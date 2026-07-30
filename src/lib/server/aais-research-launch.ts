import {
  AaisResearchConfigurationError,
  isAaisResearchModeEnabled,
} from "@/lib/server/aais-research-contract";
import { getAaisResearchLrsConfigurationStatus } from "@/lib/server/aais-research-lrs";

const accessActorEnvNames = [
  "AAIS_RESEARCH_PI_ACTOR_IDS",
  "AAIS_RESEARCH_DATA_CUSTODIAN_ACTOR_IDS",
  "AAIS_RESEARCH_EXPORT_ACTOR_IDS",
] as const;

const scheduleEnvNames = [
  "AAIS_RESEARCH_LRS_EVENT_FLUSH_SCHEDULE_ID",
  "AAIS_RESEARCH_LRS_DELETION_SCHEDULE_ID",
  "AAIS_RESEARCH_RETENTION_SCHEDULE_ID",
] as const;

const evidenceEnvNames = [
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
] as const;

const GOVERNANCE_MANIFEST_MAX_AGE_MS = 36 * 60 * 60 * 1_000;
const DAILY_BACKUP_MAX_AGE_MS = 36 * 60 * 60 * 1_000;
const BACKUP_DESTRUCTION_MAX_AGE_MS = 45 * 24 * 60 * 60 * 1_000;
const MAX_FUTURE_CLOCK_SKEW_MS = 5 * 60 * 1_000;

export type AaisResearchCollectionLaunchGate = {
  ready: boolean;
  rehearsal: boolean;
  accessReady: boolean;
  workersReady: boolean;
  lrsConfigurationReady: boolean;
  evidenceReady: boolean;
};

/**
 * Formal collection is a stricter boundary than ordinary application health.
 * A rehearsal can run against its approved synthetic scope, but a real roster
 * cannot create a visit or append an event until every external-control receipt
 * and least-privilege worker/access grant is present.
 */
export function getAaisResearchCollectionLaunchGate(
  env: Record<string, string | undefined> = process.env,
  now = new Date(),
): AaisResearchCollectionLaunchGate {
  const rehearsal = env.AAIS_RESEARCH_REHEARSAL_MODE?.trim().toLowerCase() === "true";
  if (!isAaisResearchModeEnabled(env)) {
    return {
      ready: false,
      rehearsal,
      accessReady: false,
      workersReady: false,
      lrsConfigurationReady: false,
      evidenceReady: false,
    };
  }
  if (rehearsal) {
    const ready = env.AAIS_RESEARCH_ENVIRONMENT?.trim().toLowerCase() === "research"
      && env.AAIS_RESEARCH_REHEARSAL_APPROVED?.trim().toLowerCase() === "true";
    return {
      ready,
      rehearsal: true,
      accessReady: ready,
      workersReady: ready,
      lrsConfigurationReady: ready,
      evidenceReady: ready,
    };
  }

  const accessReady = accessActorEnvNames.every((name) => isValidActorAllowlist(env[name]))
    && env.AAIS_RESEARCH_EXPORT_ENABLED?.trim().toLowerCase() === "true";

  const flushToken = env.AAIS_RESEARCH_LRS_OUTBOX_FLUSH_TOKEN?.trim() ?? "";
  const retentionToken = env.AAIS_RESEARCH_RETENTION_TOKEN?.trim() ?? "";
  const forbiddenWorkerSecrets = [
    env.AAIS_LRS_OUTBOX_FLUSH_TOKEN,
    env.CRON_SECRET,
    env.AAIS_RESEARCH_LRS_USERNAME,
    env.AAIS_RESEARCH_LRS_PASSWORD,
    env.AAIS_SESSION_SECRET,
  ].map((value) => value?.trim()).filter(Boolean);
  const schedules = scheduleEnvNames.map((name) => env[name]?.trim() ?? "");
  const workersReady = isStrongOpaqueSecret(flushToken)
    && isStrongOpaqueSecret(retentionToken)
    && flushToken !== retentionToken
    && !forbiddenWorkerSecrets.includes(flushToken)
    && !forbiddenWorkerSecrets.includes(retentionToken)
    && schedules.every(isSafeIdentifier)
    && new Set(schedules).size === schedules.length;

  const receipts = evidenceEnvNames.map((name) => env[name]?.trim() ?? "");
  const receiptDigestsReady = receipts.every(isSha256Receipt)
    && new Set(receipts.map((value) => value.toLowerCase())).size === receipts.length;
  const evidenceReady = receiptDigestsReady
    && isAaisResearchGovernanceEvidenceFresh(env, now);
  const lrsConfigurationReady = getAaisResearchLrsConfigurationStatus(env).configured;

  return {
    ready: accessReady && workersReady && lrsConfigurationReady && evidenceReady,
    rehearsal: false,
    accessReady,
    workersReady,
    lrsConfigurationReady,
    evidenceReady,
  };
}

