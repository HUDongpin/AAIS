import { createHash } from "node:crypto";
import { writeFile } from "node:fs/promises";
import path from "node:path";
import { Pool } from "pg";
import { getAaisMigrationDatabaseConfiguration } from "./run-postgres-migrations.mjs";

const defaultBatchSize = 100;
const maxBatchSize = 500;

export async function backfillAaisPostgresSessionMirrors(input) {
  const database = input.database;
  const dryRun = Boolean(input.dryRun);
  const batchSize = normalizePositiveInteger(input.batchSize, defaultBatchSize, maxBatchSize);
  const limit = normalizeOptionalPositiveInteger(input.limit);
  const report = {
    schemaVersion: 1,
    status: "pass",
    dryRun,
    batches: 0,
    sessionsScanned: 0,
    sessionsSkipped: 0,
    eventsSeen: 0,
    eventsSkipped: 0,
    eventsInserted: 0,
    taskRowsSeen: 0,
    taskRowsSkipped: 0,
    taskRowsUpserted: 0,
    secrets: "redacted",
  };
  let offset = 0;

  while (limit === undefined || report.sessionsScanned < limit) {
    const remaining = limit === undefined ? batchSize : Math.min(batchSize, limit - report.sessionsScanned);
    if (remaining <= 0) {
      break;
    }
    const result = await database.query(
      `select student_id, payload, updated_at
       from aais_learner_sessions
       order by updated_at asc, student_id asc
       limit $1 offset $2`,
      [remaining, offset],
    );
    const rows = result.rows;
    if (!rows.length) {
      break;
    }
    report.batches += 1;
    offset += rows.length;

    for (const row of rows) {
      report.sessionsScanned += 1;
      const session = parseSessionPayload(row.payload);
      if (!session) {
        report.sessionsSkipped += 1;
        continue;
      }
      const updatedAt = normalizeDateString(session.updatedAt)
        ?? normalizeDateString(row.updated_at)
        ?? new Date().toISOString();
      const events = normalizeSessionEvents(session);
      const tasks = normalizeSessionTasks(session, {
        studentId: normalizeString(session.studentId) ?? normalizeString(row.student_id),
        sessionId: normalizeString(session.sessionId),
        updatedAt,
      });

      report.eventsSeen += Array.isArray(session.events) ? session.events.length : 0;
      report.eventsSkipped += Math.max(0, (Array.isArray(session.events) ? session.events.length : 0) - events.length);
      report.taskRowsSeen += Array.isArray(session.tasks) ? session.tasks.length : 0;
      report.taskRowsSkipped += Math.max(0, (Array.isArray(session.tasks) ? session.tasks.length : 0) - tasks.length);

      if (dryRun) {
        continue;
      }
      for (const event of events) {
        report.eventsInserted += await insertAaisEvent(database, event);
      }
      for (const task of tasks) {
        report.taskRowsUpserted += await upsertAaisLearnerTaskState(database, task);
      }
    }
  }

  if (report.sessionsSkipped > 0 || report.eventsSkipped > 0 || report.taskRowsSkipped > 0) {
    report.status = "partial";
  }
  return report;
}

function normalizeSessionEvents(session) {
  if (!Array.isArray(session.events)) {
    return [];
  }
  return session.events
    .map((event) => normalizeEvent(event, session))
    .filter(Boolean);
}

function normalizeSessionTasks(session, fallback) {
  if (!Array.isArray(session.tasks)) {
    return [];
  }
  return session.tasks
    .map((task) => normalizeTask(task, fallback))
    .filter(Boolean);
}

async function insertAaisEvent(database, event) {
  const result = await database.query(
    `insert into aais_events (
       id,
       student_id,
       session_id,
       phase,
       task,
       agent,
       event,
       event_time,
       detail
     )
     values ($1, $2, $3, $4, $5, $6, $7, $8::timestamptz, $9::jsonb)
     on conflict do nothing
     returning id`,
    [
      createAaisEventRowId(event),
      event.student_id,
      event.session_id,
      event.phase,
      event.task,
      event.agent,
      event.event,
      event.time,
      JSON.stringify(event.detail),
    ],
  );
  return result.rows.length;
}

