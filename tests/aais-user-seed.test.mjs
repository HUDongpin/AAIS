import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import {
  parseAaisUserSeedJson,
  runAaisUserSeed,
} from "../scripts/seed-aais-users.mjs";

const NOW = new Date("2026-07-09T00:00:00.000Z");
const COURSE_ID = "cognitive-apprenticeship";
const COHORT = "preview-e2e";

describe("AAIS user seed parser", () => {
  it("preserves the existing deterministic default ID", () => {
    const [user] = parseUsers([
      seedEntry({ email: "Teacher@Example.TEST" }),
    ]);

    expect(user).toMatchObject({
      id: "user-19e8fe2869aea407",
      email: "teacher@example.test",
    });
  });

  it("accepts trimmed explicit account IDs without retaining passwords", () => {
    const users = parseUsers([
      seedEntry({ accountId: " Phoebe ", email: "phoebe.preview@e2e.aais.invalid" }),
      seedEntry({
        accountId: "Bobie",
        email: "bobie.preview@e2e.aais.invalid",
        role: "teacher",
        passwordEnv: "AAIS_SEED_TEACHER_PASSWORD",
      }),
    ]);

    expect(users.map(({ id, email, role }) => ({ id, email, role }))).toEqual([
      { id: "Phoebe", email: "phoebe.preview@e2e.aais.invalid", role: "student" },
      { id: "Bobie", email: "bobie.preview@e2e.aais.invalid", role: "teacher" },
    ]);
    expect(JSON.stringify(users)).not.toContain("preview-student-password-123");
    expect(JSON.stringify(users)).not.toContain("preview-teacher-password-123");
  });

  it.each([
    "",
    "-leading",
    "contains space",
    "contains/slash",
    `A${"a".repeat(128)}`,
  ])("rejects malformed explicit account ID %j", (accountId) => {
    expect(() => parseUsers([seedEntry({ accountId })]))
      .toThrow("Invalid AAIS user seed account id.");
  });

  it("rejects case-fold duplicate IDs and emails before database access", () => {
    expect(() => parseUsers([
      seedEntry({ accountId: "Phoebe", email: "one@example.test" }),
      seedEntry({ accountId: "pHOEBe", email: "two@example.test" }),
    ])).toThrow("AAIS user seed account ids must be unique.");

    expect(() => parseUsers([
      seedEntry({ accountId: "One", email: "Teacher@Example.TEST" }),
      seedEntry({ accountId: "Two", email: "teacher@example.test" }),
    ])).toThrow("AAIS user seed emails must be unique.");
  });

  it("rejects weak passwords before database access", () => {
    expect(() => parseUsers([
      seedEntry({ password: "short", passwordEnv: undefined }),
    ])).toThrow("AAIS user seed password does not meet length requirements.");
  });
});

