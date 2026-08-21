import { generateKeyPairSync, sign } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createConfiguredAaisModelProvider,
  createOpenAiCompatibleAaisProvider,
  preflightConfiguredAaisModelProvider,
} from "@/lib/ai/aais-ai-provider";
import {
  createAaisGuidePublicError,
  isAaisGuideDeliveryError,
} from "@/lib/ai/aais-guide-delivery";
import {
  createManualAaisAiRuntimeProfile,
  getAaisAiObservedRevisionSha256,
  readAaisGuideDeliveryPolicy,
  readAaisAiRuntimeConfig,
  studentRuntimeMaxRetries,
} from "@/lib/ai/aais-ai-runtime-config";
import { aaisCognitiveApprenticeshipBackground } from "@/data/aais";
import {
  createAaisAiEvalManifestSha256,
  createAaisAiEvalManifestSigningPayload,
  getAaisAiEvalApproval,
} from "@/lib/server/aais-ai-eval-manifest";
import qwen37MaxEvalManifest from "@/data/aais-ai-eval-qwen3.7-max.json";

const sourceLockEligibilityState = vi.hoisted(() => ({
  releaseState: "RELEASE_VERIFIED" as "RELEASE_VERIFIED" | "RELEASE_BLOCKED",
  primaryEligible: true,
  fallbackEligible: true,
}));

vi.mock("@/lib/server/aais-ai-release-lock", async () => {
  const actual = await vi.importActual<
    typeof import("@/lib/server/aais-ai-release-lock")
  >("@/lib/server/aais-ai-release-lock");
  return {
    ...actual,
    getAaisAiSourceLockEligibility: vi.fn(() => ({
      releaseState: sourceLockEligibilityState.releaseState,
      primary: { eligible: sourceLockEligibilityState.primaryEligible },
      fallback: { eligible: sourceLockEligibilityState.fallbackEligible },
    })),
  };
});

const qwenObservedRevision = "synthetic-qwen-revision-2026-08-21";
const deepSeekObservedRevision = "synthetic-deepseek-revision-2026-08-21";
const evalSigningKeyId = "synthetic-provider-test-eval-key-v1";
const { publicKey: evalPublicKey, privateKey: evalPrivateKey } =
  generateKeyPairSync("ed25519");
const evalVerifyingKeySpki = evalPublicKey.export({
  format: "der",
  type: "spki",
}).toString("base64");

function stubProductionQwenObservationConstraint() {
  vi.stubEnv(
    "AAIS_AI_ENDPOINT",
    "https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions",
  );
  vi.stubEnv("AAIS_AI_THINKING_MODE", "disabled");
  vi.stubEnv("AAIS_AI_TIMEOUT_MS", "12000");
  vi.stubEnv("AAIS_AI_MAX_RETRIES", "0");
  vi.stubEnv(
    "AAIS_AI_OBSERVED_REVISION_SHA256",
    getAaisAiObservedRevisionSha256(qwenObservedRevision),
  );
}

function passingEvalManifest(
  model: string,
  evalVersion: string,
  evidenceWindow: {
    passedAt?: string;
    expiresAt?: string;
  } = {},
) {
  const manifest = {
    schemaVersion: 1,
    model,
    evalVersion,
    provider: model.startsWith("deepseek")
      ? "deepseek"
      : model.startsWith("qwen")
        ? "qwen"
        : "openai-compatible",
    status: "passed",
    passedAt: evidenceWindow.passedAt ?? "2026-08-20T00:00:00.000Z",
    expiresAt: evidenceWindow.expiresAt ?? "2026-09-19T00:00:00.000Z",
    sampleCount: 4,
    blockedCount: 0,
    agentEvidence: qwen37MaxEvalManifest.agentEvidence,
    releaseEvidence: {
      contractVersion: "aais-ai-eval-release-v1",
      runtimeContract: {
        endpointFingerprint: "1".repeat(64),
        thinkingMode: "disabled",
        temperature: 0.2,
        maxTokens: 600,
        observedRevisionSha256: "2".repeat(64),
      },
      evalSuiteSha256: "3".repeat(64),
      evalDataSha256: "4".repeat(64),
      agentPromptContractSha256: {
        A1: "5".repeat(64),
        A2: "6".repeat(64),
        A3: "7".repeat(64),
        A4: "8".repeat(64),
      },
      caBackgroundSha256: "9".repeat(64),
      guardrailSha256: "a".repeat(64),
      localeCoverage: {
        requiredLocales: ["zh-CN", "en-US"],
        coveredLocales: ["zh-CN", "en-US"],
        agentLocales: {
          A1: ["zh-CN", "en-US"],
          A2: ["zh-CN", "en-US"],
          A3: ["zh-CN", "en-US"],
          A4: ["zh-CN", "en-US"],
        },
        complete: true,
      },
    },
    attestation: {
      algorithm: "ed25519",
      keyId: evalSigningKeyId,
      signature: "",
    },
    redaction: {
      prompts: "summarized",
      secrets: "omitted",
    },
  };
  manifest.attestation.signature = sign(
    null,
    Buffer.from(createAaisAiEvalManifestSigningPayload(manifest), "utf8"),
    evalPrivateKey,
  ).toString("base64");
  return manifest;
}

function stubApprovedEval(
  role: "primary" | "fallback",
  model: string,
  evalVersion: string,
  evidenceWindow?: {
    passedAt?: string;
    expiresAt?: string;
  },
) {
  const manifest = passingEvalManifest(model, evalVersion, evidenceWindow);
  const prefix = role === "fallback" ? "AAIS_AI_FALLBACK_EVAL" : "AAIS_AI_EVAL";
  vi.stubEnv(`${prefix}_APPROVED`, "true");
  vi.stubEnv(`${prefix}_VERSION`, evalVersion);
  vi.stubEnv(`${prefix}_MANIFEST_JSON`, JSON.stringify(manifest));
  vi.stubEnv(`${prefix}_MANIFEST_SHA256`, createAaisAiEvalManifestSha256(manifest));
  vi.stubEnv(`${prefix}_SIGNING_KEY_ID`, evalSigningKeyId);
  vi.stubEnv(`${prefix}_VERIFYING_KEY_SPKI`, evalVerifyingKeySpki);
}

