#!/usr/bin/env node

import { execFile } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import {
  chmod,
  lstat,
  mkdir,
  open,
  readFile,
  unlink,
} from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { fileURLToPath, pathToFileURL } from "node:url";

const execFileAsync = promisify(execFile);

export const AAIS_TEST_ACCOUNT_CSV_HEADER = Object.freeze([
  "batch_id",
  "role",
  "display_name",
  "account",
  "password",
  "course_id",
  "cohort",
  "user_id",
]);
export const AAIS_TEST_ACCOUNT_EXPECTED_COUNT = 42;
export const AAIS_TEST_ACCOUNT_STUDENT_COUNT = 40;
export const AAIS_TEST_ACCOUNT_TEACHER_COUNT = 2;
export const AAIS_TEST_ACCOUNT_VERIFY_CONCURRENCY = 2;
export const AAIS_TEST_ACCOUNT_REPORT_SCHEMA = "aais-test-account-provisioning/v1";
export const AAIS_TEST_ACCOUNT_PRODUCTION_PROJECT_ID = "prj_sKF9lhawVQyjxnv3jLyZvQH95Z1c";
export const AAIS_TEST_ACCOUNT_PRODUCTION_BASE_URL = "https://www.aais.site";
export const AAIS_TEST_ACCOUNT_VERCEL_CLI_VERSION = "59.7.0";
export const AAIS_TEST_ACCOUNT_REQUEST_TIMEOUT_MS = 15_000;
export const AAIS_TEST_ACCOUNT_BATCH_ID = "AAIS-PROD-QA-20260827-40S-2T";
export const AAIS_TEST_ACCOUNT_COURSE_ID = "cognitive-apprenticeship";
export const AAIS_TEST_ACCOUNT_COHORT = "qa-20260827-40s-2t";
export const AAIS_TEST_ACCOUNT_CUSTODY_PATH =
  `output/private-account-batches/${AAIS_TEST_ACCOUNT_BATCH_ID}/credentials.csv`;

const accountDomain = "accounts.example.test";
const passwordPattern = /^[A-Za-z0-9_-]{24}$/;
const courseIdPattern = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const cohortPattern = /^[A-Za-z0-9][A-Za-z0-9._: -]{0,127}$/;
const commitShaPattern = /^[a-f0-9]{40}$/;
const vercelDeploymentIdPattern = /^dpl_[A-Za-z0-9]+$/;
const redirectStatuses = new Set([302, 303, 307, 308]);
const productionManagerCommands = new Set(["provision", "verify", "disable"]);
const pinnedVercelCliVersionEnv = "AAIS_TEST_ACCOUNT_PINNED_VERCEL_CLI_VERSION";
const githubRepository = "HUDongpin/AAIS";
const vercelBotAccount = Object.freeze({
  login: "vercel[bot]",
  id: 35613825,
  node_id: "MDM6Qm90MzU2MTM4MjU=",
  type: "Bot",
});

export class AaisTestAccountManagerError extends Error {
  constructor(code, details = {}) {
    super(code);
    this.name = "AaisTestAccountManagerError";
    this.code = code;
    this.details = details;
  }
}

export function getAaisTestAccountDatabasePoolConfig(connectionString) {
  return {
    connectionString,
    connectionTimeoutMillis: 5_000,
    statement_timeout: 30_000,
    query_timeout: 35_000,
    idle_in_transaction_session_timeout: 30_000,
  };
}

export function createAaisTestAccountRows(input) {
  const batchId = requireBatchId(input?.batchId);
  const courseId = requireCourseId(input?.courseId);
  const cohort = requireCohort(input?.cohort);
  const randomBytesImpl = input?.randomBytesImpl ?? randomBytes;
  const passwords = new Set();
  const rows = [];

  const addRows = (role, count, displayLabel) => {
    for (let index = 1; index <= count; index += 1) {
      const account = expectedAccount(batchId, role, index);
      const password = createUniquePassword(randomBytesImpl, passwords);
      rows.push({
        batch_id: batchId,
        role,
        display_name: `${displayLabel} ${String(index).padStart(2, "0")}`,
        account,
        password,
        course_id: courseId,
        cohort,
        user_id: createAaisTestUserId(account),
      });
    }
  };

  addRows("student", AAIS_TEST_ACCOUNT_STUDENT_COUNT, "测试学生");
  addRows("teacher", AAIS_TEST_ACCOUNT_TEACHER_COUNT, "测试教师");
  validateAaisTestAccountRows(rows, {
    batchId,
    courseId,
    cohort,
    expectedCount: AAIS_TEST_ACCOUNT_EXPECTED_COUNT,
  });
  return rows;
}

export function createAaisTestUserId(account) {
  return `user-${createHash("sha256")
    .update(`aais-user:${String(account).trim().toLowerCase()}`)
    .digest("hex")
    .slice(0, 16)}`;
}

export function serializeAaisTestAccountCsv(rows) {
  return [
    AAIS_TEST_ACCOUNT_CSV_HEADER.map(escapeCsvField).join(","),
    ...rows.map((row) => AAIS_TEST_ACCOUNT_CSV_HEADER
      .map((column) => escapeCsvField(row[column]))
      .join(",")),
    "",
  ].join("\n");
}

export function parseAaisTestAccountCsv(text) {
  const records = parseCsvRecords(String(text ?? ""));
  if (records.length < 2) {
    throw managerError("AAIS_TEST_ACCOUNT_CSV_EMPTY");
  }
  const header = records[0];
  if (
    header.length !== AAIS_TEST_ACCOUNT_CSV_HEADER.length
    || header.some((column, index) => column !== AAIS_TEST_ACCOUNT_CSV_HEADER[index])
  ) {
    throw managerError("AAIS_TEST_ACCOUNT_CSV_HEADER_INVALID");
  }
  return records.slice(1).map((record) => {
    if (record.length !== AAIS_TEST_ACCOUNT_CSV_HEADER.length) {
      throw managerError("AAIS_TEST_ACCOUNT_CSV_ROW_INVALID");
    }
    return Object.fromEntries(AAIS_TEST_ACCOUNT_CSV_HEADER.map((column, index) => [
      column,
      record[index],
    ]));
  });
}

export function validateAaisTestAccountRows(rows, expected = {}) {
  if (!Array.isArray(rows) || rows.length !== AAIS_TEST_ACCOUNT_EXPECTED_COUNT) {
    throw managerError("AAIS_TEST_ACCOUNT_COUNT_INVALID");
  }
  if (
    expected.expectedCount !== undefined
    && Number(expected.expectedCount) !== AAIS_TEST_ACCOUNT_EXPECTED_COUNT
  ) {
    throw managerError("AAIS_TEST_ACCOUNT_EXPECTED_COUNT_INVALID");
  }
  const batchId = requireBatchId(expected.batchId ?? rows[0]?.batch_id);
  const courseId = requireCourseId(expected.courseId ?? rows[0]?.course_id);
  const cohort = requireCohort(expected.cohort ?? rows[0]?.cohort);
  const accounts = new Set();
  const passwords = new Set();
  const userIds = new Set();

  rows.forEach((row, rowIndex) => {
    const role = rowIndex < AAIS_TEST_ACCOUNT_STUDENT_COUNT ? "student" : "teacher";
    const roleIndex = role === "student"
      ? rowIndex + 1
      : rowIndex - AAIS_TEST_ACCOUNT_STUDENT_COUNT + 1;
    const displayLabel = role === "student" ? "测试学生" : "测试教师";
    const account = expectedAccount(batchId, role, roleIndex);
    const userId = createAaisTestUserId(account);
    if (
      row?.batch_id !== batchId
      || row?.role !== role
      || row?.display_name !== `${displayLabel} ${String(roleIndex).padStart(2, "0")}`
      || row?.account !== account
      || !passwordPattern.test(String(row?.password ?? ""))
      || row?.course_id !== courseId
      || row?.cohort !== cohort
      || row?.user_id !== userId
    ) {
      throw managerError("AAIS_TEST_ACCOUNT_CSV_ROW_INVALID");
    }
    if (accounts.has(account) || passwords.has(row.password) || userIds.has(userId)) {
      throw managerError("AAIS_TEST_ACCOUNT_CREDENTIAL_DUPLICATE");
    }
    accounts.add(account);
    passwords.add(row.password);
    userIds.add(userId);
  });

  return {
    batchId,
    courseId,
    cohort,
    count: rows.length,
    roles: {
      student: AAIS_TEST_ACCOUNT_STUDENT_COUNT,
      teacher: AAIS_TEST_ACCOUNT_TEACHER_COUNT,
      admin: 0,
    },
  };
}

export async function generateAaisTestAccountBatch(input) {
  const outputPath = path.resolve(String(input?.outputPath ?? ""));
  if (!String(input?.outputPath ?? "").trim()) {
    throw managerError("AAIS_TEST_ACCOUNT_OUTPUT_REQUIRED");
  }
  // Generate and validate the entire batch before creating a directory or file.
  const rows = createAaisTestAccountRows(input);
  const csv = serializeAaisTestAccountCsv(rows);
  const privatePath = await preparePrivateOutputPath({
    outputPath,
    cwd: input?.cwd,
    gitRoot: input?.gitRoot,
    isIgnored: input?.isIgnored,
    isTracked: input?.isTracked,
  });
  let fileHandle;
  let created = false;
  const openImpl = input?.openImpl ?? open;
  const unlinkImpl = input?.unlinkImpl ?? unlink;
  try {
    fileHandle = await openImpl(privatePath.outputPath, "wx", 0o600);
    created = true;
    await fileHandle.writeFile(csv, "utf8");
    await fileHandle.sync();
    await fileHandle.close();
    fileHandle = undefined;
    await chmod(privatePath.outputPath, 0o600);
    const metadata = await lstat(privatePath.outputPath);
    if (!metadata.isFile() || metadata.isSymbolicLink() || (metadata.mode & 0o777) !== 0o600) {
      throw managerError("AAIS_TEST_ACCOUNT_OUTPUT_PERMISSIONS_INVALID");
    }
  } catch (error) {
    let cleanupFailed = false;
    if (fileHandle) {
      try {
        await fileHandle.close();
      } catch {
        cleanupFailed = true;
      }
      fileHandle = undefined;
    }
    if (created) {
      try {
        const partial = await lstat(privatePath.outputPath);
        if (!partial.isFile() || partial.isSymbolicLink()) {
          cleanupFailed = true;
        } else {
          await unlinkImpl(privatePath.outputPath);
        }
      } catch (cleanupError) {
        if (cleanupError?.code !== "ENOENT") {
          cleanupFailed = true;
        }
      }
    }
    if (cleanupFailed) {
      throw managerError("AAIS_TEST_ACCOUNT_OUTPUT_CLEANUP_FAILED");
    }
    if (isManagerError(error)) {
      throw error;
    }
    throw managerError(error?.code === "EEXIST"
      ? "AAIS_TEST_ACCOUNT_OUTPUT_EXISTS"
      : "AAIS_TEST_ACCOUNT_OUTPUT_WRITE_FAILED");
  }
  const binding = validateAaisTestAccountRows(rows, input);
  return {
    schema: AAIS_TEST_ACCOUNT_REPORT_SCHEMA,
    schemaVersion: 1,
    status: "pass",
    command: "generate",
    batchId: binding.batchId,
    count: binding.count,
    roles: binding.roles,
    courseId: binding.courseId,
    cohort: binding.cohort,
    output: {
      gitIgnored: true,
      exclusiveCreate: true,
      directoryMode: "0700",
      fileMode: "0600",
    },
    redaction: credentialRedaction(),
    secrets: "redacted",
  };
}

