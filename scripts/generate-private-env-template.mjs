#!/usr/bin/env node

import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

const defaultVercelEnvReportPath = "output/aais-vercel-env-report-latest.json";
const defaultOutputPath = "output/aais-private-env-template-latest.env";
const defaultReportPath = "output/aais-private-env-template-report-latest.json";
const defaultBaseUrl = "https://www.aais.site";
const defaultPrivateEnvFilePath = ".env.production.local";
const placeholderLabels = new Map([
  ["AAIS_RELEASE_ID", "RELEASE_ID"],
  ["AAIS_DEPLOYMENT_GIT_COMMIT_SHA", "DEPLOYMENT_GIT_COMMIT_SHA"],
  ["AAIS_DATABASE_URL", "NEON_POSTGRES_URL"],
  ["AAIS_OIDC_ISSUER", "OIDC_ISSUER"],
  ["AAIS_OIDC_CLIENT_ID", "OIDC_CLIENT_ID"],
  ["AAIS_OIDC_CLIENT_SECRET", "OIDC_CLIENT_SECRET"],
  ["AAIS_OIDC_REDIRECT_URI", "OIDC_REDIRECT_URI"],
  ["AAIS_OIDC_TEACHER_GROUPS", "OIDC_TEACHER_GROUPS"],
]);

export async function generateAaisPrivateEnvTemplate(input = {}) {
  const generatedAt = (input.now ?? new Date()).toISOString();
  const vercelEnvReportPath = input.vercelEnvReportPath ?? defaultVercelEnvReportPath;
  const outputPath = input.outputPath ?? process.env.AAIS_PRIVATE_ENV_TEMPLATE_PATH ?? defaultOutputPath;
  const reportPath = input.reportPath ?? process.env.AAIS_PRIVATE_ENV_TEMPLATE_REPORT_PATH ?? defaultReportPath;
  const privateEnvFilePath = input.privateEnvFilePath ?? defaultPrivateEnvFilePath;
  const environment = normalizeEnvironment(input.environment ?? "production");
  const baseUrl = normalizeUrl(input.baseUrl ?? process.env.AAIS_RELEASE_DEPLOYMENT_URL ?? defaultBaseUrl);
  const releaseId = readSafeReleaseId(input.releaseId ?? process.env.AAIS_RELEASE_ID);
  const deploymentGitCommit = readSafeGitCommitSha(
    input.deploymentGitCommit
      ?? process.env.AAIS_DEPLOYMENT_GIT_COMMIT_SHA
      ?? process.env.VERCEL_GIT_COMMIT_SHA,
  );
  const explicitNames = getSafeEnvNames(input.names);
  const missing = explicitNames.length > 0
    ? explicitNames
    : getSafeEnvNames((await readJsonIfExists(vercelEnvReportPath))?.required?.missing);
  const oidcRedirectUri = `${baseUrl}/api/auth/oidc/callback`;

  const report = {
    schemaVersion: 1,
    status: missing.length > 0 ? "template-created" : "ready",
    generatedAt,
    sourceReports: {
      vercelEnv: vercelEnvReportPath,
    },
    target: {
      environment,
      baseUrl,
    },
    missing,
    template: {
      outputPath,
      privateEnvFilePath,
      placeholderValues: "fail-closed",
      variables: missing,
    },
    suggestions: {
      storageProvider: "neon",
      canonicalStorageEnv: "AAIS_DATABASE_URL",
      ...(releaseId ? { releaseId } : {}),
      ...(deploymentGitCommit ? { deploymentGitCommit } : {}),
      oidcRedirectUri,
    },
    nextCommands: buildProvisionCommands({
      privateEnvFilePath,
      vercelEnvReportPath,
      releaseId,
      deploymentGitCommit,
    }),
    redaction: {
      secrets: "omitted",
      values: "placeholders-only",
    },
  };

  await writeTextFile(outputPath, renderTemplate({
    environment,
    missing,
    oidcRedirectUri,
    privateEnvFilePath,
    releaseId,
    deploymentGitCommit,
  }));
  await writeTextFile(reportPath, `${JSON.stringify(report, null, 2)}\n`);

  return report;
}

async function readJsonIfExists(filePath) {
  try {
    return JSON.parse(await readFile(filePath, "utf8"));
  } catch {
    return null;
  }
}

