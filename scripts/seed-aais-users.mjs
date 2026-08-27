#!/usr/bin/env node

import { createHash, randomBytes, scryptSync } from "node:crypto";
import { writeFile } from "node:fs/promises";
import path from "node:path";
import { Pool } from "pg";
import { getAaisMigrationDatabaseConfiguration } from "./run-postgres-migrations.mjs";

const defaultCourseId = "cognitive-apprenticeship";
const defaultCohort = "default";
const supportedSeedModes = Object.freeze(["upsert", "create-only"]);

export const AAIS_USER_SEED_CAPABILITIES = Object.freeze({
  version: 1,
  atomicBatch: true,
  modes: supportedSeedModes,
  batchAdvisoryLock: true,
  transactionValidationHooks: true,
  reportAggregates: Object.freeze([
    "created",
    "updated",
    "collisions",
    "enrollments",
  ]),
});

export class AaisUserSeedConflictError extends Error {
  constructor(collisions) {
    super(`AAIS create-only user seed detected ${collisions} collision(s).`);
    this.name = "AaisUserSeedConflictError";
    this.collisions = collisions;
  }
}

export class AaisUserSeedRollbackError extends Error {
  constructor(cause, rollbackCause) {
    super("AAIS user seed transaction rollback could not be confirmed.", { cause });
    this.name = "AaisUserSeedRollbackError";
    this.code = "AAIS_USER_SEED_ROLLBACK_FAILED";
    this.rollbackCause = rollbackCause;
  }
}

export function parseAaisUserSeedJson(raw, env = process.env) {
  const text = String(raw ?? "").trim();
  if (!text) {
    throw new Error("AAIS_SEED_USERS_JSON is required for user seeding.");
  }
  const parsed = JSON.parse(text);
  if (!Array.isArray(parsed) || parsed.length === 0) {
    throw new Error("AAIS user seed payload must be a non-empty array.");
  }
  const emails = new Set();
  return parsed.map((entry) => {
    const email = normalizeEmail(entry?.email);
    if (emails.has(email)) {
      throw new Error("AAIS user seed emails must be unique.");
    }
    emails.add(email);
    const password = readSeedPassword(entry, env);
    return {
      id: createAaisUserId(email),
      email,
      displayName: requireDisplayName(entry?.displayName),
      role: requireRole(entry?.role),
      status: requireStatus(entry?.status ?? "active"),
      passwordRecord: createPasswordRecord(password),
    };
  });
}

export async function runAaisUserSeed(input) {
  const database = input.database;
  const users = input.users;
  const mode = readSeedMode(input.mode);
  const batchId = readOptionalBatchId(input.batchId);
  const validateBeforeWrite = readOptionalTransactionValidationHook(
    input.validateBeforeWrite,
  );
  const validateBeforeCommit = readOptionalTransactionValidationHook(
    input.validateBeforeCommit,
  );
  const now = input.now ?? new Date();
  const courseId = readConfiguredCatalogId(input.courseId ?? defaultCourseId, "course id");
  const cohort = readConfiguredCohort(input.cohort ?? defaultCohort);
  const updatedAt = now.toISOString();
  const { connection, release } = await acquireSeedConnection(database);
  let transactionOpen = false;
  try {
    await connection.query("begin");
    transactionOpen = true;
    if (batchId) {
      await connection.query(
        `select pg_catalog.pg_advisory_xact_lock(
           pg_catalog.hashtextextended($1::text, 0)
         ) as locked`,
        [`aais:user-seed:v1:${batchId}`],
      );
    }
    if (validateBeforeWrite) {
      await validateBeforeWrite({
        database: connection,
        mode,
        batchId,
        courseId,
        cohort,
      });
    }
    if (mode === "create-only") {
      await assertCreateOnlySeedHasNoCollisions(connection, users);
    }

    const results = [];
    let created = 0;
    let updated = 0;
    let enrollments = 0;
    for (const user of users) {
      const outcome = await writeSeedUser(connection, user, updatedAt, mode);
      if (outcome === "created") {
        created += 1;
      } else {
        updated += 1;
      }
      await writeSeedEnrollment(connection, {
        courseId,
        cohort,
        mode,
        updatedAt,
        user,
      });
      enrollments += 1;
      results.push({
        userHash: hashForReport(user.email),
        role: user.role,
        status: user.status,
        outcome,
        enrollment: {
          courseId,
          cohort,
          status: user.status === "disabled" ? "withdrawn" : "active",
        },
      });
    }

    const report = {
      schemaVersion: 1,
      status: "pass",
      mode,
      upserted: results.length,
      created,
      updated,
      collisions: 0,
      enrollments,
      users: results,
      redaction: {
        emails: "sha256-16",
        passwords: "omitted",
        databaseUrl: "omitted",
      },
      secrets: "redacted",
    };
    if (validateBeforeCommit) {
      await validateBeforeCommit({
        database: connection,
        mode,
        batchId,
        courseId,
        cohort,
        report,
      });
    }
    await connection.query("commit");
    transactionOpen = false;
    return report;
  } catch (error) {
    if (transactionOpen) {
      try {
        await connection.query("rollback");
      } catch (rollbackError) {
        throw new AaisUserSeedRollbackError(error, rollbackError);
      }
    }
    throw error;
  } finally {
    await release();
  }
}

