import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createAaisCsrfToken, getAaisCsrfCookieName } from "@/lib/server/aais-csrf";
import {
  createAaisSessionToken,
  getAaisSessionCookieName,
  verifyAaisSessionTokenWithMetadata,
} from "@/lib/server/aais-session";
import { clearAaisSessionRevocationsForTest } from "@/lib/server/aais-session-revocations";
import {
  createAaisTrialActorId,
  createPasswordRecord,
  resolveAaisTrialSessionActor,
} from "@/lib/server/aais-trial-accounts";

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
  vi.doUnmock("@/lib/server/aais-learning-store");
  vi.doUnmock("@/lib/server/aais-users");
  vi.doUnmock("@/lib/server/aais-auth-rate-limit");
  vi.doUnmock("@/lib/server/aais-request-auth");
  vi.doUnmock("@/lib/server/aais-research-store");
  vi.doUnmock("@/lib/server/aais-session-revocations");
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
      id: createAaisTrialActorId("Bobie"),
      displayName: "Bobie",
      role: "student",
    });
    const setCookie = bobie.headers.get("set-cookie") ?? "";
    expect(setCookie).toContain("aais_session=");
    expect(setCookie).toContain("aais_csrf=");
    expect(setCookie).toContain("HttpOnly");
    expect(setCookie).toContain("SameSite=lax");
    expect(setCookie).not.toContain("12345");
    expect(verifyAaisSessionTokenWithMetadata(
      extractCookie(setCookie, getAaisSessionCookieName()),
    )).toMatchObject({
      authSource: "trial",
      authVersion: null,
      trialPolicyFingerprint: expect.stringMatching(/^[a-f0-9]{64}$/),
    });
    expect(resolveAaisTrialSessionActor("Bobie")).toBeNull();
    expect(resolveAaisTrialSessionActor(createAaisTrialActorId("Bobie"))).toMatchObject({
      id: createAaisTrialActorId("Bobie"),
      displayName: "Bobie",
      role: "student",
    });
    expect(setCookie).toContain("aais_student_id=;");
    expect(setCookie).toContain("aais_display_name=;");

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

  it("rejects browser-normalized cross-origin login return targets", async () => {
    const { POST } = await import("@/app/api/auth/app-session/route");
    const response = await POST(
      new Request("http://localhost/api/auth/app-session", {
        method: "POST",
        body: authBody({
          account: "Bobie",
          password: "12345",
          from: "/\\evil.example/path",
        }),
      }),
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      redirectTarget: "/learning",
    });
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

  it("rejects malformed and oversized login bodies before rate-limit or authentication work", async () => {
    vi.resetModules();
    const checkAaisLoginRateLimit = vi.fn(async () => ({ status: "allowed" as const }));
    const recordAaisLoginFailure = vi.fn();
    const clearAaisLoginFailures = vi.fn();
    const authenticateAaisUserAccount = vi.fn(async () => ({ status: "invalid" as const }));
    vi.doMock("@/lib/server/aais-auth-rate-limit", () => ({
      admitAaisLoginAttempt: checkAaisLoginRateLimit,
      checkAaisLoginRateLimit,
      recordAaisLoginFailure,
      clearAaisLoginFailures,
    }));
    vi.doMock("@/lib/server/aais-users", () => ({ authenticateAaisUserAccount }));
    const { POST } = await import("@/app/api/auth/app-session/route");
    const cases = [
      { body: "not-json", status: 400, code: "AAIS_AUTH_REQUEST_INVALID" },
      { body: JSON.stringify([]), status: 400, code: "AAIS_AUTH_REQUEST_INVALID" },
      {
        body: JSON.stringify({ account: 123, password: "12345", consentAccepted: true }),
        status: 400,
        code: "AAIS_AUTH_REQUEST_INVALID",
      },
      {
        body: JSON.stringify({ account: "Bobie", password: {}, consentAccepted: true }),
        status: 400,
        code: "AAIS_AUTH_REQUEST_INVALID",
      },
      {
        body: JSON.stringify({
          account: "Bobie",
          password: "12345",
          consentAccepted: true,
          unexpected: true,
        }),
        status: 400,
        code: "AAIS_AUTH_REQUEST_INVALID",
      },
      {
        body: JSON.stringify({
          account: "a".repeat(321),
          password: "12345",
          consentAccepted: true,
        }),
        status: 413,
        code: "AAIS_AUTH_REQUEST_TOO_LARGE",
      },
      {
        body: JSON.stringify({
          account: "Bobie",
          password: "p".repeat(17_000),
          consentAccepted: true,
        }),
        status: 413,
        code: "AAIS_AUTH_REQUEST_TOO_LARGE",
      },
    ];

    for (const input of cases) {
      const response = await POST(new Request("http://localhost/api/auth/app-session", {
        method: "POST",
        body: input.body,
      }));
      expect(response.status).toBe(input.status);
      await expect(response.json()).resolves.toMatchObject({
        error: { code: input.code },
      });
    }
    expect(checkAaisLoginRateLimit).not.toHaveBeenCalled();
    expect(authenticateAaisUserAccount).not.toHaveBeenCalled();
    expect(recordAaisLoginFailure).not.toHaveBeenCalled();
    expect(clearAaisLoginFailures).not.toHaveBeenCalled();
  });

  it("maps authentication storage failures to a structured redacted response", async () => {
    vi.resetModules();
    const checkAaisLoginRateLimit = vi.fn(async () => ({ status: "allowed" as const }));
    const authenticateAaisUserAccount = vi.fn(async () => {
      throw new Error("sensitive database topology");
    });
    vi.doMock("@/lib/server/aais-auth-rate-limit", () => ({
      admitAaisLoginAttempt: checkAaisLoginRateLimit,
      checkAaisLoginRateLimit,
      recordAaisLoginFailure: vi.fn(),
      clearAaisLoginFailures: vi.fn(),
    }));
    vi.doMock("@/lib/server/aais-users", () => ({ authenticateAaisUserAccount }));
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const { POST } = await import("@/app/api/auth/app-session/route");

    const response = await POST(new Request("http://localhost/api/auth/app-session", {
      method: "POST",
      body: authBody({ account: "Bobie", password: "12345" }),
    }));
    const body = await response.json();

    expect(response.status).toBe(500);
    expect(body).toMatchObject({
      error: {
        code: "AAIS_AUTH_REQUEST_FAILED",
        message: "AAIS login could not be completed.",
      },
    });
    expect(JSON.stringify(body)).not.toContain("sensitive database topology");
    expect(authenticateAaisUserAccount).toHaveBeenCalledOnce();
  });

  it("fails closed with 503 when the database auth schema is not migrated", async () => {
    vi.resetModules();
    const checkAaisLoginRateLimit = vi.fn(async () => ({ status: "allowed" as const }));
    const recordAaisLoginFailure = vi.fn();
    const clearAaisLoginFailures = vi.fn();
    const authenticateAaisUserAccount = vi.fn(async () => ({
      status: "schema_unavailable" as const,
    }));
    vi.doMock("@/lib/server/aais-auth-rate-limit", () => ({
      admitAaisLoginAttempt: checkAaisLoginRateLimit,
      checkAaisLoginRateLimit,
      recordAaisLoginFailure,
      clearAaisLoginFailures,
    }));
    vi.doMock("@/lib/server/aais-users", () => ({ authenticateAaisUserAccount }));
    const { POST } = await import("@/app/api/auth/app-session/route");

    const response = await POST(new Request("http://localhost/api/auth/app-session", {
      method: "POST",
      body: authBody({ account: "Bobie", password: "12345" }),
    }));

    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toEqual({
      error: {
        code: "AAIS_AUTH_STORE_NOT_CONFIGURED",
        message: "AAIS database authentication is temporarily unavailable.",
      },
    });
    expect(response.headers.get("set-cookie") ?? "").not.toContain("aais_session=");
    expect(authenticateAaisUserAccount).toHaveBeenCalledOnce();
    expect(recordAaisLoginFailure).not.toHaveBeenCalled();
    expect(clearAaisLoginFailures).not.toHaveBeenCalled();
  });

  it("returns a retryable 503 when bounded password verification capacity is exhausted", async () => {
    vi.resetModules();
    const { AaisPasswordKdfCapacityError } = await import(
      "@/lib/server/aais-password-kdf"
    );
    const authenticateAaisUserAccount = vi.fn(async () => {
      throw new AaisPasswordKdfCapacityError();
    });
    vi.doMock("@/lib/server/aais-users", () => ({ authenticateAaisUserAccount }));
    const { POST } = await import("@/app/api/auth/app-session/route");

    const response = await POST(new Request("http://localhost/api/auth/app-session", {
      method: "POST",
      body: authBody({ account: "Bobie", password: "12345" }),
    }));

    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toEqual({
      error: {
        code: "AAIS_AUTH_CAPACITY_UNAVAILABLE",
        message: "AAIS login is temporarily busy. Please retry shortly.",
      },
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
      id: createAaisTrialActorId("teacher-smoke"),
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
      authVersion: 1,
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
    expect(verifyAaisSessionTokenWithMetadata(extractCookie(
      response.headers.get("set-cookie") ?? "",
      getAaisSessionCookieName(),
    ))).toMatchObject({
      authSource: "database",
      authVersion: 1,
    });
  });

  it("never falls back to a same-login trial account after a database credential match fails", async () => {
    vi.resetModules();
    const authenticateAaisUserAccount = vi.fn(async () => ({
      status: "invalid" as const,
    }));
    vi.doMock("@/lib/server/aais-users", () => ({
      authenticateAaisUserAccount,
    }));
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

    expect(response.status).toBe(401);
    expect(response.headers.get("set-cookie") ?? "").not.toContain("aais_session=");
    expect(authenticateAaisUserAccount).toHaveBeenCalledOnce();
  });

  it("uses an isolated actor namespace only after the database explicitly reports no matching user", async () => {
    vi.resetModules();
    const authenticateAaisUserAccount = vi.fn(async () => ({
      status: "not_found" as const,
    }));
    vi.doMock("@/lib/server/aais-users", () => ({
      authenticateAaisUserAccount,
    }));
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

    expect(response.status).toBe(200);
    expect(body.appSession.actor).toMatchObject({
      id: expect.stringMatching(/^trial:v1:[a-f0-9]{64}$/),
      displayName: "Bobie",
      role: "student",
    });
    expect(verifyAaisSessionTokenWithMetadata(extractCookie(
      response.headers.get("set-cookie") ?? "",
      getAaisSessionCookieName(),
    ))).toMatchObject({
      actor: {
        id: expect.stringMatching(/^trial:v1:[a-f0-9]{64}$/),
      },
      authSource: "trial",
      trialPolicyFingerprint: expect.stringMatching(/^[a-f0-9]{64}$/),
    });
  });

  it("uses configured learner credentials in production without demo-password fallback", async () => {
    vi.stubEnv("NODE_ENV", "production");
    mockDurableRateLimitAvailable();
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
      id: createAaisTrialActorId("Bobie"),
      displayName: "Bobie",
      role: "student",
    });
    expect(configured.headers.get("set-cookie") ?? "").toContain("aais_session=");
    expect(demoPassword.status).toBe(401);
  });

  it("invalidates production trial cookies after password-record rotation or remove-readd", async () => {
    vi.stubEnv("NODE_ENV", "production");
    mockDurableRateLimitAvailable();
    vi.doMock("@/lib/server/aais-session-revocations", async () => {
      const actual = await vi.importActual<typeof import("@/lib/server/aais-session-revocations")>(
        "@/lib/server/aais-session-revocations",
      );
      return {
        ...actual,
        isAaisSessionTokenRevoked: vi.fn(async () => false),
      };
    });
    const initialRecord = createPasswordRecord("initial-trial-secret", "initial-trial-salt");
    const rotatedRecord = createPasswordRecord("rotated-trial-secret", "rotated-trial-salt");
    const readdedRecord = createPasswordRecord("readded-trial-secret", "readded-trial-salt");
    const configure = (password: ReturnType<typeof createPasswordRecord>) => {
      process.env.AAIS_TRIAL_ACCOUNTS_JSON = JSON.stringify([{
        id: "RotationLearner",
        displayName: "Rotation Learner",
        role: "student",
        password,
      }]);
    };
    configure(initialRecord);
    const [{ POST }, { verifyAaisRequestSessionToken }] = await Promise.all([
      import("@/app/api/auth/app-session/route"),
      import("@/lib/server/aais-request-auth"),
    ]);

    const initialLogin = await POST(new Request("http://localhost/api/auth/app-session", {
      method: "POST",
      body: authBody({
        account: "RotationLearner",
        password: "initial-trial-secret",
      }),
    }));
    const initialToken = extractCookie(
      initialLogin.headers.get("set-cookie") ?? "",
      getAaisSessionCookieName(),
    );
    const initialMetadata = verifyAaisSessionTokenWithMetadata(initialToken);
    expect(initialLogin.status).toBe(200);
    expect(initialMetadata).toMatchObject({
      authSource: "trial",
      trialPolicyFingerprint: expect.stringMatching(/^[a-f0-9]{64}$/),
    });
    expect(JSON.stringify(initialMetadata)).not.toContain(initialRecord.salt);
    expect(JSON.stringify(initialMetadata)).not.toContain(initialRecord.hash);
    await expect(verifyAaisRequestSessionToken(initialToken)).resolves.toMatchObject({
      id: createAaisTrialActorId("RotationLearner"),
      role: "student",
    });

    configure(rotatedRecord);
    await expect(verifyAaisRequestSessionToken(initialToken)).resolves.toBeNull();
    const rotatedLogin = await POST(new Request("http://localhost/api/auth/app-session", {
      method: "POST",
      body: authBody({
        account: "RotationLearner",
        password: "rotated-trial-secret",
      }),
    }));
    const rotatedToken = extractCookie(
      rotatedLogin.headers.get("set-cookie") ?? "",
      getAaisSessionCookieName(),
    );
    expect(rotatedLogin.status).toBe(200);
    await expect(verifyAaisRequestSessionToken(rotatedToken)).resolves.toMatchObject({
      id: createAaisTrialActorId("RotationLearner"),
      role: "student",
    });

    delete process.env.AAIS_TRIAL_ACCOUNTS_JSON;
    await expect(verifyAaisRequestSessionToken(rotatedToken)).resolves.toBeNull();
    configure(readdedRecord);
    await expect(verifyAaisRequestSessionToken(rotatedToken)).resolves.toBeNull();
  });

  it("allows an additional production learner source to rotate one account without replacing others", async () => {
    vi.stubEnv("NODE_ENV", "production");
    mockDurableRateLimitAvailable();
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

  it("uses a valid recovery learner when a legacy production source is malformed", async () => {
    vi.stubEnv("NODE_ENV", "production");
    mockDurableRateLimitAvailable();
    process.env.AAIS_TRIAL_ACCOUNTS_JSON = "{not-json";
    process.env.AAIS_TRIAL_ADDITIONAL_ACCOUNTS_JSON = JSON.stringify([
      {
        id: "Bobie",
        displayName: "Bobie",
        role: "student",
        password: createPasswordRecord("recovery-bobie-secret"),
      },
    ]);
    const { POST } = await import("@/app/api/auth/app-session/route");

    const response = await POST(
      new Request("http://localhost/api/auth/app-session", {
        method: "POST",
        body: authBody({
          account: "Bobie",
          password: "recovery-bobie-secret",
        }),
      }),
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("set-cookie") ?? "").toContain("aais_session=");
  });

  it("fails closed when the recovery account source is malformed", async () => {
    vi.stubEnv("NODE_ENV", "production");
    mockDurableRateLimitAvailable();
    process.env.AAIS_TRIAL_ACCOUNTS_JSON = JSON.stringify([
      {
        id: "Bobie",
        displayName: "Bobie",
        role: "student",
        password: createPasswordRecord("production-bobie-secret"),
      },
    ]);
    process.env.AAIS_TRIAL_ADDITIONAL_ACCOUNTS_JSON = "{not-json";
    const { POST } = await import("@/app/api/auth/app-session/route");

    const response = await POST(
      new Request("http://localhost/api/auth/app-session", {
        method: "POST",
        body: authBody({
          account: "Bobie",
          password: "production-bobie-secret",
        }),
      }),
    );

    expect(response.status).toBe(503);
  });

  it("rejects trial account IDs that impersonate reserved authentication namespaces", async () => {
    vi.stubEnv("NODE_ENV", "production");
    const { getAaisTrialAccountConfigurationStatus } = await import(
      "@/lib/server/aais-trial-accounts"
    );

    for (const id of ["oidc:trial-student", "aais:trial-student", "trial:legacy-student"]) {
      process.env.AAIS_TRIAL_ACCOUNTS_JSON = JSON.stringify([
        {
          id,
          displayName: "Confused Source",
          role: "student",
          password: createPasswordRecord("source-confusion-secret"),
        },
      ]);
      expect(getAaisTrialAccountConfigurationStatus()).toMatchObject({
        status: "invalid",
        configured: false,
      });
    }
  });

  it("keeps production learners available when another source contains educator smoke records", async () => {
    vi.stubEnv("NODE_ENV", "production");
    mockDurableRateLimitAvailable();
    process.env.AAIS_TRIAL_ACCOUNTS_JSON = JSON.stringify([
      {
        id: "Bobie",
        displayName: "Bobie",
        role: "student",
        password: createPasswordRecord("production-bobie-secret"),
      },
    ]);
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
          password: "production-bobie-secret",
        }),
      }),
    );
    const educator = await POST(
      new Request("http://localhost/api/auth/app-session", {
        method: "POST",
        body: authBody({
          account: "teacher-smoke",
          password: "teacher-secret",
        }),
      }),
    );

    expect(learner.status).toBe(200);
    expect(educator.status).toBe(401);
  });

  it("refuses production educator trial accounts so teachers and admins use database or OIDC identities", async () => {
    vi.stubEnv("NODE_ENV", "production");
    mockDurableRateLimitAvailable();
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
      admitAaisLoginAttempt: checkAaisLoginRateLimit,
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

  it("atomically admits at most one password verification when concurrent login capacity is one", async () => {
    vi.resetModules();
    vi.stubEnv("AAIS_LOGIN_RATE_LIMIT_MAX_FAILURES", "1");
    let releaseAuthentication: ((value: { status: "invalid" }) => void) | undefined;
    const authenticationGate = new Promise<{ status: "invalid" }>((resolve) => {
      releaseAuthentication = resolve;
    });
    const authenticateAaisUserAccount = vi.fn(() => authenticationGate);
    vi.doMock("@/lib/server/aais-users", () => ({ authenticateAaisUserAccount }));
    const { POST } = await import("@/app/api/auth/app-session/route");
    const makeRequest = () => POST(new Request("http://localhost/api/auth/app-session", {
      method: "POST",
      body: authBody({ account: "Concurrent", password: "wrong" }),
    }));

    const responses = Array.from({ length: 20 }, makeRequest);
    await vi.waitFor(() => expect(authenticateAaisUserAccount).toHaveBeenCalledTimes(1));
    releaseAuthentication?.({ status: "invalid" });
    const settled = await Promise.all(responses);

    expect(settled.filter((response) => response.status === 401)).toHaveLength(1);
    expect(settled.filter((response) => response.status === 429)).toHaveLength(19);
    expect(authenticateAaisUserAccount).toHaveBeenCalledTimes(1);
  });

  it("blocks a trusted client that concurrently rotates random accounts before dummy KDF work", async () => {
    vi.resetModules();
    vi.stubEnv("AAIS_TRUSTED_PROXY_IP_HEADER", "x-forwarded-for");
    vi.stubEnv("AAIS_LOGIN_RATE_LIMIT_MAX_FAILURES", "100");
    vi.stubEnv("AAIS_LOGIN_RATE_LIMIT_CLIENT_MAX_ATTEMPTS", "2");
    let releaseAuthentication: ((value: { status: "invalid" }) => void) | undefined;
    const authenticationGate = new Promise<{ status: "invalid" }>((resolve) => {
      releaseAuthentication = resolve;
    });
    const authenticateAaisUserAccount = vi.fn(() => authenticationGate);
    vi.doMock("@/lib/server/aais-users", () => ({ authenticateAaisUserAccount }));
    const { POST } = await import("@/app/api/auth/app-session/route");
    const makeRequest = (account: string) => POST(new Request(
      "http://localhost/api/auth/app-session",
      {
        method: "POST",
        headers: { "x-forwarded-for": "203.0.113.191" },
        body: authBody({ account, password: "wrong" }),
      },
    ));

    const responses = [makeRequest("random-u1"), makeRequest("random-u2"), makeRequest("random-u3")];
    await vi.waitFor(() => expect(authenticateAaisUserAccount).toHaveBeenCalledTimes(2));
    releaseAuthentication?.({ status: "invalid" });
    const settled = await Promise.all(responses);

    expect(settled.filter((response) => response.status === 401)).toHaveLength(2);
    expect(settled.filter((response) => response.status === 429)).toHaveLength(1);
    expect(authenticateAaisUserAccount).toHaveBeenCalledTimes(2);
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
    mockDurableRateLimitAvailable();
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
    mockDurableRateLimitAvailable();
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
    mockDurableRateLimitAvailable();
    delete process.env.AAIS_SESSION_SECRET;
    const info = vi.spyOn(console, "info").mockImplementation(() => undefined);
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
    const auditEvents = info.mock.calls.map((call) => JSON.parse(String(call[0])));
    expect(auditEvents).toEqual([
      expect.objectContaining({
        event: "auth.login.failure",
        outcome: "failure",
        metadata: { reason: "session_configuration" },
      }),
    ]);
    expect(auditEvents.some((event) => event.event === "auth.login.success")).toBe(false);
  });

  it("clears signed and display cookies on logout", async () => {
    const { DELETE } = await import("@/app/api/auth/app-session/route");

    const response = await DELETE();
    const body = await response.json();
    const setCookie = response.headers.get("set-cookie") ?? "";

    expect(response.status).toBe(200);
    expect(body).toMatchObject({
      ok: true,
      sessionAbsent: true,
      sessionRevoked: false,
    });
    expect(setCookie).toContain("aais_session=");
    expect(setCookie).toContain("Max-Age=0");
    expect(setCookie).toContain("aais_csrf=");
    expect(setCookie).toContain("aais_student_id=");
    expect(setCookie).toContain("aais_display_name=");
  });

  it("accepts the browser's zero-byte DELETE stream as an ordinary logout", async () => {
    const authRoute = await import("@/app/api/auth/app-session/route");
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
    const csrf = extractCookie(setCookie, getAaisCsrfCookieName());
    const cookie = [
      `${getAaisSessionCookieName()}=${extractCookie(setCookie, getAaisSessionCookieName())}`,
      `${getAaisCsrfCookieName()}=${csrf}`,
    ].join("; ");
    const response = await authRoute.DELETE(new Request("http://localhost/api/auth/app-session", {
      method: "DELETE",
      headers: {
        cookie,
        "x-aais-csrf": csrf,
      },
      body: new Uint8Array(),
    }));

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      ok: true,
      sessionAbsent: false,
      sessionRevoked: true,
      secrets: "redacted",
    });
  });

  it("returns 503 and keeps the cookie when production has no durable revocation store", async () => {
    vi.resetModules();
    vi.stubEnv("NODE_ENV", "production");
    vi.doMock("@/lib/server/aais-learning-store", async () => {
      const actual = await vi.importActual<typeof import("@/lib/server/aais-learning-store")>(
        "@/lib/server/aais-learning-store",
      );
      return { ...actual, getAaisDatabaseConfiguration: () => null };
    });
    const { DELETE } = await import("@/app/api/auth/app-session/route");
    const actor = {
      id: `oidc:v2:${"b".repeat(64)}`,
      displayName: "OIDC Teacher",
      role: "teacher" as const,
    };
    const token = createAaisSessionToken(actor, new Date(), {
      authSource: "oidc",
      oidcPolicyFingerprint: "a".repeat(64),
      ttlSeconds: 15 * 60,
    });
    const csrf = createAaisCsrfToken(actor.id);

    const response = await DELETE(new Request("http://localhost/api/auth/app-session", {
      method: "DELETE",
      headers: {
        cookie: [
          `${getAaisSessionCookieName()}=${token}`,
          `${getAaisCsrfCookieName()}=${csrf}`,
        ].join("; "),
        "x-aais-csrf": csrf,
      },
    }));

    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toEqual({
      error: {
        code: "AAIS_LOGOUT_FAILED",
        message: "AAIS server session revocation failed; the session remains active.",
      },
    });
    expect(response.headers.get("set-cookie") ?? "").not.toContain("Max-Age=0");
  });

  it("treats an expired session cookie as an idempotent already-absent logout", async () => {
    const { DELETE } = await import("@/app/api/auth/app-session/route");
    const expiredToken = createAaisSessionToken(
      { id: "Bobie", displayName: "Bobie", role: "student" },
      new Date("2020-01-01T00:00:00.000Z"),
    );

    const response = await DELETE(new Request("http://localhost/api/auth/app-session", {
      method: "DELETE",
      headers: {
        cookie: `${getAaisSessionCookieName()}=${expiredToken}`,
      },
    }));

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      ok: true,
      sessionAbsent: true,
      sessionRevoked: false,
      secrets: "redacted",
    });
    expect(response.headers.get("set-cookie") ?? "").toContain("Max-Age=0");
  });

  it("treats malformed percent-encoded cookies as invalid instead of throwing", async () => {
    const { DELETE } = await import("@/app/api/auth/app-session/route");

    const response = await DELETE(new Request("http://localhost/api/auth/app-session", {
      method: "DELETE",
      headers: {
        cookie: `${getAaisSessionCookieName()}=%E0%A4%A; ${getAaisCsrfCookieName()}=%`,
      },
    }));

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      ok: true,
      sessionAbsent: true,
      sessionRevoked: false,
    });
  });

  it("rejects an oversized authenticated logout body before revocation or research storage", async () => {
    const revokeAaisSessionToken = vi.fn();
    const getAaisResearchStore = vi.fn();
    vi.doMock("@/lib/server/aais-session-revocations", async () => {
      const actual = await vi.importActual<typeof import("@/lib/server/aais-session-revocations")>(
        "@/lib/server/aais-session-revocations",
      );
      return { ...actual, revokeAaisSessionToken };
    });
    vi.doMock("@/lib/server/aais-research-store", async () => {
      const actual = await vi.importActual<typeof import("@/lib/server/aais-research-store")>(
        "@/lib/server/aais-research-store",
      );
      return { ...actual, getAaisResearchStore };
    });
    const { DELETE } = await import("@/app/api/auth/app-session/route");
    const actor = { id: "Bobie", displayName: "Bobie", role: "student" as const };
    const token = createAaisSessionToken(actor, new Date(), {
      authSource: "development",
    });
    const csrf = createAaisCsrfToken(actor.id);

    const response = await DELETE(new Request("http://localhost/api/auth/app-session", {
      method: "DELETE",
      headers: {
        cookie: [
          `${getAaisSessionCookieName()}=${token}`,
          `${getAaisCsrfCookieName()}=${csrf}`,
        ].join("; "),
        "x-aais-csrf": csrf,
      },
      body: JSON.stringify({ researchLogout: { padding: "x".repeat(17 * 1024) } }),
    }));

    expect(response.status).toBe(413);
    await expect(response.json()).resolves.toMatchObject({
      error: {
        code: "AAIS_LOGOUT_REQUEST_TOO_LARGE",
        message: "AAIS logout request is too large.",
      },
    });
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(revokeAaisSessionToken).not.toHaveBeenCalled();
    expect(getAaisResearchStore).not.toHaveBeenCalled();
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
    const csrf = extractCookie(setCookie, getAaisCsrfCookieName());
    const cookie = [
      `${getAaisSessionCookieName()}=${extractCookie(setCookie, getAaisSessionCookieName())}`,
      `${getAaisCsrfCookieName()}=${csrf}`,
    ].join("; ");

    const sessionCreated = await sessionRoute.POST(
      new Request("http://localhost/api/learning/session", {
        method: "POST",
        headers: {
          cookie,
          "x-aais-csrf": csrf,
        },
      }),
    );

    const beforeLogout = await sessionRoute.GET(
      new Request("http://localhost/api/learning/session", {
        headers: { cookie },
      }),
    );
    const logout = await authRoute.DELETE(
      new Request("http://localhost/api/auth/app-session", {
        method: "DELETE",
        headers: {
          cookie,
          "x-aais-csrf": csrf,
        },
      }),
    );
    const logoutBody = await logout.json();
    const afterLogout = await sessionRoute.GET(
      new Request("http://localhost/api/learning/session", {
        headers: { cookie },
      }),
    );
    const afterLogoutBody = await afterLogout.json();
    const repeatedLogout = await authRoute.DELETE(
      new Request("http://localhost/api/auth/app-session", {
        method: "DELETE",
        headers: {
          cookie,
          "x-aais-csrf": csrf,
        },
      }),
    );

    expect(sessionCreated.status).toBe(200);
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
    expect(repeatedLogout.status).toBe(200);
    await expect(repeatedLogout.json()).resolves.toMatchObject({
      ok: true,
      sessionAbsent: false,
      sessionRevoked: true,
    });
  });

  it("records and acknowledges the visit-bound final event before reporting research logout success", async () => {
    vi.resetModules();
    vi.stubEnv("AAIS_RESEARCH_MODE", "true");
    const recordEvent = vi.fn(async (
      _actor: unknown,
      event: { clientEventId: string; expectedVisitId: string },
    ) => ({
      clientEventId: event.clientEventId,
      visitId: event.expectedVisitId,
    }));
    const revokeAaisSessionToken = vi.fn(async () => ({
      status: "revoked" as const,
      storageMode: "memory" as const,
      secrets: "redacted" as const,
    }));
    vi.doMock("@/lib/server/aais-research-store", async () => {
      const actual = await vi.importActual<typeof import("@/lib/server/aais-research-store")>(
        "@/lib/server/aais-research-store",
      );
      return {
        ...actual,
        getAaisResearchStore: () => ({ recordEvent }),
      };
    });
    vi.doMock("@/lib/server/aais-session-revocations", async () => {
      const actual = await vi.importActual<typeof import("@/lib/server/aais-session-revocations")>(
        "@/lib/server/aais-session-revocations",
      );
      return {
        ...actual,
        revokeAaisSessionToken,
      };
    });
    const authRoute = await import("@/app/api/auth/app-session/route");
    const login = await authRoute.POST(
      new Request("http://localhost/api/auth/app-session", {
        method: "POST",
        body: authBody({ account: "Bobie", password: "12345" }),
      }),
    );
    const loginCookies = login.headers.get("set-cookie") ?? "";
    const csrf = extractCookie(loginCookies, getAaisCsrfCookieName());
    const cookie = [
      `${getAaisSessionCookieName()}=${extractCookie(loginCookies, getAaisSessionCookieName())}`,
      `${getAaisCsrfCookieName()}=${csrf}`,
    ].join("; ");
    const researchLogout = {
      expectedVisitId: "10000000-0000-4000-8000-000000000021",
      failureClientEventId: "10000000-0000-4000-8000-000000000022",
      finalClientTime: "2026-07-30T10:00:00.000Z",
      operationId: "account-logout-10000000-0000-4000-8000-000000000024",
      successClientEventId: "10000000-0000-4000-8000-000000000023",
    };

    const response = await authRoute.DELETE(
      new Request("http://localhost/api/auth/app-session", {
        method: "DELETE",
        headers: {
          "content-type": "application/json",
          cookie,
          "x-aais-csrf": csrf,
        },
        body: JSON.stringify({ researchLogout }),
      }),
    );
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(revokeAaisSessionToken).toHaveBeenCalledOnce();
    expect(recordEvent).toHaveBeenCalledOnce();
    expect(revokeAaisSessionToken.mock.invocationCallOrder[0]).toBeLessThan(
      recordEvent.mock.invocationCallOrder[0],
    );
    expect(recordEvent).toHaveBeenCalledWith(
      expect.objectContaining({ id: createAaisTrialActorId("Bobie") }),
      {
        clientEventId: researchLogout.successClientEventId,
        clientTime: researchLogout.finalClientTime,
        expectedVisitId: researchLogout.expectedVisitId,
        eventName: "account_logout",
        outcome: "success",
        detail: {
          operation_id: researchLogout.operationId,
          trigger: "server_session_revoke",
        },
      },
    );
    expect(body).toMatchObject({
      ok: true,
      sessionRevoked: true,
      researchLogout: {
        clientEventId: researchLogout.successClientEventId,
        visitId: researchLogout.expectedVisitId,
      },
    });
    expect(response.headers.get("set-cookie") ?? "").toContain("Max-Age=0");
  });

  it("revokes and clears a stale cookie without letting it append a research logout event", async () => {
    vi.resetModules();
    vi.stubEnv("AAIS_RESEARCH_MODE", "true");
    const recordEvent = vi.fn();
    const revokeAaisSessionToken = vi.fn(async () => ({
      status: "revoked" as const,
      storageMode: "memory" as const,
      secrets: "redacted" as const,
    }));
    vi.doMock("@/lib/server/aais-request-auth", async () => {
      const actual = await vi.importActual<typeof import("@/lib/server/aais-request-auth")>(
        "@/lib/server/aais-request-auth",
      );
      return { ...actual, verifyAaisRequestSessionToken: vi.fn(async () => null) };
    });
    vi.doMock("@/lib/server/aais-research-store", async () => {
      const actual = await vi.importActual<typeof import("@/lib/server/aais-research-store")>(
        "@/lib/server/aais-research-store",
      );
      return { ...actual, getAaisResearchStore: () => ({ recordEvent }) };
    });
    vi.doMock("@/lib/server/aais-session-revocations", async () => {
      const actual = await vi.importActual<typeof import("@/lib/server/aais-session-revocations")>(
        "@/lib/server/aais-session-revocations",
      );
      return { ...actual, revokeAaisSessionToken };
    });
    const { DELETE } = await import("@/app/api/auth/app-session/route");
    const actor = { id: "stale-research-user", displayName: "Stale", role: "student" as const };
    const token = createAaisSessionToken(actor, new Date(), { authSource: "development" });
    const csrf = createAaisCsrfToken(actor.id);
    const researchLogout = {
      expectedVisitId: "10000000-0000-4000-8000-000000000051",
      failureClientEventId: "10000000-0000-4000-8000-000000000052",
      finalClientTime: "2026-07-30T10:00:03.000Z",
      operationId: "account-logout-10000000-0000-4000-8000-000000000054",
      successClientEventId: "10000000-0000-4000-8000-000000000053",
    };

    const response = await DELETE(new Request("http://localhost/api/auth/app-session", {
      method: "DELETE",
      headers: {
        "content-type": "application/json",
        cookie: [
          `${getAaisSessionCookieName()}=${token}`,
          `${getAaisCsrfCookieName()}=${csrf}`,
        ].join("; "),
        "x-aais-csrf": csrf,
      },
      body: JSON.stringify({ researchLogout }),
    }));

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      ok: true,
      sessionRevoked: true,
      secrets: "redacted",
    });
    expect(revokeAaisSessionToken).toHaveBeenCalledOnce();
    expect(recordEvent).not.toHaveBeenCalled();
    expect(response.headers.get("set-cookie") ?? "").toContain("Max-Age=0");
  });

  it("records research logout failure and keeps cookies when server revocation fails", async () => {
    vi.resetModules();
    vi.stubEnv("AAIS_RESEARCH_MODE", "true");
    const recordEvent = vi.fn(async (
      _actor: unknown,
      event: { clientEventId: string; expectedVisitId: string },
    ) => ({
      clientEventId: event.clientEventId,
      visitId: event.expectedVisitId,
    }));
    const revokeAaisSessionToken = vi.fn(async () => {
      throw new Error("revocation storage unavailable");
    });
    vi.doMock("@/lib/server/aais-research-store", async () => {
      const actual = await vi.importActual<typeof import("@/lib/server/aais-research-store")>(
        "@/lib/server/aais-research-store",
      );
      return {
        ...actual,
        getAaisResearchStore: () => ({ recordEvent }),
      };
    });
    vi.doMock("@/lib/server/aais-session-revocations", async () => {
      const actual = await vi.importActual<typeof import("@/lib/server/aais-session-revocations")>(
        "@/lib/server/aais-session-revocations",
      );
      return {
        ...actual,
        revokeAaisSessionToken,
      };
    });
    const authRoute = await import("@/app/api/auth/app-session/route");
    const login = await authRoute.POST(
      new Request("http://localhost/api/auth/app-session", {
        method: "POST",
        body: authBody({ account: "Bobie", password: "12345" }),
      }),
    );
    const loginCookies = login.headers.get("set-cookie") ?? "";
    const csrf = extractCookie(loginCookies, getAaisCsrfCookieName());
    const cookie = [
      `${getAaisSessionCookieName()}=${extractCookie(loginCookies, getAaisSessionCookieName())}`,
      `${getAaisCsrfCookieName()}=${csrf}`,
    ].join("; ");
    const researchLogout = {
      expectedVisitId: "10000000-0000-4000-8000-000000000031",
      failureClientEventId: "10000000-0000-4000-8000-000000000032",
      finalClientTime: "2026-07-30T10:00:01.000Z",
      operationId: "account-logout-10000000-0000-4000-8000-000000000034",
      successClientEventId: "10000000-0000-4000-8000-000000000033",
    };

    const response = await authRoute.DELETE(
      new Request("http://localhost/api/auth/app-session", {
        method: "DELETE",
        headers: {
          "content-type": "application/json",
          cookie,
          "x-aais-csrf": csrf,
        },
        body: JSON.stringify({ researchLogout }),
      }),
    );
    const body = await response.json();

    expect(response.status).toBe(503);
    expect(body.error).toEqual({
      code: "AAIS_LOGOUT_FAILED",
      message: "AAIS server session revocation failed; the session remains active.",
    });
    expect(recordEvent.mock.calls.map(([, event]) => event)).toEqual([
      expect.objectContaining({
        clientEventId: researchLogout.failureClientEventId,
        outcome: "failure",
        detail: {
          operation_id: researchLogout.operationId,
          error_kind: "session_revoke_failed",
        },
      }),
    ]);
    expect(response.headers.get("set-cookie") ?? "").not.toContain("Max-Age=0");
  });

  it("clears cookies and reports the evidence gap when revocation succeeds but the final research event fails", async () => {
    vi.resetModules();
    vi.stubEnv("AAIS_RESEARCH_MODE", "true");
    const recordEvent = vi.fn(async () => {
      throw new Error("research database unavailable");
    });
    const revokeAaisSessionToken = vi.fn(async () => ({
      status: "revoked" as const,
      storageMode: "memory" as const,
      secrets: "redacted" as const,
    }));
    vi.doMock("@/lib/server/aais-research-store", async () => {
      const actual = await vi.importActual<typeof import("@/lib/server/aais-research-store")>(
        "@/lib/server/aais-research-store",
      );
      return { ...actual, getAaisResearchStore: () => ({ recordEvent }) };
    });
    vi.doMock("@/lib/server/aais-session-revocations", async () => {
      const actual = await vi.importActual<typeof import("@/lib/server/aais-session-revocations")>(
        "@/lib/server/aais-session-revocations",
      );
      return { ...actual, revokeAaisSessionToken };
    });
    const authRoute = await import("@/app/api/auth/app-session/route");
    const login = await authRoute.POST(
      new Request("http://localhost/api/auth/app-session", {
        method: "POST",
        body: authBody({ account: "Bobie", password: "12345" }),
      }),
    );
    const loginCookies = login.headers.get("set-cookie") ?? "";
    const csrf = extractCookie(loginCookies, getAaisCsrfCookieName());
    const cookie = [
      `${getAaisSessionCookieName()}=${extractCookie(loginCookies, getAaisSessionCookieName())}`,
      `${getAaisCsrfCookieName()}=${csrf}`,
    ].join("; ");
    const researchLogout = {
      expectedVisitId: "10000000-0000-4000-8000-000000000041",
      failureClientEventId: "10000000-0000-4000-8000-000000000042",
      finalClientTime: "2026-07-30T10:00:02.000Z",
      operationId: "account-logout-10000000-0000-4000-8000-000000000044",
      successClientEventId: "10000000-0000-4000-8000-000000000043",
    };

    const response = await authRoute.DELETE(
      new Request("http://localhost/api/auth/app-session", {
        method: "DELETE",
        headers: {
          "content-type": "application/json",
          cookie,
          "x-aais-csrf": csrf,
        },
        body: JSON.stringify({ researchLogout }),
      }),
    );

    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toMatchObject({
      error: { code: "AAIS_RESEARCH_LOGOUT_ACK_FAILED" },
      sessionRevoked: true,
      researchLogoutAcknowledged: false,
      secrets: "redacted",
    });
    expect(revokeAaisSessionToken).toHaveBeenCalledOnce();
    expect(recordEvent).toHaveBeenCalledOnce();
    expect(response.headers.get("set-cookie") ?? "").toContain("Max-Age=0");
  });
});

function mockDurableRateLimitAvailable() {
  vi.doMock("@/lib/server/aais-auth-rate-limit", () => ({
    admitAaisLoginAttempt: vi.fn(async () => ({ status: "allowed" as const })),
    clearAaisLoginFailures: vi.fn(async () => undefined),
  }));
}

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
