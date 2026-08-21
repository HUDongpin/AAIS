import { createHash } from "node:crypto";
import productionReleaseLockJson from "@/data/aais-ai-production-release-lock.json";
import {
  getAaisAiModelFingerprint,
  readAaisAiRuntimeConfig,
  type AaisAiRuntimeProviderCandidate,
} from "@/lib/ai/aais-ai-runtime-config";
import {
  getAaisAiSourceContractEvidence,
  type AaisAiSourceContractEvidence,
} from "@/lib/ai/aais-ai-source-contract";
import {
  getAaisAiEvalApproval,
  type AaisAiEvalApprovalResult,
  type AaisAiEvalManifestStatus,
} from "@/lib/server/aais-ai-eval-manifest";

export const aaisAiReleaseLockContractVersion = "aais-ai-live-release-v1" as const;
export const aaisAiProviderTemperature = 0.2;

type AaisAiReleaseProviderRole = "primary" | "secondary";
type AaisAiRuntimeProviderRole = "primary" | "fallback";
type AaisAiReleaseProviderName = "qwen" | "deepseek";
type AaisAiReleaseLockStatus = "blocked" | "approved";
type AaisAiReleaseEvidenceStatus = "pending" | "verified";
type AaisAiReleaseThinkingMode = "disabled" | "provider-default";
type AaisAiReleaseLocale = "zh-CN" | "en-US";
type AaisAiAgentContractHashes = Record<"A1" | "A2" | "A3" | "A4", string | null>;

type AaisAiReleaseProviderLock = {
  role: AaisAiReleaseProviderRole;
  required: true;
  provider: AaisAiReleaseProviderName;
  model: string;
  endpointFingerprint: string | null;
  thinkingMode: AaisAiReleaseThinkingMode | null;
  temperature: number | null;
  maxTokens: number | null;
  observedModel: string | null;
  observedRevisionSha256: string | null;
  evalVersion: string | null;
  manifestSha256: string | null;
  evalSuiteSha256: string | null;
  evalDataSha256: string | null;
  agentPromptContractSha256: AaisAiAgentContractHashes;
  caBackgroundSha256: string | null;
  guardrailSha256: string | null;
  locales: AaisAiReleaseLocale[];
  passedAt: string | null;
  expiresAt: string | null;
  manifestSigningKeyId: string | null;
  manifestSignatureSha256: string | null;
  evidenceStatus: AaisAiReleaseEvidenceStatus;
  observedModelRequired: true;
};

type AaisAiReleaseReceiptLock = {
  required: true;
  verificationStage: "external-post-deploy";
  signingKeyId: string | null;
  verifyingKeySpkiSha256: string | null;
  /** Post-deploy fields are deliberately null in source control. */
  productionUrl: string | null;
  gitCommitSha: string | null;
  deploymentId: string | null;
  configGeneration: string | null;
  auditNonce: string | null;
  operationIdDerivation: string | null;
  privacyEvidenceSha256: string | null;
  learnerCanaryEvidenceSha256: string | null;
};

export type AaisAiProductionReleaseLock = {
  schemaVersion: 1;
  contractVersion: typeof aaisAiReleaseLockContractVersion;
  lockId: string;
  releaseStatus: AaisAiReleaseLockStatus;
  deliveryPolicy: "require-live";
  providers: {
    primary: AaisAiReleaseProviderLock & { role: "primary" };
    secondary: AaisAiReleaseProviderLock & { role: "secondary" };
  };
  releaseReceipt: AaisAiReleaseReceiptLock;
  redaction: {
    secrets: "omitted";
    modelIds: "fingerprint-only";
    rawPrompts: "omitted";
    rawOutputs: "omitted";
  };
};

export type AaisAiReleaseRuntimeProviderEvidence = {
  configurationStatus: "valid" | "missing" | "invalid";
  provider: string | null;
  modelFingerprint: string | null;
  endpointFingerprint: string | null;
  thinkingMode: AaisAiReleaseThinkingMode | null;
  temperature: number | null;
  maxTokens: number | null;
  observedRevisionSha256: string | null;
  evalApproval: AaisAiEvalApprovalResult;
};

