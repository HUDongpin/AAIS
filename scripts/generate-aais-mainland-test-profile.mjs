#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import {
  createHash,
  generateKeyPairSync,
  randomBytes,
  randomUUID,
} from "node:crypto";
import { chmod, lstat, mkdir, realpath, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const MODULE_PATH = fileURLToPath(import.meta.url);
export const AAIS_SOURCE_ROOT = path.resolve(path.dirname(MODULE_PATH), "..");
export const RESTRICTED_STUDY_OUTPUT_ROOT = path.join(
  AAIS_SOURCE_ROOT,
  "output",
  "restricted-study-operations",
);
export const PROFILE_ID = "mainland-caa-is-test";
export const FORMAL_WORKER_OVERRIDE_NAMES = [
  "AAIS_RESEARCH_LRS_OUTBOX_FLUSH_TOKEN",
  "AAIS_RESEARCH_RETENTION_TOKEN",
  "AAIS_RESEARCH_LRS_EVENT_FLUSH_SCHEDULE_ID",
  "AAIS_RESEARCH_LRS_DELETION_SCHEDULE_ID",
  "AAIS_RESEARCH_RETENTION_SCHEDULE_ID",
];
export const FORMAL_EVIDENCE_OVERRIDE_NAMES = [
  "AAIS_RESEARCH_DATABASE_ISOLATION_RECEIPT_SHA256",
  "AAIS_RESEARCH_LRS_ISOLATION_RECEIPT_SHA256",
  "AAIS_RESEARCH_LRS_ZERO_BASELINE_RECEIPT_SHA256",
  "AAIS_RESEARCH_LRS_PUT_DELETE_RECEIPT_SHA256",
  "AAIS_RESEARCH_BACKUP_POLICY_RECEIPT_SHA256",
  "AAIS_RESEARCH_RESTORE_RECEIPT_SHA256",
  "AAIS_RESEARCH_LEGACY_ARCHIVE_RECEIPT_SHA256",
  "AAIS_RESEARCH_ACCESS_REGISTER_RECEIPT_SHA256",
  "AAIS_RESEARCH_CONSENT_LEGAL_BASIS_RECEIPT_SHA256",
  "AAIS_RESEARCH_DPA_RECEIPT_SHA256",
  "AAIS_RESEARCH_DATA_REGION_RECEIPT_SHA256",
  "AAIS_RESEARCH_DAILY_BACKUP_RECEIPT_SHA256",
  "AAIS_RESEARCH_BACKUP_DESTRUCTION_RECEIPT_SHA256",
  "AAIS_RESEARCH_GOVERNANCE_MANIFEST_RECEIPT_SHA256",
];
export const GOVERNANCE_FRESHNESS_OVERRIDE_NAMES = [
  "AAIS_RESEARCH_GOVERNANCE_MANIFEST_VERIFIED_AT",
  "AAIS_RESEARCH_GOVERNANCE_MANIFEST_VALID_UNTIL",
  "AAIS_RESEARCH_DAILY_BACKUP_COMPLETED_AT",
  "AAIS_RESEARCH_BACKUP_DESTRUCTION_OBSERVED_AT",
];
export const AI_EMPTY_OVERRIDE_NAMES = [
  "DASHSCOPE_API_KEY",
  "QWEN_API_KEY",
  "DASHSCOPE_OPENAI_ENDPOINT",
  "QWEN_API_ENDPOINT",
  "DASHSCOPE_BASE_URL",
  "QWEN_BASE_URL",
  "DASHSCOPE_MODEL",
  "QWEN_MODEL",
  "AAIS_AI_ENDPOINT",
  "AAIS_AI_API_KEY",
  "AAIS_AI_MODEL",
  "AAIS_AI_FALLBACK_ENDPOINT",
  "AAIS_AI_FALLBACK_API_KEY",
  "AAIS_AI_FALLBACK_MODEL",
  "OPENAI_API_KEY",
  "OPENAI_BASE_URL",
  "OPENAI_ENDPOINT",
  "OPENAI_MODEL",
];
export const GOVERNANCE_TEMPLATE_FILENAMES = [
  "01-test-scope-and-ethics-review.md",
  "02-participant-notice.md",
  "03-data-inventory-and-retention.md",
  "04-access-vendor-register-and-processor-terms.md",
  "05-security-incident-backup-restore.md",
  "06-withdrawal-deletion-closeout.md",
];
export const LRS_STORE_SPECS = [
  {
    key: "aais-production",
    projectId: "aais",
    environment: "production",
    envPrefix: "AAIS_PRODUCTION_LRS",
    endpointPath: "/stores/aais-production/xapi",
    retentionDays: 7,
  },
  {
    key: "aais-staging",
    projectId: "aais",
    environment: "staging",
    envPrefix: "AAIS_STAGING_LRS",
    endpointPath: "/stores/aais-staging/xapi",
    retentionDays: 7,
  },
  {
    key: "aais-research",
    projectId: "aais",
    environment: "research",
    envPrefix: "AAIS_RESEARCH_LRS",
    endpointPath: "/stores/aais-research/xapi",
    retentionDays: 30,
  },
  {
    key: "mais",
    projectId: "mais",
    environment: "test",
    envPrefix: "MAIS_LRS",
    endpointPath: "/stores/mais/xapi",
    retentionDays: 1,
  },
];
export const CONTROL_NAMES = [
  "专用研究 Postgres 隔离 / Dedicated research Postgres isolation",
  "LRS store 或 tenant 物理隔离 / Physical LRS isolation",
  "外部 LRS 零基线 / External LRS zero baseline",
  "外部 LRS PUT GET DELETE 对账 / External reconciliation",
  "备份规则 / Backup policy",
  "恢复演练 / Restore rehearsal",
  "旧混合池归档 / Legacy mixed-pool archive",
  "访问与保管人登记 / Access and custodian register",
  "告知同意与处理基础 / Consent and processing basis",
  "处理方委托条款 / Processor terms",
  "数据区域 / Data region",
  "每日备份完成 / Daily backup completion",
  "备份销毁证据 / Backup destruction evidence",
];
export const EXPECTED_FILENAMES = [
  "secrets.env",
  "manifest.json",
  ...GOVERNANCE_TEMPLATE_FILENAMES,
  "13-control-crosswalk.md",
];

const TEST_BANNER = "TEST-ONLY · PENDING · NOT PROVIDER EVIDENCE";
const PARTICIPANT_ACTOR_PATTERN = /^caaistest-[a-z0-9][a-z0-9._-]{0,63}$/;
const STUDY_ID_PATTERN = /^mainland-caa-is-test-[a-z0-9][a-z0-9._-]{0,96}$/;

export async function generateAaisMainlandTestProfile(input) {
  const now = input.now instanceof Date ? input.now : new Date();
  if (!Number.isFinite(now.getTime())) {
    throw new Error("AAIS mainland test profile requires a valid generation time.");
  }
  const outputDir = path.resolve(String(input.outputDir ?? ""));
  if (!input.outputDir || outputDir === path.parse(outputDir).root) {
    throw new Error("AAIS mainland test profile requires a safe non-root output directory.");
  }
  const expectedOutputLocation = await assertSafeOutputLocation(outputDir);
  const actors = resolveActors({
    actors: input.actors,
    participantCount: input.participantCount,
  });
  const studyId = normalizeStudyId(
    input.studyId ?? `${PROFILE_ID}-${toRunTag(now)}`,
  );
  const commitSha = normalizeCommitSha(input.commitSha ?? resolveGitCommitSha());
  const appVersion = normalizeToken(input.appVersion ?? "0.1.0", "app version", 64);
  const lrsPort = normalizePort(input.lrsPort ?? 3239);
  const generatedAt = now.toISOString();
  const runId = randomUUID();
  const scopeHash = createHash("sha256")
    .update(`${PROFILE_ID}\0${studyId}\0${runId}`)
    .digest("hex")
    .slice(0, 16);
  const lrsNamespace =
    `https://www.aais.site/xapi/studies/${encodeURIComponent(studyId)}/research/v1`;
  const databaseInstanceId = `caaistest-pg-${scopeHash}`;

  const issuedSecrets = new Set();
  const issueSecret = (size, encoding = "base64url") => {
    for (;;) {
      const value = randomBytes(size).toString(encoding);
      if (!issuedSecrets.has(value)) {
        issuedSecrets.add(value);
        return value;
      }
    }
  };
  const sessionSecret = issueSecret(32, "hex");
  const productPseudonymSecret = issueSecret(32, "base64url");
  const identityEncryptionKey = issueSecret(32, "base64");
  const identityFingerprintKey = issueSecret(32, "base64");
  const lrsStores = LRS_STORE_SPECS.map((spec) => ({
    ...spec,
    endpoint: `http://localhost:${lrsPort}${spec.endpointPath}`,
    storeId: `caaistest-${spec.key}-${scopeHash}`,
    username: `caaistest_${spec.key.replaceAll("-", "_")}_${issueSecret(8, "hex")}`,
    password: issueSecret(32, "base64url"),
  }));
  const databasePassword = issueSecret(32, "base64url");
  const databaseUser = `aais_test_${scopeHash}`;
  const databaseName = `aais_test_${scopeHash}`;
  const databaseUrl =
    `postgresql://${databaseUser}:${databasePassword}@localhost:55432/${databaseName}`;
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const receiptVerifyingSpki = publicKey
    .export({ format: "der", type: "spki" })
    .toString("base64");
  const receiptSigningPkcs8 = privateKey
    .export({ format: "der", type: "pkcs8" })
    .toString("base64");
  const receiptKeyId = `caaistest-ed25519-${scopeHash}`;
  assertDistinctSecrets([
    sessionSecret,
    productPseudonymSecret,
    identityEncryptionKey,
    identityFingerprintKey,
    ...lrsStores.flatMap((store) => [store.username, store.password]),
    databasePassword,
    receiptSigningPkcs8,
  ]);
  assertDistinctLrsStores(lrsStores);

  const secretsEnv = buildSecretsEnv({
    actors,
    appVersion,
    commitSha,
    databaseInstanceId,
    databaseUrl,
    generatedAt,
    identityEncryptionKey,
    identityFingerprintKey,
    lrsNamespace,
    lrsStores,
    receiptKeyId,
    receiptSigningPkcs8,
    receiptVerifyingSpki,
    runId,
    sessionSecret,
    productPseudonymSecret,
    studyId,
  });
  const manifest = buildSanitizedManifest({
    actors,
    appVersion,
    commitSha,
    databaseInstanceId,
    generatedAt,
    lrsNamespace,
    lrsStores,
    receiptKeyId,
    runId,
    studyId,
  });
  const governanceTemplates = buildGovernanceTemplates({
    actorCount: actors.length,
    generatedAt,
    lrsNamespace,
    studyId,
  });
  const crosswalk = buildControlCrosswalk({ generatedAt, studyId });

  await mkdir(path.dirname(outputDir), { recursive: true, mode: 0o700 });
  try {
    await mkdir(outputDir, { recursive: false, mode: 0o700 });
  } catch (error) {
    if (error && typeof error === "object" && error.code === "EEXIST") {
      throw new Error("AAIS mainland test profile output already exists; refusing to overwrite.");
    }
    throw error;
  }
  await chmod(outputDir, 0o700);
  const createdOutputStats = await lstat(outputDir);
  const createdCanonicalOutput = await realpath(outputDir);
  const revalidatedOutputLocation = await assertSafeOutputLocation(outputDir);
  if (
    !createdOutputStats.isDirectory()
    || createdOutputStats.isSymbolicLink()
    || createdCanonicalOutput !== expectedOutputLocation.canonicalOutputDir
    || revalidatedOutputLocation.canonicalOutputDir
      !== expectedOutputLocation.canonicalOutputDir
  ) {
    throw new Error(
      "AAIS mainland test profile output location changed during creation; refusing to write secrets.",
    );
  }
  await writeRestrictedFile(path.join(outputDir, "secrets.env"), secretsEnv);
  await writeRestrictedFile(
    path.join(outputDir, "manifest.json"),
    `${JSON.stringify(manifest, null, 2)}\n`,
  );
  for (const [fileName, content] of governanceTemplates) {
    await writeRestrictedFile(path.join(outputDir, fileName), content);
  }
  await writeRestrictedFile(
    path.join(outputDir, "13-control-crosswalk.md"),
    crosswalk,
  );

  return {
    outputDir,
    files: [...EXPECTED_FILENAMES],
    manifest,
  };
}

function buildSecretsEnv(input) {
  const lrsValues = input.lrsStores.flatMap((store) => [
    [`${store.envPrefix}_ENDPOINT`, store.endpoint],
    [`${store.envPrefix}_USERNAME`, store.username],
    [`${store.envPrefix}_PASSWORD`, store.password],
    [`${store.envPrefix}_STORE_ID`, store.storeId],
    [`${store.envPrefix}_RETENTION_DAYS`, String(store.retentionDays)],
  ]);
  const values = [
    ["AAIS_MAINLAND_TEST_PROFILE", PROFILE_ID],
    ["AAIS_MAINLAND_TEST_RUN_ID", input.runId],
    ["AAIS_MAINLAND_TEST_GENERATED_AT", input.generatedAt],
    ["AAIS_RESEARCH_MODE", "true"],
    ["AAIS_RESEARCH_REQUIRED", "true"],
    ["AAIS_RESEARCH_REHEARSAL_MODE", "true"],
    ["AAIS_RESEARCH_REHEARSAL_APPROVED", "true"],
    ["AAIS_RESEARCH_PROJECT_ID", "aais"],
    ["AAIS_RESEARCH_STUDY_ID", input.studyId],
    ["AAIS_RESEARCH_ENVIRONMENT", "research"],
    ["AAIS_RESEARCH_PARTICIPANT_ACTOR_IDS", input.actors.join(",")],
    ["AAIS_RESEARCH_CONDITIONS", "internal-test"],
    ["AAIS_RESEARCH_DATABASE_URL", input.databaseUrl],
    ["AAIS_RESEARCH_DATABASE_INSTANCE_ID", input.databaseInstanceId],
    ["AAIS_RESEARCH_DATABASE_DRIVER", "pg"],
    ["AAIS_RESEARCH_LRS_NAMESPACE", input.lrsNamespace],
    ...lrsValues,
    ["AAIS_RESEARCH_LRS_RECEIPT_VERIFYING_KEY_ID", input.receiptKeyId],
    ["AAIS_RESEARCH_LRS_RECEIPT_VERIFYING_KEY_SPKI", input.receiptVerifyingSpki],
    ["AAIS_MAINLAND_TEST_LRS_RECEIPT_SIGNING_KEY_PKCS8", input.receiptSigningPkcs8],
    ["AAIS_RESEARCH_IDENTITY_ENCRYPTION_KEY", input.identityEncryptionKey],
    ["AAIS_RESEARCH_IDENTITY_FINGERPRINT_KEY", input.identityFingerprintKey],
    ["AAIS_RESEARCH_IDENTITY_KEY_VERSION", "mainland-test-v1"],
    ["AAIS_RESEARCH_PI_ACTOR_IDS", "caaistest-operator"],
    ["AAIS_RESEARCH_DATA_CUSTODIAN_ACTOR_IDS", "caaistest-custodian"],
    ["AAIS_RESEARCH_EXPORT_ACTOR_IDS", "caaistest-researcher"],
    ["AAIS_RESEARCH_EXPORT_ENABLED", "true"],
    ["AAIS_SESSION_SECRET", input.sessionSecret],
    ["AAIS_PRODUCT_PSEUDONYM_SECRET", input.productPseudonymSecret],
    ["AAIS_APP_VERSION", input.appVersion],
    ["AAIS_COMMIT_SHA", input.commitSha],
    ["AAIS_RESEARCH_IDENTITY_RETENTION_DAYS", "7"],
    ["AAIS_RESEARCH_RAW_TEXT_RETENTION_DAYS", "7"],
    ["AAIS_RESEARCH_EVENT_RETENTION_DAYS", "30"],
    ["AAIS_RESEARCH_BACKUP_RETENTION_DAYS", "1"],
    ["AAIS_AI_PROVIDER", "disabled"],
    ...AI_EMPTY_OVERRIDE_NAMES.map((name) => [name, ""]),
    ["SENTRY_DSN", ""],
    ["NEXT_PUBLIC_SENTRY_DSN", ""],
    ["SENTRY_ORG", ""],
    ["SENTRY_PROJECT", ""],
    ["SENTRY_AUTH_TOKEN", ""],
    ["SENTRY_TRACES_SAMPLE_RATE", "0"],
    ["NEXT_PUBLIC_SENTRY_TRACES_SAMPLE_RATE", "0"],
    ["NEXT_TELEMETRY_DISABLED", "1"],
    ["LRS_ENDPOINT", ""],
    ["LRS_USERNAME", ""],
    ["LRS_PASSWORD", ""],
    ["AAIS_LRS_OUTBOX_FLUSH_TOKEN", ""],
    ["CRON_SECRET", ""],
    ...FORMAL_WORKER_OVERRIDE_NAMES.map((name) => [name, ""]),
    ...FORMAL_EVIDENCE_OVERRIDE_NAMES.map((name) => [name, ""]),
    ...GOVERNANCE_FRESHNESS_OVERRIDE_NAMES.map((name) => [name, ""]),
  ];
  const names = values.map(([name]) => name);
  if (new Set(names).size !== names.length) {
    throw new Error("AAIS mainland test profile contains duplicate environment overrides.");
  }
  const lines = values.map(([name, value]) => serializeEnvLine(name, value));
  return [
    "# TEST-ONLY · PENDING · NOT PROVIDER EVIDENCE",
    "# Restricted runtime material for an internal CAAIS rehearsal only.",
    "# Empty values below are deliberate fail-closed overrides for ambient AI, Sentry, generic LRS, formal workers, receipts, and freshness timestamps.",
    "# The Ed25519 key pair is a local test signer and is never provider evidence.",
    "",
    ...lines,
    "",
  ].join("\n");
}

function buildSanitizedManifest(input) {
  return {
    schema: "https://www.aais.site/schemas/mainland-caa-is-test-profile/v1",
    profile_id: PROFILE_ID,
    classification: "test-only",
    status: "pending",
    evidence_boundary: "not provider evidence",
    sanitized: true,
    generated_at: input.generatedAt,
    run_id: input.runId,
    project_id: "aais",
    study_id: input.studyId,
    environment: "research",
    app_version: input.appVersion,
    commit_sha: input.commitSha,
    lrs_namespace: input.lrsNamespace,
    roster: {
      actor_count: input.actors.length,
      actor_policy: "dedicated caaistest aliases only",
      actor_ids_in_manifest: false,
    },
    retention_days: {
      identity: 7,
      raw_text: 7,
      events: 30,
      backup: 1,
    },
    storage: {
      source_of_truth: "postgres",
      database_instance_id: input.databaseInstanceId,
      intended_lifecycle: "isolated ephemeral test database",
      physical_isolation_proven: false,
    },
    lrs: {
      mode: "four localhost test stores",
      store_count: input.lrsStores.length,
      external_delivery_enabled: false,
      physical_isolation_proven: false,
      provider_tenant_proven: false,
      provider_credentials_proven: false,
      stores: input.lrsStores.map((store) => ({
        key: store.key,
        project_id: store.projectId,
        environment: store.environment,
        env_prefix: store.envPrefix,
        endpoint_path: store.endpointPath,
        store_id: store.storeId,
        credentials_in_manifest: false,
        physical_isolation_proven: false,
        retention_days: store.retentionDays,
      })),
      signer: {
        algorithm: "Ed25519",
        key_id: input.receiptKeyId,
        authority: "local test signer",
        key_material_location: "restricted secrets.env",
        provider_evidence: false,
      },
    },
    credentials: {
      generated: true,
      pairwise_distinct: true,
      values_in_manifest: false,
      location: "restricted secrets.env",
    },
    ai_provider: {
      status: "pending",
      allowed_scope: "approved mainland China test endpoint only",
      content_policy: "synthetic and minimized content only",
      data_region_recorded: false,
      support_access_recorded: false,
      processor_terms_recorded: false,
    },
    governance: {
      template_count: GOVERNANCE_TEMPLATE_FILENAMES.length,
      crosswalk_control_count: CONTROL_NAMES.length,
      templates_complete: false,
      formal_receipts_generated: 0,
      formal_launch_authorized: false,
      expected_study_launch_ready: false,
    },
  };
}

function buildGovernanceTemplates(input) {
  const banner = `> **${TEST_BANNER}**  \n> 本文件仅用于中国内地 CAAIS 内部测试准备，不构成伦理批准、正式研究同意、供应商事实或正式实验启动证据。\n`;
  const common = `- 测试配置 / Profile: \`${PROFILE_ID}\`\n- 测试编号 / Study ID: \`${input.studyId}\`\n- 生成时间 / Generated: \`${input.generatedAt}\`\n- 完成状态 / Status: **PENDING**\n`;
  const templates = [
    [
      GOVERNANCE_TEMPLATE_FILENAMES[0],
      `# 测试范围与简易伦理审查 / Test Scope And Ethics Review\n\n${banner}\n${common}\n## 简易申请\n\n测试目的：CAAIS 内部工程演练  \n预计内部测试名额：**${input.actorCount}**  \n测试对象：仅限使用专用测试别名的内部测试人员  \n真实学生或未成年人：禁止纳入  \n敏感信息或生产数据：禁止输入  \nAI/provider 处理：**PENDING**；启用前必须登记实际数据区域、支持人员访问路径及处理条款。仅允许经批准的中国内地测试 endpoint，且只能发送合成、最小化内容。  \n外部 LRS、analytics、telemetry：保持禁用  \n计划开始时间：PENDING  \n计划销毁时间：PENDING\n\n## 审查决定\n\n审查人：PENDING  \n决定：**PENDING — NOT APPROVED**  \n决定时间：PENDING  \n附加条件或理由：PENDING\n\n生成本表绝不等于获得批准；本表始终是 **TEST-ONLY**，且属于 **NOT PROVIDER EVIDENCE**。\n`,
    ],
    [
      GOVERNANCE_TEMPLATE_FILENAMES[1],
      `# 内部测试者告知书 / Participant Notice\n\n${banner}\n${common}\n测试别名：PENDING  \n测试负责人及联系方式：PENDING  \n告知日期：PENDING\n\n## 请在参加测试前阅读\n\n1. 本次活动是 CAAIS 内部工程测试，不是正式学生实验。\n2. 请只使用分配给你的专用测试别名，并只输入合成内容。不要输入真实姓名、学生记录、保密文件或敏感个人信息。\n3. 系统会记录实际 UI 操作的元数据事件；受限文本不会复制到事件分析或 LRS statement。\n4. 计划最长保留期为：身份对应 7 天、原始文本 7 天、事件事实 30 天、临时测试备份 1 天。\n5. 如启用 AI，只能使用已登记并批准的中国内地测试 endpoint，只发送合成和最小化内容；启用状态目前为 **PENDING**。\n6. 你可以随时要求停止记录并删除本次测试 run，不影响你的工作安排。\n7. 外部 LRS、analytics 与 telemetry 在本测试包中保持禁用。\n\n## 测试者确认\n\n- [ ] 我已阅读并理解以上内容。\n- [ ] 我会使用测试别名和合成内容，不输入真实学生或敏感资料。\n- [ ] 我知道可以随时退出并申请删除。\n\n测试者签名或内部确认标识：PENDING  \n确认时间：PENDING\n\n本告知书为 **TEST-ONLY**，不替代正式研究同意书，且属于 **NOT PROVIDER EVIDENCE**。\n`,
    ],
    [
      GOVERNANCE_TEMPLATE_FILENAMES[2],
      `# 数据清单与保留期 / Data Inventory And Retention\n\n${banner}\n${common}\n## 最低数据清单\n\n| 数据类别 | 测试用途 | 保存位置 | 最长保留期 | 状态 |\n| --- | --- | --- | ---: | --- |\n| 加密身份对应 | 将专用测试别名绑定到随机 participant_id | 受限 identity schema | 7 天 | PENDING |\n| 受限合成学习文本 | 演练真实学习流程 | Product Postgres | 7 天 | PENDING |\n| 仅含元数据的研究事件与 outbox | 核对 UI 操作与 Postgres 事实 | Research Postgres | 30 天 | PENDING |\n| 临时加密备份（如有） | 仅用于恢复演练 | 由操作人登记的受限位置 | 1 天 | PENDING |\n| 本地 LRS 测试 statements | 演练四条相互隔离的 localhost 路由 | 内存型本地测试 stores | 各 store 为 7、7、30、1 天 | PENDING |\n| 经批准的境内 AI 测试请求（如启用） | 用合成、最小化内容测试受治理 AI 行为 | 使用前登记 endpoint、数据区域、支持访问及条款 | PENDING | PENDING |\n| Runtime secrets 与本地签名私钥 | 启动本次测试包 | 受限 \`secrets.env\` | closeout 时删除 | PENDING |\n\nPostgres 始终是事实源；canonical research namespace 为 \`${input.lrsNamespace}\`。本清单任何一项都不构成 provider evidence。\n`,
    ],
    [
      GOVERNANCE_TEMPLATE_FILENAMES[3],
      `# 访问、供应方登记与简版委托处理条款 / Access Vendor Register And Processor Terms\n\n${banner}\n${common}\n## 受限访问登记\n\nActor identifiers 仅保存在 \`secrets.env\`，请勿复制到本表。\n\n| 角色 | 指定内部人员 | 授权时间 | 撤销时间 | 状态 |\n| --- | --- | --- | --- | --- |\n| 测试负责人 | PENDING | PENDING | PENDING | PENDING |\n| 数据保管人 | PENDING | PENDING | PENDING | PENDING |\n| 受控导出人员 | PENDING | PENDING | PENDING | PENDING |\n\n## 供应方与处理登记\n\n| 组件 | 操作方或供应方 | 处理数据 | 实际位置 | 条款状态 |\n| --- | --- | --- | --- | --- |\n| 测试主机 | PENDING | 应用 runtime | PENDING | PENDING |\n| 测试 Postgres | PENDING | 加密身份、合成文本、事件事实 | PENDING | PENDING |\n| 四个 localhost LRS stores | 内部测试进程 | 元数据 statements | 同一测试主机上的独立路由 | TEST-ONLY |\n| 拟使用的中国内地 AI 测试 endpoint | PENDING | 仅合成、最小化 prompt 内容 | 数据区域与支持访问 PENDING | PENDING — 未批准前不得使用 |\n| 外部 LRS、analytics、telemetry | 无 | 无 | N/A | 禁用 |\n\n## 简版委托处理条款\n\n所有指定内部操作人或经批准的中国内地 AI 测试处理方必须：仅按书面测试指令处理；承担保密义务；实施合理访问与安全控制；禁止复用、出售、训练或无关分析；披露实际数据区域与支持人员访问；及时报告疑似事件；协助撤回和删除；在 closeout 时返还或删除测试数据。\n\n接受方：PENDING  \n接受时间：PENDING  \n条款状态：**PENDING — NOT EXECUTED**\n\n本表不是已签署 DPA，且属于 **NOT PROVIDER EVIDENCE**。\n`,
    ],
    [
      GOVERNANCE_TEMPLATE_FILENAMES[4],
      `# 安全、事件、备份与恢复 / Security Incident Backup And Restore\n\n${banner}\n${common}\n## 最低安全检查\n\n- [ ] 测试包目录权限为 0700，每个文件为 0600。\n- [ ] Session、database、LRS、identity、HMAC、AI 与签名密钥不得进入日志、截图、报告或源码仓库。\n- [ ] 外部 LRS、analytics 与 telemetry 保持禁用或阻断。\n- [ ] 如使用 AI，必须先登记并批准中国内地测试 endpoint、数据区域、支持访问和处理条款；仅发送合成、最小化内容。\n- [ ] 只保存经过清理的计数及 reconciliation evidence。\n\n## 安全事件记录\n\n发现时间：PENDING  \n发现人：PENDING  \n影响范围：PENDING  \n遏制措施：PENDING  \n操作决定：PENDING\n\n## 备份与恢复\n\n优先使用不做备份的 ephemeral database。如创建测试备份，必须加密、限制访问、排除所有 runtime secrets，并在 1 天内销毁。恢复演练为可选项，只有实际执行后才能填写结果。\n\n备份创建时间：PENDING  \n备份销毁时间：PENDING  \n恢复演练时间：PENDING  \n恢复结果：PENDING\n\n本表为 **TEST-ONLY**，且属于 **NOT PROVIDER EVIDENCE**。\n`,
    ],
    [
      GOVERNANCE_TEMPLATE_FILENAMES[5],
      `# 撤回、删除与收尾 / Withdrawal Deletion And Closeout\n\n${banner}\n${common}\n## 撤回及 closeout 清单\n\n- [ ] 记录内部测试者请求时间，并停止该 run 的新数据采集。\n- [ ] 删除 scoped Postgres events、outbox rows、visits、加密身份记录及受限合成文本，或销毁 ephemeral database。\n- [ ] 清空四个 localhost LRS test stores。\n- [ ] 在批准的证据复核结束后撤销测试凭证并删除 \`secrets.env\`。\n- [ ] 在真实 execution ledger 中记录经过清理的删除前后计数。\n- [ ] 确认没有提出外部 provider 删除或物理隔离已经完成的声明。\n\n收到撤回请求：PENDING  \nDatabase 销毁观察时间：PENDING  \n本地 LRS 销毁观察时间：PENDING  \nBackup 销毁观察时间：PENDING  \n操作人：PENDING  \nCloseout 状态：**PENDING**\n\n生成的空白模板不是删除回执；任何本地签名 drill receipt 仍然是 **TEST-ONLY** 和 **NOT PROVIDER EVIDENCE**。\n`,
    ],
  ];
  return new Map(templates.map(([fileName, content]) => [fileName, `${content.trimEnd()}\n`]));
}

function buildControlCrosswalk(input) {
  const treatments = [
    "使用独立 ephemeral test database；操作人验证仍为待完成",
    "使用四个独立 localhost 路由；不声明 provider tenant 已物理隔离",
    "运行前观察本地 store 为空；不声明外部零基线",
    "仅演练本地 statement 操作；不声明已完成外部 provider 对账",
    "优先不备份；如有临时测试备份最长保留 1 天",
    "内部演练可选；未实际执行前保持待完成",
    "本次测试不读取或更改旧混合池归档",
    "使用受限的轻量访问与保管人登记表",
    "使用内部测试者告知书；不替代正式研究同意",
    "拟使用的境内 AI 测试处理方条款与访问在审查前保持待完成",
    "使用前登记本地主机及拟用境内 AI endpoint 的实际数据区域",
    "ephemeral run 可不执行；没有实际备份时保持未完成",
    "仅在测试数据库或备份实际销毁后记录 closeout",
  ];
  const rows = CONTROL_NAMES.map((control, index) =>
    `| ${index + 1} | ${control} | ${treatments[index]} | TEST-ONLY | PENDING | NOT PROVIDER EVIDENCE |`);
  return [
    "# 十三项控制交叉表 / Thirteen-Control Test Crosswalk",
    "",
    `> **${TEST_BANNER}**  `,
    "> 本表只记录测试例外和待完成操作检查，不能满足正式实验 launch gate。",
    "",
    `- 测试配置 / Profile: \`${PROFILE_ID}\``,
    `- 测试编号 / Study ID: \`${input.studyId}\``,
    `- 生成时间 / Generated: \`${input.generatedAt}\``,
    "- 正式回执生成数 / Formal receipts generated: **0**",
    "",
    "| # | 正式控制项 / Formal control | 本地测试处理 / Local treatment | Classification | Status | Evidence boundary |",
    "| ---: | --- | --- | --- | --- | --- |",
    ...rows,
    "",
  ].join("\n");
}

async function writeRestrictedFile(filePath, content) {
  await writeFile(filePath, content, { flag: "wx", mode: 0o600 });
  await chmod(filePath, 0o600);
}

async function assertSafeOutputLocation(outputDir) {
  const canonicalSourceRoot = await realpath(AAIS_SOURCE_ROOT);
  const canonicalRestrictedOutputRoot = path.join(
    canonicalSourceRoot,
    "output",
    "restricted-study-operations",
  );
  const resolvedRestrictedOutputRoot = await resolveCanonicalProspectivePath(
    RESTRICTED_STUDY_OUTPUT_ROOT,
  );
  const canonicalOutputDir = await resolveCanonicalProspectivePath(outputDir);
  const lexicalPathIsInsideSource = isPathInside(AAIS_SOURCE_ROOT, outputDir);
  const canonicalPathIsInsideSource = isPathInside(
    canonicalSourceRoot,
    canonicalOutputDir,
  );

  if (
    lexicalPathIsInsideSource
    && (
      path.dirname(outputDir) !== RESTRICTED_STUDY_OUTPUT_ROOT
      || resolvedRestrictedOutputRoot !== canonicalRestrictedOutputRoot
      || canonicalOutputDir !== path.join(
        canonicalRestrictedOutputRoot,
        path.basename(outputDir),
      )
    )
  ) {
    throw restrictedOutputLocationError();
  }
  if (
    canonicalPathIsInsideSource
    && path.dirname(canonicalOutputDir) !== canonicalRestrictedOutputRoot
  ) {
    throw restrictedOutputLocationError();
  }

  return {
    canonicalOutputDir,
    canonicalSourceRoot,
  };
}

async function resolveCanonicalProspectivePath(candidate) {
  let existingAncestor = path.resolve(candidate);
  const missingSegments = [];
  for (;;) {
    try {
      await lstat(existingAncestor);
    } catch (error) {
      if (!error || typeof error !== "object" || error.code !== "ENOENT") {
        throw error;
      }
      const parent = path.dirname(existingAncestor);
      if (parent === existingAncestor) {
        throw error;
      }
      missingSegments.push(path.basename(existingAncestor));
      existingAncestor = parent;
      continue;
    }
    const canonicalAncestor = await realpath(existingAncestor);
    return path.resolve(canonicalAncestor, ...missingSegments.reverse());
  }
}

function restrictedOutputLocationError() {
  return new Error(
    "AAIS mainland test profile outputs inside the source repository must use output/restricted-study-operations/<new-run-dir>.",
  );
}

function isPathInside(parent, candidate) {
  const relative = path.relative(parent, candidate);
  return relative === ""
    || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative));
}

