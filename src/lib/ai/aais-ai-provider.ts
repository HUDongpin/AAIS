import type {
  AaisAgentId,
  AaisCaModule,
  AaisCognitiveApprenticeshipBackground,
  AaisPhase,
  Locale,
} from "@/data/aais";
import type { AaisGuideAttachment } from "@/lib/ai/aais-guide-attachments";
import type { AaisFunctionScaffoldPlan } from "@/lib/ai/aais-guide-function-scaffold";
import {
  aaisAiGuardrailPolicy,
  createAaisAgentProviderMessages,
  evaluateAaisModelOutput,
  getAaisAiObservedSnapshotSha256,
  isAaisImmutableQwenSnapshotModel,
} from "@/lib/ai/aais-ai-source-contract";
import type { AaisGuideConversationMessage } from "@/lib/ai/orchestration/aais-learning-guide-graph";
import {
  createDeterministicAaisAiRuntimeProfile,
  createManualAaisAiRuntimeProfile,
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
import { getAaisAiEvalApproval } from "@/lib/server/aais-ai-eval-manifest";
import { readAaisBoundedResponseJson } from "@/lib/server/aais-bounded-response";

type AaisProviderWorkspaceState = {
  currentStep: string;
  artifactText?: string;
  helpRequestsUsed?: number;
  attachments?: AaisGuideAttachment[];
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
  scaffoldPlan?: AaisFunctionScaffoldPlan;
  workspaceState: AaisProviderWorkspaceState;
  fallbackText: string;
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
  observation?: {
    model: "matched";
    kind: "exact-provider-model-id";
    snapshotSha256: string;
  };
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

export type OpenAiCompatibleProviderInput = {
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
  requireObservedModel?: boolean;
};

type OpenAiCompatibleProviderCandidate = OpenAiCompatibleProviderInput & {
  providerRole: "primary" | "fallback";
  runtimeProfile?: AaisAiRuntimeProfile;
};

type OpenAiCompatibleProviderChainInput = {
  primary: OpenAiCompatibleProviderCandidate;
  fallback?: OpenAiCompatibleProviderCandidate;
};

type AaisProviderFailureReason =
  | "abort-timeout"
  | "connect-timeout"
  | "empty-response"
  | "http-status"
  | "model-mismatch"
  | "model-missing"
  | "truncated-response"
  | "provider-error";

type AaisProviderFailure = {
  reason: AaisProviderFailureReason;
  attempts: number;
};

type AaisProviderChainFailure = {
  provider: "primary" | "fallback";
  reason: AaisProviderFailureReason;
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

export function createConfiguredAaisModelProvider(): AaisModelProvider {
  const runtimeConfig = readAaisAiRuntimeConfig();
  if (runtimeConfig.configurationStatus.primary === "invalid"
    || runtimeConfig.configurationStatus.fallback === "invalid") {
    return createDeterministicAaisProvider();
  }
  if (runtimeConfig.primary && isLiveProviderApprovedForRuntime(runtimeConfig.primary)) {
    const fallbackApproved = runtimeConfig.fallback
      ? isLiveProviderApprovedForRuntime(runtimeConfig.fallback)
      : false;
    const runtimeProfile = runtimeConfig.fallback && !fallbackApproved
      ? {
          ...runtimeConfig.profile,
          fallback: null,
        }
      : runtimeConfig.profile;
    if (runtimeConfig.fallback && fallbackApproved) {
      return createOpenAiCompatibleAaisProviderChain({
        primary: toOpenAiCompatibleCandidate(runtimeConfig.primary, runtimeProfile),
        fallback: toOpenAiCompatibleCandidate(runtimeConfig.fallback, runtimeProfile),
      });
    }
    return createOpenAiCompatibleAaisProvider(
      toOpenAiCompatibleCandidate(runtimeConfig.primary, runtimeProfile),
    );
  }
  return createDeterministicAaisProvider(runtimeConfig.profile);
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
          runtimeProfile,
        },
      };
    },
  };
}

export function createOpenAiCompatibleAaisProvider(
  input: OpenAiCompatibleProviderInput,
): AaisModelProvider {
  const runtimeProfile = input.runtimeProfile ?? createManualAaisAiRuntimeProfile(input);
  return {
    async generate(request) {
      throwIfAaisRequestAborted(request);
      const result = await generateWithOpenAiCompatibleCandidate({
        ...input,
        providerRole: "primary",
        runtimeProfile,
      }, request);
      throwIfAaisRequestAborted(request);
      if (result.ok) {
        return result;
      }
      return {
        text: request.fallbackText,
        runtime: {
          provider: "openai-compatible",
          model: input.model,
          attempts: result.failure.attempts,
          status: "fallback",
          guardrail: {
            policy: guardrailPolicy,
            status: "not-applicable",
            reasons: [result.failure.reason],
          },
          redaction,
          runtimeProfile,
        },
      };
    },
  };
}

