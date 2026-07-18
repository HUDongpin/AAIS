import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getAaisCsrfCookieName } from "@/lib/server/aais-csrf";
import { getAaisSessionCookieName } from "@/lib/server/aais-session";
import { clearAaisSessionRevocationsForTest } from "@/lib/server/aais-session-revocations";
import { createPasswordRecord } from "@/lib/server/aais-trial-accounts";

const accountConfig = JSON.stringify([
  {
    id: "Bobie",
    displayName: "Bobie",
    role: "student",
    password: createPasswordRecord("12345"),
  },
  {
    id: "Phoebe",
    displayName: "Phoebe",
    role: "student",
    password: createPasswordRecord("12345"),
  },
]);

beforeEach(() => {
  process.env.AAIS_SESSION_SECRET = "test-session-secret-with-at-least-32-characters";
  process.env.AAIS_TRIAL_ACCOUNTS_JSON = accountConfig;
});

afterEach(() => {
  delete process.env.AAIS_SESSION_SECRET;
  delete process.env.AAIS_TRIAL_ACCOUNTS_JSON;
  delete process.env.AAIS_TRIAL_SMOKE_ACCOUNTS_JSON;
  delete process.env.AAIS_TRIAL_ADDITIONAL_ACCOUNTS_JSON;
  clearAaisSessionRevocationsForTest();
  vi.restoreAllMocks();
  vi.doUnmock("@/lib/server/aais-users");
  vi.doUnmock("@/lib/server/aais-auth-rate-limit");
  vi.resetModules();
  vi.unstubAllEnvs();
});

