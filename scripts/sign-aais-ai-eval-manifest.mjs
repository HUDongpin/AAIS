#!/usr/bin/env node

import {
  createHash,
  createPrivateKey,
  createPublicKey,
  sign as signPayload,
  verify as verifySignature,
} from "node:crypto";
import {
  closeSync,
  constants as fsConstants,
  fsyncSync,
  openSync,
  readFileSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

export const aaisAiEvalManifestSigningReceiptContractVersion =
  "aais-ai-eval-manifest-signing-receipt-v1";

const requiredAgentIds = ["A1", "A2", "A3", "A4"];
const requiredLocales = ["zh-CN", "en-US"];
const requiredCaModules = [
  "Modelling",
  "Coaching",
  "Scaffolding",
  "Fading",
  "Articulation",
  "Reflection",
];
const agentContracts = {
  A1: {
    label: "导学智能体",
    responsibility: "frontend-guide-scaffolding",
    caModules: ["Scaffolding", "Fading"],
  },
  A2: {
    label: "专家智能体",
    responsibility: "frontend-expert-modelling-coaching",
    caModules: ["Modelling", "Coaching"],
  },
  A3: {
    label: "监督智能体",
    responsibility: "backend-supervision-a1-signal",
    caModules: ["Scaffolding"],
  },
  A4: {
    label: "反思智能体",
    responsibility: "backend-reflection-articulation",
    caModules: ["Articulation", "Reflection"],
  },
};
const maximumEvidenceWindowMs = 30 * 24 * 60 * 60 * 1_000;
const maximumManifestBytes = 1024 * 1024;
const sha256Pattern = /^[a-f0-9]{64}$/;
const safeIdentifierPattern = /^[A-Za-z0-9][A-Za-z0-9._:-]{2,127}$/;

export class AaisAiEvalManifestSigningError extends Error {
  constructor(code) {
    super(code);
    this.name = "AaisAiEvalManifestSigningError";
    this.code = code;
  }
}

export function signAaisAiEvalManifest(input) {
  const expectedProvider = readProvider(input.expectedProvider);
  const expectedModel = readIdentifier(
    input.expectedModel,
    "AAIS_AI_MANIFEST_EXPECTED_MODEL_INVALID",
  );
  const expectedRevisionSha256 = readSha256(
    input.expectedRevisionSha256,
    "AAIS_AI_MANIFEST_EXPECTED_REVISION_INVALID",
  );
  const signingKeyId = readIdentifier(
    input.signingKeyId,
    "AAIS_AI_MANIFEST_SIGNING_KEY_ID_INVALID",
  );
  const now = readNow(input.now);
  const manifest = structuredClone(readRecord(
    input.manifest,
    "AAIS_AI_MANIFEST_INPUT_INVALID",
  ));

  validateUnsignedManifest({
    manifest,
    expectedProvider,
    expectedModel,
    expectedRevisionSha256,
    signingKeyId,
    now,
  });

  const privateKey = readEd25519PrivateKey(input.signingKeyPkcs8);
  const publicKey = createPublicKey(privateKey);
  const verifyingKeySpki = publicKey.export({ format: "der", type: "spki" });
  manifest.attestation = {
    algorithm: "ed25519",
    keyId: signingKeyId,
  };
  const signature = signPayload(
    null,
    Buffer.from(createManifestSigningPayload(manifest), "utf8"),
    privateKey,
  );
  manifest.attestation.signature = signature.toString("base64");

  if (signature.byteLength !== 64 || !verifySignature(
    null,
    Buffer.from(createManifestSigningPayload(manifest), "utf8"),
    publicKey,
    signature,
  )) {
    fail("AAIS_AI_MANIFEST_SIGNATURE_SELF_CHECK_FAILED");
  }

  const manifestSha256 = createManifestSha256(manifest);
  const receipt = {
    schemaVersion: 1,
    contractVersion: aaisAiEvalManifestSigningReceiptContractVersion,
    evalVersion: manifest.evalVersion,
    provider: manifest.provider,
    model: manifest.model,
    observedRevisionSha256:
      manifest.releaseEvidence.runtimeContract.observedRevisionSha256,
    passedAt: manifest.passedAt,
    expiresAt: manifest.expiresAt,
    manifestSha256,
    attestation: {
      algorithm: "ed25519",
      keyId: signingKeyId,
      signatureSha256: createHash("sha256").update(signature).digest("hex"),
      verifyingKeySpki: verifyingKeySpki.toString("base64"),
      verifyingKeySpkiSha256: createHash("sha256")
        .update(verifyingKeySpki)
        .digest("hex"),
      signatureVerified: true,
    },
    redaction: {
      privateKey: "omitted",
      prompts: "omitted",
      outputs: "omitted",
      secrets: "omitted",
    },
  };

  return { manifest, receipt, manifestSha256 };
}

export function writeSignedAaisAiEvalManifest(input) {
  const outputPath = readPath(
    input.outputPath,
    "AAIS_AI_MANIFEST_OUTPUT_PATH_INVALID",
  );
  const receiptPath = readPath(
    input.receiptPath,
    "AAIS_AI_MANIFEST_RECEIPT_PATH_INVALID",
  );
  if (resolve(outputPath) === resolve(receiptPath)) {
    fail("AAIS_AI_MANIFEST_OUTPUT_PATHS_COLLIDE");
  }

  const result = signAaisAiEvalManifest(input);
  const manifestBytes = `${JSON.stringify(result.manifest, null, 2)}\n`;
  const receiptBytes = `${JSON.stringify(result.receipt, null, 2)}\n`;
  writeExclusivePair([
    [outputPath, manifestBytes],
    [receiptPath, receiptBytes],
  ]);
  return {
    ...result,
    outputPath,
    receiptPath,
  };
}

export function createManifestSha256(manifest) {
  return createHash("sha256")
    .update(`aais-ai-eval-manifest-v1:${canonicalizeJson(manifest)}`)
    .digest("hex");
}

export function createManifestSigningPayload(manifest) {
  const record = readRecord(manifest, "AAIS_AI_MANIFEST_INPUT_INVALID");
  const attestation = readRecord(
    record.attestation,
    "AAIS_AI_MANIFEST_ATTESTATION_INVALID",
  );
  const unsignedAttestation = { ...attestation };
  delete unsignedAttestation.signature;
  return `aais-ai-eval-manifest-signature-v1:${canonicalizeJson({
    ...record,
    attestation: unsignedAttestation,
  })}`;
}

function validateUnsignedManifest(input) {
  const { manifest } = input;
  if (manifest.schemaVersion !== 1
    || !safeIdentifierPattern.test(String(manifest.evalVersion ?? ""))
    || manifest.provider !== input.expectedProvider
    || manifest.model !== input.expectedModel
    || manifest.status !== "passed"
    || !Number.isSafeInteger(manifest.sampleCount)
    || manifest.sampleCount < requiredAgentIds.length * requiredLocales.length
    || manifest.blockedCount !== 0
    || manifest.redaction?.prompts !== "summarized"
    || manifest.redaction?.secrets !== "omitted") {
    fail("AAIS_AI_MANIFEST_CONTRACT_INVALID");
  }

  validateEvidenceWindow(manifest, input.now);
  validateAgentEvidence(manifest.agentEvidence);
  validateReleaseEvidence(manifest.releaseEvidence, input.expectedRevisionSha256);

  if (manifest.attestation !== undefined) {
    const attestation = readRecord(
      manifest.attestation,
      "AAIS_AI_MANIFEST_ATTESTATION_INVALID",
    );
    if ((attestation.algorithm !== undefined && attestation.algorithm !== "ed25519")
      || (attestation.keyId !== undefined
        && attestation.keyId !== ""
        && attestation.keyId !== input.signingKeyId)
      || (attestation.signature !== undefined && attestation.signature !== "")) {
      fail("AAIS_AI_MANIFEST_ATTESTATION_ALREADY_SET");
    }
  }
}

function validateEvidenceWindow(manifest, now) {
  const passedAt = readCanonicalIsoTime(manifest.passedAt);
  const expiresAt = readCanonicalIsoTime(manifest.expiresAt);
  if (passedAt === null
    || expiresAt === null
    || passedAt > now.getTime()
    || expiresAt <= now.getTime()
    || expiresAt <= passedAt
    || expiresAt - passedAt > maximumEvidenceWindowMs) {
    fail("AAIS_AI_MANIFEST_EVIDENCE_WINDOW_INVALID");
  }
}

function validateAgentEvidence(evidence) {
  if (!isRecord(evidence)
    || evidence.contractVersion !== "aais-a1-a4-ca-eval-v2"
    || evidence.complete !== true
    || evidence.caBackgroundIncluded !== true
    || evidence.rawPromptsStored !== false
    || evidence.rawOutputsStored !== false
    || !arraysEqual(evidence.requiredAgents, requiredAgentIds)
    || !arraysEqual(evidence.coveredAgents, requiredAgentIds)
    || !arraysEqual(evidence.requiredCaModules, requiredCaModules)
    || !arraysEqual(evidence.coveredCaModules, requiredCaModules)
    || !isRecord(evidence.coverage)) {
    fail("AAIS_AI_MANIFEST_AGENT_EVIDENCE_INCOMPLETE");
  }

  const sampleIds = [];
  for (const agentId of requiredAgentIds) {
    const coverage = evidence.coverage[agentId];
    const contract = agentContracts[agentId];
    if (!isRecord(coverage)
      || coverage.label !== contract.label
      || coverage.responsibility !== contract.responsibility
      || coverage.complete !== true
      || !arraysEqual(coverage.caModules, contract.caModules)
      || !Array.isArray(coverage.sampleIds)
      || coverage.sampleIds.length < requiredLocales.length
      || !coverage.sampleIds.every(isSafeSampleId)) {
      fail("AAIS_AI_MANIFEST_AGENT_EVIDENCE_INCOMPLETE");
    }
    sampleIds.push(...coverage.sampleIds);
  }
  if (new Set(sampleIds).size !== sampleIds.length) {
    fail("AAIS_AI_MANIFEST_AGENT_EVIDENCE_INCOMPLETE");
  }
}

function validateReleaseEvidence(evidence, expectedRevisionSha256) {
  const runtime = evidence?.runtimeContract;
  const localeCoverage = evidence?.localeCoverage;
  if (!isRecord(evidence)
    || evidence.contractVersion !== "aais-ai-eval-release-v1"
    || !isRecord(runtime)
    || !isSha256(runtime.endpointFingerprint)
    || runtime.thinkingMode !== "disabled"
    || !Number.isFinite(runtime.temperature)
    || runtime.temperature < 0
    || runtime.temperature > 2
    || !Number.isSafeInteger(runtime.maxTokens)
    || runtime.maxTokens < 1
    || runtime.maxTokens > 8_192
    || runtime.observedRevisionSha256 !== expectedRevisionSha256
    || !isSha256(evidence.evalSuiteSha256)
    || !isSha256(evidence.evalDataSha256)
    || !isRecord(evidence.agentPromptContractSha256)
    || !requiredAgentIds.every((agentId) =>
      isSha256(evidence.agentPromptContractSha256[agentId]))
    || !isSha256(evidence.caBackgroundSha256)
    || !isSha256(evidence.guardrailSha256)
    || !isRecord(localeCoverage)
    || localeCoverage.complete !== true
    || !arraysEqual(localeCoverage.requiredLocales, requiredLocales)
    || !arraysEqual(localeCoverage.coveredLocales, requiredLocales)
    || !isRecord(localeCoverage.agentLocales)
    || !requiredAgentIds.every((agentId) =>
      arraysEqual(localeCoverage.agentLocales[agentId], requiredLocales))) {
    fail("AAIS_AI_MANIFEST_RELEASE_EVIDENCE_INCOMPLETE");
  }
}

function readInputManifest(inputPath) {
  const path = readPath(inputPath, "AAIS_AI_MANIFEST_INPUT_PATH_INVALID");
  try {
    if (statSync(path).size > maximumManifestBytes) {
      fail("AAIS_AI_MANIFEST_INPUT_TOO_LARGE");
    }
    return JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    if (error instanceof AaisAiEvalManifestSigningError) throw error;
    fail("AAIS_AI_MANIFEST_INPUT_INVALID");
  }
}

function readEd25519PrivateKey(value) {
  try {
    const encoded = String(value ?? "").trim();
    const bytes = Buffer.from(encoded, "base64");
    if (!encoded || bytes.toString("base64") !== encoded) throw new Error();
    const key = createPrivateKey({ key: bytes, format: "der", type: "pkcs8" });
    if (key.asymmetricKeyType !== "ed25519") throw new Error();
    return key;
  } catch {
    fail("AAIS_AI_MANIFEST_SIGNING_KEY_INVALID");
  }
}

function writeExclusivePair(entries) {
  const opened = [];
  try {
    for (const [path] of entries) {
      const descriptor = openSync(
        path,
        fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_WRONLY,
        0o600,
      );
      opened.push({ descriptor, path });
    }
    for (let index = 0; index < entries.length; index += 1) {
      writeFileSync(opened[index].descriptor, entries[index][1], "utf8");
      fsyncSync(opened[index].descriptor);
    }
    for (const item of opened) closeSync(item.descriptor);
  } catch {
    for (const item of opened) {
      try {
        closeSync(item.descriptor);
      } catch {
        // Best-effort close of a descriptor created by this invocation only.
      }
      try {
        unlinkSync(item.path);
      } catch {
        // Best-effort cleanup of a file created by this invocation only.
      }
    }
    fail("AAIS_AI_MANIFEST_OUTPUT_WRITE_FAILED");
  }
}

function canonicalizeJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalizeJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) =>
      `${JSON.stringify(key)}:${canonicalizeJson(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

function readProvider(value) {
  const normalized = String(value ?? "").trim();
  if (normalized !== "qwen" && normalized !== "deepseek") {
    fail("AAIS_AI_MANIFEST_EXPECTED_PROVIDER_INVALID");
  }
  return normalized;
}

function readIdentifier(value, code) {
  const normalized = String(value ?? "").trim();
  if (!safeIdentifierPattern.test(normalized)) fail(code);
  return normalized;
}

function readSha256(value, code) {
  const normalized = String(value ?? "").trim().toLowerCase();
  if (!sha256Pattern.test(normalized)) fail(code);
  return normalized;
}

function readPath(value, code) {
  const normalized = String(value ?? "").trim();
  if (!normalized || normalized.includes("\0")) fail(code);
  return normalized;
}

function readNow(value) {
  const now = value ?? new Date();
  if (!(now instanceof Date) || !Number.isFinite(now.getTime())) {
    fail("AAIS_AI_MANIFEST_CLOCK_INVALID");
  }
  return now;
}

function readCanonicalIsoTime(value) {
  if (typeof value !== "string") return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) && new Date(parsed).toISOString() === value
    ? parsed
    : null;
}

function readRecord(value, code) {
  if (!isRecord(value)) fail(code);
  return value;
}

function isRecord(value) {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function arraysEqual(left, right) {
  return Array.isArray(left)
    && left.length === right.length
    && left.every((item, index) => item === right[index]);
}

function isSafeSampleId(value) {
  return typeof value === "string"
    && /^[A-Za-z0-9][A-Za-z0-9._:-]{1,80}$/.test(value);
}

function isSha256(value) {
  return typeof value === "string" && sha256Pattern.test(value);
}

function fail(code) {
  throw new AaisAiEvalManifestSigningError(code);
}

function main() {
  try {
    const result = writeSignedAaisAiEvalManifest({
      manifest: readInputManifest(process.env.AAIS_AI_MANIFEST_INPUT_PATH),
      outputPath: process.env.AAIS_AI_MANIFEST_OUTPUT_PATH,
      receiptPath: process.env.AAIS_AI_MANIFEST_RECEIPT_PATH,
      expectedProvider: process.env.AAIS_AI_MANIFEST_EXPECTED_PROVIDER,
      expectedModel: process.env.AAIS_AI_MANIFEST_EXPECTED_MODEL,
      expectedRevisionSha256:
        process.env.AAIS_AI_MANIFEST_EXPECTED_REVISION_SHA256,
      signingKeyId: process.env.AAIS_AI_MANIFEST_SIGNING_KEY_ID,
      signingKeyPkcs8: process.env.AAIS_AI_MANIFEST_SIGNING_KEY_PKCS8,
    });
    console.log(JSON.stringify({
      status: "signed",
      contractVersion: aaisAiEvalManifestSigningReceiptContractVersion,
      provider: result.manifest.provider,
      model: result.manifest.model,
      evalVersion: result.manifest.evalVersion,
      manifestSha256: result.manifestSha256,
      signingKeyId: result.receipt.attestation.keyId,
      signatureSha256: result.receipt.attestation.signatureSha256,
      outputPath: result.outputPath,
      receiptPath: result.receiptPath,
      secrets: "redacted",
    }));
  } catch (error) {
    const code = error instanceof AaisAiEvalManifestSigningError
      ? error.code
      : "AAIS_AI_MANIFEST_SIGNING_FAILED";
    console.error(JSON.stringify({ status: "blocked", code, secrets: "redacted" }));
    process.exitCode = 1;
  }
}

const invokedPath = process.argv[1] ? pathToFileURL(process.argv[1]).href : "";
if (import.meta.url === invokedPath) main();
