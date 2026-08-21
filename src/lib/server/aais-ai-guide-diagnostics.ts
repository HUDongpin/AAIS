import { recordAaisMonitoringIssue } from "@/lib/server/aais-monitoring";
import type { AaisGuideDeliveryAttemptDiagnosticV1 } from "@/lib/ai/aais-guide-delivery";

export const aaisAiGuideDiagnosticEvents = [
  "aais.ai.guide.completed",
  "aais.ai.guide.failover",
  "aais.ai.guide.failed",
  "aais.ai.guide.idempotency_replay",
  "aais.ai.guide.budget_uncertain",
  "aais.ai.probe.completed",
  "aais.ai.probe.failed",
] as const;

export const aaisAiGuideDiagnosticCategories = [
  "configuration",
  "evaluation",
  "provider",
  "guardrail",
  "deadline",
  "orchestration",
  "persistence",
  "transport",
  "idempotency",
] as const;

export const aaisAiGuideDiagnosticReasons = [
  "live_disabled",
  "config_missing",
  "config_invalid",
  "endpoint_not_allowed",
  "eval_missing",
  "eval_mismatch",
  "eval_invalid",
  "eval_expired",
  "release_lock_blocked",
  "observed_model_mismatch",
  "observed_model_missing",
  "observed_revision_mismatch",
  "observed_revision_missing",
  "connect_timeout",
  "response_timeout",
  "rate_limited",
  "auth_failed",
  "payment_required",
  "invalid_request",
  "upstream_5xx",
  "network_error",
  "empty_response",
  "truncated_response",
  "invalid_response",
  "guardrail_blocked",
  "chain_exhausted",
  "route_deadline",
  "orchestration_error",
  "persistence_failed",
  "client_disconnect",
  "stream_interrupted",
  "replay",
  "payload_conflict",
  "dispatched_uncertain",
] as const;

export type AaisAiGuideDiagnosticEvent = typeof aaisAiGuideDiagnosticEvents[number];
export type AaisAiGuideDiagnosticCategory = typeof aaisAiGuideDiagnosticCategories[number];
export type AaisAiGuideDiagnosticReason = typeof aaisAiGuideDiagnosticReasons[number];

export type AaisAiGuideDiagnosticProviderAttempt = {
  role: "primary" | "secondary";
  outcome: "failed" | "blocked" | "succeeded";
  reason: AaisAiGuideDiagnosticReason | null;
  attempts: number;
  modelFingerprint: string | null;
  observedModel: "matched" | "missing" | "mismatch" | "not-reported";
  observedRevision: "matched" | "missing" | "mismatch" | "not-required" | "not-reported";
  observedRevisionSha256: string | null;
};

export type AaisAiGuideDiagnosticInput = {
  event: AaisAiGuideDiagnosticEvent;
  outcome: "live_primary" | "live_secondary" | "failed" | "replayed" | "uncertain";
  category?: AaisAiGuideDiagnosticCategory;
  reason?: AaisAiGuideDiagnosticReason;
  providerRole?: "primary" | "secondary" | "none";
  agent?: "A1" | "A2";
  locale?: "zh-CN" | "en-US";
  modelFingerprint?: string;
  evalManifestDigest?: string;
  retryable?: boolean;
  attempts?: number;
  latencyMs?: number;
  persistence?: "not-started" | "committed" | "failed" | "unknown";
  budgetDisposition?:
    | "not-reserved"
    | "released"
    | "charged-once"
    | "dispatched-uncertain";
  transport?: "json" | "sse" | "probe";
  route?: "guide" | "probe";
  providerAttempts?: readonly AaisAiGuideDiagnosticProviderAttempt[];
  diagnosticId: string;
  operationId?: string;
  requestAttemptId?: string;
};

export type AaisAiGuideDiagnosticRecord = ReturnType<typeof createAaisAiGuideDiagnosticRecord>;

const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const fingerprintPattern = /^(?:sha256:)?[a-f0-9]{12,64}$/i;
const releasePattern = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

