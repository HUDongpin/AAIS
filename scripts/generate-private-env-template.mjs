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
  ["AAIS_OIDC_TEACHER_EMAILS", "OIDC_TEACHER_EMAILS"],
  ["AAIS_OIDC_ADMIN_GROUPS", "OIDC_ADMIN_GROUPS"],
  ["AAIS_OIDC_ADMIN_EMAILS", "OIDC_ADMIN_EMAILS"],
  ["AAIS_OIDC_AUTHORIZATION_ENDPOINT", "OIDC_AUTHORIZATION_ENDPOINT"],
  ["AAIS_OIDC_TOKEN_ENDPOINT", "OIDC_TOKEN_ENDPOINT"],
  ["AAIS_OIDC_JWKS_URI", "OIDC_JWKS_URI"],
  ["AAIS_AI_ENDPOINT", "AI_ENDPOINT"],
  ["AAIS_AI_API_KEY", "AI_API_KEY"],
  ["AAIS_AI_MODEL", "AI_MODEL"],
  ["AAIS_AI_EVAL_VERSION", "AI_EVAL_VERSION"],
]);

const oidcRequiredNames = [
  "AAIS_OIDC_ISSUER",
  "AAIS_OIDC_CLIENT_ID",
  "AAIS_OIDC_CLIENT_SECRET",
  "AAIS_OIDC_REDIRECT_URI",
];

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

const oidcNames = new Set([
  ...oidcRequiredNames,
  ...oidcRoleMappingNames,
  ...oidcExplicitEndpointNames,
]);

const liveAiEvalLocalNames = [
  "AAIS_AI_ENDPOINT",
  "AAIS_AI_API_KEY",
  "AAIS_AI_MODEL",
  "AAIS_AI_EVAL_VERSION",
];

