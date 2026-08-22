import type { ErrorEvent, SeverityLevel } from "@sentry/nextjs";

type AaisSentryInitOptions = Parameters<typeof import("@sentry/nextjs").init>[0];
type AaisSentrySpan = Parameters<
  NonNullable<AaisSentryInitOptions["beforeSendSpan"]>
>[0];
type AaisSentryTransaction = Parameters<
  NonNullable<AaisSentryInitOptions["beforeSendTransaction"]>
>[0];

const sensitiveKeyPattern = /(authorization|cookie|password|secret|token|credential|artifact|prompt|message|report|text|email)/i;
const urlKeyPattern = /(?:^|[._-])(?:url|uri|href|target)(?:$|[._-])/i;
const queryStringKeyPattern = /(?:^|[._-])(?:query|query_string|search)(?:$|[._-])/i;
const sensitiveUrlQueryKeyPattern = /^(?:code|state|session_state|nonce)$/i;
const oneTimeTokenInTextPattern = /([?&#](?:invite_token|reset_token|code|state|session_state|nonce)=)[^&#\s]*/gi;

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
  if (span.description) {
    span.description = sanitizePotentialUrlString(span.description);
  }
  span.data = Object.fromEntries(
    Object.entries(span.data).map(([key, value]) => [
      key,
      sanitizeSentryKeyedValue(key, value),
    ]),
  ) as AaisSentrySpan["data"];
  return span;
}

function sanitizeAaisSentryBaseEvent<T extends ErrorEvent | AaisSentryTransaction>(event: T): T {
  delete event.user;
  if (event.message) {
    event.message = sanitizeSensitiveString(event.message);
  }
  if (event.transaction) {
    event.transaction = sanitizePotentialUrlString(event.transaction);
  }
  event.exception?.values?.forEach((exception) => {
    if (exception.value) {
      exception.value = sanitizeSensitiveString(exception.value);
    }
  });
  if (event.request) {
    delete event.request.cookies;
    delete event.request.data;
    delete event.request.headers;
    delete event.request.query_string;
    if (event.request.url) {
      event.request.url = sanitizeSentryUrl(event.request.url);
    }
  }
  event.breadcrumbs = event.breadcrumbs?.map((breadcrumb) => ({
    ...breadcrumb,
    ...(breadcrumb.category
      ? { category: sanitizeSensitiveString(breadcrumb.category) }
      : {}),
    ...(breadcrumb.message
      ? { message: sanitizeSensitiveString(breadcrumb.message) }
      : {}),
    ...(breadcrumb.data
      ? { data: sanitizeAaisSentryExtra(breadcrumb.data) }
      : {}),
  }));
  event.tags = event.tags
    ? Object.fromEntries(
        Object.entries(event.tags).map(([key, value]) => [
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
      Object.entries(extra).map(([key, value]) => [
        key,
        sanitizeSentryKeyedValue(key, value),
      ]),
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
    const sanitized = sanitizePotentialUrlString(value);
    return sanitized.length > 80 ? `${sanitized.slice(0, 80)}...` : sanitized;
  }
  if (Array.isArray(value)) {
    return value.map(sanitizeSentryValue);
  }
  if (typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([key, nested]) => [
        key,
        sanitizeSentryKeyedValue(key, nested),
      ]),
    );
  }
  return typeof value;
}

function sanitizeSentryUrl(value: string) {
  try {
    const isAbsolute = /^[A-Za-z][A-Za-z\d+.-]*:/.test(value);
    const url = new URL(value, "https://aais.invalid");
    url.username = "";
    url.password = "";
    for (const key of [...url.searchParams.keys()]) {
      if (sensitiveKeyPattern.test(key) || sensitiveUrlQueryKeyPattern.test(key)) {
        url.searchParams.delete(key);
      }
    }
    url.hash = "";
    return isAbsolute
      ? url.toString()
      : `${url.pathname}${url.search}`;
  } catch {
    return sanitizeSensitiveString(value);
  }
}

function sanitizeSensitiveString(value: string) {
  return value.replace(oneTimeTokenInTextPattern, "$1redacted");
}

function sanitizePotentialUrlString(value: string) {
  const trimmed = value.trim();
  if (
    trimmed === value
    && !/\s/.test(value)
    && (
      /^[A-Za-z][A-Za-z\d+.-]*:\/\//.test(value)
      || value.startsWith("/")
    )
  ) {
    return sanitizeSentryUrl(value);
  }
  return sanitizeSensitiveString(value).replace(
    /https?:\/\/[^\s"'<>]+/gi,
    (url) => sanitizeSentryUrl(url),
  );
}

function sanitizeSentryKeyedValue(key: string, value: unknown): unknown {
  if (sensitiveKeyPattern.test(key)) {
    return "redacted";
  }
  if (typeof value === "string" && queryStringKeyPattern.test(key)) {
    return sanitizeSentryQueryString(value);
  }
  if (typeof value === "string" && urlKeyPattern.test(key)) {
    return sanitizeSentryUrl(value);
  }
  return sanitizeSentryValue(value);
}

function sanitizeSentryQueryString(value: string) {
  const hasQuestionPrefix = value.startsWith("?");
  const params = new URLSearchParams(hasQuestionPrefix ? value.slice(1) : value);
  for (const key of [...params.keys()]) {
    if (sensitiveKeyPattern.test(key) || sensitiveUrlQueryKeyPattern.test(key)) {
      params.delete(key);
    }
  }
  const sanitized = params.toString();
  return hasQuestionPrefix && sanitized ? `?${sanitized}` : sanitized;
}