function resolveActors(input) {
  if (input.actors !== undefined && input.participantCount !== undefined) {
    throw new Error("--actors and --participants are mutually exclusive.");
  }
  if (input.actors !== undefined) {
    return normalizeActors(input.actors);
  }
  const participantCount = normalizeParticipantCount(input.participantCount ?? 3);
  return Array.from(
    { length: participantCount },
    (_, index) => `caaistest-${String(index + 1).padStart(2, "0")}`,
  );
}

function normalizeActors(value) {
  const actors = (Array.isArray(value) ? value : String(value).split(","))
    .map((actor) => String(actor).trim())
    .filter(Boolean);
  if (actors.length < 3 || actors.length > 5) {
    throw new Error("AAIS mainland test profile requires 3-5 participant actors.");
  }
  if (new Set(actors).size !== actors.length) {
    throw new Error("AAIS mainland test profile participant actors must be unique.");
  }
  if (actors.some((actor) => !PARTICIPANT_ACTOR_PATTERN.test(actor))) {
    throw new Error("AAIS mainland test actors must use dedicated lowercase caaistest-* aliases.");
  }
  return actors;
}

function normalizeParticipantCount(value) {
  const participantCount = Number(value);
  if (!Number.isSafeInteger(participantCount) || participantCount < 3 || participantCount > 5) {
    throw new Error("AAIS mainland test --participants must be 3, 4, or 5.");
  }
  return participantCount;
}

