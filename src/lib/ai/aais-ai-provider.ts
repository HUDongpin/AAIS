import type { AaisAgentId, AaisPhase, Locale } from "@/data/aais";

type AaisProviderWorkspaceState = {
  currentStep: string;
  artifactText?: string;
  helpRequestsUsed?: number;
};

export type AaisModelRequest = {
  agentId: AaisAgentId;
  label: string;
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
  thinkingMode?: "disabled";
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  maxRetries?: number;
};

const redaction = {
  secrets: "omitted",
  prompt: "summarized",
} as const;

const guardrailPolicy = "aais-age-appropriate-output-v1" as const;

export function createConfiguredAaisModelProvider(): AaisModelProvider {
  if (process.env.AAIS_AI_PROVIDER === "openai-compatible") {
    const endpoint = process.env.AAIS_AI_ENDPOINT?.trim();
    const apiKey = process.env.AAIS_AI_API_KEY?.trim();
    const model = process.env.AAIS_AI_MODEL?.trim();
    if (endpoint && apiKey && model && isLiveProviderApprovedForRuntime()) {
      return createOpenAiCompatibleAaisProvider({
        endpoint,
        apiKey,
        model,
        thinkingMode: readThinkingMode(process.env.AAIS_AI_THINKING_MODE),
        timeoutMs: readPositiveInteger(process.env.AAIS_AI_TIMEOUT_MS, 8000),
        maxRetries: readPositiveInteger(process.env.AAIS_AI_MAX_RETRIES, 1),
      });
    }
  }
  return createDeterministicAaisProvider();
}

export function createDeterministicAaisProvider(): AaisModelProvider {
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
        },
      };
    },
  };
}

export function createOpenAiCompatibleAaisProvider(
  input: OpenAiCompatibleProviderInput,
): AaisModelProvider {
  return {
    async generate(request) {
      const maxAttempts = Math.max(1, (input.maxRetries ?? 1) + 1);

      for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
        try {
          const text = await callOpenAiCompatibleProvider(input, request);
          const guardrail = evaluateAaisModelOutput(text);
          if (guardrail.status === "blocked") {
            return {
              text: request.fallbackText,
              runtime: {
                provider: "openai-compatible",
                model: input.model,
                attempts: attempt,
                status: "fallback",
                guardrail,
                redaction,
              },
            };
          }
          return {
            text,
            runtime: {
              provider: "openai-compatible",
              model: input.model,
              attempts: attempt,
              status: "ok",
              guardrail,
              redaction,
            },
          };
        } catch {
          if (attempt === maxAttempts) {
            break;
          }
        }
      }

      return {
        text: request.fallbackText,
        runtime: {
          provider: "openai-compatible",
          model: input.model,
          attempts: maxAttempts,
          status: "fallback",
          guardrail: {
            policy: guardrailPolicy,
            status: "not-applicable",
            reasons: ["provider-unavailable"],
          },
          redaction,
        },
      };
    },
  };
}

async function callOpenAiCompatibleProvider(
  input: OpenAiCompatibleProviderInput,
  request: AaisModelRequest,
) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), input.timeoutMs ?? 8000);
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
        max_tokens: 360,
        ...(input.thinkingMode === "disabled" ? { thinking: { type: "disabled" } } : {}),
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
              locale: request.locale,
              phase: request.phase,
              taskId: request.taskId,
              learnerInput: request.learnerInput,
              workspaceState: {
                currentStep: request.workspaceState.currentStep,
                artifactCharacters: request.workspaceState.artifactText?.length ?? 0,
                helpRequestsUsed: request.workspaceState.helpRequestsUsed ?? 0,
              },
            }),
          },
        ],
      }),
      signal: controller.signal,
    });
    if (!response.ok) {
      throw new Error(`AAIS model provider returned ${response.status}`);
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
      throw new Error("AAIS model provider returned an empty response");
    }
    return content;
  } finally {
    clearTimeout(timeout);
  }
}

function readPositiveInteger(value: string | undefined, fallback: number) {
  const parsed = Number.parseInt(value ?? "", 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function readThinkingMode(value: string | undefined): "disabled" | undefined {
  return value?.trim().toLowerCase() === "disabled" ? "disabled" : undefined;
}

function isLiveProviderApprovedForRuntime() {
  if (!isProductionRuntime()) {
    return true;
  }
  return process.env.AAIS_AI_EVAL_APPROVED === "true"
    && Boolean(process.env.AAIS_AI_EVAL_VERSION?.trim());
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
