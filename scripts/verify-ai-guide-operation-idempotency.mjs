#!/usr/bin/env node

import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { neon } from "@neondatabase/serverless";
import { Pool } from "pg";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const migrationPath = path.join(
  repoRoot,
  "migrations",
  "postgres",
  "0028_ai_guide_operation_idempotency.sql",
);
const expectedColumns = [
  ["data_generation", "bigint"],
  ["operation_id", "uuid"],
  ["payload_digest", "text"],
  ["operation_state", "text"],
  ["result_message_id", "text"],
  ["operation_lease_expires_at", "timestamp with time zone"],
];
const expectedConstraints = [
  "aais_ai_guide_reservations_operation_state_check",
  "aais_ai_guide_reservations_payload_digest_check",
];
const expectedIndexes = [
  ["aais_ai_guide_reservations_operation_idx", true],
  ["aais_ai_guide_reservations_operation_lease_idx", false],
];
const verifierStudentId = "aais-migration-0028-verifier";
const firstOperationId = "00000000-0000-4000-8000-000000002801";
const secondOperationId = "00000000-0000-4000-8000-000000002802";
const payloadDigest = "a".repeat(64);
const conflictingPayloadDigest = "b".repeat(64);

export class AaisAiGuideOperationMigrationVerificationError extends Error {
  constructor(code) {
    super(code);
    this.name = "AaisAiGuideOperationMigrationVerificationError";
    this.code = code;
  }
}