export type AaisAiReleaseRuntimeEvidence = {
  deliveryPolicy: string;
  runtimeModeStatus: "valid" | "missing" | "invalid";
  sourceContract: AaisAiSourceContractEvidence;
  primary: AaisAiReleaseRuntimeProviderEvidence;
  secondary: AaisAiReleaseRuntimeProviderEvidence;
};

type AaisAiProviderGateIssueSuffix =
  | "CONFIGURATION"
  | "PROVIDER_MISMATCH"
  | "MODEL_MISMATCH"
  | "RUNTIME_CONTRACT"
  | "OBSERVATION_CONTRACT"
  | "EVAL_MANIFEST"
  | "MANIFEST_DIGEST"
  | "EVAL_EVIDENCE"
  | "PROMPT_CONTRACT"
  | "EVIDENCE_WINDOW"
  | "SIGNATURE";

export type AaisAiReleaseGateIssue =
  | "AAIS_AI_RELEASE_LOCK_INVALID"
  | "AAIS_AI_RELEASE_NOT_APPROVED"
  | "AAIS_AI_RELEASE_POLICY_MISMATCH"
  | "AAIS_AI_RUNTIME_MODE_CONFIGURATION"
  | `AAIS_AI_PRIMARY_${AaisAiProviderGateIssueSuffix}`
  | `AAIS_AI_SECONDARY_${AaisAiProviderGateIssueSuffix}`;

export type AaisAiReleaseProviderGate = {
  role: AaisAiReleaseProviderRole;
  runtimeRole: AaisAiRuntimeProviderRole;
  required: true;
  status: "verified" | "blocked";
  provider: string | null;
  modelFingerprint: string | null;
  endpointFingerprint: string | null;
  thinkingMode: AaisAiReleaseThinkingMode | null;
  temperature: number | null;
  maxTokens: number | null;
  observedRevisionSha256: string | null;
  evalVersion: string | null;
  evalManifest: AaisAiEvalManifestStatus;
  evalSource: "configured" | "bundled" | null;
  manifestSha256: string | null;
  evalSuiteSha256: string | null;
  evalDataSha256: string | null;
  caBackgroundSha256: string | null;
  guardrailSha256: string | null;
  locales: AaisAiReleaseLocale[];
  passedAt: string | null;
  expiresAt: string | null;
  manifestSigningKeyId: string | null;
  manifestSignatureSha256: string | null;
  observedModelRequired: true;
  issues: AaisAiReleaseGateIssue[];
};

export type AaisAiReleaseGate = {
  status: "verified" | "blocked" | "invalid";
  releaseState: "RELEASE_VERIFIED" | "RELEASE_BLOCKED";
  lock: {
    id: string | null;
    source: "bundled";
    contractVersion: typeof aaisAiReleaseLockContractVersion | null;
    releaseStatus: AaisAiReleaseLockStatus | null;
  };
  deliveryPolicy: string;
  providers: {
    primary: AaisAiReleaseProviderGate;
    secondary: AaisAiReleaseProviderGate;
  };
  externalAudit: {
    required: true;
    verificationStage: "external-post-deploy";
    signingKeyId: string | null;
    verifyingKeySpkiSha256: string | null;
    runtimeGateDependency: false;
  };
  issues: AaisAiReleaseGateIssue[];
  redaction: typeof redaction;
};

export type AaisAiSourceLockEligibility = {
  releaseState: AaisAiReleaseGate["releaseState"];
  primary: { eligible: boolean };
  fallback: { eligible: boolean };
};

const redaction = {
  secrets: "omitted",
  endpoints: "omitted",
  modelIds: "fingerprint-only",
  rawPrompts: "omitted",
  rawOutputs: "omitted",
} as const;
const agentIds = ["A1", "A2", "A3", "A4"] as const;
const requiredLocales: AaisAiReleaseLocale[] = ["zh-CN", "en-US"];

