#!/usr/bin/env node

import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { verifyAaisOidcConfiguration } from "./verify-oidc-configuration.mjs";

const defaultBaseUrl = "https://www.aais.site";
const defaultPrivateEnvFilePath = ".env.production.local";
const defaultOutputPath = "output/aais-oidc-onboarding-report-latest.json";
const defaultMarkdownOutputPath = "output/aais-oidc-onboarding-report-latest.md";
const defaultReleaseId = "aais-2026-06-30-rc-live-ai-deepseek-v4-pro";

const requiredOidcNames = [
  "AAIS_OIDC_ISSUER",
  "AAIS_OIDC_CLIENT_ID",
  "AAIS_OIDC_CLIENT_SECRET",
  "AAIS_OIDC_REDIRECT_URI",
];

const roleMappingNames = [
  "AAIS_OIDC_TEACHER_GROUPS",
  "AAIS_OIDC_TEACHER_EMAILS",
  "AAIS_OIDC_ADMIN_GROUPS",
  "AAIS_OIDC_ADMIN_EMAILS",
];

const explicitEndpointNames = [
  "AAIS_OIDC_AUTHORIZATION_ENDPOINT",
  "AAIS_OIDC_TOKEN_ENDPOINT",
  "AAIS_OIDC_JWKS_URI",
];

export async function prepareAaisOidcSso(input = {}) {
  const generatedAt = (input.now ?? new Date()).toISOString();
  const baseUrl = normalizeBaseUrl(input.baseUrl ?? process.env.AAIS_RELEASE_DEPLOYMENT_URL ?? defaultBaseUrl);
  const privateEnvFilePath = input.envFilePath ?? defaultPrivateEnvFilePath;
  const releaseId = readSafeReleaseId(input.releaseId ?? process.env.AAIS_RELEASE_ID ?? defaultReleaseId);
  const callbackUrl = `${baseUrl}/api/auth/oidc/callback`;
  const validation = await verifyAaisOidcConfiguration({
    envFilePath: privateEnvFilePath,
    baseUrl,
    fetchImpl: input.fetchImpl ?? fetch,
    now: input.now,
  });
  const report = {
    schemaVersion: 1,
    status: validation.status === "passed" ? "ready-for-vercel-provisioning" : "action-required",
    generatedAt,
    release: {
      id: releaseId,
    },
    target: {
      baseUrl,
      callbackUrl,
    },
    idpRegistration: {
      applicationType: "confidential-web-application",
      redirectUris: [callbackUrl],
      responseType: "code",
      grantType: "authorization_code",
      pkce: {
        required: true,
        method: "S256",
      },
      scopes: ["openid", "email", "profile"],
      requiredClaims: ["sub", "email", "email_verified"],
      educatorRoleClaims: ["groups", "roles", "role"],
      postLoginLandingPath: "/learning",
    },
    env: {
      privateEnvFilePath,
      requiredNames: requiredOidcNames,
      acceptedRoleMappingNames: roleMappingNames,
      optionalExplicitEndpointNames: explicitEndpointNames,
      explicitEndpointRule: "all-or-none",
    },
    validation: sanitizeValidation(validation),
    commands: buildCommands({ privateEnvFilePath, baseUrl, releaseId }),
    redaction: {
      secrets: "omitted",
      values: "not-output",
      transientEvidence: "not-stored",
    },
  };

  const outputPath = input.outputPath ?? defaultOutputPath;
  if (outputPath) {
    await writeTextFile(outputPath, `${JSON.stringify(report, null, 2)}\n`);
  }
  const markdownOutputPath = input.markdownOutputPath ?? defaultMarkdownOutputPath;
  if (markdownOutputPath) {
    await writeTextFile(markdownOutputPath, renderMarkdown(report));
  }
  return report;
}