export async function readAaisTestAccountCsvFile(input) {
  const inputPath = path.resolve(String(input?.inputPath ?? ""));
  if (!String(input?.inputPath ?? "").trim()) {
    throw managerError("AAIS_TEST_ACCOUNT_INPUT_REQUIRED");
  }
  const privatePath = await assertPrivateInputPath({
    inputPath,
    cwd: input?.cwd,
    gitRoot: input?.gitRoot,
    isIgnored: input?.isIgnored,
    isTracked: input?.isTracked,
  });
  const text = await readFile(privatePath.inputPath, "utf8").catch(() => {
    throw managerError("AAIS_TEST_ACCOUNT_INPUT_READ_FAILED");
  });
  const rows = parseAaisTestAccountCsv(text);
  const binding = validateAaisTestAccountRows(rows, input);
  return {
    rows,
    binding,
    gitRoot: privatePath.gitRoot,
  };
}

export function assertAaisUserSeedCapabilities(seedModule) {
  const capabilities = seedModule?.AAIS_USER_SEED_CAPABILITIES;
  const aggregates = new Set(capabilities?.reportAggregates ?? []);
  if (
    capabilities?.version !== 1
    || capabilities?.atomicBatch !== true
    || capabilities?.batchAdvisoryLock !== true
    || capabilities?.transactionValidationHooks !== true
    || !Array.isArray(capabilities?.modes)
    || !capabilities.modes.includes("create-only")
    || !["created", "updated", "collisions", "enrollments"]
      .every((field) => aggregates.has(field))
    || typeof seedModule?.parseAaisUserSeedJson !== "function"
    || typeof seedModule?.runAaisUserSeed !== "function"
  ) {
    throw managerError("AAIS_TEST_ACCOUNT_SEED_CAPABILITY_MISSING");
  }
  return capabilities;
}

export async function provisionAaisTestAccountBatch(input) {
  const binding = validateAaisTestAccountRows(input?.rows, input);
  assertProductionGate(input, binding);
  assertAaisUserSeedCapabilities(input?.seedModule);
  const users = input.seedModule.parseAaisUserSeedJson(JSON.stringify(input.rows.map((row) => ({
    email: row.account,
    displayName: row.display_name,
    role: row.role,
    status: "active",
    password: row.password,
  }))));
  if (
    users.length !== binding.count
    || users.some((user, index) => user.id !== input.rows[index].user_id)
  ) {
    throw managerError("AAIS_TEST_ACCOUNT_SEED_IDENTITY_MISMATCH");
  }

  let seedReport;
  let preflight;
  let transactionalDatabase;
  try {
    seedReport = await input.seedModule.runAaisUserSeed({
      database: input.database,
      users,
      courseId: binding.courseId,
      cohort: binding.cohort,
      mode: "create-only",
      batchId: binding.batchId,
      now: input.now,
      validateBeforeWrite: async ({ database }) => {
        preflight = await readProvisionPreflight(database, binding.courseId);
      },
      validateBeforeCommit: async ({ database, report }) => {
        assertCreateOnlySeedReport(report, binding.count);
        transactionalDatabase = await readDatabaseBatchAggregate({
          database,
          rows: input.rows,
          courseId: binding.courseId,
          cohort: binding.cohort,
        });
        assertExpectedDatabaseAggregate(transactionalDatabase);
      },
    });
  } catch (error) {
    if (error?.code === "AAIS_USER_SEED_ROLLBACK_FAILED") {
      throw managerError("AAIS_TEST_ACCOUNT_PROVISION_ROLLBACK_FAILED");
    }
    const reportedCollisions = error?.aggregate?.collisions ?? error?.collisions;
    const collisions = Number.isSafeInteger(reportedCollisions)
      ? reportedCollisions
      : undefined;
    throw managerError("AAIS_TEST_ACCOUNT_PROVISION_FAILED", collisions === undefined
      ? {}
      : { collisions });
  }
  let database;
  try {
    assertCreateOnlySeedReport(seedReport, binding.count);
    if (!preflight || !transactionalDatabase) {
      throw managerError("AAIS_TEST_ACCOUNT_SEED_VALIDATION_HOOK_MISSING");
    }
    database = await readDatabaseBatchAggregate({
      database: input.database,
      rows: input.rows,
      courseId: binding.courseId,
      cohort: binding.cohort,
    });
    assertExpectedDatabaseAggregate(database);
  } catch {
    throw managerError("AAIS_TEST_ACCOUNT_PROVISION_COMMITTED_UNVERIFIED", {
      committed: true,
      transactionValidation: preflight && transactionalDatabase ? "passed" : "unconfirmed",
      postCommitVerification: "failed",
      retryProvisioning: "forbidden",
    });
  }

  return {
    schema: AAIS_TEST_ACCOUNT_REPORT_SCHEMA,
    schemaVersion: 1,
    status: "pass",
    command: "provision",
    target: "production",
    batchId: binding.batchId,
    deployment: productionDeploymentReceipt(input),
    sourceEnv: String(input.sourceEnv ?? "unknown"),
    preflight,
    transactionValidation: {
      beforeWrite: "passed",
      beforeCommit: "passed",
      aggregate: transactionalDatabase,
    },
    seed: {
      mode: "create-only",
      upserted: seedReport.upserted,
      created: seedReport.created,
      updated: seedReport.updated,
      collisions: seedReport.collisions,
      enrollments: seedReport.enrollments,
    },
    database,
    redaction: credentialRedaction(),
    secrets: "redacted",
  };
}

export async function verifyAaisTestAccountBatch(input) {
  const binding = validateAaisTestAccountRows(input?.rows, input);
  assertProductionGate(input, binding);
  const baseUrl = requireProductionBaseUrl(input?.baseUrl);
  const requestTimeoutMs = requireRequestTimeoutMs(input?.requestTimeoutMs);
  const fetchImpl = createBoundedProductionFetch(input?.fetchImpl ?? fetch, requestTimeoutMs);
  const negativeAuth = await verifyNegativeAuthenticationCases({
    rows: input.rows,
    baseUrl,
    fetchImpl,
    batchId: binding.batchId,
  });
  const results = await runWithConcurrency(
    input.rows,
    AAIS_TEST_ACCOUNT_VERIFY_CONCURRENCY,
    (row) => verifyOneAccount({ row, baseUrl, fetchImpl }),
  );
  const checks = aggregateVerificationChecks(results);
  const passed = results.filter((result) => result.status === "passed");
  const failed = results.filter((result) => result.status !== "passed");
  const roleResults = {
    student: summarizeVerificationRole(results, "student"),
    teacher: summarizeVerificationRole(results, "teacher"),
    admin: summarizeVerificationRole(results, "admin"),
  };
  const status = failed.length === 0
    && passed.length === binding.count
    && negativeAuth.failed === 0
    ? "pass"
    : "failed";
  const postVerificationAttestation = await readPostVerificationAttestation(input, binding);
  assertStableProductionDeployment(input.productionAttestation, postVerificationAttestation);
  return {
    schema: AAIS_TEST_ACCOUNT_REPORT_SCHEMA,
    schemaVersion: 1,
    status,
    command: "verify",
    target: "production",
    batchId: binding.batchId,
    deployment: productionDeploymentReceipt(input, {
      baseUrl,
      reAttestedAfterVerification: true,
    }),
    concurrency: AAIS_TEST_ACCOUNT_VERIFY_CONCURRENCY,
    requestTimeoutMs,
    results: {
      expected: binding.count,
      attempted: results.length,
      passed: passed.length,
      failed: failed.length,
      roles: roleResults,
      checks,
      negativeAuth,
      failures: summarizeVerificationFailures(failed),
    },
    redaction: credentialRedaction(),
    secrets: "redacted",
  };
}

export async function auditAaisTestAccountsInGit(input) {
  const binding = validateAaisTestAccountRows(input?.rows, input);
  const trackedContents = input?.trackedContents ?? [];
  const stagedContents = input?.stagedContents ?? [];
  const headExpected = Number(input?.headExpected ?? trackedContents.length);
  const indexExpected = Number(input?.indexExpected ?? stagedContents.length);
  if (
    !Number.isSafeInteger(headExpected)
    || !Number.isSafeInteger(indexExpected)
    || headExpected < 0
    || indexExpected < 0
    || trackedContents.length !== headExpected
    || stagedContents.length !== indexExpected
  ) {
    throw managerError("AAIS_TEST_ACCOUNT_GIT_AUDIT_DENOMINATOR_MISMATCH");
  }
  const exactValues = {
    accounts: input.rows.map((row) => row.account),
    passwords: input.rows.map((row) => row.password),
    userIds: input.rows.map((row) => row.user_id),
  };
  const tracked = scanExactValues(trackedContents, exactValues);
  const staged = scanExactValues(stagedContents, exactValues);
  const totalOccurrences = tracked.totalOccurrences + staged.totalOccurrences;
  return {
    schema: AAIS_TEST_ACCOUNT_REPORT_SCHEMA,
    schemaVersion: 1,
    status: totalOccurrences === 0 ? "pass" : "failed",
    command: "audit-git",
    batchId: binding.batchId,
    sources: {
      head: { expected: headExpected, scanned: trackedContents.length },
      index: { expected: indexExpected, scanned: stagedContents.length },
    },
    valuesScanned: {
      accounts: exactValues.accounts.length,
      passwords: exactValues.passwords.length,
      userIds: exactValues.userIds.length,
    },
    tracked,
    staged,
    redaction: {
      exactValues: "omitted",
      filePaths: "omitted",
      matches: "counts-only",
    },
    secrets: "redacted",
  };
}

