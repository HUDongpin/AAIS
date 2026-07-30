import { neon } from "@neondatabase/serverless";
import { Pool } from "pg";
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
import {
  getAaisResearchConfiguration,
  isAaisResearchModeEnabled,
  requiresAaisResearchDataPlaneIsolation,
  type AaisResearchConfiguration,
} from "@/lib/server/aais-research-contract";
import { getAaisResearchLrsConfigurationStatus } from "@/lib/server/aais-research-lrs";
import { isAaisResearchGovernanceEvidenceFresh } from "@/lib/server/aais-research-launch";

type AaisReadinessCheckStatus = "ok" | "missing" | "blocked" | "invalid" | "disabled";

type AaisReadinessCheck = {
  status: AaisReadinessCheckStatus;
};

export type AaisReadinessReport = {
  status: "ready" | "not_ready";
  runtime: "production" | "development";
  readinessMode: "traffic" | "enterprise";
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
  const research = await getAaisResearchReadinessStatus(now);
  const researchIsolationRequired = requiresAaisResearchDataPlaneIsolation();

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
  if (production && !lrsConfigured && !researchIsolationRequired) {
    operationalGaps.push("LRS_ENDPOINT/LRS_USERNAME/LRS_PASSWORD");
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
  if (production && !monitoring.cron.alertsConfigured) {
    operationalGaps.push("AAIS_CRON_FAILURE_ALERTS_CONFIGURED");
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
        status: researchIsolationRequired
          ? "disabled"
          : lrsConfigured ? "ok" : "missing",
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
      };
  const configurationReady = Boolean(configuration);
  const storageReady = storageProbe.probe === "connected"
    && storageProbe.schema === "current";
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
  const flushTokenConfigured = isStrongOpaqueSecret(flushToken);
  const retentionTokenConfigured = isStrongOpaqueSecret(retentionToken);
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

function isStrongOpaqueSecret(value: string) {
  return value.length >= 32 && value.length <= 512 && !/\s/.test(value);
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

async function probeAaisResearchStorage(
  configuration: Pick<AaisResearchConfiguration, "databaseDriver" | "databaseUrl">,
): Promise<{
  probe: "connected" | "failed";
  schema: "current" | "missing_or_unreachable";
}> {
  let pool: Pool | null = null;
  try {
    let rows: Array<Record<string, unknown>>;
    if (configuration.databaseDriver === "neon-serverless") {
      const sql = neon(configuration.databaseUrl);
      const result = await sql.query(aaisResearchSchemaProbeSql, []);
      rows = normalizeResearchProbeRows(result);
    } else {
      pool = new Pool({ connectionString: configuration.databaseUrl });
      const result = await pool.query(aaisResearchSchemaProbeSql);
      rows = result.rows as Array<Record<string, unknown>>;
    }
    return {
      probe: "connected",
      schema: isAaisResearchSchemaReady(rows[0])
        ? "current"
        : "missing_or_unreachable",
    };
  } catch {
    return {
      probe: "failed",
      schema: "missing_or_unreachable",
    };
  } finally {
    await pool?.end().catch(() => undefined);
  }
}

function normalizeResearchProbeRows(value: unknown): Array<Record<string, unknown>> {
  if (Array.isArray(value)) {
    return value as Array<Record<string, unknown>>;
  }
  if (value && typeof value === "object" && "rows" in value) {
    const rows = (value as { rows?: unknown }).rows;
    return Array.isArray(rows) ? rows as Array<Record<string, unknown>> : [];
  }
  return [];
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
  "events_table",
  "outbox_table",
  "export_audit_table",
  "withdrawals_table",
  "deletions_table",
  "retention_runs_table",
  "legacy_archives_table",
  "identity_nonce_constraints",
  "participation_ledger_constraints",
  "required_functions",
] as const;

const aaisResearchSchemaProbeSql = `select
  to_regnamespace('aais_research_identity') is not null as identity_schema,
  to_regclass('public.aais_research_participants') is not null as participants_table,
  to_regclass('aais_research_identity.aais_research_identity_map') is not null as identity_map_table,
  to_regclass('aais_research_identity.aais_research_participation_ledger') is not null as participation_ledger_table,
  to_regclass('public.aais_research_visits') is not null as visits_table,
  to_regclass('public.aais_research_events') is not null as events_table,
  to_regclass('public.aais_research_lrs_outbox') is not null as outbox_table,
  to_regclass('public.aais_research_export_audit') is not null as export_audit_table,
  to_regclass('public.aais_research_withdrawals') is not null as withdrawals_table,
  to_regclass('public.aais_research_lrs_deletions') is not null as deletions_table,
  to_regclass('public.aais_research_retention_runs') is not null as retention_runs_table,
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
    select count(distinct p.proname) = 6
    from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public'
      and p.proname = any(array[
        'aais_research_detail_is_safe',
        'aais_research_apply_fact_retention',
        'aais_research_create_visit',
        'aais_research_record_event',
        'aais_research_complete_visit',
        'aais_research_withdraw'
      ])
  ) as required_functions`;

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
