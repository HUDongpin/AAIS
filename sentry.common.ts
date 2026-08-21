import type { ErrorEvent, SeverityLevel } from "@sentry/nextjs";

type AaisSentryInitOptions = Parameters<typeof import("@sentry/nextjs").init>[0];
type AaisSentrySpan = Parameters<
  NonNullable<AaisSentryInitOptions["beforeSendSpan"]>
>[0];
type AaisSentryTransaction = Parameters<
  NonNullable<AaisSentryInitOptions["beforeSendTransaction"]>
>[0];

const sensitiveKeySegments = new Set([
  "address",
  "actor",
  "attachment",
  "authorization",
  "body",
  "content",
  "cookie",
  "credential",
  "email",
  "endpoint",
  "error",
  "exception",
  "header",
  "headers",
  "host",
  "hostname",
  "identity",
  "input",
  "learner",
  "message",
  "model",
  "name",
  "output",
  "password",
  "payload",
  "prompt",
  "report",
  "request",
  "response",
  "secret",
  "session",
  "text",
  "thread",
  "token",
]);
const safeStructuredKeys = new Set([
  "aaisaimodelfingerprint",
  "diagnosticid",
  "endpointfingerprint",
  "evalmanifestdigest",
  "manifestsha256",
  "modelfingerprint",
  "observedrevisionsha256",
  "operationid",
  "requestattemptid",
  "responsemode",
]);
const safeSentryExtraKeys = new Map([
  "schemaVersion",
  "event",
  "releaseSha",
  "deploymentId",
  "environment",
  "configGeneration",
  "route",
  "outcome",
  "category",
  "reason",
  "providerRole",
  "agent",
  "locale",
  "modelFingerprint",
  "evalManifestDigest",
  "retryable",
  "attempts",
  "latencyMs",
  "latencyBucket",
  "persistence",
  "budgetDisposition",
  "transport",
  "providerAttempts",
  "diagnosticId",
  "operationId",
  "requestAttemptId",
  "redaction",
  "secrets",
  "status",
  "code",
  "causeKind",
  "action",
  "authMode",
  "claimed",
  "selected",
  "sent",
  "confirmed",
  "retried",
  "retry",
  "failed",
  "deadLetter",
  "stale",
  "deferred",
  "hasMore",
  "stoppedReason",
  "blockedActiveVisitCount",
  "staleRawTextWriteLeaseCount",
  "limit",
  "url",
  "callback_url",
].map((key) => [compactSentryKey(key), key] as const));
const safeSentryTagKeys = new Set([
  "aais.event",
  "aais.route",
  "aais.error_code",
  "aais.cause_kind",
  "aais.outbox_action",
  "aais.outbox_status",
  "aais.auth_mode",
  "aais.research_lrs_action",
  "aais.ai.outcome",
  "aais.ai.category",
  "aais.ai.reason",
  "aais.ai.provider_role",
  "aais.ai.agent",
  "aais.ai.locale",
  "aais.ai.model_fingerprint",
  "aais.ai.latency_bucket",
]);
const safeSentrySpanDataKeys = new Set([
  "aais.route",
  "http.method",
  "http.request.method",
  "http.response.status_code",
  "http.route",
  "http.status_code",
  "http.target",
  "http.url",
  "url.full",
  "url.path",
  "url.query",
]);
const safeSentrySpanKeys = new Set([
  "data",
  "description",
  "op",
  "origin",
  "parent_span_id",
  "sampled",
  "span_id",
  "start_timestamp",
  "status",
  "timestamp",
  "trace_id",
]);
const safeSentryEventKeys = new Set([
  "breadcrumbs",
  "contexts",
  "dist",
  "environment",
  "event_id",
  "exception",
  "extra",
  "level",
  "logentry",
  "message",
  "platform",
  "release",
  "request",
  "sdk",
  "spans",
  "start_timestamp",
  "tags",
  "threads",
  "timestamp",
  "transaction",
  "transaction_info",
  "type",
]);
const safeSentryExceptionKeys = new Set(["mechanism", "stacktrace", "type", "value"]);
const safeSentryThreadKeys = new Set(["crashed", "current", "id", "stacktrace"]);
const safeAaisAiDiagnosticReasons = new Set([
  "live_disabled",
  "config_missing",
  "config_invalid",
  "endpoint_not_allowed",
  "eval_missing",
  "eval_mismatch",
  "eval_invalid",
  "eval_expired",
  "release_lock_blocked",
  "observed_model_mismatch",
  "observed_model_missing",
  "observed_revision_mismatch",
  "observed_revision_missing",
  "connect_timeout",
  "response_timeout",
  "rate_limited",
  "auth_failed",
  "payment_required",
  "invalid_request",
  "upstream_5xx",
  "network_error",
  "empty_response",
  "truncated_response",
  "invalid_response",
  "guardrail_blocked",
  "chain_exhausted",
  "route_deadline",
  "orchestration_error",
  "persistence_failed",
  "client_disconnect",
  "stream_interrupted",
  "replay",
  "payload_conflict",
  "dispatched_uncertain",
  "none",
]);
const urlKeyPattern = /(?:^|[._-])(?:url|uri|href|target|route|path)(?:$|[._-])/i;
const queryStringKeyPattern = /(?:^|[._-])(?:query|query_string|search)(?:$|[._-])/i;
const oneTimeTokenInTextPattern = /([?&#](?:invite_token|reset_token|code|state|session_state|nonce)=)[^&#\s]*/gi;
const safeAaisSentryInboundRoutes = new Set([
  "/",
  "/admin/users",
  "/api/auth/app-session",
  "/api/auth/email-outbox/flush",
  "/api/auth/email-outbox/reconcile",
  "/api/auth/oidc/callback",
  "/api/auth/oidc/start",
  "/api/auth/password",
  "/api/auth/users",
  "/api/learning/ai-guide",
  "/api/learning/analytics",
  "/api/learning/export",
  "/api/learning/lrs/health",
  "/api/learning/lrs/outbox/flush",
  "/api/learning/lrs/outbox/reconcile",
  "/api/learning/privacy",
  "/api/learning/recommendations",
  "/api/learning/scaffold",
  "/api/learning/session",
  "/api/research/events",
  "/api/research/events/export",
  "/api/research/lrs/flush",
  "/api/research/retention",
  "/api/research/visit",
  "/api/research/visit/complete",
  "/api/research/withdrawal",
  "/api/system/ai-live-probe",
  "/api/system/readiness",
  "/dashboard",
  "/learning",
  "/login",
  "/privacy",
  "/terms",
]);

export function getAaisSentryDsn() {
  return process.env.SENTRY_DSN ?? process.env.NEXT_PUBLIC_SENTRY_DSN;
}

export function getAaisSentryEnvironment() {
  return process.env.VERCEL_ENV ?? process.env.NODE_ENV ?? "development";
}

export function getAaisSentryRelease() {
  return process.env.SENTRY_RELEASE
    ?? process.env.VERCEL_GIT_COMMIT_SHA
    ?? process.env.NEXT_PUBLIC_VERCEL_GIT_COMMIT_SHA;
}

export function getAaisSentrySampleRate(value: string | undefined, fallback: number) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    return fallback;
  }
  return Math.min(1, Math.max(0, parsed));
}

