import { randomUUID } from "node:crypto";
import {
  aaisAgents,
  aaisCognitiveApprenticeshipBackground,
  type AaisAgentId,
  type Locale,
} from "@/data/aais";
import {
  createOpenAiCompatibleAaisProvider,
  type AaisModelProvider,
} from "@/lib/ai/aais-ai-provider";
import { isAaisGuideDeliveryError } from "@/lib/ai/aais-guide-delivery";
import {
  readAaisAiRuntimeConfig,
  type AaisAiRuntimeConfig,
  type AaisAiRuntimeProviderCandidate,
} from "@/lib/ai/aais-ai-runtime-config";
import {
  getAaisAiProductionReleaseGate,
  projectAaisAiSourceLockEligibility,
  type AaisAiReleaseGate,
} from "@/lib/server/aais-ai-release-lock";
import {
  projectAaisGuideProviderAttemptsForDiagnostic,
  recordAaisAiGuideDiagnostic,
  type AaisAiGuideDiagnosticProviderAttempt,
} from "@/lib/server/aais-ai-guide-diagnostics";

export const aaisAiLiveProbeSyntheticIds = [
  "aais-live-primary-a1-zh-v1",
  "aais-live-primary-a1-en-v1",
  "aais-live-primary-a2-zh-v1",
  "aais-live-primary-a2-en-v1",
  "aais-live-secondary-a1-zh-v1",
  "aais-live-secondary-a1-en-v1",
  "aais-live-secondary-a2-zh-v1",
  "aais-live-secondary-a2-en-v1",
] as const;
export const aaisAiLiveProbeDeadlineMs = 30_000;

export type AaisAiLiveProbeSyntheticId = typeof aaisAiLiveProbeSyntheticIds[number];
type AaisAiLiveProbeProviderRole = "primary" | "secondary";
type AaisAiLiveProbeObservedModel = "matched" | "missing" | "mismatch" | "unreported";
type AaisAiLiveProbeObservedRevision =
  | "matched"
  | "missing"
  | "mismatch"
  | "not-required"
  | "unreported";

type AaisAiLiveProbeDefinition = {
  syntheticId: AaisAiLiveProbeSyntheticId;
  providerRole: AaisAiLiveProbeProviderRole;
  agentId: "A1" | "A2";
  locale: Locale;
  learnerInput: string;
};

export type AaisAiLiveProbeReport = {
  schemaVersion: 1;
  status: "live" | "blocked";
  syntheticId: AaisAiLiveProbeSyntheticId;
  checkedAt: string;
  diagnosticId: string;
  target: {
    providerRole: AaisAiLiveProbeProviderRole;
    agentId: "A1" | "A2";
    locale: Locale;
  };
  release: {
    state: AaisAiReleaseGate["releaseState"];
    lockId: string | null;
    modelFingerprint: string | null;
    manifestSha256: string | null;
    deploymentId: string | null;
    gitCommitSha: string | null;
    configGeneration: string | null;
  };
  runtime: {
    providerStatus: "ok" | "fallback" | "failed" | "not-run";
    fallback: boolean;
    attempts: number;
    latencyMs: number;
    guardrail: "passed" | "blocked" | "not-applicable" | "not-run";
    observedModel: AaisAiLiveProbeObservedModel;
    observedRevision: AaisAiLiveProbeObservedRevision;
    providerAttempts: AaisAiGuideDiagnosticProviderAttempt[];
    failureReasons: string[];
  };
  issues: string[];
  persistence: {
    learnerSession: "not-used";
    guideQuota: "not-used";
    rawPrompt: "not-stored";
    rawOutput: "not-stored";
    auditRow: "not-written";
  };
  redaction: {
    secrets: "omitted";
    endpoints: "omitted";
    modelIds: "fingerprint-only";
    prompt: "omitted";
    response: "omitted";
    learnerIdentity: "not-applicable";
  };
};

export type AaisAiLiveProbeExecution = {
  httpStatus: 200 | 502 | 503;
  report: AaisAiLiveProbeReport;
};

/**
 * The protected HTTP route deliberately exposes only the promotion signal.
 * Detailed fixed-taxonomy diagnostics remain in the internal diagnostic sink.
 */
