#!/usr/bin/env node

import { execFile } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

const defaultReleaseCheckReportPath = "output/aais-enterprise-release-check-latest.json";
const defaultVercelEnvReportPath = "output/aais-vercel-env-report-latest.json";
const defaultProvisionReportPath = "output/aais-vercel-env-provision-dry-run-latest.json";
const defaultOutputPath = "output/aais-enterprise-handoff-latest.json";
const defaultMarkdownOutputPath = "output/aais-enterprise-handoff-latest.md";
const defaultPrivateEnvTemplatePath = "output/aais-private-env-template-latest.env";
const defaultPrivateEnvTemplateReportPath = "output/aais-private-env-template-report-latest.json";
const defaultPrivateEnvFilePath = ".env.production.local";
const defaultPostgresRestoreTemplatePath = "output/aais-postgres-restore-template-latest.env";
const defaultPostgresRestoreTemplateReportPath = "output/aais-postgres-restore-template-report-latest.json";
const defaultEnterpriseReportPath = "output/aais-enterprise-report-latest.json";
const defaultReleaseEvidenceReportPath = "output/aais-release-evidence-latest.json";
const defaultSourceProvenanceReportPath = "output/aais-source-provenance-latest.json";
const defaultVercelDeploymentReportPath = "output/aais-vercel-deployment-report-latest.json";
const defaultPostgresRestoreReportPath = "output/aais-postgres-restore-report-latest.json";
const defaultAiEvalManifestPath = "output/aais-ai-eval-deepseek-v4-flash.json";
const defaultOidcConfigReportPath = "output/aais-oidc-config-report-latest.json";
const defaultPrivateRestoreEnvFilePath = ".env.postgres-restore.local";
const defaultBaseUrl = "https://www.aais.site";
const defaultReleaseId = "aais-2026-06-30-rc-live-ai-deepseek-v4-flash";
const productionDeployCommand = "vercel deploy --prod -y --no-wait";

const storageNames = [
  "AAIS_DATABASE_URL",
  "DATABASE_URL",
  "POSTGRES_URL",
  "POSTGRES_PRISMA_URL",
  "DATABASE_URL_UNPOOLED",
  "POSTGRES_URL_NON_POOLING",
  "PGHOST",
  "PGHOST_UNPOOLED",
  "PGUSER",
  "PGDATABASE",
  "PGPASSWORD",
  "POSTGRES_HOST",
  "POSTGRES_HOST_NON_POOLING",
  "POSTGRES_USER",
  "POSTGRES_DATABASE",
  "POSTGRES_PASSWORD",
];
const canonicalStorageMissingNames = ["AAIS_DATABASE_URL"];
const oidcNames = [
  "AAIS_OIDC_ISSUER",
  "AAIS_OIDC_CLIENT_ID",
  "AAIS_OIDC_CLIENT_SECRET",
  "AAIS_OIDC_REDIRECT_URI",
];
const oidcRoleMappingRequestName = "AAIS_OIDC_TEACHER_GROUPS";
const oidcRoleMappingNames = [
  "AAIS_OIDC_TEACHER_GROUPS",
  "AAIS_OIDC_TEACHER_EMAILS",
  "AAIS_OIDC_ADMIN_GROUPS",
  "AAIS_OIDC_ADMIN_EMAILS",
];
const releaseNames = ["AAIS_RELEASE_ID", "AAIS_DEPLOYMENT_GIT_COMMIT_SHA"];

