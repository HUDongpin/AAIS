import { createHash } from "node:crypto";
import type { AaisGuideDeliveryPolicy } from "@/lib/ai/aais-guide-delivery";

export type AaisAiRuntimeThinkingMode = "disabled" | "provider-default";

export type AaisAiRuntimeProviderName = "openai-compatible" | "qwen" | "dashscope" | "deepseek";

export type AaisAiRuntimeTimeout = {
  configured: number | null;
  effective: number;
  default: number;
  min: number;
  max: number;
  clamped: boolean;
  source: string | null;
};

export type AaisAiRuntimeProviderProfile = {
  providerRole: "primary" | "fallback";
  provider: AaisAiRuntimeProviderName;
  modelFingerprint: string;
  thinkingMode: AaisAiRuntimeThinkingMode;
  thinkingModeSource: string;
  timeoutMs: AaisAiRuntimeTimeout;
  maxRetries: number;
  maxTokens: number;
};

export type AaisAiRuntimeProfile = {
  mode: "deterministic" | "live";
  deliveryPolicy: AaisGuideDeliveryPolicy;
  primary: AaisAiRuntimeProviderProfile | null;
  fallback: AaisAiRuntimeProviderProfile | null;
  redaction: {
    secrets: "omitted";
    endpoints: "omitted";
    modelIds: "fingerprint-only";
  };
};

export type AaisAiRuntimeProviderCandidate = {
  endpoint: string;
  apiKey: string;
  model: string;
  expectedObservedRevisionSha256?: string;
  thinkingMode?: "disabled";
  timeoutMs: number;
  maxRetries: number;
  maxTokens: number;
  providerRole: "primary" | "fallback";
  profile: AaisAiRuntimeProviderProfile;
};

export type AaisAiRuntimeConfig = {
  deliveryPolicy: AaisGuideDeliveryPolicy;
  profile: AaisAiRuntimeProfile;
  primary: AaisAiRuntimeProviderCandidate | null;
  fallback: AaisAiRuntimeProviderCandidate | null;
  configurationStatus: {
    runtimeMode: "valid" | "invalid";
    primary: "valid" | "missing" | "invalid";
    fallback: "valid" | "missing" | "invalid";
  };
};

export const qwenDashScopeEndpoint = "https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions";
export const deepSeekChatCompletionsEndpoint = "https://api.deepseek.com/chat/completions";
export const qwenDefaultModel = "qwen3.8-max";
export const deepSeekRequiredModel = "deepseek-v4-flash";
export const studentRuntimeDefaultTimeoutMs = 12_000;
export const studentRuntimeMinTimeoutMs = 3_000;
export const studentRuntimeMaxTimeoutMs = 30_000;
export const studentRuntimeDefaultMaxRetries = 1;
export const studentRuntimeMaxRetries = 3;
export const studentRuntimeMaxTokens = 600;

export function normalizeAaisAiMaxRetries(value: number | undefined) {
  const parsed = typeof value === "number" && Number.isFinite(value)
    ? Math.trunc(value)
    : studentRuntimeDefaultMaxRetries;
  return clamp(parsed, 0, studentRuntimeMaxRetries);
}

const redactedRuntimeProfile = {
  secrets: "omitted",
  endpoints: "omitted",
  modelIds: "fingerprint-only",
} as const;

export function readAaisAiRuntimeConfig(env: NodeJS.ProcessEnv = process.env): AaisAiRuntimeConfig {
  const configurationStatus = getAaisAiRuntimeConfigurationStatus(env);
  const deliveryPolicy = readAaisGuideDeliveryPolicy(env);
  const primary = configurationStatus.primary === "valid"
    ? readConfiguredPrimaryProvider(env)
    : null;
  const fallback = configurationStatus.fallback === "valid"
    ? readConfiguredFallbackProvider(env)
    : null;
  return {
    deliveryPolicy,
    profile: {
      mode: primary || fallback ? "live" : "deterministic",
      deliveryPolicy,
      primary: primary?.profile ?? null,
      fallback: fallback?.profile ?? null,
      redaction: redactedRuntimeProfile,
    },
    primary,
    fallback,
    configurationStatus,
  };
}

