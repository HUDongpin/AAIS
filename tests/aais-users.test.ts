import { afterEach, describe, expect, it, vi } from "vitest";
import {
  AaisAuthTokenError,
  AaisUserNotFoundError,
  createAaisUserStore,
} from "@/lib/server/aais-users";
import type { AaisDatabaseClient } from "@/lib/server/aais-learning-store";

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("AAIS database users", () => {
  it("invites users, stores only hashed tokens/passwords, and supports password resets", async () => {
    const database = new FakeUserDatabase();
    const store = createAaisUserStore({
      appBaseUrl: "https://aais.example.test",
      database,
      now: () => new Date("2026-07-09T00:00:00.000Z"),
    });

    const invite = await store.createInvite({
      email: "Teacher@Example.TEST",
      displayName: "Teacher A",
      role: "teacher",
      createdBy: "admin-1",
    });

    expect(invite.user).toMatchObject({
      email: "teacher@example.test",
      displayName: "Teacher A",
      role: "teacher",
      status: "invited",
    });
    expect(invite.delivery).toEqual({
      status: "not_configured",
      provider: "resend",
    });
    expect(database.enrollments.get(`${invite.user.id}:cognitive-apprenticeship`)).toMatchObject({
      course_id: "cognitive-apprenticeship",
      user_id: invite.user.id,
      cohort: "default",
      role: "teacher",
      status: "active",
    });
    expect(invite.setPasswordUrl).toContain("https://aais.example.test/login?invite_token=aais_invite_");
    expect(JSON.stringify([...database.tokens.values()])).not.toContain(invite.token);
    expect(JSON.stringify(database.queries)).not.toContain("teacher-password-1");

    const activated = await store.setPasswordWithToken({
      token: invite.token,
      password: "teacher-password-1",
    });
    expect(activated.status).toBe("active");
    expect(JSON.stringify([...database.users.values()])).not.toContain("teacher-password-1");
    await expect(store.setPasswordWithToken({
      token: invite.token,
      password: "teacher-password-1",
    })).rejects.toBeInstanceOf(AaisAuthTokenError);

    const validLogin = await store.authenticate("teacher@example.test", "teacher-password-1");
    expect(validLogin).toMatchObject({
      status: "ok",
      actor: {
        id: invite.user.id,
        role: "teacher",
        displayName: "Teacher A",
      },
    });
    await expect(store.authenticate("teacher@example.test", "wrong-password"))
      .resolves.toEqual({ status: "invalid" });

    const reset = await store.createPasswordReset({
      email: "teacher@example.test",
      createdBy: "admin-1",
    });
    expect(reset).not.toBeNull();
    const resetToken = reset?.token ?? "";
    expect(reset?.resetUrl).toContain("https://aais.example.test/login?reset_token=aais_reset_");
    expect(JSON.stringify([...database.tokens.values()])).not.toContain(resetToken);

    await store.setPasswordWithToken({
      token: resetToken,
      password: "teacher-password-2",
    });
    await expect(store.authenticate("teacher@example.test", "teacher-password-1"))
      .resolves.toEqual({ status: "invalid" });
    await expect(store.authenticate("teacher@example.test", "teacher-password-2"))
      .resolves.toMatchObject({
        status: "ok",
        actor: {
          id: invite.user.id,
        },
      });
  });

  it("returns a non-enumerating null password-reset result for missing users", async () => {
    const store = createAaisUserStore({
      database: new FakeUserDatabase(),
      now: () => new Date("2026-07-09T00:00:00.000Z"),
    });

    await expect(store.createPasswordReset({
      email: "missing@example.test",
      createdBy: "self-service",
    })).resolves.toBeNull();
  });

  it("delivers a self-service password reset through the configured email provider", async () => {
    vi.stubEnv("RESEND_API_KEY", "resend-test-key");
    vi.stubEnv("AAIS_AUTH_EMAIL_FROM", "CAAIS <no-reply@example.test>");
    const database = new FakeUserDatabase();
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      void input;
      void init;
      return Response.json({ id: "email-1" });
    });
    const store = createAaisUserStore({
      appBaseUrl: "https://aais.example.test",
      database,
      fetchImpl: fetchMock as typeof fetch,
      now: () => new Date("2026-07-09T00:00:00.000Z"),
    });

    const invite = await store.createInvite({
      email: "teacher@example.test",
      displayName: "Teacher A",
      role: "teacher",
      createdBy: "admin-1",
    });
    await store.setPasswordWithToken({
      token: invite.token,
      password: "teacher-password-1",
    });
    fetchMock.mockClear();

    const reset = await store.createPasswordReset({
      email: "teacher@example.test",
      createdBy: "self-service",
    });

    expect(reset?.delivery).toEqual({
      status: "sent",
      provider: "resend",
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledWith(
      "https://api.resend.com/emails",
      expect.objectContaining({
        method: "POST",
        headers: {
          authorization: "Bearer resend-test-key",
          "content-type": "application/json",
        },
      }),
    );
    const payload = JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body));
    expect(payload).toMatchObject({
      from: "CAAIS <no-reply@example.test>",
      to: "teacher@example.test",
      subject: "AAIS password reset",
    });
    expect(payload.text).toContain(reset?.resetUrl);
    expect(JSON.stringify([...database.tokens.values()])).not.toContain(reset?.token);
  });

  it("updates user access and reports missing users", async () => {
    const database = new FakeUserDatabase();
    const store = createAaisUserStore({
      database,
      now: () => new Date("2026-07-09T00:00:00.000Z"),
    });
    const invite = await store.createInvite({
      email: "teacher@example.test",
      displayName: "Teacher A",
      role: "teacher",
      createdBy: "admin-1",
    });

    const updated = await store.updateUserAccess({
      userId: invite.user.id,
      role: "admin",
      status: "disabled",
      updatedBy: "admin-1",
    });

    expect(updated).toMatchObject({
      id: invite.user.id,
      role: "admin",
      status: "disabled",
    });
    expect(database.enrollments.get(`${invite.user.id}:cognitive-apprenticeship`)).toMatchObject({
      role: "admin",
      status: "withdrawn",
    });
    await expect(store.updateUserAccess({
      userId: "user-missing",
      role: "teacher",
      status: "active",
      updatedBy: "admin-1",
    })).rejects.toBeInstanceOf(AaisUserNotFoundError);
  });
});

