#!/usr/bin/env node

import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { auditAaisEnterpriseReadiness } from "./audit-enterprise-readiness.mjs";
import { createAaisReleaseEvidenceBundle } from "./create-release-evidence-bundle.mjs";
import { generateAaisEnterpriseHandoff } from "./generate-enterprise-handoff.mjs";
import { generateAaisPostgresRestoreTemplate } from "./generate-postgres-restore-template.mjs";
import { generateAaisPrivateEnvTemplate } from "./generate-private-env-template.mjs";
import { provisionAaisVercelEnvironment } from "./provision-vercel-env.mjs";
import { runAaisEnterpriseReleaseCheck } from "./run-enterprise-release-check.mjs";
import { verifyAaisOidcConfiguration } from "./verify-oidc-configuration.mjs";

const defaultPaths = {
  sourceProvenanceReportPath: "output/aais-source-provenance-latest.json",
  vercelEnvReportPath: "output/aais-vercel-env-report-latest.json",
  vercelDeploymentReportPath: "output/aais-vercel-deployment-report-latest.json",
  enterpriseReportPath: "output/aais-enterprise-report-latest.json",
  releaseEvidenceReportPath: "output/aais-release-evidence-latest.json",
  releaseCheckReportPath: "output/aais-enterprise-release-check-latest.json",
  privateEnvTemplatePath: "output/aais-private-env-template-latest.env",
  privateEnvTemplateReportPath: "output/aais-private-env-template-report-latest.json",
  postgresRestoreTemplatePath: "output/aais-postgres-restore-template-latest.env",
  postgresRestoreTemplateReportPath: "output/aais-postgres-restore-template-report-latest.json",
  oidcConfigReportPath: "output/aais-oidc-config-report-latest.json",
  provisionReportPath: "output/aais-vercel-env-provision-dry-run-latest.json",
  handoffReportPath: "output/aais-enterprise-handoff-latest.json",
  handoffMarkdownPath: "output/aais-enterprise-handoff-latest.md",
  readinessAuditReportPath: "output/aais-enterprise-readiness-audit-latest.json",
  readinessAuditMarkdownPath: "output/aais-enterprise-readiness-audit-latest.md",
  bundleReportPath: "output/aais-release-evidence-bundle-latest.json",
  bundleMarkdownPath: "output/aais-release-evidence-bundle-latest.md",
  aiEvalManifestPath: "output/aais-ai-eval-deepseek-v4-flash.json",
  postgresRestoreReportPath: "output/aais-postgres-restore-report-latest.json",
  outputPath: "output/aais-release-refresh-latest.json",
};

const defaultBaseUrl = "https://www.aais.site";
const defaultReleaseId = "aais-2026-06-30-rc-live-ai-deepseek-v4-flash";
const defaultPrivateEnvFilePath = ".env.production.local";