export function sanitizeAaisSentryEvent(event: ErrorEvent) {
  return sanitizeAaisSentryBaseEvent(event);
}

export function sanitizeAaisSentryTransaction(event: AaisSentryTransaction) {
  return sanitizeAaisSentryBaseEvent(event);
}

export function sanitizeAaisSentrySpan(span: AaisSentrySpan) {
  retainAllowedSentryKeys(span as unknown as Record<string, unknown>, safeSentrySpanKeys);
  if (span.description) {
    span.description = sanitizeSentrySpanDescription(span.description);
  }
  span.data = Object.fromEntries(
    Object.entries(span.data)
      .filter(([key]) => safeSentrySpanDataKeys.has(key))
      .map(([key, value]) => [
        key,
        sanitizeSentryKeyedValue(key, value),
      ]),
  ) as AaisSentrySpan["data"];
  return span;
}

function sanitizeAaisSentryBaseEvent<T extends ErrorEvent | AaisSentryTransaction>(event: T): T {
  retainAllowedSentryKeys(event as unknown as Record<string, unknown>, safeSentryEventKeys);
  delete event.user;
  delete event.fingerprint;
  delete event.server_name;
  delete event.logger;
  delete event.debug_meta;
  event.contexts = sanitizeAaisSentryContexts(event.contexts);
  if (event.message) {
    event.message = sanitizeSentryEventMessage(event.message);
  }
  if (event.transaction) {
    event.transaction = sanitizeSentryTransactionName(event.transaction);
  }
  event.exception?.values?.forEach((exception) => {
    retainAllowedSentryKeys(
      exception as unknown as Record<string, unknown>,
      safeSentryExceptionKeys,
    );
    if (exception.type) exception.type = "redacted";
    delete exception.module;
    if (exception.mechanism) {
      exception.mechanism = {
        type: "generic",
        ...(typeof exception.mechanism.handled === "boolean"
          ? { handled: exception.mechanism.handled }
          : {}),
      };
    }
    if (exception.value) {
      // Exception text is an uncontrolled error channel and may contain a
      // provider body, learner input, credentials, or a full outbound URL.
      exception.value = "redacted";
    }
    if (exception.stacktrace?.frames) {
      exception.stacktrace = {
        frames: exception.stacktrace.frames.map(projectSentryStackFrame),
      };
    }
  });
  event.threads?.values?.forEach((thread) => {
    retainAllowedSentryKeys(
      thread as unknown as Record<string, unknown>,
      safeSentryThreadKeys,
    );
    if (typeof thread.id !== "number") delete thread.id;
    if (thread.stacktrace?.frames) {
      thread.stacktrace = {
        frames: thread.stacktrace.frames.map(projectSentryStackFrame),
      };
    }
  });
  if (event.logentry) {
    retainAllowedSentryKeys(
      event.logentry as unknown as Record<string, unknown>,
      new Set(["message"]),
    );
    event.logentry.message = event.logentry.message
      ? sanitizeSentryEventMessage(event.logentry.message)
      : "redacted";
    delete event.logentry.params;
  }
  if (event.request) {
    const request = event.request;
    event.request = {
      ...(typeof request.method === "string"
        && /^(?:GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS)$/i.test(request.method)
        ? { method: request.method.toUpperCase() }
        : {}),
      ...(typeof request.url === "string"
        ? { url: sanitizeSentryUrl(request.url) }
        : {}),
    };
  }
  event.breadcrumbs = event.breadcrumbs?.map((breadcrumb) => ({
    ...(typeof breadcrumb.timestamp === "number" ? { timestamp: breadcrumb.timestamp } : {}),
    ...(typeof breadcrumb.type === "string"
      ? { type: sanitizeSentryBreadcrumbType(breadcrumb.type) }
      : {}),
    ...(breadcrumb.category
      ? { category: sanitizeSentryCategory(breadcrumb.category) }
      : {}),
    ...(breadcrumb.message
      ? { message: sanitizeSentryEventMessage(breadcrumb.message) }
      : {}),
    ...(breadcrumb.level && ["fatal", "error", "warning", "log", "info", "debug"]
      .includes(breadcrumb.level)
      ? { level: breadcrumb.level }
      : {}),
    ...(breadcrumb.data
      ? { data: sanitizeAaisSentryExtra(breadcrumb.data) }
      : {}),
  }));
  event.tags = event.tags
    ? Object.fromEntries(
        Object.entries(event.tags)
          .filter(([key]) => safeSentryTagKeys.has(key))
          .map(([key, value]) => [
            key,
            sanitizeSentryKeyedValue(key, String(value)),
          ]),
      ) as NonNullable<typeof event.tags>
    : event.tags;
  event.extra = sanitizeAaisSentryExtra(event.extra);
  event.spans = event.spans?.map(sanitizeAaisSentrySpan);
  return event;
}

