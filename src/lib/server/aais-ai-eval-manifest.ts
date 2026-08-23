import {
  createHash,
  createPublicKey,
  verify as verifySignature,
} from "node:crypto";
import { readFileSync } from "node:fs";
import qwen37SnapshotEvalManifest from "@/data/aais-ai-eval-qwen3.7-max-2026-06-08.json";
import {
  getAaisAiEndpointFingerprint,
  getAaisAiObservedSnapshotSha256,
  getAaisAiSourceContractEvidence,
  isAaisImmutableQwenSnapshotModel,
} from "@/lib/ai/aais-ai-source-contract";

export type AaisAiEvalManifestStatus =
  | "not-required"
  | "verified"
  | "missing"
  | "invalid"
  | "mismatch"
  | "expired";

type AaisAiEvalProviderRole = "primary" | "fallback";
type AaisAiEvalManifestIssue =
  | "AAIS_AI_EVAL_MANIFEST"
  | "AAIS_AI_FALLBACK_EVAL_MANIFEST";

export type AaisAiEvalManifestResult = {
  status: AaisAiEvalManifestStatus;
  issue?: AaisAiEvalManifestIssue;
  evalVersion?: string;
  source?: "configured" | "bundled";
  schemaVersion?: 1 | 2;
};

export type AaisAiEvalApprovalResult = {
  approved: boolean;
  evalVersion: string | null;
  manifest: AaisAiEvalManifestResult;
};

export type AaisAiEvalRuntimeContract = {
  endpoint: string;
  thinkingMode: "disabled" | "provider-default";
  maxTokens: number;
  maxRetries: number;
};

type AaisAiEvalAgentEvidence = {
  contractVersion: "aais-a1-a4-ca-eval-v2";
  requiredAgents: string[];
  coveredAgents: string[];
  requiredCaModules: string[];
  coveredCaModules: string[];
  coverage: Record<string, {
    label: string;
    responsibility: string;
    sampleIds: string[];
    caModules: string[];
    complete: boolean;
  }>;
  caBackgroundIncluded: boolean;
  rawPromptsStored: boolean;
  rawOutputsStored: boolean;
  complete: boolean;
};

type AaisAiEvalManifestV1 = {
  schemaVersion: 1;
  evalVersion: string;
  provider: "openai-compatible";
  model: string;
  status: "passed" | "failed";
  passedAt: string;
  sampleCount: number;
  blockedCount: number;
  redaction: {
    prompts: "summarized";
    secrets: "omitted";
  };
  agentEvidence: AaisAiEvalAgentEvidence;
};

export type AaisAiEvalManifestV2 = {
  schemaVersion: 2;
  evalVersion: string;
  provider: "openai-compatible";
  providerFamily: "qwen";
  model: string;
  status: "passed" | "failed";
  passedAt: string;
  expiresAt: string;
  sampleCount: number;
  blockedCount: number;
  redaction: {
    prompts: "summarized";
    outputs: "omitted";
    secrets: "omitted";
    rawObservedModel: "omitted";
  };
  agentEvidence: AaisAiEvalAgentEvidence;
  releaseEvidence: {
    contractVersion: "aais-ai-eval-release-v2";
    runtimeContract: {
      endpointFingerprint: string;
      thinkingMode: "disabled";
      temperature: 0.2;
      maxTokens: 600;
      maxRetries: 0;
      requestedSnapshotModel: string;
      observationKind: "exact-provider-model-id";
      observedSnapshotSha256: string;
    };
    evalSuiteSha256: string;
    evalDataSha256: string;
    agentPromptContractSha256: Record<"A1" | "A2" | "A3" | "A4", string>;
    caBackgroundSha256: string;
    guardrailSha256: string;
    localeCoverage: {
      requiredLocales: string[];
      coveredLocales: string[];
      agentLocales: Record<string, string[]>;
      complete: boolean;
    };
  };
  attestation: {
    algorithm: "ed25519";
    keyId: string;
    signature: string;
  };
};

type AaisAiEvalManifest = AaisAiEvalManifestV1 | AaisAiEvalManifestV2;

