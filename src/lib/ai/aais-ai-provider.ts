import { randomUUID } from "node:crypto";
import type {
  AaisAgentId,
  AaisCaModule,
  AaisCognitiveApprenticeshipBackground,
  AaisPhase,
  Locale,
} from "@/data/aais";
import type { AaisGuideAttachment } from "@/lib/ai/aais-guide-attachments";
import {
  aaisAiGuardrailPolicy,
  createAaisAgentProviderMessages,
  evaluateAaisModelOutput,
} from "@/lib/ai/aais-ai-source-contract";
import {
  AaisGuideDeliveryError,
  aaisGuideDeliveryRedaction,
  type AaisGuideDeliveryAttemptDiagnosticV1,
  type AaisGuideDeliveryFailureReason,
  type AaisGuideDeliveryGateReason,
  type AaisGuideDeliveryPolicy,
  type AaisGuideRuntimeDeliveryReceiptV1,
  type AaisGuideProviderRole,
} from "@/lib/ai/aais-guide-delivery";
import type { AaisGuideConversationMessage } from "@/lib/ai/orchestration/aais-learning-guide-graph";
import {
  createDeterministicAaisAiRuntimeProfile,
  createManualAaisAiRuntimeProfile,
  getAaisAiModelFingerprint,
  getAaisAiObservedRevisionSha256,
  isAaisAiProviderEndpointAllowed,
  normalizeAaisAiMaxRetries,
  readAaisAiRuntimeConfig,
  studentRuntimeDefaultMaxRetries,
  studentRuntimeDefaultTimeoutMs,
  studentRuntimeMaxTokens,
  type AaisAiRuntimeProfile,
  type AaisAiRuntimeProviderCandidate,
  type AaisAiRuntimeProviderName,
} from "@/lib/ai/aais-ai-runtime-config";
import {
  getAaisAiEvalApproval,
  type AaisAiEvalApprovalResult,
  type AaisAiEvalProvider,
} from "@/lib/server/aais-ai-eval-manifest";
import { getAaisAiSourceLockEligibility } from "@/lib/server/aais-ai-release-lock";
import { readAaisBoundedResponseJson } from "@/lib/server/aais-bounded-response";

type AaisProviderWorkspaceState = {
  currentStep: string;
  artifactText?: string;
  helpRequestsUsed?: number;
  attachments?: AaisGuideAttachment[];
};

export type AaisProviderDispatchFence = {
  acquire(): Promise<"ready" | "deadline">;
  markAttemptStarted(): void;
  releaseBeforeAttempt(): Promise<"released" | "uncertain">;
};

export type AaisModelRequest = {
  agentId: AaisAgentId;
  label: string;
  role?: string;
  mission?: string;
  voice?: {
    persona: string;
    tone: string;
    replyContract: string;
    maxSentences?: number;
    maxCharacters?: number;
    maxOutputTokens?: number;
  };
  caModules?: AaisCaModule[];
  caBackground?: AaisCognitiveApprenticeshipBackground;
  locale: Locale;
  phase: AaisPhase;
  taskId: string;
  learnerInput: string;
  conversationHistory?: AaisGuideConversationMessage[];
  workspaceState: AaisProviderWorkspaceState;
  fallbackText: string;
  diagnosticId?: string;
  /** Absolute epoch-millisecond cutoff reserved for live provider work. */
  providerDeadlineAt?: number;
  /** Durable quota fence acquired immediately before the first live fetch. */
  providerDispatchFence?: AaisProviderDispatchFence;
  signal?: AbortSignal;
};

export type AaisModelRuntime = {
  provider: string;
  model: string;
  attempts: number;
  status: "ok" | "fallback";
  guardrail: {
    policy: "aais-age-appropriate-output-v1";
    status: "passed" | "blocked" | "not-applicable";
    reasons: string[];
  };
  redaction: {
    secrets: "omitted";
    prompt: "summarized";
  };
  delivery?: AaisGuideRuntimeDeliveryReceiptV1;
  providerChain?: {
    selected: "primary" | "fallback" | "deterministic";
    fallbackUsed: boolean;
    failures: Array<{
      provider: "primary" | "fallback";
      reason: AaisProviderFailureReason;
    }>;
  };
  runtimeProfile?: AaisAiRuntimeProfile;
};

export type AaisModelResponse = {
  text: string;
  runtime: AaisModelRuntime;
};

export type AaisModelProvider = {
  generate(request: AaisModelRequest): Promise<AaisModelResponse>;
};

type OpenAiCompatibleProviderInput = {
  endpoint: string;
  apiKey: string;
  model: string;
  provider?: AaisAiRuntimeProviderName;
  thinkingMode?: "disabled";
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  maxRetries?: number;
  maxTokens?: number;
  runtimeProfile?: AaisAiRuntimeProfile;
  deliveryPolicy?: AaisGuideDeliveryPolicy;
  requireObservedModel?: boolean;
  expectedObservedRevisionSha256?: string;
  providerRole?: "primary" | "fallback";
};

type OpenAiCompatibleProviderCandidate = OpenAiCompatibleProviderInput & {
  providerRole: "primary" | "fallback";
  runtimeProfile?: AaisAiRuntimeProfile;
};

type OpenAiCompatibleProviderChainInput = {
  primary: OpenAiCompatibleProviderCandidate;
  fallback?: OpenAiCompatibleProviderCandidate;
  deliveryPolicy: AaisGuideDeliveryPolicy;
};

type AaisProviderFailureReason = AaisGuideDeliveryFailureReason;

type AaisProviderFailure = {
  reason: AaisProviderFailureReason;
  attempts: number;
  retryable: boolean;
  guardrail?: AaisModelRuntime["guardrail"];
};

type AaisProviderChainFailure = {
  provider: AaisGuideProviderRole;
  reason: AaisProviderFailureReason;
  attempts: number;
  retryable: boolean;
  modelFingerprint: string;
  guardrail?: AaisModelRuntime["guardrail"];
};

