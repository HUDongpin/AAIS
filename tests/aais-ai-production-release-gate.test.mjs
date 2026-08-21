import {
  createHash,
  generateKeyPairSync,
  verify as verifySignature,
} from "node:crypto";
import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import {
  AaisAiProductionReleaseGateError,
  aaisAiLearnerCanaryDefinitions,
  aaisAiProductionProbeDefinitions,
  createExternalAuditSigningPayload,
  createLearnerCanaryOperationId,
  readAaisAiProductionReleaseGateConfig,
  runAaisAiProductionReleaseGate,
} from "../scripts/verify-aais-ai-production-release.mjs";

const fullSha = "d".repeat(40);
const primaryManifest = "1".repeat(64);
const secondaryManifest = "2".repeat(64);
const lockId = "synthetic-approved-lock-v1";
const deploymentId = "dpl_syntheticproductionv1";
const configGeneration = "synthetic-config-v1";
const immutableOrigin = "https://aais-git-main-synthetic-team.vercel.app";
const auditNonce = "github-run-123456-attempt-1";
const csrfToken = "csrf.synthetic.release.token.with.32.characters.minimum";
const sessionToken = "synthetic-session-token-never-serialized-in-audit";
const syntheticStudentId = "synthetic-release-student";
const syntheticActorFingerprintSha256 = createHash("sha256")
  .update(`aais-ai-release-synthetic-actor-v1:${JSON.stringify(syntheticStudentId)}`)
  .digest("hex");
const protectionBypassSecret = "synthetic-vercel-protection-bypass-secret-never-serialized";
const sessionCookie = `aais_session=${encodeURIComponent(sessionToken)}; aais_csrf=${encodeURIComponent(csrfToken)}`;
const { publicKey, privateKey } = generateKeyPairSync("ed25519");
const privateKeyPkcs8 = privateKey.export({ format: "der", type: "pkcs8" }).toString("base64");
const publicKeySpki = publicKey.export({ format: "der", type: "spki" });
const publicKeySpkiBase64 = publicKeySpki.toString("base64");
const publicKeySpkiSha256 = createHash("sha256").update(publicKeySpki).digest("hex");
const learnerDefinitions = aaisAiLearnerCanaryDefinitions.map((definition) => ({
  ...definition,
  operationId: createLearnerCanaryOperationId({
    auditNonce,
    canaryId: definition.canaryId,
    configGeneration,
    deploymentId,
    gitCommitSha: fullSha,
  }),
}));