export async function generateAaisEnterpriseHandoff(input = {}) {
  const generatedAt = (input.now ?? new Date()).toISOString();
  const releaseCheckReportPath = input.releaseCheckReportPath ?? defaultReleaseCheckReportPath;
  const vercelEnvReportPath = input.vercelEnvReportPath ?? defaultVercelEnvReportPath;
  const provisionReportPath = input.provisionReportPath ?? defaultProvisionReportPath;
  const enterpriseReportPath = input.enterpriseReportPath ?? defaultEnterpriseReportPath;
  const releaseEvidenceReportPath = input.releaseEvidenceReportPath ?? defaultReleaseEvidenceReportPath;
  const sourceProvenanceReportPath = input.sourceProvenanceReportPath ?? defaultSourceProvenanceReportPath;
  const vercelDeploymentReportPath = input.vercelDeploymentReportPath ?? defaultVercelDeploymentReportPath;
  const postgresRestoreReportPath = input.postgresRestoreReportPath ?? defaultPostgresRestoreReportPath;
  const aiEvalManifestPath = input.aiEvalManifestPath ?? defaultAiEvalManifestPath;
  const oidcConfigReportPath = input.oidcConfigReportPath ?? defaultOidcConfigReportPath;
  const outputPath = input.outputPath ?? process.env.AAIS_ENTERPRISE_HANDOFF_REPORT_PATH ?? defaultOutputPath;
  const markdownOutputPath = input.markdownOutputPath
    ?? process.env.AAIS_ENTERPRISE_HANDOFF_MARKDOWN_PATH
    ?? defaultMarkdownOutputPath;
  const privateEnvTemplatePath = input.privateEnvTemplatePath ?? defaultPrivateEnvTemplatePath;
  const privateEnvTemplateReportPath = input.privateEnvTemplateReportPath ?? defaultPrivateEnvTemplateReportPath;
  const privateEnvFilePath = input.privateEnvFilePath ?? defaultPrivateEnvFilePath;
  const postgresRestoreTemplatePath = input.postgresRestoreTemplatePath ?? defaultPostgresRestoreTemplatePath;
  const postgresRestoreTemplateReportPath = input.postgresRestoreTemplateReportPath
    ?? defaultPostgresRestoreTemplateReportPath;
  const privateRestoreEnvFilePath = input.privateRestoreEnvFilePath ?? defaultPrivateRestoreEnvFilePath;
  const baseUrl = normalizeUrl(input.baseUrl ?? process.env.AAIS_RELEASE_DEPLOYMENT_URL ?? defaultBaseUrl);
  const releaseId = readSafeReleaseId(input.releaseId ?? process.env.AAIS_RELEASE_ID ?? defaultReleaseId);
  const releaseCheck = await readJsonIfExists(releaseCheckReportPath);
  const vercelEnv = await readJsonIfExists(vercelEnvReportPath);
  const provision = await readJsonIfExists(provisionReportPath);
  const enterprise = await readJsonIfExists(enterpriseReportPath);
  const missingEnv = getMissingEnvNames(releaseCheck.value, vercelEnv.value);
  const currentCodeDeployReasons = getCurrentCodeDeployReasons(releaseCheck.value);
  const missing = {
    vercelProductionEnv: missingEnv,
    storage: missingEnv.filter((name) => canonicalStorageMissingNames.includes(name)),
    oidc: missingEnv.filter((name) => oidcNames.includes(name)),
    oidcRoleMapping: missingEnv.filter((name) => name === oidcRoleMappingRequestName),
    postgresRestoreReport: releaseCheck.value?.artifacts?.postgresRestore?.status !== "passed",
    ssoOnlyRuntimeMode: releaseCheck.value?.artifacts?.enterprise?.requiredChecks?.ssoOnlyMode !== true,
    realOidcCallbackSmoke: releaseCheck.value?.artifacts?.enterprise?.requiredChecks?.oidcCallback !== true,
    teacherCohortAnalyticsSmoke: releaseCheck.value?.artifacts?.enterprise?.requiredChecks?.cohortAnalytics !== true,
    currentCodeDeploy: currentCodeDeployReasons.length > 0,
    currentCodeDeployReasons,
  };
  const localCredentialInventory = await getLocalCredentialInventory(
    input.localCredentialFiles ?? [defaultPrivateEnvFilePath, ".env.local", "All API Keys.docx"],
    [...new Set([...storageNames, ...oidcNames, ...oidcRoleMappingNames, ...releaseNames])],
    missing.vercelProductionEnv,
  );
  const externalActions = getExternalActions({
    missing,
    vercelEnv: vercelEnv.value,
    baseUrl,
    releaseId,
    releaseCheckReportPath,
    vercelEnvReportPath,
    enterpriseReportPath,
    releaseEvidenceReportPath,
    sourceProvenanceReportPath,
    vercelDeploymentReportPath,
    postgresRestoreReportPath,
    aiEvalManifestPath,
    oidcConfigReportPath,
    privateEnvTemplatePath,
    privateEnvTemplateReportPath,
    privateEnvFilePath,
    postgresRestoreTemplatePath,
    postgresRestoreTemplateReportPath,
    privateRestoreEnvFilePath,
  });

  const report = {
    schemaVersion: 1,
    status: releaseCheck.value?.status === "passed" ? "ready" : "action-required",
    generatedAt,
    sourceReports: {
      releaseCheck: releaseCheckReportPath,
      vercelEnv: vercelEnvReportPath,
      provision: provisionReportPath,
      enterprise: enterpriseReportPath,
    },
    currentGate: {
      status: normalizeStatus(releaseCheck.value?.status),
      checkedAt: readIsoTimestamp(releaseCheck.value?.checkedAt),
      sequence: sanitizeSequence(releaseCheck.value?.sequence),
    },
    missing,
    localCredentialInventory,
    provisionDryRun: {
      status: normalizeStatus(provision.value?.status),
      localValuesPresent: getSafeEnvNames(
        provision.value?.required?.localValuesPresent ?? provision.value?.localValuesPresent,
      ),
      localValuesMissing: getSafeEnvNames(
        provision.value?.required?.localValuesMissing ?? provision.value?.localValuesMissing,
      ),
    },
    enterpriseDiagnostics: summarizeEnterpriseDiagnostics(enterprise.value),
    externalActions,
    redaction: {
      secrets: "omitted",
      values: "not-read",
    },
  };

  if (outputPath) {
    await writeTextFile(outputPath, `${JSON.stringify(report, null, 2)}\n`);
  }
  if (markdownOutputPath) {
    await writeTextFile(markdownOutputPath, renderMarkdown(report));
  }

  return report;
}