type AaisProviderAttemptResult =
  | {
    ok: true;
    text: string;
    runtime: AaisModelRuntime;
  }
  | {
    ok: false;
    failure: AaisProviderFailure;
  };

const redaction = {
  secrets: "omitted",
  prompt: "summarized",
} as const;

const guardrailPolicy = aaisAiGuardrailPolicy;
export const AAIS_AI_PROVIDER_RESPONSE_MAX_BYTES = 256 * 1024;

export type AaisConfiguredModelProviderPreflight = {
  provider: AaisModelProvider;
  deliveryPolicy: AaisGuideDeliveryPolicy;
  runtimeProfile: AaisAiRuntimeProfile;
  configurationStatus: ReturnType<typeof readAaisAiRuntimeConfig>["configurationStatus"];
  evaluation: {
    primary: AaisAiEvalApprovalResult | null;
    fallback: AaisAiEvalApprovalResult | null;
  };
  eligibility: Record<AaisGuideProviderRole, {
    eligible: boolean;
    gateReason?: AaisGuideDeliveryGateReason;
  }>;
};

export function createConfiguredAaisModelProvider(): AaisModelProvider {
  return preflightConfiguredAaisModelProvider().provider;
}

export function preflightConfiguredAaisModelProvider(
  env: NodeJS.ProcessEnv = process.env,
): AaisConfiguredModelProviderPreflight {
  const runtimeConfig = readAaisAiRuntimeConfig(env);
  const deliveryPolicy = runtimeConfig.deliveryPolicy;
  const strict = deliveryPolicy === "require-live";
  const production = env.NODE_ENV === "production" || env.VERCEL_ENV === "production";
  const diagnosticId = randomUUID();

  if (runtimeConfig.configurationStatus.runtimeMode === "invalid") {
    if (strict) {
      throw createConfigurationError(
        "AAIS_AI_PROVIDER_CONFIGURATION_INVALID",
        diagnosticId,
        env.AAIS_AI_RUNTIME_MODE?.trim()
          ? "runtime-mode-invalid"
          : "runtime-mode-missing",
      );
    }
    return createDeterministicPreflight(runtimeConfig, null, null, env);
  }
  const primaryApproval = runtimeConfig.primary
    ? getAaisAiEvalApproval({
        required: strict,
        provider: getEvalProvider(runtimeConfig.primary.profile.provider),
        model: runtimeConfig.primary.model,
        providerRole: "primary",
        env,
      })
    : null;
  const fallbackApproval = runtimeConfig.fallback
    ? getAaisAiEvalApproval({
        required: strict,
        provider: getEvalProvider(runtimeConfig.fallback.profile.provider),
        model: runtimeConfig.fallback.model,
        providerRole: "fallback",
        env,
      })
    : null;

  const sourceLockEligibility = strict && production
    ? getAaisAiSourceLockEligibility(env)
    : {
        primary: { eligible: true },
        fallback: { eligible: true },
      };
  const eligiblePrimary = runtimeConfig.primary
    && (!strict || (primaryApproval?.approved && sourceLockEligibility.primary.eligible))
    ? runtimeConfig.primary
    : null;
  const eligibleFallback = runtimeConfig.fallback
    && (!strict || (fallbackApproval?.approved && sourceLockEligibility.fallback.eligible))
    ? runtimeConfig.fallback
    : null;
  const eligibility = {
    primary: createProviderEligibility({
      role: "primary",
      eligible: Boolean(eligiblePrimary),
      configurationStatus: runtimeConfig.configurationStatus.primary,
      approval: primaryApproval,
      sourceLockEligible: sourceLockEligibility.primary.eligible,
      env,
    }),
    fallback: createProviderEligibility({
      role: "fallback",
      eligible: Boolean(eligibleFallback),
      configurationStatus: runtimeConfig.configurationStatus.fallback,
      approval: fallbackApproval,
      sourceLockEligible: sourceLockEligibility.fallback.eligible,
      env,
    }),
  };
  const gateDiagnostics = strict
    ? createEligibilityDiagnostics(eligibility, runtimeConfig, env)
    : [];

  if (!eligiblePrimary && !eligibleFallback) {
    if (!strict) {
      return createDeterministicPreflight(
        runtimeConfig,
        primaryApproval,
        fallbackApproval,
        env,
      );
    }
    const gateReason = selectPreflightGateReason(eligibility);
    throw createConfigurationError(
      gateReason?.startsWith("evaluation-") || gateReason === "release-lock-blocked"
        ? "AAIS_AI_MODEL_EVALUATION_REQUIRED"
        : gateReason === "configuration-missing"
          ? "AAIS_AI_LIVE_PROVIDER_REQUIRED"
          : "AAIS_AI_PROVIDER_CONFIGURATION_INVALID",
      diagnosticId,
      gateReason,
      gateDiagnostics,
    );
  }

  const runtimeProfile: AaisAiRuntimeProfile = {
    ...runtimeConfig.profile,
    mode: "live",
    primary: eligiblePrimary?.profile ?? null,
    fallback: eligibleFallback?.profile ?? null,
  };
  const primary = eligiblePrimary
    ? toOpenAiCompatibleCandidate(eligiblePrimary, runtimeProfile, deliveryPolicy)
    : null;
  const fallback = eligibleFallback
    ? toOpenAiCompatibleCandidate(eligibleFallback, runtimeProfile, deliveryPolicy)
    : null;
  const provider = primary && fallback
    ? createOpenAiCompatibleAaisProviderChain({
        primary,
        fallback,
        deliveryPolicy,
      })
    : createOpenAiCompatibleCandidateProvider(
        primary ?? fallback!,
        deliveryPolicy,
        gateDiagnostics,
      );

  return {
    provider,
    deliveryPolicy,
    runtimeProfile,
    configurationStatus: runtimeConfig.configurationStatus,
    evaluation: {
      primary: primaryApproval,
      fallback: fallbackApproval,
    },
    eligibility,
  };
}