describe("AAIS trial account auth route", () => {
  it("allows the two configured trial accounts", async () => {
    const { POST } = await import("@/app/api/auth/app-session/route");
    const bobie = await POST(
      new Request("http://localhost/api/auth/app-session", {
        method: "POST",
        body: authBody({
          account: "Bobie",
          password: "12345",
        }),
      }),
    );
    const bobieBody = await bobie.json();

    expect(bobie.status).toBe(200);
    expect(bobieBody.appSession.actor).toMatchObject({
      id: "Bobie",
      displayName: "Bobie",
      role: "student",
    });
    const setCookie = bobie.headers.get("set-cookie") ?? "";
    expect(setCookie).toContain("aais_session=");
    expect(setCookie).toContain("aais_csrf=");
    expect(setCookie).toContain("HttpOnly");
    expect(setCookie).toContain("SameSite=lax");
    expect(setCookie).not.toContain("12345");

    const phoebe = await POST(
      new Request("http://localhost/api/auth/app-session", {
        method: "POST",
        body: authBody({
          account: "Phoebe",
          password: "12345",
        }),
      }),
    );
    const phoebeBody = await phoebe.json();

    expect(phoebe.status).toBe(200);
    expect(phoebeBody.appSession.actor.displayName).toBe("Phoebe");
  });

  it("rejects unknown accounts and wrong passwords", async () => {
    const { POST } = await import("@/app/api/auth/app-session/route");
    const wrongPassword = await POST(
      new Request("http://localhost/api/auth/app-session", {
        method: "POST",
        body: authBody({
          account: "Bobie",
          password: "wrong",
        }),
      }),
    );
    expect(wrongPassword.status).toBe(401);

    const unknown = await POST(
      new Request("http://localhost/api/auth/app-session", {
        method: "POST",
        body: authBody({
          account: "Alice",
          password: "12345",
        }),
      }),
    );
    expect(unknown.status).toBe(401);
  });

  it("requires explicit terms, privacy, and guardian consent acknowledgement before login", async () => {
    const { POST } = await import("@/app/api/auth/app-session/route");

    const response = await POST(
      new Request("http://localhost/api/auth/app-session", {
        method: "POST",
        body: JSON.stringify({
          account: "Bobie",
          password: "12345",
        }),
      }),
    );
    const body = await response.json();

    expect(response.status).toBe(428);
    expect(body.error).toEqual({
      code: "AAIS_LOGIN_CONSENT_REQUIRED",
      message: "AAIS terms, privacy, and guardian consent acknowledgement is required before login.",
    });
    expect(response.headers.get("set-cookie") ?? "").not.toContain("aais_session=");
  });

  it("allows smoke-only educator accounts without replacing configured learners", async () => {
    process.env.AAIS_TRIAL_SMOKE_ACCOUNTS_JSON = JSON.stringify([
      {
        id: "teacher-smoke",
        displayName: "Teacher Smoke",
        role: "teacher",
        password: createPasswordRecord("teacher-secret"),
      },
    ]);
    const { POST } = await import("@/app/api/auth/app-session/route");

    const learner = await POST(
      new Request("http://localhost/api/auth/app-session", {
        method: "POST",
        body: authBody({
          account: "Bobie",
          password: "12345",
        }),
      }),
    );
    const teacher = await POST(
      new Request("http://localhost/api/auth/app-session", {
        method: "POST",
        body: authBody({
          account: "teacher-smoke",
          password: "teacher-secret",
        }),
      }),
    );
    const teacherBody = await teacher.json();

    expect(learner.status).toBe(200);
    expect(teacher.status).toBe(200);
    expect(teacherBody.appSession.actor).toMatchObject({
      id: "teacher-smoke",
      displayName: "Teacher Smoke",
      role: "teacher",
    });
    expect(JSON.stringify(teacherBody)).not.toContain("teacher-secret");
  });

  it("authenticates database users before falling back to trial accounts", async () => {
    vi.resetModules();
    const authenticateAaisUserAccount = vi.fn(async () => ({
      status: "ok" as const,
      actor: {
        id: "user-teacher",
        role: "teacher" as const,
        displayName: "Teacher A",
      },
    }));
    vi.doMock("@/lib/server/aais-users", () => ({
      authenticateAaisUserAccount,
    }));
    const { POST } = await import("@/app/api/auth/app-session/route");

    const response = await POST(
      new Request("http://localhost/api/auth/app-session", {
        method: "POST",
        body: authBody({
          account: "teacher@example.test",
          password: "db-password-123",
        }),
      }),
    );
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(authenticateAaisUserAccount).toHaveBeenCalledWith(
      "teacher@example.test",
      "db-password-123",
    );
    expect(body.appSession.actor).toMatchObject({
      id: "user-teacher",
      displayName: "Teacher A",
      role: "teacher",
    });
    expect(JSON.stringify(body)).not.toContain("db-password-123");
  });

  it("uses configured learner credentials in production without demo-password fallback", async () => {
    vi.stubEnv("NODE_ENV", "production");
    process.env.AAIS_TRIAL_ACCOUNTS_JSON = JSON.stringify([
      {
        id: "Bobie",
        displayName: "Bobie",
        role: "student",
        password: createPasswordRecord("production-bobie-secret"),
      },
    ]);
    const { POST } = await import("@/app/api/auth/app-session/route");

    const configured = await POST(
      new Request("http://localhost/api/auth/app-session", {
        method: "POST",
        body: authBody({
          account: "Bobie",
          password: "production-bobie-secret",
        }),
      }),
    );
    const configuredBody = await configured.json();
    const demoPassword = await POST(
      new Request("http://localhost/api/auth/app-session", {
        method: "POST",
        body: authBody({
          account: "Bobie",
          password: "12345",
        }),
      }),
    );

    expect(configured.status).toBe(200);
    expect(configuredBody.appSession.actor).toMatchObject({
      id: "Bobie",
      displayName: "Bobie",
      role: "student",
    });
    expect(configured.headers.get("set-cookie") ?? "").toContain("aais_session=");
    expect(demoPassword.status).toBe(401);
  });

  it("allows an additional production learner source to rotate one account without replacing others", async () => {
    vi.stubEnv("NODE_ENV", "production");
    process.env.AAIS_TRIAL_ACCOUNTS_JSON = JSON.stringify([
      {
        id: "Bobie",
        displayName: "Bobie",
        role: "student",
        password: createPasswordRecord("legacy-bobie-secret"),
      },
      {
        id: "Phoebe",
        displayName: "Phoebe",
        role: "student",
        password: createPasswordRecord("production-phoebe-secret"),
      },
    ]);
    process.env.AAIS_TRIAL_ADDITIONAL_ACCOUNTS_JSON = JSON.stringify([
      {
        id: "Bobie",
        displayName: "Bobie",
        role: "student",
        password: createPasswordRecord("rotated-bobie-secret"),
      },
    ]);
    const { POST } = await import("@/app/api/auth/app-session/route");

    const rotated = await POST(
      new Request("http://localhost/api/auth/app-session", {
        method: "POST",
        body: authBody({
          account: "Bobie",
          password: "rotated-bobie-secret",
        }),
      }),
    );
    const legacy = await POST(
      new Request("http://localhost/api/auth/app-session", {
        method: "POST",
        body: authBody({
          account: "Bobie",
          password: "legacy-bobie-secret",
        }),
      }),
    );
    const otherLearner = await POST(
      new Request("http://localhost/api/auth/app-session", {
        method: "POST",
        body: authBody({
          account: "Phoebe",
          password: "production-phoebe-secret",
        }),
      }),
    );

    expect(rotated.status).toBe(200);
    expect(legacy.status).toBe(401);
    expect(otherLearner.status).toBe(200);
  });

  it("refuses production educator trial accounts so teachers and admins use database or OIDC identities", async () => {
    vi.stubEnv("NODE_ENV", "production");
    process.env.AAIS_TRIAL_ACCOUNTS_JSON = JSON.stringify([
      {
        id: "teacher-smoke",
        displayName: "Teacher Smoke",
        role: "teacher",
        password: createPasswordRecord("teacher-secret"),
      },
    ]);
    const { POST } = await import("@/app/api/auth/app-session/route");

    const response = await POST(
      new Request("http://localhost/api/auth/app-session", {
        method: "POST",
        body: authBody({
          account: "teacher-smoke",
          password: "teacher-secret",
        }),
      }),
    );
    const body = await response.json();

    expect(response.status).toBe(503);
    expect(body.error).toEqual({
      code: "AAIS_AUTH_NOT_CONFIGURED",
      message: "AAIS auth is not configured.",
    });
    expect(response.headers.get("set-cookie") ?? "").not.toContain("aais_session=");
    expect(JSON.stringify(body)).not.toContain("teacher-secret");
  });

  it("rate limits repeated failed login attempts for the same account and client", async () => {
    vi.resetModules();
    const { POST } = await import("@/app/api/auth/app-session/route");
    const makeRequest = (password: string) =>
      POST(
        new Request("http://localhost/api/auth/app-session", {
          method: "POST",
          headers: {
            "x-forwarded-for": "203.0.113.24",
          },
          body: authBody({
            account: "Bobie",
            password,
          }),
        }),
      );

    for (let attempt = 0; attempt < 5; attempt += 1) {
      const response = await makeRequest("wrong");
      expect(response.status).toBe(401);
    }

    const blocked = await makeRequest("wrong");
    const blockedBody = await blocked.json();

    expect(blocked.status).toBe(429);
    expect(blocked.headers.get("retry-after")).toBeTruthy();
    expect(blockedBody).toMatchObject({
      error: {
        code: "AAIS_LOGIN_RATE_LIMITED",
        message: "Too many login attempts. Please retry later.",
      },
      retryAfterSeconds: expect.any(Number),
    });
    expect(JSON.stringify(blockedBody)).not.toContain("wrong");

    const correctPasswordDuringLock = await makeRequest("12345");
    expect(correctPasswordDuringLock.status).toBe(429);
    expect(correctPasswordDuringLock.headers.get("set-cookie") ?? "").not.toContain("aais_session=");
  });

  it("fails closed with a redacted 503 when login rate-limit storage is unavailable", async () => {
    vi.resetModules();
    const checkAaisLoginRateLimit = vi.fn(async () => {
      throw new Error("relation aais_login_rate_limits does not exist");
    });
    const recordAaisLoginFailure = vi.fn();
    const clearAaisLoginFailures = vi.fn();
    vi.doMock("@/lib/server/aais-auth-rate-limit", () => ({
      checkAaisLoginRateLimit,
      recordAaisLoginFailure,
      clearAaisLoginFailures,
    }));
    const info = vi.spyOn(console, "info").mockImplementation(() => undefined);
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const { POST } = await import("@/app/api/auth/app-session/route");

    const response = await POST(
      new Request("http://localhost/api/auth/app-session", {
        method: "POST",
        headers: {
          "x-forwarded-for": "203.0.113.24",
        },
        body: authBody({
          account: "Bobie",
          password: "12345",
        }),
      }),
    );
    const body = await response.json();

    expect(response.status).toBe(503);
    expect(body.error).toEqual({
      code: "AAIS_LOGIN_RATE_LIMIT_UNAVAILABLE",
      message: "AAIS login protection is temporarily unavailable.",
    });
    expect(response.headers.get("set-cookie") ?? "").not.toContain("aais_session=");
    expect(checkAaisLoginRateLimit).toHaveBeenCalledOnce();
    expect(recordAaisLoginFailure).not.toHaveBeenCalled();
    expect(clearAaisLoginFailures).not.toHaveBeenCalled();
    const auditEvents = info.mock.calls.map((call) => JSON.parse(String(call[0])));
    expect(auditEvents).toEqual([
      expect.objectContaining({
        event: "auth.login.failure",
        outcome: "failure",
        metadata: {
          reason: "rate_limit_unavailable",
        },
      }),
    ]);
    const errorOutput = error.mock.calls.map((call) => String(call[0])).join("\n");
    expect(errorOutput).toContain("AAIS_LOGIN_RATE_LIMIT_UNAVAILABLE");
    expect(JSON.stringify(body)).not.toContain("Bobie");
    expect(JSON.stringify(body)).not.toContain("12345");
    expect(errorOutput).not.toContain("Bobie");
    expect(errorOutput).not.toContain("12345");
  });

  it("records redacted audit events for login success and failure", async () => {
    const info = vi.spyOn(console, "info").mockImplementation(() => undefined);
    const { POST } = await import("@/app/api/auth/app-session/route");

    await POST(
      new Request("http://localhost/api/auth/app-session", {
        method: "POST",
        body: authBody({
          account: "Bobie",
          password: "12345",
        }),
      }),
    );
    await POST(
      new Request("http://localhost/api/auth/app-session", {
        method: "POST",
        body: authBody({
          account: "Bobie",
          password: "wrong",
        }),
      }),
    );

    const auditEvents = info.mock.calls.map((call) => JSON.parse(String(call[0])));
    expect(auditEvents.map((event) => event.event)).toEqual(
      expect.arrayContaining(["auth.login.success", "auth.login.failure"]),
    );
    expect(auditEvents.map((event) => event.actorId)).toEqual([
      expect.stringMatching(/^actor:[a-f0-9]{16}$/),
      expect.stringMatching(/^actor:[a-f0-9]{16}$/),
    ]);
    expect(new Set(auditEvents.map((event) => event.actorId)).size).toBe(1);
    expect(auditEvents.every((event) => event.actorIdRedaction === "sha256-16")).toBe(true);
    expect(auditEvents.find((event) => event.event === "auth.login.success")?.metadata).toMatchObject({
      consentAcknowledged: true,
      consentVersion: "terms-privacy-guardian-v1",
    });
    expect(JSON.stringify(auditEvents)).not.toContain("Bobie");
    expect(JSON.stringify(auditEvents)).not.toContain("12345");
    expect(JSON.stringify(auditEvents)).not.toContain("wrong");
  });

  it("does not fall back to demo passwords in production without configured accounts", async () => {
    vi.stubEnv("NODE_ENV", "production");
    delete process.env.AAIS_TRIAL_ACCOUNTS_JSON;
    const { POST } = await import("@/app/api/auth/app-session/route");

    const response = await POST(
      new Request("http://localhost/api/auth/app-session", {
        method: "POST",
        body: authBody({
          account: "Bobie",
          password: "12345",
        }),
      }),
    );

    expect(response.status).toBe(503);
  });

  it("refuses trial account login when the trial-login entry is disabled", async () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("AAIS_TRIAL_LOGIN_ENABLED", "false");
    const { POST } = await import("@/app/api/auth/app-session/route");

    const response = await POST(
      new Request("http://localhost/api/auth/app-session", {
        method: "POST",
        body: authBody({
          account: "Bobie",
          password: "12345",
        }),
      }),
    );
    const body = await response.json();

    expect(response.status).toBe(404);
    expect(body.error).toEqual({
      code: "AAIS_TRIAL_LOGIN_DISABLED",
      message: "AAIS trial login is disabled.",
    });
    expect(response.headers.get("set-cookie") ?? "").not.toContain("aais_session=");
  });

  it("refuses production login when the signed session secret is missing", async () => {
    vi.stubEnv("NODE_ENV", "production");
    delete process.env.AAIS_SESSION_SECRET;
    const { POST } = await import("@/app/api/auth/app-session/route");

    const response = await POST(
      new Request("http://localhost/api/auth/app-session", {
        method: "POST",
        body: authBody({
          account: "Bobie",
          password: "12345",
        }),
      }),
    );

    expect(response.status).toBe(503);
  });

  it("clears signed and display cookies on logout", async () => {
    const { DELETE } = await import("@/app/api/auth/app-session/route");

    const response = await DELETE();
    const setCookie = response.headers.get("set-cookie") ?? "";

    expect(response.status).toBe(200);
    expect(setCookie).toContain("aais_session=");
    expect(setCookie).toContain("Max-Age=0");
    expect(setCookie).toContain("aais_csrf=");
    expect(setCookie).toContain("aais_student_id=");
    expect(setCookie).toContain("aais_display_name=");
  });

  it("revokes the signed session token on logout", async () => {
    vi.resetModules();
    const authRoute = await import("@/app/api/auth/app-session/route");
    const sessionRoute = await import("@/app/api/learning/session/route");
    const login = await authRoute.POST(
      new Request("http://localhost/api/auth/app-session", {
        method: "POST",
        body: authBody({
          account: "Bobie",
          password: "12345",
        }),
      }),
    );
    const setCookie = login.headers.get("set-cookie") ?? "";
    const cookie = [
      `${getAaisSessionCookieName()}=${extractCookie(setCookie, getAaisSessionCookieName())}`,
      `${getAaisCsrfCookieName()}=${extractCookie(setCookie, getAaisCsrfCookieName())}`,
    ].join("; ");

    const beforeLogout = await sessionRoute.GET(
      new Request("http://localhost/api/learning/session", {
        headers: { cookie },
      }),
    );
    const logout = await authRoute.DELETE(
      new Request("http://localhost/api/auth/app-session", {
        method: "DELETE",
        headers: { cookie },
      }),
    );
    const logoutBody = await logout.json();
    const afterLogout = await sessionRoute.GET(
      new Request("http://localhost/api/learning/session", {
        headers: { cookie },
      }),
    );
    const afterLogoutBody = await afterLogout.json();

    expect(beforeLogout.status).toBe(200);
    expect(logout.status).toBe(200);
    expect(logoutBody).toMatchObject({
      ok: true,
      sessionRevoked: true,
      secrets: "redacted",
    });
    expect(afterLogout.status).toBe(401);
    expect(afterLogoutBody.error).toEqual({
      code: "AAIS_AUTH_REQUIRED",
      message: "AAIS authentication is required.",
    });
  });
});

function extractCookie(setCookie: string, name: string) {
  const match = setCookie.match(new RegExp(`${name}=([^;,]+)`));
  return match?.[1] ?? "";
}

function authBody(body: {
  account: string;
  password: string;
  from?: string | null;
}) {
  return JSON.stringify({
    consentAccepted: true,
    ...body,
  });
}