async function readJsonIfExists(filePath) {
  try {
    const raw = await readFile(filePath, "utf8");
    return {
      ok: true,
      value: JSON.parse(raw),
    };
  } catch {
    return {
      ok: false,
      value: null,
    };
  }
}

async function getLocalCredentialInventory(files, names, requiredNames = names) {
  const rows = [];
  for (const file of files) {
    const text = await readCredentialSearchText(file);
    const presentNames = names.filter((name) => hasEnvName(text, name));
    rows.push({
      path: file,
      exists: existsSync(file),
      presentNames,
    });
  }
  const present = new Set(rows.flatMap((row) => row.presentNames));
  const required = new Set(requiredNames);
  const storageRequired = canonicalStorageMissingNames.some((name) => required.has(name));
  const oidcRequiredNames = oidcNames.filter((name) => required.has(name));
  const oidcRoleMappingRequired = required.has(oidcRoleMappingRequestName);
  const releaseRequiredNames = releaseNames.filter((name) => required.has(name));
  const localStorageUsable = storageNames.some((name) => [
    "AAIS_DATABASE_URL",
    "DATABASE_URL",
    "POSTGRES_URL",
    "POSTGRES_PRISMA_URL",
    "DATABASE_URL_UNPOOLED",
    "POSTGRES_URL_NON_POOLING",
  ].includes(name) && present.has(name))
    || (
      (present.has("PGHOST") || present.has("PGHOST_UNPOOLED"))
      && ["PGUSER", "PGDATABASE", "PGPASSWORD"].every((name) => present.has(name))
    )
    || (
      (present.has("POSTGRES_HOST") || present.has("POSTGRES_HOST_NON_POOLING"))
      && ["POSTGRES_USER", "POSTGRES_DATABASE", "POSTGRES_PASSWORD"].every((name) => present.has(name))
    );
  const missingOidcNames = oidcRequiredNames.filter((name) => !present.has(name));
  const oidcRoleMappingUsable = !oidcRoleMappingRequired
    || oidcRoleMappingNames.some((name) => present.has(name));
  const missingReleaseNames = releaseRequiredNames.filter((name) => !present.has(name));
  const storageUsable = !storageRequired || localStorageUsable;
  const oidcUsable = missingOidcNames.length === 0 && oidcRoleMappingUsable;
  const releaseUsable = missingReleaseNames.length === 0;
  const missingNames = [
    ...(storageUsable ? [] : canonicalStorageMissingNames),
    ...missingOidcNames,
    ...(oidcRoleMappingUsable ? [] : [oidcRoleMappingRequestName]),
    ...missingReleaseNames,
  ];
  return {
    values: "not-read",
    storageUsable,
    oidcUsable,
    oidcRoleMappingUsable,
    releaseUsable,
    missingNames,
    files: rows,
  };
}

