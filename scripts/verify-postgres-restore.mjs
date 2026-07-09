#!/usr/bin/env node

import { randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { Pool } from "pg";

const requiredRestorePurpose = "restored-staging";
const requiredTables = [
  "aais_learner_sessions",
  "aais_lrs_outbox",
  "aais_login_rate_limits",
  "aais_events",
  "aais_learner_task_state",
  "aais_users",
  "aais_user_auth_tokens",
  "aais_session_revocations",
  "aais_courses",
  "aais_course_tasks",
  "aais_enrollments",
];

export async function runAaisPostgresRestoreVerification(input = {}) {
  const checkedAt = new Date().toISOString();
  const targetPurpose = String(input.targetPurpose ?? "").trim();
  const issues = [];
  if (targetPurpose !== requiredRestorePurpose) {
    issues.push("AAIS_RESTORE_TARGET_PURPOSE");
  }

  const tableReport = await checkRequiredTables(input.database);
  if (!tableReport.present) {
    issues.push("AAIS_RESTORE_SCHEMA");
  }

  const rowCounts = tableReport.present
    ? await readRestoreRowCounts(input.database)
    : {
        learnerSessions: null,
        lrsOutbox: null,
        events: null,
        learnerTaskState: null,
        users: null,
        courses: null,
        courseTasks: null,
        enrollments: null,
      };
  const smoke = tableReport.present && targetPurpose === requiredRestorePurpose
    ? await runRolledBackSyntheticInsert(input.database, checkedAt)
    : {
        status: "skipped",
        insertAccepted: false,
        rolledBack: false,
      };
  if (smoke.status !== "passed") {
    issues.push("AAIS_RESTORE_SMOKE_INSERT");
  }

  return {
    schemaVersion: 1,
    status: issues.length ? "failed" : "passed",
    checkedAt,
    targetPurpose: targetPurpose || null,
    sourceEnv: input.sourceEnv ?? null,
    releaseId: normalizeOptionalString(input.releaseId),
    checks: {
      targetPurpose: {
        status: targetPurpose === requiredRestorePurpose ? "passed" : "failed",
        required: requiredRestorePurpose,
      },
      requiredTables: tableReport,
      rowCounts,
      smokeInsert: smoke,
    },
    issues,
    redaction: {
      databaseUrl: "omitted",
      learnerPayload: "synthetic-only",
      learnerIdentifiers: "omitted",
      secrets: "redacted",
    },
  };
}

export function getAaisRestoreDatabaseConfiguration(env = process.env) {
  const candidates = [
    "AAIS_RESTORE_DATABASE_URL",
    "RESTORE_DATABASE_URL",
  ];
  for (const sourceEnv of candidates) {
    const url = env[sourceEnv]?.trim();
    if (url) {
      return { url, sourceEnv };
    }
  }
  return null;
}

export async function loadAaisRestoreEnvFile(envFilePath) {
  if (!envFilePath) {
    return {};
  }
  const raw = await readFile(envFilePath, "utf8");
  return parseAaisEnvFile(raw);
}

export function parseAaisEnvFile(raw) {
  const values = {};
  for (const line of String(raw).split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) {
      continue;
    }
    const normalized = trimmed.startsWith("export ") ? trimmed.slice("export ".length).trim() : trimmed;
    const separator = normalized.indexOf("=");
    if (separator <= 0) {
      continue;
    }
    const key = normalized.slice(0, separator).trim();
    const value = normalized.slice(separator + 1).trim();
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) {
      continue;
    }
    values[key] = stripEnvQuotes(value);
  }
  return values;
}

async function checkRequiredTables(database) {
  const result = await database.query(
    `select
       to_regclass('public.aais_learner_sessions') as aais_learner_sessions,
       to_regclass('public.aais_lrs_outbox') as aais_lrs_outbox,
       to_regclass('public.aais_login_rate_limits') as aais_login_rate_limits,
       to_regclass('public.aais_events') as aais_events,
       to_regclass('public.aais_learner_task_state') as aais_learner_task_state,
       to_regclass('public.aais_users') as aais_users,
       to_regclass('public.aais_user_auth_tokens') as aais_user_auth_tokens,
       to_regclass('public.aais_session_revocations') as aais_session_revocations,
       to_regclass('public.aais_courses') as aais_courses,
       to_regclass('public.aais_course_tasks') as aais_course_tasks,
       to_regclass('public.aais_enrollments') as aais_enrollments`,
  );
  const row = result.rows[0] ?? {};
  const tables = Object.fromEntries(
    requiredTables.map((table) => [table, row[table] === table]),
  );
  const missing = requiredTables.filter((table) => !tables[table]);
  return {
    status: missing.length ? "failed" : "passed",
    present: missing.length === 0,
    tables,
    missing,
  };
}

async function readRestoreRowCounts(database) {
  const result = await database.query(
    `select
       (select count(*)::int from aais_learner_sessions) as learner_sessions,
       (select count(*)::int from aais_lrs_outbox) as lrs_outbox,
       (select count(*)::int from aais_events) as events,
       (select count(*)::int from aais_learner_task_state) as learner_task_state,
       (select count(*)::int from aais_users) as users,
       (select count(*)::int from aais_courses) as courses,
       (select count(*)::int from aais_course_tasks) as course_tasks,
       (select count(*)::int from aais_enrollments) as enrollments`,
  );
  const row = result.rows[0] ?? {};
  return {
    learnerSessions: normalizeCount(row.learner_sessions),
    lrsOutbox: normalizeCount(row.lrs_outbox),
    events: normalizeCount(row.events),
    learnerTaskState: normalizeCount(row.learner_task_state),
    users: normalizeCount(row.users),
    courses: normalizeCount(row.courses),
    courseTasks: normalizeCount(row.course_tasks),
    enrollments: normalizeCount(row.enrollments),
  };
}

