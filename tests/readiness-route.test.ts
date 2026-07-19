import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createAaisSessionToken,
  getAaisSessionCookieName,
} from "@/lib/server/aais-session";
import { createPasswordRecord } from "@/lib/server/aais-trial-accounts";

let databaseProbeMode: "ok" | "missing_schema" | "error" = "ok";

vi.mock("pg", () => ({
  Pool: class {
    async query(sql: string) {
      if (databaseProbeMode === "error") {
        throw new Error("database unavailable");
      }
      if (/to_regclass/i.test(sql)) {
        return {
          rows: [{
            learner_sessions_table: databaseProbeMode === "missing_schema" ? null : "aais_learner_sessions",
            learner_task_state_table: databaseProbeMode === "missing_schema" ? null : "aais_learner_task_state",
            lrs_outbox_table: databaseProbeMode === "missing_schema" ? null : "aais_lrs_outbox",
            login_rate_limits_table: databaseProbeMode === "missing_schema" ? null : "aais_login_rate_limits",
            events_table: databaseProbeMode === "missing_schema" ? null : "aais_events",
            users_table: databaseProbeMode === "missing_schema" ? null : "aais_users",
            user_auth_tokens_table: databaseProbeMode === "missing_schema" ? null : "aais_user_auth_tokens",
            session_revocations_table: databaseProbeMode === "missing_schema" ? null : "aais_session_revocations",
            courses_table: databaseProbeMode === "missing_schema" ? null : "aais_courses",
            course_tasks_table: databaseProbeMode === "missing_schema" ? null : "aais_course_tasks",
            enrollments_table: databaseProbeMode === "missing_schema" ? null : "aais_enrollments",
          }],
        };
      }
      if (/from aais_session_revocations/i.test(sql)) {
        return {
          rows: [],
        };
      }
      if (/select 1/i.test(sql)) {
        return {
          rows: [{ ok: 1 }],
        };
      }
      return {
        rows: [],
      };
    }
  },
}));

const enterpriseEnv = [
  "AAIS_SESSION_SECRET",
  "AAIS_TRIAL_LOGIN_ENABLED",
  "AAIS_TRIAL_ACCOUNTS_JSON",
  "AAIS_TRIAL_SMOKE_ACCOUNTS_JSON",
  "AAIS_DATABASE_DRIVER",
  "AAIS_DATABASE_URL",
  "DATABASE_URL",
  "POSTGRES_URL",
  "POSTGRES_PRISMA_URL",
  "POSTGRES_URL_NO_SSL",
  "DATABASE_URL_UNPOOLED",
  "POSTGRES_URL_NON_POOLING",
  "PGHOST",
  "PGHOST_UNPOOLED",
  "PGPORT",
  "PGUSER",
  "PGDATABASE",
  "PGPASSWORD",
  "PGSSLMODE",
  "LRS_ENDPOINT",
  "LRS_USERNAME",
  "LRS_PASSWORD",
  "SENTRY_DSN",
  "NEXT_PUBLIC_SENTRY_DSN",
  "AAIS_SENTRY_ALERTS_CONFIGURED",
  "AAIS_UPTIME_LOGIN_CHECK_URL",
  "CRON_SECRET",
  "AAIS_CRON_FAILURE_ALERTS_CONFIGURED",
  "AAIS_OIDC_ISSUER",
  "AAIS_OIDC_CLIENT_ID",
  "AAIS_OIDC_CLIENT_SECRET",
  "AAIS_OIDC_REDIRECT_URI",
  "AAIS_OIDC_AUTHORIZATION_ENDPOINT",
  "AAIS_OIDC_TOKEN_ENDPOINT",
  "AAIS_OIDC_JWKS_URI",
  "AAIS_OIDC_TEACHER_GROUPS",
  "AAIS_OIDC_TEACHER_EMAILS",
  "AAIS_OIDC_ADMIN_GROUPS",
  "AAIS_OIDC_ADMIN_EMAILS",
  "AAIS_AI_PROVIDER",
  "AAIS_AI_ENDPOINT",
  "AAIS_AI_API_KEY",
  "AAIS_AI_MODEL",
  "AAIS_AI_TIMEOUT_MS",
  "AAIS_AI_MAX_RETRIES",
  "AAIS_AI_THINKING_MODE",
  "AAIS_AI_FALLBACK_ENDPOINT",
  "AAIS_AI_FALLBACK_API_KEY",
  "AAIS_AI_FALLBACK_MODEL",
  "AAIS_AI_FALLBACK_TIMEOUT_MS",
  "AAIS_AI_FALLBACK_MAX_RETRIES",
  "AAIS_AI_FALLBACK_THINKING_MODE",
  "AAIS_AI_EVAL_APPROVED",
  "AAIS_AI_EVAL_VERSION",
  "AAIS_AI_EVAL_MANIFEST_PATH",
  "DASHSCOPE_API_KEY",
  "DASHSCOPE_MODEL",
  "QWEN_API_KEY",
  "QWEN_MODEL",
  "AAIS_RELEASE_ID",
  "AAIS_DEPLOYMENT_GIT_COMMIT_SHA",
  "AAIS_READINESS_MODE",
  "AAIS_READINESS_BEARER_TOKEN",
  "VERCEL",
  "VERCEL_GIT_COMMIT_SHA",
];

let tempDir: string;

const trialAccountConfig = JSON.stringify([
  {
    id: "Bobie",
    displayName: "Bobie",
    role: "student",
    password: createPasswordRecord("trial-password-that-must-not-leak"),
  },
]);

function passingAiEvalManifest(overrides: Record<string, unknown> = {}) {
  return {
    schemaVersion: 1,
    evalVersion: "eval-2026-06-30",
    provider: "openai-compatible",
    model: "enterprise-model",
    status: "passed",
    passedAt: "2026-06-30T00:00:00.000Z",
    sampleCount: 4,
    blockedCount: 0,
    agentEvidence: {
      contractVersion: "aais-a1-a4-ca-eval-v2",
      requiredAgents: ["A1", "A2", "A3", "A4"],
      coveredAgents: ["A1", "A2", "A3", "A4"],
      requiredCaModules: ["Modelling", "Coaching", "Scaffolding", "Fading", "Articulation", "Reflection"],
      coveredCaModules: ["Modelling", "Coaching", "Scaffolding", "Fading", "Articulation", "Reflection"],
      coverage: passingAiEvalAgentCoverage(),
      caBackgroundIncluded: true,
      rawPromptsStored: false,
      rawOutputsStored: false,
      complete: true,
    },
    redaction: {
      prompts: "summarized",
      secrets: "omitted",
    },
    ...overrides,
  };
}

function passingAiEvalAgentCoverage(overrides: Record<string, unknown> = {}) {
  return {
    A1: {
      label: "导学智能体",
      responsibility: "frontend-guide-scaffolding",
      sampleIds: ["a1-guide-training"],
      caModules: ["Scaffolding", "Fading"],
      complete: true,
    },
    A2: {
      label: "专家智能体",
      responsibility: "frontend-expert-modelling-coaching",
      sampleIds: ["a2-expert-modelling-coaching"],
      caModules: ["Modelling", "Coaching"],
      complete: true,
    },
    A3: {
      label: "监督智能体",
      responsibility: "backend-supervision-a1-signal",
      sampleIds: ["a3-supervision-a1-signal"],
      caModules: ["Scaffolding"],
      complete: true,
    },
    A4: {
      label: "反思智能体",
      responsibility: "backend-reflection-articulation",
      sampleIds: ["a4-articulation-reflection"],
      caModules: ["Articulation", "Reflection"],
      complete: true,
    },
    ...overrides,
  };
}

beforeEach(async () => {
  tempDir = await mkdtemp(path.join(tmpdir(), "aais-readiness-"));
  databaseProbeMode = "ok";
  vi.resetModules();
  vi.stubEnv("NODE_ENV", "production");
  for (const key of enterpriseEnv) {
    vi.stubEnv(key, "");
  }
  vi.stubEnv("AAIS_DATABASE_DRIVER", "pg");
});

