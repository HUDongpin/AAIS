#!/usr/bin/env node

import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

const requiredOidcNames = [
  "AAIS_OIDC_ISSUER",
  "AAIS_OIDC_CLIENT_ID",
  "AAIS_OIDC_CLIENT_SECRET",
  "AAIS_OIDC_REDIRECT_URI",
];

const explicitEndpointNames = [
  "AAIS_OIDC_AUTHORIZATION_ENDPOINT",
  "AAIS_OIDC_TOKEN_ENDPOINT",
  "AAIS_OIDC_JWKS_URI",
];

const oidcRoleMappingNames = [
  "AAIS_OIDC_TEACHER_GROUPS",
  "AAIS_OIDC_TEACHER_EMAILS",
  "AAIS_OIDC_ADMIN_GROUPS",
  "AAIS_OIDC_ADMIN_EMAILS",
];

const oidcEmailRoleMappingNames = new Set([
  "AAIS_OIDC_TEACHER_EMAILS",
  "AAIS_OIDC_ADMIN_EMAILS",
]);

const defaultBaseUrl = "https://www.aais.site";
const defaultCallbackPath = "/api/auth/oidc/callback";

export async function verifyAaisOidcConfiguration(input = {}) {
  const checkedAt = (input.now ?? new Date()).toISOString();
  const envValues = input.envValues instanceof Map
    ? input.envValues
    : await readEnvironmentValues(input.envFilePath);
  const baseUrl = normalizeBaseUrl(input.baseUrl ?? process.env.AAIS_RELEASE_DEPLOYMENT_URL ?? defaultBaseUrl);
  const callbackPath = normalizeCallbackPath(input.callbackPath ?? defaultCallbackPath);
  const expectedCallback = `${baseUrl}${callbackPath}`;
  const required = getRequiredStatus(envValues);
  const roleMapping = getRoleMappingStatus(envValues);
  const redirectUri = getRedirectUriStatus(envValues.get("AAIS_OIDC_REDIRECT_URI"), expectedCallback);
  const baseConfigValid = required.missing.length === 0
    && required.placeholders.length === 0
    && redirectUri.status === "passed"
    && isHttpsUrl(envValues.get("AAIS_OIDC_ISSUER"));
  const discovery = await getDiscoveryStatus({
    envValues,
    baseConfigValid,
    fetchImpl: input.fetchImpl ?? fetch,
  });

  const report = {
    schemaVersion: 1,
    status: required.missing.length === 0
      && required.placeholders.length === 0
      && roleMapping.status === "passed"
      && redirectUri.status === "passed"
      && discovery.status === "passed"
      ? "passed"
      : "failed",
    checkedAt,
    target: {
      baseUrl,
      callbackPath,
    },
    required,
    roleMapping,
    redirectUri,
    discovery,
    redaction: {
      secrets: "omitted",
      values: "not-output",
    },
  };

  const outputPath = input.outputPath ?? process.env.AAIS_OIDC_CONFIG_REPORT_PATH;
  if (outputPath) {
    await mkdir(path.dirname(outputPath), { recursive: true });
    await writeFile(outputPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  }

  return report;
}

async function readEnvironmentValues(envFilePath) {
  const values = new Map();
  const acceptedNames = [...requiredOidcNames, ...explicitEndpointNames, ...oidcRoleMappingNames];
  for (const name of acceptedNames) {
    const value = process.env[name]?.trim();
    if (value) {
      values.set(name, value);
    }
  }

  const resolvedPath = String(envFilePath ?? "").trim();
  if (!resolvedPath) {
    return values;
  }

  let raw = "";
  try {
    raw = await readFile(resolvedPath, "utf8");
  } catch (error) {
    if (error?.code !== "ENOENT") {
      throw error;
    }
  }

  for (const rawLine of raw.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) {
      continue;
    }
    const normalized = line.startsWith("export ") ? line.slice("export ".length).trim() : line;
    const separator = normalized.indexOf("=");
    if (separator <= 0) {
      continue;
    }
    const name = normalized.slice(0, separator).trim();
    if (!acceptedNames.includes(name)) {
      continue;
    }
    values.set(name, parseEnvValue(normalized.slice(separator + 1).trim()));
  }

  return values;
}

