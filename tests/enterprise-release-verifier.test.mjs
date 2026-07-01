import { mkdtemp, readFile, rm } from "node:fs/promises";
import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { describe, expect, it, vi } from "vitest";
import { runEnterpriseReleaseVerification } from "../scripts/verify-enterprise-release.mjs";

const execFileAsync = promisify(execFile);

describe("AAIS enterprise release verifier", () => {
  it("records redacted failed checks when an online probe throws", async () => {
    const fetchMock = vi.fn(async () => {
      throw new Error("fetch failed with bearer secret");
    });

    const report = await runEnterpriseReleaseVerification({
      baseUrl: "https://aais.example.test",
      fetchImpl: fetchMock,
      requireSsoOnly: true,
      oidcCallback: {
        callbackUrl: "<REQUIRED:TRANSIENT_OIDC_CALLBACK_URL>",
        stateCookie: "<REQUIRED:TRANSIENT_OIDC_STATE_COOKIE>",
      },
    });

    expect(report.status).toBe("failed");
    expect(report.checks.map((check) => check.name)).toEqual([
      "readiness",
      "security-headers",
      "legal-pages",
      "lrs-health",
      "cohort-analytics",
      "oidc-start",
      "oidc-callback",
      "sso-only-mode",
      "trial-learning-session",
      "trial-login-throttle",
    ]);
    expect(report.checks[0]).toMatchObject({
      name: "readiness",
      status: "failed",
      details: {
        reason: "online check failed before redacted evidence could be collected",
        error: "omitted",
      },
    });
    expect(report.checks.find((check) => check.name === "oidc-callback")).toMatchObject({
      status: "failed",
      details: {
        placeholderEvidenceSupplied: true,
      },
    });
    const serialized = JSON.stringify(report);
    expect(serialized).not.toContain("bearer secret");
    expect(serialized).not.toContain("TRANSIENT_OIDC_CALLBACK_URL");
  });

  it("classifies online connectivity failures without leaking raw error text", async () => {
    const fetchMock = vi.fn(async () => {
      const error = new Error("fetch failed with bearer secret");
      error.cause = {
        name: "ConnectTimeoutError",
        message: "Connect Timeout Error with bearer secret",
        code: "UND_ERR_CONNECT_TIMEOUT",
      };
      throw error;
    });

    const report = await runEnterpriseReleaseVerification({
      baseUrl: "https://aais.example.test",
      fetchImpl: fetchMock,
      requireSsoOnly: true,
    });

    expect(report.checks[0]).toMatchObject({
      name: "readiness",
      status: "failed",
      details: {
        reason: "online check failed before redacted evidence could be collected",
        error: "omitted",
        errorCategory: "connect-timeout",
      },
    });
    const serialized = JSON.stringify(report);
    expect(serialized).not.toContain("bearer secret");
    expect(serialized).not.toContain("Connect Timeout Error");
    expect(serialized).not.toContain("UND_ERR_CONNECT_TIMEOUT");
  });

  it("verifies readiness, OIDC start, optional learning session, and login throttling without leaking secrets", async () => {
    const fetchMock = vi.fn(async (input, init = {}) => {
      const url = String(input);
      if (isLegalPageUrl(url)) {
        return legalPageResponse(url);
      }
      if (url === "https://aais.example.test/api/system/readiness") {
        return Response.json(
          {
            status: "ready",
            runtime: "production",
            release: {
              id: "aais-2026-06-30-rc1",
              source: "AAIS_RELEASE_ID",
              deployment: {
                provider: "vercel",
                gitCommit: {
                  present: true,
                  shortSha: "0123456789ab",
                },
              },
            },
            checks: {
              session: {
                status: "ok",
              },
              trialAccounts: {
                status: "ok",
                configured: true,
                accountCount: 1,
              },
              storage: {
                status: "ok",
                mode: "postgres",
                provider: "neon",
                probe: "connected",
              },
              lrs: lrsReadyCheck(),
              oidc: {
                status: "ok",
                mode: "explicit",
                roleMapping: {
                  status: "ok",
                  configured: true,
                  present: ["AAIS_OIDC_TEACHER_GROUPS", "aais-teachers"],
                  acceptedNames: [
                    "AAIS_OIDC_TEACHER_GROUPS",
                    "AAIS_OIDC_TEACHER_EMAILS",
                    "AAIS_OIDC_ADMIN_GROUPS",
                    "AAIS_OIDC_ADMIN_EMAILS",
                  ],
                  redaction: "names-only",
                },
              },
              ai: {
                status: "ok",
                provider: "openai-compatible",
                evalVersion: "eval-2026-06-30",
                evalManifest: "verified",
                modelFingerprint: modelFingerprint("enterprise-model"),
              },
            },
            issues: [],
            secrets: "redacted",
          },
          {
            headers: createSecurityHeaders(),
          },
        );
      }
      if (url === "https://aais.example.test/api/learning/lrs/health") {
        return Response.json(lrsHealthBody());
      }
      if (url === "https://aais.example.test/api/auth/oidc/start?from=%2Flearning") {
        expect(init.redirect).toBe("manual");
        return new Response(null, {
          status: 307,
          headers: {
            location: oidcAuthorizationLocation(),
            "set-cookie": "aais_oidc_state=opaque; Path=/; HttpOnly; Secure; SameSite=lax",
          },
        });
      }
      if (url === "https://aais.example.test/api/auth/app-session") {
        const body = JSON.parse(String(init.body));
        if (body.password === "correct-secret-password") {
          const wrongAttemptCount = fetchMock.mock.calls.filter(([calledUrl, calledInit = {}]) => {
            if (String(calledUrl) !== "https://aais.example.test/api/auth/app-session") {
              return false;
            }
            return JSON.parse(String(calledInit.body)).password === "wrong-password";
          }).length;
          if (wrongAttemptCount >= 6) {
            return Response.json(
              { error: "Too many login attempts. Please retry later.", retryAfterSeconds: 900 },
              { status: 429 },
            );
          }
          return Response.json(
            { appSession: { actor: { id: "Bobie" } } },
            {
              status: 200,
              headers: {
                "set-cookie": "aais_session=session-secret-cookie; Path=/; HttpOnly; Secure; SameSite=lax, aais_csrf=csrf-secret-cookie; Path=/; Secure; SameSite=lax",
              },
            },
          );
        }
        if (body.password === "wrong-password") {
          const attempt = fetchMock.mock.calls.filter(([calledUrl, calledInit = {}]) => {
            if (String(calledUrl) !== "https://aais.example.test/api/auth/app-session") {
              return false;
            }
            return JSON.parse(String(calledInit.body)).password === "wrong-password";
          }).length;
          return Response.json(
            attempt <= 5
              ? { error: "Invalid AAIS trial account or password." }
              : { error: "Too many login attempts. Please retry later.", retryAfterSeconds: 900 },
            {
              status: attempt <= 5 ? 401 : 429,
              headers: attempt <= 5 ? {} : { "retry-after": "900" },
            },
          );
        }
        return Response.json({ error: "unexpected password" }, { status: 500 });
      }
      if (url === "https://aais.example.test/api/learning/session") {
        expect(init.headers.cookie).toContain("aais_session=");
        expect(init.headers.cookie).toContain("aais_csrf=");
        return Response.json({
          session: {
            studentId: "Bobie",
            activeTaskId: "training_task_1",
          },
        });
      }
      return new Response("unexpected", { status: 500 });
    });

    const report = await runEnterpriseReleaseVerification({
      baseUrl: "https://aais.example.test",
      fetchImpl: fetchMock,
      releaseId: "aais-2026-06-30-rc1",
      trialLogin: {
        account: "Bobie",
        correctPassword: "correct-secret-password",
        wrongPassword: "wrong-password",
        clientIp: "203.0.113.9",
      },
    });

    expect(report.status).toBe("passed");
    expect(report.release).toEqual({
      id: "aais-2026-06-30-rc1",
    });
    expect(report.checks.map((check) => [check.name, check.status])).toEqual([
      ["readiness", "passed"],
      ["security-headers", "passed"],
      ["legal-pages", "passed"],
      ["lrs-health", "passed"],
      ["cohort-analytics", "skipped"],
      ["oidc-start", "passed"],
      ["oidc-callback", "skipped"],
      ["trial-learning-session", "passed"],
      ["trial-login-throttle", "passed"],
    ]);
    const serialized = JSON.stringify(report);
    expect(serialized).not.toContain("correct-secret-password");
    expect(serialized).not.toContain("wrong-password");
    expect(serialized).not.toContain("opaque");
    expect(serialized).not.toContain("session-secret-cookie");
    expect(serialized).not.toContain("csrf-secret-cookie");
    const readiness = report.checks.find((check) => check.name === "readiness");
    expect(readiness.details).toMatchObject({
      issues: [],
      aiProvider: "openai-compatible",
      aiEvalVersion: "eval-2026-06-30",
      aiEvalManifest: "verified",
      aiModelFingerprint: modelFingerprint("enterprise-model"),
      storageProvider: "neon",
      oidcMode: "explicit",
      oidcRoleMappingStatus: "ok",
      oidcRoleMappingConfigured: true,
      oidcRoleMappingPresent: ["AAIS_OIDC_TEACHER_GROUPS"],
      oidcRoleMappingRedaction: "names-only",
      lrsOutboxCoalescingEnabled: true,
      lrsOutboxCoalescingWindowSeconds: 30,
      lrsOutboxCoalescingEvents: ["artifact_saved", "artifact_edited"],
      deploymentPlatform: "vercel",
      vercelRequestIdPresent: true,
      releaseId: "aais-2026-06-30-rc1",
      expectedReleaseId: "aais-2026-06-30-rc1",
      releaseIdRequired: true,
      releaseIdMatchesExpected: true,
      releaseSource: "AAIS_RELEASE_ID",
      deploymentProvider: "vercel",
      deploymentGitCommitPresent: true,
      deploymentGitCommitShortSha: "0123456789ab",
      releaseIdentityComplete: true,
    });
    expect(serialized).not.toContain("enterprise-model");
    expect(serialized).not.toContain("aais-teachers");
    const oidcStart = report.checks.find((check) => check.name === "oidc-start");
    expect(oidcStart.details).toMatchObject({
      redirectsToHttpsProvider: true,
      responseTypeCode: true,
      hasClientId: true,
      hasRedirectUri: true,
      redirectUriMatchesCallback: true,
      hasStateParam: true,
      hasNonceParam: true,
      hasPkceChallenge: true,
      pkceMethodS256: true,
      scopeIncludesOpenid: true,
      stateCookieHttpOnly: true,
      stateCookieSecure: true,
      stateCookieSameSiteLax: true,
    });
  });

  it("fails readiness when the deployed release id does not match the expected release", async () => {
    const fetchMock = vi.fn(async (input, init = {}) => {
      const url = String(input);
      if (isLegalPageUrl(url)) {
        return legalPageResponse(url);
      }
      if (url === "https://aais.example.test/api/system/readiness") {
        return Response.json(
          {
            status: "ready",
            runtime: "production",
            release: {
              id: "aais-2026-06-29-old",
              source: "AAIS_RELEASE_ID",
              deployment: {
                provider: "vercel",
                gitCommit: {
                  present: true,
                  shortSha: "abcdef123456",
                },
              },
            },
            checks: {
              session: { status: "ok" },
              trialAccounts: { status: "disabled", configured: false, accountCount: 0 },
              storage: { status: "ok", mode: "postgres", provider: "neon", probe: "connected" },
              lrs: lrsReadyCheck(),
              oidc: oidcReadyCheck(),
              ai: {
                status: "ok",
                provider: "deterministic",
                evalVersion: null,
                evalManifest: "not-required",
              },
            },
            issues: [],
            secrets: "redacted",
          },
          {
            headers: createSecurityHeaders(),
          },
        );
      }
      if (url === "https://aais.example.test/api/learning/lrs/health") {
        return Response.json(lrsHealthBody());
      }
      if (url === "https://aais.example.test/api/auth/oidc/start?from=%2Flearning") {
        expect(init.redirect).toBe("manual");
        return new Response(null, {
          status: 307,
          headers: {
            location: oidcAuthorizationLocation(),
            "set-cookie": "aais_oidc_state=opaque; Path=/; HttpOnly; Secure; SameSite=lax",
          },
        });
      }
      return new Response("unexpected", { status: 500 });
    });

    const report = await runEnterpriseReleaseVerification({
      baseUrl: "https://aais.example.test",
      fetchImpl: fetchMock,
      releaseId: "aais-2026-06-30-rc1",
    });
    const readiness = report.checks.find((check) => check.name === "readiness");

    expect(report.status).toBe("failed");
    expect(readiness).toMatchObject({
      status: "failed",
      details: {
        releaseId: "aais-2026-06-29-old",
        expectedReleaseId: "aais-2026-06-30-rc1",
        releaseIdRequired: true,
        releaseIdMatchesExpected: false,
        releaseIdentityComplete: false,
      },
    });
    expect(JSON.stringify(report)).not.toContain("opaque");
  });

  it("fails readiness when OIDC lacks role-mapping proof even if the base OIDC check is ok", async () => {
    const fetchMock = vi.fn(async (input) => {
      const url = String(input);
      if (isLegalPageUrl(url)) {
        return legalPageResponse(url);
      }
      if (url === "https://aais.example.test/api/system/readiness") {
        return Response.json(
          {
            status: "ready",
            runtime: "production",
            release: {
              id: "aais-2026-06-30-rc1",
              source: "AAIS_RELEASE_ID",
              deployment: {
                provider: "vercel",
                gitCommit: {
                  present: true,
                  shortSha: "abcdef123456",
                },
              },
            },
            checks: {
              session: { status: "ok" },
              trialAccounts: { status: "disabled", configured: false, accountCount: 0 },
              storage: { status: "ok", mode: "postgres", provider: "neon", probe: "connected" },
              lrs: lrsReadyCheck(),
              oidc: { status: "ok", mode: "explicit" },
              ai: {
                status: "ok",
                provider: "deterministic",
                evalVersion: null,
                evalManifest: "not-required",
              },
            },
            issues: [],
            secrets: "redacted",
          },
          { headers: createSecurityHeaders() },
        );
      }
      if (url === "https://aais.example.test/api/learning/lrs/health") {
        return Response.json(lrsHealthBody());
      }
      if (url === "https://aais.example.test/api/auth/oidc/start?from=%2Flearning") {
        return new Response(null, {
          status: 307,
          headers: {
            location: oidcAuthorizationLocation(),
            "set-cookie": "aais_oidc_state=opaque-start; Path=/; HttpOnly; Secure; SameSite=lax",
          },
        });
      }
      return new Response("unexpected", { status: 500 });
    });

    const report = await runEnterpriseReleaseVerification({
      baseUrl: "https://aais.example.test",
      fetchImpl: fetchMock,
    });

    const readiness = report.checks.find((check) => check.name === "readiness");
    expect(report.status).toBe("failed");
    expect(readiness).toMatchObject({
      status: "failed",
      details: {
        oidcOk: false,
        oidcMode: "explicit",
        oidcRoleMappingStatus: "unknown",
        oidcRoleMappingConfigured: false,
        oidcRoleMappingPresent: [],
        oidcRoleMappingRedaction: "unknown",
      },
    });
  });

  it("fails readiness when the LRS outbox is not persistent Postgres even if LRS is configured", async () => {
    const fetchMock = vi.fn(async (input) => {
      const url = String(input);
      if (isLegalPageUrl(url)) {
        return legalPageResponse(url);
      }
      if (url === "https://aais.example.test/api/system/readiness") {
        return Response.json(
          {
            status: "ready",
            runtime: "production",
            release: {
              id: "aais-2026-06-30-rc1",
              source: "AAIS_RELEASE_ID",
              deployment: {
                provider: "vercel",
                gitCommit: {
                  present: true,
                  shortSha: "abcdef123456",
                },
              },
            },
            checks: {
              session: { status: "ok" },
              trialAccounts: { status: "disabled", configured: false, accountCount: 0 },
              storage: { status: "ok", mode: "postgres", provider: "neon", probe: "connected" },
              lrs: {
                status: "ok",
                outbox: {
                  mode: "memory",
                  storage: "process",
                  metrics: {
                    pending: 0,
                    retry: 0,
                    sent: 4,
                    deadLetter: 0,
                    total: 4,
                  },
                },
              },
              oidc: oidcReadyCheck(),
              ai: {
                status: "ok",
                provider: "deterministic",
                evalVersion: null,
                evalManifest: "not-required",
              },
            },
            issues: [],
            secrets: "redacted",
          },
          { headers: createSecurityHeaders() },
        );
      }
      if (url === "https://aais.example.test/api/learning/lrs/health") {
        return Response.json(lrsHealthBody());
      }
      if (url === "https://aais.example.test/api/auth/oidc/start?from=%2Flearning") {
        return new Response(null, {
          status: 307,
          headers: {
            location: oidcAuthorizationLocation(),
            "set-cookie": "aais_oidc_state=opaque-start; Path=/; HttpOnly; Secure; SameSite=lax",
          },
        });
      }
      return new Response("unexpected", { status: 500 });
    });

    const report = await runEnterpriseReleaseVerification({
      baseUrl: "https://aais.example.test",
      fetchImpl: fetchMock,
    });

    const readiness = report.checks.find((check) => check.name === "readiness");
    expect(report.status).toBe("failed");
    expect(readiness).toMatchObject({
      status: "failed",
      details: {
        lrsOk: false,
        lrsOutboxMode: "memory",
        lrsOutboxStorage: "process",
        lrsOutboxMetricsPresent: true,
      },
    });
  });

  it("fails LRS health when the health endpoint does not prove a persistent Postgres outbox", async () => {
    const fetchMock = vi.fn(async (input) => {
      const url = String(input);
      if (isLegalPageUrl(url)) {
        return legalPageResponse(url);
      }
      if (url === "https://aais.example.test/api/system/readiness") {
        return Response.json(
          {
            status: "ready",
            runtime: "production",
            release: {
              id: "aais-2026-06-30-rc1",
              source: "AAIS_RELEASE_ID",
              deployment: {
                provider: "vercel",
                gitCommit: {
                  present: true,
                  shortSha: "abcdef123456",
                },
              },
            },
            checks: {
              session: { status: "ok" },
              trialAccounts: { status: "disabled", configured: false, accountCount: 0 },
              storage: { status: "ok", mode: "postgres", provider: "neon", probe: "connected" },
              lrs: lrsReadyCheck(),
              oidc: oidcReadyCheck(),
              ai: {
                status: "ok",
                provider: "deterministic",
                evalVersion: null,
                evalManifest: "not-required",
              },
            },
            issues: [],
            secrets: "redacted",
          },
          { headers: createSecurityHeaders() },
        );
      }
      if (url === "https://aais.example.test/api/learning/lrs/health") {
        return Response.json(lrsHealthBody({
          persistentOutbox: {
            mode: "memory",
            storage: "process",
            pending: 0,
            retry: 0,
            sent: 4,
            deadLetter: 0,
            total: 4,
            secrets: "redacted",
          },
        }));
      }
      if (url === "https://aais.example.test/api/auth/oidc/start?from=%2Flearning") {
        return new Response(null, {
          status: 307,
          headers: {
            location: oidcAuthorizationLocation(),
            "set-cookie": "aais_oidc_state=opaque-start; Path=/; HttpOnly; Secure; SameSite=lax",
          },
        });
      }
      return new Response("unexpected", { status: 500 });
    });

    const report = await runEnterpriseReleaseVerification({
      baseUrl: "https://aais.example.test",
      fetchImpl: fetchMock,
    });

    const lrsHealth = report.checks.find((check) => check.name === "lrs-health");
    expect(report.status).toBe("failed");
    expect(lrsHealth).toMatchObject({
      status: "failed",
      details: {
        configured: true,
        lrsOutboxMode: "memory",
        lrsOutboxStorage: "process",
        lrsOutboxMetricsPresent: true,
      },
    });
  });

  it("fails readiness when the LRS outbox lacks artifact coalescing policy", async () => {
    const fetchMock = vi.fn(async (input) => {
      const url = String(input);
      if (isLegalPageUrl(url)) {
        return legalPageResponse(url);
      }
      if (url === "https://aais.example.test/api/system/readiness") {
        const lrs = lrsReadyCheck();
        delete lrs.outbox.coalescing;
        return Response.json(
          {
            status: "ready",
            runtime: "production",
            checks: {
              session: { status: "ok" },
              trialAccounts: { status: "disabled", configured: false, accountCount: 0 },
              storage: { status: "ok", mode: "postgres", provider: "neon", probe: "connected" },
              lrs,
              oidc: oidcReadyCheck(),
              ai: {
                status: "ok",
                provider: "deterministic",
                evalVersion: null,
                evalManifest: "not-required",
              },
            },
            issues: [],
            secrets: "redacted",
          },
          { headers: createSecurityHeaders() },
        );
      }
      if (url === "https://aais.example.test/api/learning/lrs/health") {
        return Response.json(lrsHealthBody());
      }
      if (url === "https://aais.example.test/api/auth/oidc/start?from=%2Flearning") {
        return new Response(null, {
          status: 307,
          headers: {
            location: oidcAuthorizationLocation(),
            "set-cookie": "aais_oidc_state=opaque-start; Path=/; HttpOnly; Secure; SameSite=lax",
          },
        });
      }
      return new Response("unexpected", { status: 500 });
    });

    const report = await runEnterpriseReleaseVerification({
      baseUrl: "https://aais.example.test",
      fetchImpl: fetchMock,
    });

    const readiness = report.checks.find((check) => check.name === "readiness");
    expect(report.status).toBe("failed");
    expect(readiness).toMatchObject({
      status: "failed",
      details: {
        lrsOk: false,
        lrsOutboxCoalescingEnabled: false,
        lrsOutboxCoalescingWindowSeconds: null,
        lrsOutboxCoalescingEvents: [],
      },
    });
  });

  it("fails LRS health when the persistent outbox lacks artifact coalescing policy", async () => {
    const fetchMock = vi.fn(async (input) => {
      const url = String(input);
      if (isLegalPageUrl(url)) {
        return legalPageResponse(url);
      }
      if (url === "https://aais.example.test/api/system/readiness") {
        return Response.json(
          {
            status: "ready",
            runtime: "production",
            checks: {
              session: { status: "ok" },
              trialAccounts: { status: "disabled", configured: false, accountCount: 0 },
              storage: { status: "ok", mode: "postgres", provider: "neon", probe: "connected" },
              lrs: lrsReadyCheck(),
              oidc: oidcReadyCheck(),
              ai: {
                status: "ok",
                provider: "deterministic",
                evalVersion: null,
                evalManifest: "not-required",
              },
            },
            issues: [],
            secrets: "redacted",
          },
          { headers: createSecurityHeaders() },
        );
      }
      if (url === "https://aais.example.test/api/learning/lrs/health") {
        const body = lrsHealthBody();
        delete body.delivery.persistentOutbox.coalescing;
        return Response.json(body);
      }
      if (url === "https://aais.example.test/api/auth/oidc/start?from=%2Flearning") {
        return new Response(null, {
          status: 307,
          headers: {
            location: oidcAuthorizationLocation(),
            "set-cookie": "aais_oidc_state=opaque-start; Path=/; HttpOnly; Secure; SameSite=lax",
          },
        });
      }
      return new Response("unexpected", { status: 500 });
    });

    const report = await runEnterpriseReleaseVerification({
      baseUrl: "https://aais.example.test",
      fetchImpl: fetchMock,
    });

    const lrsHealth = report.checks.find((check) => check.name === "lrs-health");
    expect(report.status).toBe("failed");
    expect(lrsHealth).toMatchObject({
      status: "failed",
      details: {
        lrsOutboxMode: "persistent",
        lrsOutboxStorage: "postgres",
        lrsOutboxMetricsPresent: true,
        lrsOutboxCoalescingEnabled: false,
        lrsOutboxCoalescingWindowSeconds: null,
        lrsOutboxCoalescingEvents: [],
      },
    });
  });

  it("verifies teacher cohort analytics slices without leaking educator credentials or learner text", async () => {
    const fetchMock = vi.fn(async (input, init = {}) => {
      const url = String(input);
      if (isLegalPageUrl(url)) {
        return legalPageResponse(url);
      }
      if (url === "https://aais.example.test/api/system/readiness") {
        return Response.json(
          {
            status: "ready",
            runtime: "production",
            checks: {
              session: { status: "ok" },
              trialAccounts: { status: "ok", configured: true, accountCount: 2 },
              storage: { status: "ok", mode: "postgres", provider: "neon", probe: "connected" },
              lrs: lrsReadyCheck(),
              oidc: oidcReadyCheck(),
              ai: {
                status: "ok",
                provider: "deterministic",
                evalVersion: null,
                evalManifest: "not-required",
              },
            },
            issues: [],
            secrets: "redacted",
          },
          { headers: createSecurityHeaders() },
        );
      }
      if (url === "https://aais.example.test/api/learning/lrs/health") {
        return Response.json(lrsHealthBody());
      }
      if (url === "https://aais.example.test/api/auth/oidc/start?from=%2Flearning") {
        return new Response(null, {
          status: 307,
          headers: {
            location: oidcAuthorizationLocation(),
            "set-cookie": "aais_oidc_state=opaque-start; Path=/; HttpOnly; Secure; SameSite=lax",
          },
        });
      }
      if (url === "https://aais.example.test/api/auth/app-session") {
        const body = JSON.parse(String(init.body));
        expect(body).toEqual({
          account: "teacher-a",
          password: "teacher-secret-that-must-not-leak",
        });
        return Response.json(
          {
            appSession: {
              actor: {
                id: "teacher-a",
                role: "teacher",
              },
            },
          },
          {
            status: 200,
            headers: {
              "set-cookie": "aais_session=educator-session-cookie; Path=/; HttpOnly; Secure; SameSite=lax, aais_csrf=educator-csrf-cookie; Path=/; Secure; SameSite=lax",
            },
          },
        );
      }
      if (url === "https://aais.example.test/api/learning/analytics?scope=cohort&phase=practice&agent=A2&event=coaching_push") {
        expect(init.method).toBe("GET");
        expect(init.headers.cookie).toContain("aais_session=");
        expect(init.headers.cookie).toContain("aais_csrf=");
        return Response.json({
          analytics: {
            filters: {
              applied: {
                phase: "practice",
                agent: "A2",
                event: "coaching_push",
              },
            },
            dashboard: {
              cohort: {
                learnerCount: 1,
                trainingCompleted: 1,
                completedPracticeTasks: 0,
                scaffoldRequests: 0,
                coachingSignals: 1,
                aiInteractions: 0,
                aiAcceptanceDecisions: 0,
                riskBreakdown: {
                  high: 1,
                  medium: 0,
                  low: 0,
                },
              },
            },
            learners: [
              {
                learnerKey: "learner-123456789abc",
                sessionId: "session-redacted",
                updatedAt: "2026-07-01T00:00:00.000Z",
                trainingCompleted: true,
                activePracticeTaskId: "practice_task_1",
                completedPracticeTasks: 0,
                scaffoldRequests: 0,
                coachingSignals: 1,
                aiInteractions: 0,
                aiAcceptanceDecisions: 0,
                reflectionStatus: "needs_reflection_evidence",
                riskLevel: "high",
                priorityReasons: [
                  "reflection_missing",
                  "a2_coaching_signals",
                  "no_ai_interaction_after_coaching",
                ],
              },
            ],
            integrations: {
              factLayer: "lrs",
              joinKeys: ["session_id", "phase", "task", "agent", "event", "cohort", "role", "course_id"],
            },
            privacy: {
              actorMode: "pseudonymous",
              rawPromptStorage: "excluded_from_lrs",
              minimumNecessaryFields: true,
            },
          },
          secrets: "redacted",
        });
      }
      if (url === "https://aais.example.test/api/learning/export?scope=cohort&format=json&phase=practice&agent=A2&event=coaching_push") {
        expect(init.method).toBe("GET");
        expect(init.headers.cookie).toContain("aais_session=");
        expect(init.headers.cookie).toContain("aais_csrf=");
        return cohortExportJsonResponse();
      }
      return new Response("unexpected", { status: 500 });
    });

    const report = await runEnterpriseReleaseVerification({
      baseUrl: "https://aais.example.test",
      fetchImpl: fetchMock,
      requireCohortAnalytics: true,
      educatorLogin: {
        account: "teacher-a",
        correctPassword: "teacher-secret-that-must-not-leak",
      },
    });

    const cohort = report.checks.find((check) => check.name === "cohort-analytics");
    expect(report.status).toBe("passed");
    expect(cohort).toMatchObject({
      status: "passed",
      httpStatus: 200,
      details: {
        loginStatus: 200,
        educatorRoleAccepted: true,
        filtersApplied: true,
        learnerRows: 1,
        learnerKeysPseudonymous: true,
        aggregateCountsPresent: true,
        riskBreakdownPresent: true,
        learnerRiskLevelsPresent: true,
        priorityReasonsStable: true,
        aiAcceptanceDecisionsPresent: true,
        factLayerLrs: true,
        privacyPseudonymous: true,
        noRawLearnerText: true,
        exportStatus: 200,
        exportDispositionPresent: true,
        exportScopeCohort: true,
        exportFiltersApplied: true,
        exportLearnerRowsMatch: true,
        exportLearnerKeysPseudonymous: true,
        exportPrivacyPseudonymous: true,
        exportNoRawLearnerText: true,
        exportSecrets: "redacted",
        secrets: "redacted",
      },
    });
    const serialized = JSON.stringify(report);
    expect(serialized).not.toContain("teacher-secret-that-must-not-leak");
    expect(serialized).not.toContain("educator-session-cookie");
    expect(serialized).not.toContain("educator-csrf-cookie");
    expect(serialized).not.toContain("teacher-a");
    expect(serialized).not.toContain("learner-123456789abc");
  });

  it("fails cohort analytics when AI acceptance decision counts are missing", async () => {
    const fetchMock = vi.fn(async (input) => {
      const url = String(input);
      if (isLegalPageUrl(url)) {
        return legalPageResponse(url);
      }
      if (url === "https://aais.example.test/api/system/readiness") {
        return Response.json(
          {
            status: "ready",
            runtime: "production",
            checks: {
              session: { status: "ok" },
              trialAccounts: { status: "ok", configured: true, accountCount: 2 },
              storage: { status: "ok", mode: "postgres", provider: "neon", probe: "connected" },
              lrs: lrsReadyCheck(),
              oidc: oidcReadyCheck(),
              ai: {
                status: "ok",
                provider: "deterministic",
                evalVersion: null,
                evalManifest: "not-required",
              },
            },
            issues: [],
            secrets: "redacted",
          },
          { headers: createSecurityHeaders() },
        );
      }
      if (url === "https://aais.example.test/api/learning/lrs/health") {
        return Response.json(lrsHealthBody());
      }
      if (url === "https://aais.example.test/api/auth/oidc/start?from=%2Flearning") {
        return new Response(null, {
          status: 307,
          headers: {
            location: oidcAuthorizationLocation(),
            "set-cookie": "aais_oidc_state=opaque-start; Path=/; HttpOnly; Secure; SameSite=lax",
          },
        });
      }
      if (url === "https://aais.example.test/api/auth/app-session") {
        return Response.json(
          {
            appSession: {
              actor: {
                id: "teacher-a",
                role: "teacher",
              },
            },
          },
          {
            status: 200,
            headers: {
              "set-cookie": "aais_session=educator-session-cookie; Path=/; HttpOnly; Secure; SameSite=lax, aais_csrf=educator-csrf-cookie; Path=/; Secure; SameSite=lax",
            },
          },
        );
      }
      if (url === "https://aais.example.test/api/learning/analytics?scope=cohort&phase=practice&agent=A2&event=coaching_push") {
        return Response.json({
          analytics: {
            filters: {
              applied: {
                phase: "practice",
                agent: "A2",
                event: "coaching_push",
              },
            },
            dashboard: {
              cohort: {
                learnerCount: 1,
                trainingCompleted: 1,
                completedPracticeTasks: 0,
                scaffoldRequests: 0,
                coachingSignals: 1,
                aiInteractions: 1,
                riskBreakdown: {
                  high: 1,
                  medium: 0,
                  low: 0,
                },
              },
            },
            learners: [
              {
                learnerKey: "learner-abcdef123456",
                coachingSignals: 1,
                aiInteractions: 1,
                riskLevel: "high",
                priorityReasons: ["a2_coaching_signals"],
              },
            ],
            integrations: {
              factLayer: "lrs",
              joinKeys: ["session_id", "phase", "task", "agent", "event", "cohort", "role", "course_id"],
            },
            privacy: {
              actorMode: "pseudonymous",
              rawPromptStorage: "excluded_from_lrs",
              minimumNecessaryFields: true,
            },
          },
          secrets: "redacted",
        });
      }
      if (url === "https://aais.example.test/api/learning/export?scope=cohort&format=json&phase=practice&agent=A2&event=coaching_push") {
        return cohortExportJsonResponse();
      }
      return new Response("unexpected", { status: 500 });
    });

    const report = await runEnterpriseReleaseVerification({
      baseUrl: "https://aais.example.test",
      fetchImpl: fetchMock,
      requireCohortAnalytics: true,
      educatorLogin: {
        account: "teacher-a",
        correctPassword: "teacher-secret-that-must-not-leak",
      },
    });

    const cohort = report.checks.find((check) => check.name === "cohort-analytics");
    expect(report.status).toBe("failed");
    expect(cohort).toMatchObject({
      status: "failed",
      details: {
        aiAcceptanceDecisionsPresent: false,
      },
    });
  });

  it("fails OIDC start when the provider redirect is not a complete authorization-code request", async () => {
    const fetchMock = vi.fn(async (input) => {
      const url = String(input);
      if (isLegalPageUrl(url)) {
        return legalPageResponse(url);
      }
      if (url === "https://aais.example.test/api/system/readiness") {
        return Response.json(
          {
            status: "ready",
            runtime: "production",
            checks: {
              session: { status: "ok" },
              trialAccounts: { status: "disabled", configured: false, accountCount: 0 },
              storage: { status: "ok", mode: "postgres", probe: "connected" },
              lrs: lrsReadyCheck(),
              oidc: oidcReadyCheck(),
              ai: {
                status: "ok",
                provider: "deterministic",
                evalVersion: null,
                evalManifest: "not-required",
              },
            },
            issues: [],
            secrets: "redacted",
          },
          { headers: createSecurityHeaders() },
        );
      }
      if (url === "https://aais.example.test/api/learning/lrs/health") {
        return Response.json(lrsHealthBody());
      }
      if (url === "https://aais.example.test/api/auth/oidc/start?from=%2Flearning") {
        return new Response(null, {
          status: 307,
          headers: {
            location: "https://idp.example.test/oauth2/authorize?state=abc",
            "set-cookie": "aais_oidc_state=opaque; Path=/; HttpOnly; Secure; SameSite=lax",
          },
        });
      }
      return new Response("unexpected", { status: 500 });
    });

    const report = await runEnterpriseReleaseVerification({
      baseUrl: "https://aais.example.test",
      fetchImpl: fetchMock,
    });

    const oidcStart = report.checks.find((check) => check.name === "oidc-start");
    expect(report.status).toBe("failed");
    expect(oidcStart).toMatchObject({
      status: "failed",
      details: {
        redirectsToHttpsProvider: true,
        responseTypeCode: false,
        hasClientId: false,
        hasRedirectUri: false,
        hasStateParam: true,
        hasNonceParam: false,
        hasPkceChallenge: false,
        pkceMethodS256: false,
        scopeIncludesOpenid: false,
      },
    });
    expect(JSON.stringify(report)).not.toContain("opaque");
  });

  it("fails OIDC start when the provider redirect_uri does not match the verified AAIS callback", async () => {
    const fetchMock = vi.fn(async (input) => {
      const url = String(input);
      if (isLegalPageUrl(url)) {
        return legalPageResponse(url);
      }
      if (url === "https://aais.example.test/api/system/readiness") {
        return Response.json(
          {
            status: "ready",
            runtime: "production",
            checks: {
              session: { status: "ok" },
              trialAccounts: { status: "disabled", configured: false, accountCount: 0 },
              storage: { status: "ok", mode: "postgres", probe: "connected" },
              lrs: lrsReadyCheck(),
              oidc: oidcReadyCheck(),
              ai: {
                status: "ok",
                provider: "deterministic",
                evalVersion: null,
                evalManifest: "not-required",
              },
            },
            issues: [],
            secrets: "redacted",
          },
          { headers: createSecurityHeaders() },
        );
      }
      if (url === "https://aais.example.test/api/learning/lrs/health") {
        return Response.json(lrsHealthBody());
      }
      if (url === "https://aais.example.test/api/auth/oidc/start?from=%2Flearning") {
        return new Response(null, {
          status: 307,
          headers: {
            location: oidcAuthorizationLocation({
              redirectUri: "https://wrong-aais.example.test/api/auth/oidc/callback",
            }),
            "set-cookie": "aais_oidc_state=opaque; Path=/; HttpOnly; Secure; SameSite=lax",
          },
        });
      }
      return new Response("unexpected", { status: 500 });
    });

    const report = await runEnterpriseReleaseVerification({
      baseUrl: "https://aais.example.test",
      fetchImpl: fetchMock,
    });

    const oidcStart = report.checks.find((check) => check.name === "oidc-start");
    expect(report.status).toBe("failed");
    expect(oidcStart).toMatchObject({
      status: "failed",
      details: {
        hasRedirectUri: true,
        redirectUriMatchesCallback: false,
      },
    });
  });

  it("fails when readiness is not green and skips optional login throttle when no credentials are supplied", async () => {
    const fetchMock = vi.fn(async (input) => {
      const url = String(input);
      if (isLegalPageUrl(url)) {
        return legalPageResponse(url);
      }
      if (url === "https://aais.example.test/api/system/readiness") {
        return Response.json(
          {
            status: "not_ready",
            issues: ["AAIS_DATABASE_URL"],
            secrets: "redacted",
          },
          {
            status: 503,
            headers: createSecurityHeaders(),
          },
        );
      }
      if (url === "https://aais.example.test/api/learning/lrs/health") {
        return Response.json(
          {
            status: "error",
            configured: true,
            httpStatus: 502,
            configuration: {
              configured: true,
              requiredEnv: ["LRS_ENDPOINT", "LRS_USERNAME", "LRS_PASSWORD"],
            },
            secrets: "redacted",
          },
          { status: 502 },
        );
      }
      if (url === "https://aais.example.test/api/auth/oidc/start?from=%2Flearning") {
        return new Response(null, {
          status: 307,
          headers: {
            location: oidcAuthorizationLocation(),
            "set-cookie": "aais_oidc_state=opaque; Path=/; HttpOnly; Secure; SameSite=lax",
          },
        });
      }
      return new Response("unexpected", { status: 500 });
    });

    const report = await runEnterpriseReleaseVerification({
      baseUrl: "https://aais.example.test/",
      fetchImpl: fetchMock,
    });

    expect(report.status).toBe("failed");
    const readiness = report.checks.find((check) => check.name === "readiness");
    expect(readiness.details).toMatchObject({
      issueCount: 1,
      issues: ["AAIS_DATABASE_URL"],
    });
    expect(report.checks.map((check) => [check.name, check.status])).toEqual([
      ["readiness", "failed"],
      ["security-headers", "passed"],
      ["legal-pages", "passed"],
      ["lrs-health", "failed"],
      ["cohort-analytics", "skipped"],
      ["oidc-start", "passed"],
      ["oidc-callback", "skipped"],
      ["trial-learning-session", "skipped"],
      ["trial-login-throttle", "skipped"],
    ]);
    expect(JSON.stringify(report)).not.toContain("opaque");
  });

  it("diagnoses non-json readiness responses without storing response bodies", async () => {
    const fetchMock = vi.fn(async (input) => {
      const url = String(input);
      if (isLegalPageUrl(url)) {
        return legalPageResponse(url);
      }
      if (url === "https://aais.example.test/api/system/readiness") {
        return new Response("<html><body>platform 404 with internal deployment text</body></html>", {
          status: 404,
          headers: {
            "content-type": "text/html; charset=utf-8",
            ...createSecurityHeaders(),
          },
        });
      }
      if (url === "https://aais.example.test/api/learning/lrs/health") {
        return Response.json(lrsHealthBody(), { headers: createSecurityHeaders() });
      }
      if (url === "https://aais.example.test/api/auth/oidc/start?from=%2Flearning") {
        return new Response(null, {
          status: 307,
          headers: {
            location: oidcAuthorizationLocation(),
            "set-cookie": "aais_oidc_state=opaque; Path=/; HttpOnly; Secure; SameSite=lax",
          },
        });
      }
      return new Response("unexpected", { status: 500 });
    });

    const report = await runEnterpriseReleaseVerification({
      baseUrl: "https://aais.example.test",
      fetchImpl: fetchMock,
      releaseId: "aais-2026-06-30-rc1",
    });

    const readiness = report.checks.find((check) => check.name === "readiness");
    expect(report.status).toBe("failed");
    expect(readiness).toMatchObject({
      status: "failed",
      httpStatus: 404,
      details: {
        responseContentType: "text/html",
        responseJsonReadable: false,
        responseBodyKind: "unreadable",
        responseErrorCategory: "html-response",
        readinessStatus: "unknown",
      },
    });
    const serialized = JSON.stringify(report);
    expect(serialized).not.toContain("platform 404");
    expect(serialized).not.toContain("internal deployment text");
    expect(serialized).not.toContain("opaque");
  });

  it("fails readiness when required production subchecks are missing from the readiness payload", async () => {
    const fetchMock = vi.fn(async (input) => {
      const url = String(input);
      if (isLegalPageUrl(url)) {
        return legalPageResponse(url);
      }
      if (url === "https://aais.example.test/api/system/readiness") {
        return Response.json(
          {
            status: "ready",
            runtime: "production",
            checks: {
              ai: {
                status: "ok",
                provider: "openai-compatible",
                evalVersion: "eval-2026-06-30",
                evalManifest: "verified",
              },
            },
            issues: [],
            secrets: "redacted",
          },
          {
            headers: createSecurityHeaders(),
          },
        );
      }
      if (url === "https://aais.example.test/api/learning/lrs/health") {
        return Response.json(lrsHealthBody());
      }
      if (url === "https://aais.example.test/api/auth/oidc/start?from=%2Flearning") {
        return new Response(null, {
          status: 307,
          headers: {
            location: oidcAuthorizationLocation(),
            "set-cookie": "aais_oidc_state=opaque; Path=/; HttpOnly; Secure; SameSite=lax",
          },
        });
      }
      return new Response("unexpected", { status: 500 });
    });

    const report = await runEnterpriseReleaseVerification({
      baseUrl: "https://aais.example.test",
      fetchImpl: fetchMock,
    });

    const readiness = report.checks.find((check) => check.name === "readiness");
    expect(report.status).toBe("failed");
    expect(readiness.status).toBe("failed");
    expect(readiness.details).toMatchObject({
      sessionOk: false,
      trialAccountsOk: false,
      storagePostgresConnected: false,
      lrsOk: false,
      oidcOk: false,
      liveAiEvalOk: true,
    });
  });

  it("accepts SSO-only readiness when trial login has been disabled", async () => {
    const fetchMock = vi.fn(async (input) => {
      const url = String(input);
      if (isLegalPageUrl(url)) {
        return legalPageResponse(url);
      }
      if (url === "https://aais.example.test/api/system/readiness") {
        return Response.json(
          {
            status: "ready",
            runtime: "production",
            checks: {
              session: {
                status: "ok",
              },
              trialAccounts: {
                status: "disabled",
                configured: false,
                accountCount: 0,
              },
              storage: {
                status: "ok",
                mode: "postgres",
                probe: "connected",
              },
              lrs: lrsReadyCheck(),
              oidc: oidcReadyCheck(),
              ai: {
                status: "ok",
                provider: "deterministic",
                evalVersion: null,
                evalManifest: "not-required",
              },
            },
            issues: [],
            secrets: "redacted",
          },
          {
            headers: createSecurityHeaders(),
          },
        );
      }
      if (url === "https://aais.example.test/api/learning/lrs/health") {
        return Response.json(lrsHealthBody());
      }
      if (url === "https://aais.example.test/api/auth/oidc/start?from=%2Flearning") {
        return new Response(null, {
          status: 307,
          headers: {
            location: oidcAuthorizationLocation(),
            "set-cookie": "aais_oidc_state=opaque; Path=/; HttpOnly; Secure; SameSite=lax",
          },
        });
      }
      return new Response("unexpected", { status: 500 });
    });

    const report = await runEnterpriseReleaseVerification({
      baseUrl: "https://aais.example.test",
      fetchImpl: fetchMock,
    });

    expect(report.status).toBe("passed");
    expect(report.checks.map((check) => [check.name, check.status])).toEqual([
      ["readiness", "passed"],
      ["security-headers", "passed"],
      ["legal-pages", "passed"],
      ["lrs-health", "passed"],
      ["cohort-analytics", "skipped"],
      ["oidc-start", "passed"],
      ["oidc-callback", "skipped"],
      ["trial-learning-session", "skipped"],
      ["trial-login-throttle", "skipped"],
    ]);
  });

  it("writes a redacted enterprise report to an output file for the release evidence bundle", async () => {
    const tempDir = await mkdtemp(path.join(tmpdir(), "aais-enterprise-report-"));
    const outputPath = path.join(tempDir, "enterprise-release.json");
    const fetchMock = vi.fn(async (input) => {
      const url = String(input);
      if (isLegalPageUrl(url)) {
        return legalPageResponse(url);
      }
      if (url === "https://aais.example.test/api/system/readiness") {
        return Response.json(
          {
            status: "ready",
            runtime: "production",
            release: {
              id: "aais-2026-06-30-rc1",
              source: "AAIS_RELEASE_ID",
              deployment: {
                provider: "vercel",
                gitCommit: {
                  present: true,
                  shortSha: "abcdef123456",
                },
              },
            },
            checks: {
              session: { status: "ok" },
              trialAccounts: { status: "disabled", configured: false, accountCount: 0 },
              storage: { status: "ok", mode: "postgres", probe: "connected" },
              lrs: lrsReadyCheck(),
              oidc: oidcReadyCheck(),
              ai: {
                status: "ok",
                provider: "deterministic",
                evalVersion: null,
                evalManifest: "not-required",
              },
            },
            issues: [],
            secrets: "redacted",
          },
          { headers: createSecurityHeaders() },
        );
      }
      if (url === "https://aais.example.test/api/learning/lrs/health") {
        return Response.json(lrsHealthBody());
      }
      if (url === "https://aais.example.test/api/auth/oidc/start?from=%2Flearning") {
        return new Response(null, {
          status: 307,
          headers: {
            location: oidcAuthorizationLocation(),
            "set-cookie": "aais_oidc_state=opaque-start; Path=/; HttpOnly; Secure; SameSite=lax",
          },
        });
      }
      return new Response("unexpected", { status: 500 });
    });

    try {
      const report = await runEnterpriseReleaseVerification({
        baseUrl: "https://aais.example.test",
        fetchImpl: fetchMock,
        releaseId: "aais-2026-06-30-rc1",
        outputPath,
      });

      const fileReport = JSON.parse(await readFile(outputPath, "utf8"));
      expect(fileReport).toEqual(report);
      expect(fileReport).toMatchObject({
        status: "passed",
        release: { id: "aais-2026-06-30-rc1" },
        redaction: {
          secrets: "omitted",
          cookies: "attributes-only",
        },
      });
      expect(JSON.stringify(fileReport)).not.toContain("opaque-start");
    } finally {
      await rm(tempDir, { force: true, recursive: true });
    }
  });

  it("writes CLI output when a boolean flag appears before --output", async () => {
    const tempDir = await mkdtemp(path.join(tmpdir(), "aais-enterprise-cli-"));
    const outputPath = path.join(tempDir, "enterprise-release.json");
    const server = createServer((request, response) => {
      const url = request.url ?? "/";
      if (url === "/api/system/readiness") {
        response.writeHead(200, {
          ...createSecurityHeaders(),
          "content-type": "application/json",
        });
        response.end(JSON.stringify({
          status: "ready",
          runtime: "production",
          checks: {
            session: { status: "ok" },
            trialAccounts: { status: "disabled", configured: false, accountCount: 0 },
            storage: { status: "ok", mode: "postgres", provider: "neon", probe: "connected" },
            lrs: lrsReadyCheck(),
            oidc: oidcReadyCheck(),
            ai: {
              status: "ok",
              provider: "deterministic",
              evalVersion: null,
              evalManifest: "not-required",
            },
          },
          issues: [],
          secrets: "redacted",
        }));
        return;
      }
      if (url === "/api/learning/lrs/health") {
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify(lrsHealthBody()));
        return;
      }
      if (url === "/terms" || url === "/privacy") {
        response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
        response.end(legalPageHtml(url));
        return;
      }
      if (url === "/api/auth/oidc/start?from=%2Flearning") {
        response.writeHead(307, {
          location: oidcAuthorizationLocation({
            redirectUri: `http://${request.headers.host}/api/auth/oidc/callback`,
          }),
          "set-cookie": "aais_oidc_state=opaque; Path=/; HttpOnly; Secure; SameSite=lax",
        });
        response.end();
        return;
      }
      if (url === "/login") {
        response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
        response.end('<a href="/api/auth/oidc/start?from=%2Flearning">使用机构 SSO 登录</a>');
        return;
      }
      if (url === "/api/auth/app-session" && request.method === "POST") {
        response.writeHead(404, { "content-type": "application/json" });
        response.end(JSON.stringify({ error: "AAIS trial login is disabled." }));
        return;
      }
      response.writeHead(500);
      response.end("unexpected");
    });

    try {
      await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : 0;
      await execFileAsync(process.execPath, [
        "scripts/verify-enterprise-release.mjs",
        "--base-url",
        `http://127.0.0.1:${port}`,
        "--require-sso-only",
        "--output",
        outputPath,
      ], {
        cwd: process.cwd(),
      });

      const fileReport = JSON.parse(await readFile(outputPath, "utf8"));
      expect(fileReport).toMatchObject({
        status: "passed",
        redaction: {
          secrets: "omitted",
          cookies: "attributes-only",
        },
      });
    } finally {
      server.close();
      await rm(tempDir, { force: true, recursive: true });
    }
  });

  it("verifies an optional real OIDC callback smoke without leaking callback secrets", async () => {
    const fetchMock = vi.fn(async (input, init = {}) => {
      const url = String(input);
      if (isLegalPageUrl(url)) {
        return legalPageResponse(url);
      }
      if (url === "https://aais.example.test/api/system/readiness") {
        return Response.json(
          {
            status: "ready",
            runtime: "production",
            checks: {
              session: { status: "ok" },
              trialAccounts: { status: "disabled", configured: false, accountCount: 0 },
              storage: { status: "ok", mode: "postgres", probe: "connected" },
              lrs: lrsReadyCheck(),
              oidc: oidcReadyCheck(),
              ai: {
                status: "ok",
                provider: "deterministic",
                evalVersion: null,
                evalManifest: "not-required",
              },
            },
            issues: [],
            secrets: "redacted",
          },
          { headers: createSecurityHeaders() },
        );
      }
      if (url === "https://aais.example.test/api/learning/lrs/health") {
        return Response.json(lrsHealthBody());
      }
      if (url === "https://aais.example.test/api/auth/oidc/start?from=%2Flearning") {
        return new Response(null, {
          status: 307,
          headers: {
            location: oidcAuthorizationLocation(),
            "set-cookie": "aais_oidc_state=opaque-start; Path=/; HttpOnly; Secure; SameSite=lax",
          },
        });
      }
      if (url === "https://aais.example.test/api/auth/oidc/callback?code=real-auth-code&state=real-state") {
        expect(init.redirect).toBe("manual");
        expect(init.headers.cookie).toBe("aais_oidc_state=real-state-cookie");
        return new Response(null, {
          status: 307,
          headers: {
            location: "/learning",
            "set-cookie": "aais_session=session-cookie-value; Path=/; HttpOnly; Secure; SameSite=lax, aais_csrf=csrf-cookie-value; Path=/; Secure; SameSite=lax, aais_oidc_state=; Path=/; Max-Age=0; HttpOnly; Secure; SameSite=lax",
          },
        });
      }
      if (url === "https://aais.example.test/api/learning/session") {
        expect(init.method).toBe("GET");
        expect(init.headers.cookie).toContain("aais_session=");
        expect(init.headers.cookie).toContain("aais_csrf=");
        return Response.json({
          session: {
            studentId: "enterprise-user-1",
            activeTaskId: "training_task_1",
          },
        });
      }
      return new Response("unexpected", { status: 500 });
    });

    const report = await runEnterpriseReleaseVerification({
      baseUrl: "https://aais.example.test",
      fetchImpl: fetchMock,
      oidcCallback: {
        callbackUrl: "/api/auth/oidc/callback?code=real-auth-code&state=real-state",
        stateCookie: "real-state-cookie",
      },
    });

    const callback = report.checks.find((check) => check.name === "oidc-callback");
    expect(report.status).toBe("passed");
    expect(callback).toMatchObject({
      status: "passed",
      httpStatus: 307,
      details: {
        callbackUrlMatchesBaseCallback: true,
        redirectsToLocalTarget: true,
        setsSessionCookie: true,
        sessionCookieHttpOnly: true,
        sessionCookieSecure: true,
        sessionCookieSameSiteLax: true,
        setsCsrfCookie: true,
        csrfCookieSecure: true,
        csrfCookieSameSiteLax: true,
        clearsStateCookie: true,
        setCookieLeaksCallbackUrl: false,
        learningSessionStatus: 200,
        learningSessionReadable: true,
      },
    });
    const serialized = JSON.stringify(report);
    expect(serialized).not.toContain("real-auth-code");
    expect(serialized).not.toContain("real-state");
    expect(serialized).not.toContain("real-state-cookie");
    expect(serialized).not.toContain("session-cookie-value");
    expect(serialized).not.toContain("csrf-cookie-value");
    expect(serialized).not.toContain("enterprise-user-1");
  });

  it("uses the real OIDC callback educator session for SSO-only cohort analytics", async () => {
    const fetchMock = vi.fn(async (input, init = {}) => {
      const url = String(input);
      if (isLegalPageUrl(url)) {
        return legalPageResponse(url);
      }
      if (url === "https://aais.example.test/api/system/readiness") {
        return Response.json(
          {
            status: "ready",
            runtime: "production",
            checks: {
              session: { status: "ok" },
              trialAccounts: { status: "disabled", configured: false, accountCount: 0 },
              storage: { status: "ok", mode: "postgres", probe: "connected" },
              lrs: lrsReadyCheck(),
              oidc: oidcReadyCheck(),
              ai: {
                status: "ok",
                provider: "deterministic",
                evalVersion: null,
                evalManifest: "not-required",
              },
            },
            issues: [],
            secrets: "redacted",
          },
          { headers: createSecurityHeaders() },
        );
      }
      if (url === "https://aais.example.test/api/learning/lrs/health") {
        return Response.json(lrsHealthBody());
      }
      if (url === "https://aais.example.test/api/auth/oidc/start?from=%2Flearning") {
        return new Response(null, {
          status: 307,
          headers: {
            location: oidcAuthorizationLocation(),
            "set-cookie": "aais_oidc_state=opaque-start; Path=/; HttpOnly; Secure; SameSite=lax",
          },
        });
      }
      if (url === "https://aais.example.test/api/auth/oidc/callback?code=real-auth-code&state=real-state") {
        expect(init.headers.cookie).toBe("aais_oidc_state=real-state-cookie");
        return new Response(null, {
          status: 307,
          headers: {
            location: "/dashboard",
            "set-cookie": "aais_session=educator-session-cookie; Path=/; HttpOnly; Secure; SameSite=lax, aais_csrf=educator-csrf-cookie; Path=/; Secure; SameSite=lax, aais_oidc_state=; Path=/; Max-Age=0; HttpOnly; Secure; SameSite=lax",
          },
        });
      }
      if (url === "https://aais.example.test/api/learning/session") {
        expect(init.headers.cookie).toContain("aais_session=");
        expect(init.headers.cookie).toContain("aais_csrf=");
        return Response.json({
          session: {
            studentId: "teacher-oidc-user",
            activeTaskId: "training_task_1",
          },
        });
      }
      if (url === "https://aais.example.test/api/learning/analytics?scope=cohort&phase=practice&agent=A2&event=coaching_push") {
        expect(init.headers.cookie).toContain("aais_session=");
        expect(init.headers.cookie).toContain("aais_csrf=");
        return Response.json({
          analytics: {
            filters: {
              applied: {
                phase: "practice",
                agent: "A2",
                event: "coaching_push",
              },
            },
            dashboard: {
              cohort: {
                learnerCount: 1,
                trainingCompleted: 1,
                completedPracticeTasks: 0,
                scaffoldRequests: 0,
                coachingSignals: 1,
                aiInteractions: 0,
                aiAcceptanceDecisions: 0,
                riskBreakdown: {
                  high: 1,
                  medium: 0,
                  low: 0,
                },
              },
            },
            learners: [
              {
                learnerKey: "learner-abcdef123456",
                coachingSignals: 1,
                aiAcceptanceDecisions: 0,
                riskLevel: "high",
                priorityReasons: ["a2_coaching_signals"],
              },
            ],
            integrations: {
              factLayer: "lrs",
              joinKeys: ["session_id", "phase", "task", "agent", "event", "cohort", "role", "course_id"],
            },
            privacy: {
              actorMode: "pseudonymous",
              rawPromptStorage: "excluded_from_lrs",
              minimumNecessaryFields: true,
            },
          },
          secrets: "redacted",
        });
      }
      if (url === "https://aais.example.test/api/learning/export?scope=cohort&format=json&phase=practice&agent=A2&event=coaching_push") {
        expect(init.headers.cookie).toContain("aais_session=");
        expect(init.headers.cookie).toContain("aais_csrf=");
        return cohortExportJsonResponse();
      }
      if (url === "https://aais.example.test/login") {
        return new Response(
          '<a href="/api/auth/oidc/start?from=%2Flearning">使用机构 SSO 登录</a>',
          {
            status: 200,
            headers: {
              "content-type": "text/html; charset=utf-8",
            },
          },
        );
      }
      if (url === "https://aais.example.test/api/auth/app-session") {
        expect(String(init.body)).toContain("aais-sso-only-smoke");
        return Response.json(
          { error: "AAIS trial login is disabled." },
          { status: 404 },
        );
      }
      return new Response("unexpected", { status: 500 });
    });

    const report = await runEnterpriseReleaseVerification({
      baseUrl: "https://aais.example.test",
      fetchImpl: fetchMock,
      requireSsoOnly: true,
      requireCohortAnalytics: true,
      oidcCallback: {
        callbackUrl: "/api/auth/oidc/callback?code=real-auth-code&state=real-state",
        stateCookie: "real-state-cookie",
      },
    });

    const cohort = report.checks.find((check) => check.name === "cohort-analytics");
    expect(report.status).toBe("passed");
    expect(cohort).toMatchObject({
      status: "passed",
      details: {
        authSource: "oidc-callback",
        educatorRoleAccepted: true,
        analyticsStatus: 200,
        filtersApplied: true,
        learnerKeysPseudonymous: true,
        aggregateCountsPresent: true,
        riskBreakdownPresent: true,
        learnerRiskLevelsPresent: true,
        priorityReasonsStable: true,
        aiAcceptanceDecisionsPresent: true,
        factLayerLrs: true,
        privacyPseudonymous: true,
        noRawLearnerText: true,
      },
    });
    const serialized = JSON.stringify(report);
    expect(serialized).not.toContain("real-auth-code");
    expect(serialized).not.toContain("real-state-cookie");
    expect(serialized).not.toContain("educator-session-cookie");
    expect(serialized).not.toContain("educator-csrf-cookie");
    expect(serialized).not.toContain("teacher-oidc-user");
  });

  it("fails OIDC callback smoke locally when placeholder callback evidence is supplied", async () => {
    const fetchMock = vi.fn(async (input, init = {}) => {
      const url = String(input);
      if (isLegalPageUrl(url)) {
        return legalPageResponse(url);
      }
      if (url === "https://aais.example.test/api/system/readiness") {
        return Response.json(
          {
            status: "ready",
            runtime: "production",
            checks: {
              session: { status: "ok" },
              trialAccounts: { status: "disabled", configured: false, accountCount: 0 },
              storage: { status: "ok", mode: "postgres", probe: "connected" },
              lrs: lrsReadyCheck(),
              oidc: oidcReadyCheck(),
              ai: {
                status: "ok",
                provider: "deterministic",
                evalVersion: null,
                evalManifest: "not-required",
              },
            },
            issues: [],
            secrets: "redacted",
          },
          { headers: createSecurityHeaders() },
        );
      }
      if (url === "https://aais.example.test/api/learning/lrs/health") {
        return Response.json(lrsHealthBody());
      }
      if (url === "https://aais.example.test/api/auth/oidc/start?from=%2Flearning") {
        return new Response(null, {
          status: 307,
          headers: {
            location: oidcAuthorizationLocation(),
            "set-cookie": "aais_oidc_state=opaque-start; Path=/; HttpOnly; Secure; SameSite=lax",
          },
        });
      }
      if (url === "https://aais.example.test/login") {
        return new Response('<a href="/api/auth/oidc/start">SSO</a>', { status: 200 });
      }
      if (url === "https://aais.example.test/api/auth/app-session") {
        expect(init.method).toBe("POST");
        return Response.json({ error: "Trial login disabled." }, { status: 404 });
      }
      if (url.includes("/api/auth/oidc/callback")) {
        throw new Error("placeholder OIDC callback URL should not be fetched");
      }
      return new Response("unexpected", { status: 500 });
    });

    const report = await runEnterpriseReleaseVerification({
      baseUrl: "https://aais.example.test",
      fetchImpl: fetchMock,
      requireSsoOnly: true,
      oidcCallback: {
        callbackUrl: "<transient-callback-url>",
        stateCookie: "<transient-state-cookie>",
      },
    });

    const callback = report.checks.find((check) => check.name === "oidc-callback");
    expect(report.status).toBe("failed");
    expect(callback).toMatchObject({
      status: "failed",
      details: {
        reason: "OIDC callback placeholder values must be replaced with transient IdP evidence",
        placeholderEvidenceSupplied: true,
      },
    });
    expect(fetchMock).not.toHaveBeenCalledWith(
      expect.stringContaining("/api/auth/oidc/callback"),
      expect.anything(),
    );
    const serialized = JSON.stringify(report);
    expect(serialized).not.toContain("transient-callback-url");
    expect(serialized).not.toContain("transient-state-cookie");
  });

  it("fails OIDC callback smoke when the supplied callback URL is not the verified AAIS callback", async () => {
    const fetchMock = vi.fn(async (input) => {
      const url = String(input);
      if (isLegalPageUrl(url)) {
        return legalPageResponse(url);
      }
      if (url === "https://aais.example.test/api/system/readiness") {
        return Response.json(
          {
            status: "ready",
            runtime: "production",
            checks: {
              session: { status: "ok" },
              trialAccounts: { status: "disabled", configured: false, accountCount: 0 },
              storage: { status: "ok", mode: "postgres", probe: "connected" },
              lrs: lrsReadyCheck(),
              oidc: oidcReadyCheck(),
              ai: {
                status: "ok",
                provider: "deterministic",
                evalVersion: null,
                evalManifest: "not-required",
              },
            },
            issues: [],
            secrets: "redacted",
          },
          { headers: createSecurityHeaders() },
        );
      }
      if (url === "https://aais.example.test/api/learning/lrs/health") {
        return Response.json(lrsHealthBody());
      }
      if (url === "https://aais.example.test/api/auth/oidc/start?from=%2Flearning") {
        return new Response(null, {
          status: 307,
          headers: {
            location: oidcAuthorizationLocation(),
            "set-cookie": "aais_oidc_state=opaque-start; Path=/; HttpOnly; Secure; SameSite=lax",
          },
        });
      }
      if (url === "https://wrong-aais.example.test/api/auth/oidc/callback?code=real-auth-code&state=real-state") {
        return new Response(null, {
          status: 307,
          headers: {
            location: "/learning",
            "set-cookie": "aais_session=session-cookie-value; Path=/; HttpOnly; Secure; SameSite=lax, aais_csrf=csrf-cookie-value; Path=/; Secure; SameSite=lax, aais_oidc_state=; Path=/; Max-Age=0; HttpOnly; Secure; SameSite=lax",
          },
        });
      }
      return new Response("unexpected", { status: 500 });
    });

    const report = await runEnterpriseReleaseVerification({
      baseUrl: "https://aais.example.test",
      fetchImpl: fetchMock,
      oidcCallback: {
        callbackUrl: "https://wrong-aais.example.test/api/auth/oidc/callback?code=real-auth-code&state=real-state",
        stateCookie: "real-state-cookie",
      },
    });

    const callback = report.checks.find((check) => check.name === "oidc-callback");
    expect(report.status).toBe("failed");
    expect(callback).toMatchObject({
      status: "failed",
      details: {
        callbackUrlMatchesBaseCallback: false,
      },
    });
    expect(fetchMock).not.toHaveBeenCalledWith(
      "https://wrong-aais.example.test/api/auth/oidc/callback?code=real-auth-code&state=real-state",
      expect.anything(),
    );
    expect(JSON.stringify(report)).not.toContain("real-auth-code");
    expect(JSON.stringify(report)).not.toContain("real-state-cookie");
  });

  it("fails OIDC callback smoke when session or CSRF cookies are not Secure", async () => {
    const fetchMock = vi.fn(async (input, init = {}) => {
      const url = String(input);
      if (isLegalPageUrl(url)) {
        return legalPageResponse(url);
      }
      if (url === "https://aais.example.test/api/system/readiness") {
        return Response.json(
          {
            status: "ready",
            runtime: "production",
            checks: {
              session: { status: "ok" },
              trialAccounts: { status: "disabled", configured: false, accountCount: 0 },
              storage: { status: "ok", mode: "postgres", probe: "connected" },
              lrs: lrsReadyCheck(),
              oidc: oidcReadyCheck(),
              ai: {
                status: "ok",
                provider: "deterministic",
                evalVersion: null,
                evalManifest: "not-required",
              },
            },
            issues: [],
            secrets: "redacted",
          },
          { headers: createSecurityHeaders() },
        );
      }
      if (url === "https://aais.example.test/api/learning/lrs/health") {
        return Response.json(lrsHealthBody());
      }
      if (url === "https://aais.example.test/api/auth/oidc/start?from=%2Flearning") {
        return new Response(null, {
          status: 307,
          headers: {
            location: oidcAuthorizationLocation(),
            "set-cookie": "aais_oidc_state=opaque-start; Path=/; HttpOnly; Secure; SameSite=lax",
          },
        });
      }
      if (url === "https://aais.example.test/api/auth/oidc/callback?code=real-auth-code&state=real-state") {
        expect(init.headers.cookie).toBe("aais_oidc_state=real-state-cookie");
        return new Response(null, {
          status: 307,
          headers: {
            location: "/learning",
            "set-cookie": "aais_session=session-cookie-value; Path=/; HttpOnly; SameSite=lax, aais_csrf=csrf-cookie-value; Path=/; SameSite=lax, aais_oidc_state=; Path=/; Max-Age=0; HttpOnly; Secure; SameSite=lax",
          },
        });
      }
      if (url === "https://aais.example.test/api/learning/session") {
        return Response.json({
          session: {
            studentId: "enterprise-user-1",
          },
        });
      }
      return new Response("unexpected", { status: 500 });
    });

    const report = await runEnterpriseReleaseVerification({
      baseUrl: "https://aais.example.test",
      fetchImpl: fetchMock,
      oidcCallback: {
        callbackUrl: "/api/auth/oidc/callback?code=real-auth-code&state=real-state",
        stateCookie: "real-state-cookie",
      },
    });

    const callback = report.checks.find((check) => check.name === "oidc-callback");
    expect(report.status).toBe("failed");
    expect(callback).toMatchObject({
      status: "failed",
      details: {
        sessionCookieSecure: false,
        csrfCookieSecure: false,
      },
    });
  });

  it("can require SSO-only release mode without leaking trial credentials or cookies", async () => {
    const fetchMock = vi.fn(async (input, init = {}) => {
      const url = String(input);
      if (isLegalPageUrl(url)) {
        return legalPageResponse(url);
      }
      if (url === "https://aais.example.test/api/system/readiness") {
        return Response.json(
          {
            status: "ready",
            runtime: "production",
            checks: {
              session: { status: "ok" },
              trialAccounts: { status: "disabled", configured: false, accountCount: 0 },
              storage: { status: "ok", mode: "postgres", probe: "connected" },
              lrs: lrsReadyCheck(),
              oidc: oidcReadyCheck(),
              ai: {
                status: "ok",
                provider: "deterministic",
                evalVersion: null,
                evalManifest: "not-required",
              },
            },
            issues: [],
            secrets: "redacted",
          },
          { headers: createSecurityHeaders() },
        );
      }
      if (url === "https://aais.example.test/api/learning/lrs/health") {
        return Response.json(lrsHealthBody());
      }
      if (url === "https://aais.example.test/api/auth/oidc/start?from=%2Flearning") {
        return new Response(null, {
          status: 307,
          headers: {
            location: oidcAuthorizationLocation(),
            "set-cookie": "aais_oidc_state=opaque-start; Path=/; HttpOnly; Secure; SameSite=lax",
          },
        });
      }
      if (url === "https://aais.example.test/login") {
        return new Response(
          '<a href="/api/auth/oidc/start?from=%2Flearning">使用机构 SSO 登录</a>',
          {
            status: 200,
            headers: {
              "content-type": "text/html; charset=utf-8",
            },
          },
        );
      }
      if (url === "https://aais.example.test/api/auth/app-session") {
        expect(init.method).toBe("POST");
        return Response.json(
          { error: "AAIS trial login is disabled." },
          { status: 404 },
        );
      }
      return new Response("unexpected", { status: 500 });
    });

    const report = await runEnterpriseReleaseVerification({
      baseUrl: "https://aais.example.test",
      fetchImpl: fetchMock,
      requireSsoOnly: true,
      trialLogin: {
        account: "retired-trial-user",
        correctPassword: "trial-password-that-must-not-leak",
      },
    });

    const ssoOnly = report.checks.find((check) => check.name === "sso-only-mode");
    expect(report.status).toBe("passed");
    expect(ssoOnly).toMatchObject({
      status: "passed",
      httpStatus: 404,
      details: {
        readinessTrialAccountsDisabled: true,
        loginPageHasSsoEntry: true,
        loginPageHasTrialForm: false,
        appSessionPostDisabled: true,
        appSessionSetsSessionCookie: false,
      },
    });
    const serialized = JSON.stringify(report);
    expect(serialized).not.toContain("retired-trial-user");
    expect(serialized).not.toContain("trial-password-that-must-not-leak");
    expect(serialized).not.toContain("opaque-start");
  });
});

