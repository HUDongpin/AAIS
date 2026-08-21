import { describe, expect, it } from "vitest";
import {
  deepSeekChatCompletionsEndpoint,
  deepSeekRequiredModel,
  getAaisAiModelFingerprint,
  qwenDashScopeEndpoint,
  qwenDefaultModel,
  readAaisAiRuntimeConfig,
} from "@/lib/ai/aais-ai-runtime-config";
import {
  evaluateAaisAiReleaseGate,
  getBundledAaisAiProductionReleaseLock,
  projectAaisAiSourceLockEligibility,
  readAaisAiProductionReleaseLock,
  type AaisAiProductionReleaseLock,
  type AaisAiReleaseRuntimeEvidence,
} from "@/lib/server/aais-ai-release-lock";

const now = new Date("2026-08-21T02:00:00.000Z");
const qwenManifestSha256 = "1".repeat(64);
const deepSeekManifestSha256 = "2".repeat(64);

describe("AAIS AI production release lock", () => {
  it("keeps pending Qwen and verified DeepSeek evidence RELEASE_BLOCKED", () => {
    const lock = getBundledAaisAiProductionReleaseLock(now);

    expect(lock).toMatchObject({
      schemaVersion: 1,
      contractVersion: "aais-ai-live-release-v1",
      releaseStatus: "blocked",
      deliveryPolicy: "require-live",
      providers: {
        primary: {
          provider: "qwen",
          model: "qwen3.8-max",
          endpointFingerprint: null,
          observedModel: null,
          observedRevisionSha256: null,
          evidenceStatus: "pending",
          evalVersion: null,
          manifestSha256: null,
          locales: [],
          manifestSigningKeyId: null,
        },
        secondary: {
          provider: "deepseek",
          model: "deepseek-v4-flash",
          endpointFingerprint: "9c4742713a9f000db0ee433cce638395df58f5fdfab1b26333d0c7797862c5d2",
          observedModel: "deepseek-v4-flash",
          observedRevisionSha256: "da47ddb8311a680e525bf29d5c7edec3dfa755208983808bf556746776aa9571",
          evidenceStatus: "verified",
          evalVersion: "aais-deepseek-v4-flash-20260821-formal-v1",
          manifestSha256: "ba57d0c63175f0bf1a9819e33d4855423ff9d6cb1759ef38658de8b71c443b95",
          locales: ["zh-CN", "en-US"],
          manifestSigningKeyId: "aais-deepseek-eval-20260821-v1",
        },
      },
      releaseReceipt: {
        required: true,
        verificationStage: "external-post-deploy",
        signingKeyId: "aais-production-audit-20260821-v1",
        verifyingKeySpkiSha256: "dd85266e4965bc110e015f42785c200b736532fa799cc3b7a12faca169c76324",
        productionUrl: null,
        gitCommitSha: null,
        deploymentId: null,
        configGeneration: null,
        auditNonce: null,
        operationIdDerivation: null,
        privacyEvidenceSha256: null,
        learnerCanaryEvidenceSha256: null,
      },
    });

    const gate = evaluateAaisAiReleaseGate({
      runtime: createRuntimeEvidence(),
      now,
    });
    expect(gate.status).toBe("blocked");
    expect(gate.releaseState).toBe("RELEASE_BLOCKED");
    expect(gate.issues).toEqual(expect.arrayContaining([
      "AAIS_AI_RELEASE_NOT_APPROVED",
      "AAIS_AI_PRIMARY_RUNTIME_CONTRACT",
      "AAIS_AI_PRIMARY_EVAL_MANIFEST",
      "AAIS_AI_SECONDARY_RUNTIME_CONTRACT",
      "AAIS_AI_SECONDARY_EVAL_MANIFEST",
    ]));
    expect(JSON.stringify(gate)).not.toContain("qwen3.8-max");
    expect(JSON.stringify(gate)).not.toContain("deepseek-v4-flash");
    expect(projectAaisAiSourceLockEligibility(gate)).toEqual({
      releaseState: "RELEASE_BLOCKED",
      primary: { eligible: false },
      fallback: { eligible: false },
    });
  });

  it("binds the bundled lock models to the exact Production runtime provider contract", () => {
    const lock = getBundledAaisAiProductionReleaseLock(now);
    const runtime = readAaisAiRuntimeConfig({
      NODE_ENV: "production",
      VERCEL_ENV: "production",
      AAIS_AI_RUNTIME_MODE: "live-required",
      AAIS_AI_PROVIDER: "qwen",
      AAIS_AI_ENDPOINT: qwenDashScopeEndpoint,
      AAIS_AI_API_KEY: "synthetic-primary-key",
      AAIS_AI_MODEL: qwenDefaultModel,
      AAIS_AI_THINKING_MODE: "disabled",
      AAIS_AI_TIMEOUT_MS: "12000",
      AAIS_AI_MAX_RETRIES: "0",
      AAIS_AI_OBSERVED_REVISION_SHA256: "3".repeat(64),
      AAIS_AI_FALLBACK_ENABLED: "true",
      AAIS_AI_FALLBACK_PROVIDER: "deepseek",
      AAIS_AI_FALLBACK_ENDPOINT: deepSeekChatCompletionsEndpoint,
      AAIS_AI_FALLBACK_API_KEY: "synthetic-secondary-key",
      AAIS_AI_FALLBACK_MODEL: deepSeekRequiredModel,
      AAIS_AI_FALLBACK_THINKING: "false",
      AAIS_AI_FALLBACK_TIMEOUT_MS: "12000",
      AAIS_AI_FALLBACK_MAX_RETRIES: "0",
      AAIS_AI_FALLBACK_OBSERVED_REVISION_SHA256: "4".repeat(64),
    });

    expect(runtime.configurationStatus).toEqual({
      runtimeMode: "valid",
      primary: "valid",
      fallback: "valid",
    });
    expect(runtime.primary).toMatchObject({
      endpoint: qwenDashScopeEndpoint,
      model: qwenDefaultModel,
      profile: { provider: "qwen" },
    });
    expect(runtime.fallback).toMatchObject({
      endpoint: deepSeekChatCompletionsEndpoint,
      model: deepSeekRequiredModel,
      profile: { provider: "deepseek" },
    });
    expect(lock?.providers.primary).toMatchObject({
      provider: runtime.primary?.profile.provider,
      model: qwenDefaultModel,
    });
    expect(lock?.providers.secondary).toMatchObject({
      provider: runtime.fallback?.profile.provider,
      model: deepSeekRequiredModel,
    });
  });

  it("rejects an approved lock if any provider evidence field remains pending", () => {
    const lock = createApprovedTestFixtureLock();
    lock.providers.secondary.evalDataSha256 = null;

    expect(readAaisAiProductionReleaseLock(lock, now)).toBeNull();
    expect(evaluateAaisAiReleaseGate({
      runtime: createRuntimeEvidence(),
      lock,
      now,
    })).toMatchObject({
      status: "invalid",
      releaseState: "RELEASE_BLOCKED",
      issues: ["AAIS_AI_RELEASE_LOCK_INVALID"],
    });
  });

  it("rejects source locks with Qwen and DeepSeek assigned to the wrong roles", () => {
    const primarySwapped = structuredClone(createApprovedTestFixtureLock()) as unknown as {
      providers: { primary: { provider: string } };
    };
    primarySwapped.providers.primary.provider = "deepseek";
    expect(readAaisAiProductionReleaseLock(primarySwapped, now)).toBeNull();

    const secondarySwapped = structuredClone(createApprovedTestFixtureLock()) as unknown as {
      providers: { secondary: { provider: string } };
    };
    secondarySwapped.providers.secondary.provider = "qwen";
    expect(readAaisAiProductionReleaseLock(secondarySwapped, now)).toBeNull();
  });

  it("rejects an approved lock without the external audit signing contract", () => {
    const lock = createApprovedTestFixtureLock();
    lock.releaseReceipt.verifyingKeySpkiSha256 = null;

    expect(readAaisAiProductionReleaseLock(lock, now)).toBeNull();
  });

  it("verifies a fully matching static contract and projects the external audit requirement", () => {
    const gate = evaluateAaisAiReleaseGate({
      lock: createApprovedTestFixtureLock(),
      runtime: createRuntimeEvidence(),
      now,
    });

    expect(gate).toMatchObject({
      status: "verified",
      releaseState: "RELEASE_VERIFIED",
      providers: {
        primary: {
          status: "verified",
          provider: "qwen",
          modelFingerprint: getAaisAiModelFingerprint("qwen3.8-max"),
          observedRevisionSha256: "3".repeat(64),
          manifestSha256: qwenManifestSha256,
          locales: ["zh-CN", "en-US"],
          issues: [],
        },
        secondary: {
          status: "verified",
          provider: "deepseek",
          modelFingerprint: getAaisAiModelFingerprint("deepseek-v4-flash"),
          observedRevisionSha256: "4".repeat(64),
          manifestSha256: deepSeekManifestSha256,
          locales: ["zh-CN", "en-US"],
          issues: [],
        },
      },
      externalAudit: {
        required: true,
        verificationStage: "external-post-deploy",
        signingKeyId: "synthetic-release-receipt-key-v1",
        verifyingKeySpkiSha256: "d".repeat(64),
        runtimeGateDependency: false,
      },
      issues: [],
    });
    expect(projectAaisAiSourceLockEligibility(gate)).toEqual({
      releaseState: "RELEASE_VERIFIED",
      primary: { eligible: true },
      fallback: { eligible: true },
    });
  });

  it("reports primary prompt evidence and secondary revision failures independently", () => {
    const runtime = createRuntimeEvidence();
    const primaryEvidence = runtime.primary.evalApproval.manifest.releaseEvidence;
    if (primaryEvidence) primaryEvidence.caBackgroundSha256 = "f".repeat(64);
    runtime.secondary.observedRevisionSha256 = "e".repeat(64);
    const gate = evaluateAaisAiReleaseGate({
      lock: createApprovedTestFixtureLock(),
      runtime,
      now,
    });

    expect(gate.providers.primary.issues).toContain("AAIS_AI_PRIMARY_PROMPT_CONTRACT");
    expect(gate.providers.primary.issues).not.toContain("AAIS_AI_SECONDARY_OBSERVATION_CONTRACT");
    expect(gate.providers.secondary.issues).toContain("AAIS_AI_SECONDARY_OBSERVATION_CONTRACT");
    expect(gate.providers.secondary.issues).not.toContain("AAIS_AI_PRIMARY_PROMPT_CONTRACT");
  });

  it("projects source-lock eligibility independently after shared approval verifies", () => {
    const secondaryBlocked = evaluateAaisAiReleaseGate({
      lock: createApprovedTestFixtureLock(),
      runtime: createRuntimeEvidence(),
      now,
    });
    secondaryBlocked.status = "blocked";
    secondaryBlocked.releaseState = "RELEASE_BLOCKED";
    secondaryBlocked.providers.secondary.status = "blocked";
    secondaryBlocked.providers.secondary.issues = ["AAIS_AI_SECONDARY_EVAL_MANIFEST"];
    secondaryBlocked.issues = ["AAIS_AI_SECONDARY_EVAL_MANIFEST"];
    expect(projectAaisAiSourceLockEligibility(secondaryBlocked)).toEqual({
      releaseState: "RELEASE_BLOCKED",
      primary: { eligible: true },
      fallback: { eligible: false },
    });

    const primaryBlocked = evaluateAaisAiReleaseGate({
      lock: createApprovedTestFixtureLock(),
      runtime: createRuntimeEvidence(),
      now,
    });
    primaryBlocked.status = "blocked";
    primaryBlocked.releaseState = "RELEASE_BLOCKED";
    primaryBlocked.providers.primary.status = "blocked";
    primaryBlocked.providers.primary.issues = ["AAIS_AI_PRIMARY_EVAL_MANIFEST"];
    primaryBlocked.issues = ["AAIS_AI_PRIMARY_EVAL_MANIFEST"];
    expect(projectAaisAiSourceLockEligibility(primaryBlocked)).toEqual({
      releaseState: "RELEASE_BLOCKED",
      primary: { eligible: false },
      fallback: { eligible: true },
    });
  });

  it("blocks when the current source prompt, CA, or guardrail contract changes", () => {
    for (const mutate of [
      (runtime: AaisAiReleaseRuntimeEvidence) => {
        runtime.sourceContract.agentPromptContractSha256.A2 = "f".repeat(64);
      },
      (runtime: AaisAiReleaseRuntimeEvidence) => {
        runtime.sourceContract.caBackgroundSha256 = "f".repeat(64);
      },
      (runtime: AaisAiReleaseRuntimeEvidence) => {
        runtime.sourceContract.guardrailSha256 = "f".repeat(64);
      },
    ]) {
      const runtime = createRuntimeEvidence();
      mutate(runtime);
      const gate = evaluateAaisAiReleaseGate({
        lock: createApprovedTestFixtureLock(),
        runtime,
        now,
      });

      expect(gate.releaseState).toBe("RELEASE_BLOCKED");
      expect(gate.providers.primary.issues).toContain("AAIS_AI_PRIMARY_PROMPT_CONTRACT");
      expect(gate.providers.secondary.issues).toContain("AAIS_AI_SECONDARY_PROMPT_CONTRACT");
    }
  });

  it("rejects post-deploy values embedded in the source lock to avoid self-reference", () => {
    const lock = createApprovedTestFixtureLock();
    lock.releaseReceipt.deploymentId = "dpl_wrong_release";

    expect(readAaisAiProductionReleaseLock(lock, now)).toBeNull();
  });

  it("rejects expired or over-30-day approved evidence at parse time", () => {
    const expired = createApprovedTestFixtureLock();
    expired.providers.primary.passedAt = "2026-07-20T00:00:00.000Z";
    expired.providers.primary.expiresAt = "2026-08-19T00:00:00.000Z";
    expect(readAaisAiProductionReleaseLock(expired, now)).toBeNull();

    const overWindow = createApprovedTestFixtureLock();
    overWindow.providers.secondary.expiresAt = "2026-09-21T00:00:00.001Z";
    expect(readAaisAiProductionReleaseLock(overWindow, now)).toBeNull();
  });
});

