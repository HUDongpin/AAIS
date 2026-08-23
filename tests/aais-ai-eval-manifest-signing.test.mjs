import { generateKeyPairSync } from "node:crypto";
import { describe, expect, it } from "vitest";
import snapshotManifest from "../src/data/aais-ai-eval-qwen3.7-max-2026-06-08.json";
import {
  AaisAiEvalManifestSigningError,
  signAaisAiEvalManifest,
} from "../scripts/sign-aais-ai-eval-manifest.mjs";

function unsignedManifest() {
  const manifest = structuredClone(snapshotManifest);
  manifest.attestation = {
    algorithm: "ed25519",
    keyId: "",
    signature: "",
  };
  return manifest;
}

function signingInput(overrides = {}) {
  const { privateKey } = generateKeyPairSync("ed25519");
  return {
    manifest: unsignedManifest(),
    expectedModel: snapshotManifest.model,
    expectedSnapshotSha256:
      snapshotManifest.releaseEvidence.runtimeContract.observedSnapshotSha256,
    signingKeyId: "aais-test-ed25519-v1",
    signingKeyPkcs8: privateKey
      .export({ format: "der", type: "pkcs8" })
      .toString("base64"),
    now: new Date("2026-08-23T03:00:00.000Z"),
    ...overrides,
  };
}

describe("AAIS snapshot evaluation signing", () => {
  it("creates a self-verified signed manifest and redacted public receipt", () => {
    const input = signingInput();
    const result = signAaisAiEvalManifest(input);

    expect(result.manifest.attestation).toMatchObject({
      algorithm: "ed25519",
      keyId: "aais-test-ed25519-v1",
      signature: expect.any(String),
    });
    expect(result.receipt).toMatchObject({
      schemaVersion: 2,
      model: snapshotManifest.model,
      manifestSha256: result.manifestSha256,
      attestation: {
        algorithm: "ed25519",
        signatureVerified: true,
        verifyingKeySpki: expect.any(String),
      },
      redaction: {
        privateKey: "omitted",
        prompts: "omitted",
        outputs: "omitted",
        secrets: "omitted",
      },
    });
    expect(JSON.stringify(result)).not.toContain(input.signingKeyPkcs8);
  });

  it("rejects a signing request bound to a different snapshot digest", () => {
    expect(() => signAaisAiEvalManifest(signingInput({
      expectedSnapshotSha256: "0".repeat(64),
    }))).toThrowError(expect.objectContaining({
      name: "AaisAiEvalManifestSigningError",
      code: "AAIS_AI_MANIFEST_RELEASE_EVIDENCE_INCOMPLETE",
    }));
    expect(AaisAiEvalManifestSigningError).toBeTypeOf("function");
  });
});
