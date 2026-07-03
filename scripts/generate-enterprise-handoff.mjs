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
const defaultAiEvalManifestPath = "output/aais-ai-eval-deepseek-v4-pro.json";
const defaultOidcConfigReportPath = "output/aais-oidc-config-report-latest.json";
const defaultEnterpriseGapEvidenceReportPath = "output/aais-enterprise-gap-evidence-latest.json";
const defaultPrivateRestoreEnvFilePath = ".env.postgres-restore.local";
const defaultBaseUrl = "https://www.aais.site";
const defaultReleaseId = "aais-2026-06-30-rc-live-ai-deepseek-v4-pro";
const productionDeployCommand = "vercel deploy --prod -y --no-wait";

const storageNames = [
  "AAIS_DATABASE_URL",
  "DATABASE_URL",
  "POSTGRES_URL",
  "POSTGRES_PRISMA_URL",
  "POSTGRES_URL_NO_SSL",
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
const oidcExplicitEndpointNames = [
  "AAIS_OIDC_AUTHORIZATION_ENDPOINT",
  "AAIS_OIDC_TOKEN_ENDPOINT",
  "AAIS_OIDC_JWKS_URI",
];
const releaseNames = ["AAIS_RELEASE_ID", "AAIS_DEPLOYMENT_GIT_COMMIT_SHA"];
const oidcCallbackGapInputNames = [
  "AAIS_VERIFY_OIDC_CALLBACK_URL",
  "AAIS_VERIFY_OIDC_STATE_COOKIE",
];
const oidcCohortGapInputNames = [
  ...oidcCallbackGapInputNames,
  "AAIS_VERIFY_EXPECTED_SESSION_ROLE",
];
const trialAuthGapInputNames = [
  "AAIS_VERIFY_TRIAL_ACCOUNT",
  "AAIS_VERIFY_TRIAL_CORRECT_PASSWORD",
  "AAIS_VERIFY_EDUCATOR_ACCOUNT",
  "AAIS_VERIFY_EDUCATOR_CORRECT_PASSWORD",
];
const restoreGapInputNames = ["AAIS_RESTORE_DATABASE_URL", "AAIS_RESTORE_TARGET_PURPOSE"];
const aiEvalGapInputNames = ["AAIS_AI_ENDPOINT", "AAIS_AI_API_KEY", "AAIS_AI_MODEL", "AAIS_AI_EVAL_VERSION"];
const businessGapActionDefinitions = [
  {
    id: "production-oidc-env-config",
    label: "Production OIDC environment and config",
    description: "Fill local OIDC values, validate config, apply missing Vercel Production names, then redeploy and inspect production.",
    actionIds: [
      "fill-private-env-template",
      "verify-oidc-config-dry-run",
      "set-vercel-production-env",
      "redeploy-vercel-production",
      "inspect-vercel-production-deployment",
      "rerun-final-gate",
    ],
    appliesTo: (missing) => missing.ssoOnlyGate,
    isRequired: (missing) => missing.oidc.length > 0 || missing.oidcRoleMapping.length > 0,
    getMissingNames: (missing) => [...missing.oidc, ...missing.oidcRoleMapping],
  },
  {
    id: "real-oidc-callback",
    label: "Real OIDC callback smoke",
    description: "Capture a transient real IdP callback and matching state cookie, then prove AAIS session handoff with redacted evidence.",
    actionIds: ["run-real-oidc-callback-smoke", "rerun-final-gate"],
    appliesTo: (missing) => missing.ssoOnlyGate,
    isRequired: (missing) => missing.realOidcCallbackSmoke
      || missing.oidc.length > 0
      || missing.oidcRoleMapping.length > 0,
    getMissingNames: (missing) => [...missing.oidc, ...missing.oidcRoleMapping],
  },
  {
    id: "sso-only-cutover",
    label: "SSO-only runtime cutover",
    description: "Disable trial login only after real OIDC and teacher/admin evidence are proven, then redeploy and re-inspect production.",
    actionIds: [
      "run-real-oidc-callback-smoke",
      "set-sso-only-runtime-mode",
      "redeploy-vercel-production-after-sso-only",
      "inspect-vercel-production-deployment-after-sso-only",
      "rerun-final-gate",
    ],
    appliesTo: (missing) => missing.ssoOnlyGate,
    isRequired: (missing) => missing.ssoOnlyRuntimeMode,
  },
  {
    id: "neon-restore-rehearsal",
    label: "Restored Neon rehearsal",
    description: "Fill the ignored restored-staging Neon env file and run the restore verifier against the restored database, not production.",
    actionIds: ["fill-postgres-restore-template", "run-neon-restore-rehearsal", "rerun-final-gate"],
    isRequired: (missing) => missing.postgresRestoreReport,
  },
  {
    id: "teacher-cohort-analytics",
    label: "Teacher cohort analytics",
    description: "Use a teacher/admin OIDC session to prove filtered cohort analytics and matching export evidence without raw learner text.",
    actionIds: ["run-teacher-cohort-analytics-smoke", "run-trial-auth-enterprise-smoke", "rerun-final-gate"],
    isRequired: (missing) => missing.teacherCohortAnalyticsSmoke,
  },
  {
    id: "a1-a4-agent-evidence",
    label: "A1-A4 agent evidence",
    description: "Rerun live AI evaluation with the A1-A4/CA contract, then redeploy and rerun production evidence until readiness proves A1 scaffolding, A2 expert coaching, A3 supervision, A4 reflection, AI acceptance, and raw-text exclusion.",
    actionIds: ["run-live-ai-eval", "redeploy-vercel-production", "inspect-vercel-production-deployment", "rerun-final-gate"],
    isRequired: (missing) => missing.liveAiEval
      || missing.currentCodeDeployReasons.includes("agent-evidence"),
    getReasons: (missing) => [
      ...(missing.liveAiEval ? ["live-ai-eval-agent-evidence"] : []),
      ...missing.currentCodeDeployReasons.filter((reason) => reason === "agent-evidence"),
    ],
  },
  {
    id: "current-release-consistency",
    label: "Current release consistency",
    description: "Regenerate release evidence from clean source provenance, current deployment identity, and the final enterprise gate.",
    actionIds: [
      "redeploy-vercel-production",
      "inspect-vercel-production-deployment",
      "run-neon-restore-rehearsal",
      "run-real-oidc-callback-smoke",
      "rerun-final-gate",
    ],
    isRequired: (missing) => missing.currentCodeDeploy,
    getReasons: (missing) => missing.currentCodeDeployReasons,
  },
];

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
  const enterpriseGapEvidenceReportPath = input.enterpriseGapEvidenceReportPath
    ?? defaultEnterpriseGapEvidenceReportPath;
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
  const deploymentGitCommit = readSafeGitCommitSha(
    input.deploymentGitCommit ?? process.env.AAIS_DEPLOYMENT_GIT_COMMIT_SHA,
  );
  const releaseCheck = await readJsonIfExists(releaseCheckReportPath);
  const vercelEnv = await readJsonIfExists(vercelEnvReportPath);
  const provision = await readJsonIfExists(provisionReportPath);
  const enterprise = await readJsonIfExists(enterpriseReportPath);
  const enterpriseGapEvidence = await readJsonIfExists(enterpriseGapEvidenceReportPath);
  const gapEvidencePreflight = summarizeGapEvidencePreflight(enterpriseGapEvidence.value);
  const missingEnv = getMissingEnvNames(releaseCheck.value, vercelEnv.value);
  const authMode = readAuthMode(
    vercelEnv.value?.target?.authMode ?? releaseCheck.value?.artifacts?.vercelEnv?.target?.authMode,
    missingEnv,
  );
  const ssoOnlyGate = authMode === "sso-only";
  const currentCodeDeployReasons = getCurrentCodeDeployReasons(releaseCheck.value);
  const missing = {
    vercelProductionEnv: missingEnv,
    storage: missingEnv.filter((name) => canonicalStorageMissingNames.includes(name)),
    authMode,
    ssoOnlyGate,
    oidc: ssoOnlyGate ? missingEnv.filter((name) => oidcNames.includes(name)) : [],
    oidcRoleMapping: ssoOnlyGate ? missingEnv.filter((name) => name === oidcRoleMappingRequestName) : [],
    postgresRestoreReport: releaseCheck.value?.artifacts?.postgresRestore?.status !== "passed",
    ssoOnlyRuntimeMode: ssoOnlyGate
      && releaseCheck.value?.artifacts?.enterprise?.requiredChecks?.ssoOnlyMode !== true,
    realOidcCallbackSmoke: ssoOnlyGate
      && releaseCheck.value?.artifacts?.enterprise?.requiredChecks?.oidcCallback !== true,
    teacherCohortAnalyticsSmoke: releaseCheck.value?.artifacts?.enterprise?.requiredChecks?.cohortAnalytics !== true,
    liveAiEval: !isLiveAiEvalComplete(releaseCheck.value?.artifacts?.aiEval),
    currentCodeDeploy: currentCodeDeployReasons.length > 0,
    currentCodeDeployReasons,
  };
  const storage = summarizeStorageState({
    vercelEnv: vercelEnv.value,
    releaseCheck: releaseCheck.value,
    missing,
  });
  const oidc = summarizeOidcState({ missing, baseUrl });
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
    enterpriseGapEvidenceReportPath,
    gapEvidencePreflight,
    privateEnvTemplatePath,
    privateEnvTemplateReportPath,
    privateEnvFilePath,
    postgresRestoreTemplatePath,
    postgresRestoreTemplateReportPath,
    privateRestoreEnvFilePath,
    deploymentGitCommit,
  });
  const businessGapActions = getBusinessGapActions({ missing, externalActions });
  const businessGapsPassed = businessGapActions.filter((gap) => gap.status === "passed").length;

  const report = {
    schemaVersion: 1,
    status: releaseCheck.value?.status === "passed" ? "ready" : "action-required",
    generatedAt,
    sourceReports: {
      releaseCheck: releaseCheckReportPath,
      vercelEnv: vercelEnvReportPath,
      provision: provisionReportPath,
      enterprise: enterpriseReportPath,
      enterpriseGapEvidence: enterpriseGapEvidenceReportPath,
    },
    currentGate: {
      status: normalizeStatus(releaseCheck.value?.status),
      checkedAt: readIsoTimestamp(releaseCheck.value?.checkedAt),
      sequence: sanitizeSequence(releaseCheck.value?.sequence),
    },
    missing,
    storage,
    oidc,
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
    gapEvidencePreflight,
    businessGapSummary: {
      total: businessGapActions.length,
      passed: businessGapsPassed,
      actionRequired: businessGapActions.length - businessGapsPassed,
    },
    businessGapActions,
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

function summarizeOidcState({ missing, baseUrl }) {
  const missingRequiredNames = oidcNames.filter((name) => missing.oidc.includes(name));
  const localValidationRequiredNames = oidcNames;
  const localValidationOnlyNames = oidcNames.filter((name) => !missingRequiredNames.includes(name));
  const missingRoleMappingNames = missing.oidcRoleMapping.length > 0
    ? [oidcRoleMappingRequestName]
    : [];
  const callbackUrl = `${baseUrl}/api/auth/oidc/callback`;
  const configured = missingRequiredNames.length === 0 && missingRoleMappingNames.length === 0;
  const smokeReady = configured && !missing.realOidcCallbackSmoke && !missing.teacherCohortAnalyticsSmoke;
  const ssoOnlyReady = smokeReady && !missing.ssoOnlyRuntimeMode;

  return {
    status: ssoOnlyReady ? "satisfied" : "action-required",
    callbackUrl,
    requiredNames: oidcNames,
    missingRequiredNames,
    localValidationRequiredNames,
    localValidationOnlyNames,
    acceptedRoleMappingNames: oidcRoleMappingNames,
    missingRoleMappingNames,
    optionalExplicitEndpointNames: oidcExplicitEndpointNames,
    explicitEndpointsRule: "all-or-none",
    requiredProofOrder: [
      "verify-oidc-config-dry-run",
      "set-vercel-production-env",
      "redeploy-vercel-production",
      "inspect-vercel-production-deployment",
      "run-real-oidc-callback-smoke",
      "run-teacher-cohort-analytics-smoke",
      "set-sso-only-runtime-mode",
      "redeploy-vercel-production-after-sso-only",
      "inspect-vercel-production-deployment-after-sso-only",
      "rerun-final-gate",
    ],
    transientEvidence: [
      "AAIS_VERIFY_OIDC_CALLBACK_URL",
      "AAIS_VERIFY_OIDC_STATE_COOKIE",
      "AAIS_VERIFY_EXPECTED_SESSION_ROLE",
    ],
    notes: [
      "Register the callback URL with the institution IdP before running verify:oidc-config.",
      "Fill validation-only OIDC names in the private env file even when Vercel already has them; provision:vercel-env still applies only the missing Vercel names.",
      "Use one teacher/admin role-mapping source; group mappings are preferred when the IdP can provide groups or roles.",
      "Run real OIDC callback smoke before disabling trial login.",
    ],
    redaction: {
      values: "not-read",
      transientEvidence: "not-stored",
    },
  };
}

function summarizeStorageState({ vercelEnv, releaseCheck, missing }) {
  const storageUrl = vercelEnv?.storageUrl ?? {};
  const readiness = releaseCheck?.artifacts?.enterprise?.readiness ?? {};
  const sourceEnv = readSafeStorageSource(storageUrl.sourceEnv);
  const provider = readSafeToken(readiness.storageProvider);
  const connected = readOptionalBoolean(readiness.storagePostgresConnected);
  const satisfied = missing.storage.length === 0
    && (storageUrl.present === true || connected === true);

  return {
    status: satisfied ? "satisfied" : "action-required",
    provider,
    connected,
    sourceEnv,
    acceptedSources: getSafeEnvNames(storageUrl.acceptedNames),
    action: satisfied ? "none" : "set-vercel-production-env",
    note: satisfied
      ? "Vercel-connected Neon storage is already accepted; do not add AAIS_DATABASE_URL unless replacing the current source intentionally."
      : "Set one accepted Neon/Postgres source before production learner-session writes.",
    redaction: {
      values: "not-read",
    },
  };
}

function summarizeGapEvidencePreflight(report) {
  const preflight = report?.preflight ?? {};
  const required = preflight.required ?? {};
  const missing = getSafeEnvNames(required.missing);
  const placeholders = getSafeEnvNames(required.placeholders);
  const invalid = getSafeEnvNames(required.invalid);
  const hasEvidence = Boolean(report && typeof report === "object");

  return {
    status: hasEvidence ? normalizeStatus(preflight.status ?? report.status) : "missing",
    reportStatus: hasEvidence ? normalizeStatus(report.status) : "missing",
    mode: hasEvidence ? readSafeToken(report.mode) : "unknown",
    missing,
    placeholders,
    invalid,
    oidcTransientEvidence: sanitizePresenceMap(preflight.oidcTransientEvidence, [
      "callbackUrlPresent",
      "stateCookiePresent",
    ]),
    restoreEvidence: sanitizePresenceMap(preflight.restoreEvidence, [
      "databaseUrlPresent",
      "databaseUrlPlaceholder",
    ]),
    liveAiEvalEvidence: sanitizePresenceMap(preflight.liveAiEvalEvidence, [
      "endpointPresent",
      "endpointHttps",
      "apiKeyPresent",
      "modelPresent",
      "evalVersionPresent",
    ]),
    redaction: {
      values: "not-read",
      secrets: "omitted",
    },
  };
}

function sanitizePresenceMap(value, keys) {
  if (!value || typeof value !== "object") {
    return null;
  }
  return Object.fromEntries(keys.map((key) => [key, value[key] === true]));
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
    "POSTGRES_URL_NO_SSL",
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

function getGapInputIssues(preflight, names) {
  const allowed = new Set(names);
  const issues = [
    ...(preflight?.missing ?? []),
    ...(preflight?.placeholders ?? []),
    ...(preflight?.invalid ?? []),
  ];
  return [...new Set(issues.filter((name) => allowed.has(name)))];
}

function getExternalActions(input) {
  const actions = [];
  const oidcCallbackGapInputIssues = getGapInputIssues(input.gapEvidencePreflight, oidcCallbackGapInputNames);
  const oidcCohortGapInputIssues = getGapInputIssues(input.gapEvidencePreflight, oidcCohortGapInputNames);
  const trialAuthGapInputIssues = getGapInputIssues(input.gapEvidencePreflight, trialAuthGapInputNames);
  const restoreGapInputIssues = getGapInputIssues(input.gapEvidencePreflight, restoreGapInputNames);
  const aiEvalGapInputIssues = getGapInputIssues(input.gapEvidencePreflight, aiEvalGapInputNames);
  if (input.missing.vercelProductionEnv.length > 0) {
    const deploymentGitCommitArg = getDeploymentGitCommitArg(input);
    actions.push({
      id: "fill-private-env-template",
      status: "required",
      templatePath: input.privateEnvTemplatePath,
      reportPath: input.privateEnvTemplateReportPath,
      privateEnvFilePath: input.privateEnvFilePath,
      ...(input.missing.ssoOnlyGate
        ? {
            oidcOnboardingCommand: [
              "npm run prepare:oidc-sso --",
              `--env-file ${input.privateEnvFilePath}`,
              `--base-url ${input.baseUrl}`,
              "--output output/aais-oidc-onboarding-report-latest.json",
              "--markdown-output output/aais-oidc-onboarding-report-latest.md",
              `--release-id ${input.releaseId}`,
            ].join(" "),
            note: "Use prepare:oidc-sso before applying Vercel env so the IdP registration contract, callback URL, role-mapping choices, and redacted local OIDC validation are captured.",
          }
        : {
            note: "Fill the current-stage trial auth, Vercel Neon, release identity, LRS, and DeepSeek values requested by the Vercel env report.",
          }),
      commands: [
        [
          "npm run provision:vercel-env --",
          `--env-file ${input.privateEnvFilePath}`,
          `--report ${input.vercelEnvReportPath}`,
          `--release-id ${input.releaseId}`,
          `--deployment-git-commit ${deploymentGitCommitArg}`,
          "--output output/aais-vercel-env-provision-dry-run-latest.json",
        ].join(" "),
        [
          "npm run provision:vercel-env --",
          `--env-file ${input.privateEnvFilePath}`,
          `--report ${input.vercelEnvReportPath}`,
          `--release-id ${input.releaseId}`,
          `--deployment-git-commit ${deploymentGitCommitArg}`,
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
        "POSTGRES_URL_NO_SSL",
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
  if (input.missing.liveAiEval) {
    actions.push({
      id: "run-live-ai-eval",
      status: "required",
      ...(aiEvalGapInputIssues.length > 0
        ? {
            preflightStatus: input.gapEvidencePreflight.status,
            missingInputs: aiEvalGapInputIssues,
          }
        : {}),
      command: [
        "npm run ai:evaluate --",
        `--env-file ${input.privateEnvFilePath}`,
        `--output ${input.aiEvalManifestPath}`,
        "--env-json-output output/aais-ai-eval-inline-latest.json",
        "--eval-version <AAIS_AI_EVAL_VERSION>",
        `--release-id ${input.releaseId}`,
      ].join(" "),
      gapEvidenceCommand: [
        "npm run verify:enterprise-gaps --",
        "--mode live-ai-eval",
        `--ai-eval-env-file ${input.privateEnvFilePath}`,
        `--ai-eval-output ${input.aiEvalManifestPath}`,
        "--ai-eval-inline-output output/aais-ai-eval-inline-latest.json",
        "--output output/aais-enterprise-gap-evidence-latest.json",
        `--release-id ${input.releaseId}`,
      ].join(" "),
      gapPreflightCommand: [
        "npm run verify:enterprise-gaps --",
        "--mode live-ai-eval",
        "--preflight-only",
        `--ai-eval-env-file ${input.privateEnvFilePath}`,
        `--ai-eval-output ${input.aiEvalManifestPath}`,
        "--ai-eval-inline-output output/aais-ai-eval-inline-latest.json",
        "--output output/aais-enterprise-gap-evidence-latest.json",
        `--release-id ${input.releaseId}`,
      ].join(" "),
      note: "The manifest must use the aais-a1-a4-ca-eval-v2 contract and cover A1, A2, A3, A4 without storing raw prompts, model replies, or provider secrets.",
    });
  }
  if (input.missing.postgresRestoreReport) {
    actions.push({
      id: "fill-postgres-restore-template",
      status: "required",
      ...(restoreGapInputIssues.length > 0
        ? {
            preflightStatus: input.gapEvidencePreflight.status,
            missingInputs: restoreGapInputIssues,
          }
        : {}),
      templatePath: input.postgresRestoreTemplatePath,
      reportPath: input.postgresRestoreTemplateReportPath,
      privateRestoreEnvFilePath: input.privateRestoreEnvFilePath,
      neonApiPreparationCommand: [
        "npm run prepare:neon-restore --",
        "--neon-env-file .env.neon-restore.local",
        `--output-env ${input.privateRestoreEnvFilePath}`,
        "--report output/aais-neon-restore-env-report-latest.json",
        `--release-id ${input.releaseId}`,
      ].join(" "),
      note: "If a Neon API key is available, prepare:neon-restore can create or use the restored branch and write the ignored restore env file without printing the connection URI.",
      commands: [
        [
          "npm run verify:postgres-restore --",
          `--env-file ${input.privateRestoreEnvFilePath}`,
          `--source-env-file ${input.privateEnvFilePath}`,
          "--database-provider neon",
          "--target-purpose restored-staging",
          `--output ${input.postgresRestoreReportPath}`,
          `--release-id ${input.releaseId}`,
        ].join(" "),
      ],
      gapEvidenceCommand: [
        "npm run verify:enterprise-gaps --",
        "--mode restore",
        `--restore-env-file ${input.privateRestoreEnvFilePath}`,
        `--source-env-file ${input.privateEnvFilePath}`,
        `--restore-output ${input.postgresRestoreReportPath}`,
        "--output output/aais-enterprise-gap-evidence-latest.json",
        `--release-id ${input.releaseId}`,
      ].join(" "),
      gapPreflightCommand: [
        "npm run verify:enterprise-gaps --",
        "--mode restore",
        "--preflight-only",
        `--restore-env-file ${input.privateRestoreEnvFilePath}`,
        `--source-env-file ${input.privateEnvFilePath}`,
        `--restore-output ${input.postgresRestoreReportPath}`,
        "--output output/aais-enterprise-gap-evidence-latest.json",
        `--release-id ${input.releaseId}`,
      ].join(" "),
    });
    actions.push({
      id: "run-neon-restore-rehearsal",
      status: "required",
      ...(restoreGapInputIssues.length > 0
        ? {
            preflightStatus: input.gapEvidencePreflight.status,
            missingInputs: restoreGapInputIssues,
          }
        : {}),
      note: [
        `Fill ${input.privateRestoreEnvFilePath} with the restored staging Neon URL first.`,
        `Keep ${input.privateEnvFilePath} available when possible so the verifier can prove the restore target differs from production sources.`,
        "Do not pass database URLs on the command line; the verifier reads the ignored env file transiently and emits only redacted evidence.",
      ].join(" "),
      command: [
        "npm run verify:postgres-restore --",
        `--env-file ${input.privateRestoreEnvFilePath}`,
        `--source-env-file ${input.privateEnvFilePath}`,
        "--database-provider neon",
        "--target-purpose restored-staging",
        `--output ${input.postgresRestoreReportPath}`,
        `--release-id ${input.releaseId}`,
      ].join(" "),
      gapEvidenceCommand: [
        "npm run verify:enterprise-gaps --",
        "--mode restore",
        `--restore-env-file ${input.privateRestoreEnvFilePath}`,
        `--source-env-file ${input.privateEnvFilePath}`,
        `--restore-output ${input.postgresRestoreReportPath}`,
        "--output output/aais-enterprise-gap-evidence-latest.json",
        `--release-id ${input.releaseId}`,
      ].join(" "),
      gapPreflightCommand: [
        "npm run verify:enterprise-gaps --",
        "--mode restore",
        "--preflight-only",
        `--restore-env-file ${input.privateRestoreEnvFilePath}`,
        `--source-env-file ${input.privateEnvFilePath}`,
        `--restore-output ${input.postgresRestoreReportPath}`,
        "--output output/aais-enterprise-gap-evidence-latest.json",
        `--release-id ${input.releaseId}`,
      ].join(" "),
    });
  }
  if (input.missing.ssoOnlyGate && (input.missing.oidc.length > 0 || input.missing.realOidcCallbackSmoke)) {
    actions.push({
      id: "run-real-oidc-callback-smoke",
      status: "required",
      ...(oidcCallbackGapInputIssues.length > 0
        ? {
            preflightStatus: input.gapEvidencePreflight.status,
            missingInputs: oidcCallbackGapInputIssues,
          }
        : {}),
      note: "Run before disabling trial login; this proves the real IdP callback and AAIS session handoff without requiring final SSO-only mode yet.",
      command: [
        "AAIS_VERIFY_OIDC_CALLBACK_URL=<REQUIRED:TRANSIENT_OIDC_CALLBACK_URL>",
        "AAIS_VERIFY_OIDC_STATE_COOKIE=<REQUIRED:TRANSIENT_OIDC_STATE_COOKIE>",
        "npm run verify:enterprise --",
        `--base-url ${input.baseUrl}`,
        `--release-id ${input.releaseId}`,
        `--output ${input.enterpriseReportPath}`,
      ].join(" "),
      gapEvidenceCommand: [
        "npm run verify:enterprise-gaps --",
        "--mode oidc-callback",
        "--env-file .env.enterprise-smoke.local",
        `--base-url ${input.baseUrl}`,
        `--enterprise-output ${input.enterpriseReportPath}`,
        "--output output/aais-enterprise-gap-evidence-latest.json",
        `--release-id ${input.releaseId}`,
      ].join(" "),
      gapPreflightCommand: [
        "npm run verify:enterprise-gaps --",
        "--mode oidc-callback",
        "--preflight-only",
        "--env-file .env.enterprise-smoke.local",
        `--base-url ${input.baseUrl}`,
        `--enterprise-output ${input.enterpriseReportPath}`,
        "--output output/aais-enterprise-gap-evidence-latest.json",
        `--release-id ${input.releaseId}`,
      ].join(" "),
    });
  }
  if (input.missing.teacherCohortAnalyticsSmoke) {
    if (input.missing.ssoOnlyGate) {
      actions.push({
        id: "run-teacher-cohort-analytics-smoke",
        status: "required",
        ...(oidcCohortGapInputIssues.length > 0
          ? {
              preflightStatus: input.gapEvidencePreflight.status,
              missingInputs: oidcCohortGapInputIssues,
            }
          : {}),
        note: "Uses the teacher/admin OIDC callback session to prove filtered cohort analytics and matching cohort export JSON without raw learner text.",
        command: [
          "AAIS_VERIFY_OIDC_CALLBACK_URL=<REQUIRED:TRANSIENT_TEACHER_OR_ADMIN_OIDC_CALLBACK_URL>",
          "AAIS_VERIFY_OIDC_STATE_COOKIE=<REQUIRED:TRANSIENT_TEACHER_OR_ADMIN_OIDC_STATE_COOKIE>",
          "AAIS_VERIFY_EXPECTED_SESSION_ROLE=teacher",
          "AAIS_VERIFY_REQUIRE_COHORT_ANALYTICS=true",
          "npm run verify:enterprise --",
          `--base-url ${input.baseUrl}`,
          "--require-sso-only",
          `--release-id ${input.releaseId}`,
          `--output ${input.enterpriseReportPath}`,
        ].join(" "),
        gapEvidenceCommand: [
          "npm run verify:enterprise-gaps --",
          "--mode cohort-sso",
          "--env-file .env.enterprise-smoke.local",
          `--base-url ${input.baseUrl}`,
          `--enterprise-output ${input.enterpriseReportPath}`,
          "--output output/aais-enterprise-gap-evidence-latest.json",
          `--release-id ${input.releaseId}`,
        ].join(" "),
        gapPreflightCommand: [
          "npm run verify:enterprise-gaps --",
          "--mode cohort-sso",
          "--preflight-only",
          "--env-file .env.enterprise-smoke.local",
          `--base-url ${input.baseUrl}`,
          `--enterprise-output ${input.enterpriseReportPath}`,
          "--output output/aais-enterprise-gap-evidence-latest.json",
          `--release-id ${input.releaseId}`,
        ].join(" "),
      });
    } else {
      actions.push({
        id: "run-trial-auth-enterprise-smoke",
        status: "required",
        ...(trialAuthGapInputIssues.length > 0
          ? {
              preflightStatus: input.gapEvidencePreflight.status,
              missingInputs: trialAuthGapInputIssues,
            }
          : {}),
        note: "Uses trial learner and educator accounts to prove learning session, login throttle, cohort analytics, and cohort export without raw learner text.",
        command: [
          "npm run verify:enterprise --",
          `--base-url ${input.baseUrl}`,
          "--require-cohort-analytics",
          `--release-id ${input.releaseId}`,
          `--output ${input.enterpriseReportPath}`,
        ].join(" "),
        gapEvidenceCommand: [
          "npm run verify:enterprise-gaps --",
          "--mode trial-auth",
          "--env-file .env.enterprise-smoke.local",
          `--base-url ${input.baseUrl}`,
          `--enterprise-output ${input.enterpriseReportPath}`,
          "--output output/aais-enterprise-gap-evidence-latest.json",
          `--release-id ${input.releaseId}`,
        ].join(" "),
        gapPreflightCommand: [
          "npm run verify:enterprise-gaps --",
          "--mode trial-auth",
          "--preflight-only",
          "--env-file .env.enterprise-smoke.local",
          `--base-url ${input.baseUrl}`,
          `--enterprise-output ${input.enterpriseReportPath}`,
          "--output output/aais-enterprise-gap-evidence-latest.json",
          `--release-id ${input.releaseId}`,
        ].join(" "),
      });
    }
  }
  if (input.missing.ssoOnlyGate && input.missing.ssoOnlyRuntimeMode) {
    actions.push({
      id: "set-sso-only-runtime-mode",
      status: "required-after-sso-verification",
      commands: [
        "vercel env rm AAIS_TRIAL_LOGIN_ENABLED production -y",
        "printf '%s' 'false' | vercel env add AAIS_TRIAL_LOGIN_ENABLED production",
      ],
      requiredValue: "false",
      note: "Set the value to false only after OIDC login is verified, then redeploy production. Remove the existing value first if Vercel already has one.",
    });
    actions.push({
      id: "redeploy-vercel-production-after-sso-only",
      status: "required-after-sso-only-change",
      command: productionDeployCommand,
    });
    actions.push(createProductionDeployInspectAction("inspect-vercel-production-deployment-after-sso-only", input));
  }
  const finalGateOidcCallbackEnv = input.missing.ssoOnlyGate && input.missing.teacherCohortAnalyticsSmoke
    ? [
        "AAIS_VERIFY_OIDC_CALLBACK_URL=<REQUIRED:TRANSIENT_TEACHER_OR_ADMIN_OIDC_CALLBACK_URL>",
        "AAIS_VERIFY_OIDC_STATE_COOKIE=<REQUIRED:TRANSIENT_TEACHER_OR_ADMIN_OIDC_STATE_COOKIE>",
        "AAIS_VERIFY_EXPECTED_SESSION_ROLE=teacher",
      ]
    : input.missing.ssoOnlyGate && input.missing.realOidcCallbackSmoke
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
      input.missing.ssoOnlyGate ? "--auth-mode sso-only" : "--auth-mode trial",
      input.missing.ssoOnlyGate ? "--require-sso-only" : "--allow-trial-mode",
      `--release-id ${input.releaseId}`,
      `--deployment-git-commit ${getDeploymentGitCommitArg(input)}`,
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

function getBusinessGapActions({ missing, externalActions }) {
  const availableActionIds = new Set(
    externalActions.map((action) => action.id).filter((id) => /^[a-z][a-z0-9-]{1,63}$/.test(id)),
  );
  return businessGapActionDefinitions.filter((definition) => (
    typeof definition.appliesTo === "function" ? definition.appliesTo(missing) : true
  )).map((definition) => {
    const required = definition.isRequired(missing);
    const actions = definition.actionIds.filter((actionId) => availableActionIds.has(actionId));
    const missingNames = getSafeEnvNames(definition.getMissingNames?.(missing) ?? []);
    const reasons = getSafeReasonNames(definition.getReasons?.(missing) ?? []);
    const row = {
      id: definition.id,
      label: definition.label,
      status: required ? "action-required" : "passed",
      description: definition.description,
    };
    if (required) {
      if (missingNames.length > 0) {
        row.missing = missingNames;
      }
      if (reasons.length > 0) {
        row.reasons = reasons;
      }
      if (actions.length > 0) {
        row.actions = actions;
      }
    }
    return row;
  });
}

function getCurrentCodeDeployReasons(releaseCheck) {
  const reasons = [];
  if (releaseCheck?.artifacts?.sourceProvenance?.clean === false) {
    reasons.push("source-provenance-clean");
  }
  const enterprise = releaseCheck?.artifacts?.enterprise ?? {};
  if (enterprise?.readiness?.releaseIdMatchesExpected !== true) {
    reasons.push("release-identity");
  }
  if (enterprise?.requiredChecks?.agentEvidence === false
    && enterprise?.requiredChecks?.a3Supervision !== true) {
    reasons.push("agent-evidence");
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

function isLiveAiEvalComplete(aiEval) {
  return aiEval?.status === "passed"
    && aiEval?.compatibleWithEnterpriseReadiness === true
    && aiEval?.blockedCount === 0
    && aiEval?.agentEvidenceComplete === true
    && aiEval?.agentEvidenceContractVersion === "aais-a1-a4-ca-eval-v2"
    && aiEval?.modelFingerprintMatchesEnterprise === true;
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
      `--deployment-git-commit ${getDeploymentGitCommitArg(input)}`,
      `--output ${input.vercelDeploymentReportPath}`,
    ].join(" "),
    note: "Use the deployment URL returned by vercel deploy --prod -y --no-wait; pass the same git SHA recorded in source provenance and AAIS_DEPLOYMENT_GIT_COMMIT_SHA. The verifier runs Vercel inspect and fails until the deployment is READY.",
  };
}

function getDeploymentGitCommitArg(input) {
  return input.deploymentGitCommit ?? "<git-sha>";
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
    "## Storage / Neon",
    "",
    `- status: ${report.storage.status}`,
    `- source env: ${report.storage.sourceEnv ?? "unknown"}`,
    `- provider: ${report.storage.provider ?? "unknown"}`,
    `- connected: ${report.storage.connected === null ? "unknown" : report.storage.connected}`,
    `- action: ${report.storage.action}`,
    `- note: ${report.storage.note}`,
    "",
    "## OIDC / SSO",
    "",
    `- status: ${report.oidc.status}`,
    `- callback URL to register: ${report.oidc.callbackUrl}`,
    `- missing Vercel OIDC names: ${report.oidc.missingRequiredNames.join(", ") || "none"}`,
    `- local verify:oidc-config required names: ${report.oidc.localValidationRequiredNames.join(", ")}`,
    `- local validation-only names: ${report.oidc.localValidationOnlyNames.join(", ") || "none"}`,
    `- accepted role mapping names: ${report.oidc.acceptedRoleMappingNames.join(", ")}`,
    `- missing role mapping names: ${report.oidc.missingRoleMappingNames.join(", ") || "none"}`,
    `- optional explicit endpoints: ${report.oidc.optionalExplicitEndpointNames.join(", ")}`,
    `- explicit endpoint rule: ${report.oidc.explicitEndpointsRule}`,
    ...report.oidc.notes.map((note) => `- note: ${note}`),
    "",
    "## Enterprise Gap Preflight",
    "",
    `- status: ${report.gapEvidencePreflight.status}`,
    `- report status: ${report.gapEvidencePreflight.reportStatus}`,
    `- mode: ${report.gapEvidencePreflight.mode}`,
    `- missing inputs: ${report.gapEvidencePreflight.missing.join(", ") || "none"}`,
    `- placeholder inputs: ${report.gapEvidencePreflight.placeholders.join(", ") || "none"}`,
    `- invalid inputs: ${report.gapEvidencePreflight.invalid.join(", ") || "none"}`,
    "",
    "## Business Gap Action Plan",
    "",
    `Summary: ${report.businessGapSummary.passed}/${report.businessGapSummary.total} passed`,
    "",
    ...report.businessGapActions.flatMap((gap) => [
      `- ${gap.id}: ${gap.status} (${gap.label})`,
      `  - description: ${gap.description}`,
      ...(gap.missing ? [`  - missing: ${gap.missing.join(", ")}`] : []),
      ...(gap.reasons ? [`  - reasons: ${gap.reasons.join(", ")}`] : []),
      ...(gap.actions ? [`  - actions: ${gap.actions.join(", ")}`] : []),
    ]),
    "",
    "## Required Actions",
    "",
    ...report.externalActions.flatMap((action) => [
      `- ${action.id}: ${action.status}`,
      ...(action.preflightStatus ? [`  - preflight status: ${action.preflightStatus}`] : []),
      ...(action.missingInputs ? [`  - missing inputs: ${action.missingInputs.join(", ")}`] : []),
      ...(action.templatePath ? [`  - template: ${action.templatePath}`] : []),
      ...(action.privateEnvFilePath ? [`  - private env: ${action.privateEnvFilePath}`] : []),
      ...(action.privateRestoreEnvFilePath ? [`  - private restore env: ${action.privateRestoreEnvFilePath}`] : []),
      ...(action.requiredValue ? [`  - required value: ${action.requiredValue}`] : []),
      ...(action.note ? [`  - note: ${action.note}`] : []),
      ...(action.oidcOnboardingCommand ? [`  - ${action.oidcOnboardingCommand}`] : []),
      ...(action.neonApiPreparationCommand ? [`  - ${action.neonApiPreparationCommand}`] : []),
      ...(action.gapPreflightCommand ? [`  - ${action.gapPreflightCommand}`] : []),
      ...(action.gapEvidenceCommand ? [`  - ${action.gapEvidenceCommand}`] : []),
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

function getSafeReasonNames(value) {
  return Array.isArray(value)
    ? value
      .map((item) => String(item ?? "").trim())
      .filter((item) => /^[a-z][a-z0-9-]{1,63}$/.test(item))
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

function readAuthMode(value, missingEnv = []) {
  const normalized = String(value ?? "").trim().toLowerCase();
  if (normalized === "sso-only" || normalized === "trial") {
    return normalized;
  }
  return missingEnv.some((name) => oidcNames.includes(name) || name === oidcRoleMappingRequestName)
    ? "sso-only"
    : "trial";
}

function readSafeGitCommitSha(value) {
  const trimmed = String(value ?? "").trim().toLowerCase();
  return /^[a-f0-9]{7,40}$/.test(trimmed) ? trimmed : null;
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

function readOptionalBoolean(value) {
  return typeof value === "boolean" ? value : null;
}

function readSafeStorageSource(value) {
  const source = String(value ?? "").trim();
  return /^[A-Z][A-Z0-9_/*-]{1,127}$/.test(source) ? source : null;
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
    enterpriseGapEvidenceReportPath: args.get("gap-evidence-report"),
    outputPath: args.get("output"),
    markdownOutputPath: args.get("markdown-output"),
    baseUrl: args.get("base-url"),
    releaseId: args.get("release-id"),
    deploymentGitCommit: args.get("deployment-git-commit"),
  });
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : "AAIS enterprise handoff generation failed."}\n`);
    process.exitCode = 1;
  });
}