describe("AAIS user seed transaction", () => {
  it("uses one connected client for lock, preflight, writes, postcondition, and commit", async () => {
    const users = parseUsers([seedEntry({ accountId: "Phoebe" })]);
    const pool = new FakeSeedPool(({ normalizedSql }) => {
      if (normalizedSql.includes("join aais_enrollments")) {
        return { rows: users.map((user) => postconditionRow(user)) };
      }
      return { rows: [] };
    });

    const report = await runSeed(pool, users);

    expect(pool.connect).toHaveBeenCalledTimes(1);
    expect(pool.query).not.toHaveBeenCalled();
    expect(pool.client.release).toHaveBeenCalledTimes(1);
    expect(pool.client.queries.map(({ sql }) => normalizeSql(sql))).toEqual([
      "begin",
      "select pg_advisory_xact_lock(hashtextextended('aais-user-seed-v1', 0))",
      expect.stringContaining("from aais_users"),
      expect.stringContaining("insert into aais_users"),
      expect.stringContaining("insert into aais_enrollments"),
      expect.stringContaining("from aais_users"),
      "commit",
    ]);
    expect(report).toMatchObject({
      schemaVersion: 1,
      status: "pass",
      upserted: 1,
      users: [{
        role: "student",
        status: "active",
        enrollment: { courseId: COURSE_ID, cohort: COHORT, status: "active" },
      }],
    });
  });

  it("permits an idempotent rerun of the exact ID/email identity", async () => {
    const users = parseUsers([seedEntry({ accountId: "Phoebe" })]);
    const pool = new FakeSeedPool(({ normalizedSql }) => {
      if (isPreflight(normalizedSql)) {
        return { rows: [{
          id: users[0].id,
          email: users[0].email,
          normalized_email: users[0].email,
        }] };
      }
      if (normalizedSql.includes("join aais_enrollments")) {
        return { rows: [postconditionRow(users[0])] };
      }
      return { rows: [] };
    });

    await expect(runSeed(pool, users)).resolves.toMatchObject({ status: "pass" });
    expect(pool.client.release).toHaveBeenCalledTimes(1);
  });

  it.each([
    {
      name: "case-conflicting ID",
      row: { id: "phoebe", email: "phoebe.preview@e2e.aais.invalid", normalized_email: "phoebe.preview@e2e.aais.invalid" },
    },
    {
      name: "ID mapped to another email",
      row: { id: "Phoebe", email: "other@example.test", normalized_email: "other@example.test" },
    },
    {
      name: "email mapped to another ID",
      row: { id: "Other", email: "phoebe.preview@e2e.aais.invalid", normalized_email: "phoebe.preview@e2e.aais.invalid" },
    },
  ])("rolls back and releases for $name", async ({ row }) => {
    const users = parseUsers([seedEntry({ accountId: "Phoebe" })]);
    const pool = new FakeSeedPool(({ normalizedSql }) =>
      isPreflight(normalizedSql) ? { rows: [row] } : { rows: [] });

    await expect(runSeed(pool, users)).rejects.toThrow("AAIS user seed identity collision.");
    expect(pool.client.queries.map(({ sql }) => normalizeSql(sql))).toEqual([
      "begin",
      "select pg_advisory_xact_lock(hashtextextended('aais-user-seed-v1', 0))",
      expect.stringContaining("from aais_users"),
      "rollback",
    ]);
    expect(pool.client.release).toHaveBeenCalledTimes(1);
  });

  it("rolls back and releases on write errors", async () => {
    const users = parseUsers([seedEntry({ accountId: "Phoebe" })]);
    const pool = new FakeSeedPool(({ normalizedSql }) => {
      if (normalizedSql.includes("insert into aais_users")) {
        throw new Error("write rejected");
      }
      return { rows: [] };
    });

    await expect(runSeed(pool, users)).rejects.toThrow("write rejected");
    expect(pool.client.queries.at(-1).sql.toLowerCase()).toBe("rollback");
    expect(pool.client.release).toHaveBeenCalledTimes(1);
  });

  it("rolls back and releases when exact postconditions are not proved", async () => {
    const users = parseUsers([seedEntry({ accountId: "Phoebe" })]);
    const pool = new FakeSeedPool(() => ({ rows: [] }));

    await expect(runSeed(pool, users)).rejects.toThrow("AAIS user seed postcondition failed.");
    expect(pool.client.queries.at(-1).sql.toLowerCase()).toBe("rollback");
    expect(pool.client.release).toHaveBeenCalledTimes(1);
  });

  it("serializes concurrent cooperating seeds through the transaction lock", async () => {
    const pool = new SerializedSeedPool();
    const firstUsers = parseUsers([seedEntry({ accountId: "Phoebe" })]);
    const secondUsers = parseUsers([seedEntry({
      accountId: "Bobie",
      email: "bobie.preview@e2e.aais.invalid",
      role: "teacher",
    })]);

    await Promise.all([runSeed(pool, firstUsers), runSeed(pool, secondUsers)]);

    const firstCommit = pool.events.indexOf("client-1:commit");
    const secondAcquired = pool.events.indexOf("client-2:lock-acquired");
    expect(firstCommit).toBeGreaterThan(-1);
    expect(secondAcquired).toBeGreaterThan(firstCommit);
    expect(pool.connect).toHaveBeenCalledTimes(2);
    expect(pool.clients.every((client) => client.release.mock.calls.length === 1)).toBe(true);
  });

  it("reports only counts, roles, statuses, and enrollment data", async () => {
    const rawPassword = "preview-student-password-123";
    const users = parseUsers([seedEntry({ accountId: "Phoebe", password: rawPassword, passwordEnv: undefined })]);
    const pool = new FakeSeedPool(({ normalizedSql }) =>
      normalizedSql.includes("join aais_enrollments")
        ? { rows: [postconditionRow(users[0])] }
        : { rows: [] });

    const report = await runSeed(pool, users);
    const serialized = JSON.stringify(report);
    for (const secretOrIdentity of [
      users[0].id,
      users[0].email,
      rawPassword,
      "postgres://user:password@example.test/aais",
      sha256(users[0].id),
      sha256(users[0].email),
      sha256(rawPassword),
    ]) {
      expect(serialized).not.toContain(secretOrIdentity);
    }
    expect(Object.keys(report.users[0]).sort()).toEqual(["enrollment", "role", "status"]);
  });
});