describe("AAIS external Production live-AI release gate", () => {
  it("fails before network access when any required input is absent", async () => {
    expect(() => readAaisAiProductionReleaseGateConfig({})).toThrowError(
      expect.objectContaining({ code: "AAIS_RELEASE_CONFIGURATION_MISSING" }),
    );
    await expect(runAaisAiProductionReleaseGate({ env: {} })).rejects.toMatchObject({
      code: "AAIS_RELEASE_CONFIGURATION_MISSING",
    });
  });

  it("verifies readiness, eight provider probes, eight formal learner canaries and their replays, then signs a redacted receipt", async () => {
    const env = createReleaseEnv();
    const fetchImpl = createReleaseFetch();
    const result = await runAaisAiProductionReleaseGate({
      env,
      fetchImpl,
      now: () => new Date("2026-08-21T03:00:00.000Z"),
    });

    expect(result).toMatchObject({
      status: "verified",
      receipt: {
        contractVersion: "aais-ai-external-production-audit-v1",
        lockId,
        deploymentId,
        gitCommitSha: fullSha,
        configGeneration,
        privacyEvidence: {
          exportVerified: true,
          canaryRecordsVerified: true,
          deletionVerified: true,
          absenceVerified: true,
          storageMode: "postgres",
          rawLearnerContentRetained: false,
          syntheticActorVerified: true,
          evidenceSha256: expect.stringMatching(/^[a-f0-9]{64}$/),
        },
        privacyEvidenceSha256: expect.stringMatching(/^[a-f0-9]{64}$/),
        learnerCanaryEvidenceSha256: expect.stringMatching(/^[a-f0-9]{64}$/),
        auditRun: {
          nonce: auditNonce,
          operationIdDerivation: "sha256-domain-uuid-v5-v1",
        },
        probeEvidence: expect.arrayContaining(
          aaisAiProductionProbeDefinitions.map((definition) =>
            expect.objectContaining({ syntheticId: definition.syntheticId })),
        ),
        learnerCanaryEvidence: expect.arrayContaining(
          learnerDefinitions.map((definition) =>
            expect.objectContaining({
              canaryId: definition.canaryId,
              agentId: definition.agentId,
              locale: definition.locale,
              transport: definition.transport,
              operationId: definition.operationId,
              responseMode: "live",
              persistence: "committed",
              budgetDisposition: "charged-once",
              replayVerified: true,
              evidenceSha256: expect.stringMatching(/^[a-f0-9]{64}$/),
            })),
        ),
        attestation: {
          algorithm: "ed25519",
          keyId: "synthetic-audit-key-v1",
          verifyingKeySpki: publicKeySpkiBase64,
          verifyingKeySpkiSha256: publicKeySpkiSha256,
        },
      },
      receiptSha256: expect.stringMatching(/^[a-f0-9]{64}$/),
    });
    expect(result.receipt.probeEvidence).toHaveLength(8);
    expect(result.receipt.learnerCanaryEvidence).toHaveLength(8);
    expect(fetchImpl).toHaveBeenCalledTimes(32);
    const learnerCalls = fetchImpl.mock.calls.filter(([url]) =>
      String(url) === `${immutableOrigin}/api/learning/ai-guide`
    );
    expect(learnerCalls).toHaveLength(16);
    expect(learnerCalls.every(([, init]) =>
      init.headers.cookie === sessionCookie
      && init.headers["x-aais-csrf"] === csrfToken
      && init.headers["x-vercel-protection-bypass"] === protectionBypassSecret
      && !Object.hasOwn(init.headers, "authorization")
    )).toBe(true);
    const immutableCalls = fetchImpl.mock.calls.filter(([url]) =>
      String(url).startsWith(immutableOrigin)
    );
    expect(immutableCalls).not.toHaveLength(0);
    expect(immutableCalls.every(([, init]) =>
      init.headers["x-vercel-protection-bypass"] === protectionBypassSecret
    )).toBe(true);
    const vercelApiCalls = fetchImpl.mock.calls.filter(([url]) =>
      String(url).startsWith("https://api.vercel.com/")
    );
    expect(vercelApiCalls).toHaveLength(1);
    expect(Object.hasOwn(
      vercelApiCalls[0][1].headers,
      "x-vercel-protection-bypass",
    )).toBe(false);
    expect(verifySignature(
      null,
      Buffer.from(createExternalAuditSigningPayload(result.receipt), "utf8"),
      {
        key: Buffer.from(result.receipt.attestation.verifyingKeySpki, "base64"),
        format: "der",
        type: "spki",
      },
      Buffer.from(result.receipt.attestation.signature, "base64"),
    )).toBe(true);
    expect(createHash("sha256")
      .update(Buffer.from(result.receipt.attestation.verifyingKeySpki, "base64"))
      .digest("hex"))
      .toBe(result.receipt.attestation.verifyingKeySpkiSha256);
    const serialized = JSON.stringify(result.receipt);
    expect(serialized).not.toContain(env.AAIS_RELEASE_READINESS_BEARER_TOKEN);
    expect(serialized).not.toContain(env.AAIS_RELEASE_LIVE_PROBE_BEARER_TOKEN);
    expect(serialized).not.toContain(env.AAIS_RELEASE_LEARNER_SESSION_COOKIE);
    expect(serialized).not.toContain(env.AAIS_RELEASE_LEARNER_CSRF_TOKEN);
    expect(serialized).not.toContain(env.AAIS_RELEASE_VERCEL_PROTECTION_BYPASS_SECRET);
    expect(serialized).not.toContain(env.AAIS_RELEASE_SYNTHETIC_ACTOR_FINGERPRINT_SHA256);
    expect(serialized).not.toContain(sessionToken);
    expect(serialized).not.toContain("synthetic provider answer");
    expect(serialized).not.toContain("Release verification");
    expect(serialized).not.toContain("发布验收");
  });

  it.each([
    ["readiness", { readinessMismatch: true }, "AAIS_RELEASE_READINESS_MISMATCH"],
    ["one of eight provider probes", { probeMismatch: true }, "AAIS_RELEASE_LIVE_PROBE_MISMATCH"],
    ["formal JSON learner response", { jsonCanaryMismatch: true }, "AAIS_RELEASE_LEARNER_JSON_CANARY_MISMATCH"],
    ["JSON hidden-agent turn", { jsonHiddenAgent: true }, "AAIS_RELEASE_LEARNER_JSON_CANARY_MISMATCH"],
    ["JSON internal runtime field", { jsonRuntimeLeak: true }, "AAIS_RELEASE_LEARNER_JSON_CANARY_MISMATCH"],
    ["JSON delivery receipt field", { jsonDeliveryLeak: true }, "AAIS_RELEASE_LEARNER_JSON_CANARY_MISMATCH"],
    ["formal SSE learner response", { sseCanaryMismatch: true }, "AAIS_RELEASE_LEARNER_SSE_CANARY_MISMATCH"],
    ["SSE hidden-agent event", { sseHiddenAgent: true }, "AAIS_RELEASE_LEARNER_SSE_CANARY_MISMATCH"],
    ["SSE ack internal field", { sseAckLeak: true }, "AAIS_RELEASE_LEARNER_SSE_CANARY_MISMATCH"],
    ["SSE delivery receipt field", { sseDeliveryLeak: true }, "AAIS_RELEASE_LEARNER_SSE_CANARY_MISMATCH"],
    ["SSE done internal field", { sseDoneLeak: true }, "AAIS_RELEASE_LEARNER_SSE_CANARY_MISMATCH"],
    ["learner-route secondary failover", { learnerSecondary: true }, "AAIS_RELEASE_LEARNER_JSON_CANARY_MISMATCH"],
    ["duplicate SSE terminal", { sseDuplicateDone: true }, "AAIS_RELEASE_LEARNER_SSE_CANARY_MISMATCH"],
    ["same-operation replay", { replayMismatch: true }, "AAIS_RELEASE_LEARNER_REPLAY_MISMATCH"],
    ["privacy deletion receipt", { privacyDeleteMismatch: true }, "AAIS_RELEASE_LEARNER_PRIVACY_DELETE_MISMATCH"],
  ])("fails closed on a %s mismatch", async (_label, options, code) => {
    await expect(runAaisAiProductionReleaseGate({
      env: createReleaseEnv(),
      fetchImpl: createReleaseFetch(options),
      now: () => new Date("2026-08-21T03:00:00.000Z"),
    })).rejects.toMatchObject({
      name: "AaisAiProductionReleaseGateError",
      code,
    });
  });

  it("rejects aliases, mismatched learner CSRF evidence, and invalid audit signing keys", () => {
    const alias = createReleaseEnv({
      AAIS_RELEASE_IMMUTABLE_URL: "https://www.aais.site",
    });
    expect(() => readAaisAiProductionReleaseGateConfig(alias)).toThrowError(
      expect.objectContaining({ code: "AAIS_RELEASE_IMMUTABLE_URL_INVALID" }),
    );

    const csrfMismatch = createReleaseEnv({
      AAIS_RELEASE_LEARNER_CSRF_TOKEN: `${csrfToken}.different`,
    });
    expect(() => readAaisAiProductionReleaseGateConfig(csrfMismatch)).toThrowError(
      expect.objectContaining({ code: "AAIS_RELEASE_LEARNER_SESSION_COOKIE_INVALID" }),
    );

    const invalidKey = createReleaseEnv({
      AAIS_RELEASE_AUDIT_SIGNING_KEY_PKCS8: Buffer.from("not-a-key").toString("base64"),
    });
    expect(() => readAaisAiProductionReleaseGateConfig(invalidKey)).toThrowError(
      expect.objectContaining({ code: "AAIS_RELEASE_AUDIT_SIGNING_KEY_INVALID" }),
    );

    const duplicateBypass = createReleaseEnv({
      AAIS_RELEASE_VERCEL_PROTECTION_BYPASS_SECRET:
        "readiness-bearer-token-with-at-least-32-characters",
    });
    expect(() => readAaisAiProductionReleaseGateConfig(duplicateBypass)).toThrowError(
      expect.objectContaining({ code: "AAIS_RELEASE_BEARERS_NOT_DISTINCT" }),
    );
  });

  it("rejects a non-allowlisted learner actor before any guide request or deletion", async () => {
    const fetchImpl = createReleaseFetch({ actorMismatch: true });
    await expect(runAaisAiProductionReleaseGate({
      env: createReleaseEnv(),
      fetchImpl,
      now: () => new Date("2026-08-21T03:00:00.000Z"),
    })).rejects.toMatchObject({
      code: "AAIS_RELEASE_LEARNER_SESSION_NOT_CLEAN",
    });
    expect(fetchImpl.mock.calls.some(([url]) =>
      String(url) === `${immutableOrigin}/api/learning/ai-guide`
    )).toBe(false);
    expect(fetchImpl.mock.calls.some(([url, init]) =>
      String(url) === `${immutableOrigin}/api/learning/privacy`
      && init.method === "DELETE"
    )).toBe(false);
  });

  it("keeps the workflow pinned to the canonical main repository and every required secret", () => {
    const workflow = readFileSync(
      ".github/workflows/aais-ai-production-release-gate.yml",
      "utf8",
    );
    expect(workflow).toContain('test "$GITHUB_REPOSITORY" = "HUDongpin/AAIS"');
    expect(workflow).toContain('test "$GITHUB_REF" = "refs/heads/main"');
    expect(workflow).toContain('test "$GITHUB_SHA" = "$EXPECTED_SHA"');
    expect(workflow).toContain('test "$(git rev-parse HEAD)" = "$EXPECTED_SHA"');
    expect(workflow).toContain("persist-credentials: false");
    expect(workflow).toContain(
      "AAIS_RELEASE_VERCEL_PROTECTION_BYPASS_SECRET: ${{ secrets.AAIS_RELEASE_VERCEL_PROTECTION_BYPASS_SECRET }}",
    );
    expect(workflow).toContain(
      "AAIS_RELEASE_SYNTHETIC_ACTOR_FINGERPRINT_SHA256: ${{ secrets.AAIS_RELEASE_SYNTHETIC_ACTOR_FINGERPRINT_SHA256 }}",
    );
    expect(workflow).not.toContain("git rev-parse --abbrev-ref");
  });
});

