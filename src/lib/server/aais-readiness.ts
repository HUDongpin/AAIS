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
  getAaisAiEvalApproval,
  type AaisAiEvalManifestStatus,
} from "@/lib/server/aais-ai-eval-manifest";
import {
  readAaisAiRuntimeConfig,
  type AaisAiRuntimeProfile,
} from "@/lib/ai/aais-ai-runtime-config";
import {
  getAaisResearchConfiguration,
  isAaisResearchModeEnabled,
  requiresAaisResearchDataPlaneIsolation,
  type AaisResearchConfiguration,
} from "@/lib/server/aais-research-contract";
import { getAaisResearchLrsConfigurationStatus } from "@/lib/server/aais-research-lrs";
import { isAaisResearchGovernanceEvidenceFresh } from "@/lib/server/aais-research-launch";
import { getAaisSessionSecretConfigurationStatus } from "@/lib/server/aais-session-secret";
import { getAaisProductPseudonymConfigurationStatus } from "@/lib/server/aais-product-pseudonym";
import {
  areAaisOpaqueSecretsDistinct,
  isAaisStrongOpaqueSecret,
} from "@/lib/server/aais-opaque-secret";
import { inspectAaisAuthDeliveryConfiguration } from "@/lib/server/aais-auth-delivery";
import {
  createAaisNeonQueryClient,
  createAaisPostgresPool,
} from "@/lib/server/aais-postgres-pool";
import {
  getAaisReleaseMetadata,
  type AaisReleaseMetadata,
} from "@/lib/server/aais-deployment-metadata";

type AaisReadinessCheckStatus = "ok" | "missing" | "blocked" | "invalid" | "disabled";

type AaisReadinessCheck = {
  status: AaisReadinessCheckStatus;
};

type AaisAuthEmailOutboxProbe = {
  schema: "current" | "missing_or_unreachable" | "not_run";
  queueAvailable: boolean;
  pending: number;
  retry: number;
  sending: number;
  sent: number;
  deadLetter: number;
  uncertain: number;
  total: number;
};

type AaisResearchOperationalProbe = {
  available: boolean;
  eventDeadLetter: number;
  deletionDeadLetter: number;
  blockedActiveVisits: number;
  staleRawTextWriteLeases: number;
};