async function readCredentialSearchText(file) {
  if (!existsSync(file)) {
    return "";
  }
  if (/\.docx$/i.test(file)) {
    try {
      const { stdout } = await execFileAsync("unzip", ["-p", file, "word/document.xml"], {
        maxBuffer: 5 * 1024 * 1024,
      });
      return stdout;
    } catch {
      return readFile(file, "latin1");
    }
  }
  return readFile(file, "latin1");
}

function getExternalActions(input) {
  const actions = [];
  if (input.missing.vercelProductionEnv.length > 0) {
    actions.push({
      id: "fill-private-env-template",
      status: "required",
      templatePath: input.privateEnvTemplatePath,
      reportPath: input.privateEnvTemplateReportPath,
      privateEnvFilePath: input.privateEnvFilePath,
      commands: [
        [
          "npm run provision:vercel-env --",
          `--env-file ${input.privateEnvFilePath}`,
          `--report ${input.vercelEnvReportPath}`,
          "--output output/aais-vercel-env-provision-dry-run-latest.json",
        ].join(" "),
        [
          "npm run provision:vercel-env --",
          `--env-file ${input.privateEnvFilePath}`,
          `--report ${input.vercelEnvReportPath}`,
          "--apply",
          "--output output/aais-vercel-env-provision-apply-latest.json",
        ].join(" "),
      ],
    });
    if (input.missing.oidc.length > 0 || input.missing.oidcRoleMapping.length > 0) {
      actions.push({
        id: "verify-oidc-config-dry-run",
        status: "required-after-private-env-fill",
        command: [
          "npm run verify:oidc-config --",
          `--env-file ${input.privateEnvFilePath}`,
          `--base-url ${input.baseUrl}`,
          `--output ${input.oidcConfigReportPath}`,
        ].join(" "),
      });
    }
    actions.push({
      id: "set-vercel-production-env",
      status: "required",
      missing: input.missing.vercelProductionEnv,
      acceptedStorageSources: input.vercelEnv?.storageUrl?.acceptedNames ?? [
        "AAIS_DATABASE_URL",
        "DATABASE_URL",
        "POSTGRES_URL",
        "POSTGRES_PRISMA_URL",
        "DATABASE_URL_UNPOOLED",
        "POSTGRES_URL_NON_POOLING",
        "PGHOST/PGUSER/PGDATABASE/PGPASSWORD",
        "POSTGRES_HOST/POSTGRES_USER/POSTGRES_DATABASE/POSTGRES_PASSWORD",
      ],
      commands: getVercelEnvCommands(input.vercelEnv, input.missing.vercelProductionEnv),
    });
  }
  if (input.missing.vercelProductionEnv.length > 0 || input.missing.currentCodeDeploy) {
    actions.push({
      id: "redeploy-vercel-production",
      status: input.missing.vercelProductionEnv.length > 0
        ? "required-after-env-change"
        : "required-after-code-change",
      command: productionDeployCommand,
      ...(input.missing.currentCodeDeploy && input.missing.vercelProductionEnv.length === 0
        ? {
            reason: `current production evidence is missing code-level release checks: ${input.missing.currentCodeDeployReasons.join(", ")}`,
          }
        : {}),
    });
    actions.push(createProductionDeployInspectAction("inspect-vercel-production-deployment", input));
  }
  if (input.missing.postgresRestoreReport) {
    actions.push({
      id: "fill-postgres-restore-template",
      status: "required",
      templatePath: input.postgresRestoreTemplatePath,
      reportPath: input.postgresRestoreTemplateReportPath,
      privateRestoreEnvFilePath: input.privateRestoreEnvFilePath,
      commands: [
        [
          "npm run verify:postgres-restore --",
          `--env-file ${input.privateRestoreEnvFilePath}`,
          "--database-provider neon",
          `--output ${input.postgresRestoreReportPath}`,
          `--release-id ${input.releaseId}`,
        ].join(" "),
      ],
    });
    actions.push({
      id: "run-neon-restore-rehearsal",
      status: "required",
      command: [
        "npm run verify:postgres-restore --",
        "--database-url <restored-neon-staging-database-url>",
        "--database-provider neon",
        `--output ${input.postgresRestoreReportPath}`,
        `--release-id ${input.releaseId}`,
      ].join(" "),
    });
  }
  if (input.missing.oidc.length > 0 || input.missing.realOidcCallbackSmoke) {
    actions.push({
      id: "run-real-oidc-callback-smoke",
      status: "required",
      command: [
        "AAIS_VERIFY_OIDC_CALLBACK_URL=<REQUIRED:TRANSIENT_OIDC_CALLBACK_URL>",
        "AAIS_VERIFY_OIDC_STATE_COOKIE=<REQUIRED:TRANSIENT_OIDC_STATE_COOKIE>",
        "npm run verify:enterprise --",
        `--base-url ${input.baseUrl}`,
        "--require-sso-only",
        `--release-id ${input.releaseId}`,
        `--output ${input.enterpriseReportPath}`,
      ].join(" "),
    });
  }
  if (input.missing.teacherCohortAnalyticsSmoke) {
    actions.push({
      id: "run-teacher-cohort-analytics-smoke",
      status: "required",
      note: "Uses the teacher/admin OIDC callback session to prove filtered cohort analytics and matching cohort export JSON without raw learner text.",
      command: [
        "AAIS_VERIFY_OIDC_CALLBACK_URL=<REQUIRED:TRANSIENT_TEACHER_OR_ADMIN_OIDC_CALLBACK_URL>",
        "AAIS_VERIFY_OIDC_STATE_COOKIE=<REQUIRED:TRANSIENT_TEACHER_OR_ADMIN_OIDC_STATE_COOKIE>",
        "AAIS_VERIFY_REQUIRE_COHORT_ANALYTICS=true",
        "npm run verify:enterprise --",
        `--base-url ${input.baseUrl}`,
        "--require-sso-only",
        `--release-id ${input.releaseId}`,
        `--output ${input.enterpriseReportPath}`,
      ].join(" "),
    });
  }
  if (input.missing.ssoOnlyRuntimeMode) {
    actions.push({
      id: "set-sso-only-runtime-mode",
      status: "required-after-sso-verification",
      command: "vercel env add AAIS_TRIAL_LOGIN_ENABLED production",
      requiredValue: "false",
      note: "Set the value to false only after OIDC login is verified, then redeploy production.",
    });
    actions.push({
      id: "redeploy-vercel-production-after-sso-only",
      status: "required-after-sso-only-change",
      command: productionDeployCommand,
    });
    actions.push(createProductionDeployInspectAction("inspect-vercel-production-deployment-after-sso-only", input));
  }
  const finalGateOidcCallbackEnv = input.missing.teacherCohortAnalyticsSmoke
    ? [
        "AAIS_VERIFY_OIDC_CALLBACK_URL=<REQUIRED:TRANSIENT_TEACHER_OR_ADMIN_OIDC_CALLBACK_URL>",
        "AAIS_VERIFY_OIDC_STATE_COOKIE=<REQUIRED:TRANSIENT_TEACHER_OR_ADMIN_OIDC_STATE_COOKIE>",
      ]
    : input.missing.realOidcCallbackSmoke
      ? [
          "AAIS_VERIFY_OIDC_CALLBACK_URL=<REQUIRED:TRANSIENT_OIDC_CALLBACK_URL>",
          "AAIS_VERIFY_OIDC_STATE_COOKIE=<REQUIRED:TRANSIENT_OIDC_STATE_COOKIE>",
        ]
      : [];
  actions.push({
    id: "rerun-final-gate",
    status: "required",
    command: [
      ...finalGateOidcCallbackEnv,
      ...(input.missing.teacherCohortAnalyticsSmoke ? [
        "AAIS_VERIFY_REQUIRE_COHORT_ANALYTICS=true",
      ] : []),
      "npm run verify:enterprise-release --",
      `--base-url ${input.baseUrl}`,
      `--release-id ${input.releaseId}`,
      "--deployment-git-commit <git-sha>",
      `--vercel-env-report ${input.vercelEnvReportPath}`,
      `--source-provenance-report ${input.sourceProvenanceReportPath}`,
      `--vercel-deployment-report ${input.vercelDeploymentReportPath}`,
      `--enterprise-report ${input.enterpriseReportPath}`,
      `--release-evidence-output ${input.releaseEvidenceReportPath}`,
      `--ai-eval-manifest ${input.aiEvalManifestPath}`,
      `--postgres-restore-report ${input.postgresRestoreReportPath}`,
      `--deployment-url ${input.baseUrl}`,
      "--deployment-platform vercel",
      "--database-provider neon",
      `--output ${input.releaseCheckReportPath}`,
      "--max-age-hours 168",
    ].join(" "),
  });
  return actions;
}