function createReleaseEnv(overrides = {}) {
  return {
    AAIS_RELEASE_IMMUTABLE_URL: immutableOrigin,
    AAIS_RELEASE_DEPLOYMENT_ID: deploymentId,
    AAIS_RELEASE_GIT_COMMIT_SHA: fullSha,
    AAIS_RELEASE_CONFIG_GENERATION: configGeneration,
    AAIS_RELEASE_EXPECTED_LOCK_ID: lockId,
    AAIS_RELEASE_PRIMARY_MANIFEST_SHA256: primaryManifest,
    AAIS_RELEASE_SECONDARY_MANIFEST_SHA256: secondaryManifest,
    AAIS_RELEASE_READINESS_BEARER_TOKEN: "readiness-bearer-token-with-at-least-32-characters",
    AAIS_RELEASE_LIVE_PROBE_BEARER_TOKEN: "probe-bearer-token-with-at-least-32-characters",
    AAIS_RELEASE_VERCEL_PROTECTION_BYPASS_SECRET: protectionBypassSecret,
    AAIS_RELEASE_LEARNER_SESSION_COOKIE: sessionCookie,
    AAIS_RELEASE_LEARNER_CSRF_TOKEN: csrfToken,
    AAIS_RELEASE_SYNTHETIC_ACTOR_FINGERPRINT_SHA256: syntheticActorFingerprintSha256,
    AAIS_RELEASE_VERCEL_API_TOKEN: "vercel-api-token-never-serialized",
    AAIS_RELEASE_VERCEL_TEAM_ID: "team_syntheticv1",
    AAIS_RELEASE_VERCEL_PROJECT_ID: "prj_syntheticv1",
    AAIS_RELEASE_AUDIT_SIGNING_KEY_ID: "synthetic-audit-key-v1",
    AAIS_RELEASE_AUDIT_SIGNING_KEY_PKCS8: privateKeyPkcs8,
    AAIS_RELEASE_AUDIT_NONCE: auditNonce,
    AAIS_RELEASE_AUDIT_RECEIPT_PATH: "/tmp/aais-synthetic-audit.json",
    ...overrides,
  };
}