export function getBundledAaisAiProductionReleaseLock(now = new Date()) {
  return readAaisAiProductionReleaseLock(productionReleaseLockJson, now);
}

export function getAaisAiProductionReleaseGate(
  env: NodeJS.ProcessEnv = process.env,
  now = new Date(),
): AaisAiReleaseGate {
  const runtimeConfig = readAaisAiRuntimeConfig(env);
  const primaryEvalApproval = getAaisAiEvalApproval({
    required: true,
    provider: "qwen",
    model: runtimeConfig.primary?.model ?? null,
    providerRole: "primary",
    env,
    now,
  });
  const secondaryEvalApproval = getAaisAiEvalApproval({
    required: true,
    provider: "deepseek",
    model: runtimeConfig.fallback?.model ?? null,
    providerRole: "fallback",
    env,
    now,
  });
  return evaluateAaisAiReleaseGate({
    lock: productionReleaseLockJson,
    now,
    runtime: {
      deliveryPolicy: runtimeConfig.deliveryPolicy,
      runtimeModeStatus: runtimeConfig.configurationStatus.runtimeMode,
      sourceContract: getAaisAiSourceContractEvidence(),
      primary: createRuntimeProviderEvidence(
        runtimeConfig.primary,
        runtimeConfig.configurationStatus.primary,
        primaryEvalApproval,
      ),
      secondary: createRuntimeProviderEvidence(
        runtimeConfig.fallback,
        runtimeConfig.configurationStatus.fallback,
        secondaryEvalApproval,
      ),
    },
  });
}

/** Minimal cycle-safe projection consumed by learner provider preflight. */
export function getAaisAiSourceLockEligibility(
  env: NodeJS.ProcessEnv = process.env,
  now = new Date(),
): AaisAiSourceLockEligibility {
  return projectAaisAiSourceLockEligibility(
    getAaisAiProductionReleaseGate(env, now),
  );
}

export function projectAaisAiSourceLockEligibility(
  gate: AaisAiReleaseGate,
): AaisAiSourceLockEligibility {
  // A provider's source-lock eligibility is role-local once the shared lock
  // contract is sound. A blocked secondary must not make an otherwise fully
  // verified primary ineligible (and vice versa); the aggregate release state
  // deliberately remains RELEASE_BLOCKED until both required roles verify.
  const sharedIssues = new Set<AaisAiReleaseGateIssue>([
    "AAIS_AI_RELEASE_LOCK_INVALID",
    "AAIS_AI_RELEASE_NOT_APPROVED",
    "AAIS_AI_RELEASE_POLICY_MISMATCH",
    "AAIS_AI_RUNTIME_MODE_CONFIGURATION",
  ]);
  const sharedVerified = gate.status !== "invalid"
    && gate.lock.releaseStatus === "approved"
    && !gate.issues.some((issue) => sharedIssues.has(issue));
  return {
    releaseState: gate.releaseState,
    primary: {
      eligible: sharedVerified && gate.providers.primary.status === "verified",
    },
    fallback: {
      eligible: sharedVerified && gate.providers.secondary.status === "verified",
    },
  };
}

function createRuntimeProviderEvidence(
  candidate: AaisAiRuntimeProviderCandidate | null,
  configurationStatus: AaisAiReleaseRuntimeProviderEvidence["configurationStatus"],
  evalApproval: AaisAiEvalApprovalResult,
): AaisAiReleaseRuntimeProviderEvidence {
  return {
    configurationStatus,
    provider: candidate?.profile.provider ?? null,
    modelFingerprint: candidate?.profile.modelFingerprint ?? null,
    endpointFingerprint: candidate ? getAaisAiEndpointFingerprint(candidate.endpoint) : null,
    thinkingMode: candidate?.profile.thinkingMode ?? null,
    temperature: candidate ? aaisAiProviderTemperature : null,
    maxTokens: candidate?.maxTokens ?? null,
    observedRevisionSha256: candidate?.expectedObservedRevisionSha256 ?? null,
    evalApproval,
  };
}