function getCurrentCodeDeployReasons(releaseCheck) {
  const reasons = [];
  const enterprise = releaseCheck?.artifacts?.enterprise ?? {};
  if (enterprise?.readiness?.releaseIdMatchesExpected !== true) {
    reasons.push("release-identity");
  }
  if (enterprise?.artifactCoalescing?.complete === false) {
    reasons.push("artifact-coalescing");
  }
  if (enterprise?.requiredChecks?.legalPages !== true) {
    reasons.push("legal-pages");
  }
  reasons.push(...getVercelDeploymentReasons(releaseCheck?.artifacts?.vercelDeployment));
  if (releaseCheck?.artifacts?.vercelConfig?.status !== "passed") {
    reasons.push("scheduled-outbox-drain");
  }
  return reasons;
}

function getVercelDeploymentReasons(artifact) {
  if (artifact?.status === "passed") {
    return [];
  }
  const deployment = artifact?.deployment ?? artifact ?? {};
  const reasons = [];
  if (deployment.readyState && deployment.readyState !== "READY") {
    reasons.push("vercel-deployment-ready-state");
  }
  if (deployment.target && deployment.target !== "production") {
    reasons.push("vercel-deployment-target");
  }
  if (deployment.urlMatchesExpected === false || deployment.targetMatchesProduction === false) {
    reasons.push("vercel-deployment-url");
  }
  if (deployment.gitCommitShortSha === null || deployment.gitCommitShortSha === undefined) {
    reasons.push("vercel-deployment-git-commit");
  }
  return reasons.length > 0 ? reasons : ["vercel-deployment-ready"];
}

