import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createHash, generateKeyPairSync } from "node:crypto";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createAaisSessionToken,
  getAaisSessionCookieName,
} from "@/lib/server/aais-session";
import { createPasswordRecord } from "@/lib/server/aais-trial-accounts";

let databaseProbeMode: "ok" | "missing_schema" | "error" = "ok";
let researchDatabaseProbeMode: "ok" | "missing_schema" | "error" = "ok";
const receiptVerifyingKey = generateKeyPairSync("ed25519").publicKey;
const receiptVerifyingSpki = receiptVerifyingKey
  .export({ format: "der", type: "spki" })
  .toString("base64");

const readyResearchSchemaRow = {
  identity_schema: true,
  participants_table: true,
  identity_map_table: true,
  participation_ledger_table: true,
  visits_table: true,
  events_table: true,
  outbox_table: true,
  export_audit_table: true,
  withdrawals_table: true,
  deletions_table: true,
  retention_runs_table: true,
  legacy_archives_table: true,
  identity_nonce_constraints: true,
  participation_ledger_constraints: true,
  required_functions: true,
};

vi.mock("pg", () => ({
  Pool: class {
    async query(sql: string) {
      if (/aais_research_participants/i.test(sql)) {
        if (researchDatabaseProbeMode === "error") {
          throw new Error("research database unavailable");
        }
        return {
          rows: [{
            ...readyResearchSchemaRow,
            ...(researchDatabaseProbeMode === "missing_schema"
              ? { outbox_table: false }
              : {}),
          }],
        };
      }
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

    async end() {}
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
  "POSTGRES_HOST",
  "POSTGRES_HOST_NON_POOLING",
  "POSTGRES_PORT",
  "POSTGRES_USER",
  "POSTGRES_DATABASE",
  "POSTGRES_PASSWORD",
  "POSTGRES_SSLMODE",
  "LRS_ENDPOINT",
  "LRS_USERNAME",
  "LRS_PASSWORD",
  "SENTRY_DSN",
  "NEXT_PUBLIC_SENTRY_DSN",
  "AAIS_SENTRY_ALERTS_CONFIGURED",
  "AAIS_UPTIME_LOGIN_CHECK_URL",
  "CRON_SECRET",
  "AAIS_LRS_OUTBOX_FLUSH_TOKEN",
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
  "AAIS_OIDC_RESEARCHER_GROUPS",
  "AAIS_OIDC_RESEARCHER_EMAILS",
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
  "AAIS_RESEARCH_MODE",
  "AAIS_RESEARCH_REQUIRED",
  "AAIS_RESEARCH_DATABASE_URL",
  "AAIS_RESEARCH_DATABASE_INSTANCE_ID",
  "AAIS_RESEARCH_DATABASE_DRIVER",
  "AAIS_RESEARCH_PROJECT_ID",
  "AAIS_RESEARCH_STUDY_ID",
  "AAIS_RESEARCH_ENVIRONMENT",
  "AAIS_RESEARCH_REHEARSAL_APPROVED",
  "AAIS_RESEARCH_REHEARSAL_MODE",
  "AAIS_RESEARCH_IDENTITY_ENCRYPTION_KEY",
  "AAIS_RESEARCH_IDENTITY_FINGERPRINT_KEY",
  "AAIS_RESEARCH_PARTICIPANT_ACTOR_IDS",
  "AAIS_RESEARCH_IDENTITY_KEY_VERSION",
  "AAIS_RESEARCH_CONDITIONS",
  "AAIS_RESEARCH_LRS_NAMESPACE",
  "AAIS_RESEARCH_LRS_STORE_ID",
  "AAIS_RESEARCH_LRS_ENDPOINT",
  "AAIS_RESEARCH_LRS_USERNAME",
  "AAIS_RESEARCH_LRS_PASSWORD",
  "AAIS_RESEARCH_LRS_RECEIPT_VERIFYING_KEY_ID",
  "AAIS_RESEARCH_LRS_RECEIPT_VERIFYING_KEY_SPKI",
  "AAIS_RESEARCH_PI_ACTOR_IDS",
  "AAIS_RESEARCH_DATA_CUSTODIAN_ACTOR_IDS",
  "AAIS_RESEARCH_EXPORT_ACTOR_IDS",
  "AAIS_RESEARCH_EXPORT_ENABLED",
  "AAIS_RESEARCH_LRS_OUTBOX_FLUSH_TOKEN",
  "AAIS_RESEARCH_RETENTION_TOKEN",
  "AAIS_RESEARCH_LRS_EVENT_FLUSH_SCHEDULE_ID",
  "AAIS_RESEARCH_LRS_DELETION_SCHEDULE_ID",
  "AAIS_RESEARCH_RETENTION_SCHEDULE_ID",
  "AAIS_RESEARCH_DATABASE_ISOLATION_RECEIPT_SHA256",
  "AAIS_RESEARCH_LRS_ISOLATION_RECEIPT_SHA256",
  "AAIS_RESEARCH_LRS_ZERO_BASELINE_RECEIPT_SHA256",
  "AAIS_RESEARCH_LRS_PUT_DELETE_RECEIPT_SHA256",
  "AAIS_RESEARCH_BACKUP_POLICY_RECEIPT_SHA256",
  "AAIS_RESEARCH_RESTORE_RECEIPT_SHA256",
  "AAIS_RESEARCH_LEGACY_ARCHIVE_RECEIPT_SHA256",
  "AAIS_RESEARCH_ACCESS_REGISTER_RECEIPT_SHA256",
  "AAIS_RESEARCH_CONSENT_LEGAL_BASIS_RECEIPT_SHA256",
  "AAIS_RESEARCH_DPA_RECEIPT_SHA256",
  "AAIS_RESEARCH_DATA_REGION_RECEIPT_SHA256",
  "AAIS_RESEARCH_DAILY_BACKUP_RECEIPT_SHA256",
  "AAIS_RESEARCH_BACKUP_DESTRUCTION_RECEIPT_SHA256",
  "AAIS_RESEARCH_GOVERNANCE_MANIFEST_RECEIPT_SHA256",
  "AAIS_RESEARCH_GOVERNANCE_MANIFEST_VERIFIED_AT",
  "AAIS_RESEARCH_GOVERNANCE_MANIFEST_VALID_UNTIL",
  "AAIS_RESEARCH_DAILY_BACKUP_COMPLETED_AT",
  "AAIS_RESEARCH_BACKUP_DESTRUCTION_OBSERVED_AT",
  "AAIS_RESEARCH_IDENTITY_RETENTION_DAYS",
  "AAIS_RESEARCH_RAW_TEXT_RETENTION_DAYS",
  "AAIS_RESEARCH_EVENT_RETENTION_DAYS",
  "AAIS_RESEARCH_BACKUP_RETENTION_DAYS",
  "AAIS_APP_VERSION",
  "AAIS_COMMIT_SHA",
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
  researchDatabaseProbeMode = "ok";
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

function stubResearchEnv(input: {
  participantCount?: number;
  rehearsal?: boolean;
} = {}) {
  const participantCount = input.participantCount ?? 30;
  const rehearsal = input.rehearsal ?? false;
  vi.stubEnv("AAIS_RESEARCH_MODE", "true");
  vi.stubEnv(
    "AAIS_RESEARCH_DATABASE_URL",
    "postgres://research:research-database-secret@research-db.example.test/aais_research",
  );
  vi.stubEnv("AAIS_RESEARCH_DATABASE_INSTANCE_ID", "aais-research-db-primary");
  vi.stubEnv("AAIS_RESEARCH_DATABASE_DRIVER", "pg");
  vi.stubEnv("AAIS_RESEARCH_PROJECT_ID", "aais");
  vi.stubEnv("AAIS_RESEARCH_STUDY_ID", "aais-ca-pilot");
  vi.stubEnv("AAIS_RESEARCH_ENVIRONMENT", "research");
  vi.stubEnv("AAIS_RESEARCH_REHEARSAL_MODE", rehearsal ? "true" : "false");
  vi.stubEnv("AAIS_RESEARCH_REHEARSAL_APPROVED", rehearsal ? "true" : "false");
  vi.stubEnv(
    "AAIS_RESEARCH_IDENTITY_ENCRYPTION_KEY",
    Buffer.alloc(32, 1).toString("base64"),
  );
  vi.stubEnv(
    "AAIS_RESEARCH_IDENTITY_FINGERPRINT_KEY",
    Buffer.alloc(32, 2).toString("base64"),
  );
  vi.stubEnv(
    "AAIS_RESEARCH_PARTICIPANT_ACTOR_IDS",
    Array.from({ length: participantCount }, (_, index) =>
      `${rehearsal ? "synthetic" : "participant"}-${index + 1}`)
      .join(","),
  );
  vi.stubEnv("AAIS_RESEARCH_IDENTITY_KEY_VERSION", "v1");
  vi.stubEnv("AAIS_RESEARCH_CONDITIONS", "control,treatment");
  vi.stubEnv("AAIS_RESEARCH_LRS_STORE_ID", "aais-research-clean-store");
  vi.stubEnv(
    "AAIS_RESEARCH_LRS_ENDPOINT",
    "https://research-lrs.example.test/xapi/statements",
  );
  vi.stubEnv("AAIS_RESEARCH_LRS_USERNAME", "research-lrs-writer");
  vi.stubEnv("AAIS_RESEARCH_LRS_PASSWORD", "research-lrs-secret-that-must-not-leak");
  vi.stubEnv("AAIS_RESEARCH_LRS_RECEIPT_VERIFYING_KEY_ID", "provider-ed25519-2026-01");
  vi.stubEnv("AAIS_RESEARCH_LRS_RECEIPT_VERIFYING_KEY_SPKI", receiptVerifyingSpki);
  vi.stubEnv("AAIS_RESEARCH_PI_ACTOR_IDS", "principal-investigator-1");
  vi.stubEnv("AAIS_RESEARCH_DATA_CUSTODIAN_ACTOR_IDS", "data-custodian-1");
  vi.stubEnv("AAIS_RESEARCH_EXPORT_ACTOR_IDS", "approved-researcher-1");
  vi.stubEnv("AAIS_RESEARCH_EXPORT_ENABLED", "true");
  vi.stubEnv(
    "AAIS_RESEARCH_LRS_OUTBOX_FLUSH_TOKEN",
    "research-flush-token-with-at-least-32-characters",
  );
  vi.stubEnv(
    "AAIS_RESEARCH_RETENTION_TOKEN",
    "research-retention-token-with-at-least-32-characters",
  );
  vi.stubEnv("AAIS_RESEARCH_LRS_EVENT_FLUSH_SCHEDULE_ID", "schedule-event-flush-v1");
  vi.stubEnv("AAIS_RESEARCH_LRS_DELETION_SCHEDULE_ID", "schedule-deletion-flush-v1");
  vi.stubEnv("AAIS_RESEARCH_RETENTION_SCHEDULE_ID", "schedule-retention-v1");
  vi.stubEnv("AAIS_RESEARCH_DATABASE_ISOLATION_RECEIPT_SHA256", "1".repeat(64));
  vi.stubEnv("AAIS_RESEARCH_LRS_ISOLATION_RECEIPT_SHA256", "2".repeat(64));
  vi.stubEnv("AAIS_RESEARCH_LRS_ZERO_BASELINE_RECEIPT_SHA256", "3".repeat(64));
  vi.stubEnv("AAIS_RESEARCH_LRS_PUT_DELETE_RECEIPT_SHA256", "4".repeat(64));
  vi.stubEnv("AAIS_RESEARCH_BACKUP_POLICY_RECEIPT_SHA256", "5".repeat(64));
  vi.stubEnv("AAIS_RESEARCH_RESTORE_RECEIPT_SHA256", "6".repeat(64));
  vi.stubEnv("AAIS_RESEARCH_LEGACY_ARCHIVE_RECEIPT_SHA256", "7".repeat(64));
  vi.stubEnv("AAIS_RESEARCH_ACCESS_REGISTER_RECEIPT_SHA256", "8".repeat(64));
  vi.stubEnv("AAIS_RESEARCH_CONSENT_LEGAL_BASIS_RECEIPT_SHA256", "9".repeat(64));
  vi.stubEnv("AAIS_RESEARCH_DPA_RECEIPT_SHA256", "a".repeat(64));
  vi.stubEnv("AAIS_RESEARCH_DATA_REGION_RECEIPT_SHA256", "b".repeat(64));
  vi.stubEnv("AAIS_RESEARCH_DAILY_BACKUP_RECEIPT_SHA256", "c".repeat(64));
  vi.stubEnv("AAIS_RESEARCH_BACKUP_DESTRUCTION_RECEIPT_SHA256", "d".repeat(64));
  vi.stubEnv("AAIS_RESEARCH_GOVERNANCE_MANIFEST_RECEIPT_SHA256", "e".repeat(64));
  const governanceNow = Date.now();
  vi.stubEnv(
    "AAIS_RESEARCH_GOVERNANCE_MANIFEST_VERIFIED_AT",
    new Date(governanceNow - 60 * 60 * 1_000).toISOString(),
  );
  vi.stubEnv(
    "AAIS_RESEARCH_GOVERNANCE_MANIFEST_VALID_UNTIL",
    new Date(governanceNow + 30 * 24 * 60 * 60 * 1_000).toISOString(),
  );
  vi.stubEnv(
    "AAIS_RESEARCH_DAILY_BACKUP_COMPLETED_AT",
    new Date(governanceNow - 12 * 60 * 60 * 1_000).toISOString(),
  );
  vi.stubEnv(
    "AAIS_RESEARCH_BACKUP_DESTRUCTION_OBSERVED_AT",
    new Date(governanceNow - 7 * 24 * 60 * 60 * 1_000).toISOString(),
  );
  vi.stubEnv("AAIS_APP_VERSION", "0.1.0");
  vi.stubEnv("AAIS_COMMIT_SHA", "abcdef0123456789abcdef0123456789abcdef01");
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
    expect(body.checks.research).toMatchObject({
      status: "disabled",
      enabled: false,
      configuration: { status: "disabled" },
      storage: { status: "disabled", probe: "not_required" },
      lrs: { status: "disabled" },
    });
  });

  it("passes enterprise readiness for a migrated formal research roster of exactly 30", async () => {
    vi.stubEnv("NODE_ENV", "development");
    vi.stubEnv("AAIS_READINESS_MODE", "enterprise");
    stubResearchEnv();
    const encryptionKey = process.env.AAIS_RESEARCH_IDENTITY_ENCRYPTION_KEY;
    const fingerprintKey = process.env.AAIS_RESEARCH_IDENTITY_FINGERPRINT_KEY;
    const { GET } = await import("@/app/api/system/readiness/route");

    const response = await GET();
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body).toMatchObject({
      status: "ready",
      readinessMode: "enterprise",
      checks: {
        research: {
          status: "ok",
          enabled: true,
          applicationReady: true,
          studyLaunchReady: true,
          configuration: {
            status: "ok",
            dedicatedDatabase: true,
            databaseTargetNonCollision: true,
            postgresOnly: true,
          },
          roster: {
            status: "ok",
            mode: "formal",
            participantCount: 30,
            required: { minimum: 30, maximum: 30 },
          },
          storage: {
            status: "ok",
            mode: "postgres",
            probe: "connected",
            schema: "current",
            sourceOfTruth: "postgres",
          },
          lrs: {
            status: "ok",
            configured: true,
            dedicated: true,
            configurationIsolated: true,
            storeConfigured: true,
            credentialsConfigured: true,
            receiptVerificationConfigured: true,
            receiptVerifyingKeyIdConfigured: true,
          },
          access: {
            status: "ok",
            piConfigured: true,
            custodianConfigured: true,
            exportActorsConfigured: true,
            exportEnabled: true,
          },
          workers: {
            status: "ok",
            flushTokenConfigured: true,
            retentionTokenConfigured: true,
            tokensDistinct: true,
            eventFlushScheduleConfigured: true,
            deletionScheduleConfigured: true,
            retentionScheduleConfigured: true,
          },
          evidence: {
            status: "ok",
            databaseIsolationReceiptConfigured: true,
            lrsIsolationReceiptConfigured: true,
            zeroBaselineReceiptConfigured: true,
            putDeleteReceiptConfigured: true,
            backupPolicyReceiptConfigured: true,
            restoreReceiptConfigured: true,
            legacyArchiveReceiptConfigured: true,
            accessRegisterReceiptConfigured: true,
            consentLegalBasisReceiptConfigured: true,
            dpaReceiptConfigured: true,
            dataRegionReceiptConfigured: true,
            dailyBackupReceiptConfigured: true,
            backupDestructionReceiptConfigured: true,
            governanceManifestReceiptConfigured: true,
            governanceEvidenceFresh: true,
          },
        },
      },
      issues: [],
      secrets: "redacted",
    });
    const serialized = JSON.stringify(body);
    expect(serialized).not.toContain("research-database-secret");
    expect(serialized).not.toContain("research-lrs-secret-that-must-not-leak");
    expect(serialized).not.toContain("research-lrs-writer");
    expect(serialized).not.toContain("aais-research-clean-store");
    expect(serialized).not.toContain(encryptionKey);
    expect(serialized).not.toContain(fingerprintKey);
    expect(serialized).not.toContain("research-flush-token-with-at-least-32-characters");
    expect(serialized).not.toContain("research-retention-token-with-at-least-32-characters");
    expect(serialized).not.toContain("1".repeat(64));
  });

  it("blocks formal research readiness without the pinned LRS receipt verification key", async () => {
    vi.stubEnv("NODE_ENV", "development");
    vi.stubEnv("AAIS_READINESS_MODE", "enterprise");
    stubResearchEnv();
    vi.stubEnv("AAIS_RESEARCH_LRS_RECEIPT_VERIFYING_KEY_ID", "");
    vi.stubEnv("AAIS_RESEARCH_LRS_RECEIPT_VERIFYING_KEY_SPKI", "");
    const { GET } = await import("@/app/api/system/readiness/route");

    const response = await GET();
    const body = await response.json();

    expect(response.status).toBe(503);
    expect(body.checks.research).toMatchObject({
      applicationReady: false,
      studyLaunchReady: false,
      lrs: {
        status: "invalid",
        configured: false,
        receiptVerificationConfigured: false,
        receiptVerifyingKeyIdConfigured: false,
      },
    });
  });

  it("blocks readiness when research is required but collection mode is disabled", async () => {
    vi.stubEnv("NODE_ENV", "development");
    vi.stubEnv("AAIS_READINESS_MODE", "enterprise");
    vi.stubEnv("AAIS_RESEARCH_REQUIRED", "true");
    vi.stubEnv("AAIS_RESEARCH_MODE", "false");
    const { GET } = await import("@/app/api/system/readiness/route");

    const response = await GET();
    const body = await response.json();

    expect(response.status).toBe(503);
    expect(body).toMatchObject({
      status: "not_ready",
      checks: {
        research: {
          status: "blocked",
          enabled: false,
          applicationReady: false,
          studyLaunchReady: false,
          configuration: { status: "blocked" },
          storage: {
            status: "blocked",
            mode: "postgres",
            probe: "not_run",
            schema: "not_run",
          },
          lrs: { status: "blocked" },
        },
      },
      issues: ["AAIS_RESEARCH_MODE"],
    });
  });

  it("does not require the disabled generic LRS inside a ready research-isolated deployment", async () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("AAIS_READINESS_MODE", "enterprise");
    vi.stubEnv("AAIS_SESSION_SECRET", "session-secret-that-must-not-leak");
    vi.stubEnv("AAIS_TRIAL_LOGIN_ENABLED", "true");
    vi.stubEnv("AAIS_TRIAL_ACCOUNTS_JSON", trialAccountConfig);
    vi.stubEnv(
      "AAIS_DATABASE_URL",
      "postgres://aais:database-secret@ep-prod.us-east-1.aws.neon.tech/aais",
    );
    stubMonitoringEnv();
    stubResearchEnv();
    const { GET } = await import("@/app/api/system/readiness/route");

    const response = await GET();
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body).toMatchObject({
      status: "ready",
      checks: {
        lrs: { status: "disabled" },
        research: {
          status: "ok",
          enabled: true,
          applicationReady: true,
          studyLaunchReady: true,
          lrs: { status: "ok" },
        },
      },
      issues: [],
    });
    expect(body.warnings).not.toContain("LRS_ENDPOINT/LRS_USERNAME/LRS_PASSWORD");
  });

  it("keeps application health distinct from the external evidence required to launch a study", async () => {
    vi.stubEnv("NODE_ENV", "development");
    vi.stubEnv("AAIS_READINESS_MODE", "enterprise");
    stubResearchEnv();
    vi.stubEnv("AAIS_RESEARCH_LRS_ISOLATION_RECEIPT_SHA256", "");
    vi.stubEnv("AAIS_RESEARCH_LRS_ZERO_BASELINE_RECEIPT_SHA256", "");
    vi.stubEnv("AAIS_RESEARCH_LRS_PUT_DELETE_RECEIPT_SHA256", "");
    vi.stubEnv("AAIS_RESEARCH_BACKUP_POLICY_RECEIPT_SHA256", "");
    vi.stubEnv("AAIS_RESEARCH_RESTORE_RECEIPT_SHA256", "");
    vi.stubEnv("AAIS_RESEARCH_LEGACY_ARCHIVE_RECEIPT_SHA256", "");
    const { GET } = await import("@/app/api/system/readiness/route");

    const response = await GET();
    const body = await response.json();

    expect(response.status).toBe(503);
    expect(body).toMatchObject({
      status: "not_ready",
      checks: {
        research: {
          status: "blocked",
          applicationReady: true,
          studyLaunchReady: false,
          configuration: {
            status: "ok",
            dedicatedDatabase: true,
          },
          lrs: {
            status: "ok",
            dedicated: false,
          },
          evidence: {
            status: "missing",
            databaseIsolationReceiptConfigured: true,
            lrsIsolationReceiptConfigured: false,
            zeroBaselineReceiptConfigured: false,
            putDeleteReceiptConfigured: false,
            backupPolicyReceiptConfigured: false,
            restoreReceiptConfigured: false,
            legacyArchiveReceiptConfigured: false,
          },
        },
      },
    });
    expect(body.issues).toContain("AAIS_RESEARCH_LAUNCH_EVIDENCE");
  });

  it("blocks formal launch when the governance manifest or operational backup evidence is stale", async () => {
    vi.stubEnv("NODE_ENV", "development");
    vi.stubEnv("AAIS_READINESS_MODE", "enterprise");
    stubResearchEnv();
    vi.stubEnv(
      "AAIS_RESEARCH_DAILY_BACKUP_COMPLETED_AT",
      new Date(Date.now() - 37 * 60 * 60 * 1_000).toISOString(),
    );
    const { GET } = await import("@/app/api/system/readiness/route");

    const response = await GET();
    const body = await response.json();

    expect(response.status).toBe(503);
    expect(body.checks.research).toMatchObject({
      applicationReady: true,
      studyLaunchReady: false,
      evidence: {
        status: "missing",
        dailyBackupReceiptConfigured: true,
        governanceManifestReceiptConfigured: true,
        governanceEvidenceFresh: false,
      },
    });
    expect(body.issues).toContain("AAIS_RESEARCH_LAUNCH_EVIDENCE");
  });

  it("blocks launch when research access grants or distinct scheduled workers are absent", async () => {
    vi.stubEnv("NODE_ENV", "development");
    vi.stubEnv("AAIS_READINESS_MODE", "enterprise");
    stubResearchEnv();
    vi.stubEnv("AAIS_RESEARCH_EXPORT_ACTOR_IDS", "");
    vi.stubEnv("AAIS_RESEARCH_EXPORT_ENABLED", "false");
    vi.stubEnv(
      "AAIS_RESEARCH_RETENTION_TOKEN",
      "research-flush-token-with-at-least-32-characters",
    );
    vi.stubEnv("AAIS_RESEARCH_LRS_DELETION_SCHEDULE_ID", "");
    const { GET } = await import("@/app/api/system/readiness/route");

    const response = await GET();
    const body = await response.json();

    expect(response.status).toBe(503);
    expect(body.checks.research).toMatchObject({
      applicationReady: true,
      studyLaunchReady: false,
      access: {
        status: "missing",
        exportActorsConfigured: false,
        exportEnabled: false,
      },
      workers: {
        status: "missing",
        tokensDistinct: false,
        deletionScheduleConfigured: false,
      },
    });
    expect(body.issues).toEqual(expect.arrayContaining([
      "AAIS_RESEARCH_ACCESS_GRANTS",
      "AAIS_RESEARCH_WORKER_CONFIGURATION",
    ]));
  });

  it("accepts an approved research rehearsal roster of 3-5 synthetic participants", async () => {
    vi.stubEnv("NODE_ENV", "development");
    vi.stubEnv("AAIS_READINESS_MODE", "enterprise");
    stubResearchEnv({ participantCount: 4, rehearsal: true });
    vi.stubEnv("AAIS_RESEARCH_LRS_RECEIPT_VERIFYING_KEY_ID", "");
    vi.stubEnv("AAIS_RESEARCH_LRS_RECEIPT_VERIFYING_KEY_SPKI", "");
    const { GET } = await import("@/app/api/system/readiness/route");

    const response = await GET();
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.checks.research).toMatchObject({
      status: "ok",
      roster: {
        status: "ok",
        mode: "rehearsal",
        participantCount: 4,
        required: { minimum: 3, maximum: 5 },
      },
      storage: { status: "ok", schema: "current" },
      lrs: {
        status: "ok",
        dedicated: true,
        receiptVerificationConfigured: false,
        receiptVerifyingKeyIdConfigured: false,
      },
    });
  });

  it("rejects a formal research roster that is not exactly 30 participants", async () => {
    vi.stubEnv("NODE_ENV", "development");
    vi.stubEnv("AAIS_READINESS_MODE", "enterprise");
    stubResearchEnv({ participantCount: 29 });
    const { GET } = await import("@/app/api/system/readiness/route");

    const response = await GET();
    const body = await response.json();

    expect(response.status).toBe(503);
    expect(body.checks.research).toMatchObject({
      status: "invalid",
      configuration: { status: "invalid" },
      roster: {
        status: "invalid",
        mode: "formal",
        participantCount: 29,
        required: { minimum: 30, maximum: 30 },
      },
      storage: { status: "blocked", probe: "not_run" },
    });
    expect(body.issues).toEqual(expect.arrayContaining([
      "AAIS_RESEARCH_CONFIGURATION",
      "AAIS_RESEARCH_PARTICIPANT_ACTOR_IDS",
    ]));
  });

  it("fails research readiness closed when required configuration and roster are missing", async () => {
    vi.stubEnv("NODE_ENV", "development");
    vi.stubEnv("AAIS_READINESS_MODE", "enterprise");
    vi.stubEnv("AAIS_RESEARCH_MODE", "true");
    const { GET } = await import("@/app/api/system/readiness/route");

    const response = await GET();
    const body = await response.json();

    expect(response.status).toBe(503);
    expect(body).toMatchObject({
      status: "not_ready",
      checks: {
        research: {
          status: "invalid",
          enabled: true,
          configuration: {
            status: "invalid",
            dedicatedDatabase: false,
          },
          roster: {
            status: "invalid",
            mode: "formal",
            participantCount: 0,
          },
          storage: {
            status: "blocked",
            probe: "not_run",
            schema: "not_run",
          },
          lrs: {
            status: "invalid",
            configured: false,
            dedicated: false,
          },
        },
      },
    });
    expect(body.issues).toEqual(expect.arrayContaining([
      "AAIS_RESEARCH_CONFIGURATION",
      "AAIS_RESEARCH_PARTICIPANT_ACTOR_IDS",
      "AAIS_RESEARCH_LRS_CONFIGURATION",
    ]));
    expect(JSON.stringify(body)).not.toContain("configuration is incomplete");
  });

  it("fails research readiness closed when the dedicated database lacks the research schema", async () => {
    vi.stubEnv("NODE_ENV", "development");
    vi.stubEnv("AAIS_READINESS_MODE", "enterprise");
    stubResearchEnv();
    researchDatabaseProbeMode = "missing_schema";
    const { GET } = await import("@/app/api/system/readiness/route");

    const response = await GET();
    const body = await response.json();

    expect(response.status).toBe(503);
    expect(body.checks.research).toMatchObject({
      status: "blocked",
      configuration: { status: "ok", dedicatedDatabase: true },
      roster: { status: "ok", participantCount: 30 },
      storage: {
        status: "blocked",
        probe: "connected",
        schema: "missing_or_unreachable",
      },
      lrs: { status: "ok" },
    });
    expect(body.issues).toEqual(expect.arrayContaining([
      "AAIS_RESEARCH_DATABASE_SCHEMA",
    ]));
    expect(JSON.stringify(body)).not.toContain("research database unavailable");
  });

  it("fails research readiness closed when the dedicated database is unreachable", async () => {
    vi.stubEnv("NODE_ENV", "development");
    vi.stubEnv("AAIS_READINESS_MODE", "enterprise");
    stubResearchEnv();
    researchDatabaseProbeMode = "error";
    const { GET } = await import("@/app/api/system/readiness/route");

    const response = await GET();
    const body = await response.json();

    expect(response.status).toBe(503);
    expect(body.checks.research).toMatchObject({
      status: "blocked",
      configuration: { status: "ok" },
      storage: {
        status: "blocked",
        probe: "failed",
        schema: "missing_or_unreachable",
      },
    });
    expect(body.issues).toEqual(expect.arrayContaining([
      "AAIS_RESEARCH_DATABASE_SCHEMA",
    ]));
    expect(JSON.stringify(body)).not.toContain("research database unavailable");
  });

  it("fails research readiness closed when LRS credentials are not dedicated", async () => {
    vi.stubEnv("NODE_ENV", "development");
    vi.stubEnv("AAIS_READINESS_MODE", "enterprise");
    stubResearchEnv();
    vi.stubEnv("LRS_ENDPOINT", "https://research-lrs.example.test/xapi/statements");
    vi.stubEnv("LRS_USERNAME", "research-lrs-writer");
    vi.stubEnv("LRS_PASSWORD", "generic-lrs-secret-that-must-not-leak");
    const { GET } = await import("@/app/api/system/readiness/route");

    const response = await GET();
    const body = await response.json();

    expect(response.status).toBe(503);
    expect(body.checks.research).toMatchObject({
      status: "invalid",
      configuration: { status: "ok" },
      storage: { status: "ok", schema: "current" },
      lrs: {
        status: "invalid",
        configured: false,
        dedicated: false,
        storeConfigured: true,
        credentialsConfigured: true,
      },
    });
    expect(body.issues).toEqual(expect.arrayContaining([
      "AAIS_RESEARCH_LRS_CONFIGURATION",
    ]));
    const serialized = JSON.stringify(body);
    expect(serialized).not.toContain("research-lrs-writer");
    expect(serialized).not.toContain("research-lrs-secret-that-must-not-leak");
    expect(serialized).not.toContain("generic-lrs-secret-that-must-not-leak");
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

  it("fails closed when production OIDC is configured without an allowed role mapping", async () => {
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
              "AAIS_OIDC_RESEARCHER_GROUPS",
              "AAIS_OIDC_RESEARCHER_EMAILS",
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
    vi.stubEnv("AAIS_AI_MODEL", "qwen3.6-plus");
    const { GET } = await import("@/app/api/system/readiness/route");

    const response = await GET();
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.checks.ai).toMatchObject({
      status: "ok",
      provider: "openai-compatible",
      evalVersion: null,
      evalManifest: "not-required",
      modelFingerprint: modelFingerprint("qwen3.6-plus"),
      runtimeProfile: {
        mode: "live",
        primary: {
          provider: "qwen",
          modelFingerprint: modelFingerprint("qwen3.6-plus"),
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
