import { execFile } from "node:child_process";
import {
  lstat,
  mkdir,
  mkdtemp,
  open,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import {
  AAIS_TEST_ACCOUNT_BATCH_ID,
  AAIS_TEST_ACCOUNT_COHORT,
  AAIS_TEST_ACCOUNT_COURSE_ID,
  AAIS_TEST_ACCOUNT_CSV_HEADER,
  AAIS_TEST_ACCOUNT_CUSTODY_PATH,
  AAIS_TEST_ACCOUNT_EXPECTED_COUNT,
  AAIS_TEST_ACCOUNT_PRODUCTION_BASE_URL,
  AAIS_TEST_ACCOUNT_PRODUCTION_PROJECT_ID,
  AAIS_TEST_ACCOUNT_REPORT_SCHEMA,
  AAIS_TEST_ACCOUNT_REQUEST_TIMEOUT_MS,
  AAIS_TEST_ACCOUNT_STUDENT_COUNT,
  AAIS_TEST_ACCOUNT_TEACHER_COUNT,
  AAIS_TEST_ACCOUNT_VERCEL_CLI_VERSION,
  attestAaisProductionDeployment,
  auditAaisTestAccountsInGit,
  collectAaisGitContents,
  createAaisTestAccountRows,
  createAaisTestUserId,
  disableAaisTestAccountBatch,
  generateAaisTestAccountBatch,
  getAaisTestAccountDatabasePoolConfig,
  getAaisTestAccountManagerUsage,
  parseAaisTestAccountCsv,
  parseAaisTestAccountManagerArgs,
  provisionAaisTestAccountBatch,
  runAaisTestAccountPinnedProductionCommand,
  serializeAaisTestAccountCsv,
  validateAaisTestAccountRows,
  verifyAaisTestAccountBatch,
} from "../scripts/manage-aais-test-accounts.mjs";

const execFileAsync = promisify(execFile);
const expectedSha = "a".repeat(40);
const temporaryPaths = [];

afterEach(async () => {
  await Promise.all(temporaryPaths.splice(0).map((temporaryPath) =>
    rm(temporaryPath, { recursive: true, force: true })
  ));
});

describe("AAIS production test-account batch manager", () => {
  it("generates the one fixed 40-student/2-teacher identity sequence", () => {
    const rows = createRows();

    expect(AAIS_TEST_ACCOUNT_CSV_HEADER).toEqual([
      "batch_id",
      "role",
      "display_name",
      "account",
      "password",
      "course_id",
      "cohort",
      "user_id",
    ]);
    expect(rows).toHaveLength(AAIS_TEST_ACCOUNT_EXPECTED_COUNT);
    expect(rows.filter((row) => row.role === "student")).toHaveLength(
      AAIS_TEST_ACCOUNT_STUDENT_COUNT,
    );
    expect(rows.filter((row) => row.role === "teacher")).toHaveLength(
      AAIS_TEST_ACCOUNT_TEACHER_COUNT,
    );
    expect(rows[0]).toEqual(expect.objectContaining({
      batch_id: "AAIS-PROD-QA-20260827-40S-2T",
      role: "student",
      display_name: "测试学生 01",
      account: expectedAccount("student", 1),
      course_id: "cognitive-apprenticeship",
      cohort: "qa-20260827-40s-2t",
    }));
    expect(rows[39]).toEqual(expect.objectContaining({
      role: "student",
      display_name: "测试学生 40",
      account: expectedAccount("student", 40),
    }));
    expect(rows[40]).toEqual(expect.objectContaining({
      role: "teacher",
      display_name: "测试教师 01",
      account: expectedAccount("teacher", 1),
    }));
    expect(rows[41]).toEqual(expect.objectContaining({
      role: "teacher",
      display_name: "测试教师 02",
      account: expectedAccount("teacher", 2),
    }));
    expect(new Set(rows.map((row) => row.account))).toHaveLength(42);
    expect(new Set(rows.map((row) => row.password))).toHaveLength(42);
    expect(new Set(rows.map((row) => row.user_id))).toHaveLength(42);
    for (const row of rows) {
      expect(row.password).toMatch(/^[A-Za-z0-9_-]{24}$/);
      expect(row.user_id).toBe(createAaisTestUserId(row.account));
    }
    expect(validateAaisTestAccountRows(rows)).toEqual({
      batchId: AAIS_TEST_ACCOUNT_BATCH_ID,
      courseId: AAIS_TEST_ACCOUNT_COURSE_ID,
      cohort: AAIS_TEST_ACCOUNT_COHORT,
      count: 42,
      roles: { student: 40, teacher: 2, admin: 0 },
    });
  });

  it("rejects silent batch, course, cohort, display-name, and account variants", () => {
    expect(() => createAaisTestAccountRows({
      ...fixedBinding(),
      batchId: AAIS_TEST_ACCOUNT_BATCH_ID.toLowerCase(),
      randomBytesImpl: deterministicRandomBytes(),
    })).toThrow(expect.objectContaining({ code: "AAIS_TEST_ACCOUNT_BATCH_ID_INVALID" }));
    expect(() => createAaisTestAccountRows({
      ...fixedBinding(),
      courseId: "another-valid-course",
      randomBytesImpl: deterministicRandomBytes(),
    })).toThrow(expect.objectContaining({ code: "AAIS_TEST_ACCOUNT_COURSE_ID_INVALID" }));
    expect(() => createAaisTestAccountRows({
      ...fixedBinding(),
      cohort: "another-valid-cohort",
      randomBytesImpl: deterministicRandomBytes(),
    })).toThrow(expect.objectContaining({ code: "AAIS_TEST_ACCOUNT_COHORT_INVALID" }));

    const displayVariant = createRows();
    displayVariant[0] = { ...displayVariant[0], display_name: "测试学生 001" };
    expect(() => validateAaisTestAccountRows(displayVariant)).toThrow(
      expect.objectContaining({ code: "AAIS_TEST_ACCOUNT_CSV_ROW_INVALID" }),
    );
    const accountVariant = createRows();
    accountVariant[0] = {
      ...accountVariant[0],
      account: expectedAccount("student", 1).replace("-001@", "-01@"),
    };
    expect(() => validateAaisTestAccountRows(accountVariant)).toThrow(
      expect.objectContaining({ code: "AAIS_TEST_ACCOUNT_CSV_ROW_INVALID" }),
    );
  });

  it("round-trips only the fixed CSV schema and rejects reordered headers", () => {
    const rows = createRows();
    const csv = serializeAaisTestAccountCsv(rows);

    expect(csv.split("\n")[0]).toBe(AAIS_TEST_ACCOUNT_CSV_HEADER.join(","));
    expect(parseAaisTestAccountCsv(csv)).toEqual(rows);
    expect(() => parseAaisTestAccountCsv(csv.replace(
      "batch_id,role",
      "role,batch_id",
    ))).toThrow(expect.objectContaining({ code: "AAIS_TEST_ACCOUNT_CSV_HEADER_INVALID" }));
  });

  it("creates only the fixed ignored custody file with 0700/0600 and wx", async () => {
    const gitRoot = await makeTemporaryDirectory();
    const outputPath = path.join(gitRoot, AAIS_TEST_ACCOUNT_CUSTODY_PATH);
    const input = {
      ...fixedBinding(),
      outputPath,
      gitRoot,
      randomBytesImpl: deterministicRandomBytes(),
      isIgnored: async () => true,
      isTracked: async () => false,
    };

    const report = await generateAaisTestAccountBatch(input);
    const fileMetadata = await lstat(outputPath);
    const directoryMetadata = await lstat(path.dirname(outputPath));
    expect(report).toMatchObject({
      schema: AAIS_TEST_ACCOUNT_REPORT_SCHEMA,
      status: "pass",
      command: "generate",
      count: 42,
      output: { exclusiveCreate: true, directoryMode: "0700", fileMode: "0600" },
      secrets: "redacted",
    });
    expect(fileMetadata.mode & 0o777).toBe(0o600);
    expect(directoryMetadata.mode & 0o777).toBe(0o700);
    expect(parseAaisTestAccountCsv(await readFile(outputPath, "utf8"))).toHaveLength(42);
    await expect(generateAaisTestAccountBatch({
      ...input,
      randomBytesImpl: deterministicRandomBytes(),
    })).rejects.toMatchObject({ code: "AAIS_TEST_ACCOUNT_OUTPUT_EXISTS" });
  });

  it("does not touch the filesystem when the random source fails", async () => {
    const gitRoot = await makeTemporaryDirectory();
    const outputPath = path.join(gitRoot, AAIS_TEST_ACCOUNT_CUSTODY_PATH);

    await expect(generateAaisTestAccountBatch({
      ...fixedBinding(),
      outputPath,
      gitRoot,
      randomBytesImpl: () => {
        throw new Error("synthetic RNG failure");
      },
      isIgnored: async () => true,
      isTracked: async () => false,
    })).rejects.toThrow("synthetic RNG failure");
    await expect(lstat(path.dirname(outputPath))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("removes a partial file after a post-open write failure and escalates cleanup failure", async () => {
    const gitRoot = await makeTemporaryDirectory();
    const outputPath = path.join(gitRoot, AAIS_TEST_ACCOUNT_CUSTODY_PATH);
    const failingOpen = async (target, flags, mode) => {
      const handle = await open(target, flags, mode);
      return {
        writeFile: async () => {
          await handle.writeFile("synthetic-partial");
          throw new Error("synthetic write failure");
        },
        sync: () => handle.sync(),
        close: () => handle.close(),
      };
    };
    const common = {
      ...fixedBinding(),
      outputPath,
      gitRoot,
      randomBytesImpl: deterministicRandomBytes(),
      isIgnored: async () => true,
      isTracked: async () => false,
      openImpl: failingOpen,
    };

    await expect(generateAaisTestAccountBatch(common)).rejects.toMatchObject({
      code: "AAIS_TEST_ACCOUNT_OUTPUT_WRITE_FAILED",
    });
    await expect(lstat(outputPath)).rejects.toMatchObject({ code: "ENOENT" });

    await expect(generateAaisTestAccountBatch({
      ...common,
      randomBytesImpl: deterministicRandomBytes(),
      unlinkImpl: async () => {
        throw new Error("synthetic cleanup failure");
      },
    })).rejects.toMatchObject({ code: "AAIS_TEST_ACCOUNT_OUTPUT_CLEANUP_FAILED" });
    expect((await lstat(outputPath)).isFile()).toBe(true);
  });

  it("rejects alternate custody paths, non-ignored targets, and symlink components", async () => {
    const gitRoot = await makeTemporaryDirectory();
    const common = {
      ...fixedBinding(),
      gitRoot,
      randomBytesImpl: deterministicRandomBytes(),
      isTracked: async () => false,
    };
    await expect(generateAaisTestAccountBatch({
      ...common,
      outputPath: path.join(gitRoot, "output", "credentials.csv"),
      isIgnored: async () => true,
    })).rejects.toMatchObject({ code: "AAIS_TEST_ACCOUNT_CUSTODY_PATH_INVALID" });
    await expect(generateAaisTestAccountBatch({
      ...common,
      outputPath: path.join(gitRoot, AAIS_TEST_ACCOUNT_CUSTODY_PATH),
      isIgnored: async () => false,
    })).rejects.toMatchObject({ code: "AAIS_TEST_ACCOUNT_PATH_NOT_PRIVATE" });

    const outside = await makeTemporaryDirectory();
    await mkdir(path.join(gitRoot, "output"), { recursive: true });
    await symlink(outside, path.join(gitRoot, "output", "private-account-batches"));
    await expect(generateAaisTestAccountBatch({
      ...common,
      outputPath: path.join(gitRoot, AAIS_TEST_ACCOUNT_CUSTODY_PATH),
      isIgnored: async () => true,
    })).rejects.toMatchObject({ code: "AAIS_TEST_ACCOUNT_PATH_SYMLINK_REJECTED" });
  });

  it("fails closed unless seed supports create-only transaction validation hooks", async () => {
    let called = 0;
    const seedModule = makeSeedModule({ transactionValidationHooks: false });
    const originalRunner = seedModule.runAaisUserSeed;
    seedModule.runAaisUserSeed = async (input) => {
      called += 1;
      return originalRunner(input);
    };
    await expect(provisionAaisTestAccountBatch({
      ...productionInput(createRows()),
      database: makeProvisionDatabase(),
      seedModule,
    })).rejects.toMatchObject({ code: "AAIS_TEST_ACCOUNT_SEED_CAPABILITY_MISSING" });
    expect(called).toBe(0);
  });

  it("provisions create-only and validates schema/course plus 42/42 postconditions before commit", async () => {
    const rows = createRows();
    const database = makeProvisionDatabase();
    const seedModule = makeSeedModule();

    const report = await provisionAaisTestAccountBatch({
      ...productionInput(rows),
      database,
      seedModule,
      sourceEnv: "DATABASE_URL",
      now: new Date("2026-08-27T00:00:00.000Z"),
    });

    expect(seedModule.calls).toHaveLength(1);
    expect(seedModule.calls[0]).toMatchObject({
      mode: "create-only",
      batchId: AAIS_TEST_ACCOUNT_BATCH_ID,
      courseId: AAIS_TEST_ACCOUNT_COURSE_ID,
      cohort: AAIS_TEST_ACCOUNT_COHORT,
    });
    expect(report).toMatchObject({
      schema: AAIS_TEST_ACCOUNT_REPORT_SCHEMA,
      status: "pass",
      command: "provision",
      deployment: { researchIsolation: "non-research" },
      preflight: {
        requiredTables: 6,
        requiredMigrations: 6,
        authRuntime: "ready",
        course: "active",
      },
      transactionValidation: {
        beforeWrite: "passed",
        beforeCommit: "passed",
        aggregate: {
          users: { total: 42, roles: { student: 40, teacher: 2, admin: 0 } },
          enrollments: { total: 42, roles: { student: 40, teacher: 2, admin: 0 } },
        },
      },
      seed: {
        mode: "create-only",
        upserted: 42,
        created: 42,
        updated: 0,
        collisions: 0,
        enrollments: 42,
      },
      database: {
        users: { total: 42, statuses: { active: 42 } },
        enrollments: { total: 42, statuses: { active: 42 } },
      },
      secrets: "redacted",
    });
    expect(database.queries.filter((query) =>
      query.sql.includes("provision-users-aggregate")
    )).toHaveLength(2);
    expect(database.queries.find((query) =>
      query.sql.includes("provision-course-preflight")
    )?.sql).toContain("for share");
    assertNoCredentialValues(report, rows);
  });

  it("fails closed when the Git index cannot prove the custody path is untracked", async () => {
    const gitRoot = await makeTemporaryDirectory();
    await execFileAsync("git", ["init"], { cwd: gitRoot });
    await writeFile(path.join(gitRoot, ".git", "index"), "invalid-index", "utf8");

    await expect(generateAaisTestAccountBatch({
      ...fixedBinding(),
      outputPath: path.join(gitRoot, AAIS_TEST_ACCOUNT_CUSTODY_PATH),
      gitRoot,
      randomBytesImpl: deterministicRandomBytes(),
      isIgnored: async () => true,
    })).rejects.toMatchObject({
      code: "AAIS_TEST_ACCOUNT_PATH_PRIVACY_CHECK_FAILED",
    });
    await expect(lstat(path.join(gitRoot, "output"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("stops a seed transaction before writes when schema preflight is incomplete", async () => {
    const rows = createRows();
    const database = makeProvisionDatabase({ usersPresent: false });
    const seedModule = makeSeedModule();

    await expect(provisionAaisTestAccountBatch({
      ...productionInput(rows),
      database,
      seedModule,
    })).rejects.toMatchObject({ code: "AAIS_TEST_ACCOUNT_PROVISION_FAILED" });
    expect(seedModule.writes).toBe(0);
    expect(seedModule.rolledBack).toBe(1);
  });

  it("stops before writes when login or logout runtime migrations are incomplete", async () => {
    const rows = createRows();
    for (const database of [
      makeProvisionDatabase({ revocationsPresent: false }),
      makeProvisionDatabase({ rateLimitExpiryPresent: false }),
      makeProvisionDatabase({ migrationVersions: ["0002", "0005", "0006", "0007", "0010"] }),
    ]) {
      const seedModule = makeSeedModule();
      await expect(provisionAaisTestAccountBatch({
        ...productionInput(rows),
        database,
        seedModule,
      })).rejects.toMatchObject({ code: "AAIS_TEST_ACCOUNT_PROVISION_FAILED" });
      expect(seedModule.writes).toBe(0);
      expect(seedModule.rolledBack).toBe(1);
    }
  });

  it("rolls back all 42 writes when the in-transaction database aggregate mismatches", async () => {
    const rows = createRows();
    const database = makeProvisionDatabase({ studentCount: 39 });
    const seedModule = makeSeedModule();

    await expect(provisionAaisTestAccountBatch({
      ...productionInput(rows),
      database,
      seedModule,
    })).rejects.toMatchObject({ code: "AAIS_TEST_ACCOUNT_PROVISION_FAILED" });
    expect(seedModule.writes).toBe(42);
    expect(seedModule.rolledBack).toBe(1);
  });

  it("preserves an explicit unknown state when the seed rollback cannot be confirmed", async () => {
    const rows = createRows();
    const seedModule = makeSeedModule();
    seedModule.runAaisUserSeed = async () => {
      const error = new Error("synthetic sensitive database detail");
      error.code = "AAIS_USER_SEED_ROLLBACK_FAILED";
      throw error;
    };

    const failure = await provisionAaisTestAccountBatch({
      ...productionInput(rows),
      database: makeProvisionDatabase(),
      seedModule,
    }).then(() => null, (error) => error);

    expect(failure).toMatchObject({
      code: "AAIS_TEST_ACCOUNT_PROVISION_ROLLBACK_FAILED",
      details: {},
    });
    expect(JSON.stringify(failure)).not.toContain("sensitive database detail");
    assertNoCredentialValues(failure, rows);
  });

  it("reports a committed-but-unverified state when post-commit aggregation fails", async () => {
    const rows = createRows();
    const seedModule = makeSeedModule();

    const failure = await provisionAaisTestAccountBatch({
      ...productionInput(rows),
      database: makeProvisionDatabase({ failPostCommitAggregate: true }),
      seedModule,
    }).then(() => null, (error) => error);

    expect(failure).toMatchObject({
      code: "AAIS_TEST_ACCOUNT_PROVISION_COMMITTED_UNVERIFIED",
      details: {
        committed: true,
        transactionValidation: "passed",
        postCommitVerification: "failed",
        retryProvisioning: "forbidden",
      },
    });
    expect(seedModule.writes).toBe(42);
    expect(seedModule.rolledBack).toBe(0);
    assertNoCredentialValues(failure, rows);
  });

  it("rejects unbound local or remote production state before database or HTTP work", async () => {
    const rows = createRows();
    const database = makeProvisionDatabase();
    const seedModule = makeSeedModule();
    const invalidAttestations = [
      { branch: "feature" },
      { clean: false },
      { remoteTrackingSha: "b".repeat(40) },
      { liveOriginMainSha: "b".repeat(40) },
      { vercelEnv: "preview" },
      { vercelTargetEnv: "preview" },
      { vercelCliVersion: "59.6.0" },
      { deployedGitSha: "b".repeat(40) },
      { vercelDeploymentReadyState: "ERROR" },
      { vercelDeploymentTarget: "preview" },
      { githubDeploymentState: "failure" },
      { researchModeEnabled: true },
      { researchRequiredEnabled: true },
      { researchEnvironmentIsResearch: true },
      { projectId: "wrong" },
      { projectName: "wrong" },
    ];

    for (const change of invalidAttestations) {
      await expect(provisionAaisTestAccountBatch({
        ...productionInput(rows),
        productionAttestation: { ...productionAttestation(), ...change },
        database,
        seedModule,
      })).rejects.toBeInstanceOf(Error);
    }
    expect(seedModule.calls).toHaveLength(0);
    expect(database.queries).toHaveLength(0);
  });

  it("verifies 42/42 login identity, page authorization, and revoking logout at concurrency 2", async () => {
    const rows = createRows();
    const fakeHttp = makeVerificationFetch(rows);

    const report = await verifyAaisTestAccountBatch({
      ...productionInput(rows),
      baseUrl: AAIS_TEST_ACCOUNT_PRODUCTION_BASE_URL,
      fetchImpl: fakeHttp.fetchImpl,
    });

    expect(report).toMatchObject({
      schema: AAIS_TEST_ACCOUNT_REPORT_SCHEMA,
      status: "pass",
      command: "verify",
      deployment: { researchIsolation: "non-research" },
      concurrency: 2,
      requestTimeoutMs: AAIS_TEST_ACCOUNT_REQUEST_TIMEOUT_MS,
      results: {
        expected: 42,
        attempted: 42,
        passed: 42,
        failed: 0,
        roles: {
          student: { expected: 40, passed: 40, failed: 0 },
          teacher: { expected: 2, passed: 2, failed: 0 },
          admin: { expected: 0, passed: 0, failed: 0 },
        },
        checks: {
          login: { expected: 42, passed: 42, failed: 0 },
          role: { expected: 42, passed: 42, failed: 0 },
          learningAllowed: { expected: 42, passed: 42, failed: 0 },
          studentDashboardDenied: { expected: 40, passed: 40, failed: 0 },
          teacherDashboardAllowed: { expected: 2, passed: 2, failed: 0 },
          teacherAdminDenied: { expected: 2, passed: 2, failed: 0 },
          logout: { expected: 42, passed: 42, failed: 0 },
        },
        negativeAuth: {
          expected: 3,
          attempted: 3,
          passed: 3,
          failed: 0,
          sessionCookiesSet: 0,
          cleanup: { attempted: 0, passed: 0 },
        },
      },
      secrets: "redacted",
    });
    expect(fakeHttp.maximumActiveLogins).toBe(2);
    expect(fakeHttp.logoutCount).toBe(42);
    expect(fakeHttp.manualRedirectOnly).toBe(true);
    assertNoCredentialValues(report, rows);
    expect(JSON.stringify(report)).not.toContain("aais_session");
    expect(JSON.stringify(report)).not.toContain("aais_csrf");
  });

  it("bounds a stalled production request and logs out its known session", async () => {
    const rows = createRows();
    const fakeHttp = makeVerificationFetch(rows);
    let stalled = false;
    const fetchImpl = async (urlValue, request = {}) => {
      const url = new URL(urlValue);
      if (!stalled && url.pathname === "/learning") {
        stalled = true;
        return new Promise((_resolve, reject) => {
          const fallback = setTimeout(() => reject(new Error("unbounded synthetic request")), 100);
          request.signal?.addEventListener("abort", () => {
            clearTimeout(fallback);
            reject(new Error("synthetic abort"));
          }, { once: true });
        });
      }
      return fakeHttp.fetchImpl(urlValue, request);
    };

    const report = await verifyAaisTestAccountBatch({
      ...productionInput(rows),
      baseUrl: AAIS_TEST_ACCOUNT_PRODUCTION_BASE_URL,
      fetchImpl,
      requestTimeoutMs: 10,
    });

    expect(report).toMatchObject({
      status: "failed",
      requestTimeoutMs: 10,
      results: {
        attempted: 42,
        passed: 41,
        failed: 1,
        checks: {
          learningAllowed: { expected: 42, passed: 41, failed: 1 },
          logout: { expected: 42, passed: 42, failed: 0 },
        },
        failures: { "learning-page-timeout": 1 },
      },
    });
    expect(fakeHttp.logoutCount).toBe(42);
    expect(fakeHttp.activeSessionCount).toBe(0);
    assertNoCredentialValues(report, rows);
  });

  it("bounds a stalled login response body after capturing cookies for cleanup", async () => {
    const rows = createRows();
    const fakeHttp = makeVerificationFetch(rows);
    let stalled = false;
    const fetchImpl = async (urlValue, request = {}) => {
      const response = await fakeHttp.fetchImpl(urlValue, request);
      const url = new URL(urlValue);
      if (
        !stalled
        && url.pathname === "/api/auth/app-session"
        && request.method === "POST"
        && response.status === 200
      ) {
        stalled = true;
        return {
          ...response,
          json: () => new Promise((_resolve, reject) => {
            const fallback = setTimeout(() => reject(new Error("unbounded synthetic body")), 100);
            request.signal?.addEventListener("abort", () => {
              clearTimeout(fallback);
              reject(new Error("synthetic body abort"));
            }, { once: true });
          }),
        };
      }
      return response;
    };

    const report = await verifyAaisTestAccountBatch({
      ...productionInput(rows),
      baseUrl: AAIS_TEST_ACCOUNT_PRODUCTION_BASE_URL,
      fetchImpl,
      requestTimeoutMs: 10,
    });

    expect(report).toMatchObject({
      status: "failed",
      results: {
        attempted: 42,
        passed: 41,
        failed: 1,
        checks: {
          login: { expected: 42, passed: 41, failed: 1 },
          logout: { expected: 42, passed: 42, failed: 0 },
        },
        failures: { "login-timeout": 1 },
      },
    });
    expect(fakeHttp.logoutCount).toBe(42);
    expect(fakeHttp.activeSessionCount).toBe(0);
    assertNoCredentialValues(report, rows);
  });

  it("binds the canonical alias to one READY Vercel and successful GitHub deployment", () => {
    const evidence = productionDeploymentEvidence();

    expect(attestAaisProductionDeployment({
      expectedSha,
      ...evidence,
    })).toEqual({
      deployedGitSha: expectedSha,
      vercelDeploymentId: "dpl_AaisProduction1",
      vercelDeploymentUrl: "aais-production.example-team.vercel.app",
      vercelDeploymentReadyState: "READY",
      vercelDeploymentTarget: "production",
      githubDeploymentId: 12345,
      githubDeploymentStatusId: 67890,
      githubDeploymentState: "success",
    });

    expect(() => attestAaisProductionDeployment({
      expectedSha,
      ...productionDeploymentEvidence({ deploymentSha: "b".repeat(40) }),
    })).toThrow(expect.objectContaining({
      code: "AAIS_TEST_ACCOUNT_PRODUCTION_DEPLOYMENT_INVALID",
    }));
    expect(() => attestAaisProductionDeployment({
      expectedSha,
      ...productionDeploymentEvidence({ inspectedUrl: "older-build.example-team.vercel.app" }),
    })).toThrow(expect.objectContaining({
      code: "AAIS_TEST_ACCOUNT_PRODUCTION_DEPLOYMENT_INVALID",
    }));
  });

  it("immediately revokes an unexpected negative-auth session and reports counts only", async () => {
    const rows = createRows();
    const fakeHttp = makeVerificationFetch(rows, { negativeSessionCase: "wrong-password" });

    const report = await verifyAaisTestAccountBatch({
      ...productionInput(rows),
      baseUrl: AAIS_TEST_ACCOUNT_PRODUCTION_BASE_URL,
      fetchImpl: fakeHttp.fetchImpl,
    });

    expect(report.status).toBe("failed");
    expect(report.results.negativeAuth).toEqual({
      expected: 3,
      attempted: 3,
      passed: 2,
      failed: 1,
      sessionCookiesSet: 1,
      cleanup: { attempted: 1, passed: 1 },
    });
    expect(fakeHttp.logoutCount).toBe(43);
    expect(fakeHttp.negativeCleanupCount).toBe(1);
    expect(fakeHttp.activeSessionCount).toBe(0);
    assertNoCredentialValues(report, rows);
    expect(JSON.stringify(report)).not.toContain("aais_session");
    expect(JSON.stringify(report)).not.toContain("aais_csrf");
  });

  it("audits exact account, password, and user-id values with complete HEAD/index denominators", async () => {
    const rows = createRows();
    const report = await auditAaisTestAccountsInGit({
      ...fixedBinding(),
      rows,
      expectedCount: 42,
      trackedContents: [Buffer.from(`${rows[0].account}\n${rows[0].account}\n${rows[0].user_id}`)],
      stagedContents: [Buffer.from(rows[1].password)],
      headExpected: 1,
      indexExpected: 1,
    });

    expect(report).toMatchObject({
      schema: AAIS_TEST_ACCOUNT_REPORT_SCHEMA,
      status: "failed",
      sources: {
        head: { expected: 1, scanned: 1 },
        index: { expected: 1, scanned: 1 },
      },
      tracked: {
        matchedValues: { accounts: 1, passwords: 0, userIds: 1 },
        occurrences: { accounts: 2, passwords: 0, userIds: 1 },
        totalOccurrences: 3,
      },
      staged: {
        matchedValues: { accounts: 0, passwords: 1, userIds: 0 },
        totalOccurrences: 1,
      },
    });
    assertNoCredentialValues(report, rows);
    await expect(auditAaisTestAccountsInGit({
      ...fixedBinding(),
      rows,
      trackedContents: [],
      stagedContents: [],
      headExpected: 1,
      indexExpected: 0,
    })).rejects.toMatchObject({ code: "AAIS_TEST_ACCOUNT_GIT_AUDIT_DENOMINATOR_MISMATCH" });
  });

  it("reads committed HEAD and the full index rather than an unstaged working-tree replacement", async () => {
    const rows = createRows();
    const gitRoot = await makeTemporaryDirectory();
    await runGitFixture(["init", "-b", "main"], gitRoot);
    await runGitFixture(["config", "user.email", "qa@example.test"], gitRoot);
    await runGitFixture(["config", "user.name", "AAIS QA"], gitRoot);
    await writeFile(path.join(gitRoot, "committed.txt"), "safe committed value\n");
    await runGitFixture(["add", "committed.txt"], gitRoot);
    await runGitFixture(["commit", "-m", "fixture"], gitRoot);
    await writeFile(path.join(gitRoot, "committed.txt"), `${rows[0].account}\n`);
    await writeFile(path.join(gitRoot, "staged.txt"), `${rows[1].password}\n`);
    await runGitFixture(["add", "staged.txt"], gitRoot);

    const contents = await collectAaisGitContents({ gitRoot });
    const report = await auditAaisTestAccountsInGit({
      ...fixedBinding(),
      rows,
      expectedCount: 42,
      ...contents,
    });

    expect(contents.headExpected).toBe(1);
    expect(contents.indexExpected).toBe(2);
    expect(report.sources).toEqual({
      head: { expected: 1, scanned: 1 },
      index: { expected: 2, scanned: 2 },
    });
    expect(report.tracked.occurrences.accounts).toBe(0);
    expect(report.staged.occurrences.accounts).toBe(0);
    expect(report.staged.occurrences.passwords).toBe(1);
  });

  it("fails closed when any enumerated Git blob cannot be read", async () => {
    const gitRoot = await makeTemporaryDirectory();
    await expect(collectAaisGitContents({
      gitRoot,
      runGitImpl: async (args) => {
        if (args[0] === "ls-tree") {
          return { stdout: "one-file\0" };
        }
        if (args[0] === "ls-files") {
          return { stdout: "" };
        }
        throw new Error("synthetic blob read failure");
      },
    })).rejects.toMatchObject({ code: "AAIS_TEST_ACCOUNT_GIT_BLOB_READ_FAILED" });
  });

  it("keeps every exact planned credential value out of the manager and test source blobs", async () => {
    const rows = createRows();
    const sourceRoot = path.resolve(import.meta.dirname, "..");
    const sources = await Promise.all([
      readFile(path.join(sourceRoot, "scripts", "manage-aais-test-accounts.mjs")),
      readFile(path.join(sourceRoot, "tests", "aais-test-account-manager.test.mjs")),
    ]);
    const report = await auditAaisTestAccountsInGit({
      ...fixedBinding(),
      rows,
      trackedContents: sources,
      stagedContents: [],
      headExpected: sources.length,
      indexExpected: 0,
    });

    expect(report.status).toBe("pass");
    expect(report.tracked.totalOccurrences).toBe(0);
    expect(report.staged.totalOccurrences).toBe(0);
  });

  it("disables exactly the frozen IDs/emails in one connection and is idempotent", async () => {
    const rows = createRows();
    const pool = new FakeDisablePool(rows);
    pool.enrollments.get(rows[0].user_id).status = "completed";

    const first = await disableAaisTestAccountBatch({
      ...productionInput(rows),
      database: pool,
      now: new Date("2026-08-28T00:00:00.000Z"),
    });
    const second = await disableAaisTestAccountBatch({
      ...productionInput(rows),
      database: pool,
      now: new Date("2026-08-28T00:01:00.000Z"),
    });

    expect(first).toMatchObject({
      schema: AAIS_TEST_ACCOUNT_REPORT_SCHEMA,
      status: "pass",
      deployment: { researchIsolation: "non-research" },
      users: {
        matched: 42,
        newlyDisabled: 42,
        alreadyDisabled: 0,
        authVersionsIncremented: 42,
      },
      enrollments: { matched: 42, newlyWithdrawn: 42, alreadyWithdrawn: 0 },
    });
    expect(second).toMatchObject({
      users: {
        matched: 42,
        newlyDisabled: 0,
        alreadyDisabled: 42,
        authVersionsIncremented: 0,
      },
      enrollments: { matched: 42, newlyWithdrawn: 0, alreadyWithdrawn: 42 },
    });
    expect(pool.connections).toEqual({ acquired: 2, released: 2 });
    expect(pool.transactions).toEqual({ begun: 2, committed: 2, rolledBack: 0 });
    expect([...pool.users.values()].every((row) =>
      row.status === "disabled" && row.auth_version === 2
    )).toBe(true);
    expect([...pool.enrollments.values()].every((row) => row.status === "withdrawn")).toBe(true);
    assertNoCredentialValues(first, rows);
  });

  it("uses an already leased PoolClient shape without reconnecting or releasing it", async () => {
    const rows = createRows();
    const backing = new FakeDisablePool(rows);
    let nestedConnects = 0;
    let innerReleases = 0;
    const leasedClient = {
      query: (sql, params) => backing.query(sql, params),
      connect: async () => {
        nestedConnects += 1;
        throw new Error("already connected");
      },
      release: () => {
        innerReleases += 1;
      },
    };

    const report = await disableAaisTestAccountBatch({
      ...productionInput(rows),
      database: leasedClient,
    });

    expect(report.status).toBe("pass");
    expect(nestedConnects).toBe(0);
    expect(innerReleases).toBe(0);
    expect(backing.transactions).toEqual({ begun: 1, committed: 1, rolledBack: 0 });
  });

  it("rolls back disable when a frozen user ID resolves to another normalized email", async () => {
    const rows = createRows();
    const pool = new FakeDisablePool(rows);
    pool.users.get(rows[0].user_id).normalized_email = "different@accounts.example.test";

    await expect(disableAaisTestAccountBatch({
      ...productionInput(rows),
      database: pool,
    })).rejects.toMatchObject({ code: "AAIS_TEST_ACCOUNT_DISABLE_USER_SET_MISMATCH" });
    expect(pool.transactions).toEqual({ begun: 1, committed: 0, rolledBack: 1 });
    expect(pool.connections).toEqual({ acquired: 1, released: 1 });
    expect([...pool.users.values()].every((row) => row.status === "active")).toBe(true);
  });

  it("rolls back a late disable failure and leaves out-of-scope rows untouched", async () => {
    const rows = createRows();
    const pool = new FakeDisablePool(rows, { failDisableEnrollment: true });
    pool.users.set("sentinel-out-of-scope", {
      id: "sentinel-out-of-scope",
      normalized_email: "sentinel-out-of-scope@example.test",
      role: "student",
      status: "active",
      auth_version: 9,
    });

    await expect(disableAaisTestAccountBatch({
      ...productionInput(rows),
      database: pool,
    })).rejects.toMatchObject({ code: "AAIS_TEST_ACCOUNT_DISABLE_FAILED" });

    expect(pool.transactions).toEqual({ begun: 1, committed: 0, rolledBack: 1 });
    expect([...pool.users.values()].filter((row) => row.id !== "sentinel-out-of-scope")
      .every((row) => row.status === "active" && row.auth_version === 1)).toBe(true);
    expect([...pool.enrollments.values()].every((row) => row.status === "active")).toBe(true);
    expect(pool.users.get("sentinel-out-of-scope")).toMatchObject({
      status: "active",
      auth_version: 9,
    });
  });

  it("reports an explicit unknown state when disable rollback itself fails", async () => {
    const rows = createRows();
    const pool = new FakeDisablePool(rows, {
      failDisableEnrollment: true,
      failRollback: true,
    });

    await expect(disableAaisTestAccountBatch({
      ...productionInput(rows),
      database: pool,
    })).rejects.toMatchObject({ code: "AAIS_TEST_ACCOUNT_DISABLE_ROLLBACK_FAILED" });
    expect(pool.connections).toEqual({ acquired: 1, released: 1 });
  });

  it("documents exact fixed CLI usage and rejects command-specific option drift", () => {
    const usage = getAaisTestAccountManagerUsage();
    expect(usage).toContain(AAIS_TEST_ACCOUNT_CUSTODY_PATH);
    expect(usage).toContain(`--batch-id ${AAIS_TEST_ACCOUNT_BATCH_ID}`);
    expect(usage).toContain(`--course-id ${AAIS_TEST_ACCOUNT_COURSE_ID}`);
    expect(usage).toContain(`--cohort ${AAIS_TEST_ACCOUNT_COHORT}`);
    expect(usage).toContain("npm run accounts:test-batch -- provision");
    expect(usage).toContain(`pinned Vercel CLI ${AAIS_TEST_ACCOUNT_VERCEL_CLI_VERSION}`);
    expect(usage).toContain(AAIS_TEST_ACCOUNT_PRODUCTION_PROJECT_ID);
    expect(usage).toContain(AAIS_TEST_ACCOUNT_PRODUCTION_BASE_URL);
    expect(parseAaisTestAccountManagerArgs(["--help"])).toEqual({ command: "help" });
    expect(() => parseAaisTestAccountManagerArgs([
      "generate",
      "--output",
      AAIS_TEST_ACCOUNT_CUSTODY_PATH,
      "--expected-count",
      "42",
    ])).toThrow(expect.objectContaining({ code: "AAIS_TEST_ACCOUNT_ARGUMENT_NOT_ALLOWED" }));
    expect(() => parseAaisTestAccountManagerArgs([
      "audit-git",
      "--input",
      AAIS_TEST_ACCOUNT_CUSTODY_PATH,
      "--target",
      "production",
    ])).toThrow(expect.objectContaining({ code: "AAIS_TEST_ACCOUNT_ARGUMENT_NOT_ALLOWED" }));
  });

  it("uses the pinned Vercel CLI wrapper for every production command", async () => {
    const calls = [];
    const result = await runAaisTestAccountPinnedProductionCommand([
      "verify",
      "--expected-sha",
      expectedSha,
    ], {
      cwd: "/synthetic/aais",
      env: { SYNTHETIC_PARENT: "present" },
      execFileImpl: async (file, args, options) => {
        calls.push({ file, args, options });
        return calls.length === 1
          ? { stdout: `${AAIS_TEST_ACCOUNT_VERCEL_CLI_VERSION}\n`, stderr: "" }
          : { stdout: "synthetic aggregate\n", stderr: "", exitCode: 0 };
      },
    });

    expect(calls).toHaveLength(2);
    expect(calls[0]).toMatchObject({
      file: "npx",
      args: ["--yes", `vercel@${AAIS_TEST_ACCOUNT_VERCEL_CLI_VERSION}`, "--version"],
    });
    expect(calls[1].file).toBe("npx");
    expect(calls[1].args.slice(0, 7)).toEqual([
      "--yes",
      `vercel@${AAIS_TEST_ACCOUNT_VERCEL_CLI_VERSION}`,
      "env",
      "run",
      "-e",
      "production",
      "--",
    ]);
    expect(calls[1].args.slice(-3)).toEqual(["verify", "--expected-sha", expectedSha]);
    expect(calls[1].options.env).toMatchObject({
      SYNTHETIC_PARENT: "present",
      AAIS_TEST_ACCOUNT_PINNED_VERCEL_CLI_VERSION: AAIS_TEST_ACCOUNT_VERCEL_CLI_VERSION,
    });
    expect(result).toEqual({
      exitCode: 0,
      stdout: "synthetic aggregate\n",
      stderr: "",
    });

    await expect(runAaisTestAccountPinnedProductionCommand(["provision"], {
      execFileImpl: async () => ({ stdout: "59.6.0\n", stderr: "" }),
    })).rejects.toMatchObject({
      code: "AAIS_TEST_ACCOUNT_VERCEL_CLI_ATTESTATION_FAILED",
    });
  });

  it("applies the standard bounded Postgres pool settings to Production operations", () => {
    expect(getAaisTestAccountDatabasePoolConfig("postgres://synthetic.example/aais")).toEqual({
      connectionString: "postgres://synthetic.example/aais",
      connectionTimeoutMillis: 5_000,
      statement_timeout: 30_000,
      query_timeout: 35_000,
      idle_in_transaction_session_timeout: 30_000,
    });
  });
});

function fixedBinding() {
  return {
    batchId: AAIS_TEST_ACCOUNT_BATCH_ID,
    courseId: AAIS_TEST_ACCOUNT_COURSE_ID,
    cohort: AAIS_TEST_ACCOUNT_COHORT,
  };
}

function createRows() {
  return createAaisTestAccountRows({
    ...fixedBinding(),
    randomBytesImpl: deterministicRandomBytes(),
  });
}

function deterministicRandomBytes() {
  let counter = 0;
  return (size) => {
    counter += 1;
    const value = Buffer.alloc(size);
    value.writeUInt32BE(counter, size - 4);
    return value;
  };
}

function productionAttestation() {
  return {
    headSha: expectedSha,
    remoteTrackingSha: expectedSha,
    liveOriginMainSha: expectedSha,
    branch: "main",
    clean: true,
    projectId: AAIS_TEST_ACCOUNT_PRODUCTION_PROJECT_ID,
    projectName: "aais",
    vercelEnv: "production",
    vercelTargetEnv: "production",
    vercelCliVersion: AAIS_TEST_ACCOUNT_VERCEL_CLI_VERSION,
    deployedGitSha: expectedSha,
    vercelDeploymentId: "dpl_AaisProduction1",
    vercelDeploymentUrl: "aais-production.example-team.vercel.app",
    vercelDeploymentReadyState: "READY",
    vercelDeploymentTarget: "production",
    githubDeploymentId: 12345,
    githubDeploymentStatusId: 67890,
    githubDeploymentState: "success",
    researchModeEnabled: false,
    researchRequiredEnabled: false,
    researchEnvironmentIsResearch: false,
  };
}

function productionInput(rows) {
  return {
    ...fixedBinding(),
    rows,
    target: "production",
    approved: true,
    expectedSha,
    expectedCount: 42,
    projectId: AAIS_TEST_ACCOUNT_PRODUCTION_PROJECT_ID,
    productionAttestation: productionAttestation(),
  };
}

function makeSeedModule(capabilityChanges = {}) {
  const seedModule = {
    AAIS_USER_SEED_CAPABILITIES: {
      version: 1,
      atomicBatch: true,
      modes: ["upsert", "create-only"],
      batchAdvisoryLock: true,
      transactionValidationHooks: true,
      reportAggregates: ["created", "updated", "collisions", "enrollments"],
      ...capabilityChanges,
    },
    calls: [],
    writes: 0,
    rolledBack: 0,
    parseAaisUserSeedJson(raw) {
      return JSON.parse(raw).map((user) => ({
        ...user,
        id: createAaisTestUserId(user.email),
        passwordRecord: { algorithm: "synthetic-test-only" },
      }));
    },
    async runAaisUserSeed(input) {
      seedModule.calls.push(input);
      try {
        await input.validateBeforeWrite({ database: input.database });
        seedModule.writes += input.users.length;
        const report = {
          status: "pass",
          mode: "create-only",
          upserted: 42,
          created: 42,
          updated: 0,
          collisions: 0,
          enrollments: 42,
        };
        await input.validateBeforeCommit({ database: input.database, report });
        return report;
      } catch (error) {
        seedModule.rolledBack += 1;
        throw error;
      }
    },
  };
  return seedModule;
}

function makeProvisionDatabase(options = {}) {
  let aggregateReads = 0;
  return {
    queries: [],
    async query(sql, params = []) {
      this.queries.push({ sql, params });
      if (sql.includes("provision-schema-preflight")) {
        return {
          rows: [{
            users_present: options.usersPresent ?? true,
            enrollments_present: true,
            courses_present: true,
            migrations_present: true,
            rate_limits_present: options.rateLimitsPresent ?? true,
            revocations_present: options.revocationsPresent ?? true,
            rate_limit_expiry_present: options.rateLimitExpiryPresent ?? true,
          }],
        };
      }
      if (sql.includes("provision-migration-preflight")) {
        const versions = options.migrationVersions
          ?? ["0002", "0005", "0006", "0007", "0010", "0026"];
        return { rows: versions.map((version) => ({ version })) };
      }
      if (sql.includes("provision-course-preflight")) {
        return { rows: [{ id: AAIS_TEST_ACCOUNT_COURSE_ID, status: "active" }] };
      }
      if (sql.includes("provision-users-aggregate")) {
        aggregateReads += 1;
        if (options.failPostCommitAggregate && aggregateReads > 2) {
          throw new Error("synthetic post-commit database failure");
        }
        return {
          rows: [
            { role: "student", status: "active", count: options.studentCount ?? 40 },
            { role: "teacher", status: "active", count: 2 },
          ],
        };
      }
      if (sql.includes("provision-enrollments-aggregate")) {
        aggregateReads += 1;
        if (options.failPostCommitAggregate && aggregateReads > 2) {
          throw new Error("synthetic post-commit database failure");
        }
        return {
          rows: [
            { role: "student", status: "active", count: 40 },
            { role: "teacher", status: "active", count: 2 },
          ],
        };
      }
      throw new Error("Unexpected synthetic provision query");
    },
  };
}

function productionDeploymentEvidence(changes = {}) {
  const deploymentUrl = "aais-production.example-team.vercel.app";
  const inspectedUrl = changes.inspectedUrl ?? deploymentUrl;
  const deploymentSha = changes.deploymentSha ?? expectedSha;
  const actor = {
    login: "vercel[bot]",
    id: 35613825,
    node_id: "MDM6Qm90MzU2MTM4MjU=",
    type: "Bot",
  };
  return {
    vercelInspect: {
      id: "dpl_AaisProduction1",
      name: "aais",
      url: inspectedUrl,
      readyState: "READY",
      target: "production",
      aliases: ["aais.site", "www.aais.site", "aais-six.vercel.app"],
    },
    githubDeployments: [{
      id: 12345,
      sha: deploymentSha,
      ref: deploymentSha,
      task: "deploy",
      environment: "Production",
      creator: actor,
    }],
    githubStatusesByDeploymentId: {
      12345: [{
        id: 67890,
        state: "success",
        target_url: `https://${deploymentUrl}`,
        environment_url: `https://${deploymentUrl}`,
        creator: actor,
      }],
    },
  };
}

function makeVerificationFetch(rows, options = {}) {
  const rowsByAccount = new Map(rows.map((row) => [row.account, row]));
  const rowsBySession = new Map();
  let activeLogins = 0;
  let maximumActiveLogins = 0;
  let logoutCount = 0;
  let negativeCleanupCount = 0;
  let manualRedirectOnly = true;

  const fetchImpl = async (urlValue, request = {}) => {
    manualRedirectOnly &&= request.redirect === "manual";
    const url = new URL(urlValue);
    if (url.pathname === "/api/auth/app-session" && request.method === "POST") {
      const body = JSON.parse(request.body);
      const row = rowsByAccount.get(body.account);
      let negativeKind = null;
      let status = 200;
      if (body.consentAccepted !== true) {
        negativeKind = "missing-consent";
        status = 428;
      } else if (!row) {
        negativeKind = "unknown-account";
        status = 401;
      } else if (body.password !== row.password) {
        negativeKind = "wrong-password";
        status = 401;
      }
      if (negativeKind) {
        const unexpectedSession = "synthetic-negative-session";
        const unexpectedCsrf = "synthetic-negative-csrf";
        const hasUnexpectedSession = options.negativeSessionCase === negativeKind;
        if (hasUnexpectedSession) {
          rowsBySession.set(unexpectedSession, row ?? rows[0]);
        }
        const cookies = hasUnexpectedSession
          ? [
            `aais_session=${unexpectedSession}; Secure; HttpOnly`,
            `aais_csrf=${unexpectedCsrf}; Secure`,
          ]
          : [];
        return fakeResponse(status, {}, { cookies });
      }

      activeLogins += 1;
      maximumActiveLogins = Math.max(maximumActiveLogins, activeLogins);
      await new Promise((resolve) => setTimeout(resolve, 2));
      activeLogins -= 1;
      const session = `synthetic-session-${row.user_id}`;
      const csrf = `synthetic-csrf-${row.user_id}`;
      rowsBySession.set(session, row);
      return fakeResponse(200, {
        appSession: { actor: { id: row.user_id, role: row.role } },
      }, {
        cookies: [
          `aais_session=${session}; Secure; HttpOnly`,
          `aais_csrf=${csrf}; Secure`,
        ],
      });
    }

    const session = readCookie(request.headers?.cookie, "aais_session");
    const row = rowsBySession.get(session);
    if (url.pathname === "/api/auth/app-session" && request.method === "DELETE") {
      const csrf = readCookie(request.headers?.cookie, "aais_csrf");
      const validCsrf = request.headers?.["x-aais-csrf"] === csrf;
      if (!row || !validCsrf) {
        return fakeResponse(403, { sessionRevoked: false });
      }
      logoutCount += 1;
      if (session === "synthetic-negative-session") {
        negativeCleanupCount += 1;
      }
      rowsBySession.delete(session);
      return fakeResponse(200, { sessionRevoked: true });
    }
    if (!row) {
      return fakeResponse(401, {});
    }
    if (url.pathname === "/learning") {
      return fakeResponse(200, {});
    }
    if (url.pathname === "/dashboard") {
      return row.role === "teacher"
        ? fakeResponse(200, {})
        : fakeResponse(307, {}, { location: "/learning" });
    }
    if (url.pathname === "/admin/users") {
      return fakeResponse(307, {}, { location: "/learning" });
    }
    return fakeResponse(404, {});
  };

  return {
    fetchImpl,
    get maximumActiveLogins() {
      return maximumActiveLogins;
    },
    get logoutCount() {
      return logoutCount;
    },
    get negativeCleanupCount() {
      return negativeCleanupCount;
    },
    get activeSessionCount() {
      return rowsBySession.size;
    },
    get manualRedirectOnly() {
      return manualRedirectOnly;
    },
  };
}

function fakeResponse(status, body, options = {}) {
  return {
    status,
    headers: {
      getSetCookie: () => options.cookies ?? [],
      get: (name) => name.toLowerCase() === "location" ? options.location ?? null : null,
    },
    json: async () => body,
  };
}

function readCookie(header, name) {
  return String(header ?? "")
    .split(";")
    .map((part) => part.trim().split("="))
    .find(([key]) => key === name)?.[1] ?? null;
}

class FakeDisablePool {
  constructor(rows, options = {}) {
    this.users = new Map(rows.map((row) => [row.user_id, {
      id: row.user_id,
      normalized_email: row.account,
      role: row.role,
      status: "active",
      auth_version: 1,
    }]));
    this.enrollments = new Map(rows.map((row) => [row.user_id, {
      user_id: row.user_id,
      role: row.role,
      status: "active",
      course_id: row.course_id,
      cohort: row.cohort,
    }]));
    this.connections = { acquired: 0, released: 0 };
    this.transactions = { begun: 0, committed: 0, rolledBack: 0 };
    this.transactionSnapshot = null;
    this.failDisableEnrollment = options.failDisableEnrollment ?? false;
    this.failRollback = options.failRollback ?? false;
  }

  async connect() {
    this.connections.acquired += 1;
    return {
      query: (sql, params) => this.query(sql, params),
      release: () => {
        this.connections.released += 1;
      },
    };
  }

  async query(sql, params = []) {
    const normalized = sql.trim().toLowerCase();
    if (normalized === "begin") {
      this.transactionSnapshot = {
        users: cloneRecordMap(this.users),
        enrollments: cloneRecordMap(this.enrollments),
      };
      this.transactions.begun += 1;
      return { rows: [] };
    }
    if (normalized === "commit") {
      this.transactionSnapshot = null;
      this.transactions.committed += 1;
      return { rows: [] };
    }
    if (normalized === "rollback") {
      if (this.failRollback) {
        throw new Error("Synthetic rollback failure");
      }
      this.users = this.transactionSnapshot.users;
      this.enrollments = this.transactionSnapshot.enrollments;
      this.transactionSnapshot = null;
      this.transactions.rolledBack += 1;
      return { rows: [] };
    }
    if (sql.includes("pg_advisory_xact_lock")) {
      return { rows: [{ locked: true }] };
    }
    if (sql.includes("disable-preflight-users") || sql.includes("disable-postflight-users")) {
      return { rows: params[0].map((id) => ({ ...this.users.get(id) })) };
    }
    if (
      sql.includes("disable-preflight-enrollments")
      || sql.includes("disable-postflight-enrollments")
    ) {
      return { rows: params[0].map((id) => ({ ...this.enrollments.get(id) })) };
    }
    if (sql.includes("disable-users")) {
      const output = [];
      for (const id of params[0]) {
        const user = this.users.get(id);
        if (user.status === "active") {
          user.status = "disabled";
          user.auth_version += 1;
          output.push({ id, auth_version: user.auth_version });
        }
      }
      return { rows: output };
    }
    if (sql.includes("disable-enrollments")) {
      if (this.failDisableEnrollment) {
        throw new Error("Synthetic enrollment disable failure");
      }
      const output = [];
      for (const id of params[0]) {
        const enrollment = this.enrollments.get(id);
        if (enrollment.status !== "withdrawn") {
          enrollment.status = "withdrawn";
          output.push({ user_id: id });
        }
      }
      return { rows: output };
    }
    throw new Error("Unexpected synthetic disable query");
  }
}

function cloneRecordMap(map) {
  return new Map([...map].map(([key, value]) => [key, { ...value }]));
}

function assertNoCredentialValues(report, rows) {
  const serialized = JSON.stringify(report);
  for (const row of rows) {
    expect(serialized).not.toContain(row.account);
    expect(serialized).not.toContain(row.password);
    expect(serialized).not.toContain(row.user_id);
  }
}

async function makeTemporaryDirectory() {
  const temporaryPath = await mkdtemp(path.join(os.tmpdir(), "aais-account-manager-"));
  temporaryPaths.push(temporaryPath);
  return temporaryPath;
}

async function runGitFixture(args, cwd) {
  return execFileAsync("git", args, { cwd, encoding: "utf8" });
}

function expectedAccount(role, index) {
  const local = ["qa-20260827", role, String(index).padStart(3, "0")].join("-");
  const domain = ["accounts", "example", "test"].join(".");
  return `${local}@${domain}`;
}