function createProductionDeployInspectAction(id, input) {
  return {
    id,
    status: "required-after-production-deploy",
    command: [
      "npm run verify:vercel-deployment --",
      "--deployment-url <deployment-url>",
      `--release-id ${input.releaseId}`,
      "--deployment-git-commit <git-sha>",
      `--output ${input.vercelDeploymentReportPath}`,
    ].join(" "),
    note: "Use the deployment URL returned by vercel deploy --prod -y --no-wait; pass the same git SHA recorded in source provenance and AAIS_DEPLOYMENT_GIT_COMMIT_SHA. The verifier runs Vercel inspect and fails until the deployment is READY.",
  };
}

function summarizeEnterpriseDiagnostics(enterpriseReport) {
  const failedOnlineChecks = Array.isArray(enterpriseReport?.checks)
    ? enterpriseReport.checks
      .map((check) => ({
        name: readSafeCheckName(check?.name),
        errorCategory: readSafeErrorCategory(check?.details?.errorCategory),
      }))
      .filter((check) => check.name && check.errorCategory)
    : [];
  return {
    status: normalizeStatus(enterpriseReport?.status),
    onlineFailureCategories: Array.from(new Set(failedOnlineChecks.map((check) => check.errorCategory))),
    failedOnlineChecks,
    rawErrors: "omitted",
  };
}

