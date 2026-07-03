#!/usr/bin/env node

import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

const defaultApiBaseUrl = "https://console.neon.tech/api/v2";
const defaultOutputEnvPath = ".env.postgres-restore.local";
const defaultReportPath = "output/aais-neon-restore-env-report-latest.json";
const defaultReleaseId = "aais-2026-06-30-rc-live-ai-deepseek-v4-pro";

export async function prepareAaisNeonRestoreEnv(input = {}) {
  const checkedAt = (input.now ?? new Date()).toISOString();
  const envValues = await readEnvFile(input.neonEnvFilePath);
  const releaseId = readSafeReleaseId(readConfig(input, envValues, "releaseId", ["AAIS_RELEASE_ID"]) ?? defaultReleaseId);
  const apiKey = requireValue(readConfig(input, envValues, "apiKey", ["NEON_API_KEY"]), "NEON_API_KEY");
  const projectId = requireSafeToken(readConfig(input, envValues, "projectId", ["NEON_PROJECT_ID"]), "NEON_PROJECT_ID");
  const existingBranchId = readOptionalSafeToken(
    readConfig(input, envValues, "existingBranchId", ["AAIS_RESTORE_BRANCH_ID", "NEON_RESTORE_BRANCH_ID"]),
    "AAIS_RESTORE_BRANCH_ID",
  );
  const parentBranchId = readOptionalSafeToken(
    readConfig(input, envValues, "parentBranchId", [
      "AAIS_RESTORE_PARENT_BRANCH_ID",
      "NEON_PARENT_BRANCH_ID",
      "NEON_SOURCE_BRANCH_ID",
    ]),
    "AAIS_RESTORE_PARENT_BRANCH_ID",
  );
  const parentTimestamp = readOptionalIsoTimestamp(
    readConfig(input, envValues, "parentTimestamp", [
      "AAIS_RESTORE_PARENT_TIMESTAMP",
      "NEON_RESTORE_PARENT_TIMESTAMP",
    ]),
  );
  const databaseName = requireSafeIdentifier(
    readConfig(input, envValues, "databaseName", ["AAIS_RESTORE_DATABASE_NAME", "NEON_DATABASE_NAME", "PGDATABASE"]),
    "AAIS_RESTORE_DATABASE_NAME",
  );
  const roleName = requireSafeIdentifier(
    readConfig(input, envValues, "roleName", ["AAIS_RESTORE_ROLE_NAME", "NEON_ROLE_NAME", "PGUSER"]),
    "AAIS_RESTORE_ROLE_NAME",
  );
  const branchName = readSafeBranchName(
    readConfig(input, envValues, "branchName", ["AAIS_RESTORE_BRANCH_NAME", "NEON_RESTORE_BRANCH_NAME"])
      ?? buildDefaultBranchName({ releaseId, checkedAt }),
  );
  const pooled = readBoolean(readConfig(input, envValues, "pooled", ["AAIS_RESTORE_DATABASE_POOLED"]), true);
  const outputEnvPath = input.outputEnvPath ?? defaultOutputEnvPath;
  const reportPath = input.reportPath ?? defaultReportPath;
  const fetchImpl = input.fetchImpl ?? globalThis.fetch;
  if (typeof fetchImpl !== "function") {
    throw new Error("AAIS Neon restore preparation requires fetch.");
  }

  const client = createNeonApiClient({
    apiBaseUrl: input.apiBaseUrl ?? defaultApiBaseUrl,
    apiKey,
    fetchImpl,
  });
  const branch = existingBranchId
    ? {
        id: existingBranchId,
        name: branchName,
        mode: "existing",
      }
    : await createRestoreBranch(client, {
        projectId,
        branchName,
        parentBranchId,
        parentTimestamp,
      });
  const connectionUri = await retrieveConnectionUri(client, {
    projectId,
    branchId: branch.id,
    databaseName,
    roleName,
    pooled,
  });
  assertNeonConnectionUri(connectionUri);

  await writeRestoreEnvFile(outputEnvPath, {
    connectionUri,
    releaseId,
    branchId: branch.id,
    branchName: branch.name,
    parentBranchId,
    parentTimestamp,
  });

  const report = {
    schemaVersion: 1,
    status: "ready",
    checkedAt,
    release: {
      id: releaseId,
    },
    source: {
      provider: "neon-api",
      projectId: "redacted",
    },
    branch: {
      mode: branch.mode,
      id: "redacted",
      name: branch.name,
      parentBranchId: parentBranchId ? "redacted" : null,
      parentTimestamp: parentTimestamp ?? null,
    },
    connection: {
      databaseName,
      roleName,
      pooled,
      uri: "written-redacted",
    },
    envFile: {
      path: outputEnvPath,
      variables: [
        "AAIS_RESTORE_DATABASE_URL",
        "AAIS_RESTORE_DATABASE_PROVIDER",
        "AAIS_RESTORE_TARGET_PURPOSE",
        "AAIS_RELEASE_ID",
        "AAIS_RESTORE_BRANCH_ID",
        "AAIS_RESTORE_BRANCH_NAME",
      ],
    },
    nextCommand: [
      "npm run verify:postgres-restore --",
      `--env-file ${outputEnvPath}`,
      "--source-env-file .env.production.local",
      "--database-provider neon",
      "--target-purpose restored-staging",
      "--output ./output/aais-postgres-restore-report-latest.json",
      `--release-id ${releaseId}`,
    ].join(" "),
    redaction: {
      secrets: "omitted",
      values: "connection-uri-written-not-output",
    },
  };

  if (reportPath) {
    await mkdir(path.dirname(reportPath), { recursive: true });
    await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  }
  return report;
}