export function getAaisAiRuntimeConfigurationStatus(
  env: NodeJS.ProcessEnv = process.env,
): AaisAiRuntimeConfig["configurationStatus"] {
  const production = isProductionEnvironment(env);
  const runtimeMode = getAaisGuideDeliveryPolicyConfigurationStatus(env);
  const provider = env.AAIS_AI_PROVIDER?.trim().toLowerCase();
  const explicitEndpoint = env.AAIS_AI_ENDPOINT?.trim();
  const explicitApiKey = env.AAIS_AI_API_KEY?.trim();
  const explicitModel = env.AAIS_AI_MODEL?.trim();
  const explicitThinkingMode = env.AAIS_AI_THINKING_MODE?.trim().toLowerCase();
  const explicitTimeoutMs = env.AAIS_AI_TIMEOUT_MS?.trim();
  const explicitMaxRetries = env.AAIS_AI_MAX_RETRIES?.trim();
  const expectedPrimaryRevisionSha256 = env.AAIS_AI_OBSERVED_REVISION_SHA256?.trim();
  const qwenApiKey = env.DASHSCOPE_API_KEY?.trim() || env.QWEN_API_KEY?.trim();
  const qwenEndpointOverride = env.DASHSCOPE_OPENAI_ENDPOINT?.trim()
    || env.QWEN_API_ENDPOINT?.trim()
    || env.DASHSCOPE_BASE_URL?.trim()
    || env.QWEN_BASE_URL?.trim();
  const qwenModelOverride = env.DASHSCOPE_MODEL?.trim() || env.QWEN_MODEL?.trim();
  const qwenMode = provider === "qwen" || provider === "dashscope";
  const deepSeekMode = provider === "deepseek";
  const openAiCompatibleMode = provider === "openai-compatible";
  const qwenAliasMode = !provider && Boolean(qwenApiKey);
  const primaryFieldsPresent = Boolean(
    provider
      || explicitEndpoint
      || explicitApiKey
      || explicitModel
      || explicitThinkingMode
      || explicitTimeoutMs
      || explicitMaxRetries
      || qwenApiKey
      || qwenEndpointOverride
      || qwenModelOverride
      || expectedPrimaryRevisionSha256,
  );

  let primary: "valid" | "missing" | "invalid" = "missing";
  if (primaryFieldsPresent) {
    if (production) {
      const apiKey = explicitApiKey || qwenApiKey;
      primary = provider === "qwen"
        && explicitModel === qwenDefaultModel
        && Boolean(explicitEndpoint)
        && Boolean(apiKey)
        && explicitThinkingMode === "disabled"
        && isProductionProviderTimeout(explicitTimeoutMs)
        && explicitMaxRetries === "0"
        && isSha256Hex(expectedPrimaryRevisionSha256)
        && isAaisAiProviderEndpointAllowed(explicitEndpoint!, env, {
          provider: "qwen",
          providerRole: "primary",
        })
        ? "valid"
        : "invalid";
    } else if (provider && !openAiCompatibleMode && !qwenMode && !deepSeekMode) {
      primary = "invalid";
    } else {
      const useQwenDefaults = qwenMode
        || qwenAliasMode
        || (!deepSeekMode && Boolean(!explicitApiKey && qwenApiKey));
      const endpoint = explicitEndpoint || (useQwenDefaults ? readQwenEndpoint(env) : undefined);
      const apiKey = explicitApiKey || qwenApiKey;
      const model = explicitModel || (useQwenDefaults ? readQwenModel(env) : undefined);
      primary = endpoint
        && apiKey
        && model
        && (!expectedPrimaryRevisionSha256 || isSha256Hex(expectedPrimaryRevisionSha256))
        && isAaisAiProviderEndpointAllowed(endpoint, env)
        ? "valid"
        : "invalid";
    }
  }

  const fallbackEndpoint = env.AAIS_AI_FALLBACK_ENDPOINT?.trim();
  const fallbackApiKey = env.AAIS_AI_FALLBACK_API_KEY?.trim();
  const fallbackModel = env.AAIS_AI_FALLBACK_MODEL?.trim();
  const fallbackProvider = env.AAIS_AI_FALLBACK_PROVIDER?.trim().toLowerCase();
  const fallbackEnabledValue = env.AAIS_AI_FALLBACK_ENABLED?.trim().toLowerCase();
  const fallbackThinking = readFallbackThinkingConfiguration(env);
  const fallbackThinkingMode = fallbackThinking.value;
  const fallbackTimeoutMs = env.AAIS_AI_FALLBACK_TIMEOUT_MS?.trim();
  const fallbackMaxRetries = env.AAIS_AI_FALLBACK_MAX_RETRIES?.trim();
  const expectedFallbackRevisionSha256 = env.AAIS_AI_FALLBACK_OBSERVED_REVISION_SHA256?.trim();
  const fallbackProviderValid = !fallbackProvider
    || fallbackProvider === "deepseek"
    || fallbackProvider === "openai-compatible";
  const fallbackContractFieldsPresent = Boolean(
    fallbackEndpoint
      || fallbackApiKey
      || fallbackModel
      || fallbackProvider
      || fallbackThinking.present
      || fallbackTimeoutMs
      || fallbackMaxRetries
      || expectedFallbackRevisionSha256,
  );
  const fallbackFieldsPresent = Boolean(fallbackEnabledValue || fallbackContractFieldsPresent);
  const fallback = !fallbackFieldsPresent
    || (fallbackEnabledValue === "false" && !fallbackContractFieldsPresent)
    ? "missing" as const
    : production
      ? fallbackEnabledValue === "true"
        && fallbackProvider === "deepseek"
        && fallbackThinkingMode === "disabled"
        && isProductionProviderTimeout(fallbackTimeoutMs)
        && fallbackMaxRetries === "0"
        && Boolean(fallbackEndpoint)
        && Boolean(fallbackApiKey)
        && Boolean(fallbackModel)
        && fallbackModel === deepSeekRequiredModel
        && isSha256Hex(expectedFallbackRevisionSha256)
        && isAaisAiProviderEndpointAllowed(fallbackEndpoint!, env, {
          provider: "deepseek",
          providerRole: "fallback",
        })
        ? "valid" as const
        : "invalid" as const
      : fallbackEndpoint
        && fallbackApiKey
        && fallbackModel
        && fallbackProviderValid
        && (!expectedFallbackRevisionSha256 || isSha256Hex(expectedFallbackRevisionSha256))
        && isAaisAiProviderEndpointAllowed(fallbackEndpoint, env)
        ? "valid" as const
        : "invalid" as const;

  return { runtimeMode, primary, fallback };
}