function createRuntimeEvidence(): AaisAiReleaseRuntimeEvidence {
  return {
    deliveryPolicy: "require-live",
    runtimeModeStatus: "valid",
    sourceContract: {
      agentPromptContractSha256: {
        A1: "7".repeat(64),
        A2: "8".repeat(64),
        A3: "9".repeat(64),
        A4: "a".repeat(64),
      },
      caBackgroundSha256: "b".repeat(64),
      guardrailSha256: "c".repeat(64),
    },
    primary: createRuntimeProviderEvidence("primary"),
    secondary: createRuntimeProviderEvidence("secondary"),
  };
}

function createRuntimeProviderEvidence(role: "primary" | "secondary") {
  const primary = role === "primary";
  const model = primary ? "qwen3.8-max" : "deepseek-v4-flash";
  const manifestSha256 = primary ? qwenManifestSha256 : deepSeekManifestSha256;
  const evalVersion = primary ? "synthetic-qwen38-eval-v1" : "synthetic-deepseek-eval-v1";
  return {
    configurationStatus: "valid" as const,
    provider: primary ? "qwen" : "deepseek",
    modelFingerprint: getAaisAiModelFingerprint(model),
    endpointFingerprint: primary ? "1".repeat(64) : "2".repeat(64),
    thinkingMode: "disabled" as const,
    temperature: 0.2,
    maxTokens: 600,
    observedRevisionSha256: primary ? "3".repeat(64) : "4".repeat(64),
    evalApproval: createEvalApproval({
      role,
      evalVersion,
      manifestSha256,
    }),
  };
}