const requiredAgentIds = ["A1", "A2", "A3", "A4"] as const;
const requiredLocales = ["zh-CN", "en-US"] as const;
const requiredCaModules = ["Modelling", "Coaching", "Scaffolding", "Fading", "Articulation", "Reflection"];
const bundledManifests: AaisAiEvalManifest[] = [
  qwen37SnapshotEvalManifest as AaisAiEvalManifestV2,
];
const maximumSnapshotEvidenceWindowMs = 366 * 24 * 60 * 60 * 1_000;
const sha256Pattern = /^[a-f0-9]{64}$/;
const safeIdentifierPattern = /^[A-Za-z0-9][A-Za-z0-9._:-]{2,127}$/;
const requiredAgentContracts = {
  A1: {
    label: "导学智能体",
    caModules: ["Scaffolding", "Fading"],
    responsibility: "frontend-guide-scaffolding",
  },
  A2: {
    label: "专家智能体",
    caModules: ["Modelling", "Coaching"],
    responsibility: "frontend-expert-modelling-coaching",
  },
  A3: {
    label: "监督智能体",
    caModules: ["Scaffolding"],
    responsibility: "backend-supervision-a1-signal",
  },
  A4: {
    label: "反思智能体",
    caModules: ["Articulation", "Reflection"],
    responsibility: "backend-reflection-articulation",
  },
} as const;

export function verifyAaisAiEvalManifest(input: {
  required: boolean;
  evalVersion: string | null;
  provider: "deterministic" | "openai-compatible";
  model: string | null;
  runtime?: AaisAiEvalRuntimeContract | null;
  providerRole?: AaisAiEvalProviderRole;
  env?: NodeJS.ProcessEnv;
  now?: Date;
}): AaisAiEvalManifestResult {
  if (!input.required) {
    return { status: "not-required" };
  }

  const providerRole = input.providerRole ?? "primary";
  const env = input.env ?? process.env;
  const issue = getManifestIssue(providerRole);
  const configuredManifestRequested = hasConfiguredManifestSource(providerRole, env);
  const configuredManifest = readConfiguredManifest(providerRole, env);
  if (configuredManifestRequested) {
    if (!configuredManifest || !isValidManifestShape(configuredManifest)) {
      return { status: "invalid", issue };
    }
    if (!manifestTargetsRequest(configuredManifest, input)) {
      return { status: "mismatch", issue };
    }
    return verifyTargetedManifest(configuredManifest, input, "configured", env, issue);
  }

  const bundledManifest = bundledManifests.find((manifest) =>
    manifestTargetsRequest(manifest, input));
  if (!bundledManifest) {
    return { status: "missing", issue };
  }
  return verifyTargetedManifest(bundledManifest, input, "bundled", env, issue);
}

export function getAaisAiEvalApproval(input: {
  required: boolean;
  provider: "deterministic" | "openai-compatible";
  model: string | null;
  runtime?: AaisAiEvalRuntimeContract | null;
  providerRole?: AaisAiEvalProviderRole;
  env?: NodeJS.ProcessEnv;
  now?: Date;
}): AaisAiEvalApprovalResult {
  const env = input.env ?? process.env;
  const providerRole = input.providerRole ?? "primary";
  const evalVersion = readEvalEnvironmentValue(providerRole, env, "VERSION") || null;
  const manifest = verifyAaisAiEvalManifest({
    ...input,
    evalVersion,
    providerRole,
    env,
  });
  return {
    approved: !input.required || (
      readEvalEnvironmentValue(providerRole, env, "APPROVED") === "true"
      && Boolean(evalVersion)
      && manifest.status === "verified"
    ),
    evalVersion,
    manifest,
  };
}

export function createAaisAiEvalManifestSha256(manifest: unknown) {
  return createHash("sha256")
    .update(`aais-ai-eval-manifest-v2:${canonicalizeJson(manifest)}`)
    .digest("hex");
}

export function createAaisAiEvalManifestSigningPayload(manifest: unknown) {
  if (!isRecord(manifest) || !isRecord(manifest.attestation)) {
    throw new TypeError("AAIS AI eval manifest signing payload is invalid.");
  }
  const unsignedAttestation = { ...manifest.attestation };
  delete unsignedAttestation.signature;
  return `aais-ai-eval-manifest-signature-v2:${canonicalizeJson({
    ...manifest,
    attestation: unsignedAttestation,
  })}`;
}