function createReleaseFetch(options = {}) {
  const probeById = new Map(aaisAiProductionProbeDefinitions.map((definition) => [
    definition.syntheticId,
    definition,
  ]));
  const canaryByOperation = new Map(learnerDefinitions.map((definition, index) => [
    definition.operationId,
    { definition, index },
  ]));
  const operationCalls = new Map();
  const guideMessages = [];
  let sessionCreated = false;
  let sessionDeleted = false;
  const actorId = options.actorMismatch ? "ordinary-learner-must-not-delete" : syntheticStudentId;
  return vi.fn(async (input, init = {}) => {
    const url = String(input);
    if (url.startsWith("https://api.vercel.com/v13/deployments/")) {
      return jsonResponse({
        id: deploymentId,
        projectId: "prj_syntheticv1",
        team: { id: "team_syntheticv1" },
        url: new URL(immutableOrigin).hostname,
        readyState: "READY",
        status: "READY",
        target: "production",
        gitSource: { sha: fullSha, ref: "main" },
      });
    }
    if (url === `${immutableOrigin}/api/system/readiness`) {
      return jsonResponse(createReadinessBody(options.readinessMismatch));
    }
    if (url === `${immutableOrigin}/api/system/ai-live-probe`) {
      const request = JSON.parse(String(init.body));
      const definition = probeById.get(request.syntheticId);
      return jsonResponse(createProbeBody(definition, options.probeMismatch));
    }
    if (url === `${immutableOrigin}/api/learning/privacy` && init.method === "GET") {
      return jsonResponse(createPrivacyExport(
        sessionCreated && !sessionDeleted ? createLearnerSession(guideMessages, actorId) : null,
        actorId,
      ));
    }
    if (url === `${immutableOrigin}/api/learning/session` && init.method === "POST") {
      sessionCreated = true;
      return jsonResponse({
        session: createLearnerSession([], actorId),
        actor: { role: "student" },
      });
    }
    if (url === `${immutableOrigin}/api/learning/session` && init.method === "GET") {
      return jsonResponse({
        session: createLearnerSession(guideMessages, actorId),
        actor: { role: "student" },
      });
    }
    if (url === `${immutableOrigin}/api/learning/ai-guide`) {
      const request = JSON.parse(String(init.body));
      const canary = canaryByOperation.get(request.operationId);
      if (!canary) throw new AaisAiProductionReleaseGateError("UNEXPECTED_TEST_OPERATION");
      const previousCalls = operationCalls.get(request.operationId) ?? 0;
      operationCalls.set(request.operationId, previousCalls + 1);
      const replay = previousCalls === 1;
      if (!replay) {
        guideMessages.push(
          {
            id: `user-${request.operationId}`,
            kind: "user",
            text: request.learnerInput,
          },
          {
            id: `assistant-${request.operationId}`,
            kind: "assistant",
            text: `synthetic provider answer ${canary.definition.agentId} ${canary.definition.locale}`,
            turns: [{ agentId: canary.definition.agentId, content: "synthetic provider answer" }],
            orchestration: {
              delivery: {
                schemaVersion: 1,
                responseMode: "live",
                channel: "primary",
                degraded: false,
              },
            },
          },
        );
      }
      const mismatchedReplay = Boolean(options.replayMismatch && canary.index === 0 && replay);
      const mismatch = canary.definition.transport === "json"
        ? Boolean(options.jsonCanaryMismatch && canary.index === 0)
        : Boolean(options.sseCanaryMismatch && canary.index === 1);
      return createGuideResponse(canary.definition, canary.index, {
        replay,
        mismatch,
        mismatchedReplay,
        duplicateDone: Boolean(options.sseDuplicateDone && canary.index === 1),
        hiddenAgent: Boolean(
          (options.jsonHiddenAgent && canary.index === 0)
          || (options.sseHiddenAgent && canary.index === 1),
        ),
        jsonRuntimeLeak: Boolean(options.jsonRuntimeLeak && canary.index === 0),
        jsonDeliveryLeak: Boolean(options.jsonDeliveryLeak && canary.index === 0),
        sseAckLeak: Boolean(options.sseAckLeak && canary.index === 1),
        sseDeliveryLeak: Boolean(options.sseDeliveryLeak && canary.index === 1),
        sseDoneLeak: Boolean(options.sseDoneLeak && canary.index === 1),
        learnerSecondary: Boolean(options.learnerSecondary && canary.index === 0),
      });
    }
    if (url === `${immutableOrigin}/api/learning/privacy` && init.method === "DELETE") {
      sessionDeleted = true;
      return jsonResponse({
        deletion: {
          studentId: actorId,
          nextGeneration: 2,
          deletedAt: "2026-08-21T03:00:00.000Z",
          storageMode: "postgres",
          learnerRecordDeleted: true,
          mirroredAnalyticsDeleted: true,
          persistentOutboxDeleted: options.privacyDeleteMismatch ? false : true,
          accountRetained: true,
          antiAbuseGuideUsage: {
            retained: true,
            scope: "content-free-account-daily-aggregate",
            rawLearnerContent: false,
            quotaEffectEndsAt: "2026-08-22T00:00:00.000Z",
            cleanup: "next-quota-maintenance-after-utc-reset",
          },
          secrets: "redacted",
        },
      });
    }
    throw new AaisAiProductionReleaseGateError("UNEXPECTED_TEST_URL");
  });
}