/**
 * Production always requires live learner-visible AI. Non-production keeps the
 * deterministic provider available for local development, tests, and the
 * background-only A3/A4 graph nodes unless live-required is explicitly set.
 * The environment spelling is intentionally distinct from the internal
 * delivery-policy contract: `AAIS_AI_RUNTIME_MODE=live-required` maps to
 * `require-live`.
 */
export function readAaisGuideDeliveryPolicy(
  env: NodeJS.ProcessEnv = process.env,
): AaisGuideDeliveryPolicy {
  if (isProductionEnvironment(env)) {
    return "require-live";
  }
  return env.AAIS_AI_RUNTIME_MODE?.trim().toLowerCase() === "live-required"
    ? "require-live"
    : "allow-deterministic";
}

export function getAaisGuideDeliveryPolicyConfigurationStatus(
  env: NodeJS.ProcessEnv = process.env,
): "valid" | "invalid" {
  const configured = env.AAIS_AI_RUNTIME_MODE?.trim().toLowerCase();
  if (configured && configured !== "live-required" && configured !== "allow-deterministic") {
    return "invalid";
  }
  if (isProductionEnvironment(env)) {
    return configured === "live-required" ? "valid" : "invalid";
  }
  return "valid";
}

type AaisAiProviderEndpointBinding = {
  provider: AaisAiRuntimeProviderName;
  providerRole: "primary" | "fallback";
};