export async function disableAaisTestAccountBatch(input) {
  const binding = validateAaisTestAccountRows(input?.rows, input);
  assertProductionGate(input, binding);
  const databaseHandle = await acquireSingleDatabaseConnection(input?.database);
  const database = databaseHandle.database;
  const userIds = input.rows.map((row) => row.user_id);
  const expectedById = new Map(input.rows.map((row) => [row.user_id, row]));
  const updatedAt = (input?.now ?? new Date()).toISOString();
  let transactionStarted = false;
  try {
    await database.query("begin");
    transactionStarted = true;
    await database.query(
      "select pg_advisory_xact_lock(hashtextextended($1, 0))",
      [`aais-test-account-disable:${binding.batchId}`],
    );
    const beforeUsers = await database.query(
      `/* aais-test-accounts:disable-preflight-users */
       select id, normalized_email, role, status, auth_version
         from aais_users
        where id = any($1::text[])
        for update`,
      [userIds],
    );
    const users = validateExactUserRows(beforeUsers.rows, expectedById);
    const beforeEnrollments = await database.query(
      `/* aais-test-accounts:disable-preflight-enrollments */
       select user_id, role, status, course_id, cohort
         from aais_enrollments
        where user_id = any($1::text[])
          and course_id = $2
          and cohort = $3
        for update`,
      [userIds, binding.courseId, binding.cohort],
    );
    const enrollments = validateExactEnrollmentRows(
      beforeEnrollments.rows,
      expectedById,
      binding,
    );
    const activeIds = users.filter((row) => row.status === "active").map((row) => row.id);
    const withdrawableEnrollmentIds = enrollments
      .filter((row) => row.status !== "withdrawn")
      .map((row) => row.user_id);

    if (activeIds.length > 0) {
      const disabled = await database.query(
        `/* aais-test-accounts:disable-users */
         update aais_users
            set status = 'disabled',
                auth_version = auth_version + 1,
                updated_at = $2::timestamptz
          where id = any($1::text[])
            and status = 'active'
        returning id, auth_version`,
        [activeIds, updatedAt],
      );
      if (disabled.rows.length !== activeIds.length) {
        throw managerError("AAIS_TEST_ACCOUNT_DISABLE_USER_COUNT_MISMATCH");
      }
    }
    if (withdrawableEnrollmentIds.length > 0) {
      const withdrawn = await database.query(
        `/* aais-test-accounts:disable-enrollments */
         update aais_enrollments
            set status = 'withdrawn',
                updated_at = $4::timestamptz
          where user_id = any($1::text[])
            and course_id = $2
            and cohort = $3
            and status <> 'withdrawn'
        returning user_id`,
        [withdrawableEnrollmentIds, binding.courseId, binding.cohort, updatedAt],
      );
      if (withdrawn.rows.length !== withdrawableEnrollmentIds.length) {
        throw managerError("AAIS_TEST_ACCOUNT_DISABLE_ENROLLMENT_COUNT_MISMATCH");
      }
    }

    const afterUsers = await database.query(
      `/* aais-test-accounts:disable-postflight-users */
       select id, normalized_email, role, status, auth_version
         from aais_users
        where id = any($1::text[])
        order by id`,
      [userIds],
    );
    const postUsers = validateExactUserRows(afterUsers.rows, expectedById);
    const beforeVersionById = new Map(users.map((row) => [row.id, row.auth_version]));
    for (const row of postUsers) {
      const previous = beforeVersionById.get(row.id);
      const wasActive = users.find((candidate) => candidate.id === row.id)?.status === "active";
      if (
        row.status !== "disabled"
        || row.auth_version !== previous + (wasActive ? 1 : 0)
      ) {
        throw managerError("AAIS_TEST_ACCOUNT_DISABLE_AUTH_VERSION_MISMATCH");
      }
    }
    const afterEnrollments = await database.query(
      `/* aais-test-accounts:disable-postflight-enrollments */
       select user_id, role, status, course_id, cohort
         from aais_enrollments
        where user_id = any($1::text[])
          and course_id = $2
          and cohort = $3
        order by user_id`,
      [userIds, binding.courseId, binding.cohort],
    );
    const postEnrollments = validateExactEnrollmentRows(
      afterEnrollments.rows,
      expectedById,
      binding,
    );
    if (postEnrollments.some((row) => row.status !== "withdrawn")) {
      throw managerError("AAIS_TEST_ACCOUNT_DISABLE_POSTFLIGHT_INVALID");
    }
    await database.query("commit");
    transactionStarted = false;
    databaseHandle.release();

    return {
      schema: AAIS_TEST_ACCOUNT_REPORT_SCHEMA,
      schemaVersion: 1,
      status: "pass",
      command: "disable",
      target: "production",
      batchId: binding.batchId,
      deployment: productionDeploymentReceipt(input),
      users: {
        matched: postUsers.length,
        newlyDisabled: activeIds.length,
        alreadyDisabled: postUsers.length - activeIds.length,
        authVersionsIncremented: activeIds.length,
      },
      enrollments: {
        matched: postEnrollments.length,
        newlyWithdrawn: withdrawableEnrollmentIds.length,
        alreadyWithdrawn: postEnrollments.length - withdrawableEnrollmentIds.length,
      },
      redaction: credentialRedaction(),
      secrets: "redacted",
    };
  } catch (error) {
    let rollbackFailed = false;
    if (transactionStarted) {
      try {
        await database.query("rollback");
      } catch {
        rollbackFailed = true;
      }
    }
    databaseHandle.release();
    if (rollbackFailed) {
      throw managerError("AAIS_TEST_ACCOUNT_DISABLE_ROLLBACK_FAILED");
    }
    if (isManagerError(error)) {
      throw error;
    }
    throw managerError("AAIS_TEST_ACCOUNT_DISABLE_FAILED");
  }
}

export async function collectAaisGitContents(input = {}) {
  const gitRoot = path.resolve(input.gitRoot ?? await resolveGitRoot(input.cwd));
  const runGitImpl = input.runGitImpl ?? runGit;
  try {
    const trackedPaths = splitNul((await runGitImpl([
      "ls-tree",
      "-r",
      "-z",
      "--name-only",
      "HEAD",
    ], gitRoot)).stdout);
    const stagedPaths = splitNul((await runGitImpl(["ls-files", "-z"], gitRoot)).stdout);
    const trackedContents = [];
    for (const relativePath of trackedPaths) {
      const result = await runGitImpl(
        ["show", `HEAD:${relativePath}`],
        gitRoot,
        { encoding: null },
      );
      trackedContents.push(result.stdout);
    }
    const stagedContents = [];
    for (const relativePath of stagedPaths) {
      const result = await runGitImpl(["show", `:${relativePath}`], gitRoot, { encoding: null });
      stagedContents.push(result.stdout);
    }
    return {
      gitRoot,
      trackedContents,
      stagedContents,
      headExpected: trackedPaths.length,
      indexExpected: stagedPaths.length,
    };
  } catch {
    throw managerError("AAIS_TEST_ACCOUNT_GIT_BLOB_READ_FAILED");
  }
}

export function parseAaisTestAccountManagerArgs(argv) {
  const args = [...argv];
  const command = args.shift() ?? "";
  if (command === "--help" || command === "-h" || command === "help") {
    return { command: "help" };
  }
  if (!["generate", "provision", "verify", "audit-git", "disable"].includes(command)) {
    throw managerError("AAIS_TEST_ACCOUNT_COMMAND_INVALID");
  }
  const options = { command, approved: false };
  const booleanFlags = new Set(["--approved", "--help"]);
  const valueFlags = new Map([
    ["--output", "outputPath"],
    ["--input", "inputPath"],
    ["--batch-id", "batchId"],
    ["--course-id", "courseId"],
    ["--cohort", "cohort"],
    ["--target", "target"],
    ["--expected-sha", "expectedSha"],
    ["--project-id", "projectId"],
    ["--expected-count", "expectedCount"],
    ["--base-url", "baseUrl"],
  ]);
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (booleanFlags.has(arg)) {
      if (arg === "--approved") {
        options.approved = true;
      } else {
        options.help = true;
      }
      continue;
    }
    const key = valueFlags.get(arg);
    if (!key || index + 1 >= args.length) {
      throw managerError("AAIS_TEST_ACCOUNT_ARGUMENT_INVALID");
    }
    options[key] = args[index + 1];
    index += 1;
  }
  assertAllowedCommandOptions(options);
  return options;
}

export function getAaisTestAccountManagerUsage() {
  const fixedBinding = `--batch-id ${AAIS_TEST_ACCOUNT_BATCH_ID} --course-id ${AAIS_TEST_ACCOUNT_COURSE_ID} --cohort ${AAIS_TEST_ACCOUNT_COHORT}`;
  const privateCsv = AAIS_TEST_ACCOUNT_CUSTODY_PATH;
  const productionPrefix = "npm run accounts:test-batch --";
  return [
    "Usage:",
    `  npm run accounts:test-batch -- generate --output ${privateCsv} ${fixedBinding}`,
    `  npm run accounts:test-batch -- audit-git --input ${privateCsv} ${fixedBinding} --expected-count 42`,
    `  ${productionPrefix} provision --input ${privateCsv} --target production --approved --expected-sha <40-hex> --project-id ${AAIS_TEST_ACCOUNT_PRODUCTION_PROJECT_ID} ${fixedBinding} --expected-count 42`,
    `  ${productionPrefix} verify --input ${privateCsv} --target production --approved --base-url ${AAIS_TEST_ACCOUNT_PRODUCTION_BASE_URL} --expected-sha <40-hex> --project-id ${AAIS_TEST_ACCOUNT_PRODUCTION_PROJECT_ID} ${fixedBinding} --expected-count 42`,
    `  ${productionPrefix} disable --input ${privateCsv} --target production --approved --expected-sha <40-hex> --project-id ${AAIS_TEST_ACCOUNT_PRODUCTION_PROJECT_ID} ${fixedBinding} --expected-count 42`,
    "",
    "Credential values are read only from the ignored mode-0600 CSV and are never printed.",
    "All non-generate commands emit aggregate JSON only; no receipt file is written.",
    `Production commands automatically use the pinned Vercel CLI ${AAIS_TEST_ACCOUNT_VERCEL_CLI_VERSION} wrapper.`,
    "",
  ].join("\n");
}

export async function runAaisTestAccountPinnedProductionCommand(argv, input = {}) {
  if (!productionManagerCommands.has(argv?.[0])) {
    throw managerError("AAIS_TEST_ACCOUNT_COMMAND_INVALID");
  }
  const execFileImpl = input.execFileImpl ?? execFileAsync;
  const cwd = input.cwd ?? process.cwd();
  const env = input.env ?? process.env;
  const commandOptions = {
    cwd,
    encoding: "utf8",
    maxBuffer: 16 * 1024 * 1024,
    env,
  };
  let versionResult;
  try {
    versionResult = await execFileImpl("npx", [
      "--yes",
      `vercel@${AAIS_TEST_ACCOUNT_VERCEL_CLI_VERSION}`,
      "--version",
    ], commandOptions);
  } catch {
    throw managerError("AAIS_TEST_ACCOUNT_VERCEL_CLI_ATTESTATION_FAILED");
  }
  if (String(versionResult.stdout ?? "").trim() !== AAIS_TEST_ACCOUNT_VERCEL_CLI_VERSION) {
    throw managerError("AAIS_TEST_ACCOUNT_VERCEL_CLI_ATTESTATION_FAILED");
  }

  const managerPath = fileURLToPath(import.meta.url);
  try {
    const result = await execFileImpl("npx", [
      "--yes",
      `vercel@${AAIS_TEST_ACCOUNT_VERCEL_CLI_VERSION}`,
      "env",
      "run",
      "-e",
      "production",
      "--",
      process.execPath,
      managerPath,
      ...argv,
    ], {
      ...commandOptions,
      env: {
        ...env,
        [pinnedVercelCliVersionEnv]: AAIS_TEST_ACCOUNT_VERCEL_CLI_VERSION,
      },
    });
    return {
      exitCode: 0,
      stdout: String(result.stdout ?? ""),
      stderr: String(result.stderr ?? ""),
    };
  } catch (error) {
    if (!Number.isInteger(error?.code)) {
      throw managerError("AAIS_TEST_ACCOUNT_VERCEL_ENV_RUN_FAILED");
    }
    return {
      exitCode: Number(error.code),
      stdout: String(error.stdout ?? ""),
      stderr: String(error.stderr ?? ""),
    };
  }
}