type FakeUserRow = {
  id: string;
  email: string;
  normalized_email: string;
  display_name: string;
  role: "student" | "teacher" | "admin";
  status: "invited" | "active" | "disabled";
  password: string | null;
  created_at: string;
  updated_at: string;
  last_login_at: string | null;
};

type FakeTokenRow = {
  id: string;
  user_id: string;
  purpose: "invite" | "password_reset";
  token_hash: string;
  created_by: string;
  expires_at: string;
  consumed_at: string | null;
  created_at: string;
};

type FakeEnrollmentRow = {
  course_id: string;
  user_id: string;
  cohort: string;
  role: "student" | "teacher" | "admin";
  status: "active" | "completed" | "withdrawn";
  enrolled_at: string;
  updated_at: string;
};

class FakeUserDatabase implements AaisDatabaseClient {
  readonly users = new Map<string, FakeUserRow>();
  readonly tokens = new Map<string, FakeTokenRow>();
  readonly enrollments = new Map<string, FakeEnrollmentRow>();
  readonly queries: Array<{ sql: string; params: unknown[] }> = [];

  async query(sql: string, params: unknown[] = []) {
    this.queries.push({ sql, params });
    const normalizedSql = sql.trim().toLowerCase();

    if (normalizedSql.startsWith("insert into aais_users")) {
      const [
        id,
        email,
        normalizedEmail,
        displayName,
        role,
        ,
        now,
      ] = params.map(String);
      const existing = this.findUserByEmail(normalizedEmail);
      if (existing) {
        existing.display_name = displayName;
        existing.role = role as FakeUserRow["role"];
        existing.status = existing.status === "disabled" ? "disabled" : "invited";
        existing.updated_at = now;
      } else {
        this.users.set(id, {
          id,
          email,
          normalized_email: normalizedEmail,
          display_name: displayName,
          role: role as FakeUserRow["role"],
          status: "invited",
          password: null,
          created_at: now,
          updated_at: now,
          last_login_at: null,
        });
      }
      return { rows: [] };
    }

    if (normalizedSql.startsWith("insert into aais_user_auth_tokens")) {
      const [id, userId, tokenHash, createdBy, expiresAt, createdAt] = params.map(String);
      this.tokens.set(id, {
        id,
        user_id: userId,
        purpose: normalizedSql.includes("'password_reset'") ? "password_reset" : "invite",
        token_hash: tokenHash,
        created_by: createdBy,
        expires_at: expiresAt,
        consumed_at: null,
        created_at: createdAt,
      });
      return { rows: [] };
    }

    if (normalizedSql.startsWith("insert into aais_enrollments")) {
      const [courseId, userId, cohort, role, status, updatedAt] = params.map(String);
      const key = `${userId}:${courseId}`;
      const existing = this.enrollments.get(key);
      this.enrollments.set(key, {
        course_id: courseId,
        user_id: userId,
        cohort: existing?.cohort ?? cohort,
        role: role as FakeEnrollmentRow["role"],
        status: status as FakeEnrollmentRow["status"],
        enrolled_at: existing?.enrolled_at ?? updatedAt,
        updated_at: updatedAt,
      });
      return { rows: [] };
    }

    if (normalizedSql.startsWith("select id, email, display_name, role, status, password")) {
      const account = String(params[0]).toLowerCase();
      const user = this.findUserByEmail(account)
        ?? [...this.users.values()].find((candidate) => candidate.id.toLowerCase() === account);
      return { rows: user ? [user] : [] };
    }

    if (normalizedSql.includes("from aais_users") && normalizedSql.includes("where id = $1")) {
      const user = this.users.get(String(params[0]));
      return { rows: user ? [user] : [] };
    }

    if (normalizedSql.includes("from aais_users") && normalizedSql.includes("where normalized_email = $1")) {
      const user = this.findUserByEmail(String(params[0]));
      return { rows: user ? [user] : [] };
    }

    if (normalizedSql.includes("from aais_users") && normalizedSql.includes("order by updated_at")) {
      return { rows: [...this.users.values()] };
    }

    if (normalizedSql.startsWith("select t.id")) {
      const token = [...this.tokens.values()].find((candidate) => candidate.token_hash === params[0]);
      const user = token ? this.users.get(token.user_id) : undefined;
      return {
        rows: token && user
          ? [{
              id: token.id,
              user_id: token.user_id,
              purpose: token.purpose,
              expires_at: token.expires_at,
              consumed_at: token.consumed_at,
              status: user.status,
            }]
          : [],
      };
    }

    if (/^update aais_users\s+set role/i.test(normalizedSql)) {
      const user = this.users.get(String(params[0]));
      if (!user) {
        return { rows: [] };
      }
      user.role = String(params[1]) as FakeUserRow["role"];
      user.status = String(params[2]) as FakeUserRow["status"];
      user.updated_at = String(params[3]);
      return { rows: [user] };
    }

    if (/^update aais_users\s+set password/i.test(normalizedSql)) {
      const user = this.users.get(String(params[0]));
      if (user) {
        user.password = String(params[1]);
        user.status = "active";
        user.updated_at = String(params[2]);
      }
      return { rows: [] };
    }

    if (/^update aais_users\s+set last_login_at/i.test(normalizedSql)) {
      const user = this.users.get(String(params[0]));
      if (user) {
        user.last_login_at = String(params[1]);
        user.updated_at = String(params[1]);
      }
      return { rows: [] };
    }

    if (normalizedSql.startsWith("update aais_user_auth_tokens")) {
      const token = this.tokens.get(String(params[0]));
      if (token) {
        token.consumed_at = String(params[1]);
      }
      return { rows: [] };
    }

    throw new Error(`Unhandled fake AAIS user query: ${sql}`);
  }

  private findUserByEmail(normalizedEmail: string) {
    return [...this.users.values()].find((user) => user.normalized_email === normalizedEmail);
  }
}