export function isAaisAiProviderEndpointAllowed(
  endpoint: string,
  env: Partial<Pick<NodeJS.ProcessEnv, "NODE_ENV" | "VERCEL_ENV">> = process.env,
  binding?: AaisAiProviderEndpointBinding,
) {
  let parsed: URL;
  try {
    parsed = new URL(endpoint);
  } catch {
    return false;
  }
  if (parsed.username
    || parsed.password
    || parsed.search
    || parsed.hash
    || endpoint.includes("?")
    || endpoint.includes("#")) {
    return false;
  }
  const production = env.NODE_ENV === "production" || env.VERCEL_ENV === "production";
  if (production) {
    if (!binding) {
      return endpoint === qwenDashScopeEndpoint
        || endpoint === deepSeekChatCompletionsEndpoint;
    }
    if (binding.providerRole === "primary") {
      return (binding.provider === "qwen" || binding.provider === "dashscope")
        && endpoint === qwenDashScopeEndpoint;
    }
    return binding.provider === "deepseek"
      && endpoint === deepSeekChatCompletionsEndpoint;
  }
  if (parsed.protocol === "https:") {
    return true;
  }
  return !production
    && parsed.protocol === "http:"
    && isLoopbackHostname(parsed.hostname);
}

export function createDeterministicAaisAiRuntimeProfile(
  deliveryPolicy: AaisGuideDeliveryPolicy = "allow-deterministic",
): AaisAiRuntimeProfile {
  return {
    mode: "deterministic",
    deliveryPolicy,
    primary: null,
    fallback: null,
    redaction: redactedRuntimeProfile,
  };
}

export function createManualAaisAiRuntimeProfile(input: {
  provider?: AaisAiRuntimeProviderName;
  model: string;
  thinkingMode?: "disabled";
  timeoutMs?: number;
  maxRetries?: number;
  maxTokens?: number;
  deliveryPolicy?: AaisGuideDeliveryPolicy;
}): AaisAiRuntimeProfile {
  const timeoutMs = createTimeoutSummary({
    rawValue: input.timeoutMs ? String(input.timeoutMs) : undefined,
    source: input.timeoutMs ? "manual" : null,
  });
  return {
    mode: "live",
    deliveryPolicy: input.deliveryPolicy ?? "allow-deterministic",
    primary: {
      providerRole: "primary",
      provider: input.provider ?? "openai-compatible",
      modelFingerprint: getAaisAiModelFingerprint(input.model),
      thinkingMode: input.thinkingMode === "disabled" ? "disabled" : "provider-default",
      thinkingModeSource: input.thinkingMode === "disabled" ? "manual" : "default",
      timeoutMs,
      maxRetries: normalizeAaisAiMaxRetries(input.maxRetries),
      maxTokens: input.maxTokens ?? studentRuntimeMaxTokens,
    },
    fallback: null,
    redaction: redactedRuntimeProfile,
  };
}

export function getAaisAiModelFingerprint(model: string) {
  return createHash("sha256")
    .update(`aais-ai-model:${model}`)
    .digest("hex")
    .slice(0, 16);
}

export function getAaisAiObservedRevisionSha256(observedRevision: string) {
  return createHash("sha256")
    .update(`aais-ai-observed-revision-v1:${observedRevision}`)
    .digest("hex");
}