function createSecurityHeaders() {
  return {
    "strict-transport-security": "max-age=63072000; includeSubDomains; preload",
    "x-content-type-options": "nosniff",
    "x-frame-options": "DENY",
    "referrer-policy": "strict-origin-when-cross-origin",
    "permissions-policy": "camera=(), microphone=(), geolocation=(), payment=()",
    "content-security-policy": "default-src 'self'; frame-ancestors 'none'; base-uri 'self'",
    "cross-origin-opener-policy": "same-origin",
    "x-vercel-id": "hkg1::iad1::redacted-request-id",
  };
}

function isLegalPageUrl(url) {
  return url === "https://aais.example.test/terms"
    || url === "https://aais.example.test/privacy"
    || url === "/terms"
    || url === "/privacy";
}

function legalPageResponse(url) {
  return new Response(legalPageHtml(url), {
    status: 200,
    headers: {
      "content-type": "text/html; charset=utf-8",
    },
  });
}

function legalPageHtml(url) {
  if (String(url).endsWith("/privacy")) {
    return "<!doctype html><html><main><h1>隐私与学习数据说明</h1><p>Privacy and data governance for AAIS.</p></main></html>";
  }
  return "<!doctype html><html><main><h1>使用条款</h1><p>Responsible use for AAIS.</p></main></html>";
}

