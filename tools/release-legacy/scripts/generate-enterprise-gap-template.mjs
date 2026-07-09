#!/usr/bin/env node

import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

const defaultOutputPath = "output/aais-enterprise-gap-template-latest.env";
const defaultReportPath = "output/aais-enterprise-gap-template-report-latest.json";
const defaultPrivateSmokeEnvFilePath = ".env.enterprise-smoke.local";
const defaultRestoreEnvFilePath = ".env.postgres-restore.local";
const defaultEnterpriseReportPath = "output/aais-enterprise-report-latest.json";
const defaultRestoreReportPath = "output/aais-postgres-restore-report-latest.json";
const defaultAiEvalEnvFilePath = ".env.production.local";
const defaultAiEvalManifestPath = "output/aais-ai-eval-deepseek-v4-pro.json";
const defaultAiEvalInlineManifestPath = "output/aais-ai-eval-inline-latest.json";
const defaultGapEvidenceReportPath = "output/aais-enterprise-gap-evidence-latest.json";
const defaultReleaseId = "aais-2026-06-30-rc-live-ai-deepseek-v4-pro";

export async function generateAaisEnterpriseGapTemplate(input = {}) {
  const generatedAt = (input.now ?? new Date()).toISOString();
  const outputPath = input.outputPath
    ?? process.env.AAIS_ENTERPRISE_GAP_TEMPLATE_PATH
    ?? defaultOutputPath;
  const reportPath = input.reportPath
    ?? process.env.AAIS_ENTERPRISE_GAP_TEMPLATE_REPORT_PATH
    ?? defaultReportPath;
  const privateSmokeEnvFilePath = input.privateSmokeEnvFilePath ?? defaultPrivateSmokeEnvFilePath;
  const restoreEnvFilePath = input.restoreEnvFilePath ?? defaultRestoreEnvFilePath;
  const aiEvalEnvFilePath = input.aiEvalEnvFilePath ?? defaultAiEvalEnvFilePath;
  const enterpriseReportPath = input.enterpriseReportPath ?? defaultEnterpriseReportPath;
  const restoreReportPath = input.restoreReportPath ?? defaultRestoreReportPath;
  const aiEvalManifestPath = input.aiEvalManifestPath ?? defaultAiEvalManifestPath;
  const aiEvalInlineManifestPath = input.aiEvalInlineManifestPath ?? defaultAiEvalInlineManifestPath;
  const gapEvidenceReportPath = input.gapEvidenceReportPath ?? defaultGapEvidenceReportPath;
  const baseUrl = normalizeBaseUrl(input.baseUrl ?? process.env.AAIS_RELEASE_DEPLOYMENT_URL);
  const releaseId = readSafeReleaseId(input.releaseId ?? process.env.AAIS_RELEASE_ID ?? defaultReleaseId);
  const report = {
    schemaVersion: 1,
    status: "template-created",
    generatedAt,
    release: {
      id: releaseId,
    },
    template: {
      outputPath,
      privateSmokeEnvFilePath,
      placeholderValues: "fail-closed",
      variables: [
        "AAIS_VERIFY_BASE_URL",
        "AAIS_VERIFY_TRIAL_ACCOUNT",
        "AAIS_VERIFY_TRIAL_CORRECT_PASSWORD",
        "AAIS_VERIFY_TRIAL_WRONG_PASSWORD",
        "AAIS_VERIFY_TRIAL_THROTTLE_ACCOUNT",
        "AAIS_VERIFY_TRIAL_THROTTLE_CORRECT_PASSWORD",
        "AAIS_VERIFY_TRIAL_CLIENT_IP",
        "AAIS_VERIFY_TRIAL_THROTTLE_CLIENT_IP",
        "AAIS_VERIFY_EDUCATOR_ACCOUNT",
        "AAIS_VERIFY_EDUCATOR_CORRECT_PASSWORD",
        "AAIS_RELEASE_ID",
      ],
    },
    target: {
      baseUrl,
      enterpriseReportPath,
      restoreEnvFilePath,
      restoreReportPath,
      aiEvalEnvFilePath,
      aiEvalManifestPath,
      aiEvalInlineManifestPath,
      gapEvidenceReportPath,
    },
    nextCommands: {
      trialAuth: buildGapCommand({
        mode: "trial-auth",
        privateSmokeEnvFilePath,
        baseUrl,
        enterpriseReportPath,
        gapEvidenceReportPath,
        releaseId,
      }),
      restore: [
        "npm run verify:enterprise-gaps --",
        "--mode restore",
        `--restore-env-file ${restoreEnvFilePath}`,
        `--restore-output ${restoreReportPath}`,
        `--output ${gapEvidenceReportPath}`,
        `--release-id ${releaseId}`,
      ].join(" "),
      liveAiEval: buildAiEvalGapCommand({
        aiEvalEnvFilePath,
        aiEvalManifestPath,
        aiEvalInlineManifestPath,
        gapEvidenceReportPath,
        releaseId,
      }),
      all: [
        "npm run verify:enterprise-gaps --",
        "--mode all",
        `--env-file ${privateSmokeEnvFilePath}`,
        `--restore-env-file ${restoreEnvFilePath}`,
        `--ai-eval-env-file ${aiEvalEnvFilePath}`,
        `--base-url ${baseUrl}`,
        `--enterprise-output ${enterpriseReportPath}`,
        `--restore-output ${restoreReportPath}`,
        `--ai-eval-output ${aiEvalManifestPath}`,
        `--ai-eval-inline-output ${aiEvalInlineManifestPath}`,
        `--output ${gapEvidenceReportPath}`,
        `--release-id ${releaseId}`,
      ].join(" "),
    },
    redaction: {
      secrets: "omitted",
      values: "placeholders-only",
      trialAuthEvidence: "not-stored",
    },
  };

  await writeTextFile(outputPath, renderTemplate({ baseUrl, releaseId }));
  await writeTextFile(reportPath, `${JSON.stringify(report, null, 2)}\n`);
  return report;
}