export function getAaisAiEndpointFingerprint(endpoint: string) {
  return createHash("sha256")
    .update(`aais-ai-endpoint-v1:${endpoint}`)
    .digest("hex");
}

export function readAaisAiProductionReleaseLock(
  value: unknown,
  now = new Date(),
): AaisAiProductionReleaseLock | null {
  if (!isRecord(value) || !hasExactKeys(value, [
    "schemaVersion",
    "contractVersion",
    "lockId",
    "releaseStatus",
    "deliveryPolicy",
    "providers",
    "releaseReceipt",
    "redaction",
  ])) return null;
  if (value.schemaVersion !== 1
    || value.contractVersion !== aaisAiReleaseLockContractVersion
    || !isSafeIdentifier(value.lockId)
    || (value.releaseStatus !== "blocked" && value.releaseStatus !== "approved")
    || value.deliveryPolicy !== "require-live"
    || !isRecord(value.providers)
    || !hasExactKeys(value.providers, ["primary", "secondary"])
    || !isReleaseProviderLock(value.providers.primary, "primary")
    || !isReleaseProviderLock(value.providers.secondary, "secondary")
    || !isReleaseReceiptLock(value.releaseReceipt)
    || !isReleaseLockRedaction(value.redaction)) return null;
  const lock = value as AaisAiProductionReleaseLock;
  if (lock.releaseStatus === "approved"
    && (!hasCompleteApprovedProviderEvidence(lock.providers.primary, now)
      || !hasCompleteApprovedProviderEvidence(lock.providers.secondary, now)
      || !hasCompleteApprovedReceiptLock(lock.releaseReceipt))) return null;
  return lock;
}

export function evaluateAaisAiReleaseGate(input: {
  runtime: AaisAiReleaseRuntimeEvidence;
  lock?: unknown;
  now?: Date;
}): AaisAiReleaseGate {
  const lock = readAaisAiProductionReleaseLock(
    input.lock === undefined ? productionReleaseLockJson : input.lock,
    input.now ?? new Date(),
  );
  if (!lock) return createInvalidReleaseGate(input.runtime);

  const sharedIssues: AaisAiReleaseGateIssue[] = [];
  if (lock.releaseStatus !== "approved") sharedIssues.push("AAIS_AI_RELEASE_NOT_APPROVED");
  if (input.runtime.deliveryPolicy !== lock.deliveryPolicy) {
    sharedIssues.push("AAIS_AI_RELEASE_POLICY_MISMATCH");
  }
  if (input.runtime.runtimeModeStatus !== "valid") {
    sharedIssues.push("AAIS_AI_RUNTIME_MODE_CONFIGURATION");
  }
  const primary = evaluateProviderGate(
    "primary",
    lock.providers.primary,
    input.runtime.primary,
    input.runtime.sourceContract,
  );
  const secondary = evaluateProviderGate(
    "secondary",
    lock.providers.secondary,
    input.runtime.secondary,
    input.runtime.sourceContract,
  );
  const issues = uniqueIssues([
    ...sharedIssues,
    ...primary.issues,
    ...secondary.issues,
  ]);
  return {
    status: issues.length ? "blocked" : "verified",
    releaseState: issues.length ? "RELEASE_BLOCKED" : "RELEASE_VERIFIED",
    lock: {
      id: lock.lockId,
      source: "bundled",
      contractVersion: lock.contractVersion,
      releaseStatus: lock.releaseStatus,
    },
    deliveryPolicy: input.runtime.deliveryPolicy,
    providers: { primary, secondary },
    externalAudit: projectExternalAudit(lock.releaseReceipt),
    issues,
    redaction,
  };
}

