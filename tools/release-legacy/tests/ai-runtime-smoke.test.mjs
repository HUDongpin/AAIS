import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { runAaisAiRuntimeSmoke } from "../scripts/run-ai-runtime-smoke.mjs";

let tempDir;

beforeEach(async () => {
  tempDir = await mkdtemp(path.join(tmpdir(), "aais-ai-runtime-smoke-"));
});

afterEach(async () => {
  vi.unstubAllEnvs();
  await rm(tempDir, { force: true, recursive: true });
});

describe("AAIS AI runtime smoke runner", () => {
  it("posts a redacted A2 smoke request with supplied session cookies", async () => {
    const outputPath = path.join(tempDir, "runtime-smoke.json");
    const fetchMock = vi.fn(async (url, init) => {
      expect(url).toBe("https://aais.example.test/api/learning/ai-guide");
      expect(init.headers.cookie).toContain("aais_session=session-secret-cookie");
      expect(init.headers.cookie).toContain("aais_csrf=csrf-secret-cookie");
      expect(init.headers["x-aais-csrf"]).toBe("csrf-secret-cookie");
      const payload = JSON.parse(String(init.body));
      expect(payload).toMatchObject({
        locale: "zh-CN",
        learnerInput: "Provider prompt should stay out of reports.",
        targetAgentIds: ["A2"],
        workspaceState: {
          currentStep: "runtime-ai-smoke",
        },
      });
      return Response.json(createAiGuideResponse({
        mode: "live",
        reply: "Provider answer should never be written to the smoke report.",
        fallback: false,
      }));
    });

    const report = await runAaisAiRuntimeSmoke({
      baseUrl: "https://aais.example.test/",
      cookie: "aais_session=session-secret-cookie; aais_csrf=csrf-secret-cookie",
      csrfToken: "csrf-secret-cookie",
      learnerInput: "Provider prompt should stay out of reports.",
      outputPath,
      fetchImpl: fetchMock,
      now: new Date("2026-07-07T10:00:00.000Z"),
    });

    expect(report).toMatchObject({
      schemaVersion: 1,
      status: "passed",
      checkedAt: "2026-07-07T10:00:00.000Z",
      target: {
        path: "/api/learning/ai-guide",
        targetAgentIds: ["A2"],
      },
      http: {
        status: 200,
        ok: true,
      },
      auth: {
        mode: "provided-cookie",
        sessionCookie: "present",
        csrfCookie: "present",
        values: "omitted",
      },
      response: {
        visibleAgents: ["A2"],
        visibleTurnCount: 1,
        rawMessage: "omitted",
        rawTurns: "omitted",
      },
      runtime: {
        fallback: false,
        timeoutReason: null,
        ai: {
          mode: "live",
          primary: {
            providerRole: "primary",
            provider: "qwen",
            modelFingerprint: "abcdef1234567890",
            thinkingMode: "disabled",
            timeoutMs: {
              configured: 30000,
              effective: 30000,
              max: 30000,
            },
            maxRetries: 0,
            maxTokens: 180,
          },
          redaction: {
            secrets: "omitted",
            endpoints: "omitted",
            modelIds: "fingerprint-only",
          },
        },
      },
      redaction: {
        cookies: "omitted",
        csrf: "omitted",
        rawModelReply: "omitted",
        rawPrompt: "omitted",
        secrets: "omitted",
      },
    });
    expect(await readFile(outputPath, "utf8")).toContain("\"status\": \"passed\"");
    const serialized = JSON.stringify(report);
    expect(serialized).not.toContain("session-secret-cookie");
    expect(serialized).not.toContain("csrf-secret-cookie");
    expect(serialized).not.toContain("Provider prompt");
    expect(serialized).not.toContain("Provider answer");
  });

  it("can obtain a trial session without leaking account, password, or cookies", async () => {
    const fetchMock = vi.fn(async (url, init) => {
      if (url === "https://aais.example.test/api/auth/app-session") {
        const loginPayload = JSON.parse(String(init.body));
        expect(loginPayload).toMatchObject({
          account: "trial-learner",
          password: "trial-password-secret",
        });
        return new Response(JSON.stringify({ ok: true }), {
          status: 200,
          headers: {
            "set-cookie": [
              "aais_session=session-secret-cookie; Path=/; HttpOnly; Secure; SameSite=lax",
              "aais_csrf=csrf-secret-cookie; Path=/; Secure; SameSite=lax",
            ].join(", "),
            "content-type": "application/json",
          },
        });
      }
      expect(url).toBe("https://aais.example.test/api/learning/ai-guide");
      expect(init.headers.cookie).toContain("aais_session=session-secret-cookie");
      expect(init.headers.cookie).toContain("aais_csrf=csrf-secret-cookie");
      expect(init.headers["x-aais-csrf"]).toBe("csrf-secret-cookie");
      return Response.json(createAiGuideResponse({
        mode: "deterministic",
        reply: "Local fallback answer should not be serialized.",
        fallback: true,
        timeoutReason: "abort-timeout",
      }));
    });

    const report = await runAaisAiRuntimeSmoke({
      baseUrl: "https://aais.example.test",
      trialAccount: "trial-learner",
      trialPassword: "trial-password-secret",
      fetchImpl: fetchMock,
      now: new Date("2026-07-07T10:30:00.000Z"),
    });

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(report).toMatchObject({
      status: "passed",
      auth: {
        mode: "trial-login",
        loginStatus: 200,
        sessionCookie: "present",
        csrfCookie: "present",
        values: "omitted",
      },
      runtime: {
        fallback: true,
        timeoutReason: "abort-timeout",
        ai: {
          mode: "deterministic",
          primary: null,
          fallback: null,
        },
      },
    });
    const serialized = JSON.stringify(report);
    expect(serialized).not.toContain("trial-learner");
    expect(serialized).not.toContain("trial-password-secret");
    expect(serialized).not.toContain("session-secret-cookie");
    expect(serialized).not.toContain("csrf-secret-cookie");
    expect(serialized).not.toContain("Local fallback answer");
  });
});

function createAiGuideResponse({ mode, reply, fallback, timeoutReason = null }) {
  return {
    message: {
      text: `AAIS agents replied: ${reply}`,
    },
    turns: [
      {
        agentId: "A2",
        label: "Expert Agent",
        content: reply,
        actions: ["model", "coach"],
      },
    ],
    backgroundTurns: [],
    orchestration: {
      runtime: {
        timings: {
          fallback,
          timeoutReason,
        },
        ai: mode === "live"
          ? {
            mode: "live",
            primary: {
              providerRole: "primary",
              provider: "qwen",
              modelFingerprint: "abcdef1234567890",
              thinkingMode: "disabled",
              thinkingModeSource: "AAIS_AI_THINKING_MODE",
              timeoutMs: {
                configured: 30000,
                effective: 30000,
                default: 12000,
                min: 3000,
                max: 30000,
                clamped: false,
                source: "AAIS_AI_TIMEOUT_MS",
              },
              maxRetries: 0,
              maxTokens: 180,
            },
            fallback: null,
            redaction: {
              secrets: "omitted",
              endpoints: "omitted",
              modelIds: "fingerprint-only",
            },
          }
          : {
            mode: "deterministic",
            primary: null,
            fallback: null,
            redaction: {
              secrets: "omitted",
              endpoints: "omitted",
              modelIds: "fingerprint-only",
            },
          },
      },
    },
  };
}
