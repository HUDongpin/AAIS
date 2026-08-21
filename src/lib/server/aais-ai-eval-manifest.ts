import {
  createHash,
  createPublicKey,
  verify as verifySignature,
} from "node:crypto";
import { readFileSync } from "node:fs";
import qwen37MaxEvalManifest from "@/data/aais-ai-eval-qwen3.7-max.json";
import type { AaisGuideProviderRole } from "@/lib/ai/aais-guide-delivery";

export type AaisAiEvalManifestStatus =
  | "not-required"
  | "verified"
  | "missing"
  | "invalid"
  | "mismatch"
  | "expired";

export type AaisAiEvalProvider =
  | "openai-compatible"
  | "qwen"
  | "deepseek";

export type AaisAiEvalManifestResult = {
  status: AaisAiEvalManifestStatus;
  issue?: "AAIS_AI_EVAL_MANIFEST" | "AAIS_AI_FALLBACK_EVAL_MANIFEST";
  evalVersion?: string;
  provider?: AaisAiEvalProvider;
  source?: "configured" | "bundled";
  manifestSha256?: string;
  passedAt?: string;
  expiresAt?: string;
  releaseEvidence?: {
    endpointFingerprint: string;
    thinkingMode: "disabled" | "provider-default";
    temperature: number;
    maxTokens: number;
    observedRevisionSha256: string;
    evalSuiteSha256: string;
    evalDataSha256: string;
    agentPromptContractSha256: Record<"A1" | "A2" | "A3" | "A4", string>;
    caBackgroundSha256: string;
    guardrailSha256: string;
    locales: Array<"zh-CN" | "en-US">;
    signingKeyId: string;
    signatureSha256: string;
    signatureVerified: true;
  };
};

export type AaisAiEvalApprovalResult = {
  approved: boolean;
  evalVersion: string | null;
  manifest: AaisAiEvalManifestResult;
};