function stubProductionEvaluatedQwenDeepSeekChain() {
  vi.stubEnv("NODE_ENV", "production");
  vi.stubEnv("AAIS_AI_RUNTIME_MODE", "live-required");
  vi.stubEnv("AAIS_AI_PROVIDER", "qwen");
  stubProductionQwenObservationConstraint();
  vi.stubEnv("DASHSCOPE_API_KEY", "dashscope-secret-key");
  vi.stubEnv("AAIS_AI_MODEL", "qwen3.8-max");
  vi.stubEnv("AAIS_AI_MAX_RETRIES", "0");
  stubApprovedEval("primary", "qwen3.8-max", "synthetic-qwen3.8-max-eval-v1");
  vi.stubEnv("AAIS_AI_FALLBACK_PROVIDER", "deepseek");
  vi.stubEnv("AAIS_AI_FALLBACK_ENABLED", "true");
  vi.stubEnv("AAIS_AI_FALLBACK_ENDPOINT", "https://api.deepseek.com/chat/completions");
  vi.stubEnv("AAIS_AI_FALLBACK_API_KEY", "deepseek-secret-key");
  vi.stubEnv("AAIS_AI_FALLBACK_MODEL", "deepseek-v4-flash");
  vi.stubEnv("AAIS_AI_FALLBACK_THINKING_MODE", "disabled");
  vi.stubEnv("AAIS_AI_FALLBACK_TIMEOUT_MS", "12000");
  vi.stubEnv(
    "AAIS_AI_FALLBACK_OBSERVED_REVISION_SHA256",
    getAaisAiObservedRevisionSha256(deepSeekObservedRevision),
  );
  vi.stubEnv("AAIS_AI_FALLBACK_MAX_RETRIES", "0");
  stubApprovedEval("fallback", "deepseek-v4-flash", "synthetic-deepseek-v4-flash-eval-v1");
}

