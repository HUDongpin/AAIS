#!/usr/bin/env node

import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { auditAaisEnterpriseReadiness } from "./audit-enterprise-readiness.mjs";
import { createAaisReleaseEvidenceBundle } from "./create-release-evidence-bundle.mjs";
import { generateAaisEnterpriseHandoff } from "./generate-enterprise-handoff.mjs";
import { generateAaisEnterpriseGapTemplate } from "./generate-enterprise-gap-template.mjs";
import { generateAaisPostgresRestoreTemplate } from "./generate-postgres-restore-template.mjs";
import { generateAaisPrivateEnvTemplate } from "./generate-private-env-template.mjs";
import { provisionAaisVercelEnvironment } from "./provision-vercel-env.mjs";
import { runAaisEnterpriseGapEvidence } from "./run-enterprise-gap-evidence.mjs";
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
  enterpriseGapTemplatePath: "output/aais-enterprise-gap-template-latest.env",
  enterpriseGapTemplateReportPath: "output/aais-enterprise-gap-template-report-latest.json",
  enterpriseGapEvidenceReportPath: "output/aais-enterprise-gap-evidence-latest.json",
  oidcConfigReportPath: "output/aais-oidc-config-report-latest.json",
  provisionReportPath: "output/aais-vercel-env-provision-dry-run-latest.json",
  handoffReportPath: "output/aais-enterprise-handoff-latest.json",
  handoffMarkdownPath: "output/aais-enterprise-handoff-latest.md",
  readinessAuditReportPath: "output/aais-enterprise-readiness-audit-latest.json",
  readinessAuditMarkdownPath: "output/aais-enterprise-readiness-audit-latest.md",
  bundleReportPath: "output/aais-release-evidence-bundle-latest.json",
  bundleMarkdownPath: "output/aais-release-evidence-bundle-latest.md",
  aiEvalManifestPath: "output/aais-ai-eval-deepseek-v4-pro.json",
  postgresRestoreReportPath: "output/aais-postgres-restore-report-latest.json",
  outputPath: "output/aais-release-refresh-latest.json",
};

const defaultBaseUrl = "https://www.aais.site";
const defaultReleaseId = "aais-2026-06-30-rc-live-ai-deepseek-v4-pro";
const defaultPrivateEnvFilePath = ".env.production.local";
const defaultEnterpriseGapEnvFilePath = ".env.enterprise-smoke.local";
const defaultRestoreEnvFilePath = ".env.postgres-restore.local";