async function upsertAaisLearnerTaskState(database, task) {
  const result = await database.query(
    `insert into aais_learner_task_state (
       student_id,
       session_id,
       task,
       phase,
       status,
       artifact_characters,
       self_report_characters,
       scaffold_requests,
       updated_at
     )
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9::timestamptz)
     on conflict (student_id, task)
     do update set
       session_id = excluded.session_id,
       phase = excluded.phase,
       status = excluded.status,
       artifact_characters = excluded.artifact_characters,
       self_report_characters = excluded.self_report_characters,
       scaffold_requests = excluded.scaffold_requests,
       updated_at = excluded.updated_at
     where aais_learner_task_state.session_id is distinct from excluded.session_id
       or aais_learner_task_state.phase is distinct from excluded.phase
       or aais_learner_task_state.status is distinct from excluded.status
       or aais_learner_task_state.artifact_characters is distinct from excluded.artifact_characters
       or aais_learner_task_state.self_report_characters is distinct from excluded.self_report_characters
       or aais_learner_task_state.scaffold_requests is distinct from excluded.scaffold_requests
       or aais_learner_task_state.updated_at is distinct from excluded.updated_at
     returning task`,
    [
      task.studentId,
      task.sessionId,
      task.taskId,
      task.phase,
      task.status,
      task.artifactCharacters,
      task.selfReportCharacters,
      task.scaffoldRequests,
      task.updatedAt,
    ],
  );
  return result.rows.length;
}

function parseSessionPayload(payload) {
  if (!payload) {
    return null;
  }
  if (typeof payload === "string") {
    try {
      const parsed = JSON.parse(payload);
      return isRecord(parsed) ? parsed : null;
    } catch {
      return null;
    }
  }
  return isRecord(payload) ? payload : null;
}

function normalizeEvent(event, session) {
  if (!isRecord(event)) {
    return null;
  }
  const normalized = {
    student_id: normalizeString(event.student_id) ?? normalizeString(session.studentId),
    session_id: normalizeString(event.session_id) ?? normalizeString(session.sessionId),
    phase: normalizeString(event.phase),
    task: normalizeString(event.task),
    agent: normalizeString(event.agent),
    event: normalizeString(event.event),
    time: normalizeDateString(event.time),
    detail: normalizeJsonObject(event.detail),
  };
  if (
    !normalized.student_id
    || !normalized.session_id
    || !normalized.phase
    || !normalized.task
    || !normalized.agent
    || !normalized.event
    || !normalized.time
  ) {
    return null;
  }
  return normalized;
}

function normalizeTask(task, fallback) {
  if (!isRecord(task)) {
    return null;
  }
  const taskId = normalizeString(task.taskId);
  const phase = normalizeString(task.phase);
  const status = normalizeString(task.status);
  const studentId = fallback.studentId;
  const sessionId = fallback.sessionId;
  if (!studentId || !sessionId || !taskId || !phase || !status) {
    return null;
  }
  return {
    studentId,
    sessionId,
    taskId,
    phase,
    status,
    artifactCharacters: stringLength(task.artifactText),
    selfReportCharacters: stringLength(task.selfReport),
    scaffoldRequests: normalizeNonNegativeInteger(task.scaffoldRequests),
    updatedAt: fallback.updatedAt,
  };
}

function createAaisEventRowId(event) {
  return createHash("sha256")
    .update(JSON.stringify([
      event.student_id,
      event.session_id,
      event.phase,
      event.task,
      event.agent,
      event.event,
      event.time,
      event.detail,
    ]))
    .digest("hex")
    .slice(0, 32);
}

function normalizeJsonObject(value) {
  return isRecord(value) ? value : {};
}