export async function runAaisTestAccountManagerCli(argv, input = {}) {
  const options = parseAaisTestAccountManagerArgs(argv);
  if (options.command === "help" || options.help) {
    return { usage: getAaisTestAccountManagerUsage() };
  }
  if (options.command === "generate") {
    requireGenerateOptions(options);
    return {
      report: await generateAaisTestAccountBatch({
        ...options,
        cwd: input.cwd,
      }),
    };
  }

  requireBatchInputOptions(options);
  const loaded = await readAaisTestAccountCsvFile({
    ...options,
    cwd: input.cwd,
  });
  if (options.command === "audit-git") {
    const git = await collectAaisGitContents({
      cwd: input.cwd,
      gitRoot: loaded.gitRoot,
    });
    const report = await auditAaisTestAccountsInGit({
      ...options,
      rows: loaded.rows,
      trackedContents: git.trackedContents,
      stagedContents: git.stagedContents,
      headExpected: git.headExpected,
      indexExpected: git.indexExpected,
    });
    return { report, failed: report.status !== "pass" };
  }

  requireProductionOptions(options);
  const productionAttestation = await readProductionAttestation(loaded.gitRoot, options.expectedSha);
  if (options.command === "verify") {
    const report = await verifyAaisTestAccountBatch({
      ...options,
      rows: loaded.rows,
      productionAttestation,
      readPostVerificationAttestation: () =>
        readProductionAttestation(loaded.gitRoot, options.expectedSha),
    });
    return { report, failed: report.status !== "pass" };
  }

  return withAaisDatabaseClient(async ({ database, sourceEnv }) => {
    if (options.command === "provision") {
      const seedModule = await import("./seed-aais-users.mjs");
      return {
        report: await provisionAaisTestAccountBatch({
          ...options,
          rows: loaded.rows,
          productionAttestation,
          database,
          sourceEnv,
          seedModule,
        }),
      };
    }
    return {
      report: await disableAaisTestAccountBatch({
        ...options,
        rows: loaded.rows,
        productionAttestation,
        database,
      }),
    };
  });
}

function createUniquePassword(randomBytesImpl, existing) {
  for (let attempt = 0; attempt < 32; attempt += 1) {
    const bytes = randomBytesImpl(18);
    if (!Buffer.isBuffer(bytes) || bytes.length !== 18) {
      throw managerError("AAIS_TEST_ACCOUNT_RANDOM_SOURCE_INVALID");
    }
    const password = bytes.toString("base64url");
    if (passwordPattern.test(password) && !existing.has(password)) {
      existing.add(password);
      return password;
    }
  }
  throw managerError("AAIS_TEST_ACCOUNT_RANDOM_COLLISION");
}

function expectedAccount(batchId, role, index) {
  const date = batchId.slice("AAIS-PROD-QA-".length, "AAIS-PROD-QA-".length + 8);
  return `qa-${date}-${role}-${String(index).padStart(3, "0")}@${accountDomain}`;
}

function requireBatchId(value) {
  const batchId = String(value ?? "").trim();
  if (batchId !== AAIS_TEST_ACCOUNT_BATCH_ID) {
    throw managerError("AAIS_TEST_ACCOUNT_BATCH_ID_INVALID");
  }
  return batchId;
}

function requireCourseId(value) {
  const courseId = String(value ?? "").trim();
  if (!courseIdPattern.test(courseId) || courseId !== AAIS_TEST_ACCOUNT_COURSE_ID) {
    throw managerError("AAIS_TEST_ACCOUNT_COURSE_ID_INVALID");
  }
  return courseId;
}

function requireCohort(value) {
  const cohort = String(value ?? "").trim();
  if (!cohortPattern.test(cohort) || cohort !== AAIS_TEST_ACCOUNT_COHORT) {
    throw managerError("AAIS_TEST_ACCOUNT_COHORT_INVALID");
  }
  return cohort;
}