function createNeonApiClient({ apiBaseUrl, apiKey, fetchImpl }) {
  return {
    async request(method, route, body) {
      const url = `${String(apiBaseUrl).replace(/\/+$/, "")}${route}`;
      const response = await fetchImpl(url, {
        method,
        headers: {
          accept: "application/json",
          authorization: `Bearer ${apiKey}`,
          ...(body ? { "content-type": "application/json" } : {}),
        },
        ...(body ? { body: JSON.stringify(body) } : {}),
      });
      let json = null;
      try {
        json = await response.json();
      } catch {
        json = null;
      }
      if (!response.ok) {
        throw new Error(`Neon API ${method} ${route.split("?")[0]} failed with ${response.status}.`);
      }
      return json ?? {};
    },
  };
}

async function createRestoreBranch(client, { projectId, branchName, parentBranchId, parentTimestamp }) {
  const body = {
    branch: {
      name: branchName,
      ...(parentBranchId ? { parent_id: parentBranchId } : {}),
      ...(parentTimestamp ? { parent_timestamp: parentTimestamp } : {}),
    },
    endpoints: [
      {
        type: "read_write",
      },
    ],
  };
  const response = await client.request("POST", `/projects/${encodeURIComponent(projectId)}/branches`, body);
  const branch = response.branch;
  const branchId = readOptionalSafeToken(branch?.id, "branch.id");
  if (!branchId) {
    throw new Error("Neon create branch response did not include a safe branch id.");
  }
  return {
    id: branchId,
    name: readSafeBranchName(branch?.name ?? branchName),
    mode: "created",
  };
}

async function retrieveConnectionUri(client, { projectId, branchId, databaseName, roleName, pooled }) {
  const params = new URLSearchParams({
    branch_id: branchId,
    database_name: databaseName,
    role_name: roleName,
    pooled: pooled ? "true" : "false",
  });
  const response = await client.request(
    "GET",
    `/projects/${encodeURIComponent(projectId)}/connection_uri?${params.toString()}`,
  );
  const uri = String(response.uri ?? response.connection_uri ?? "").trim();
  if (!uri) {
    throw new Error("Neon connection URI response did not include a URI.");
  }
  return uri;
}

async function writeRestoreEnvFile(filePath, input) {
  const lines = [
    "# AAIS restored Neon rehearsal env.",
    "# Generated by npm run prepare:neon-restore.",
    "# Do not commit this file. Never replace this URL with the production database URL.",
    "",
    `AAIS_RESTORE_DATABASE_URL=${input.connectionUri}`,
    "AAIS_RESTORE_DATABASE_PROVIDER=neon",
    "AAIS_RESTORE_TARGET_PURPOSE=restored-staging",
    `AAIS_RELEASE_ID=${input.releaseId}`,
    `AAIS_RESTORE_BRANCH_ID=${input.branchId}`,
    `AAIS_RESTORE_BRANCH_NAME=${input.branchName}`,
    ...(input.parentBranchId ? [`AAIS_RESTORE_PARENT_BRANCH_ID=${input.parentBranchId}`] : []),
    ...(input.parentTimestamp ? [`AAIS_RESTORE_PARENT_TIMESTAMP=${input.parentTimestamp}`] : []),
    "",
  ];
  await writeTextFile(filePath, lines.join("\n"));
}

async function writeTextFile(filePath, text) {
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, text, "utf8");
}

