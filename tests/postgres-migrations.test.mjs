import { describe, expect, it } from "vitest";
import {
  getAaisMigrationDatabaseConfiguration,
  loadAaisPostgresMigrations,
  runAaisPostgresMigrations,
} from "../scripts/run-postgres-migrations.mjs";

describe("AAIS Postgres migrations", () => {
  it("loads the baseline migration from disk", async () => {
    const migrations = await loadAaisPostgresMigrations();

    expect(migrations).toEqual([
      expect.objectContaining({
        version: "0001",
        name: "aais_baseline",
        fileName: "0001_aais_baseline.sql",
        checksum: expect.stringMatching(/^[a-f0-9]{64}$/),
      }),
      expect.objectContaining({
        version: "0002",
        name: "login_rate_limits",
        fileName: "0002_login_rate_limits.sql",
        checksum: expect.stringMatching(/^[a-f0-9]{64}$/),
      }),
      expect.objectContaining({
        version: "0003",
        name: "aais_events",
        fileName: "0003_aais_events.sql",
        checksum: expect.stringMatching(/^[a-f0-9]{64}$/),
      }),
      expect.objectContaining({
        version: "0004",
        name: "learner_task_state",
        fileName: "0004_learner_task_state.sql",
        checksum: expect.stringMatching(/^[a-f0-9]{64}$/),
      }),
      expect.objectContaining({
        version: "0005",
        name: "users_and_auth_tokens",
        fileName: "0005_users_and_auth_tokens.sql",
        checksum: expect.stringMatching(/^[a-f0-9]{64}$/),
      }),
      expect.objectContaining({
        version: "0006",
        name: "session_revocations",
        fileName: "0006_session_revocations.sql",
        checksum: expect.stringMatching(/^[a-f0-9]{64}$/),
      }),
      expect.objectContaining({
        version: "0007",
        name: "course_catalog",
        fileName: "0007_course_catalog.sql",
        checksum: expect.stringMatching(/^[a-f0-9]{64}$/),
      }),
      expect.objectContaining({
        version: "0008",
        name: "ai_guide_daily_usage",
        fileName: "0008_ai_guide_daily_usage.sql",
        checksum: expect.stringMatching(/^[a-f0-9]{64}$/),
      }),
      expect.objectContaining({
        version: "0009",
        name: "user_account_id_casefold_unique",
        fileName: "0009_user_account_id_casefold_unique.sql",
        checksum: expect.stringMatching(/^[a-f0-9]{64}$/),
      }),
    ]);
    expect(migrations[0].sql).toContain("create table if not exists aais_learner_sessions");
    expect(migrations[0].sql).toContain("create table if not exists aais_lrs_outbox");
    expect(migrations[1].sql).toContain("create table if not exists aais_login_rate_limits");
    expect(migrations[2].sql).toContain("create table if not exists aais_events");
    expect(migrations[2].sql).toContain("jsonb_array_elements");
    expect(migrations[2].sql).toContain("on conflict do nothing");
    expect(migrations[3].sql).toContain("create table if not exists aais_learner_task_state");
    expect(migrations[3].sql).toContain("artifact_characters");
    expect(migrations[3].sql).toContain("jsonb_array_elements");
    expect(migrations[3].sql).toContain("on conflict (student_id, task) do update");
    expect(migrations[4].sql).toContain("create table if not exists aais_users");
    expect(migrations[4].sql).toContain("create table if not exists aais_user_auth_tokens");
    expect(migrations[4].sql).toContain("token_hash");
    expect(migrations[5].sql).toContain("create table if not exists aais_session_revocations");
    expect(migrations[5].sql).toContain("token_hash");
    expect(migrations[6].sql).toContain("create table if not exists aais_courses");
    expect(migrations[6].sql).toContain("create table if not exists aais_course_tasks");
    expect(migrations[6].sql).toContain("create table if not exists aais_enrollments");
    expect(migrations[6].sql).toContain("Cognitive Apprenticeship: Metacognition Studio");
    expect(migrations[6].sql).toContain("practice_task_3");
    expect(migrations[7].sql).toContain("create table if not exists aais_ai_guide_daily_usage");
    expect(migrations[7].sql).toContain("primary key (student_id, usage_day)");
    expect(migrations[7].sql).toContain("where event = 'ai_prompt_submitted'");
    expect(migrations[7].sql).toContain("(event_time at time zone 'UTC')::date");
    expect(migrations[7].sql).toContain("date_trunc('day', now() at time zone 'UTC')");
    expect(migrations[7].sql).toContain("interval '1 day'");
    expect(migrations[7].sql).toContain("event_time >= utc_day.starts_at");
    expect(migrations[7].sql).toContain("event_time < utc_day.ends_at");
    expect(migrations[7].sql).toContain("group by student_id, (event_time at time zone 'UTC')::date");
    expect(migrations[7].sql).toContain("on conflict (student_id, usage_day)");
    expect(migrations[7].sql).toContain("greatest(aais_ai_guide_daily_usage.used, excluded.used)");
    expect(normalizeSql(migrations[8].sql)).toBe(
      "create unique index aais_users_id_casefold_unique_idx on aais_users (lower(id));",
    );
    expect(migrations[8].sql.toLowerCase()).not.toContain("if not exists");
  });

  it("applies the case-fold index after 0008 and records it in the migration ledger", async () => {
    const database = new FakeMigrationDatabase({
      "0008": "checksum-0008",
    });
    const migrations = [
      createMigration("0008", "ai_guide_daily_usage", "select 8;"),
      createMigration(
        "0009",
        "user_account_id_casefold_unique",
        "create unique index aais_users_id_casefold_unique_idx on aais_users (lower(id));",
      ),
    ];

    const report = await runAaisPostgresMigrations({ database, migrations });

    expect(report).toMatchObject({ applied: 1, skipped: 1 });
    expect(report.migrations.map(({ version, status }) => ({ version, status }))).toEqual([
      { version: "0008", status: "skipped" },
      { version: "0009", status: "applied" },
    ]);
    expect(database.applied.get("0009")).toBe("checksum-0009");
  });

  it("rolls back without recording 0009 when existing IDs collide case-insensitively", async () => {
    const database = new CasefoldIndexMigrationDatabase({ existingIds: ["Phoebe", "phoebe"] });
    const migration = createMigration(
      "0009",
      "user_account_id_casefold_unique",
      "create unique index aais_users_id_casefold_unique_idx on aais_users (lower(id));",
    );

    await expect(runAaisPostgresMigrations({ database, migrations: [migration] }))
      .rejects.toThrow("duplicate key value violates unique constraint");

    expect(database.queries.map(({ sql }) => normalizeSql(sql))).toEqual([
      expect.stringContaining("create table if not exists aais_schema_migrations"),
      "select version, checksum from aais_schema_migrations order by version",
      "begin",
      "create unique index aais_users_id_casefold_unique_idx on aais_users (lower(id));",
      "rollback",
    ]);
    expect(database.applied.has("0009")).toBe(false);
  });

  it("uses the installed lower(id) index as the final guard against a non-cooperating writer", async () => {
    const database = new CasefoldIndexMigrationDatabase({ existingIds: ["Phoebe"] });
    const migration = createMigration(
      "0009",
      "user_account_id_casefold_unique",
      "create unique index aais_users_id_casefold_unique_idx on aais_users (lower(id));",
    );

    await runAaisPostgresMigrations({ database, migrations: [migration] });

    expect(() => database.nonCooperatingInsert("pHOEBe"))
      .toThrow("aais_users_id_casefold_unique_idx");
    expect(() => database.nonCooperatingInsert("Bobie")).not.toThrow();
  });

  it("applies pending migrations and records checksums", async () => {
    const database = new FakeMigrationDatabase();
    const migrations = [createMigration("0001", "aais_baseline", "create table aais_test (id text);")];

    const report = await runAaisPostgresMigrations({ database, migrations });

    expect(report).toMatchObject({
      schemaVersion: 1,
      status: "pass",
      applied: 1,
      skipped: 0,
      secrets: "redacted",
    });
    expect(report.migrations[0]).toMatchObject({
      version: "0001",
      name: "aais_baseline",
      status: "applied",
      checksum: "checksum-000",
    });
    expect(database.queries.map((query) => query.sql.trim().toLowerCase())).toEqual([
      expect.stringContaining("create table if not exists aais_schema_migrations"),
      "select version, checksum from aais_schema_migrations order by version",
      "begin",
      "create table aais_test (id text);",
      expect.stringContaining("insert into aais_schema_migrations"),
      "commit",
    ]);
    expect(database.applied.get("0001")).toEqual("checksum-0001");
  });

  it("skips already applied migrations with the same checksum", async () => {
    const database = new FakeMigrationDatabase({
      "0001": "checksum-0001",
    });
    const migrations = [createMigration("0001", "aais_baseline", "create table aais_test (id text);")];

    const report = await runAaisPostgresMigrations({ database, migrations });

    expect(report).toMatchObject({
      applied: 0,
      skipped: 1,
    });
    expect(report.migrations[0].status).toBe("skipped");
    expect(database.queries.map((query) => query.sql.trim().toLowerCase())).not.toContain("begin");
  });

  it("uses a non-interactive transaction client when available", async () => {
    const database = new FakeTransactionMigrationDatabase();
    const migrations = [createMigration(
      "0001",
      "aais_baseline",
      "create table aais_test (id text);\ninsert into aais_test (id) values ('quoted; semicolon');",
    )];

    const report = await runAaisPostgresMigrations({ database, migrations });

    expect(report).toMatchObject({
      applied: 1,
      skipped: 0,
    });
    expect(database.transactions).toEqual([
      [
        "create table aais_test (id text)",
        "insert into aais_test (id) values ('quoted; semicolon')",
        expect.stringContaining("insert into aais_schema_migrations"),
      ],
    ]);
    expect(database.queries.map((query) => query.sql.trim().toLowerCase())).not.toContain("begin");
    expect(database.queries.map((query) => query.sql.trim().toLowerCase())).not.toContain("commit");
    expect(database.applied.get("0001")).toEqual("checksum-0001");
  });

  it("fails when an applied migration checksum changes", async () => {
    const database = new FakeMigrationDatabase({
      "0001": "older-checksum",
    });
    const migrations = [createMigration("0001", "aais_baseline", "create table aais_test (id text);")];

    await expect(runAaisPostgresMigrations({ database, migrations }))
      .rejects.toThrow("AAIS migration checksum mismatch for 0001.");
  });

  it("resolves Postgres config from URL and raw PG environment without exposing values", () => {
    expect(getAaisMigrationDatabaseConfiguration({
      AAIS_DATABASE_URL: "postgres://user:pass@example.test/aais",
    })).toEqual({
      url: "postgres://user:pass@example.test/aais",
      sourceEnv: "AAIS_DATABASE_URL",
    });
    expect(getAaisMigrationDatabaseConfiguration({
      PGHOST: "db.example.test",
      PGUSER: "aais",
      PGPASSWORD: "secret",
      PGDATABASE: "prod",
      PGPORT: "5433",
    })).toEqual({
      url: "postgres://aais:secret@db.example.test:5433/prod?sslmode=require",
      sourceEnv: "PG*",
    });
  });
});