function getRequiredStatus(values) {
  const missing = [];
  const placeholders = [];
  const present = [];
  for (const name of requiredOidcNames) {
    const value = values.get(name)?.trim();
    if (!value) {
      missing.push(name);
    } else if (isPlaceholderValue(value)) {
      placeholders.push(name);
    } else {
      present.push(name);
    }
  }
  return {
    present,
    missing,
    placeholders,
  };
}

function getRoleMappingStatus(values) {
  const present = [];
  const placeholders = [];
  const invalid = [];
  for (const name of oidcRoleMappingNames) {
    const value = values.get(name)?.trim();
    if (!value) {
      continue;
    }
    const entries = value.split(",").map((entry) => entry.trim()).filter(Boolean);
    if (isPlaceholderValue(value) || entries.some(isPlaceholderValue)) {
      placeholders.push(name);
      continue;
    }
    if (!entries.length || !entries.every((entry) => isValidRoleMappingEntry(name, entry))) {
      invalid.push(name);
      continue;
    }
    present.push(name);
  }
  const missing = present.length === 0 && placeholders.length === 0 && invalid.length === 0;
  return {
    status: !missing && placeholders.length === 0 && invalid.length === 0 ? "passed" : "failed",
    present,
    missing,
    placeholders,
    invalid,
    acceptedNames: oidcRoleMappingNames,
  };
}

function isValidRoleMappingEntry(name, value) {
  if (oidcEmailRoleMappingNames.has(name)) {
    return /^[^\s@,]+@[^\s@,]+\.[^\s@,]+$/.test(value);
  }
  return value.length <= 128 && !/[\u0000-\u001F\u007F,]/.test(value);
}

function getRedirectUriStatus(value, expectedCallback) {
  const trimmed = String(value ?? "").trim();
  const usesHttps = isHttpsUrl(trimmed);
  const matchesExpectedCallback = trimmed === expectedCallback;
  return {
    status: usesHttps && matchesExpectedCallback ? "passed" : "failed",
    usesHttps,
    matchesExpectedCallback,
    expectedCallback,
  };
}

async function getDiscoveryStatus({ envValues, baseConfigValid, fetchImpl }) {
  if (!baseConfigValid) {
    return {
      status: "skipped",
      reason: "base-config-invalid",
    };
  }

  const explicit = getExplicitEndpointStatus(envValues);
  if (explicit.partial) {
    return {
      status: "failed",
      mode: "explicit-endpoints",
      reason: "explicit_endpoints_incomplete",
      present: explicit.present,
      missing: explicit.missing,
      placeholders: explicit.placeholders,
      authorizationEndpointHttps: explicit.authorizationEndpointHttps,
      tokenEndpointHttps: explicit.tokenEndpointHttps,
      jwksUriHttps: explicit.jwksUriHttps,
    };
  }
  if (explicit.complete) {
    return {
      status: explicit.valid ? "passed" : "failed",
      mode: "explicit-endpoints",
      present: explicit.present,
      missing: explicit.missing,
      placeholders: explicit.placeholders,
      authorizationEndpointHttps: explicit.authorizationEndpointHttps,
      tokenEndpointHttps: explicit.tokenEndpointHttps,
      jwksUriHttps: explicit.jwksUriHttps,
      ...(explicit.valid ? {} : { reason: "explicit_endpoints_invalid" }),
    };
  }

  const issuer = envValues.get("AAIS_OIDC_ISSUER").trim().replace(/\/+$/, "");
  let response;
  try {
    response = await fetchImpl(`${issuer}/.well-known/openid-configuration`, {
      headers: {
        accept: "application/json",
      },
    });
  } catch {
    return {
      status: "failed",
      mode: "issuer-discovery",
      reason: "discovery_unreachable",
      httpStatus: null,
    };
  }
  if (!response?.ok) {
    return {
      status: "failed",
      mode: "issuer-discovery",
      reason: "discovery_unreachable",
      httpStatus: Number.isInteger(response?.status) ? response.status : null,
    };
  }

  const metadata = await response.json().catch(() => null);
  const endpointChecks = {
    issuerMatches: metadata?.issuer === issuer,
    authorizationEndpointHttps: isHttpsUrl(metadata?.authorization_endpoint),
    tokenEndpointHttps: isHttpsUrl(metadata?.token_endpoint),
    jwksUriHttps: isHttpsUrl(metadata?.jwks_uri),
    supportsCodeFlow: Array.isArray(metadata?.response_types_supported)
      && metadata.response_types_supported.includes("code"),
    supportsOpenidScope: Array.isArray(metadata?.scopes_supported)
      && metadata.scopes_supported.includes("openid"),
  };
  const valid = Object.values(endpointChecks).every(Boolean);
  return {
    status: valid ? "passed" : "failed",
    mode: "issuer-discovery",
    ...endpointChecks,
    ...(valid ? {} : { reason: "discovery_invalid" }),
  };
}

