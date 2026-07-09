import { describe, expect, it } from "vitest";
import {
  parseAaisUserSeedJson,
  runAaisUserSeed,
} from "../scripts/seed-aais-users.mjs";

describe("AAIS user seed script", () => {
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
      upserted: 2,
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
  constructor() {
    this.users = new Map();
    this.enrollments = new Map();
    this.queries = [];
  }

  async query(sql, params = []) {
    this.queries.push({ sql, params });
    const normalized = sql.trim().toLowerCase();
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
      this.users.set(normalizedEmail, {
        id,
        email,
        normalized_email: normalizedEmail,
        display_name: displayName,
        role,
        status,
        password,
        updated_at: updatedAt,
      });
    }
    if (normalized.startsWith("insert into aais_enrollments")) {
      const [courseId, userId, cohort, role, status, updatedAt] = params.map(String);
      this.enrollments.set(`${userId}:${courseId}`, {
        course_id: courseId,
        user_id: userId,
        cohort,
        role,
        status,
        updated_at: updatedAt,
      });
    }
    return { rows: [] };
  }
}
