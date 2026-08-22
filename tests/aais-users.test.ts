import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  AaisActiveAdminInvariantError,
  AaisAuthEmailDeliveryFencedError,
  AaisAuthTokenError,
  AaisUserInviteConflictError,
  AaisUserNotFoundError,
  AaisUserStoreConfigurationError,
  createAaisUserStore,
  resolveAaisDatabaseSessionActor,
} from "@/lib/server/aais-users";
import type { AaisDatabaseClient } from "@/lib/server/aais-learning-store";
import { AaisAuthDeliveryConfigurationError } from "@/lib/server/aais-auth-delivery";

const strongResendKey = "re_1234567890abcdefghijklmnopqrstuvwxyzABCD";

beforeEach(() => {
  vi.stubEnv("NODE_ENV", "test");
  vi.stubEnv("AAIS_APP_BASE_URL", "https://aais.example.test");
  vi.stubEnv("AAIS_SESSION_SECRET", "test-session-secret-with-at-least-32-characters");
  vi.stubEnv("RESEND_API_KEY", strongResendKey);
  vi.stubEnv("AAIS_AUTH_EMAIL_FROM", "CAAIS <no-reply@example.test>");
});

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
      status: "queued",
      provider: "resend",
    });
    expect(database.enrollments.get(`${invite.user.id}:cognitive-apprenticeship`)).toMatchObject({
      course_id: "cognitive-apprenticeship",
      user_id: invite.user.id,
      cohort: "default",
      role: "teacher",
      status: "active",
    });
    expect(invite.setPasswordUrl).toContain("https://aais.example.test/login#invite_token=aais_invite_");
    expect(invite.setPasswordUrl).not.toContain("?invite_token=");
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
    expect(reset?.resetUrl).toContain("https://aais.example.test/login#reset_token=aais_reset_");
    expect(reset?.resetUrl).not.toContain("?reset_token=");
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

  it("distinguishes a missing database identity from invalid credentials without exposing it at the route", async () => {
    const store = createAaisUserStore({ database: new FakeUserDatabase() });

    await expect(store.authenticate("missing@example.test", "irrelevant-password"))
      .resolves.toEqual({ status: "not_found" });
  });

  it("releases a delivered email fence only when its token is successfully consumed", async () => {
    const database = new FakeUserDatabase();
    const store = createAaisUserStore({
      database,
      now: () => new Date("2026-07-09T00:00:00.000Z"),
    });
    const invite = await store.createInvite({
      email: "delivered@example.test",
      displayName: "Delivered User",
      role: "student",
      createdBy: "admin-1",
    });
    const token = [...database.tokens.values()].find((candidate) =>
      candidate.user_id === invite.user.id && candidate.purpose === "invite"
    )!;
    token.email_delivery_state = "delivered";
    token.email_delivery_outbox_id = [...database.outbox.values()].find((row) =>
      row.auth_token_id === token.id
    )!.id;

    await store.setPasswordWithToken({
      token: invite.token,
      password: "delivered-user-password-1",
    });

    expect(token).toMatchObject({
      consumed_at: "2026-07-09T00:00:00.000Z",
      email_delivery_state: "idle",
      email_delivery_outbox_id: null,
      email_delivery_claim_id: null,
    });
    const consumeSql = database.queries.find((query) =>
      query.sql.trim().toLowerCase().startsWith("with token_candidate as")
    )?.sql ?? "";
    expect(consumeSql).toContain("email_delivery_state = 'idle'");
    expect(consumeSql).toContain("resolved_email_delivery");
  });

  it("routes known and missing database identities through the same password KDF abstraction", async () => {
    const database = new FakeUserDatabase();
    database.users.set("known-user", {
      id: "known-user",
      email: "known@example.test",
      normalized_email: "known@example.test",
      display_name: "Known User",
      role: "student",
      status: "active",
      password: JSON.stringify({
        algorithm: "scrypt",
        salt: "known-user-salt",
        hash: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
      }),
      created_at: "2026-07-09T00:00:00.000Z",
      updated_at: "2026-07-09T00:00:00.000Z",
      last_login_at: null,
      auth_version: 1,
    });
    const passwordVerifier = vi.fn(async (
      _password: string,
      record: { algorithm: "scrypt"; salt: string; hash: string } | null,
    ) => record !== null);
    const store = createAaisUserStore({ database, passwordVerifier });

    await expect(store.authenticate("known@example.test", "candidate-password"))
      .resolves.toMatchObject({ status: "ok" });
    await expect(store.authenticate("missing@example.test", "candidate-password"))
      .resolves.toEqual({ status: "not_found" });

    expect(passwordVerifier).toHaveBeenCalledTimes(2);
    expect(passwordVerifier.mock.calls[0]?.[1]).toMatchObject({
      algorithm: "scrypt",
      salt: "known-user-salt",
    });
    expect(passwordVerifier.mock.calls[1]?.[1]).toBeNull();
  });

  it("fails closed when the required auth-version migration is missing", async () => {
    const query = vi.fn(async (_sql: string) => {
      void _sql;
      throw Object.assign(new Error("column auth_version does not exist"), {
        code: "42703",
      });
    });
    const passwordVerifier = vi.fn(async () => true);
    const store = createAaisUserStore({
      database: { query },
      passwordVerifier,
    });

    await expect(store.authenticate("known@example.test", "candidate-password"))
      .rejects.toBeInstanceOf(AaisUserStoreConfigurationError);

    expect(query).toHaveBeenCalledOnce();
    expect(query.mock.calls[0]?.[0]).toContain("auth_version");
    expect(query.mock.calls[0]?.[0]).not.toContain("coalesce");
    expect(query.mock.calls[0]?.[0]).not.toContain("to_jsonb(aais_users)");
    expect(passwordVerifier).not.toHaveBeenCalled();
  });

  it("returns a non-enumerating null password-reset result for missing users", async () => {
    const database = new FakeUserDatabase();
    const fetchMock = vi.fn(async () =>
      new Response(null, { status: 202 }));
    const store = createAaisUserStore({
      database,
      fetchImpl: fetchMock as typeof fetch,
      now: () => new Date("2026-07-09T00:00:00.000Z"),
    });

    await expect(store.createPasswordReset({
      email: "missing@example.test",
      createdBy: "self-service",
    })).resolves.toBeNull();
    expect(database.queries).toHaveLength(1);
    expect(database.queries[0]?.sql).toContain("queued_email as");
    expect(database.tokens.size).toBe(0);
    expect(database.outbox.size).toBe(0);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("fails closed before database writes when production delivery configuration is invalid", async () => {
    const database = new FakeUserDatabase();
    const store = createAaisUserStore({
      database,
      env: {
        NODE_ENV: "production",
        AAIS_APP_BASE_URL: "http://localhost:3000",
        AAIS_SESSION_SECRET: "strong-session-secret-with-at-least-32-characters",
      },
    });

    await expect(store.createInvite({
      email: "blocked@example.test",
      displayName: "Blocked User",
      role: "student",
      createdBy: "admin-1",
    })).rejects.toBeInstanceOf(AaisAuthDeliveryConfigurationError);
    await expect(store.createPasswordReset({
      email: "blocked@example.test",
      createdBy: "self-service",
    })).rejects.toBeInstanceOf(AaisAuthDeliveryConfigurationError);

    expect(database.queries).toEqual([]);
    expect(database.users.size).toBe(0);
    expect(database.tokens.size).toBe(0);
    expect(database.enrollments.size).toBe(0);
    expect(database.outbox.size).toBe(0);
  });

  it("reuses one deterministic invite slot so only the latest invite token remains valid", async () => {
    const database = new FakeUserDatabase();
    const store = createAaisUserStore({
      database,
      now: () => new Date("2026-07-09T00:00:00.000Z"),
    });

    const first = await store.createInvite({
      email: "repeat-invite@example.test",
      displayName: "First Invite",
      role: "student",
      createdBy: "admin-1",
    });
    const second = await store.createInvite({
      email: "repeat-invite@example.test",
      displayName: "Latest Invite",
      role: "teacher",
      createdBy: "admin-2",
    });

    const liveInvites = [...database.tokens.values()].filter((token) =>
      token.user_id === second.user.id
      && token.purpose === "invite"
      && token.consumed_at === null
    );
    expect(liveInvites).toHaveLength(1);
    expect(liveInvites[0]?.id).toMatch(/^auth-invite-/);
    expect(database.queries[1]?.sql).toContain("on conflict (id) do update");
    await expect(store.setPasswordWithToken({
      token: first.token,
      password: "superseded-password-1",
    })).rejects.toBeInstanceOf(AaisAuthTokenError);
    await expect(store.setPasswordWithToken({
      token: second.token,
      password: "latest-password-2",
    })).resolves.toMatchObject({ status: "active" });
  });

  it("binds a legacy mixed-case invited account to the normalized outbox recipient", async () => {
    const database = new FakeUserDatabase();
    database.users.set("legacy-invited-user", {
      id: "legacy-invited-user",
      email: "Legacy.Invited@Example.TEST",
      normalized_email: "legacy.invited@example.test",
      display_name: "Legacy Invite",
      role: "student",
      status: "invited",
      password: null,
      created_at: "2026-07-01T00:00:00.000Z",
      updated_at: "2026-07-01T00:00:00.000Z",
      last_login_at: null,
      auth_version: 1,
    });
    const store = createAaisUserStore({
      database,
      now: () => new Date("2026-07-09T00:00:00.000Z"),
    });

    await store.createInvite({
      email: "legacy.invited@example.test",
      displayName: "Legacy Invite",
      role: "student",
      createdBy: "admin-1",
    });

    expect([...database.outbox.values()]).toEqual([
      expect.objectContaining({ recipient: "legacy.invited@example.test" }),
    ]);
    expect(database.queries[0]?.sql).toContain("$2, $13::jsonb");
  });

  it("rolls back reissue while the deterministic token slot has an in-flight delivery fence", async () => {
    const database = new FakeUserDatabase();
    const store = createAaisUserStore({
      database,
      now: () => new Date("2026-07-09T00:00:00.000Z"),
    });
    const first = await store.createInvite({
      email: "fenced-invite@example.test",
      displayName: "Fenced Invite",
      role: "student",
      createdBy: "admin-1",
    });
    const token = [...database.tokens.values()].find((row) => row.purpose === "invite")!;
    const outbox = [...database.outbox.values()].find((row) => row.purpose === "invite")!;
    token.email_delivery_state = "in_flight";
    token.email_delivery_outbox_id = outbox.id;
    token.email_delivery_claim_id = "10000000-0000-4000-8000-000000000099";
    const stateBefore = {
      users: structuredClone([...database.users.entries()]),
      tokens: structuredClone([...database.tokens.entries()]),
      enrollments: structuredClone([...database.enrollments.entries()]),
      outbox: structuredClone([...database.outbox.entries()]),
    };

    await expect(store.createInvite({
      email: "fenced-invite@example.test",
      displayName: "Must Roll Back",
      role: "teacher",
      createdBy: "admin-2",
    })).rejects.toBeInstanceOf(AaisAuthEmailDeliveryFencedError);

    expect([...database.users.entries()]).toEqual(stateBefore.users);
    expect([...database.tokens.entries()]).toEqual(stateBefore.tokens);
    expect([...database.enrollments.entries()]).toEqual(stateBefore.enrollments);
    expect([...database.outbox.entries()]).toEqual(stateBefore.outbox);
    expect(first.user.displayName).toBe("Fenced Invite");
  });

  it("rejects reinvites for active and disabled accounts without mutating or emailing them", async () => {
    vi.stubEnv("RESEND_API_KEY", strongResendKey);
    vi.stubEnv("AAIS_AUTH_EMAIL_FROM", "CAAIS <no-reply@example.test>");
    const database = new FakeUserDatabase();
    const fetchMock = vi.fn(async () => new Response(null, { status: 202 }));
    const store = createAaisUserStore({
      database,
      fetchImpl: fetchMock as typeof fetch,
      now: () => new Date("2026-07-09T00:00:00.000Z"),
    });
    const activeInvite = await store.createInvite({
      email: "active@example.test",
      displayName: "Active User",
      role: "teacher",
      createdBy: "admin-1",
    });
    await store.setPasswordWithToken({
      token: activeInvite.token,
      password: "active-password-1",
    });
    const disabledInvite = await store.createInvite({
      email: "disabled@example.test",
      displayName: "Disabled User",
      role: "student",
      createdBy: "admin-1",
    });
    await store.setPasswordWithToken({
      token: disabledInvite.token,
      password: "disabled-password-1",
    });
    await store.updateUserAccess({
      userId: disabledInvite.user.id,
      role: "student",
      status: "disabled",
      updatedBy: "admin-1",
    });
    const activeBefore = structuredClone(database.users.get(activeInvite.user.id));
    const disabledBefore = structuredClone(database.users.get(disabledInvite.user.id));
    fetchMock.mockClear();

    await expect(store.createInvite({
      email: "active@example.test",
      displayName: "Unexpected Active Rewrite",
      role: "student",
      createdBy: "admin-2",
    })).rejects.toBeInstanceOf(AaisUserInviteConflictError);
    await expect(store.createInvite({
      email: "disabled@example.test",
      displayName: "Unexpected Disabled Rewrite",
      role: "admin",
      createdBy: "admin-2",
    })).rejects.toBeInstanceOf(AaisUserInviteConflictError);

    expect(database.users.get(activeInvite.user.id)).toEqual(activeBefore);
    expect(database.users.get(disabledInvite.user.id)).toEqual(disabledBefore);
    expect([...database.tokens.values()].filter((token) => token.consumed_at === null)).toEqual([]);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("rolls back invite and access changes when their atomic enrollment statement fails", async () => {
    const database = new FakeUserDatabase();
    const store = createAaisUserStore({
      database,
      now: () => new Date("2026-07-09T00:00:00.000Z"),
    });

    database.failNextInviteEnrollmentWrite = true;
    await expect(store.createInvite({
      email: "atomic@example.test",
      displayName: "Atomic User",
      role: "student",
      createdBy: "admin-1",
    })).rejects.toThrow("injected invite enrollment failure");
    expect(database.users.size).toBe(0);
    expect(database.tokens.size).toBe(0);
    expect(database.enrollments.size).toBe(0);
    expect(database.queries).toHaveLength(1);
    expect(database.queries[0]?.sql.trim().toLowerCase()).toMatch(/^with invited_user as/);

    database.queries.length = 0;
    database.failNextAuthEmailOutboxWrite = true;
    await expect(store.createInvite({
      email: "atomic@example.test",
      displayName: "Atomic User",
      role: "student",
      createdBy: "admin-1",
    })).rejects.toThrow("injected auth email outbox failure");
    expect(database.users.size).toBe(0);
    expect(database.tokens.size).toBe(0);
    expect(database.enrollments.size).toBe(0);
    expect(database.outbox.size).toBe(0);

    const invite = await store.createInvite({
      email: "atomic@example.test",
      displayName: "Atomic User",
      role: "student",
      createdBy: "admin-1",
    });
    const beforeUser = structuredClone(database.users.get(invite.user.id));
    const enrollmentKey = `${invite.user.id}:cognitive-apprenticeship`;
    const beforeEnrollment = structuredClone(database.enrollments.get(enrollmentKey));
    database.queries.length = 0;
    database.failNextAccessEnrollmentWrite = true;

    await expect(store.updateUserAccess({
      userId: invite.user.id,
      role: "admin",
      status: "disabled",
      updatedBy: "admin-1",
    })).rejects.toThrow("injected access enrollment failure");
    expect(database.users.get(invite.user.id)).toEqual(beforeUser);
    expect(database.enrollments.get(enrollmentKey)).toEqual(beforeEnrollment);
    expect(database.queries).toHaveLength(1);
    expect(database.queries[0]?.sql.trim().toLowerCase()).toMatch(/^with updated_user as/);

    await store.setPasswordWithToken({
      token: invite.token,
      password: "atomic-password-1",
    });
    const tokenSnapshot = structuredClone([...database.tokens.entries()]);
    const outboxSnapshot = structuredClone([...database.outbox.entries()]);
    database.failNextAuthEmailOutboxWrite = true;
    await expect(store.createPasswordReset({
      email: "atomic@example.test",
      createdBy: "self-service",
    })).rejects.toThrow("injected auth email outbox failure");
    expect([...database.tokens.entries()]).toEqual(tokenSnapshot);
    expect([...database.outbox.entries()]).toEqual(outboxSnapshot);
  });

  it("allows exactly one concurrent use of a one-time password token", async () => {
    const database = new FakeUserDatabase();
    const store = createAaisUserStore({
      database,
      now: () => new Date("2026-07-09T00:00:00.000Z"),
    });
    const invite = await store.createInvite({
      email: "concurrent@example.test",
      displayName: "Concurrent User",
      role: "student",
      createdBy: "admin-1",
    });

    const results = await Promise.allSettled([
      store.setPasswordWithToken({ token: invite.token, password: "first-password-1" }),
      store.setPasswordWithToken({ token: invite.token, password: "second-password-2" }),
    ]);

    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(results.filter((result) => result.status === "rejected")).toHaveLength(1);
    expect(results.find((result) => result.status === "rejected")).toMatchObject({
      reason: expect.any(AaisAuthTokenError),
    });
  });

  it("rejects format-valid unknown password tokens before entering the password KDF queue", async () => {
    const database = new FakeUserDatabase();
    const passwordRecordCreator = vi.fn(async () => ({
      algorithm: "scrypt" as const,
      salt: "unused",
      hash: "unused",
    }));
    const store = createAaisUserStore({ database, passwordRecordCreator });
    const token = `aais_reset_${"x".repeat(43)}`;

    const results = await Promise.allSettled(Array.from({ length: 40 }, () =>
      store.setPasswordWithToken({ token, password: "unknown-token-password" })
    ));

    expect(results.every((result) =>
      result.status === "rejected" && result.reason instanceof AaisAuthTokenError
    )).toBe(true);
    expect(passwordRecordCreator).not.toHaveBeenCalled();
    expect(database.queries).toHaveLength(40);
    expect(database.queries.every(({ sql }) =>
      sql.trim().toLowerCase().startsWith("select token.id")
    )).toBe(true);
  });

  it("rechecks token validity atomically after the password KDF preflight", async () => {
    const database = new FakeUserDatabase();
    const setupStore = createAaisUserStore({ database });
    const invite = await setupStore.createInvite({
      email: "preflight-race@example.test",
      displayName: "Preflight Race",
      role: "student",
      createdBy: "admin-1",
    });
    const passwordRecordCreator = vi.fn(async () => {
      const token = [...database.tokens.values()].find((candidate) => !candidate.consumed_at);
      if (token) {
        token.consumed_at = "2026-07-09T00:00:01.000Z";
      }
      return { algorithm: "scrypt" as const, salt: "race", hash: "race" };
    });
    const store = createAaisUserStore({
      database,
      now: () => new Date("2026-07-09T00:00:00.000Z"),
      passwordRecordCreator,
    });

    await expect(store.setPasswordWithToken({
      token: invite.token,
      password: "preflight-race-password",
    })).rejects.toBeInstanceOf(AaisAuthTokenError);
    expect(passwordRecordCreator).toHaveBeenCalledOnce();
    expect([...database.users.values()].find((user) =>
      user.normalized_email === "preflight-race@example.test"
    )?.password).toBeNull();
  });

  it("serializes two different password tokens for the same user and consumes the sibling", async () => {
    const database = new FakeUserDatabase();
    const store = createAaisUserStore({
      database,
      now: () => new Date("2026-07-09T00:00:00.000Z"),
    });
    const invite = await store.createInvite({
      email: "sibling@example.test",
      displayName: "Sibling Token User",
      role: "student",
      createdBy: "admin-1",
    });
    await store.setPasswordWithToken({ token: invite.token, password: "initial-password-1" });
    const firstReset = await store.createPasswordReset({
      email: "sibling@example.test",
      createdBy: "self-service",
    });
    const secondReset = await store.createPasswordReset({
      email: "sibling@example.test",
      createdBy: "self-service",
    });

    const resetQueries = database.queries.filter(({ sql }) =>
      sql.trim().toLowerCase().startsWith("with reset_user as materialized")
    );
    expect(resetQueries).toHaveLength(2);
    expect(resetQueries.every(({ sql }) =>
      sql.toLowerCase().includes("for no key update")
    )).toBe(true);
    expect([...database.tokens.values()].filter((token) =>
      token.purpose === "password_reset" && !token.consumed_at
    )).toHaveLength(1);

    const results = await Promise.allSettled([
      store.setPasswordWithToken({
        token: firstReset?.token ?? "",
        password: "first-reset-password-1",
      }),
      store.setPasswordWithToken({
        token: secondReset?.token ?? "",
        password: "second-reset-password-2",
      }),
    ]);

    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(results.filter((result) => result.status === "rejected")).toHaveLength(1);
    expect([...database.tokens.values()].filter((token) => !token.consumed_at)).toEqual([]);
  });

  it("queues self-service reset delivery without waiting for the provider", async () => {
    const database = new FakeUserDatabase();
    const setupStore = createAaisUserStore({
      database,
      now: () => new Date("2026-07-09T00:00:00.000Z"),
    });
    const invite = await setupStore.createInvite({
      email: "timeout@example.test",
      displayName: "Timeout User",
      role: "student",
      createdBy: "admin-1",
    });
    await setupStore.setPasswordWithToken({
      token: invite.token,
      password: "initial-password-1",
    });
    vi.stubEnv("RESEND_API_KEY", strongResendKey);
    vi.stubEnv("AAIS_AUTH_EMAIL_FROM", "CAAIS <no-reply@example.test>");
    const fetchMock = vi.fn((_input: RequestInfo | URL, init?: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(init.signal?.reason), { once: true });
      })
    );
    const store = createAaisUserStore({
      database,
      fetchImpl: fetchMock as typeof fetch,
      emailTimeoutMs: 100,
      now: () => new Date("2026-07-09T01:00:00.000Z"),
    });

    const startedAt = Date.now();
    const result = await store.createPasswordReset({
      email: "timeout@example.test",
      createdBy: "self-service",
    });

    expect(Date.now() - startedAt).toBeLessThan(1_000);
    expect(result?.delivery).toEqual({
      status: "queued",
      provider: "resend",
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("stores only ciphertext and performs no synchronous provider request", async () => {
    vi.stubEnv("RESEND_API_KEY", strongResendKey);
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
      status: "queued",
      provider: "resend",
    });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(database.outbox.size).toBeGreaterThan(0);
    const serializedOutbox = JSON.stringify([...database.outbox.values()]);
    const serializedQueryParams = JSON.stringify(database.queries.map((query) => query.params));
    for (const plaintext of [
      reset?.token,
      reset?.resetUrl,
      "AAIS password reset",
      "Use this one-time link",
      "CAAIS <no-reply@example.test>",
    ].filter((value): value is string => Boolean(value))) {
      expect(serializedOutbox).not.toContain(plaintext);
      expect(serializedQueryParams).not.toContain(plaintext);
    }
    const resetOutbox = [...database.outbox.values()].find((row) =>
      row.purpose === "password_reset"
    );
    expect(resetOutbox?.payload_envelope).toEqual({
      version: 1,
      nonce: expect.stringMatching(/^[A-Za-z0-9_-]{16}$/),
      tag: expect.stringMatching(/^[A-Za-z0-9_-]{22}$/),
      ciphertext: expect.stringMatching(/^[A-Za-z0-9_-]+$/),
    });
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

  it("keeps a sole active administrator unchanged across every access-removal shape", async () => {
    const database = new FakeUserDatabase();
    const store = createAaisUserStore({
      database,
      now: () => new Date("2026-07-09T00:00:00.000Z"),
    });
    const invite = await store.createInvite({
      email: "sole-admin@example.test",
      displayName: "Sole Admin",
      role: "admin",
      createdBy: "bootstrap-admin",
    });
    await store.setPasswordWithToken({
      token: invite.token,
      password: "sole-admin-password-1",
    });
    const enrollmentKey = `${invite.user.id}:cognitive-apprenticeship`;
    const userBefore = structuredClone(database.users.get(invite.user.id));
    const enrollmentBefore = structuredClone(database.enrollments.get(enrollmentKey));
    const forbiddenChanges = [
      { role: "teacher", status: "active" },
      { role: "admin", status: "invited" },
      { role: "admin", status: "disabled" },
    ] as const;

    for (const change of forbiddenChanges) {
      await expect(store.updateUserAccess({
        userId: invite.user.id,
        ...change,
        updatedBy: "another-admin-session",
      })).rejects.toBeInstanceOf(AaisActiveAdminInvariantError);
    }

    expect(database.users.get(invite.user.id)).toEqual(userBefore);
    expect(database.enrollments.get(enrollmentKey)).toEqual(enrollmentBefore);
  });

  it("serializes concurrent removal of two active admins so exactly one remains", async () => {
    const database = new FakeUserDatabase();
    const store = createAaisUserStore({
      database,
      now: () => new Date("2026-07-09T00:00:00.000Z"),
    });
    const firstInvite = await store.createInvite({
      email: "first-admin@example.test",
      displayName: "First Admin",
      role: "admin",
      createdBy: "bootstrap-admin",
    });
    const secondInvite = await store.createInvite({
      email: "second-admin@example.test",
      displayName: "Second Admin",
      role: "admin",
      createdBy: "bootstrap-admin",
    });
    await store.setPasswordWithToken({
      token: firstInvite.token,
      password: "first-admin-password-1",
    });
    await store.setPasswordWithToken({
      token: secondInvite.token,
      password: "second-admin-password-2",
    });

    const results = await Promise.allSettled([
      store.updateUserAccess({
        userId: firstInvite.user.id,
        role: "teacher",
        status: "active",
        updatedBy: secondInvite.user.id,
      }),
      store.updateUserAccess({
        userId: secondInvite.user.id,
        role: "teacher",
        status: "active",
        updatedBy: firstInvite.user.id,
      }),
    ]);

    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(results.filter((result) => result.status === "rejected")).toHaveLength(1);
    expect(results.find((result) => result.status === "rejected")).toMatchObject({
      reason: expect.any(AaisActiveAdminInvariantError),
    });
    expect([...database.users.values()].filter((user) =>
      user.role === "admin" && user.status === "active"
    )).toHaveLength(1);
  });

  it("resolves only active database users for request-time authorization", async () => {
    const database = new FakeUserDatabase();
    const store = createAaisUserStore({
      database,
      now: () => new Date("2026-07-09T00:00:00.000Z"),
    });
    const invite = await store.createInvite({
      email: "admin@example.test",
      displayName: "Current Admin",
      role: "admin",
      createdBy: "bootstrap-admin",
    });
    await store.setPasswordWithToken({
      token: invite.token,
      password: "admin-password-1",
    });

    await expect(resolveAaisDatabaseSessionActor(invite.user.id, { database }))
      .resolves.toEqual({
        status: "active",
        actor: {
          id: invite.user.id,
          role: "admin",
          displayName: "Current Admin",
        },
        authVersion: 2,
      });

    const backupInvite = await store.createInvite({
      email: "backup-admin@example.test",
      displayName: "Backup Admin",
      role: "admin",
      createdBy: "bootstrap-admin",
    });
    await store.setPasswordWithToken({
      token: backupInvite.token,
      password: "backup-admin-password-2",
    });
    await store.updateUserAccess({
      userId: invite.user.id,
      role: "teacher",
      status: "disabled",
      updatedBy: "bootstrap-admin",
    });
    await expect(resolveAaisDatabaseSessionActor(invite.user.id, { database }))
      .resolves.toEqual({ status: "inactive" });
    await expect(resolveAaisDatabaseSessionActor("missing-user", { database }))
      .resolves.toEqual({ status: "not_found" });
    await expect(resolveAaisDatabaseSessionActor(invite.user.id, { database: null }))
      .resolves.toEqual({ status: "not_configured" });
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
  auth_version: number;
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
  email_delivery_state: "idle" | "in_flight" | "uncertain" | "delivered";
  email_delivery_outbox_id: string | null;
  email_delivery_claim_id: string | null;
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

type FakeAuthEmailOutboxRow = {
  id: string;
  purpose: "invite" | "password_reset";
  auth_token_id: string;
  auth_token_hash: string;
  recipient: string;
  payload_envelope: Record<string, unknown>;
  idempotency_key: string;
  status: "pending";
};

class FakeUserDatabase implements AaisDatabaseClient {
  readonly users = new Map<string, FakeUserRow>();
  readonly tokens = new Map<string, FakeTokenRow>();
  readonly enrollments = new Map<string, FakeEnrollmentRow>();
  readonly outbox = new Map<string, FakeAuthEmailOutboxRow>();
  readonly queries: Array<{ sql: string; params: unknown[] }> = [];
  failNextInviteEnrollmentWrite = false;
  failNextAccessEnrollmentWrite = false;
  failNextAuthEmailOutboxWrite = false;
  private accessMutationTail: Promise<void> = Promise.resolve();

  async query(sql: string, params: unknown[] = []) {
    this.queries.push({ sql, params });
    const normalizedSql = sql.trim().toLowerCase();

    if (normalizedSql.startsWith("with invited_user as")) {
      const stateBefore = this.snapshotState();
      const [
        id,
        email,
        displayName,
        role,
        createdBy,
        issuedAt,
        tokenId,
        tokenHash,
        expiresAt,
        courseId,
        cohort,
        outboxId,
        payloadEnvelope,
        idempotencyKey,
      ] = params.map(String);
      const existing = this.findUserByEmail(email);
      if (existing && existing.status !== "invited") {
        return { rows: [] };
      }
      if (this.failNextInviteEnrollmentWrite) {
        this.failNextInviteEnrollmentWrite = false;
        throw new Error("injected invite enrollment failure");
      }
      const existingTokenSlot = this.tokens.get(tokenId);
      if (
        existingTokenSlot
        && existingTokenSlot.email_delivery_state !== "idle"
        && !(
          existingTokenSlot.email_delivery_state === "delivered"
          && (Boolean(existingTokenSlot.consumed_at) || existingTokenSlot.expires_at <= issuedAt)
        )
      ) {
        throw createFakeAuthEmailDeliveryFenceError();
      }
      let user: FakeUserRow;
      if (existing) {
        existing.display_name = displayName;
        existing.role = role as FakeUserRow["role"];
        existing.status = existing.status === "disabled" ? "disabled" : "invited";
        existing.updated_at = issuedAt;
        existing.auth_version += 1;
        user = existing;
      } else {
        user = {
          id,
          email,
          normalized_email: email,
          display_name: displayName,
          role: role as FakeUserRow["role"],
          status: "invited",
          password: null,
          created_at: issuedAt,
          updated_at: issuedAt,
          last_login_at: null,
          auth_version: 1,
        };
        this.users.set(id, user);
      }
      for (const candidate of this.tokens.values()) {
        if (candidate.user_id === user.id && candidate.purpose === "invite" && !candidate.consumed_at) {
          candidate.consumed_at = issuedAt;
        }
      }
      this.tokens.set(tokenId, {
        id: tokenId,
        user_id: user.id,
        purpose: "invite",
        token_hash: tokenHash,
        created_by: createdBy,
        expires_at: expiresAt,
        consumed_at: null,
        created_at: issuedAt,
        email_delivery_state: "idle",
        email_delivery_outbox_id: null,
        email_delivery_claim_id: null,
      });
      const enrollmentKey = `${user.id}:${courseId}`;
      const existingEnrollment = this.enrollments.get(enrollmentKey);
      this.enrollments.set(enrollmentKey, {
        course_id: courseId,
        user_id: user.id,
        cohort: existingEnrollment?.cohort ?? cohort,
        role: user.role,
        status: user.status === "disabled" ? "withdrawn" : "active",
        enrolled_at: existingEnrollment?.enrolled_at ?? issuedAt,
        updated_at: issuedAt,
      });
      this.outbox.set(outboxId, {
        id: outboxId,
        purpose: "invite",
        auth_token_id: tokenId,
        auth_token_hash: tokenHash,
        recipient: email,
        payload_envelope: JSON.parse(payloadEnvelope) as Record<string, unknown>,
        idempotency_key: idempotencyKey,
        status: "pending",
      });
      if (this.failNextAuthEmailOutboxWrite) {
        this.failNextAuthEmailOutboxWrite = false;
        this.restoreState(stateBefore);
        throw new Error("injected auth email outbox failure");
      }
      return { rows: [user] };
    }

    if (normalizedSql.startsWith("with reset_user as")) {
      const stateBefore = this.snapshotState();
      const [
        email,
        tokenId,
        tokenHash,
        createdBy,
        expiresAt,
        issuedAt,
        outboxId,
        payloadEnvelope,
        idempotencyKey,
      ] = params.map(String);
      const user = this.findUserByEmail(email);
      if (!user || user.status === "disabled") {
        return { rows: [] };
      }
      const existingTokenSlot = this.tokens.get(tokenId);
      if (
        existingTokenSlot
        && existingTokenSlot.email_delivery_state !== "idle"
        && !(
          existingTokenSlot.email_delivery_state === "delivered"
          && (Boolean(existingTokenSlot.consumed_at) || existingTokenSlot.expires_at <= issuedAt)
        )
      ) {
        throw createFakeAuthEmailDeliveryFenceError();
      }
      for (const candidate of this.tokens.values()) {
        if (
          candidate.user_id === user.id
          && candidate.purpose === "password_reset"
          && candidate.id !== tokenId
          && !candidate.consumed_at
        ) {
          candidate.consumed_at = issuedAt;
        }
      }
      this.tokens.set(tokenId, {
        id: tokenId,
        user_id: user.id,
        purpose: "password_reset",
        token_hash: tokenHash,
        created_by: createdBy,
        expires_at: expiresAt,
        consumed_at: null,
        created_at: issuedAt,
        email_delivery_state: "idle",
        email_delivery_outbox_id: null,
        email_delivery_claim_id: null,
      });
      this.outbox.set(outboxId, {
        id: outboxId,
        purpose: "password_reset",
        auth_token_id: tokenId,
        auth_token_hash: tokenHash,
        recipient: email,
        payload_envelope: JSON.parse(payloadEnvelope) as Record<string, unknown>,
        idempotency_key: idempotencyKey,
        status: "pending",
      });
      if (this.failNextAuthEmailOutboxWrite) {
        this.failNextAuthEmailOutboxWrite = false;
        this.restoreState(stateBefore);
        throw new Error("injected auth email outbox failure");
      }
      return { rows: [user] };
    }

    if (normalizedSql.startsWith("with updated_user as")) {
      return this.withAccessMutationLock(() => {
        const [userId, role, status, updatedAt, courseId, cohort] = params.map(String);
        const user = this.users.get(userId);
        if (!user) {
          return { rows: [] };
        }
        if (this.failNextAccessEnrollmentWrite) {
          this.failNextAccessEnrollmentWrite = false;
          throw new Error("injected access enrollment failure");
        }
        const removesActiveAdmin = user.role === "admin"
          && user.status === "active"
          && (role !== "admin" || status !== "active");
        const anotherActiveAdminExists = [...this.users.values()].some((candidate) =>
          candidate.id !== userId
          && candidate.role === "admin"
          && candidate.status === "active"
        );
        if (removesActiveAdmin && !anotherActiveAdminExists) {
          throw createFakeActiveAdminInvariantError();
        }
        user.role = role as FakeUserRow["role"];
        user.status = status as FakeUserRow["status"];
        user.updated_at = updatedAt;
        user.auth_version += 1;
        const enrollmentKey = `${user.id}:${courseId}`;
        const existingEnrollment = this.enrollments.get(enrollmentKey);
        this.enrollments.set(enrollmentKey, {
          course_id: courseId,
          user_id: user.id,
          cohort: existingEnrollment?.cohort ?? cohort,
          role: user.role,
          status: user.status === "disabled" ? "withdrawn" : "active",
          enrolled_at: existingEnrollment?.enrolled_at ?? updatedAt,
          updated_at: updatedAt,
        });
        return { rows: [user] };
      });
    }

    if (normalizedSql.startsWith("with token_candidate as")) {
      const [tokenHash, password, updatedAt] = params.map(String);
      const token = [...this.tokens.values()].find((candidate) =>
        candidate.token_hash === tokenHash
      );
      const user = token ? this.users.get(token.user_id) : undefined;
      if (
        !token
        || !user
        || token.consumed_at
        || Date.parse(token.expires_at) <= Date.parse(updatedAt)
        || user.status === "disabled"
      ) {
        return { rows: [] };
      }
      token.consumed_at = updatedAt;
      token.email_delivery_state = "idle";
      token.email_delivery_outbox_id = null;
      token.email_delivery_claim_id = null;
      user.password = password;
      user.status = "active";
      user.updated_at = updatedAt;
      user.auth_version += 1;
      for (const candidate of this.tokens.values()) {
        if (
          candidate.user_id === user.id
          && candidate.token_hash !== tokenHash
          && !candidate.consumed_at
        ) {
          candidate.consumed_at = updatedAt;
          candidate.email_delivery_state = "idle";
          candidate.email_delivery_outbox_id = null;
          candidate.email_delivery_claim_id = null;
        }
      }
      return { rows: [user] };
    }

    if (normalizedSql.startsWith("select token.id")) {
      const [tokenHash, checkedAt] = params.map(String);
      const token = [...this.tokens.values()].find((candidate) =>
        candidate.token_hash === tokenHash
      );
      const user = token ? this.users.get(token.user_id) : undefined;
      return {
        rows: token
          && user
          && !token.consumed_at
          && Date.parse(token.expires_at) > Date.parse(checkedAt)
          && user.status !== "disabled"
          ? [{ id: token.id }]
          : [],
      };
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
      user.auth_version += 1;
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
      if (
        user
        && user.status === "active"
        && user.auth_version === Number(params[2])
      ) {
        user.last_login_at = String(params[1]);
        user.updated_at = String(params[1]);
        return { rows: [user] };
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

  private snapshotState() {
    return {
      users: structuredClone(this.users),
      tokens: structuredClone(this.tokens),
      enrollments: structuredClone(this.enrollments),
      outbox: structuredClone(this.outbox),
    };
  }

  private restoreState(state: {
    users: Map<string, FakeUserRow>;
    tokens: Map<string, FakeTokenRow>;
    enrollments: Map<string, FakeEnrollmentRow>;
    outbox: Map<string, FakeAuthEmailOutboxRow>;
  }) {
    this.users.clear();
    this.tokens.clear();
    this.enrollments.clear();
    this.outbox.clear();
    for (const [key, value] of state.users) this.users.set(key, value);
    for (const [key, value] of state.tokens) this.tokens.set(key, value);
    for (const [key, value] of state.enrollments) this.enrollments.set(key, value);
    for (const [key, value] of state.outbox) this.outbox.set(key, value);
  }

  private async withAccessMutationLock<T>(operation: () => T | Promise<T>) {
    const previous = this.accessMutationTail;
    let release!: () => void;
    this.accessMutationTail = new Promise<void>((resolve) => {
      release = resolve;
    });
    await previous;
    try {
      return await operation();
    } finally {
      release();
    }
  }
}

function createFakeActiveAdminInvariantError() {
  return Object.assign(
    new Error("AAIS active administrator invariant violation."),
    {
      code: "23514",
      constraint: "aais_users_active_admin_invariant",
    },
  );
}

function createFakeAuthEmailDeliveryFenceError() {
  return Object.assign(
    new Error("AAIS_AUTH_EMAIL_DELIVERY_FENCED"),
    { code: "P0001" },
  );
}