function getVercelEnvCommands(vercelEnv, missingEnv) {
  const safeCommands = [];
  const allowed = new Set(missingEnv);
  const actions = Array.isArray(vercelEnv?.provisioningPlan?.actions)
    ? vercelEnv.provisioningPlan.actions
    : [];
  for (const action of actions) {
    for (const command of action?.commands ?? []) {
      const match = String(command).match(/^vercel env add ([A-Z][A-Z0-9_]{1,127}) production$/);
      if (match && allowed.has(match[1])) {
        safeCommands.push(command);
      }
    }
  }
  for (const name of missingEnv) {
    const command = `vercel env add ${name} production`;
    if (!safeCommands.includes(command)) {
      safeCommands.push(command);
    }
  }
  return safeCommands;
}

function getMissingEnvNames(releaseCheck, vercelEnv) {
  return getSafeEnvNames(
    releaseCheck?.artifacts?.vercelEnv?.missing
      ?? vercelEnv?.required?.missing
      ?? [],
  );
}

function hasEnvName(text, name) {
  return new RegExp(`(?:^|[^A-Z0-9_])${escapeRegExp(name)}(?:[^A-Z0-9_]|$)`, "m").test(text);
}

function sanitizeSequence(value) {
  return Array.isArray(value)
    ? value.map((item) => ({
      name: readSafeToken(item?.name),
      status: normalizeStatus(item?.status),
      outputPath: typeof item?.outputPath === "string" ? item.outputPath : null,
    }))
    : [];
}

function renderMarkdown(report) {
  const lines = [
    "# AAIS Enterprise Handoff",
    "",
    `Status: ${report.status}`,
    `Generated: ${report.generatedAt}`,
    `Current gate: ${report.currentGate.status}`,
    "",
    "## Missing Vercel Production Variables",
    "",
    ...report.missing.vercelProductionEnv.map((name) => `- ${name}`),
    "",
    "## Required Actions",
    "",
    ...report.externalActions.flatMap((action) => [
      `- ${action.id}: ${action.status}`,
      ...(action.templatePath ? [`  - template: ${action.templatePath}`] : []),
      ...(action.privateEnvFilePath ? [`  - private env: ${action.privateEnvFilePath}`] : []),
      ...(action.privateRestoreEnvFilePath ? [`  - private restore env: ${action.privateRestoreEnvFilePath}`] : []),
      ...(action.note ? [`  - note: ${action.note}`] : []),
      ...(action.command ? [`  - ${action.command}`] : []),
      ...(action.commands ? action.commands.map((command) => `  - ${command}`) : []),
    ]),
    "",
    "## Enterprise Smoke Diagnostics",
    "",
    `- status: ${report.enterpriseDiagnostics.status}`,
    `- online failure categories: ${report.enterpriseDiagnostics.onlineFailureCategories.join(", ") || "none"}`,
    ...report.enterpriseDiagnostics.failedOnlineChecks.map(
      (check) => `- ${check.name}: ${check.errorCategory}`,
    ),
    "",
    "## Redaction",
    "",
    "- Secret values are omitted.",
    "- Local credential files were checked for variable names only.",
    "",
  ];
  return `${lines.join("\n")}`;
}