export async function verifyAaisAiGuideOperationMigration(input) {
  const databaseUrl = readDatabaseUrl(input.databaseUrl);
  if (input.approved !== true || input.target !== "staging") {
    fail("AAIS_0028_TARGET_NOT_APPROVED");
  }
  const parsedUrl = new URL(databaseUrl);
  const targetFingerprint = createHash("sha256")
    .update(`${parsedUrl.hostname}${parsedUrl.pathname}`)
    .digest("hex");
  const migrationChecksum = createHash("sha256")
    .update(readFileSync(migrationPath))
    .digest("hex");
  const database = input.database
    ?? createVerificationDatabase(databaseUrl, input.driver);
  const shouldEndDatabase = input.database === undefined;
  let verificationStage = "identity";

  try {
    const identity = await database.query(`select
      current_database() as database_name,
      current_setting('server_version_num')::integer as server_version_num`);
    verificationStage = "ledger";
    const ledger = await database.query(`select version, name, checksum
      from public.aais_schema_migrations
      order by version`);
    assert(
      ledger.rows.length === 28
        && ledger.rows.at(-1)?.version === "0028"
        && ledger.rows.at(-1)?.name === "ai_guide_operation_idempotency"
        && ledger.rows.at(-1)?.checksum === migrationChecksum,
      "AAIS_0028_LEDGER_INVALID",
    );

    verificationStage = "columns";
    const columns = await database.query(`select column_name, data_type
      from information_schema.columns
      where table_schema = 'public'
        and table_name = 'aais_ai_guide_reservations'
        and column_name = any($1::text[])
      order by ordinal_position`, [expectedColumns.map(([name]) => name)]);
    assert(
      sameRows(columns.rows, expectedColumns, "column_name", "data_type"),
      "AAIS_0028_COLUMNS_INVALID",
    );

    verificationStage = "constraints";
    const constraints = await database.query(`select conname, convalidated
      from pg_catalog.pg_constraint
      where conrelid = 'public.aais_ai_guide_reservations'::regclass
        and conname = any($1::text[])
      order by conname`, [expectedConstraints]);
    assert(
      constraints.rows.length === expectedConstraints.length
        && constraints.rows.every((row) => row.convalidated === true)
        && expectedConstraints.every((name) =>
          constraints.rows.some((row) => row.conname === name)),
      "AAIS_0028_CONSTRAINTS_INVALID",
    );

    verificationStage = "indexes";
    const indexes = await database.query(`select
        index_class.relname as index_name,
        index_row.indisunique,
        index_row.indpred is not null as partial
      from pg_catalog.pg_index index_row
      join pg_catalog.pg_class index_class on index_class.oid = index_row.indexrelid
      where index_row.indrelid = 'public.aais_ai_guide_reservations'::regclass
        and index_class.relname = any($1::text[])
      order by index_class.relname`, [expectedIndexes.map(([name]) => name)]);
    assert(
      indexes.rows.length === expectedIndexes.length
        && indexes.rows.every((row) => row.partial === true)
        && expectedIndexes.every(([name, unique]) =>
          indexes.rows.some((row) =>
            row.index_name === name && row.indisunique === unique)),
      "AAIS_0028_INDEXES_INVALID",
    );

    verificationStage = "function";
    const functions = await database.query(`select
        procedure.pronargs,
        procedure.provolatile,
        procedure.prosecdef,
        procedure.proconfig
      from pg_catalog.pg_proc procedure
      join pg_catalog.pg_namespace namespace on namespace.oid = procedure.pronamespace
      where namespace.nspname = 'public'
        and procedure.proname = 'aais_reserve_ai_guide_request'
      order by procedure.pronargs`);
    const operationFunction = functions.rows.find((row) => row.pronargs === 9);
    assert(
      Boolean(operationFunction)
        && operationFunction.provolatile === "v"
        && operationFunction.prosecdef === false
        && Array.isArray(operationFunction.proconfig)
        && operationFunction.proconfig.includes(
          "search_path=pg_catalog, public, pg_temp",
        ),
      "AAIS_0028_FUNCTION_INVALID",
    );

    verificationStage = "behavior";
    const behaviorResults = await database.transaction([
      {
        sql: `insert into public.aais_learner_data_generations (
          student_id,
          data_generation,
          updated_at
        ) values ($1, 1, $2::timestamptz)`,
        params: [verifierStudentId, "2026-08-21T00:00:00.000Z"],
      },
      reserveQuery({
        now: "2026-08-21T00:00:00.000Z",
        operationId: firstOperationId,
        digest: payloadDigest,
      }),
      reserveQuery({
        now: "2026-08-21T00:00:01.000Z",
        operationId: firstOperationId,
        digest: payloadDigest,
      }),
      reserveQuery({
        now: "2026-08-21T00:00:02.000Z",
        operationId: firstOperationId,
        digest: conflictingPayloadDigest,
      }),
      reserveQuery({
        now: "2026-08-21T00:01:01.000Z",
        operationId: firstOperationId,
        digest: payloadDigest,
      }),
      reserveQuery({
        now: "2026-08-21T00:01:02.000Z",
        operationId: secondOperationId,
        digest: payloadDigest,
      }),
      reserveQuery({
        now: "2026-08-21T00:01:03.000Z",
        operationId: secondOperationId,
        digest: payloadDigest,
      }),
      {
        sql: `select used
          from public.aais_ai_guide_daily_usage
          where student_id = $1 and usage_day = date '2026-08-21'`,
        params: [verifierStudentId],
      },
      {
        sql: "delete from public.aais_ai_guide_reservations where student_id = $1",
        params: [verifierStudentId],
      },
      {
        sql: "delete from public.aais_ai_guide_daily_usage where student_id = $1",
        params: [verifierStudentId],
      },
      {
        sql: "delete from public.aais_learner_data_generations where student_id = $1",
        params: [verifierStudentId],
      },
    ]);
    const firstClaim = firstRow(behaviorResults[1]);
    const replay = firstRow(behaviorResults[2]);
    const conflict = firstRow(behaviorResults[3]);
    const expired = firstRow(behaviorResults[4]);
    const secondClaim = firstRow(behaviorResults[5]);
    const secondReplay = firstRow(behaviorResults[6]);
    const usage = behaviorResults[7];

    assertReservation(firstClaim, {
      used: 1,
      granted: true,
      reservationId: firstOperationId,
      operationStatus: "reserved",
    }, "AAIS_0028_FIRST_CLAIM_INVALID");
    assertReservation(replay, {
      used: 1,
      granted: false,
      reservationId: firstOperationId,
      operationStatus: "in_progress",
    }, "AAIS_0028_REPLAY_INVALID");
    assertReservation(conflict, {
      used: 1,
      granted: false,
      reservationId: firstOperationId,
      operationStatus: "conflict",
    }, "AAIS_0028_CONFLICT_INVALID");
    assertReservation(expired, {
      used: 0,
      granted: false,
      reservationId: firstOperationId,
      operationStatus: "failed",
    }, "AAIS_0028_EXPIRY_INVALID");
    assertReservation(secondClaim, {
      used: 1,
      granted: true,
      reservationId: secondOperationId,
      operationStatus: "reserved",
    }, "AAIS_0028_SECOND_CLAIM_INVALID");
    assertReservation(secondReplay, {
      used: 1,
      granted: false,
      reservationId: secondOperationId,
      operationStatus: "in_progress",
    }, "AAIS_0028_SECOND_REPLAY_INVALID");
    assert(
      usage.rows.length === 1 && usage.rows[0].used === 1,
      "AAIS_0028_USAGE_INVALID",
    );

    verificationStage = "cleanup";
    const cleanup = await database.query(`select
      (select count(*)::integer from public.aais_learner_data_generations
        where student_id = $1) as generation_rows,
      (select count(*)::integer from public.aais_ai_guide_daily_usage
        where student_id = $1) as usage_rows,
      (select count(*)::integer from public.aais_ai_guide_reservations
        where student_id = $1) as reservation_rows`, [verifierStudentId]);
    assert(
      cleanup.rows[0]?.generation_rows === 0
        && cleanup.rows[0]?.usage_rows === 0
        && cleanup.rows[0]?.reservation_rows === 0,
      "AAIS_0028_CLEANUP_INVALID",
    );

    verificationStage = "complete";
    return {
      schemaVersion: 1,
      status: "pass",
      target: "staging",
      targetFingerprint,
      postgresMajorVersion: Math.floor(identity.rows[0].server_version_num / 10_000),
      migration: {
        version: "0028",
        checksum: migrationChecksum,
        ledgerCount: ledger.rows.length,
      },
      catalog: {
        columns: expectedColumns.map(([name, type]) => ({ name, type })),
        constraints: expectedConstraints.map((name) => ({ name, validated: true })),
        indexes: expectedIndexes.map(([name, unique]) => ({
          name,
          unique,
          partial: true,
        })),
        function: {
          arguments: 9,
          volatility: "volatile",
          security: "invoker",
          searchPath: "pg_catalog, public, pg_temp",
        },
      },
      behavior: {
        firstClaim: "reserved",
        replay: "in_progress",
        conflict: "conflict",
        expiredLease: "failed",
        replacementClaim: "reserved",
        replacementReplay: "in_progress",
        chargedOnce: true,
        transactionalCleanup: true,
      },
      secrets: "redacted",
    };
  } catch (error) {
    if (error && typeof error === "object" && Object.isExtensible(error)) {
      error.verificationStage ??= verificationStage;
    }
    throw error;
  } finally {
    if (shouldEndDatabase) await database.end();
  }
}