export type AaisAiLiveProbePublicReport = {
  status: "live" | "blocked";
  role: AaisAiLiveProbeProviderRole;
  modelFingerprint: string | null;
  evalManifestSha256: string | null;
  latencyMs: number;
  diagnosticId: string;
};

type AaisAiLiveProbeDependencies = {
  runtimeConfig?: AaisAiRuntimeConfig;
  releaseGate?: AaisAiReleaseGate;
  providerFactory?: (
    candidate: AaisAiRuntimeProviderCandidate,
    runtimeConfig: AaisAiRuntimeConfig,
  ) => AaisModelProvider;
  now?: () => Date;
  diagnosticId?: () => string;
};

const fixedProbeDefinitions = new Map<AaisAiLiveProbeSyntheticId, AaisAiLiveProbeDefinition>([
  createProbeDefinition("aais-live-primary-a1-zh-v1", "primary", "A1", "zh-CN"),
  createProbeDefinition("aais-live-primary-a1-en-v1", "primary", "A1", "en-US"),
  createProbeDefinition("aais-live-primary-a2-zh-v1", "primary", "A2", "zh-CN"),
  createProbeDefinition("aais-live-primary-a2-en-v1", "primary", "A2", "en-US"),
  createProbeDefinition("aais-live-secondary-a1-zh-v1", "secondary", "A1", "zh-CN"),
  createProbeDefinition("aais-live-secondary-a1-en-v1", "secondary", "A1", "en-US"),
  createProbeDefinition("aais-live-secondary-a2-zh-v1", "secondary", "A2", "zh-CN"),
  createProbeDefinition("aais-live-secondary-a2-en-v1", "secondary", "A2", "en-US"),
]);

const probePersistence = {
  learnerSession: "not-used",
  guideQuota: "not-used",
  rawPrompt: "not-stored",
  rawOutput: "not-stored",
  auditRow: "not-written",
} as const;

const probeRedaction = {
  secrets: "omitted",
  endpoints: "omitted",
  modelIds: "fingerprint-only",
  prompt: "omitted",
  response: "omitted",
  learnerIdentity: "not-applicable",
} as const;

export function isAaisAiLiveProbeSyntheticId(
  value: unknown,
): value is AaisAiLiveProbeSyntheticId {
  return typeof value === "string"
    && fixedProbeDefinitions.has(value as AaisAiLiveProbeSyntheticId);
}

export function projectAaisAiLiveProbePublicReport(
  report: AaisAiLiveProbeReport,
): AaisAiLiveProbePublicReport {
  return {
    status: report.status,
    role: report.target.providerRole,
    modelFingerprint: report.release.modelFingerprint,
    evalManifestSha256: report.release.manifestSha256,
    latencyMs: report.runtime.latencyMs,
    diagnosticId: report.diagnosticId,
  };
}