export async function refreshAaisReleaseEvidence(input = {}) {
  const refreshedAt = (input.now ?? new Date()).toISOString();
  const paths = resolvePaths(input);
  const baseUrl = input.baseUrl ?? process.env.AAIS_RELEASE_DEPLOYMENT_URL ?? defaultBaseUrl;
  const releaseId = input.releaseId ?? process.env.AAIS_RELEASE_ID ?? defaultReleaseId;
  const deploymentGitCommit = input.deploymentGitCommit ?? process.env.AAIS_DEPLOYMENT_GIT_COMMIT_SHA;
  const enterpriseReleaseChecker = input.enterpriseReleaseChecker ?? runAaisEnterpriseReleaseCheck;
  const envTemplateGenerator = input.envTemplateGenerator ?? generateAaisPrivateEnvTemplate;
  const restoreTemplateGenerator = input.restoreTemplateGenerator ?? generateAaisPostgresRestoreTemplate;
  const gapTemplateGenerator = input.gapTemplateGenerator ?? generateAaisEnterpriseGapTemplate;
  const gapEvidenceRunner = input.gapEvidenceRunner ?? runAaisEnterpriseGapEvidence;
  const oidcConfigVerifier = input.oidcConfigVerifier ?? verifyAaisOidcConfiguration;
  const provisioner = input.provisioner ?? provisionAaisVercelEnvironment;
  const handoffGenerator = input.handoffGenerator ?? generateAaisEnterpriseHandoff;
  const readinessAuditor = input.readinessAuditor ?? auditAaisEnterpriseReadiness;
  const bundleCreator = input.bundleCreator ?? createAaisReleaseEvidenceBundle;
  const includeOidcConfig = input.includeOidcConfig === true || process.env.AAIS_RELEASE_INCLUDE_OIDC === "true";

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

  const postgresRestoreTemplate = await runRefreshStage(() => restoreTemplateGenerator({
    outputPath: paths.postgresRestoreTemplatePath,
    reportPath: paths.postgresRestoreTemplateReportPath,
    postgresRestoreReportPath: paths.postgresRestoreReportPath,
    releaseId,
    now: input.now,
  }));

  const enterpriseGapTemplate = await runRefreshStage(() => gapTemplateGenerator({
    outputPath: paths.enterpriseGapTemplatePath,
    reportPath: paths.enterpriseGapTemplateReportPath,
    baseUrl,
    releaseId,
    enterpriseReportPath: paths.enterpriseReportPath,
    restoreEnvFilePath: input.restoreEnvFilePath,
    restoreReportPath: paths.postgresRestoreReportPath,
    aiEvalEnvFilePath: input.envFilePath ?? defaultPrivateEnvFilePath,
    aiEvalManifestPath: paths.aiEvalManifestPath,
    gapEvidenceReportPath: paths.enterpriseGapEvidenceReportPath,
    now: input.now,
  }));

  const enterpriseGapPreflight = input.enterpriseGapPreflightOnly === true
    ? await runRefreshStage(() => gapEvidenceRunner({
      mode: "all",
      envFilePath: input.enterpriseGapEnvFilePath ?? defaultEnterpriseGapEnvFilePath,
      restoreEnvFilePath: input.restoreEnvFilePath ?? defaultRestoreEnvFilePath,
      aiEvalEnvFilePath: input.envFilePath ?? defaultPrivateEnvFilePath,
      baseUrl,
      releaseId,
      outputPath: paths.enterpriseGapEvidenceReportPath,
      enterpriseOutputPath: paths.enterpriseReportPath,
      restoreOutputPath: paths.postgresRestoreReportPath,
      aiEvalOutputPath: paths.aiEvalManifestPath,
      preflightOnly: true,
      now: input.now,
    }))
    : null;

  const privateEnvTemplate = await runRefreshStage(() => envTemplateGenerator({
    vercelEnvReportPath: paths.vercelEnvReportPath,
    enterpriseGapEvidenceReportPath: paths.enterpriseGapEvidenceReportPath,
    outputPath: paths.privateEnvTemplatePath,
    reportPath: paths.privateEnvTemplateReportPath,
    baseUrl,
    environment: "production",
    releaseId,
    deploymentGitCommit,
    now: input.now,
  }));

  const oidcConfig = includeOidcConfig
    ? await runRefreshStage(() => oidcConfigVerifier({
      envFilePath: input.envFilePath ?? defaultPrivateEnvFilePath,
      baseUrl,
      outputPath: paths.oidcConfigReportPath,
      now: input.now,
    }))
    : null;

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
    sourceProvenanceReportPath: paths.sourceProvenanceReportPath,
    postgresRestoreReportPath: paths.postgresRestoreReportPath,
    aiEvalManifestPath: paths.aiEvalManifestPath,
    oidcConfigReportPath: includeOidcConfig ? paths.oidcConfigReportPath : false,
    enterpriseGapEvidenceReportPath: paths.enterpriseGapEvidenceReportPath,
    outputPath: paths.handoffReportPath,
    markdownOutputPath: paths.handoffMarkdownPath,
    privateEnvTemplatePath: paths.privateEnvTemplatePath,
    privateEnvTemplateReportPath: paths.privateEnvTemplateReportPath,
    postgresRestoreTemplatePath: paths.postgresRestoreTemplatePath,
    postgresRestoreTemplateReportPath: paths.postgresRestoreTemplateReportPath,
    baseUrl,
    releaseId,
    deploymentGitCommit,
    now: input.now,
  }));

  const readinessAudit = await runRefreshStage(() => readinessAuditor({
    releaseCheckReportPath: paths.releaseCheckReportPath,
    handoffReportPath: paths.handoffReportPath,
    gapEvidenceReportPath: paths.enterpriseGapEvidenceReportPath,
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
    oidcConfigReportPath: includeOidcConfig ? paths.oidcConfigReportPath : false,
    aiEvalManifestPath: paths.aiEvalManifestPath,
    postgresRestoreReportPath: paths.postgresRestoreReportPath,
    enterpriseGapTemplateReportPath: paths.enterpriseGapTemplateReportPath,
    enterpriseGapEvidenceReportPath: paths.enterpriseGapEvidenceReportPath,
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
    step("restore-template", postgresRestoreTemplate, paths.postgresRestoreTemplateReportPath),
    step("gap-template", enterpriseGapTemplate, paths.enterpriseGapTemplateReportPath),
    ...(enterpriseGapPreflight
      ? [step("gap-evidence-preflight", enterpriseGapPreflight, paths.enterpriseGapEvidenceReportPath)]
      : []),
    step("env-template", privateEnvTemplate, paths.privateEnvTemplateReportPath),
    ...(includeOidcConfig ? [step("oidc-config-dry-run", oidcConfig, paths.oidcConfigReportPath)] : []),
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
    nextActions: summarizeNextActions(handoff),
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
    businessGapSummary: {
      total: readInteger(report?.businessGapSummary?.total),
      passed: readInteger(report?.businessGapSummary?.passed),
      actionRequired: readInteger(report?.businessGapSummary?.actionRequired),
    },
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

function summarizeNextActions(handoff) {
  const actions = Array.isArray(handoff?.externalActions)
    ? handoff.externalActions
    : [];
  return {
    source: "enterprise-handoff",
    total: actions.length,
    required: actions.filter((action) => isRequiredActionStatus(action?.status)).length,
    businessGaps: summarizeBusinessGapActions(handoff?.businessGapActions),
    actions: actions.map((action) => sanitizeNextAction(action)),
    redaction: {
      secrets: "omitted",
      values: "not-read",
      secretLikeCommands: "redacted",
    },
  };
}

function summarizeBusinessGapActions(value) {
  return Array.isArray(value)
    ? value.map((gap) => ({
      id: readSafeActionId(gap?.id),
      status: normalizeStatus(gap?.status),
      missing: readSafeEnvNames(gap?.missing),
      reasons: readSafeReasonNames(gap?.reasons),
      actions: Array.isArray(gap?.actions)
        ? gap.actions.map(readSafeActionId).filter((actionId) => actionId !== "unknown-action")
        : [],
    })).filter((gap) => gap.id !== "unknown-action")
    : [];
}

function sanitizeNextAction(action) {
  const summary = {
    id: readSafeActionId(action?.id),
    status: normalizeStatus(action?.status),
  };
  const missing = readSafeEnvNames(action?.missing);
  if (missing.length > 0) {
    summary.missing = missing;
  }
  const missingInputs = readSafeEnvNames(action?.missingInputs);
  if (missingInputs.length > 0) {
    summary.missingInputs = missingInputs;
  }
  const preflightStatus = normalizeStatus(action?.preflightStatus);
  if (preflightStatus !== "unknown") {
    summary.preflightStatus = preflightStatus;
  }
  for (const field of [
    "templatePath",
    "reportPath",
    "privateEnvFilePath",
    "privateRestoreEnvFilePath",
  ]) {
    const value = readSafePath(action?.[field]);
    if (value) {
      summary[field] = value;
    }
  }
  const requiredValue = readSafeLiteral(action?.requiredValue);
  if (requiredValue) {
    summary.requiredValue = requiredValue;
  }
  const command = sanitizeActionCommand(action?.command);
  if (command) {
    summary.command = command;
  }
  const oidcOnboardingCommand = sanitizeActionCommand(action?.oidcOnboardingCommand);
  if (oidcOnboardingCommand) {
    summary.oidcOnboardingCommand = oidcOnboardingCommand;
  }
  const neonApiPreparationCommand = sanitizeActionCommand(action?.neonApiPreparationCommand);
  if (neonApiPreparationCommand) {
    summary.neonApiPreparationCommand = neonApiPreparationCommand;
  }
  const gapPreflightCommand = sanitizeActionCommand(action?.gapPreflightCommand);
  if (gapPreflightCommand) {
    summary.gapPreflightCommand = gapPreflightCommand;
  }
  const gapEvidenceCommand = sanitizeActionCommand(action?.gapEvidenceCommand);
  if (gapEvidenceCommand) {
    summary.gapEvidenceCommand = gapEvidenceCommand;
  }
  const commands = Array.isArray(action?.commands)
    ? action.commands.map(sanitizeActionCommand).filter(Boolean)
    : [];
  if (commands.length > 0) {
    summary.commands = commands;
  }
  return summary;
}

function isRequiredActionStatus(value) {
  const status = normalizeStatus(value);
  return status === "required" || status.startsWith("required-");
}

function sanitizeActionCommand(value) {
  if (typeof value !== "string") {
    return null;
  }
  const command = value.trim();
  if (!isSafeActionText(command)) {
    return "<redacted:secret-like-command>";
  }
  return command.slice(0, 1200);
}

function isSafeActionText(text) {
  if (!text || text.length > 4000) {
    return false;
  }
  const unsafePatterns = [
    /(?:postgres|postgresql|mysql|mongodb|redis):\/\/\S+/i,
    /:\/\/[^/\s:@]+:[^/\s@]+@/i,
    /\bBearer\s+[A-Za-z0-9._~+/=-]{8,}/i,
    /\b(?:password|passwd|pwd|client_secret|secret|token|api[_-]?key)=([^<\s][^\s]*)/i,
    /\bAAIS_VERIFY_OIDC_CALLBACK_URL=https:\/\/\S+/,
    /\bAAIS_VERIFY_OIDC_STATE_COOKIE=[^<\s]\S+/,
  ];
  return !unsafePatterns.some((pattern) => pattern.test(text));
}

function readSafeActionId(value) {
  const token = String(value ?? "").trim();
  return /^[a-z][a-z0-9-]{1,79}$/.test(token) ? token : "unknown-action";
}

function readSafeEnvNames(value) {
  return Array.isArray(value)
    ? value
      .map((item) => String(item ?? "").trim())
      .filter((item) => /^[A-Z][A-Z0-9_*\\/-]{1,127}$/.test(item))
    : [];
}

function readSafeReasonNames(value) {
  return Array.isArray(value)
    ? value
      .map((item) => String(item ?? "").trim())
      .filter((item) => /^[a-z][a-z0-9-]{1,63}$/.test(item))
    : [];
}

function readSafePath(value) {
  const text = String(value ?? "").trim();
  if (!text || text.length > 240 || text.includes("\0") || !isSafeActionText(text)) {
    return null;
  }
  return text;
}

function readSafeLiteral(value) {
  const text = String(value ?? "").trim();
  if (!text || text.length > 80 || !isSafeActionText(text)) {
    return null;
  }
  return /^[A-Za-z0-9._:/@-]+$/.test(text) ? text : null;
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
    restoreEnvFilePath: args.get("restore-env-file"),
    enterpriseGapEnvFilePath: args.get("enterprise-gap-env-file"),
    enterpriseGapPreflightOnly: args.has("enterprise-gap-preflight-only") || args.has("gap-preflight-only"),
    enterpriseGapTemplatePath: args.get("enterprise-gap-template"),
    enterpriseGapTemplateReportPath: args.get("enterprise-gap-template-report"),
    enterpriseGapEvidenceReportPath: args.get("enterprise-gap-evidence-report"),
    oidcConfigReportPath: args.get("oidc-config-report"),
    includeOidcConfig: args.has("include-oidc-config"),
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