function normalizeStudyId(value) {
  const studyId = String(value).trim();
  if (!STUDY_ID_PATTERN.test(studyId)) {
    throw new Error("AAIS mainland test study id must use the mainland-caa-is-test-* prefix.");
  }
  return studyId;
}

function normalizeCommitSha(value) {
  const commitSha = String(value ?? "").trim().toLowerCase();
  if (!/^[0-9a-f]{7,64}$/.test(commitSha)) {
    throw new Error("AAIS mainland test profile requires a real hexadecimal commit SHA.");
  }
  return commitSha;
}

function normalizeToken(value, label, maxLength) {
  const token = String(value).trim();
  if (!token || token.length > maxLength || !/^[A-Za-z0-9][A-Za-z0-9._:-]*$/.test(token)) {
    throw new Error(`AAIS mainland test ${label} is invalid.`);
  }
  return token;
}

function normalizePort(value) {
  const port = Number(value);
  if (!Number.isSafeInteger(port) || port < 1024 || port > 65535) {
    throw new Error("AAIS mainland test LRS port must be an unprivileged TCP port.");
  }
  return port;
}

function serializeEnvLine(name, value) {
  const normalized = String(value);
  if (!/^[A-Z][A-Z0-9_]*$/.test(name) || /[\r\n]/.test(normalized)) {
    throw new Error("AAIS mainland test profile produced an unsafe environment value.");
  }
  return `${name}=${normalized}`;
}

