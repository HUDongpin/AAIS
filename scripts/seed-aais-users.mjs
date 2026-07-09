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
  const now = input.now ?? new Date();
  const courseId = readConfiguredCatalogId(input.courseId ?? defaultCourseId, "course id");
  const cohort = readConfiguredCohort(input.cohort ?? defaultCohort);
  const updatedAt = now.toISOString();
  const results = [];

  for (const user of users) {
    await database.query(
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
         updated_at = excluded.updated_at`,
      [
        user.id,
        user.email,
        user.email,
        user.displayName,
        user.role,
        user.status,
        JSON.stringify(user.passwordRecord),
        updatedAt,
      ],
    );
    await database.query(
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
         updated_at = excluded.updated_at`,
      [
        courseId,
        user.id,
        cohort,
        user.role,
        user.status === "disabled" ? "withdrawn" : "active",
        updatedAt,
      ],
    );
    results.push({
      userHash: hashForReport(user.email),
      role: user.role,
      status: user.status,
      enrollment: {
        courseId,
        cohort,
        status: user.status === "disabled" ? "withdrawn" : "active",
      },
    });
  }

  return {
    schemaVersion: 1,
    status: "pass",
    upserted: results.length,
    users: results,
    redaction: {
      emails: "sha256-16",
      passwords: "omitted",
      databaseUrl: "omitted",
    },
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
    process.stderr.write(`${error instanceof Error ? error.message : "AAIS user seeding failed."}\n`);
    process.exitCode = 1;
  });
}
