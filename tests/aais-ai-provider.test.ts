import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createConfiguredAaisModelProvider,
  createOpenAiCompatibleAaisProvider,
} from "@/lib/ai/aais-ai-provider";
import { aaisCognitiveApprenticeshipBackground } from "@/data/aais";
import { getAaisAiEvalApproval } from "@/lib/server/aais-ai-eval-manifest";

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe("AAIS governed AI provider", () => {
  it("retries transient provider failures and returns redacted runtime metadata", async () => {
    const fetchMock = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(new Response("temporary failure", { status: 503 }))
      .mockResolvedValueOnce(Response.json({
        choices: [
          {
            message: {
              content: "受治理 provider 的导学回复",
            },
          },
        ],
      }));
    const provider = createOpenAiCompatibleAaisProvider({
      endpoint: "https://ai.example.test/v1/chat/completions",
      apiKey: "secret-api-key",
      model: "enterprise-model",
      fetchImpl: fetchMock,
      timeoutMs: 1000,
      maxRetries: 1,
    });

    const result = await provider.generate({
      agentId: "A1",
      label: "导学智能体",
      locale: "zh-CN",
      phase: "training",
      taskId: "training_task_1",
      learnerInput: "我应该如何开始？",
      workspaceState: {
        currentStep: "guide",
      },
      fallbackText: "本地 fallback",
    });

    expect(result.text).toBe("受治理 provider 的导学回复");
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls[0]?.[1]?.headers).toMatchObject({
      authorization: "Bearer secret-api-key",
    });
    expect(result.runtime).toMatchObject({
      provider: "openai-compatible",
      model: "enterprise-model",
      attempts: 2,
      status: "ok",
      redaction: {
        secrets: "omitted",
        prompt: "summarized",
      },
    });
    expect(JSON.stringify(result.runtime)).not.toContain("secret-api-key");
  });

  it("uses the fallback provider when the configured primary provider cannot connect", async () => {
    vi.stubEnv("AAIS_AI_PROVIDER", "openai-compatible");
    vi.stubEnv("AAIS_AI_ENDPOINT", "https://qwen.example.test/compatible-mode/v1/chat/completions");
    vi.stubEnv("AAIS_AI_API_KEY", "qwen-secret-key");
    vi.stubEnv("AAIS_AI_MODEL", "qwen-plus");
    vi.stubEnv("AAIS_AI_FALLBACK_ENDPOINT", "https://deepseek.example.test/v1/chat/completions");
    vi.stubEnv("AAIS_AI_FALLBACK_API_KEY", "deepseek-secret-key");
    vi.stubEnv("AAIS_AI_FALLBACK_MODEL", "deepseek-v4-pro");
    const fetchMock = vi.fn<typeof fetch>(async (url) => {
      if (String(url).includes("qwen.example.test")) {
        throw Object.assign(new TypeError("fetch failed"), {
          cause: {
            code: "UND_ERR_CONNECT_TIMEOUT",
          },
        });
      }
      return Response.json({
        choices: [
          {
            message: {
              content: "DeepSeek fallback response",
            },
          },
        ],
      });
    });
    vi.stubGlobal("fetch", fetchMock);

    const provider = createConfiguredAaisModelProvider();
    const result = await provider.generate({
      agentId: "A1",
      label: "导学智能体",
      locale: "zh-CN",
      phase: "training",
      taskId: "training_task_1",
      learnerInput: "我应该如何开始？",
      workspaceState: {
        currentStep: "guide",
      },
      fallbackText: "本地 fallback",
    });

    expect(result.text).toBe("DeepSeek fallback response");
    expect(fetchMock.mock.calls.map(([url]) => String(url))).toEqual([
      "https://qwen.example.test/compatible-mode/v1/chat/completions",
      "https://qwen.example.test/compatible-mode/v1/chat/completions",
      "https://deepseek.example.test/v1/chat/completions",
    ]);
    expect(result.runtime).toMatchObject({
      provider: "openai-compatible",
      model: "deepseek-v4-pro",
      providerChain: {
        selected: "fallback",
        fallbackUsed: true,
        failures: [
          {
            provider: "primary",
            reason: "connect-timeout",
          },
        ],
      },
      redaction: {
        secrets: "omitted",
        prompt: "summarized",
      },
    });
    expect(JSON.stringify(result)).not.toContain("qwen-secret-key");
    expect(JSON.stringify(result)).not.toContain("deepseek-secret-key");
  });

  it("honors zero runtime retries from environment configuration", async () => {
    vi.stubEnv("AAIS_AI_PROVIDER", "openai-compatible");
    vi.stubEnv("AAIS_AI_ENDPOINT", "https://ai.example.test/v1/chat/completions");
    vi.stubEnv("AAIS_AI_API_KEY", "secret-api-key");
    vi.stubEnv("AAIS_AI_MODEL", "enterprise-model");
    vi.stubEnv("AAIS_AI_MAX_RETRIES", "0");
    const fetchMock = vi.fn<typeof fetch>(async () =>
      new Response("temporary failure", { status: 503 }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const provider = createConfiguredAaisModelProvider();
    const result = await provider.generate({
      agentId: "A1",
      label: "导学智能体",
      locale: "zh-CN",
      phase: "training",
      taskId: "training_task_1",
      learnerInput: "我应该如何开始？",
      workspaceState: {
        currentStep: "guide",
      },
      fallbackText: "本地 fallback",
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(result).toMatchObject({
      text: "本地 fallback",
      runtime: {
        attempts: 1,
        status: "fallback",
        guardrail: {
          reasons: ["http-status"],
        },
      },
    });
  });

  it("honors configured student runtime timeout up to the enterprise ceiling and trims output budget", async () => {
    vi.useFakeTimers();
    vi.stubEnv("AAIS_AI_PROVIDER", "openai-compatible");
    vi.stubEnv("AAIS_AI_ENDPOINT", "https://ai.example.test/v1/chat/completions");
    vi.stubEnv("AAIS_AI_API_KEY", "secret-api-key");
    vi.stubEnv("AAIS_AI_MODEL", "enterprise-model");
    vi.stubEnv("AAIS_AI_TIMEOUT_MS", "30000");
    vi.stubEnv("AAIS_AI_MAX_RETRIES", "0");
    const fetchMock = vi.fn<typeof fetch>((_url, init) => {
      const signal = init?.signal as AbortSignal | undefined;
      return new Promise<Response>((_resolve, reject) => {
        signal?.addEventListener("abort", () => {
          reject(Object.assign(new Error("provider aborted"), { name: "AbortError" }));
        });
      });
    });
    vi.stubGlobal("fetch", fetchMock);

    const provider = createConfiguredAaisModelProvider();
    const resultPromise = provider.generate({
      agentId: "A2",
      label: "专家智能体",
      locale: "zh-CN",
      phase: "training",
      taskId: "training_task_1",
      learnerInput: "请给我一个专家示范。",
      workspaceState: {
        currentStep: "guide",
      },
      fallbackText: "本地 fallback",
    });

    try {
      await vi.advanceTimersByTimeAsync(12_001);
      const request = fetchMock.mock.calls[0]?.[1];
      const payload = JSON.parse(String(request?.body));
      expect((request?.signal as AbortSignal).aborted).toBe(false);
      expect(payload.max_tokens).toBe(600);
      await vi.advanceTimersByTimeAsync(18_000);
      expect((request?.signal as AbortSignal).aborted).toBe(true);
    } finally {
      await vi.advanceTimersByTimeAsync(30_000);
      vi.useRealTimers();
    }

    const result = await resultPromise;
    expect(result).toMatchObject({
      text: "本地 fallback",
      runtime: {
        attempts: 1,
        status: "fallback",
        runtimeProfile: {
          mode: "live",
          primary: {
            timeoutMs: {
              configured: 30000,
              effective: 30000,
              clamped: false,
            },
            thinkingMode: "provider-default",
          },
        },
        guardrail: {
          reasons: ["abort-timeout"],
        },
      },
    });
  });

  it("uses DashScope Qwen defaults when a Qwen API key is available", async () => {
    vi.stubEnv("DASHSCOPE_API_KEY", "dashscope-secret-key");
    const fetchMock = vi.fn<typeof fetch>(async () =>
      Response.json({
        choices: [
          {
            message: {
              content: "Qwen live guide response",
            },
          },
        ],
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const provider = createConfiguredAaisModelProvider();
    const result = await provider.generate({
      agentId: "A1",
      label: "导学智能体",
      locale: "zh-CN",
      phase: "training",
      taskId: "training_task_1",
      learnerInput: "请帮我明确目标。",
      workspaceState: {
        currentStep: "guide",
      },
      fallbackText: "本地 fallback",
    });

    expect(result.text).toBe("Qwen live guide response");
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(String(fetchMock.mock.calls[0]?.[0])).toBe(
      "https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions",
    );
    const payload = JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body));
    expect(payload.model).toBe("qwen3.7-max");
    expect(payload.enable_thinking).toBe(false);
    expect(payload).not.toHaveProperty("thinking");
    expect(fetchMock.mock.calls[0]?.[1]?.headers).toMatchObject({
      authorization: "Bearer dashscope-secret-key",
    });
    expect(result.runtime).toMatchObject({
      provider: "openai-compatible",
      model: "qwen3.7-max",
      status: "ok",
      runtimeProfile: {
        mode: "live",
        primary: {
          provider: "qwen",
          thinkingMode: "disabled",
          timeoutMs: {
            effective: 12000,
          },
        },
      },
      redaction: {
        secrets: "omitted",
        prompt: "summarized",
      },
    });
    expect(JSON.stringify(result)).not.toContain("dashscope-secret-key");
  });

  it("keeps production on deterministic fallback until model evaluation is approved", async () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("AAIS_AI_PROVIDER", "openai-compatible");
    vi.stubEnv("AAIS_AI_ENDPOINT", "https://ai.example.test/v1/chat/completions");
    vi.stubEnv("AAIS_AI_API_KEY", "secret-api-key");
    vi.stubEnv("AAIS_AI_MODEL", "enterprise-model");
    const fetchMock = vi.fn<typeof fetch>();
    vi.stubGlobal("fetch", fetchMock);

    const provider = createConfiguredAaisModelProvider();
    const result = await provider.generate({
      agentId: "A1",
      label: "导学智能体",
      locale: "zh-CN",
      phase: "training",
      taskId: "training_task_1",
      learnerInput: "我应该如何开始？",
      workspaceState: {
        currentStep: "guide",
      },
      fallbackText: "本地 fallback",
    });

    expect(fetchMock).not.toHaveBeenCalled();
    expect(result).toMatchObject({
      text: "本地 fallback",
      runtime: {
        provider: "deterministic",
        status: "fallback",
      },
    });
  });

  it("keeps production on deterministic fallback when the configured evaluation version is stale", async () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("AAIS_AI_PROVIDER", "qwen");
    vi.stubEnv("DASHSCOPE_API_KEY", "dashscope-secret-key");
    vi.stubEnv("AAIS_AI_MODEL", "qwen3.7-max");
    vi.stubEnv("AAIS_AI_EVAL_APPROVED", "true");
    vi.stubEnv("AAIS_AI_EVAL_VERSION", "eval-for-an-older-model");
    const fetchMock = vi.fn<typeof fetch>();
    vi.stubGlobal("fetch", fetchMock);

    const provider = createConfiguredAaisModelProvider();
    const result = await provider.generate({
      agentId: "A1",
      label: "导学智能体",
      locale: "zh-CN",
      phase: "training",
      taskId: "training_task_1",
      learnerInput: "我应该如何开始？",
      workspaceState: {
        currentStep: "guide",
      },
      fallbackText: "本地 fallback",
    });

    expect(fetchMock).not.toHaveBeenCalled();
    expect(result.runtime).toMatchObject({
      provider: "deterministic",
      status: "fallback",
    });
  });

  it("fails closed instead of hiding a malformed configured manifest behind bundled evidence", () => {
    vi.stubEnv("AAIS_AI_EVAL_APPROVED", "true");
    vi.stubEnv("AAIS_AI_EVAL_VERSION", "eval-2026-07-19-qwen3.7-max-v1");
    vi.stubEnv("AAIS_AI_EVAL_MANIFEST_JSON", "{not-valid-json");

    expect(getAaisAiEvalApproval({
      required: true,
      provider: "openai-compatible",
      model: "qwen3.7-max",
    })).toEqual({
      approved: false,
      evalVersion: "eval-2026-07-19-qwen3.7-max-v1",
      manifest: {
        status: "invalid",
        issue: "AAIS_AI_EVAL_MANIFEST",
      },
    });
  });

  it("enables production Qwen only when the configured version matches bundled evaluation evidence", async () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("AAIS_AI_PROVIDER", "qwen");
    vi.stubEnv("DASHSCOPE_API_KEY", "dashscope-secret-key");
    vi.stubEnv("AAIS_AI_MODEL", "qwen3.7-max");
    vi.stubEnv("AAIS_AI_EVAL_APPROVED", "true");
    vi.stubEnv("AAIS_AI_EVAL_VERSION", "eval-2026-07-19-qwen3.7-max-v1");
    const fetchMock = vi.fn<typeof fetch>(async () =>
      Response.json({
        choices: [
          {
            message: {
              content: "Qwen live guide response",
            },
          },
        ],
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const provider = createConfiguredAaisModelProvider();
    const result = await provider.generate({
      agentId: "A1",
      label: "导学智能体",
      locale: "zh-CN",
      phase: "training",
      taskId: "training_task_1",
      learnerInput: "请帮我明确目标。",
      workspaceState: {
        currentStep: "guide",
      },
      fallbackText: "本地 fallback",
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(result.runtime).toMatchObject({
      provider: "openai-compatible",
      model: "qwen3.7-max",
      status: "ok",
    });
  });

  it("excludes an unevaluated live fallback from the production provider chain", async () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("AAIS_AI_PROVIDER", "qwen");
    vi.stubEnv("DASHSCOPE_API_KEY", "dashscope-secret-key");
    vi.stubEnv("AAIS_AI_MODEL", "qwen3.7-max");
    vi.stubEnv("AAIS_AI_EVAL_APPROVED", "true");
    vi.stubEnv("AAIS_AI_EVAL_VERSION", "eval-2026-07-19-qwen3.7-max-v1");
    vi.stubEnv("AAIS_AI_FALLBACK_ENDPOINT", "https://fallback.example.test/v1/chat/completions");
    vi.stubEnv("AAIS_AI_FALLBACK_API_KEY", "fallback-secret-key");
    vi.stubEnv("AAIS_AI_FALLBACK_MODEL", "unevaluated-model");
    const fetchMock = vi.fn<typeof fetch>(async () =>
      new Response("primary unavailable", { status: 503 }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const provider = createConfiguredAaisModelProvider();
    const result = await provider.generate({
      agentId: "A1",
      label: "导学智能体",
      locale: "zh-CN",
      phase: "training",
      taskId: "training_task_1",
      learnerInput: "请帮我明确目标。",
      workspaceState: {
        currentStep: "guide",
      },
      fallbackText: "本地 fallback",
    });

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls.every(([url]) =>
      String(url).includes("dashscope.aliyuncs.com"))).toBe(true);
    expect(result).toMatchObject({
      text: "本地 fallback",
      runtime: {
        provider: "openai-compatible",
        model: "qwen3.7-max",
        status: "fallback",
        runtimeProfile: {
          fallback: null,
        },
      },
    });
    expect(JSON.stringify(result)).not.toContain("fallback-secret-key");
  });

  it("blocks unsafe provider content and returns fallback without leaking the unsafe text", async () => {
    const fetchMock = vi.fn<typeof fetch>(async () =>
      Response.json({
        choices: [
          {
            message: {
              content: "password=super-secret-value",
            },
          },
        ],
      }),
    );
    const provider = createOpenAiCompatibleAaisProvider({
      endpoint: "https://ai.example.test/v1/chat/completions",
      apiKey: "secret-api-key",
      model: "enterprise-model",
      fetchImpl: fetchMock,
      timeoutMs: 1000,
      maxRetries: 0,
    });

    const result = await provider.generate({
      agentId: "A1",
      label: "导学智能体",
      locale: "zh-CN",
      phase: "training",
      taskId: "training_task_1",
      learnerInput: "我应该如何开始？",
      workspaceState: {
        currentStep: "guide",
      },
      fallbackText: "本地 fallback",
    });

    expect(result.text).toBe("本地 fallback");
    expect(result.runtime).toMatchObject({
      provider: "openai-compatible",
      status: "fallback",
      guardrail: {
        policy: "aais-age-appropriate-output-v1",
        status: "blocked",
        reasons: ["secret-like-content"],
      },
    });
    expect(JSON.stringify(result)).not.toContain("super-secret-value");
  });

  it("sends the Qwen-specific disabled-thinking parameter at the request-body top level", async () => {
    const fetchMock = vi.fn<typeof fetch>(async () =>
      Response.json({
        choices: [
          {
            message: {
              content: "受治理 provider 的导学回复",
            },
          },
        ],
      }),
    );
    const provider = createOpenAiCompatibleAaisProvider({
      endpoint: "https://ai.example.test/v1/chat/completions",
      apiKey: "secret-api-key",
      model: "qwen3.7-max",
      provider: "qwen",
      fetchImpl: fetchMock,
      timeoutMs: 1000,
      maxRetries: 0,
      thinkingMode: "disabled",
    });

    await provider.generate({
      agentId: "A1",
      label: "导学智能体",
      locale: "zh-CN",
      phase: "training",
      taskId: "training_task_1",
      learnerInput: "我应该如何开始？",
      workspaceState: {
        currentStep: "guide",
      },
      fallbackText: "本地 fallback",
    });

    const payload = JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body));
    expect(payload.enable_thinking).toBe(false);
    expect(payload).not.toHaveProperty("thinking");
  });

  it("sends the Cognitive Apprenticeship background in the redacted model context", async () => {
    const fetchMock = vi.fn<typeof fetch>(async () =>
      Response.json({
        choices: [
          {
            message: {
              content: "受治理 provider 的导学回复",
            },
          },
        ],
      }),
    );
    const provider = createOpenAiCompatibleAaisProvider({
      endpoint: "https://ai.example.test/v1/chat/completions",
      apiKey: "secret-api-key",
      model: "enterprise-model",
      fetchImpl: fetchMock,
      timeoutMs: 1000,
      maxRetries: 0,
    });

    await provider.generate({
      agentId: "A2",
      label: "专家智能体",
      role: "前端，与学生直接对话",
      mission: "两位专家共同完成一个任务，随后引导学生练习。",
      caModules: ["Modelling", "Coaching"],
      caBackground: aaisCognitiveApprenticeshipBackground,
      locale: "zh-CN",
      phase: "training",
      taskId: "training_task_1",
      learnerInput: "我想看专家怎么做。",
      workspaceState: {
        currentStep: "modelling",
      },
      fallbackText: "本地 fallback",
    });

    const payload = JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body));
    const userContext = JSON.parse(payload.messages[1].content);
    expect(userContext.caBackground).toMatchObject({
      framework: "Cognitive Apprenticeship",
      sequence: ["Modelling", "Coaching", "Scaffolding", "Articulation", "Reflection"],
    });
    expect(userContext.caBackground.principles.map((principle: { id: string }) => principle.id)).toEqual([
      "modelling",
      "coaching",
      "scaffolding",
      "fading",
      "articulation",
      "reflection",
    ]);
    expect(JSON.stringify(payload)).not.toContain("secret-api-key");
  });
});