function assertDistinctSecrets(values) {
  if (values.some((value) => !value) || new Set(values).size !== values.length) {
    throw new Error("AAIS mainland test secrets must be nonempty and pairwise distinct.");
  }
}

function assertDistinctLrsStores(stores) {
  if (stores.length !== LRS_STORE_SPECS.length) {
    throw new Error("AAIS mainland test profile requires exactly four LRS stores.");
  }
  const values = stores.flatMap((store) => [
    store.endpoint,
    store.storeId,
    store.username,
    store.password,
  ]);
  if (values.some((value) => !value) || new Set(values).size !== values.length) {
    throw new Error("AAIS mainland test LRS endpoints, store ids, and credentials must not be reused.");
  }
}

function toRunTag(value) {
  return value.toISOString().replace(/[-:.]/g, "").toLowerCase();
}

function resolveGitCommitSha() {
  for (const value of [
    process.env.VERCEL_GIT_COMMIT_SHA,
    process.env.AAIS_COMMIT_SHA,
  ]) {
    if (value?.trim()) {
      return value.trim();
    }
  }
  try {
    return execFileSync("git", ["rev-parse", "HEAD"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    return "";
  }
}

export function parseArgs(argv) {
  const options = {};
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--help" || argument === "-h") {
      options.help = true;
    } else if (argument === "--output") {
      options.outputDir = requireArgumentValue(argv, ++index, argument);
    } else if (argument === "--study-id") {
      options.studyId = requireArgumentValue(argv, ++index, argument);
    } else if (argument === "--actors") {
      options.actors = requireArgumentValue(argv, ++index, argument).split(",");
    } else if (argument === "--participants") {
      options.participantCount = requireArgumentValue(argv, ++index, argument);
    } else if (argument === "--commit-sha") {
      options.commitSha = requireArgumentValue(argv, ++index, argument);
    } else if (argument === "--app-version") {
      options.appVersion = requireArgumentValue(argv, ++index, argument);
    } else if (argument === "--lrs-port") {
      options.lrsPort = requireArgumentValue(argv, ++index, argument);
    } else {
      throw new Error(`Unknown AAIS mainland test profile argument: ${argument}`);
    }
  }
  if (options.actors !== undefined && options.participantCount !== undefined) {
    throw new Error("--actors and --participants are mutually exclusive.");
  }
  return options;
}