function verifyTargetedManifest(
  manifest: AaisAiEvalManifest,
  input: Parameters<typeof verifyAaisAiEvalManifest>[0],
  source: NonNullable<AaisAiEvalManifestResult["source"]>,
  env: NodeJS.ProcessEnv,
  issue: AaisAiEvalManifestIssue,
): AaisAiEvalManifestResult {
  if (manifest.schemaVersion === 2) {
    const status = verifySnapshotManifest(manifest, input, env);
    return status === "verified"
      ? verifiedManifestResult(manifest, source)
      : { status, issue };
  }
  if (isQwenModel(manifest.model)) {
    return { status: "invalid", issue };
  }
  return isVerifiedLegacyManifest(manifest, input)
    ? verifiedManifestResult(manifest, source)
    : { status: "mismatch", issue };
}

function verifySnapshotManifest(
  manifest: AaisAiEvalManifestV2,
  input: Parameters<typeof verifyAaisAiEvalManifest>[0],
  env: NodeJS.ProcessEnv,
): "verified" | "invalid" | "mismatch" | "expired" {
  if (!isAaisImmutableQwenSnapshotModel(manifest.model)
    || manifest.providerFamily !== "qwen"
    || manifest.status !== "passed"
    || manifest.sampleCount < requiredAgentIds.length * requiredLocales.length
    || manifest.blockedCount !== 0
    || manifest.redaction.prompts !== "summarized"
    || manifest.redaction.outputs !== "omitted"
    || manifest.redaction.secrets !== "omitted"
    || manifest.redaction.rawObservedModel !== "omitted"
    || !isCompleteAgentEvidence(manifest.agentEvidence, true)
    || !isCompleteReleaseEvidence(manifest, input.runtime)) {
    return "invalid";
  }

  const passedAt = readCanonicalIsoTime(manifest.passedAt);
  const expiresAt = readCanonicalIsoTime(manifest.expiresAt);
  const now = input.now ?? new Date();
  if (!Number.isFinite(now.getTime()) || passedAt === null || expiresAt === null
    || expiresAt <= passedAt
    || expiresAt - passedAt > maximumSnapshotEvidenceWindowMs
    || passedAt > now.getTime() + 5 * 60 * 1_000) {
    return "invalid";
  }
  if (expiresAt <= now.getTime()) {
    return "expired";
  }

  const providerRole = input.providerRole ?? "primary";
  const expectedManifestSha256 = readEvalEnvironmentValue(providerRole, env, "MANIFEST_SHA256");
  const expectedKeyId = readEvalEnvironmentValue(providerRole, env, "SIGNING_KEY_ID");
  const verifyingKeySpki = readEvalEnvironmentValue(providerRole, env, "VERIFYING_KEY_SPKI");
  if (!isSha256(expectedManifestSha256)
    || createAaisAiEvalManifestSha256(manifest) !== expectedManifestSha256
    || !safeIdentifierPattern.test(expectedKeyId ?? "")
    || manifest.attestation.algorithm !== "ed25519"
    || manifest.attestation.keyId !== expectedKeyId
    || !verifyManifestSignature(manifest, verifyingKeySpki)) {
    return "invalid";
  }
  return "verified";
}

function isCompleteReleaseEvidence(
  manifest: AaisAiEvalManifestV2,
  runtime: AaisAiEvalRuntimeContract | null | undefined,
) {
  const evidence = manifest.releaseEvidence;
  const contract = evidence.runtimeContract;
  const source = getAaisAiSourceContractEvidence();
  return Boolean(
    runtime
      && evidence.contractVersion === "aais-ai-eval-release-v2"
      && contract.endpointFingerprint === getAaisAiEndpointFingerprint(runtime.endpoint)
      && contract.thinkingMode === runtime.thinkingMode
      && contract.temperature === 0.2
      && contract.maxTokens === runtime.maxTokens
      && contract.maxRetries === runtime.maxRetries
      && contract.requestedSnapshotModel === manifest.model
      && contract.observationKind === "exact-provider-model-id"
      && contract.observedSnapshotSha256 === getAaisAiObservedSnapshotSha256(manifest.model)
      && isSha256(evidence.evalSuiteSha256)
      && isSha256(evidence.evalDataSha256)
      && requiredAgentIds.every((agentId) =>
        evidence.agentPromptContractSha256?.[agentId]
          === source.agentPromptContractSha256[agentId])
      && evidence.caBackgroundSha256 === source.caBackgroundSha256
      && evidence.guardrailSha256 === source.guardrailSha256
      && evidence.localeCoverage?.complete === true
      && arraysEqual(evidence.localeCoverage.requiredLocales, requiredLocales)
      && arraysEqual(evidence.localeCoverage.coveredLocales, requiredLocales)
      && requiredAgentIds.every((agentId) =>
        arraysEqual(evidence.localeCoverage.agentLocales?.[agentId], requiredLocales)),
  );
}

