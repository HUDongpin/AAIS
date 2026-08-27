import { describe, expect, it } from "vitest";
import {
  AAIS_USER_SEED_CAPABILITIES,
  AaisUserSeedConflictError,
  AaisUserSeedRollbackError,
  parseAaisUserSeedJson,
  runAaisUserSeed,
} from "../scripts/seed-aais-users.mjs";

describe("AAIS user seed script", () => {
  it("advertises the atomic create-only contract for callers that fail closed", () => {
    expect(AAIS_USER_SEED_CAPABILITIES).toEqual({
      version: 1,
      atomicBatch: true,
      modes: ["upsert", "create-only"],
      batchAdvisoryLock: true,
      transactionValidationHooks: true,
      reportAggregates: ["created", "updated", "collisions", "enrollments"],
    });
    expect(Object.isFrozen(AAIS_USER_SEED_CAPABILITIES)).toBe(true);
    expect(Object.isFrozen(AAIS_USER_SEED_CAPABILITIES.modes)).toBe(true);
    expect(Object.isFrozen(AAIS_USER_SEED_CAPABILITIES.reportAggregates)).toBe(true);
  });

  it("parses seed users from password env references", () => {
    const users = parseAaisUserSeedJson(JSON.stringify([
      {
        email: "Teacher@Example.TEST",
        displayName: "Teacher Smoke",
        role: "teacher",
        passwordEnv: "AAIS_SEED_TEACHER_PASSWORD",
      },
    ]), {
      AAIS_SEED_TEACHER_PASSWORD: "teacher-password-123",
    });

    expect(users).toEqual([
      expect.objectContaining({
        id: expect.stringMatching(/^user-[a-f0-9]{16}$/),
        email: "teacher@example.test",
        displayName: "Teacher Smoke",
        role: "teacher",
        status: "active",
        passwordRecord: expect.objectContaining({
          algorithm: "scrypt",
          salt: expect.any(String),
          hash: expect.any(String),
        }),
      }),
    ]);
    expect(JSON.stringify(users)).not.toContain("teacher-password-123");
  });

  it("upserts users and enrollments without reporting raw emails or passwords", async () => {
    const database = new FakeSeedDatabase();
    const users = parseAaisUserSeedJson(JSON.stringify([
      {
        email: "teacher@example.test",
        displayName: "Teacher Smoke",
        role: "teacher",
        password: "teacher-password-123",
      },
      {
        email: "student@example.test",
        displayName: "Student Smoke",
        role: "student",
        status: "disabled",
        password: "student-password-123",
      },
    ]));

    const report = await runAaisUserSeed({
      database,
      users,
      now: new Date("2026-07-09T00:00:00.000Z"),
      courseId: "cognitive-apprenticeship",
      cohort: "staging-smoke",
    });

    expect(report).toMatchObject({
      schemaVersion: 1,
      status: "pass",
      mode: "upsert",
      upserted: 2,
      created: 2,
      updated: 0,
      collisions: 0,
      enrollments: 2,
      secrets: "redacted",
      redaction: {
        emails: "sha256-16",
        passwords: "omitted",
        databaseUrl: "omitted",
      },
    });
    expect(report.users).toEqual([
      expect.objectContaining({
        userHash: expect.stringMatching(/^[a-f0-9]{16}$/),
        role: "teacher",
        status: "active",
        outcome: "created",
        enrollment: {
          courseId: "cognitive-apprenticeship",
          cohort: "staging-smoke",
          status: "active",
        },
      }),
      expect.objectContaining({
        userHash: expect.stringMatching(/^[a-f0-9]{16}$/),
        role: "student",
        status: "disabled",
        outcome: "created",
        enrollment: {
          courseId: "cognitive-apprenticeship",
          cohort: "staging-smoke",
          status: "withdrawn",
        },
      }),
    ]);
    expect(JSON.stringify(report)).not.toContain("teacher@example.test");
    expect(JSON.stringify(report)).not.toContain("student@example.test");
    expect(JSON.stringify(report)).not.toContain("teacher-password-123");
    expect(JSON.stringify(report)).not.toContain("student-password-123");
    expect(JSON.stringify(database.queries)).not.toContain("teacher-password-123");
    expect(JSON.stringify(database.queries)).not.toContain("student-password-123");

    expect(database.users.get("teacher@example.test")).toMatchObject({
      email: "teacher@example.test",
      display_name: "Teacher Smoke",
      role: "teacher",
      status: "active",
    });
    expect(JSON.parse(database.users.get("teacher@example.test").password)).toMatchObject({
      algorithm: "scrypt",
      salt: expect.any(String),
      hash: expect.any(String),
    });
    expect(database.enrollments.get(`${users[0].id}:cognitive-apprenticeship`)).toMatchObject({
      cohort: "staging-smoke",
      role: "teacher",
      status: "active",
    });
    expect(database.enrollments.get(`${users[1].id}:cognitive-apprenticeship`)).toMatchObject({
      cohort: "staging-smoke",
      role: "student",
      status: "withdrawn",
    });
    expect(database.transactions).toEqual({ begun: 1, committed: 1, rolledBack: 0 });
    expect(database.connections).toEqual({ acquired: 1, released: 1 });
  });

  it("increments auth_version when default upsert replaces an existing password", async () => {
    const database = new FakeSeedDatabase();
    const users = parseAaisUserSeedJson(JSON.stringify([{
      email: "student-existing@example.test",
      displayName: "Student Existing Updated",
      role: "student",
      password: "replacement-password-123",
    }]));
    database.users.set(users[0].email, {
      id: users[0].id,
      email: users[0].email,
      normalized_email: users[0].email,
      display_name: "Student Existing",
      role: "student",
      status: "active",
      password: JSON.stringify({ algorithm: "scrypt", salt: "old", hash: "old" }),
      auth_version: 7,
      created_at: "2026-07-01T00:00:00.000Z",
      updated_at: "2026-07-01T00:00:00.000Z",
    });

    const report = await runAaisUserSeed({ database, users });

    expect(report).toMatchObject({
      mode: "upsert",
      upserted: 1,
      created: 0,
      updated: 1,
      collisions: 0,
      enrollments: 1,
    });
    expect(database.users.get(users[0].email)).toMatchObject({
      display_name: "Student Existing Updated",
      auth_version: 8,
    });
    const userUpsert = database.queries.find((query) =>
      query.sql.trim().toLowerCase().startsWith("insert into aais_users")
    );
    expect(userUpsert?.sql).toContain("auth_version = aais_users.auth_version + 1");
  });

  it("preflights create-only collisions and rolls back without attempting a write", async () => {
    const database = new FakeSeedDatabase();
    const users = parseAaisUserSeedJson(JSON.stringify([
      {
        email: "existing@example.test",
        displayName: "Existing",
        role: "student",
        password: "existing-password-123",
      },
      {
        email: "new@example.test",
        displayName: "New",
        role: "student",
        password: "new-user-password-123",
      },
    ]));
    const existing = {
      id: users[0].id,
      email: users[0].email,
      normalized_email: users[0].email,
      display_name: "Existing Original",
      role: "student",
      status: "active",
      password: "redacted-record",
      auth_version: 3,
    };
    database.users.set(users[0].email, existing);

    await expect(runAaisUserSeed({
      database,
      users,
      mode: "create-only",
    })).rejects.toMatchObject({
      name: "AaisUserSeedConflictError",
      collisions: 1,
    });

    expect(database.users).toEqual(new Map([[users[0].email, existing]]));
    expect(database.enrollments.size).toBe(0);
    expect(database.queries.filter((query) =>
      query.sql.trim().toLowerCase().startsWith("insert into")
    )).toHaveLength(0);
    expect(database.transactions).toEqual({ begun: 1, committed: 0, rolledBack: 1 });
  });

  it("uses race-safe create-only inserts and rolls back earlier rows on a late conflict", async () => {
    const users = parseAaisUserSeedJson(JSON.stringify([
      {
        email: "first@example.test",
        displayName: "First",
        role: "student",
        password: "first-user-password-123",
      },
      {
        email: "racing@example.test",
        displayName: "Racing",
        role: "teacher",
        password: "racing-user-password-123",
      },
    ]));
    const database = new FakeSeedDatabase({ raceConflictEmail: users[1].email });

    await expect(runAaisUserSeed({
      database,
      users,
      mode: "create-only",
    })).rejects.toBeInstanceOf(AaisUserSeedConflictError);

    expect(database.users.size).toBe(0);
    expect(database.enrollments.size).toBe(0);
    expect(database.transactions).toEqual({ begun: 1, committed: 0, rolledBack: 1 });
  });

  it("rolls back the whole batch when a later enrollment write fails", async () => {
    const database = new FakeSeedDatabase({ failOnEnrollmentAttempt: 2 });
    const users = parseAaisUserSeedJson(JSON.stringify([
      {
        email: "atomic-1@example.test",
        displayName: "Atomic 1",
        role: "student",
        password: "atomic-user-password-1",
      },
      {
        email: "atomic-2@example.test",
        displayName: "Atomic 2",
        role: "student",
        password: "atomic-user-password-2",
      },
      {
        email: "atomic-3@example.test",
        displayName: "Atomic 3",
        role: "teacher",
        password: "atomic-user-password-3",
      },
    ]));

    await expect(runAaisUserSeed({ database, users }))
      .rejects.toThrow("Synthetic enrollment failure.");

    expect(database.users.size).toBe(0);
    expect(database.enrollments.size).toBe(0);
    expect(database.transactions).toEqual({ begun: 1, committed: 0, rolledBack: 1 });
    expect(database.connections).toEqual({ acquired: 1, released: 1 });
  });

  it("reports an explicit unknown state when the seed rollback itself fails", async () => {
    const database = new FakeSeedDatabase({
      failOnEnrollmentAttempt: 1,
      failRollback: true,
    });
    const users = parseAaisUserSeedJson(JSON.stringify([{
      email: "rollback-failure@example.test",
      displayName: "Rollback Failure",
      role: "student",
      password: "rollback-failure-password-123",
    }]));

    const failure = await runAaisUserSeed({ database, users, mode: "create-only" })
      .then(() => null, (error) => error);

    expect(failure).toBeInstanceOf(AaisUserSeedRollbackError);
    expect(failure).toMatchObject({
      code: "AAIS_USER_SEED_ROLLBACK_FAILED",
      message: "AAIS user seed transaction rollback could not be confirmed.",
    });
    expect(failure.message).not.toContain(users[0].email);
    expect(failure.message).not.toContain("Synthetic enrollment failure");
    expect(database.connections).toEqual({ acquired: 1, released: 1 });
    expect(database.transactions).toEqual({ begun: 1, committed: 0, rolledBack: 0 });
  });

  it("runs validation hooks inside the batch transaction and rolls back on a postcondition failure", async () => {
    const database = new FakeSeedDatabase();
    const users = parseAaisUserSeedJson(JSON.stringify([{
      email: "transaction-hook@example.test",
      displayName: "Transaction Hook",
      role: "student",
      password: "transaction-hook-password-123",
    }]));
    const hookStates = [];

    await expect(runAaisUserSeed({
      database,
      users,
      mode: "create-only",
      batchId: "transaction-hook-batch",
      validateBeforeWrite: ({ database: connection, report }) => {
        hookStates.push({
          phase: "before-write",
          sameConnection: typeof connection.query === "function",
          reportAbsent: report === undefined,
          transactionOpen: database.transactionSnapshot !== null,
          users: database.users.size,
        });
      },
      validateBeforeCommit: ({ database: connection, report }) => {
        hookStates.push({
          phase: "before-commit",
          sameConnection: typeof connection.query === "function",
          reportCreated: report.created,
          transactionOpen: database.transactionSnapshot !== null,
          users: database.users.size,
        });
        throw new Error("Synthetic transactional postcondition failure.");
      },
    })).rejects.toThrow("Synthetic transactional postcondition failure.");

    expect(hookStates).toEqual([
      {
        phase: "before-write",
        sameConnection: true,
        reportAbsent: true,
        transactionOpen: true,
        users: 0,
      },
      {
        phase: "before-commit",
        sameConnection: true,
        reportCreated: 1,
        transactionOpen: true,
        users: 1,
      },
    ]);
    expect(database.users.size).toBe(0);
    expect(database.enrollments.size).toBe(0);
    expect(database.transactions).toEqual({ begun: 1, committed: 0, rolledBack: 1 });
    expect(database.connections).toEqual({ acquired: 1, released: 1 });
  });

  it("atomically creates a locked batch of 40 students and 2 teachers", async () => {
    const rawUsers = Array.from({ length: 42 }, (_, index) => ({
      email: `${index < 40 ? "student" : "teacher"}-${String(index + 1).padStart(2, "0")}@example.test`,
      displayName: `${index < 40 ? "Student" : "Teacher"} ${index + 1}`,
      role: index < 40 ? "student" : "teacher",
      password: `synthetic-only-password-${index + 1}`,
    }));
    const users = parseAaisUserSeedJson(JSON.stringify(rawUsers));
    const database = new FakeSeedDatabase();

    const report = await runAaisUserSeed({
      database,
      users,
      mode: "create-only",
      batchId: "qa-20260828-40s-2t",
      courseId: "cognitive-apprenticeship",
      cohort: "qa-20260828",
    });

    expect(report).toMatchObject({
      schemaVersion: 1,
      status: "pass",
      mode: "create-only",
      upserted: 42,
      created: 42,
      updated: 0,
      collisions: 0,
      enrollments: 42,
      secrets: "redacted",
    });
    expect(report.users).toHaveLength(42);
    expect(report.users.filter((user) => user.role === "student")).toHaveLength(40);
    expect(report.users.filter((user) => user.role === "teacher")).toHaveLength(2);
    expect(report.users.every((user) => user.outcome === "created")).toBe(true);
    expect(JSON.stringify(report)).not.toContain("@example.test");
    expect(JSON.stringify(report)).not.toContain("synthetic-only-password");
    expect(database.users.size).toBe(42);
    expect(database.enrollments.size).toBe(42);
    expect(database.transactions).toEqual({ begun: 1, committed: 1, rolledBack: 0 });
    expect(database.queries).toEqual(expect.arrayContaining([
      expect.objectContaining({
        sql: expect.stringContaining("pg_advisory_xact_lock"),
        params: ["aais:user-seed:v1:qa-20260828-40s-2t"],
      }),
    ]));
  });

  it("uses an already leased PoolClient shape without reconnecting or releasing it", async () => {
    const backing = new FakeSeedDatabase();
    const users = parseAaisUserSeedJson(JSON.stringify([{
      email: "leased-client@example.test",
      displayName: "Leased Client",
      role: "student",
      password: "leased-client-password-123",
    }]));
    let nestedConnects = 0;
    let innerReleases = 0;
    const leasedClient = {
      query: (sql, params) => backing.query(sql, params),
      connect: async () => {
        nestedConnects += 1;
        throw new Error("already connected");
      },
      release: () => {
        innerReleases += 1;
      },
    };

    const report = await runAaisUserSeed({
      database: leasedClient,
      users,
      mode: "create-only",
    });

    expect(report).toMatchObject({ status: "pass", created: 1, enrollments: 1 });
    expect(nestedConnects).toBe(0);
    expect(innerReleases).toBe(0);
    expect(backing.transactions).toEqual({ begun: 1, committed: 1, rolledBack: 0 });
  });

  it("rejects duplicate emails and weak passwords before any database write", () => {
    expect(() => parseAaisUserSeedJson(JSON.stringify([
      {
        email: "teacher@example.test",
        displayName: "Teacher",
        role: "teacher",
        password: "teacher-password-123",
      },
      {
        email: "Teacher@Example.TEST",
        displayName: "Teacher Again",
        role: "teacher",
        password: "teacher-password-456",
      },
    ]))).toThrow("AAIS user seed emails must be unique.");

    expect(() => parseAaisUserSeedJson(JSON.stringify([
      {
        email: "student@example.test",
        displayName: "Student",
        role: "student",
        password: "short",
      },
    ]))).toThrow("AAIS user seed password does not meet length requirements.");
  });
});