function escapeCsvField(value) {
  const text = String(value ?? "");
  if (/[",\r\n]/.test(text)) {
    return `"${text.replaceAll('"', '""')}"`;
  }
  return text;
}

function parseCsvRecords(text) {
  if (!text || text.includes("\0")) {
    throw managerError("AAIS_TEST_ACCOUNT_CSV_INVALID");
  }
  const records = [];
  let record = [];
  let field = "";
  let quoted = false;
  let quoteClosed = false;
  const pushRecord = () => {
    record.push(field);
    if (!(record.length === 1 && record[0] === "")) {
      records.push(record);
    }
    record = [];
    field = "";
    quoteClosed = false;
  };
  for (let index = 0; index < text.length; index += 1) {
    const character = text[index];
    if (quoted) {
      if (character === '"') {
        if (text[index + 1] === '"') {
          field += '"';
          index += 1;
        } else {
          quoted = false;
          quoteClosed = true;
        }
      } else {
        field += character;
      }
      continue;
    }
    if (character === '"') {
      if (field || quoteClosed) {
        throw managerError("AAIS_TEST_ACCOUNT_CSV_INVALID");
      }
      quoted = true;
      continue;
    }
    if (character === ",") {
      record.push(field);
      field = "";
      quoteClosed = false;
      continue;
    }
    if (character === "\n") {
      pushRecord();
      continue;
    }
    if (character === "\r") {
      if (text[index + 1] !== "\n") {
        throw managerError("AAIS_TEST_ACCOUNT_CSV_INVALID");
      }
      continue;
    }
    if (quoteClosed) {
      throw managerError("AAIS_TEST_ACCOUNT_CSV_INVALID");
    }
    field += character;
  }
  if (quoted) {
    throw managerError("AAIS_TEST_ACCOUNT_CSV_INVALID");
  }
  if (record.length > 0 || field) {
    pushRecord();
  }
  return records;
}

async function preparePrivateOutputPath(input) {
  const cwd = path.resolve(input.cwd ?? process.cwd());
  const gitRoot = path.resolve(input.gitRoot ?? await resolveGitRoot(cwd));
  const outputPath = path.resolve(input.outputPath);
  assertExactCustodyPath(gitRoot, outputPath);
  await assertIgnoredUntrackedPath({ ...input, gitRoot, absolutePath: outputPath });
  await assertNoSymlinkComponents(gitRoot, outputPath);
  try {
    await lstat(outputPath);
    throw managerError("AAIS_TEST_ACCOUNT_OUTPUT_EXISTS");
  } catch (error) {
    if (isManagerError(error)) {
      throw error;
    }
    if (error?.code !== "ENOENT") {
      throw managerError("AAIS_TEST_ACCOUNT_OUTPUT_INVALID");
    }
  }
  const outputDirectory = path.dirname(outputPath);
  await mkdir(outputDirectory, { recursive: true, mode: 0o700 });
  await assertNoSymlinkComponents(gitRoot, outputDirectory);
  await chmod(outputDirectory, 0o700);
  const directoryMetadata = await lstat(outputDirectory);
  if (
    !directoryMetadata.isDirectory()
    || directoryMetadata.isSymbolicLink()
    || (directoryMetadata.mode & 0o777) !== 0o700
  ) {
    throw managerError("AAIS_TEST_ACCOUNT_OUTPUT_DIRECTORY_INVALID");
  }
  return { outputPath, gitRoot };
}

async function assertPrivateInputPath(input) {
  const cwd = path.resolve(input.cwd ?? process.cwd());
  const gitRoot = path.resolve(input.gitRoot ?? await resolveGitRoot(cwd));
  const inputPath = path.resolve(input.inputPath);
  assertExactCustodyPath(gitRoot, inputPath);
  await assertIgnoredUntrackedPath({ ...input, gitRoot, absolutePath: inputPath });
  await assertNoSymlinkComponents(gitRoot, inputPath);
  let metadata;
  try {
    metadata = await lstat(inputPath);
  } catch {
    throw managerError("AAIS_TEST_ACCOUNT_INPUT_INVALID");
  }
  if (
    !metadata.isFile()
    || metadata.isSymbolicLink()
    || (metadata.mode & 0o777) !== 0o600
  ) {
    throw managerError("AAIS_TEST_ACCOUNT_INPUT_PERMISSIONS_INVALID");
  }
  const directoryMetadata = await lstat(path.dirname(inputPath));
  if (
    !directoryMetadata.isDirectory()
    || directoryMetadata.isSymbolicLink()
    || (directoryMetadata.mode & 0o777) !== 0o700
  ) {
    throw managerError("AAIS_TEST_ACCOUNT_INPUT_DIRECTORY_INVALID");
  }
  return { inputPath, gitRoot };
}

async function assertIgnoredUntrackedPath(input) {
  const relativePath = path.relative(input.gitRoot, input.absolutePath);
  if (!relativePath || relativePath.startsWith("..") || path.isAbsolute(relativePath)) {
    throw managerError("AAIS_TEST_ACCOUNT_PATH_OUTSIDE_REPOSITORY");
  }
  const isIgnored = input.isIgnored
    ? await input.isIgnored(input.absolutePath, input.gitRoot)
    : await isGitIgnored(relativePath, input.gitRoot);
  const isTracked = input.isTracked
    ? await input.isTracked(input.absolutePath, input.gitRoot)
    : await isGitTracked(relativePath, input.gitRoot);
  if (!isIgnored || isTracked) {
    throw managerError("AAIS_TEST_ACCOUNT_PATH_NOT_PRIVATE");
  }
}

async function assertNoSymlinkComponents(root, target) {
  const relativePath = path.relative(root, target);
  if (!relativePath || relativePath.startsWith("..") || path.isAbsolute(relativePath)) {
    throw managerError("AAIS_TEST_ACCOUNT_PATH_OUTSIDE_REPOSITORY");
  }
  let current = root;
  for (const component of relativePath.split(path.sep)) {
    current = path.join(current, component);
    try {
      const metadata = await lstat(current);
      if (metadata.isSymbolicLink()) {
        throw managerError("AAIS_TEST_ACCOUNT_PATH_SYMLINK_REJECTED");
      }
    } catch (error) {
      if (isManagerError(error)) {
        throw error;
      }
      if (error?.code !== "ENOENT") {
        throw managerError("AAIS_TEST_ACCOUNT_PATH_INVALID");
      }
    }
  }
}

async function resolveGitRoot(cwd = process.cwd()) {
  try {
    const result = await runGit(["rev-parse", "--show-toplevel"], cwd);
    return String(result.stdout).trim();
  } catch {
    throw managerError("AAIS_TEST_ACCOUNT_GIT_ROOT_UNAVAILABLE");
  }
}

async function isGitIgnored(relativePath, gitRoot) {
  try {
    await runGit(["check-ignore", "--no-index", "-q", "--", relativePath], gitRoot);
    return true;
  } catch {
    return false;
  }
}

async function isGitTracked(relativePath, gitRoot) {
  try {
    const result = await runGit(["ls-files", "-z", "--", relativePath], gitRoot);
    const matches = splitNul(result.stdout);
    if (matches.length > 1 || (matches.length === 1 && matches[0] !== relativePath)) {
      throw managerError("AAIS_TEST_ACCOUNT_PATH_PRIVACY_CHECK_FAILED");
    }
    return matches.length === 1;
  } catch {
    throw managerError("AAIS_TEST_ACCOUNT_PATH_PRIVACY_CHECK_FAILED");
  }
}

async function runGit(args, cwd, options = {}) {
  return execFileAsync("git", args, {
    cwd,
    encoding: options.encoding === null ? null : "utf8",
    maxBuffer: 128 * 1024 * 1024,
  });
}

export function attestAaisProductionDeployment(input) {
  const expectedSha = String(input?.expectedSha ?? "");
  const inspect = input?.vercelInspect;
  const aliases = Array.isArray(inspect?.aliases) ? inspect.aliases : [];
  const inspectedOrigin = normalizeVercelDeploymentOrigin(inspect?.url);
  if (
    !commitShaPattern.test(expectedSha)
    || !vercelDeploymentIdPattern.test(String(inspect?.id ?? ""))
    || inspect?.name !== "aais"
    || inspect?.readyState !== "READY"
    || inspect?.target !== "production"
    || !aliases.includes("aais.site")
    || !aliases.includes("www.aais.site")
  ) {
    throw managerError("AAIS_TEST_ACCOUNT_PRODUCTION_DEPLOYMENT_INVALID");
  }

  const matches = [];
  for (const deployment of input?.githubDeployments ?? []) {
    if (
      !isPositiveInteger(deployment?.id)
      || deployment?.sha !== expectedSha
      || deployment?.ref !== expectedSha
      || deployment?.task !== "deploy"
      || deployment?.environment !== "Production"
      || !isExactVercelBot(deployment?.creator)
    ) {
      continue;
    }
    const statuses = input?.githubStatusesByDeploymentId?.[String(deployment.id)];
    const [latestStatus] = Array.isArray(statuses)
      ? statuses
        .filter((status) => isPositiveInteger(status?.id) && isExactVercelBot(status?.creator))
        .sort((left, right) => Number(right.id) - Number(left.id))
      : [];
    if (
      latestStatus?.state !== "success"
      || normalizeVercelDeploymentOrigin(latestStatus?.target_url) !== inspectedOrigin
      || normalizeVercelDeploymentOrigin(latestStatus?.environment_url) !== inspectedOrigin
    ) {
      continue;
    }
    matches.push({ deployment, status: latestStatus });
  }
  if (matches.length !== 1) {
    throw managerError("AAIS_TEST_ACCOUNT_PRODUCTION_DEPLOYMENT_INVALID");
  }
  const [{ deployment, status }] = matches;
  return {
    deployedGitSha: deployment.sha,
    vercelDeploymentId: inspect.id,
    vercelDeploymentUrl: new URL(inspectedOrigin).hostname,
    vercelDeploymentReadyState: inspect.readyState,
    vercelDeploymentTarget: inspect.target,
    githubDeploymentId: Number(deployment.id),
    githubDeploymentStatusId: Number(status.id),
    githubDeploymentState: status.state,
  };
}

async function readProductionDeploymentAttestation(gitRoot, expectedSha) {
  const commandOptions = {
    cwd: gitRoot,
    encoding: "utf8",
    maxBuffer: 16 * 1024 * 1024,
  };
  const inspectResult = await execFileAsync("npx", [
    "--yes",
    `vercel@${AAIS_TEST_ACCOUNT_VERCEL_CLI_VERSION}`,
    "inspect",
    AAIS_TEST_ACCOUNT_PRODUCTION_BASE_URL,
    "--json",
    "--no-color",
    "--non-interactive",
  ], commandOptions);
  const deploymentsResult = await execFileAsync("gh", [
    "api",
    `repos/${githubRepository}/deployments?sha=${expectedSha}&environment=Production&per_page=100`,
  ], commandOptions);
  const vercelInspect = JSON.parse(inspectResult.stdout);
  const githubDeployments = JSON.parse(deploymentsResult.stdout);
  if (!Array.isArray(githubDeployments)) {
    throw managerError("AAIS_TEST_ACCOUNT_PRODUCTION_DEPLOYMENT_INVALID");
  }
  const candidateIds = githubDeployments
    .filter((deployment) => deployment?.sha === expectedSha && isPositiveInteger(deployment?.id))
    .map((deployment) => Number(deployment.id));
  const statusEntries = await Promise.all(candidateIds.map(async (deploymentId) => {
    const result = await execFileAsync("gh", [
      "api",
      `repos/${githubRepository}/deployments/${deploymentId}/statuses?per_page=100`,
    ], commandOptions);
    return [String(deploymentId), JSON.parse(result.stdout)];
  }));
  return attestAaisProductionDeployment({
    expectedSha,
    vercelInspect,
    githubDeployments,
    githubStatusesByDeploymentId: Object.fromEntries(statusEntries),
  });
}

async function readProductionAttestation(gitRoot, expectedSha) {
  try {
    if (!commitShaPattern.test(String(expectedSha ?? ""))) {
      throw managerError("AAIS_TEST_ACCOUNT_EXPECTED_SHA_INVALID");
    }
    const [head, branch, status, remoteTracking, liveOriginMain, deployment] = await Promise.all([
      runGit(["rev-parse", "HEAD"], gitRoot),
      runGit(["branch", "--show-current"], gitRoot),
      runGit(["status", "--porcelain=v1"], gitRoot),
      runGit(["rev-parse", "refs/remotes/origin/main"], gitRoot),
      runGit([
        "ls-remote",
        "--exit-code",
        "origin",
        "refs/heads/main",
      ], gitRoot),
      readProductionDeploymentAttestation(gitRoot, expectedSha),
    ]);
    const projectPath = path.join(gitRoot, ".vercel", "project.json");
    await assertNoSymlinkComponents(gitRoot, projectPath);
    const metadata = await lstat(projectPath);
    if (!metadata.isFile() || metadata.isSymbolicLink()) {
      throw managerError("AAIS_TEST_ACCOUNT_VERCEL_LINK_INVALID");
    }
    const project = JSON.parse(await readFile(projectPath, "utf8"));
    return {
      headSha: String(head.stdout).trim(),
      branch: String(branch.stdout).trim(),
      clean: String(status.stdout).trim() === "",
      remoteTrackingSha: String(remoteTracking.stdout).trim(),
      liveOriginMainSha: parseExactRemoteMainSha(liveOriginMain.stdout),
      projectId: String(project?.projectId ?? ""),
      projectName: String(project?.projectName ?? ""),
      vercelEnv: String(process.env.VERCEL_ENV ?? ""),
      vercelTargetEnv: String(process.env.VERCEL_TARGET_ENV ?? ""),
      vercelCliVersion: String(process.env[pinnedVercelCliVersionEnv] ?? ""),
      researchModeEnabled: isLiteralTrue(process.env.AAIS_RESEARCH_MODE),
      researchRequiredEnabled: isLiteralTrue(process.env.AAIS_RESEARCH_REQUIRED),
      researchEnvironmentIsResearch:
        String(process.env.AAIS_RESEARCH_ENVIRONMENT ?? "").trim().toLowerCase() === "research",
      ...deployment,
    };
  } catch (error) {
    if (isManagerError(error)) {
      throw error;
    }
    throw managerError("AAIS_TEST_ACCOUNT_PRODUCTION_ATTESTATION_UNAVAILABLE");
  }
}

function assertProductionGate(input, binding) {
  if (input?.target !== "production") {
    throw managerError("AAIS_TEST_ACCOUNT_TARGET_INVALID");
  }
  if (input?.approved !== true) {
    throw managerError("AAIS_TEST_ACCOUNT_APPROVAL_REQUIRED");
  }
  if (!commitShaPattern.test(String(input?.expectedSha ?? ""))) {
    throw managerError("AAIS_TEST_ACCOUNT_EXPECTED_SHA_INVALID");
  }
  const attestation = input?.productionAttestation;
  if (
    input.expectedSha !== attestation?.headSha
    || input.expectedSha !== attestation?.remoteTrackingSha
    || input.expectedSha !== attestation?.liveOriginMainSha
    || attestation?.branch !== "main"
    || attestation?.clean !== true
    || attestation?.vercelEnv !== "production"
    || attestation?.vercelTargetEnv !== "production"
    || attestation?.researchModeEnabled !== false
    || attestation?.researchRequiredEnabled !== false
    || attestation?.researchEnvironmentIsResearch !== false
  ) {
    throw managerError("AAIS_TEST_ACCOUNT_GIT_SHA_MISMATCH");
  }
  if (input?.projectId !== AAIS_TEST_ACCOUNT_PRODUCTION_PROJECT_ID) {
    throw managerError("AAIS_TEST_ACCOUNT_PROJECT_ID_INVALID");
  }
  if (
    attestation?.projectId !== AAIS_TEST_ACCOUNT_PRODUCTION_PROJECT_ID
    || attestation?.projectName !== "aais"
    || attestation.projectId !== input.projectId
  ) {
    throw managerError("AAIS_TEST_ACCOUNT_VERCEL_LINK_INVALID");
  }
  if (attestation?.vercelCliVersion !== AAIS_TEST_ACCOUNT_VERCEL_CLI_VERSION) {
    throw managerError("AAIS_TEST_ACCOUNT_VERCEL_CLI_ATTESTATION_FAILED");
  }
  if (
    attestation?.deployedGitSha !== input.expectedSha
    || !vercelDeploymentIdPattern.test(String(attestation?.vercelDeploymentId ?? ""))
    || !normalizeVercelDeploymentOrigin(attestation?.vercelDeploymentUrl)
    || attestation?.vercelDeploymentReadyState !== "READY"
    || attestation?.vercelDeploymentTarget !== "production"
    || !isPositiveInteger(attestation?.githubDeploymentId)
    || !isPositiveInteger(attestation?.githubDeploymentStatusId)
    || attestation?.githubDeploymentState !== "success"
  ) {
    throw managerError("AAIS_TEST_ACCOUNT_PRODUCTION_DEPLOYMENT_INVALID");
  }
  if (Number(input?.expectedCount) !== AAIS_TEST_ACCOUNT_EXPECTED_COUNT) {
    throw managerError("AAIS_TEST_ACCOUNT_EXPECTED_COUNT_INVALID");
  }
  if (
    input?.batchId !== binding.batchId
    || input?.courseId !== binding.courseId
    || input?.cohort !== binding.cohort
  ) {
    throw managerError("AAIS_TEST_ACCOUNT_BATCH_BINDING_MISMATCH");
  }
}

async function readPostVerificationAttestation(input, binding) {
  if (typeof input?.readPostVerificationAttestation !== "function") {
    throw managerError("AAIS_TEST_ACCOUNT_PRODUCTION_REATTESTATION_REQUIRED");
  }
  try {
    const attestation = await input.readPostVerificationAttestation();
    assertProductionGate({ ...input, productionAttestation: attestation }, binding);
    return attestation;
  } catch (error) {
    if (error?.code === "AAIS_TEST_ACCOUNT_PRODUCTION_DEPLOYMENT_CHANGED") {
      throw error;
    }
    throw managerError("AAIS_TEST_ACCOUNT_PRODUCTION_REATTESTATION_FAILED");
  }
}

function assertStableProductionDeployment(before, after) {
  const fields = [
    "deployedGitSha",
    "vercelDeploymentId",
    "vercelDeploymentUrl",
    "vercelDeploymentReadyState",
    "vercelDeploymentTarget",
    "githubDeploymentId",
    "githubDeploymentStatusId",
    "githubDeploymentState",
  ];
  if (fields.some((field) => before?.[field] !== after?.[field])) {
    throw managerError("AAIS_TEST_ACCOUNT_PRODUCTION_DEPLOYMENT_CHANGED");
  }
}

function productionDeploymentReceipt(input, extra = {}) {
  const attestation = input.productionAttestation;
  return {
    gitSha: input.expectedSha,
    projectId: input.projectId,
    vercelCliVersion: attestation.vercelCliVersion,
    vercelDeploymentId: attestation.vercelDeploymentId,
    vercelDeploymentStatus: attestation.vercelDeploymentReadyState,
    githubDeploymentId: attestation.githubDeploymentId,
    githubDeploymentStatusId: attestation.githubDeploymentStatusId,
    githubDeploymentState: attestation.githubDeploymentState,
    researchIsolation: "non-research",
    ...extra,
  };
}

function assertCreateOnlySeedReport(report, expectedCount) {
  if (
    report?.status !== "pass"
    || report?.mode !== "create-only"
    || report?.upserted !== expectedCount
    || report?.created !== expectedCount
    || report?.updated !== 0
    || report?.collisions !== 0
    || report?.enrollments !== expectedCount
  ) {
    throw managerError("AAIS_TEST_ACCOUNT_SEED_REPORT_INVALID");
  }
}

async function readProvisionPreflight(database, courseId) {
  try {
    const tablesResult = await database.query(
      `/* aais-test-accounts:provision-schema-preflight */
       select
         to_regclass('public.aais_users') is not null as users_present,
         to_regclass('public.aais_enrollments') is not null as enrollments_present,
         to_regclass('public.aais_courses') is not null as courses_present,
         to_regclass('public.aais_schema_migrations') is not null as migrations_present,
         to_regclass('public.aais_login_rate_limits') is not null as rate_limits_present,
         to_regclass('public.aais_session_revocations') is not null as revocations_present,
         exists (
           select 1
             from information_schema.columns
            where table_schema = 'public'
              and table_name = 'aais_login_rate_limits'
              and column_name = 'expires_at'
         ) as rate_limit_expiry_present`,
    );
    const tables = tablesResult.rows?.[0];
    if (
      tables?.users_present !== true
      || tables?.enrollments_present !== true
      || tables?.courses_present !== true
      || tables?.migrations_present !== true
      || tables?.rate_limits_present !== true
      || tables?.revocations_present !== true
      || tables?.rate_limit_expiry_present !== true
    ) {
      throw managerError("AAIS_TEST_ACCOUNT_REQUIRED_TABLES_MISSING");
    }
    const migrationsResult = await database.query(
      `/* aais-test-accounts:provision-migration-preflight */
       select version
         from public.aais_schema_migrations
        where version = any($1::text[])
        order by version`,
      [["0002", "0005", "0006", "0007", "0010", "0026"]],
    );
    const versions = new Set((migrationsResult.rows ?? []).map((row) => String(row.version)));
    if (!["0002", "0005", "0006", "0007", "0010", "0026"]
      .every((version) => versions.has(version))) {
      throw managerError("AAIS_TEST_ACCOUNT_REQUIRED_MIGRATIONS_MISSING");
    }
    const courseResult = await database.query(
      `/* aais-test-accounts:provision-course-preflight */
       select id, status
         from public.aais_courses
        where id = $1
        limit 2
        for share`,
      [courseId],
    );
    if (
      courseResult.rows?.length !== 1
      || courseResult.rows[0].id !== courseId
      || courseResult.rows[0].status !== "active"
    ) {
      throw managerError("AAIS_TEST_ACCOUNT_COURSE_BINDING_INVALID");
    }
    return {
      requiredTables: 6,
      requiredMigrations: 6,
      authRuntime: "ready",
      course: "active",
    };
  } catch (error) {
    if (isManagerError(error)) {
      throw error;
    }
    throw managerError("AAIS_TEST_ACCOUNT_PROVISION_PREFLIGHT_FAILED");
  }
}

async function readDatabaseBatchAggregate(input) {
  const userIds = input.rows.map((row) => row.user_id);
  let users;
  let enrollments;
  try {
    const userResult = await input.database.query(
      `/* aais-test-accounts:provision-users-aggregate */
       select role, status, count(*)::integer as count
         from aais_users
        where id = any($1::text[])
        group by role, status
        order by role, status`,
      [userIds],
    );
    const enrollmentResult = await input.database.query(
      `/* aais-test-accounts:provision-enrollments-aggregate */
       select role, status, count(*)::integer as count
         from aais_enrollments
        where user_id = any($1::text[])
          and course_id = $2
          and cohort = $3
        group by role, status
        order by role, status`,
      [userIds, input.courseId, input.cohort],
    );
    users = normalizeRoleStatusCounts(userResult.rows);
    enrollments = normalizeRoleStatusCounts(enrollmentResult.rows);
  } catch (error) {
    if (isManagerError(error)) {
      throw error;
    }
    throw managerError("AAIS_TEST_ACCOUNT_DATABASE_AGGREGATE_FAILED");
  }
  return { users, enrollments };
}

function normalizeRoleStatusCounts(rows) {
  const output = {
    total: 0,
    roles: { student: 0, teacher: 0, admin: 0 },
    statuses: { active: 0, disabled: 0, withdrawn: 0 },
  };
  for (const row of rows ?? []) {
    const count = Number(row.count);
    if (
      !Number.isSafeInteger(count)
      || count < 0
      || !Object.hasOwn(output.roles, row.role)
      || !Object.hasOwn(output.statuses, row.status)
    ) {
      throw managerError("AAIS_TEST_ACCOUNT_DATABASE_AGGREGATE_INVALID");
    }
    output.total += count;
    output.roles[row.role] += count;
    output.statuses[row.status] += count;
  }
  return output;
}

function assertExpectedDatabaseAggregate(database) {
  if (
    database.users.total !== AAIS_TEST_ACCOUNT_EXPECTED_COUNT
    || database.users.roles.student !== AAIS_TEST_ACCOUNT_STUDENT_COUNT
    || database.users.roles.teacher !== AAIS_TEST_ACCOUNT_TEACHER_COUNT
    || database.users.roles.admin !== 0
    || database.users.statuses.active !== AAIS_TEST_ACCOUNT_EXPECTED_COUNT
    || database.users.statuses.disabled !== 0
    || database.enrollments.total !== AAIS_TEST_ACCOUNT_EXPECTED_COUNT
    || database.enrollments.roles.student !== AAIS_TEST_ACCOUNT_STUDENT_COUNT
    || database.enrollments.roles.teacher !== AAIS_TEST_ACCOUNT_TEACHER_COUNT
    || database.enrollments.roles.admin !== 0
    || database.enrollments.statuses.active !== AAIS_TEST_ACCOUNT_EXPECTED_COUNT
    || database.enrollments.statuses.withdrawn !== 0
  ) {
    throw managerError("AAIS_TEST_ACCOUNT_DATABASE_AGGREGATE_MISMATCH");
  }
}

async function verifyOneAccount(input) {
  const row = input.row;
  const checks = {
    login: false,
    role: false,
    learningAllowed: false,
    studentDashboardDenied: row.role !== "student",
    teacherDashboardAllowed: row.role !== "teacher",
    teacherAdminDenied: row.role !== "teacher",
    logout: false,
  };
  let cookieJar = null;
  let failure = "login";
  try {
    const login = await input.fetchImpl(`${input.baseUrl}/api/auth/app-session`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        account: row.account,
        password: row.password,
        consentAccepted: true,
        from: row.role === "teacher" ? "/dashboard" : "/learning",
      }),
      redirect: "manual",
      cache: "no-store",
    });
    cookieJar = extractCookieJar(login.headers);
    const loginBody = await readJson(login);
    checks.login = login.status === 200 && cookieJar.hasSession && Boolean(cookieJar.csrfToken);
    if (!checks.login) {
      return cookieJar.hasSession && cookieJar.csrfToken
        ? await finishVerificationWithLogout(input, row, checks, cookieJar, failure)
        : verificationResult(row.role, checks, failure);
    }
    failure = "role";
    checks.role = loginBody?.appSession?.actor?.id === row.user_id
      && loginBody?.appSession?.actor?.role === row.role;
    if (!checks.role) {
      return await finishVerificationWithLogout(input, row, checks, cookieJar, failure);
    }

    failure = "learning-page";
    const learning = await input.fetchImpl(`${input.baseUrl}/learning`, {
      method: "GET",
      headers: { cookie: cookieJar.cookieHeader },
      redirect: "manual",
      cache: "no-store",
    });
    checks.learningAllowed = learning.status === 200;
    if (!checks.learningAllowed) {
      return await finishVerificationWithLogout(input, row, checks, cookieJar, failure);
    }

    if (row.role === "student") {
      failure = "student-dashboard-deny";
      const dashboard = await input.fetchImpl(`${input.baseUrl}/dashboard`, {
        method: "GET",
        headers: { cookie: cookieJar.cookieHeader },
        redirect: "manual",
        cache: "no-store",
      });
      checks.studentDashboardDenied = isRedirectTo(dashboard, input.baseUrl, "/learning");
      if (!checks.studentDashboardDenied) {
        return await finishVerificationWithLogout(input, row, checks, cookieJar, failure);
      }
    } else {
      failure = "teacher-dashboard-allow";
      const dashboard = await input.fetchImpl(`${input.baseUrl}/dashboard`, {
        method: "GET",
        headers: { cookie: cookieJar.cookieHeader },
        redirect: "manual",
        cache: "no-store",
      });
      checks.teacherDashboardAllowed = dashboard.status === 200;
      if (!checks.teacherDashboardAllowed) {
        return await finishVerificationWithLogout(input, row, checks, cookieJar, failure);
      }
      failure = "teacher-admin-deny";
      const admin = await input.fetchImpl(`${input.baseUrl}/admin/users`, {
        method: "GET",
        headers: { cookie: cookieJar.cookieHeader },
        redirect: "manual",
        cache: "no-store",
      });
      checks.teacherAdminDenied = isRedirectTo(admin, input.baseUrl, "/learning");
      if (!checks.teacherAdminDenied) {
        return await finishVerificationWithLogout(input, row, checks, cookieJar, failure);
      }
    }
    return await finishVerificationWithLogout(input, row, checks, cookieJar, null);
  } catch (error) {
    const requestFailure = isRequestTimeoutError(error) ? `${failure}-timeout` : "network";
    if (cookieJar) {
      return finishVerificationWithLogout(input, row, checks, cookieJar, requestFailure);
    }
    return verificationResult(row.role, checks, requestFailure);
  }
}

