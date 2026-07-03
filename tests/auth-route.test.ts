import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
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
  vi.unstubAllEnvs();
});

describe("AAIS trial account auth route", () => {
  it("allows the two configured trial accounts", async () => {
    const { POST } = await import("@/app/api/auth/app-session/route");
    const bobie = await POST(
      new Request("http://localhost/api/auth/app-session", {
        method: "POST",
        body: JSON.stringify({
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
        body: JSON.stringify({
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
        body: JSON.stringify({
          account: "Bobie",
          password: "wrong",
        }),
      }),
    );
    expect(wrongPassword.status).toBe(401);

    const unknown = await POST(
      new Request("http://localhost/api/auth/app-session", {
        method: "POST",
        body: JSON.stringify({
          account: "Alice",
          password: "12345",
        }),
      }),
    );
    expect(unknown.status).toBe(401);
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
        body: JSON.stringify({
          account: "Bobie",
          password: "12345",
        }),
      }),
    );
    const teacher = await POST(
      new Request("http://localhost/api/auth/app-session", {
        method: "POST",
        body: JSON.stringify({
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
          body: JSON.stringify({
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
      error: "Too many login attempts. Please retry later.",
      retryAfterSeconds: expect.any(Number),
    });
    expect(JSON.stringify(blockedBody)).not.toContain("wrong");

    const correctPasswordDuringLock = await makeRequest("12345");
    expect(correctPasswordDuringLock.status).toBe(429);
    expect(correctPasswordDuringLock.headers.get("set-cookie") ?? "").not.toContain("aais_session=");
  });

  it("records redacted audit events for login success and failure", async () => {
    const info = vi.spyOn(console, "info").mockImplementation(() => undefined);
    const { POST } = await import("@/app/api/auth/app-session/route");

    await POST(
      new Request("http://localhost/api/auth/app-session", {
        method: "POST",
        body: JSON.stringify({
          account: "Bobie",
          password: "12345",
        }),
      }),
    );
    await POST(
      new Request("http://localhost/api/auth/app-session", {
        method: "POST",
        body: JSON.stringify({
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
        body: JSON.stringify({
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
        body: JSON.stringify({
          account: "Bobie",
          password: "12345",
        }),
      }),
    );
    const body = await response.json();

    expect(response.status).toBe(404);
    expect(body.error).toBe("AAIS trial login is disabled.");
    expect(response.headers.get("set-cookie") ?? "").not.toContain("aais_session=");
  });

  it("refuses production login when the signed session secret is missing", async () => {
    vi.stubEnv("NODE_ENV", "production");
    delete process.env.AAIS_SESSION_SECRET;
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
});