function createDeterministicPreflight(
  runtimeConfig: ReturnType<typeof readAaisAiRuntimeConfig>,
  primary: AaisAiEvalApprovalResult | null,
  fallback: AaisAiEvalApprovalResult | null,
  env: NodeJS.ProcessEnv,
): AaisConfiguredModelProviderPreflight {
  const runtimeProfile = createDeterministicAaisAiRuntimeProfile(
    runtimeConfig.deliveryPolicy,
  );
  return {
    provider: createDeterministicAaisProvider(runtimeProfile),
    deliveryPolicy: runtimeConfig.deliveryPolicy,
    runtimeProfile,
    configurationStatus: runtimeConfig.configurationStatus,
    evaluation: { primary, fallback },
    eligibility: {
      primary: createProviderEligibility({
        role: "primary",
        eligible: Boolean(runtimeConfig.primary),
        configurationStatus: runtimeConfig.configurationStatus.primary,
        approval: primary,
        env,
      }),
      fallback: createProviderEligibility({
        role: "fallback",
        eligible: Boolean(runtimeConfig.fallback),
        configurationStatus: runtimeConfig.configurationStatus.fallback,
        approval: fallback,
        env,
      }),
    },
  };
}

function createConfigurationError(
  code:
    | "AAIS_AI_LIVE_PROVIDER_REQUIRED"
    | "AAIS_AI_MODEL_EVALUATION_REQUIRED"
    | "AAIS_AI_PROVIDER_CONFIGURATION_INVALID",
  diagnosticId: string,
  gateReason?: AaisGuideDeliveryGateReason,
  attempts: AaisGuideDeliveryAttemptDiagnosticV1[] = [],
) {
  return new AaisGuideDeliveryError({
    code,
    status: 503,
    retryable: false,
    learnerAction: "contact-support",
    diagnosticId,
    gateReason,
    attempts,
  });
}

function createProviderEligibility(input: {
  role: AaisGuideProviderRole;
  eligible: boolean;
  configurationStatus: "valid" | "missing" | "invalid";
  approval: AaisAiEvalApprovalResult | null;
  sourceLockEligible?: boolean;
  env: NodeJS.ProcessEnv;
}): { eligible: boolean; gateReason?: AaisGuideDeliveryGateReason } {
  if (input.eligible) {
    return { eligible: true };
  }
  if (input.configurationStatus === "missing") {
    return { eligible: false, gateReason: "configuration-missing" };
  }
  if (input.configurationStatus === "invalid") {
    return {
      eligible: false,
      gateReason: getInvalidProviderConfigurationGateReason(input.role, input.env),
    };
  }
  if (!input.approval?.approved) {
    const manifestStatus = String(input.approval?.manifest.status ?? "missing");
    if (manifestStatus === "expired") {
      return { eligible: false, gateReason: "evaluation-expired" };
    }
    if (manifestStatus === "invalid") {
      return { eligible: false, gateReason: "evaluation-invalid" };
    }
    if (manifestStatus === "mismatch") {
      return { eligible: false, gateReason: "evaluation-mismatch" };
    }
    return { eligible: false, gateReason: "evaluation-missing" };
  }
  if (input.sourceLockEligible === false) {
    return { eligible: false, gateReason: "release-lock-blocked" };
  }
  return { eligible: false, gateReason: "configuration-invalid" };
}

function getEvalProvider(provider: AaisAiRuntimeProviderName): AaisAiEvalProvider {
  return provider === "qwen" || provider === "deepseek"
    ? provider
    : "openai-compatible";
}

function getInvalidProviderConfigurationGateReason(
  role: AaisGuideProviderRole,
  env: NodeJS.ProcessEnv,
): AaisGuideDeliveryGateReason {
  const production = env.NODE_ENV === "production" || env.VERCEL_ENV === "production";
  const endpoint = role === "primary"
    ? env.AAIS_AI_ENDPOINT?.trim()
    : env.AAIS_AI_FALLBACK_ENDPOINT?.trim();
  const configuredProvider = role === "primary"
    ? env.AAIS_AI_PROVIDER?.trim().toLowerCase()
    : env.AAIS_AI_FALLBACK_PROVIDER?.trim().toLowerCase();
  const expectedProvider = role === "primary"
    ? configuredProvider === "dashscope" ? "dashscope" : "qwen"
    : "deepseek";
  if (endpoint && !isAaisAiProviderEndpointAllowed(endpoint, env, {
    provider: expectedProvider,
    providerRole: role,
  })) {
    return "endpoint-not-allowed";
  }
  if (!production) {
    return "configuration-invalid";
  }
  const requiredValues = role === "primary"
    ? [
        configuredProvider,
        endpoint,
        env.AAIS_AI_API_KEY?.trim()
          || env.DASHSCOPE_API_KEY?.trim()
          || env.QWEN_API_KEY?.trim(),
        env.AAIS_AI_MODEL?.trim(),
        env.AAIS_AI_THINKING_MODE?.trim(),
        env.AAIS_AI_TIMEOUT_MS?.trim(),
        env.AAIS_AI_MAX_RETRIES?.trim(),
        env.AAIS_AI_OBSERVED_REVISION_SHA256?.trim(),
      ]
    : [
        env.AAIS_AI_FALLBACK_ENABLED?.trim(),
        configuredProvider,
        endpoint,
        env.AAIS_AI_FALLBACK_API_KEY?.trim(),
        env.AAIS_AI_FALLBACK_MODEL?.trim(),
        env.AAIS_AI_FALLBACK_THINKING_MODE?.trim()
          || env.AAIS_AI_FALLBACK_THINKING?.trim(),
        env.AAIS_AI_FALLBACK_TIMEOUT_MS?.trim(),
        env.AAIS_AI_FALLBACK_MAX_RETRIES?.trim(),
        env.AAIS_AI_FALLBACK_OBSERVED_REVISION_SHA256?.trim(),
      ];
  return requiredValues.some((value) => !value)
    ? "configuration-missing"
    : "configuration-invalid";
}