function readConfiguredPrimaryProvider(env: NodeJS.ProcessEnv): AaisAiRuntimeProviderCandidate | null {
  const production = isProductionEnvironment(env);
  const provider = env.AAIS_AI_PROVIDER?.trim().toLowerCase();
  const explicitEndpoint = env.AAIS_AI_ENDPOINT?.trim();
  const explicitApiKey = env.AAIS_AI_API_KEY?.trim();
  const explicitModel = env.AAIS_AI_MODEL?.trim();
  const expectedObservedRevisionSha256 = env.AAIS_AI_OBSERVED_REVISION_SHA256?.trim();
  const qwenApiKey = env.DASHSCOPE_API_KEY?.trim() || env.QWEN_API_KEY?.trim();
  const qwenMode = provider === "qwen" || provider === "dashscope";
  const deepSeekMode = provider === "deepseek";
  const openAiCompatibleMode = provider === "openai-compatible";
  const qwenAliasMode = !provider && Boolean(qwenApiKey);
  const explicitOpenAiConfig = Boolean(explicitEndpoint && explicitApiKey && explicitModel);

  if (provider && !openAiCompatibleMode && !qwenMode && !deepSeekMode) {
    return null;
  }
  if (!openAiCompatibleMode && !qwenMode && !qwenAliasMode && !explicitOpenAiConfig) {
    return null;
  }

  const useQwenDefaults = qwenMode
    || qwenAliasMode
    || (!deepSeekMode && Boolean(!explicitApiKey && qwenApiKey));
  const endpoint = explicitEndpoint || (useQwenDefaults ? readQwenEndpoint(env) : undefined);
  const apiKey = explicitApiKey || qwenApiKey;
  const model = explicitModel
    || (!production && useQwenDefaults ? readQwenModel(env) : undefined);
  if (!endpoint || !apiKey || !model) {
    return null;
  }

  const providerName: AaisAiRuntimeProviderName = qwenMode
    ? provider === "dashscope" ? "dashscope" : "qwen"
    : deepSeekMode
      ? "deepseek"
      : useQwenDefaults
        ? "qwen"
        : "openai-compatible";
  return applyProductionSingleAttemptPolicy(createProviderCandidate({
    endpoint,
    apiKey,
    model,
    expectedObservedRevisionSha256,
    providerRole: "primary",
    provider: providerName,
    thinkingModeValue: env.AAIS_AI_THINKING_MODE,
    thinkingModeSourceName: "AAIS_AI_THINKING_MODE",
    timeoutValue: env.AAIS_AI_TIMEOUT_MS,
    timeoutSourceName: "AAIS_AI_TIMEOUT_MS",
    maxRetriesValue: env.AAIS_AI_MAX_RETRIES,
  }), env);
}

function readConfiguredFallbackProvider(env: NodeJS.ProcessEnv): AaisAiRuntimeProviderCandidate | null {
  const endpoint = env.AAIS_AI_FALLBACK_ENDPOINT?.trim();
  const apiKey = env.AAIS_AI_FALLBACK_API_KEY?.trim();
  const model = env.AAIS_AI_FALLBACK_MODEL?.trim();
  const configuredProvider = env.AAIS_AI_FALLBACK_PROVIDER?.trim().toLowerCase();
  const expectedObservedRevisionSha256 = env.AAIS_AI_FALLBACK_OBSERVED_REVISION_SHA256?.trim();
  if (!endpoint || !apiKey || !model) {
    return null;
  }
  const provider: AaisAiRuntimeProviderName = configuredProvider === "deepseek"
    ? "deepseek"
    : "openai-compatible";
  const fallbackThinking = readFallbackThinkingConfiguration(env);
  return applyProductionSingleAttemptPolicy(createProviderCandidate({
    endpoint,
    apiKey,
    model,
    expectedObservedRevisionSha256,
    providerRole: "fallback",
    provider,
    thinkingModeValue: fallbackThinking.value,
    thinkingModeSourceName: fallbackThinking.sourceName,
    timeoutValue: env.AAIS_AI_FALLBACK_TIMEOUT_MS ?? env.AAIS_AI_TIMEOUT_MS,
    timeoutSourceName: env.AAIS_AI_FALLBACK_TIMEOUT_MS ? "AAIS_AI_FALLBACK_TIMEOUT_MS" : "AAIS_AI_TIMEOUT_MS",
    maxRetriesValue: env.AAIS_AI_FALLBACK_MAX_RETRIES ?? env.AAIS_AI_MAX_RETRIES,
  }), env);
}