export async function refreshAaisReleaseEvidence(input = {}) {
  const refreshedAt = (input.now ?? new Date()).toISOString();
  const paths = resolvePaths(input);
  const baseUrl = input.baseUrl ?? process.env.AAIS_RELEASE_DEPLOYMENT_URL ?? defaultBaseUrl;
  const releaseId = input.releaseId ?? process.env.AAIS_RELEASE_ID ?? defaultReleaseId;
  const deploymentGitCommit = input.deploymentGitCommit ?? process.env.AAIS_DEPLOYMENT_GIT_COMMIT_SHA;
  const enterpriseReleaseChecker = input.enterpriseReleaseChecker ?? runAaisEnterpriseReleaseCheck;
  const envTemplateGenerator = input.envTemplateGenerator ?? generateAaisPrivateEnvTemplate;
  const restoreTemplateGenerator = input.restoreTemplateGenerator ?? generateAaisPostgresRestoreTemplate;
  const oidcConfigVerifier = input.oidcConfigVerifier ?? verifyAaisOidcConfiguration;
  const provisioner = input.provisioner ?? provisionAaisVercelEnvironment;
  const handoffGenerator = input.handoffGenerator ?? generateAaisEnterpriseHandoff;
  const readinessAuditor = input.readinessAuditor ?? auditAaisEnterpriseReadiness;
  const bundleCreator = input.bundleCreator ?? createAaisReleaseEvidenceBundle;

  const enterpriseRelease = await runRefreshStage(() => enterpriseReleaseChecker({
    baseUrl,
    releaseId,
    sourceProvenanceReportPath: paths.sourceProvenanceReportPath,
    vercelEnvReportPath: paths.vercelEnvReportPath,
    vercelDeploymentReportPath: paths.vercelDeploymentReportPath,
    enterpriseReportPath: paths.enterpriseReportPath,
    releaseEvidenceReportPath: paths.releaseEvidenceReportPath,
    outputPath: paths.releaseCheckReportPath,
    aiEvalManifestPath: paths.aiEvalManifestPath,
    postgresRestoreReportPath: paths.postgresRestoreReportPath,
    deploymentUrl: baseUrl,
    deploymentGitCommit,
    deploymentPlatform: "vercel",
    databaseProvider: "neon",
    maxAgeHours: input.maxAgeHours,
    now: input.now,
  }));

  const privateEnvTemplate = await runRefreshStage(() => envTemplateGenerator({
    vercelEnvReportPath: paths.vercelEnvReportPath,
    outputPath: paths.privateEnvTemplatePath,
    reportPath: paths.privateEnvTemplateReportPath,
    baseUrl,
    environment: "production",
    releaseId,
    deploymentGitCommit,
    now: input.now,
  }));

  const postgresRestoreTemplate = await runRefreshStage(() => restoreTemplateGenerator({
    outputPath: paths.postgresRestoreTemplatePath,
    reportPath: paths.postgresRestoreTemplateReportPath,
    postgresRestoreReportPath: paths.postgresRestoreReportPath,
    releaseId,
    now: input.now,
  }));

  const oidcConfig = await runRefreshStage(() => oidcConfigVerifier({
    envFilePath: input.envFilePath ?? defaultPrivateEnvFilePath,
    baseUrl,
    outputPath: paths.oidcConfigReportPath,
    now: input.now,
  }));

  const provision = await runRefreshStage(() => provisioner({
    envFilePath: input.envFilePath ?? defaultPrivateEnvFilePath,
    vercelEnvReportPath: paths.vercelEnvReportPath,
    outputPath: paths.provisionReportPath,
    environment: "production",
    releaseId,
    deploymentGitCommit,
    apply: false,
    now: input.now,
  }));

  const handoff = await runRefreshStage(() => handoffGenerator({
    releaseCheckReportPath: paths.releaseCheckReportPath,
    vercelEnvReportPath: paths.vercelEnvReportPath,
    provisionReportPath: paths.provisionReportPath,
    enterpriseReportPath: paths.enterpriseReportPath,
    releaseEvidenceReportPath: paths.releaseEvidenceReportPath,
    postgresRestoreReportPath: paths.postgresRestoreReportPath,
    aiEvalManifestPath: paths.aiEvalManifestPath,
    oidcConfigReportPath: paths.oidcConfigReportPath,
    outputPath: paths.handoffReportPath,
    markdownOutputPath: paths.handoffMarkdownPath,
    privateEnvTemplatePath: paths.privateEnvTemplatePath,
    privateEnvTemplateReportPath: paths.privateEnvTemplateReportPath,
    postgresRestoreTemplatePath: paths.postgresRestoreTemplatePath,
    postgresRestoreTemplateReportPath: paths.postgresRestoreTemplateReportPath,
    baseUrl,
    releaseId,
    now: input.now,
  }));

  const readinessAudit = await runRefreshStage(() => readinessAuditor({
    releaseCheckReportPath: paths.releaseCheckReportPath,
    handoffReportPath: paths.handoffReportPath,
    outputPath: paths.readinessAuditReportPath,
    markdownOutputPath: paths.readinessAuditMarkdownPath,
    now: input.now,
  }));

  const evidenceBundle = await runRefreshStage(() => bundleCreator({
    vercelEnvReportPath: paths.vercelEnvReportPath,
    sourceProvenanceReportPath: paths.sourceProvenanceReportPath,
    vercelDeploymentReportPath: paths.vercelDeploymentReportPath,
    enterpriseReportPath: paths.enterpriseReportPath,
    releaseEvidenceReportPath: paths.releaseEvidenceReportPath,
    releaseCheckReportPath: paths.releaseCheckReportPath,
    handoffReportPath: paths.handoffReportPath,
    readinessAuditReportPath: paths.readinessAuditReportPath,
    oidcConfigReportPath: paths.oidcConfigReportPath,
    aiEvalManifestPath: paths.aiEvalManifestPath,
    postgresRestoreReportPath: paths.postgresRestoreReportPath,
    outputPath: paths.bundleReportPath,
    markdownOutputPath: paths.bundleMarkdownPath,
    releaseId,
    now: input.now,
  }));

  const sequence = [
    step("enterprise-release", enterpriseRelease, paths.releaseCheckReportPath),
    step(
      "source-provenance",
      findSequenceStep(enterpriseRelease, "source-provenance") ?? enterpriseRelease?.artifacts?.sourceProvenance,
      paths.sourceProvenanceReportPath,
    ),
    step("env-template", privateEnvTemplate, paths.privateEnvTemplateReportPath),
    step("restore-template", postgresRestoreTemplate, paths.postgresRestoreTemplateReportPath),
    step("oidc-config-dry-run", oidcConfig, paths.oidcConfigReportPath),
    step("provision-dry-run", provision, paths.provisionReportPath),
    step("handoff", handoff, paths.handoffReportPath),
    step("readiness-audit", readinessAudit, paths.readinessAuditReportPath),
    step("evidence-bundle", evidenceBundle, paths.bundleReportPath),
  ];
  const status = sequence.every((item) => item.status === "passed" || item.status === "ready")
    ? "ready"
    : "action-required";
  const report = {
    schemaVersion: 1,
    status,
    refreshedAt,
    release: {
      id: readSafeReleaseId(releaseId),
    },
    sequence,
    summaries: {
      readinessAudit: summarizeReadinessAudit(readinessAudit),
      evidenceBundle: summarizeEvidenceBundle(evidenceBundle),
    },
    redaction: {
      secrets: "omitted",
      values: "not-read",
    },
  };

  if (paths.outputPath) {
    await mkdir(path.dirname(paths.outputPath), { recursive: true });
    await writeFile(paths.outputPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  }

  return report;
}

function resolvePaths(input) {
  return Object.fromEntries(
    Object.entries(defaultPaths).map(([key, defaultValue]) => [
      key,
      input[key] ?? (key === "outputPath" ? process.env.AAIS_RELEASE_REFRESH_REPORT_PATH : undefined) ?? defaultValue,
    ]),
  );
}

async function runRefreshStage(run) {
  try {
    return await run();
  } catch {
    return {
      status: "failed",
      redaction: {
        secrets: "omitted",
        values: "not-read",
        errors: "omitted",
      },
    };
  }
}

function step(name, report, outputPath) {
  return {
    name,
    status: normalizeStatus(report?.status),
    outputPath,
  };
}

function findSequenceStep(report, name) {
  return Array.isArray(report?.sequence)
    ? report.sequence.find((item) => item?.name === name)
    : null;
}

function summarizeReadinessAudit(report) {
  return {
    total: readInteger(report?.summary?.total),
    passed: readInteger(report?.summary?.passed),
    actionRequired: readInteger(report?.summary?.actionRequired),
  };
}

function summarizeEvidenceBundle(report) {
  return {
    total: readInteger(report?.summary?.total),
    present: readInteger(report?.summary?.present),
    missing: readInteger(report?.summary?.missing),
    passed: readInteger(report?.summary?.passed),
    actionRequired: readInteger(report?.summary?.actionRequired),
    secretScanFailed: readInteger(report?.summary?.secretScanFailed),
  };
}

function normalizeStatus(value) {
  const status = String(value ?? "").trim().toLowerCase();
  return /^[a-z][a-z0-9_-]{1,31}$/.test(status) ? status : "unknown";
}

function readSafeReleaseId(value) {
  const trimmed = String(value ?? "").trim();
  return /^[A-Za-z0-9][A-Za-z0-9._:-]{2,127}$/.test(trimmed) ? trimmed : null;
}

function readInteger(value) {
  return Number.isInteger(value) ? value : null;
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
  const report = await refreshAaisReleaseEvidence({
    baseUrl: args.get("base-url"),
    releaseId: args.get("release-id"),
    deploymentGitCommit: args.get("deployment-git-commit"),
    envFilePath: args.get("env-file"),
    maxAgeHours: args.get("max-age-hours"),
    outputPath: args.get("output"),
    aiEvalManifestPath: args.get("ai-eval-manifest"),
    postgresRestoreReportPath: args.get("postgres-restore-report"),
    oidcConfigReportPath: args.get("oidc-config-report"),
  });
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  if (report.status !== "ready") {
    process.exitCode = 1;
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : "AAIS release evidence refresh failed."}\n`);
    process.exitCode = 1;
  });
}
