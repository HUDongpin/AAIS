import {
  createPrivateKey,
  createPublicKey,
  randomUUID,
  sign,
  verify,
} from "node:crypto";
import { execFileSync } from "node:child_process";
import {
  lstat,
  mkdtemp,
  readFile,
  readdir,
  rm,
  symlink,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  AAIS_SOURCE_ROOT,
  AI_EMPTY_OVERRIDE_NAMES,
  CONTROL_NAMES,
  EXPECTED_FILENAMES,
  FORMAL_EVIDENCE_OVERRIDE_NAMES,
  FORMAL_WORKER_OVERRIDE_NAMES,
  GOVERNANCE_TEMPLATE_FILENAMES,
  GOVERNANCE_FRESHNESS_OVERRIDE_NAMES,
  LRS_STORE_SPECS,
  RESTRICTED_STUDY_OUTPUT_ROOT,
  generateAaisMainlandTestProfile,
  parseArgs,
} from "../scripts/generate-aais-mainland-test-profile.mjs";
import { readAaisAiRuntimeConfig } from "@/lib/ai/aais-ai-runtime-config";
import { getAaisResearchConfiguration } from "@/lib/server/aais-research-contract";
import { getAaisResearchCollectionLaunchGate } from "@/lib/server/aais-research-launch";
import { getAaisResearchLrsConfiguration } from "@/lib/server/aais-research-lrs";

const temporaryRoots = [];

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map((root) =>
    rm(root, { recursive: true, force: true })));
});