function requireArgumentValue(argv, index, name) {
  const value = argv[index];
  if (!value || value.startsWith("--")) {
    throw new Error(`${name} requires a value.`);
  }
  return value;
}

function printHelp() {
  process.stdout.write([
    "Usage: node scripts/generate-aais-mainland-test-profile.mjs --output <new-directory> [options]",
    "",
    "Options:",
    "  --study-id mainland-caa-is-test-<run-id>",
    "  --participants 3|4|5",
    "  --actors caaistest-01,caaistest-02,caaistest-03",
    "  --commit-sha <7-64 hexadecimal characters>",
    "  --app-version <safe token>",
    "  --lrs-port <1024-65535>",
    "",
    "Creates a mode-0700 internal test pack whose files are mode 0600.",
    "--participants generates caaistest-01..N and is mutually exclusive with --actors.",
    "The pack is TEST-ONLY, PENDING, and NOT PROVIDER EVIDENCE.",
    "",
  ].join("\n"));
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    printHelp();
    return;
  }
  if (!options.outputDir) {
    throw new Error("--output is required.");
  }
  const result = await generateAaisMainlandTestProfile(options);
  process.stdout.write(`${JSON.stringify({
    status: "generated",
    profile: PROFILE_ID,
    classification: "test-only",
    evidenceBoundary: "not provider evidence",
    actorCount: result.manifest.roster.actor_count,
    fileCount: result.files.length,
    output: result.outputDir,
    secrets: "redacted",
  })}\n`);
}

const invokedAsScript = process.argv[1]
  && path.resolve(process.argv[1]) === MODULE_PATH;
if (invokedAsScript) {
  main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
