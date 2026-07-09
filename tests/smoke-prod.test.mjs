import { describe, expect, it } from "vitest";
import { runAaisProductionSmoke } from "../scripts/smoke-prod.mjs";

describe("AAIS production smoke runner", () => {
  it("checks login uptime, readiness, trial login, and a synthetic learner write without serializing secrets", async () => {
    const calls = [];
    const fetchImpl = async (url, init = {}) => {
      calls.push({ url, init });
      if (url.endsWith("/login")) {
        return textResponse("<html><body><form>AAIS login account password</form></body></html>");
      }
      if (url.endsWith("/api/system/readiness")) {
        return jsonResponse({ status: "ready" });
      }
      if (url.endsWith("/api/auth/app-session")) {
        expect(JSON.parse(init.body)).toMatchObject({
          consentAccepted: true,
        });
        return jsonResponse(
          { redirectTarget: "/learning" },
          {
            headers: {
              getSetCookie: () => [
                "aais_session=signed-session-value; Path=/; HttpOnly; SameSite=Lax",
                "aais_csrf=csrf-value; Path=/; SameSite=Lax",
              ],
            },
          },
        );
      }
      if (url.endsWith("/api/learning/session") && init.method === "GET") {
        expect(init.headers.cookie).toContain("aais_session=signed-session-value");
        return jsonResponse({ session: { activeTaskId: "practice-1" } });
      }
      if (url.endsWith("/api/learning/session") && init.method === "PATCH") {
        expect(init.headers.cookie).toContain("aais_session=signed-session-value");
        expect(init.headers["x-aais-csrf"]).toBe("csrf-value");
        expect(JSON.parse(init.body)).toMatchObject({
          action: "save-artifact",
          taskId: "practice-1",
        });
        return jsonResponse({ session: { activeTaskId: "practice-1" } });
      }
      throw new Error(`Unexpected URL ${url}`);
    };

    const report = await runAaisProductionSmoke({
      baseUrl: "https://staging.example",
      account: "smoke-account",
      password: "secret-password",
      fetchImpl,
    });

    expect(report.status).toBe("passed");
    expect(report.checks.map((check) => check.name)).toEqual([
      "login-page",
      "public-readiness",
      "trial-login",
      "learning-write",
    ]);
    expect(calls).toHaveLength(5);
    expect(JSON.stringify(report)).not.toContain("secret-password");
    expect(JSON.stringify(report)).not.toContain("signed-session-value");
    expect(JSON.stringify(report)).not.toContain("csrf-value");
    expect(JSON.stringify(report)).not.toContain("<form>");
  });

  it("optionally proves a known demo credential is rejected without setting a session cookie", async () => {
    const fetchImpl = async (url, init = {}) => {
      if (url.endsWith("/login")) {
        return textResponse("<html><body><form>AAIS login account password</form></body></html>");
      }
      if (url.endsWith("/api/system/readiness")) {
        return jsonResponse({ status: "ready" });
      }
      if (url.endsWith("/api/auth/app-session") && String(init.body).includes("blocked-demo")) {
        expect(JSON.parse(init.body)).toMatchObject({
          consentAccepted: true,
        });
        return jsonResponse(
          {
            error: {
              code: "AAIS_INVALID_CREDENTIALS",
              message: "Invalid AAIS trial account or password.",
            },
          },
          {
            status: 401,
            headers: {
              getSetCookie: () => [],
            },
          },
        );
      }
      if (url.endsWith("/api/auth/app-session")) {
        expect(JSON.parse(init.body)).toMatchObject({
          consentAccepted: true,
        });
        return jsonResponse(
          { redirectTarget: "/learning" },
          {
            headers: {
              getSetCookie: () => [
                "aais_session=signed-session-value; Path=/; HttpOnly; SameSite=Lax",
                "aais_csrf=csrf-value; Path=/; SameSite=Lax",
              ],
            },
          },
        );
      }
      if (url.endsWith("/api/learning/session") && init.method === "GET") {
        return jsonResponse({ session: { activeTaskId: "practice-1" } });
      }
      if (url.endsWith("/api/learning/session") && init.method === "PATCH") {
        return jsonResponse({ session: { activeTaskId: "practice-1" } });
      }
      throw new Error(`Unexpected URL ${url}`);
    };

    const report = await runAaisProductionSmoke({
      baseUrl: "https://staging.example",
      account: "smoke-account",
      password: "secret-password",
      blockedAccount: "blocked-demo",
      blockedPassword: "known-demo-password",
      fetchImpl,
    });

    expect(report.status).toBe("passed");
    expect(report.checks.map((check) => check.name)).toEqual([
      "login-page",
      "public-readiness",
      "blocked-trial-login",
      "trial-login",
      "learning-write",
    ]);
    expect(report.checks.find((check) => check.name === "blocked-trial-login")).toMatchObject({
      status: "passed",
      httpStatus: 401,
      details: {
        loginRejected: true,
        sessionCookie: "absent",
        errorCode: "AAIS_INVALID_CREDENTIALS",
      },
    });
    const serialized = JSON.stringify(report);
    expect(serialized).not.toContain("known-demo-password");
    expect(serialized).not.toContain("blocked-demo");
    expect(serialized).not.toContain("signed-session-value");
  });

  it("requires smoke credentials by variable name", async () => {
    await expect(runAaisProductionSmoke({
      baseUrl: "https://staging.example",
      account: "",
      password: "secret-password",
      fetchImpl: async () => jsonResponse({ status: "ready" }),
    })).rejects.toThrow("AAIS_SMOKE_TRIAL_ACCOUNT");
  });
});

function jsonResponse(body, init = {}) {
  return {
    status: init.status ?? 200,
    headers: init.headers ?? {
      get: () => null,
    },
    json: async () => body,
  };
}

function textResponse(body, init = {}) {
  return {
    status: init.status ?? 200,
    headers: init.headers ?? {
      get: () => null,
    },
    text: async () => body,
  };
}