export async function runAaisAiLiveProbe(
  syntheticId: AaisAiLiveProbeSyntheticId,
  input: {
    signal?: AbortSignal;
    dependencies?: AaisAiLiveProbeDependencies;
  } = {},
): Promise<AaisAiLiveProbeExecution> {
  const definition = fixedProbeDefinitions.get(syntheticId);
  if (!definition) {
    throw new Error("AAIS_AI_LIVE_PROBE_ID_INVALID");
  }
  const dependencies = input.dependencies ?? {};
  const runtimeConfig = dependencies.runtimeConfig ?? readAaisAiRuntimeConfig();
  const releaseGate = dependencies.releaseGate ?? getAaisAiProductionReleaseGate();
  const now = dependencies.now ?? (() => new Date());
  const diagnosticId = (dependencies.diagnosticId ?? randomUUID)();
  const providerGate = definition.providerRole === "primary"
    ? releaseGate.providers.primary
    : releaseGate.providers.secondary;
  const candidate = definition.providerRole === "primary"
    ? runtimeConfig.primary
    : runtimeConfig.fallback;
  const sourceLockEligibility = projectAaisAiSourceLockEligibility(releaseGate);
  const roleSourceLockEligible = definition.providerRole === "primary"
    ? sourceLockEligibility.primary.eligible
    : sourceLockEligibility.fallback.eligible;
  const release = createProbeReleaseSummary({
    releaseGate,
    providerGate,
  });

  if (!roleSourceLockEligible
    || providerGate.status !== "verified"
    || !candidate) {
    const execution: AaisAiLiveProbeExecution = {
      httpStatus: 503,
      report: {
        schemaVersion: 1,
        status: "blocked",
        syntheticId,
        checkedAt: now().toISOString(),
        diagnosticId,
        target: createProbeTarget(definition),
        release,
        runtime: createNotRunRuntime(),
        issues: uniqueStrings([
          ...releaseGate.issues,
          ...providerGate.issues,
          ...(candidate ? [] : [
            definition.providerRole === "primary"
              ? "AAIS_AI_PRIMARY_CONFIGURATION"
              : "AAIS_AI_SECONDARY_CONFIGURATION",
          ]),
        ]),
        persistence: probePersistence,
        redaction: probeRedaction,
      },
    };
    recordProbeDiagnostic(execution.report);
    return execution;
  }

  const providerFactory = dependencies.providerFactory ?? createProbeProvider;
  const provider = providerFactory(candidate, runtimeConfig);
  const agent = readProbeAgent(definition.agentId);
  const startedAt = performance.now();
  try {
    const response = await provider.generate({
      agentId: definition.agentId,
      label: agent.name[definition.locale],
      role: agent.role[definition.locale],
      mission: agent.mission[definition.locale],
      voice: agent.voice
        ? {
            persona: agent.voice.persona[definition.locale],
            tone: agent.voice.tone[definition.locale],
            replyContract: agent.voice.replyContract[definition.locale],
            maxSentences: agent.voice.maxSentences,
            maxCharacters: agent.voice.maxCharacters?.[definition.locale],
            maxOutputTokens: agent.voice.maxOutputTokens,
          }
        : undefined,
      caModules: agent.caModules,
      caBackground: aaisCognitiveApprenticeshipBackground,
      locale: definition.locale,
      phase: "training",
      taskId: syntheticId,
      learnerInput: definition.learnerInput,
      workspaceState: {
        currentStep: "release-live-probe",
        helpRequestsUsed: 0,
      },
      fallbackText: definition.locale === "zh-CN"
        ? "固定探针降级响应。"
        : "Fixed probe fallback response.",
      diagnosticId,
      signal: createProbeSignal(input.signal),
    });
    const latencyMs = normalizeLatency(performance.now() - startedAt);
    const observedModel = readObservedModelStatus(response.runtime);
    const observedRevision = readObservedRevisionStatus(response.runtime);
    const providerAttempts = projectAaisGuideProviderAttemptsForDiagnostic(
      response.runtime.delivery?.attempts,
    );
    const observedModelVerified = !providerGate.observedModelRequired
      || observedModel === "matched";
    const observedRevisionVerified = !providerGate.observedRevisionSha256
      || observedRevision === "matched";
    const live = response.runtime.status === "ok"
      && response.runtime.guardrail.status === "passed"
      && observedModelVerified
      && observedRevisionVerified;
    const issues = uniqueStrings([
      ...(response.runtime.status === "fallback" ? ["AAIS_AI_LIVE_PROBE_FALLBACK"] : []),
      ...(response.runtime.guardrail.status !== "passed" ? ["AAIS_AI_LIVE_PROBE_GUARDRAIL"] : []),
      ...(!observedModelVerified ? ["AAIS_AI_LIVE_PROBE_OBSERVED_MODEL"] : []),
      ...(!observedRevisionVerified ? ["AAIS_AI_LIVE_PROBE_OBSERVED_REVISION"] : []),
    ]);
    const report: AaisAiLiveProbeReport = {
      schemaVersion: 1,
      status: live ? "live" : "blocked",
      syntheticId,
      checkedAt: now().toISOString(),
      diagnosticId,
      target: createProbeTarget(definition),
      release,
      runtime: {
        providerStatus: response.runtime.status,
        fallback: response.runtime.status === "fallback",
        attempts: normalizeAttempts(response.runtime.attempts),
        latencyMs,
        guardrail: response.runtime.guardrail.status,
        observedModel,
        observedRevision,
        providerAttempts,
        failureReasons: sanitizeFailureReasons(response.runtime.guardrail.reasons),
      },
      issues,
      persistence: probePersistence,
      redaction: probeRedaction,
    };
    recordProbeDiagnostic(report);
    return {
      httpStatus: live ? 200 : 502,
      report,
    };
  } catch (error) {
    const failure = readDeliveryFailure(error);
    const report: AaisAiLiveProbeReport = {
      schemaVersion: 1,
      status: "blocked",
      syntheticId,
      checkedAt: now().toISOString(),
      diagnosticId,
      target: createProbeTarget(definition),
      release,
      runtime: {
        providerStatus: "failed",
        fallback: false,
        attempts: failure.attempts,
        latencyMs: normalizeLatency(performance.now() - startedAt),
        guardrail: failure.guardrail,
        observedModel: failure.observedModel,
        observedRevision: failure.observedRevision,
        providerAttempts: failure.providerAttempts,
        failureReasons: failure.reasons,
      },
      issues: uniqueStrings([
        "AAIS_AI_LIVE_PROBE_PROVIDER",
        ...(["missing", "mismatch"].includes(failure.observedModel)
          ? ["AAIS_AI_LIVE_PROBE_OBSERVED_MODEL"]
          : []),
        ...(["missing", "mismatch"].includes(failure.observedRevision)
          ? ["AAIS_AI_LIVE_PROBE_OBSERVED_REVISION"]
          : []),
      ]),
      persistence: probePersistence,
      redaction: probeRedaction,
    };
    recordProbeDiagnostic(report);
    return { httpStatus: 502, report };
  }
}