async function writeTextFile(filePath, text) {
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, text, "utf8");
}

function getSafeEnvNames(value) {
  return Array.isArray(value)
    ? value
      .map((item) => String(item ?? "").trim())
      .filter((item) => /^[A-Z][A-Z0-9_*\\/-]{1,127}$/.test(item))
    : [];
}

function normalizeStatus(value) {
  const status = String(value ?? "").trim().toLowerCase();
  return /^[a-z][a-z0-9_-]{1,31}$/.test(status) ? status : "unknown";
}

function readSafeReleaseId(value) {
  const trimmed = String(value ?? "").trim();
  return /^[A-Za-z0-9][A-Za-z0-9._:-]{2,127}$/.test(trimmed) ? trimmed : defaultReleaseId;
}

function readSafeToken(value) {
  const token = String(value ?? "").trim();
  return /^[A-Za-z0-9][A-Za-z0-9._:-]{1,127}$/.test(token) ? token : null;
}

function readSafeCheckName(value) {
  const token = String(value ?? "").trim();
  return /^[a-z][a-z0-9-]{1,63}$/.test(token) ? token : null;
}

function readSafeErrorCategory(value) {
  const token = String(value ?? "").trim();
  return /^(connect-timeout|response-timeout|dns|tls|network|unknown)$/.test(token) ? token : null;
}

function readIsoTimestamp(value) {
  if (typeof value !== "string") {
    return null;
  }
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString();
}

function normalizeUrl(value) {
  const trimmed = String(value ?? "").trim().replace(/\/+$/, "");
  try {
    const url = new URL(trimmed);
    return url.protocol === "https:" ? trimmed : defaultBaseUrl;
  } catch {
    return defaultBaseUrl;
  }
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function parseCliArgs(argv) {
  const args = new Map();
  for (let index = 0; index < argv.length; index += 1) {
    const current = argv[index];
    if (!current.startsWith("--")) {
      continue;
    }
    const [rawKey, inlineValue] = current.slice(2).split("=");
    const nextValue = argv[index + 1];
    const value = inlineValue ?? (nextValue && !nextValue.startsWith("--") ? nextValue : true);
    if (inlineValue === undefined && value === nextValue) {
      index += 1;
    }
    args.set(rawKey, value);
  }
  return args;
}

async function main() {
  const args = parseCliArgs(process.argv.slice(2));
  const report = await generateAaisEnterpriseHandoff({
    releaseCheckReportPath: args.get("release-check-report"),
    vercelEnvReportPath: args.get("vercel-env-report"),
    provisionReportPath: args.get("provision-report"),
    enterpriseReportPath: args.get("enterprise-report"),
    releaseEvidenceReportPath: args.get("release-evidence-report"),
    sourceProvenanceReportPath: args.get("source-provenance-report"),
    postgresRestoreReportPath: args.get("postgres-restore-report"),
    aiEvalManifestPath: args.get("ai-eval-manifest"),
    oidcConfigReportPath: args.get("oidc-config-report"),
    outputPath: args.get("output"),
    markdownOutputPath: args.get("markdown-output"),
    baseUrl: args.get("base-url"),
    releaseId: args.get("release-id"),
  });
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : "AAIS enterprise handoff generation failed."}\n`);
    process.exitCode = 1;
  });
}