function evaluateProviderGate(
  role: AaisAiReleaseProviderRole,
  lock: AaisAiReleaseProviderLock,
  runtime: AaisAiReleaseRuntimeProviderEvidence,
  sourceContract: AaisAiSourceContractEvidence,
): AaisAiReleaseProviderGate {
  const prefix = role === "primary" ? "PRIMARY" : "SECONDARY";
  const issue = (suffix: AaisAiProviderGateIssueSuffix) =>
    `AAIS_AI_${prefix}_${suffix}` as AaisAiReleaseGateIssue;
  const issues: AaisAiReleaseGateIssue[] = [];
  const manifest = runtime.evalApproval.manifest;
  const evidence = manifest.releaseEvidence;
  const expectedModelFingerprint = getAaisAiModelFingerprint(lock.model);

  if (runtime.configurationStatus !== "valid") issues.push(issue("CONFIGURATION"));
  if (runtime.provider !== lock.provider) issues.push(issue("PROVIDER_MISMATCH"));
  if (manifest.provider !== lock.provider) issues.push(issue("PROVIDER_MISMATCH"));
  if (runtime.modelFingerprint !== expectedModelFingerprint
    || !lock.observedModel
    || getAaisAiModelFingerprint(lock.observedModel) !== expectedModelFingerprint) {
    issues.push(issue("MODEL_MISMATCH"));
  }
  if (!lock.endpointFingerprint
    || runtime.endpointFingerprint !== lock.endpointFingerprint
    || evidence?.endpointFingerprint !== lock.endpointFingerprint
    || runtime.thinkingMode !== lock.thinkingMode
    || evidence?.thinkingMode !== lock.thinkingMode
    || runtime.temperature !== lock.temperature
    || evidence?.temperature !== lock.temperature
    || runtime.maxTokens !== lock.maxTokens
    || evidence?.maxTokens !== lock.maxTokens) {
    issues.push(issue("RUNTIME_CONTRACT"));
  }
  if (!lock.observedRevisionSha256
    || runtime.observedRevisionSha256 !== lock.observedRevisionSha256
    || evidence?.observedRevisionSha256 !== lock.observedRevisionSha256) {
    issues.push(issue("OBSERVATION_CONTRACT"));
  }
  if (lock.evidenceStatus !== "verified"
    || !runtime.evalApproval.approved
    || runtime.evalApproval.evalVersion !== lock.evalVersion
    || manifest.status !== "verified") {
    issues.push(issue("EVAL_MANIFEST"));
  }
  const manifestSha256 = readManifestSha256(runtime.evalApproval);
  if (!lock.manifestSha256 || manifestSha256 !== lock.manifestSha256) {
    issues.push(issue("MANIFEST_DIGEST"));
  }
  if (!evidence
    || evidence.evalSuiteSha256 !== lock.evalSuiteSha256
    || evidence.evalDataSha256 !== lock.evalDataSha256
    || !arraysEqual(evidence.locales, lock.locales)) {
    issues.push(issue("EVAL_EVIDENCE"));
  }
  if (!evidence
    || !agentIds.every((agentId) =>
      evidence.agentPromptContractSha256[agentId] === lock.agentPromptContractSha256[agentId]
      && sourceContract.agentPromptContractSha256[agentId]
        === lock.agentPromptContractSha256[agentId])
    || evidence.caBackgroundSha256 !== lock.caBackgroundSha256
    || sourceContract.caBackgroundSha256 !== lock.caBackgroundSha256
    || evidence.guardrailSha256 !== lock.guardrailSha256
    || sourceContract.guardrailSha256 !== lock.guardrailSha256) {
    issues.push(issue("PROMPT_CONTRACT"));
  }
  if (manifest.passedAt !== lock.passedAt || manifest.expiresAt !== lock.expiresAt) {
    issues.push(issue("EVIDENCE_WINDOW"));
  }
  if (!evidence
    || evidence.signatureVerified !== true
    || evidence.signingKeyId !== lock.manifestSigningKeyId
    || evidence.signatureSha256 !== lock.manifestSignatureSha256) {
    issues.push(issue("SIGNATURE"));
  }

  return {
    role,
    runtimeRole: role === "primary" ? "primary" : "fallback",
    required: true,
    status: issues.length ? "blocked" : "verified",
    provider: runtime.provider,
    modelFingerprint: runtime.modelFingerprint,
    endpointFingerprint: runtime.endpointFingerprint,
    thinkingMode: runtime.thinkingMode,
    temperature: runtime.temperature,
    maxTokens: runtime.maxTokens,
    observedRevisionSha256: runtime.observedRevisionSha256,
    evalVersion: runtime.evalApproval.evalVersion,
    evalManifest: manifest.status,
    evalSource: manifest.source ?? null,
    manifestSha256,
    evalSuiteSha256: evidence?.evalSuiteSha256 ?? null,
    evalDataSha256: evidence?.evalDataSha256 ?? null,
    caBackgroundSha256: evidence?.caBackgroundSha256 ?? null,
    guardrailSha256: evidence?.guardrailSha256 ?? null,
    locales: evidence?.locales ?? [],
    passedAt: manifest.passedAt ?? null,
    expiresAt: manifest.expiresAt ?? null,
    manifestSigningKeyId: evidence?.signingKeyId ?? null,
    manifestSignatureSha256: evidence?.signatureSha256 ?? null,
    observedModelRequired: true,
    issues,
  };
}

