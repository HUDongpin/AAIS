import { createHash } from "node:crypto";

export type AaisAiRuntimeThinkingMode = "disabled" | "provider-default";

export type AaisAiRuntimeProviderName = "openai-compatible" | "qwen" | "dashscope";

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
  thinkingMode?: "disabled";
  timeoutMs: number;
  maxRetries: number;
  maxTokens: number;
  providerRole: "primary" | "fallback";
  profile: AaisAiRuntimeProviderProfile;
};

export type AaisAiRuntimeConfig = {
  profile: AaisAiRuntimeProfile;
  primary: AaisAiRuntimeProviderCandidate | null;
  fallback: AaisAiRuntimeProviderCandidate | null;
};

export const qwenDashScopeEndpoint = "https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions";
export const qwenDefaultModel = "qwen3.8-max";
export const studentRuntimeDefaultTimeoutMs = 12_000;
export const studentRuntimeMinTimeoutMs = 3_000;
export const studentRuntimeMaxTimeoutMs = 30_000;
export const studentRuntimeDefaultMaxRetries = 1;
export const studentRuntimeMaxTokens = 600;

const redactedRuntimeProfile = {
  secrets: "omitted",
  endpoints: "omitted",
  modelIds: "fingerprint-only",
} as const;

export function readAaisAiRuntimeConfig(env: NodeJS.ProcessEnv = process.env): AaisAiRuntimeConfig {
  const primary = readConfiguredPrimaryProvider(env);
  const fallback = readConfiguredFallbackProvider(env);
  return {
    profile: {
      mode: primary ? "live" : "deterministic",
      primary: primary?.profile ?? null,
      fallback: fallback?.profile ?? null,
      redaction: redactedRuntimeProfile,
    },
    primary,
    fallback,
  };
}

export function createDeterministicAaisAiRuntimeProfile(): AaisAiRuntimeProfile {
  return {
    mode: "deterministic",
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
}): AaisAiRuntimeProfile {
  const timeoutMs = createTimeoutSummary({
    rawValue: input.timeoutMs ? String(input.timeoutMs) : undefined,
    source: input.timeoutMs ? "manual" : null,
  });
  return {
    mode: "live",
    primary: {
      providerRole: "primary",
      provider: input.provider ?? "openai-compatible",
      modelFingerprint: getAaisAiModelFingerprint(input.model),
      thinkingMode: input.thinkingMode === "disabled" ? "disabled" : "provider-default",
      thinkingModeSource: input.thinkingMode === "disabled" ? "manual" : "default",
      timeoutMs,
      maxRetries: Math.max(0, input.maxRetries ?? studentRuntimeDefaultMaxRetries),
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

function readConfiguredPrimaryProvider(env: NodeJS.ProcessEnv): AaisAiRuntimeProviderCandidate | null {
  const provider = env.AAIS_AI_PROVIDER?.trim().toLowerCase();
  const explicitEndpoint = env.AAIS_AI_ENDPOINT?.trim();
  const explicitApiKey = env.AAIS_AI_API_KEY?.trim();
  const explicitModel = env.AAIS_AI_MODEL?.trim();
  const qwenApiKey = env.DASHSCOPE_API_KEY?.trim() || env.QWEN_API_KEY?.trim();
  const qwenMode = provider === "qwen" || provider === "dashscope";
  const openAiCompatibleMode = provider === "openai-compatible";
  const qwenAliasMode = !provider && Boolean(qwenApiKey);
  const explicitOpenAiConfig = Boolean(explicitEndpoint && explicitApiKey && explicitModel);

  if (provider && !openAiCompatibleMode && !qwenMode) {
    return null;
  }
  if (!openAiCompatibleMode && !qwenMode && !qwenAliasMode && !explicitOpenAiConfig) {
    return null;
  }

  const useQwenDefaults = qwenMode || qwenAliasMode || Boolean(!explicitApiKey && qwenApiKey);
  const endpoint = explicitEndpoint || (useQwenDefaults ? readQwenEndpoint(env) : undefined);
  const apiKey = explicitApiKey || qwenApiKey;
  const model = explicitModel || (useQwenDefaults ? readQwenModel(env) : undefined);
  if (!endpoint || !apiKey || !model) {
    return null;
  }

  const providerName: AaisAiRuntimeProviderName = qwenMode
    ? provider === "dashscope" ? "dashscope" : "qwen"
    : useQwenDefaults
      ? "qwen"
      : "openai-compatible";
  return createProviderCandidate({
    endpoint,
    apiKey,
    model,
    providerRole: "primary",
    provider: providerName,
    thinkingModeValue: env.AAIS_AI_THINKING_MODE,
    thinkingModeSourceName: "AAIS_AI_THINKING_MODE",
    timeoutValue: env.AAIS_AI_TIMEOUT_MS,
    timeoutSourceName: "AAIS_AI_TIMEOUT_MS",
    maxRetriesValue: env.AAIS_AI_MAX_RETRIES,
  });
}

function readConfiguredFallbackProvider(env: NodeJS.ProcessEnv): AaisAiRuntimeProviderCandidate | null {
  const endpoint = env.AAIS_AI_FALLBACK_ENDPOINT?.trim();
  const apiKey = env.AAIS_AI_FALLBACK_API_KEY?.trim();
  const model = env.AAIS_AI_FALLBACK_MODEL?.trim();
  if (!endpoint || !apiKey || !model) {
    return null;
  }
  return createProviderCandidate({
    endpoint,
    apiKey,
    model,
    providerRole: "fallback",
    provider: "openai-compatible",
    thinkingModeValue: env.AAIS_AI_FALLBACK_THINKING_MODE,
    thinkingModeSourceName: "AAIS_AI_FALLBACK_THINKING_MODE",
    timeoutValue: env.AAIS_AI_FALLBACK_TIMEOUT_MS ?? env.AAIS_AI_TIMEOUT_MS,
    timeoutSourceName: env.AAIS_AI_FALLBACK_TIMEOUT_MS ? "AAIS_AI_FALLBACK_TIMEOUT_MS" : "AAIS_AI_TIMEOUT_MS",
    maxRetriesValue: env.AAIS_AI_FALLBACK_MAX_RETRIES ?? env.AAIS_AI_MAX_RETRIES,
  });
}

function createProviderCandidate(input: {
  endpoint: string;
  apiKey: string;
  model: string;
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
  const maxRetries = readNonNegativeInteger(input.maxRetriesValue, studentRuntimeDefaultMaxRetries);
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
  if (input.provider === "qwen" || input.provider === "dashscope") {
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

function clamp(value: number, min: number, max: number) {
  return Math.min(Math.max(value, min), max);
}