function createProbeDefinition(
  syntheticId: AaisAiLiveProbeSyntheticId,
  providerRole: AaisAiLiveProbeProviderRole,
  agentId: "A1" | "A2",
  locale: Locale,
): [AaisAiLiveProbeSyntheticId, AaisAiLiveProbeDefinition] {
  const learnerInput = agentId === "A1"
    ? locale === "zh-CN"
      ? "请用一个简短问题帮助我确定解一元二次方程的下一步。"
      : "Ask one concise question that helps me choose the next step for a quadratic equation."
    : locale === "zh-CN"
      ? "请简短示范专家如何监控解一元二次方程时的理解。"
      : "Briefly model how an expert monitors understanding while solving a quadratic equation.";
  return [syntheticId, {
    syntheticId,
    providerRole,
    agentId,
    locale,
    learnerInput,
  }];
}

function createProbeProvider(
  candidate: AaisAiRuntimeProviderCandidate,
  runtimeConfig: AaisAiRuntimeConfig,
) {
  return createOpenAiCompatibleAaisProvider({
    endpoint: candidate.endpoint,
    apiKey: candidate.apiKey,
    model: candidate.model,
    provider: candidate.profile.provider,
    thinkingMode: candidate.thinkingMode,
    timeoutMs: candidate.timeoutMs,
    maxRetries: 0,
    maxTokens: candidate.maxTokens,
    runtimeProfile: runtimeConfig.profile,
    deliveryPolicy: "require-live",
    requireObservedModel: true,
    expectedObservedRevisionSha256: candidate.expectedObservedRevisionSha256,
    providerRole: candidate.providerRole,
  });
}

function readProbeAgent(agentId: AaisAgentId) {
  const agent = aaisAgents.find((candidate) => candidate.id === agentId);
  if (!agent || (agent.id !== "A1" && agent.id !== "A2")) {
    throw new Error("AAIS_AI_LIVE_PROBE_AGENT_INVALID");
  }
  return agent;
}

function createProbeTarget(definition: AaisAiLiveProbeDefinition) {
  return {
    providerRole: definition.providerRole,
    agentId: definition.agentId,
    locale: definition.locale,
  };
}