function createOpenAiCompatibleAaisProviderChain(
  input: OpenAiCompatibleProviderChainInput,
): AaisModelProvider {
  return {
    async generate(request) {
      throwIfAaisRequestAborted(request);
      const primaryResult = await generateWithOpenAiCompatibleCandidate(input.primary, request);
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
        {
          provider: "primary",
          reason: primaryResult.failure.reason,
        },
      ];

      if (input.fallback) {
        const fallbackResult = await generateWithOpenAiCompatibleCandidate(input.fallback, request);
        throwIfAaisRequestAborted(request);
        if (fallbackResult.ok) {
          return {
            text: fallbackResult.text,
            runtime: {
              ...fallbackResult.runtime,
              attempts: primaryResult.failure.attempts + fallbackResult.runtime.attempts,
              providerChain: {
                selected: "fallback",
                fallbackUsed: true,
                failures,
              },
            },
          };
        }
        failures.push({
          provider: "fallback",
          reason: fallbackResult.failure.reason,
        });
        return createDeterministicChainFallback({
          request,
          model: input.fallback.model,
          runtimeProfile: input.fallback.runtimeProfile,
          attempts: primaryResult.failure.attempts + fallbackResult.failure.attempts,
          failures,
        });
      }

      return createDeterministicChainFallback({
        request,
        model: input.primary.model,
        runtimeProfile: input.primary.runtimeProfile,
        attempts: primaryResult.failure.attempts,
        failures,
      });
    },
  };
}

async function generateWithOpenAiCompatibleCandidate(
  input: OpenAiCompatibleProviderCandidate,
  request: AaisModelRequest,
): Promise<AaisProviderAttemptResult> {
  const boundedRetries = normalizeAaisAiMaxRetries(
    input.maxRetries ?? studentRuntimeDefaultMaxRetries,
  );
  const maxAttempts = boundedRetries + 1;
  let failureReason: AaisProviderFailureReason = "provider-error";

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    throwIfAaisRequestAborted(request);
    try {
      const providerResponse = await callOpenAiCompatibleProvider(input, request);
      throwIfAaisRequestAborted(request);
      const guardrail = evaluateAaisModelOutput(providerResponse.text, request);
      if (guardrail.status === "blocked") {
        return {
          ok: true,
          text: request.fallbackText,
          runtime: {
            provider: "openai-compatible",
            model: input.model,
            attempts: attempt,
            status: "fallback",
            guardrail,
            redaction,
            observation: providerResponse.observation,
            runtimeProfile: input.runtimeProfile,
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
          observation: providerResponse.observation,
          runtimeProfile: input.runtimeProfile,
        },
      };
    } catch (error) {
      throwIfAaisRequestAborted(request);
      failureReason = classifyProviderError(error);
      if (attempt === maxAttempts) {
        break;
      }
    }
  }

  return {
    ok: false,
    failure: {
      reason: failureReason,
      attempts: maxAttempts,
    },
  };
}

function createDeterministicChainFallback(input: {
  request: AaisModelRequest;
  model: string;
  runtimeProfile?: AaisAiRuntimeProfile;
  attempts: number;
  failures: Array<{
    provider: "primary" | "fallback";
    reason: AaisProviderFailureReason;
  }>;
}): AaisModelResponse {
  return {
    text: input.request.fallbackText,
    runtime: {
      provider: "openai-compatible",
      model: input.model,
      attempts: input.attempts,
      status: "fallback",
      guardrail: {
        policy: guardrailPolicy,
        status: "not-applicable",
        reasons: input.failures.map((failure) => failure.reason),
      },
      redaction,
      runtimeProfile: input.runtimeProfile,
      providerChain: {
        selected: "deterministic",
        fallbackUsed: input.failures.some((failure) => failure.provider === "fallback"),
        failures: input.failures,
      },
    },
  };
}

