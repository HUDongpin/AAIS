#!/usr/bin/env node

import {
  createHash,
  createPrivateKey,
  createPublicKey,
  sign as signPayload,
} from "node:crypto";
import { writeFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

export const aaisAiExternalAuditContractVersion =
  "aais-ai-external-production-audit-v1";

export const aaisAiProductionProbeDefinitions = [
  ["aais-live-primary-a1-zh-v1", "primary", "A1", "zh-CN"],
  ["aais-live-primary-a1-en-v1", "primary", "A1", "en-US"],
  ["aais-live-primary-a2-zh-v1", "primary", "A2", "zh-CN"],
  ["aais-live-primary-a2-en-v1", "primary", "A2", "en-US"],
  ["aais-live-secondary-a1-zh-v1", "secondary", "A1", "zh-CN"],
  ["aais-live-secondary-a1-en-v1", "secondary", "A1", "en-US"],
  ["aais-live-secondary-a2-zh-v1", "secondary", "A2", "zh-CN"],
  ["aais-live-secondary-a2-en-v1", "secondary", "A2", "en-US"],
].map(([syntheticId, providerRole, agentId, locale]) => ({
  syntheticId,
  providerRole,
  agentId,
  locale,
}));

export const aaisAiLearnerCanaryDefinitions = [
  ["aais-release-learner-a1-zh-json-v1", "A1", "zh-CN", "json"],
  ["aais-release-learner-a1-zh-sse-v1", "A1", "zh-CN", "sse"],
  ["aais-release-learner-a1-en-json-v1", "A1", "en-US", "json"],
  ["aais-release-learner-a1-en-sse-v1", "A1", "en-US", "sse"],
  ["aais-release-learner-a2-zh-json-v1", "A2", "zh-CN", "json"],
  ["aais-release-learner-a2-zh-sse-v1", "A2", "zh-CN", "sse"],
  ["aais-release-learner-a2-en-json-v1", "A2", "en-US", "json"],
  ["aais-release-learner-a2-en-sse-v1", "A2", "en-US", "sse"],
].map(([canaryId, agentId, locale, transport]) => ({
  canaryId,
  agentId,
  locale,
  transport,
}));

const requiredEnvironmentNames = [
  "AAIS_RELEASE_IMMUTABLE_URL",
  "AAIS_RELEASE_DEPLOYMENT_ID",
  "AAIS_RELEASE_GIT_COMMIT_SHA",
  "AAIS_RELEASE_CONFIG_GENERATION",
  "AAIS_RELEASE_EXPECTED_LOCK_ID",
  "AAIS_RELEASE_PRIMARY_MANIFEST_SHA256",
  "AAIS_RELEASE_SECONDARY_MANIFEST_SHA256",
  "AAIS_RELEASE_READINESS_BEARER_TOKEN",
  "AAIS_RELEASE_LIVE_PROBE_BEARER_TOKEN",
  "AAIS_RELEASE_VERCEL_PROTECTION_BYPASS_SECRET",
  "AAIS_RELEASE_LEARNER_SESSION_COOKIE",
  "AAIS_RELEASE_LEARNER_CSRF_TOKEN",
  "AAIS_RELEASE_SYNTHETIC_ACTOR_FINGERPRINT_SHA256",
  "AAIS_RELEASE_VERCEL_API_TOKEN",
  "AAIS_RELEASE_VERCEL_TEAM_ID",
  "AAIS_RELEASE_VERCEL_PROJECT_ID",
  "AAIS_RELEASE_AUDIT_SIGNING_KEY_ID",
  "AAIS_RELEASE_AUDIT_SIGNING_KEY_PKCS8",
  "AAIS_RELEASE_AUDIT_NONCE",
  "AAIS_RELEASE_AUDIT_RECEIPT_PATH",
];

const requestTimeoutMs = 35_000;
const maximumResponseBytes = 1024 * 1024;
const fullShaPattern = /^[a-f0-9]{40}$/;
const sha256Pattern = /^[a-f0-9]{64}$/;
const safeIdentifierPattern = /^[A-Za-z0-9][A-Za-z0-9._:-]{2,127}$/;
const strongBearerPattern = /^[\x21-\x7e]{32,512}$/;
const csrfTokenPattern = /^[A-Za-z0-9._~-]{32,2048}$/;
const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export class AaisAiProductionReleaseGateError extends Error {
  constructor(code) {
    super(code);
    this.name = "AaisAiProductionReleaseGateError";
    this.code = code;
  }
}

export function readAaisAiProductionReleaseGateConfig(env = process.env) {
  const missing = requiredEnvironmentNames.filter((name) => !String(env[name] ?? "").trim());
  if (missing.length) fail("AAIS_RELEASE_CONFIGURATION_MISSING");

  const immutableUrl = readImmutableVercelUrl(env.AAIS_RELEASE_IMMUTABLE_URL);
  const gitCommitSha = readFullGitSha(env.AAIS_RELEASE_GIT_COMMIT_SHA);
  const deploymentId = readIdentifier(env.AAIS_RELEASE_DEPLOYMENT_ID);
  if (!deploymentId.startsWith("dpl_")) fail("AAIS_RELEASE_DEPLOYMENT_ID_INVALID");
  const configGeneration = readIdentifier(env.AAIS_RELEASE_CONFIG_GENERATION);
  const expectedLockId = readIdentifier(env.AAIS_RELEASE_EXPECTED_LOCK_ID);
  const primaryManifestSha256 = readSha256(env.AAIS_RELEASE_PRIMARY_MANIFEST_SHA256);
  const secondaryManifestSha256 = readSha256(env.AAIS_RELEASE_SECONDARY_MANIFEST_SHA256);
  const readinessBearer = readStrongBearer(env.AAIS_RELEASE_READINESS_BEARER_TOKEN);
  const probeBearer = readStrongBearer(env.AAIS_RELEASE_LIVE_PROBE_BEARER_TOKEN);
  const protectionBypassSecret = readStrongBearer(
    env.AAIS_RELEASE_VERCEL_PROTECTION_BYPASS_SECRET,
  );
  if (new Set([readinessBearer, probeBearer, protectionBypassSecret]).size !== 3) {
    fail("AAIS_RELEASE_BEARERS_NOT_DISTINCT");
  }
  const learnerCsrfToken = readLearnerCsrfToken(env.AAIS_RELEASE_LEARNER_CSRF_TOKEN);
  const learnerSessionCookie = readLearnerSessionCookie(
    env.AAIS_RELEASE_LEARNER_SESSION_COOKIE,
    learnerCsrfToken,
  );
  const syntheticActorFingerprintSha256 = readSha256(
    env.AAIS_RELEASE_SYNTHETIC_ACTOR_FINGERPRINT_SHA256,
  );

  const auditSigningKeyId = readIdentifier(env.AAIS_RELEASE_AUDIT_SIGNING_KEY_ID);
  const auditNonce = readIdentifier(env.AAIS_RELEASE_AUDIT_NONCE);
  const auditPrivateKey = readEd25519PrivateKey(env.AAIS_RELEASE_AUDIT_SIGNING_KEY_PKCS8);
  const auditPublicKeySpki = createPublicKey(auditPrivateKey).export({
    format: "der",
    type: "spki",
  });
  const auditVerifyingKeySpki = auditPublicKeySpki.toString("base64");
  const auditVerifyingKeySpkiSha256 = createHash("sha256")
    .update(auditPublicKeySpki)
    .digest("hex");
  const receiptPath = String(env.AAIS_RELEASE_AUDIT_RECEIPT_PATH).trim();
  if (!receiptPath || receiptPath.includes("\0")) fail("AAIS_RELEASE_AUDIT_PATH_INVALID");

  return {
    immutableUrl,
    immutableOrigin: new URL(immutableUrl).origin,
    deploymentId,
    gitCommitSha,
    configGeneration,
    expectedLockId,
    manifests: {
      primary: primaryManifestSha256,
      secondary: secondaryManifestSha256,
    },
    readinessBearer,
    probeBearer,
    learner: {
      sessionCookie: learnerSessionCookie,
      csrfToken: learnerCsrfToken,
      actorFingerprintSha256: syntheticActorFingerprintSha256,
    },
    vercel: {
      apiToken: String(env.AAIS_RELEASE_VERCEL_API_TOKEN).trim(),
      teamId: readIdentifier(env.AAIS_RELEASE_VERCEL_TEAM_ID),
      projectId: readIdentifier(env.AAIS_RELEASE_VERCEL_PROJECT_ID),
      protectionBypassSecret,
    },
    audit: {
      signingKeyId: auditSigningKeyId,
      nonce: auditNonce,
      privateKey: auditPrivateKey,
      verifyingKeySpki: auditVerifyingKeySpki,
      verifyingKeySpkiSha256: auditVerifyingKeySpkiSha256,
      receiptPath,
    },
  };
}

export async function runAaisAiProductionReleaseGate(input = {}) {
  const config = input.config ?? readAaisAiProductionReleaseGateConfig(input.env);
  const fetchImpl = input.fetchImpl ?? fetch;
  const now = input.now ?? (() => new Date());
  const issuedAt = now();
  if (!(issuedAt instanceof Date) || !Number.isFinite(issuedAt.getTime())) {
    fail("AAIS_RELEASE_CLOCK_INVALID");
  }

  const vercelEvidence = await verifyVercelDeployment(config, fetchImpl, issuedAt);
  const readiness = await verifyProtectedReadiness(config, fetchImpl);
  const probes = [];
  for (const definition of aaisAiProductionProbeDefinitions) {
    probes.push(await verifyLiveProbe(config, definition, fetchImpl));
  }
  const learnerDefinitions = aaisAiLearnerCanaryDefinitions.map((definition) => ({
    ...definition,
    operationId: createLearnerCanaryOperationId({
      gitCommitSha: config.gitCommitSha,
      deploymentId: config.deploymentId,
      configGeneration: config.configGeneration,
      canaryId: definition.canaryId,
      auditNonce: config.audit.nonce,
    }),
  }));
  if (new Set(learnerDefinitions.map((definition) => definition.operationId)).size
    !== learnerDefinitions.length) {
    fail("AAIS_RELEASE_LEARNER_OPERATION_ID_INVALID");
  }
  const learnerSession = await createFreshLearnerCanarySession(config, fetchImpl);
  const learnerCanaryEvidence = [];
  let learnerFailure = null;
  try {
    for (const definition of learnerDefinitions) {
      learnerCanaryEvidence.push(await verifyLearnerCanary(
        config,
        learnerSession,
        definition,
        fetchImpl,
      ));
    }
  } catch (error) {
    learnerFailure = error;
  }
  const privacyEvidence = await deleteAndVerifyLearnerCanarySession(
    config,
    learnerSession,
    learnerDefinitions,
    fetchImpl,
    learnerFailure === null,
  );
  if (learnerFailure) throw learnerFailure;

  const unsignedReceipt = {
    schemaVersion: 1,
    contractVersion: aaisAiExternalAuditContractVersion,
    lockId: config.expectedLockId,
    immutableUrl: config.immutableUrl,
    immutableUrlSha256: createProductionUrlSha256(config.immutableUrl),
    deploymentId: config.deploymentId,
    gitCommitSha: config.gitCommitSha,
    configGeneration: config.configGeneration,
    providerManifests: { ...config.manifests },
    privacyEvidence,
    privacyEvidenceSha256: privacyEvidence.evidenceSha256,
    learnerCanaryEvidence,
    learnerCanaryEvidenceSha256: sha256Canonical(
      learnerCanaryEvidence,
      "aais-ai-learner-live-canary-set-v1",
    ),
    auditRun: {
      nonce: config.audit.nonce,
      operationIdDerivation: "sha256-domain-uuid-v5-v1",
    },
    readinessEvidenceSha256: readiness.evidenceSha256,
    probeEvidence: probes,
    vercelEvidence,
    issuedAt: issuedAt.toISOString(),
    expiresAt: new Date(issuedAt.getTime() + 24 * 60 * 60 * 1_000).toISOString(),
    redaction: {
      secrets: "omitted",
      prompts: "omitted",
      responses: "omitted",
      providerBodies: "omitted",
      learnerIdentity: "omitted",
      modelIds: "fingerprint-only",
    },
    attestation: {
      algorithm: "ed25519",
      keyId: config.audit.signingKeyId,
      verifyingKeySpki: config.audit.verifyingKeySpki,
      verifyingKeySpkiSha256: config.audit.verifyingKeySpkiSha256,
    },
  };
  const signature = signPayload(
    null,
    Buffer.from(createExternalAuditSigningPayload(unsignedReceipt), "utf8"),
    config.audit.privateKey,
  ).toString("base64");
  const receipt = {
    ...unsignedReceipt,
    attestation: {
      ...unsignedReceipt.attestation,
      signature,
    },
  };
  return {
    status: "verified",
    receipt,
    receiptSha256: createExternalAuditReceiptSha256(receipt),
    receiptPath: config.audit.receiptPath,
  };
}

export function createExternalAuditSigningPayload(receipt) {
  if (!isRecord(receipt) || !isRecord(receipt.attestation)) {
    fail("AAIS_RELEASE_AUDIT_RECEIPT_INVALID");
  }
  const attestation = { ...receipt.attestation };
  delete attestation.signature;
  return `aais-ai-external-production-audit-signature-v1:${canonicalizeJson({
    ...receipt,
    attestation,
  })}`;
}

export function createExternalAuditReceiptSha256(receipt) {
  return createHash("sha256")
    .update(`aais-ai-external-production-audit-v1:${canonicalizeJson(receipt)}`)
    .digest("hex");
}

export function createProductionUrlSha256(url) {
  return createHash("sha256")
    .update(`aais-ai-production-url-v1:${url}`)
    .digest("hex");
}

export function createLearnerCanaryOperationId(input) {
  const digest = createHash("sha256").update(
    `aais-ai-learner-canary-operation-v1:${canonicalizeJson({
      auditNonce: input.auditNonce,
      canaryId: input.canaryId,
      configGeneration: input.configGeneration,
      deploymentId: input.deploymentId,
      gitCommitSha: input.gitCommitSha,
    })}`,
  ).digest().subarray(0, 16);
  digest[6] = (digest[6] & 0x0f) | 0x50;
  digest[8] = (digest[8] & 0x3f) | 0x80;
  const hex = digest.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

async function verifyVercelDeployment(config, fetchImpl, observedAt) {
  const endpoint = `https://api.vercel.com/v13/deployments/${encodeURIComponent(
    config.deploymentId,
  )}?teamId=${encodeURIComponent(config.vercel.teamId)}`;
  const body = await requestJson(fetchImpl, endpoint, {
    method: "GET",
    headers: {
      accept: "application/json",
      authorization: `Bearer ${config.vercel.apiToken}`,
    },
  }, "AAIS_RELEASE_VERCEL_ATTESTATION_FAILED");
  const expectedHostname = new URL(config.immutableUrl).hostname;
  const providerSha = body?.gitSource?.sha ?? body?.meta?.githubCommitSha;
  const providerRef = body?.gitSource?.ref ?? body?.meta?.githubCommitRef;
  const providerTeamId = body?.team?.id ?? body?.ownerId;
  if (body?.id !== config.deploymentId
    || body?.projectId !== config.vercel.projectId
    || providerTeamId !== config.vercel.teamId
    || body?.url !== expectedHostname
    || (body?.readyState !== "READY" && body?.status !== "READY")
    || body?.target !== "production"
    || providerSha !== config.gitCommitSha
    || providerRef !== "main") {
    fail("AAIS_RELEASE_VERCEL_ATTESTATION_MISMATCH");
  }
  return {
    provider: "vercel",
    status: "verified",
    observedAt: observedAt.toISOString(),
  };
}

async function verifyProtectedReadiness(config, fetchImpl) {
  const body = await requestJson(fetchImpl, `${config.immutableOrigin}/api/system/readiness`, {
    method: "GET",
    headers: {
      accept: "application/json",
      authorization: `Bearer ${config.readinessBearer}`,
      ...createVercelProtectionBypassHeader(config),
    },
  }, "AAIS_RELEASE_READINESS_FAILED");
  const deployment = body?.release?.deployment;
  const ai = body?.checks?.ai;
  const gate = ai?.releaseGate;
  if (body?.status !== "ready"
    || body?.runtime !== "production"
    || deployment?.provider !== "vercel"
    || deployment?.gitCommit?.fullSha !== config.gitCommitSha
    || deployment?.deploymentId !== config.deploymentId
    || deployment?.configGeneration !== config.configGeneration
    || ai?.status !== "ok"
    || ai?.deliveryPolicy !== "require-live"
    || ai?.liveProbe?.status !== "ok"
    || ai?.liveProbe?.bearerConfigured !== true
    || ai?.liveProbe?.bearerFormatValid !== true
    || ai?.liveProbe?.bearerDistinct !== true
    || gate?.status !== "verified"
    || gate?.releaseState !== "RELEASE_VERIFIED"
    || gate?.lock?.id !== config.expectedLockId
    || gate?.lock?.releaseStatus !== "approved"
    || gate?.externalAudit?.required !== true
    || gate?.externalAudit?.verificationStage !== "external-post-deploy"
    || gate?.externalAudit?.runtimeGateDependency !== false
    || gate?.externalAudit?.signingKeyId !== config.audit.signingKeyId
    || gate?.externalAudit?.verifyingKeySpkiSha256
      !== config.audit.verifyingKeySpkiSha256
    || !Array.isArray(gate?.issues)
    || gate.issues.length !== 0) {
    fail("AAIS_RELEASE_READINESS_MISMATCH");
  }
  verifyReadinessProvider(
    gate.providers?.primary,
    "primary",
    "qwen",
    "qwen3.8-max",
    config.manifests.primary,
  );
  verifyReadinessProvider(
    gate.providers?.secondary,
    "secondary",
    "deepseek",
    "deepseek-v4-flash",
    config.manifests.secondary,
  );
  const profile = ai?.runtimeProfile;
  if (profile?.primary?.maxRetries !== 0
    || profile?.primary?.thinkingMode !== "disabled"
    || profile?.fallback?.maxRetries !== 0
    || profile?.fallback?.thinkingMode !== "disabled") {
    fail("AAIS_RELEASE_RUNTIME_PROFILE_MISMATCH");
  }
  return {
    evidenceSha256: sha256Canonical({
      deploymentId: deployment.deploymentId,
      gitCommitSha: deployment.gitCommit.fullSha,
      configGeneration: deployment.configGeneration,
      lockId: gate.lock.id,
      providers: {
        primary: projectReadinessProvider(gate.providers.primary),
        secondary: projectReadinessProvider(gate.providers.secondary),
      },
    }, "aais-ai-readiness-evidence-v1"),
  };
}

function verifyReadinessProvider(provider, role, expectedProvider, model, manifestSha256) {
  if (provider?.role !== role
    || provider?.status !== "verified"
    || provider?.provider !== expectedProvider
    || provider?.modelFingerprint !== createModelFingerprint(model)
    || provider?.thinkingMode !== "disabled"
    || provider?.temperature !== 0.2
    || provider?.maxTokens !== 600
    || !sha256Pattern.test(String(provider?.observedRevisionSha256 ?? ""))
    || provider?.evalManifest !== "verified"
    || provider?.manifestSha256 !== manifestSha256
    || provider?.observedModelRequired !== true
    || !Array.isArray(provider?.locales)
    || provider.locales.join(",") !== "zh-CN,en-US"
    || !Array.isArray(provider?.issues)
    || provider.issues.length !== 0) {
    fail(`AAIS_RELEASE_${role.toUpperCase()}_READINESS_MISMATCH`);
  }
}

function projectReadinessProvider(provider) {
  return {
    role: provider.role,
    provider: provider.provider,
    modelFingerprint: provider.modelFingerprint,
    manifestSha256: provider.manifestSha256,
    observedRevisionSha256: provider.observedRevisionSha256,
  };
}

async function verifyLiveProbe(config, definition, fetchImpl) {
  const body = await requestJson(fetchImpl, `${config.immutableOrigin}/api/system/ai-live-probe`, {
    method: "POST",
    headers: {
      accept: "application/json",
      authorization: `Bearer ${config.probeBearer}`,
      "content-type": "application/json",
      ...createVercelProtectionBypassHeader(config),
    },
    body: JSON.stringify({ syntheticId: definition.syntheticId }),
  }, "AAIS_RELEASE_LIVE_PROBE_FAILED");
  const expectedManifest = definition.providerRole === "primary"
    ? config.manifests.primary
    : config.manifests.secondary;
  const expectedModel = definition.providerRole === "primary"
    ? "qwen3.8-max"
    : "deepseek-v4-flash";
  if (!hasExactObjectKeys(body, [
    "status", "role", "modelFingerprint", "evalManifestSha256", "latencyMs",
    "diagnosticId",
  ])
    || body.status !== "live"
    || body.role !== definition.providerRole
    || body.modelFingerprint !== createModelFingerprint(expectedModel)
    || body.evalManifestSha256 !== expectedManifest
    || typeof body.latencyMs !== "number"
    || !Number.isFinite(body.latencyMs)
    || body.latencyMs < 0
    || body.latencyMs > 30_000
    || !uuidPattern.test(String(body.diagnosticId ?? ""))) {
    fail("AAIS_RELEASE_LIVE_PROBE_MISMATCH");
  }
  return {
    syntheticId: definition.syntheticId,
    providerRole: definition.providerRole,
    agentId: definition.agentId,
    locale: definition.locale,
    diagnosticId: body.diagnosticId,
    modelFingerprint: body.modelFingerprint,
    evalManifestSha256: body.evalManifestSha256,
    latencyMs: body.latencyMs,
    evidenceSha256: sha256Canonical({
      syntheticId: definition.syntheticId,
      providerRole: definition.providerRole,
      agentId: definition.agentId,
      locale: definition.locale,
      report: body,
    }, "aais-ai-live-probe-evidence-v1"),
  };
}

async function createFreshLearnerCanarySession(config, fetchImpl) {
  const privacyUrl = `${config.immutableOrigin}/api/learning/privacy`;
  const existing = await requestJson(fetchImpl, privacyUrl, {
    method: "GET",
    headers: {
      accept: "application/json",
      cookie: config.learner.sessionCookie,
      ...createVercelProtectionBypassHeader(config),
    },
  }, "AAIS_RELEASE_LEARNER_PRIVACY_PREFLIGHT_FAILED");
  if (!isValidPrivacyExport(existing)
    || !isExpectedSyntheticActor(config, existing.studentId)
    || existing.data.session !== null
    || existing.data.events.length !== 0) {
    fail("AAIS_RELEASE_LEARNER_SESSION_NOT_CLEAN");
  }
  const created = await requestJson(
    fetchImpl,
    `${config.immutableOrigin}/api/learning/session`,
    {
      method: "POST",
      headers: {
        accept: "application/json",
        cookie: config.learner.sessionCookie,
        "x-aais-csrf": config.learner.csrfToken,
        ...createVercelProtectionBypassHeader(config),
      },
    },
    "AAIS_RELEASE_LEARNER_SESSION_CREATE_FAILED",
  );
  const session = created?.session;
  const trainingTask = Array.isArray(session?.tasks)
    ? session.tasks.find((task) => task?.taskId === "training_task_1")
    : null;
  if (created?.actor?.role !== "student"
    || !isExpectedSyntheticActor(config, session?.studentId)
    || !Number.isSafeInteger(session?.dataGeneration)
    || session.dataGeneration < 1
    || !trainingTask
    || trainingTask.phase !== "training"
    || trainingTask.status === "locked"
    || !Array.isArray(session?.guideMessages)
    || session.guideMessages.length !== 0) {
    fail("AAIS_RELEASE_LEARNER_SESSION_CREATE_MISMATCH");
  }
  return {
    dataGeneration: session.dataGeneration,
    taskId: trainingTask.taskId,
  };
}

async function deleteAndVerifyLearnerCanarySession(
  config,
  learnerSession,
  definitions,
  fetchImpl,
  requireCompleteCanaries,
) {
  const privacyUrl = `${config.immutableOrigin}/api/learning/privacy`;
  if (requireCompleteCanaries) {
    const persisted = await requestJson(
      fetchImpl,
      `${config.immutableOrigin}/api/learning/session`,
      {
        method: "GET",
        headers: {
          accept: "application/json",
          cookie: config.learner.sessionCookie,
          ...createVercelProtectionBypassHeader(config),
        },
      },
      "AAIS_RELEASE_LEARNER_SESSION_PERSISTENCE_FAILED",
    );
    if (persisted?.actor?.role !== "student"
      || persisted?.session?.dataGeneration !== learnerSession.dataGeneration
      || !hasAllLearnerCanaryMessages(persisted.session, definitions)
      || persisted.session.guideMessages.length !== definitions.length * 2) {
      fail("AAIS_RELEASE_LEARNER_SESSION_PERSISTENCE_MISMATCH");
    }
  }
  const beforeDeletion = await requestJson(fetchImpl, privacyUrl, {
    method: "GET",
    headers: {
      accept: "application/json",
      cookie: config.learner.sessionCookie,
      ...createVercelProtectionBypassHeader(config),
    },
  }, "AAIS_RELEASE_LEARNER_PRIVACY_EXPORT_FAILED");
  if (!isValidPrivacyExport(beforeDeletion)
    || !isExpectedSyntheticActor(config, beforeDeletion.studentId)
    || beforeDeletion.data.session?.dataGeneration !== learnerSession.dataGeneration) {
    fail("AAIS_RELEASE_LEARNER_PRIVACY_EXPORT_MISMATCH");
  }
  if (requireCompleteCanaries
    && (!hasAllLearnerCanaryMessages(beforeDeletion.data.session, definitions)
      || beforeDeletion.data.session.guideMessages.length !== definitions.length * 2)) {
    fail("AAIS_RELEASE_LEARNER_PRIVACY_EXPORT_MISMATCH");
  }
  const deletionBody = await requestJson(fetchImpl, privacyUrl, {
    method: "DELETE",
    headers: {
      accept: "application/json",
      cookie: config.learner.sessionCookie,
      "content-type": "application/json",
      "x-aais-csrf": config.learner.csrfToken,
      ...createVercelProtectionBypassHeader(config),
    },
    body: JSON.stringify({ dataGeneration: learnerSession.dataGeneration }),
  }, "AAIS_RELEASE_LEARNER_PRIVACY_DELETE_FAILED");
  const deletion = deletionBody?.deletion;
  if (deletion?.storageMode !== "postgres"
    || !isExpectedSyntheticActor(config, deletion?.studentId)
    || deletion?.learnerRecordDeleted !== true
    || deletion?.mirroredAnalyticsDeleted !== true
    || deletion?.persistentOutboxDeleted !== true
    || deletion?.accountRetained !== true
    || deletion?.nextGeneration !== learnerSession.dataGeneration + 1
    || deletion?.antiAbuseGuideUsage?.retained !== true
    || deletion?.antiAbuseGuideUsage?.scope !== "content-free-account-daily-aggregate"
    || deletion?.antiAbuseGuideUsage?.rawLearnerContent !== false
    || deletion?.secrets !== "redacted") {
    fail("AAIS_RELEASE_LEARNER_PRIVACY_DELETE_MISMATCH");
  }
  const afterDeletion = await requestJson(fetchImpl, privacyUrl, {
    method: "GET",
    headers: {
      accept: "application/json",
      cookie: config.learner.sessionCookie,
      ...createVercelProtectionBypassHeader(config),
    },
  }, "AAIS_RELEASE_LEARNER_PRIVACY_ABSENCE_FAILED");
  if (!isValidPrivacyExport(afterDeletion)
    || !isExpectedSyntheticActor(config, afterDeletion.studentId)
    || afterDeletion.data.session !== null
    || afterDeletion.data.events.length !== 0) {
    fail("AAIS_RELEASE_LEARNER_PRIVACY_ABSENCE_MISMATCH");
  }
  const evidence = {
    exportVerified: true,
    canaryRecordsVerified: requireCompleteCanaries,
    deletionVerified: true,
    absenceVerified: true,
    storageMode: "postgres",
    mirroredAnalyticsDeleted: true,
    persistentOutboxDeleted: true,
    accountRetained: true,
    retainedQuotaAggregate: "content-free",
    rawLearnerContentRetained: false,
    syntheticActorVerified: true,
  };
  return {
    ...evidence,
    evidenceSha256: sha256Canonical(evidence, "aais-ai-learner-privacy-evidence-v1"),
  };
}

function isValidPrivacyExport(value) {
  return value?.schemaVersion === 1
    && value?.exportScope === "learner-data"
    && isRecord(value?.data)
    && Array.isArray(value.data.events)
    && value?.privacy?.ownerScoped === true
    && value?.privacy?.includesRawLearnerText === true
    && value?.privacy?.cohortPseudonymization === "not-applied-to-owner-export"
    && value?.privacy?.secrets === "redacted"
    && value?.secrets === "redacted";
}

function isExpectedSyntheticActor(config, studentId) {
  return typeof studentId === "string"
    && studentId.length >= 3
    && studentId.length <= 128
    && sha256Canonical(studentId, "aais-ai-release-synthetic-actor-v1")
      === config.learner.actorFingerprintSha256;
}

function hasAllLearnerCanaryMessages(session, definitions) {
  if (!Array.isArray(session?.guideMessages)) return false;
  return definitions.every((definition) => {
    const user = session.guideMessages.find((message) =>
      message?.id === `user-${definition.operationId}` && message?.kind === "user"
    );
    const assistant = session.guideMessages.find((message) =>
      message?.id === `assistant-${definition.operationId}` && message?.kind === "assistant"
    );
    const delivery = assistant?.orchestration?.delivery;
    return Boolean(user
      && assistant
      && Array.isArray(assistant.turns)
      && assistant.turns.some((turn) => turn?.agentId === definition.agentId)
      && delivery?.schemaVersion === 1
      && delivery?.responseMode === "live"
      && delivery?.channel === "primary"
      && delivery?.degraded === false);
  });
}

async function verifyLearnerCanary(
  config,
  learnerSession,
  definition,
  fetchImpl,
) {
  const first = await requestLearnerGuideCanary(
    config,
    learnerSession,
    definition,
    fetchImpl,
    false,
  );
  const replay = await requestLearnerGuideCanary(
    config,
    learnerSession,
    definition,
    fetchImpl,
    true,
  );
  if (canonicalizeJson(first.delivery) !== canonicalizeJson(replay.delivery)
    || canonicalizeJson(first.budget) !== canonicalizeJson(replay.budget)
    || canonicalizeJson(first.replayContent) !== canonicalizeJson(replay.replayContent)) {
    fail("AAIS_RELEASE_LEARNER_REPLAY_MISMATCH");
  }
  const evidence = {
    canaryId: definition.canaryId,
    agentId: definition.agentId,
    locale: definition.locale,
    transport: definition.transport,
    operationId: definition.operationId,
    diagnosticId: first.delivery.diagnosticId,
    channel: first.delivery.channel,
    degraded: first.delivery.degraded,
    responseMode: "live",
    persistence: "committed",
    budgetDisposition: "charged-once",
    replayVerified: true,
  };
  return {
    ...evidence,
    evidenceSha256: sha256Canonical(evidence, "aais-ai-learner-live-canary-evidence-v1"),
  };
}

async function requestLearnerGuideCanary(
  config,
  learnerSession,
  definition,
  fetchImpl,
  replay,
) {
  const transport = definition.transport;
  const failurePrefix = `AAIS_RELEASE_LEARNER_${transport.toUpperCase()}_CANARY`;
  const response = await request(fetchImpl, `${config.immutableOrigin}/api/learning/ai-guide`, {
    method: "POST",
    headers: {
      accept: transport === "sse" ? "text/event-stream" : "application/json",
      cookie: config.learner.sessionCookie,
      "content-type": "application/json",
      "x-aais-csrf": config.learner.csrfToken,
      ...createVercelProtectionBypassHeader(config),
    },
    body: JSON.stringify({
      dataGeneration: learnerSession.dataGeneration,
      operationId: definition.operationId,
      locale: definition.locale,
      phase: "training",
      taskId: learnerSession.taskId,
      learnerInput: createLearnerCanaryPrompt(definition.agentId, definition.locale),
      workspaceState: {
        currentStep: "release-live-canary",
        helpRequestsUsed: 0,
      },
    }),
  }, `${failurePrefix}_FAILED`);
  const contentType = String(response.headers.get("content-type") ?? "").toLowerCase();
  const text = await readBoundedResponseText(response);
  try {
    if (transport === "json") {
      if (!contentType.includes("application/json")) throw new Error();
      return validateLearnerJsonCanary(
        JSON.parse(text),
        definition,
        replay,
        failurePrefix,
      );
    }
    if (!contentType.includes("text/event-stream")) throw new Error();
    return validateLearnerSseCanary(
      parseGuideSse(text),
      definition,
      replay,
      failurePrefix,
    );
  } catch (error) {
    if (error instanceof AaisAiProductionReleaseGateError) throw error;
    fail(`${failurePrefix}_INVALID`);
  }
}

function validateLearnerJsonCanary(body, definition, replay, failurePrefix) {
  const runtime = body?.orchestration?.runtime;
  const delivery = runtime?.delivery;
  const turn = Array.isArray(body?.turns) && body.turns.length === 1
    ? body.turns[0]
    : null;
  if (containsForbiddenPublicKey(body, true)
    || !hasExactObjectKeys(body, ["message", "turns", "orchestration", "budget"])
    || !hasExactObjectKeys(body.message, ["text"])
    || !hasExactObjectKeys(turn, ["agentId", "label", "content", "actions"])
    || !hasExactObjectKeys(body.orchestration, ["graph", "runtime"])
    || !hasExactObjectKeys(body.orchestration.graph, ["graphId", "topologicalOrder"])
    || !hasExactObjectKeys(runtime, ["engine", "status", "timings", "delivery"])
    || !hasExactObjectKeys(runtime?.timings, ["visibleMs", "fallback"])
    || !isValidLearnerDelivery(delivery)
    || body.orchestration.graph.graphId !== "learning-ai-guide"
    || !Array.isArray(body.orchestration.graph.topologicalOrder)
    || body.orchestration.graph.topologicalOrder.length !== 1
    || body.orchestration.graph.topologicalOrder[0] !== definition.agentId
    || runtime?.engine !== "aais-langgraph-runtime"
    || runtime?.status !== "completed"
    || typeof runtime?.timings?.visibleMs !== "number"
    || !Number.isFinite(runtime.timings.visibleMs)
    || runtime.timings.visibleMs < 0
    || runtime?.timings?.fallback !== false
    || turn?.agentId !== definition.agentId
    || typeof turn?.label !== "string"
    || !turn.label.trim()
    || typeof turn?.content !== "string"
    || !turn.content.trim()
    || !Array.isArray(turn?.actions)
    || turn.actions.some((action) => typeof action !== "string")
    || typeof body?.message?.text !== "string"
    || !body.message.text.trim()
    || !isValidGuideBudget(body?.budget)) {
    fail(`${failurePrefix}_MISMATCH`);
  }
  return {
    delivery,
    budget: body.budget,
    replayContent: {
      message: body.message,
      turns: body.turns,
      graph: body.orchestration.graph,
    },
    replay,
  };
}

function validateLearnerSseCanary(events, definition, replay, failurePrefix) {
  const parsed = events.map((entry) => ({
    event: entry.event,
    data: entry.data ? JSON.parse(entry.data) : null,
  }));
  const ackEntries = parsed.filter((entry) => entry.event === "ack");
  const deliveryEntries = parsed.filter((entry) => entry.event === "delivery");
  const terminalEntries = parsed.filter((entry) => entry.event === "done");
  const ack = ackEntries[0]?.data;
  const delivery = deliveryEntries[0]?.data;
  const done = terminalEntries[0]?.data;
  const visibleStarts = parsed.filter((entry) =>
    entry.event === "agent_start"
    && (entry.data?.agentId === "A1" || entry.data?.agentId === "A2")
  );
  const visibleDone = parsed.filter((entry) =>
    entry.event === "agent_done"
    && (entry.data?.agentId === "A1" || entry.data?.agentId === "A2")
  );
  const visibleDeltas = parsed.filter((entry) =>
    entry.event === "agent_delta"
    && (entry.data?.agentId === "A1" || entry.data?.agentId === "A2")
  );
  const middleEvents = parsed.slice(2, -2);
  if (parsed.some((entry) => containsForbiddenPublicKey(entry.data, false))
    || parsed.length < 6
    || ackEntries.length !== 1
    || deliveryEntries.length !== 1
    || terminalEntries.length !== 1
    || parsed[0]?.event !== "ack"
    || parsed[1]?.event !== "agent_start"
    || parsed.at(-2)?.event !== "delivery"
    || parsed.at(-1)?.event !== "done"
    || middleEvents.at(-1)?.event !== "agent_done"
    || middleEvents.slice(0, -1).length < 1
    || middleEvents.slice(0, -1).some((entry) => entry.event !== "agent_delta")
    || parsed.some((entry) => entry.event === "error" || entry.event === "fallback")
    || !hasExactObjectKeys(ack, [
      "status", "graphId", "operationId", "requestAttemptId", "diagnosticId", "budget",
    ])
    || !hasExactObjectKeys(parsed[1]?.data, ["agentId"])
    || middleEvents.slice(0, -1).some((entry) =>
      !hasExactObjectKeys(entry.data, ["agentId", "content"])
      || entry.data.agentId !== definition.agentId
      || typeof entry.data.content !== "string"
      || !entry.data.content
    )
    || !hasExactObjectKeys(middleEvents.at(-1)?.data, ["agentId", "status"])
    || !hasExactObjectKeys(delivery, [
      "schemaVersion", "responseMode", "channel", "degraded", "diagnosticId",
      "persisted", "budgetDisposition",
    ])
    || !hasExactObjectKeys(done, ["status", "delivery"])
    || ack?.status !== (replay ? "replayed" : "accepted")
    || ack?.graphId !== "learning-ai-guide"
    || ack?.operationId !== definition.operationId
    || !uuidPattern.test(String(ack?.requestAttemptId ?? ""))
    || ack?.diagnosticId !== delivery?.diagnosticId
    || !isValidGuideBudget(ack?.budget)
    || !isValidLearnerDelivery(delivery)
    || done?.status !== "completed"
    || canonicalizeJson(done?.delivery) !== canonicalizeJson(delivery)
    || visibleStarts.length !== 1
    || visibleStarts[0]?.data?.agentId !== definition.agentId
    || visibleDone.length !== 1
    || visibleDone[0]?.data?.agentId !== definition.agentId
    || visibleDone[0]?.data?.status !== "ok"
    || visibleDeltas.length < 1
    || visibleDeltas.some((entry) => entry.data?.agentId !== definition.agentId)
    || visibleDeltas.some((entry) => typeof entry.data?.content !== "string")) {
    fail(`${failurePrefix}_MISMATCH`);
  }
  return {
    delivery,
    budget: ack.budget,
    replayContent: {
      agentId: definition.agentId,
      content: visibleDeltas.map((entry) => entry.data.content).join(""),
    },
    replay,
  };
}

function isValidLearnerDelivery(delivery) {
  return hasExactObjectKeys(delivery, [
    "schemaVersion", "responseMode", "channel", "degraded", "diagnosticId",
    "persisted", "budgetDisposition",
  ])
    && delivery?.schemaVersion === 1
    && delivery?.responseMode === "live"
    // The independent secondary probes prove that DeepSeek can serve every
    // agent/locale pair. A learner canary is the promotion signal for the
    // normal path, so any failover here must stop rollout.
    && delivery?.channel === "primary"
    && delivery?.degraded === false
    && delivery?.persisted === true
    && delivery?.budgetDisposition === "charged-once"
    && uuidPattern.test(String(delivery?.diagnosticId ?? ""));
}

function isValidGuideBudget(budget) {
  return hasExactObjectKeys(budget, ["limit", "used", "remaining", "resetsAt"])
    && Number.isSafeInteger(budget.limit)
    && Number.isSafeInteger(budget.used)
    && Number.isSafeInteger(budget.remaining)
    && budget.limit >= 1
    && budget.used >= 0
    && budget.remaining >= 0
    && budget.used + budget.remaining === budget.limit
    && typeof budget.resetsAt === "string"
    && Number.isFinite(Date.parse(budget.resetsAt));
}

function hasExactObjectKeys(value, keys) {
  return isRecord(value)
    && Object.keys(value).length === keys.length
    && keys.every((key) => Object.hasOwn(value, key));
}

function createVercelProtectionBypassHeader(config) {
  return {
    "x-vercel-protection-bypass": config.vercel.protectionBypassSecret,
  };
}

const forbiddenPublicKeys = new Set([
  "reason",
  "message",
  "model",
  "url",
  "endpoint",
  "timeoutreason",
  "attempts",
]);

function containsForbiddenPublicKey(value, allowRootMessage, depth = 0) {
  if (Array.isArray(value)) {
    return value.some((entry) => containsForbiddenPublicKey(entry, false, depth + 1));
  }
  if (!isRecord(value)) return false;
  return Object.entries(value).some(([key, entry]) => {
    const normalizedKey = key.toLowerCase();
    if (forbiddenPublicKeys.has(normalizedKey)
      && !(allowRootMessage && depth === 0 && normalizedKey === "message")) {
      return true;
    }
    return containsForbiddenPublicKey(entry, false, depth + 1);
  });
}

function createLearnerCanaryPrompt(agentId, locale) {
  if (agentId === "A2") {
    return locale === "zh-CN"
      ? "@教授 发布验收：请示范如何确定下一步。"
      : "@Professor Release verification: model how to choose the next step.";
  }
  return locale === "zh-CN"
    ? "发布验收：请只给出下一步学习建议。"
    : "Release verification: give only the next learning step.";
}

function parseGuideSse(text) {
  return text.split(/\r?\n\r?\n/).map((chunk) => {
    const lines = chunk.split(/\r?\n/);
    const event = lines.find((line) => line.startsWith("event:"))?.slice(6).trim();
    const data = lines.filter((line) => line.startsWith("data:"))
      .map((line) => line.slice(5).trimStart())
      .join("\n");
    return { event, data };
  }).filter((entry) => entry.event);
}

async function requestJson(fetchImpl, url, init, failureCode) {
  const response = await request(fetchImpl, url, init, failureCode);
  const contentType = String(response.headers.get("content-type") ?? "").toLowerCase();
  if (!contentType.includes("application/json")) fail(failureCode);
  try {
    return JSON.parse(await readBoundedResponseText(response));
  } catch {
    fail(failureCode);
  }
}

async function request(fetchImpl, url, init, failureCode) {
  let response;
  try {
    response = await fetchImpl(url, {
      ...init,
      redirect: "manual",
      signal: AbortSignal.timeout(requestTimeoutMs),
    });
  } catch {
    fail(failureCode);
  }
  if (!response || response.status < 200 || response.status >= 300
    || (response.status >= 300 && response.status < 400)) {
    fail(failureCode);
  }
  return response;
}

async function readBoundedResponseText(response) {
  const declaredLength = Number(response.headers.get("content-length"));
  if (Number.isFinite(declaredLength) && declaredLength > maximumResponseBytes) {
    fail("AAIS_RELEASE_RESPONSE_TOO_LARGE");
  }
  const bytes = new Uint8Array(await response.arrayBuffer());
  if (bytes.byteLength > maximumResponseBytes) fail("AAIS_RELEASE_RESPONSE_TOO_LARGE");
  return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
}

function readImmutableVercelUrl(value) {
  let url;
  try {
    url = new URL(String(value ?? "").trim());
  } catch {
    fail("AAIS_RELEASE_IMMUTABLE_URL_INVALID");
  }
  if (url.protocol !== "https:"
    || url.port
    || url.username
    || url.password
    || url.pathname !== "/"
    || url.search
    || url.hash
    || !url.hostname.endsWith(".vercel.app")) {
    fail("AAIS_RELEASE_IMMUTABLE_URL_INVALID");
  }
  return url.origin;
}

function readFullGitSha(value) {
  const normalized = String(value ?? "").trim().toLowerCase();
  if (!fullShaPattern.test(normalized)) fail("AAIS_RELEASE_GIT_SHA_INVALID");
  return normalized;
}

function readSha256(value) {
  const normalized = String(value ?? "").trim().toLowerCase();
  if (!sha256Pattern.test(normalized)) fail("AAIS_RELEASE_SHA256_INVALID");
  return normalized;
}

function readIdentifier(value) {
  const normalized = String(value ?? "").trim();
  if (!safeIdentifierPattern.test(normalized)) fail("AAIS_RELEASE_IDENTIFIER_INVALID");
  return normalized;
}

function readStrongBearer(value) {
  const normalized = String(value ?? "").trim();
  if (!strongBearerPattern.test(normalized)) fail("AAIS_RELEASE_BEARER_INVALID");
  return normalized;
}

function readLearnerCsrfToken(value) {
  const normalized = String(value ?? "").trim();
  if (!csrfTokenPattern.test(normalized)) fail("AAIS_RELEASE_LEARNER_CSRF_INVALID");
  return normalized;
}

function readLearnerSessionCookie(value, csrfToken) {
  const normalized = String(value ?? "").trim();
  if (normalized.length < 32
    || normalized.length > 4096
    || /[^\x20-\x7e]/.test(normalized)
    || /[\r\n\0]/.test(normalized)) {
    fail("AAIS_RELEASE_LEARNER_SESSION_COOKIE_INVALID");
  }
  const entries = normalized.split(";").map((part) => part.trim()).filter(Boolean);
  const sessionValues = readNamedCookieValues(entries, "aais_session");
  const csrfValues = readNamedCookieValues(entries, "aais_csrf");
  if (sessionValues.length !== 1
    || csrfValues.length !== 1
    || sessionValues[0].length < 16
    || csrfValues[0] !== csrfToken) {
    fail("AAIS_RELEASE_LEARNER_SESSION_COOKIE_INVALID");
  }
  return normalized;
}

function readNamedCookieValues(entries, name) {
  return entries.filter((entry) => entry.startsWith(`${name}=`)).map((entry) => {
    try {
      return decodeURIComponent(entry.slice(name.length + 1));
    } catch {
      fail("AAIS_RELEASE_LEARNER_SESSION_COOKIE_INVALID");
    }
  });
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
    fail("AAIS_RELEASE_AUDIT_SIGNING_KEY_INVALID");
  }
}

function createModelFingerprint(model) {
  return createHash("sha256")
    .update(`aais-ai-model:${model}`)
    .digest("hex")
    .slice(0, 16);
}

function sha256Canonical(value, domain) {
  return createHash("sha256")
    .update(`${domain}:${canonicalizeJson(value)}`)
    .digest("hex");
}

function canonicalizeJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalizeJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) =>
      `${JSON.stringify(key)}:${canonicalizeJson(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

function isRecord(value) {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function fail(code) {
  throw new AaisAiProductionReleaseGateError(code);
}

async function main() {
  try {
    const result = await runAaisAiProductionReleaseGate();
    writeFileSync(
      result.receiptPath,
      `${JSON.stringify(result.receipt, null, 2)}\n`,
      { encoding: "utf8", mode: 0o600, flag: "wx" },
    );
    console.log(JSON.stringify({
      status: result.status,
      contractVersion: aaisAiExternalAuditContractVersion,
      receiptSha256: result.receiptSha256,
      probesVerified: aaisAiProductionProbeDefinitions.length,
      learnerCanariesVerified: aaisAiLearnerCanaryDefinitions.length,
      learnerReplaysVerified: aaisAiLearnerCanaryDefinitions.length,
      privacyReceiptVerified: true,
      secrets: "redacted",
    }));
  } catch (error) {
    const code = error instanceof AaisAiProductionReleaseGateError
      ? error.code
      : "AAIS_RELEASE_GATE_FAILED";
    console.error(JSON.stringify({ status: "blocked", code, secrets: "redacted" }));
    process.exitCode = 1;
  }
}

const invokedPath = process.argv[1] ? pathToFileURL(process.argv[1]).href : "";
if (import.meta.url === invokedPath) {
  await main();
}
