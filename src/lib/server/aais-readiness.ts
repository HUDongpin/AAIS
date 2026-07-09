import { getLrsConfigurationStatus } from "@/lib/server/aais-lrs-client";
import {
  getAaisOidcConfigurationStatus,
  getAaisOidcRoleMappingStatus,
  type AaisOidcRoleMappingStatus,
} from "@/lib/server/aais-oidc";
import {
  getAaisAgentEvidenceCapability,
  getAaisDatabaseConfiguration,
  getAaisPersistentLrsOutboxStatus,
  probeAaisLearningStorage,
  type AaisAgentEvidenceCapability,
  type AaisDatabaseSourceEnv,
} from "@/lib/server/aais-learning-store";
import { getAaisTrialAccountConfigurationStatus } from "@/lib/server/aais-trial-accounts";
import {
  verifyAaisAiEvalManifest,
  type AaisAiEvalManifestStatus,
} from "@/lib/server/aais-ai-eval-manifest";
import {
  readAaisAiRuntimeConfig,
  type AaisAiRuntimeProfile,
} from "@/lib/ai/aais-ai-runtime-config";

type AaisReadinessCheckStatus = "ok" | "missing" | "blocked" | "invalid" | "disabled";

type AaisReadinessCheck = {
  status: AaisReadinessCheckStatus;
};

export type AaisReadinessReport = {
  status: "ready" | "not_ready";
  runtime: "production" | "development";
  checkedAt: string;
  release: {
    id: string | null;
    source: "AAIS_RELEASE_ID" | "missing";
    deployment: {
      provider: "vercel" | "unknown";
      gitCommit: {
        present: boolean;
        shortSha: string | null;
        source: "VERCEL_GIT_COMMIT_SHA" | "AAIS_DEPLOYMENT_GIT_COMMIT_SHA" | "missing";
      };
    };
  };
  checks: {
    session: AaisReadinessCheck;
    trialAccounts: AaisReadinessCheck & {
      configured: boolean;
      accountCount: number;
    };
    storage: AaisReadinessCheck & {
      mode: "postgres" | "file";
      provider: "neon" | "postgres" | "file";
      probe: "connected" | "not_required" | "failed";
      sourceEnv: AaisDatabaseSourceEnv | null;
    };
    lrs: AaisReadinessCheck & {
      outbox: {
        mode: "persistent" | "memory";
        storage: "postgres" | "process";
        metrics: {
          pending: number;
          retry: number;
          sent: number;
          deadLetter: number;
          total: number;
        };
        coalescing: {
          enabled: boolean;
          windowSeconds: number;
          events: string[];
          strategy: "latest-write-wins";
        };
        recovery: {
          deadLetterRequeue: boolean;
          action: string;
          auth: string[];
          redaction: "payloads-excluded";
        };
      };
    };
    monitoring: AaisReadinessCheck & {
      sentry: AaisReadinessCheck & {
        dsnConfigured: boolean;
        source: "SENTRY_DSN" | "NEXT_PUBLIC_SENTRY_DSN" | "missing";
        alertsConfigured: boolean;
      };
      uptime: AaisReadinessCheck & {
        loginCheckConfigured: boolean;
        source: "AAIS_UPTIME_LOGIN_CHECK_URL" | "missing";
      };
      cron: AaisReadinessCheck & {
        scheduleConfigured: boolean;
        secretConfigured: boolean;
        alertsConfigured: boolean;
      };
    };
    agentEvidence: AaisReadinessCheck & AaisAgentEvidenceCapability;
    a3Supervision: AaisReadinessCheck & AaisAgentEvidenceCapability;
    a2Monitoring: AaisReadinessCheck & AaisAgentEvidenceCapability;
    oidc: AaisReadinessCheck & {
      mode: "explicit" | "discovery" | "missing";
      roleMapping: AaisReadinessCheck & AaisOidcRoleMappingStatus;
    };
    ai: AaisReadinessCheck & {
      provider: "deterministic" | "openai-compatible";
      evalVersion: string | null;
      evalManifest: AaisAiEvalManifestStatus;
      modelFingerprint: string | null;
      runtimeProfile: AaisAiRuntimeProfile;
    };
  };
  issues: string[];
  secrets: "redacted";
};