export function sanitizeAaisSentryExtra(extra: ErrorEvent["extra"]) {
  if (!extra) {
    return {
      secrets: "redacted",
    };
  }
  return {
    ...Object.fromEntries(
      Object.entries(extra).flatMap(([key, value]) => {
        const projectedKey = safeSentryExtraKeys.get(compactSentryKey(key));
        return projectedKey
          ? [[projectedKey, sanitizeSentryKeyedValue(projectedKey, value)] as const]
          : [];
      }),
    ),
    secrets: "redacted",
  };
}

export function toAaisSentryLevel(status: number): SeverityLevel {
  if (status >= 500) {
    return "error";
  }
  if (status >= 400) {
    return "warning";
  }
  return "info";
}

function sanitizeSentryValue(value: unknown): unknown {
  if (value === null || typeof value === "number" || typeof value === "boolean") {
    return value;
  }
  if (typeof value === "string") {
    return "redacted";
  }
  if (Array.isArray(value) || typeof value === "object") return "redacted";
  return typeof value;
}

function sanitizeSentryUrl(value: string) {
  try {
    const isAbsolute = /^[A-Za-z][A-Za-z\d+.-]*:/.test(value);
    const url = new URL(value, "https://aais.invalid");
    url.username = "";
    url.password = "";
    url.search = "";
    url.hash = "";
    // Generic span/extra/breadcrumb URLs are not known to be inbound AAIS
    // routes. Omitting every absolute origin prevents provider endpoints,
    // signed asset URLs, and identity-provider paths from reaching Sentry.
    if (isAbsolute) {
      return "[external-endpoint-omitted]";
    }
    if (url.pathname.startsWith("/_next/")) {
      return "/_next/*";
    }
    return safeAaisSentryInboundRoutes.has(url.pathname)
      ? url.pathname
      : "[external-endpoint-omitted]";
  } catch {
    return "[external-endpoint-omitted]";
  }
}

