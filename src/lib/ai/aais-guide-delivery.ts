export type AaisGuideDeliveryPolicy = "require-live" | "allow-deterministic";

export type AaisGuideProviderRole = "primary" | "fallback";

export type AaisGuideDeliveryGateReason =
  | "configuration-invalid"
  | "configuration-missing"
  | "endpoint-not-allowed"
  | "evaluation-expired"
  | "evaluation-invalid"
  | "evaluation-mismatch"
  | "evaluation-missing"
  | "release-lock-blocked"
  | "runtime-mode-invalid"
  | "runtime-mode-missing";

export type AaisGuideDeliveryFailureReason =
  | "abort-timeout"
  | "auth-failed"
  | "connect-timeout"
  | "empty-response"
  | "guardrail-blocked"
  | "invalid-response"
  | "invalid-request"
  | "observed-model-mismatch"
  | "observed-model-missing"
  | "observed-revision-mismatch"
  | "observed-revision-missing"
  | "provider-error"
  | "payment-required"
  | "rate-limited"
  | "route-deadline"
  | "truncated-response"
  | "upstream-4xx"
  | "upstream-5xx";

export type AaisGuideDeliveryAttemptDiagnosticV1 = {
  role: AaisGuideProviderRole;
  outcome: "succeeded" | "failed" | "blocked" | "skipped";
  attempts: number;
  modelFingerprint?: string;
  observedModel: "matched" | "missing" | "mismatch" | "not-reported";
  observedRevision?: "matched" | "missing" | "mismatch" | "not-required" | "not-reported";
  observedRevisionSha256?: string;
  reason?: AaisGuideDeliveryFailureReason;
  gateReason?: AaisGuideDeliveryGateReason;
};

export const aaisGuideDeliveryRedaction = {
  secrets: "omitted",
  prompts: "omitted",
  outputs: "omitted",
  endpoints: "omitted",
  modelIds: "fingerprint-only",
  observedRevisions: "sha256-only",
} as const;

export type AaisGuideRuntimeDeliveryReceiptV1 = {
  schemaVersion: 1;
  mode: "live" | "deterministic";
  channel: "primary" | "secondary" | "deterministic";
  degraded: boolean;
  diagnosticId: string;
  observedModel: "matched" | "not-reported";
  attempts: AaisGuideDeliveryAttemptDiagnosticV1[];
  redaction: typeof aaisGuideDeliveryRedaction;
};

/** Learner-facing persisted-success receipt shared by JSON, SSE, and replay. */
export type AaisGuideDeliveryReceiptV1 = {
  schemaVersion: 1;
  responseMode: "live";
  channel: "primary" | "secondary";
  degraded: boolean;
  diagnosticId: string;
  persisted: true;
  budgetDisposition: "charged-once";
};

export type AaisGuideDeliveryErrorCode =
  | "AAIS_AI_LIVE_PROVIDER_REQUIRED"
  | "AAIS_AI_MODEL_EVALUATION_REQUIRED"
  | "AAIS_AI_OBSERVED_MODEL_MISMATCH"
  | "AAIS_AI_OUTPUT_BLOCKED"
  | "AAIS_AI_PROVIDER_CHAIN_EXHAUSTED"
  | "AAIS_AI_PROVIDER_CONFIGURATION_INVALID";

export type AaisGuideLearnerAction = "retry" | "rephrase" | "contact-support";

export type AaisGuideProviderPublicErrorV1 = {
  schemaVersion: 1;
  code: AaisGuideDeliveryErrorCode;
  diagnosticId: string;
  retryable: boolean;
  learnerAction: AaisGuideLearnerAction;
  message: string;
};

export type AaisGuidePublicErrorCode =
  | "AI_LIVE_NOT_READY"
  | "AI_LIVE_UNAVAILABLE"
  | "AI_LIVE_TIMEOUT"
  | "AI_REPHRASE_REQUIRED"
  | "AI_PERSISTENCE_FAILED"
  | "AI_OPERATION_IN_PROGRESS"
  | "AI_OPERATION_CONFLICT";

/** Learner-facing fixed error wire shared by JSON and SSE terminal events. */
export type AaisGuidePublicErrorV1 = {
  schemaVersion: 1;
  code: AaisGuidePublicErrorCode;
  diagnosticId: string;
  retryable: boolean;
  learnerAction: AaisGuideLearnerAction;
};