function createEvalApproval(input: {
  role: "primary" | "secondary";
  evalVersion: string;
  manifestSha256: string;
}) {
  const primary = input.role === "primary";
  return {
    approved: true,
    evalVersion: input.evalVersion,
    manifest: {
      status: "verified" as const,
      evalVersion: input.evalVersion,
      provider: primary ? "qwen" as const : "deepseek" as const,
      source: "configured" as const,
      manifestSha256: input.manifestSha256,
      passedAt: "2026-08-21T00:00:00.000Z",
      expiresAt: "2026-09-20T00:00:00.000Z",
      releaseEvidence: {
        endpointFingerprint: primary ? "1".repeat(64) : "2".repeat(64),
        thinkingMode: "disabled" as const,
        temperature: 0.2,
        maxTokens: 600,
        observedRevisionSha256: primary ? "3".repeat(64) : "4".repeat(64),
        evalSuiteSha256: "5".repeat(64),
        evalDataSha256: "6".repeat(64),
        agentPromptContractSha256: {
          A1: "7".repeat(64),
          A2: "8".repeat(64),
          A3: "9".repeat(64),
          A4: "a".repeat(64),
        },
        caBackgroundSha256: "b".repeat(64),
        guardrailSha256: "c".repeat(64),
        locales: ["zh-CN", "en-US"] as Array<"zh-CN" | "en-US">,
        signingKeyId: "synthetic-eval-key-v1",
        signatureSha256: primary ? "7".repeat(64) : "8".repeat(64),
        signatureVerified: true as const,
      },
    },
  };
}