function normalizeString(value) {
  return typeof value === "string" && value.trim() ? value : null;
}

function normalizeDateString(value) {
  if (value instanceof Date && Number.isFinite(value.getTime())) {
    return value.toISOString();
  }
  if (typeof value !== "string" || !value.trim()) {
    return null;
  }
  const trimmed = value.trim();
  const timestamp = Date.parse(trimmed);
  return Number.isFinite(timestamp) ? trimmed : null;
}

function normalizeNonNegativeInteger(value) {
  const number = Number(value);
  return Number.isInteger(number) && number >= 0 ? number : 0;
}

function normalizePositiveInteger(value, fallback, maximum) {
  const number = normalizeOptionalPositiveInteger(value);
  if (number === undefined) {
    return fallback;
  }
  return Math.min(number, maximum);
}

function normalizeOptionalPositiveInteger(value) {
  if (value === undefined || value === null || value === "") {
    return undefined;
  }
  const number = Number(value);
  return Number.isInteger(number) && number > 0 ? number : undefined;
}

function stringLength(value) {
  return typeof value === "string" ? value.length : 0;
}

function isRecord(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function parseArgs(argv) {
  const options = {
    dryRun: false,
    batchSize: defaultBatchSize,
    limit: undefined,
    output: "",
    help: false,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--help" || arg === "-h") {
      options.help = true;
      continue;
    }
    if (arg === "--dry-run") {
      options.dryRun = true;
      continue;
    }
    if (arg === "--batch-size") {
      options.batchSize = requirePositiveIntegerArg(argv[index + 1], "--batch-size");
      index += 1;
      continue;
    }
    if (arg === "--limit") {
      options.limit = requirePositiveIntegerArg(argv[index + 1], "--limit");
      index += 1;
      continue;
    }
    if (arg === "--output") {
      options.output = path.resolve(argv[index + 1] ?? "");
      index += 1;
      continue;
    }
    throw new Error(`Unknown AAIS backfill argument: ${arg}`);
  }
  return options;
}

function requirePositiveIntegerArg(value, optionName) {
  const parsed = normalizeOptionalPositiveInteger(value);
  if (parsed === undefined) {
    throw new Error(`${optionName} requires a positive integer value.`);
  }
  return parsed;
}

function writeUsage() {
  process.stdout.write([
    "Usage: npm run db:backfill -- [--dry-run] [--limit <rows>] [--batch-size <rows>] [--output <report.json>]",
    "",
    "Backfills AAIS Postgres learner session JSONB into mirrored event and task-state tables.",
    "Reports are count-only and redact secrets, learner ids, session ids, artifacts, and event detail.",
    "",
  ].join("\n"));
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    writeUsage();
    return;
  }
  const config = getAaisMigrationDatabaseConfiguration();
  if (!config) {
    throw new Error("AAIS Postgres backfill requires a configured Postgres database environment.");
  }
  const pool = new Pool({ connectionString: config.url });
  try {
    const report = await backfillAaisPostgresSessionMirrors({
      database: pool,
      dryRun: options.dryRun,
      batchSize: options.batchSize,
      limit: options.limit,
    });
    const output = {
      ...report,
      sourceEnv: config.sourceEnv,
    };
    if (options.output) {
      await writeFile(options.output, `${JSON.stringify(output, null, 2)}\n`);
    }
    process.stdout.write(JSON.stringify({
      status: output.status,
      dryRun: output.dryRun,
      sessionsScanned: output.sessionsScanned,
      sessionsSkipped: output.sessionsSkipped,
      eventsSeen: output.eventsSeen,
      eventsInserted: output.eventsInserted,
      taskRowsSeen: output.taskRowsSeen,
      taskRowsUpserted: output.taskRowsUpserted,
      sourceEnv: output.sourceEnv,
      secrets: "redacted",
    }) + "\n");
  } finally {
    await pool.end();
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : "AAIS Postgres backfill failed."}\n`);
    process.exitCode = 1;
  });
}