export type AaisGuideDeliveryErrorInput = {
  code: AaisGuideDeliveryErrorCode;
  status: 422 | 502 | 503 | 504;
  retryable: boolean;
  learnerAction: AaisGuideLearnerAction;
  diagnosticId: string;
  attempts?: AaisGuideDeliveryAttemptDiagnosticV1[];
  gateReason?: AaisGuideDeliveryGateReason;
};

/**
 * A fail-closed learner-visible delivery error. It deliberately accepts no
 * free-form message or cause so provider bodies, prompts, model identifiers,
 * endpoints, and credentials cannot accidentally cross the route boundary.
 */
export class AaisGuideDeliveryError extends Error {
  readonly code: AaisGuideDeliveryErrorCode;
  readonly status: 422 | 502 | 503 | 504;
  readonly retryable: boolean;
  readonly learnerAction: AaisGuideLearnerAction;
  readonly diagnosticId: string;
  readonly attempts: AaisGuideDeliveryAttemptDiagnosticV1[];
  readonly gateReason?: AaisGuideDeliveryGateReason;
  readonly redaction = aaisGuideDeliveryRedaction;

  constructor(input: AaisGuideDeliveryErrorInput) {
    super(input.code);
    this.name = "AaisGuideDeliveryError";
    this.code = input.code;
    this.status = input.status;
    this.retryable = input.retryable;
    this.learnerAction = input.learnerAction;
    this.diagnosticId = input.diagnosticId;
    this.attempts = input.attempts ? [...input.attempts] : [];
    this.gateReason = input.gateReason;
  }
}

export function isAaisGuideDeliveryError(error: unknown): error is AaisGuideDeliveryError {
  if (error instanceof AaisGuideDeliveryError) {
    return true;
  }
  const candidate = error as Partial<AaisGuideDeliveryError> | null;
  return Boolean(
    candidate
      && candidate.name === "AaisGuideDeliveryError"
      && isAaisGuideDeliveryErrorCode(candidate.code)
      && typeof candidate.diagnosticId === "string"
      && typeof candidate.retryable === "boolean"
      && isAaisGuideLearnerAction(candidate.learnerAction)
      && [422, 502, 503, 504].includes(Number(candidate.status)),
  );
}

export function createAaisGuidePublicError(
  error: AaisGuideDeliveryError,
  locale: "zh-CN" | "en-US" = "zh-CN",
): AaisGuideProviderPublicErrorV1 {
  return {
    schemaVersion: 1,
    code: error.code,
    diagnosticId: error.diagnosticId,
    retryable: error.retryable,
    learnerAction: error.learnerAction,
    message: getPublicErrorMessage(error.code, locale),
  };
}

function isAaisGuideDeliveryErrorCode(value: unknown): value is AaisGuideDeliveryErrorCode {
  return [
    "AAIS_AI_LIVE_PROVIDER_REQUIRED",
    "AAIS_AI_MODEL_EVALUATION_REQUIRED",
    "AAIS_AI_OBSERVED_MODEL_MISMATCH",
    "AAIS_AI_OUTPUT_BLOCKED",
    "AAIS_AI_PROVIDER_CHAIN_EXHAUSTED",
    "AAIS_AI_PROVIDER_CONFIGURATION_INVALID",
  ].includes(String(value));
}

function isAaisGuideLearnerAction(value: unknown): value is AaisGuideLearnerAction {
  return ["retry", "rephrase", "contact-support"].includes(String(value));
}

function getPublicErrorMessage(
  code: AaisGuideDeliveryErrorCode,
  locale: "zh-CN" | "en-US",
) {
  if (locale === "en-US") {
    if (code === "AAIS_AI_OUTPUT_BLOCKED") {
      return "The online AI could not provide a safe response. Please rephrase your question.";
    }
    if (code === "AAIS_AI_PROVIDER_CHAIN_EXHAUSTED") {
      return "The online AI is temporarily unavailable. Please try again shortly.";
    }
    return "The online AI is unavailable because its production configuration requires attention.";
  }
  if (code === "AAIS_AI_OUTPUT_BLOCKED") {
    return "在线 AI 未能生成安全的回复。请换一种方式描述你的问题。";
  }
  if (code === "AAIS_AI_PROVIDER_CHAIN_EXHAUSTED") {
    return "在线 AI 暂时不可用，请稍后重试。";
  }
  return "在线 AI 的生产配置需要处理，当前暂时无法回复。";
}