async function finishVerificationWithLogout(input, row, checks, cookieJar, priorFailure) {
  let logoutFailed = false;
  let logoutFailure = "logout";
  try {
    const logout = await input.fetchImpl(`${input.baseUrl}/api/auth/app-session`, {
      method: "DELETE",
      headers: {
        cookie: cookieJar.cookieHeader,
        "x-aais-csrf": cookieJar.csrfToken,
      },
      redirect: "manual",
      cache: "no-store",
    });
    const body = await readJson(logout);
    checks.logout = logout.status === 200 && body?.sessionRevoked === true;
    logoutFailed = !checks.logout;
  } catch (error) {
    logoutFailed = true;
    logoutFailure = isRequestTimeoutError(error) ? "logout-timeout" : "logout";
  }
  return verificationResult(row.role, checks, priorFailure ?? (logoutFailed ? logoutFailure : null));
}

async function verifyNegativeAuthenticationCases(input) {
  const representative = input.rows[0];
  const lastCharacter = representative.password.at(-1);
  const wrongPassword = `${representative.password.slice(0, -1)}${lastCharacter === "A" ? "B" : "A"}`;
  const cases = [
    {
      kind: "wrong-password",
      expectedStatus: 401,
      body: {
        account: representative.account,
        password: wrongPassword,
        consentAccepted: true,
        from: "/learning",
      },
    },
    {
      kind: "unknown-account",
      expectedStatus: 401,
      body: {
        account: `aais-${input.batchId}-unknown@${accountDomain}`,
        password: representative.password,
        consentAccepted: true,
        from: "/learning",
      },
    },
    {
      kind: "missing-consent",
      expectedStatus: 428,
      body: {
        account: representative.account,
        password: representative.password,
        consentAccepted: false,
        from: "/learning",
      },
    },
  ];
  const results = [];
  for (const testCase of cases) {
    try {
      const response = await input.fetchImpl(`${input.baseUrl}/api/auth/app-session`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(testCase.body),
        redirect: "manual",
        cache: "no-store",
      });
      const cookieJar = extractCookieJar(response.headers);
      let cleanupAttempted = false;
      let cleanupPassed = false;
      if (cookieJar.hasSession && cookieJar.csrfToken) {
        cleanupAttempted = true;
        try {
          const cleanup = await input.fetchImpl(`${input.baseUrl}/api/auth/app-session`, {
            method: "DELETE",
            headers: {
              cookie: cookieJar.cookieHeader,
              "x-aais-csrf": cookieJar.csrfToken,
            },
            redirect: "manual",
            cache: "no-store",
          });
          const cleanupBody = await readJson(cleanup);
          cleanupPassed = cleanup.status === 200 && cleanupBody?.sessionRevoked === true;
        } catch {
          cleanupPassed = false;
        }
      }
      results.push({
        sessionCookieSet: cookieJar.hasSession,
        cleanupAttempted,
        cleanupPassed,
        passed: response.status === testCase.expectedStatus && !cookieJar.hasSession,
      });
    } catch {
      results.push({
        sessionCookieSet: false,
        cleanupAttempted: false,
        cleanupPassed: false,
        passed: false,
      });
    }
  }
  const passed = results.filter((result) => result.passed).length;
  return {
    expected: cases.length,
    attempted: results.length,
    passed,
    failed: results.length - passed,
    sessionCookiesSet: results.filter((result) => result.sessionCookieSet).length,
    cleanup: {
      attempted: results.filter((result) => result.cleanupAttempted).length,
      passed: results.filter((result) => result.cleanupPassed).length,
    },
  };
}