export async function getAaisReadinessReport(now = new Date()): Promise<AaisReadinessReport> {
  const production = isProductionRuntime();
  const issues: string[] = [];
  const sessionConfigured = Boolean(process.env.AAIS_SESSION_SECRET?.trim());
  const trialAccounts = getAaisTrialAccountConfigurationStatus();
  const databaseConfig = getAaisDatabaseConfiguration();
  const databaseConfigured = Boolean(databaseConfig);
  const databaseProvider = databaseConfig
    ? getDatabaseProvider(databaseConfig.url)
    : "file";
  const storageProbe = await probeAaisLearningStorage();
  const persistentOutbox = await readPersistentOutboxStatus();
  const monitoring = getAaisMonitoringConfigurationStatus();
  const agentEvidence = getAaisAgentEvidenceCapability();
  const lrsConfigured = getLrsConfigurationStatus().configured;
  const oidcConfig = getAaisOidcConfigurationStatus();
  const oidcRoleMapping = getAaisOidcRoleMappingStatus();
  const ssoOnlyRequired = production && trialAccounts.status === "disabled";
  const aiRuntimeConfig = readAaisAiRuntimeConfig();
  const aiModel = aiRuntimeConfig.primary?.model ?? null;
  const aiProvider = aiRuntimeConfig.profile.mode === "live" ? "openai-compatible" : "deterministic";
  const aiModelFingerprint = aiRuntimeConfig.profile.primary?.modelFingerprint ?? null;
  const aiEvalVersion = process.env.AAIS_AI_EVAL_VERSION?.trim() || null;
  const aiApproved = process.env.AAIS_AI_EVAL_APPROVED === "true" && Boolean(aiEvalVersion);
  const aiEvalManifest = verifyAaisAiEvalManifest({
    required: production && aiProvider === "openai-compatible",
    evalVersion: aiEvalVersion,
    provider: aiProvider,
    model: aiModel,
  });
  const release = getAaisReleaseMetadata();

  if (production && !sessionConfigured) {
    issues.push("AAIS_SESSION_SECRET");
  }
  if (production && trialAccounts.status !== "disabled" && !trialAccounts.configured) {
    issues.push("AAIS_TRIAL_ACCOUNTS_JSON");
  }
  if (production && !databaseConfigured) {
    issues.push("AAIS_DATABASE_URL");
  }
  if (production && databaseConfigured && storageProbe.status !== "connected") {
    issues.push("AAIS_DATABASE_URL_CONNECTIVITY");
  }
  if (production && !lrsConfigured) {
    issues.push("LRS_ENDPOINT/LRS_USERNAME/LRS_PASSWORD");
  }
  if (production && !monitoring.sentry.dsnConfigured) {
    issues.push("SENTRY_DSN/NEXT_PUBLIC_SENTRY_DSN");
  }
  if (production && !monitoring.sentry.alertsConfigured) {
    issues.push("AAIS_SENTRY_ALERTS_CONFIGURED");
  }
  if (production && !monitoring.uptime.loginCheckConfigured) {
    issues.push("AAIS_UPTIME_LOGIN_CHECK_URL");
  }
  if (production && !monitoring.cron.secretConfigured) {
    issues.push("CRON_SECRET");
  }
  if (production && !monitoring.cron.alertsConfigured) {
    issues.push("AAIS_CRON_FAILURE_ALERTS_CONFIGURED");
  }
  if (ssoOnlyRequired && !oidcConfig.configured) {
    issues.push("AAIS_OIDC_*");
  }
  if (ssoOnlyRequired && oidcConfig.configured && !oidcRoleMapping.configured) {
    issues.push("AAIS_OIDC_ROLE_MAPPING");
  }
  if (production && aiProvider === "openai-compatible" && !aiApproved) {
    issues.push("AAIS_AI_EVAL_APPROVED/AAIS_AI_EVAL_VERSION");
  }
  if (production && aiProvider === "openai-compatible" && aiEvalManifest.issue) {
    issues.push(aiEvalManifest.issue);
  }

  return {
    status: issues.length ? "not_ready" : "ready",
    runtime: production ? "production" : "development",
    checkedAt: now.toISOString(),
    release,
    checks: {
      session: {
        status: sessionConfigured ? "ok" : "missing",
      },
      trialAccounts: {
        status: getTrialAccountStatus(trialAccounts.status),
        configured: trialAccounts.configured,
        accountCount: trialAccounts.accountCount,
      },
      storage: {
        status: getStorageStatus({ databaseConfigured, production, storageProbeStatus: storageProbe.status }),
        mode: databaseConfigured ? "postgres" : "file",
        provider: databaseProvider,
        probe: databaseConfigured
          ? (storageProbe.status === "connected" ? "connected" : "failed")
          : "not_required",
        sourceEnv: databaseConfig?.sourceEnv ?? null,
      },
      lrs: {
        status: lrsConfigured ? "ok" : "missing",
        outbox: {
          mode: databaseConfigured ? "persistent" : "memory",
          storage: databaseConfigured ? "postgres" : "process",
          metrics: {
            pending: persistentOutbox.pending,
            retry: persistentOutbox.retry,
            sent: persistentOutbox.sent,
            deadLetter: persistentOutbox.deadLetter,
            total: persistentOutbox.total,
          },
          coalescing: persistentOutbox.coalescing,
          recovery: persistentOutbox.recovery,
        },
      },
      monitoring: {
        status: getMonitoringStatus(monitoring),
        sentry: {
          status: monitoring.sentry.dsnConfigured && monitoring.sentry.alertsConfigured
            ? "ok"
            : "missing",
          ...monitoring.sentry,
        },
        uptime: {
          status: monitoring.uptime.loginCheckConfigured ? "ok" : "missing",
          ...monitoring.uptime,
        },
        cron: {
          status: monitoring.cron.scheduleConfigured
            && monitoring.cron.secretConfigured
            && monitoring.cron.alertsConfigured
            ? "ok"
            : "missing",
          ...monitoring.cron,
        },
      },
      agentEvidence: {
        status: agentEvidence.enabled ? "ok" : "blocked",
        ...agentEvidence,
      },
      a3Supervision: {
        status: agentEvidence.enabled ? "ok" : "blocked",
        ...agentEvidence,
      },
      a2Monitoring: {
        status: agentEvidence.enabled ? "ok" : "blocked",
        ...agentEvidence,
      },
      oidc: {
        status: getOidcStatus({
          configured: oidcConfig.configured,
          production: ssoOnlyRequired,
          roleMappingConfigured: oidcRoleMapping.configured,
        }),
        mode: oidcConfig.mode,
        roleMapping: {
          status: oidcRoleMapping.configured ? "ok" : "missing",
          configured: oidcRoleMapping.configured,
          present: oidcRoleMapping.present,
          acceptedNames: oidcRoleMapping.acceptedNames,
          redaction: oidcRoleMapping.redaction,
        },
      },
      ai: {
        status: getAiStatus({
          aiProvider,
          aiApproved,
          production,
          aiEvalManifestStatus: aiEvalManifest.status,
        }),
        provider: aiProvider,
        evalVersion: aiProvider === "openai-compatible" ? aiEvalVersion : null,
        evalManifest: aiEvalManifest.status,
        modelFingerprint: aiModelFingerprint,
        runtimeProfile: aiRuntimeConfig.profile,
      },
    },
    issues,
    secrets: "redacted",
  };
}