function createReadinessBody(mismatch = false) {
  const provider = (role) => ({
    role,
    status: "verified",
    provider: role === "primary" ? "qwen" : "deepseek",
    modelFingerprint: modelFingerprint(
      role === "primary" ? "qwen3.8-max" : "deepseek-v4-flash",
    ),
    thinkingMode: "disabled",
    temperature: 0.2,
    maxTokens: 600,
    observedRevisionSha256: role === "primary" ? "6".repeat(64) : "7".repeat(64),
    evalManifest: "verified",
    manifestSha256: role === "primary" ? primaryManifest : secondaryManifest,
    observedModelRequired: true,
    locales: ["zh-CN", "en-US"],
    issues: [],
  });
  return {
    status: mismatch ? "not_ready" : "ready",
    runtime: "production",
    release: {
      deployment: {
        provider: "vercel",
        gitCommit: { fullSha },
        deploymentId,
        configGeneration,
      },
    },
    checks: {
      ai: {
        status: "ok",
        deliveryPolicy: "require-live",
        liveProbe: {
          status: "ok",
          bearerConfigured: true,
          bearerFormatValid: true,
          bearerDistinct: true,
        },
        runtimeProfile: {
          primary: { maxRetries: 0, thinkingMode: "disabled" },
          fallback: { maxRetries: 0, thinkingMode: "disabled" },
        },
        releaseGate: {
          status: "verified",
          releaseState: "RELEASE_VERIFIED",
          lock: { id: lockId, releaseStatus: "approved" },
          providers: {
            primary: provider("primary"),
            secondary: provider("secondary"),
          },
          externalAudit: {
            required: true,
            verificationStage: "external-post-deploy",
            signingKeyId: "synthetic-audit-key-v1",
            verifyingKeySpkiSha256: publicKeySpkiSha256,
            runtimeGateDependency: false,
          },
          issues: [],
        },
      },
    },
  };
}

