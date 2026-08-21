import { generateKeyPairSync, sign } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  createAaisAiEvalManifestSha256,
  createAaisAiEvalManifestSigningPayload,
  getAaisAiEvalApproval,
} from "@/lib/server/aais-ai-eval-manifest";

const manifestNow = new Date("2026-08-21T02:00:00.000Z");
const manifestSigningKeyId = "synthetic-eval-key-v1";
const { publicKey: manifestPublicKey, privateKey: manifestPrivateKey } =
  generateKeyPairSync("ed25519");
const manifestVerifyingKeySpki = manifestPublicKey.export({
  format: "der",
  type: "spki",
}).toString("base64");

describe("AAIS Qwen 3.8 and DeepSeek evaluation manifest contracts", () => {
  it("verifies primary and secondary evidence through role-specific variables", () => {
    const env = createRoleManifestEnv();
    const primary = getAaisAiEvalApproval({
      required: true,
      provider: "qwen",
      model: "qwen3.8-max",
      providerRole: "primary",
      env,
      now: manifestNow,
    });
    const secondary = getAaisAiEvalApproval({
      required: true,
      provider: "deepseek",
      model: "deepseek-v4-flash",
      providerRole: "fallback",
      env,
      now: manifestNow,
    });

    expect(primary).toMatchObject({
      approved: true,
      evalVersion: "synthetic-qwen38-eval-v1",
      manifest: {
        status: "verified",
        source: "configured",
        passedAt: "2026-08-21T00:00:00.000Z",
      },
    });
    expect(secondary).toMatchObject({
      approved: true,
      evalVersion: "synthetic-deepseek-eval-v1",
      manifest: {
        status: "verified",
        source: "configured",
        passedAt: "2026-08-21T00:00:00.000Z",
      },
    });
    expect(primary.manifest.manifestSha256).toMatch(/^[a-f0-9]{64}$/);
    expect(secondary.manifest.manifestSha256).toMatch(/^[a-f0-9]{64}$/);
    expect(primary.manifest.manifestSha256).not.toBe(secondary.manifest.manifestSha256);
  });

  it("does not let primary evidence satisfy the secondary role", () => {
    const env = createRoleManifestEnv();
    env.AAIS_AI_FALLBACK_EVAL_MANIFEST_JSON = env.AAIS_AI_EVAL_MANIFEST_JSON;
    const primary = getAaisAiEvalApproval({
      required: true,
      provider: "qwen",
      model: "qwen3.8-max",
      providerRole: "primary",
      env,
      now: manifestNow,
    });
    const secondary = getAaisAiEvalApproval({
      required: true,
      provider: "deepseek",
      model: "deepseek-v4-flash",
      providerRole: "fallback",
      env,
      now: manifestNow,
    });

    expect(primary.approved).toBe(true);
    expect(secondary).toMatchObject({
      approved: false,
      manifest: {
        status: "mismatch",
        issue: "AAIS_AI_FALLBACK_EVAL_MANIFEST",
      },
    });
  });

  it("fails closed on an exact-model mismatch without weakening the other role", () => {
    const env = createRoleManifestEnv();
    const qwenManifest = createSignedSyntheticManifest({
      evalVersion: "synthetic-qwen38-eval-v1",
      model: "qwen3.7-max",
    });
    env.AAIS_AI_EVAL_MANIFEST_JSON = JSON.stringify(qwenManifest);
    env.AAIS_AI_EVAL_MANIFEST_SHA256 = createAaisAiEvalManifestSha256(qwenManifest);
    const primary = getAaisAiEvalApproval({
      required: true,
      provider: "qwen",
      model: "qwen3.8-max",
      providerRole: "primary",
      env,
      now: manifestNow,
    });
    const secondary = getAaisAiEvalApproval({
      required: true,
      provider: "deepseek",
      model: "deepseek-v4-flash",
      providerRole: "fallback",
      env,
      now: manifestNow,
    });

    expect(primary).toMatchObject({
      approved: false,
      manifest: {
        status: "mismatch",
        issue: "AAIS_AI_EVAL_MANIFEST",
      },
    });
    expect(secondary.approved).toBe(true);
  });

  it("derives a stable digest from canonical JSON rather than whitespace or key order", () => {
    const manifest = createSignedSyntheticManifest({
      evalVersion: "synthetic-qwen38-eval-v1",
      model: "qwen3.8-max",
    });
    const baseEnv = createRoleManifestEnv();
    baseEnv.AAIS_AI_EVAL_MANIFEST_JSON = JSON.stringify(manifest);
    const reorderedEnv = createRoleManifestEnv();
    reorderedEnv.AAIS_AI_EVAL_MANIFEST_JSON = JSON.stringify(reverseObjectKeys(manifest), null, 2);

    const base = getAaisAiEvalApproval({
      required: true,
      provider: "qwen",
      model: "qwen3.8-max",
      providerRole: "primary",
      env: baseEnv,
      now: manifestNow,
    });
    const reordered = getAaisAiEvalApproval({
      required: true,
      provider: "qwen",
      model: "qwen3.8-max",
      providerRole: "primary",
      env: reorderedEnv,
      now: manifestNow,
    });

    expect(base.approved).toBe(true);
    expect(reordered.approved).toBe(true);
    expect(reordered.manifest.manifestSha256).toBe(base.manifest.manifestSha256);
  });

  it("does not let the approval flag bypass a missing role-specific manifest digest", () => {
    const env = createRoleManifestEnv();
    delete env.AAIS_AI_FALLBACK_EVAL_MANIFEST_SHA256;

    const secondary = getAaisAiEvalApproval({
      required: true,
      provider: "deepseek",
      model: "deepseek-v4-flash",
      providerRole: "fallback",
      env,
      now: manifestNow,
    });

    expect(env.AAIS_AI_FALLBACK_EVAL_APPROVED).toBe("true");
    expect(secondary).toMatchObject({
      approved: false,
      manifest: {
        status: "mismatch",
        issue: "AAIS_AI_FALLBACK_EVAL_MANIFEST",
      },
    });
  });

  it("reports otherwise-valid expired evidence distinctly", () => {
    const manifest = createSignedSyntheticManifest({
      evalVersion: "synthetic-qwen38-eval-v1",
      model: "qwen3.8-max",
      passedAt: "2026-07-20T00:00:00.000Z",
      expiresAt: "2026-08-19T00:00:00.000Z",
    });
    const env = createRoleManifestEnv();
    env.AAIS_AI_EVAL_MANIFEST_JSON = JSON.stringify(manifest);
    env.AAIS_AI_EVAL_MANIFEST_SHA256 = createAaisAiEvalManifestSha256(manifest);
    const primary = getAaisAiEvalApproval({
      required: true,
      provider: "qwen",
      model: "qwen3.8-max",
      providerRole: "primary",
      env,
      now: manifestNow,
    });

    expect(primary.approved).toBe(false);
    expect(primary.manifest).toMatchObject({
      status: "expired",
      issue: "AAIS_AI_EVAL_MANIFEST",
    });
  });

  it("rejects over-30-day and incomplete locale-agent coverage evidence", () => {
    const cases = [
      createSignedSyntheticManifest({
        evalVersion: "synthetic-qwen38-eval-v1",
        model: "qwen3.8-max",
        passedAt: "2026-08-01T00:00:00.000Z",
        expiresAt: "2026-09-01T00:00:00.001Z",
      }),
      createSignedSyntheticManifest({
        evalVersion: "synthetic-qwen38-eval-v1",
        model: "qwen3.8-max",
        omitLocaleForAgent: "A4",
      }),
    ];

    for (const manifest of cases) {
      const env = createRoleManifestEnv();
      env.AAIS_AI_EVAL_MANIFEST_JSON = JSON.stringify(manifest);
      env.AAIS_AI_EVAL_MANIFEST_SHA256 = createAaisAiEvalManifestSha256(manifest);
      const primary = getAaisAiEvalApproval({
        required: true,
        provider: "qwen",
        model: "qwen3.8-max",
        providerRole: "primary",
        env,
        now: manifestNow,
      });
      expect(primary.approved).toBe(false);
      expect(primary.manifest.status).toBe("mismatch");
    }
  });

  it("rejects Qwen and DeepSeek manifests swapped between provider roles", () => {
    const env = createRoleManifestEnv();
    const wrongPrimary = createSignedSyntheticManifest({
      evalVersion: "synthetic-qwen38-eval-v1",
      model: "qwen3.8-max",
      provider: "deepseek",
    });
    const wrongSecondary = createSignedSyntheticManifest({
      evalVersion: "synthetic-deepseek-eval-v1",
      model: "deepseek-v4-flash",
      provider: "qwen",
    });
    env.AAIS_AI_EVAL_MANIFEST_JSON = JSON.stringify(wrongPrimary);
    env.AAIS_AI_EVAL_MANIFEST_SHA256 = createAaisAiEvalManifestSha256(wrongPrimary);
    env.AAIS_AI_FALLBACK_EVAL_MANIFEST_JSON = JSON.stringify(wrongSecondary);
    env.AAIS_AI_FALLBACK_EVAL_MANIFEST_SHA256 =
      createAaisAiEvalManifestSha256(wrongSecondary);

    expect(getAaisAiEvalApproval({
      required: true,
      provider: "qwen",
      model: "qwen3.8-max",
      providerRole: "primary",
      env,
      now: manifestNow,
    }).approved).toBe(false);
    expect(getAaisAiEvalApproval({
      required: true,
      provider: "deepseek",
      model: "deepseek-v4-flash",
      providerRole: "fallback",
      env,
      now: manifestNow,
    }).approved).toBe(false);
  });
});