function createEligibilityDiagnostics(
  eligibility: AaisConfiguredModelProviderPreflight["eligibility"],
  runtimeConfig: ReturnType<typeof readAaisAiRuntimeConfig>,
  env: NodeJS.ProcessEnv,
): AaisGuideDeliveryAttemptDiagnosticV1[] {
  return (["primary", "fallback"] as const).flatMap((role) => {
    const status = eligibility[role];
    if (status.eligible || !status.gateReason) {
      return [];
    }
    const model = runtimeConfig[role]?.model
      ?? (role === "primary"
        ? env.AAIS_AI_MODEL?.trim()
        : env.AAIS_AI_FALLBACK_MODEL?.trim());
    return [{
      role,
      outcome: "skipped" as const,
      attempts: 0,
      ...(model ? { modelFingerprint: getAaisAiModelFingerprint(model) } : {}),
      observedModel: "not-reported" as const,
      observedRevision: "not-reported" as const,
      gateReason: status.gateReason,
    }];
  });
}

function selectPreflightGateReason(
  eligibility: AaisConfiguredModelProviderPreflight["eligibility"],
) {
  return eligibility.primary.gateReason ?? eligibility.fallback.gateReason;
}

function createProviderChainError(
  failures: AaisProviderChainFailure[],
  diagnosticId: string,
  gateDiagnostics: AaisGuideDeliveryAttemptDiagnosticV1[] = [],
) {
  const attempts = sortDeliveryDiagnostics([
    ...failures.map(toAttemptDiagnostic),
    ...gateDiagnostics,
  ]);
  if (failures.length > 0 && failures.every((failure) =>
    failure.reason === "guardrail-blocked")) {
    return new AaisGuideDeliveryError({
      code: "AAIS_AI_OUTPUT_BLOCKED",
      status: 422,
      retryable: false,
      learnerAction: "rephrase",
      diagnosticId,
      attempts,
    });
  }
  if (failures.some((failure) =>
    failure.reason === "observed-model-missing"
    || failure.reason === "observed-model-mismatch"
    || failure.reason === "observed-revision-missing"
    || failure.reason === "observed-revision-mismatch")) {
    return new AaisGuideDeliveryError({
      code: "AAIS_AI_OBSERVED_MODEL_MISMATCH",
      status: 502,
      retryable: false,
      learnerAction: "contact-support",
      diagnosticId,
      attempts,
    });
  }
  const providerBudgetExpired = failures.some((failure) =>
    failure.reason === "route-deadline");
  const retryable = providerBudgetExpired
    || failures.some((failure) => failure.retryable);
  const timeoutOnly = failures.length > 0 && failures.every((failure) =>
    failure.reason === "abort-timeout"
    || failure.reason === "connect-timeout"
    || failure.reason === "route-deadline");
  return new AaisGuideDeliveryError({
    code: "AAIS_AI_PROVIDER_CHAIN_EXHAUSTED",
    status: providerBudgetExpired || timeoutOnly ? 504 : 502,
    retryable,
    learnerAction: retryable ? "retry" : "contact-support",
    diagnosticId,
    attempts,
  });
}

function createDeliveryReceipt(input: {
  diagnosticId: string;
  mode: AaisGuideRuntimeDeliveryReceiptV1["mode"];
  channel: AaisGuideRuntimeDeliveryReceiptV1["channel"];
  attempts: AaisGuideDeliveryAttemptDiagnosticV1[];
}): AaisGuideRuntimeDeliveryReceiptV1 {
  const observedModel = input.attempts.some((attempt) =>
    attempt.outcome === "succeeded" && attempt.observedModel === "matched")
    ? "matched" as const
    : "not-reported" as const;
  return {
    schemaVersion: 1,
    mode: input.mode,
    channel: input.channel,
    degraded: input.channel !== "primary",
    diagnosticId: input.diagnosticId,
    observedModel,
    attempts: input.attempts,
    redaction: aaisGuideDeliveryRedaction,
  };
}

function resolveDiagnosticId(request: Pick<AaisModelRequest, "diagnosticId">) {
  const candidate = request.diagnosticId?.trim();
  return candidate && /^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$/.test(candidate)
    ? candidate
    : randomUUID();
}

function toProviderChainFailure(input: {
  candidate: OpenAiCompatibleProviderCandidate;
  failure: AaisProviderFailure;
}): AaisProviderChainFailure {
  return {
    provider: input.candidate.providerRole,
    reason: input.failure.reason,
    attempts: input.failure.attempts,
    retryable: input.failure.retryable,
    modelFingerprint: getAaisAiModelFingerprint(input.candidate.model),
    guardrail: input.failure.guardrail,
  };
}

function toAttemptDiagnostic(
  failure: AaisProviderChainFailure,
): AaisGuideDeliveryAttemptDiagnosticV1 {
  return {
    role: failure.provider,
    outcome: failure.reason === "guardrail-blocked" ? "blocked" : "failed",
    attempts: failure.attempts,
    modelFingerprint: failure.modelFingerprint,
    observedModel: failure.reason === "observed-model-missing"
      ? "missing"
      : failure.reason === "observed-model-mismatch"
        ? "mismatch"
        : failure.reason === "observed-revision-missing"
          || failure.reason === "observed-revision-mismatch"
          ? "matched"
          : "not-reported",
    observedRevision: failure.reason === "observed-revision-missing"
      ? "missing"
      : failure.reason === "observed-revision-mismatch"
        ? "mismatch"
        : "not-reported",
    reason: failure.reason,
  };
}