function sanitizeValidation(validation) {
  return {
    status: validation.status,
    required: {
      present: readSafeEnvNames(validation.required?.present),
      missing: readSafeEnvNames(validation.required?.missing),
      placeholders: readSafeEnvNames(validation.required?.placeholders),
    },
    roleMapping: {
      status: validation.roleMapping?.status === "passed" ? "passed" : "failed",
      present: readSafeEnvNames(validation.roleMapping?.present),
      missing: validation.roleMapping?.missing === true,
      placeholders: readSafeEnvNames(validation.roleMapping?.placeholders),
      invalid: readSafeEnvNames(validation.roleMapping?.invalid),
      acceptedNames: roleMappingNames,
    },
    redirectUri: {
      status: validation.redirectUri?.status === "passed" ? "passed" : "failed",
      usesHttps: validation.redirectUri?.usesHttps === true,
      matchesExpectedCallback: validation.redirectUri?.matchesExpectedCallback === true,
      expectedCallback: validation.redirectUri?.expectedCallback,
    },
    discovery: sanitizeDiscovery(validation.discovery),
  };
}

function sanitizeDiscovery(discovery) {
  const mode = typeof discovery?.mode === "string" ? discovery.mode : "skipped";
  return {
    status: ["passed", "failed", "skipped"].includes(discovery?.status) ? discovery.status : "failed",
    mode,
    ...(typeof discovery?.reason === "string" ? { reason: discovery.reason } : {}),
    ...(Number.isInteger(discovery?.httpStatus) ? { httpStatus: discovery.httpStatus } : {}),
    ...(Array.isArray(discovery?.present) ? { present: readSafeEnvNames(discovery.present) } : {}),
    ...(Array.isArray(discovery?.missing) ? { missing: readSafeEnvNames(discovery.missing) } : {}),
    ...(Array.isArray(discovery?.placeholders) ? { placeholders: readSafeEnvNames(discovery.placeholders) } : {}),
    ...safeBooleanFields(discovery, [
      "issuerMatches",
      "authorizationEndpointHttps",
      "tokenEndpointHttps",
      "jwksUriHttps",
      "supportsCodeFlow",
      "supportsOpenidScope",
    ]),
  };
}

function safeBooleanFields(source, names) {
  return Object.fromEntries(
    names
      .filter((name) => typeof source?.[name] === "boolean")
      .map((name) => [name, source[name]]),
  );
}

function buildCommands({ privateEnvFilePath, baseUrl, releaseId }) {
  return {
    validateLocalConfig: [
      "npm run verify:oidc-config --",
      `--env-file ${privateEnvFilePath}`,
      `--base-url ${baseUrl}`,
      "--output output/aais-oidc-config-report-latest.json",
    ].join(" "),
    dryRunVercelProvision: [
      "npm run provision:vercel-env --",
      `--env-file ${privateEnvFilePath}`,
      "--report output/aais-vercel-env-report-latest.json",
      `--release-id ${releaseId}`,
      "--deployment-git-commit <git-sha>",
      "--output output/aais-vercel-env-provision-dry-run-latest.json",
    ].join(" "),
    applyVercelProvision: [
      "npm run provision:vercel-env --",
      `--env-file ${privateEnvFilePath}`,
      "--report output/aais-vercel-env-report-latest.json",
      `--release-id ${releaseId}`,
      "--deployment-git-commit <git-sha>",
      "--apply",
      "--output output/aais-vercel-env-provision-apply-latest.json",
    ].join(" "),
    deployAfterProvision: "vercel deploy --prod -y --no-wait",
    realCallbackSmoke: [
      "AAIS_VERIFY_OIDC_CALLBACK_URL=<REQUIRED:TRANSIENT_OIDC_CALLBACK_URL>",
      "AAIS_VERIFY_OIDC_STATE_COOKIE=<REQUIRED:TRANSIENT_OIDC_STATE_COOKIE>",
      "npm run verify:enterprise --",
      `--base-url ${baseUrl}`,
      `--release-id ${releaseId}`,
      "--output output/aais-enterprise-report-latest.json",
    ].join(" "),
    teacherCohortSmoke: [
      "AAIS_VERIFY_OIDC_CALLBACK_URL=<REQUIRED:TRANSIENT_TEACHER_OR_ADMIN_OIDC_CALLBACK_URL>",
      "AAIS_VERIFY_OIDC_STATE_COOKIE=<REQUIRED:TRANSIENT_TEACHER_OR_ADMIN_OIDC_STATE_COOKIE>",
      "AAIS_VERIFY_EXPECTED_SESSION_ROLE=teacher",
      "AAIS_VERIFY_REQUIRE_COHORT_ANALYTICS=true",
      "npm run verify:enterprise --",
      `--base-url ${baseUrl}`,
      "--require-sso-only",
      `--release-id ${releaseId}`,
      "--output output/aais-enterprise-report-latest.json",
    ].join(" "),
  };
}