function readFallbackThinkingConfiguration(env: NodeJS.ProcessEnv) {
  const explicitMode = env.AAIS_AI_FALLBACK_THINKING_MODE?.trim().toLowerCase() || undefined;
  const compatibleBoolean = env.AAIS_AI_FALLBACK_THINKING?.trim().toLowerCase() || undefined;
  const compatibleMode = compatibleBoolean === "false"
    ? "disabled"
    : compatibleBoolean === "true"
      ? "provider-default"
      : compatibleBoolean
        ? "invalid"
        : undefined;
  return {
    present: Boolean(explicitMode || compatibleBoolean),
    value: explicitMode && compatibleMode && explicitMode !== compatibleMode
      ? "invalid"
      : explicitMode ?? compatibleMode,
    sourceName: explicitMode
      ? "AAIS_AI_FALLBACK_THINKING_MODE"
      : "AAIS_AI_FALLBACK_THINKING",
  } as const;
}

function applyProductionSingleAttemptPolicy(
  candidate: AaisAiRuntimeProviderCandidate,
  env: NodeJS.ProcessEnv,
): AaisAiRuntimeProviderCandidate {
  if (!isProductionEnvironment(env)) {
    return candidate;
  }
  return {
    ...candidate,
    maxRetries: 0,
    profile: {
      ...candidate.profile,
      maxRetries: 0,
    },
  };
}

function createProviderCandidate(input: {
  endpoint: string;
  apiKey: string;
  model: string;
  expectedObservedRevisionSha256?: string;
  providerRole: "primary" | "fallback";
  provider: AaisAiRuntimeProviderName;
  thinkingModeValue: string | undefined;
  thinkingModeSourceName: string;
  timeoutValue: string | undefined;
  timeoutSourceName: string;
  maxRetriesValue: string | undefined;
}): AaisAiRuntimeProviderCandidate {
  const thinking = readThinkingMode({
    value: input.thinkingModeValue,
    sourceName: input.thinkingModeSourceName,
    provider: input.provider,
  });
  const timeoutMs = createTimeoutSummary({
    rawValue: input.timeoutValue,
    source: input.timeoutValue ? input.timeoutSourceName : null,
  });
  const maxRetries = normalizeAaisAiMaxRetries(
    readNonNegativeInteger(input.maxRetriesValue, studentRuntimeDefaultMaxRetries),
  );
  const profile: AaisAiRuntimeProviderProfile = {
    providerRole: input.providerRole,
    provider: input.provider,
    modelFingerprint: getAaisAiModelFingerprint(input.model),
    thinkingMode: thinking.mode,
    thinkingModeSource: thinking.source,
    timeoutMs,
    maxRetries,
    maxTokens: studentRuntimeMaxTokens,
  };
  return {
    endpoint: input.endpoint,
    apiKey: input.apiKey,
    model: input.model,
    ...(input.expectedObservedRevisionSha256
      ? { expectedObservedRevisionSha256: input.expectedObservedRevisionSha256 }
      : {}),
    ...(thinking.mode === "disabled" ? { thinkingMode: "disabled" as const } : {}),
    timeoutMs: timeoutMs.effective,
    maxRetries,
    maxTokens: studentRuntimeMaxTokens,
    providerRole: input.providerRole,
    profile,
  };
}