function createRoleManifestEnv(): NodeJS.ProcessEnv {
  const primary = createSignedSyntheticManifest({
    evalVersion: "synthetic-qwen38-eval-v1",
    model: "qwen3.8-max",
  });
  const secondary = createSignedSyntheticManifest({
    evalVersion: "synthetic-deepseek-eval-v1",
    model: "deepseek-v4-flash",
  });
  return {
    NODE_ENV: "test",
    AAIS_AI_EVAL_APPROVED: "true",
    AAIS_AI_EVAL_VERSION: "synthetic-qwen38-eval-v1",
    AAIS_AI_EVAL_MANIFEST_JSON: JSON.stringify(primary),
    AAIS_AI_EVAL_MANIFEST_SHA256: createAaisAiEvalManifestSha256(primary),
    AAIS_AI_EVAL_SIGNING_KEY_ID: manifestSigningKeyId,
    AAIS_AI_EVAL_VERIFYING_KEY_SPKI: manifestVerifyingKeySpki,
    AAIS_AI_FALLBACK_EVAL_APPROVED: "true",
    AAIS_AI_FALLBACK_EVAL_VERSION: "synthetic-deepseek-eval-v1",
    AAIS_AI_FALLBACK_EVAL_MANIFEST_JSON: JSON.stringify(secondary),
    AAIS_AI_FALLBACK_EVAL_MANIFEST_SHA256: createAaisAiEvalManifestSha256(secondary),
    AAIS_AI_FALLBACK_EVAL_SIGNING_KEY_ID: manifestSigningKeyId,
    AAIS_AI_FALLBACK_EVAL_VERIFYING_KEY_SPKI: manifestVerifyingKeySpki,
  };
}

