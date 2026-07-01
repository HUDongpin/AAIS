import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createPasswordRecord } from "@/lib/server/aais-trial-accounts";

let databaseProbeMode: "ok" | "error" = "ok";

vi.mock("pg", () => ({
  Pool: class {
    async query(sql: string) {
      if (databaseProbeMode === "error") {
        throw new Error("database unavailable");
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
  "AAIS_DATABASE_URL",
  "DATABASE_URL",
  "POSTGRES_URL",
  "DATABASE_URL_UNPOOLED",
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
  "AAIS_AI_EVAL_APPROVED",
  "AAIS_AI_EVAL_VERSION",
  "AAIS_AI_EVAL_MANIFEST_PATH",
  "AAIS_RELEASE_ID",
  "AAIS_DEPLOYMENT_GIT_COMMIT_SHA",
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

beforeEach(async () => {
  tempDir = await mkdtemp(path.join(tmpdir(), "aais-readiness-"));
  databaseProbeMode = "ok";
  vi.resetModules();
  vi.stubEnv("NODE_ENV", "production");
  for (const key of enterpriseEnv) {
    vi.stubEnv(key, "");
  }
});

afterEach(async () => {
  vi.unstubAllEnvs();
  await rm(tempDir, { force: true, recursive: true });
});

describe("AAIS readiness route", () => {
  it("reports a redacted ready status when enterprise production configuration is complete", async () => {
    vi.stubEnv("AAIS_SESSION_SECRET", "session-secret-that-must-not-leak");
    vi.stubEnv("AAIS_TRIAL_ACCOUNTS_JSON", trialAccountConfig);
    vi.stubEnv("AAIS_DATABASE_URL", "postgres://aais:database-secret@ep-prod.us-east-1.aws.neon.tech/aais");
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
      JSON.stringify({
        schemaVersion: 1,
        evalVersion: "eval-2026-06-30",
        provider: "openai-compatible",
        model: "enterprise-model",
        status: "passed",
        passedAt: "2026-06-30T00:00:00.000Z",
        sampleCount: 8,
        blockedCount: 0,
        redaction: {
          prompts: "summarized",
          secrets: "omitted",
        },
      }),
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
        a2Monitoring: {
          status: "ok",
          enabled: true,
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

  it("accepts OIDC issuer discovery when explicit provider endpoints are not set", async () => {
    vi.stubEnv("AAIS_SESSION_SECRET", "session-secret-that-must-not-leak");
    vi.stubEnv("AAIS_TRIAL_LOGIN_ENABLED", "false");
    vi.stubEnv("AAIS_DATABASE_URL", "postgres://aais:database-secret@example.test/aais");
    vi.stubEnv("LRS_ENDPOINT", "https://lrs.example.test/xapi");
    vi.stubEnv("LRS_USERNAME", "lrs-user");
    vi.stubEnv("LRS_PASSWORD", "lrs-password-that-must-not-leak");
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

  it("fails closed when production is missing enterprise runtime configuration", async () => {
    const { GET } = await import("@/app/api/system/readiness/route");

    const response = await GET();
    const body = await response.json();

    expect(response.status).toBe(503);
    expect(body.status).toBe("not_ready");
    expect(body.issues).toEqual(
      expect.arrayContaining([
        "AAIS_SESSION_SECRET",
        "AAIS_TRIAL_ACCOUNTS_JSON",
        "AAIS_DATABASE_URL",
        "LRS_ENDPOINT/LRS_USERNAME/LRS_PASSWORD",
        "AAIS_OIDC_*",
      ]),
    );
    expect(body.secrets).toBe("redacted");
  });

  it("requires a verified AI evaluation manifest before production live AI is ready", async () => {
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
  });

  it("accepts a redacted inline AI evaluation manifest JSON for Vercel production", async () => {
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
    vi.stubEnv("AAIS_AI_EVAL_MANIFEST_JSON", JSON.stringify({
      schemaVersion: 1,
      evalVersion: "eval-2026-06-30",
      provider: "openai-compatible",
      model: "enterprise-model",
      status: "passed",
      passedAt: "2026-06-30T00:00:00.000Z",
      sampleCount: 8,
      blockedCount: 0,
      redaction: {
        prompts: "summarized",
        secrets: "omitted",
      },
    }));
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
      JSON.stringify({
        schemaVersion: 1,
        evalVersion: "eval-2026-06-30",
        provider: "openai-compatible",
        model: "enterprise-model",
        status: "passed",
        passedAt: "2026-06-30T00:00:00.000Z",
        sampleCount: 8,
        blockedCount: 1,
        redaction: {
          prompts: "summarized",
          secrets: "omitted",
        },
      }),
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
});

function modelFingerprint(model: string) {
  return createHash("sha256")
    .update(`aais-ai-model:${model}`)
    .digest("hex")
    .slice(0, 16);
}
