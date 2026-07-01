#!/usr/bin/env node

import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

const defaultOutputPath = "output/aais-release-evidence-bundle-latest.json";
const defaultMarkdownOutputPath = "output/aais-release-evidence-bundle-latest.md";

const defaultArtifactPaths = {
  sourceProvenanceReportPath: "output/aais-source-provenance-latest.json",
  vercelEnvReportPath: "output/aais-vercel-env-report-latest.json",
  vercelDeploymentReportPath: "output/aais-vercel-deployment-report-latest.json",
  enterpriseReportPath: "output/aais-enterprise-report-latest.json",
  releaseEvidenceReportPath: "output/aais-release-evidence-latest.json",
  releaseCheckReportPath: "output/aais-enterprise-release-check-latest.json",
  handoffReportPath: "output/aais-enterprise-handoff-latest.json",
  readinessAuditReportPath: "output/aais-enterprise-readiness-audit-latest.json",
  oidcConfigReportPath: "output/aais-oidc-config-report-latest.json",
  aiEvalManifestPath: "output/aais-ai-eval-deepseek-v4-flash.json",
  postgresRestoreReportPath: "output/aais-postgres-restore-report-latest.json",
};

export async function createAaisReleaseEvidenceBundle(input = {}) {
  const generatedAt = (input.now ?? new Date()).toISOString();
  const outputPath = input.outputPath ?? process.env.AAIS_RELEASE_BUNDLE_REPORT_PATH ?? defaultOutputPath;
  const markdownOutputPath = input.markdownOutputPath
    ?? process.env.AAIS_RELEASE_BUNDLE_MARKDOWN_PATH
    ?? defaultMarkdownOutputPath;
  const artifacts = await Promise.all(getArtifactInputs(input).map(readArtifact));
  const passed = artifacts.filter((artifact) => artifact.effectiveStatus === "passed").length;
  const missing = artifacts.filter((artifact) => !artifact.present).length;
  const secretScanFailed = artifacts.filter((artifact) => artifact.secretScan.status === "failed").length;
  const actionRequired = artifacts.length - passed;
  const report = {
    schemaVersion: 1,
    status: actionRequired === 0 && secretScanFailed === 0 ? "ready" : "action-required",
    generatedAt,
    release: {
      id: readSafeReleaseId(input.releaseId ?? process.env.AAIS_RELEASE_ID),
    },
    summary: {
      total: artifacts.length,
      present: artifacts.length - missing,
      missing,
      passed,
      actionRequired,
      secretScanFailed,
    },
    artifacts,
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

function getArtifactInputs(input) {
  return [
    artifactInput("source-provenance", input.sourceProvenanceReportPath ?? defaultArtifactPaths.sourceProvenanceReportPath),
    artifactInput("vercel-env", input.vercelEnvReportPath ?? defaultArtifactPaths.vercelEnvReportPath),
    artifactInput(
      "vercel-deployment",
      input.vercelDeploymentReportPath ?? defaultArtifactPaths.vercelDeploymentReportPath,
    ),
    artifactInput("enterprise-smoke", input.enterpriseReportPath ?? defaultArtifactPaths.enterpriseReportPath),
    artifactInput("release-evidence", input.releaseEvidenceReportPath ?? defaultArtifactPaths.releaseEvidenceReportPath),
    artifactInput("enterprise-release-check", input.releaseCheckReportPath ?? defaultArtifactPaths.releaseCheckReportPath),
    artifactInput("enterprise-handoff", input.handoffReportPath ?? defaultArtifactPaths.handoffReportPath),
    artifactInput(
      "enterprise-readiness-audit",
      input.readinessAuditReportPath ?? defaultArtifactPaths.readinessAuditReportPath,
    ),
    artifactInput("oidc-config", input.oidcConfigReportPath ?? defaultArtifactPaths.oidcConfigReportPath),
    artifactInput("ai-eval", input.aiEvalManifestPath ?? defaultArtifactPaths.aiEvalManifestPath),
    artifactInput("postgres-restore", input.postgresRestoreReportPath ?? defaultArtifactPaths.postgresRestoreReportPath),
  ];
}

function artifactInput(id, filePath) {
  return {
    id,
    path: filePath,
    required: true,
  };
}

async function readArtifact(input) {
  try {
    const raw = await readFile(input.path, "utf8");
    const parsed = JSON.parse(raw);
    const secretScan = scanSecretLikeContent(raw);
    const reportedStatus = normalizeStatus(parsed?.status);
    const effectiveStatus = reportedStatus === "passed" && secretScan.status === "passed"
      ? "passed"
      : "action-required";
    return {
      ...input,
      present: true,
      reportedStatus,
      effectiveStatus,
      sha256: createHash("sha256").update(raw).digest("hex"),
      secretScan,
      metadata: getArtifactMetadata(input.id, parsed),
    };
  } catch {
    return {
      ...input,
      present: false,
      reportedStatus: "missing",
      effectiveStatus: "action-required",
      secretScan: {
        status: "not-run",
      },
    };
  }
}

function getArtifactMetadata(id, artifact) {
  const metadata = {};
  const checkedAt = readIsoTimestamp(artifact?.checkedAt ?? artifact?.generatedAt ?? artifact?.passedAt);
  if (checkedAt) {
    metadata.checkedAt = checkedAt;
  }
  const missing = getSafeEnvNames(artifact?.required?.missing ?? artifact?.missing?.vercelProductionEnv);
  if (missing.length > 0) {
    metadata.missing = missing;
  }
  if (id === "enterprise-readiness-audit" && artifact?.summary) {
    metadata.summary = {
      total: readInteger(artifact.summary.total),
      passed: readInteger(artifact.summary.passed),
      actionRequired: readInteger(artifact.summary.actionRequired),
    };
  }
  if (id === "ai-eval" && typeof artifact?.evalVersion === "string") {
    metadata.evalVersion = artifact.evalVersion;
  }
  return metadata;
}

function renderMarkdown(report) {
  const lines = [
    "# AAIS Release Evidence Bundle",
    "",
    `Status: ${report.status}`,
    `Generated: ${report.generatedAt}`,
    `Summary: ${report.summary.passed}/${report.summary.total} passed, ${report.summary.missing} missing`,
    "",
    "## Artifacts",
    "",
    ...report.artifacts.flatMap((artifact) => [
      `- ${artifact.id}: ${artifact.effectiveStatus}`,
      `  - path: ${artifact.path}`,
      `  - present: ${artifact.present}`,
      ...(artifact.sha256 ? [`  - sha256: ${artifact.sha256}`] : []),
      `  - secretScan: ${artifact.secretScan.status}`,
      ...(artifact.secretScan.issue ? [`  - issue: ${artifact.secretScan.issue}`] : []),
    ]),
    "",
    "## Redaction",
    "",
    "- Secret values are omitted.",
    "- This bundle stores paths, hashes, statuses, and issue names only.",
    "",
  ];
  return lines.join("\n");
}

async function writeTextFile(filePath, text) {
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, text, "utf8");
}

function scanSecretLikeContent(raw) {
  const scanTarget = stripAllowedRequiredPlaceholders(raw);
  const issue = [
    ["private-key", /-----BEGIN [A-Z ]*PRIVATE KEY-----/],
    ["bearer-token", /bearer\s+[A-Za-z0-9._-]{8,}/i],
    ["postgres-url-with-password", /postgres(?:ql)?:\/\/[^:\s/]+:[^@\s/]+@/i],
    ["oidc-id-token", /\bid_token\s*[:=]/i],
    ["authorization-code-url", /[?&]code=[^\s"'<>]+/i],
    ["oidc-state-cookie", /aais_oidc_state=[A-Za-z0-9._~%+-]{24,}/i],
    ["pkce-verifier", /code_verifier=[A-Za-z0-9._~-]{20,}/i],
    ["api-key-assignment", /api[_-]?key\s*[:=]\s*["']?[A-Za-z0-9._-]{8,}/i],
    ["password-assignment", /password\s*[:=]\s*["']?[^"'\s,}]{8,}/i],
    ["raw-learner-text", /不能出现在教师看板的原始学习文本|第一位学习者的|第二位学习者的/i],
    ["legal-page-body", /AAIS 只收集运行 Cognitive Apprenticeship|学习使用边界|数据范围|运维与证据/i],
  ].find(([, pattern]) => pattern.test(scanTarget));
  if (!issue) {
    return {
      status: "passed",
    };
  }
  return {
    status: "failed",
    issue: issue[0],
  };
}

function stripAllowedRequiredPlaceholders(raw) {
  return raw.replace(/password\s*[:=]\s*["']?<REQUIRED:[^"'\s,}]+>/gi, "required_placeholder=");
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
  return /^[A-Za-z0-9][A-Za-z0-9._:-]{2,127}$/.test(trimmed) ? trimmed : null;
}

function readIsoTimestamp(value) {
  if (typeof value !== "string") {
    return null;
  }
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString();
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
  const report = await createAaisReleaseEvidenceBundle({
    sourceProvenanceReportPath: args.get("source-provenance-report"),
    vercelEnvReportPath: args.get("vercel-env-report"),
    vercelDeploymentReportPath: args.get("vercel-deployment-report"),
    enterpriseReportPath: args.get("enterprise-report"),
    releaseEvidenceReportPath: args.get("release-evidence-report"),
    releaseCheckReportPath: args.get("release-check-report"),
    handoffReportPath: args.get("handoff-report"),
    readinessAuditReportPath: args.get("readiness-audit-report"),
    oidcConfigReportPath: args.get("oidc-config-report"),
    aiEvalManifestPath: args.get("ai-eval-manifest"),
    postgresRestoreReportPath: args.get("postgres-restore-report"),
    outputPath: args.get("output"),
    markdownOutputPath: args.get("markdown-output"),
    releaseId: args.get("release-id"),
  });
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  if (report.status !== "ready") {
    process.exitCode = 1;
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : "AAIS release evidence bundle failed."}\n`);
    process.exitCode = 1;
  });
}
