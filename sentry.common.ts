import type { ErrorEvent, SeverityLevel } from "@sentry/nextjs";

const sensitiveKeyPattern = /(authorization|cookie|password|secret|token|credential|artifact|prompt|message|report|text|email)/i;

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
  delete event.user;
  if (event.request) {
    delete event.request.cookies;
    delete event.request.data;
    delete event.request.headers;
  }
  event.extra = sanitizeAaisSentryExtra(event.extra);
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
        sensitiveKeyPattern.test(key) ? "redacted" : sanitizeSentryValue(value),
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
    return value.length > 80 ? `${value.slice(0, 80)}...` : value;
  }
  if (Array.isArray(value)) {
    return value.map(sanitizeSentryValue);
  }
  if (typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([key, nested]) => [
        key,
        sensitiveKeyPattern.test(key) ? "redacted" : sanitizeSentryValue(nested),
      ]),
    );
  }
  return typeof value;
}