function createMigration(version, name, sql) {
  return {
    version,
    name,
    fileName: `${version}_${name}.sql`,
    sql,
    checksum: `checksum-${version}`,
  };
}

function normalizeSql(sql) {
  return String(sql).trim().replace(/\s+/g, " ").toLowerCase();
}

class FakeMigrationDatabase {
  constructor(applied = {}) {
    this.applied = new Map(Object.entries(applied));
    this.queries = [];
  }

  async query(sql, params = []) {
    this.queries.push({ sql, params });
    const normalized = sql.trim().toLowerCase();
    if (normalized.startsWith("select version, checksum from aais_schema_migrations")) {
      return {
        rows: [...this.applied.entries()].map(([version, checksum]) => ({
          version,
          checksum,
        })),
      };
    }
    if (normalized.startsWith("insert into aais_schema_migrations")) {
      this.applied.set(String(params[0]), String(params[2]));
    }
    return { rows: [] };
  }
}

class FakeTransactionMigrationDatabase extends FakeMigrationDatabase {
  transactions = [];

  async transaction(queries) {
    this.transactions.push(queries.map((query) => query.sql.trim()));
    for (const query of queries) {
      await this.query(query.sql, query.params);
    }
    return queries.map(() => ({ rows: [] }));
  }
}

class CasefoldIndexMigrationDatabase extends FakeMigrationDatabase {
  constructor({ existingIds }) {
    super();
    this.existingIds = [...existingIds];
    this.casefoldIndexInstalled = false;
  }

  async query(sql, params = []) {
    const normalized = normalizeSql(sql);
    if (normalized === "create unique index aais_users_id_casefold_unique_idx on aais_users (lower(id));") {
      this.queries.push({ sql, params });
      const folded = this.existingIds.map((id) => id.toLowerCase());
      if (new Set(folded).size !== folded.length) {
        throw new Error("duplicate key value violates unique constraint");
      }
      this.casefoldIndexInstalled = true;
      return { rows: [] };
    }
    return super.query(sql, params);
  }

  nonCooperatingInsert(id) {
    if (this.casefoldIndexInstalled
      && this.existingIds.some((existing) => existing.toLowerCase() === id.toLowerCase())) {
      throw new Error("duplicate key value violates unique constraint aais_users_id_casefold_unique_idx");
    }
    this.existingIds.push(id);
  }
}