async function readEnvFile(filePath) {
  const resolvedPath = String(filePath ?? "").trim();
  if (!resolvedPath) {
    return new Map();
  }
  let raw = "";
  try {
    raw = await readFile(resolvedPath, "utf8");
  } catch (error) {
    if (error?.code !== "ENOENT") {
      throw error;
    }
  }
  const values = new Map();
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
    if (!/^[A-Z][A-Z0-9_]{1,127}$/.test(name)) {
      continue;
    }
    values.set(name, parseEnvValue(normalized.slice(separator + 1).trim()));
  }
  return values;
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

function readConfig(input, envValues, inputKey, envNames) {
  const explicit = input[inputKey];
  if (explicit !== undefined && explicit !== null && String(explicit).trim()) {
    return explicit;
  }
  for (const envName of envNames) {
    const value = envValues.get(envName) ?? process.env[envName];
    if (value !== undefined && value !== null && String(value).trim()) {
      return value;
    }
  }
  return null;
}

function requireValue(value, label) {
  const trimmed = String(value ?? "").trim();
  if (!trimmed || isPlaceholderValue(trimmed)) {
    throw new Error(`${label} is required for AAIS Neon restore preparation.`);
  }
  return trimmed;
}

function requireSafeToken(value, label) {
  const token = readOptionalSafeToken(requireValue(value, label), label);
  if (!token) {
    throw new Error(`${label} must be a safe Neon identifier.`);
  }
  return token;
}

function readOptionalSafeToken(value, label) {
  const trimmed = String(value ?? "").trim();
  if (!trimmed || isPlaceholderValue(trimmed)) {
    return null;
  }
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{1,127}$/.test(trimmed)) {
    throw new Error(`${label} must be a safe Neon identifier.`);
  }
  return trimmed;
}

function requireSafeIdentifier(value, label) {
  const trimmed = requireValue(value, label);
  if (!/^[A-Za-z0-9_][A-Za-z0-9_.$-]{0,127}$/.test(trimmed)) {
    throw new Error(`${label} must be a safe database or role name.`);
  }
  return trimmed;
}

function readSafeBranchName(value) {
  const trimmed = requireValue(value, "AAIS_RESTORE_BRANCH_NAME");
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{1,127}$/.test(trimmed)) {
    throw new Error("AAIS_RESTORE_BRANCH_NAME must be a safe Neon branch name.");
  }
  return trimmed;
}

function readSafeReleaseId(value) {
  const trimmed = String(value ?? "").trim();
  return /^[A-Za-z0-9][A-Za-z0-9._:-]{2,127}$/.test(trimmed) ? trimmed : defaultReleaseId;
}

function readOptionalIsoTimestamp(value) {
  const trimmed = String(value ?? "").trim();
  if (!trimmed || isPlaceholderValue(trimmed)) {
    return null;
  }
  const date = new Date(trimmed);
  if (!Number.isFinite(date.getTime())) {
    throw new Error("AAIS_RESTORE_PARENT_TIMESTAMP must be a valid ISO timestamp.");
  }
  return date.toISOString();
}

function readBoolean(value, fallback) {
  const trimmed = String(value ?? "").trim().toLowerCase();
  if (!trimmed) {
    return fallback;
  }
  if (trimmed === "true" || trimmed === "1") {
    return true;
  }
  if (trimmed === "false" || trimmed === "0") {
    return false;
  }
  throw new Error("AAIS_RESTORE_DATABASE_POOLED must be true or false.");
}

function buildDefaultBranchName({ releaseId, checkedAt }) {
  const compactTime = checkedAt.replace(/[-:.TZ]/g, "").slice(0, 14);
  const safeRelease = releaseId.toLowerCase().replace(/[^a-z0-9._:-]+/g, "-").slice(0, 60);
  return `aais-restore-${safeRelease}-${compactTime}`.slice(0, 127);
}

function assertNeonConnectionUri(value) {
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new Error("Neon connection URI is not a valid URL.");
  }
  if (!["postgres:", "postgresql:"].includes(url.protocol) || !url.hostname.toLowerCase().endsWith(".neon.tech")) {
    throw new Error("Neon connection URI must be a Neon Postgres URL.");
  }
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
  const report = await prepareAaisNeonRestoreEnv({
    neonEnvFilePath: args.get("neon-env-file"),
    outputEnvPath: args.get("output-env"),
    reportPath: args.get("report"),
    projectId: args.get("project-id"),
    parentBranchId: args.get("parent-branch-id"),
    parentTimestamp: args.get("parent-timestamp"),
    existingBranchId: args.get("existing-branch-id"),
    branchName: args.get("branch-name"),
    databaseName: args.get("database-name"),
    roleName: args.get("role-name"),
    pooled: args.get("pooled"),
    releaseId: args.get("release-id"),
  });
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : "AAIS Neon restore preparation failed."}\n`);
    process.exitCode = 1;
  });
}