function getTrialAccountStatus(status: "configured" | "missing" | "invalid" | "disabled"): AaisReadinessCheckStatus {
  if (status === "configured") {
    return "ok";
  }
  return status;
}

function getAaisMonitoringConfigurationStatus() {
  const serverDsnConfigured = Boolean(process.env.SENTRY_DSN?.trim());
  const publicDsnConfigured = Boolean(process.env.NEXT_PUBLIC_SENTRY_DSN?.trim());
  const sentrySource = serverDsnConfigured
    ? "SENTRY_DSN"
    : publicDsnConfigured
      ? "NEXT_PUBLIC_SENTRY_DSN"
      : "missing";
  return {
    sentry: {
      dsnConfigured: serverDsnConfigured || publicDsnConfigured,
      source: sentrySource,
      alertsConfigured: process.env.AAIS_SENTRY_ALERTS_CONFIGURED === "true",
    },
    uptime: {
      loginCheckConfigured: isSafeHttpsUrl(process.env.AAIS_UPTIME_LOGIN_CHECK_URL),
      source: isSafeHttpsUrl(process.env.AAIS_UPTIME_LOGIN_CHECK_URL)
        ? "AAIS_UPTIME_LOGIN_CHECK_URL"
        : "missing",
    },
    cron: {
      scheduleConfigured: true,
      secretConfigured: Boolean(process.env.CRON_SECRET?.trim()),
      alertsConfigured: process.env.AAIS_CRON_FAILURE_ALERTS_CONFIGURED === "true",
    },
  } as const;
}

function getMonitoringStatus(
  monitoring: ReturnType<typeof getAaisMonitoringConfigurationStatus>,
): AaisReadinessCheckStatus {
  return monitoring.sentry.dsnConfigured
    && monitoring.sentry.alertsConfigured
    && monitoring.uptime.loginCheckConfigured
    && monitoring.cron.scheduleConfigured
    && monitoring.cron.secretConfigured
    && monitoring.cron.alertsConfigured
    ? "ok"
    : "missing";
}