function createSuccessfulAttemptDiagnostic(
  candidate: OpenAiCompatibleProviderCandidate,
  attempts: number,
  observedModel: "matched" | "not-reported" = candidate.requireObservedModel
    ? "matched"
    : "not-reported",
  observedRevision: {
    status: "matched" | "not-required" | "not-reported";
    sha256?: string;
  } = {
    status: candidate.expectedObservedRevisionSha256 ? "matched" : "not-required",
  },
): AaisGuideDeliveryAttemptDiagnosticV1 {
  return {
    role: candidate.providerRole,
    outcome: "succeeded",
    attempts,
    modelFingerprint: getAaisAiModelFingerprint(candidate.model),
    observedModel,
    observedRevision: observedRevision.status,
    ...(observedRevision.sha256
      ? { observedRevisionSha256: observedRevision.sha256 }
      : {}),
  };
}

function toRuntimeChainFailure(failure: AaisProviderChainFailure) {
  return {
    provider: failure.provider,
    reason: failure.reason,
  };
}

export function createDeterministicAaisProvider(
  runtimeProfile: AaisAiRuntimeProfile = createDeterministicAaisAiRuntimeProfile(),
): AaisModelProvider {
  return {
    async generate(request) {
      throwIfAaisRequestAborted(request);
      return {
        text: request.fallbackText,
        runtime: {
          provider: "deterministic",
          model: "local-template",
          attempts: 0,
          status: "fallback",
          guardrail: {
            policy: guardrailPolicy,
            status: "not-applicable",
            reasons: ["deterministic-template"],
          },
          redaction,
          delivery: createDeliveryReceipt({
            diagnosticId: resolveDiagnosticId(request),
            mode: "deterministic",
            channel: "deterministic",
            attempts: [],
          }),
          runtimeProfile,
        },
      };
    },
  };
}

export function createOpenAiCompatibleAaisProvider(
  input: OpenAiCompatibleProviderInput,
): AaisModelProvider {
  const deliveryPolicy = input.deliveryPolicy
    ?? input.runtimeProfile?.deliveryPolicy
    ?? "allow-deterministic";
  const runtimeProfile = input.runtimeProfile ?? createManualAaisAiRuntimeProfile({
    ...input,
    deliveryPolicy,
  });
  return createOpenAiCompatibleCandidateProvider({
    ...input,
    providerRole: input.providerRole ?? "primary",
    runtimeProfile,
    deliveryPolicy,
    requireObservedModel: input.requireObservedModel ?? deliveryPolicy === "require-live",
  }, deliveryPolicy);
}

function createOpenAiCompatibleCandidateProvider(
  candidate: OpenAiCompatibleProviderCandidate,
  deliveryPolicy: AaisGuideDeliveryPolicy,
  gateDiagnostics: AaisGuideDeliveryAttemptDiagnosticV1[] = [],
): AaisModelProvider {
  return {
    async generate(request) {
      throwIfAaisRequestAborted(request);
      const diagnosticId = resolveDiagnosticId(request);
      const result = await generateWithOpenAiCompatibleCandidate(
        candidate,
        request,
        diagnosticId,
      );
      throwIfAaisRequestAborted(request);
      if (result.ok) {
        return withGateDiagnostics(result, gateDiagnostics);
      }
      const failures = [toProviderChainFailure({
        candidate,
        failure: result.failure,
      })];
      if (deliveryPolicy === "require-live") {
        throw createProviderChainError(failures, diagnosticId, gateDiagnostics);
      }
      return {
        text: request.fallbackText,
        runtime: {
          provider: "openai-compatible",
          model: candidate.model,
          attempts: result.failure.attempts,
          status: "fallback",
          guardrail: result.failure.guardrail ?? {
            policy: guardrailPolicy,
            status: "not-applicable",
            reasons: [result.failure.reason],
          },
          redaction,
          delivery: createDeliveryReceipt({
            diagnosticId,
            mode: "deterministic",
            channel: "deterministic",
            attempts: failures.map(toAttemptDiagnostic),
          }),
          providerChain: {
            selected: "deterministic",
            fallbackUsed: candidate.providerRole === "fallback",
            failures: failures.map(toRuntimeChainFailure),
          },
          runtimeProfile: candidate.runtimeProfile,
        },
      };
    },
  };
}

function withGateDiagnostics(
  response: AaisModelResponse,
  gateDiagnostics: AaisGuideDeliveryAttemptDiagnosticV1[],
): AaisModelResponse {
  if (!gateDiagnostics.length || !response.runtime.delivery) {
    return response;
  }
  return {
    ...response,
    runtime: {
      ...response.runtime,
      delivery: {
        ...response.runtime.delivery,
        attempts: sortDeliveryDiagnostics([
          ...response.runtime.delivery.attempts,
          ...gateDiagnostics,
        ]),
      },
    },
  };
}

function sortDeliveryDiagnostics(
  diagnostics: AaisGuideDeliveryAttemptDiagnosticV1[],
) {
  return [...diagnostics].sort((left, right) =>
    (left.role === "primary" ? 0 : 1) - (right.role === "primary" ? 0 : 1));
}

