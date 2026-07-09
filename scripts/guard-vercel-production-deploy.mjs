#!/usr/bin/env node

import { pathToFileURL } from "node:url";

const productionBranch = "main";

export function evaluateAaisVercelProductionDeploy(input = {}) {
  const env = input.env ?? process.env;
  const vercelEnv = normalizeEnvValue(env.VERCEL_ENV);
  const runningOnVercel = env.VERCEL === "1" || Boolean(vercelEnv);
  const gitRef = normalizeEnvValue(env.VERCEL_GIT_COMMIT_REF);
  const gitSha = normalizeEnvValue(env.VERCEL_GIT_COMMIT_SHA);
  const gitProvider = normalizeEnvValue(env.VERCEL_GIT_PROVIDER);

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

  return {
    status: issues.length > 0 ? "failed" : "passed",
    reason: issues.length > 0
      ? "AAIS_PRODUCTION_DEPLOY_NOT_GIT_MAIN"
      : "AAIS_PRODUCTION_DEPLOY_GIT_MAIN_CONFIRMED",
    checks: {
      vercelEnv,
      productionBranch,
      gitRef,
      gitShaPresent: Boolean(gitSha),
      gitProviderPresent: Boolean(gitProvider),
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
    secrets: "redacted",
  }));

  if (report.status === "failed") {
    console.error([
      "AAIS production deploy guard failed.",
      "Production Vercel builds must come from the Git-connected main branch.",
      "Do not run local laptop production deploys.",
    ].join(" "));
    process.exitCode = 1;
  }
}

const invokedPath = process.argv[1] ? pathToFileURL(process.argv[1]).href : "";
if (import.meta.url === invokedPath) {
  main();
}