function reserveQuery(input) {
  return {
    sql: `select *
      from public.aais_reserve_ai_guide_request(
        $1,
        date '2026-08-21',
        $2::timestamptz,
        4,
        $3::uuid,
        1,
        60,
        $3::uuid,
        $4
      )`,
    params: [verifierStudentId, input.now, input.operationId, input.digest],
  };
}

function firstRow(result) {
  assert(result?.rows?.length === 1, "AAIS_0028_RESERVATION_RESULT_INVALID");
  return result.rows[0];
}

function createVerificationDatabase(databaseUrl, configuredDriver) {
  const driver = String(configuredDriver ?? "neon-serverless").trim().toLowerCase();
  if (driver === "neon-serverless") {
    const sql = neon(databaseUrl);
    return {
      async query(query, params = []) {
        return normalizeQueryResult(await sql.query(query, params));
      },
      async transaction(queries) {
        const results = await sql.transaction((txn) =>
          queries.map((query) => txn.query(query.sql, query.params ?? [])));
        return results.map(normalizeQueryResult);
      },
      async end() {},
    };
  }
  if (driver === "pg") {
    const pool = new Pool({
      connectionString: databaseUrl,
      max: 1,
      connectionTimeoutMillis: 20_000,
      statement_timeout: 60_000,
    });
    return {
      async query(query, params = []) {
        return normalizeQueryResult(await pool.query(query, params));
      },
      async transaction(queries) {
        const client = await pool.connect();
        try {
          await client.query("begin");
          const results = [];
          for (const query of queries) {
            results.push(normalizeQueryResult(
              await client.query(query.sql, query.params ?? []),
            ));
          }
          await client.query("commit");
          return results;
        } catch (error) {
          await client.query("rollback").catch(() => undefined);
          throw error;
        } finally {
          client.release();
        }
      },
      async end() {
        await pool.end();
      },
    };
  }
  fail("AAIS_0028_DATABASE_DRIVER_INVALID");
}

