#!/usr/bin/env node

import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

const productionBranch = "main";
const productCronSchedules = new Map([
  ["/api/learning/lrs/outbox/flush", "*/2 * * * *"],
  ["/api/auth/email-outbox/flush", "*/2 * * * *"],
]);
const forbiddenProductionDatabaseBindings = [
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
  "PGPORT",
  "PGSSLMODE",
  "POSTGRES_HOST",
  "POSTGRES_HOST_NON_POOLING",
  "POSTGRES_USER",
  "POSTGRES_DATABASE",
  "POSTGRES_PASSWORD",
  "POSTGRES_PORT",
  "POSTGRES_SSLMODE",
];
const aliyunOnlyWorkerTokenBindings = [
  "AAIS_LRS_OUTBOX_FLUSH_TOKEN",
  "AAIS_AUTH_EMAIL_OUTBOX_FLUSH_TOKEN",
];

export function hasAllAaisProductCronSchedules(vercelConfig) {
  return getAaisProductCronScheduleState(vercelConfig) === "configured";
}

export function getAaisProductCronScheduleState(vercelConfig) {
  const crons = Array.isArray(vercelConfig?.crons) ? vercelConfig.crons : [];
  if (crons.length === 0) {
    return "removed";
  }
  if (crons.length !== productCronSchedules.size) {
    return "partial";
  }
  const exactPaths = new Set();
  for (const cron of crons) {
    const route = normalizeCronRoute(cron.path);
    if (
      cron.path !== route
      || productCronSchedules.get(route) !== cron.schedule
      || exactPaths.has(route)
    ) {
      return "partial";
    }
    exactPaths.add(route);
  }

  return exactPaths.size === productCronSchedules.size ? "configured" : "partial";
}