function cohortExportJsonResponse() {
  return Response.json(
    {
      schemaVersion: 1,
      exportScope: "cohort",
      filters: {
        applied: {
          phase: "practice",
          agent: "A2",
          event: "coaching_push",
        },
      },
      dashboard: {
        cohort: {
          learnerCount: 1,
          trainingCompleted: 1,
          completedPracticeTasks: 0,
          scaffoldRequests: 0,
          coachingSignals: 1,
          aiInteractions: 0,
          aiAcceptanceDecisions: 0,
        },
      },
      learners: [
        {
          learnerKey: "learner-123456789abc",
          sessionKey: "session-redacted",
          riskLevel: "high",
          priorityReasons: ["a2_coaching_signals"],
        },
      ],
      privacy: {
        actorMode: "pseudonymous",
        rawLearnerText: "excluded",
      },
      secrets: "redacted",
    },
    {
      headers: {
        "content-disposition": 'attachment; filename="aais-cohort-analytics.json"',
      },
    },
  );
}

function oidcAuthorizationLocation(input = {}) {
  const url = new URL("https://idp.example.test/oauth2/authorize");
  url.searchParams.set("response_type", "code");
  url.searchParams.set("client_id", "aais-client");
  url.searchParams.set(
    "redirect_uri",
    input.redirectUri ?? "https://aais.example.test/api/auth/oidc/callback",
  );
  url.searchParams.set("scope", "openid email profile");
  url.searchParams.set("state", "abc");
  url.searchParams.set("nonce", "nonce");
  url.searchParams.set("code_challenge", "test-code-challenge");
  url.searchParams.set("code_challenge_method", "S256");
  return url.toString();
}