function normalizeQueryResult(result) {
  if (Array.isArray(result)) return { rows: result };
  if (result && typeof result === "object" && Array.isArray(result.rows)) {
    return { rows: result.rows };
  }
  return { rows: [] };
}

function assertReservation(actual, expected, code) {
  assert(
    actual.used === expected.used
      && actual.granted === expected.granted
      && actual.reservation_id === expected.reservationId
      && actual.operation_status === expected.operationStatus
      && actual.result_message_id === null,
    code,
  );
}

function sameRows(actual, expected, leftKey, rightKey) {
  return actual.length === expected.length
    && expected.every(([left, right]) => actual.some((row) =>
      row[leftKey] === left && row[rightKey] === right));
}

function readDatabaseUrl(value) {
  try {
    const parsed = new URL(String(value ?? "").trim());
    if ((parsed.protocol !== "postgres:" && parsed.protocol !== "postgresql:")
      || !parsed.hostname.endsWith(".neon.tech")
      || !parsed.username
      || !parsed.password) {
      fail("AAIS_0028_DATABASE_URL_INVALID");
    }
    return parsed.toString();
  } catch (error) {
    if (error instanceof AaisAiGuideOperationMigrationVerificationError) throw error;
    fail("AAIS_0028_DATABASE_URL_INVALID");
  }
}

function assert(condition, code) {
  if (!condition) fail(code);
}

function fail(code) {
  throw new AaisAiGuideOperationMigrationVerificationError(code);
}

function parseOutputPath(argv) {
  if (argv.length !== 2 || argv[0] !== "--output") {
    fail("AAIS_0028_OUTPUT_PATH_REQUIRED");
  }
  const outputPath = String(argv[1] ?? "").trim();
  if (!outputPath || outputPath.includes("\0")) {
    fail("AAIS_0028_OUTPUT_PATH_INVALID");
  }
  return outputPath;
}

async function main() {
  try {
    const report = await verifyAaisAiGuideOperationMigration({
      databaseUrl: process.env.AAIS_DATABASE_URL,
      driver: process.env.AAIS_DATABASE_DRIVER,
      target: process.env.AAIS_AI_GUIDE_MIGRATION_TARGET,
      approved: process.env.AAIS_AI_GUIDE_MIGRATION_VERIFY_APPROVED === "true",
    });
    const outputPath = parseOutputPath(process.argv.slice(2));
    writeFileSync(outputPath, `${JSON.stringify(report, null, 2)}\n`, {
      encoding: "utf8",
      mode: 0o600,
      flag: "wx",
    });
    console.log(JSON.stringify({
      status: report.status,
      target: report.target,
      targetFingerprint: report.targetFingerprint,
      postgresMajorVersion: report.postgresMajorVersion,
      migrationVersion: report.migration.version,
      ledgerCount: report.migration.ledgerCount,
      chargedOnce: report.behavior.chargedOnce,
      transactionalCleanup: report.behavior.transactionalCleanup,
      secrets: "redacted",
    }));
  } catch (error) {
    const code = error instanceof AaisAiGuideOperationMigrationVerificationError
      ? error.code
      : "AAIS_0028_VERIFICATION_FAILED";
    const databaseCode = typeof error?.code === "string"
      && /^[A-Z][A-Z0-9_]{1,63}$/.test(error.code)
      ? error.code
      : null;
    const errorType = ["Error", "TypeError", "RangeError"].includes(error?.name)
      ? error.name
      : "Error";
    console.error(JSON.stringify({
      status: "blocked",
      code,
      databaseCode,
      errorType,
      failureStage: code === "AAIS_0028_VERIFICATION_FAILED"
        ? error?.verificationStage ?? null
        : null,
      secrets: "redacted",
    }));
    process.exitCode = 1;
  }
}

const invokedPath = process.argv[1] ? pathToFileURL(process.argv[1]).href : "";
if (import.meta.url === invokedPath) await main();