function createInvalidReleaseGate(runtime: AaisAiReleaseRuntimeEvidence): AaisAiReleaseGate {
  const issues: AaisAiReleaseGateIssue[] = ["AAIS_AI_RELEASE_LOCK_INVALID"];
  return {
    status: "invalid",
    releaseState: "RELEASE_BLOCKED",
    lock: { id: null, source: "bundled", contractVersion: null, releaseStatus: null },
    deliveryPolicy: runtime.deliveryPolicy,
    providers: {
      primary: createInvalidProviderGate("primary", runtime.primary, issues),
      secondary: createInvalidProviderGate("secondary", runtime.secondary, issues),
    },
    externalAudit: {
      required: true,
      verificationStage: "external-post-deploy",
      signingKeyId: null,
      verifyingKeySpkiSha256: null,
      runtimeGateDependency: false,
    },
    issues,
    redaction,
  };
}

function createInvalidProviderGate(
  role: AaisAiReleaseProviderRole,
  runtime: AaisAiReleaseRuntimeProviderEvidence,
  issues: AaisAiReleaseGateIssue[],
): AaisAiReleaseProviderGate {
  const evidence = runtime.evalApproval.manifest.releaseEvidence;
  return {
    role,
    runtimeRole: role === "primary" ? "primary" : "fallback",
    required: true,
    status: "blocked",
    provider: runtime.provider,
    modelFingerprint: runtime.modelFingerprint,
    endpointFingerprint: runtime.endpointFingerprint,
    thinkingMode: runtime.thinkingMode,
    temperature: runtime.temperature,
    maxTokens: runtime.maxTokens,
    observedRevisionSha256: runtime.observedRevisionSha256,
    evalVersion: runtime.evalApproval.evalVersion,
    evalManifest: runtime.evalApproval.manifest.status,
    evalSource: runtime.evalApproval.manifest.source ?? null,
    manifestSha256: readManifestSha256(runtime.evalApproval),
    evalSuiteSha256: evidence?.evalSuiteSha256 ?? null,
    evalDataSha256: evidence?.evalDataSha256 ?? null,
    caBackgroundSha256: evidence?.caBackgroundSha256 ?? null,
    guardrailSha256: evidence?.guardrailSha256 ?? null,
    locales: evidence?.locales ?? [],
    passedAt: runtime.evalApproval.manifest.passedAt ?? null,
    expiresAt: runtime.evalApproval.manifest.expiresAt ?? null,
    manifestSigningKeyId: evidence?.signingKeyId ?? null,
    manifestSignatureSha256: evidence?.signatureSha256 ?? null,
    observedModelRequired: true,
    issues,
  };
}

