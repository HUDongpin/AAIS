import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createAaisCsrfToken,
  getAaisCsrfCookieName,
} from "@/lib/server/aais-csrf";
import {
  createAaisSessionToken,
  getAaisSessionCookieName,
  type AaisSessionActor,
} from "@/lib/server/aais-session";

const mocks = vi.hoisted(() => ({
  resolveDatabaseActor: vi.fn(async () => ({ status: "not_configured" as const })),
  store: {
    createInvite: vi.fn(),
    createPasswordReset: vi.fn(),
    listUsers: vi.fn(),
    setPasswordWithToken: vi.fn(),
    updateUserAccess: vi.fn(),
  },
}));

vi.mock("@/lib/server/aais-users", () => ({
  AaisActiveAdminInvariantError: class AaisActiveAdminInvariantError extends Error {},
  AaisAuthTokenError: class AaisAuthTokenError extends Error {},
  AaisAuthEmailDeliveryFencedError: class AaisAuthEmailDeliveryFencedError extends Error {},
  AaisUserStoreConfigurationError: class AaisUserStoreConfigurationError extends Error {},
  AaisUserInviteConflictError: class AaisUserInviteConflictError extends Error {},
  createAaisUserStore: () => mocks.store,
  isAaisActiveAdminInvariantError: (error: unknown) =>
    error instanceof Error && error.name === "AaisActiveAdminInvariantError",
  isAaisAuthTokenError: (error: unknown) => error instanceof Error && error.name === "AaisAuthTokenError",
  isAaisAuthEmailDeliveryFencedError: (error: unknown) =>
    error instanceof Error && error.name === "AaisAuthEmailDeliveryFencedError",
  isAaisUserInviteConflictError: (error: unknown) =>
    error instanceof Error && error.name === "AaisUserInviteConflictError",
  isAaisUserNotFoundError: (error: unknown) => error instanceof Error && error.name === "AaisUserNotFoundError",
  isAaisUserStoreConfigurationError: (error: unknown) =>
    error instanceof Error && error.name === "AaisUserStoreConfigurationError",
  resolveAaisDatabaseSessionActor: mocks.resolveDatabaseActor,
}));

const store = mocks.store;

beforeEach(() => {
  process.env.AAIS_SESSION_SECRET = "test-session-secret-with-at-least-32-characters";
  process.env.AAIS_APP_BASE_URL = "https://aais.example.test";
  process.env.RESEND_API_KEY = "re_1234567890abcdefghijklmnopqrstuvwxyzABCD";
  process.env.AAIS_AUTH_EMAIL_FROM = "AAIS <no-reply@example.test>";
  store.createInvite.mockReset();
  store.createPasswordReset.mockReset();
  store.listUsers.mockReset();
  store.setPasswordWithToken.mockReset();
  store.updateUserAccess.mockReset();
  mocks.resolveDatabaseActor.mockReset();
  mocks.resolveDatabaseActor.mockResolvedValue({ status: "not_configured" });
});

afterEach(() => {
  delete process.env.AAIS_SESSION_SECRET;
  delete process.env.AAIS_APP_BASE_URL;
  delete process.env.RESEND_API_KEY;
  delete process.env.AAIS_AUTH_EMAIL_FROM;
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  vi.doUnmock("@/lib/server/aais-auth-rate-limit");
  vi.resetModules();
});