afterEach(() => {
  sourceLockEligibilityState.releaseState = "RELEASE_VERIFIED";
  sourceLockEligibilityState.primaryEligible = true;
  sourceLockEligibilityState.fallbackEligible = true;
  vi.useRealTimers();
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
          reasons: ["invalid-response"],
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
    "https://api.deepseek.com/chat/completions",
    "https://dashscope.aliyuncs.com/compatible-mode/v1/responses",
  ])("marks unsafe production AI endpoint configuration invalid: %s", (endpoint) => {
    const configured = readAaisAiRuntimeConfig({
      ...process.env,
      NODE_ENV: "production",
      AAIS_AI_RUNTIME_MODE: "live-required",
      AAIS_AI_PROVIDER: "qwen",
      AAIS_AI_ENDPOINT: endpoint,
      DASHSCOPE_API_KEY: "secret-api-key",
      AAIS_AI_MODEL: "qwen3.8-max",
      AAIS_AI_THINKING_MODE: "disabled",
      AAIS_AI_TIMEOUT_MS: "12000",
      AAIS_AI_MAX_RETRIES: "0",
      AAIS_AI_OBSERVED_REVISION_SHA256: getAaisAiObservedRevisionSha256(qwenObservedRevision),
    });

    expect(configured.configurationStatus.primary).toBe("invalid");
    expect(configured.primary).toBeNull();
    expect(configured.profile.mode).toBe("deterministic");
  });

  it("forces live-required delivery in production and rejects an attempted deterministic override", () => {
    const env = {
      NODE_ENV: "production",
      AAIS_AI_RUNTIME_MODE: "allow-deterministic",
    } as NodeJS.ProcessEnv;

    expect(readAaisGuideDeliveryPolicy(env)).toBe("require-live");
    expect(readAaisAiRuntimeConfig(env)).toMatchObject({
      deliveryPolicy: "require-live",
      configurationStatus: {
        runtimeMode: "invalid",
      },
      profile: {
        deliveryPolicy: "require-live",
      },
    });
    expect(() => preflightConfiguredAaisModelProvider(env)).toThrowError(
      expect.objectContaining({
        code: "AAIS_AI_PROVIDER_CONFIGURATION_INVALID",
        status: 503,
      }),
    );
  });

  it("fails closed when production omits the required explicit runtime mode", () => {
    expect(() => preflightConfiguredAaisModelProvider({
      NODE_ENV: "production",
    } as NodeJS.ProcessEnv)).toThrowError(expect.objectContaining({
      code: "AAIS_AI_PROVIDER_CONFIGURATION_INVALID",
      status: 503,
      retryable: false,
      gateReason: "runtime-mode-missing",
    }));
  });

  it("rejects an implicit Production Qwen model even when provider and key are present", () => {
    const env = {
      NODE_ENV: "production",
      AAIS_AI_RUNTIME_MODE: "live-required",
      AAIS_AI_PROVIDER: "qwen",
      AAIS_AI_ENDPOINT: "https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions",
      DASHSCOPE_API_KEY: "synthetic-qwen-key",
      AAIS_AI_THINKING_MODE: "disabled",
      AAIS_AI_TIMEOUT_MS: "12000",
      AAIS_AI_MAX_RETRIES: "0",
      AAIS_AI_OBSERVED_REVISION_SHA256: getAaisAiObservedRevisionSha256(qwenObservedRevision),
    } as NodeJS.ProcessEnv;
    const configured = readAaisAiRuntimeConfig(env);

    expect(configured.configurationStatus.primary).toBe("invalid");
    expect(configured.primary).toBeNull();
    expect(() => preflightConfiguredAaisModelProvider(env)).toThrowError(
      expect.objectContaining({
        code: "AAIS_AI_LIVE_PROVIDER_REQUIRED",
        gateReason: "configuration-missing",
      }),
    );
  });

  it("does not accept the legacy Qwen 3.7 model as a Production primary candidate", () => {
    const configured = readAaisAiRuntimeConfig({
      NODE_ENV: "production",
      AAIS_AI_RUNTIME_MODE: "live-required",
      AAIS_AI_PROVIDER: "qwen",
      DASHSCOPE_API_KEY: "synthetic-qwen-key",
      AAIS_AI_MODEL: "qwen3.7-max",
      AAIS_AI_OBSERVED_REVISION_SHA256: getAaisAiObservedRevisionSha256(qwenObservedRevision),
    } as NodeJS.ProcessEnv);

    expect(configured.configurationStatus.primary).toBe("invalid");
    expect(configured.primary).toBeNull();
  });

  it("requires the complete explicit Qwen 3.8 Production runtime contract", () => {
    const valid: NodeJS.ProcessEnv = {
      NODE_ENV: "production",
      AAIS_AI_RUNTIME_MODE: "live-required",
      AAIS_AI_PROVIDER: "qwen",
      AAIS_AI_ENDPOINT: "https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions",
      DASHSCOPE_API_KEY: "synthetic-qwen-key",
      AAIS_AI_MODEL: "qwen3.8-max",
      AAIS_AI_THINKING_MODE: "disabled",
      AAIS_AI_TIMEOUT_MS: "12000",
      AAIS_AI_MAX_RETRIES: "0",
      AAIS_AI_OBSERVED_REVISION_SHA256: getAaisAiObservedRevisionSha256(qwenObservedRevision),
    };

    expect(readAaisAiRuntimeConfig(valid).configurationStatus.primary).toBe("valid");
    for (const omitted of [
      "AAIS_AI_PROVIDER",
      "AAIS_AI_ENDPOINT",
      "AAIS_AI_MODEL",
      "AAIS_AI_THINKING_MODE",
      "AAIS_AI_TIMEOUT_MS",
      "AAIS_AI_MAX_RETRIES",
    ] as const) {
      const incomplete: NodeJS.ProcessEnv = { ...valid };
      delete incomplete[omitted];
      expect(readAaisAiRuntimeConfig(incomplete).configurationStatus.primary).toBe("invalid");
    }
    expect(readAaisAiRuntimeConfig({
      ...valid,
      AAIS_AI_TIMEOUT_MS: "12001",
    }).configurationStatus.primary).toBe("invalid");
    expect(readAaisAiRuntimeConfig({
      ...valid,
      AAIS_AI_MAX_RETRIES: "1",
    }).configurationStatus.primary).toBe("invalid");
    expect(readAaisAiRuntimeConfig({
      ...valid,
      AAIS_AI_PROVIDER: "dashscope",
    }).configurationStatus.primary).toBe("invalid");
  });

  it("accepts only the atomic explicit DeepSeek secondary contract in Production", () => {
    const valid = {
      NODE_ENV: "production",
      AAIS_AI_RUNTIME_MODE: "live-required",
      AAIS_AI_FALLBACK_ENABLED: "true",
      AAIS_AI_FALLBACK_PROVIDER: "deepseek",
      AAIS_AI_FALLBACK_ENDPOINT: "https://api.deepseek.com/chat/completions",
      AAIS_AI_FALLBACK_API_KEY: "synthetic-deepseek-key",
      AAIS_AI_FALLBACK_MODEL: "deepseek-v4-flash",
      AAIS_AI_FALLBACK_THINKING_MODE: "disabled",
      AAIS_AI_FALLBACK_TIMEOUT_MS: "12000",
      AAIS_AI_FALLBACK_MAX_RETRIES: "0",
      AAIS_AI_FALLBACK_OBSERVED_REVISION_SHA256:
        getAaisAiObservedRevisionSha256(deepSeekObservedRevision),
    } as NodeJS.ProcessEnv;

    expect(readAaisAiRuntimeConfig(valid).configurationStatus.fallback).toBe("valid");
    const compatibleBooleanThinking: NodeJS.ProcessEnv = { ...valid };
    delete compatibleBooleanThinking.AAIS_AI_FALLBACK_THINKING_MODE;
    compatibleBooleanThinking.AAIS_AI_FALLBACK_THINKING = "false";
    expect(readAaisAiRuntimeConfig(compatibleBooleanThinking).configurationStatus.fallback)
      .toBe("valid");
    expect(readAaisAiRuntimeConfig({
      ...valid,
      AAIS_AI_FALLBACK_THINKING: "true",
    }).configurationStatus.fallback).toBe("invalid");
    for (const omitted of [
      "AAIS_AI_FALLBACK_ENABLED",
      "AAIS_AI_FALLBACK_PROVIDER",
      "AAIS_AI_FALLBACK_MODEL",
      "AAIS_AI_FALLBACK_THINKING_MODE",
      "AAIS_AI_FALLBACK_TIMEOUT_MS",
      "AAIS_AI_FALLBACK_MAX_RETRIES",
    ] as const) {
      const incomplete: NodeJS.ProcessEnv = { ...valid };
      delete incomplete[omitted];
      expect(readAaisAiRuntimeConfig(incomplete).configurationStatus.fallback).toBe("invalid");
    }
    expect(readAaisAiRuntimeConfig({
      ...valid,
      AAIS_AI_FALLBACK_ENDPOINT: "https://api.deepseek.com/v1/chat/completions",
    }).configurationStatus.fallback).toBe("invalid");
    expect(readAaisAiRuntimeConfig({
      ...valid,
      AAIS_AI_FALLBACK_ENABLED: "false",
    }).configurationStatus.fallback).toBe("invalid");
    expect(readAaisAiRuntimeConfig({
      NODE_ENV: "production",
      AAIS_AI_RUNTIME_MODE: "live-required",
      AAIS_AI_FALLBACK_ENABLED: "false",
    }).configurationStatus.fallback).toBe("missing");
  });

  it("keeps deterministic delivery available outside production with an explicit receipt", async () => {
    const preflight = preflightConfiguredAaisModelProvider({
      NODE_ENV: "test",
    } as NodeJS.ProcessEnv);
    const result = await preflight.provider.generate({
      agentId: "A1",
      label: "小张",
      locale: "zh-CN",
      phase: "training",
      taskId: "training_task_1",
      learnerInput: "给我一个本地测试提示。",
      workspaceState: { currentStep: "guide" },
      fallbackText: "本地测试支架",
    });

    expect(preflight.deliveryPolicy).toBe("allow-deterministic");
    expect(result).toMatchObject({
      text: "本地测试支架",
      runtime: {
        status: "fallback",
        delivery: {
          schemaVersion: 1,
          mode: "deterministic",
          channel: "deterministic",
          degraded: true,
          observedModel: "not-reported",
          attempts: [],
        },
      },
    });
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

  it.each([
    { status: 400, reason: "invalid-request" },
    { status: 401, reason: "auth-failed" },
    { status: 402, reason: "payment-required" },
    { status: 403, reason: "auth-failed" },
    { status: 404, reason: "upstream-4xx" },
    { status: 422, reason: "invalid-request" },
  ])("does not retry permanent upstream status $status and emits $reason", async ({
    status,
    reason,
  }) => {
    const fetchMock = vi.fn<typeof fetch>(async () =>
      new Response("provider-body-canary-must-not-escape", { status }));
    const provider = createOpenAiCompatibleAaisProvider({
      endpoint: "https://ai.example.test/v1/chat/completions",
      apiKey: "secret-api-key",
      model: "enterprise-model",
      fetchImpl: fetchMock,
      timeoutMs: 1_000,
      maxRetries: 3,
    });

    const result = await provider.generate({
      agentId: "A1",
      label: "小张",
      locale: "zh-CN",
      phase: "training",
      taskId: "training_task_1",
      learnerInput: "请继续。",
      workspaceState: { currentStep: "guide" },
      fallbackText: "本地测试支架",
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(result.runtime).toMatchObject({
      status: "fallback",
      guardrail: { reasons: [reason] },
      delivery: {
        mode: "deterministic",
        attempts: [{ reason, attempts: 1 }],
      },
    });
    expect(JSON.stringify(result)).not.toContain("provider-body-canary-must-not-escape");
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
    vi.stubEnv("AAIS_AI_FALLBACK_PROVIDER", "deepseek");
    const fetchMock = vi.fn<typeof fetch>(async (url) => {
      if (String(url).includes("qwen.example.test")) {
        throw Object.assign(new TypeError("fetch failed"), {
          cause: {
            code: "UND_ERR_CONNECT_TIMEOUT",
          },
        });
      }
      return Response.json({
        model: "deepseek-v4-pro",
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
      delivery: {
        schemaVersion: 1,
        mode: "live",
        channel: "secondary",
        degraded: true,
        observedModel: "matched",
        attempts: [
          {
            role: "primary",
            outcome: "failed",
            reason: "connect-timeout",
          },
          {
            role: "fallback",
            outcome: "succeeded",
            observedModel: "matched",
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
    vi.stubEnv("AAIS_AI_MODEL", "qwen3.8-max");
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
          reasons: ["upstream-5xx"],
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
          reasons: ["connect-timeout"],
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

  it("fails closed in production instead of returning deterministic content before evaluation approval", () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("AAIS_AI_RUNTIME_MODE", "live-required");
    stubProductionQwenObservationConstraint();
    vi.stubEnv("AAIS_AI_PROVIDER", "qwen");
    vi.stubEnv("DASHSCOPE_API_KEY", "secret-api-key");
    vi.stubEnv("AAIS_AI_MODEL", "qwen3.8-max");
    const fetchMock = vi.fn<typeof fetch>();
    vi.stubGlobal("fetch", fetchMock);

    let thrown: unknown;
    try {
      createConfiguredAaisModelProvider();
    } catch (error) {
      thrown = error;
    }
    expect(fetchMock).not.toHaveBeenCalled();
    expect(isAaisGuideDeliveryError(thrown)).toBe(true);
    expect(thrown).toMatchObject({
      code: "AAIS_AI_MODEL_EVALUATION_REQUIRED",
      status: 503,
      retryable: false,
      learnerAction: "contact-support",
    });
    if (!isAaisGuideDeliveryError(thrown)) {
      throw new Error("Expected a governed delivery error.");
    }
    expect(createAaisGuidePublicError(thrown, "zh-CN")).toMatchObject({
      schemaVersion: 1,
      code: "AAIS_AI_MODEL_EVALUATION_REQUIRED",
      retryable: false,
      learnerAction: "contact-support",
    });
    expect(JSON.stringify(createAaisGuidePublicError(thrown))).not.toContain("secret-api-key");
  });

  it("skips an unsafe secondary while an approved primary remains eligible", async () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("AAIS_AI_RUNTIME_MODE", "live-required");
    stubProductionQwenObservationConstraint();
    vi.stubEnv("AAIS_AI_PROVIDER", "qwen");
    vi.stubEnv("DASHSCOPE_API_KEY", "dashscope-secret-key");
    vi.stubEnv("AAIS_AI_MODEL", "qwen3.8-max");
    stubApprovedEval("primary", "qwen3.8-max", "synthetic-qwen3.8-max-eval-v1");
    vi.stubEnv(
      "AAIS_AI_FALLBACK_ENDPOINT",
      "https://fallback.example.test/v1/chat/completions?tenant=learner",
    );
    vi.stubEnv("AAIS_AI_FALLBACK_API_KEY", "fallback-secret-key");
    vi.stubEnv("AAIS_AI_FALLBACK_MODEL", "fallback-model");
    const fetchMock = vi.fn<typeof fetch>(async () => Response.json({
      model: "qwen3.8-max",
      system_fingerprint: qwenObservedRevision,
      choices: [{ message: { content: "Primary remained live" } }],
    }));
    vi.stubGlobal("fetch", fetchMock);

    const preflight = preflightConfiguredAaisModelProvider();
    const result = await preflight.provider.generate({
      agentId: "A1",
      label: "小张",
      locale: "zh-CN",
      phase: "training",
      taskId: "training_task_1",
      learnerInput: "请给我下一步。",
      workspaceState: { currentStep: "guide" },
      fallbackText: "不应返回的本地支架",
    });

    expect(preflight.configurationStatus.fallback).toBe("invalid");
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(result).toMatchObject({
      text: "Primary remained live",
      runtime: {
        status: "ok",
        delivery: {
          mode: "live",
          channel: "primary",
          degraded: false,
          attempts: [
            { role: "primary", outcome: "succeeded" },
            {
              role: "fallback",
              outcome: "skipped",
              attempts: 0,
              gateReason: "endpoint-not-allowed",
            },
          ],
        },
      },
    });
  });

  it("rejects Qwen 3.8 Max when only Qwen 3.7 evaluation evidence exists", () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("AAIS_AI_RUNTIME_MODE", "live-required");
    stubProductionQwenObservationConstraint();
    vi.stubEnv("AAIS_AI_PROVIDER", "qwen");
    vi.stubEnv("DASHSCOPE_API_KEY", "dashscope-secret-key");
    vi.stubEnv("AAIS_AI_MODEL", "qwen3.8-max");
    stubApprovedEval("primary", "qwen3.7-max", "synthetic-qwen3.7-max-eval-v1");
    const fetchMock = vi.fn<typeof fetch>();
    vi.stubGlobal("fetch", fetchMock);

    expect(() => createConfiguredAaisModelProvider()).toThrowError(
      expect.objectContaining({
        code: "AAIS_AI_MODEL_EVALUATION_REQUIRED",
        status: 503,
      }),
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("surfaces expired evaluation evidence as a fixed preflight gate reason", () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("AAIS_AI_RUNTIME_MODE", "live-required");
    stubProductionQwenObservationConstraint();
    vi.stubEnv("AAIS_AI_PROVIDER", "qwen");
    vi.stubEnv("DASHSCOPE_API_KEY", "dashscope-secret-key");
    vi.stubEnv("AAIS_AI_MODEL", "qwen3.8-max");
    stubApprovedEval(
      "primary",
      "qwen3.8-max",
      "synthetic-expired-qwen3.8-max-eval-v1",
      {
        passedAt: "2026-07-20T00:00:00.000Z",
        expiresAt: "2026-08-19T00:00:00.000Z",
      },
    );

    expect(() => preflightConfiguredAaisModelProvider()).toThrowError(
      expect.objectContaining({
        code: "AAIS_AI_MODEL_EVALUATION_REQUIRED",
        gateReason: "evaluation-expired",
        attempts: expect.arrayContaining([
          expect.objectContaining({
            role: "primary",
            outcome: "skipped",
            gateReason: "evaluation-expired",
          }),
        ]),
      }),
    );
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

  it("validates primary and secondary evaluation manifests independently with canonical digests", () => {
    const primaryManifest = passingEvalManifest(
      "qwen3.8-max",
      "synthetic-qwen3.8-max-eval-v1",
    );
    const fallbackManifest = passingEvalManifest(
      "deepseek-v4-flash",
      "synthetic-deepseek-v4-flash-eval-v1",
    );
    const env = {
      NODE_ENV: "test",
      AAIS_AI_EVAL_APPROVED: "true",
      AAIS_AI_EVAL_VERSION: "synthetic-qwen3.8-max-eval-v1",
      AAIS_AI_EVAL_MANIFEST_JSON: JSON.stringify(primaryManifest),
      AAIS_AI_EVAL_MANIFEST_SHA256: createAaisAiEvalManifestSha256(primaryManifest),
      AAIS_AI_EVAL_SIGNING_KEY_ID: evalSigningKeyId,
      AAIS_AI_EVAL_VERIFYING_KEY_SPKI: evalVerifyingKeySpki,
      AAIS_AI_FALLBACK_EVAL_APPROVED: "true",
      AAIS_AI_FALLBACK_EVAL_VERSION: "synthetic-deepseek-v4-flash-eval-v1",
      AAIS_AI_FALLBACK_EVAL_MANIFEST_JSON: JSON.stringify(fallbackManifest, null, 2),
      AAIS_AI_FALLBACK_EVAL_MANIFEST_SHA256:
        createAaisAiEvalManifestSha256(fallbackManifest),
      AAIS_AI_FALLBACK_EVAL_SIGNING_KEY_ID: evalSigningKeyId,
      AAIS_AI_FALLBACK_EVAL_VERIFYING_KEY_SPKI: evalVerifyingKeySpki,
    } as NodeJS.ProcessEnv;

    const primary = getAaisAiEvalApproval({
      required: true,
      provider: "qwen",
      model: "qwen3.8-max",
      providerRole: "primary",
      env,
    });
    const fallback = getAaisAiEvalApproval({
      required: true,
      provider: "deepseek",
      model: "deepseek-v4-flash",
      providerRole: "fallback",
      env,
    });

    expect(primary).toMatchObject({
      approved: true,
      manifest: {
        status: "verified",
        source: "configured",
        passedAt: "2026-08-20T00:00:00.000Z",
        manifestSha256: expect.stringMatching(/^[a-f0-9]{64}$/),
      },
    });
    expect(fallback).toMatchObject({
      approved: true,
      manifest: {
        status: "verified",
        source: "configured",
        passedAt: "2026-08-20T00:00:00.000Z",
        manifestSha256: expect.stringMatching(/^[a-f0-9]{64}$/),
      },
    });
    expect(primary.manifest.manifestSha256).not.toBe(fallback.manifest.manifestSha256);
  });

  it("uses an independently approved DeepSeek secondary after a transient primary failure", async () => {
    stubProductionEvaluatedQwenDeepSeekChain();
    const fetchMock = vi.fn<typeof fetch>(async (url) => {
      if (String(url).includes("dashscope.aliyuncs.com")) {
        return new Response("primary unavailable", { status: 503 });
      }
      return Response.json({
        model: "deepseek-v4-flash",
        system_fingerprint: deepSeekObservedRevision,
        choices: [{ message: { content: "DeepSeek live secondary response" } }],
      });
    });
    vi.stubGlobal("fetch", fetchMock);

    const preflight = preflightConfiguredAaisModelProvider();
    const result = await preflight.provider.generate({
      agentId: "A1",
      label: "小张",
      locale: "zh-CN",
      phase: "training",
      taskId: "training_task_1",
      learnerInput: "我应该如何开始？",
      workspaceState: { currentStep: "guide" },
      fallbackText: "不应返回的本地支架",
      diagnosticId: "operation-live-failover-001",
    });

    expect(preflight.evaluation.primary?.approved).toBe(true);
    expect(preflight.evaluation.fallback?.approved).toBe(true);
    expect(fetchMock.mock.calls.map(([url]) => String(url))).toEqual([
      "https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions",
      "https://api.deepseek.com/chat/completions",
    ]);
    const deepSeekPayload = JSON.parse(String(fetchMock.mock.calls[1]?.[1]?.body));
    expect(deepSeekPayload).toMatchObject({
      model: "deepseek-v4-flash",
      thinking: { type: "disabled" },
    });
    expect(deepSeekPayload).not.toHaveProperty("enable_thinking");
    expect(result).toMatchObject({
      text: "DeepSeek live secondary response",
      runtime: {
        status: "ok",
        providerChain: {
          selected: "fallback",
          failures: [{ provider: "primary", reason: "upstream-5xx" }],
        },
        runtimeProfile: {
          primary: {
            maxRetries: 0,
          },
          fallback: {
            provider: "deepseek",
            thinkingMode: "disabled",
            maxRetries: 0,
          },
        },
        delivery: {
          mode: "live",
          channel: "secondary",
          degraded: true,
          diagnosticId: "operation-live-failover-001",
          observedModel: "matched",
          attempts: [
            {
              role: "primary",
              outcome: "failed",
              reason: "upstream-5xx",
              observedModel: "not-reported",
            },
            {
              role: "fallback",
              outcome: "succeeded",
              observedModel: "matched",
              observedRevision: "matched",
              observedRevisionSha256: getAaisAiObservedRevisionSha256(deepSeekObservedRevision),
            },
          ],
        },
      },
    });
    expect(JSON.stringify(result)).not.toContain("dashscope-secret-key");
    expect(JSON.stringify(result)).not.toContain("deepseek-secret-key");
    expect(JSON.stringify(result)).not.toContain(deepSeekObservedRevision);
  });

  it.each([
    {
      finishReason: "content_filter",
      expectedReason: "guardrail-blocked",
      expectedOutcome: "blocked",
    },
    {
      finishReason: "insufficient_system_resource",
      expectedReason: "upstream-5xx",
      expectedOutcome: "failed",
    },
  ])("fails over without delivering partial content for finish_reason=$finishReason", async ({
    finishReason,
    expectedReason,
    expectedOutcome,
  }) => {
    stubProductionEvaluatedQwenDeepSeekChain();
    const fetchMock = vi.fn<typeof fetch>(async (url) =>
      String(url).includes("dashscope")
        ? Response.json({
            model: "qwen3.8-max",
            system_fingerprint: qwenObservedRevision,
            choices: [{
              finish_reason: finishReason,
              message: { content: "PARTIAL_PRIMARY_OUTPUT_MUST_NOT_ESCAPE" },
            }],
          })
        : Response.json({
            model: "deepseek-v4-flash",
            system_fingerprint: deepSeekObservedRevision,
            choices: [{
              finish_reason: "stop",
              message: { content: "Safe secondary completion" },
            }],
          }));
    vi.stubGlobal("fetch", fetchMock);

    const result = await createConfiguredAaisModelProvider().generate({
      agentId: "A1",
      label: "小张",
      locale: "zh-CN",
      phase: "training",
      taskId: "training_task_1",
      learnerInput: "请继续。",
      workspaceState: { currentStep: "guide" },
      fallbackText: "不应返回的本地支架",
    });

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(result).toMatchObject({
      text: "Safe secondary completion",
      runtime: {
        delivery: {
          channel: "secondary",
          attempts: [
            {
              role: "primary",
              outcome: expectedOutcome,
              attempts: 1,
              reason: expectedReason,
            },
            { role: "fallback", outcome: "succeeded", attempts: 1 },
          ],
        },
      },
    });
    expect(JSON.stringify(result)).not.toContain("PARTIAL_PRIMARY_OUTPUT_MUST_NOT_ESCAPE");
  });

  it.each([
    {
      label: "missing",
      systemFingerprint: undefined,
      reason: "observed-revision-missing",
      observedRevision: "missing",
    },
    {
      label: "mismatched",
      systemFingerprint: "unexpected-primary-revision-must-not-leak",
      reason: "observed-revision-mismatch",
      observedRevision: "mismatch",
    },
  ])("fails over when the primary observed revision is $label", async ({
    systemFingerprint,
    reason,
    observedRevision,
  }) => {
    stubProductionEvaluatedQwenDeepSeekChain();
    const fetchMock = vi.fn<typeof fetch>(async (url) =>
      String(url).includes("dashscope")
        ? Response.json({
            model: "qwen3.8-max",
            ...(systemFingerprint ? { system_fingerprint: systemFingerprint } : {}),
            choices: [{ message: { content: "Primary revision was not approved" } }],
          })
        : Response.json({
            model: "deepseek-v4-flash",
            system_fingerprint: deepSeekObservedRevision,
            choices: [{ message: { content: "Revision-verified secondary" } }],
          }));
    vi.stubGlobal("fetch", fetchMock);

    const result = await createConfiguredAaisModelProvider().generate({
      agentId: "A1",
      label: "小张",
      locale: "zh-CN",
      phase: "training",
      taskId: "training_task_1",
      learnerInput: "请继续。",
      workspaceState: { currentStep: "guide" },
      fallbackText: "不应返回的本地支架",
    });

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(result).toMatchObject({
      text: "Revision-verified secondary",
      runtime: {
        delivery: {
          channel: "secondary",
          attempts: [
            {
              role: "primary",
              reason,
              observedModel: "matched",
              observedRevision,
            },
            { role: "fallback", outcome: "succeeded", observedRevision: "matched" },
          ],
        },
      },
    });
    expect(JSON.stringify(result)).not.toContain("unexpected-primary-revision-must-not-leak");
    expect(JSON.stringify(result)).not.toContain("Primary revision was not approved");
  });

  it("blocks delivery when every live channel fails observed-revision verification", async () => {
    stubProductionEvaluatedQwenDeepSeekChain();
    const fetchMock = vi.fn<typeof fetch>(async (url) => Response.json({
      model: String(url).includes("dashscope") ? "qwen3.8-max" : "deepseek-v4-flash",
      system_fingerprint: "unapproved-observed-revision-must-not-leak",
      choices: [{ message: { content: "Unverified revision output" } }],
    }));
    vi.stubGlobal("fetch", fetchMock);

    let thrown: unknown;
    try {
      await createConfiguredAaisModelProvider().generate({
        agentId: "A1",
        label: "小张",
        locale: "zh-CN",
        phase: "training",
        taskId: "training_task_1",
        learnerInput: "请继续。",
        workspaceState: { currentStep: "guide" },
        fallbackText: "不应返回的本地支架",
      });
    } catch (error) {
      thrown = error;
    }

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(thrown).toMatchObject({
      code: "AAIS_AI_OBSERVED_MODEL_MISMATCH",
      attempts: [
        { role: "primary", reason: "observed-revision-mismatch" },
        { role: "fallback", reason: "observed-revision-mismatch" },
      ],
    });
    expect(JSON.stringify(thrown)).not.toContain("unapproved-observed-revision-must-not-leak");
    expect(JSON.stringify(thrown)).not.toContain("Unverified revision output");
  });

  it("shortens the secondary timeout to the remaining provider budget", async () => {
    vi.useFakeTimers();
    stubProductionEvaluatedQwenDeepSeekChain();
    const startedAt = Date.now();
    const callStartedAt: number[] = [];
    const fetchMock = vi.fn<typeof fetch>((_url, init) => {
      callStartedAt.push(Date.now());
      const signal = init?.signal as AbortSignal;
      return new Promise<Response>((_resolve, reject) => {
        signal.addEventListener("abort", () => reject(signal.reason), { once: true });
      });
    });
    vi.stubGlobal("fetch", fetchMock);

    const pending = createConfiguredAaisModelProvider().generate({
      agentId: "A1",
      label: "小张",
      locale: "zh-CN",
      phase: "training",
      taskId: "training_task_1",
      learnerInput: "请继续。",
      workspaceState: { currentStep: "guide" },
      fallbackText: "不应返回的本地支架",
      providerDeadlineAt: startedAt + 15_000,
    }).then(
      () => null,
      (error: unknown) => error,
    );

    await vi.advanceTimersByTimeAsync(12_000);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(callStartedAt).toEqual([startedAt, startedAt + 12_000]);
    await vi.advanceTimersByTimeAsync(3_000);
    const error = await pending;

    expect(error).toMatchObject({
      code: "AAIS_AI_PROVIDER_CHAIN_EXHAUSTED",
      status: 504,
      retryable: true,
      attempts: [
        { role: "primary", attempts: 1, reason: "connect-timeout" },
        { role: "fallback", attempts: 1, reason: "route-deadline" },
      ],
    });
    vi.useRealTimers();
  });

  it("keeps route-deadline as the terminal status after an earlier non-timeout failure", async () => {
    vi.useFakeTimers();
    stubProductionEvaluatedQwenDeepSeekChain();
    const startedAt = Date.now();
    const fetchMock = vi.fn<typeof fetch>(async (_url, init) => {
      if (fetchMock.mock.calls.length === 1) {
        return new Response(null, { status: 400 });
      }
      const signal = init?.signal as AbortSignal;
      return new Promise<Response>((_resolve, reject) => {
        signal.addEventListener("abort", () => reject(signal.reason), { once: true });
      });
    });
    vi.stubGlobal("fetch", fetchMock);

    const pending = createConfiguredAaisModelProvider().generate({
      agentId: "A1",
      label: "小张",
      locale: "zh-CN",
      phase: "training",
      taskId: "training_task_1",
      learnerInput: "请继续。",
      workspaceState: { currentStep: "guide" },
      fallbackText: "不应返回的本地支架",
      providerDeadlineAt: startedAt + 1_000,
    }).then(
      () => null,
      (error: unknown) => error,
    );

    await vi.advanceTimersByTimeAsync(1_000);
    const error = await pending;
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(error).toMatchObject({
      code: "AAIS_AI_PROVIDER_CHAIN_EXHAUSTED",
      status: 504,
      retryable: true,
      attempts: [
        { role: "primary", reason: "invalid-request" },
        { role: "fallback", reason: "route-deadline" },
      ],
    });
    vi.useRealTimers();
  });

  it("does not call the secondary after the primary consumes the provider deadline", async () => {
    vi.useFakeTimers();
    stubProductionEvaluatedQwenDeepSeekChain();
    const startedAt = Date.now();
    const fetchMock = vi.fn<typeof fetch>((_url, init) => {
      const signal = init?.signal as AbortSignal;
      return new Promise<Response>((_resolve, reject) => {
        signal.addEventListener("abort", () => reject(signal.reason), { once: true });
      });
    });
    vi.stubGlobal("fetch", fetchMock);

    const pending = createConfiguredAaisModelProvider().generate({
      agentId: "A1",
      label: "小张",
      locale: "zh-CN",
      phase: "training",
      taskId: "training_task_1",
      learnerInput: "请继续。",
      workspaceState: { currentStep: "guide" },
      fallbackText: "不应返回的本地支架",
      providerDeadlineAt: startedAt + 10_000,
    }).then(
      () => null,
      (error: unknown) => error,
    );

    await vi.advanceTimersByTimeAsync(10_000);
    const error = await pending;

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(error).toMatchObject({
      code: "AAIS_AI_PROVIDER_CHAIN_EXHAUSTED",
      status: 504,
      attempts: [
        { role: "primary", attempts: 1, reason: "route-deadline" },
        { role: "fallback", attempts: 0, reason: "route-deadline" },
      ],
    });
    vi.useRealTimers();
  });

  it("refunds the dispatch fence and records zero attempts when dispatch crosses the provider deadline", async () => {
    vi.useFakeTimers();
    const startedAt = Date.now();
    const fetchMock = vi.fn<typeof fetch>();
    const dispatchFence = {
      acquire: vi.fn(() => new Promise<"ready">((resolve) => {
        setTimeout(() => resolve("ready"), 1_000);
      })),
      markAttemptStarted: vi.fn(),
      releaseBeforeAttempt: vi.fn(async () => "released" as const),
    };
    const provider = createOpenAiCompatibleAaisProvider({
      endpoint: "https://ai.example.test/v1/chat/completions",
      apiKey: "synthetic-test-key",
      model: "enterprise-model",
      fetchImpl: fetchMock,
      timeoutMs: 12_000,
      maxRetries: 0,
      deliveryPolicy: "require-live",
    });

    const pending = provider.generate({
      agentId: "A1",
      label: "小张",
      locale: "zh-CN",
      phase: "training",
      taskId: "training_task_1",
      learnerInput: "dispatch 跨过截止时间时不能发起 provider 请求。",
      workspaceState: { currentStep: "guide" },
      fallbackText: "不应返回的本地支架",
      providerDeadlineAt: startedAt + 1_000,
      providerDispatchFence: dispatchFence,
    }).then(
      () => null,
      (error: unknown) => error,
    );

    await vi.advanceTimersByTimeAsync(1_000);
    const error = await pending;

    expect(fetchMock).not.toHaveBeenCalled();
    expect(dispatchFence.acquire).toHaveBeenCalledTimes(1);
    expect(dispatchFence.releaseBeforeAttempt).toHaveBeenCalledTimes(1);
    expect(dispatchFence.markAttemptStarted).not.toHaveBeenCalled();
    expect(error).toMatchObject({
      status: 504,
      attempts: [
        expect.objectContaining({
          role: "primary",
          attempts: 0,
          reason: "route-deadline",
        }),
      ],
    });
  });

  it("blocks every provider before fetch when the production source lock is not verified", () => {
    stubProductionEvaluatedQwenDeepSeekChain();
    sourceLockEligibilityState.releaseState = "RELEASE_BLOCKED";
    sourceLockEligibilityState.primaryEligible = false;
    sourceLockEligibilityState.fallbackEligible = false;
    const fetchMock = vi.fn<typeof fetch>();
    vi.stubGlobal("fetch", fetchMock);

    expect(() => preflightConfiguredAaisModelProvider()).toThrowError(
      expect.objectContaining({
        code: "AAIS_AI_MODEL_EVALUATION_REQUIRED",
        gateReason: "release-lock-blocked",
        attempts: [
          expect.objectContaining({
            role: "primary",
            attempts: 0,
            gateReason: "release-lock-blocked",
          }),
          expect.objectContaining({
            role: "fallback",
            attempts: 0,
            gateReason: "release-lock-blocked",
          }),
        ],
      }),
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("serves only the role whose production source lock is verified", async () => {
    stubProductionEvaluatedQwenDeepSeekChain();
    sourceLockEligibilityState.releaseState = "RELEASE_BLOCKED";
    sourceLockEligibilityState.primaryEligible = false;
    sourceLockEligibilityState.fallbackEligible = true;
    const fetchMock = vi.fn<typeof fetch>(async () => Response.json({
      model: "deepseek-v4-flash",
      system_fingerprint: deepSeekObservedRevision,
      choices: [{ finish_reason: "stop", message: { content: "Verified secondary response" } }],
    }));
    vi.stubGlobal("fetch", fetchMock);

    const preflight = preflightConfiguredAaisModelProvider();
    const result = await preflight.provider.generate({
      agentId: "A1",
      label: "小张",
      locale: "zh-CN",
      phase: "training",
      taskId: "training_task_1",
      learnerInput: "请继续。",
      workspaceState: { currentStep: "guide" },
      fallbackText: "不应返回的本地支架",
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(String(fetchMock.mock.calls[0]?.[0])).toContain("api.deepseek.com");
    expect(result.runtime.delivery).toMatchObject({
      mode: "live",
      channel: "secondary",
      attempts: [
        expect.objectContaining({
          role: "primary",
          outcome: "skipped",
          gateReason: "release-lock-blocked",
        }),
        expect.objectContaining({ role: "fallback", outcome: "succeeded" }),
      ],
    });
  });

  it("serves through the approved secondary when the primary model is not approved", async () => {
    stubProductionEvaluatedQwenDeepSeekChain();
    stubApprovedEval("primary", "qwen3.7-max", "synthetic-qwen3.7-max-eval-v1");
    const fetchMock = vi.fn<typeof fetch>(async () => Response.json({
      model: "deepseek-v4-flash",
      system_fingerprint: deepSeekObservedRevision,
      choices: [{ message: { content: "Secondary-only live response" } }],
    }));
    vi.stubGlobal("fetch", fetchMock);

    const preflight = preflightConfiguredAaisModelProvider();
    const result = await preflight.provider.generate({
      agentId: "A1",
      label: "小张",
      locale: "zh-CN",
      phase: "training",
      taskId: "training_task_1",
      learnerInput: "请继续。",
      workspaceState: { currentStep: "guide" },
      fallbackText: "不应返回的本地支架",
    });

    expect(preflight.evaluation.primary?.approved).toBe(false);
    expect(preflight.runtimeProfile.primary).toBeNull();
    expect(preflight.runtimeProfile.fallback?.provider).toBe("deepseek");
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(String(fetchMock.mock.calls[0]?.[0])).toContain("api.deepseek.com");
    expect(result.runtime.delivery).toMatchObject({
      mode: "live",
      channel: "secondary",
      degraded: true,
      observedModel: "matched",
      attempts: expect.arrayContaining([
        expect.objectContaining({
          role: "primary",
          outcome: "skipped",
          attempts: 0,
          gateReason: "evaluation-mismatch",
        }),
        expect.objectContaining({ role: "fallback", outcome: "succeeded" }),
      ]),
    });
  });

  it("serves the approved secondary when the Production primary configuration is invalid", async () => {
    stubProductionEvaluatedQwenDeepSeekChain();
    vi.stubEnv("AAIS_AI_MODEL", "qwen3.7-max");
    const fetchMock = vi.fn<typeof fetch>(async () => Response.json({
      model: "deepseek-v4-flash",
      system_fingerprint: deepSeekObservedRevision,
      choices: [{ message: { content: "Secondary survived primary config failure" } }],
    }));
    vi.stubGlobal("fetch", fetchMock);

    const preflight = preflightConfiguredAaisModelProvider();
    const result = await preflight.provider.generate({
      agentId: "A1",
      label: "小张",
      locale: "zh-CN",
      phase: "training",
      taskId: "training_task_1",
      learnerInput: "请继续。",
      workspaceState: { currentStep: "guide" },
      fallbackText: "不应返回的本地支架",
    });

    expect(preflight.configurationStatus.primary).toBe("invalid");
    expect(preflight.eligibility.primary).toEqual({
      eligible: false,
      gateReason: "configuration-invalid",
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(String(fetchMock.mock.calls[0]?.[0])).toBe(
      "https://api.deepseek.com/chat/completions",
    );
    expect(result.runtime.delivery).toMatchObject({
      channel: "secondary",
      attempts: [
        { role: "primary", outcome: "skipped", gateReason: "configuration-invalid" },
        { role: "fallback", outcome: "succeeded" },
      ],
    });
  });

  it.each([
    {
      label: "missing",
      responseModel: undefined,
      reason: "observed-model-missing",
      observedModel: "missing",
    },
    {
      label: "mismatched",
      responseModel: "qwen3.7-max",
      reason: "observed-model-mismatch",
      observedModel: "mismatch",
    },
  ])("fails closed without retrying when the provider model is $label", async ({
    responseModel,
    reason,
    observedModel,
  }) => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("AAIS_AI_RUNTIME_MODE", "live-required");
    stubProductionQwenObservationConstraint();
    vi.stubEnv("AAIS_AI_PROVIDER", "qwen");
    vi.stubEnv("DASHSCOPE_API_KEY", "dashscope-secret-key");
    vi.stubEnv("AAIS_AI_MODEL", "qwen3.8-max");
    stubApprovedEval("primary", "qwen3.8-max", "synthetic-qwen3.8-max-eval-v1");
    const fetchMock = vi.fn<typeof fetch>(async () => Response.json({
      ...(responseModel ? { model: responseModel } : {}),
      system_fingerprint: qwenObservedRevision,
      choices: [{ message: { content: "This response must not escape." } }],
    }));
    vi.stubGlobal("fetch", fetchMock);

    let thrown: unknown;
    try {
      await createConfiguredAaisModelProvider().generate({
        agentId: "A1",
        label: "小张",
        locale: "zh-CN",
        phase: "training",
        taskId: "training_task_1",
        learnerInput: "请继续。",
        workspaceState: { currentStep: "guide" },
        fallbackText: "不应返回的本地支架",
        diagnosticId: "operation-model-integrity-001",
      });
    } catch (error) {
      thrown = error;
    }

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(thrown).toMatchObject({
      code: "AAIS_AI_OBSERVED_MODEL_MISMATCH",
      status: 502,
      retryable: false,
      diagnosticId: "operation-model-integrity-001",
      attempts: expect.arrayContaining([
        expect.objectContaining({ reason, observedModel }),
        expect.objectContaining({
          role: "fallback",
          outcome: "skipped",
          gateReason: "configuration-missing",
        }),
      ]),
    });
    expect(JSON.stringify(thrown)).not.toContain("qwen3.7-max");
    expect(JSON.stringify(thrown)).not.toContain("dashscope-secret-key");
    expect(JSON.stringify(thrown)).not.toContain("This response must not escape.");
  });

  it("tries the live secondary when the primary output guardrail blocks", async () => {
    stubProductionEvaluatedQwenDeepSeekChain();
    const fetchMock = vi.fn<typeof fetch>(async (url) => String(url).includes("dashscope")
      ? Response.json({
          model: "qwen3.8-max",
          system_fingerprint: qwenObservedRevision,
          choices: [{ message: { content: "password=primary-output-must-not-escape" } }],
        })
      : Response.json({
          model: "deepseek-v4-flash",
          system_fingerprint: deepSeekObservedRevision,
          choices: [{ message: { content: "Secondary safe response" } }],
        }));
    vi.stubGlobal("fetch", fetchMock);

    const result = await createConfiguredAaisModelProvider().generate({
      agentId: "A1",
      label: "小张",
      locale: "zh-CN",
      phase: "training",
      taskId: "training_task_1",
      learnerInput: "请继续。",
      workspaceState: { currentStep: "guide" },
      fallbackText: "不应返回的本地支架",
    });

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(result).toMatchObject({
      text: "Secondary safe response",
      runtime: {
        status: "ok",
        delivery: {
          mode: "live",
          channel: "secondary",
          attempts: [
            {
              role: "primary",
              outcome: "blocked",
              reason: "guardrail-blocked",
            },
            {
              role: "fallback",
              outcome: "succeeded",
            },
          ],
        },
      },
    });
    expect(JSON.stringify(result)).not.toContain("primary-output-must-not-escape");
  });

  it("returns a typed rephrase error when every live output is blocked", async () => {
    stubProductionEvaluatedQwenDeepSeekChain();
    const fetchMock = vi.fn<typeof fetch>(async (url) => Response.json({
      model: String(url).includes("dashscope") ? "qwen3.8-max" : "deepseek-v4-flash",
      system_fingerprint: String(url).includes("dashscope")
        ? qwenObservedRevision
        : deepSeekObservedRevision,
      choices: [{ message: { content: "password=blocked-output-must-not-escape" } }],
    }));
    vi.stubGlobal("fetch", fetchMock);

    let thrown: unknown;
    try {
      await createConfiguredAaisModelProvider().generate({
        agentId: "A1",
        label: "小张",
        locale: "zh-CN",
        phase: "training",
        taskId: "training_task_1",
        learnerInput: "请继续。",
        workspaceState: { currentStep: "guide" },
        fallbackText: "不应返回的本地支架",
      });
    } catch (error) {
      thrown = error;
    }

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(thrown).toMatchObject({
      code: "AAIS_AI_OUTPUT_BLOCKED",
      status: 422,
      retryable: false,
      learnerAction: "rephrase",
      attempts: [
        { role: "primary", outcome: "blocked", reason: "guardrail-blocked" },
        { role: "fallback", outcome: "blocked", reason: "guardrail-blocked" },
      ],
    });
    expect(JSON.stringify(thrown)).not.toContain("blocked-output-must-not-escape");
  });

  it("enables only the production Qwen 3.8 target with signed configured evaluation evidence", async () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("AAIS_AI_RUNTIME_MODE", "live-required");
    stubProductionQwenObservationConstraint();
    vi.stubEnv("AAIS_AI_PROVIDER", "qwen");
    vi.stubEnv("DASHSCOPE_API_KEY", "dashscope-secret-key");
    vi.stubEnv("AAIS_AI_MODEL", "qwen3.8-max");
    stubApprovedEval("primary", "qwen3.8-max", "synthetic-qwen3.8-max-eval-v1");
    const fetchMock = vi.fn<typeof fetch>(async () =>
      Response.json({
        model: "qwen3.8-max",
        system_fingerprint: qwenObservedRevision,
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
      model: "qwen3.8-max",
      status: "ok",
      delivery: {
        schemaVersion: 1,
        mode: "live",
        channel: "primary",
        degraded: false,
        observedModel: "matched",
      },
    });
  });

  it("skips an unevaluated secondary while an approved primary remains eligible", async () => {
    stubProductionEvaluatedQwenDeepSeekChain();
    vi.stubEnv("AAIS_AI_FALLBACK_EVAL_APPROVED", "false");
    const fetchMock = vi.fn<typeof fetch>(async () => Response.json({
      model: "qwen3.8-max",
      system_fingerprint: qwenObservedRevision,
      choices: [{ message: { content: "Approved primary response" } }],
    }));
    vi.stubGlobal("fetch", fetchMock);

    const preflight = preflightConfiguredAaisModelProvider();
    const result = await preflight.provider.generate({
      agentId: "A1",
      label: "小张",
      locale: "zh-CN",
      phase: "training",
      taskId: "training_task_1",
      learnerInput: "请给我下一步。",
      workspaceState: { currentStep: "guide" },
      fallbackText: "不应返回的本地支架",
    });

    expect(preflight.evaluation.fallback?.approved).toBe(false);
    expect(preflight.runtimeProfile.fallback).toBeNull();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(result.runtime.delivery).toMatchObject({
      mode: "live",
      channel: "primary",
      degraded: false,
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