function verifyManifestSignature(
  manifest: AaisAiEvalManifestV2,
  verifyingKeySpki: string | undefined,
) {
  const spki = decodeBase64(verifyingKeySpki);
  const signature = decodeBase64(manifest.attestation.signature);
  if (!spki || !signature || signature.byteLength !== 64) return false;
  try {
    const publicKey = createPublicKey({ key: spki, format: "der", type: "spki" });
    return publicKey.asymmetricKeyType === "ed25519"
      && verifySignature(
        null,
        Buffer.from(createAaisAiEvalManifestSigningPayload(manifest), "utf8"),
        publicKey,
        signature,
      );
  } catch {
    return false;
  }
}

function manifestTargetsRequest(
  manifest: AaisAiEvalManifest,
  input: Pick<Parameters<typeof verifyAaisAiEvalManifest>[0], "evalVersion" | "provider" | "model">,
) {
  return manifest.evalVersion === input.evalVersion
    && manifest.provider === input.provider
    && manifest.model === input.model;
}

function isVerifiedLegacyManifest(
  manifest: AaisAiEvalManifestV1,
  input: Parameters<typeof verifyAaisAiEvalManifest>[0],
) {
  return Boolean(
    manifestTargetsRequest(manifest, input)
      && manifest.status === "passed"
      && manifest.sampleCount > 0
      && manifest.blockedCount === 0
      && manifest.redaction.prompts === "summarized"
      && manifest.redaction.secrets === "omitted"
      && isCompleteAgentEvidence(manifest.agentEvidence, false),
  );
}

function verifiedManifestResult(
  manifest: AaisAiEvalManifest,
  source: NonNullable<AaisAiEvalManifestResult["source"]>,
): AaisAiEvalManifestResult {
  return {
    status: "verified",
    evalVersion: manifest.evalVersion,
    source,
    schemaVersion: manifest.schemaVersion,
  };
}

function isCompleteAgentEvidence(value: AaisAiEvalAgentEvidence, requireTwoLocales: boolean) {
  return Boolean(
    value
      && value.contractVersion === "aais-a1-a4-ca-eval-v2"
      && value.complete === true
      && value.caBackgroundIncluded === true
      && value.rawPromptsStored === false
      && value.rawOutputsStored === false
      && Array.isArray(value.requiredAgents)
      && Array.isArray(value.coveredAgents)
      && Array.isArray(value.requiredCaModules)
      && Array.isArray(value.coveredCaModules)
      && requiredAgentIds.every((agentId) => value.requiredAgents.includes(agentId))
      && requiredAgentIds.every((agentId) => value.coveredAgents.includes(agentId))
      && requiredCaModules.every((module) => value.requiredCaModules.includes(module))
      && requiredCaModules.every((module) => value.coveredCaModules.includes(module))
      && hasCompleteAgentCoverage(value.coverage, requireTwoLocales),
  );
}

function hasCompleteAgentCoverage(
  value: AaisAiEvalAgentEvidence["coverage"],
  requireTwoLocales: boolean,
) {
  return Object.entries(requiredAgentContracts).every(([agentId, contract]) => {
    const coverage = value?.[agentId];
    return Boolean(
      coverage
        && coverage.label === contract.label
        && coverage.responsibility === contract.responsibility
        && Array.isArray(coverage.sampleIds)
        && coverage.sampleIds.length >= (requireTwoLocales ? requiredLocales.length : 1)
        && coverage.sampleIds.every(isSafeSampleId)
        && Array.isArray(coverage.caModules)
        && arraysEqual(coverage.caModules, contract.caModules)
        && coverage.complete === true,
    );
  });
}

function readConfiguredManifest(providerRole: AaisAiEvalProviderRole, env: NodeJS.ProcessEnv) {
  const inlineManifest = readEvalEnvironmentValue(providerRole, env, "MANIFEST_JSON");
  if (inlineManifest) return readManifestJson(inlineManifest);
  const manifestPath = readEvalEnvironmentValue(providerRole, env, "MANIFEST_PATH");
  return manifestPath ? readManifestPath(manifestPath) : null;
}

function hasConfiguredManifestSource(providerRole: AaisAiEvalProviderRole, env: NodeJS.ProcessEnv) {
  return Boolean(
    readEvalEnvironmentValue(providerRole, env, "MANIFEST_JSON")
    || readEvalEnvironmentValue(providerRole, env, "MANIFEST_PATH"),
  );
}