export type AaisReadinessReport = {
  status: "ready" | "not_ready";
  runtime: "production" | "development";
  readinessMode: "traffic" | "enterprise";
  checkedAt: string;
  release: AaisReleaseMetadata;
  checks: {
    session: AaisReadinessCheck;
    productPseudonym: AaisReadinessCheck & {
      configured: boolean;
      formatValid: boolean;
      distinct: boolean;
      algorithm: "hmac-sha256-128";
      emitVersion: "v2";
      source: "environment" | "development-default" | "missing";
    };
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
    authDelivery: AaisReadinessCheck & {
      configurationStatus: "configured" | "invalid" | "not_configured";
      appBaseUrlConfigured: boolean;
      providerConfigured: boolean;
      encryptionSecretValid: boolean;
      operatorAuthorized: boolean;
      schema: "current" | "missing_or_unreachable" | "not_run";
      queue: {
        status: "ok" | "degraded" | "not_run";
        metrics: {
          pending: number;
          retry: number;
          sending: number;
          sent: number;
          deadLetter: number;
          uncertain: number;
          total: number;
        };
      };
      reconciliation: {
        auth: "admin_session_csrf";
        evidenceRequired: true;
        automaticUncertainRelease: false;
      };
    };
    lrs: AaisReadinessCheck & {
      configurationStatus: "valid" | "missing" | "invalid";
      outbox: {
        status: "ok" | "degraded" | "failed";
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
      evalSource: "configured" | "bundled" | null;
      modelFingerprint: string | null;
      runtimeProfile: AaisAiRuntimeProfile;
    };
    research: AaisReadinessCheck & {
      enabled: boolean;
      applicationReady: boolean;
      studyLaunchReady: boolean;
      configuration: AaisReadinessCheck & {
        dedicatedDatabase: boolean;
        databaseTargetNonCollision: boolean;
        postgresOnly: true;
      };
      roster: AaisReadinessCheck & {
        mode: "formal" | "rehearsal" | "disabled";
        participantCount: number;
        required: {
          minimum: number;
          maximum: number;
        };
      };
      storage: AaisReadinessCheck & {
        mode: "postgres" | "not_required";
        probe: "connected" | "failed" | "not_run" | "not_required";
        schema: "current" | "missing_or_unreachable" | "not_run" | "not_required";
        sourceOfTruth: "postgres";
      };
      operations: AaisReadinessCheck & AaisResearchOperationalProbe;
      lrs: AaisReadinessCheck & {
        configured: boolean;
        dedicated: boolean;
        configurationIsolated: boolean;
        storeConfigured: boolean;
        credentialsConfigured: boolean;
        receiptVerificationConfigured: boolean;
        receiptVerifyingKeyIdConfigured: boolean;
      };
      access: AaisReadinessCheck & {
        piConfigured: boolean;
        custodianConfigured: boolean;
        exportActorsConfigured: boolean;
        exportEnabled: boolean;
      };
      workers: AaisReadinessCheck & {
        flushTokenConfigured: boolean;
        retentionTokenConfigured: boolean;
        tokensDistinct: boolean;
        eventFlushScheduleConfigured: boolean;
        deletionScheduleConfigured: boolean;
        retentionScheduleConfigured: boolean;
      };
      evidence: AaisReadinessCheck & {
        databaseIsolationReceiptConfigured: boolean;
        lrsIsolationReceiptConfigured: boolean;
        zeroBaselineReceiptConfigured: boolean;
        putDeleteReceiptConfigured: boolean;
        backupPolicyReceiptConfigured: boolean;
        restoreReceiptConfigured: boolean;
        legacyArchiveReceiptConfigured: boolean;
        accessRegisterReceiptConfigured: boolean;
        consentLegalBasisReceiptConfigured: boolean;
        dpaReceiptConfigured: boolean;
        dataRegionReceiptConfigured: boolean;
        dailyBackupReceiptConfigured: boolean;
        backupDestructionReceiptConfigured: boolean;
        governanceManifestReceiptConfigured: boolean;
        governanceEvidenceFresh: boolean;
      };
    };
  };
  issues: string[];
  warnings: string[];
  secrets: "redacted";
};

export async function getAaisReadinessReport(now = new Date()): Promise<AaisReadinessReport> {
  const production = isProductionRuntime();
  const readinessMode = readAaisReadinessMode();
  const issues: string[] = [];
  const warnings: string[] = [];
  const operationalGaps = readinessMode === "enterprise" ? issues : warnings;
  const sessionSecret = getAaisSessionSecretConfigurationStatus();
  const productPseudonym = getAaisProductPseudonymConfigurationStatus();
  const trialAccounts = getAaisTrialAccountConfigurationStatus();
  const databaseConfig = getAaisDatabaseConfiguration();
  const databaseConfigured = Boolean(databaseConfig);
  const databaseProvider = databaseConfig
    ? getDatabaseProvider(databaseConfig.url)
    : "file";
  // These dependency checks do not consume one another's results. Start them
  // together so a slow database/LRS/research branch cannot multiply the
  // readiness latency by forcing every independent probe to wait in series.
  const storageProbePromise = probeAaisLearningStorage();
  const persistentOutboxPromise = readPersistentOutboxStatus();
  const authDeliveryProbePromise = databaseConfig
    ? probeAaisAuthEmailOutboxSchema(databaseConfig.url)
    : Promise.resolve(createNotRunAuthEmailOutboxProbe());
  const researchPromise = getAaisResearchReadinessStatus(now);
  const authDeliveryConfiguration = inspectAaisAuthDeliveryConfiguration();
  const operatorSecrets = getAaisProductOperatorSecretStatus();
  const monitoring = getAaisMonitoringConfigurationStatus(operatorSecrets);
  const agentEvidence = getAaisAgentEvidenceCapability();
  const lrsConfiguration = getLrsConfigurationStatus();
  const lrsConfigured = lrsConfiguration.configured;
  const oidcConfig = getAaisOidcConfigurationStatus();
  const oidcRoleMapping = getAaisOidcRoleMappingStatus();
  const ssoOnlyRequired = production && trialAccounts.status === "disabled";
  const aiRuntimeConfig = readAaisAiRuntimeConfig();
  const aiEndpointConfigurationValid = aiRuntimeConfig.configurationStatus.primary !== "invalid"
    && aiRuntimeConfig.configurationStatus.fallback !== "invalid";
  const aiModel = aiRuntimeConfig.primary?.model ?? null;
  const aiFallbackModel = aiRuntimeConfig.fallback?.model ?? null;
  const aiProvider = aiRuntimeConfig.profile.mode === "live" ? "openai-compatible" : "deterministic";
  const aiModelFingerprint = aiRuntimeConfig.profile.primary?.modelFingerprint ?? null;
  const aiEvalApproval = getAaisAiEvalApproval({
    required: production && aiProvider === "openai-compatible",
    provider: aiProvider,
    model: aiModel,
    runtime: aiRuntimeConfig.primary
      ? {
          endpoint: aiRuntimeConfig.primary.endpoint,
          thinkingMode: aiRuntimeConfig.primary.profile.thinkingMode,
          maxTokens: aiRuntimeConfig.primary.maxTokens,
          maxRetries: aiRuntimeConfig.primary.maxRetries,
        }
      : null,
  });
  const aiFallbackEvalApproval = aiFallbackModel
    ? getAaisAiEvalApproval({
        required: production && aiProvider === "openai-compatible",
        provider: aiProvider,
        model: aiFallbackModel,
        providerRole: "fallback",
        runtime: aiRuntimeConfig.fallback
          ? {
              endpoint: aiRuntimeConfig.fallback.endpoint,
              thinkingMode: aiRuntimeConfig.fallback.profile.thinkingMode,
              maxTokens: aiRuntimeConfig.fallback.maxTokens,
              maxRetries: aiRuntimeConfig.fallback.maxRetries,
            }
          : null,
      })
    : null;
  const aiEvalVersion = aiEvalApproval.evalVersion;
  const aiEvalManifest = aiEvalApproval.manifest;
  const aiApproved = aiEvalApproval.approved
    && (aiFallbackEvalApproval?.approved ?? true);
  const release = getAaisReleaseMetadata();
  const [storageProbe, persistentOutbox, authDeliveryProbe, research] = await Promise.all([
    storageProbePromise,
    persistentOutboxPromise,
    authDeliveryProbePromise,
    researchPromise,
  ]);
  const authDeliverySchema = authDeliveryProbe.schema;
  const authDeliveryQueueHealthy = authDeliveryProbe.queueAvailable
    && authDeliveryProbe.deadLetter === 0
    && authDeliveryProbe.uncertain === 0;
  const persistentOutboxHealthy = persistentOutbox.available
    && persistentOutbox.deadLetter === 0;
  const researchIsolationRequired = requiresAaisResearchDataPlaneIsolation();

  if (production && release.deployment.provider === "unknown") {
    issues.push("AAIS_DEPLOYMENT_PROVIDER");
  }
  if (production && (!release.id || !release.deployment.gitCommit.present)) {
    issues.push("AAIS_RELEASE_METADATA");
  }

  if (production && !sessionSecret.valid) {
    issues.push("AAIS_SESSION_SECRET");
  }
  if (production && (!productPseudonym.configured || !productPseudonym.formatValid)) {
    issues.push("AAIS_PRODUCT_PSEUDONYM_SECRET");
  }
  if (production && !productPseudonym.distinct) {
    issues.push("AAIS_PRODUCT_PSEUDONYM_SECRET_DISTINCT");
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
  if (
    production
    && (
      !authDeliveryConfiguration.appBaseUrlValid
      || !authDeliveryConfiguration.appBaseUrlConfigured
      || !authDeliveryConfiguration.emailProviderValid
      || !authDeliveryConfiguration.emailProviderConfigured
    )
  ) {
    issues.push("AAIS_AUTH_DELIVERY_CONFIGURATION");
  }
  if (
    production
    && (
      !operatorSecrets.authEmailWorkerAuthorized
      || !operatorSecrets.authEmailOutboxTokenValid
    )
  ) {
    issues.push("AAIS_AUTH_EMAIL_OUTBOX_OPERATOR_SECRET");
  }
  if (
    production
    && databaseConfigured
    && storageProbe.status === "connected"
    && authDeliverySchema !== "current"
  ) {
    issues.push("AAIS_AUTH_EMAIL_OUTBOX_SCHEMA");
  }
  if (
    databaseConfigured
    && authDeliverySchema === "current"
    && !authDeliveryQueueHealthy
  ) {
    issues.push("AAIS_AUTH_EMAIL_OUTBOX_HEALTH");
  }
  if (production && !lrsConfigured && !researchIsolationRequired) {
    operationalGaps.push(lrsConfiguration.configurationStatus === "invalid"
      ? "AAIS_LRS_ENDPOINT_CONFIGURATION"
      : "LRS_ENDPOINT/LRS_USERNAME/LRS_PASSWORD");
  }
  if (!researchIsolationRequired && !persistentOutbox.available) {
    issues.push("AAIS_LRS_OUTBOX_STATUS");
  }
  if (
    !researchIsolationRequired
    && persistentOutbox.available
    && persistentOutbox.deadLetter > 0
  ) {
    issues.push("AAIS_LRS_OUTBOX_DEAD_LETTER");
  }
  if (production && !monitoring.sentry.dsnConfigured) {
    operationalGaps.push("SENTRY_DSN/NEXT_PUBLIC_SENTRY_DSN");
  }
  if (production && !monitoring.sentry.alertsConfigured) {
    operationalGaps.push("AAIS_SENTRY_ALERTS_CONFIGURED");
  }
  if (production && !monitoring.uptime.loginCheckConfigured) {
    operationalGaps.push("AAIS_UPTIME_LOGIN_CHECK_URL");
  }
  if (production && !monitoring.cron.secretConfigured) {
    operationalGaps.push("CRON_SECRET");
  }
  if (production && !operatorSecrets.outboxTokenValid) {
    issues.push("AAIS_LRS_OUTBOX_FLUSH_TOKEN");
  }
  if (production && !operatorSecrets.readinessTokenValid) {
    issues.push("AAIS_READINESS_BEARER_TOKEN");
  }
  if (production && !operatorSecrets.distinct) {
    issues.push("AAIS_OPERATOR_TOKENS_DISTINCT");
  }
  if (production && !monitoring.cron.alertsConfigured) {
    operationalGaps.push("AAIS_CRON_FAILURE_ALERTS_CONFIGURED");
  }
  if (ssoOnlyRequired && !oidcConfig.configured) {
    issues.push("AAIS_OIDC_*");
  }
  if (ssoOnlyRequired && oidcConfig.configured && !oidcRoleMapping.configured) {
    issues.push("AAIS_OIDC_ROLE_MAPPING");
  }
  if (production && !aiEndpointConfigurationValid) {
    issues.push("AAIS_AI_ENDPOINT_CONFIGURATION");
  }
  if (production && aiProvider === "openai-compatible" && !aiEvalApproval.approved) {
    issues.push("AAIS_AI_EVAL_APPROVED/AAIS_AI_EVAL_VERSION");
  }
  if (
    production
    && aiProvider === "openai-compatible"
    && aiFallbackEvalApproval
    && !aiFallbackEvalApproval.approved
  ) {
    issues.push("AAIS_AI_FALLBACK_EVAL_MANIFEST");
  }
  if (production && aiProvider === "openai-compatible" && aiEvalManifest.issue) {
    issues.push(aiEvalManifest.issue);
  }
  if (researchIsolationRequired && !isAaisResearchModeEnabled()) {
    issues.push("AAIS_RESEARCH_MODE");
  }
  if (research.enabled && research.configuration.status !== "ok") {
    issues.push("AAIS_RESEARCH_CONFIGURATION");
  }
  if (research.enabled && research.roster.status !== "ok") {
    issues.push("AAIS_RESEARCH_PARTICIPANT_ACTOR_IDS");
  }
  if (
    research.enabled
    && research.configuration.status === "ok"
    && research.storage.status !== "ok"
  ) {
    issues.push("AAIS_RESEARCH_DATABASE_SCHEMA");
  }
  if (research.enabled && research.lrs.status !== "ok") {
    issues.push("AAIS_RESEARCH_LRS_CONFIGURATION");
  }
  if (research.enabled && research.access.status !== "ok") {
    issues.push("AAIS_RESEARCH_ACCESS_GRANTS");
  }
  if (research.enabled && research.workers.status !== "ok") {
    issues.push("AAIS_RESEARCH_WORKER_CONFIGURATION");
  }
  if (
    research.enabled
    && research.storage.status === "ok"
    && research.operations.status !== "ok"
  ) {
    issues.push("AAIS_RESEARCH_OPERATIONAL_HEALTH");
  }
  if (research.enabled && research.evidence.status !== "ok") {
    issues.push("AAIS_RESEARCH_LAUNCH_EVIDENCE");
  }

  return {
    status: issues.length ? "not_ready" : "ready",
    runtime: production ? "production" : "development",
    readinessMode,
    checkedAt: now.toISOString(),
    release,
    checks: {
      session: {
        status: sessionSecret.valid
          ? "ok"
          : sessionSecret.configured ? "invalid" : "missing",
      },
      productPseudonym: {
        status: productPseudonym.valid
          ? "ok"
          : productPseudonym.configured ? "invalid" : "missing",
        configured: productPseudonym.configured,
        formatValid: productPseudonym.formatValid,
        distinct: productPseudonym.distinct,
        algorithm: productPseudonym.algorithm,
        emitVersion: productPseudonym.emitVersion,
        source: productPseudonym.source,
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
      authDelivery: {
        status: authDeliveryConfiguration.status === "configured"
          && operatorSecrets.authEmailWorkerAuthorized
          && authDeliverySchema === "current"
          && authDeliveryQueueHealthy
          ? "ok"
          : authDeliverySchema === "not_run" ? "blocked" : "invalid",
        configurationStatus: authDeliveryConfiguration.status,
        appBaseUrlConfigured: authDeliveryConfiguration.appBaseUrlConfigured,
        providerConfigured: authDeliveryConfiguration.emailProviderConfigured,
        encryptionSecretValid: authDeliveryConfiguration.encryptionSecretValid,
        operatorAuthorized: operatorSecrets.authEmailWorkerAuthorized,
        schema: authDeliverySchema,
        queue: {
          status: !authDeliveryProbe.queueAvailable
            ? "not_run"
            : authDeliveryQueueHealthy ? "ok" : "degraded",
          metrics: {
            pending: authDeliveryProbe.pending,
            retry: authDeliveryProbe.retry,
            sending: authDeliveryProbe.sending,
            sent: authDeliveryProbe.sent,
            deadLetter: authDeliveryProbe.deadLetter,
            uncertain: authDeliveryProbe.uncertain,
            total: authDeliveryProbe.total,
          },
        },
        reconciliation: {
          auth: "admin_session_csrf",
          evidenceRequired: true,
          automaticUncertainRelease: false,
        },
      },
      lrs: {
        status: researchIsolationRequired
          ? "disabled"
          : !persistentOutboxHealthy
            ? "blocked"
            : lrsConfigured ? "ok" : "missing",
        configurationStatus: lrsConfiguration.configurationStatus,
        outbox: {
          status: !persistentOutbox.available
            ? "failed"
            : persistentOutbox.deadLetter > 0 ? "degraded" : "ok",
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
          endpointConfigurationValid: aiEndpointConfigurationValid,
        }),
        provider: aiProvider,
        evalVersion: aiProvider === "openai-compatible" ? aiEvalVersion : null,
        evalManifest: aiEvalManifest.status,
        evalSource: aiEvalManifest.source ?? null,
        modelFingerprint: aiModelFingerprint,
        runtimeProfile: aiRuntimeConfig.profile,
      },
      research,
    },
    issues,
    warnings,
    secrets: "redacted",
  };
}

type AaisResearchReadiness = AaisReadinessReport["checks"]["research"];

async function getAaisResearchReadinessStatus(
  now: Date,
): Promise<AaisResearchReadiness> {
  if (!isAaisResearchModeEnabled()) {
    const required = requiresAaisResearchDataPlaneIsolation();
    const status = required ? "blocked" : "disabled";
    return {
      status,
      enabled: false,
      applicationReady: false,
      studyLaunchReady: false,
      configuration: {
        status,
        dedicatedDatabase: false,
        databaseTargetNonCollision: false,
        postgresOnly: true,
      },
      roster: {
        status,
        mode: "disabled",
        participantCount: 0,
        required: { minimum: 0, maximum: 0 },
      },
      storage: {
        status,
        mode: required ? "postgres" : "not_required",
        probe: required ? "not_run" : "not_required",
        schema: required ? "not_run" : "not_required",
        sourceOfTruth: "postgres",
      },
      operations: {
        status,
        ...createUnavailableAaisResearchOperationalProbe(),
      },
      lrs: {
        status,
        configured: false,
        dedicated: false,
        configurationIsolated: false,
        storeConfigured: false,
        credentialsConfigured: false,
        receiptVerificationConfigured: false,
        receiptVerifyingKeyIdConfigured: false,
      },
      access: {
        status,
        piConfigured: false,
        custodianConfigured: false,
        exportActorsConfigured: false,
        exportEnabled: false,
      },
      workers: {
        status,
        flushTokenConfigured: false,
        retentionTokenConfigured: false,
        tokensDistinct: false,
        eventFlushScheduleConfigured: false,
        deletionScheduleConfigured: false,
        retentionScheduleConfigured: false,
      },
      evidence: {
        status,
        databaseIsolationReceiptConfigured: false,
        lrsIsolationReceiptConfigured: false,
        zeroBaselineReceiptConfigured: false,
        putDeleteReceiptConfigured: false,
        backupPolicyReceiptConfigured: false,
        restoreReceiptConfigured: false,
        legacyArchiveReceiptConfigured: false,
        accessRegisterReceiptConfigured: false,
        consentLegalBasisReceiptConfigured: false,
        dpaReceiptConfigured: false,
        dataRegionReceiptConfigured: false,
        dailyBackupReceiptConfigured: false,
        backupDestructionReceiptConfigured: false,
        governanceManifestReceiptConfigured: false,
        governanceEvidenceFresh: false,
      },
    };
  }

  const roster = readAaisResearchRosterReadiness();
  let configuration: AaisResearchConfiguration | null = null;
  try {
    configuration = getAaisResearchConfiguration();
  } catch {
    // Readiness deliberately reports only a stable issue name, never parser
    // errors that might contain deployment configuration or credentials.
  }

  const lrsConfiguration = getAaisResearchLrsConfigurationStatus();
  const lrsCredentialFieldsPresent = [
    process.env.AAIS_RESEARCH_LRS_ENDPOINT,
    process.env.AAIS_RESEARCH_LRS_USERNAME,
    process.env.AAIS_RESEARCH_LRS_PASSWORD,
  ].every((value) => Boolean(value?.trim()));
  const lrsStoreConfigured = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(
    process.env.AAIS_RESEARCH_LRS_STORE_ID?.trim() ?? "",
  );
  const storageProbe = configuration
    ? await probeAaisResearchStorage(configuration)
    : {
        probe: "not_run" as const,
        schema: "not_run" as const,
        operations: createUnavailableAaisResearchOperationalProbe(),
      };
  const configurationReady = Boolean(configuration);
  const storageReady = storageProbe.probe === "connected"
    && storageProbe.schema === "current";
  const operationsReady = storageProbe.operations.available
    && storageProbe.operations.eventDeadLetter === 0
    && storageProbe.operations.deletionDeadLetter === 0
    && storageProbe.operations.blockedActiveVisits === 0
    && storageProbe.operations.staleRawTextWriteLeases === 0;
  const lrsReady = lrsConfiguration.configured
    && lrsCredentialFieldsPresent
    && lrsStoreConfigured;
  const access = readAaisResearchAccessReadiness();
  const workers = readAaisResearchWorkerReadiness();
  const evidence = readAaisResearchEvidenceReadiness(now);
  const applicationReady = configurationReady
    && roster.status === "ok"
    && storageReady
    && lrsReady;
  const studyLaunchReady = applicationReady
    && operationsReady
    && access.status === "ok"
    && workers.status === "ok"
    && evidence.status === "ok";
  const status: AaisReadinessCheckStatus = studyLaunchReady
    ? "ok"
    : configurationReady && roster.status === "ok" && lrsReady
      ? "blocked"
      : "invalid";

  return {
    status,
    enabled: true,
    applicationReady,
    studyLaunchReady,
    configuration: {
      status: configurationReady ? "ok" : "invalid",
      dedicatedDatabase: configurationReady
        && evidence.databaseIsolationReceiptConfigured,
      databaseTargetNonCollision: configurationReady,
      postgresOnly: true,
    },
    roster,
    storage: {
      status: storageReady ? "ok" : "blocked",
      mode: "postgres",
      probe: storageProbe.probe,
      schema: storageProbe.schema,
      sourceOfTruth: "postgres",
    },
    operations: {
      status: operationsReady ? "ok" : "blocked",
      ...storageProbe.operations,
    },
    lrs: {
      status: lrsReady ? "ok" : "invalid",
      configured: lrsReady,
      dedicated: lrsReady && evidence.lrsIsolationReceiptConfigured,
      configurationIsolated: lrsConfiguration.configured,
      storeConfigured: lrsStoreConfigured,
      credentialsConfigured: lrsCredentialFieldsPresent,
      receiptVerificationConfigured: lrsConfiguration.receiptVerificationConfigured,
      receiptVerifyingKeyIdConfigured: lrsConfiguration.receiptVerifyingKeyIdConfigured,
    },
    access,
    workers,
    evidence,
  };
}

function readAaisResearchAccessReadiness(): AaisResearchReadiness["access"] {
  const piConfigured = isValidActorAllowlist(process.env.AAIS_RESEARCH_PI_ACTOR_IDS);
  const custodianConfigured = isValidActorAllowlist(
    process.env.AAIS_RESEARCH_DATA_CUSTODIAN_ACTOR_IDS,
  );
  const exportActorsConfigured = isValidActorAllowlist(
    process.env.AAIS_RESEARCH_EXPORT_ACTOR_IDS,
  );
  const exportEnabled = process.env.AAIS_RESEARCH_EXPORT_ENABLED?.trim().toLowerCase() === "true";
  const ready = piConfigured && custodianConfigured && exportActorsConfigured && exportEnabled;
  return {
    status: ready ? "ok" : "missing",
    piConfigured,
    custodianConfigured,
    exportActorsConfigured,
    exportEnabled,
  };
}

function readAaisResearchWorkerReadiness(): AaisResearchReadiness["workers"] {
  const flushToken = process.env.AAIS_RESEARCH_LRS_OUTBOX_FLUSH_TOKEN?.trim() ?? "";
  const retentionToken = process.env.AAIS_RESEARCH_RETENTION_TOKEN?.trim() ?? "";
  const flushTokenConfigured = isAaisStrongOpaqueSecret(flushToken);
  const retentionTokenConfigured = isAaisStrongOpaqueSecret(retentionToken);
  const forbiddenTokens = [
    process.env.AAIS_LRS_OUTBOX_FLUSH_TOKEN,
    process.env.CRON_SECRET,
    process.env.AAIS_RESEARCH_LRS_USERNAME,
    process.env.AAIS_RESEARCH_LRS_PASSWORD,
    process.env.AAIS_SESSION_SECRET,
  ].map((value) => value?.trim()).filter(Boolean);
  const tokensDistinct = flushTokenConfigured
    && retentionTokenConfigured
    && flushToken !== retentionToken
    && !forbiddenTokens.includes(flushToken)
    && !forbiddenTokens.includes(retentionToken);
  const eventFlushScheduleConfigured = isSafeReceiptId(
    process.env.AAIS_RESEARCH_LRS_EVENT_FLUSH_SCHEDULE_ID,
  );
  const deletionScheduleConfigured = isSafeReceiptId(
    process.env.AAIS_RESEARCH_LRS_DELETION_SCHEDULE_ID,
  );
  const retentionScheduleConfigured = isSafeReceiptId(
    process.env.AAIS_RESEARCH_RETENTION_SCHEDULE_ID,
  );
  const scheduleIds = [
    process.env.AAIS_RESEARCH_LRS_EVENT_FLUSH_SCHEDULE_ID?.trim(),
    process.env.AAIS_RESEARCH_LRS_DELETION_SCHEDULE_ID?.trim(),
    process.env.AAIS_RESEARCH_RETENTION_SCHEDULE_ID?.trim(),
  ];
  const ready = tokensDistinct
    && eventFlushScheduleConfigured
    && deletionScheduleConfigured
    && retentionScheduleConfigured
    && new Set(scheduleIds).size === scheduleIds.length;
  return {
    status: ready ? "ok" : "missing",
    flushTokenConfigured,
    retentionTokenConfigured,
    tokensDistinct,
    eventFlushScheduleConfigured,
    deletionScheduleConfigured,
    retentionScheduleConfigured,
  };
}

function readAaisResearchEvidenceReadiness(
  now: Date,
): AaisResearchReadiness["evidence"] {
  const receiptValues = [
    process.env.AAIS_RESEARCH_DATABASE_ISOLATION_RECEIPT_SHA256,
    process.env.AAIS_RESEARCH_LRS_ISOLATION_RECEIPT_SHA256,
    process.env.AAIS_RESEARCH_LRS_ZERO_BASELINE_RECEIPT_SHA256,
    process.env.AAIS_RESEARCH_LRS_PUT_DELETE_RECEIPT_SHA256,
    process.env.AAIS_RESEARCH_BACKUP_POLICY_RECEIPT_SHA256,
    process.env.AAIS_RESEARCH_RESTORE_RECEIPT_SHA256,
    process.env.AAIS_RESEARCH_LEGACY_ARCHIVE_RECEIPT_SHA256,
    process.env.AAIS_RESEARCH_ACCESS_REGISTER_RECEIPT_SHA256,
    process.env.AAIS_RESEARCH_CONSENT_LEGAL_BASIS_RECEIPT_SHA256,
    process.env.AAIS_RESEARCH_DPA_RECEIPT_SHA256,
    process.env.AAIS_RESEARCH_DATA_REGION_RECEIPT_SHA256,
    process.env.AAIS_RESEARCH_DAILY_BACKUP_RECEIPT_SHA256,
    process.env.AAIS_RESEARCH_BACKUP_DESTRUCTION_RECEIPT_SHA256,
    process.env.AAIS_RESEARCH_GOVERNANCE_MANIFEST_RECEIPT_SHA256,
  ].map((value) => value?.trim().toLowerCase() ?? "");
  const evidence = {
    databaseIsolationReceiptConfigured: isSha256Receipt(
      process.env.AAIS_RESEARCH_DATABASE_ISOLATION_RECEIPT_SHA256,
    ),
    lrsIsolationReceiptConfigured: isSha256Receipt(
      process.env.AAIS_RESEARCH_LRS_ISOLATION_RECEIPT_SHA256,
    ),
    zeroBaselineReceiptConfigured: isSha256Receipt(
      process.env.AAIS_RESEARCH_LRS_ZERO_BASELINE_RECEIPT_SHA256,
    ),
    putDeleteReceiptConfigured: isSha256Receipt(
      process.env.AAIS_RESEARCH_LRS_PUT_DELETE_RECEIPT_SHA256,
    ),
    backupPolicyReceiptConfigured: isSha256Receipt(
      process.env.AAIS_RESEARCH_BACKUP_POLICY_RECEIPT_SHA256,
    ),
    restoreReceiptConfigured: isSha256Receipt(
      process.env.AAIS_RESEARCH_RESTORE_RECEIPT_SHA256,
    ),
    legacyArchiveReceiptConfigured: isSha256Receipt(
      process.env.AAIS_RESEARCH_LEGACY_ARCHIVE_RECEIPT_SHA256,
    ),
    accessRegisterReceiptConfigured: isSha256Receipt(
      process.env.AAIS_RESEARCH_ACCESS_REGISTER_RECEIPT_SHA256,
    ),
    consentLegalBasisReceiptConfigured: isSha256Receipt(
      process.env.AAIS_RESEARCH_CONSENT_LEGAL_BASIS_RECEIPT_SHA256,
    ),
    dpaReceiptConfigured: isSha256Receipt(
      process.env.AAIS_RESEARCH_DPA_RECEIPT_SHA256,
    ),
    dataRegionReceiptConfigured: isSha256Receipt(
      process.env.AAIS_RESEARCH_DATA_REGION_RECEIPT_SHA256,
    ),
    dailyBackupReceiptConfigured: isSha256Receipt(
      process.env.AAIS_RESEARCH_DAILY_BACKUP_RECEIPT_SHA256,
    ),
    backupDestructionReceiptConfigured: isSha256Receipt(
      process.env.AAIS_RESEARCH_BACKUP_DESTRUCTION_RECEIPT_SHA256,
    ),
    governanceManifestReceiptConfigured: isSha256Receipt(
      process.env.AAIS_RESEARCH_GOVERNANCE_MANIFEST_RECEIPT_SHA256,
    ),
    governanceEvidenceFresh: isAaisResearchGovernanceEvidenceFresh(
      process.env,
      now,
    ),
  };
  return {
    status: Object.values(evidence).every(Boolean)
      && new Set(receiptValues).size === receiptValues.length
      ? "ok"
      : "missing",
    ...evidence,
  };
}

function isValidActorAllowlist(value: string | undefined) {
  const ids = (value ?? "").split(",").map((item) => item.trim()).filter(Boolean);
  return ids.length > 0
    && new Set(ids).size === ids.length
    && ids.every((id) => /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(id));
}

function isSafeReceiptId(value: string | undefined) {
  return /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(value?.trim() ?? "");
}

function isSha256Receipt(value: string | undefined) {
  return /^[0-9a-f]{64}$/i.test(value?.trim() ?? "");
}

function readAaisResearchRosterReadiness(): AaisResearchReadiness["roster"] {
  const rehearsalMode = process.env.AAIS_RESEARCH_REHEARSAL_MODE?.trim().toLowerCase() === "true";
  const participantIds = (process.env.AAIS_RESEARCH_PARTICIPANT_ACTOR_IDS ?? "")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);
  const required = rehearsalMode
    ? { minimum: 3, maximum: 5 }
    : { minimum: 30, maximum: 30 };
  const rehearsalApproved = !rehearsalMode || (
    process.env.AAIS_RESEARCH_ENVIRONMENT?.trim().toLowerCase() === "research"
    && process.env.AAIS_RESEARCH_REHEARSAL_APPROVED?.trim().toLowerCase() === "true"
  );
  const rosterValid = participantIds.length >= required.minimum
    && participantIds.length <= required.maximum
    && new Set(participantIds).size === participantIds.length
    && participantIds.every((participantId) =>
      /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(participantId))
    && rehearsalApproved;
  return {
    status: rosterValid ? "ok" : "invalid",
    mode: rehearsalMode ? "rehearsal" : "formal",
    participantCount: participantIds.length,
    required,
  };
}

async function probeAaisAuthEmailOutboxSchema(
  databaseUrl: string,
): Promise<AaisAuthEmailOutboxProbe> {
  let pool: ReturnType<typeof createAaisPostgresPool> | null = null;
  try {
    let rows: Array<Record<string, unknown>>;
    if (shouldUseNeonDatabaseDriver(databaseUrl)) {
      const client = createAaisNeonQueryClient(databaseUrl);
      const result = await client.query(aaisAuthEmailOutboxSchemaProbeSql, []);
      rows = result.rows;
    } else {
      pool = createAaisPostgresPool(databaseUrl);
      const result = await pool.query(aaisAuthEmailOutboxSchemaProbeSql);
      rows = result.rows as Array<Record<string, unknown>>;
    }
    const row = rows[0];
    const schemaCurrent = Boolean(row)
      && authEmailOutboxSchemaProbeKeys.every((key) =>
        row[key] === true || row[key] === "t" || row[key] === 1)
      && authEmailOutboxQueueMetricKeys.every((key) =>
        readNonNegativeDatabaseCount(row[key]) !== null
      );
    if (!schemaCurrent || !row) {
      return createUnavailableAuthEmailOutboxProbe();
    }
    return {
      schema: "current",
      queueAvailable: true,
      pending: readNonNegativeDatabaseCount(row.pending_count)!,
      retry: readNonNegativeDatabaseCount(row.retry_count)!,
      sending: readNonNegativeDatabaseCount(row.sending_count)!,
      sent: readNonNegativeDatabaseCount(row.sent_count)!,
      deadLetter: readNonNegativeDatabaseCount(row.dead_letter_count)!,
      uncertain: readNonNegativeDatabaseCount(row.uncertain_count)!,
      total: readNonNegativeDatabaseCount(row.total_count)!,
    };
  } catch {
    return createUnavailableAuthEmailOutboxProbe();
  } finally {
    await pool?.end().catch(() => undefined);
  }
}

function createNotRunAuthEmailOutboxProbe(): AaisAuthEmailOutboxProbe {
  return {
    ...createUnavailableAuthEmailOutboxProbe(),
    schema: "not_run",
  };
}

function createUnavailableAuthEmailOutboxProbe(): AaisAuthEmailOutboxProbe {
  return {
    schema: "missing_or_unreachable",
    queueAvailable: false,
    pending: 0,
    retry: 0,
    sending: 0,
    sent: 0,
    deadLetter: 0,
    uncertain: 0,
    total: 0,
  };
}

function readNonNegativeDatabaseCount(value: unknown) {
  const parsed = typeof value === "bigint"
    ? Number(value)
    : typeof value === "number"
      ? value
      : typeof value === "string" && /^\d+$/.test(value)
        ? Number.parseInt(value, 10)
        : Number.NaN;
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : null;
}

function shouldUseNeonDatabaseDriver(databaseUrl: string) {
  const configured = process.env.AAIS_DATABASE_DRIVER?.trim().toLowerCase();
  if (configured === "pg") {
    return false;
  }
  if (configured === "neon-serverless") {
    return true;
  }
  try {
    return new URL(databaseUrl).hostname.toLowerCase().endsWith(".neon.tech");
  } catch {
    return false;
  }
}

const authEmailOutboxSchemaProbeKeys = [
  "outbox_table",
  "required_columns",
  "token_delivery_fence_columns",
  "reconciliation_columns",
  "required_constraints",
  "reconciliation_constraint",
  "reconciliation_evidence_index",
  "reissue_guard_function",
  "reissue_guard_trigger",
  "due_index",
  "lease_index",
  "token_fence_index",
] as const;

const authEmailOutboxQueueMetricKeys = [
  "pending_count",
  "retry_count",
  "sending_count",
  "sent_count",
  "dead_letter_count",
  "uncertain_count",
  "total_count",
] as const;

const aaisAuthEmailOutboxSchemaProbeSql = `select
  to_regclass('public.aais_auth_email_outbox') is not null as outbox_table,
  (
    select count(*) = 20
       and count(*) filter (
         where column_name = 'id' and data_type = 'uuid' and is_nullable = 'NO'
       ) = 1
       and count(*) filter (
         where column_name = 'payload_envelope' and data_type = 'jsonb' and is_nullable = 'NO'
       ) = 1
       and count(*) filter (
         where column_name = 'attempt_count' and data_type = 'integer' and is_nullable = 'NO'
       ) = 1
       and count(*) filter (
         where column_name = 'next_attempt_at'
           and data_type = 'timestamp with time zone' and is_nullable = 'NO'
       ) = 1
       and count(*) filter (
         where column_name = 'lease_expires_at'
           and data_type = 'timestamp with time zone' and is_nullable = 'YES'
       ) = 1
      from information_schema.columns
     where table_schema = 'public'
       and table_name = 'aais_auth_email_outbox'
       and column_name = any(array[
         'id', 'purpose', 'auth_token_id', 'auth_token_hash', 'recipient',
         'payload_envelope', 'idempotency_key', 'status', 'attempt_count',
         'next_attempt_at', 'claim_id', 'claimed_at', 'lease_expires_at',
         'first_attempt_at', 'uncertain_since', 'sent_at', 'dead_lettered_at',
         'last_error_code', 'created_at', 'updated_at'
       ])
  ) as required_columns,
  (
    select count(*) = 4
       and count(*) filter (
         where column_name = 'email_delivery_state'
           and data_type = 'text' and is_nullable = 'NO'
       ) = 1
       and count(*) filter (
         where column_name in ('email_delivery_outbox_id', 'email_delivery_claim_id')
           and data_type = 'uuid' and is_nullable = 'YES'
       ) = 2
       and count(*) filter (
         where column_name = 'email_delivery_started_at'
           and data_type = 'timestamp with time zone' and is_nullable = 'YES'
       ) = 1
      from information_schema.columns
     where table_schema = 'public'
       and table_name = 'aais_user_auth_tokens'
       and column_name = any(array[
         'email_delivery_state', 'email_delivery_outbox_id',
         'email_delivery_claim_id', 'email_delivery_started_at'
       ])
  ) as token_delivery_fence_columns,
  (
    select count(*) = 7
       and count(*) filter (
         where column_name in (
           'reconciliation_disposition', 'reconciliation_provider',
           'reconciliation_message_id', 'reconciliation_observed_status',
           'reconciled_by'
         )
           and data_type = 'text' and is_nullable = 'YES'
       ) = 5
       and count(*) filter (
         where column_name in ('reconciliation_observed_at', 'reconciled_at')
           and data_type = 'timestamp with time zone' and is_nullable = 'YES'
       ) = 2
      from information_schema.columns
     where table_schema = 'public'
       and table_name = 'aais_auth_email_outbox'
       and column_name = any(array[
         'reconciliation_disposition', 'reconciliation_provider',
         'reconciliation_message_id', 'reconciliation_observed_status',
         'reconciliation_observed_at', 'reconciled_at', 'reconciled_by'
       ])
  ) as reconciliation_columns,
  (
    select count(*) = 3
      from pg_constraint constraint_row
      join pg_namespace namespace on namespace.oid = constraint_row.connamespace
     where namespace.nspname = 'public'
       and constraint_row.conname = any(array[
         'aais_user_auth_tokens_email_delivery_state_check',
         'aais_auth_email_outbox_claim_state_check',
         'aais_auth_email_outbox_terminal_state_check'
       ])
       and constraint_row.contype = 'c'
       and constraint_row.convalidated
  ) as required_constraints,
  (
    exists (
      select 1
        from pg_constraint constraint_row
        join pg_namespace namespace on namespace.oid = constraint_row.connamespace
       where namespace.nspname = 'public'
         and constraint_row.conname = 'aais_auth_email_outbox_reconciliation_check'
         and constraint_row.contype = 'c'
         and constraint_row.convalidated
    )
    and exists (
      select 1
        from pg_constraint constraint_row
        join pg_namespace namespace on namespace.oid = constraint_row.connamespace
       where namespace.nspname = 'public'
         and constraint_row.conname = 'aais_user_auth_tokens_email_delivery_state_check'
         and constraint_row.contype = 'c'
         and constraint_row.convalidated
         and pg_get_constraintdef(constraint_row.oid) ilike '%delivered%'
    )
  ) as reconciliation_constraint,
  exists (
    select 1 from pg_indexes
     where schemaname = 'public'
       and indexname = 'aais_auth_email_outbox_reconciliation_evidence_key'
       and indexdef ilike '%unique index%'
       and indexdef ilike '%(reconciliation_provider, reconciliation_message_id)%'
       and indexdef ilike '%reconciliation_message_id is not null%'
  ) as reconciliation_evidence_index,
  exists (
    select 1
      from pg_proc procedure
      join pg_namespace namespace on namespace.oid = procedure.pronamespace
     where namespace.nspname = 'public'
       and procedure.proname = 'aais_guard_auth_token_email_reissue'
       and pg_get_function_identity_arguments(procedure.oid) = ''
       and procedure.provolatile = 'v'
       and not procedure.prosecdef
  ) as reissue_guard_function,
  exists (
    select 1
      from pg_trigger trigger_row
      join pg_class relation on relation.oid = trigger_row.tgrelid
      join pg_namespace namespace on namespace.oid = relation.relnamespace
     where namespace.nspname = 'public'
       and relation.relname = 'aais_user_auth_tokens'
       and trigger_row.tgname = 'aais_user_auth_tokens_email_reissue_guard'
       and not trigger_row.tgisinternal
       and trigger_row.tgenabled = 'O'
  ) as reissue_guard_trigger,
  exists (
    select 1 from pg_indexes
     where schemaname = 'public'
       and indexname = 'aais_auth_email_outbox_due_idx'
       and indexdef ilike '%(next_attempt_at, created_at, id)%'
       and indexdef ilike '%pending%'
       and indexdef ilike '%retry%'
  ) as due_index,
  exists (
    select 1 from pg_indexes
     where schemaname = 'public'
       and indexname = 'aais_auth_email_outbox_lease_idx'
       and indexdef ilike '%(lease_expires_at, id)%'
       and indexdef ilike '%sending%'
  ) as lease_index,
  exists (
    select 1 from pg_indexes
     where schemaname = 'public'
       and indexname = 'aais_auth_email_outbox_token_fence_idx'
       and indexdef ilike '%(auth_token_id, auth_token_hash)%'
       and indexdef ilike '%pending%'
       and indexdef ilike '%retry%'
       and indexdef ilike '%sending%'
  ) as token_fence_index,
  (select count(*)::bigint from public.aais_auth_email_outbox where status = 'pending') as pending_count,
  (select count(*)::bigint from public.aais_auth_email_outbox where status = 'retry') as retry_count,
  (select count(*)::bigint from public.aais_auth_email_outbox where status = 'sending') as sending_count,
  (select count(*)::bigint from public.aais_auth_email_outbox where status = 'sent') as sent_count,
  (select count(*)::bigint from public.aais_auth_email_outbox where status = 'dead') as dead_letter_count,
  (
    select count(*)::bigint
      from public.aais_auth_email_outbox
     where uncertain_since is not null
       and reconciliation_disposition is null
       and status in ('sending', 'retry', 'dead')
  ) as uncertain_count,
  (select count(*)::bigint from public.aais_auth_email_outbox) as total_count`;

async function probeAaisResearchStorage(
  configuration: AaisResearchConfiguration,
): Promise<{
  probe: "connected" | "failed";
  schema: "current" | "missing_or_unreachable";
  operations: AaisResearchOperationalProbe;
}> {
  let pool: ReturnType<typeof createAaisPostgresPool> | null = null;
  try {
    let rows: Array<Record<string, unknown>>;
    if (configuration.databaseDriver === "neon-serverless") {
      const client = createAaisNeonQueryClient(configuration.databaseUrl);
      const result = await client.query(
        aaisResearchSchemaProbeSql,
        createAaisResearchProbeScopeParams(configuration),
      );
      rows = result.rows;
    } else {
      pool = createAaisPostgresPool(configuration.databaseUrl);
      const result = await pool.query(
        aaisResearchSchemaProbeSql,
        createAaisResearchProbeScopeParams(configuration),
      );
      rows = result.rows as Array<Record<string, unknown>>;
    }
    const row = rows[0];
    return {
      probe: "connected",
      schema: isAaisResearchSchemaReady(row)
        ? "current"
        : "missing_or_unreachable",
      operations: readAaisResearchOperationalProbe(row),
    };
  } catch {
    return {
      probe: "failed",
      schema: "missing_or_unreachable",
      operations: createUnavailableAaisResearchOperationalProbe(),
    };
  } finally {
    await pool?.end().catch(() => undefined);
  }
}

function createAaisResearchProbeScopeParams(configuration: AaisResearchConfiguration) {
  return [
    configuration.projectId,
    configuration.studyId,
    configuration.environment,
    configuration.lrsNamespace,
  ];
}

function readAaisResearchOperationalProbe(
  row: Record<string, unknown> | undefined,
): AaisResearchOperationalProbe {
  const eventDeadLetter = readNonNegativeDatabaseCount(row?.event_dead_letter_count);
  const deletionDeadLetter = readNonNegativeDatabaseCount(row?.deletion_dead_letter_count);
  const blockedActiveVisits = readNonNegativeDatabaseCount(
    row?.retention_blocked_active_visit_count,
  );
  const staleRawTextWriteLeases = readNonNegativeDatabaseCount(
    row?.stale_raw_text_write_lease_count,
  );
  if (
    eventDeadLetter === null
    || deletionDeadLetter === null
    || blockedActiveVisits === null
    || staleRawTextWriteLeases === null
  ) {
    return createUnavailableAaisResearchOperationalProbe();
  }
  return {
    available: true,
    eventDeadLetter,
    deletionDeadLetter,
    blockedActiveVisits,
    staleRawTextWriteLeases,
  };
}

function createUnavailableAaisResearchOperationalProbe(): AaisResearchOperationalProbe {
  return {
    available: false,
    eventDeadLetter: 0,
    deletionDeadLetter: 0,
    blockedActiveVisits: 0,
    staleRawTextWriteLeases: 0,
  };
}

function isAaisResearchSchemaReady(row: Record<string, unknown> | undefined) {
  if (!row) {
    return false;
  }
  return researchSchemaProbeKeys.every((key) =>
    row[key] === true || row[key] === "t" || row[key] === 1);
}

const researchSchemaProbeKeys = [
  "identity_schema",
  "participants_table",
  "identity_map_table",
  "participation_ledger_table",
  "visits_table",
  "raw_write_leases_table",
  "raw_write_leases_expiry_index",
  "events_table",
  "outbox_table",
  "export_audit_table",
  "withdrawals_table",
  "deletions_table",
  "retention_runs_table",
  "retention_stale_lease_count_column",
  "legacy_archives_table",
  "identity_nonce_constraints",
  "participation_ledger_constraints",
  "required_functions",
  "withdrawal_safe_export_function",
  "visit_event_cap_guard",
] as const;

const aaisResearchSchemaProbeSql = `select
  to_regnamespace('aais_research_identity') is not null as identity_schema,
  to_regclass('public.aais_research_participants') is not null as participants_table,
  to_regclass('aais_research_identity.aais_research_identity_map') is not null as identity_map_table,
  to_regclass('aais_research_identity.aais_research_participation_ledger') is not null as participation_ledger_table,
  to_regclass('public.aais_research_visits') is not null as visits_table,
  to_regclass('public.aais_research_raw_write_leases') is not null as raw_write_leases_table,
  exists (
    select 1
      from pg_indexes
     where schemaname = 'public'
       and indexname = 'aais_research_raw_write_leases_scope_expiry_idx'
       and indexdef ilike
         '%(project_id, study_id, environment, lrs_namespace, visit_id, expires_at)%'
  ) as raw_write_leases_expiry_index,
  to_regclass('public.aais_research_events') is not null as events_table,
  to_regclass('public.aais_research_lrs_outbox') is not null as outbox_table,
  to_regclass('public.aais_research_export_audit') is not null as export_audit_table,
  to_regclass('public.aais_research_withdrawals') is not null as withdrawals_table,
  to_regclass('public.aais_research_lrs_deletions') is not null as deletions_table,
  to_regclass('public.aais_research_retention_runs') is not null as retention_runs_table,
  exists (
    select 1
      from information_schema.columns
     where table_schema = 'public'
       and table_name = 'aais_research_retention_runs'
       and column_name = 'stale_raw_text_write_lease_count'
       and data_type = 'integer'
       and is_nullable = 'NO'
  ) as retention_stale_lease_count_column,
  to_regclass('public.aais_research_legacy_archives') is not null as legacy_archives_table,
  (
    select count(*) = 2
    from pg_constraint c
    join pg_namespace n on n.oid = c.connamespace
    where n.nspname = 'aais_research_identity'
      and c.contype = 'u'
      and c.conname = any(array[
        'aais_research_identity_scope_key_iv_unique',
        'aais_research_participation_scope_key_iv_unique'
      ])
  ) as identity_nonce_constraints,
  (
    select count(*) = 4
    from pg_constraint c
    join pg_namespace n on n.oid = c.connamespace
    where n.nspname = 'aais_research_identity'
      and c.contype = 'u'
      and c.conname = any(array[
        'aais_research_participation_scope_fingerprint_unique',
        'aais_research_participation_scope_run_unique',
        'aais_research_participation_scope_visit_unique',
        'aais_research_participation_scope_key_iv_unique'
      ])
  ) as participation_ledger_constraints,
  (
    select count(distinct p.proname) = 8
      and bool_and(p.prosecdef is false)
      and bool_and(
        case
          when p.proname = 'aais_research_detail_is_safe'
            then p.provolatile = 'i'
          else p.provolatile = 'v'
        end
      )
    from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public'
      and p.proname = any(array[
        'aais_research_detail_is_safe',
        'aais_research_apply_fact_retention',
        'aais_research_create_visit',
        'aais_research_record_event',
        'aais_research_acquire_raw_write_lease',
        'aais_research_begin_withdrawal',
        'aais_research_complete_visit',
        'aais_research_withdraw'
      ])
  ) as required_functions,
  exists (
    select 1
    from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
    where p.oid = to_regprocedure(
      'public.aais_research_export_events(text,text,text,text,uuid,integer)'
    )
      and n.nspname = 'public'
      and p.provolatile = 'v'
      and p.prosecdef is false
  ) as withdrawal_safe_export_function,
  exists (
    select 1
    from pg_trigger trigger_row
    join pg_class relation on relation.oid = trigger_row.tgrelid
    join pg_namespace namespace on namespace.oid = relation.relnamespace
    join pg_proc function_row on function_row.oid = trigger_row.tgfoid
    where namespace.nspname = 'public'
      and relation.relname = 'aais_research_events'
      and trigger_row.tgname = 'aais_research_events_visit_cap_guard'
      and trigger_row.tgenabled = 'O'
      and not trigger_row.tgisinternal
      and trigger_row.tgtype = 7
      and trigger_row.tgnargs = 0
      and function_row.oid = to_regprocedure(
        'public.aais_research_enforce_visit_event_cap()'
      )
      and function_row.provolatile = 'v'
      and function_row.prosecdef is false
  ) as visit_event_cap_guard,
  (
    select count(*)::bigint
      from public.aais_research_lrs_outbox outbox
     where outbox.project_id = $1
       and outbox.study_id = $2
       and outbox.environment = $3
       and outbox.lrs_namespace = $4
       and outbox.status = 'dead_letter'
  ) as event_dead_letter_count,
  (
    select count(*)::bigint
      from public.aais_research_lrs_deletions deletion
     where deletion.project_id = $1
       and deletion.study_id = $2
       and deletion.environment = $3
       and deletion.lrs_namespace = $4
       and deletion.status = 'dead_letter'
  ) as deletion_dead_letter_count,
  (
    select count(*)::bigint
      from public.aais_research_visits visit
      join aais_research_identity.aais_research_identity_map identity
        on identity.participant_id = visit.participant_id
       and identity.project_id = visit.project_id
       and identity.study_id = visit.study_id
       and identity.environment = visit.environment
       and identity.lrs_namespace = visit.lrs_namespace
     where visit.project_id = $1
       and visit.study_id = $2
       and visit.environment = $3
       and visit.lrs_namespace = $4
       and visit.status = 'active'
       and identity.retention_due_at <= clock_timestamp()
  ) as retention_blocked_active_visit_count,
  (
    select count(*)::bigint
      from public.aais_research_raw_write_leases lease
     where lease.project_id = $1
       and lease.study_id = $2
       and lease.environment = $3
       and lease.lrs_namespace = $4
       and lease.expires_at <= clock_timestamp()
  ) as stale_raw_text_write_lease_count`;

function readAaisReadinessMode(): AaisReadinessReport["readinessMode"] {
  return process.env.AAIS_READINESS_MODE?.trim().toLowerCase() === "enterprise"
    ? "enterprise"
    : "traffic";
}

function getTrialAccountStatus(status: "configured" | "missing" | "invalid" | "disabled"): AaisReadinessCheckStatus {
  if (status === "configured") {
    return "ok";
  }
  return status;
}

function getAaisProductOperatorSecretStatus() {
  const cronSecret = process.env.CRON_SECRET?.trim() ?? "";
  const outboxToken = process.env.AAIS_LRS_OUTBOX_FLUSH_TOKEN?.trim() ?? "";
  const authEmailOutboxToken = process.env.AAIS_AUTH_EMAIL_OUTBOX_FLUSH_TOKEN?.trim() ?? "";
  const readinessToken = process.env.AAIS_READINESS_BEARER_TOKEN?.trim() ?? "";
  const sessionSecret = process.env.AAIS_SESSION_SECRET?.trim() ?? "";
  const distinct = areAaisOpaqueSecretsDistinct([
    cronSecret,
    outboxToken,
    authEmailOutboxToken,
    readinessToken,
    sessionSecret,
  ]);
  const cronSecretValid = isAaisStrongOpaqueSecret(cronSecret);
  const lrsWorkerAuthorized = cronSecretValid || isAaisStrongOpaqueSecret(outboxToken);
  const authEmailWorkerAuthorized = cronSecretValid
    || isAaisStrongOpaqueSecret(authEmailOutboxToken);
  return {
    cronSecretValid,
    outboxTokenValid: !outboxToken || isAaisStrongOpaqueSecret(outboxToken),
    authEmailOutboxTokenValid: !authEmailOutboxToken
      || isAaisStrongOpaqueSecret(authEmailOutboxToken),
    lrsWorkerAuthorized: lrsWorkerAuthorized && distinct,
    authEmailWorkerAuthorized: authEmailWorkerAuthorized && distinct,
    schedulerAuthorized: lrsWorkerAuthorized && authEmailWorkerAuthorized && distinct,
    readinessTokenValid: !readinessToken || isAaisStrongOpaqueSecret(readinessToken),
    distinct,
  };
}

function getAaisMonitoringConfigurationStatus(
  operatorSecrets = getAaisProductOperatorSecretStatus(),
) {
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
      secretConfigured: operatorSecrets.schedulerAuthorized,
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
  endpointConfigurationValid: boolean;
}): AaisReadinessCheckStatus {
  if (input.production && !input.endpointConfigurationValid) {
    return "invalid";
  }
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

async function readPersistentOutboxStatus() {
  try {
    return {
      ...await getAaisPersistentLrsOutboxStatus(),
      available: true as const,
    };
  } catch {
    return {
      available: false as const,
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