function createProbeBody(definition, mismatch = false) {
  const manifestSha256 = definition.providerRole === "primary"
    ? primaryManifest
    : secondaryManifest;
  const diagnosticId = `71000000-0000-4000-8000-${String(
    aaisAiProductionProbeDefinitions.indexOf(definition) + 1,
  ).padStart(12, "0")}`;
  return {
    status: mismatch && definition === aaisAiProductionProbeDefinitions[0]
      ? "blocked"
      : "live",
    role: definition.providerRole,
    modelFingerprint: modelFingerprint(
      definition.providerRole === "primary" ? "qwen3.8-max" : "deepseek-v4-flash",
    ),
    evalManifestSha256: manifestSha256,
    latencyMs: 123,
    diagnosticId,
  };
}

function createGuideResponse(definition, index, options) {
  const diagnosticId = `72000000-0000-4000-8000-${String(index + 1).padStart(12, "0")}`;
  const content = options.mismatchedReplay
    ? `changed replay content ${definition.agentId}`
    : `synthetic provider answer ${definition.agentId} ${definition.locale}`;
  const delivery = {
    schemaVersion: 1,
    responseMode: options.mismatch ? "deterministic" : "live",
    channel: options.learnerSecondary ? "secondary" : "primary",
    degraded: Boolean(options.learnerSecondary),
    diagnosticId,
    persisted: true,
    budgetDisposition: "charged-once",
    ...(options.jsonDeliveryLeak || options.sseDeliveryLeak
      ? { endpoint: "https://provider.invalid/internal" }
      : {}),
  };
  const budget = {
    limit: 40,
    used: index + 1,
    remaining: 39 - index,
    resetsAt: "2026-08-22T00:00:00.000Z",
  };
  if (definition.transport === "json") {
    return jsonResponse({
      message: { text: content },
      turns: [
        {
          agentId: definition.agentId,
          label: definition.agentId === "A1" ? "小张" : "Professor",
          content,
          actions: [],
        },
        ...(options.hiddenAgent
          ? [{ agentId: "A3", label: "监督智能体", content: "hidden", actions: [] }]
          : []),
      ],
      orchestration: {
        graph: { graphId: "learning-ai-guide", topologicalOrder: [definition.agentId] },
        runtime: {
          engine: "aais-langgraph-runtime",
          status: "completed",
          timings: {
            visibleMs: 1,
            fallback: false,
            ...(options.jsonRuntimeLeak ? { attempts: options.replay ? 0 : 1 } : {}),
          },
          delivery,
        },
      },
      budget,
    });
  }
  const events = [
    ["ack", {
      status: options.replay ? "replayed" : "accepted",
      graphId: "learning-ai-guide",
      operationId: definition.operationId,
      requestAttemptId: `73000000-0000-4000-8000-${String(index + 1).padStart(12, "0")}`,
      diagnosticId,
      budget,
      ...(options.sseAckLeak ? { reason: "internal" } : {}),
    }],
    ["agent_start", { agentId: definition.agentId }],
    ["agent_delta", { agentId: definition.agentId, content }],
    ...(options.hiddenAgent
      ? [["agent_delta", { agentId: "A4", content: "hidden" }]]
      : []),
    ["agent_done", { agentId: definition.agentId, status: "ok" }],
    ...(options.mismatch ? [["fallback", { timeoutReason: "abort-timeout" }]] : []),
    ["delivery", delivery],
    ["done", {
      status: "completed",
      delivery,
      ...(options.sseDoneLeak ? { message: "internal" } : {}),
    }],
    ...(options.duplicateDone ? [["done", { status: "completed", delivery }]] : []),
  ];
  return new Response(events.map(([event, data]) =>
    `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`).join(""), {
    status: 200,
    headers: { "content-type": "text/event-stream;charset=utf-8" },
  });
}