function createSignedSyntheticManifest(input: {
  evalVersion: string;
  model: string;
  passedAt?: string;
  expiresAt?: string;
  omitLocaleForAgent?: "A1" | "A2" | "A3" | "A4";
  provider?: "qwen" | "deepseek";
}) {
  const manifest = {
    schemaVersion: 1,
    evalVersion: input.evalVersion,
    provider: input.provider ?? (input.model.startsWith("deepseek") ? "deepseek" : "qwen"),
    model: input.model,
    status: "passed",
    passedAt: input.passedAt ?? "2026-08-21T00:00:00.000Z",
    expiresAt: input.expiresAt ?? "2026-09-20T00:00:00.000Z",
    sampleCount: 4,
    blockedCount: 0,
    agentEvidence: {
      contractVersion: "aais-a1-a4-ca-eval-v2",
      requiredAgents: ["A1", "A2", "A3", "A4"],
      coveredAgents: ["A1", "A2", "A3", "A4"],
      requiredCaModules: [
        "Modelling",
        "Coaching",
        "Scaffolding",
        "Fading",
        "Articulation",
        "Reflection",
      ],
      coveredCaModules: [
        "Modelling",
        "Coaching",
        "Scaffolding",
        "Fading",
        "Articulation",
        "Reflection",
      ],
      coverage: {
        A1: createCoverage(
          "导学智能体",
          "frontend-guide-scaffolding",
          "a1-synthetic-contract-sample",
          ["Scaffolding", "Fading"],
        ),
        A2: createCoverage(
          "专家智能体",
          "frontend-expert-modelling-coaching",
          "a2-synthetic-contract-sample",
          ["Modelling", "Coaching"],
        ),
        A3: createCoverage(
          "监督智能体",
          "backend-supervision-a1-signal",
          "a3-synthetic-contract-sample",
          ["Scaffolding"],
        ),
        A4: createCoverage(
          "反思智能体",
          "backend-reflection-articulation",
          "a4-synthetic-contract-sample",
          ["Articulation", "Reflection"],
        ),
      },
      caBackgroundIncluded: true,
      rawPromptsStored: false,
      rawOutputsStored: false,
      complete: true,
    },
    releaseEvidence: {
      contractVersion: "aais-ai-eval-release-v1",
      runtimeContract: {
        endpointFingerprint: input.model === "qwen3.8-max" ? "1".repeat(64) : "2".repeat(64),
        thinkingMode: "disabled",
        temperature: 0.2,
        maxTokens: 600,
        observedRevisionSha256: input.model === "qwen3.8-max"
          ? "3".repeat(64)
          : "4".repeat(64),
      },
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
      localeCoverage: {
        requiredLocales: ["zh-CN", "en-US"],
        coveredLocales: ["zh-CN", "en-US"],
        agentLocales: {
          A1: input.omitLocaleForAgent === "A1" ? ["zh-CN"] : ["zh-CN", "en-US"],
          A2: input.omitLocaleForAgent === "A2" ? ["zh-CN"] : ["zh-CN", "en-US"],
          A3: input.omitLocaleForAgent === "A3" ? ["zh-CN"] : ["zh-CN", "en-US"],
          A4: input.omitLocaleForAgent === "A4" ? ["zh-CN"] : ["zh-CN", "en-US"],
        },
        complete: true,
      },
    },
    attestation: {
      algorithm: "ed25519",
      keyId: manifestSigningKeyId,
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
    manifestPrivateKey,
  ).toString("base64");
  return manifest;
}

function createCoverage(
  label: string,
  responsibility: string,
  sampleId: string,
  caModules: string[],
) {
  return {
    label,
    responsibility,
    sampleIds: [sampleId],
    caModules,
    complete: true,
  };
}

function reverseObjectKeys(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(reverseObjectKeys);
  }
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .reverse()
        .map(([key, item]) => [key, reverseObjectKeys(item)]),
    );
  }
  return value;
}