function normalizeCronRoute(value) {
  if (typeof value !== "string") {
    return null;
  }
  const withoutQuery = value.split(/[?#]/, 1)[0];
  return withoutQuery.length > 1 ? withoutQuery.replace(/\/+$/, "") : withoutQuery;
}

function readRepositoryVercelConfig() {
  return JSON.parse(
    readFileSync("vercel.json", "utf8"),
  );
}

export function evaluateAaisVercelProductionDeploy(input = {}) {
  const env = input.env ?? process.env;
  const vercelEnv = normalizeEnvValue(env.VERCEL_ENV);
  const runningOnVercel = env.VERCEL === "1" || Boolean(vercelEnv);
  const gitRef = normalizeEnvValue(env.VERCEL_GIT_COMMIT_REF);
  const gitSha = normalizeEnvValue(env.VERCEL_GIT_COMMIT_SHA);
  const gitProvider = normalizeEnvValue(env.VERCEL_GIT_PROVIDER);
  const gitShaValid = Boolean(gitSha && /^[a-f0-9]{40}$/i.test(gitSha));
  const gitProviderValid = gitProvider === "github";
  const deploymentProvider = normalizeEnvValue(
    env.AAIS_DEPLOYMENT_PROVIDER,
  )?.toLowerCase() ?? null;
  const runtimeLeaseSchemaConfirmed = normalizeEnvValue(
    env.AAIS_RUNTIME_LEASE_SCHEMA_CONFIRMED,
  ) === "true";
  const canonicalDatabaseBindingConfigured = Boolean(
    normalizeEnvValue(env.AAIS_DATABASE_URL),
  );
  const canonicalDatabaseBindingValid = isValidProductionNeonBinding(env);
  const databasePoolMaxValid = normalizeEnvValue(env.AAIS_DATABASE_POOL_MAX) === "2";
  const databaseTargetId = normalizeEnvValue(env.AAIS_DATABASE_TARGET_ID);
  const databaseTargetIdValid = Boolean(
    databaseTargetId
    && /^[A-Za-z0-9][A-Za-z0-9._:-]{2,127}$/.test(databaseTargetId),
  );
  const researchDisabled = normalizeEnvValue(env.AAIS_RESEARCH_MODE) === "false"
    && normalizeEnvValue(env.AAIS_RESEARCH_REQUIRED) === "false";
  const providerOwnedReleaseMetadata = !normalizeEnvValue(env.AAIS_RELEASE_ID)
    && !normalizeEnvValue(env.AAIS_DEPLOYMENT_GIT_COMMIT_SHA);
  const serverActionsEncryptionKeyValid = isCanonicalAes256Key(
    env.NEXT_SERVER_ACTIONS_ENCRYPTION_KEY,
  );
  const cronSecretValid = isStrongOpaqueSecret(env.CRON_SECRET);
  const forbiddenWorkerTokenBindings = aliyunOnlyWorkerTokenBindings
    .filter((name) => Boolean(normalizeEnvValue(env[name])));
  const forbiddenDatabaseBindings = forbiddenProductionDatabaseBindings
    .filter((name) => Boolean(normalizeEnvValue(env[name])));
  const productCronScheduleState = input.productCronScheduleState
    ?? getAaisProductCronScheduleState(
      input.vercelConfig ?? readRepositoryVercelConfig(),
    );

  if (!runningOnVercel) {
    return {
      status: "skipped",
      reason: "AAIS_NOT_RUNNING_ON_VERCEL",
      checks: {
        vercelEnv,
        productionBranch,
        gitRef,
        gitShaValid,
        gitProviderValid,
        deploymentProvider,
        runtimeLeaseSchemaConfirmed,
        canonicalDatabaseBindingConfigured,
        canonicalDatabaseBindingValid,
        databasePoolMaxValid,
        databaseTargetIdValid,
        researchDisabled,
        providerOwnedReleaseMetadata,
        serverActionsEncryptionKeyValid,
        cronSecretValid,
        forbiddenWorkerTokenBindings,
        forbiddenDatabaseBindings,
        productCronScheduleState,
      },
    };
  }

  if (vercelEnv !== "production") {
    return {
      status: "passed",
      reason: "AAIS_NON_PRODUCTION_VERCEL_BUILD",
      checks: {
        vercelEnv,
        productionBranch,
        gitRef,
        gitShaValid,
        gitProviderValid,
        deploymentProvider,
        runtimeLeaseSchemaConfirmed,
        canonicalDatabaseBindingConfigured,
        canonicalDatabaseBindingValid,
        databasePoolMaxValid,
        databaseTargetIdValid,
        researchDisabled,
        providerOwnedReleaseMetadata,
        serverActionsEncryptionKeyValid,
        cronSecretValid,
        forbiddenWorkerTokenBindings,
        forbiddenDatabaseBindings,
        productCronScheduleState,
      },
    };
  }

  const issues = [];
  if (gitRef !== productionBranch) {
    issues.push("AAIS_PRODUCTION_DEPLOY_REQUIRES_MAIN_GIT_REF");
  }
  if (!gitShaValid) {
    issues.push("AAIS_PRODUCTION_DEPLOY_REQUIRES_GIT_COMMIT_SHA");
  }
  if (!gitProviderValid) {
    issues.push("AAIS_PRODUCTION_DEPLOY_REQUIRES_GIT_PROVIDER");
  }
  if (deploymentProvider !== "vercel") {
    issues.push("AAIS_PRODUCTION_DEPLOY_REQUIRES_VERCEL_PROVIDER");
  }
  if (!runtimeLeaseSchemaConfirmed) {
    issues.push("AAIS_PRODUCTION_DEPLOY_REQUIRES_RUNTIME_LEASE_SCHEMA");
  }
  if (!canonicalDatabaseBindingValid || forbiddenDatabaseBindings.length > 0) {
    issues.push("AAIS_PRODUCTION_DEPLOY_REQUIRES_ONLY_AAIS_DATABASE_URL");
  }
  if (!databasePoolMaxValid) {
    issues.push("AAIS_PRODUCTION_DEPLOY_REQUIRES_DATABASE_POOL_MAX_2");
  }
  if (!databaseTargetIdValid) {
    issues.push("AAIS_PRODUCTION_DEPLOY_REQUIRES_DATABASE_TARGET_ID");
  }
  if (!researchDisabled) {
    issues.push("AAIS_PRODUCTION_DEPLOY_REQUIRES_RESEARCH_DISABLED");
  }
  if (!providerOwnedReleaseMetadata) {
    issues.push("AAIS_PRODUCTION_DEPLOY_REQUIRES_PROVIDER_OWNED_RELEASE_METADATA");
  }
  if (!serverActionsEncryptionKeyValid) {
    issues.push("AAIS_PRODUCTION_DEPLOY_REQUIRES_SERVER_ACTIONS_KEY");
  }
  if (!cronSecretValid) {
    issues.push("AAIS_PRODUCTION_DEPLOY_REQUIRES_STRONG_CRON_SECRET");
  }
  if (forbiddenWorkerTokenBindings.length > 0) {
    issues.push("AAIS_PRODUCTION_DEPLOY_FORBIDS_ALIYUN_WORKER_TOKENS");
  }
  if (productCronScheduleState !== "configured") {
    issues.push("AAIS_PRODUCTION_DEPLOY_REQUIRES_EXACT_VERCEL_PRODUCT_CRONS");
  }

  return {
    status: issues.length > 0 ? "failed" : "passed",
    reason: issues.length > 0
      ? issues.some((issue) => [
        "AAIS_PRODUCTION_DEPLOY_REQUIRES_MAIN_GIT_REF",
        "AAIS_PRODUCTION_DEPLOY_REQUIRES_GIT_COMMIT_SHA",
        "AAIS_PRODUCTION_DEPLOY_REQUIRES_GIT_PROVIDER",
      ].includes(issue))
        ? "AAIS_PRODUCTION_DEPLOY_NOT_GIT_MAIN"
        : issues.includes("AAIS_PRODUCTION_DEPLOY_REQUIRES_VERCEL_PROVIDER")
          ? "AAIS_PRODUCTION_DEPLOY_PROVIDER_INVALID"
          : issues.includes("AAIS_PRODUCTION_DEPLOY_REQUIRES_RUNTIME_LEASE_SCHEMA")
          ? "AAIS_PRODUCTION_DEPLOY_RUNTIME_LEASE_SCHEMA_NOT_CONFIRMED"
          : issues.includes("AAIS_PRODUCTION_DEPLOY_REQUIRES_ONLY_AAIS_DATABASE_URL")
            ? "AAIS_PRODUCTION_DEPLOY_DATABASE_BINDING_INVALID"
            : issues.some((issue) => [
              "AAIS_PRODUCTION_DEPLOY_REQUIRES_DATABASE_POOL_MAX_2",
              "AAIS_PRODUCTION_DEPLOY_REQUIRES_DATABASE_TARGET_ID",
            ].includes(issue))
              ? "AAIS_PRODUCTION_DEPLOY_DATABASE_CONTRACT_INVALID"
              : issues.includes("AAIS_PRODUCTION_DEPLOY_REQUIRES_RESEARCH_DISABLED")
                ? "AAIS_PRODUCTION_DEPLOY_RESEARCH_BOUNDARY_INVALID"
                : issues.includes("AAIS_PRODUCTION_DEPLOY_REQUIRES_PROVIDER_OWNED_RELEASE_METADATA")
                  ? "AAIS_PRODUCTION_DEPLOY_RELEASE_METADATA_INVALID"
                  : issues.includes("AAIS_PRODUCTION_DEPLOY_REQUIRES_SERVER_ACTIONS_KEY")
                    ? "AAIS_PRODUCTION_DEPLOY_SERVER_ACTIONS_KEY_INVALID"
                    : issues.some((issue) => [
                      "AAIS_PRODUCTION_DEPLOY_REQUIRES_STRONG_CRON_SECRET",
                      "AAIS_PRODUCTION_DEPLOY_FORBIDS_ALIYUN_WORKER_TOKENS",
                    ].includes(issue))
                      ? "AAIS_PRODUCTION_DEPLOY_WORKER_AUTH_INVALID"
                      : "AAIS_PRODUCTION_DEPLOY_SCHEDULER_STATE_INVALID"
      : "AAIS_PRODUCTION_DEPLOY_GIT_MAIN_CONFIRMED",
    checks: {
      vercelEnv,
      productionBranch,
      gitRef,
      gitShaValid,
      gitProviderValid,
      deploymentProvider,
      runtimeLeaseSchemaConfirmed,
      canonicalDatabaseBindingConfigured,
      canonicalDatabaseBindingValid,
      databasePoolMaxValid,
      databaseTargetIdValid,
      researchDisabled,
      providerOwnedReleaseMetadata,
      serverActionsEncryptionKeyValid,
      cronSecretValid,
      forbiddenWorkerTokenBindings,
      forbiddenDatabaseBindings,
      productCronScheduleState,
    },
    issues,
  };
}

function normalizeEnvValue(value) {
  const text = String(value ?? "").trim();
  return text || null;
}

function isStrongOpaqueSecret(value) {
  const secret = normalizeEnvValue(value);
  if (!secret || secret !== value || /\s/.test(secret)) {
    return false;
  }
  const byteLength = Buffer.byteLength(secret, "utf8");
  return byteLength >= 32
    && byteLength <= 512
    && new Set([...secret]).size >= 8
    && !/^(?:change|replace|todo|tbd|example|sample|test)[-_ ]?me/i.test(secret)
    && !/^(?:password|secret|changeme)$/i.test(secret);
}

function isCanonicalAes256Key(value) {
  const encoded = normalizeEnvValue(value);
  if (!encoded || encoded !== value || !/^[A-Za-z0-9+/]{43}=$/.test(encoded)) {
    return false;
  }
  const decoded = Buffer.from(encoded, "base64");
  return decoded.length === 32 && decoded.toString("base64") === encoded;
}

function isValidProductionNeonBinding(env) {
  if (
    normalizeEnvValue(env.AAIS_DATABASE_PROVIDER)?.toLowerCase() !== "neon"
    || normalizeEnvValue(env.AAIS_DATABASE_DRIVER)?.toLowerCase() !== "pg"
    || env.NODE_TLS_REJECT_UNAUTHORIZED === "0"
  ) {
    return false;
  }
  try {
    const parsed = new URL(normalizeEnvValue(env.AAIS_DATABASE_URL) ?? "");
    const sslModes = parsed.searchParams.getAll("sslmode");
    return ["postgres:", "postgresql:"].includes(parsed.protocol)
      && parsed.username === "aais_app_vercel"
      && Boolean(parsed.password)
      && parsed.hostname.toLowerCase().endsWith(".neon.tech")
      && sslModes.length === 1
      && sslModes[0]?.toLowerCase() === "verify-full";
  } catch {
    return false;
  }
}

function main() {
  const report = evaluateAaisVercelProductionDeploy();
  console.log(JSON.stringify({
    status: report.status,
    reason: report.reason,
    issues: report.issues ?? [],
    vercelEnv: report.checks.vercelEnv,
    productionBranch: report.checks.productionBranch,
    gitRef: report.checks.gitRef,
    gitShaValid: report.checks.gitShaValid,
    gitProviderValid: report.checks.gitProviderValid,
    deploymentProvider: report.checks.deploymentProvider,
    runtimeLeaseSchemaConfirmed: report.checks.runtimeLeaseSchemaConfirmed,
    canonicalDatabaseBindingConfigured: report.checks.canonicalDatabaseBindingConfigured,
    canonicalDatabaseBindingValid: report.checks.canonicalDatabaseBindingValid,
    databasePoolMaxValid: report.checks.databasePoolMaxValid,
    databaseTargetIdValid: report.checks.databaseTargetIdValid,
    researchDisabled: report.checks.researchDisabled,
    providerOwnedReleaseMetadata: report.checks.providerOwnedReleaseMetadata,
    serverActionsEncryptionKeyValid: report.checks.serverActionsEncryptionKeyValid,
    cronSecretValid: report.checks.cronSecretValid,
    forbiddenWorkerTokenBindings: report.checks.forbiddenWorkerTokenBindings,
    forbiddenDatabaseBindings: report.checks.forbiddenDatabaseBindings,
    productCronScheduleState: report.checks.productCronScheduleState,
    secrets: "redacted",
  }));

  if (report.status === "failed") {
    console.error([
      "AAIS production deploy guard failed.",
      "Production Vercel builds must come from the Git-connected main branch.",
      "The runtime lease migrations and database target identity must be evidenced before the lease-aware production build.",
      "Production must expose only AAIS_DATABASE_URL; database alias names are reported without values.",
      "Vercel must use aais_app_vercel, pool max 2, the bound target ID, and an explicitly disabled research plane.",
      "Vercel must own release metadata, use the shared canonical Server Actions key, and configure only a strong Cron secret for worker authorization.",
      "Both exact Vercel product Crons must remain configured so the lease-aware warm backup can take over.",
      "Do not run local laptop production deploys.",
    ].join(" "));
    process.exitCode = 1;
  }
}

const invokedPath = process.argv[1] ? pathToFileURL(process.argv[1]).href : "";
if (import.meta.url === invokedPath) {
  main();
}
