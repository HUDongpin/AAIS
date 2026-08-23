import { describe, expect, it } from "vitest";
import snapshotManifest from "@/data/aais-ai-eval-qwen3.7-max-2026-06-08.json";
import {
  getAaisAiEvalApproval,
  verifyAaisAiEvalManifest,
} from "@/lib/server/aais-ai-eval-manifest";
import signingReceipt from "../docs/evidence/aais-ai-eval-qwen3.7-max-2026-06-08-signing-receipt-2026-08-23.json";

const runtime = {
  endpoint: "https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions",
  thinkingMode: "disabled" as const,
  maxTokens: 600,
  maxRetries: 0,
};

function approvedEnvironment(
  overrides: Record<string, string | undefined> = {},
): NodeJS.ProcessEnv {
  return {
    NODE_ENV: "production",
    AAIS_AI_EVAL_APPROVED: "true",
    AAIS_AI_EVAL_VERSION: snapshotManifest.evalVersion,
    AAIS_AI_EVAL_MANIFEST_SHA256: signingReceipt.manifestSha256,
    AAIS_AI_EVAL_SIGNING_KEY_ID: signingReceipt.attestation.keyId,
    AAIS_AI_EVAL_VERIFYING_KEY_SPKI: signingReceipt.attestation.verifyingKeySpki,
    ...overrides,
  } as NodeJS.ProcessEnv;
}

describe("signed Qwen snapshot evaluation manifest", () => {
  it("approves only the exact snapshot, runtime contract, source contract, and trust root", () => {
    expect(getAaisAiEvalApproval({
      required: true,
      provider: "openai-compatible",
      model: snapshotManifest.model,
      runtime,
      env: approvedEnvironment(),
      now: new Date("2026-08-23T03:00:00.000Z"),
    })).toEqual({
      approved: true,
      evalVersion: snapshotManifest.evalVersion,
      manifest: {
        status: "verified",
        evalVersion: snapshotManifest.evalVersion,
        source: "bundled",
        schemaVersion: 2,
      },
    });
  });

  it.each([
    ["model alias", { model: "qwen3.7-max" }, "missing"],
    ["runtime retries", { runtime: { ...runtime, maxRetries: 1 } }, "invalid"],
    ["runtime endpoint", {
      runtime: {
        ...runtime,
        endpoint: "https://dashscope-intl.aliyuncs.com/compatible-mode/v1/chat/completions",
      },
    }, "invalid"],
  ])("fails closed on a mismatched %s", (_label, overrides, expectedStatus) => {
    expect(verifyAaisAiEvalManifest({
      required: true,
      evalVersion: snapshotManifest.evalVersion,
      provider: "openai-compatible",
      model: snapshotManifest.model,
      runtime,
      env: approvedEnvironment(),
      now: new Date("2026-08-23T03:00:00.000Z"),
      ...overrides,
    }).status).toBe(expectedStatus);
  });

  it("rejects a tampered configured manifest even when the original trust values remain", () => {
    const tampered = structuredClone(snapshotManifest);
    tampered.releaseEvidence.evalDataSha256 = "0".repeat(64);

    expect(verifyAaisAiEvalManifest({
      required: true,
      evalVersion: snapshotManifest.evalVersion,
      provider: "openai-compatible",
      model: snapshotManifest.model,
      runtime,
      env: approvedEnvironment({
        AAIS_AI_EVAL_MANIFEST_JSON: JSON.stringify(tampered),
      }),
      now: new Date("2026-08-23T03:00:00.000Z"),
    })).toMatchObject({
      status: "invalid",
      issue: "AAIS_AI_EVAL_MANIFEST",
    });
  });

  it("rejects a missing external trust anchor and expired evidence", () => {
    expect(verifyAaisAiEvalManifest({
      required: true,
      evalVersion: snapshotManifest.evalVersion,
      provider: "openai-compatible",
      model: snapshotManifest.model,
      runtime,
      env: approvedEnvironment({ AAIS_AI_EVAL_VERIFYING_KEY_SPKI: "" }),
      now: new Date("2026-08-23T03:00:00.000Z"),
    }).status).toBe("invalid");

    expect(verifyAaisAiEvalManifest({
      required: true,
      evalVersion: snapshotManifest.evalVersion,
      provider: "openai-compatible",
      model: snapshotManifest.model,
      runtime,
      env: approvedEnvironment(),
      now: new Date("2027-08-24T00:00:00.000Z"),
    }).status).toBe("expired");
  });
});
