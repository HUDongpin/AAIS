#!/usr/bin/env node

import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { verifyAaisReleaseEvidence } from "./verify-release-evidence.mjs";
import { runEnterpriseReleaseVerification } from "./verify-enterprise-release.mjs";
import { verifyAaisSourceProvenance } from "./verify-source-provenance.mjs";
import { verifyAaisVercelDeployment } from "./verify-vercel-deployment.mjs";
import { verifyAaisVercelEnvironment } from "./verify-vercel-env.mjs";

const defaultSourceProvenanceReportPath = "output/aais-source-provenance-latest.json";
const defaultVercelEnvReportPath = "output/aais-vercel-env-report-latest.json";
const defaultVercelDeploymentReportPath = "output/aais-vercel-deployment-report-latest.json";
const defaultEnterpriseReportPath = "output/aais-enterprise-report-latest.json";
const defaultReleaseEvidenceReportPath = "output/aais-release-evidence-latest.json";
const defaultOutputPath = "output/aais-enterprise-release-check-latest.json";

const requiredEnterpriseCheckNames = [
  "readiness",
  "securityHeaders",
  "legalPages",
  "lrsHealth",
  "cohortAnalytics",
  "oidcStart",
  "oidcCallback",
  "ssoOnlyMode",
];

export async function runAaisEnterpriseReleaseCheck(input = {}) {
  const checkedAt = (input.now ?? new Date()).toISOString();
  const baseUrl = input.baseUrl ?? process.env.AAIS_VERIFY_BASE_URL ?? process.env.AAIS_RELEASE_DEPLOYMENT_URL;
  const releaseId = input.releaseId ?? process.env.AAIS_RELEASE_ID;
  const sourceProvenanceReportPath = input.sourceProvenanceReportPath
    ?? process.env.AAIS_RELEASE_SOURCE_PROVENANCE_REPORT_PATH
    ?? defaultSourceProvenanceReportPath;
  const vercelEnvReportPath = input.vercelEnvReportPath
    ?? process.env.AAIS_RELEASE_VERCEL_ENV_REPORT_PATH
    ?? defaultVercelEnvReportPath;
  const enterpriseReportPath = input.enterpriseReportPath
    ?? process.env.AAIS_RELEASE_ENTERPRISE_REPORT_PATH
    ?? defaultEnterpriseReportPath;
  const releaseEvidenceReportPath = input.releaseEvidenceReportPath
    ?? process.env.AAIS_RELEASE_EVIDENCE_REPORT_PATH
    ?? defaultReleaseEvidenceReportPath;
  const vercelConfigPath = input.vercelConfigPath ?? process.env.AAIS_RELEASE_VERCEL_CONFIG_PATH;
  const vercelDeploymentReportPath = input.vercelDeploymentReportPath
    ?? process.env.AAIS_RELEASE_VERCEL_DEPLOYMENT_REPORT_PATH
    ?? defaultVercelDeploymentReportPath;
  const outputPath = input.outputPath
    ?? process.env.AAIS_ENTERPRISE_RELEASE_CHECK_REPORT_PATH
    ?? defaultOutputPath;
  const deploymentUrl = input.deploymentUrl ?? baseUrl;
  const deploymentGitCommit = input.deploymentGitCommit ?? process.env.AAIS_DEPLOYMENT_GIT_COMMIT_SHA;
  const deploymentPlatform = input.deploymentPlatform ?? process.env.AAIS_RELEASE_DEPLOYMENT_PLATFORM ?? "vercel";
  const databaseProvider = input.databaseProvider ?? process.env.AAIS_RELEASE_DATABASE_PROVIDER ?? "neon";
  const requireSsoOnly = input.requireSsoOnly ?? true;
  const requireCohortAnalytics = input.requireCohortAnalytics ?? true;
  const educatorLogin = input.educatorLogin ?? getEducatorLoginFromEnv();
  const sourceProvenanceVerifier = input.sourceProvenanceVerifier ?? verifyAaisSourceProvenance;
  const vercelEnvVerifier = input.vercelEnvVerifier ?? verifyAaisVercelEnvironment;
  const vercelDeploymentVerifier = input.vercelDeploymentVerifier ?? verifyAaisVercelDeployment;
  const enterpriseVerifier = input.enterpriseVerifier ?? runEnterpriseReleaseVerification;
  const releaseEvidenceVerifier = input.releaseEvidenceVerifier ?? verifyAaisReleaseEvidence;

  const sourceProvenanceReport = await sourceProvenanceVerifier({
    releaseId,
    outputPath: sourceProvenanceReportPath,
    now: input.now,
  });

  const vercelEnvReport = await vercelEnvVerifier({
    environment: input.environment ?? "production",
    authMode: input.authMode ?? "sso-only",
    aiMode: input.aiMode ?? "live",
    outputPath: vercelEnvReportPath,
    now: input.now,
  });

  const vercelDeploymentReport = await vercelDeploymentVerifier({
    deploymentUrl,
    releaseId,
    deploymentGitCommit,
    outputPath: vercelDeploymentReportPath,
    now: input.now,
  });

  const enterpriseReport = await enterpriseVerifier({
    baseUrl,
    releaseId,
    outputPath: enterpriseReportPath,
    requireSsoOnly,
    requireCohortAnalytics,
    fetchImpl: input.fetchImpl,
    oidcCallback: input.oidcCallback,
    trialLogin: input.trialLogin,
    educatorLogin,
  });

  const releaseEvidenceReport = await releaseEvidenceVerifier({
    releaseId,
    sourceProvenanceReportPath,
    vercelEnvReportPath,
    vercelDeploymentReportPath,
    enterpriseReportPath,
    aiEvalManifestPath: input.aiEvalManifestPath ?? process.env.AAIS_RELEASE_AI_EVAL_MANIFEST_PATH,
    postgresRestoreReportPath: input.postgresRestoreReportPath
      ?? process.env.AAIS_RELEASE_POSTGRES_RESTORE_REPORT_PATH,
    vercelConfigPath,
    outputPath: releaseEvidenceReportPath,
    maxAgeHours: input.maxAgeHours,
    deploymentUrl,
    deploymentPlatform,
    databaseProvider,
    now: input.now,
  });

  const finalStatus = normalizeStatus(releaseEvidenceReport?.status);
  const report = {
    schemaVersion: 1,
    status: finalStatus === "passed" ? "passed" : "failed",
    checkedAt,
    sequence: [
      {
        name: "source-provenance",
        status: normalizeStatus(sourceProvenanceReport?.status),
        outputPath: sourceProvenanceReportPath,
      },
      {
        name: "vercel-env",
        status: normalizeStatus(vercelEnvReport?.status),
        outputPath: vercelEnvReportPath,
      },
      {
        name: "vercel-deployment",
        status: normalizeStatus(vercelDeploymentReport?.status),
        outputPath: vercelDeploymentReportPath,
      },
      {
        name: "enterprise-smoke",
        status: normalizeStatus(enterpriseReport?.status),
        outputPath: enterpriseReportPath,
      },
      {
        name: "release-evidence",
        status: finalStatus,
        outputPath: releaseEvidenceReportPath,
      },
    ],
    gate: {
      source: "release-evidence",
      passed: finalStatus === "passed",
      finalStatus,
    },
    release: summarizeRelease(releaseEvidenceReport?.release, releaseId),
    artifacts: {
      sourceProvenance: summarizeSourceProvenance(
        sourceProvenanceReport,
        releaseEvidenceReport?.artifacts?.sourceProvenance,
      ),
      vercelEnv: summarizeVercelEnv(vercelEnvReport, releaseEvidenceReport?.artifacts?.vercelEnv),
      vercelDeployment: summarizeVercelDeployment(
        vercelDeploymentReport,
        releaseEvidenceReport?.artifacts?.vercelDeployment,
      ),
      enterprise: summarizeEnterprise(enterpriseReport, releaseEvidenceReport?.artifacts?.enterprise),
      aiEval: summarizeAiEval(releaseEvidenceReport?.artifacts?.aiEval),
      postgresRestore: summarizePostgresRestore(releaseEvidenceReport?.artifacts?.postgresRestore),
      vercelConfig: summarizeVercelConfig(releaseEvidenceReport?.artifacts?.vercelConfig),
    },
    redaction: {
      secrets: "omitted",
      cookies: "attributes-only",
      values: "not-read",
    },
  };

  if (outputPath) {
    await mkdir(path.dirname(outputPath), { recursive: true });
    await writeFile(outputPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  }

  return report;
}

function summarizeRelease(release, fallbackReleaseId) {
  return {
    id: readSafeReleaseId(release?.id ?? fallbackReleaseId),
    consistent: typeof release?.consistent === "boolean" ? release.consistent : null,
  };
}

function summarizeSourceProvenance(sourceProvenanceReport, evidenceArtifact) {
  const source = evidenceArtifact?.source ?? sourceProvenanceReport?.source ?? {};
  return {
    status: normalizeStatus(evidenceArtifact?.status ?? sourceProvenanceReport?.status),
    gitHeadPresent: readOptionalBoolean(source.gitHeadPresent),
    gitCommitShortSha: readGitCommitShortSha(source.gitCommitShortSha),
    clean: readOptionalBoolean(source.clean),
    gitCommitMatchesDeployment: readOptionalBoolean(source.gitCommitMatchesDeployment),
  };
}

function summarizeVercelEnv(vercelEnvReport, evidenceArtifact) {
  const missing = getSafeEnvNames(evidenceArtifact?.missing ?? vercelEnvReport?.required?.missing);
  const missingCount = readNonNegativeInteger(evidenceArtifact?.missingCount, missing.length);
  return {
    status: normalizeStatus(evidenceArtifact?.status ?? vercelEnvReport?.status),
    missingCount,
    missing,
  };
}

function summarizeVercelDeployment(vercelDeploymentReport, evidenceArtifact) {
  const deployment = evidenceArtifact?.deployment ?? vercelDeploymentReport?.deployment ?? {};
  return {
    status: normalizeStatus(evidenceArtifact?.status ?? vercelDeploymentReport?.status),
    readyState: readSafeReadyState(deployment.readyState),
    target: readSafeDeploymentTarget(deployment.target),
    urlMatchesExpected: readOptionalBoolean(deployment.urlMatchesExpected),
    targetMatchesProduction: readOptionalBoolean(deployment.targetMatchesProduction),
    gitCommitShortSha: readGitCommitShortSha(deployment.gitCommitShortSha),
    gitCommitSource: readGitCommitSource(deployment.gitCommitSource),
    gitCommitMatchesEnterprise: readOptionalBoolean(deployment.gitCommitMatchesEnterprise),
  };
}

function summarizeEnterprise(enterpriseReport, evidenceArtifact) {
  return {
    status: normalizeStatus(evidenceArtifact?.status ?? enterpriseReport?.status),
    readiness: summarizeEnterpriseReadiness(enterpriseReport),
    requiredChecks: getRequiredChecks(evidenceArtifact?.requiredChecks),
    artifactCoalescing: summarizeArtifactCoalescing(evidenceArtifact),
    evidenceOrder: getEvidenceOrder(evidenceArtifact?.evidenceOrder),
  };
}

function summarizeEnterpriseReadiness(enterpriseReport) {
  const readinessCheck = Array.isArray(enterpriseReport?.checks)
    ? enterpriseReport.checks.find((check) => check?.name === "readiness")
    : null;
  const details = readinessCheck?.details ?? {};
  return {
    storagePostgresConnected: readOptionalBoolean(details.storagePostgresConnected),
    storageProvider: readSafeToken(details.storageProvider),
    issueCount: readOptionalInteger(details.issueCount),
    releaseId: readSafeReleaseId(details.releaseId),
    releaseIdMatchesExpected: readOptionalBoolean(details.releaseIdMatchesExpected),
    deploymentGitCommitPresent: readOptionalBoolean(details.deploymentGitCommitPresent),
  };
}

function summarizeAiEval(artifact) {
  return {
    status: normalizeStatus(artifact?.status),
    compatibleWithEnterpriseReadiness: readOptionalBoolean(artifact?.compatibleWithEnterpriseReadiness),
    blockedCount: readOptionalInteger(artifact?.blockedCount),
    modelFingerprintMatchesEnterprise: readOptionalBoolean(artifact?.modelFingerprint?.matchesEnterprise),
  };
}

function summarizePostgresRestore(artifact) {
  const provider = artifact?.provider;
  return {
    status: normalizeStatus(artifact?.status),
    provider: provider && typeof provider === "object"
      ? {
          value: readSafeToken(provider.value),
          expected: readSafeToken(provider.expected),
          matchesExpected: readOptionalBoolean(provider.matchesExpected),
        }
      : undefined,
    sameAsSource: readOptionalBoolean(artifact?.sameAsSource),
    tablePresent: readOptionalBoolean(artifact?.tablePresent),
    smokeInserted: readOptionalBoolean(artifact?.smokeInserted),
    smokeReadBack: readOptionalBoolean(artifact?.smokeReadBack),
    smokeDeleted: readOptionalBoolean(artifact?.smokeDeleted),
  };
}

function summarizeVercelConfig(artifact) {
  return {
    status: normalizeStatus(artifact?.status),
    path: readSafePath(artifact?.path),
    cronCount: readOptionalInteger(artifact?.cronCount),
    outboxCronPresent: readOptionalBoolean(artifact?.outboxCronPresent),
    outboxCronSchedule: readSafeCronSchedule(artifact?.outboxCronSchedule),
    outboxCronDaily: readOptionalBoolean(artifact?.outboxCronDaily),
    secretScanStatus: normalizeStatus(artifact?.secretScan?.status),
  };
}

function summarizeArtifactCoalescing(artifact) {
  const readiness = readOptionalBoolean(artifact?.lrsOutboxEvidence?.artifactCoalescingComplete);
  const lrsHealth = readOptionalBoolean(artifact?.lrsHealthEvidence?.artifactCoalescingComplete);
  return {
    readiness,
    lrsHealth,
    complete: readiness === true && lrsHealth === true,
  };
}

function getRequiredChecks(value) {
  return Object.fromEntries(
    requiredEnterpriseCheckNames.map((name) => [name, readOptionalBoolean(value?.[name]) === true]),
  );
}

function getEvidenceOrder(value) {
  return {
    enterpriseAfterVercelEnv: readOptionalBoolean(value?.enterpriseAfterVercelEnv) === true,
    enterpriseAfterVercelDeployment: readOptionalBoolean(value?.enterpriseAfterVercelDeployment) === true,
  };
}

function getSafeEnvNames(value) {
  return Array.isArray(value)
    ? value
      .map((item) => String(item ?? "").trim())
      .filter((item) => /^[A-Z][A-Z0-9_*\\/-]{1,127}$/.test(item))
    : [];
}

function readSafeReleaseId(value) {
  const trimmed = String(value ?? "").trim();
  return /^[A-Za-z0-9][A-Za-z0-9._:-]{2,127}$/.test(trimmed) ? trimmed : null;
}

function readSafeToken(value) {
  const trimmed = String(value ?? "").trim().toLowerCase();
  return /^[a-z][a-z0-9_-]{1,63}$/.test(trimmed) ? trimmed : null;
}

function readSafePath(value) {
  const trimmed = String(value ?? "").trim();
  return /^\/[A-Za-z0-9_./-]{1,255}$/.test(trimmed) ? trimmed : null;
}

function readSafeCronSchedule(value) {
  const trimmed = String(value ?? "").trim();
  return /^[0-9*,/\-\s]+$/.test(trimmed) && trimmed.split(/\s+/).length === 5
    ? trimmed
    : null;
}

function readSafeReadyState(value) {
  const trimmed = String(value ?? "").trim().toUpperCase();
  return ["READY", "BUILDING", "ERROR", "QUEUED", "CANCELED"].includes(trimmed) ? trimmed : null;
}

function readSafeDeploymentTarget(value) {
  const trimmed = String(value ?? "").trim().toLowerCase();
  return trimmed === "production" || trimmed === "preview" ? trimmed : null;
}

function readGitCommitShortSha(value) {
  const trimmed = String(value ?? "").trim().toLowerCase();
  return /^[a-f0-9]{7,12}$/.test(trimmed) ? trimmed : null;
}

function readGitCommitSource(value) {
  const trimmed = String(value ?? "").trim();
  return ["vercel-inspect", "AAIS_DEPLOYMENT_GIT_COMMIT_SHA", "VERCEL_GIT_COMMIT_SHA"].includes(trimmed)
    ? trimmed
    : null;
}

function normalizeStatus(value) {
  const status = String(value ?? "").trim().toLowerCase();
  return /^[a-z][a-z0-9_-]{1,31}$/.test(status) ? status : "unknown";
}

function readOptionalBoolean(value) {
  return typeof value === "boolean" ? value : null;
}

function readOptionalInteger(value) {
  return Number.isInteger(value) ? value : null;
}

function readNonNegativeInteger(value, fallback) {
  return Number.isInteger(value) && value >= 0 ? value : fallback;
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

function getOidcCallbackFromEnv() {
  return process.env.AAIS_VERIFY_OIDC_CALLBACK_URL && process.env.AAIS_VERIFY_OIDC_STATE_COOKIE
    ? {
        callbackUrl: process.env.AAIS_VERIFY_OIDC_CALLBACK_URL,
        stateCookie: process.env.AAIS_VERIFY_OIDC_STATE_COOKIE,
      }
    : undefined;
}

function getEducatorLoginFromEnv() {
  return process.env.AAIS_VERIFY_EDUCATOR_ACCOUNT && process.env.AAIS_VERIFY_EDUCATOR_CORRECT_PASSWORD
    ? {
        account: process.env.AAIS_VERIFY_EDUCATOR_ACCOUNT,
        correctPassword: process.env.AAIS_VERIFY_EDUCATOR_CORRECT_PASSWORD,
        clientIp: process.env.AAIS_VERIFY_EDUCATOR_CLIENT_IP,
      }
    : undefined;
}

function getTrialLoginFromEnv() {
  return process.env.AAIS_VERIFY_TRIAL_ACCOUNT && process.env.AAIS_VERIFY_TRIAL_CORRECT_PASSWORD
    ? {
        account: process.env.AAIS_VERIFY_TRIAL_ACCOUNT,
        correctPassword: process.env.AAIS_VERIFY_TRIAL_CORRECT_PASSWORD,
        wrongPassword: process.env.AAIS_VERIFY_TRIAL_WRONG_PASSWORD ?? "aais-intentional-wrong-password",
        clientIp: process.env.AAIS_VERIFY_TRIAL_CLIENT_IP,
      }
    : undefined;
}

async function main() {
  const args = parseCliArgs(process.argv.slice(2));
  const report = await runAaisEnterpriseReleaseCheck({
    baseUrl: args.get("base-url") ?? process.env.AAIS_VERIFY_BASE_URL ?? process.env.AAIS_RELEASE_DEPLOYMENT_URL,
    releaseId: args.get("release-id"),
    environment: args.get("environment"),
    authMode: args.get("auth-mode"),
    aiMode: args.get("ai-mode"),
    sourceProvenanceReportPath: args.get("source-provenance-report"),
    vercelEnvReportPath: args.get("vercel-env-report"),
    vercelDeploymentReportPath: args.get("vercel-deployment-report"),
    enterpriseReportPath: args.get("enterprise-report"),
    releaseEvidenceReportPath: args.get("release-evidence-output") ?? args.get("release-evidence-report"),
    vercelConfigPath: args.get("vercel-config"),
    outputPath: args.get("output"),
    aiEvalManifestPath: args.get("ai-eval-manifest"),
    postgresRestoreReportPath: args.get("postgres-restore-report"),
    deploymentUrl: args.get("deployment-url"),
    deploymentGitCommit: args.get("deployment-git-commit"),
    deploymentPlatform: args.get("deployment-platform"),
    databaseProvider: args.get("database-provider"),
    maxAgeHours: args.get("max-age-hours"),
    requireSsoOnly: !args.has("allow-trial-mode"),
    oidcCallback: getOidcCallbackFromEnv(),
    trialLogin: getTrialLoginFromEnv(),
  });
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  if (report.status !== "passed") {
    process.exitCode = 1;
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : "AAIS enterprise release check failed."}\n`);
    process.exitCode = 1;
  });
}
