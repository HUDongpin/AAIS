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
        if (/aais_lrs_outbox/i.test(sql)) {
          return { rows: [{ table_name: "aais_lrs_outbox" }] };
        }
        if (/aais_learner_sessions/i.test(sql) && /to_regclass/i.test(sql)) {
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
      targetPurpose: "restored-staging",
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
        purpose: "restored-staging",
        sameAsSource: false,
        productionSourceCount: 1,
      },
      checks: {
        tablePresent: true,
        lrsOutboxTablePresent: true,
        existingSessionCount: 12,
        smokeInsertOnly: true,
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
    expect(queries.find((query) => /insert into aais_learner_sessions/i.test(query.sql))?.sql)
      .not.toMatch(/on conflict/i);

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
      "AAIS_RESTORE_TARGET_PURPOSE=restored-staging",
      "",
    ].join("\n"), "utf8");
    const database = {
      async query(sql) {
        if (/aais_lrs_outbox/i.test(sql)) {
          return { rows: [{ table_name: "aais_lrs_outbox" }] };
        }
        if (/aais_learner_sessions/i.test(sql) && /to_regclass/i.test(sql)) {
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
        purpose: "restored-staging",
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

  it("refuses production database sources loaded from a private source env file", async () => {
    const sourceEnvFilePath = path.join(tempDir, "production.env");
    await writeFile(sourceEnvFilePath, [
      "DATABASE_URL=postgres://prod-user:prod-secret@ep-prod.us-east-1.aws.neon.tech/aais?sslmode=require",
      "",
    ].join("\n"), "utf8");

    await expect(runAaisPostgresRestoreRehearsal({
      databaseUrl: "postgres://restore-user:restore-secret@ep-prod.us-east-1.aws.neon.tech/aais",
      sourceEnvFilePath,
      database: {
        async query() {
          throw new Error("should not query production");
        },
      },
    })).rejects.toThrow("AAIS restore rehearsal target must differ from production database sources");
  });

  it("refuses the Vercel Postgres no-SSL production source as a restore target", async () => {
    const sourceEnvFilePath = path.join(tempDir, "production.env");
    await writeFile(sourceEnvFilePath, [
      "POSTGRES_URL_NO_SSL=postgres://prod-user:prod-secret@ep-prod.us-east-1.aws.neon.tech/aais",
      "",
    ].join("\n"), "utf8");

    await expect(runAaisPostgresRestoreRehearsal({
      databaseUrl: "postgres://restore-user:restore-secret@ep-prod.us-east-1.aws.neon.tech/aais?sslmode=require",
      sourceEnvFilePath,
      database: {
        async query() {
          throw new Error("should not query production");
        },
      },
    })).rejects.toThrow("AAIS restore rehearsal target must differ from production database sources");
  });

  it("records only a redacted production source count when a source env file is checked", async () => {
    const sourceEnvFilePath = path.join(tempDir, "production.env");
    await writeFile(sourceEnvFilePath, [
      "DATABASE_URL=postgres://prod-user:prod-secret@ep-prod.us-east-1.aws.neon.tech/aais?sslmode=require",
      "",
    ].join("\n"), "utf8");

    const report = await runAaisPostgresRestoreRehearsal({
      databaseUrl: "postgres://restore-user:restore-secret@ep-restored.us-east-1.aws.neon.tech/aais_restore",
      sourceEnvFilePath,
      targetPurpose: "restored-staging",
      database: passingRestoreDatabase(),
      smokeStudentId: "restore-smoke",
      now: new Date("2026-06-30T02:00:00.000Z"),
    });

    expect(report.target).toMatchObject({
      databaseUrl: "redacted",
      sameAsSource: false,
      productionSourceCount: 1,
    });
    const serialized = JSON.stringify(report);
    expect(serialized).not.toContain("prod-secret");
    expect(serialized).not.toContain("restore-secret");
    expect(serialized).not.toContain("ep-prod.us-east-1.aws.neon.tech");
    expect(serialized).not.toContain("ep-restored.us-east-1.aws.neon.tech");
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
      targetPurpose: "restored-staging",
      database: {
        async query(sql) {
          if (/aais_lrs_outbox/i.test(sql)) {
            return { rows: [{ table_name: "aais_lrs_outbox" }] };
          }
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
        lrsOutboxTablePresent: true,
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

  it("does not overwrite or delete an existing smoke row if the insert collides", async () => {
    const queries = [];
    const report = await runAaisPostgresRestoreRehearsal({
      databaseUrl: "postgres://restore-user:restore-secret@ep-restored.us-east-1.aws.neon.tech/aais_restore",
      targetPurpose: "restored-staging",
      database: {
        async query(sql) {
          queries.push(sql);
          if (/aais_lrs_outbox/i.test(sql)) {
            return { rows: [{ table_name: "aais_lrs_outbox" }] };
          }
          if (/aais_learner_sessions/i.test(sql) && /to_regclass/i.test(sql)) {
            return { rows: [{ table_name: "aais_learner_sessions" }] };
          }
          if (/count\(\*\)/i.test(sql)) {
            return { rows: [{ session_count: "1" }] };
          }
          if (/insert into aais_learner_sessions/i.test(sql)) {
            throw new Error("duplicate key value violates unique constraint");
          }
          throw new Error("should not query after a colliding insert");
        },
        async end() {
          queries.push("end");
        },
      },
      smokeStudentId: "restore-smoke",
      now: new Date("2026-06-30T02:00:00.000Z"),
    });

    expect(report).toMatchObject({
      status: "failed",
      checks: {
        tablePresent: true,
        lrsOutboxTablePresent: true,
        smokeInsertOnly: true,
        smokeInserted: false,
        smokeReadBack: false,
        smokeDeleted: false,
      },
    });
    expect(queries.some((sql) => /on conflict/i.test(sql))).toBe(false);
    expect(queries.some((sql) => /delete from aais_learner_sessions/i.test(sql))).toBe(false);
    expect(JSON.stringify(report)).not.toContain("restore-secret");
    expect(JSON.stringify(report)).not.toContain("duplicate key");
  });

  it("fails when the restore target purpose is not explicitly restored staging", async () => {
    const report = await runAaisPostgresRestoreRehearsal({
      databaseUrl: "postgres://restore-user:restore-secret@ep-restored.us-east-1.aws.neon.tech/aais_restore",
      database: passingRestoreDatabase(),
      smokeStudentId: "restore-smoke",
      now: new Date("2026-06-30T02:00:00.000Z"),
    });

    expect(report).toMatchObject({
      status: "failed",
      target: {
        purpose: "invalid",
      },
      checks: {
        tablePresent: true,
        lrsOutboxTablePresent: true,
        smokeInserted: true,
        smokeReadBack: true,
        smokeDeleted: true,
      },
    });
    expect(JSON.stringify(report)).not.toContain("restore-secret");
  });

  it("fails when the restored database is missing the LRS outbox table", async () => {
    const report = await runAaisPostgresRestoreRehearsal({
      databaseUrl: "postgres://restore-user:restore-secret@ep-restored.us-east-1.aws.neon.tech/aais_restore",
      targetPurpose: "restored-staging",
      database: passingRestoreDatabase({ lrsOutboxTablePresent: false }),
      smokeStudentId: "restore-smoke",
      now: new Date("2026-06-30T02:00:00.000Z"),
    });

    expect(report).toMatchObject({
      status: "failed",
      target: {
        purpose: "restored-staging",
      },
      checks: {
        tablePresent: true,
        lrsOutboxTablePresent: false,
        smokeInserted: true,
        smokeReadBack: true,
        smokeDeleted: true,
      },
    });
    expect(JSON.stringify(report)).not.toContain("restore-secret");
  });
});

function passingRestoreDatabase(input = {}) {
  const lrsOutboxTablePresent = input.lrsOutboxTablePresent ?? true;
  return {
    async query(sql) {
      if (/aais_lrs_outbox/i.test(sql)) {
        return { rows: [{ table_name: lrsOutboxTablePresent ? "aais_lrs_outbox" : null }] };
      }
      if (/aais_learner_sessions/i.test(sql) && /to_regclass/i.test(sql)) {
        return { rows: [{ table_name: "aais_learner_sessions" }] };
      }
      if (/count\(\*\)/i.test(sql)) {
        return { rows: [{ session_count: "1" }] };
      }
      if (/select payload from aais_learner_sessions/i.test(sql)) {
        return { rows: [{ payload: { schemaVersion: 1, studentId: "restore-smoke" } }] };
      }
      return { rows: [] };
    },
    async end() {},
  };
}