async function acquireSeedConnection(database) {
  // A pg PoolClient is already connected but still inherits Client.connect().
  // Its release() method identifies it as an externally leased connection;
  // the outer pool owner must remain the only release authority.
  if (
    database
    && typeof database.query === "function"
    && typeof database.release === "function"
  ) {
    return {
      connection: database,
      release: async () => {},
    };
  }
  if (database && typeof database.connect === "function") {
    const connection = await database.connect();
    if (!connection || typeof connection.query !== "function") {
      connection?.release?.();
      throw new Error("AAIS user seed database connection is invalid.");
    }
    return {
      connection,
      release: async () => connection.release?.(),
    };
  }
  if (!database || typeof database.query !== "function") {
    throw new Error("AAIS user seed database client is invalid.");
  }
  return {
    connection: database,
    release: async () => {},
  };
}

async function assertCreateOnlySeedHasNoCollisions(database, users) {
  const result = await database.query(
    `select id, normalized_email
       from aais_users
      where normalized_email = any($1::text[])
         or id = any($2::text[])
      for update`,
    [
      users.map((user) => user.email),
      users.map((user) => user.id),
    ],
  );
  if (result.rows.length > 0) {
    throw new AaisUserSeedConflictError(result.rows.length);
  }
}

async function writeSeedUser(database, user, updatedAt, mode) {
  const params = [
    user.id,
    user.email,
    user.email,
    user.displayName,
    user.role,
    user.status,
    JSON.stringify(user.passwordRecord),
    updatedAt,
  ];
  if (mode === "create-only") {
    const result = await database.query(
      `insert into aais_users (
         id,
         email,
         normalized_email,
         display_name,
         role,
         status,
         password,
         created_at,
         updated_at
       )
       values ($1, $2, $3, $4, $5, $6, $7::jsonb, $8::timestamptz, $8::timestamptz)
       on conflict do nothing
       returning id`,
      params,
    );
    if (result.rows.length !== 1) {
      throw new AaisUserSeedConflictError(1);
    }
    return "created";
  }
  const result = await database.query(
    `insert into aais_users (
       id,
       email,
       normalized_email,
       display_name,
       role,
       status,
       password,
       created_at,
       updated_at
     )
     values ($1, $2, $3, $4, $5, $6, $7::jsonb, $8::timestamptz, $8::timestamptz)
     on conflict (normalized_email) do update
     set
       display_name = excluded.display_name,
       role = excluded.role,
       status = excluded.status,
       password = excluded.password,
       auth_version = aais_users.auth_version + 1,
       updated_at = excluded.updated_at
     returning id, (xmax = 0) as created`,
    params,
  );
  if (result.rows.length !== 1 || typeof result.rows[0]?.created !== "boolean") {
    throw new Error("AAIS user seed upsert returned an invalid result.");
  }
  return result.rows[0].created ? "created" : "updated";
}