function createBoundedProductionFetch(fetchImpl, requestTimeoutMs) {
  return async (url, request = {}) => {
    const controller = new AbortController();
    const response = await runWithProductionDeadline(
      fetchImpl(url, { ...request, signal: controller.signal }),
      requestTimeoutMs,
      controller,
    );
    const json = typeof response?.json === "function" ? response.json.bind(response) : null;
    if (!json) {
      return response;
    }
    return new Proxy(response, {
      get(target, property) {
        if (property === "json") {
          return () => runWithProductionDeadline(
            Promise.resolve().then(() => json()),
            requestTimeoutMs,
            controller,
          );
        }
        const value = Reflect.get(target, property, target);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
  };
}

async function runWithProductionDeadline(operation, requestTimeoutMs, controller) {
  let timeoutId;
  const deadline = new Promise((_resolve, reject) => {
    timeoutId = setTimeout(() => {
      reject(new AaisTestAccountRequestTimeoutError());
      controller.abort();
    }, requestTimeoutMs);
  });
  try {
    return await Promise.race([operation, deadline]);
  } finally {
    clearTimeout(timeoutId);
  }
}

class AaisTestAccountRequestTimeoutError extends Error {
  constructor() {
    super("AAIS_TEST_ACCOUNT_REQUEST_TIMEOUT");
    this.name = "AaisTestAccountRequestTimeoutError";
  }
}

function isRequestTimeoutError(error) {
  return error instanceof AaisTestAccountRequestTimeoutError;
}

function verificationResult(role, checks, failure) {
  const passed = Object.values(checks).every(Boolean) && !failure;
  return {
    role,
    status: passed ? "passed" : "failed",
    checks,
    failure: passed ? null : failure ?? "unknown",
  };
}

async function runWithConcurrency(items, concurrency, worker) {
  const results = new Array(items.length);
  let nextIndex = 0;
  const workers = Array.from({ length: concurrency }, async () => {
    while (nextIndex < items.length) {
      const index = nextIndex;
      nextIndex += 1;
      results[index] = await worker(items[index], index);
    }
  });
  await Promise.all(workers);
  return results;
}

function aggregateVerificationChecks(results) {
  const names = [
    "login",
    "role",
    "learningAllowed",
    "studentDashboardDenied",
    "teacherDashboardAllowed",
    "teacherAdminDenied",
    "logout",
  ];
  return Object.fromEntries(names.map((name) => {
    const applicable = name.startsWith("student")
      ? results.filter((result) => result.role === "student")
      : name.startsWith("teacher")
        ? results.filter((result) => result.role === "teacher")
        : results;
    const passed = applicable.filter((result) => result.checks[name]).length;
    return [name, { expected: applicable.length, passed, failed: applicable.length - passed }];
  }));
}

function summarizeVerificationRole(results, role) {
  const matching = results.filter((result) => result.role === role);
  const passed = matching.filter((result) => result.status === "passed").length;
  return { expected: matching.length, passed, failed: matching.length - passed };
}

function summarizeVerificationFailures(results) {
  const summary = {};
  for (const result of results) {
    summary[result.failure] = (summary[result.failure] ?? 0) + 1;
  }
  return summary;
}

function extractCookieJar(headers) {
  const cookies = new Map();
  const rawHeaders = typeof headers?.getSetCookie === "function"
    ? headers.getSetCookie()
    : splitSetCookieHeader(headers?.get?.("set-cookie"));
  for (const header of rawHeaders) {
    const pair = String(header).split(";")[0] ?? "";
    const separator = pair.indexOf("=");
    if (separator > 0) {
      cookies.set(pair.slice(0, separator).trim(), pair.slice(separator + 1));
    }
  }
  return {
    hasSession: cookies.has("aais_session"),
    csrfToken: cookies.get("aais_csrf") ?? null,
    cookieHeader: [...cookies.entries()].map(([key, value]) => `${key}=${value}`).join("; "),
  };
}

function splitSetCookieHeader(value) {
  return value
    ? String(value).split(/,(?=\s*[^;,]+=)/).map((entry) => entry.trim()).filter(Boolean)
    : [];
}

async function readJson(response) {
  try {
    return await response.json();
  } catch (error) {
    if (isRequestTimeoutError(error)) {
      throw error;
    }
    return null;
  }
}

function isRedirectTo(response, baseUrl, pathname) {
  if (!redirectStatuses.has(response.status)) {
    return false;
  }
  const location = response.headers?.get?.("location");
  if (!location) {
    return false;
  }
  try {
    const resolved = new URL(location, baseUrl);
    return resolved.origin === new URL(baseUrl).origin
      && resolved.pathname === pathname
      && !resolved.search
      && !resolved.hash;
  } catch {
    return false;
  }
}

function requireProductionBaseUrl(value) {
  let url;
  try {
    url = new URL(String(value ?? ""));
  } catch {
    throw managerError("AAIS_TEST_ACCOUNT_BASE_URL_INVALID");
  }
  if (
    url.origin !== AAIS_TEST_ACCOUNT_PRODUCTION_BASE_URL
    || url.href !== `${AAIS_TEST_ACCOUNT_PRODUCTION_BASE_URL}/`
    || url.username
    || url.password
  ) {
    throw managerError("AAIS_TEST_ACCOUNT_BASE_URL_INVALID");
  }
  return AAIS_TEST_ACCOUNT_PRODUCTION_BASE_URL;
}

function requireRequestTimeoutMs(value) {
  const timeoutMs = value === undefined
    ? AAIS_TEST_ACCOUNT_REQUEST_TIMEOUT_MS
    : Number(value);
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 60_000) {
    throw managerError("AAIS_TEST_ACCOUNT_REQUEST_TIMEOUT_INVALID");
  }
  return timeoutMs;
}

function scanExactValues(contents, exactValues) {
  const result = {
    filesScanned: contents.length,
    matchedValues: { accounts: 0, passwords: 0, userIds: 0 },
    occurrences: { accounts: 0, passwords: 0, userIds: 0 },
    totalMatchedValues: 0,
    totalOccurrences: 0,
  };
  for (const [category, values] of Object.entries(exactValues)) {
    for (const value of values) {
      let valueOccurrences = 0;
      const needle = Buffer.from(value, "utf8");
      for (const content of contents) {
        const haystack = Buffer.isBuffer(content) ? content : Buffer.from(String(content));
        let offset = 0;
        while (offset <= haystack.length - needle.length) {
          const found = haystack.indexOf(needle, offset);
          if (found < 0) {
            break;
          }
          valueOccurrences += 1;
          offset = found + needle.length;
        }
      }
      if (valueOccurrences > 0) {
        result.matchedValues[category] += 1;
        result.totalMatchedValues += 1;
        result.occurrences[category] += valueOccurrences;
        result.totalOccurrences += valueOccurrences;
      }
    }
  }
  return result;
}

function validateExactUserRows(rows, expectedById) {
  if (!Array.isArray(rows) || rows.length !== expectedById.size) {
    throw managerError("AAIS_TEST_ACCOUNT_DISABLE_USER_SET_MISMATCH");
  }
  const seen = new Set();
  return rows.map((row) => {
    const id = String(row.id ?? "");
    const expected = expectedById.get(id);
    const authVersion = Number(row.auth_version);
    if (
      !expected
      || seen.has(id)
      || String(row.normalized_email ?? "").trim().toLowerCase() !== expected.account
      || row.role !== expected.role
      || (row.status !== "active" && row.status !== "disabled")
      || !Number.isSafeInteger(authVersion)
      || authVersion < 1
    ) {
      throw managerError("AAIS_TEST_ACCOUNT_DISABLE_USER_SET_MISMATCH");
    }
    seen.add(id);
    return {
      id,
      normalized_email: expected.account,
      role: row.role,
      status: row.status,
      auth_version: authVersion,
    };
  });
}

function validateExactEnrollmentRows(rows, expectedById, binding) {
  if (!Array.isArray(rows) || rows.length !== expectedById.size) {
    throw managerError("AAIS_TEST_ACCOUNT_DISABLE_ENROLLMENT_SET_MISMATCH");
  }
  const seen = new Set();
  return rows.map((row) => {
    const userId = String(row.user_id ?? "");
    const expected = expectedById.get(userId);
    if (
      !expected
      || seen.has(userId)
      || row.role !== expected.role
      || !["active", "completed", "withdrawn"].includes(row.status)
      || row.course_id !== binding.courseId
      || row.cohort !== binding.cohort
    ) {
      throw managerError("AAIS_TEST_ACCOUNT_DISABLE_ENROLLMENT_SET_MISMATCH");
    }
    seen.add(userId);
    return {
      user_id: userId,
      role: row.role,
      status: row.status,
      course_id: row.course_id,
      cohort: row.cohort,
    };
  });
}

async function acquireSingleDatabaseConnection(database) {
  if (!database || typeof database.query !== "function") {
    throw managerError("AAIS_TEST_ACCOUNT_DATABASE_NOT_CONFIGURED");
  }
  // pg PoolClient inherits connect() even after Pool.connect() has leased it.
  // A release() method marks this as an already-connected, externally owned
  // client, so this helper must neither reconnect nor release it.
  if (typeof database.release === "function") {
    return { database, release: () => undefined };
  }
  if (typeof database.connect !== "function") {
    return { database, release: () => undefined };
  }
  try {
    const client = await database.connect();
    if (!client || typeof client.query !== "function" || typeof client.release !== "function") {
      throw managerError("AAIS_TEST_ACCOUNT_DATABASE_CLIENT_INVALID");
    }
    let released = false;
    return {
      database: client,
      release: () => {
        if (!released) {
          released = true;
          client.release();
        }
      },
    };
  } catch (error) {
    if (isManagerError(error)) {
      throw error;
    }
    throw managerError("AAIS_TEST_ACCOUNT_DATABASE_CONNECTION_FAILED");
  }
}

function splitNul(value) {
  return String(value ?? "").split("\0").filter(Boolean);
}

function assertExactCustodyPath(gitRoot, candidatePath) {
  const expectedPath = path.resolve(gitRoot, AAIS_TEST_ACCOUNT_CUSTODY_PATH);
  if (candidatePath !== expectedPath) {
    throw managerError("AAIS_TEST_ACCOUNT_CUSTODY_PATH_INVALID");
  }
}

function parseExactRemoteMainSha(output) {
  const lines = String(output ?? "").trim().split("\n").filter(Boolean);
  if (lines.length !== 1) {
    throw managerError("AAIS_TEST_ACCOUNT_ORIGIN_MAIN_INVALID");
  }
  const [sha, reference, ...extra] = lines[0].trim().split(/\s+/);
  if (
    !commitShaPattern.test(sha ?? "")
    || reference !== "refs/heads/main"
    || extra.length > 0
  ) {
    throw managerError("AAIS_TEST_ACCOUNT_ORIGIN_MAIN_INVALID");
  }
  return sha;
}

function normalizeVercelDeploymentOrigin(value) {
  const text = String(value ?? "").trim();
  let url;
  try {
    url = new URL(text.includes("://") ? text : `https://${text}`);
  } catch {
    throw managerError("AAIS_TEST_ACCOUNT_PRODUCTION_DEPLOYMENT_INVALID");
  }
  if (
    url.protocol !== "https:"
    || url.port
    || url.username
    || url.password
    || url.pathname !== "/"
    || url.search
    || url.hash
    || !url.hostname.endsWith(".vercel.app")
  ) {
    throw managerError("AAIS_TEST_ACCOUNT_PRODUCTION_DEPLOYMENT_INVALID");
  }
  return url.origin;
}

function isPositiveInteger(value) {
  return Number.isSafeInteger(Number(value)) && Number(value) > 0;
}

function isExactVercelBot(actor) {
  return actor
    && actor.login === vercelBotAccount.login
    && actor.id === vercelBotAccount.id
    && actor.node_id === vercelBotAccount.node_id
    && actor.type === vercelBotAccount.type;
}

function requireGenerateOptions(options) {
  if (!options.outputPath || !options.batchId || !options.courseId || !options.cohort) {
    throw managerError("AAIS_TEST_ACCOUNT_GENERATE_ARGUMENTS_REQUIRED");
  }
}

function requireBatchInputOptions(options) {
  if (
    !options.inputPath
    || !options.batchId
    || !options.courseId
    || !options.cohort
    || Number(options.expectedCount) !== AAIS_TEST_ACCOUNT_EXPECTED_COUNT
  ) {
    throw managerError("AAIS_TEST_ACCOUNT_INPUT_ARGUMENTS_REQUIRED");
  }
}

function requireProductionOptions(options) {
  if (
    options.target !== "production"
    || options.approved !== true
    || !options.expectedSha
    || !options.projectId
  ) {
    throw managerError("AAIS_TEST_ACCOUNT_PRODUCTION_ARGUMENTS_REQUIRED");
  }
  if (options.command === "verify" && !options.baseUrl) {
    throw managerError("AAIS_TEST_ACCOUNT_BASE_URL_REQUIRED");
  }
}

function assertAllowedCommandOptions(options) {
  const commonInput = new Set([
    "command",
    "approved",
    "help",
    "inputPath",
    "batchId",
    "courseId",
    "cohort",
    "expectedCount",
  ]);
  const production = new Set([
    ...commonInput,
    "target",
    "expectedSha",
    "projectId",
  ]);
  const allowed = options.command === "generate"
    ? new Set(["command", "approved", "help", "outputPath", "batchId", "courseId", "cohort"])
    : options.command === "audit-git"
      ? commonInput
      : options.command === "verify"
        ? new Set([...production, "baseUrl"])
        : production;
  if (Object.keys(options).some((key) => !allowed.has(key))) {
    throw managerError("AAIS_TEST_ACCOUNT_ARGUMENT_NOT_ALLOWED");
  }
  if (options.command === "generate" && options.approved) {
    throw managerError("AAIS_TEST_ACCOUNT_ARGUMENT_NOT_ALLOWED");
  }
  if (options.command === "audit-git" && options.approved) {
    throw managerError("AAIS_TEST_ACCOUNT_ARGUMENT_NOT_ALLOWED");
  }
}

async function withAaisDatabaseClient(callback) {
  const [{ Pool }, { getAaisMigrationDatabaseConfiguration }] = await Promise.all([
    import("pg"),
    import("./run-postgres-migrations.mjs"),
  ]);
  const configuration = getAaisMigrationDatabaseConfiguration();
  if (!configuration) {
    throw managerError("AAIS_TEST_ACCOUNT_DATABASE_NOT_CONFIGURED");
  }
  const pool = new Pool(getAaisTestAccountDatabasePoolConfig(configuration.url));
  let client;
  try {
    client = await pool.connect();
    return await callback({ database: client, sourceEnv: configuration.sourceEnv });
  } catch (error) {
    if (isManagerError(error)) {
      throw error;
    }
    throw managerError("AAIS_TEST_ACCOUNT_DATABASE_OPERATION_FAILED");
  } finally {
    client?.release();
    await pool.end().catch(() => undefined);
  }
}

function credentialRedaction() {
  return {
    accounts: "omitted",
    passwords: "omitted",
    userIds: "omitted",
    databaseUrl: "omitted",
  };
}

function managerError(code, details) {
  return new AaisTestAccountManagerError(code, details);
}

function isLiteralTrue(value) {
  return String(value ?? "").trim().toLowerCase() === "true";
}

function isManagerError(error) {
  return error instanceof AaisTestAccountManagerError;
}

async function main() {
  try {
    const argv = process.argv.slice(2);
    if (
      productionManagerCommands.has(argv[0])
      && process.env[pinnedVercelCliVersionEnv] !== AAIS_TEST_ACCOUNT_VERCEL_CLI_VERSION
    ) {
      const wrapped = await runAaisTestAccountPinnedProductionCommand(argv);
      process.stdout.write(wrapped.stdout);
      process.stderr.write(wrapped.stderr);
      process.exitCode = wrapped.exitCode;
      return;
    }
    const result = await runAaisTestAccountManagerCli(argv);
    if (result.usage) {
      process.stdout.write(result.usage);
      return;
    }
    process.stdout.write(`${JSON.stringify(result.report)}\n`);
    if (result.failed) {
      process.exitCode = 1;
    }
  } catch (error) {
    const code = isManagerError(error) ? error.code : "AAIS_TEST_ACCOUNT_MANAGER_FAILED";
    const details = isManagerError(error) ? error.details : {};
    process.stderr.write(`${JSON.stringify({
      schema: AAIS_TEST_ACCOUNT_REPORT_SCHEMA,
      status: "failed",
      code,
      ...details,
      secrets: "redacted",
    })}\n`);
    process.exitCode = 1;
  }
}

const invokedPath = process.argv[1] ? pathToFileURL(process.argv[1]).href : "";
if (import.meta.url === invokedPath) {
  main();
}