function projectExternalAudit(
  receipt: AaisAiReleaseReceiptLock,
): AaisAiReleaseGate["externalAudit"] {
  return {
    required: true,
    verificationStage: receipt.verificationStage,
    signingKeyId: receipt.signingKeyId,
    verifyingKeySpkiSha256: receipt.verifyingKeySpkiSha256,
    runtimeGateDependency: false,
  };
}

function isReleaseProviderLock(
  value: unknown,
  role: AaisAiReleaseProviderRole,
): value is AaisAiReleaseProviderLock {
  if (!isRecord(value) || !hasExactKeys(value, [
    "role", "required", "provider", "model", "endpointFingerprint", "thinkingMode",
    "temperature", "maxTokens", "observedModel", "observedRevisionSha256", "evalVersion",
    "manifestSha256", "evalSuiteSha256", "evalDataSha256", "agentPromptContractSha256",
    "caBackgroundSha256", "guardrailSha256", "locales", "passedAt", "expiresAt",
    "manifestSigningKeyId", "manifestSignatureSha256", "evidenceStatus",
    "observedModelRequired",
  ])) return false;
  return value.role === role
    && value.required === true
    && value.provider === (role === "primary" ? "qwen" : "deepseek")
    && isSafeModelId(value.model)
    && isNullableSha256(value.endpointFingerprint)
    && (value.thinkingMode === null
      || value.thinkingMode === "disabled"
      || value.thinkingMode === "provider-default")
    && (value.temperature === null
      || (typeof value.temperature === "number" && value.temperature >= 0 && value.temperature <= 2))
    && (value.maxTokens === null
      || (Number.isSafeInteger(value.maxTokens) && Number(value.maxTokens) > 0))
    && (value.observedModel === null || isSafeModelId(value.observedModel))
    && isNullableSha256(value.observedRevisionSha256)
    && (value.evalVersion === null || isSafeIdentifier(value.evalVersion))
    && isNullableSha256(value.manifestSha256)
    && isNullableSha256(value.evalSuiteSha256)
    && isNullableSha256(value.evalDataSha256)
    && isAgentContractHashes(value.agentPromptContractSha256)
    && isNullableSha256(value.caBackgroundSha256)
    && isNullableSha256(value.guardrailSha256)
    && isReleaseLocales(value.locales)
    && (value.passedAt === null || readCanonicalIsoTime(value.passedAt) !== null)
    && (value.expiresAt === null || readCanonicalIsoTime(value.expiresAt) !== null)
    && (value.manifestSigningKeyId === null || isSafeIdentifier(value.manifestSigningKeyId))
    && isNullableSha256(value.manifestSignatureSha256)
    && (value.evidenceStatus === "pending" || value.evidenceStatus === "verified")
    && value.observedModelRequired === true;
}

function hasCompleteApprovedProviderEvidence(
  value: AaisAiReleaseProviderLock,
  now: Date,
) {
  return value.evidenceStatus === "verified"
    && value.endpointFingerprint !== null
    && value.thinkingMode !== null
    && value.temperature !== null
    && value.maxTokens !== null
    && value.observedModel === value.model
    && value.observedRevisionSha256 !== null
    && value.evalVersion !== null
    && value.manifestSha256 !== null
    && value.evalSuiteSha256 !== null
    && value.evalDataSha256 !== null
    && agentIds.every((agentId) => value.agentPromptContractSha256[agentId] !== null)
    && value.caBackgroundSha256 !== null
    && value.guardrailSha256 !== null
    && arraysEqual(value.locales, requiredLocales)
    && value.passedAt !== null
    && value.expiresAt !== null
    && isEvidenceWindowValid(value.passedAt, value.expiresAt, now, 30)
    && value.manifestSigningKeyId !== null
    && value.manifestSignatureSha256 !== null;
}

