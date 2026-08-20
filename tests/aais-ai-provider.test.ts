import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createConfiguredAaisModelProvider,
  createOpenAiCompatibleAaisProvider,
} from "@/lib/ai/aais-ai-provider";
import {
  createManualAaisAiRuntimeProfile,
  readAaisAiRuntimeConfig,
  studentRuntimeMaxRetries,
} from "@/lib/ai/aais-ai-runtime-config";
import { aaisCognitiveApprenticeshipBackground } from "@/data/aais";
import { getAaisAiEvalApproval } from "@/lib/server/aais-ai-eval-manifest";

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe("AAIS governed AI provider", () => {
  it("fails closed on oversized streaming provider JSON and cancels the body", async () => {
    let cancelled = false;
    const responseBody = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array(300 * 1024));
      },
      cancel() {
        cancelled = true;
      },
    });
    const fetchMock = vi.fn<typeof fetch>(async () => new Response(responseBody));
    const provider = createOpenAiCompatibleAaisProvider({
      endpoint: "https://ai.example.test/v1/chat/completions",
      apiKey: "secret-api-key",
      model: "enterprise-model",
      fetchImpl: fetchMock,
      timeoutMs: 1_000,
      maxRetries: 0,
    });

    const result = await provider.generate({
      agentId: "A1",
      label: "导学智能体",
      locale: "zh-CN",
      phase: "training",
      taskId: "training_task_1",
      learnerInput: "请给我下一步。",
      workspaceState: { currentStep: "guide" },
      fallbackText: "本地 fallback",
    });

    expect(cancelled).toBe(true);
    expect(result).toMatchObject({
      text: "本地 fallback",
      runtime: {
        status: "fallback",
        guardrail: {
          reasons: ["provider-error"],
        },
      },
    });
  });

  it.each([
    "http://ai.example.test/v1/chat/completions",
    "https://user:password@ai.example.test/v1/chat/completions",
    "https://ai.example.test/v1/chat/completions?tenant=learner",
    "https://ai.example.test/v1/chat/completions?",
    "https://ai.example.test/v1/chat/completions#fragment",
    "https://ai.example.test/v1/chat/completions#",
  ])("marks unsafe production AI endpoint configuration invalid: %s", (endpoint) => {
    const configured = readAaisAiRuntimeConfig({
      ...process.env,
      NODE_ENV: "production",
      AAIS_AI_PROVIDER: "openai-compatible",
      AAIS_AI_ENDPOINT: endpoint,
      AAIS_AI_API_KEY: "secret-api-key",
      AAIS_AI_MODEL: "enterprise-model",
    });

    expect(configured.configurationStatus.primary).toBe("invalid");
    expect(configured.primary).toBeNull();
    expect(configured.profile.mode).toBe("deterministic");
  });

  it("caps configured and manual retry counts so provider work has a finite upper bound", () => {
    const configured = readAaisAiRuntimeConfig({
      ...process.env,
      AAIS_AI_PROVIDER: "openai-compatible",
      AAIS_AI_ENDPOINT: "https://ai.example.test/v1/chat/completions",
      AAIS_AI_API_KEY: "secret-api-key",
      AAIS_AI_MODEL: "enterprise-model",
      AAIS_AI_MAX_RETRIES: "1000000",
      AAIS_AI_FALLBACK_ENDPOINT: "https://fallback.example.test/v1/chat/completions",
      AAIS_AI_FALLBACK_API_KEY: "fallback-secret-key",
      AAIS_AI_FALLBACK_MODEL: "fallback-model",
      AAIS_AI_FALLBACK_MAX_RETRIES: "999999",
    });
    const manual = createManualAaisAiRuntimeProfile({
      model: "manual-model",
      maxRetries: Number.MAX_SAFE_INTEGER,
    });
    const invalidManual = createManualAaisAiRuntimeProfile({
      model: "manual-model",
      maxRetries: Number.NaN,
    });
    const fractionalManual = createManualAaisAiRuntimeProfile({
      model: "manual-model",
      maxRetries: 2.9,
    });

    expect(configured.primary?.maxRetries).toBe(studentRuntimeMaxRetries);
    expect(configured.fallback?.maxRetries).toBe(studentRuntimeMaxRetries);
    expect(configured.profile.primary?.maxRetries).toBe(studentRuntimeMaxRetries);
    expect(configured.profile.fallback?.maxRetries).toBe(studentRuntimeMaxRetries);
    expect(manual.primary?.maxRetries).toBe(studentRuntimeMaxRetries);
    expect(invalidManual.primary?.maxRetries).toBe(1);
    expect(fractionalManual.primary?.maxRetries).toBe(2);
  });

  it("defensively caps direct provider retry inputs at the same finite upper bound", async () => {
    const fetchMock = vi.fn<typeof fetch>(async () =>
      new Response("temporary failure", { status: 503 }),
    );
    const provider = createOpenAiCompatibleAaisProvider({
      endpoint: "https://ai.example.test/v1/chat/completions",
      apiKey: "secret-api-key",
      model: "enterprise-model",
      fetchImpl: fetchMock,
      timeoutMs: 1_000,
      maxRetries: Number.MAX_SAFE_INTEGER,
    });

    const result = await provider.generate({
      agentId: "A1",
      label: "导学智能体",
      locale: "zh-CN",
      phase: "training",
      taskId: "training_task_1",
      learnerInput: "请给我一个有限重试的提示。",
      workspaceState: { currentStep: "guide" },
      fallbackText: "本地 fallback",
    });

    expect(fetchMock).toHaveBeenCalledTimes(studentRuntimeMaxRetries + 1);
    expect(result.runtime).toMatchObject({
      attempts: studentRuntimeMaxRetries + 1,
      status: "fallback",
    });
  });

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

  it("retries a length-truncated response and only returns the complete retry", async () => {
    const fetchMock = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(Response.json({
        choices: [{
          finish_reason: "length",
          message: {
            content: "> 3. 作者是否",
          },
        }],
      }))
      .mockResolvedValueOnce(Response.json({
        choices: [{
          finish_reason: "stop",
          message: {
            content: "作者是否提供了足够证据？请逐项核对。",
          },
        }],
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
      agentId: "A2",
      label: "专家智能体",
      locale: "zh-CN",
      phase: "training",
      taskId: "training_task_1",
      learnerInput: "请继续分析。",
      workspaceState: {
        currentStep: "modelling",
      },
      fallbackText: "本地 fallback",
    });

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(result).toMatchObject({
      text: "作者是否提供了足够证据？请逐项核对。",
      runtime: {
        attempts: 2,
        status: "ok",
      },
    });
    expect(result.text).not.toContain("> 3. 作者是否");
  });

  it("falls back with a testable reason when every response reaches a token limit", async () => {
    const fetchMock = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(Response.json({
        choices: [{
          finish_reason: "length",
          message: {
            content: "第一段未完成",
          },
        }],
      }))
      .mockResolvedValueOnce(Response.json({
        choices: [{
          stop_reason: "max_tokens",
          message: {
            content: "第二段仍未完成",
          },
        }],
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
      agentId: "A2",
      label: "专家智能体",
      locale: "zh-CN",
      phase: "training",
      taskId: "training_task_1",
      learnerInput: "请继续分析。",
      workspaceState: {
        currentStep: "modelling",
      },
      fallbackText: "本地 fallback",
    });

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(result).toMatchObject({
      text: "本地 fallback",
      runtime: {
        attempts: 2,
        status: "fallback",
        guardrail: {
          status: "not-applicable",
          reasons: ["truncated-response"],
        },
      },
    });
    expect(JSON.stringify(result)).not.toContain("未完成");
  });

  it("keeps accepting legacy compatible responses that omit finish_reason", async () => {
    const fetchMock = vi.fn<typeof fetch>(async () => Response.json({
      choices: [{
        message: {
          content: "旧测试 mock 的完整回复",
        },
      }],
    }));
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

    expect(result).toMatchObject({
      text: "旧测试 mock 的完整回复",
      runtime: {
        attempts: 1,
        status: "ok",
      },
    });
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

  it("propagates an external cancellation without retrying or returning fallback", async () => {
    const controller = new AbortController();
    let notifyFetchStarted!: () => void;
    const fetchStarted = new Promise<void>((resolve) => {
      notifyFetchStarted = resolve;
    });
    const fetchMock = vi.fn<typeof fetch>((_url, init) => {
      notifyFetchStarted();
      const signal = init?.signal as AbortSignal;
      return new Promise<Response>((_resolve, reject) => {
        signal.addEventListener("abort", () => reject(signal.reason), { once: true });
      });
    });
    const provider = createOpenAiCompatibleAaisProvider({
      endpoint: "https://ai.example.test/v1/chat/completions",
      apiKey: "secret-api-key",
      model: "enterprise-model",
      fetchImpl: fetchMock,
      timeoutMs: 30_000,
      maxRetries: 3,
    });

    const result = provider.generate({
      agentId: "A1",
      label: "小张",
      locale: "zh-CN",
      phase: "training",
      taskId: "training_task_1",
      learnerInput: "取消这次请求。",
      workspaceState: { currentStep: "guide" },
      fallbackText: "不应返回的 fallback",
      signal: controller.signal,
    });
    await fetchStarted;
    controller.abort();

    await expect(result).rejects.toMatchObject({ name: "AbortError" });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect((fetchMock.mock.calls[0]?.[1]?.signal as AbortSignal).aborted).toBe(true);
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
    expect(payload.model).toBe("qwen3.8-max");
    expect(payload.enable_thinking).toBe(false);
    expect(payload).not.toHaveProperty("thinking");
    expect(fetchMock.mock.calls[0]?.[1]?.headers).toMatchObject({
      authorization: "Bearer dashscope-secret-key",
    });
    expect(result.runtime).toMatchObject({
      provider: "openai-compatible",
      model: "qwen3.8-max",
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

  it("keeps the whole configured chain deterministic when a fallback endpoint is unsafe", async () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("AAIS_AI_PROVIDER", "qwen");
    vi.stubEnv("DASHSCOPE_API_KEY", "dashscope-secret-key");
    vi.stubEnv("AAIS_AI_MODEL", "qwen3.7-max");
    vi.stubEnv("AAIS_AI_EVAL_APPROVED", "true");
    vi.stubEnv("AAIS_AI_EVAL_VERSION", "eval-2026-07-19-qwen3.7-max-v1");
    vi.stubEnv(
      "AAIS_AI_FALLBACK_ENDPOINT",
      "https://fallback.example.test/v1/chat/completions?tenant=learner",
    );
    vi.stubEnv("AAIS_AI_FALLBACK_API_KEY", "fallback-secret-key");
    vi.stubEnv("AAIS_AI_FALLBACK_MODEL", "fallback-model");
    const fetchMock = vi.fn<typeof fetch>();
    vi.stubGlobal("fetch", fetchMock);

    const result = await createConfiguredAaisModelProvider().generate({
      agentId: "A1",
      label: "导学智能体",
      locale: "zh-CN",
      phase: "training",
      taskId: "training_task_1",
      learnerInput: "请给我下一步。",
      workspaceState: { currentStep: "guide" },
      fallbackText: "本地 fallback",
    });

    expect(fetchMock).not.toHaveBeenCalled();
    expect(result).toMatchObject({
      text: "本地 fallback",
      runtime: { provider: "deterministic", status: "fallback" },
    });
  });

  it("keeps Qwen 3.8 Max on deterministic production fallback when only Qwen 3.7 evaluation exists", async () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("AAIS_AI_PROVIDER", "qwen");
    vi.stubEnv("DASHSCOPE_API_KEY", "dashscope-secret-key");
    vi.stubEnv("AAIS_AI_MODEL", "qwen3.8-max");
    vi.stubEnv("AAIS_AI_EVAL_APPROVED", "true");
    vi.stubEnv("AAIS_AI_EVAL_VERSION", "eval-2026-07-19-qwen3.7-max-v1");
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
      model: "qwen3.8-max",
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
      conversationHistory: [
        {
          kind: "user",
          text: "我的卡点是高性能虚拟滚动列表。",
        },
        {
          kind: "assistant",
          text: "我们先确定最小验证目标。",
        },
      ],
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
    expect(userContext.conversationHistory).toEqual([
      {
        kind: "user",
        text: "我的卡点是高性能虚拟滚动列表。",
      },
      {
        kind: "assistant",
        text: "我们先确定最小验证目标。",
      },
    ]);
    expect(JSON.stringify(payload)).not.toContain("secret-api-key");
  });

  it("builds distinct A1 and A2 voice prompts and caps only A1's output budget", async () => {
    const fetchMock = vi.fn<typeof fetch>(async () =>
      Response.json({
        choices: [
          {
            message: {
              content: "下一步先写下目标。",
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
      agentId: "A1",
      label: "小张",
      voice: {
        persona: "亲切利落的同龄学习向导，不扮演专家。",
        tone: "温和直接，只指出下一步。",
        replyContract: "最多 2 句，不用标题或清单。",
        maxSentences: 2,
        maxCharacters: 120,
        maxOutputTokens: 120,
      },
      locale: "zh-CN",
      phase: "training",
      taskId: "training_task_1",
      learnerInput: "我应该如何开始？",
      workspaceState: {
        currentStep: "guide",
      },
      fallbackText: "先说你卡在哪一步。",
    });
    await provider.generate({
      agentId: "A2",
      label: "教授",
      voice: {
        persona: "严谨耐心的教授型专家教练。",
        tone: "用思维示范、例子和追问解释理由。",
        replyContract: "呈现专家思路、理由和一个练习提示。",
      },
      locale: "zh-CN",
      phase: "training",
      taskId: "training_task_1",
      learnerInput: "请示范专家会如何开始。",
      workspaceState: {
        currentStep: "modelling",
      },
      fallbackText: "我先示范专家如何判断目标。",
    });

    const a1Payload = JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body));
    const a2Payload = JSON.parse(String(fetchMock.mock.calls[1]?.[1]?.body));
    expect(a1Payload.max_tokens).toBe(120);
    expect(a2Payload.max_tokens).toBe(600);
    expect(a1Payload.messages[0].content).toContain("小张 (A1)");
    expect(a1Payload.messages[0].content).toContain("Hard limit: at most 2 sentences");
    expect(a1Payload.messages[0].content).toContain("不扮演专家");
    expect(a1Payload.messages[0].content).toContain("Address the learner as “你”");
    expect(a2Payload.messages[0].content).toContain("教授 (A2)");
    expect(a2Payload.messages[0].content).toContain("教授型专家教练");
    expect(a2Payload.messages[0].content).toContain("never call the learner 小张 or 教授");
    expect(a2Payload.messages[0].content).not.toContain("Hard limit: at most 2 sentences");
    expect(a1Payload.messages[0].content).not.toBe(a2Payload.messages[0].content);
  });

  it("falls back when an A1 response breaks its concise reply contract", async () => {
    const fetchMock = vi.fn<typeof fetch>(async () =>
      Response.json({
        choices: [
          {
            message: {
              content: "第一句先解释背景。第二句继续解释。第三句仍然展开很多内容。",
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
      label: "小张",
      voice: {
        persona: "简短的学习向导。",
        tone: "温和直接。",
        replyContract: "最多 2 句。",
        maxSentences: 2,
        maxCharacters: 24,
        maxOutputTokens: 120,
      },
      locale: "zh-CN",
      phase: "training",
      taskId: "training_task_1",
      learnerInput: "我应该如何开始？",
      workspaceState: {
        currentStep: "guide",
      },
      fallbackText: "先写下目标，我再帮你看下一步。",
    });

    expect(result.text).toBe("先写下目标，我再帮你看下一步。");
    expect(result.runtime).toMatchObject({
      status: "fallback",
      guardrail: {
        status: "blocked",
        reasons: expect.arrayContaining([
          "agent-response-too-long",
          "agent-response-too-many-sentences",
        ]),
      },
    });
  });
});