function readQwenEndpoint(env: NodeJS.ProcessEnv) {
  return normalizeQwenEndpoint(
    env.DASHSCOPE_OPENAI_ENDPOINT
      ?? env.QWEN_API_ENDPOINT
      ?? env.DASHSCOPE_BASE_URL
      ?? env.QWEN_BASE_URL
      ?? qwenDashScopeEndpoint,
  );
}

function readQwenModel(env: NodeJS.ProcessEnv) {
  return env.AAIS_AI_MODEL?.trim()
    || env.DASHSCOPE_MODEL?.trim()
    || env.QWEN_MODEL?.trim()
    || qwenDefaultModel;
}

function normalizeQwenEndpoint(value: string) {
  const endpoint = value.trim().replace(/\/+$/, "");
  if (!endpoint) {
    return qwenDashScopeEndpoint;
  }
  if (/\/chat\/completions$/i.test(endpoint)) {
    return endpoint;
  }
  if (/\/compatible-mode\/v1$/i.test(endpoint) || /\/v1$/i.test(endpoint)) {
    return `${endpoint}/chat/completions`;
  }
  return `${endpoint}/compatible-mode/v1/chat/completions`;
}

function readThinkingMode(input: {
  value: string | undefined;
  sourceName: string;
  provider: AaisAiRuntimeProviderName;
}) {
  const normalized = input.value?.trim().toLowerCase();
  if (normalized === "disabled") {
    return {
      mode: "disabled" as const,
      source: input.sourceName,
    };
  }
  if (normalized === "provider-default" || normalized === "default") {
    return {
      mode: "provider-default" as const,
      source: input.sourceName,
    };
  }
  if (
    input.provider === "qwen"
    || input.provider === "dashscope"
    || input.provider === "deepseek"
  ) {
    return {
      mode: "disabled" as const,
      source: "provider-profile-default",
    };
  }
  return {
    mode: "provider-default" as const,
    source: "default",
  };
}

function createTimeoutSummary(input: {
  rawValue: string | undefined;
  source: string | null;
}): AaisAiRuntimeTimeout {
  const configured = readPositiveIntegerOrNull(input.rawValue);
  const requested = configured ?? studentRuntimeDefaultTimeoutMs;
  const effective = clamp(requested, studentRuntimeMinTimeoutMs, studentRuntimeMaxTimeoutMs);
  return {
    configured,
    effective,
    default: studentRuntimeDefaultTimeoutMs,
    min: studentRuntimeMinTimeoutMs,
    max: studentRuntimeMaxTimeoutMs,
    clamped: configured !== null && configured !== effective,
    source: configured !== null ? input.source : null,
  };
}

function readPositiveIntegerOrNull(value: string | undefined) {
  const parsed = Number.parseInt(value ?? "", 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

function readNonNegativeInteger(value: string | undefined, fallback: number) {
  const parsed = Number.parseInt(value ?? "", 10);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
}

function isSha256Hex(value: string | undefined): value is string {
  return Boolean(value && /^[a-f0-9]{64}$/.test(value));
}

function isProductionProviderTimeout(value: string | undefined) {
  if (!value || !/^\d+$/.test(value)) {
    return false;
  }
  const timeoutMs = Number(value);
  return Number.isSafeInteger(timeoutMs)
    && timeoutMs >= studentRuntimeMinTimeoutMs
    && timeoutMs <= studentRuntimeDefaultTimeoutMs;
}

function clamp(value: number, min: number, max: number) {
  return Math.min(Math.max(value, min), max);
}

function isLoopbackHostname(hostname: string) {
  return hostname === "localhost"
    || hostname === "127.0.0.1"
    || hostname === "[::1]";
}

function isProductionEnvironment(env: NodeJS.ProcessEnv) {
  return env.NODE_ENV === "production" || env.VERCEL_ENV === "production";
}
