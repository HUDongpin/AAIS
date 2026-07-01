import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { runAaisPostgresRestoreRehearsal } from "../scripts/verify-postgres-restore.mjs";

let tempDir;

beforeEach(async () => {
  tempDir = await mkdtemp(path.join(tmpdir(), "aais-restore-"));
});

afterEach(async () => {
  vi.unstubAllEnvs();
  await rm(tempDir, { force: true, recursive: true });
});

describe("AAIS Postgres restore rehearsal verifier", () => {
  it("checks schema, performs a smoke round trip, deletes the smoke row, and writes a redacted report", async () => {
    const outputPath = path.join(tempDir, "restore-report.json");
    const queries = [];
    const database = {
      async query(sql, params = []) {
        queries.push({ sql, params });
        if (/to_regclass/i.test(sql)) {
          return { rows: [{ table_name: "aais_learner_sessions" }] };
        }
        if (/count\(\*\)/i.test(sql)) {
          return { rows: [{ session_count: "12" }] };
        }
        if (/select payload from aais_learner_sessions/i.test(sql)) {
          return {
            rows: [
              {
                payload: {
                  schemaVersion: 1,
                  studentId: "restore-smoke",
                  activeTaskId: "training_task_1",
                  events: [],
                },
              },
            ],
          };
        }
        return { rows: [] };
      },
      async end() {
        queries.push({ sql: "end", params: [] });
      },
    };

    const report = await runAaisPostgresRestoreRehearsal({
      databaseUrl: "postgres://restore-user:restore-secret@ep-restored.us-east-1.aws.neon.tech/aais_restore",
      sourceDatabaseUrl: "postgres://prod-user:prod-secret@example.test/aais",
      database,
      outputPath,
      smokeStudentId: "restore-smoke",
      releaseId: "aais-2026-06-30-rc1",
      now: new Date("2026-06-30T02:00:00.000Z"),
    });

    expect(report).toMatchObject({
      schemaVersion: 1,
      status: "passed",
      checkedAt: "2026-06-30T02:00:00.000Z",
      release: {
        id: "aais-2026-06-30-rc1",
      },
      target: {
        databaseUrl: "redacted",
        provider: "neon",
        sameAsSource: false,
      },
      checks: {
        tablePresent: true,
        existingSessionCount: 12,
        smokeInserted: true,
        smokeReadBack: true,
        smokeDeleted: true,
      },
      redaction: {
        secrets: "omitted",
      },
    });
    expect(queries.map((query) => query.sql)).toEqual(
      expect.arrayContaining([
        expect.stringMatching(/to_regclass/i),
        expect.stringMatching(/count\(\*\)/i),
        expect.stringMatching(/insert into aais_learner_sessions/i),
        expect.stringMatching(/select payload from aais_learner_sessions/i),
        expect.stringMatching(/delete from aais_learner_sessions/i),
        "end",
      ]),
    );

    const serialized = JSON.stringify(report);
    expect(serialized).not.toContain("restore-secret");
    expect(serialized).not.toContain("prod-secret");
    const written = JSON.parse(await readFile(outputPath, "utf8"));
    expect(written).toEqual(report);
  });

  it("reads the restored Neon URL from a private env file without leaking it", async () => {
    const envFilePath = path.join(tempDir, "restore.env");
    await writeFile(envFilePath, [
      "AAIS_RESTORE_DATABASE_URL=postgres://restore-user:restore-secret@ep-restored.us-east-1.aws.neon.tech/aais_restore",
      "AAIS_RESTORE_DATABASE_PROVIDER=neon",
      "",
    ].join("\n"), "utf8");
    const database = {
      async query(sql) {
        if (/to_regclass/i.test(sql)) {
          return { rows: [{ table_name: "aais_learner_sessions" }] };
        }
        if (/count\(\*\)/i.test(sql)) {
          return { rows: [{ session_count: "0" }] };
        }
        if (/select payload from aais_learner_sessions/i.test(sql)) {
          return { rows: [{ payload: { schemaVersion: 1, studentId: "restore-smoke" } }] };
        }
        return { rows: [] };
      },
      async end() {},
    };

    const report = await runAaisPostgresRestoreRehearsal({
      envFilePath,
      database,
      smokeStudentId: "restore-smoke",
      now: new Date("2026-06-30T02:00:00.000Z"),
    });

    expect(report).toMatchObject({
      status: "passed",
      target: {
        databaseUrl: "redacted",
        provider: "neon",
      },
    });
    expect(JSON.stringify(report)).not.toContain("restore-secret");
    expect(JSON.stringify(report)).not.toContain("ep-restored.us-east-1.aws.neon.tech");
  });

  it("refuses to run against the production database URL by default", async () => {
    await expect(runAaisPostgresRestoreRehearsal({
      databaseUrl: "postgres://prod-user:prod-secret@example.test/aais",
      sourceDatabaseUrl: "postgres://prod-user:prod-secret@example.test/aais",
      database: {
        async query() {
          throw new Error("should not query production");
        },
      },
    })).rejects.toThrow("AAIS restore rehearsal target must differ from production database sources");
  });

  it("refuses Vercel Neon fallback production database sources as restore targets", async () => {
    vi.stubEnv("DATABASE_URL", "postgres://prod-user:prod-secret@ep-prod.us-east-1.aws.neon.tech/aais?sslmode=require");

    await expect(runAaisPostgresRestoreRehearsal({
      databaseUrl: "postgres://prod-user:other-secret@ep-prod.us-east-1.aws.neon.tech/aais",
      database: {
        async query() {
          throw new Error("should not query production");
        },
      },
    })).rejects.toThrow("AAIS restore rehearsal target must differ from production database sources");
  });

  it("treats owner-fillable restore URL placeholders as missing before opening a database connection", async () => {
    await expect(runAaisPostgresRestoreRehearsal({
      databaseUrl: "<REQUIRED:RESTORED_NEON_STAGING_DATABASE_URL>",
      database: {
        async query() {
          throw new Error("should not query a placeholder restore target");
        },
      },
    })).rejects.toThrow("AAIS_RESTORE_DATABASE_URL is required for AAIS restore rehearsal");
  });

  it("refuses to label a non-Neon restore target as Neon", async () => {
    await expect(runAaisPostgresRestoreRehearsal({
      databaseUrl: "postgres://restore-user:restore-secret@example.test/aais_restore",
      databaseProvider: "neon",
      database: {
        async query() {
          throw new Error("should not query a mislabeled restore target");
        },
      },
    })).rejects.toThrow("AAIS restore database provider must match the database URL host");
  });

  it("fails when the restored database is missing the learner sessions table", async () => {
    const report = await runAaisPostgresRestoreRehearsal({
      databaseUrl: "postgres://restore-user:restore-secret@example.test/aais_restore",
      database: {
        async query(sql) {
          if (/to_regclass/i.test(sql)) {
            return { rows: [{ table_name: null }] };
          }
          return { rows: [] };
        },
      },
      now: new Date("2026-06-30T02:00:00.000Z"),
    });

    expect(report).toMatchObject({
      status: "failed",
      checks: {
        tablePresent: false,
        smokeInserted: false,
        smokeReadBack: false,
        smokeDeleted: false,
      },
      redaction: {
        secrets: "omitted",
      },
    });
    expect(JSON.stringify(report)).not.toContain("restore-secret");
  });
});