function renderTemplate({ environment, missing, oidcRedirectUri, privateEnvFilePath, releaseId, deploymentGitCommit }) {
  const lines = [
    `# AAIS private ${environment} env template`,
    "# Do not commit this file.",
    `# Copy this template to ${privateEnvFilePath}, then fill the copy with real values.`,
    "# Rerun the dry-run, and apply only after status is ready.",
    "# Placeholder values intentionally fail closed in provision:vercel-env.",
    "# For Neon, prefer AAIS_DATABASE_URL; Vercel Neon aliases are also accepted by the provisioner.",
    `# Suggested AAIS_OIDC_REDIRECT_URI: ${oidcRedirectUri}`,
    "",
    ...missing.map((name) => `${name}=${templateValueFor(name, { releaseId, deploymentGitCommit })}`),
    "",
  ];
  return lines.join("\n");
}

function templateValueFor(name, { releaseId, deploymentGitCommit }) {
  if (name === "AAIS_RELEASE_ID" && releaseId) {
    return releaseId;
  }
  if (name === "AAIS_DEPLOYMENT_GIT_COMMIT_SHA" && deploymentGitCommit) {
    return deploymentGitCommit;
  }
  return `<REQUIRED:${placeholderFor(name)}>`;
}

function buildProvisionCommands({ privateEnvFilePath, vercelEnvReportPath, releaseId, deploymentGitCommit }) {
  const releaseIdArg = releaseId ? ` --release-id ${releaseId}` : "";
  const deploymentGitCommitArg = deploymentGitCommit ? ` --deployment-git-commit ${deploymentGitCommit}` : "";
  return [
    `npm run provision:vercel-env -- --env-file ${privateEnvFilePath} --report ${vercelEnvReportPath}${releaseIdArg}${deploymentGitCommitArg} --output output/aais-vercel-env-provision-dry-run-latest.json`,
    `npm run provision:vercel-env -- --env-file ${privateEnvFilePath} --report ${vercelEnvReportPath}${releaseIdArg}${deploymentGitCommitArg} --apply --output output/aais-vercel-env-provision-apply-latest.json`,
  ];
}

function placeholderFor(name) {
  return placeholderLabels.get(name) ?? name;
}

async function writeTextFile(filePath, text) {
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, text, "utf8");
}

function getSafeEnvNames(value) {
  return Array.isArray(value)
    ? Array.from(new Set(value
      .map((item) => String(item ?? "").trim())
      .filter((item) => /^[A-Z][A-Z0-9_]{1,127}$/.test(item))))
    : [];
}

function normalizeEnvironment(value) {
  const normalized = String(value ?? "").trim().toLowerCase();
  return ["production", "preview", "development"].includes(normalized) ? normalized : "production";
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

function readSafeReleaseId(value) {
  const trimmed = String(value ?? "").trim();
  return /^[A-Za-z0-9][A-Za-z0-9._:-]{2,127}$/.test(trimmed) ? trimmed : null;
}

function readSafeGitCommitSha(value) {
  const trimmed = String(value ?? "").trim().toLowerCase();
  return /^[a-f0-9]{7,40}$/.test(trimmed) ? trimmed : null;
}

function parseCliArgs(argv) {
  const args = new Map();
  const names = [];
  for (let index = 0; index < argv.length; index += 1) {
    const current = argv[index];
    if (!current.startsWith("--")) {
      continue;
    }
    const [rawKey, inlineValue] = current.slice(2).split("=");
    if (rawKey === "name") {
      const value = inlineValue ?? argv[index + 1];
      if (inlineValue === undefined) {
        index += 1;
      }
      names.push(value);
      continue;
    }
    const nextValue = argv[index + 1];
    const value = inlineValue ?? (nextValue && !nextValue.startsWith("--") ? nextValue : true);
    if (inlineValue === undefined && value === nextValue) {
      index += 1;
    }
    args.set(rawKey, value);
  }
  return { args, names };
}

async function main() {
  const { args, names } = parseCliArgs(process.argv.slice(2));
  const report = await generateAaisPrivateEnvTemplate({
    vercelEnvReportPath: args.get("vercel-env-report"),
    outputPath: args.get("output"),
    reportPath: args.get("report"),
    baseUrl: args.get("base-url"),
    environment: args.get("environment"),
    releaseId: args.get("release-id"),
    deploymentGitCommit: args.get("deployment-git-commit"),
    names,
  });
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : "AAIS private env template generation failed."}\n`);
    process.exitCode = 1;
  });
}
