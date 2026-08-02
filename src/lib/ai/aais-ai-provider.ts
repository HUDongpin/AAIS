import type {
  AaisAgentId,
  AaisCaModule,
  AaisCognitiveApprenticeshipBackground,
  AaisPhase,
  Locale,
} from "@/data/aais";
import type { AaisGuideAttachment } from "@/lib/ai/aais-guide-attachments";
import {
  createDeterministicAaisAiRuntimeProfile,
  createManualAaisAiRuntimeProfile,
  readAaisAiRuntimeConfig,
  studentRuntimeDefaultMaxRetries,
  studentRuntimeDefaultTimeoutMs,
  studentRuntimeMaxTokens,
  type AaisAiRuntimeProfile,
  type AaisAiRuntimeProviderCandidate,
  type AaisAiRuntimeProviderName,
} from "@/lib/ai/aais-ai-runtime-config";
import { getAaisAiEvalApproval } from "@/lib/server/aais-ai-eval-manifest";

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
  caModules?: AaisCaModule[];
  caBackground?: AaisCognitiveApprenticeshipBackground;
  locale: Locale;
  phase: AaisPhase;
  taskId: string;
  learnerInput: string;
  workspaceState: AaisProviderWorkspaceState;
  fallbackText: string;
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

const guardrailPolicy = "aais-age-appropriate-output-v1" as const;

export function createConfiguredAaisModelProvider(): AaisModelProvider {
  const runtimeConfig = readAaisAiRuntimeConfig();
  if (runtimeConfig.primary && isLiveProviderApprovedForRuntime(runtimeConfig.primary.model)) {
    const fallbackApproved = runtimeConfig.fallback
      ? isLiveProviderApprovedForRuntime(runtimeConfig.fallback.model)
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
      const result = await generateWithOpenAiCompatibleCandidate({
        ...input,
        providerRole: "primary",
        runtimeProfile,
      }, request);
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
      const primaryResult = await generateWithOpenAiCompatibleCandidate(input.primary, request);
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
  const maxAttempts = Math.max(1, (input.maxRetries ?? studentRuntimeDefaultMaxRetries) + 1);
  let failureReason: AaisProviderFailureReason = "provider-error";

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      const text = await callOpenAiCompatibleProvider(input, request);
      const guardrail = evaluateAaisModelOutput(text);
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
            runtimeProfile: input.runtimeProfile,
          },
        };
      }
      return {
        ok: true,
        text,
        runtime: {
          provider: "openai-compatible",
          model: input.model,
          attempts: attempt,
          status: "ok",
          guardrail,
          redaction,
          runtimeProfile: input.runtimeProfile,
        },
      };
    } catch (error) {
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
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), input.timeoutMs ?? studentRuntimeDefaultTimeoutMs);
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
        max_tokens: input.maxTokens ?? studentRuntimeMaxTokens,
        ...createThinkingModePayload(input),
        messages: [
          {
            role: "system",
            content:
              "You are an AAIS Cognitive Apprenticeship learning agent. Keep replies concise, pedagogical, and age-appropriate. Never reveal secrets or internal runtime details.",
          },
          {
            role: "user",
            content: JSON.stringify({
              agentId: request.agentId,
              label: request.label,
              role: request.role,
              mission: request.mission,
              caModules: request.caModules,
              caBackground: request.caBackground,
              locale: request.locale,
              phase: request.phase,
              taskId: request.taskId,
              learnerInput: request.learnerInput,
              workspaceState: {
                currentStep: request.workspaceState.currentStep,
                artifactCharacters: request.workspaceState.artifactText?.length ?? 0,
                helpRequestsUsed: request.workspaceState.helpRequestsUsed ?? 0,
                attachments: request.workspaceState.attachments?.map((attachment) => ({
                  name: attachment.name,
                  mediaType: attachment.mediaType,
                  sizeBytes: attachment.sizeBytes,
                  extractedText: attachment.extractedText,
                })) ?? [],
              },
            }),
          },
        ],
      }),
      signal: controller.signal,
    });
    if (!response.ok) {
      throw createProviderError("http-status");
    }
    const body = (await response.json()) as {
      choices?: Array<{
        message?: {
          content?: string;
        };
      }>;
    };
    const content = body.choices?.[0]?.message?.content?.trim();
    if (!content) {
      throw createProviderError("empty-response");
    }
    return content;
  } finally {
    clearTimeout(timeout);
  }
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
    "provider-error",
  ].includes(String(value));
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

function isLiveProviderApprovedForRuntime(model: string) {
  return getAaisAiEvalApproval({
    required: isProductionRuntime(),
    provider: "openai-compatible",
    model,
  }).approved;
}

function evaluateAaisModelOutput(text: string): AaisModelRuntime["guardrail"] {
  const reasons: string[] = [];
  if (text.length > 1800) {
    reasons.push("too-long");
  }
  if (containsSecretLikeContent(text)) {
    reasons.push("secret-like-content");
  }
  return {
    policy: guardrailPolicy,
    status: reasons.length ? "blocked" : "passed",
    reasons,
  };
}

function containsSecretLikeContent(text: string) {
  return [
    /api[_-]?key\s*[:=]/i,
    /password\s*[:=]/i,
    /bearer\s+[A-Za-z0-9._-]{8,}/i,
    /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
  ].some((pattern) => pattern.test(text));
}

function isProductionRuntime() {
  return process.env.NODE_ENV === "production" || process.env.VERCEL_ENV === "production";
}
