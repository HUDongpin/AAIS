import { createHash } from "node:crypto";
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
  const agentEvidence = getAaisAgentEvidenceCapability();
  const lrsConfigured = getLrsConfigurationStatus().configured;
  const oidcConfig = getAaisOidcConfigurationStatus();
  const oidcRoleMapping = getAaisOidcRoleMappingStatus();
  const ssoOnlyRequired = production && trialAccounts.status === "disabled";
  const aiProvider = getConfiguredAiProvider();
  const aiModel = process.env.AAIS_AI_MODEL?.trim() || null;
  const aiModelFingerprint = aiProvider === "openai-compatible" && aiModel
    ? getAiModelFingerprint(aiModel)
    : null;
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

function getConfiguredAiProvider(): AaisReadinessReport["checks"]["ai"]["provider"] {
  const provider = process.env.AAIS_AI_PROVIDER;
  const endpoint = process.env.AAIS_AI_ENDPOINT?.trim();
  const apiKey = process.env.AAIS_AI_API_KEY?.trim();
  const model = process.env.AAIS_AI_MODEL?.trim();
  return provider === "openai-compatible" && endpoint && apiKey && model
    ? "openai-compatible"
    : "deterministic";
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

function getAiModelFingerprint(model: string) {
  return createHash("sha256")
    .update(`aais-ai-model:${model}`)
    .digest("hex")
    .slice(0, 16);
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