function createProbeReleaseSummary(input: {
  releaseGate: AaisAiReleaseGate;
  providerGate: AaisAiReleaseGate["providers"]["primary"];
}) {
  return {
    state: input.releaseGate.releaseState,
    lockId: input.releaseGate.lock.id,
    modelFingerprint: input.providerGate.modelFingerprint,
    manifestSha256: input.providerGate.manifestSha256,
    deploymentId: readSafeDeploymentValue(process.env.VERCEL_DEPLOYMENT_ID),
    gitCommitSha: readSafeGitCommitSha(process.env.VERCEL_GIT_COMMIT_SHA),
    configGeneration: readSafeDeploymentValue(process.env.AAIS_CONFIG_GENERATION),
  };
}

function createNotRunRuntime(): AaisAiLiveProbeReport["runtime"] {
  return {
    providerStatus: "not-run",
    fallback: false,
    attempts: 0,
    latencyMs: 0,
    guardrail: "not-run",
    observedModel: "unreported",
    observedRevision: "unreported",
    providerAttempts: [],
    failureReasons: [],
  };
}

function readObservedModelStatus(runtime: unknown): AaisAiLiveProbeObservedModel {
  const value = runtime as {
    delivery?: {
      observedModel?: unknown;
    };
  };
  const status = value.delivery?.observedModel;
  if (status === "matched") return "matched";
  if (status === "missing") return "missing";
  if (status === "mismatch") return "mismatch";
  return "unreported";
}

function readObservedRevisionStatus(runtime: unknown): AaisAiLiveProbeObservedRevision {
  const value = runtime as {
    delivery?: {
      attempts?: Array<{ outcome?: unknown; observedRevision?: unknown }>;
    };
  };
  const status = [...(value.delivery?.attempts ?? [])]
    .reverse()
    .find((attempt) => attempt.outcome === "succeeded")
    ?.observedRevision;
  if (status === "matched" || status === "missing" || status === "mismatch"
    || status === "not-required") return status;
  return "unreported";
}

function readDeliveryFailure(error: unknown) {
  if (!isAaisGuideDeliveryError(error)) {
    return {
      attempts: 0,
      guardrail: "not-applicable" as const,
      observedModel: "unreported" as const,
      observedRevision: "unreported" as const,
      providerAttempts: [] as AaisAiGuideDiagnosticProviderAttempt[],
      reasons: ["provider-error"],
    };
  }
  const reasons = sanitizeFailureReasons(
    error.attempts.flatMap((attempt) => attempt.reason ? [attempt.reason] : []),
  );
  const observedModel = error.attempts.some((attempt) => attempt.observedModel === "mismatch")
    ? "mismatch" as const
    : error.attempts.some((attempt) => attempt.observedModel === "missing")
      ? "missing" as const
      : "unreported" as const;
  const observedRevision = error.attempts.some((attempt) =>
    attempt.observedRevision === "mismatch")
    ? "mismatch" as const
    : error.attempts.some((attempt) => attempt.observedRevision === "missing")
      ? "missing" as const
      : error.attempts.some((attempt) => attempt.observedRevision === "matched")
        ? "matched" as const
        : error.attempts.some((attempt) => attempt.observedRevision === "not-required")
          ? "not-required" as const
          : "unreported" as const;
  return {
    attempts: normalizeAttempts(error.attempts.reduce(
      (total, attempt) => total + normalizeAttempts(attempt.attempts),
      0,
    )),
    guardrail: reasons.includes("guardrail-blocked")
      ? "blocked" as const
      : "not-applicable" as const,
    observedModel,
    observedRevision,
    providerAttempts: projectAaisGuideProviderAttemptsForDiagnostic(error.attempts),
    reasons: reasons.length ? reasons : ["provider-error"],
  };
}

function createProbeSignal(requestSignal: AbortSignal | undefined) {
  const deadline = AbortSignal.timeout(aaisAiLiveProbeDeadlineMs);
  return requestSignal ? AbortSignal.any([requestSignal, deadline]) : deadline;
}