function createOpenAiCompatibleAaisProviderChain(
  input: OpenAiCompatibleProviderChainInput,
): AaisModelProvider {
  return {
    async generate(request) {
      throwIfAaisRequestAborted(request);
      const diagnosticId = resolveDiagnosticId(request);
      const primaryResult = await generateWithOpenAiCompatibleCandidate(
        input.primary,
        request,
        diagnosticId,
      );
      throwIfAaisRequestAborted(request);
      if (primaryResult.ok) {
        return {
          text: primaryResult.text,
          runtime: {
            ...primaryResult.runtime,
            providerChain: {
              selected: "primary",
              fallbackUsed: false,
              failures: [],
            },
          },
        };
      }

      const failures: AaisProviderChainFailure[] = [
        toProviderChainFailure({
          candidate: input.primary,
          failure: primaryResult.failure,
        }),
      ];

      if (input.fallback) {
        const fallbackResult = await generateWithOpenAiCompatibleCandidate(
          input.fallback,
          request,
          diagnosticId,
        );
        throwIfAaisRequestAborted(request);
        if (fallbackResult.ok) {
          return {
            text: fallbackResult.text,
            runtime: {
              ...fallbackResult.runtime,
              attempts: primaryResult.failure.attempts + fallbackResult.runtime.attempts,
              delivery: createDeliveryReceipt({
                diagnosticId,
                mode: "live",
                channel: "secondary",
                attempts: [
                  ...failures.map(toAttemptDiagnostic),
                  fallbackResult.runtime.delivery?.attempts.find((attempt) =>
                    attempt.outcome === "succeeded")
                    ?? createSuccessfulAttemptDiagnostic(
                      input.fallback,
                      fallbackResult.runtime.attempts,
                    ),
                ],
              }),
              providerChain: {
                selected: "fallback",
                fallbackUsed: true,
                failures: failures.map(toRuntimeChainFailure),
              },
            },
          };
        }
        failures.push(toProviderChainFailure({
          candidate: input.fallback,
          failure: fallbackResult.failure,
        }));
        if (input.deliveryPolicy === "require-live") {
          throw createProviderChainError(failures, diagnosticId);
        }
        return createDeterministicChainFallback({
          request,
          model: input.fallback.model,
          runtimeProfile: input.fallback.runtimeProfile,
          attempts: primaryResult.failure.attempts + fallbackResult.failure.attempts,
          failures,
          diagnosticId,
        });
      }

      if (input.deliveryPolicy === "require-live") {
        throw createProviderChainError(failures, diagnosticId);
      }
      return createDeterministicChainFallback({
        request,
        model: input.primary.model,
        runtimeProfile: input.primary.runtimeProfile,
        attempts: primaryResult.failure.attempts,
        failures,
        diagnosticId,
      });
    },
  };
}

async function generateWithOpenAiCompatibleCandidate(
  input: OpenAiCompatibleProviderCandidate,
  request: AaisModelRequest,
  diagnosticId: string,
): Promise<AaisProviderAttemptResult> {
  const boundedRetries = input.deliveryPolicy === "require-live"
    ? 0
    : normalizeAaisAiMaxRetries(
        input.maxRetries ?? studentRuntimeDefaultMaxRetries,
      );
  const maxAttempts = boundedRetries + 1;
  let failure: AaisProviderFailure = {
    reason: "provider-error",
    attempts: 0,
    retryable: true,
  };

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    throwIfAaisRequestAborted(request);
    if (getProviderBudgetRemainingMs(request) <= 0) {
      return {
        ok: false,
        failure: {
          reason: "route-deadline",
          attempts: attempt - 1,
          retryable: false,
        },
      };
    }
    try {
      const providerResponse = await callOpenAiCompatibleProvider(input, request);
      throwIfAaisRequestAborted(request);
      const guardrail = evaluateAaisModelOutput(providerResponse.text, request);
      if (guardrail.status === "blocked") {
        return {
          ok: false,
          failure: {
            reason: "guardrail-blocked",
            attempts: attempt,
            retryable: false,
            guardrail,
          },
        };
      }
      return {
        ok: true,
        text: providerResponse.text,
        runtime: {
          provider: "openai-compatible",
          model: input.model,
          attempts: attempt,
          status: "ok",
          guardrail,
          redaction,
          delivery: createDeliveryReceipt({
            diagnosticId,
            mode: "live",
            channel: input.providerRole === "primary" ? "primary" : "secondary",
            attempts: [createSuccessfulAttemptDiagnostic(
              input,
              attempt,
              providerResponse.observedModel,
              providerResponse.observedRevision,
            )],
          }),
          runtimeProfile: input.runtimeProfile,
        },
      };
    } catch (error) {
      throwIfAaisRequestAborted(request);
      const classified = classifyProviderError(error);
      failure = {
        reason: classified.reason,
        retryable: classified.retryable,
        attempts: classified.attempted ? attempt : attempt - 1,
      };
      if (!classified.retryable || attempt === maxAttempts) {
        break;
      }
    }
  }

  return {
    ok: false,
    failure,
  };
}

function createDeterministicChainFallback(input: {
  request: AaisModelRequest;
  model: string;
  runtimeProfile?: AaisAiRuntimeProfile;
  attempts: number;
  failures: AaisProviderChainFailure[];
  diagnosticId: string;
}): AaisModelResponse {
  const blockedGuardrail = input.failures.find((failure) => failure.guardrail)?.guardrail;
  return {
    text: input.request.fallbackText,
    runtime: {
      provider: "openai-compatible",
      model: input.model,
      attempts: input.attempts,
      status: "fallback",
      guardrail: blockedGuardrail ?? {
        policy: guardrailPolicy,
        status: "not-applicable",
        reasons: input.failures.map((failure) => failure.reason),
      },
      redaction,
      delivery: createDeliveryReceipt({
        diagnosticId: input.diagnosticId,
        mode: "deterministic",
        channel: "deterministic",
        attempts: input.failures.map(toAttemptDiagnostic),
      }),
      runtimeProfile: input.runtimeProfile,
      providerChain: {
        selected: "deterministic",
        fallbackUsed: input.failures.some((failure) => failure.provider === "fallback"),
        failures: input.failures.map(toRuntimeChainFailure),
      },
    },
  };
}