function readEvalEnvironmentValue(
  providerRole: AaisAiEvalProviderRole,
  env: NodeJS.ProcessEnv,
  suffix:
    | "APPROVED"
    | "VERSION"
    | "MANIFEST_JSON"
    | "MANIFEST_PATH"
    | "MANIFEST_SHA256"
    | "SIGNING_KEY_ID"
    | "VERIFYING_KEY_SPKI",
) {
  const name = providerRole === "fallback"
    ? `AAIS_AI_FALLBACK_EVAL_${suffix}`
    : `AAIS_AI_EVAL_${suffix}`;
  return env[name]?.trim();
}

function getManifestIssue(providerRole: AaisAiEvalProviderRole) {
  return providerRole === "fallback"
    ? "AAIS_AI_FALLBACK_EVAL_MANIFEST" as const
    : "AAIS_AI_EVAL_MANIFEST" as const;
}

function readManifestJson(value: string) {
  try {
    return JSON.parse(value) as Partial<AaisAiEvalManifest>;
  } catch {
    return null;
  }
}

function readManifestPath(manifestPath: string) {
  try {
    return JSON.parse(readFileSync(manifestPath, "utf8")) as Partial<AaisAiEvalManifest>;
  } catch {
    return null;
  }
}

function isValidManifestShape(value: Partial<AaisAiEvalManifest> | null): value is AaisAiEvalManifest {
  if (!value || (value.schemaVersion !== 1 && value.schemaVersion !== 2)) return false;
  if (!safeIdentifierPattern.test(String(value.evalVersion ?? ""))
    || value.provider !== "openai-compatible"
    || !safeIdentifierPattern.test(String(value.model ?? ""))
    || (value.status !== "passed" && value.status !== "failed")
    || typeof value.passedAt !== "string"
    || !Number.isSafeInteger(value.sampleCount)
    || !Number.isSafeInteger(value.blockedCount)
    || !isRecord(value.agentEvidence)
    || !isRecord(value.agentEvidence.coverage)) {
    return false;
  }
  if (value.schemaVersion === 1) {
    return value.redaction?.prompts === "summarized"
      && value.redaction?.secrets === "omitted";
  }
  const snapshotManifest = value as Partial<AaisAiEvalManifestV2>;
  return snapshotManifest.providerFamily === "qwen"
    && typeof snapshotManifest.expiresAt === "string"
    && snapshotManifest.redaction?.prompts === "summarized"
    && snapshotManifest.redaction?.outputs === "omitted"
    && snapshotManifest.redaction?.secrets === "omitted"
    && snapshotManifest.redaction?.rawObservedModel === "omitted"
    && isRecord(snapshotManifest.releaseEvidence)
    && isRecord(snapshotManifest.releaseEvidence.runtimeContract)
    && isRecord(snapshotManifest.releaseEvidence.localeCoverage)
    && isRecord(snapshotManifest.attestation)
    && snapshotManifest.attestation.algorithm === "ed25519"
    && safeIdentifierPattern.test(String(snapshotManifest.attestation.keyId ?? ""))
    && decodeBase64(snapshotManifest.attestation.signature)?.byteLength === 64;
}

function readCanonicalIsoTime(value: unknown) {
  if (typeof value !== "string") return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) && new Date(parsed).toISOString() === value
    ? parsed
    : null;
}

function isQwenModel(value: string) {
  return /^qwen/i.test(value);
}

function isSafeSampleId(value: unknown) {
  return /^[A-Za-z0-9][A-Za-z0-9._:-]{1,80}$/.test(String(value ?? "").trim());
}

function isSha256(value: unknown): value is string {
  return typeof value === "string" && sha256Pattern.test(value);
}

function decodeBase64(value: unknown) {
  if (typeof value !== "string"
    || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)) {
    return null;
  }
  try {
    const decoded = Buffer.from(value, "base64");
    return decoded.toString("base64") === value ? decoded : null;
  } catch {
    return null;
  }
}

function arraysEqual(left: readonly string[] | undefined, right: readonly string[]) {
  return Array.isArray(left)
    && left.length === right.length
    && left.every((item, index) => item === right[index]);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function canonicalizeJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalizeJson).join(",")}]`;
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record).sort().map((key) =>
      `${JSON.stringify(key)}:${canonicalizeJson(record[key])}`).join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}