export function createAaisAiGuideDiagnosticRecord(input: AaisAiGuideDiagnosticInput) {
  const route = input.route === "probe"
    ? "/api/system/ai-live-probe" as const
    : "/api/learning/ai-guide" as const;
  return {
    schemaVersion: 1 as const,
    event: input.event,
    releaseSha: readSafeGitCommitSha(
      process.env.VERCEL_GIT_COMMIT_SHA ?? process.env.SENTRY_RELEASE,
    ),
    deploymentId: readSafeReleaseValue(process.env.VERCEL_DEPLOYMENT_ID),
    environment: readSafeReleaseValue(
      process.env.VERCEL_ENV ?? process.env.NODE_ENV ?? "development",
    ) ?? "unknown",
    configGeneration: readSafeReleaseValue(process.env.AAIS_CONFIG_GENERATION),
    route,
    outcome: input.outcome,
    category: input.category ?? null,
    reason: input.reason ?? null,
    providerRole: input.providerRole ?? "none",
    agent: input.agent ?? null,
    locale: input.locale ?? null,
    modelFingerprint: readFingerprint(input.modelFingerprint),
    evalManifestDigest: readFingerprint(input.evalManifestDigest),
    retryable: input.retryable ?? false,
    attempts: normalizeCount(input.attempts),
    latencyMs: normalizeLatency(input.latencyMs),
    latencyBucket: getLatencyBucket(input.latencyMs),
    persistence: input.persistence ?? "not-started",
    budgetDisposition: input.budgetDisposition ?? "not-reserved",
    transport: input.route === "probe" ? "probe" as const : input.transport ?? "json",
    providerAttempts: sanitizeProviderAttempts(input.providerAttempts),
    diagnosticId: readCorrelationId(input.diagnosticId),
    operationId: readCorrelationId(input.operationId),
    requestAttemptId: readCorrelationId(input.requestAttemptId),
    redaction: {
      secrets: "omitted" as const,
      endpoints: "omitted" as const,
      prompt: "omitted" as const,
      response: "omitted" as const,
      learnerIdentity: "omitted" as const,
      providerBody: "omitted" as const,
    },
  };
}

/**
 * Projects the provider delivery chain into the only provider-attempt shape
 * diagnostics may record. It keeps at most one primary and one secondary row,
 * translates gate/failure enums to the bounded diagnostic taxonomy, and never
 * copies provider bodies, endpoints, raw model ids, prompts, or error text.
 */
export function projectAaisGuideProviderAttemptsForDiagnostic(
  attempts: readonly AaisGuideDeliveryAttemptDiagnosticV1[] | undefined,
): AaisAiGuideDiagnosticProviderAttempt[] {
  if (!Array.isArray(attempts)) return [];
  const byRole = new Map<"primary" | "secondary", AaisAiGuideDiagnosticProviderAttempt>();
  for (const attempt of attempts) {
    const role = attempt?.role === "fallback"
      ? "secondary" as const
      : attempt?.role === "primary"
        ? "primary" as const
        : null;
    if (!role) continue;
    const outcome = attempt.outcome === "succeeded"
      ? "succeeded" as const
      : attempt.outcome === "blocked" || attempt.outcome === "skipped"
        ? "blocked" as const
        : "failed" as const;
    byRole.set(role, {
      role,
      outcome,
      reason: mapProviderAttemptReason(attempt.reason, attempt.gateReason),
      attempts: normalizeCount(attempt.attempts),
      modelFingerprint: readFingerprint(attempt.modelFingerprint),
      observedModel: normalizeObservedModel(attempt.observedModel),
      observedRevision: normalizeObservedRevision(attempt.observedRevision),
      observedRevisionSha256: readFingerprint(attempt.observedRevisionSha256),
    });
  }
  return (["primary", "secondary"] as const)
    .flatMap((role) => byRole.get(role) ?? [])
    .slice(0, 2);
}

export function recordAaisAiGuideDiagnostic(input: AaisAiGuideDiagnosticInput) {
  const record = createAaisAiGuideDiagnosticRecord(input);
  console.info(JSON.stringify(record));
  recordAaisMonitoringIssue({
    event: record.event,
    message: record.event,
    level: getDiagnosticLevel(record),
    route: record.route,
    tags: {
      "aais.ai.outcome": record.outcome,
      "aais.ai.category": record.category ?? "none",
      "aais.ai.reason": record.reason ?? "none",
      "aais.ai.provider_role": record.providerRole,
      "aais.ai.agent": record.agent ?? "none",
      "aais.ai.locale": record.locale ?? "none",
      "aais.ai.model_fingerprint": record.modelFingerprint ?? "unavailable",
      "aais.ai.latency_bucket": record.latencyBucket,
    },
    // Correlation identifiers intentionally stay in context rather than tags
    // so Sentry cardinality remains bounded.
    extra: record,
  });
  return record;
}

function getDiagnosticLevel(record: AaisAiGuideDiagnosticRecord) {
  if (record.event === "aais.ai.guide.failover") {
    return "warning" as const;
  }
  if (record.category === "guardrail") {
    return "info" as const;
  }
  if (record.event === "aais.ai.guide.completed"
    || record.event === "aais.ai.guide.idempotency_replay"
    || record.event === "aais.ai.probe.completed") {
    return "info" as const;
  }
  return "error" as const;
}

function readSafeReleaseValue(value: string | undefined) {
  const normalized = value?.trim();
  return normalized && releasePattern.test(normalized) ? normalized : null;
}

function readSafeGitCommitSha(value: string | undefined) {
  const normalized = value?.trim().toLowerCase();
  return normalized && /^[a-f0-9]{40}$/.test(normalized) ? normalized : null;
}