export function assertAaisResearchCollectionLaunchGate(
  env: Record<string, string | undefined> = process.env,
  now = new Date(),
) {
  if (!getAaisResearchCollectionLaunchGate(env, now).ready) {
    throw new AaisResearchConfigurationError(
      "AAIS formal research collection is blocked pending approved launch controls.",
    );
  }
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

function isSafeIdentifier(value: string) {
  return /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(value);
}

function isSha256Receipt(value: string) {
  return /^[0-9a-f]{64}$/i.test(value);
}

export function isAaisResearchGovernanceEvidenceFresh(
  env: Record<string, string | undefined>,
  now = new Date(),
) {
  if (!Number.isFinite(now.getTime())) {
    return false;
  }

  const manifestVerifiedAt = readExactIsoTimestamp(
    env.AAIS_RESEARCH_GOVERNANCE_MANIFEST_VERIFIED_AT,
  );
  const manifestValidUntil = readExactIsoTimestamp(
    env.AAIS_RESEARCH_GOVERNANCE_MANIFEST_VALID_UNTIL,
  );
  const dailyBackupCompletedAt = readExactIsoTimestamp(
    env.AAIS_RESEARCH_DAILY_BACKUP_COMPLETED_AT,
  );
  const backupDestructionObservedAt = readExactIsoTimestamp(
    env.AAIS_RESEARCH_BACKUP_DESTRUCTION_OBSERVED_AT,
  );

  if (
    !manifestVerifiedAt
    || !manifestValidUntil
    || !dailyBackupCompletedAt
    || !backupDestructionObservedAt
  ) {
    return false;
  }

  const nowMs = now.getTime();
  const manifestVerifiedAtMs = manifestVerifiedAt.getTime();
  const manifestValidUntilMs = manifestValidUntil.getTime();
  return isRecentPastTimestamp(
    manifestVerifiedAtMs,
    nowMs,
    GOVERNANCE_MANIFEST_MAX_AGE_MS,
  )
    && manifestValidUntilMs > nowMs
    && manifestValidUntilMs > manifestVerifiedAtMs
    && isRecentPastTimestamp(
      dailyBackupCompletedAt.getTime(),
      nowMs,
      DAILY_BACKUP_MAX_AGE_MS,
    )
    && isRecentPastTimestamp(
      backupDestructionObservedAt.getTime(),
      nowMs,
      BACKUP_DESTRUCTION_MAX_AGE_MS,
    );
}

function readExactIsoTimestamp(value: string | undefined) {
  const normalized = value?.trim() ?? "";
  if (
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.test(normalized)
  ) {
    return null;
  }
  const parsed = new Date(normalized);
  if (!Number.isFinite(parsed.getTime())) {
    return null;
  }
  const canonical = parsed.toISOString();
  return normalized === canonical
    || normalized === canonical.replace(".000Z", "Z")
    ? parsed
    : null;
}

function isRecentPastTimestamp(timestampMs: number, nowMs: number, maxAgeMs: number) {
  return timestampMs <= nowMs + MAX_FUTURE_CLOCK_SKEW_MS
    && timestampMs >= nowMs - maxAgeMs;
}