async function runRolledBackSyntheticInsert(database, checkedAt) {
  const syntheticStudentId = `restore-smoke-${randomUUID()}`;
  const payload = {
    schemaVersion: 1,
    studentId: syntheticStudentId,
    sessionId: `restore-session-${randomUUID()}`,
    createdAt: checkedAt,
    updatedAt: checkedAt,
    activeTaskId: "training_task_1",
    activeStage: "training",
    tasks: [],
    guideMessages: [],
    events: [],
  };

  await database.query("begin");
  try {
    const result = await database.query(
      `insert into aais_learner_sessions (student_id, payload, version, updated_at)
       values ($1, $2::jsonb, 0, $3::timestamptz)
       on conflict (student_id) do nothing
       returning student_id`,
      [syntheticStudentId, JSON.stringify(payload), checkedAt],
    );
    await database.query("rollback");
    return {
      status: result.rows.length === 1 ? "passed" : "failed",
      insertAccepted: result.rows.length === 1,
      rolledBack: true,
      writeMode: "insert-only-rolled-back",
    };
  } catch (error) {
    await database.query("rollback").catch(() => undefined);
    return {
      status: "failed",
      insertAccepted: false,
      rolledBack: true,
      writeMode: "insert-only-rolled-back",
      errorCategory: classifyDatabaseError(error),
    };
  }
}

function normalizeCount(value) {
  const count = Number(value);
  return Number.isInteger(count) && count >= 0 ? count : 0;
}

function stripEnvQuotes(value) {
  if (
    (value.startsWith("\"") && value.endsWith("\""))
    || (value.startsWith("'") && value.endsWith("'"))
  ) {
    return value.slice(1, -1);
  }
  return value;
}

function normalizeOptionalString(value) {
  const text = String(value ?? "").trim();
  return text || null;
}

function classifyDatabaseError(error) {
  const code = String(error?.code ?? error?.cause?.code ?? "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_]/g, "");
  if (code === "enotfound" || code === "eai_again") {
    return "dns";
  }
  if (code === "econnrefused" || code === "econnreset") {
    return "network";
  }
  if (code) {
    return "database";
  }
  return "unknown";
}

async function writeReportIfRequested(report, outputPath) {
  if (outputPath) {
    await mkdir(path.dirname(outputPath), { recursive: true });
    await writeFile(outputPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  }
  return report;
}

function parseArgs(argv) {
  const input = {};
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--env-file") {
      input.envFile = argv[index + 1];
      index += 1;
    } else if (arg === "--target-purpose") {
      input.targetPurpose = argv[index + 1];
      index += 1;
    } else if (arg === "--release-id") {
      input.releaseId = argv[index + 1];
      index += 1;
    } else if (arg === "--output") {
      input.outputPath = argv[index + 1];
      index += 1;
    } else if (arg === "--help") {
      input.help = true;
    } else {
      throw new Error(`Unknown AAIS restore verification argument: ${arg}`);
    }
  }
  return input;
}

function printHelp() {
  console.log([
    "Usage: npm run verify:postgres-restore -- --env-file ./.env.postgres-restore.local --output ./aais-postgres-restore-report.json",
    "",
    "Required restore environment:",
    "  AAIS_RESTORE_DATABASE_URL",
    "  AAIS_RESTORE_TARGET_PURPOSE=restored-staging",
    "",
    "The report is redacted: database URLs, learner ids, payloads, and secrets are omitted.",
  ].join("\n"));
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    printHelp();
    return;
  }
  const envFileValues = await loadAaisRestoreEnvFile(args.envFile);
  const env = {
    ...process.env,
    ...envFileValues,
  };
  const config = getAaisRestoreDatabaseConfiguration(env);
  if (!config) {
    throw new Error("AAIS restore verification requires AAIS_RESTORE_DATABASE_URL.");
  }
  const targetPurpose = args.targetPurpose ?? env.AAIS_RESTORE_TARGET_PURPOSE;
  const pool = new Pool({ connectionString: config.url });
  try {
    const report = await runAaisPostgresRestoreVerification({
      database: pool,
      targetPurpose,
      sourceEnv: config.sourceEnv,
      releaseId: args.releaseId ?? env.AAIS_RELEASE_ID,
    });
    const output = await writeReportIfRequested(
      report,
      args.outputPath ?? env.AAIS_RESTORE_REHEARSAL_REPORT_PATH,
    );
    console.log(JSON.stringify({
      status: output.status,
      targetPurpose: output.targetPurpose,
      sourceEnv: output.sourceEnv,
      issues: output.issues,
      tablesPresent: output.checks.requiredTables.present,
      smokeInsert: output.checks.smokeInsert.status,
      secrets: "redacted",
    }));
    if (output.status !== "passed") {
      process.exitCode = 1;
    }
  } finally {
    await pool.end();
  }
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(`AAIS restore verification failed: ${error.message}`);
    process.exitCode = 1;
  });
}
