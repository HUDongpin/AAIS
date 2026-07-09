import { describe, expect, it } from "vitest";
import { runAaisStagingLoadSanity } from "../scripts/run-staging-load-sanity.mjs";

describe("AAIS staging load sanity runner", () => {
  it("runs concurrent learner login/read/write flows with redacted aggregate output", async () => {
    const calls = [];
    let clock = 0;
    const fetchImpl = async (url, init = {}) => {
      calls.push({ url, init });
      if (url.endsWith("/api/auth/app-session")) {
        const body = JSON.parse(init.body);
        expect(body).toMatchObject({
          consentAccepted: true,
          from: "/learning",
        });
        return jsonResponse(
          { redirectTarget: "/learning" },
          {
            headers: {
              getSetCookie: () => [
                `aais_session=session-${body.account}; Path=/; HttpOnly; SameSite=Lax`,
                `aais_csrf=csrf-${body.account}; Path=/; SameSite=Lax`,
              ],
            },
          },
        );
      }
      if (url.endsWith("/api/learning/session") && init.method === "GET") {
        expect(init.headers.cookie).toContain("aais_session=session-");
        return jsonResponse({ session: { activeTaskId: "practice_task_1" } });
      }
      if (url.endsWith("/api/learning/session") && init.method === "PATCH") {
        expect(init.headers.cookie).toContain("aais_session=session-");
        expect(init.headers["x-aais-csrf"]).toContain("csrf-");
        const body = JSON.parse(init.body);
        expect(body).toMatchObject({
          action: "save-artifact",
          taskId: "practice_task_1",
        });
        expect(body.artifactText).toContain("synthetic note");
        return jsonResponse({ session: { activeTaskId: "practice_task_1" } });
      }
      throw new Error(`Unexpected URL ${url}`);
    };

    const report = await runAaisStagingLoadSanity({
      approved: true,
      baseUrl: "https://aais-preview.example",
      targetUsers: 3,
      concurrency: 2,
      maxP95Ms: 1000,
      now: new Date("2026-07-09T01:00:00.000Z"),
      nowMs: () => {
        clock += 10;
        return clock;
      },
      credentials: [
        { account: "student-1", password: "secret-1" },
        { account: "student-2", password: "secret-2" },
        { account: "student-3", password: "secret-3" },
      ],
      fetchImpl,
    });

    expect(report.status).toBe("passed");
    expect(report.target).toMatchObject({
      purpose: "staging-or-preview-only",
      targetUsers: 3,
      concurrency: 2,
      credentialCount: 3,
    });
    expect(report.results).toMatchObject({
      attempted: 3,
      passed: 3,
      failed: 0,
      failureSummary: {},
    });
    expect(calls).toHaveLength(9);
    const serialized = JSON.stringify(report);
    expect(serialized).not.toContain("student-1");
    expect(serialized).not.toContain("secret-1");
    expect(serialized).not.toContain("session-student");
    expect(serialized).not.toContain("csrf-student");
    expect(serialized).not.toContain("synthetic note");
  });

  it("requires explicit approval before writing synthetic learner updates", async () => {
    await expect(runAaisStagingLoadSanity({
      approved: false,
      baseUrl: "https://aais-preview.example",
      credentials: [{ account: "student-1", password: "secret-1" }],
      fetchImpl: async () => jsonResponse({}),
    })).rejects.toThrow("--approved");
  });

  it("refuses known production hosts", async () => {
    await expect(runAaisStagingLoadSanity({
      approved: true,
      baseUrl: "https://www.aais.site",
      credentials: [{ account: "student-1", password: "secret-1" }],
      fetchImpl: async () => jsonResponse({}),
    })).rejects.toThrow("staging or preview");
  });

  it("refuses a known production host before opening a credential file", async () => {
    await expect(runAaisStagingLoadSanity({
      approved: true,
      baseUrl: "https://www.aais.site",
      credentialsPath: "./missing-load-users.json",
      fetchImpl: async () => jsonResponse({}),
    })).rejects.toThrow("staging or preview");
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
