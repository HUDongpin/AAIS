import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  AaisAiGuideOperationMigrationVerificationError,
  verifyAaisAiGuideOperationMigration,
} from "../scripts/verify-ai-guide-operation-idempotency.mjs";

const syntheticDatabaseUrl =
  "postgresql://synthetic-user:synthetic-password@ep-synthetic.neon.tech/neondb";
const migrationChecksum = createHash("sha256")
  .update(readFileSync(path.join(
    process.cwd(),
    "migrations",
    "postgres",
    "0028_ai_guide_operation_idempotency.sql",
  )))
  .digest("hex");

describe("AAIS 0028 formal target verifier", () => {
  it("accepts the complete catalog and charged-once behavior contract", async () => {
    const database = createPassingDatabase();
    const report = await verifyAaisAiGuideOperationMigration({
      databaseUrl: syntheticDatabaseUrl,
      target: "staging",
      approved: true,
      database,
    });

    expect(report).toMatchObject({
      status: "pass",
      target: "staging",
      postgresMajorVersion: 18,
      migration: {
        version: "0028",
        checksum: migrationChecksum,
        ledgerCount: 28,
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
    });
    expect(report.targetFingerprint).toMatch(/^[a-f0-9]{64}$/);
    expect(JSON.stringify(report)).not.toContain("synthetic-password");
    expect(database.transactionQueries).toHaveLength(11);
    expect(database.transactionQueries.slice(-3).map((query) => query.sql)).toEqual([
      "delete from public.aais_ai_guide_reservations where student_id = $1",
      "delete from public.aais_ai_guide_daily_usage where student_id = $1",
      "delete from public.aais_learner_data_generations where student_id = $1",
    ]);
  });

  it("refuses an unapproved or non-staging target before a database call", async () => {
    for (const input of [
      { target: "staging", approved: false },
      { target: "production", approved: true },
    ]) {
      const database = createPassingDatabase();
      await expect(verifyAaisAiGuideOperationMigration({
        databaseUrl: syntheticDatabaseUrl,
        database,
        ...input,
      })).rejects.toMatchObject({
        code: "AAIS_0028_TARGET_NOT_APPROVED",
      });
      expect(database.queryCount).toBe(0);
    }
  });

  it("fails closed when the formal target catalog is incomplete", async () => {
    const database = createPassingDatabase();
    database.omitOperationIndex = true;
    let caught;
    try {
      await verifyAaisAiGuideOperationMigration({
        databaseUrl: syntheticDatabaseUrl,
        target: "staging",
        approved: true,
        database,
      });
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(AaisAiGuideOperationMigrationVerificationError);
    expect(caught).toMatchObject({ code: "AAIS_0028_INDEXES_INVALID" });
    expect(database.transactionQueries).toHaveLength(0);
  });
});

function createPassingDatabase() {
  return {
    queryCount: 0,
    transactionQueries: [],
    omitOperationIndex: false,
    async query(sql) {
      this.queryCount += 1;
      if (sql.includes("current_database()")) {
        return { rows: [{ database_name: "neondb", server_version_num: 180_000 }] };
      }
      if (sql.includes("from public.aais_schema_migrations")) {
        return {
          rows: Array.from({ length: 28 }, (_, index) => index === 27
            ? {
                version: "0028",
                name: "ai_guide_operation_idempotency",
                checksum: migrationChecksum,
              }
            : {
                version: String(index + 1).padStart(4, "0"),
                name: `migration_${index + 1}`,
                checksum: "0".repeat(64),
              }),
        };
      }
      if (sql.includes("from information_schema.columns")) {
        return { rows: [
          { column_name: "data_generation", data_type: "bigint" },
          { column_name: "operation_id", data_type: "uuid" },
          { column_name: "payload_digest", data_type: "text" },
          { column_name: "operation_state", data_type: "text" },
          { column_name: "result_message_id", data_type: "text" },
          {
            column_name: "operation_lease_expires_at",
            data_type: "timestamp with time zone",
          },
        ] };
      }
      if (sql.includes("from pg_catalog.pg_constraint")) {
        return { rows: [
          {
            conname: "aais_ai_guide_reservations_operation_state_check",
            convalidated: true,
          },
          {
            conname: "aais_ai_guide_reservations_payload_digest_check",
            convalidated: true,
          },
        ] };
      }
      if (sql.includes("from pg_catalog.pg_index")) {
        return { rows: [
          ...(this.omitOperationIndex ? [] : [{
            index_name: "aais_ai_guide_reservations_operation_idx",
            indisunique: true,
            partial: true,
          }]),
          {
            index_name: "aais_ai_guide_reservations_operation_lease_idx",
            indisunique: false,
            partial: true,
          },
        ] };
      }
      if (sql.includes("from pg_catalog.pg_proc")) {
        return { rows: [{
          pronargs: 9,
          provolatile: "v",
          prosecdef: false,
          proconfig: ["search_path=pg_catalog, public, pg_temp"],
        }] };
      }
      if (sql.includes("generation_rows")) {
        return { rows: [{ generation_rows: 0, usage_rows: 0, reservation_rows: 0 }] };
      }
      throw new Error("UNEXPECTED_TEST_QUERY");
    },
    async transaction(queries) {
      this.transactionQueries = queries;
      return [
        { rows: [] },
        reservationRow(1, true, "00000000-0000-4000-8000-000000002801", "reserved"),
        reservationRow(1, false, "00000000-0000-4000-8000-000000002801", "in_progress"),
        reservationRow(1, false, "00000000-0000-4000-8000-000000002801", "conflict"),
        reservationRow(0, false, "00000000-0000-4000-8000-000000002801", "failed"),
        reservationRow(1, true, "00000000-0000-4000-8000-000000002802", "reserved"),
        reservationRow(1, false, "00000000-0000-4000-8000-000000002802", "in_progress"),
        { rows: [{ used: 1 }] },
        { rows: [] },
        { rows: [] },
        { rows: [] },
      ];
    },
    async end() {},
  };
}

function reservationRow(used, granted, reservationId, operationStatus) {
  return { rows: [{
    used,
    granted,
    reservation_id: reservationId,
    operation_status: operationStatus,
    result_message_id: null,
  }] };
}