function sanitizeSensitiveString(value: string) {
  return value.replace(oneTimeTokenInTextPattern, "$1redacted");
}

function sanitizeSentryEventMessage(value: string) {
  const sanitized = sanitizeSensitiveString(value);
  return /^(?:aais(?:\.[a-z0-9_-]+)+|AAIS_[A-Z0-9_]+)$/i.test(sanitized)
    ? sanitized
    : "redacted";
}

function sanitizeSentryCategory(value: string) {
  return /^(?:aais(?:\.[a-z0-9_-]+)+|navigation|http|fetch|xhr|console|ui\.(?:click|input|submit))$/.test(value)
    ? value
    : "redacted";
}

function sanitizeSentryBreadcrumbType(value: string) {
  return ["default", "debug", "error", "http", "info", "navigation", "query", "ui", "user"]
    .includes(value)
    ? value
    : "default";
}

function sanitizeSentrySpanDescription(value: string) {
  const trimmed = value.trim();
  if (trimmed.startsWith("/")) {
    return sanitizeSentryUrl(trimmed);
  }
  const methodRoute = /^(GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS)\s+(\/\S*)$/i.exec(trimmed);
  if (methodRoute) {
    return `${methodRoute[1]!.toUpperCase()} ${sanitizeSentryUrl(methodRoute[2]!)}`;
  }
  return "[span-description-omitted]";
}

function sanitizeSentryTransactionName(value: string) {
  const trimmed = value.trim();
  if (trimmed.startsWith("/") && !/\s/.test(trimmed)) {
    const route = sanitizeSentryUrl(trimmed);
    return route === "[external-endpoint-omitted]"
      ? "[transaction-omitted]"
      : route;
  }
  const methodRoute = /^(GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS)\s+(\/\S*)$/i.exec(trimmed);
  if (methodRoute) {
    const route = sanitizeSentryUrl(methodRoute[2]!);
    return route === "[external-endpoint-omitted]"
      ? "[transaction-omitted]"
      : `${methodRoute[1]!.toUpperCase()} ${route}`;
  }
  return "[transaction-omitted]";
}

function sanitizeSentryKeyedValue(key: string, value: unknown): unknown {
  if (compactSentryKey(key) === "providerattempts") {
    return sanitizeSentryProviderAttempts(value);
  }
  const structuredValue = sanitizeSafeStructuredValue(key, value);
  if (structuredValue.handled) {
    return structuredValue.value;
  }
  if (isSensitiveSentryKey(key)) {
    return "redacted";
  }
  if (typeof value === "string" && queryStringKeyPattern.test(key)) {
    return sanitizeSentryQueryString(value);
  }
  if (typeof value === "string" && urlKeyPattern.test(key)) {
    return sanitizeSentryUrl(value);
  }
  if (typeof value === "string") {
    return sanitizeKnownOperationalString(key, value);
  }
  if (Array.isArray(value)) return "redacted";
  return sanitizeSentryValue(value);
}