type AaisAiEvalManifest = {
  schemaVersion: 1;
  evalVersion: string;
  provider: AaisAiEvalProvider;
  model: string;
  status: "passed" | "failed";
  passedAt: string;
  expiresAt: string;
  sampleCount: number;
  blockedCount: number;
  redaction: {
    prompts: "summarized";
    secrets: "omitted";
  };
  agentEvidence: {
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
  releaseEvidence: {
    contractVersion: "aais-ai-eval-release-v1";
    runtimeContract: {
      endpointFingerprint: string;
      thinkingMode: "disabled" | "provider-default";
      temperature: number;
      maxTokens: number;
      observedRevisionSha256: string;
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

const requiredAgentIds = ["A1", "A2", "A3", "A4"];
const requiredCaModules = ["Modelling", "Coaching", "Scaffolding", "Fading", "Articulation", "Reflection"];
const bundledManifests = [qwen37MaxEvalManifest as unknown as AaisAiEvalManifest];
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
};

export function verifyAaisAiEvalManifest(input: {
  required: boolean;
  evalVersion: string | null;
  provider: "deterministic" | AaisAiEvalProvider;
  model: string | null;
  providerRole?: AaisGuideProviderRole;
  env?: NodeJS.ProcessEnv;
  now?: Date;
}): AaisAiEvalManifestResult {
  if (!input.required) {
    return {
      status: "not-required",
    };
  }
  const providerRole = input.providerRole ?? "primary";
  const env = input.env ?? process.env;
  const issue = getManifestIssue(providerRole);
  const configuredManifestRequested = hasConfiguredManifestSource(providerRole, env);
  const configuredManifest = readConfiguredManifest(providerRole, env);
  if (configuredManifestRequested && !configuredManifest) {
    return {
      status: "invalid",
      issue,
    };
  }
  if (configuredManifest) {
    if (!isValidManifestShape(configuredManifest)) {
      return {
        status: "invalid",
        issue,
      };
    }
    // Configured release evidence is the current contract and must name the
    // actual provider. The legacy bundled OpenAI-compatible manifest remains
    // readable only through the bundled path below.
    if (configuredManifest.provider !== "qwen"
      && configuredManifest.provider !== "deepseek") {
      return { status: "mismatch", issue };
    }
    if (manifestTargetsRequest(configuredManifest, input)) {
      if (isVerifiedManifest(configuredManifest, input, providerRole, env)) {
        return verifiedManifestResult(configuredManifest, "configured");
      }
      return {
        status: isExpiredManifest(configuredManifest, input, providerRole, env)
          ? "expired"
          : "mismatch",
        issue,
      };
    }
  }
  const bundledManifest = bundledManifests.find((manifest) =>
    isVerifiedManifest(manifest, input, providerRole, env));
  if (bundledManifest) {
    return verifiedManifestResult(bundledManifest, "bundled");
  }
  if (bundledManifests.some((manifest) =>
    isExpiredManifest(manifest, input, providerRole, env))) {
    return { status: "expired", issue };
  }
  if (!configuredManifest) {
    return {
      status: "missing",
      issue,
    };
  }
  return {
    status: "mismatch",
    issue,
  };
}

export function getAaisAiEvalApproval(input: {
  required: boolean;
  provider: "deterministic" | AaisAiEvalProvider;
  model: string | null;
  providerRole?: AaisGuideProviderRole;
  env?: NodeJS.ProcessEnv;
  now?: Date;
}): AaisAiEvalApprovalResult {
  const providerRole = input.providerRole ?? "primary";
  const env = input.env ?? process.env;
  const evalVersion = readEvalEnvironmentValue(providerRole, env, "VERSION") || null;
  const manifest = verifyAaisAiEvalManifest({
    required: input.required,
    provider: input.provider,
    model: input.model,
    providerRole,
    env,
    now: input.now,
    evalVersion,
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

function manifestTargetsRequest(
  manifest: AaisAiEvalManifest,
  input: Parameters<typeof verifyAaisAiEvalManifest>[0],
) {
  return manifest.evalVersion === input.evalVersion
    && manifest.provider === input.provider
    && manifest.model === input.model;
}

function isVerifiedManifest(
  manifest: Partial<AaisAiEvalManifest> | null,
  input: Parameters<typeof verifyAaisAiEvalManifest>[0],
  providerRole: AaisGuideProviderRole,
  env: NodeJS.ProcessEnv,
): manifest is AaisAiEvalManifest {
  return Boolean(
    isValidManifestShape(manifest)
      && manifest.evalVersion === input.evalVersion
      && manifest.provider === input.provider
      && manifest.model === input.model
      && manifest.status === "passed"
      && manifest.sampleCount > 0
      && manifest.blockedCount === 0
      && manifest.redaction.prompts === "summarized"
      && manifest.redaction.secrets === "omitted"
      && isCompleteAgentEvidence(manifest.agentEvidence)
      && isCompleteReleaseEvidence(manifest.releaseEvidence)
      && getEvidenceWindowStatus(manifest, input.now ?? new Date()) === "valid"
      && manifestDigestMatchesEnvironment(manifest, providerRole, env)
      && manifestSigningKeyMatchesEnvironment(manifest, providerRole, env)
      && verifyManifestAttestation(manifest, providerRole, env),
  );
}

function isExpiredManifest(
  manifest: Partial<AaisAiEvalManifest> | null,
  input: Parameters<typeof verifyAaisAiEvalManifest>[0],
  providerRole: AaisGuideProviderRole,
  env: NodeJS.ProcessEnv,
) {
  return Boolean(
    isValidManifestShape(manifest)
      && manifest.evalVersion === input.evalVersion
      && manifest.provider === input.provider
      && manifest.model === input.model
      && manifest.status === "passed"
      && manifest.sampleCount > 0
      && manifest.blockedCount === 0
      && manifest.redaction.prompts === "summarized"
      && manifest.redaction.secrets === "omitted"
      && isCompleteAgentEvidence(manifest.agentEvidence)
      && isCompleteReleaseEvidence(manifest.releaseEvidence)
      && getEvidenceWindowStatus(manifest, input.now ?? new Date()) === "expired"
      && manifestDigestMatchesEnvironment(manifest, providerRole, env)
      && manifestSigningKeyMatchesEnvironment(manifest, providerRole, env)
      && verifyManifestAttestation(manifest, providerRole, env),
  );
}

function verifiedManifestResult(
  manifest: AaisAiEvalManifest,
  source: NonNullable<AaisAiEvalManifestResult["source"]>,
): AaisAiEvalManifestResult {
  return {
    status: "verified",
    evalVersion: manifest.evalVersion,
    provider: manifest.provider,
    source,
    manifestSha256: createAaisAiEvalManifestSha256(manifest),
    passedAt: manifest.passedAt,
    expiresAt: manifest.expiresAt,
    releaseEvidence: {
      endpointFingerprint: manifest.releaseEvidence.runtimeContract.endpointFingerprint,
      thinkingMode: manifest.releaseEvidence.runtimeContract.thinkingMode,
      temperature: manifest.releaseEvidence.runtimeContract.temperature,
      maxTokens: manifest.releaseEvidence.runtimeContract.maxTokens,
      observedRevisionSha256: manifest.releaseEvidence.runtimeContract.observedRevisionSha256,
      evalSuiteSha256: manifest.releaseEvidence.evalSuiteSha256,
      evalDataSha256: manifest.releaseEvidence.evalDataSha256,
      agentPromptContractSha256: { ...manifest.releaseEvidence.agentPromptContractSha256 },
      caBackgroundSha256: manifest.releaseEvidence.caBackgroundSha256,
      guardrailSha256: manifest.releaseEvidence.guardrailSha256,
      locales: ["zh-CN", "en-US"],
      signingKeyId: manifest.attestation.keyId,
      signatureSha256: createHash("sha256")
        .update(decodeBase64(manifest.attestation.signature) ?? Buffer.alloc(0))
        .digest("hex"),
      signatureVerified: true,
    },
  };
}

function isCompleteAgentEvidence(value: AaisAiEvalManifest["agentEvidence"]) {
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
      && hasCompleteAgentCoverage(value.coverage),
  );
}

function isCompleteReleaseEvidence(value: AaisAiEvalManifest["releaseEvidence"]) {
  const runtime = value?.runtimeContract;
  const localeCoverage = value?.localeCoverage;
  return Boolean(
    value
      && value.contractVersion === "aais-ai-eval-release-v1"
      && runtime
      && isSha256(runtime.endpointFingerprint)
      && (runtime.thinkingMode === "disabled" || runtime.thinkingMode === "provider-default")
      && Number.isFinite(runtime.temperature)
      && runtime.temperature >= 0
      && runtime.temperature <= 2
      && Number.isSafeInteger(runtime.maxTokens)
      && runtime.maxTokens > 0
      && runtime.maxTokens <= 8_192
      && isSha256(runtime.observedRevisionSha256)
      && isSha256(value.evalSuiteSha256)
      && isSha256(value.evalDataSha256)
      && requiredAgentIds.every((agentId) =>
        isSha256(value.agentPromptContractSha256?.[agentId as "A1" | "A2" | "A3" | "A4"]),
      )
      && isSha256(value.caBackgroundSha256)
      && isSha256(value.guardrailSha256)
      && localeCoverage
      && localeCoverage.complete === true
      && hasExactlyRequiredLocales(localeCoverage.requiredLocales)
      && hasExactlyRequiredLocales(localeCoverage.coveredLocales)
      && requiredAgentIds.every((agentId) =>
        hasExactlyRequiredLocales(localeCoverage.agentLocales?.[agentId]),
      ),
  );
}

function hasExactlyRequiredLocales(value: unknown) {
  return Array.isArray(value)
    && value.length === 2
    && value[0] === "zh-CN"
    && value[1] === "en-US";
}

function getEvidenceWindowStatus(
  manifest: Pick<AaisAiEvalManifest, "passedAt" | "expiresAt">,
  now: Date,
): "valid" | "expired" | "invalid" {
  const passedAt = readCanonicalIsoTime(manifest.passedAt);
  const expiresAt = readCanonicalIsoTime(manifest.expiresAt);
  const nowMs = now.getTime();
  const maximumEvidenceWindowMs = 30 * 24 * 60 * 60 * 1_000;
  if (passedAt === null
    || expiresAt === null
    || !Number.isFinite(nowMs)
    || passedAt > nowMs
    || expiresAt <= passedAt
    || expiresAt - passedAt > maximumEvidenceWindowMs) return "invalid";
  return expiresAt <= nowMs ? "expired" : "valid";
}

function readCanonicalIsoTime(value: unknown) {
  if (typeof value !== "string") return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) && new Date(parsed).toISOString() === value
    ? parsed
    : null;
}

function manifestDigestMatchesEnvironment(
  manifest: AaisAiEvalManifest,
  providerRole: AaisGuideProviderRole,
  env: NodeJS.ProcessEnv,
) {
  const expected = readEvalEnvironmentValue(providerRole, env, "MANIFEST_SHA256");
  return isSha256(expected) && expected === createAaisAiEvalManifestSha256(manifest);
}

function manifestSigningKeyMatchesEnvironment(
  manifest: AaisAiEvalManifest,
  providerRole: AaisGuideProviderRole,
  env: NodeJS.ProcessEnv,
) {
  const expectedKeyId = readEvalEnvironmentValue(providerRole, env, "SIGNING_KEY_ID");
  return isSafeIdentifier(expectedKeyId)
    && manifest.attestation.keyId === expectedKeyId;
}

function verifyManifestAttestation(
  manifest: AaisAiEvalManifest,
  providerRole: AaisGuideProviderRole,
  env: NodeJS.ProcessEnv,
) {
  if (manifest.attestation.algorithm !== "ed25519") return false;
  const signature = decodeBase64(manifest.attestation.signature);
  const spki = decodeBase64(
    readEvalEnvironmentValue(providerRole, env, "VERIFYING_KEY_SPKI"),
  );
  if (!signature || signature.byteLength !== 64 || !spki) return false;
  try {
    const key = createPublicKey({ key: spki, format: "der", type: "spki" });
    return key.asymmetricKeyType === "ed25519"
      && verifySignature(
        null,
        Buffer.from(createAaisAiEvalManifestSigningPayload(manifest), "utf8"),
        key,
        signature,
      );
  } catch {
    return false;
  }
}

function hasCompleteAgentCoverage(value: AaisAiEvalManifest["agentEvidence"]["coverage"]) {
  return Object.entries(requiredAgentContracts).every(([agentId, contract]) => {
    const coverage = value?.[agentId];
    return Boolean(
      coverage
        && coverage.label === contract.label
        && coverage.responsibility === contract.responsibility
        && Array.isArray(coverage.sampleIds)
        && coverage.sampleIds.some(isSafeSampleId)
        && Array.isArray(coverage.caModules)
        && arraysEqual(
          contract.caModules.filter((module) => coverage.caModules.includes(module)),
          contract.caModules,
        )
        && coverage.complete === true,
    );
  });
}

function arraysEqual(left: string[], right: string[]) {
  return left.length === right.length && left.every((item, index) => item === right[index]);
}

function isSafeSampleId(value: unknown) {
  return /^[A-Za-z0-9][A-Za-z0-9._:-]{1,80}$/.test(String(value ?? "").trim());
}

function readConfiguredManifest(
  providerRole: AaisGuideProviderRole,
  env: NodeJS.ProcessEnv,
) {
  const inlineManifest = readEvalEnvironmentValue(providerRole, env, "MANIFEST_JSON");
  if (inlineManifest) {
    return readManifestJson(inlineManifest);
  }
  const manifestPath = readEvalEnvironmentValue(providerRole, env, "MANIFEST_PATH");
  return manifestPath ? readManifestPath(manifestPath) : null;
}

function hasConfiguredManifestSource(
  providerRole: AaisGuideProviderRole,
  env: NodeJS.ProcessEnv,
) {
  return Boolean(
    readEvalEnvironmentValue(providerRole, env, "MANIFEST_JSON")
    || readEvalEnvironmentValue(providerRole, env, "MANIFEST_PATH"),
  );
}

function readEvalEnvironmentValue(
  providerRole: AaisGuideProviderRole,
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

function getManifestIssue(providerRole: AaisGuideProviderRole) {
  return providerRole === "fallback"
    ? "AAIS_AI_FALLBACK_EVAL_MANIFEST" as const
    : "AAIS_AI_EVAL_MANIFEST" as const;
}

/**
 * SHA-256 over a domain-separated canonical JSON form. Object keys are sorted
 * lexicographically at every depth; array order and JSON primitive values are
 * preserved. Whitespace and source-path differences therefore do not alter the
 * release-lock digest.
 */
export function createAaisAiEvalManifestSha256(manifest: unknown) {
  return createHash("sha256")
    .update(`aais-ai-eval-manifest-v1:${canonicalizeJson(manifest)}`)
    .digest("hex");
}

export function createAaisAiEvalManifestSigningPayload(manifest: unknown) {
  if (!manifest || typeof manifest !== "object" || Array.isArray(manifest)) {
    throw new TypeError("AAIS AI eval manifest signing payload is invalid.");
  }
  const record = manifest as Record<string, unknown>;
  const attestation = record.attestation;
  if (!attestation || typeof attestation !== "object" || Array.isArray(attestation)) {
    throw new TypeError("AAIS AI eval manifest attestation is invalid.");
  }
  const unsignedAttestation = { ...(attestation as Record<string, unknown>) };
  delete unsignedAttestation.signature;
  const unsignedManifest = {
    ...record,
    attestation: unsignedAttestation,
  };
  return `aais-ai-eval-manifest-signature-v1:${canonicalizeJson(unsignedManifest)}`;
}

function canonicalizeJson(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(canonicalizeJson).join(",")}]`;
  }
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalizeJson(record[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
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
  return Boolean(
    value
      && value.schemaVersion === 1
      && typeof value.evalVersion === "string"
      && (value.provider === "openai-compatible"
        || value.provider === "qwen"
        || value.provider === "deepseek")
      && typeof value.model === "string"
      && (value.status === "passed" || value.status === "failed")
      && typeof value.passedAt === "string"
      && typeof value.expiresAt === "string"
      && typeof value.sampleCount === "number"
      && typeof value.blockedCount === "number"
      && value.redaction?.prompts === "summarized"
      && value.redaction?.secrets === "omitted"
      && typeof value.agentEvidence === "object"
      && value.agentEvidence !== null
      && typeof value.agentEvidence.coverage === "object"
      && value.agentEvidence.coverage !== null
      && typeof value.releaseEvidence === "object"
      && value.releaseEvidence !== null
      && typeof value.releaseEvidence.runtimeContract === "object"
      && value.releaseEvidence.runtimeContract !== null
      && typeof value.releaseEvidence.localeCoverage === "object"
      && value.releaseEvidence.localeCoverage !== null
      && typeof value.attestation === "object"
      && value.attestation !== null
      && value.attestation.algorithm === "ed25519"
      && isSafeIdentifier(value.attestation.keyId)
      && decodeBase64(value.attestation.signature)?.byteLength === 64,
  );
}

function isSha256(value: unknown): value is string {
  return typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
}

function isSafeIdentifier(value: unknown): value is string {
  return typeof value === "string"
    && /^[A-Za-z0-9][A-Za-z0-9._:-]{2,127}$/.test(value);
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