function createApprovedTestFixtureLock(): AaisAiProductionReleaseLock {
  return {
    schemaVersion: 1,
    contractVersion: "aais-ai-live-release-v1",
    lockId: "synthetic-contract-fixture-only-v1",
    releaseStatus: "approved",
    deliveryPolicy: "require-live",
    providers: {
      primary: createProviderLock("primary"),
      secondary: createProviderLock("secondary"),
    },
    releaseReceipt: {
      required: true,
      verificationStage: "external-post-deploy",
      signingKeyId: "synthetic-release-receipt-key-v1",
      verifyingKeySpkiSha256: "d".repeat(64),
      productionUrl: null,
      gitCommitSha: null,
      deploymentId: null,
      configGeneration: null,
      auditNonce: null,
      operationIdDerivation: null,
      privacyEvidenceSha256: null,
      learnerCanaryEvidenceSha256: null,
    },
    redaction: {
      secrets: "omitted",
      modelIds: "fingerprint-only",
      rawPrompts: "omitted",
      rawOutputs: "omitted",
    },
  };
}

function createProviderLock<T extends "primary" | "secondary">(
  role: T,
): AaisAiProductionReleaseLock["providers"][T] {
  const primary = role === "primary";
  return {
    role,
    required: true as const,
    provider: primary ? "qwen" as const : "deepseek" as const,
    model: primary ? "qwen3.8-max" : "deepseek-v4-flash",
    endpointFingerprint: primary ? "1".repeat(64) : "2".repeat(64),
    thinkingMode: "disabled" as const,
    temperature: 0.2,
    maxTokens: 600,
    observedModel: primary ? "qwen3.8-max" : "deepseek-v4-flash",
    observedRevisionSha256: primary ? "3".repeat(64) : "4".repeat(64),
    evalVersion: primary ? "synthetic-qwen38-eval-v1" : "synthetic-deepseek-eval-v1",
    manifestSha256: primary ? qwenManifestSha256 : deepSeekManifestSha256,
    evalSuiteSha256: "5".repeat(64),
    evalDataSha256: "6".repeat(64),
    agentPromptContractSha256: {
      A1: "7".repeat(64),
      A2: "8".repeat(64),
      A3: "9".repeat(64),
      A4: "a".repeat(64),
    },
    caBackgroundSha256: "b".repeat(64),
    guardrailSha256: "c".repeat(64),
    locales: ["zh-CN", "en-US"] as Array<"zh-CN" | "en-US">,
    passedAt: "2026-08-21T00:00:00.000Z",
    expiresAt: "2026-09-20T00:00:00.000Z",
    manifestSigningKeyId: "synthetic-eval-key-v1",
    manifestSignatureSha256: primary ? "7".repeat(64) : "8".repeat(64),
    evidenceStatus: "verified" as const,
    observedModelRequired: true as const,
  } as AaisAiProductionReleaseLock["providers"][T];
}