function isReleaseReceiptLock(value: unknown): value is AaisAiReleaseReceiptLock {
  return isRecord(value)
    && hasExactKeys(value, [
      "required", "verificationStage", "signingKeyId", "verifyingKeySpkiSha256",
      "productionUrl", "gitCommitSha", "deploymentId", "configGeneration",
      "auditNonce", "operationIdDerivation", "privacyEvidenceSha256",
      "learnerCanaryEvidenceSha256",
    ])
    && value.required === true
    && value.verificationStage === "external-post-deploy"
    && (value.signingKeyId === null || isSafeIdentifier(value.signingKeyId))
    && isNullableSha256(value.verifyingKeySpkiSha256)
    // These are intentionally populated only in the external signed audit
    // receipt after the immutable deployment has been exercised. Requiring
    // them in the deployed source lock would create a deployment self-reference.
    && value.productionUrl === null
    && value.gitCommitSha === null
    && value.deploymentId === null
    && value.configGeneration === null
    && value.auditNonce === null
    && value.operationIdDerivation === null
    && value.privacyEvidenceSha256 === null
    && value.learnerCanaryEvidenceSha256 === null;
}

function hasCompleteApprovedReceiptLock(value: AaisAiReleaseReceiptLock) {
  return value.signingKeyId !== null
    && value.verifyingKeySpkiSha256 !== null;
}

function isEvidenceWindowValid(
  passedAt: string,
  expiresAt: string,
  now: Date,
  maximumDays: number,
) {
  const passed = readCanonicalIsoTime(passedAt);
  const expires = readCanonicalIsoTime(expiresAt);
  const nowMs = now.getTime();
  return passed !== null
    && expires !== null
    && Number.isFinite(nowMs)
    && passed <= nowMs
    && expires > nowMs
    && expires > passed
    && expires - passed <= maximumDays * 24 * 60 * 60 * 1_000;
}

function readCanonicalIsoTime(value: unknown) {
  if (typeof value !== "string") return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) && new Date(parsed).toISOString() === value ? parsed : null;
}

function isAgentContractHashes(value: unknown): value is AaisAiAgentContractHashes {
  return isRecord(value)
    && hasExactKeys(value, [...agentIds])
    && agentIds.every((agentId) => isNullableSha256(value[agentId]));
}

function isReleaseLocales(value: unknown): value is AaisAiReleaseLocale[] {
  return Array.isArray(value)
    && value.every((locale) => locale === "zh-CN" || locale === "en-US")
    && new Set(value).size === value.length
    && (value.length === 0 || arraysEqual(value, requiredLocales));
}

function isReleaseLockRedaction(value: unknown) {
  return isRecord(value)
    && hasExactKeys(value, ["secrets", "modelIds", "rawPrompts", "rawOutputs"])
    && value.secrets === "omitted"
    && value.modelIds === "fingerprint-only"
    && value.rawPrompts === "omitted"
    && value.rawOutputs === "omitted";
}

function readManifestSha256(approval: AaisAiEvalApprovalResult) {
  return isSha256(approval.manifest.manifestSha256)
    ? approval.manifest.manifestSha256
    : null;
}

function isSafeModelId(value: unknown): value is string {
  return typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9._:/-]{1,127}$/.test(value);
}

function isSafeIdentifier(value: unknown): value is string {
  return typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9._:-]{2,127}$/.test(value);
}

function isSha256(value: unknown): value is string {
  return typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
}

function isNullableSha256(value: unknown) {
  return value === null || isSha256(value);
}

function arraysEqual(left: readonly unknown[], right: readonly unknown[]) {
  return left.length === right.length && left.every((item, index) => item === right[index]);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function hasExactKeys(value: Record<string, unknown>, keys: readonly string[]) {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return actual.length === expected.length
    && actual.every((key, index) => key === expected[index]);
}

function uniqueIssues(issues: AaisAiReleaseGateIssue[]) {
  return [...new Set(issues)];
}