function getExplicitEndpointStatus(values) {
  const present = [];
  const missing = [];
  const placeholders = [];
  for (const name of explicitEndpointNames) {
    const value = values.get(name)?.trim();
    if (!value) {
      missing.push(name);
    } else if (isPlaceholderValue(value)) {
      placeholders.push(name);
    } else {
      present.push(name);
    }
  }
  const authorizationEndpointHttps = isHttpsUrl(values.get("AAIS_OIDC_AUTHORIZATION_ENDPOINT"));
  const tokenEndpointHttps = isHttpsUrl(values.get("AAIS_OIDC_TOKEN_ENDPOINT"));
  const jwksUriHttps = isHttpsUrl(values.get("AAIS_OIDC_JWKS_URI"));
  const anyConfigured = present.length > 0 || placeholders.length > 0;
  const complete = explicitEndpointNames.every((name) => values.has(name) && values.get(name)?.trim())
    && placeholders.length === 0;
  return {
    present,
    missing,
    placeholders,
    partial: anyConfigured && !complete,
    complete,
    valid: complete && authorizationEndpointHttps && tokenEndpointHttps && jwksUriHttps,
    authorizationEndpointHttps,
    tokenEndpointHttps,
    jwksUriHttps,
  };
}

function normalizeBaseUrl(value) {
  const parsed = parseUrl(value);
  if (!parsed || parsed.protocol !== "https:") {
    return defaultBaseUrl;
  }
  parsed.pathname = parsed.pathname.replace(/\/+$/, "");
  parsed.search = "";
  parsed.hash = "";
  return parsed.toString().replace(/\/+$/, "");
}

function normalizeCallbackPath(value) {
  const pathValue = String(value ?? "").trim();
  return pathValue.startsWith("/") && !pathValue.startsWith("//")
    ? pathValue
    : defaultCallbackPath;
}

function isHttpsUrl(value) {
  return parseUrl(value)?.protocol === "https:";
}

function parseUrl(value) {
  try {
    const parsed = new URL(String(value ?? "").trim());
    return parsed.hostname ? parsed : null;
  } catch {
    return null;
  }
}

function parseEnvValue(value) {
  if (value.length >= 2 && value.startsWith("\"") && value.endsWith("\"")) {
    return value
      .slice(1, -1)
      .replace(/\\n/g, "\n")
      .replace(/\\r/g, "\r")
      .replace(/\\t/g, "\t")
      .replace(/\\"/g, "\"")
      .replace(/\\\\/g, "\\");
  }
  if (value.length >= 2 && value.startsWith("'") && value.endsWith("'")) {
    return value.slice(1, -1);
  }
  return value;
}

function isPlaceholderValue(value) {
  return /^<REQUIRED:[A-Z0-9_:-]+>$/i.test(String(value ?? "").trim());
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
  const report = await verifyAaisOidcConfiguration({
    envFilePath: args.get("env-file"),
    baseUrl: args.get("base-url"),
    callbackPath: args.get("callback-path"),
    outputPath: args.get("output"),
  });
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  if (report.status !== "passed") {
    process.exitCode = 1;
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : "AAIS OIDC configuration verification failed."}\n`);
    process.exitCode = 1;
  });
}
