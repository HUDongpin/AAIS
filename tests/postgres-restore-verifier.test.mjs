import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  getAaisRestoreDatabaseConfiguration,
  loadAaisRestoreEnvFile,
  parseAaisEnvFile,
  runAaisPostgresRestoreVerification,
} from "../scripts/verify-postgres-restore.mjs";

let tempDir = "";

afterEach(async () => {
  if (tempDir) {
    await rm(tempDir, { force: true, recursive: true });
    tempDir = "";
  }
});

describe("AAIS Postgres restore verifier", () => {
  it("verifies restored-staging schema and rolled-back synthetic insert without leaking secrets", async () => {
    const database = new FakeRestoreDatabase();

    const report = await runAaisPostgresRestoreVerification({
      database,
      targetPurpose: "restored-staging",
      sourceEnv: "AAIS_RESTORE_DATABASE_URL",
      releaseId: "aais-restore-test",
    });

    expect(report).toMatchObject({
      schemaVersion: 1,
      status: "passed",
      targetPurpose: "restored-staging",
      sourceEnv: "AAIS_RESTORE_DATABASE_URL",
      releaseId: "aais-restore-test",
      checks: {
        targetPurpose: {
          status: "passed",
          required: "restored-staging",
        },
        requiredTables: {
          status: "passed",
          present: true,
          missing: [],
        },
        rowCounts: {
          learnerSessions: 12,
          lrsOutbox: 2,
          events: 44,
          learnerTaskState: 9,
          users: 3,
          courses: 1,
          courseTasks: 4,
          enrollments: 0,
        },
        smokeInsert: {
          status: "passed",
          insertAccepted: true,
          rolledBack: true,
          writeMode: "insert-only-rolled-back",
        },
      },
      issues: [],
      redaction: {
        databaseUrl: "omitted",
        learnerPayload: "synthetic-only",
        learnerIdentifiers: "omitted",
        secrets: "redacted",
      },
    });
    expect(database.queries.map((query) => query.sql.trim().toLowerCase())).toEqual([
      expect.stringContaining("to_regclass('public.aais_learner_sessions')"),
      expect.stringContaining("select count(*)::int from aais_learner_sessions"),
      "begin",
      expect.stringContaining("insert into aais_learner_sessions"),
      "rollback",
    ]);
    const serialized = JSON.stringify(report);
    expect(serialized).not.toContain("postgres://owner:secret@example.test/aais");
    expect(serialized).not.toContain("restore-smoke-");
  });

  it("fails closed when the target purpose is not restored-staging", async () => {
    const database = new FakeRestoreDatabase();

    const report = await runAaisPostgresRestoreVerification({
      database,
      targetPurpose: "production",
      sourceEnv: "AAIS_RESTORE_DATABASE_URL",
    });

    expect(report.status).toBe("failed");
    expect(report.issues).toEqual(expect.arrayContaining([
      "AAIS_RESTORE_TARGET_PURPOSE",
      "AAIS_RESTORE_SMOKE_INSERT",
    ]));
    expect(report.checks.targetPurpose.status).toBe("failed");
    expect(report.checks.smokeInsert.status).toBe("skipped");
    expect(database.queries.map((query) => query.sql.trim().toLowerCase())).not.toContain("begin");
  });

  it("reports missing restore schema without attempting a smoke write", async () => {
    const database = new FakeRestoreDatabase({
      missingTables: ["aais_events"],
    });

    const report = await runAaisPostgresRestoreVerification({
      database,
      targetPurpose: "restored-staging",
      sourceEnv: "AAIS_RESTORE_DATABASE_URL",
    });

    expect(report.status).toBe("failed");
    expect(report.issues).toEqual(expect.arrayContaining([
      "AAIS_RESTORE_SCHEMA",
      "AAIS_RESTORE_SMOKE_INSERT",
    ]));
    expect(report.checks.requiredTables.missing).toEqual(["aais_events"]);
    expect(report.checks.smokeInsert.status).toBe("skipped");
    expect(database.queries.map((query) => query.sql.trim().toLowerCase())).not.toContain("begin");
  });

  it("loads restore-specific env values by name without exposing the URL", async () => {
    tempDir = await mkdtemp(path.join(tmpdir(), "aais-restore-env-"));
    const envFile = path.join(tempDir, ".env.postgres-restore.local");
    await writeFile(envFile, [
      "AAIS_RESTORE_DATABASE_URL='postgres://owner:secret@example.test/aais'",
      "AAIS_RESTORE_TARGET_PURPOSE=restored-staging",
      "AAIS_RELEASE_ID=aais-restore-test",
    ].join("\n"));

    const env = await loadAaisRestoreEnvFile(envFile);

    expect(getAaisRestoreDatabaseConfiguration(env)).toEqual({
      url: "postgres://owner:secret@example.test/aais",
      sourceEnv: "AAIS_RESTORE_DATABASE_URL",
    });
    expect(Object.keys(env)).toEqual([
      "AAIS_RESTORE_DATABASE_URL",
      "AAIS_RESTORE_TARGET_PURPOSE",
      "AAIS_RELEASE_ID",
    ]);
  });

  it("parses simple env files while ignoring comments and invalid keys", () => {
    expect(parseAaisEnvFile([
      "# comment",
      "export AAIS_RESTORE_TARGET_PURPOSE=restored-staging",
      "AAIS_RELEASE_ID=\"aais-restore-test\"",
      "1_BAD=value",
    ].join("\n"))).toEqual({
      AAIS_RESTORE_TARGET_PURPOSE: "restored-staging",
      AAIS_RELEASE_ID: "aais-restore-test",
    });
  });
});

class FakeRestoreDatabase {
  constructor(input = {}) {
    this.missingTables = new Set(input.missingTables ?? []);
    this.queries = [];
  }

  async query(sql, params = []) {
    this.queries.push({ sql, params });
    const normalized = sql.trim().toLowerCase();
    if (normalized.startsWith("select") && normalized.includes("to_regclass")) {
      return {
        rows: [
          Object.fromEntries([
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
          ].map((table) => [table, this.missingTables.has(table) ? null : table])),
        ],
      };
    }
    if (normalized.startsWith("select") && normalized.includes("count(*)::int")) {
      return {
        rows: [{
          learner_sessions: 12,
          lrs_outbox: 2,
          events: 44,
          learner_task_state: 9,
          users: 3,
          courses: 1,
          course_tasks: 4,
          enrollments: 0,
        }],
      };
    }
    if (normalized.startsWith("insert into aais_learner_sessions")) {
      return {
        rows: [{ student_id: params[0] }],
      };
    }
    return { rows: [] };
  }
}