function sanitizeSentryQueryString(value: string) {
  void value;
  return "";
}

function isSensitiveSentryKey(key: string) {
  const segments = key
    .replace(/([a-z0-9])([A-Z])/g, "$1.$2")
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
  return segments.some((segment) => sensitiveKeySegments.has(segment));
}

function sanitizeSafeStructuredValue(key: string, value: unknown) {
  const compact = compactSentryKey(key);
  if (!safeStructuredKeys.has(compact)) {
    return { handled: false as const };
  }
  if (value === null || value === undefined) {
    return { handled: true as const, value: null };
  }
  const normalized = String(value);
  if (compact === "diagnosticid"
    || compact === "operationid"
    || compact === "requestattemptid") {
    return {
      handled: true as const,
      value: /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(normalized)
        ? normalized.toLowerCase()
        : "redacted",
    };
  }
  if (compact === "responsemode") {
    return {
      handled: true as const,
      value: normalized === "live" || normalized === "deterministic"
        ? normalized
        : "redacted",
    };
  }
  return {
    handled: true as const,
    value: /^(?:sha256:)?[a-f0-9]{12,64}$/i.test(normalized)
      ? normalized.toLowerCase()
      : "redacted",
  };
}

function sanitizeKnownOperationalString(key: string, value: string) {
  const segments = key
    .replace(/([a-z0-9])([A-Z])/g, "$1.$2")
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
  const field = segments.at(-1) ?? "";
  if (field === "route") {
    const route = sanitizeSentryUrl(value);
    return route === "[external-endpoint-omitted]" ? "redacted" : route;
  }
  if (field === "event") {
    return /^aais(?:\.[a-z0-9_-]+)+$/.test(value) ? value : "redacted";
  }
  if (field === "environment") {
    return ["production", "preview", "development", "test", "unknown"].includes(value)
      ? value
      : "redacted";
  }
  if (field === "outcome") {
    return [
      "live_primary", "live_secondary", "failed", "replayed", "uncertain",
      "succeeded", "blocked",
    ].includes(value) ? value : "redacted";
  }
  if (field === "category") {
    return [
      "configuration", "evaluation", "provider", "guardrail", "deadline",
      "orchestration", "persistence", "transport", "idempotency",
    ].includes(value) ? value : "redacted";
  }
  if (field === "causekind") {
    return ["error", "type_error", "abort_error", "non_error"].includes(value)
      ? value
      : "redacted";
  }
  if (field === "code" || field === "errorcode") {
    return /^AAIS_[A-Z0-9_]{1,120}$/.test(value) ? value : "redacted";
  }
  if (field === "providerrole" || field === "role") {
    return ["primary", "secondary", "none"].includes(value) ? value : "redacted";
  }
  if (field === "agent") {
    return ["A1", "A2", "none"].includes(value) ? value : "redacted";
  }
  if (field === "locale") {
    return ["zh-CN", "en-US", "none"].includes(value) ? value : "redacted";
  }
  if (field === "latencybucket") {
    return ["lt_1s", "1s_5s", "5s_10s", "10s_20s", "20s_30s", "gt_30s"]
      .includes(value) ? value : "redacted";
  }
  if (field === "persistence") {
    return ["not-started", "committed", "failed", "unknown"].includes(value)
      ? value
      : "redacted";
  }
  if (field === "budgetdisposition") {
    return ["not-reserved", "released", "charged-once", "dispatched-uncertain"]
      .includes(value) ? value : "redacted";
  }
  if (field === "transport") {
    return ["json", "sse", "probe"].includes(value) ? value : "redacted";
  }
  if (field === "observedmodel") {
    return ["matched", "missing", "mismatch", "not-reported"].includes(value)
      ? value
      : "redacted";
  }
  if (field === "observedrevision") {
    return ["matched", "missing", "mismatch", "not-required", "not-reported"]
      .includes(value) ? value : "redacted";
  }
  if (field === "reason") {
    return safeAaisAiDiagnosticReasons.has(value) ? value : "redacted";
  }
  if (field === "releasesha") {
    return /^[a-f0-9]{40}$/.test(value) ? value : "redacted";
  }
  if (field === "deploymentid" || field === "configgeneration") {
    return /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(value)
      ? value
      : "redacted";
  }
  return "redacted";
}