async function callOpenAiCompatibleProvider(
  input: OpenAiCompatibleProviderCandidate,
  request: AaisModelRequest,
) {
  throwIfAaisRequestAborted(request);
  if (!isAaisAiProviderEndpointAllowed(input.endpoint, process.env, {
    provider: input.provider ?? "openai-compatible",
    providerRole: input.providerRole,
  })) {
    throw createProviderError("provider-error", false);
  }
  const configuredTimeoutMs = input.timeoutMs ?? studentRuntimeDefaultTimeoutMs;
  let providerBudgetRemainingMs = getProviderBudgetRemainingMs(request);
  if (providerBudgetRemainingMs <= 0) {
    throw createProviderError("route-deadline", false, false);
  }
  if (request.providerDispatchFence) {
    let fenceStatus: "ready" | "deadline";
    try {
      fenceStatus = await request.providerDispatchFence.acquire();
    } catch (error) {
      throwIfAaisRequestAborted(request);
      throw createProviderError("provider-error", true, false, error);
    }
    if (fenceStatus === "deadline") {
      throw createProviderError("route-deadline", false, false);
    }
    if (request.signal?.aborted) {
      try {
        await request.providerDispatchFence.releaseBeforeAttempt();
      } catch {
        // The durable fence remains dispatched-uncertain when rollback cannot be proven.
      }
      request.signal.throwIfAborted();
    }
    providerBudgetRemainingMs = getProviderBudgetRemainingMs(request);
    if (providerBudgetRemainingMs <= 0) {
      try {
        await request.providerDispatchFence.releaseBeforeAttempt();
      } catch (error) {
        throw createProviderError("provider-error", true, false, error);
      }
      throw createProviderError("route-deadline", false, false);
    }
  }
  const providerBudgetBoundsAttempt = Number.isFinite(providerBudgetRemainingMs)
    && providerBudgetRemainingMs <= configuredTimeoutMs;
  const attemptTimeoutMs = Math.max(
    1,
    Math.min(configuredTimeoutMs, providerBudgetRemainingMs),
  );
  const controller = new AbortController();
  let receivedResponseHeaders = false;
  const timeout = setTimeout(() => controller.abort(createProviderError(
    providerBudgetBoundsAttempt
      ? "route-deadline"
      : receivedResponseHeaders
        ? "abort-timeout"
        : "connect-timeout",
    false,
  )), attemptTimeoutMs);
  const abortFromRequest = () => controller.abort(request.signal?.reason);
  request.signal?.addEventListener("abort", abortFromRequest, { once: true });
  if (request.signal?.aborted) {
    abortFromRequest();
  }
  try {
    if (controller.signal.aborted) {
      try {
        await request.providerDispatchFence?.releaseBeforeAttempt();
      } catch {
        // The durable fence remains dispatched-uncertain when rollback cannot be proven.
      }
      request.signal?.throwIfAborted();
      throw controller.signal.reason;
    }
    let responsePromise: Promise<Response>;
    try {
      responsePromise = (input.fetchImpl ?? fetch)(input.endpoint, {
        method: "POST",
        headers: {
          authorization: `Bearer ${input.apiKey}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          model: input.model,
          temperature: 0.2,
          max_tokens: resolveAgentMaxOutputTokens(input.maxTokens, request),
          ...createThinkingModePayload(input),
          messages: createAaisAgentProviderMessages(request),
        }),
        signal: controller.signal,
      });
    } finally {
      request.providerDispatchFence?.markAttemptStarted();
    }
    const response = await responsePromise;
    receivedResponseHeaders = true;
    throwIfAaisRequestAborted(request);
    if (!response.ok) {
      if (response.status === 429) {
        throw createProviderError("rate-limited", true);
      }
      if (response.status === 401 || response.status === 403) {
        throw createProviderError("auth-failed", false);
      }
      if (response.status === 402) {
        throw createProviderError("payment-required", false);
      }
      if (response.status === 400 || response.status === 422) {
        throw createProviderError("invalid-request", false);
      }
      if (response.status >= 500) {
        throw createProviderError("upstream-5xx", true);
      }
      throw createProviderError("upstream-4xx", false);
    }
    let parsedBody: unknown;
    try {
      parsedBody = await readAaisBoundedResponseJson(
        response,
        AAIS_AI_PROVIDER_RESPONSE_MAX_BYTES,
        "AAIS AI provider response is too large.",
      );
    } catch {
      throw createProviderError("invalid-response", false);
    }
    if (!isProviderResponseRecord(parsedBody)) {
      throw createProviderError("invalid-response", false);
    }
    const body = parsedBody as {
      model?: unknown;
      system_fingerprint?: unknown;
      choices?: Array<{
        finish_reason?: unknown;
        finishReason?: unknown;
        stop_reason?: unknown;
        message?: {
          content?: string;
        };
      }>;
    };
    throwIfAaisRequestAborted(request);
    const choice = body.choices?.[0];
    if (!Array.isArray(body.choices) || !choice) {
      throw createProviderError("invalid-response", false);
    }
    const finishReason = choice.finish_reason ?? choice.finishReason ?? choice.stop_reason;
    if (isProviderContentFilterFinishReason(finishReason)) {
      throw createProviderError("guardrail-blocked", false);
    }
    if (isProviderResourceExhaustionFinishReason(finishReason)) {
      throw createProviderError("upstream-5xx", true);
    }
    if (isTruncatedProviderFinishReason(finishReason)) {
      throw createProviderError("truncated-response", true);
    }
    if (!choice.message || typeof choice.message.content !== "string") {
      throw createProviderError("invalid-response", false);
    }
    const observedModel = typeof body.model === "string" ? body.model.trim() : "";
    if (!observedModel && input.requireObservedModel) {
      throw createProviderError("observed-model-missing", false);
    }
    if (observedModel && observedModel !== input.model) {
      throw createProviderError("observed-model-mismatch", false);
    }
    const observedRevision = typeof body.system_fingerprint === "string"
      ? body.system_fingerprint.trim()
      : "";
    if (!observedRevision && input.expectedObservedRevisionSha256) {
      throw createProviderError("observed-revision-missing", false);
    }
    const observedRevisionSha256 = observedRevision
      ? getAaisAiObservedRevisionSha256(observedRevision)
      : undefined;
    if (input.expectedObservedRevisionSha256
      && observedRevisionSha256 !== input.expectedObservedRevisionSha256) {
      throw createProviderError("observed-revision-mismatch", false);
    }
    const content = choice.message.content.trim();
    if (!content) {
      throw createProviderError("empty-response", true);
    }
    return {
      text: content,
      observedModel: observedModel ? "matched" as const : "not-reported" as const,
      observedRevision: {
        status: input.expectedObservedRevisionSha256
          ? "matched" as const
          : observedRevision
            ? "not-required" as const
            : "not-reported" as const,
        ...(observedRevisionSha256 ? { sha256: observedRevisionSha256 } : {}),
      },
    };
  } catch (error) {
    if (!request.signal?.aborted && controller.signal.aborted) {
      const reason = controller.signal.reason as { reason?: unknown } | undefined;
      if (isProviderFailureReason(reason?.reason)) {
        throw reason;
      }
      throw createProviderError(
        providerBudgetBoundsAttempt
          ? "route-deadline"
          : receivedResponseHeaders
            ? "abort-timeout"
            : "connect-timeout",
        false,
      );
    }
    throw error;
  } finally {
    clearTimeout(timeout);
    request.signal?.removeEventListener("abort", abortFromRequest);
  }
}

function isProviderResponseRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function getProviderBudgetRemainingMs(
  request: Pick<AaisModelRequest, "providerDeadlineAt">,
) {
  if (typeof request.providerDeadlineAt !== "number"
    || !Number.isFinite(request.providerDeadlineAt)) {
    return Number.POSITIVE_INFINITY;
  }
  return request.providerDeadlineAt - Date.now();
}

function throwIfAaisRequestAborted(request: Pick<AaisModelRequest, "signal">) {
  if (!request.signal?.aborted) {
    return;
  }
  request.signal.throwIfAborted();
}

function toOpenAiCompatibleCandidate(
  candidate: AaisAiRuntimeProviderCandidate,
  runtimeProfile: AaisAiRuntimeProfile,
  deliveryPolicy: AaisGuideDeliveryPolicy,
): OpenAiCompatibleProviderCandidate {
  return {
    endpoint: candidate.endpoint,
    apiKey: candidate.apiKey,
    model: candidate.model,
    expectedObservedRevisionSha256: candidate.expectedObservedRevisionSha256,
    provider: candidate.profile.provider,
    thinkingMode: candidate.thinkingMode,
    timeoutMs: candidate.timeoutMs,
    maxRetries: candidate.maxRetries,
    maxTokens: candidate.maxTokens,
    providerRole: candidate.providerRole,
    runtimeProfile,
    deliveryPolicy,
    requireObservedModel: deliveryPolicy === "require-live",
  };
}

function createProviderError(
  reason: AaisProviderFailureReason,
  retryable: boolean,
  attempted = true,
  cause?: unknown,
) {
  return Object.assign(new Error(reason), {
    reason,
    retryable,
    attempted,
    ...(cause === undefined ? {} : { cause }),
  });
}

function classifyProviderError(error: unknown): Pick<AaisProviderFailure, "reason" | "retryable"> & {
  attempted: boolean;
} {
  const errorWithReason = error as {
    reason?: unknown;
    retryable?: unknown;
    attempted?: unknown;
    name?: unknown;
    message?: unknown;
    cause?: {
      code?: unknown;
      name?: unknown;
      message?: unknown;
    };
  };
  if (isProviderFailureReason(errorWithReason.reason)) {
    return {
      reason: errorWithReason.reason,
      retryable: errorWithReason.retryable === true,
      attempted: errorWithReason.attempted !== false,
    };
  }
  const name = String(errorWithReason.name ?? "");
  if (name === "AbortError") {
    return { reason: "abort-timeout", retryable: true, attempted: true };
  }
  const causeCode = String(errorWithReason.cause?.code ?? "");
  const causeName = String(errorWithReason.cause?.name ?? "");
  const causeMessage = String(errorWithReason.cause?.message ?? "");
  const message = String(errorWithReason.message ?? "");
  if (
    causeCode === "UND_ERR_CONNECT_TIMEOUT"
    || causeName === "ConnectTimeoutError"
    || /connect timeout/i.test(causeMessage)
    || /connect timeout/i.test(message)
  ) {
    return { reason: "connect-timeout", retryable: true, attempted: true };
  }
  return { reason: "provider-error", retryable: true, attempted: true };
}

function isProviderFailureReason(value: unknown): value is AaisProviderFailureReason {
  return [
    "abort-timeout",
    "auth-failed",
    "connect-timeout",
    "empty-response",
    "guardrail-blocked",
    "invalid-response",
    "invalid-request",
    "observed-model-mismatch",
    "observed-model-missing",
    "observed-revision-mismatch",
    "observed-revision-missing",
    "rate-limited",
    "route-deadline",
    "truncated-response",
    "provider-error",
    "payment-required",
    "upstream-4xx",
    "upstream-5xx",
  ].includes(String(value));
}

function isProviderContentFilterFinishReason(value: unknown) {
  return normalizeProviderFinishReason(value) === "content_filter";
}

function isProviderResourceExhaustionFinishReason(value: unknown) {
  return normalizeProviderFinishReason(value) === "insufficient_system_resource";
}

function isTruncatedProviderFinishReason(value: unknown) {
  const normalized = normalizeProviderFinishReason(value);
  return [
    "length",
    "max_completion_tokens",
    "max_length",
    "max_output_tokens",
    "max_tokens",
    "token_limit",
  ].includes(normalized);
}

function normalizeProviderFinishReason(value: unknown) {
  return typeof value === "string"
    ? value.trim().toLowerCase().replace(/[\s-]+/g, "_")
    : "";
}

function createThinkingModePayload(input: OpenAiCompatibleProviderInput) {
  if (
    input.thinkingMode === "disabled"
    && (input.provider === "qwen" || input.provider === "dashscope")
  ) {
    return {
      enable_thinking: false,
    };
  }
  if (input.thinkingMode === "disabled" && input.provider === "deepseek") {
    return {
      thinking: {
        type: "disabled",
      },
    };
  }
  return {};
}

function resolveAgentMaxOutputTokens(
  configuredMaxTokens: number | undefined,
  request: AaisModelRequest,
) {
  const runtimeLimit = configuredMaxTokens ?? studentRuntimeMaxTokens;
  const agentLimit = request.voice?.maxOutputTokens;
  return agentLimit ? Math.min(runtimeLimit, agentLimit) : runtimeLimit;
}