afterEach(async () => {
  vi.unstubAllEnvs();
  await rm(tempDir, { force: true, recursive: true });
});

function stubMonitoringEnv() {
  vi.stubEnv("SENTRY_DSN", "https://private@example.ingest.sentry.io/123");
  vi.stubEnv("AAIS_SENTRY_ALERTS_CONFIGURED", "true");
  vi.stubEnv("AAIS_UPTIME_LOGIN_CHECK_URL", "https://uptime.example.test/aais-login");
  vi.stubEnv("CRON_SECRET", "cron-secret-that-must-not-leak");
  vi.stubEnv("AAIS_CRON_FAILURE_ALERTS_CONFIGURED", "true");
}

describe("AAIS readiness route", () => {
  it("reports a redacted ready status when enterprise production configuration is complete", async () => {
    vi.stubEnv("AAIS_READINESS_MODE", "enterprise");
    vi.stubEnv("AAIS_SESSION_SECRET", "session-secret-that-must-not-leak");
    vi.stubEnv("AAIS_TRIAL_ACCOUNTS_JSON", trialAccountConfig);
    vi.stubEnv("AAIS_DATABASE_URL", "postgres://aais:database-secret@ep-prod.us-east-1.aws.neon.tech/aais");
    vi.stubEnv("LRS_ENDPOINT", "https://lrs.example.test/xapi");
    vi.stubEnv("LRS_USERNAME", "lrs-user");
    vi.stubEnv("LRS_PASSWORD", "lrs-password-that-must-not-leak");
    stubMonitoringEnv();
    vi.stubEnv("AAIS_OIDC_ISSUER", "https://idp.example.test");
    vi.stubEnv("AAIS_OIDC_CLIENT_ID", "aais-client");
    vi.stubEnv("AAIS_OIDC_CLIENT_SECRET", "oidc-secret-that-must-not-leak");
    vi.stubEnv("AAIS_OIDC_REDIRECT_URI", "https://aais.example.test/api/auth/oidc/callback");
    vi.stubEnv("AAIS_OIDC_AUTHORIZATION_ENDPOINT", "https://idp.example.test/oauth2/authorize");
    vi.stubEnv("AAIS_OIDC_TOKEN_ENDPOINT", "https://idp.example.test/oauth2/token");
    vi.stubEnv("AAIS_OIDC_JWKS_URI", "https://idp.example.test/.well-known/jwks.json");
    vi.stubEnv("AAIS_OIDC_TEACHER_GROUPS", "aais-teachers");
    vi.stubEnv("AAIS_AI_PROVIDER", "openai-compatible");
    vi.stubEnv("AAIS_AI_ENDPOINT", "https://ai.example.test/v1/chat/completions");
    vi.stubEnv("AAIS_AI_API_KEY", "ai-secret-that-must-not-leak");
    vi.stubEnv("AAIS_AI_MODEL", "enterprise-model");
    vi.stubEnv("AAIS_AI_EVAL_APPROVED", "true");
    vi.stubEnv("AAIS_AI_EVAL_VERSION", "eval-2026-06-30");
    vi.stubEnv("AAIS_RELEASE_ID", "aais-2026-06-30-rc1");
    vi.stubEnv("VERCEL", "1");
    vi.stubEnv("VERCEL_GIT_COMMIT_SHA", "0123456789abcdef0123456789abcdef01234567");
    const manifestPath = path.join(tempDir, "aais-ai-eval.json");
    await writeFile(
      manifestPath,
      JSON.stringify(passingAiEvalManifest()),
      "utf8",
    );
    vi.stubEnv("AAIS_AI_EVAL_MANIFEST_PATH", manifestPath);
    const { GET } = await import("@/app/api/system/readiness/route");

    const response = await GET();
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body).toMatchObject({
      status: "ready",
      runtime: "production",
      readinessMode: "enterprise",
      release: {
        id: "aais-2026-06-30-rc1",
        source: "AAIS_RELEASE_ID",
        deployment: {
          provider: "vercel",
          gitCommit: {
            present: true,
            shortSha: "0123456789ab",
            source: "VERCEL_GIT_COMMIT_SHA",
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
        lrs: {
          status: "ok",
          outbox: {
            mode: "persistent",
            storage: "postgres",
            metrics: {
              pending: 0,
              retry: 0,
              sent: 0,
              deadLetter: 0,
              total: 0,
            },
            coalescing: {
              enabled: true,
              windowSeconds: 30,
              events: ["artifact_saved", "artifact_edited", "planning_submitted"],
              strategy: "latest-write-wins",
            },
            recovery: {
              deadLetterRequeue: true,
              action: "POST /api/learning/lrs/outbox/flush?action=requeue-dead-letter",
              auth: ["admin-session-csrf", "bearer-token"],
              redaction: "payloads-excluded",
            },
          },
        },
        monitoring: {
          status: "ok",
          sentry: {
            status: "ok",
            dsnConfigured: true,
            source: "SENTRY_DSN",
            alertsConfigured: true,
          },
          uptime: {
            status: "ok",
            loginCheckConfigured: true,
            source: "AAIS_UPTIME_LOGIN_CHECK_URL",
          },
          cron: {
            status: "ok",
            scheduleConfigured: true,
            secretConfigured: true,
            alertsConfigured: true,
          },
        },
        agentEvidence: {
          status: "ok",
          enabled: true,
          agentContract: {
            version: "aais-a1-a4-ca-v2",
            requiredAgents: ["A1", "A2", "A3", "A4"],
            caModules: {
              A1: ["Scaffolding", "Fading"],
              A2: ["Modelling", "Coaching"],
              A3: ["Scaffolding"],
              A4: ["Articulation", "Reflection"],
            },
            roles: {
              A1: "frontend-direct-dialogue",
              A2: "frontend-direct-dialogue",
              A3: "backend-a1-signal",
              A4: "backend-a1-reflection",
            },
            xapiExtensions: {
              agentRole: true,
              agentCaModules: true,
              agentFamily: true,
              agentPhaseScope: true,
              pseudonymousSessionId: true,
            },
            complete: true,
          },
          agentResponsibilities: {
            A1: ["scaffold_request", "scaffold_self_check_started"],
            A2: ["expert_model_viewed", "coaching_push", "ai_acceptance_recorded"],
            A3: [
              "artifact_edited",
              "artifact_saved",
              "planning_submitted",
              "monitoring_pause_detected",
            ],
            A4: ["articulation_submitted", "expert_trace_compared", "self_report_saved"],
          },
          triggers: [
            "monitoring_pause_detected",
            "coaching_push",
            "ai_acceptance_recorded",
          ],
        },
        a2Monitoring: {
          status: "ok",
          enabled: true,
          agentContract: {
            version: "aais-a1-a4-ca-v2",
            xapiExtensions: {
              agentRole: true,
              agentCaModules: true,
              agentFamily: true,
              agentPhaseScope: true,
              pseudonymousSessionId: true,
            },
            complete: true,
          },
          triggers: [
            "monitoring_pause_detected",
            "coaching_push",
            "ai_acceptance_recorded",
          ],
          signals: [
            "low_progress_artifact_autosave",
            "artifact_regression_autosave",
          ],
          coaching: {
            interruption: "low",
            cooldownSeconds: 600,
          },
          artifactRegression: {
            minimumPreviousCharacters: 80,
            minimumDropCharacters: 40,
            rawTextExcluded: true,
          },
          aiAcceptance: {
            decisionKeyed: true,
            revisions: true,
            rawMessageIdsExcluded: true,
            rationaleTextExcluded: true,
          },
          redaction: "raw-learner-text-excluded",
        },
        a3Supervision: {
          status: "ok",
          enabled: true,
          agentContract: {
            version: "aais-a1-a4-ca-v2",
            requiredAgents: ["A1", "A2", "A3", "A4"],
            caModules: {
              A1: ["Scaffolding", "Fading"],
              A2: ["Modelling", "Coaching"],
              A3: ["Scaffolding"],
              A4: ["Articulation", "Reflection"],
            },
            roles: {
              A1: "frontend-direct-dialogue",
              A2: "frontend-direct-dialogue",
              A3: "backend-a1-signal",
              A4: "backend-a1-reflection",
            },
            xapiExtensions: {
              agentRole: true,
              agentCaModules: true,
              agentFamily: true,
              agentPhaseScope: true,
              pseudonymousSessionId: true,
            },
            complete: true,
          },
          agentResponsibilities: {
            A3: [
              "artifact_edited",
              "artifact_saved",
              "planning_submitted",
              "monitoring_pause_detected",
            ],
          },
          triggers: [
            "monitoring_pause_detected",
            "coaching_push",
            "ai_acceptance_recorded",
          ],
          signals: [
            "low_progress_artifact_autosave",
            "artifact_regression_autosave",
          ],
        },
        oidc: {
          status: "ok",
          roleMapping: {
            status: "ok",
            configured: true,
            present: ["AAIS_OIDC_TEACHER_GROUPS"],
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
      secrets: "redacted",
    });
    const serialized = JSON.stringify(body);
    expect(serialized).not.toContain("session-secret-that-must-not-leak");
    expect(serialized).not.toContain("trial-password-that-must-not-leak");
    expect(serialized).not.toContain("database-secret");
    expect(serialized).not.toContain("lrs-password-that-must-not-leak");
    expect(serialized).not.toContain("oidc-secret-that-must-not-leak");
    expect(serialized).not.toContain("aais-teachers");
    expect(serialized).not.toContain("ai-secret-that-must-not-leak");
    expect(serialized).not.toContain("enterprise-model");
    expect(serialized).not.toContain("0123456789abcdef0123456789abcdef01234567");
    expect(body.issues).toEqual([]);
    expect(body.warnings).toEqual([]);
  });

  it("returns only bare status to anonymous external readiness callers", async () => {
    vi.stubEnv("AAIS_RELEASE_ID", "aais-2026-06-30-rc1");
    vi.stubEnv("VERCEL", "1");
    vi.stubEnv("VERCEL_GIT_COMMIT_SHA", "0123456789abcdef0123456789abcdef01234567");
    const { GET } = await import("@/app/api/system/readiness/route");

    const response = await GET(new Request("http://localhost/api/system/readiness"));
    const body = await response.json();

    expect(response.status).toBe(503);
    expect(body).toEqual({
      status: "not_ready",
    });
    const serialized = JSON.stringify(body);
    expect(serialized).not.toContain("aais-2026-06-30-rc1");
    expect(serialized).not.toContain("0123456789abcdef0123456789abcdef01234567");
    expect(serialized).not.toContain("AAIS_SESSION_SECRET");
  });

  it("returns the full readiness report to callers with the configured bearer token", async () => {
    vi.stubEnv("AAIS_READINESS_BEARER_TOKEN", "readiness-token-with-at-least-32-characters");
    vi.stubEnv("AAIS_RELEASE_ID", "aais-2026-06-30-rc1");
    const { GET } = await import("@/app/api/system/readiness/route");

    const response = await GET(
      new Request("http://localhost/api/system/readiness", {
        headers: {
          authorization: "Bearer readiness-token-with-at-least-32-characters",
        },
      }),
    );
    const body = await response.json();

    expect(response.status).toBe(503);
    expect(body.release).toMatchObject({
      id: "aais-2026-06-30-rc1",
      source: "AAIS_RELEASE_ID",
    });
    expect(body.checks).toBeTruthy();
    expect(JSON.stringify(body)).not.toContain("readiness-token-with-at-least-32-characters");
  });

  it("rejects invalid readiness bearer tokens without returning diagnostics", async () => {
    vi.stubEnv("AAIS_READINESS_BEARER_TOKEN", "readiness-token-with-at-least-32-characters");
    vi.stubEnv("AAIS_RELEASE_ID", "aais-2026-06-30-rc1");
    const { GET } = await import("@/app/api/system/readiness/route");

    const response = await GET(
      new Request("http://localhost/api/system/readiness", {
        headers: {
          authorization: "Bearer wrong-readiness-token",
        },
      }),
    );
    const body = await response.json();

    expect(response.status).toBe(403);
    expect(body).toEqual({
      error: {
        code: "AAIS_READINESS_FORBIDDEN",
        message: "AAIS readiness authorization failed.",
      },
      secrets: "redacted",
    });
    const serialized = JSON.stringify(body);
    expect(serialized).not.toContain("readiness-token-with-at-least-32-characters");
    expect(serialized).not.toContain("aais-2026-06-30-rc1");
  });

  it("returns the full readiness report to admin sessions", async () => {
    vi.stubEnv("AAIS_SESSION_SECRET", "session-secret-that-must-not-leak");
    vi.stubEnv("AAIS_RELEASE_ID", "aais-2026-06-30-rc1");
    const adminToken = createAaisSessionToken({
      id: "admin-a",
      displayName: "Admin A",
      role: "admin",
    });
    const { GET } = await import("@/app/api/system/readiness/route");

    const response = await GET(
      new Request("http://localhost/api/system/readiness", {
        headers: {
          cookie: `${getAaisSessionCookieName()}=${encodeURIComponent(adminToken)}`,
        },
      }),
    );
    const body = await response.json();

    expect(response.status).toBe(503);
    expect(body.release).toMatchObject({
      id: "aais-2026-06-30-rc1",
    });
    expect(body.checks.session.status).toBe("ok");
    expect(JSON.stringify(body)).not.toContain("Admin A");
  });

  it("uses explicit deployment git commit metadata when Vercel git metadata is unavailable", async () => {
    vi.stubEnv("AAIS_RELEASE_ID", "aais-2026-06-30-rc1");
    vi.stubEnv("AAIS_DEPLOYMENT_GIT_COMMIT_SHA", "fedcba9876543210fedcba9876543210fedcba98");
    vi.stubEnv("VERCEL", "1");
    vi.stubEnv("VERCEL_GIT_COMMIT_SHA", "");
    const { GET } = await import("@/app/api/system/readiness/route");

    const response = await GET();
    const body = await response.json();

    expect(response.status).toBe(503);
    expect(body.release).toMatchObject({
      id: "aais-2026-06-30-rc1",
      source: "AAIS_RELEASE_ID",
      deployment: {
        provider: "vercel",
        gitCommit: {
          present: true,
          shortSha: "fedcba987654",
          source: "AAIS_DEPLOYMENT_GIT_COMMIT_SHA",
        },
      },
    });
    expect(JSON.stringify(body)).not.toContain("fedcba9876543210fedcba9876543210fedcba98");
  });

  it("reports ready for SSO-only production when trial login is disabled", async () => {
    vi.stubEnv("AAIS_SESSION_SECRET", "session-secret-that-must-not-leak");
    vi.stubEnv("AAIS_TRIAL_LOGIN_ENABLED", "false");
    vi.stubEnv("AAIS_DATABASE_URL", "postgres://aais:database-secret@example.test/aais");
    vi.stubEnv("LRS_ENDPOINT", "https://lrs.example.test/xapi");
    vi.stubEnv("LRS_USERNAME", "lrs-user");
    vi.stubEnv("LRS_PASSWORD", "lrs-password-that-must-not-leak");
    stubMonitoringEnv();
    vi.stubEnv("AAIS_OIDC_ISSUER", "https://idp.example.test");
    vi.stubEnv("AAIS_OIDC_CLIENT_ID", "aais-client");
    vi.stubEnv("AAIS_OIDC_CLIENT_SECRET", "oidc-secret-that-must-not-leak");
    vi.stubEnv("AAIS_OIDC_REDIRECT_URI", "https://aais.example.test/api/auth/oidc/callback");
    vi.stubEnv("AAIS_OIDC_AUTHORIZATION_ENDPOINT", "https://idp.example.test/oauth2/authorize");
    vi.stubEnv("AAIS_OIDC_TOKEN_ENDPOINT", "https://idp.example.test/oauth2/token");
    vi.stubEnv("AAIS_OIDC_JWKS_URI", "https://idp.example.test/.well-known/jwks.json");
    vi.stubEnv("AAIS_OIDC_ADMIN_EMAILS", "admin@example.test");
    const { GET } = await import("@/app/api/system/readiness/route");

    const response = await GET();
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body).toMatchObject({
      status: "ready",
      runtime: "production",
      checks: {
        trialAccounts: {
          status: "disabled",
          configured: false,
          accountCount: 0,
        },
      },
      secrets: "redacted",
    });
    expect(body.issues).not.toContain("AAIS_TRIAL_ACCOUNTS_JSON");
    expect(body.checks.oidc.roleMapping).toMatchObject({
      status: "ok",
      configured: true,
      present: ["AAIS_OIDC_ADMIN_EMAILS"],
      redaction: "names-only",
    });
    expect(JSON.stringify(body)).not.toContain("database-secret");
    expect(JSON.stringify(body)).not.toContain("lrs-password-that-must-not-leak");
    expect(JSON.stringify(body)).not.toContain("oidc-secret-that-must-not-leak");
    expect(JSON.stringify(body)).not.toContain("admin@example.test");
  });

  it("accepts a standard Vercel Neon DATABASE_URL when AAIS_DATABASE_URL is not set", async () => {
    vi.stubEnv("AAIS_SESSION_SECRET", "session-secret-that-must-not-leak");
    vi.stubEnv("AAIS_TRIAL_LOGIN_ENABLED", "false");
    vi.stubEnv("DATABASE_URL", "postgres://aais:database-secret@ep-prod.us-east-1.aws.neon.tech/aais");
    vi.stubEnv("LRS_ENDPOINT", "https://lrs.example.test/xapi");
    vi.stubEnv("LRS_USERNAME", "lrs-user");
    vi.stubEnv("LRS_PASSWORD", "lrs-password-that-must-not-leak");
    stubMonitoringEnv();
    vi.stubEnv("AAIS_OIDC_ISSUER", "https://idp.example.test");
    vi.stubEnv("AAIS_OIDC_CLIENT_ID", "aais-client");
    vi.stubEnv("AAIS_OIDC_CLIENT_SECRET", "oidc-secret-that-must-not-leak");
    vi.stubEnv("AAIS_OIDC_REDIRECT_URI", "https://aais.example.test/api/auth/oidc/callback");
    vi.stubEnv("AAIS_OIDC_AUTHORIZATION_ENDPOINT", "https://idp.example.test/oauth2/authorize");
    vi.stubEnv("AAIS_OIDC_TOKEN_ENDPOINT", "https://idp.example.test/oauth2/token");
    vi.stubEnv("AAIS_OIDC_JWKS_URI", "https://idp.example.test/.well-known/jwks.json");
    vi.stubEnv("AAIS_OIDC_TEACHER_GROUPS", "aais-teachers");
    const { GET } = await import("@/app/api/system/readiness/route");

    const response = await GET();
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body).toMatchObject({
      status: "ready",
      checks: {
        storage: {
          status: "ok",
          mode: "postgres",
          provider: "neon",
          probe: "connected",
          sourceEnv: "DATABASE_URL",
        },
      },
    });
    expect(body.issues).not.toContain("AAIS_DATABASE_URL");
    expect(JSON.stringify(body)).not.toContain("database-secret");
    expect(JSON.stringify(body)).not.toContain("aais-teachers");
  });

  it("reports ready for current-stage trial auth production without OIDC provider variables", async () => {
    vi.stubEnv("AAIS_SESSION_SECRET", "session-secret-that-must-not-leak");
    vi.stubEnv("AAIS_TRIAL_ACCOUNTS_JSON", trialAccountConfig);
    vi.stubEnv("DATABASE_URL", "postgres://aais:database-secret@ep-prod.us-east-1.aws.neon.tech/aais");
    vi.stubEnv("LRS_ENDPOINT", "https://lrs.example.test/xapi");
    vi.stubEnv("LRS_USERNAME", "lrs-user");
    vi.stubEnv("LRS_PASSWORD", "lrs-password-that-must-not-leak");
    stubMonitoringEnv();
    const { GET } = await import("@/app/api/system/readiness/route");

    const response = await GET();
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body).toMatchObject({
      status: "ready",
      checks: {
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
          sourceEnv: "DATABASE_URL",
        },
        oidc: {
          status: "ok",
          mode: "missing",
          roleMapping: {
            status: "missing",
            configured: false,
            present: [],
          },
        },
      },
    });
    expect(body.issues).not.toContain("AAIS_OIDC_*");
    expect(body.issues).not.toContain("AAIS_OIDC_ROLE_MAPPING");
    expect(JSON.stringify(body)).not.toContain("database-secret");
  });

  it("reports missing operational evidence as warnings in traffic readiness mode", async () => {
    vi.stubEnv("AAIS_SESSION_SECRET", "session-secret-that-must-not-leak");
    vi.stubEnv("AAIS_TRIAL_ACCOUNTS_JSON", trialAccountConfig);
    vi.stubEnv("DATABASE_URL", "postgres://aais:database-secret@ep-prod.us-east-1.aws.neon.tech/aais");
    vi.stubEnv("AAIS_READINESS_MODE", "traffic");
    const { GET } = await import("@/app/api/system/readiness/route");

    const response = await GET();
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body).toMatchObject({
      status: "ready",
      readinessMode: "traffic",
      checks: {
        monitoring: {
          status: "missing",
          sentry: {
            status: "missing",
            dsnConfigured: false,
            source: "missing",
            alertsConfigured: false,
          },
          uptime: {
            status: "missing",
            loginCheckConfigured: false,
            source: "missing",
          },
          cron: {
            status: "missing",
            scheduleConfigured: true,
            secretConfigured: false,
            alertsConfigured: false,
          },
        },
      },
    });
    expect(body.issues).toEqual([]);
    expect(body.warnings).toEqual(
      expect.arrayContaining([
        "LRS_ENDPOINT/LRS_USERNAME/LRS_PASSWORD",
        "SENTRY_DSN/NEXT_PUBLIC_SENTRY_DSN",
        "AAIS_SENTRY_ALERTS_CONFIGURED",
        "AAIS_UPTIME_LOGIN_CHECK_URL",
        "CRON_SECRET",
        "AAIS_CRON_FAILURE_ALERTS_CONFIGURED",
      ]),
    );
    expect(JSON.stringify(body)).not.toContain("database-secret");
  });

  it("uses bundled Qwen evaluation evidence when the configured manifest belongs to an older model", async () => {
    vi.stubEnv("AAIS_SESSION_SECRET", "session-secret-that-must-not-leak");
    vi.stubEnv("AAIS_TRIAL_ACCOUNTS_JSON", trialAccountConfig);
    vi.stubEnv("DATABASE_URL", "postgres://aais:database-secret@ep-prod.us-east-1.aws.neon.tech/aais");
    vi.stubEnv("CRON_SECRET", "cron-secret-that-must-not-leak");
    vi.stubEnv("AAIS_READINESS_MODE", "traffic");
    vi.stubEnv("AAIS_AI_PROVIDER", "qwen");
    vi.stubEnv("DASHSCOPE_API_KEY", "dashscope-secret-that-must-not-leak");
    vi.stubEnv("AAIS_AI_MODEL", "qwen3.7-max");
    vi.stubEnv("AAIS_AI_EVAL_APPROVED", "true");
    vi.stubEnv("AAIS_AI_EVAL_VERSION", "eval-for-an-older-model");
    vi.stubEnv("AAIS_AI_EVAL_MANIFEST_JSON", JSON.stringify(passingAiEvalManifest()));
    const { GET } = await import("@/app/api/system/readiness/route");

    const response = await GET();
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body).toMatchObject({
      status: "ready",
      readinessMode: "traffic",
      checks: {
        ai: {
          status: "ok",
          provider: "openai-compatible",
          evalVersion: "eval-2026-07-19-qwen3.7-max-v1",
          evalManifest: "verified",
          evalSource: "bundled",
          modelFingerprint: modelFingerprint("qwen3.7-max"),
        },
      },
      issues: [],
    });
    expect(body.warnings).toEqual(expect.arrayContaining([
      "LRS_ENDPOINT/LRS_USERNAME/LRS_PASSWORD",
      "SENTRY_DSN/NEXT_PUBLIC_SENTRY_DSN",
      "AAIS_UPTIME_LOGIN_CHECK_URL",
      "AAIS_CRON_FAILURE_ALERTS_CONFIGURED",
    ]));
    expect(JSON.stringify(body)).not.toContain("dashscope-secret-that-must-not-leak");
  });

  it("accepts OIDC issuer discovery when explicit provider endpoints are not set", async () => {
    vi.stubEnv("AAIS_SESSION_SECRET", "session-secret-that-must-not-leak");
    vi.stubEnv("AAIS_TRIAL_LOGIN_ENABLED", "false");
    vi.stubEnv("AAIS_DATABASE_URL", "postgres://aais:database-secret@example.test/aais");
    vi.stubEnv("LRS_ENDPOINT", "https://lrs.example.test/xapi");
    vi.stubEnv("LRS_USERNAME", "lrs-user");
    vi.stubEnv("LRS_PASSWORD", "lrs-password-that-must-not-leak");
    stubMonitoringEnv();
    vi.stubEnv("AAIS_OIDC_ISSUER", "https://idp.example.test");
    vi.stubEnv("AAIS_OIDC_CLIENT_ID", "aais-client");
    vi.stubEnv("AAIS_OIDC_CLIENT_SECRET", "oidc-secret-that-must-not-leak");
    vi.stubEnv("AAIS_OIDC_REDIRECT_URI", "https://aais.example.test/api/auth/oidc/callback");
    vi.stubEnv("AAIS_OIDC_TEACHER_GROUPS", "aais-teachers");
    const { GET } = await import("@/app/api/system/readiness/route");

    const response = await GET();
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.checks.oidc).toMatchObject({
      status: "ok",
      mode: "discovery",
    });
    expect(body.issues).not.toContain("AAIS_OIDC_*");
    expect(body.issues).not.toContain("AAIS_OIDC_ROLE_MAPPING");
    expect(JSON.stringify(body)).not.toContain("oidc-secret-that-must-not-leak");
    expect(JSON.stringify(body)).not.toContain("aais-teachers");
  });

  it("fails closed when production OIDC is configured without a teacher or admin role mapping", async () => {
    vi.stubEnv("AAIS_SESSION_SECRET", "session-secret-that-must-not-leak");
    vi.stubEnv("AAIS_TRIAL_LOGIN_ENABLED", "false");
    vi.stubEnv("AAIS_DATABASE_URL", "postgres://aais:database-secret@example.test/aais");
    vi.stubEnv("LRS_ENDPOINT", "https://lrs.example.test/xapi");
    vi.stubEnv("LRS_USERNAME", "lrs-user");
    vi.stubEnv("LRS_PASSWORD", "lrs-password-that-must-not-leak");
    stubMonitoringEnv();
    vi.stubEnv("AAIS_OIDC_ISSUER", "https://idp.example.test");
    vi.stubEnv("AAIS_OIDC_CLIENT_ID", "aais-client");
    vi.stubEnv("AAIS_OIDC_CLIENT_SECRET", "oidc-secret-that-must-not-leak");
    vi.stubEnv("AAIS_OIDC_REDIRECT_URI", "https://aais.example.test/api/auth/oidc/callback");
    vi.stubEnv("AAIS_OIDC_AUTHORIZATION_ENDPOINT", "https://idp.example.test/oauth2/authorize");
    vi.stubEnv("AAIS_OIDC_TOKEN_ENDPOINT", "https://idp.example.test/oauth2/token");
    vi.stubEnv("AAIS_OIDC_JWKS_URI", "https://idp.example.test/.well-known/jwks.json");
    const { GET } = await import("@/app/api/system/readiness/route");

    const response = await GET();
    const body = await response.json();

    expect(response.status).toBe(503);
    expect(body).toMatchObject({
      status: "not_ready",
      checks: {
        oidc: {
          status: "blocked",
          mode: "explicit",
          roleMapping: {
            status: "missing",
            configured: false,
            present: [],
            acceptedNames: [
              "AAIS_OIDC_TEACHER_GROUPS",
              "AAIS_OIDC_TEACHER_EMAILS",
              "AAIS_OIDC_ADMIN_GROUPS",
              "AAIS_OIDC_ADMIN_EMAILS",
            ],
            redaction: "names-only",
          },
        },
      },
      secrets: "redacted",
    });
    expect(body.issues).toEqual(expect.arrayContaining(["AAIS_OIDC_ROLE_MAPPING"]));
    expect(JSON.stringify(body)).not.toContain("database-secret");
    expect(JSON.stringify(body)).not.toContain("oidc-secret-that-must-not-leak");
  });

  it("fails closed when production OIDC explicit endpoints are partially configured", async () => {
    vi.stubEnv("AAIS_SESSION_SECRET", "session-secret-that-must-not-leak");
    vi.stubEnv("AAIS_TRIAL_LOGIN_ENABLED", "false");
    vi.stubEnv("AAIS_DATABASE_URL", "postgres://aais:database-secret@example.test/aais");
    vi.stubEnv("LRS_ENDPOINT", "https://lrs.example.test/xapi");
    vi.stubEnv("LRS_USERNAME", "lrs-user");
    vi.stubEnv("LRS_PASSWORD", "lrs-password-that-must-not-leak");
    stubMonitoringEnv();
    vi.stubEnv("AAIS_OIDC_ISSUER", "https://idp.example.test");
    vi.stubEnv("AAIS_OIDC_CLIENT_ID", "aais-client");
    vi.stubEnv("AAIS_OIDC_CLIENT_SECRET", "oidc-secret-that-must-not-leak");
    vi.stubEnv("AAIS_OIDC_REDIRECT_URI", "https://aais.example.test/api/auth/oidc/callback");
    vi.stubEnv("AAIS_OIDC_AUTHORIZATION_ENDPOINT", "https://idp.example.test/oauth2/authorize");
    vi.stubEnv("AAIS_OIDC_TEACHER_GROUPS", "aais-teachers");
    vi.stubEnv("AAIS_AI_PROVIDER", "deterministic");
    const { GET } = await import("@/app/api/system/readiness/route");

    const response = await GET();
    const body = await response.json();

    expect(response.status).toBe(503);
    expect(body.checks.oidc).toMatchObject({
      status: "missing",
      mode: "missing",
      roleMapping: {
        status: "ok",
        configured: true,
        present: ["AAIS_OIDC_TEACHER_GROUPS"],
        redaction: "names-only",
      },
    });
    expect(body.issues).toContain("AAIS_OIDC_*");
    expect(body.issues).not.toContain("AAIS_OIDC_ROLE_MAPPING");
    expect(JSON.stringify(body)).not.toContain("oidc-secret-that-must-not-leak");
    expect(JSON.stringify(body)).not.toContain("aais-teachers");
  });

  it("fails closed when production is missing enterprise runtime configuration", async () => {
    vi.stubEnv("AAIS_READINESS_MODE", "enterprise");
    const { GET } = await import("@/app/api/system/readiness/route");

    const response = await GET();
    const body = await response.json();

    expect(response.status).toBe(503);
    expect(body.status).toBe("not_ready");
    expect(body.readinessMode).toBe("enterprise");
    expect(body.issues).toEqual(
      expect.arrayContaining([
        "AAIS_SESSION_SECRET",
        "AAIS_TRIAL_ACCOUNTS_JSON",
        "AAIS_DATABASE_URL",
        "LRS_ENDPOINT/LRS_USERNAME/LRS_PASSWORD",
        "SENTRY_DSN/NEXT_PUBLIC_SENTRY_DSN",
        "AAIS_SENTRY_ALERTS_CONFIGURED",
        "AAIS_UPTIME_LOGIN_CHECK_URL",
        "CRON_SECRET",
        "AAIS_CRON_FAILURE_ALERTS_CONFIGURED",
      ]),
    );
    expect(body.secrets).toBe("redacted");
  });

  it("reports Qwen DashScope alias configuration as live AI in development", async () => {
    vi.stubEnv("NODE_ENV", "development");
    vi.stubEnv("AAIS_AI_PROVIDER", "qwen");
    vi.stubEnv("DASHSCOPE_API_KEY", "dashscope-secret-that-must-not-leak");
    vi.stubEnv("AAIS_AI_MODEL", "qwen3.7-max");
    const { GET } = await import("@/app/api/system/readiness/route");

    const response = await GET();
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.checks.ai).toMatchObject({
      status: "ok",
      provider: "openai-compatible",
      evalVersion: null,
      evalManifest: "not-required",
      modelFingerprint: modelFingerprint("qwen3.7-max"),
      runtimeProfile: {
        mode: "live",
        primary: {
          provider: "qwen",
          modelFingerprint: modelFingerprint("qwen3.7-max"),
          thinkingMode: "disabled",
          timeoutMs: {
            configured: null,
            effective: 12000,
            clamped: false,
            max: 30000,
          },
          maxRetries: 1,
        },
        fallback: null,
        redaction: {
          secrets: "omitted",
          endpoints: "omitted",
        },
      },
    });
    expect(JSON.stringify(body)).not.toContain("dashscope-secret-that-must-not-leak");
    expect(JSON.stringify(body)).not.toContain("dashscope.aliyuncs.com");
  });

  it("requires a verified AI evaluation manifest before production live AI is ready", async () => {
    vi.stubEnv("AAIS_SESSION_SECRET", "session-secret-that-must-not-leak");
    vi.stubEnv("AAIS_TRIAL_ACCOUNTS_JSON", trialAccountConfig);
    vi.stubEnv("AAIS_DATABASE_URL", "postgres://aais:database-secret@example.test/aais");
    vi.stubEnv("LRS_ENDPOINT", "https://lrs.example.test/xapi");
    vi.stubEnv("LRS_USERNAME", "lrs-user");
    vi.stubEnv("LRS_PASSWORD", "lrs-password-that-must-not-leak");
    stubMonitoringEnv();
    vi.stubEnv("AAIS_OIDC_ISSUER", "https://idp.example.test");
    vi.stubEnv("AAIS_OIDC_CLIENT_ID", "aais-client");
    vi.stubEnv("AAIS_OIDC_CLIENT_SECRET", "oidc-secret-that-must-not-leak");
    vi.stubEnv("AAIS_OIDC_REDIRECT_URI", "https://aais.example.test/api/auth/oidc/callback");
    vi.stubEnv("AAIS_OIDC_AUTHORIZATION_ENDPOINT", "https://idp.example.test/oauth2/authorize");
    vi.stubEnv("AAIS_OIDC_TOKEN_ENDPOINT", "https://idp.example.test/oauth2/token");
    vi.stubEnv("AAIS_OIDC_JWKS_URI", "https://idp.example.test/.well-known/jwks.json");
    vi.stubEnv("AAIS_AI_PROVIDER", "openai-compatible");
    vi.stubEnv("AAIS_AI_ENDPOINT", "https://ai.example.test/v1/chat/completions");
    vi.stubEnv("AAIS_AI_API_KEY", "ai-secret-that-must-not-leak");
    vi.stubEnv("AAIS_AI_MODEL", "enterprise-model");
    vi.stubEnv("AAIS_AI_EVAL_APPROVED", "true");
    vi.stubEnv("AAIS_AI_EVAL_VERSION", "eval-2026-06-30");
    vi.stubEnv("AAIS_AI_EVAL_MANIFEST_PATH", path.join(tempDir, "missing.json"));
    const { GET } = await import("@/app/api/system/readiness/route");

    const response = await GET();
    const body = await response.json();

    expect(response.status).toBe(503);
    expect(body.status).toBe("not_ready");
    expect(body.checks.ai).toMatchObject({
      status: "blocked",
      provider: "openai-compatible",
      evalVersion: "eval-2026-06-30",
      evalManifest: "missing",
    });
    expect(body.issues).toEqual(
      expect.arrayContaining(["AAIS_AI_EVAL_MANIFEST"]),
    );
    expect(JSON.stringify(body)).not.toContain("ai-secret-that-must-not-leak");
    expect(JSON.stringify(body)).not.toContain("cron-secret-that-must-not-leak");
    expect(JSON.stringify(body)).not.toContain("private@example.ingest.sentry.io");
  });

  it("accepts a redacted inline AI evaluation manifest JSON for Vercel production", async () => {
    vi.stubEnv("AAIS_SESSION_SECRET", "session-secret-that-must-not-leak");
    vi.stubEnv("AAIS_TRIAL_ACCOUNTS_JSON", trialAccountConfig);
    vi.stubEnv("AAIS_DATABASE_URL", "postgres://aais:database-secret@example.test/aais");
    vi.stubEnv("LRS_ENDPOINT", "https://lrs.example.test/xapi");
    vi.stubEnv("LRS_USERNAME", "lrs-user");
    vi.stubEnv("LRS_PASSWORD", "lrs-password-that-must-not-leak");
    stubMonitoringEnv();
    vi.stubEnv("AAIS_OIDC_ISSUER", "https://idp.example.test");
    vi.stubEnv("AAIS_OIDC_CLIENT_ID", "aais-client");
    vi.stubEnv("AAIS_OIDC_CLIENT_SECRET", "oidc-secret-that-must-not-leak");
    vi.stubEnv("AAIS_OIDC_REDIRECT_URI", "https://aais.example.test/api/auth/oidc/callback");
    vi.stubEnv("AAIS_OIDC_TEACHER_GROUPS", "aais-teachers");
    vi.stubEnv("AAIS_AI_PROVIDER", "openai-compatible");
    vi.stubEnv("AAIS_AI_ENDPOINT", "https://ai.example.test/v1/chat/completions");
    vi.stubEnv("AAIS_AI_API_KEY", "ai-secret-that-must-not-leak");
    vi.stubEnv("AAIS_AI_MODEL", "enterprise-model");
    vi.stubEnv("AAIS_AI_EVAL_APPROVED", "true");
    vi.stubEnv("AAIS_AI_EVAL_VERSION", "eval-2026-06-30");
    vi.stubEnv("AAIS_AI_EVAL_MANIFEST_JSON", JSON.stringify(passingAiEvalManifest()));
    const { GET } = await import("@/app/api/system/readiness/route");

    const response = await GET();
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.checks.ai).toMatchObject({
      status: "ok",
      provider: "openai-compatible",
      evalVersion: "eval-2026-06-30",
      evalManifest: "verified",
      modelFingerprint: modelFingerprint("enterprise-model"),
    });
    const serialized = JSON.stringify(body);
    expect(serialized).not.toContain("enterprise-model");
    expect(serialized).not.toContain("ai-secret-that-must-not-leak");
  });

  it("rejects inline AI evaluation manifests with mismatched A1-A4 role coverage", async () => {
    vi.stubEnv("AAIS_SESSION_SECRET", "session-secret-that-must-not-leak");
    vi.stubEnv("AAIS_TRIAL_ACCOUNTS_JSON", trialAccountConfig);
    vi.stubEnv("AAIS_DATABASE_URL", "postgres://aais:database-secret@example.test/aais");
    vi.stubEnv("LRS_ENDPOINT", "https://lrs.example.test/xapi");
    vi.stubEnv("LRS_USERNAME", "lrs-user");
    vi.stubEnv("LRS_PASSWORD", "lrs-password-that-must-not-leak");
    vi.stubEnv("AAIS_OIDC_ISSUER", "https://idp.example.test");
    vi.stubEnv("AAIS_OIDC_CLIENT_ID", "aais-client");
    vi.stubEnv("AAIS_OIDC_CLIENT_SECRET", "oidc-secret-that-must-not-leak");
    vi.stubEnv("AAIS_OIDC_REDIRECT_URI", "https://aais.example.test/api/auth/oidc/callback");
    vi.stubEnv("AAIS_OIDC_TEACHER_GROUPS", "aais-teachers");
    vi.stubEnv("AAIS_AI_PROVIDER", "openai-compatible");
    vi.stubEnv("AAIS_AI_ENDPOINT", "https://ai.example.test/v1/chat/completions");
    vi.stubEnv("AAIS_AI_API_KEY", "ai-secret-that-must-not-leak");
    vi.stubEnv("AAIS_AI_MODEL", "enterprise-model");
    vi.stubEnv("AAIS_AI_EVAL_APPROVED", "true");
    vi.stubEnv("AAIS_AI_EVAL_VERSION", "eval-2026-06-30");
    const agentEvidence = passingAiEvalManifest().agentEvidence;
    vi.stubEnv("AAIS_AI_EVAL_MANIFEST_JSON", JSON.stringify(passingAiEvalManifest({
      agentEvidence: {
        ...agentEvidence,
        coverage: passingAiEvalAgentCoverage({
          A2: {
            label: "专家智能体",
            responsibility: "backend-supervision-a1-signal",
            sampleIds: ["a2-expert-modelling-coaching"],
            caModules: ["Modelling", "Coaching"],
            complete: true,
          },
        }),
      },
    })));
    const { GET } = await import("@/app/api/system/readiness/route");

    const response = await GET();
    const body = await response.json();

    expect(response.status).toBe(503);
    expect(body.checks.ai).toMatchObject({
      status: "blocked",
      provider: "openai-compatible",
      evalVersion: "eval-2026-06-30",
      evalManifest: "mismatch",
    });
    expect(body.issues).toEqual(expect.arrayContaining(["AAIS_AI_EVAL_MANIFEST"]));
    expect(JSON.stringify(body)).not.toContain("ai-secret-that-must-not-leak");
  });

  it("rejects AI evaluation manifests that report blocked samples", async () => {
    vi.stubEnv("AAIS_SESSION_SECRET", "session-secret-that-must-not-leak");
    vi.stubEnv("AAIS_TRIAL_ACCOUNTS_JSON", trialAccountConfig);
    vi.stubEnv("AAIS_DATABASE_URL", "postgres://aais:database-secret@example.test/aais");
    vi.stubEnv("LRS_ENDPOINT", "https://lrs.example.test/xapi");
    vi.stubEnv("LRS_USERNAME", "lrs-user");
    vi.stubEnv("LRS_PASSWORD", "lrs-password-that-must-not-leak");
    vi.stubEnv("AAIS_OIDC_ISSUER", "https://idp.example.test");
    vi.stubEnv("AAIS_OIDC_CLIENT_ID", "aais-client");
    vi.stubEnv("AAIS_OIDC_CLIENT_SECRET", "oidc-secret-that-must-not-leak");
    vi.stubEnv("AAIS_OIDC_REDIRECT_URI", "https://aais.example.test/api/auth/oidc/callback");
    vi.stubEnv("AAIS_OIDC_AUTHORIZATION_ENDPOINT", "https://idp.example.test/oauth2/authorize");
    vi.stubEnv("AAIS_OIDC_TOKEN_ENDPOINT", "https://idp.example.test/oauth2/token");
    vi.stubEnv("AAIS_OIDC_JWKS_URI", "https://idp.example.test/.well-known/jwks.json");
    vi.stubEnv("AAIS_AI_PROVIDER", "openai-compatible");
    vi.stubEnv("AAIS_AI_ENDPOINT", "https://ai.example.test/v1/chat/completions");
    vi.stubEnv("AAIS_AI_API_KEY", "ai-secret-that-must-not-leak");
    vi.stubEnv("AAIS_AI_MODEL", "enterprise-model");
    vi.stubEnv("AAIS_AI_EVAL_APPROVED", "true");
    vi.stubEnv("AAIS_AI_EVAL_VERSION", "eval-2026-06-30");
    const manifestPath = path.join(tempDir, "aais-ai-eval-blocked.json");
    await writeFile(
      manifestPath,
      JSON.stringify(passingAiEvalManifest({ blockedCount: 1 })),
      "utf8",
    );
    vi.stubEnv("AAIS_AI_EVAL_MANIFEST_PATH", manifestPath);
    const { GET } = await import("@/app/api/system/readiness/route");

    const response = await GET();
    const body = await response.json();

    expect(response.status).toBe(503);
    expect(body.checks.ai).toMatchObject({
      status: "blocked",
      evalManifest: "mismatch",
    });
    expect(body.issues).toEqual(expect.arrayContaining(["AAIS_AI_EVAL_MANIFEST"]));
  });

  it("fails closed when production database connectivity or schema probe fails", async () => {
    databaseProbeMode = "error";
    vi.stubEnv("AAIS_SESSION_SECRET", "session-secret-that-must-not-leak");
    vi.stubEnv("AAIS_TRIAL_ACCOUNTS_JSON", trialAccountConfig);
    vi.stubEnv("AAIS_DATABASE_URL", "postgres://aais:database-secret@example.test/aais");
    vi.stubEnv("LRS_ENDPOINT", "https://lrs.example.test/xapi");
    vi.stubEnv("LRS_USERNAME", "lrs-user");
    vi.stubEnv("LRS_PASSWORD", "lrs-password-that-must-not-leak");
    vi.stubEnv("AAIS_OIDC_ISSUER", "https://idp.example.test");
    vi.stubEnv("AAIS_OIDC_CLIENT_ID", "aais-client");
    vi.stubEnv("AAIS_OIDC_CLIENT_SECRET", "oidc-secret-that-must-not-leak");
    vi.stubEnv("AAIS_OIDC_REDIRECT_URI", "https://aais.example.test/api/auth/oidc/callback");
    vi.stubEnv("AAIS_OIDC_AUTHORIZATION_ENDPOINT", "https://idp.example.test/oauth2/authorize");
    vi.stubEnv("AAIS_OIDC_TOKEN_ENDPOINT", "https://idp.example.test/oauth2/token");
    vi.stubEnv("AAIS_OIDC_JWKS_URI", "https://idp.example.test/.well-known/jwks.json");
    const { GET } = await import("@/app/api/system/readiness/route");

    const response = await GET();
    const body = await response.json();

    expect(response.status).toBe(503);
    expect(body).toMatchObject({
      status: "not_ready",
      checks: {
        storage: {
          status: "blocked",
          mode: "postgres",
          probe: "failed",
        },
      },
      secrets: "redacted",
    });
    expect(body.issues).toEqual(expect.arrayContaining(["AAIS_DATABASE_URL_CONNECTIVITY"]));
    expect(JSON.stringify(body)).not.toContain("database-secret");
    expect(JSON.stringify(body)).not.toContain("database unavailable");
  });

  it("fails closed when production database migrations have not created required tables", async () => {
    databaseProbeMode = "missing_schema";
    vi.stubEnv("AAIS_SESSION_SECRET", "session-secret-that-must-not-leak");
    vi.stubEnv("AAIS_TRIAL_ACCOUNTS_JSON", trialAccountConfig);
    vi.stubEnv("AAIS_DATABASE_URL", "postgres://aais:database-secret@example.test/aais");
    vi.stubEnv("LRS_ENDPOINT", "https://lrs.example.test/xapi");
    vi.stubEnv("LRS_USERNAME", "lrs-user");
    vi.stubEnv("LRS_PASSWORD", "lrs-password-that-must-not-leak");
    vi.stubEnv("AAIS_OIDC_ISSUER", "https://idp.example.test");
    vi.stubEnv("AAIS_OIDC_CLIENT_ID", "aais-client");
    vi.stubEnv("AAIS_OIDC_CLIENT_SECRET", "oidc-secret-that-must-not-leak");
    vi.stubEnv("AAIS_OIDC_REDIRECT_URI", "https://aais.example.test/api/auth/oidc/callback");
    vi.stubEnv("AAIS_OIDC_AUTHORIZATION_ENDPOINT", "https://idp.example.test/oauth2/authorize");
    vi.stubEnv("AAIS_OIDC_TOKEN_ENDPOINT", "https://idp.example.test/oauth2/token");
    vi.stubEnv("AAIS_OIDC_JWKS_URI", "https://idp.example.test/.well-known/jwks.json");
    const { GET } = await import("@/app/api/system/readiness/route");

    const response = await GET();
    const body = await response.json();

    expect(response.status).toBe(503);
    expect(body).toMatchObject({
      status: "not_ready",
      checks: {
        storage: {
          status: "blocked",
          mode: "postgres",
          probe: "failed",
        },
      },
      secrets: "redacted",
    });
    expect(body.issues).toEqual(expect.arrayContaining(["AAIS_DATABASE_URL_CONNECTIVITY"]));
    expect(JSON.stringify(body)).not.toContain("database-secret");
  });

  it("fails closed when production trial accounts are not configured", async () => {
    vi.stubEnv("AAIS_SESSION_SECRET", "session-secret-that-must-not-leak");
    vi.stubEnv("AAIS_DATABASE_URL", "postgres://aais:database-secret@example.test/aais");
    vi.stubEnv("LRS_ENDPOINT", "https://lrs.example.test/xapi");
    vi.stubEnv("LRS_USERNAME", "lrs-user");
    vi.stubEnv("LRS_PASSWORD", "lrs-password-that-must-not-leak");
    vi.stubEnv("AAIS_OIDC_ISSUER", "https://idp.example.test");
    vi.stubEnv("AAIS_OIDC_CLIENT_ID", "aais-client");
    vi.stubEnv("AAIS_OIDC_CLIENT_SECRET", "oidc-secret-that-must-not-leak");
    vi.stubEnv("AAIS_OIDC_REDIRECT_URI", "https://aais.example.test/api/auth/oidc/callback");
    vi.stubEnv("AAIS_OIDC_AUTHORIZATION_ENDPOINT", "https://idp.example.test/oauth2/authorize");
    vi.stubEnv("AAIS_OIDC_TOKEN_ENDPOINT", "https://idp.example.test/oauth2/token");
    vi.stubEnv("AAIS_OIDC_JWKS_URI", "https://idp.example.test/.well-known/jwks.json");
    const { GET } = await import("@/app/api/system/readiness/route");

    const response = await GET();
    const body = await response.json();

    expect(response.status).toBe(503);
    expect(body).toMatchObject({
      status: "not_ready",
      checks: {
        trialAccounts: {
          status: "missing",
          configured: false,
          accountCount: 0,
        },
      },
      secrets: "redacted",
    });
    expect(body.issues).toEqual(expect.arrayContaining(["AAIS_TRIAL_ACCOUNTS_JSON"]));
    expect(JSON.stringify(body)).not.toContain("lrs-password-that-must-not-leak");
    expect(JSON.stringify(body)).not.toContain("oidc-secret-that-must-not-leak");
  });

  it("reports invalid production trial account configuration distinctly from missing configuration", async () => {
    vi.stubEnv("AAIS_SESSION_SECRET", "session-secret-that-must-not-leak");
    vi.stubEnv("AAIS_TRIAL_ACCOUNTS_JSON", JSON.stringify([
      {
        id: "Bobie",
        displayName: "Bobie",
        role: "student",
        password: {
          algorithm: "plain-text",
          value: "trial-password-that-must-not-leak",
        },
      },
    ]));
    vi.stubEnv("AAIS_DATABASE_URL", "postgres://aais:database-secret@example.test/aais");
    vi.stubEnv("LRS_ENDPOINT", "https://lrs.example.test/xapi");
    vi.stubEnv("LRS_USERNAME", "lrs-user");
    vi.stubEnv("LRS_PASSWORD", "lrs-password-that-must-not-leak");
    vi.stubEnv("AAIS_OIDC_ISSUER", "https://idp.example.test");
    vi.stubEnv("AAIS_OIDC_CLIENT_ID", "aais-client");
    vi.stubEnv("AAIS_OIDC_CLIENT_SECRET", "oidc-secret-that-must-not-leak");
    vi.stubEnv("AAIS_OIDC_REDIRECT_URI", "https://aais.example.test/api/auth/oidc/callback");
    vi.stubEnv("AAIS_OIDC_AUTHORIZATION_ENDPOINT", "https://idp.example.test/oauth2/authorize");
    vi.stubEnv("AAIS_OIDC_TOKEN_ENDPOINT", "https://idp.example.test/oauth2/token");
    vi.stubEnv("AAIS_OIDC_JWKS_URI", "https://idp.example.test/.well-known/jwks.json");
    const { GET } = await import("@/app/api/system/readiness/route");

    const response = await GET();
    const body = await response.json();

    expect(response.status).toBe(503);
    expect(body).toMatchObject({
      status: "not_ready",
      checks: {
        trialAccounts: {
          status: "invalid",
          configured: false,
          accountCount: 0,
        },
      },
      secrets: "redacted",
    });
    expect(body.issues).toEqual(expect.arrayContaining(["AAIS_TRIAL_ACCOUNTS_JSON"]));
    expect(JSON.stringify(body)).not.toContain("trial-password-that-must-not-leak");
  });

  it("reports production educator trial accounts as invalid so teacher/admin access uses real users", async () => {
    vi.stubEnv("AAIS_SESSION_SECRET", "session-secret-that-must-not-leak");
    vi.stubEnv("AAIS_TRIAL_ACCOUNTS_JSON", JSON.stringify([
      {
        id: "teacher-smoke",
        displayName: "Teacher Smoke",
        role: "teacher",
        password: createPasswordRecord("teacher-password-that-must-not-leak"),
      },
    ]));
    vi.stubEnv("AAIS_DATABASE_URL", "postgres://aais:database-secret@example.test/aais");
    vi.stubEnv("LRS_ENDPOINT", "https://lrs.example.test/xapi");
    vi.stubEnv("LRS_USERNAME", "lrs-user");
    vi.stubEnv("LRS_PASSWORD", "lrs-password-that-must-not-leak");
    vi.stubEnv("AAIS_OIDC_ISSUER", "https://idp.example.test");
    vi.stubEnv("AAIS_OIDC_CLIENT_ID", "aais-client");
    vi.stubEnv("AAIS_OIDC_CLIENT_SECRET", "oidc-secret-that-must-not-leak");
    vi.stubEnv("AAIS_OIDC_REDIRECT_URI", "https://aais.example.test/api/auth/oidc/callback");
    vi.stubEnv("AAIS_OIDC_AUTHORIZATION_ENDPOINT", "https://idp.example.test/oauth2/authorize");
    vi.stubEnv("AAIS_OIDC_TOKEN_ENDPOINT", "https://idp.example.test/oauth2/token");
    vi.stubEnv("AAIS_OIDC_JWKS_URI", "https://idp.example.test/.well-known/jwks.json");
    const { GET } = await import("@/app/api/system/readiness/route");

    const response = await GET();
    const body = await response.json();

    expect(response.status).toBe(503);
    expect(body).toMatchObject({
      status: "not_ready",
      checks: {
        trialAccounts: {
          status: "invalid",
          configured: false,
          accountCount: 0,
        },
      },
      secrets: "redacted",
    });
    expect(body.issues).toEqual(expect.arrayContaining(["AAIS_TRIAL_ACCOUNTS_JSON"]));
    expect(JSON.stringify(body)).not.toContain("teacher-password-that-must-not-leak");
  });
});

function modelFingerprint(model: string) {
  return createHash("sha256")
    .update(`aais-ai-model:${model}`)
    .digest("hex")
    .slice(0, 16);
}