function seedEntry(overrides = {}) {
  return {
    accountId: undefined,
    email: "phoebe.preview@e2e.aais.invalid",
    displayName: "Preview Student",
    role: "student",
    status: "active",
    passwordEnv: "AAIS_SEED_STUDENT_PASSWORD",
    ...overrides,
  };
}

function parseUsers(entries) {
  return parseAaisUserSeedJson(JSON.stringify(entries), {
    AAIS_SEED_STUDENT_PASSWORD: "preview-student-password-123",
    AAIS_SEED_TEACHER_PASSWORD: "preview-teacher-password-123",
  });
}

function runSeed(database, users) {
  return runAaisUserSeed({
    database,
    users,
    now: NOW,
    courseId: COURSE_ID,
    cohort: COHORT,
  });
}

function postconditionRow(user) {
  return {
    id: user.id,
    email: user.email,
    normalized_email: user.email,
    role: user.role,
    status: user.status,
    password_algorithm: "scrypt",
    password_salt_present: true,
    password_hash_present: true,
    course_id: COURSE_ID,
    cohort: COHORT,
    enrollment_role: user.role,
    enrollment_status: user.status === "disabled" ? "withdrawn" : "active",
  };
}

function normalizeSql(sql) {
  return String(sql).trim().replace(/\s+/g, " ").toLowerCase();
}

function isPreflight(normalizedSql) {
  return normalizedSql.includes("from aais_users")
    && !normalizedSql.includes("join aais_enrollments");
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

class FakeSeedPool {
  constructor(handler) {
    this.client = new FakeSeedClient(handler);
    this.connect = vi.fn(async () => this.client);
    this.query = vi.fn(async () => {
      throw new Error("Pool.query must not be used by the seed transaction.");
    });
  }
}

class FakeSeedClient {
  constructor(handler) {
    this.handler = handler;
    this.queries = [];
    this.release = vi.fn();
  }

  async query(sql, params = []) {
    const query = { sql: String(sql), params };
    this.queries.push(query);
    return this.handler({ ...query, normalizedSql: normalizeSql(sql) });
  }
}

class SerializedSeedPool {
  constructor() {
    this.clients = [];
    this.events = [];
    this.lockTail = Promise.resolve();
    this.connect = vi.fn(async () => {
      const client = new SerializedSeedClient(this, this.clients.length + 1);
      this.clients.push(client);
      return client;
    });
    this.query = vi.fn(async () => {
      throw new Error("Pool.query must not be used by the seed transaction.");
    });
  }
}

class SerializedSeedClient {
  constructor(pool, number) {
    this.pool = pool;
    this.id = `client-${number}`;
    this.users = [];
    this.release = vi.fn();
  }

  async query(sql, params = []) {
    const normalizedSql = normalizeSql(sql);
    if (normalizedSql === "begin") {
      this.pool.events.push(`${this.id}:begin`);
      return { rows: [] };
    }
    if (normalizedSql.includes("pg_advisory_xact_lock")) {
      this.pool.events.push(`${this.id}:lock-request`);
      const prior = this.pool.lockTail;
      let releaseLock;
      this.pool.lockTail = new Promise((resolve) => { releaseLock = resolve; });
      await prior;
      this.releaseLock = releaseLock;
      this.pool.events.push(`${this.id}:lock-acquired`);
      return { rows: [] };
    }
    if (normalizedSql.includes("insert into aais_users")) {
      this.users = JSON.parse(String(params[0] ?? "[]")).map((user) => ({
        id: user.id,
        email: user.email,
        role: user.role,
        status: user.status,
      }));
      return { rows: [] };
    }
    if (normalizedSql.includes("join aais_enrollments")) {
      return { rows: this.users.map((user) => postconditionRow(user)) };
    }
    if (normalizedSql === "commit" || normalizedSql === "rollback") {
      this.pool.events.push(`${this.id}:${normalizedSql}`);
      this.releaseLock?.();
      return { rows: [] };
    }
    return { rows: [] };
  }
}