export async function generateAaisPrivateEnvTemplate(input = {}) {
  const generatedAt = (input.now ?? new Date()).toISOString();
  const vercelEnvReportPath = input.vercelEnvReportPath ?? defaultVercelEnvReportPath;
  const enterpriseGapEvidenceReportPath = input.enterpriseGapEvidenceReportPath
    ?? process.env.AAIS_ENTERPRISE_GAP_REPORT_PATH;
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
  const gapEvidenceReport = enterpriseGapEvidenceReportPath
    ? await readJsonIfExists(enterpriseGapEvidenceReportPath)
    : null;
  const localEvidenceOnlyVariables = getLocalEvidenceOnlyVariables({
    gapEvidenceReport,
    provisionVariables: missing,
  });
  const oidcRedirectUri = `${baseUrl}/api/auth/oidc/callback`;
  const templateVariables = getTemplateVariables([...missing, ...localEvidenceOnlyVariables]);
  const validationOnlyVariables = templateVariables.filter((name) => (
    !missing.includes(name) && !localEvidenceOnlyVariables.includes(name)
  ));

  const report = {
    schemaVersion: 1,
    status: templateVariables.length > 0 ? "template-created" : "ready",
    generatedAt,
    sourceReports: {
      vercelEnv: vercelEnvReportPath,
      ...(enterpriseGapEvidenceReportPath ? { enterpriseGapEvidence: enterpriseGapEvidenceReportPath } : {}),
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
      variables: templateVariables,
      provisionVariables: missing,
      localEvidenceOnlyVariables,
      validationOnlyVariables,
    },
    suggestions: {
      storageProvider: "neon",
      canonicalStorageEnv: "AAIS_DATABASE_URL",
      ...(releaseId ? { releaseId } : {}),
      ...(deploymentGitCommit ? { deploymentGitCommit } : {}),
      oidcRedirectUri,
      oidc: {
        idpRedirectUri: oidcRedirectUri,
        requiredNames: oidcRequiredNames,
        acceptedRoleMappingNames: oidcRoleMappingNames,
        optionalExplicitEndpointNames: oidcExplicitEndpointNames,
        explicitEndpointsRule: "all-or-none",
        validationCommand: [
          "npm run verify:oidc-config --",
          `--env-file ${privateEnvFilePath}`,
          `--base-url ${baseUrl}`,
          "--output output/aais-oidc-config-report-latest.json",
        ].join(" "),
      },
      ...(localEvidenceOnlyVariables.length > 0
        ? {
          liveAiEval: {
            envFilePath: privateEnvFilePath,
            requiredNames: liveAiEvalLocalNames,
            preflightCommand: [
              "npm run verify:enterprise-gaps --",
              "--mode live-ai-eval",
              "--preflight-only",
              `--ai-eval-env-file ${privateEnvFilePath}`,
              "--output output/aais-enterprise-gap-evidence-latest.json",
              `--release-id ${releaseId ?? "<release-id>"}`,
            ].join(" "),
            evaluationCommand: [
              "npm run ai:evaluate --",
              `--env-file ${privateEnvFilePath}`,
              "--output output/aais-ai-eval-deepseek-v4-pro.json",
              "--env-json-output output/aais-ai-eval-inline-latest.json",
              "--eval-version <AAIS_AI_EVAL_VERSION>",
              `--release-id ${releaseId ?? "<release-id>"}`,
            ].join(" "),
          },
        }
        : {}),
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
    templateVariables,
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

function renderTemplate({
  environment,
  templateVariables,
  oidcRedirectUri,
  privateEnvFilePath,
  releaseId,
  deploymentGitCommit,
}) {
  const lines = [
    `# AAIS private ${environment} env template`,
    "# Do not commit this file.",
    `# Copy this template to ${privateEnvFilePath}, then fill the copy with real values.`,
    "# Rerun the dry-run, and apply only after status is ready.",
    "# Provider placeholders intentionally fail closed in provision:vercel-env.",
    "# Some OIDC names may already exist in Vercel; they are included here for local verify:oidc-config only.",
    "# Live AI eval names may be included for local evidence only; fill them only in the private env file.",
    "# provision:vercel-env applies only names requested by the Vercel env report.",
    "# For Neon, prefer AAIS_DATABASE_URL; Vercel Neon aliases are also accepted by the provisioner.",
    `# Suggested AAIS_OIDC_REDIRECT_URI: ${oidcRedirectUri}`,
    `# Register this exact OIDC callback URL with the IdP: ${oidcRedirectUri}`,
    "# Educator role mapping can use any one of AAIS_OIDC_TEACHER_GROUPS, AAIS_OIDC_TEACHER_EMAILS, AAIS_OIDC_ADMIN_GROUPS, or AAIS_OIDC_ADMIN_EMAILS.",
    "# Optional explicit OIDC endpoints are all-or-none: set AAIS_OIDC_AUTHORIZATION_ENDPOINT, AAIS_OIDC_TOKEN_ENDPOINT, and AAIS_OIDC_JWKS_URI together, or omit all three for issuer discovery.",
    "",
    ...templateVariables.map((name) => `${name}=${templateValueFor(name, {
      releaseId,
      deploymentGitCommit,
      oidcRedirectUri,
    })}`),
    "",
  ];
  return lines.join("\n");
}

function getLocalEvidenceOnlyVariables({ gapEvidenceReport, provisionVariables }) {
  const required = gapEvidenceReport?.preflight?.required ?? {};
  const gapNames = new Set([
    ...getSafeEnvNames(required.missing),
    ...getSafeEnvNames(required.placeholders),
    ...getSafeEnvNames(required.invalid),
  ]);
  const provisionNames = new Set(provisionVariables);
  return liveAiEvalLocalNames.filter((name) => gapNames.has(name) && !provisionNames.has(name));
}

function getTemplateVariables(missing) {
  const variables = [...missing];
  const hasOidcVariable = missing.some((name) => oidcNames.has(name));
  if (!hasOidcVariable) {
    return variables;
  }

  for (const name of oidcRequiredNames) {
    appendUnique(variables, name);
  }
  if (!variables.some((name) => oidcRoleMappingNames.includes(name))) {
    appendUnique(variables, "AAIS_OIDC_TEACHER_GROUPS");
  }
  if (variables.some((name) => oidcExplicitEndpointNames.includes(name))) {
    for (const name of oidcExplicitEndpointNames) {
      appendUnique(variables, name);
    }
  }
  return variables;
}

function appendUnique(values, value) {
  if (!values.includes(value)) {
    values.push(value);
  }
}

function templateValueFor(name, { releaseId, deploymentGitCommit, oidcRedirectUri }) {
  if (name === "AAIS_RELEASE_ID" && releaseId) {
    return releaseId;
  }
  if (name === "AAIS_DEPLOYMENT_GIT_COMMIT_SHA" && deploymentGitCommit) {
    return deploymentGitCommit;
  }
  if (name === "AAIS_OIDC_REDIRECT_URI") {
    return oidcRedirectUri;
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
    enterpriseGapEvidenceReportPath: args.get("gap-evidence-report"),
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