function oidcReadyCheck() {
  return {
    status: "ok",
    mode: "explicit",
    roleMapping: {
      status: "ok",
      configured: true,
      present: ["AAIS_OIDC_TEACHER_GROUPS"],
      acceptedNames: [
        "AAIS_OIDC_TEACHER_GROUPS",
        "AAIS_OIDC_TEACHER_EMAILS",
        "AAIS_OIDC_ADMIN_GROUPS",
        "AAIS_OIDC_ADMIN_EMAILS",
      ],
      redaction: "names-only",
    },
  };
}

function lrsReadyCheck() {
  return {
    status: "ok",
    outbox: {
      mode: "persistent",
      storage: "postgres",
      coalescing: {
        enabled: true,
        windowSeconds: 30,
        events: ["artifact_saved", "artifact_edited"],
        strategy: "latest-write-wins",
      },
      metrics: {
        pending: 0,
        retry: 0,
        sent: 4,
        deadLetter: 0,
        total: 4,
      },
    },
  };
}

function lrsHealthBody(input = {}) {
  return {
    status: "connected",
    configured: true,
    configuration: { configured: true },
    delivery: {
      persistentOutbox: input.persistentOutbox ?? {
        mode: "persistent",
        storage: "postgres",
        coalescing: {
          enabled: true,
          windowSeconds: 30,
          events: ["artifact_saved", "artifact_edited"],
          strategy: "latest-write-wins",
        },
        pending: 0,
        retry: 0,
        sent: 4,
        deadLetter: 0,
        total: 4,
        secrets: "redacted",
      },
    },
    secrets: "redacted",
  };
}

function modelFingerprint(model) {
  return createHash("sha256")
    .update(`aais-ai-model:${model}`)
    .digest("hex")
    .slice(0, 16);
}