async function writeSeedEnrollment(database, input) {
  const enrollmentStatus = input.user.status === "disabled" ? "withdrawn" : "active";
  const params = [
    input.courseId,
    input.user.id,
    input.cohort,
    input.user.role,
    enrollmentStatus,
    input.updatedAt,
  ];
  if (input.mode === "create-only") {
    const result = await database.query(
      `insert into aais_enrollments (
         course_id,
         user_id,
         cohort,
         role,
         status,
         enrolled_at,
         updated_at
       )
       values ($1, $2, $3, $4, $5, $6::timestamptz, $6::timestamptz)
       on conflict do nothing
       returning user_id`,
      params,
    );
    if (result.rows.length !== 1) {
      throw new AaisUserSeedConflictError(1);
    }
    return;
  }
  const result = await database.query(
    `insert into aais_enrollments (
       course_id,
       user_id,
       cohort,
       role,
       status,
       enrolled_at,
       updated_at
     )
     values ($1, $2, $3, $4, $5, $6::timestamptz, $6::timestamptz)
     on conflict (course_id, user_id) do update
     set
       cohort = excluded.cohort,
       role = excluded.role,
       status = excluded.status,
       updated_at = excluded.updated_at
     returning user_id`,
    params,
  );
  if (result.rows.length !== 1) {
    throw new Error("AAIS user seed enrollment upsert returned an invalid result.");
  }
}

function parseArgs(argv) {
  const options = {
    approved: false,
    output: "",
    mode: "",
    batchId: "",
    help: false,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--help" || arg === "-h") {
      options.help = true;
      continue;
    }
    if (arg === "--approved") {
      options.approved = true;
      continue;
    }
    if (arg === "--output") {
      options.output = path.resolve(argv[index + 1] ?? "");
      index += 1;
      continue;
    }
    if (arg === "--mode") {
      options.mode = argv[index + 1] ?? "";
      index += 1;
      continue;
    }
    if (arg === "--batch-id") {
      options.batchId = argv[index + 1] ?? "";
      index += 1;
      continue;
    }
    throw new Error(`Unknown AAIS user seed argument: ${arg}`);
  }
  return options;
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    process.stdout.write([
      "Usage: npm run db:seed-users -- --approved [--mode upsert|create-only] [--batch-id id] [--output report.json]",
      "",
      "Seeds database-backed AAIS users from AAIS_SEED_USERS_JSON.",
      "Each user needs email, displayName, role, and either password or passwordEnv.",
      "Prefer passwordEnv values so raw passwords stay in ignored/provider-managed env vars.",
      "create-only atomically refuses any existing or concurrently-created identity.",
      "Requires --approved or AAIS_USER_SEED_APPROVED=true.",
      "",
    ].join("\n"));
    return;
  }
  if (!options.approved && process.env.AAIS_USER_SEED_APPROVED !== "true") {
    throw new Error("AAIS user seeding requires --approved or AAIS_USER_SEED_APPROVED=true.");
  }
  const config = getAaisMigrationDatabaseConfiguration();
  if (!config) {
    throw new Error("AAIS user seeding requires a configured Postgres database environment.");
  }
  const users = parseAaisUserSeedJson(process.env.AAIS_SEED_USERS_JSON, process.env);
  const pool = new Pool({ connectionString: config.url });
  try {
    const report = await runAaisUserSeed({
      database: pool,
      users,
      courseId: process.env.AAIS_DEFAULT_COURSE_ID,
      cohort: process.env.AAIS_DEFAULT_COHORT,
      mode: options.mode || process.env.AAIS_USER_SEED_MODE,
      batchId: options.batchId || process.env.AAIS_USER_SEED_BATCH_ID,
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
      mode: output.mode,
      upserted: output.upserted,
      created: output.created,
      updated: output.updated,
      collisions: output.collisions,
      enrollments: output.enrollments,
      sourceEnv: output.sourceEnv,
      secrets: "redacted",
    }) + "\n");
  } finally {
    await pool.end();
  }
}