describe("AAIS user management routes", () => {
  it("requires an admin session for user management", async () => {
    store.listUsers.mockResolvedValue([]);
    const { GET } = await import("@/app/api/auth/users/route");

    const response = await GET(new Request("http://localhost/api/auth/users", {
      headers: signedHeaders({
        id: "student-1",
        role: "student",
        displayName: "Student",
      }),
    }));
    const body = await response.json();

    expect(response.status).toBe(403);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(body.error).toEqual({
      code: "AAIS_USER_MANAGEMENT_FORBIDDEN",
      message: "AAIS user management requires admin authorization.",
    });
    expect(store.listUsers).not.toHaveBeenCalled();
  });

  it.each([
    ["without a session", {}],
    [
      "without CSRF",
      (() => {
        const headers = signedHeaders({
          id: "admin-1",
          role: "admin",
          displayName: "Admin",
        });
        delete (headers as Partial<typeof headers>)["x-aais-csrf"];
        return headers;
      })(),
    ],
  ])("rejects POST %s before accessing the request body", async (_label, headers) => {
    const { POST } = await import("@/app/api/auth/users/route");
    const request = new Request("http://localhost/api/auth/users", {
      method: "POST",
      headers,
      body: JSON.stringify({
        action: "invite",
        email: "teacher@example.test",
        displayName: "Teacher",
        role: "teacher",
      }),
    });
    const originalBody = request.body;
    let bodyAccessCount = 0;
    Object.defineProperty(request, "body", {
      configurable: true,
      get() {
        bodyAccessCount += 1;
        return originalBody;
      },
    });

    const response = await POST(request);

    expect([401, 403]).toContain(response.status);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(bodyAccessCount).toBe(0);
    expectNoStoreCalls();
  });

  it("creates admin-issued account invites without accepting client-side actor ids", async () => {
    const info = vi.spyOn(console, "info").mockImplementation(() => undefined);
    store.createInvite.mockResolvedValue({
      user: {
        id: "user-teacher",
        email: "teacher@example.test",
        displayName: "Teacher",
        role: "teacher",
        status: "invited",
        createdAt: "2026-07-09T00:00:00.000Z",
        updatedAt: "2026-07-09T00:00:00.000Z",
        lastLoginAt: null,
      },
      token: "aais_invite_fake-token",
      setPasswordUrl: "https://aais.example.test/login?invite_token=aais_invite_fake-token",
      delivery: {
        status: "queued",
        provider: "resend",
      },
    });
    const { POST } = await import("@/app/api/auth/users/route");

    const response = await POST(new Request("http://localhost/api/auth/users", {
      method: "POST",
      headers: signedHeaders({
        id: "admin-1",
        role: "admin",
        displayName: "Admin",
      }),
      body: JSON.stringify({
        action: "invite",
        email: "teacher@example.test",
        displayName: "Teacher",
        role: "teacher",
      }),
    }));
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(store.createInvite).toHaveBeenCalledWith({
      email: "teacher@example.test",
      displayName: "Teacher",
      role: "teacher",
      createdBy: "admin-1",
    });
    expect(body).toMatchObject({
      invite: {
        user: {
          id: "user-teacher",
          email: "teacher@example.test",
        },
        delivery: {
          status: "queued",
          provider: "resend",
        },
      },
      secrets: "redacted",
    });
    expect(JSON.stringify(body)).not.toContain("aais_invite_fake-token");
    expect(JSON.stringify(body)).not.toContain("invite_token");
    expect(JSON.stringify(body)).not.toContain("setPasswordUrl");
    expect(info).toHaveBeenCalledWith(expect.stringContaining("auth.user.invite.created"));
    expect(info.mock.calls.map((call) => String(call[0])).join("\n")).not.toContain("teacher@example.test");
  });

  it("returns a typed conflict when an active or disabled account is invited again", async () => {
    const conflict = new Error("must not be exposed");
    conflict.name = "AaisUserInviteConflictError";
    store.createInvite.mockRejectedValue(conflict);
    const { POST } = await import("@/app/api/auth/users/route");

    const response = await POST(new Request("http://localhost/api/auth/users", {
      method: "POST",
      headers: signedHeaders({
        id: "admin-1",
        role: "admin",
        displayName: "Admin",
      }),
      body: JSON.stringify({
        action: "invite",
        email: "existing@example.test",
        displayName: "Existing User",
        role: "teacher",
      }),
    }));

    expect(response.status).toBe(409);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    await expect(response.json()).resolves.toEqual({
      error: {
        code: "AAIS_USER_INVITE_CONFLICT",
        message: "AAIS cannot invite an account that is already active or disabled.",
      },
    });
  });

  it("maps unsafe auth-email delivery configuration to a redacted 503", async () => {
    const { AaisAuthDeliveryConfigurationError } = await import(
      "@/lib/server/aais-auth-delivery"
    );
    store.createInvite.mockRejectedValue(new AaisAuthDeliveryConfigurationError());
    const { POST } = await import("@/app/api/auth/users/route");

    const response = await POST(new Request("http://localhost/api/auth/users", {
      method: "POST",
      headers: signedHeaders({
        id: "admin-1",
        role: "admin",
        displayName: "Admin",
      }),
      body: JSON.stringify({
        action: "invite",
        email: "teacher@example.test",
        displayName: "Teacher",
        role: "teacher",
      }),
    }));

    expect(response.status).toBe(503);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    await expect(response.json()).resolves.toEqual({
      error: {
        code: "AAIS_AUTH_DELIVERY_NOT_CONFIGURED",
        message: "AAIS authentication email delivery is temporarily unavailable.",
      },
    });
  });

  it("creates admin-issued password reset requests without returning raw reset tokens", async () => {
    store.createPasswordReset.mockResolvedValue({
      user: {
        id: "user-teacher",
        email: "teacher@example.test",
        displayName: "Teacher",
        role: "teacher",
        status: "active",
        createdAt: "2026-07-09T00:00:00.000Z",
        updatedAt: "2026-07-09T00:00:00.000Z",
        lastLoginAt: null,
      },
      token: "aais_reset_fake-token",
      resetUrl: "https://aais.example.test/login?reset_token=aais_reset_fake-token",
      delivery: {
        status: "queued",
        provider: "resend",
      },
    });
    const { POST } = await import("@/app/api/auth/users/route");

    const response = await POST(new Request("http://localhost/api/auth/users", {
      method: "POST",
      headers: signedHeaders({
        id: "admin-1",
        role: "admin",
        displayName: "Admin",
      }),
      body: JSON.stringify({
        action: "password-reset",
        email: "teacher@example.test",
      }),
    }));
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(store.createPasswordReset).toHaveBeenCalledWith({
      email: "teacher@example.test",
      createdBy: "admin-1",
    });
    expect(body).toMatchObject({
      reset: {
        user: {
          id: "user-teacher",
          email: "teacher@example.test",
        },
        delivery: {
          status: "queued",
          provider: "resend",
        },
      },
      secrets: "redacted",
    });
    expect(JSON.stringify(body)).not.toContain("aais_reset_fake-token");
    expect(JSON.stringify(body)).not.toContain("reset_token");
    expect(JSON.stringify(body)).not.toContain("resetUrl");
  });

  it("updates user role and status with a redacted audit event", async () => {
    const info = vi.spyOn(console, "info").mockImplementation(() => undefined);
    store.updateUserAccess.mockResolvedValue({
      id: "user-teacher",
      email: "teacher@example.test",
      displayName: "Teacher",
      role: "admin",
      status: "active",
      createdAt: "2026-07-09T00:00:00.000Z",
      updatedAt: "2026-07-09T00:00:00.000Z",
      lastLoginAt: null,
    });
    const { POST } = await import("@/app/api/auth/users/route");

    const response = await POST(new Request("http://localhost/api/auth/users", {
      method: "POST",
      headers: signedHeaders({
        id: "admin-1",
        role: "admin",
        displayName: "Admin",
      }),
      body: JSON.stringify({
        action: "update-access",
        userId: "user-teacher",
        role: "admin",
        status: "active",
      }),
    }));
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(store.updateUserAccess).toHaveBeenCalledWith({
      userId: "user-teacher",
      role: "admin",
      status: "active",
      updatedBy: "admin-1",
    });
    expect(body).toMatchObject({
      user: {
        id: "user-teacher",
        role: "admin",
        status: "active",
      },
      secrets: "redacted",
    });
    expect(info).toHaveBeenCalledWith(expect.stringContaining("auth.user.access.updated"));
    expect(info.mock.calls.map((call) => String(call[0])).join("\n")).not.toContain("teacher@example.test");
  });

  it("rejects every self-update that would leave an administrator outside active-admin", async () => {
    const { POST } = await import("@/app/api/auth/users/route");
    const headers = signedHeaders({
      id: "admin-1",
      role: "admin",
      displayName: "Admin",
    });
    const forbiddenChanges = [
      { role: "teacher", status: "active" },
      { role: "admin", status: "invited" },
      { role: "admin", status: "disabled" },
    ] as const;

    for (const change of forbiddenChanges) {
      const response = await POST(new Request("http://localhost/api/auth/users", {
        method: "POST",
        headers,
        body: JSON.stringify({
          action: "update-access",
          userId: "admin-1",
          ...change,
        }),
      }));

      expect(response.status).toBe(409);
      expect(response.headers.get("cache-control")).toBe("private, no-store");
      await expect(response.json()).resolves.toEqual({
        error: {
          code: "AAIS_USER_SELF_ACTIVE_ADMIN_REQUIRED",
          message: "AAIS administrators must keep their own account active with the admin role.",
        },
      });
    }

    expect(store.updateUserAccess).not.toHaveBeenCalled();
  });

  it("returns a typed conflict when a target update would remove the last active admin", async () => {
    const conflict = new Error("must not be exposed");
    conflict.name = "AaisActiveAdminInvariantError";
    store.updateUserAccess.mockRejectedValue(conflict);
    const { POST } = await import("@/app/api/auth/users/route");

    const response = await POST(new Request("http://localhost/api/auth/users", {
      method: "POST",
      headers: signedHeaders({
        id: "admin-1",
        role: "admin",
        displayName: "Admin",
      }),
      body: JSON.stringify({
        action: "update-access",
        userId: "admin-2",
        role: "teacher",
        status: "active",
      }),
    }));

    expect(response.status).toBe(409);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    await expect(response.json()).resolves.toEqual({
      error: {
        code: "AAIS_ACTIVE_ADMIN_REQUIRED",
        message: "AAIS must retain at least one active administrator.",
      },
    });
  });

  it("sets passwords and requests resets through the public password route", async () => {
    const info = vi.spyOn(console, "info").mockImplementation(() => undefined);
    store.setPasswordWithToken.mockResolvedValue({
      id: "user-teacher",
      email: "teacher@example.test",
      displayName: "Teacher",
      role: "teacher",
      status: "active",
      createdAt: "2026-07-09T00:00:00.000Z",
      updatedAt: "2026-07-09T00:00:00.000Z",
      lastLoginAt: null,
    });
    store.createPasswordReset.mockResolvedValue(null);
    const { POST } = await import("@/app/api/auth/password/route");

    const setPassword = await POST(new Request("http://localhost/api/auth/password", {
      method: "POST",
      body: JSON.stringify({
        action: "set-password",
        token: "aais_invite_fake-token",
        password: "new-password-123",
      }),
    }));
    const setPasswordBody = await setPassword.json();
    const reset = await POST(new Request("http://localhost/api/auth/password", {
      method: "POST",
      body: JSON.stringify({
        action: "request-reset",
        email: "missing@example.test",
      }),
    }));
    const resetBody = await reset.json();

    expect(setPassword.status).toBe(200);
    expect(setPassword.headers.get("cache-control")).toBe("private, no-store");
    expect(setPasswordBody).toMatchObject({
      user: {
        id: "user-teacher",
        status: "active",
      },
      secrets: "redacted",
    });
    expect(store.setPasswordWithToken).toHaveBeenCalledWith({
      token: "aais_invite_fake-token",
      password: "new-password-123",
    });
    expect(reset.status).toBe(200);
    expect(reset.headers.get("cache-control")).toBe("private, no-store");
    expect(resetBody).toEqual({
      ok: true,
      delivery: "queued_if_account_exists",
      secrets: "redacted",
    });
    expect(store.createPasswordReset).toHaveBeenCalledWith({
      email: "missing@example.test",
      createdBy: "self-service",
    });
    const auditEvents = info.mock.calls.map((call) => String(call[0])).join("\n");
    expect(auditEvents).toContain("auth.password.set");
    expect(auditEvents).toContain("auth.password.reset.requested");
    expect(auditEvents).not.toContain("new-password-123");
    expect(auditEvents).not.toContain("missing@example.test");
  });

  it("preserves leading and trailing whitespace in a new password", async () => {
    store.setPasswordWithToken.mockResolvedValue({
      id: "user-whitespace-password",
      email: "space@example.test",
      displayName: "Whitespace Password",
      role: "student",
      status: "active",
      createdAt: "2026-07-09T00:00:00.000Z",
      updatedAt: "2026-07-09T00:00:00.000Z",
      lastLoginAt: null,
    });
    const { POST } = await import("@/app/api/auth/password/route");
    const password = "  exact-password-123  ";

    const response = await POST(new Request("http://localhost/api/auth/password", {
      method: "POST",
      body: JSON.stringify({
        action: "set-password",
        token: "  aais_invite_whitespace-token  ",
        password,
      }),
    }));

    expect(response.status).toBe(200);
    expect(store.setPasswordWithToken).toHaveBeenCalledWith({
      token: "aais_invite_whitespace-token",
      password,
    });
  });

  it("returns a retryable 503 when password hashing reaches its bounded capacity", async () => {
    const { AaisPasswordKdfCapacityError } = await import(
      "@/lib/server/aais-password-kdf"
    );
    store.setPasswordWithToken.mockRejectedValue(new AaisPasswordKdfCapacityError());
    const { POST } = await import("@/app/api/auth/password/route");

    const response = await POST(new Request("http://localhost/api/auth/password", {
      method: "POST",
      body: JSON.stringify({
        action: "set-password",
        token: "aais_invite_capacity-token-value-1234567890",
        password: "new-password-123",
      }),
    }));

    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toEqual({
      error: {
        code: "AAIS_PASSWORD_CAPACITY_UNAVAILABLE",
        message: "AAIS password service is temporarily busy. Please retry shortly.",
      },
    });
  });

  it("stops set-password work before the store when the token or client limiter is blocked", async () => {
    const setPasswordLimiter = vi.fn(async () => ({
      status: "blocked" as const,
      retryAfterSeconds: 60,
    }));
    vi.doMock("@/lib/server/aais-auth-rate-limit", () => ({
      recordAaisPasswordResetRequest: vi.fn(async () => ({ status: "allowed" as const })),
      recordAaisSetPasswordRequest: setPasswordLimiter,
    }));
    const { POST } = await import("@/app/api/auth/password/route");

    const response = await POST(new Request("http://localhost/api/auth/password", {
      method: "POST",
      body: JSON.stringify({
        action: "set-password",
        token: `aais_reset_${"r".repeat(43)}`,
        password: "new-password-123",
      }),
    }));

    expect(response.status).toBe(429);
    expect(response.headers.get("retry-after")).toBe("60");
    await expect(response.json()).resolves.toEqual({
      error: {
        code: "AAIS_SET_PASSWORD_RATE_LIMITED",
        message: "AAIS password request is temporarily rate limited.",
      },
    });
    expect(setPasswordLimiter).toHaveBeenCalledOnce();
    expect(store.setPasswordWithToken).not.toHaveBeenCalled();
  });

  it("fails closed when durable set-password abuse control is unavailable", async () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    vi.doMock("@/lib/server/aais-auth-rate-limit", () => ({
      recordAaisPasswordResetRequest: vi.fn(async () => ({ status: "allowed" as const })),
      recordAaisSetPasswordRequest: vi.fn(async () => {
        throw new Error("private database outage detail");
      }),
    }));
    const { POST } = await import("@/app/api/auth/password/route");

    const response = await POST(new Request("http://localhost/api/auth/password", {
      method: "POST",
      body: JSON.stringify({
        action: "set-password",
        token: `aais_reset_${"s".repeat(43)}`,
        password: "new-password-123",
      }),
    }));

    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toEqual({
      error: {
        code: "AAIS_SET_PASSWORD_RATE_LIMIT_UNAVAILABLE",
        message: "AAIS password protection is temporarily unavailable.",
      },
    });
    expect(store.setPasswordWithToken).not.toHaveBeenCalled();
  });

  it("maps an unknown password-store outage to a redacted 500", async () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    store.setPasswordWithToken.mockRejectedValue(new Error("private database outage detail"));
    const { POST } = await import("@/app/api/auth/password/route");

    const response = await POST(new Request("http://localhost/api/auth/password", {
      method: "POST",
      body: JSON.stringify({
        action: "set-password",
        token: `aais_reset_${"t".repeat(43)}`,
        password: "new-password-123",
      }),
    }));
    const body = await response.json();

    expect(response.status).toBe(500);
    expect(body).toEqual({
      error: {
        code: "AAIS_PASSWORD_REQUEST_FAILED",
        message: "AAIS password request failed.",
      },
    });
    expect(JSON.stringify(body)).not.toContain("private database outage detail");
  });

  it("maps a typed password-store configuration outage to a redacted 503", async () => {
    const error = new Error("private schema detail");
    error.name = "AaisUserStoreConfigurationError";
    store.setPasswordWithToken.mockRejectedValue(error);
    const { POST } = await import("@/app/api/auth/password/route");

    const response = await POST(new Request("http://localhost/api/auth/password", {
      method: "POST",
      body: JSON.stringify({
        action: "set-password",
        token: `aais_reset_${"u".repeat(43)}`,
        password: "new-password-123",
      }),
    }));

    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toEqual({
      error: {
        code: "AAIS_USER_STORE_NOT_CONFIGURED",
        message: "AAIS user store requires Postgres configuration.",
      },
    });
  });

  it("rate limits public reset requests without changing the non-enumerating response", async () => {
    vi.spyOn(console, "info").mockImplementation(() => undefined);
    vi.stubEnv("AAIS_PASSWORD_RESET_ACCOUNT_MAX_REQUESTS", "1");
    vi.stubEnv("AAIS_PASSWORD_RESET_CLIENT_MAX_REQUESTS", "10");
    store.createPasswordReset.mockResolvedValue(null);
    const { POST } = await import("@/app/api/auth/password/route");
    const makeRequest = () => new Request("http://localhost/api/auth/password", {
      method: "POST",
      headers: {
        "x-forwarded-for": "203.0.113.201",
      },
      body: JSON.stringify({
        action: "request-reset",
        email: "unknown-rate-limit@example.test",
      }),
    });

    const first = await POST(makeRequest());
    const second = await POST(makeRequest());

    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    await expect(first.json()).resolves.toEqual({
      ok: true,
      delivery: "queued_if_account_exists",
      secrets: "redacted",
    });
    await expect(second.json()).resolves.toEqual({
      ok: true,
      delivery: "queued_if_account_exists",
      secrets: "redacted",
    });
    expect(store.createPasswordReset).toHaveBeenCalledTimes(1);
  });

  it("preflights delivery configuration before public reset rate-limit writes", async () => {
    vi.resetModules();
    delete process.env.RESEND_API_KEY;
    const recordAaisPasswordResetRequest = vi.fn(async () => ({ status: "allowed" as const }));
    vi.doMock("@/lib/server/aais-auth-rate-limit", () => ({
      recordAaisPasswordResetRequest,
      recordAaisSetPasswordRequest: vi.fn(async () => ({ status: "allowed" as const })),
    }));
    const { POST } = await import("@/app/api/auth/password/route");

    const response = await POST(new Request("http://localhost/api/auth/password", {
      method: "POST",
      body: JSON.stringify({
        action: "request-reset",
        email: "missing@example.test",
      }),
    }));

    expect(response.status).toBe(503);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    await expect(response.json()).resolves.toEqual({
      error: {
        code: "AAIS_AUTH_DELIVERY_NOT_CONFIGURED",
        message: "AAIS authentication email delivery is temporarily unavailable.",
      },
    });
    expect(recordAaisPasswordResetRequest).not.toHaveBeenCalled();
    expect(store.createPasswordReset).not.toHaveBeenCalled();
  });

  it("fails closed when durable password-reset abuse control is unavailable", async () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    vi.doMock("@/lib/server/aais-auth-rate-limit", () => ({
      recordAaisPasswordResetRequest: vi.fn(async () => {
        throw new Error("database unavailable");
      }),
      recordAaisSetPasswordRequest: vi.fn(async () => ({ status: "allowed" as const })),
    }));
    const { POST } = await import("@/app/api/auth/password/route");

    const response = await POST(new Request("http://localhost/api/auth/password", {
      method: "POST",
      body: JSON.stringify({
        action: "request-reset",
        email: "protected@example.test",
      }),
    }));

    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toEqual({
      error: {
        code: "AAIS_PASSWORD_RESET_RATE_LIMIT_UNAVAILABLE",
        message: "AAIS password reset protection is temporarily unavailable.",
      },
    });
    expect(store.createPasswordReset).not.toHaveBeenCalled();
  });

  it("rejects invalid or oversized public password bodies before rate-limit and store work", async () => {
    const rateLimit = vi.fn(async () => ({ status: "allowed" as const }));
    vi.doMock("@/lib/server/aais-auth-rate-limit", () => ({
      recordAaisPasswordResetRequest: rateLimit,
      recordAaisSetPasswordRequest: rateLimit,
    }));
    const { POST } = await import("@/app/api/auth/password/route");
    const cases = [
      {
        body: "null",
        status: 400,
        code: "AAIS_PASSWORD_REQUEST_INVALID",
      },
      {
        body: JSON.stringify({
          action: "request-reset",
          email: "learner@example.test",
          unexpected: true,
        }),
        status: 400,
        code: "AAIS_PASSWORD_REQUEST_INVALID",
      },
      {
        body: JSON.stringify({ action: "request-reset", email: "e".repeat(321) }),
        status: 413,
        code: "AAIS_PASSWORD_REQUEST_TOO_LARGE",
      },
      {
        body: JSON.stringify({
          action: "set-password",
          token: "t".repeat(1_025),
          password: "new-password-123",
        }),
        status: 413,
        code: "AAIS_PASSWORD_REQUEST_TOO_LARGE",
      },
      {
        body: JSON.stringify({
          action: "set-password",
          token: "aais_reset_fake-token",
          password: "short-123",
        }),
        status: 400,
        code: "AAIS_PASSWORD_REQUEST_INVALID",
      },
      {
        body: JSON.stringify({
          action: "set-password",
          token: "aais_reset_fake-token",
          password: "p".repeat(257),
        }),
        status: 413,
        code: "AAIS_PASSWORD_REQUEST_TOO_LARGE",
      },
      {
        body: "{}",
        headers: { "content-length": String(17 * 1_024) },
        status: 413,
        code: "AAIS_PASSWORD_REQUEST_TOO_LARGE",
      },
    ];

    for (const testCase of cases) {
      const response = await POST(new Request("http://localhost/api/auth/password", {
        method: "POST",
        headers: testCase.headers,
        body: testCase.body,
      }));

      expect(response.status).toBe(testCase.status);
      expect(response.headers.get("cache-control")).toBe("private, no-store");
      await expect(response.json()).resolves.toMatchObject({
        error: { code: testCase.code },
      });
    }

    expect(rateLimit).not.toHaveBeenCalled();
    expectNoStoreCalls();
  });

  it("rejects invalid or oversized admin user bodies after authorization and before store work", async () => {
    const { POST } = await import("@/app/api/auth/users/route");
    const headers = signedHeaders({
      id: "admin-1",
      role: "admin",
      displayName: "Admin",
    });
    const cases = [
      {
        body: "[]",
        status: 400,
        code: "AAIS_USER_REQUEST_INVALID",
      },
      {
        body: JSON.stringify({
          action: "invite",
          email: "teacher@example.test",
          displayName: "Teacher",
          role: "teacher",
          createdBy: "client-spoof",
        }),
        status: 400,
        code: "AAIS_USER_REQUEST_INVALID",
      },
      {
        body: JSON.stringify({
          action: "invite",
          email: "e".repeat(321),
          displayName: "Teacher",
          role: "teacher",
        }),
        status: 413,
        code: "AAIS_USER_REQUEST_TOO_LARGE",
      },
      {
        body: JSON.stringify({
          action: "invite",
          email: "teacher@example.test",
          displayName: "n".repeat(121),
          role: "teacher",
        }),
        status: 413,
        code: "AAIS_USER_REQUEST_TOO_LARGE",
      },
      {
        body: JSON.stringify({
          action: "update-access",
          userId: "u".repeat(129),
          role: "teacher",
          status: "active",
        }),
        status: 413,
        code: "AAIS_USER_REQUEST_TOO_LARGE",
      },
      {
        body: JSON.stringify({
          action: "update-access",
          userId: "user-teacher",
          role: 1,
          status: "active",
        }),
        status: 400,
        code: "AAIS_USER_REQUEST_INVALID",
      },
      {
        body: "{}",
        extraHeaders: { "content-length": String(17 * 1_024) },
        status: 413,
        code: "AAIS_USER_REQUEST_TOO_LARGE",
      },
    ];

    for (const testCase of cases) {
      const response = await POST(new Request("http://localhost/api/auth/users", {
        method: "POST",
        headers: {
          ...headers,
          ...testCase.extraHeaders,
        },
        body: testCase.body,
      }));

      expect(response.status).toBe(testCase.status);
      expect(response.headers.get("cache-control")).toBe("private, no-store");
      await expect(response.json()).resolves.toMatchObject({
        error: { code: testCase.code },
      });
    }

    expect(mocks.resolveDatabaseActor).not.toHaveBeenCalled();
    expectNoStoreCalls();
  });

  it("does not echo lower-layer user or password validation text", async () => {
    store.createInvite.mockRejectedValue(new Error("Invalid AAIS email teacher-secret@example.test"));
    const usersRoute = await import("@/app/api/auth/users/route");

    const inviteResponse = await usersRoute.POST(new Request("http://localhost/api/auth/users", {
      method: "POST",
      headers: signedHeaders({
        id: "admin-1",
        role: "admin",
        displayName: "Admin",
      }),
      body: JSON.stringify({
        action: "invite",
        email: "teacher-secret@example.test",
        displayName: "Teacher",
        role: "teacher",
      }),
    }));
    const inviteBody = await inviteResponse.json();

    expect(inviteResponse.status).toBe(400);
    expect(inviteBody.error).toEqual({
      code: "AAIS_USER_INPUT_INVALID",
      message: "AAIS user input is invalid.",
    });
    expect(JSON.stringify(inviteBody)).not.toContain("teacher-secret@example.test");

    store.setPasswordWithToken.mockRejectedValue(new Error("AAIS password is too short: secret-password"));
    const passwordRoute = await import("@/app/api/auth/password/route");

    const passwordResponse = await passwordRoute.POST(new Request("http://localhost/api/auth/password", {
      method: "POST",
      body: JSON.stringify({
        action: "set-password",
        token: "aais_invite_fake-token",
        password: "secret-password",
      }),
    }));
    const passwordBody = await passwordResponse.json();

    expect(passwordResponse.status).toBe(400);
    expect(passwordBody.error).toEqual({
      code: "AAIS_PASSWORD_INPUT_INVALID",
      message: "AAIS password input is invalid.",
    });
    expect(JSON.stringify(passwordBody)).not.toContain("secret-password");
  });

  it("maps unknown user-store failures to a redacted server error", async () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    store.createInvite.mockRejectedValue(new Error("database unavailable with private detail"));
    const { POST } = await import("@/app/api/auth/users/route");

    const response = await POST(new Request("http://localhost/api/auth/users", {
      method: "POST",
      headers: signedHeaders({
        id: "admin-1",
        role: "admin",
        displayName: "Admin",
      }),
      body: JSON.stringify({
        action: "invite",
        email: "teacher@example.test",
        displayName: "Teacher",
        role: "teacher",
      }),
    }));
    const body = await response.json();

    expect(response.status).toBe(500);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(body).toEqual({
      error: {
        code: "AAIS_USER_MANAGEMENT_FAILED",
        message: "AAIS user management request failed.",
      },
    });
    expect(JSON.stringify(body)).not.toContain("database unavailable");
    expect(JSON.stringify(body)).not.toContain("private detail");
  });
});

function signedHeaders(actor: AaisSessionActor) {
  const session = createAaisSessionToken(actor, new Date(), { authSource: "development" });
  const csrf = createAaisCsrfToken(actor.id);
  return {
    cookie: `${getAaisSessionCookieName()}=${encodeURIComponent(session)}; ${getAaisCsrfCookieName()}=${encodeURIComponent(csrf)}`,
    "x-aais-csrf": csrf,
  };
}

function expectNoStoreCalls() {
  expect(store.createInvite).not.toHaveBeenCalled();
  expect(store.createPasswordReset).not.toHaveBeenCalled();
  expect(store.listUsers).not.toHaveBeenCalled();
  expect(store.setPasswordWithToken).not.toHaveBeenCalled();
  expect(store.updateUserAccess).not.toHaveBeenCalled();
}
