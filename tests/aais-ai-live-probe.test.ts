import { describe, expect, it, vi } from "vitest";
import {
  AaisGuideDeliveryError,
  aaisGuideDeliveryRedaction,
} from "@/lib/ai/aais-guide-delivery";
import {
  getAaisAiModelFingerprint,
  readAaisAiRuntimeConfig,
} from "@/lib/ai/aais-ai-runtime-config";
import {
  aaisAiLiveProbeDeadlineMs,
  runAaisAiLiveProbe,
} from "@/lib/server/aais-ai-live-probe";
import type {
  AaisAiReleaseGate,
  AaisAiReleaseProviderGate,
} from "@/lib/server/aais-ai-release-lock";

const primaryModel = "qwen3.8-max";
const secondaryModel = "deepseek-v4-flash";

describe("AAIS protected live-provider probe service", () => {
  it("caps the business deadline at 30 seconds", () => {
    expect(aaisAiLiveProbeDeadlineMs).toBeLessThanOrEqual(30_000);
  });
  it("stops before inference while the source release lock is RELEASE_BLOCKED", async () => {
    const runtimeConfig = createRuntimeConfig();
    const providerFactory = vi.fn();
    const result = await runAaisAiLiveProbe("aais-live-primary-a1-zh-v1", {
      dependencies: {
        runtimeConfig,
        releaseGate: createBlockedReleaseGate(),
        providerFactory,
        now: () => new Date("2026-08-21T00:00:00.000Z"),
        diagnosticId: () => "diagnostic-release-blocked-v1",
      },
    });

    expect(result.httpStatus).toBe(503);
    expect(result.report).toMatchObject({
      status: "blocked",
      syntheticId: "aais-live-primary-a1-zh-v1",
      release: {
        state: "RELEASE_BLOCKED",
      },
      runtime: {
        providerStatus: "not-run",
        attempts: 0,
      },
      persistence: {
        learnerSession: "not-used",
        guideQuota: "not-used",
        rawPrompt: "not-stored",
        rawOutput: "not-stored",
        auditRow: "not-written",
      },
    });
    expect(providerFactory).not.toHaveBeenCalled();
  });

  it("runs the fixed primary target and returns metadata without raw output", async () => {
    const runtimeConfig = createRuntimeConfig();
    const generate = vi.fn(async (request: unknown) => {
      void request;
      return createProviderResponse("primary");
    });
    const providerFactory = vi.fn(() => ({ generate }));
    const result = await runAaisAiLiveProbe("aais-live-primary-a2-en-v1", {
      dependencies: {
        runtimeConfig,
        releaseGate: createVerifiedReleaseGate(),
        providerFactory,
        now: () => new Date("2026-08-21T00:00:00.000Z"),
        diagnosticId: () => "diagnostic-primary-live-v1",
      },
    });

    expect(result.httpStatus).toBe(200);
    expect(result.report).toMatchObject({
      status: "live",
      target: {
        providerRole: "primary",
        agentId: "A2",
        locale: "en-US",
      },
      release: {
        state: "RELEASE_VERIFIED",
        lockId: "synthetic-release-contract-fixture-v1",
        modelFingerprint: getAaisAiModelFingerprint(primaryModel),
      },
      runtime: {
        providerStatus: "ok",
        fallback: false,
        attempts: 1,
        guardrail: "passed",
        observedModel: "matched",
      },
    });
    expect(providerFactory).toHaveBeenCalledWith(runtimeConfig.primary, runtimeConfig);
    expect(generate).toHaveBeenCalledTimes(1);
    expect(generate.mock.calls[0]?.[0]).toMatchObject({
      agentId: "A2",
      locale: "en-US",
      taskId: "aais-live-primary-a2-en-v1",
      workspaceState: {
        currentStep: "release-live-probe",
        helpRequestsUsed: 0,
      },
    });
    const serialized = JSON.stringify(result.report);
    expect(serialized).not.toContain("RAW_PROVIDER_OUTPUT_MUST_NOT_LEAVE_PROBE");
    expect(serialized).not.toContain(primaryModel);
    expect(serialized).not.toContain("synthetic-primary-api-key");
    expect(serialized).not.toContain("dashscope.aliyuncs.com");
  });

  it("can probe a verified primary independently while the secondary remains blocked", async () => {
    const runtimeConfig = createRuntimeConfig();
    const releaseGate = createVerifiedReleaseGate();
    releaseGate.status = "blocked";
    releaseGate.releaseState = "RELEASE_BLOCKED";
    releaseGate.providers.secondary.status = "blocked";
    releaseGate.providers.secondary.issues = ["AAIS_AI_SECONDARY_EVAL_MANIFEST"];
    releaseGate.issues = ["AAIS_AI_SECONDARY_EVAL_MANIFEST"];
    const generate = vi.fn(async () => createProviderResponse("primary"));

    const result = await runAaisAiLiveProbe("aais-live-primary-a1-zh-v1", {
      dependencies: {
        runtimeConfig,
        releaseGate,
        providerFactory: () => ({ generate }),
        diagnosticId: () => "diagnostic-primary-role-local-v1",
      },
    });

    expect(result.httpStatus).toBe(200);
    expect(result.report).toMatchObject({
      status: "live",
      release: { state: "RELEASE_BLOCKED" },
      target: { providerRole: "primary" },
    });
    expect(generate).toHaveBeenCalledOnce();
  });

  it("targets the configured DeepSeek candidate directly for a secondary probe", async () => {
    const runtimeConfig = createRuntimeConfig();
    const generate = vi.fn(async (request: unknown) => {
      void request;
      return createProviderResponse("secondary");
    });
    const providerFactory = vi.fn(() => ({ generate }));
    const result = await runAaisAiLiveProbe("aais-live-secondary-a1-zh-v1", {
      dependencies: {
        runtimeConfig,
        releaseGate: createVerifiedReleaseGate(),
        providerFactory,
        diagnosticId: () => "diagnostic-secondary-live-v1",
      },
    });

    expect(result.httpStatus).toBe(200);
    expect(result.report).toMatchObject({
      status: "live",
      target: {
        providerRole: "secondary",
        agentId: "A1",
        locale: "zh-CN",
      },
      release: {
        modelFingerprint: getAaisAiModelFingerprint(secondaryModel),
      },
    });
    expect(providerFactory).toHaveBeenCalledWith(runtimeConfig.fallback, runtimeConfig);
    expect(generate.mock.calls[0]?.[0]).toMatchObject({
      taskId: "aais-live-secondary-a1-zh-v1",
    });
  });

  it("fails closed when the provider receipt does not attest the observed model", async () => {
    const runtimeConfig = createRuntimeConfig();
    const response = createProviderResponse("primary", "not-reported");
    const result = await runAaisAiLiveProbe("aais-live-primary-a1-en-v1", {
      dependencies: {
        runtimeConfig,
        releaseGate: createVerifiedReleaseGate(),
        providerFactory: () => ({ generate: async () => response }),
        diagnosticId: () => "diagnostic-model-unreported-v1",
      },
    });

    expect(result.httpStatus).toBe(502);
    expect(result.report).toMatchObject({
      status: "blocked",
      runtime: {
        observedModel: "unreported",
      },
      issues: ["AAIS_AI_LIVE_PROBE_OBSERVED_MODEL"],
    });
  });

  it("uses a single strict provider attempt and rejects a response with no observed model", async () => {
    const runtimeConfig = createRuntimeConfig();
    const fetchMock = vi.fn<typeof fetch>(async () => Response.json({
      choices: [{ message: { content: "Synthetic provider response." } }],
    }));
    vi.stubGlobal("fetch", fetchMock);
    try {
      const result = await runAaisAiLiveProbe("aais-live-primary-a1-en-v1", {
        dependencies: {
          runtimeConfig,
          releaseGate: createVerifiedReleaseGate(),
          diagnosticId: () => "diagnostic-model-missing-v1",
        },
      });

      expect(result.httpStatus).toBe(502);
      expect(result.report.runtime).toMatchObject({
        providerStatus: "failed",
        fallback: false,
        attempts: 1,
        observedModel: "missing",
        failureReasons: ["observed-model-missing"],
      });
      expect(fetchMock).toHaveBeenCalledTimes(1);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("rejects an observed provider revision that does not match the signed lock", async () => {
    const runtimeConfig = createRuntimeConfig();
    const fetchMock = vi.fn<typeof fetch>(async () => Response.json({
      model: primaryModel,
      system_fingerprint: "unexpected-synthetic-provider-revision",
      choices: [{ message: { content: "Synthetic provider response." } }],
    }));
    vi.stubGlobal("fetch", fetchMock);
    try {
      const result = await runAaisAiLiveProbe("aais-live-primary-a2-en-v1", {
        dependencies: {
          runtimeConfig,
          releaseGate: createVerifiedReleaseGate(),
          diagnosticId: () => "diagnostic-revision-mismatch-v1",
        },
      });

      expect(result.httpStatus).toBe(502);
      expect(result.report.runtime).toMatchObject({
        providerStatus: "failed",
        fallback: false,
        attempts: 1,
        observedModel: "unreported",
        observedRevision: "mismatch",
        failureReasons: ["observed-revision-mismatch"],
        providerAttempts: [expect.objectContaining({
          role: "primary",
          outcome: "failed",
          reason: "observed_revision_mismatch",
          observedRevision: "mismatch",
        })],
      });
      expect(result.report.issues).toContain("AAIS_AI_LIVE_PROBE_OBSERVED_REVISION");
      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(JSON.stringify(result.report)).not.toContain("unexpected-synthetic-provider-revision");
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("bounds provider failures to a stable reason without exposing thrown data", async () => {
    const runtimeConfig = createRuntimeConfig();
    const result = await runAaisAiLiveProbe("aais-live-primary-a1-en-v1", {
      dependencies: {
        runtimeConfig,
        releaseGate: createVerifiedReleaseGate(),
        providerFactory: () => ({
          generate: async () => {
            throw new Error(
              "synthetic-primary-api-key RAW_PROVIDER_OUTPUT_MUST_NOT_LEAVE_PROBE",
            );
          },
        }),
        diagnosticId: () => "diagnostic-provider-failure-v1",
      },
    });

    expect(result.httpStatus).toBe(502);
    expect(result.report.runtime).toMatchObject({
      providerStatus: "failed",
      fallback: false,
      failureReasons: ["provider-error"],
    });
    const serialized = JSON.stringify(result.report);
    expect(serialized).not.toContain("synthetic-primary-api-key");
    expect(serialized).not.toContain("RAW_PROVIDER_OUTPUT_MUST_NOT_LEAVE_PROBE");
  });

  it("classifies an abort-timeout probe attempt as a response timeout", async () => {
    const runtimeConfig = createRuntimeConfig();
    const consoleSpy = vi.spyOn(console, "info").mockImplementation(() => undefined);
    try {
      const result = await runAaisAiLiveProbe("aais-live-primary-a1-en-v1", {
        dependencies: {
          runtimeConfig,
          releaseGate: createVerifiedReleaseGate(),
          providerFactory: () => ({
            generate: async () => {
              throw new AaisGuideDeliveryError({
                code: "AAIS_AI_PROVIDER_CHAIN_EXHAUSTED",
                status: 504,
                retryable: false,
                learnerAction: "retry",
                diagnosticId: "50000000-0000-4000-8000-000000000050",
                attempts: [{
                  role: "primary",
                  outcome: "failed",
                  attempts: 1,
                  modelFingerprint: getAaisAiModelFingerprint(primaryModel),
                  observedModel: "not-reported",
                  reason: "abort-timeout",
                }],
              });
            },
          }),
          diagnosticId: () => "50000000-0000-4000-8000-000000000050",
        },
      });

      expect(result.httpStatus).toBe(502);
      const diagnostic = JSON.parse(String(consoleSpy.mock.calls.at(-1)?.[0]));
      expect(diagnostic).toMatchObject({
        event: "aais.ai.probe.failed",
        category: "deadline",
        reason: "response_timeout",
        providerAttempts: [{
          role: "primary",
          reason: "response_timeout",
        }],
      });
    } finally {
      consoleSpy.mockRestore();
    }
  });

  it("reports a typed observed-model mismatch without returning either model id", async () => {
    const runtimeConfig = createRuntimeConfig();
    const result = await runAaisAiLiveProbe("aais-live-secondary-a2-zh-v1", {
      dependencies: {
        runtimeConfig,
        releaseGate: createVerifiedReleaseGate(),
        providerFactory: () => ({
          generate: async () => {
            throw new AaisGuideDeliveryError({
              code: "AAIS_AI_OBSERVED_MODEL_MISMATCH",
              status: 502,
              retryable: false,
              learnerAction: "contact-support",
              diagnosticId: "diagnostic-observed-model-mismatch-v1",
              attempts: [{
                role: "fallback",
                outcome: "failed",
                attempts: 1,
                modelFingerprint: getAaisAiModelFingerprint(secondaryModel),
                observedModel: "mismatch",
                reason: "observed-model-mismatch",
              }],
            });
          },
        }),
        diagnosticId: () => "diagnostic-observed-model-mismatch-v1",
      },
    });

    expect(result.httpStatus).toBe(502);
    expect(result.report.runtime).toMatchObject({
      providerStatus: "failed",
      fallback: false,
      attempts: 1,
      observedModel: "mismatch",
      failureReasons: ["observed-model-mismatch"],
      providerAttempts: [expect.objectContaining({
        role: "secondary",
        outcome: "failed",
        reason: "observed_model_mismatch",
      })],
    });
    expect(result.report.issues).toEqual(expect.arrayContaining([
      "AAIS_AI_LIVE_PROBE_PROVIDER",
      "AAIS_AI_LIVE_PROBE_OBSERVED_MODEL",
    ]));
    const serialized = JSON.stringify(result.report);
    expect(serialized).not.toContain(secondaryModel);
    expect(serialized).not.toContain("some-unexpected-provider-model");
  });
});

function createRuntimeConfig() {
  return readAaisAiRuntimeConfig({
    NODE_ENV: "production",
    AAIS_AI_RUNTIME_MODE: "live-required",
    AAIS_AI_PROVIDER: "qwen",
    AAIS_AI_ENDPOINT: "https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions",
    AAIS_AI_API_KEY: "synthetic-primary-api-key",
    AAIS_AI_MODEL: primaryModel,
    AAIS_AI_THINKING_MODE: "disabled",
    AAIS_AI_TIMEOUT_MS: "12000",
    AAIS_AI_MAX_RETRIES: "0",
    AAIS_AI_OBSERVED_REVISION_SHA256: "a".repeat(64),
    AAIS_AI_FALLBACK_ENABLED: "true",
    AAIS_AI_FALLBACK_PROVIDER: "deepseek",
    AAIS_AI_FALLBACK_ENDPOINT: "https://api.deepseek.com/chat/completions",
    AAIS_AI_FALLBACK_API_KEY: "synthetic-secondary-api-key",
    AAIS_AI_FALLBACK_MODEL: secondaryModel,
    AAIS_AI_FALLBACK_THINKING_MODE: "disabled",
    AAIS_AI_FALLBACK_TIMEOUT_MS: "12000",
    AAIS_AI_FALLBACK_MAX_RETRIES: "0",
    AAIS_AI_FALLBACK_OBSERVED_REVISION_SHA256: "b".repeat(64),
  });
}

function createBlockedReleaseGate(): AaisAiReleaseGate {
  const verified = createVerifiedReleaseGate();
  return {
    ...verified,
    status: "blocked",
    releaseState: "RELEASE_BLOCKED",
    lock: {
      ...verified.lock,
      releaseStatus: "blocked",
    },
    issues: ["AAIS_AI_RELEASE_NOT_APPROVED"],
  };
}

function createVerifiedReleaseGate(): AaisAiReleaseGate {
  return {
    status: "verified",
    releaseState: "RELEASE_VERIFIED",
    lock: {
      id: "synthetic-release-contract-fixture-v1",
      source: "bundled",
      contractVersion: "aais-ai-live-release-v1",
      releaseStatus: "approved",
    },
    deliveryPolicy: "require-live",
    providers: {
      primary: createVerifiedProviderGate("primary"),
      secondary: createVerifiedProviderGate("secondary"),
    },
    externalAudit: {
      required: true,
      verificationStage: "external-post-deploy",
      signingKeyId: "synthetic-release-receipt-key-v1",
      verifyingKeySpkiSha256: "d".repeat(64),
      runtimeGateDependency: false,
    },
    issues: [],
    redaction: {
      secrets: "omitted",
      endpoints: "omitted",
      modelIds: "fingerprint-only",
      rawPrompts: "omitted",
      rawOutputs: "omitted",
    },
  };
}

function createVerifiedProviderGate(
  role: "primary" | "secondary",
): AaisAiReleaseProviderGate {
  return {
    role,
    runtimeRole: role === "primary" ? "primary" : "fallback",
    required: true,
    status: "verified",
    provider: role === "primary" ? "qwen" : "deepseek",
    modelFingerprint: getAaisAiModelFingerprint(
      role === "primary" ? primaryModel : secondaryModel,
    ),
    endpointFingerprint: role === "primary" ? "1".repeat(64) : "2".repeat(64),
    thinkingMode: "disabled",
    temperature: 0.2,
    maxTokens: 600,
    observedRevisionSha256: role === "primary" ? "3".repeat(64) : "4".repeat(64),
    evalVersion: role === "primary"
      ? "synthetic-qwen38-eval-v1"
      : "synthetic-deepseek-eval-v1",
    evalManifest: "verified",
    evalSource: "configured",
    manifestSha256: role === "primary" ? "1".repeat(64) : "2".repeat(64),
    evalSuiteSha256: "5".repeat(64),
    evalDataSha256: "6".repeat(64),
    caBackgroundSha256: "b".repeat(64),
    guardrailSha256: "c".repeat(64),
    locales: ["zh-CN", "en-US"],
    passedAt: "2026-08-21T00:00:00.000Z",
    expiresAt: "2026-09-20T00:00:00.000Z",
    manifestSigningKeyId: "synthetic-eval-key-v1",
    manifestSignatureSha256: role === "primary" ? "7".repeat(64) : "8".repeat(64),
    observedModelRequired: true,
    issues: [],
  };
}

function createProviderResponse(
  role: "primary" | "secondary",
  observedModel: "matched" | "not-reported" = "matched",
) {
  return {
    text: "RAW_PROVIDER_OUTPUT_MUST_NOT_LEAVE_PROBE",
    runtime: {
      provider: "openai-compatible",
      model: role === "primary" ? primaryModel : secondaryModel,
      attempts: 1,
      status: "ok" as const,
      guardrail: {
        policy: "aais-age-appropriate-output-v1" as const,
        status: "passed" as const,
        reasons: [],
      },
      redaction: {
        secrets: "omitted" as const,
        prompt: "summarized" as const,
      },
      delivery: {
        schemaVersion: 1 as const,
        mode: "live" as const,
        channel: role,
        degraded: role === "secondary",
        diagnosticId: `synthetic-${role}-diagnostic-v1`,
        observedModel,
        attempts: [{
          role: role === "primary" ? "primary" as const : "fallback" as const,
          outcome: "succeeded" as const,
          attempts: 1,
          modelFingerprint: getAaisAiModelFingerprint(
            role === "primary" ? primaryModel : secondaryModel,
          ),
          observedModel,
          observedRevision: "matched" as const,
          observedRevisionSha256: role === "primary" ? "a".repeat(64) : "b".repeat(64),
        }],
        redaction: aaisGuideDeliveryRedaction,
      },
    },
  };
}
