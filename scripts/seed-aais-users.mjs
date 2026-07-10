#!/usr/bin/env node

import { createHash, randomBytes, scryptSync } from "node:crypto";
import { writeFile } from "node:fs/promises";
import path from "node:path";
import { Pool } from "pg";
import { getAaisMigrationDatabaseConfiguration } from "./run-postgres-migrations.mjs";

const defaultCourseId = "cognitive-apprenticeship";
const defaultCohort = "default";

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
  const accountIds = new Set();
  return parsed.map((entry) => {
    const email = normalizeEmail(entry?.email);
    if (emails.has(email)) {
      throw new Error("AAIS user seed emails must be unique.");
    }
    emails.add(email);
    const id = Object.prototype.hasOwnProperty.call(entry ?? {}, "accountId")
      ? requireAccountId(entry.accountId)
      : createAaisUserId(email);
    const casefoldId = id.toLowerCase();
    if (accountIds.has(casefoldId)) {
      throw new Error("AAIS user seed account ids must be unique.");
    }
    accountIds.add(casefoldId);
    const password = readSeedPassword(entry, env);
    return {
      id,
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
  const now = input.now ?? new Date();
  const courseId = readConfiguredCatalogId(input.courseId ?? defaultCourseId, "course id");
  const cohort = readConfiguredCohort(input.cohort ?? defaultCohort);
  const updatedAt = now.toISOString();
  validateSeedUsers(users);
  const client = await database.connect();
  try {
    await client.query("begin");
    await client.query(
      "select pg_advisory_xact_lock(hashtextextended('aais-user-seed-v1', 0))",
    );
    const existing = await client.query(
      `select id, email, normalized_email
       from aais_users
       where lower(id) = any($1::text[])
          or normalized_email = any($2::text[])
       order by lower(id), normalized_email
       for update`,
      [users.map((user) => user.id.toLowerCase()), users.map((user) => user.email)],
    );
    assertSeedIdentitiesAvailable(existing.rows, users);

    const userRows = users.map((user) => ({
      id: user.id,
      email: user.email,
      normalized_email: user.email,
      display_name: user.displayName,
      role: user.role,
      status: user.status,
      password: user.passwordRecord,
    }));
    await client.query(
      `insert into aais_users (
         id, email, normalized_email, display_name, role, status, password, created_at, updated_at
       )
       select
         seed.id,
         seed.email,
         seed.normalized_email,
         seed.display_name,
         seed.role,
         seed.status,
         seed.password,
         $2::timestamptz,
         $2::timestamptz
       from jsonb_to_recordset($1::jsonb) as seed(
         id text,
         email text,
         normalized_email text,
         display_name text,
         role text,
         status text,
         password jsonb
       )
       on conflict (normalized_email) do update
       set
         display_name = excluded.display_name,
         role = excluded.role,
         status = excluded.status,
         password = excluded.password,
         updated_at = excluded.updated_at`,
      [JSON.stringify(userRows), updatedAt],
    );

    const enrollmentRows = users.map((user) => ({
      course_id: courseId,
      user_id: user.id,
      cohort,
      role: user.role,
      status: enrollmentStatus(user),
    }));
    await client.query(
      `insert into aais_enrollments (
         course_id, user_id, cohort, role, status, enrolled_at, updated_at
       )
       select
         seed.course_id,
         seed.user_id,
         seed.cohort,
         seed.role,
         seed.status,
         $2::timestamptz,
         $2::timestamptz
       from jsonb_to_recordset($1::jsonb) as seed(
         course_id text,
         user_id text,
         cohort text,
         role text,
         status text
       )
       on conflict (course_id, user_id) do update
       set
         cohort = excluded.cohort,
         role = excluded.role,
         status = excluded.status,
         updated_at = excluded.updated_at`,
      [JSON.stringify(enrollmentRows), updatedAt],
    );

    const postcondition = await client.query(
      `select
         users.id,
         users.email,
         users.normalized_email,
         users.role,
         users.status,
         users.password->>'algorithm' as password_algorithm,
         coalesce(users.password->>'salt', '') <> '' as password_salt_present,
         coalesce(users.password->>'hash', '') <> '' as password_hash_present,
         enrollments.course_id,
         enrollments.cohort,
         enrollments.role as enrollment_role,
         enrollments.status as enrollment_status
       from aais_users as users
       join aais_enrollments as enrollments
         on enrollments.user_id = users.id
        and enrollments.course_id = $3
       where lower(users.id) = any($1::text[])
         and users.normalized_email = any($2::text[])
       order by lower(users.id)`,
      [users.map((user) => user.id.toLowerCase()), users.map((user) => user.email), courseId],
    );
    assertSeedPostconditions(postcondition.rows, users, { courseId, cohort });
    await client.query("commit");
  } catch (error) {
    await client.query("rollback").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }

  return {
    schemaVersion: 1,
    status: "pass",
    upserted: users.length,
    users: users.map((user) => ({
      role: user.role,
      status: user.status,
      enrollment: {
        courseId,
        cohort,
        status: enrollmentStatus(user),
      },
    })),
    secrets: "redacted",
  };
}

function parseArgs(argv) {
  const options = {
    approved: false,
    output: "",
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
    throw new Error(`Unknown AAIS user seed argument: ${arg}`);
  }
  return options;
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    process.stdout.write([
      "Usage: npm run db:seed-users -- --approved [--output report.json]",
      "",
      "Seeds database-backed AAIS users from AAIS_SEED_USERS_JSON.",
      "Each user needs email, displayName, role, and either password or passwordEnv.",
      "Prefer passwordEnv values so raw passwords stay in ignored/provider-managed env vars.",
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
      upserted: output.upserted,
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

function requireAccountId(value) {
  if (typeof value !== "string") {
    throw new Error("Invalid AAIS user seed account id.");
  }
  const candidate = value.trim();
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(candidate)) {
    throw new Error("Invalid AAIS user seed account id.");
  }
  return candidate;
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

function validateSeedUsers(users) {
  if (!Array.isArray(users) || users.length === 0) {
    throw new Error("AAIS user seed users are required.");
  }
  const ids = new Set();
  const emails = new Set();
  for (const user of users) {
    const id = requireAccountId(user?.id);
    const email = normalizeEmail(user?.email);
    if (ids.has(id.toLowerCase())) {
      throw new Error("AAIS user seed account ids must be unique.");
    }
    if (emails.has(email)) {
      throw new Error("AAIS user seed emails must be unique.");
    }
    ids.add(id.toLowerCase());
    emails.add(email);
  }
}

function assertSeedIdentitiesAvailable(rows, users) {
  const exactIdentities = new Set(users.map((user) => `${user.id}\u0000${user.email}`));
  for (const row of rows) {
    const identity = `${String(row.id)}\u0000${String(row.normalized_email)}`;
    if (!exactIdentities.has(identity) || String(row.email) !== String(row.normalized_email)) {
      throw new Error("AAIS user seed identity collision.");
    }
  }
}

function assertSeedPostconditions(rows, users, { courseId, cohort }) {
  if (rows.length !== users.length) {
    throw new Error("AAIS user seed postcondition failed.");
  }
  const rowsById = new Map(rows.map((row) => [String(row.id), row]));
  for (const user of users) {
    const row = rowsById.get(user.id);
    if (!row
      || String(row.email) !== user.email
      || String(row.normalized_email) !== user.email
      || String(row.role) !== user.role
      || String(row.status) !== user.status
      || String(row.password_algorithm) !== "scrypt"
      || row.password_salt_present !== true
      || row.password_hash_present !== true
      || String(row.course_id) !== courseId
      || String(row.cohort) !== cohort
      || String(row.enrollment_role) !== user.role
      || String(row.enrollment_status) !== enrollmentStatus(user)) {
      throw new Error("AAIS user seed postcondition failed.");
    }
  }
}

function enrollmentStatus(user) {
  return user.status === "disabled" ? "withdrawn" : "active";
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : "AAIS user seeding failed."}\n`);
    process.exitCode = 1;
  });
}