function renderMarkdown(report) {
  return [
    "# AAIS OIDC SSO Onboarding",
    "",
    `Status: ${report.status}`,
    `Generated: ${report.generatedAt}`,
    `Callback URL: ${report.target.callbackUrl}`,
    "",
    "## IdP Registration",
    "",
    `- application type: ${report.idpRegistration.applicationType}`,
    `- redirect URI: ${report.target.callbackUrl}`,
    `- response type: ${report.idpRegistration.responseType}`,
    `- grant type: ${report.idpRegistration.grantType}`,
    `- PKCE: ${report.idpRegistration.pkce.method}`,
    `- scopes: ${report.idpRegistration.scopes.join(", ")}`,
    `- required claims: ${report.idpRegistration.requiredClaims.join(", ")}`,
    `- educator role claims: ${report.idpRegistration.educatorRoleClaims.join(", ")}`,
    "",
    "## Environment",
    "",
    `- private env: ${report.env.privateEnvFilePath}`,
    `- required names: ${report.env.requiredNames.join(", ")}`,
    `- accepted role mapping names: ${report.env.acceptedRoleMappingNames.join(", ")}`,
    `- optional explicit endpoints: ${report.env.optionalExplicitEndpointNames.join(", ")}`,
    `- explicit endpoint rule: ${report.env.explicitEndpointRule}`,
    "",
    "## Validation",
    "",
    `- config: ${report.validation.status}`,
    `- required missing: ${report.validation.required.missing.join(", ") || "none"}`,
    `- required placeholders: ${report.validation.required.placeholders.join(", ") || "none"}`,
    `- role mapping: ${report.validation.roleMapping.status}`,
    `- redirect URI: ${report.validation.redirectUri.status}`,
    `- discovery: ${report.validation.discovery.status}`,
    "",
    "## Commands",
    "",
    `- ${report.commands.validateLocalConfig}`,
    `- ${report.commands.dryRunVercelProvision}`,
    `- ${report.commands.applyVercelProvision}`,
    `- ${report.commands.deployAfterProvision}`,
    `- ${report.commands.realCallbackSmoke}`,
    `- ${report.commands.teacherCohortSmoke}`,
    "",
    "## Redaction",
    "",
    "- Secrets and transient OIDC callback evidence are omitted.",
    "",
  ].join("\n");
}

async function writeTextFile(filePath, text) {
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, text, "utf8");
}

function normalizeBaseUrl(value) {
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
  return /^[A-Za-z0-9][A-Za-z0-9._:-]{2,127}$/.test(trimmed) ? trimmed : defaultReleaseId;
}

function readSafeEnvNames(value) {
  return Array.isArray(value)
    ? value
      .map((item) => String(item ?? "").trim())
      .filter((item) => /^[A-Z][A-Z0-9_]{1,127}$/.test(item))
    : [];
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
  const report = await prepareAaisOidcSso({
    envFilePath: args.get("env-file"),
    baseUrl: args.get("base-url"),
    outputPath: args.get("output"),
    markdownOutputPath: args.get("markdown-output"),
    releaseId: args.get("release-id"),
  });
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : "AAIS OIDC SSO onboarding preparation failed."}\n`);
    process.exitCode = 1;
  });
}