function readSeedPassword(entry, env) {
  if (typeof entry?.password === "string") {
    return requireStrongEnoughPassword(entry.password);
  }
  if (typeof entry?.passwordEnv === "string") {
    const envName = entry.passwordEnv.trim();
    if (!/^[A-Z0-9_]{3,128}$/.test(envName)) {
      throw new Error("Invalid AAIS user seed password env name.");
    }
    return requireStrongEnoughPassword(env[envName] ?? "");
  }
  throw new Error("AAIS user seed password or passwordEnv is required.");
}

function createPasswordRecord(password) {
  const salt = randomBytes(16).toString("base64url");
  return {
    algorithm: "scrypt",
    salt,
    hash: scryptSync(password, salt, 32).toString("base64url"),
  };
}

function normalizeEmail(value) {
  const email = String(value ?? "").trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email.length > 254) {
    throw new Error("Invalid AAIS user seed email.");
  }
  return email;
}

function requireDisplayName(value) {
  const displayName = String(value ?? "").trim();
  if (!displayName || displayName.length > 120) {
    throw new Error("Invalid AAIS user seed display name.");
  }
  return displayName;
}

function requireRole(value) {
  if (value === "student" || value === "teacher" || value === "admin") {
    return value;
  }
  throw new Error("Invalid AAIS user seed role.");
}

function requireStatus(value) {
  if (value === "active" || value === "disabled") {
    return value;
  }
  throw new Error("Invalid AAIS user seed status.");
}

function requireStrongEnoughPassword(password) {
  if (typeof password !== "string" || password.length < 10 || password.length > 256) {
    throw new Error("AAIS user seed password does not meet length requirements.");
  }
  return password;
}

function readSeedMode(value) {
  const mode = String(value ?? "").trim() || "upsert";
  if (!supportedSeedModes.includes(mode)) {
    throw new Error("Invalid AAIS user seed mode.");
  }
  return mode;
}

function readOptionalBatchId(value) {
  const batchId = String(value ?? "").trim();
  if (!batchId) {
    return null;
  }
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(batchId)) {
    throw new Error("Invalid AAIS user seed batch id.");
  }
  return batchId;
}

function readOptionalTransactionValidationHook(value) {
  if (value === undefined || value === null) {
    return null;
  }
  if (typeof value !== "function") {
    throw new Error("Invalid AAIS user seed transaction validation hook.");
  }
  return value;
}

function readConfiguredCatalogId(value, label) {
  const candidate = String(value ?? "").trim() || defaultCourseId;
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(candidate)) {
    throw new Error(`Invalid AAIS ${label}.`);
  }
  return candidate;
}

function readConfiguredCohort(value) {
  const candidate = String(value ?? "").trim() || defaultCohort;
  if (!/^[A-Za-z0-9][A-Za-z0-9._: -]{0,127}$/.test(candidate)) {
    throw new Error("Invalid AAIS cohort.");
  }
  return candidate;
}

function createAaisUserId(email) {
  return `user-${createHash("sha256").update(`aais-user:${email}`).digest("hex").slice(0, 16)}`;
}

function hashForReport(email) {
  return createHash("sha256").update(`aais-user-report:${email}`).digest("hex").slice(0, 16);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error) => {
    const failure = error instanceof AaisUserSeedConflictError
      ? {
          code: "AAIS_USER_SEED_CONFLICT",
          collisions: error.collisions,
        }
      : error instanceof AaisUserSeedRollbackError
        ? { code: error.code }
      : { code: "AAIS_USER_SEED_FAILED" };
    process.stderr.write(`${JSON.stringify({
      status: "failed",
      ...failure,
      secrets: "redacted",
    })}\n`);
    process.exitCode = 1;
  });
}