function readFingerprint(value: string | undefined) {
  const normalized = value?.trim();
  return normalized && fingerprintPattern.test(normalized) ? normalized : null;
}

function readCorrelationId(value: string | undefined) {
  return value && uuidPattern.test(value) ? value.toLowerCase() : null;
}

function sanitizeProviderAttempts(
  attempts: readonly AaisAiGuideDiagnosticProviderAttempt[] | undefined,
): AaisAiGuideDiagnosticProviderAttempt[] {
  if (!Array.isArray(attempts)) return [];
  const byRole = new Map<"primary" | "secondary", AaisAiGuideDiagnosticProviderAttempt>();
  for (const attempt of attempts) {
    if (!attempt || (attempt.role !== "primary" && attempt.role !== "secondary")) continue;
    if (attempt.outcome !== "failed"
      && attempt.outcome !== "blocked"
      && attempt.outcome !== "succeeded") continue;
    byRole.set(attempt.role, {
      role: attempt.role,
      outcome: attempt.outcome,
      reason: aaisAiGuideDiagnosticReasons.includes(
        attempt.reason as AaisAiGuideDiagnosticReason,
      ) ? attempt.reason : null,
      attempts: normalizeCount(attempt.attempts),
      modelFingerprint: readFingerprint(attempt.modelFingerprint ?? undefined),
      observedModel: normalizeObservedModel(attempt.observedModel),
      observedRevision: normalizeObservedRevision(attempt.observedRevision),
      observedRevisionSha256: readFingerprint(
        attempt.observedRevisionSha256 ?? undefined,
      ),
    });
  }
  return (["primary", "secondary"] as const)
    .flatMap((role) => byRole.get(role) ?? [])
    .slice(0, 2);
}

function mapProviderAttemptReason(
  reason: AaisGuideDeliveryAttemptDiagnosticV1["reason"],
  gateReason: AaisGuideDeliveryAttemptDiagnosticV1["gateReason"],
): AaisAiGuideDiagnosticReason | null {
  if (gateReason === "configuration-invalid" || gateReason === "runtime-mode-invalid") {
    return "config_invalid";
  }
  if (gateReason === "configuration-missing" || gateReason === "runtime-mode-missing") {
    return "config_missing";
  }
  if (gateReason === "endpoint-not-allowed") return "endpoint_not_allowed";
  if (gateReason === "evaluation-expired") return "eval_expired";
  if (gateReason === "evaluation-invalid") return "eval_invalid";
  if (gateReason === "evaluation-mismatch") return "eval_mismatch";
  if (gateReason === "evaluation-missing") return "eval_missing";
  if (gateReason === "release-lock-blocked") return "release_lock_blocked";
  if (reason === "abort-timeout") return "response_timeout";
  if (reason === "connect-timeout") return "connect_timeout";
  if (reason === "auth-failed") return "auth_failed";
  if (reason === "empty-response") return "empty_response";
  if (reason === "guardrail-blocked") return "guardrail_blocked";
  if (reason === "invalid-response" || reason === "upstream-4xx") return "invalid_response";
  if (reason === "invalid-request") return "invalid_request";
  if (reason === "observed-model-mismatch") return "observed_model_mismatch";
  if (reason === "observed-model-missing") return "observed_model_missing";
  if (reason === "observed-revision-mismatch") return "observed_revision_mismatch";
  if (reason === "observed-revision-missing") return "observed_revision_missing";
  if (reason === "payment-required") return "payment_required";
  if (reason === "rate-limited") return "rate_limited";
  if (reason === "route-deadline") return "route_deadline";
  if (reason === "truncated-response") return "truncated_response";
  if (reason === "upstream-5xx") return "upstream_5xx";
  if (reason === "provider-error") return "network_error";
  return null;
}

function normalizeObservedModel(value: unknown) {
  return value === "matched" || value === "missing" || value === "mismatch"
    ? value
    : "not-reported" as const;
}

function normalizeObservedRevision(value: unknown) {
  return value === "matched"
    || value === "missing"
    || value === "mismatch"
    || value === "not-required"
    ? value
    : "not-reported" as const;
}

function normalizeCount(value: number | undefined) {
  return Number.isSafeInteger(value) && Number(value) >= 0
    ? Math.min(Number(value), 100)
    : 0;
}

function normalizeLatency(value: number | undefined) {
  return Number.isFinite(value) && Number(value) >= 0
    ? Math.min(Math.round(Number(value)), 300_000)
    : 0;
}

function getLatencyBucket(value: number | undefined) {
  const latency = normalizeLatency(value);
  if (latency < 1_000) return "lt_1s";
  if (latency < 5_000) return "1s_5s";
  if (latency < 10_000) return "5s_10s";
  if (latency < 20_000) return "10s_20s";
  if (latency <= 30_000) return "20s_30s";
  return "gt_30s";
}