function renderTemplate({ baseUrl, releaseId }) {
  return [
    "# AAIS enterprise gap evidence env template",
    "# Do not commit this file.",
    "# Copy this template to .env.enterprise-smoke.local, then replace trial learner and educator placeholders.",
    "# These smoke credentials are sensitive; keep this file local and out of git.",
    "# Placeholder values intentionally fail closed in verify:enterprise-gaps.",
    "",
    `AAIS_VERIFY_BASE_URL=${baseUrl}`,
    "AAIS_VERIFY_TRIAL_ACCOUNT=<REQUIRED:TRIAL_LEARNER_ACCOUNT>",
    "AAIS_VERIFY_TRIAL_CORRECT_PASSWORD=<REQUIRED:TRIAL_LEARNER_PASSWORD>",
    "AAIS_VERIFY_TRIAL_WRONG_PASSWORD=<OPTIONAL:INTENTIONAL_WRONG_PASSWORD>",
    "AAIS_VERIFY_TRIAL_THROTTLE_ACCOUNT=<OPTIONAL:SEPARATE_THROTTLE_ACCOUNT>",
    "AAIS_VERIFY_TRIAL_THROTTLE_CORRECT_PASSWORD=<OPTIONAL:SEPARATE_THROTTLE_PASSWORD>",
    "# Optional: leave unset to let verify:enterprise-gaps generate separated smoke IPs.",
    "AAIS_VERIFY_TRIAL_CLIENT_IP=<OPTIONAL:TRIAL_LEARNING_CLIENT_IP>",
    "AAIS_VERIFY_TRIAL_THROTTLE_CLIENT_IP=<OPTIONAL:TRIAL_THROTTLE_CLIENT_IP>",
    "AAIS_VERIFY_EDUCATOR_ACCOUNT=<REQUIRED:TRIAL_EDUCATOR_ACCOUNT>",
    "AAIS_VERIFY_EDUCATOR_CORRECT_PASSWORD=<REQUIRED:TRIAL_EDUCATOR_PASSWORD>",
    `AAIS_RELEASE_ID=${releaseId}`,
    "",
  ].join("\n");
}

function buildAiEvalGapCommand({
  aiEvalEnvFilePath,
  aiEvalManifestPath,
  aiEvalInlineManifestPath,
  gapEvidenceReportPath,
  releaseId,
}) {
  return [
    "npm run verify:enterprise-gaps --",
    "--mode live-ai-eval",
    `--ai-eval-env-file ${aiEvalEnvFilePath}`,
    `--ai-eval-output ${aiEvalManifestPath}`,
    `--ai-eval-inline-output ${aiEvalInlineManifestPath}`,
    `--output ${gapEvidenceReportPath}`,
    `--release-id ${releaseId}`,
  ].join(" ");
}

function buildGapCommand({
  mode,
  privateSmokeEnvFilePath,
  baseUrl,
  enterpriseReportPath,
  gapEvidenceReportPath,
  releaseId,
}) {
  return [
    "npm run verify:enterprise-gaps --",
    `--mode ${mode}`,
    `--env-file ${privateSmokeEnvFilePath}`,
    `--base-url ${baseUrl}`,
    `--enterprise-output ${enterpriseReportPath}`,
    `--output ${gapEvidenceReportPath}`,
    `--release-id ${releaseId}`,
  ].join(" ");
}

async function writeTextFile(filePath, text) {
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, text, "utf8");
}

function normalizeBaseUrl(value) {
  const trimmed = String(value ?? "").trim();
  if (!trimmed) {
    return "https://www.aais.site";
  }
  try {
    const url = new URL(trimmed);
    url.hash = "";
    url.search = "";
    return url.toString().replace(/\/$/, "");
  } catch {
    return "https://www.aais.site";
  }
}

function readSafeReleaseId(value) {
  const trimmed = String(value ?? "").trim();
  return /^[A-Za-z0-9][A-Za-z0-9._:-]{2,127}$/.test(trimmed) ? trimmed : defaultReleaseId;
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
  const report = await generateAaisEnterpriseGapTemplate({
    outputPath: args.get("output"),
    reportPath: args.get("report"),
    baseUrl: args.get("base-url"),
    releaseId: args.get("release-id"),
    enterpriseReportPath: args.get("enterprise-report"),
    restoreEnvFilePath: args.get("restore-env-file"),
    restoreReportPath: args.get("restore-report"),
    aiEvalEnvFilePath: args.get("ai-eval-env-file"),
    aiEvalManifestPath: args.get("ai-eval-manifest"),
    aiEvalInlineManifestPath: args.get("ai-eval-inline-manifest"),
    gapEvidenceReportPath: args.get("gap-evidence-report"),
  });
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : "AAIS enterprise gap template generation failed."}\n`);
    process.exitCode = 1;
  });
}
