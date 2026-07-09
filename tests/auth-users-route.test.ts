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
  store: {
    createInvite: vi.fn(),
    createPasswordReset: vi.fn(),
    listUsers: vi.fn(),
    setPasswordWithToken: vi.fn(),
    updateUserAccess: vi.fn(),
  },
}));

vi.mock("@/lib/server/aais-users", () => ({
  AaisAuthTokenError: class AaisAuthTokenError extends Error {},
  createAaisUserStore: () => mocks.store,
  isAaisAuthTokenError: (error: unknown) => error instanceof Error && error.name === "AaisAuthTokenError",
  isAaisUserNotFoundError: (error: unknown) => error instanceof Error && error.name === "AaisUserNotFoundError",
  isAaisUserStoreConfigurationError: () => false,
}));

const store = mocks.store;

beforeEach(() => {
  process.env.AAIS_SESSION_SECRET = "test-session-secret-with-at-least-32-characters";
  store.createInvite.mockReset();
  store.createPasswordReset.mockReset();
  store.listUsers.mockReset();
  store.setPasswordWithToken.mockReset();
  store.updateUserAccess.mockReset();
});

afterEach(() => {
  delete process.env.AAIS_SESSION_SECRET;
  vi.restoreAllMocks();
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
    expect(body.error).toEqual({
      code: "AAIS_USER_MANAGEMENT_FORBIDDEN",
      message: "AAIS user management requires admin authorization.",
    });
    expect(store.listUsers).not.toHaveBeenCalled();
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
        status: "not_configured",
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
        createdBy: "client-spoof",
      }),
    }));
    const body = await response.json();

    expect(response.status).toBe(200);
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
          status: "not_configured",
          provider: "resend",
        },
      },
      secrets: "redacted",
    });
    expect(JSON.stringify(body)).not.toContain("client-spoof");
    expect(JSON.stringify(body)).not.toContain("aais_invite_fake-token");
    expect(JSON.stringify(body)).not.toContain("invite_token");
    expect(JSON.stringify(body)).not.toContain("setPasswordUrl");
    expect(info).toHaveBeenCalledWith(expect.stringContaining("auth.user.invite.created"));
    expect(info.mock.calls.map((call) => String(call[0])).join("\n")).not.toContain("teacher@example.test");
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
        status: "sent",
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
          status: "sent",
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
        updatedBy: "client-spoof",
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
});

function signedHeaders(actor: AaisSessionActor) {
  const session = createAaisSessionToken(actor);
  const csrf = createAaisCsrfToken(actor.id);
  return {
    cookie: `${getAaisSessionCookieName()}=${encodeURIComponent(session)}; ${getAaisCsrfCookieName()}=${encodeURIComponent(csrf)}`,
    "x-aais-csrf": csrf,
  };
}