function isSafeHttpsUrl(value: string | undefined) {
  const trimmed = value?.trim();
  if (!trimmed) {
    return false;
  }
  try {
    const url = new URL(trimmed);
    return url.protocol === "https:";
  } catch {
    return false;
  }
}

function getDatabaseProvider(databaseUrl: string | undefined): "neon" | "postgres" {
  const configuredProvider = process.env.AAIS_DATABASE_PROVIDER?.trim().toLowerCase();
  if (configuredProvider === "neon" || configuredProvider === "postgres") {
    return configuredProvider;
  }
  try {
    const hostname = new URL(databaseUrl ?? "").hostname.toLowerCase();
    return hostname.endsWith(".neon.tech") ? "neon" : "postgres";
  } catch {
    return "postgres";
  }
}

function getStorageStatus(input: {
  databaseConfigured: boolean;
  production: boolean;
  storageProbeStatus: "connected" | "not_configured" | "failed";
}): AaisReadinessCheckStatus {
  if (!input.databaseConfigured) {
    return input.production ? "missing" : "ok";
  }
  return input.storageProbeStatus === "connected" ? "ok" : "blocked";
}

function getAiStatus(input: {
  aiProvider: AaisReadinessReport["checks"]["ai"]["provider"];
  aiApproved: boolean;
  production: boolean;
  aiEvalManifestStatus: AaisAiEvalManifestStatus;
}): AaisReadinessCheckStatus {
  if (input.aiProvider !== "openai-compatible" || !input.production) {
    return "ok";
  }
  return input.aiApproved && input.aiEvalManifestStatus === "verified" ? "ok" : "blocked";
}

function getOidcStatus(input: {
  configured: boolean;
  production: boolean;
  roleMappingConfigured: boolean;
}): AaisReadinessCheckStatus {
  if (!input.configured) {
    return input.production ? "missing" : "ok";
  }
  if (input.production && !input.roleMappingConfigured) {
    return "blocked";
  }
  return "ok";
}

function getAaisReleaseMetadata(): AaisReadinessReport["release"] {
  const releaseId = readSafeReleaseId(process.env.AAIS_RELEASE_ID);
  const vercelGitCommitShortSha = readSafeGitCommitShortSha(process.env.VERCEL_GIT_COMMIT_SHA);
  const explicitGitCommitShortSha = readSafeGitCommitShortSha(process.env.AAIS_DEPLOYMENT_GIT_COMMIT_SHA);
  const gitCommitShortSha = vercelGitCommitShortSha ?? explicitGitCommitShortSha;
  return {
    id: releaseId,
    source: releaseId ? "AAIS_RELEASE_ID" : "missing",
    deployment: {
      provider: process.env.VERCEL ? "vercel" : "unknown",
      gitCommit: {
        present: Boolean(gitCommitShortSha),
        shortSha: gitCommitShortSha,
        source: vercelGitCommitShortSha
          ? "VERCEL_GIT_COMMIT_SHA"
          : explicitGitCommitShortSha
            ? "AAIS_DEPLOYMENT_GIT_COMMIT_SHA"
            : "missing",
      },
    },
  };
}

function readSafeReleaseId(value: string | undefined) {
  const trimmed = String(value ?? "").trim();
  return /^[A-Za-z0-9][A-Za-z0-9._:-]{2,127}$/.test(trimmed) ? trimmed : null;
}

function readSafeGitCommitShortSha(value: string | undefined) {
  const trimmed = String(value ?? "").trim().toLowerCase();
  return /^[a-f0-9]{7,40}$/.test(trimmed) ? trimmed.slice(0, 12) : null;
}

async function readPersistentOutboxStatus() {
  try {
    return await getAaisPersistentLrsOutboxStatus();
  } catch {
    return {
      pending: 0,
      retry: 0,
      sent: 0,
      deadLetter: 0,
      total: 0,
      coalescing: {
        enabled: false,
        windowSeconds: 30,
        events: ["artifact_saved", "artifact_edited", "planning_submitted"],
        strategy: "latest-write-wins" as const,
      },
      recovery: {
        deadLetterRequeue: false,
        action: "POST /api/learning/lrs/outbox/flush?action=requeue-dead-letter",
        auth: ["admin-session-csrf", "bearer-token"],
        redaction: "payloads-excluded" as const,
      },
    };
  }
}

function isProductionRuntime() {
  return process.env.NODE_ENV === "production" || process.env.VERCEL_ENV === "production";
}
