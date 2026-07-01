#!/usr/bin/env node

import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { Pool } from "pg";

const productionDatabaseUrlEnvNames = [
  "AAIS_DATABASE_URL",
  "DATABASE_URL",
  "POSTGRES_URL",
  "POSTGRES_PRISMA_URL",
  "DATABASE_URL_UNPOOLED",
  "POSTGRES_URL_NON_POOLING",
];

export async function runAaisPostgresRestoreRehearsal(input = {}) {
  const envValues = await readEnvFile(input.envFilePath);
  const databaseUrl = requireValue(
    input.databaseUrl ?? envValues.get("AAIS_RESTORE_DATABASE_URL") ?? process.env.AAIS_RESTORE_DATABASE_URL,
    "AAIS_RESTORE_DATABASE_URL",
  );
  const sourceDatabaseUrls = getProductionDatabaseUrls(input.sourceDatabaseUrl);
  const sameAsSource = sourceDatabaseUrls.some((sourceDatabaseUrl) => (
    normalizeDatabaseUrl(databaseUrl) === normalizeDatabaseUrl(sourceDatabaseUrl)
  ));
  if (sameAsSource && !input.allowSameDatabase) {
    throw new Error("AAIS restore rehearsal target must differ from production database sources.");
  }

  const smokeStudentId = requireSafeStudentId(input.smokeStudentId ?? `restore-smoke-${Date.now()}`);
  const checkedAt = (input.now ?? new Date()).toISOString();
  const releaseId = readReleaseId(input.releaseId ?? process.env.AAIS_RELEASE_ID);
  const databaseProvider = getVerifiedDatabaseProvider({
    databaseUrl,
    configuredProvider: input.databaseProvider
      ?? envValues.get("AAIS_RESTORE_DATABASE_PROVIDER")
      ?? process.env.AAIS_RESTORE_DATABASE_PROVIDER,
  });
  const database = input.database ?? createDatabaseClient(databaseUrl);
  const checks = {
    tablePresent: false,
    existingSessionCount: 0,
    smokeInserted: false,
    smokeReadBack: false,
    smokeDeleted: false,
  };

  try {
    const table = await database.query("select to_regclass('public.aais_learner_sessions') as table_name");
    checks.tablePresent = table.rows[0]?.table_name === "aais_learner_sessions";
    if (checks.tablePresent) {
      const count = await database.query("select count(*)::int as session_count from aais_learner_sessions");
      checks.existingSessionCount = Number(count.rows[0]?.session_count ?? 0);

      const payload = createSmokeSessionPayload(smokeStudentId, checkedAt);
      await database.query(
        `insert into aais_learner_sessions (student_id, payload, updated_at)
         values ($1, $2::jsonb, now())
         on conflict (student_id)
         do update set payload = excluded.payload, updated_at = now()`,
        [smokeStudentId, JSON.stringify(payload)],
      );
      checks.smokeInserted = true;

      const readBack = await database.query(
        "select payload from aais_learner_sessions where student_id = $1 limit 1",
        [smokeStudentId],
      );
      const readBackPayload = parsePayload(readBack.rows[0]?.payload);
      checks.smokeReadBack = readBackPayload?.studentId === smokeStudentId
        && readBackPayload?.schemaVersion === 1;
    }
  } catch {
    // Keep the report redacted; the individual checks carry enough release evidence.
  } finally {
    try {
      if (checks.smokeInserted) {
        await database.query(
          "delete from aais_learner_sessions where student_id = $1",
          [smokeStudentId],
        );
        checks.smokeDeleted = true;
      }
    } catch {
      checks.smokeDeleted = false;
    }
    if (typeof database.end === "function") {
      await database.end();
    }
  }

  const report = {
    schemaVersion: 1,
    status: checks.tablePresent
      && checks.smokeInserted
      && checks.smokeReadBack
      && checks.smokeDeleted
      ? "passed"
      : "failed",
    checkedAt,
    ...(releaseId ? { release: { id: releaseId } } : {}),
    target: {
      databaseUrl: "redacted",
      provider: databaseProvider,
      sameAsSource,
    },
    checks,
    redaction: {
      secrets: "omitted",
    },
  };

  const outputPath = input.outputPath ?? process.env.AAIS_RESTORE_REHEARSAL_REPORT_PATH;
  if (outputPath) {
    await mkdir(path.dirname(outputPath), { recursive: true });
    await writeFile(outputPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  }

  return report;
}

async function readEnvFile(filePath) {
  const resolvedPath = String(filePath ?? "").trim();
  if (!resolvedPath) {
    return new Map();
  }
  const raw = await readFile(resolvedPath, "utf8");
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

function createDatabaseClient(databaseUrl) {
  return new Pool({ connectionString: databaseUrl });
}

function createSmokeSessionPayload(studentId, now) {
  return {
    schemaVersion: 1,
    studentId,
    createdAt: now,
    updatedAt: now,
    activeTaskId: "training_task_1",
    activeStage: "restore-rehearsal",
    tasks: [],
    guideMessages: [],
    events: [],
  };
}

function parsePayload(payload) {
  if (!payload) {
    return null;
  }
  if (typeof payload === "string") {
    return JSON.parse(payload);
  }
  return payload;
}

function normalizeDatabaseUrl(value) {
  const trimmed = String(value ?? "").trim();
  try {
    const url = new URL(trimmed);
    const port = url.port ? `:${url.port}` : "";
    return `${url.protocol.toLowerCase()}//${url.hostname.toLowerCase()}${port}${url.pathname}`;
  } catch {
    return trimmed;
  }
}

function getProductionDatabaseUrls(explicitSourceDatabaseUrl) {
  const urls = [];
  appendDatabaseUrl(urls, explicitSourceDatabaseUrl);
  for (const name of productionDatabaseUrlEnvNames) {
    appendDatabaseUrl(urls, process.env[name]);
  }
  appendDatabaseUrl(urls, buildRawDatabaseUrl({
    host: process.env.PGHOST ?? process.env.PGHOST_UNPOOLED,
    port: process.env.PGPORT,
    database: process.env.PGDATABASE,
  }));
  appendDatabaseUrl(urls, buildRawDatabaseUrl({
    host: process.env.POSTGRES_HOST ?? process.env.POSTGRES_HOST_NON_POOLING,
    port: process.env.POSTGRES_PORT,
    database: process.env.POSTGRES_DATABASE,
  }));
  return urls;
}

function appendDatabaseUrl(urls, value) {
  const trimmed = String(value ?? "").trim();
  if (!trimmed || isPlaceholderValue(trimmed)) {
    return;
  }
  urls.push(trimmed);
}

function buildRawDatabaseUrl(input) {
  const host = String(input.host ?? "").trim();
  const database = String(input.database ?? "").trim();
  if (!host || !database) {
    return "";
  }
  const url = new URL("postgres://production-source");
  url.hostname = host;
  if (input.port) {
    url.port = String(input.port).trim();
  }
  url.pathname = `/${database}`;
  return url.toString();
}

function requireValue(value, label) {
  const trimmed = String(value ?? "").trim();
  if (!trimmed || isPlaceholderValue(trimmed)) {
    throw new Error(`${label} is required for AAIS restore rehearsal.`);
  }
  return trimmed;
}

function isPlaceholderValue(value) {
  return /^<REQUIRED:[A-Z0-9_:-]+>$/i.test(String(value ?? "").trim());
}

function requireSafeStudentId(value) {
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(value)) {
    throw new Error("Invalid AAIS restore smoke student id.");
  }
  return value;
}

function readReleaseId(value) {
  const trimmed = String(value ?? "").trim();
  return /^[A-Za-z0-9][A-Za-z0-9._:-]{2,127}$/.test(trimmed) ? trimmed : null;
}

function readDatabaseProvider(value) {
  const trimmed = String(value ?? "").trim().toLowerCase();
  return trimmed === "neon" || trimmed === "postgres" ? trimmed : null;
}

function getVerifiedDatabaseProvider({ databaseUrl, configuredProvider }) {
  const inferred = inferDatabaseProvider(databaseUrl);
  const requested = readDatabaseProvider(configuredProvider);
  if (requested && requested !== inferred) {
    throw new Error("AAIS restore database provider must match the database URL host.");
  }
  return requested ?? inferred;
}

function inferDatabaseProvider(databaseUrl) {
  try {
    const hostname = new URL(databaseUrl).hostname.toLowerCase();
    return hostname.endsWith(".neon.tech") ? "neon" : "postgres";
  } catch {
    return "postgres";
  }
}

function parseCliArgs(argv) {
  const args = new Map();
  for (let index = 0; index < argv.length; index += 1) {
    const current = argv[index];
    if (!current.startsWith("--")) {
      continue;
    }
    const [rawKey, inlineValue] = current.slice(2).split("=");
    const value = inlineValue ?? argv[index + 1];
    if (inlineValue === undefined) {
      index += 1;
    }
    args.set(rawKey, value);
  }
  return args;
}

async function main() {
  const args = parseCliArgs(process.argv.slice(2));
  const report = await runAaisPostgresRestoreRehearsal({
    databaseUrl: args.get("database-url"),
    envFilePath: args.get("env-file"),
    sourceDatabaseUrl: args.get("source-database-url"),
    outputPath: args.get("output"),
    smokeStudentId: args.get("smoke-student-id"),
    releaseId: args.get("release-id"),
    databaseProvider: args.get("database-provider"),
  });
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  if (report.status !== "passed") {
    process.exitCode = 1;
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : "AAIS restore rehearsal failed."}\n`);
    process.exitCode = 1;
  });
}