function recordProbeDiagnostic(report: AaisAiLiveProbeReport) {
  const live = report.status === "live";
  const reason = live ? undefined : readProbeDiagnosticReason(report);
  recordAaisAiGuideDiagnostic({
    event: live ? "aais.ai.probe.completed" : "aais.ai.probe.failed",
    outcome: live
      ? report.target.providerRole === "primary" ? "live_primary" : "live_secondary"
      : "failed",
    category: live ? undefined : readProbeDiagnosticCategory(reason),
    reason,
    providerRole: report.target.providerRole,
    agent: report.target.agentId,
    locale: report.target.locale,
    modelFingerprint: report.release.modelFingerprint ?? undefined,
    evalManifestDigest: report.release.manifestSha256 ?? undefined,
    retryable: false,
    attempts: report.runtime.attempts,
    latencyMs: report.runtime.latencyMs,
    persistence: "not-started",
    budgetDisposition: "not-reserved",
    transport: "probe",
    route: "probe",
    providerAttempts: report.runtime.providerAttempts,
    diagnosticId: report.diagnosticId,
  });
}

function readProbeDiagnosticReason(
  report: AaisAiLiveProbeReport,
): Parameters<typeof recordAaisAiGuideDiagnostic>[0]["reason"] {
  const reason = report.runtime.failureReasons[0];
  if (reason === "observed-model-missing") return "observed_model_missing";
  if (reason === "observed-model-mismatch") return "observed_model_mismatch";
  if (reason === "observed-revision-missing") return "observed_revision_missing";
  if (reason === "observed-revision-mismatch") return "observed_revision_mismatch";
  if (reason === "abort-timeout") return "response_timeout";
  if (reason === "connect-timeout") return "connect_timeout";
  if (reason === "route-deadline") return "route_deadline";
  if (reason === "rate-limited") return "rate_limited";
  if (reason === "auth-failed" || reason === "authentication-failed") return "auth_failed";
  if (reason === "payment-required") return "payment_required";
  if (reason === "invalid-request") return "invalid_request";
  if (reason === "upstream-5xx") return "upstream_5xx";
  if (reason === "empty-response") return "empty_response";
  if (reason === "truncated-response") return "truncated_response";
  if (reason === "guardrail-blocked") return "guardrail_blocked";
  if (reason === "invalid-response") return "invalid_response";
  if (report.release.state === "RELEASE_BLOCKED") return "release_lock_blocked";
  return "network_error";
}

function readProbeDiagnosticCategory(
  reason: Parameters<typeof recordAaisAiGuideDiagnostic>[0]["reason"],
): Parameters<typeof recordAaisAiGuideDiagnostic>[0]["category"] {
  if (!reason) return "provider";
  if (reason.startsWith("eval_") || reason === "release_lock_blocked") return "evaluation";
  if (reason === "guardrail_blocked") return "guardrail";
  if (reason.includes("timeout") || reason === "route_deadline") return "deadline";
  return "provider";
}

function sanitizeFailureReasons(reasons: string[]) {
  const allowed = new Set([
    "abort-timeout",
    "auth-failed",
    "authentication-failed",
    "connect-timeout",
    "empty-response",
    "guardrail-blocked",
    "invalid-request",
    "invalid-response",
    "observed-model-mismatch",
    "observed-model-missing",
    "observed-revision-mismatch",
    "observed-revision-missing",
    "payment-required",
    "provider-error",
    "rate-limited",
    "route-deadline",
    "truncated-response",
    "upstream-4xx",
    "upstream-5xx",
  ]);
  return uniqueStrings(reasons.filter((reason) => allowed.has(reason)));
}

function readSafeDeploymentValue(value: string | undefined) {
  const normalized = String(value ?? "").trim();
  return /^[A-Za-z0-9][A-Za-z0-9._:-]{2,127}$/.test(normalized)
    ? normalized
    : null;
}

function readSafeGitCommitSha(value: string | undefined) {
  const normalized = String(value ?? "").trim().toLowerCase();
  return /^[a-f0-9]{40}$/.test(normalized) ? normalized : null;
}

function normalizeAttempts(value: number) {
  return Number.isSafeInteger(value) && value >= 0 ? Math.min(value, 8) : 0;
}

function normalizeLatency(value: number) {
  return Number.isFinite(value) && value >= 0
    ? Math.min(Math.round(value), aaisAiLiveProbeDeadlineMs)
    : 0;
}

function uniqueStrings(values: string[]) {
  return [...new Set(values)];
}