function createLearnerSession(guideMessages, studentId = syntheticStudentId) {
  return {
    sessionId: "session-synthetic-release",
    studentId,
    dataGeneration: 1,
    activeStage: "training",
    activeTaskId: "training_task_1",
    tasks: [{
      taskId: "training_task_1",
      phase: "training",
      status: "active",
      scaffoldHistory: [],
    }],
    guideMessages: [...guideMessages],
    events: [],
    truncation: {
      guideMessages: {
        total: guideMessages.length,
        returned: guideMessages.length,
        truncated: false,
      },
    },
  };
}

function createPrivacyExport(session, studentId = syntheticStudentId) {
  return {
    schemaVersion: 1,
    exportScope: "learner-data",
    generatedAt: "2026-08-21T03:00:00.000Z",
    studentId,
    data: {
      session,
      events: session?.events ?? [],
    },
    privacy: {
      ownerScoped: true,
      includesRawLearnerText: true,
      cohortPseudonymization: "not-applied-to-owner-export",
      secrets: "redacted",
    },
    secrets: "redacted",
  };
}

function jsonResponse(value) {
  return Response.json(value, {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

function modelFingerprint(model) {
  return createHash("sha256")
    .update(`aais-ai-model:${model}`)
    .digest("hex")
    .slice(0, 16);
}