function compactSentryKey(key: string) {
  return key.replace(/[^A-Za-z0-9]/g, "").toLowerCase();
}

function sanitizeAaisSentryContexts(contexts: ErrorEvent["contexts"]) {
  if (!contexts) return undefined;
  const aais = contexts.aais && typeof contexts.aais === "object"
    ? sanitizeAaisSentryExtra(contexts.aais)
    : null;
  const trace = sanitizeSentryTraceContext(contexts.trace);
  if (!aais && !trace) return undefined;
  return {
    ...(aais ? { aais } : {}),
    ...(trace ? { trace } : {}),
  } as ErrorEvent["contexts"];
}

function sanitizeSentryTraceContext(value: unknown) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const trace = value as Record<string, unknown>;
  const traceId = typeof trace.trace_id === "string" && /^[a-f0-9]{32}$/i.test(trace.trace_id)
    ? trace.trace_id.toLowerCase()
    : null;
  const spanId = typeof trace.span_id === "string" && /^[a-f0-9]{16}$/i.test(trace.span_id)
    ? trace.span_id.toLowerCase()
    : null;
  if (!traceId || !spanId) return null;
  return {
    trace_id: traceId,
    span_id: spanId,
    ...(typeof trace.parent_span_id === "string" && /^[a-f0-9]{16}$/i.test(trace.parent_span_id)
      ? { parent_span_id: trace.parent_span_id.toLowerCase() }
      : {}),
    ...(typeof trace.op === "string" && /^[a-z][a-z0-9_.-]{0,63}$/i.test(trace.op)
      ? { op: trace.op }
      : {}),
    ...(typeof trace.status === "string" && /^[a-z_]{2,32}$/.test(trace.status)
      ? { status: trace.status }
      : {}),
  };
}

function projectSentryStackFrame(frame: {
  filename?: string;
  lineno?: number;
  colno?: number;
  in_app?: boolean;
}) {
  return {
    ...(typeof frame.filename === "string" ? { filename: "[source-omitted]" } : {}),
    ...(Number.isSafeInteger(frame.lineno) && Number(frame.lineno) >= 0
      ? { lineno: Number(frame.lineno) }
      : {}),
    ...(Number.isSafeInteger(frame.colno) && Number(frame.colno) >= 0
      ? { colno: Number(frame.colno) }
      : {}),
    ...(typeof frame.in_app === "boolean" ? { in_app: frame.in_app } : {}),
  };
}

function sanitizeSentryProviderAttempts(value: unknown) {
  if (!Array.isArray(value)) return "redacted";
  return value.slice(0, 2).flatMap((candidate) => {
    if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) return [];
    const attempt = candidate as Record<string, unknown>;
    const role = attempt.role === "primary" || attempt.role === "secondary"
      ? attempt.role
      : null;
    const outcome = attempt.outcome === "failed"
      || attempt.outcome === "blocked"
      || attempt.outcome === "succeeded"
      ? attempt.outcome
      : null;
    if (!role || !outcome) return [];
    return [{
      role,
      outcome,
      reason: typeof attempt.reason === "string" && safeAaisAiDiagnosticReasons.has(attempt.reason)
        ? attempt.reason
        : null,
      attempts: Number.isSafeInteger(attempt.attempts) && Number(attempt.attempts) >= 0
        ? Math.min(Number(attempt.attempts), 100)
        : 0,
      modelFingerprint: sanitizeSafeStructuredValue(
        "modelFingerprint",
        attempt.modelFingerprint,
      ).value,
      observedModel: ["matched", "missing", "mismatch", "not-reported"]
        .includes(String(attempt.observedModel))
        ? String(attempt.observedModel)
        : "not-reported",
      observedRevision: ["matched", "missing", "mismatch", "not-required", "not-reported"]
        .includes(String(attempt.observedRevision))
        ? String(attempt.observedRevision)
        : "not-reported",
      observedRevisionSha256: sanitizeSafeStructuredValue(
        "observedRevisionSha256",
        attempt.observedRevisionSha256,
      ).value,
    }];
  });
}

function retainAllowedSentryKeys(
  value: Record<string, unknown>,
  allowedKeys: ReadonlySet<string>,
) {
  for (const key of Object.keys(value)) {
    if (!allowedKeys.has(key)) delete value[key];
  }
}
