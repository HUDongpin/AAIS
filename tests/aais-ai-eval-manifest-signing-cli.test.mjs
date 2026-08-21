import { generateKeyPairSync } from "node:crypto";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  AaisAiEvalManifestSigningError,
  createManifestSha256,
  signAaisAiEvalManifest,
  writeSignedAaisAiEvalManifest,
} from "../scripts/sign-aais-ai-eval-manifest.mjs";
import {
  createAaisAiEvalManifestSha256,
  getAaisAiEvalApproval,
} from "@/lib/server/aais-ai-eval-manifest";

const now = new Date("2026-08-21T12:00:00.000Z");
const signingKeyId = "synthetic-manifest-signing-key-v1";
const expectedRevisionSha256 = "d".repeat(64);
const { privateKey } = generateKeyPairSync("ed25519");
const signingKeyPkcs8 = privateKey.export({
  format: "der",
  type: "pkcs8",
}).toString("base64");

describe("AAIS AI evaluation manifest signing CLI", () => {
  it("signs complete evidence that the production verifier accepts", () => {
    const result = signAaisAiEvalManifest(createSigningInput());
    const verifyingKeySpki = result.receipt.attestation.verifyingKeySpki;
    const env = {
      AAIS_AI_EVAL_APPROVED: "true",
      AAIS_AI_EVAL_VERSION: result.manifest.evalVersion,
      AAIS_AI_EVAL_MANIFEST_JSON: JSON.stringify(result.manifest),
      AAIS_AI_EVAL_MANIFEST_SHA256: result.manifestSha256,
      AAIS_AI_EVAL_SIGNING_KEY_ID: signingKeyId,
      AAIS_AI_EVAL_VERIFYING_KEY_SPKI: verifyingKeySpki,
    };

    expect(result.manifestSha256).toBe(
      createAaisAiEvalManifestSha256(result.manifest),
    );
    expect(result.manifestSha256).toBe(createManifestSha256(result.manifest));
    expect(result.receipt).toMatchObject({
      schemaVersion: 1,
      provider: "deepseek",
      model: "deepseek-v4-flash",
      observedRevisionSha256: expectedRevisionSha256,
      manifestSha256: result.manifestSha256,
      attestation: {
        algorithm: "ed25519",
        keyId: signingKeyId,
        signatureVerified: true,
      },
      redaction: {
        privateKey: "omitted",
        prompts: "omitted",
        outputs: "omitted",
        secrets: "omitted",
      },
    });
    expect(getAaisAiEvalApproval({
      required: true,
      provider: "deepseek",
      model: "deepseek-v4-flash",
      env,
      now,
    })).toMatchObject({
      approved: true,
      evalVersion: "deepseek-v4-flash-formal-eval-v1",
      manifest: {
        status: "verified",
        source: "configured",
        manifestSha256: result.manifestSha256,
        releaseEvidence: {
          observedRevisionSha256: expectedRevisionSha256,
          signingKeyId,
          signatureVerified: true,
        },
      },
    });
  });

  it("writes restricted, non-overwriting manifest and receipt files without the private key", () => {
    const directory = mkdtempSync(join(tmpdir(), "aais-manifest-sign-"));
    const outputPath = join(directory, "manifest.json");
    const receiptPath = join(directory, "receipt.json");
    const result = writeSignedAaisAiEvalManifest({
      ...createSigningInput(),
      outputPath,
      receiptPath,
    });
    const manifestText = readFileSync(outputPath, "utf8");
    const receiptText = readFileSync(receiptPath, "utf8");

    expect(JSON.parse(manifestText)).toEqual(result.manifest);
    expect(JSON.parse(receiptText)).toEqual(result.receipt);
    expect(`${manifestText}${receiptText}`).not.toContain(signingKeyPkcs8);
    expect(() => writeSignedAaisAiEvalManifest({
      ...createSigningInput(),
      outputPath,
      receiptPath,
    })).toThrowError(expect.objectContaining({
      code: "AAIS_AI_MANIFEST_OUTPUT_WRITE_FAILED",
    }));
    expect(readFileSync(outputPath, "utf8")).toBe(manifestText);
    expect(readFileSync(receiptPath, "utf8")).toBe(receiptText);
  });

  it("fails closed on incomplete, mismatched, stale, or pre-attested evidence", () => {
    const cases = [
      {
        code: "AAIS_AI_MANIFEST_AGENT_EVIDENCE_INCOMPLETE",
        mutate: (manifest) => {
          delete manifest.agentEvidence.coverage.A4;
        },
      },
      {
        code: "AAIS_AI_MANIFEST_RELEASE_EVIDENCE_INCOMPLETE",
        mutate: (manifest) => {
          manifest.releaseEvidence.localeCoverage.agentLocales.A3 = ["zh-CN"];
        },
      },
      {
        code: "AAIS_AI_MANIFEST_RELEASE_EVIDENCE_INCOMPLETE",
        mutate: (manifest) => {
          manifest.releaseEvidence.runtimeContract.observedRevisionSha256 = "e".repeat(64);
        },
      },
      {
        code: "AAIS_AI_MANIFEST_AGENT_EVIDENCE_INCOMPLETE",
        mutate: (manifest) => {
          manifest.agentEvidence.coverage.A4.sampleIds[1] =
            manifest.agentEvidence.coverage.A1.sampleIds[0];
        },
      },
      {
        code: "AAIS_AI_MANIFEST_EVIDENCE_WINDOW_INVALID",
        mutate: (manifest) => {
          manifest.expiresAt = "2026-09-20T12:00:00.001Z";
        },
      },
      {
        code: "AAIS_AI_MANIFEST_CONTRACT_INVALID",
        mutate: (manifest) => {
          manifest.blockedCount = 1;
        },
      },
      {
        code: "AAIS_AI_MANIFEST_ATTESTATION_ALREADY_SET",
        mutate: (manifest) => {
          manifest.attestation.signature = "already-set";
        },
      },
    ];

    for (const testCase of cases) {
      const input = createSigningInput();
      testCase.mutate(input.manifest);
      expectSigningError(() => signAaisAiEvalManifest(input), testCase.code);
    }
  });

  it("fails closed on a wrong key type and does not disclose key material", () => {
    const { privateKey: rsaPrivateKey } = generateKeyPairSync("rsa", {
      modulusLength: 2048,
    });
    const rsaPkcs8 = rsaPrivateKey.export({
      format: "der",
      type: "pkcs8",
    }).toString("base64");
    let caught;
    try {
      signAaisAiEvalManifest({
        ...createSigningInput(),
        signingKeyPkcs8: rsaPkcs8,
      });
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(AaisAiEvalManifestSigningError);
    expect(caught).toMatchObject({ code: "AAIS_AI_MANIFEST_SIGNING_KEY_INVALID" });
    expect(String(caught)).not.toContain(rsaPkcs8);
  });
});

function createSigningInput() {
  return {
    manifest: createUnsignedManifest(),
    expectedProvider: "deepseek",
    expectedModel: "deepseek-v4-flash",
    expectedRevisionSha256,
    signingKeyId,
    signingKeyPkcs8,
    now,
  };
}

function createUnsignedManifest() {
  return {
    schemaVersion: 1,
    evalVersion: "deepseek-v4-flash-formal-eval-v1",
    provider: "deepseek",
    model: "deepseek-v4-flash",
    status: "passed",
    passedAt: "2026-08-21T11:00:00.000Z",
    expiresAt: "2026-09-20T11:00:00.000Z",
    sampleCount: 8,
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
          ["a1-zh-formal", "a1-en-formal"],
          ["Scaffolding", "Fading"],
        ),
        A2: createCoverage(
          "专家智能体",
          "frontend-expert-modelling-coaching",
          ["a2-zh-formal", "a2-en-formal"],
          ["Modelling", "Coaching"],
        ),
        A3: createCoverage(
          "监督智能体",
          "backend-supervision-a1-signal",
          ["a3-zh-formal", "a3-en-formal"],
          ["Scaffolding"],
        ),
        A4: createCoverage(
          "反思智能体",
          "backend-reflection-articulation",
          ["a4-zh-formal", "a4-en-formal"],
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
        endpointFingerprint: "1".repeat(64),
        thinkingMode: "disabled",
        temperature: 0.2,
        maxTokens: 600,
        observedRevisionSha256: expectedRevisionSha256,
      },
      evalSuiteSha256: "2".repeat(64),
      evalDataSha256: "3".repeat(64),
      agentPromptContractSha256: {
        A1: "4".repeat(64),
        A2: "5".repeat(64),
        A3: "6".repeat(64),
        A4: "7".repeat(64),
      },
      caBackgroundSha256: "8".repeat(64),
      guardrailSha256: "9".repeat(64),
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
      keyId: "",
      signature: "",
    },
    redaction: {
      prompts: "summarized",
      secrets: "omitted",
    },
  };
}

function createCoverage(label, responsibility, sampleIds, caModules) {
  return { label, responsibility, sampleIds, caModules, complete: true };
}

function expectSigningError(callback, code) {
  let caught;
  try {
    callback();
  } catch (error) {
    caught = error;
  }
  expect(caught).toBeInstanceOf(AaisAiEvalManifestSigningError);
  expect(caught).toMatchObject({ code });
}