async function callOpenAiCompatibleProvider(
  input: OpenAiCompatibleProviderInput,
  request: AaisModelRequest,
) {
  throwIfAaisRequestAborted(request);
  if (!isAaisAiProviderEndpointAllowed(input.endpoint)) {
    throw createProviderError("provider-error");
  }
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), input.timeoutMs ?? studentRuntimeDefaultTimeoutMs);
  const abortFromRequest = () => controller.abort(request.signal?.reason);
  request.signal?.addEventListener("abort", abortFromRequest, { once: true });
  try {
    const response = await (input.fetchImpl ?? fetch)(input.endpoint, {
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
    throwIfAaisRequestAborted(request);
    if (!response.ok) {
      throw createProviderError("http-status");
    }
    const body = (await readAaisBoundedResponseJson(
      response,
      AAIS_AI_PROVIDER_RESPONSE_MAX_BYTES,
      "AAIS AI provider response is too large.",
    )) as {
      model?: unknown;
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
    const finishReason = choice?.finish_reason ?? choice?.finishReason ?? choice?.stop_reason;
    if (isTruncatedProviderFinishReason(finishReason)) {
      throw createProviderError("truncated-response");
    }
    const content = choice?.message?.content?.trim();
    if (!content) {
      throw createProviderError("empty-response");
    }
    const observedModel = typeof body.model === "string" ? body.model.trim() : "";
    const requiresExactObservation = input.requireObservedModel === true
      || isAaisImmutableQwenSnapshotModel(input.model);
    if (requiresExactObservation && !observedModel) {
      throw createProviderError("model-missing");
    }
    if (requiresExactObservation && observedModel !== input.model) {
      throw createProviderError("model-mismatch");
    }
    return {
      text: content,
      ...(observedModel === input.model && isAaisImmutableQwenSnapshotModel(input.model)
        ? {
            observation: {
              model: "matched" as const,
              kind: "exact-provider-model-id" as const,
              snapshotSha256: getAaisAiObservedSnapshotSha256(observedModel),
            },
          }
        : {}),
    };
  } finally {
    clearTimeout(timeout);
    request.signal?.removeEventListener("abort", abortFromRequest);
  }
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
): OpenAiCompatibleProviderCandidate {
  return {
    endpoint: candidate.endpoint,
    apiKey: candidate.apiKey,
    model: candidate.model,
    provider: candidate.profile.provider,
    thinkingMode: candidate.thinkingMode,
    timeoutMs: candidate.timeoutMs,
    maxRetries: candidate.maxRetries,
    maxTokens: candidate.maxTokens,
    providerRole: candidate.providerRole,
    runtimeProfile,
  };
}

function createProviderError(reason: AaisProviderFailureReason) {
  return Object.assign(new Error(reason), {
    reason,
  });
}

function classifyProviderError(error: unknown): AaisProviderFailureReason {
  const errorWithReason = error as {
    reason?: unknown;
    name?: unknown;
    message?: unknown;
    cause?: {
      code?: unknown;
      name?: unknown;
      message?: unknown;
    };
  };
  if (isProviderFailureReason(errorWithReason.reason)) {
    return errorWithReason.reason;
  }
  const name = String(errorWithReason.name ?? "");
  if (name === "AbortError") {
    return "abort-timeout";
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
    return "connect-timeout";
  }
  return "provider-error";
}

function isProviderFailureReason(value: unknown): value is AaisProviderFailureReason {
  return [
    "abort-timeout",
    "connect-timeout",
    "empty-response",
    "http-status",
    "model-mismatch",
    "model-missing",
    "truncated-response",
    "provider-error",
  ].includes(String(value));
}

function isTruncatedProviderFinishReason(value: unknown) {
  if (typeof value !== "string") {
    return false;
  }
  const normalized = value.trim().toLowerCase().replace(/[\s-]+/g, "_");
  return [
    "length",
    "max_completion_tokens",
    "max_length",
    "max_output_tokens",
    "max_tokens",
    "token_limit",
  ].includes(normalized);
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
  return {};
}

function isLiveProviderApprovedForRuntime(candidate: AaisAiRuntimeProviderCandidate) {
  return getAaisAiEvalApproval({
    required: isProductionRuntime(),
    provider: "openai-compatible",
    model: candidate.model,
    providerRole: candidate.providerRole,
    runtime: {
      endpoint: candidate.endpoint,
      thinkingMode: candidate.profile.thinkingMode,
      maxTokens: candidate.maxTokens,
      maxRetries: candidate.maxRetries,
    },
  }).approved;
}

function resolveAgentMaxOutputTokens(
  configuredMaxTokens: number | undefined,
  request: AaisModelRequest,
) {
  const runtimeLimit = configuredMaxTokens ?? studentRuntimeMaxTokens;
  const agentLimit = request.voice?.maxOutputTokens;
  return agentLimit ? Math.min(runtimeLimit, agentLimit) : runtimeLimit;
}

function isProductionRuntime() {
  return process.env.NODE_ENV === "production" || process.env.VERCEL_ENV === "production";
}