class FakeSeedDatabase {
  constructor(input = {}) {
    this.users = new Map();
    this.enrollments = new Map();
    this.queries = [];
    this.transactions = { begun: 0, committed: 0, rolledBack: 0 };
    this.connections = { acquired: 0, released: 0 };
    this.transactionSnapshot = null;
    this.enrollmentAttempts = 0;
    this.failOnEnrollmentAttempt = input.failOnEnrollmentAttempt ?? 0;
    this.raceConflictEmail = input.raceConflictEmail ?? "";
    this.failRollback = input.failRollback ?? false;
  }

  async connect() {
    this.connections.acquired += 1;
    return {
      query: (sql, params) => this.query(sql, params),
      release: () => {
        this.connections.released += 1;
      },
    };
  }

  async query(sql, params = []) {
    this.queries.push({ sql, params });
    const normalized = sql.trim().toLowerCase();
    if (normalized === "begin") {
      if (this.transactionSnapshot) {
        throw new Error("Synthetic nested transaction.");
      }
      this.transactionSnapshot = {
        users: cloneRecordMap(this.users),
        enrollments: cloneRecordMap(this.enrollments),
      };
      this.transactions.begun += 1;
      return { rows: [] };
    }
    if (normalized === "commit") {
      if (!this.transactionSnapshot) {
        throw new Error("Synthetic commit without transaction.");
      }
      this.transactionSnapshot = null;
      this.transactions.committed += 1;
      return { rows: [] };
    }
    if (normalized === "rollback") {
      if (!this.transactionSnapshot) {
        throw new Error("Synthetic rollback without transaction.");
      }
      if (this.failRollback) {
        throw new Error("Synthetic rollback failure.");
      }
      this.users = this.transactionSnapshot.users;
      this.enrollments = this.transactionSnapshot.enrollments;
      this.transactionSnapshot = null;
      this.transactions.rolledBack += 1;
      return { rows: [] };
    }
    if (normalized.includes("pg_advisory_xact_lock")) {
      return { rows: [{ locked: null }] };
    }
    if (normalized.startsWith("select id, normalized_email")) {
      const emails = new Set(params[0]);
      const ids = new Set(params[1]);
      return {
        rows: [...this.users.values()]
          .filter((user) => emails.has(user.normalized_email) || ids.has(user.id))
          .map((user) => ({ id: user.id, normalized_email: user.normalized_email })),
      };
    }
    if (normalized.startsWith("insert into aais_users")) {
      const [
        id,
        email,
        normalizedEmail,
        displayName,
        role,
        status,
        password,
        updatedAt,
      ] = params.map(String);
      const createOnly = normalized.includes("on conflict do nothing");
      if (createOnly && this.raceConflictEmail === normalizedEmail) {
        this.raceConflictEmail = "";
        return { rows: [] };
      }
      const existing = this.users.get(normalizedEmail);
      const idCollision = [...this.users.values()].some((user) =>
        user.id === id && user.normalized_email !== normalizedEmail
      );
      if (createOnly && (existing || idCollision)) {
        return { rows: [] };
      }
      if (idCollision) {
        throw new Error("Synthetic user id conflict.");
      }
      const created = !existing;
      this.users.set(normalizedEmail, {
        ...(existing ?? {}),
        id: existing?.id ?? id,
        email: existing?.email ?? email,
        normalized_email: normalizedEmail,
        display_name: displayName,
        role,
        status,
        password,
        auth_version: created ? 1 : Number(existing.auth_version ?? 1) + 1,
        created_at: existing?.created_at ?? updatedAt,
        updated_at: updatedAt,
      });
      return { rows: [{ id, created }] };
    }
    if (normalized.startsWith("insert into aais_enrollments")) {
      this.enrollmentAttempts += 1;
      if (this.enrollmentAttempts === this.failOnEnrollmentAttempt) {
        throw new Error("Synthetic enrollment failure.");
      }
      const [courseId, userId, cohort, role, status, updatedAt] = params.map(String);
      const key = `${userId}:${courseId}`;
      const existing = this.enrollments.get(key);
      if (normalized.includes("on conflict do nothing") && existing) {
        return { rows: [] };
      }
      this.enrollments.set(key, {
        ...(existing ?? {}),
        course_id: courseId,
        user_id: userId,
        cohort,
        role,
        status,
        updated_at: updatedAt,
      });
      return { rows: [{ user_id: userId }] };
    }
    return { rows: [] };
  }
}

function cloneRecordMap(map) {
  return new Map([...map].map(([key, value]) => [key, { ...value }]));
}