describe("AAIS mainland CAAIS test profile generator", () => {
  it("creates a restricted, sanitized, explicitly test-only profile pack", async () => {
    const root = await createTemporaryRoot();
    const outputDir = path.join(root, "profile-pack");
    const actors = ["caaistest-01", "caaistest-02", "caaistest-03"];
    const studyId = "mainland-caa-is-test-unit-01";
    const result = await generateAaisMainlandTestProfile({
      outputDir,
      actors,
      studyId,
      commitSha: "77ec56051af1eef41d2b64e70462d00c3d38c7c9",
      appVersion: "0.1.0",
      lrsPort: 43239,
      now: new Date("2026-08-01T04:00:00.000Z"),
    });

    expect(result.files).toEqual(EXPECTED_FILENAMES);
    expect((await lstat(outputDir)).mode & 0o777).toBe(0o700);
    expect((await readdir(outputDir)).sort()).toEqual([...EXPECTED_FILENAMES].sort());
    for (const fileName of EXPECTED_FILENAMES) {
      expect((await lstat(path.join(outputDir, fileName))).mode & 0o777).toBe(0o600);
    }

    const secretsText = await readFile(path.join(outputDir, "secrets.env"), "utf8");
    const secrets = parseEnv(secretsText);
    expect(secrets.AAIS_MAINLAND_TEST_PROFILE).toBe("mainland-caa-is-test");
    expect(secrets.AAIS_RESEARCH_MODE).toBe("true");
    expect(secrets.AAIS_RESEARCH_REQUIRED).toBe("true");
    expect(secrets.AAIS_RESEARCH_REHEARSAL_MODE).toBe("true");
    expect(secrets.AAIS_RESEARCH_REHEARSAL_APPROVED).toBe("true");
    expect(secrets.AAIS_RESEARCH_PROJECT_ID).toBe("aais");
    expect(secrets.AAIS_RESEARCH_STUDY_ID).toBe(studyId);
    expect(secrets.AAIS_RESEARCH_ENVIRONMENT).toBe("research");
    expect(secrets.AAIS_RESEARCH_PARTICIPANT_ACTOR_IDS).toBe(actors.join(","));
    expect(secrets.AAIS_RESEARCH_CONDITIONS).toBe("internal-test");
    expect(secrets.AAIS_RESEARCH_LRS_NAMESPACE).toBe(
      `https://www.aais.site/xapi/studies/${studyId}/research/v1`,
    );
    const expectedLrsStores = [
      ["AAIS_PRODUCTION_LRS", "/stores/aais-production/xapi", "7"],
      ["AAIS_STAGING_LRS", "/stores/aais-staging/xapi", "7"],
      ["AAIS_RESEARCH_LRS", "/stores/aais-research/xapi", "30"],
      ["MAIS_LRS", "/stores/mais/xapi", "1"],
    ];
    expect(LRS_STORE_SPECS).toHaveLength(4);
    for (const [prefix, endpointPath, retentionDays] of expectedLrsStores) {
      expect(secrets[`${prefix}_ENDPOINT`]).toBe(`http://localhost:43239${endpointPath}`);
      expect(secrets[`${prefix}_STORE_ID`]).toBeTruthy();
      expect(secrets[`${prefix}_USERNAME`]).toBeTruthy();
      expect(secrets[`${prefix}_PASSWORD`]).toBeTruthy();
      expect(secrets[`${prefix}_RETENTION_DAYS`]).toBe(retentionDays);
    }
    const lrsIsolationValues = expectedLrsStores.flatMap(([prefix]) => [
      secrets[`${prefix}_STORE_ID`],
      secrets[`${prefix}_USERNAME`],
      secrets[`${prefix}_PASSWORD`],
    ]);
    expect(new Set(lrsIsolationValues).size).toBe(lrsIsolationValues.length);
    expect(secrets.AAIS_RESEARCH_IDENTITY_RETENTION_DAYS).toBe("7");
    expect(secrets.AAIS_RESEARCH_RAW_TEXT_RETENTION_DAYS).toBe("7");
    expect(secrets.AAIS_RESEARCH_EVENT_RETENTION_DAYS).toBe("30");
    expect(secrets.AAIS_RESEARCH_BACKUP_RETENTION_DAYS).toBe("1");
    for (const name of [
      ...FORMAL_WORKER_OVERRIDE_NAMES,
      ...FORMAL_EVIDENCE_OVERRIDE_NAMES,
      ...GOVERNANCE_FRESHNESS_OVERRIDE_NAMES,
    ]) {
      expect(secrets).toHaveProperty(name, "");
    }
    expect(FORMAL_EVIDENCE_OVERRIDE_NAMES).toHaveLength(14);
    expect(FORMAL_EVIDENCE_OVERRIDE_NAMES.some((name) => Boolean(secrets[name]))).toBe(false);
    expect(secrets).toMatchObject({
      AAIS_AI_PROVIDER: "disabled",
      SENTRY_DSN: "",
      NEXT_PUBLIC_SENTRY_DSN: "",
      SENTRY_ORG: "",
      SENTRY_PROJECT: "",
      SENTRY_AUTH_TOKEN: "",
      SENTRY_TRACES_SAMPLE_RATE: "0",
      NEXT_PUBLIC_SENTRY_TRACES_SAMPLE_RATE: "0",
      NEXT_TELEMETRY_DISABLED: "1",
      LRS_ENDPOINT: "",
      LRS_USERNAME: "",
      LRS_PASSWORD: "",
      AAIS_LRS_OUTBOX_FLUSH_TOKEN: "",
      CRON_SECRET: "",
    });
    for (const name of AI_EMPTY_OVERRIDE_NAMES) {
      expect(secrets).toHaveProperty(name, "");
    }

    const contaminatedAmbient = {
      AAIS_AI_PROVIDER: "qwen",
      ...Object.fromEntries(AI_EMPTY_OVERRIDE_NAMES.map((name) => [
        name,
        `ambient-${name.toLowerCase()}`,
      ])),
      SENTRY_DSN: "https://ambient-private-sentry.example/1",
      NEXT_PUBLIC_SENTRY_DSN: "https://ambient-public-sentry.example/1",
      SENTRY_ORG: "ambient-org",
      SENTRY_PROJECT: "ambient-project",
      SENTRY_AUTH_TOKEN: "ambient-sentry-auth-token",
      SENTRY_TRACES_SAMPLE_RATE: "1",
      NEXT_PUBLIC_SENTRY_TRACES_SAMPLE_RATE: "1",
      NEXT_TELEMETRY_DISABLED: "0",
      LRS_ENDPOINT: "https://ambient-shared-lrs.example/xapi",
      LRS_USERNAME: "ambient-shared-user",
      LRS_PASSWORD: "ambient-shared-password",
      AAIS_LRS_OUTBOX_FLUSH_TOKEN: "ambient-generic-flush-token-with-more-than-32-characters",
      CRON_SECRET: "ambient-cron-secret-with-more-than-32-characters",
      ...Object.fromEntries(FORMAL_WORKER_OVERRIDE_NAMES.map((name, index) => [
        name,
        `ambient-worker-${index}-${"x".repeat(40)}`,
      ])),
      ...Object.fromEntries(FORMAL_EVIDENCE_OVERRIDE_NAMES.map((name, index) => [
        name,
        (index + 1).toString(16).repeat(64),
      ])),
      AAIS_RESEARCH_GOVERNANCE_MANIFEST_VERIFIED_AT: "2026-08-01T04:00:00.000Z",
      AAIS_RESEARCH_GOVERNANCE_MANIFEST_VALID_UNTIL: "2026-09-01T04:00:00.000Z",
      AAIS_RESEARCH_DAILY_BACKUP_COMPLETED_AT: "2026-08-01T04:00:00.000Z",
      AAIS_RESEARCH_BACKUP_DESTRUCTION_OBSERVED_AT: "2026-08-01T04:00:00.000Z",
    };
    const effectiveEnv = { ...contaminatedAmbient, ...secrets };
    expect(readAaisAiRuntimeConfig(effectiveEnv)).toMatchObject({
      profile: {
        mode: "deterministic",
        primary: null,
        fallback: null,
      },
      primary: null,
      fallback: null,
    });
    for (const name of [
      ...FORMAL_WORKER_OVERRIDE_NAMES,
      ...FORMAL_EVIDENCE_OVERRIDE_NAMES,
      ...GOVERNANCE_FRESHNESS_OVERRIDE_NAMES,
    ]) {
      expect(effectiveEnv[name]).toBe("");
    }
    expect(getAaisResearchCollectionLaunchGate({
      ...effectiveEnv,
      AAIS_RESEARCH_REHEARSAL_MODE: "false",
    }, new Date("2026-08-01T04:05:00.000Z"))).toMatchObject({
      ready: false,
      rehearsal: false,
      workersReady: false,
      evidenceReady: false,
      lrsConfigurationReady: true,
    });

    const encryptionKey = Buffer.from(
      secrets.AAIS_RESEARCH_IDENTITY_ENCRYPTION_KEY,
      "base64",
    );
    const fingerprintKey = Buffer.from(
      secrets.AAIS_RESEARCH_IDENTITY_FINGERPRINT_KEY,
      "base64",
    );
    expect(encryptionKey).toHaveLength(32);
    expect(fingerprintKey).toHaveLength(32);
    expect(encryptionKey.equals(fingerprintKey)).toBe(false);
    const databasePassword = new URL(secrets.AAIS_RESEARCH_DATABASE_URL).password;
    const distinctSecrets = [
      secrets.AAIS_SESSION_SECRET,
      secrets.AAIS_RESEARCH_IDENTITY_ENCRYPTION_KEY,
      secrets.AAIS_RESEARCH_IDENTITY_FINGERPRINT_KEY,
      ...expectedLrsStores.flatMap(([prefix]) => [
        secrets[`${prefix}_USERNAME`],
        secrets[`${prefix}_PASSWORD`],
      ]),
      databasePassword,
      secrets.AAIS_MAINLAND_TEST_LRS_RECEIPT_SIGNING_KEY_PKCS8,
    ];
    expect(distinctSecrets.every(Boolean)).toBe(true);
    expect(new Set(distinctSecrets).size).toBe(distinctSecrets.length);

    const privateKey = createPrivateKey({
      key: Buffer.from(
        secrets.AAIS_MAINLAND_TEST_LRS_RECEIPT_SIGNING_KEY_PKCS8,
        "base64",
      ),
      format: "der",
      type: "pkcs8",
    });
    const publicKey = createPublicKey({
      key: Buffer.from(
        secrets.AAIS_RESEARCH_LRS_RECEIPT_VERIFYING_KEY_SPKI,
        "base64",
      ),
      format: "der",
      type: "spki",
    });
    expect(privateKey.asymmetricKeyType).toBe("ed25519");
    expect(publicKey.asymmetricKeyType).toBe("ed25519");
    expect(createPublicKey(privateKey).export({ format: "der", type: "spki" }))
      .toEqual(publicKey.export({ format: "der", type: "spki" }));
    const message = Buffer.from("local-test-receipt", "utf8");
    expect(verify(null, message, publicKey, sign(null, message, privateKey))).toBe(true);

    const productionResearchConfig = getAaisResearchConfiguration(effectiveEnv);
    expect(productionResearchConfig).toMatchObject({
      studyId,
      environment: "research",
      lrsNamespace: `https://www.aais.site/xapi/studies/${studyId}/research/v1`,
      lrsStoreId: secrets.AAIS_RESEARCH_LRS_STORE_ID,
      rehearsalMode: true,
      participantActorIds: actors,
      identityRetentionDays: 7,
      rawTextRetentionDays: 7,
      factRetentionDays: 30,
      backupRetentionDays: 1,
    });
    const productionLrsConfig = getAaisResearchLrsConfiguration(effectiveEnv);
    expect(productionLrsConfig).toMatchObject({
      endpoint: "http://localhost:43239/stores/aais-research/xapi",
      username: secrets.AAIS_RESEARCH_LRS_USERNAME,
      password: secrets.AAIS_RESEARCH_LRS_PASSWORD,
      storeId: secrets.AAIS_RESEARCH_LRS_STORE_ID,
      receiptVerification: {
        keyId: secrets.AAIS_RESEARCH_LRS_RECEIPT_VERIFYING_KEY_ID,
      },
    });

    const manifestText = await readFile(path.join(outputDir, "manifest.json"), "utf8");
    const manifest = JSON.parse(manifestText);
    expect(manifest).toMatchObject({
      profile_id: "mainland-caa-is-test",
      classification: "test-only",
      status: "pending",
      evidence_boundary: "not provider evidence",
      sanitized: true,
      study_id: studyId,
      environment: "research",
      roster: {
        actor_count: 3,
        actor_ids_in_manifest: false,
      },
      retention_days: {
        identity: 7,
        raw_text: 7,
        events: 30,
        backup: 1,
      },
      lrs: {
        mode: "four localhost test stores",
        store_count: 4,
        external_delivery_enabled: false,
        physical_isolation_proven: false,
        provider_tenant_proven: false,
        provider_credentials_proven: false,
        signer: {
          authority: "local test signer",
          provider_evidence: false,
        },
      },
      governance: {
        template_count: 6,
        crosswalk_control_count: 13,
        templates_complete: false,
        formal_receipts_generated: 0,
        formal_launch_authorized: false,
        expected_study_launch_ready: false,
      },
      ai_provider: {
        status: "pending",
        allowed_scope: "approved mainland China test endpoint only",
        content_policy: "synthetic and minimized content only",
        data_region_recorded: false,
        support_access_recorded: false,
        processor_terms_recorded: false,
      },
    });
    expect(manifest.lrs.stores.map((store) => ({
      env_prefix: store.env_prefix,
      endpoint_path: store.endpoint_path,
      retention_days: store.retention_days,
      physical_isolation_proven: store.physical_isolation_proven,
      credentials_in_manifest: store.credentials_in_manifest,
    }))).toEqual([
      {
        env_prefix: "AAIS_PRODUCTION_LRS",
        endpoint_path: "/stores/aais-production/xapi",
        retention_days: 7,
        physical_isolation_proven: false,
        credentials_in_manifest: false,
      },
      {
        env_prefix: "AAIS_STAGING_LRS",
        endpoint_path: "/stores/aais-staging/xapi",
        retention_days: 7,
        physical_isolation_proven: false,
        credentials_in_manifest: false,
      },
      {
        env_prefix: "AAIS_RESEARCH_LRS",
        endpoint_path: "/stores/aais-research/xapi",
        retention_days: 30,
        physical_isolation_proven: false,
        credentials_in_manifest: false,
      },
      {
        env_prefix: "MAIS_LRS",
        endpoint_path: "/stores/mais/xapi",
        retention_days: 1,
        physical_isolation_proven: false,
        credentials_in_manifest: false,
      },
    ]);
    const sensitiveValues = [
      ...actors,
      secrets.AAIS_SESSION_SECRET,
      secrets.AAIS_RESEARCH_IDENTITY_ENCRYPTION_KEY,
      secrets.AAIS_RESEARCH_IDENTITY_FINGERPRINT_KEY,
      secrets.AAIS_RESEARCH_DATABASE_URL,
      ...expectedLrsStores.flatMap(([prefix]) => [
        secrets[`${prefix}_ENDPOINT`],
        secrets[`${prefix}_USERNAME`],
        secrets[`${prefix}_PASSWORD`],
      ]),
      secrets.AAIS_RESEARCH_LRS_RECEIPT_VERIFYING_KEY_SPKI,
      secrets.AAIS_MAINLAND_TEST_LRS_RECEIPT_SIGNING_KEY_PKCS8,
    ];
    for (const sensitiveValue of sensitiveValues) {
      expect(manifestText).not.toContain(sensitiveValue);
    }

    const chineseTemplateKeywords = [
      "简易伦理审查",
      "内部测试者告知书",
      "数据清单与保留期",
      "简版委托处理条款",
      "安全事件记录",
      "撤回及 closeout 清单",
    ];
    for (const [index, fileName] of GOVERNANCE_TEMPLATE_FILENAMES.entries()) {
      const content = await readFile(path.join(outputDir, fileName), "utf8");
      expect(content).toContain("TEST-ONLY");
      expect(content).toContain("PENDING");
      expect(content).toContain("NOT PROVIDER EVIDENCE");
      expect(content).toContain(chineseTemplateKeywords[index]);
      expect(content).toMatch(/[\u4e00-\u9fff]/);
      for (const actor of actors) {
        expect(content).not.toContain(actor);
      }
    }
    expect(await readFile(
      path.join(outputDir, GOVERNANCE_TEMPLATE_FILENAMES[0]),
      "utf8",
    )).toContain("PENDING — NOT APPROVED");
    const notice = await readFile(
      path.join(outputDir, GOVERNANCE_TEMPLATE_FILENAMES[1]),
      "utf8",
    );
    expect(notice).toContain("测试者签名或内部确认标识：PENDING");
    expect(notice).toContain("中国内地测试 endpoint");
    const vendorTerms = await readFile(
      path.join(outputDir, GOVERNANCE_TEMPLATE_FILENAMES[3]),
      "utf8",
    );
    expect(vendorTerms).toContain("数据区域与支持访问 PENDING");
    expect(vendorTerms).toContain("外部 LRS、analytics、telemetry");
    const crosswalk = await readFile(
      path.join(outputDir, "13-control-crosswalk.md"),
      "utf8",
    );
    expect(CONTROL_NAMES).toHaveLength(13);
    expect(crosswalk.match(/^\| \d+ \|/gm)).toHaveLength(13);
    expect(crosswalk.match(
      /^\| \d+ \|.*\| TEST-ONLY \| PENDING \| NOT PROVIDER EVIDENCE \|$/gm,
    )).toHaveLength(13);
    const sanitizedArtifacts = (await Promise.all(EXPECTED_FILENAMES
      .filter((fileName) => fileName !== "secrets.env")
      .map((fileName) => readFile(path.join(outputDir, fileName), "utf8"))))
      .join("\n");
    for (const sensitiveValue of sensitiveValues) {
      expect(sanitizedArtifacts).not.toContain(sensitiveValue);
    }
  });

  it("supports CLI --participants 5 and rejects combining it with --actors", async () => {
    const root = await createTemporaryRoot();
    const outputDir = path.join(root, "five-participant-pack");
    const parsed = parseArgs([
      "--output",
      outputDir,
      "--participants",
      "5",
      "--study-id",
      "mainland-caa-is-test-five-participants",
      "--commit-sha",
      "77ec56051af1eef41d2b64e70462d00c3d38c7c9",
      "--lrs-port",
      "43240",
    ]);
    expect(parsed).toMatchObject({
      outputDir,
      participantCount: "5",
      studyId: "mainland-caa-is-test-five-participants",
      lrsPort: "43240",
    });
    const stdout = execFileSync(process.execPath, [
      path.resolve(process.cwd(), "scripts/generate-aais-mainland-test-profile.mjs"),
      "--output",
      outputDir,
      "--participants",
      "5",
      "--study-id",
      "mainland-caa-is-test-five-participants",
      "--commit-sha",
      "77ec56051af1eef41d2b64e70462d00c3d38c7c9",
      "--lrs-port",
      "43240",
    ], { encoding: "utf8" });
    expect(JSON.parse(stdout)).toMatchObject({
      status: "generated",
      profile: "mainland-caa-is-test",
      actorCount: 5,
      fileCount: EXPECTED_FILENAMES.length,
      secrets: "redacted",
    });
    const secrets = parseEnv(await readFile(path.join(outputDir, "secrets.env"), "utf8"));
    expect(secrets.AAIS_RESEARCH_PARTICIPANT_ACTOR_IDS).toBe([
      "caaistest-01",
      "caaistest-02",
      "caaistest-03",
      "caaistest-04",
      "caaistest-05",
    ].join(","));
    expect(JSON.parse(await readFile(path.join(outputDir, "manifest.json"), "utf8")))
      .toMatchObject({ roster: { actor_count: 5 } });
    expect(() => parseArgs([
      "--output",
      path.join(root, "invalid"),
      "--participants",
      "5",
      "--actors",
      "caaistest-a,caaistest-b,caaistest-c",
    ])).toThrow("mutually exclusive");
  });

  it("allows external outputs but restricts in-repository packs to the operations register", async () => {
    const token = randomUUID();
    const externalRoot = await createTemporaryRoot();
    const externalOutput = path.join(externalRoot, `external-profile-${token}`);
    await generateAaisMainlandTestProfile({
      outputDir: externalOutput,
      participantCount: 3,
      studyId: `mainland-caa-is-test-external-${token}`,
      commitSha: "77ec56051af1eef41d2b64e70462d00c3d38c7c9",
    });
    expect((await lstat(externalOutput)).mode & 0o777).toBe(0o700);

    const allowedOutput = path.join(
      RESTRICTED_STUDY_OUTPUT_ROOT,
      `vitest-mainland-profile-${token}`,
    );
    temporaryRoots.push(allowedOutput);
    await generateAaisMainlandTestProfile({
      outputDir: allowedOutput,
      participantCount: 3,
      studyId: `mainland-caa-is-test-path-${token}`,
      commitSha: "77ec56051af1eef41d2b64e70462d00c3d38c7c9",
    });
    expect((await lstat(allowedOutput)).mode & 0o777).toBe(0o700);

    const forbiddenOutput = path.join(
      AAIS_SOURCE_ROOT,
      "tests",
      `forbidden-mainland-profile-${token}`,
    );
    await expect(generateAaisMainlandTestProfile({
      outputDir: forbiddenOutput,
      participantCount: 3,
      studyId: `mainland-caa-is-test-forbidden-${token}`,
      commitSha: "77ec56051af1eef41d2b64e70462d00c3d38c7c9",
    })).rejects.toThrow("output/restricted-study-operations/<new-run-dir>");
    await expect(lstat(forbiddenOutput)).rejects.toMatchObject({ code: "ENOENT" });

    const symlinkRoot = await createTemporaryRoot();
    const repositoryAlias = path.join(symlinkRoot, "aais-link");
    await symlink(path.join(AAIS_SOURCE_ROOT, "tests"), repositoryAlias, "dir");
    const aliasDirectoryName = `forbidden-symlink-profile-${token}`;
    const aliasedOutput = path.join(repositoryAlias, aliasDirectoryName);
    const canonicalAliasedOutput = path.join(
      AAIS_SOURCE_ROOT,
      "tests",
      aliasDirectoryName,
    );
    await expect(generateAaisMainlandTestProfile({
      outputDir: aliasedOutput,
      participantCount: 3,
      studyId: `mainland-caa-is-test-symlink-${token}`,
      commitSha: "77ec56051af1eef41d2b64e70462d00c3d38c7c9",
    })).rejects.toThrow("output/restricted-study-operations/<new-run-dir>");
    await expect(lstat(canonicalAliasedOutput)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(lstat(path.join(canonicalAliasedOutput, "secrets.env")))
      .rejects.toMatchObject({ code: "ENOENT" });
  });

  it("accepts only three to five unique lowercase caaistest aliases", async () => {
    const root = await createTemporaryRoot();
    const base = {
      commitSha: "77ec56051af1eef41d2b64e70462d00c3d38c7c9",
      studyId: "mainland-caa-is-test-validation",
    };
    await expect(generateAaisMainlandTestProfile({
      ...base,
      outputDir: path.join(root, "too-few"),
      actors: ["caaistest-01", "caaistest-02"],
    })).rejects.toThrow("3-5 participant actors");
    await expect(generateAaisMainlandTestProfile({
      ...base,
      outputDir: path.join(root, "too-many"),
      actors: Array.from({ length: 6 }, (_, index) => `caaistest-${index + 1}`),
    })).rejects.toThrow("3-5 participant actors");
    await expect(generateAaisMainlandTestProfile({
      ...base,
      outputDir: path.join(root, "duplicate"),
      actors: ["caaistest-01", "caaistest-01", "caaistest-02"],
    })).rejects.toThrow("must be unique");
    await expect(generateAaisMainlandTestProfile({
      ...base,
      outputDir: path.join(root, "unsafe"),
      actors: ["caaistest-01", "real-student-02", "caaistest-03"],
    })).rejects.toThrow("caaistest-* aliases");
    await expect(generateAaisMainlandTestProfile({
      ...base,
      outputDir: path.join(root, "participant-count-two"),
      participantCount: 2,
    })).rejects.toThrow("must be 3, 4, or 5");
    await expect(generateAaisMainlandTestProfile({
      ...base,
      outputDir: path.join(root, "participant-count-six"),
      participantCount: 6,
    })).rejects.toThrow("must be 3, 4, or 5");
    await expect(generateAaisMainlandTestProfile({
      ...base,
      outputDir: path.join(root, "both-rosters"),
      actors: ["caaistest-a", "caaistest-b", "caaistest-c"],
      participantCount: 3,
    })).rejects.toThrow("mutually exclusive");
  });

  it("refuses to overwrite an existing restricted profile pack", async () => {
    const root = await createTemporaryRoot();
    const outputDir = path.join(root, "immutable-pack");
    const input = {
      outputDir,
      actors: ["caaistest-a", "caaistest-b", "caaistest-c"],
      studyId: "mainland-caa-is-test-no-overwrite",
      commitSha: "77ec56051af1eef41d2b64e70462d00c3d38c7c9",
    };
    await generateAaisMainlandTestProfile(input);
    const original = await readFile(path.join(outputDir, "secrets.env"), "utf8");

    await expect(generateAaisMainlandTestProfile(input))
      .rejects.toThrow("refusing to overwrite");
    expect(await readFile(path.join(outputDir, "secrets.env"), "utf8")).toBe(original);
  });
});

async function createTemporaryRoot() {
  const root = await mkdtemp(path.join(os.tmpdir(), "aais-mainland-test-profile-"));
  temporaryRoots.push(root);
  return root;
}

function parseEnv(content) {
  return Object.fromEntries(content
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith("#"))
    .map((line) => {
      const separator = line.indexOf("=");
      return [line.slice(0, separator), line.slice(separator + 1)];
    }));
}
