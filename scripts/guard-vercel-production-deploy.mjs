#!/usr/bin/env node

import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

const productionBranch = "main";
const productCronSchedules = new Map([
  ["/api/learning/lrs/outbox/flush", "*/5 * * * *"],
  ["/api/auth/email-outbox/flush", "*/5 * * * *"],
]);

export function hasAllAaisProductCronSchedules(vercelConfig) {
  return getAaisProductCronScheduleState(vercelConfig) === "configured";
}

export function getAaisProductCronScheduleState(vercelConfig) {
  const relevant = Array.isArray(vercelConfig?.crons)
    ? vercelConfig.crons.filter((cron) =>
      productCronSchedules.has(normalizeCronRoute(cron?.path)))
    : [];
  if (relevant.length === 0) {
    return "removed";
  }
  if (relevant.length !== productCronSchedules.size) {
    return "partial";
  }
  const exactPaths = new Set();
  for (const cron of relevant) {
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
  const aliyunSchedulersConfirmed = normalizeEnvValue(
    env.AAIS_ALIYUN_PRIMARY_SCHEDULERS_CONFIRMED,
  ) === "true";
  const runtimeLeaseSchemaConfirmed = normalizeEnvValue(
    env.AAIS_RUNTIME_LEASE_SCHEMA_CONFIRMED,
  ) === "true";
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
        gitShaPresent: Boolean(gitSha),
        gitProviderPresent: Boolean(gitProvider),
        aliyunSchedulersConfirmed,
        runtimeLeaseSchemaConfirmed,
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
        gitShaPresent: Boolean(gitSha),
        gitProviderPresent: Boolean(gitProvider),
        aliyunSchedulersConfirmed,
        runtimeLeaseSchemaConfirmed,
        productCronScheduleState,
      },
    };
  }

  const issues = [];
  if (gitRef !== productionBranch) {
    issues.push("AAIS_PRODUCTION_DEPLOY_REQUIRES_MAIN_GIT_REF");
  }
  if (!gitSha) {
    issues.push("AAIS_PRODUCTION_DEPLOY_REQUIRES_GIT_COMMIT_SHA");
  }
  if (!gitProvider) {
    issues.push("AAIS_PRODUCTION_DEPLOY_REQUIRES_GIT_PROVIDER");
  }
  if (!runtimeLeaseSchemaConfirmed) {
    issues.push("AAIS_PRODUCTION_DEPLOY_REQUIRES_RUNTIME_LEASE_SCHEMA");
  }
  if (!aliyunSchedulersConfirmed && productCronScheduleState !== "configured") {
    issues.push("AAIS_PRODUCTION_DEPLOY_REQUIRES_CURRENT_VERCEL_CRONS_BEFORE_HANDOFF");
  }
  if (aliyunSchedulersConfirmed && productCronScheduleState !== "removed") {
    issues.push("AAIS_PRODUCTION_DEPLOY_REQUIRES_CRON_FREE_VERCEL_AFTER_HANDOFF");
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
        : issues.includes("AAIS_PRODUCTION_DEPLOY_REQUIRES_RUNTIME_LEASE_SCHEMA")
          ? "AAIS_PRODUCTION_DEPLOY_RUNTIME_LEASE_SCHEMA_NOT_CONFIRMED"
          : "AAIS_PRODUCTION_DEPLOY_SCHEDULER_STATE_INVALID"
      : "AAIS_PRODUCTION_DEPLOY_GIT_MAIN_CONFIRMED",
    checks: {
      vercelEnv,
      productionBranch,
      gitRef,
      gitShaPresent: Boolean(gitSha),
      gitProviderPresent: Boolean(gitProvider),
      aliyunSchedulersConfirmed,
      runtimeLeaseSchemaConfirmed,
      productCronScheduleState,
    },
    issues,
  };
}

function normalizeEnvValue(value) {
  const text = String(value ?? "").trim();
  return text || null;
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
    gitShaPresent: report.checks.gitShaPresent,
    gitProviderPresent: report.checks.gitProviderPresent,
    aliyunSchedulersConfirmed: report.checks.aliyunSchedulersConfirmed,
    runtimeLeaseSchemaConfirmed: report.checks.runtimeLeaseSchemaConfirmed,
    productCronScheduleState: report.checks.productCronScheduleState,
    secrets: "redacted",
  }));

  if (report.status === "failed") {
    console.error([
      "AAIS production deploy guard failed.",
      "Production Vercel builds must come from the Git-connected main branch.",
      "The runtime lease migrations and database target identity must be evidenced before the lease-aware production build.",
      "Before handoff both exact Vercel product Crons are required; after handoff both must remain absent.",
      "Do not run local laptop production deploys.",
    ].join(" "));
    process.exitCode = 1;
  }
}

const invokedPath = process.argv[1] ? pathToFileURL(process.argv[1]).href : "";
if (import.meta.url === invokedPath) {
  main();
}
