import * as Sentry from "@sentry/nextjs";
import {
  getAaisSentryDsn,
  getAaisSentryEnvironment,
  getAaisSentryRelease,
  getAaisSentrySampleRate,
  sanitizeAaisSentryEvent,
  sanitizeAaisSentrySpan,
  sanitizeAaisSentryTransaction,
} from "./sentry.common";

const dsn = getAaisSentryDsn();

if (dsn) {
  Sentry.init({
    dsn,
    environment: getAaisSentryEnvironment(),
    release: getAaisSentryRelease(),
    sendDefaultPii: false,
    tracesSampleRate: getAaisSentrySampleRate(
      process.env.NEXT_PUBLIC_SENTRY_TRACES_SAMPLE_RATE,
      process.env.NODE_ENV === "production" ? 0.05 : 0,
    ),
    enableLogs: true,
    beforeSend: sanitizeAaisSentryEvent,
    beforeSendTransaction: sanitizeAaisSentryTransaction,
    beforeSendSpan: sanitizeAaisSentrySpan,
  });
}

export const onRouterTransitionStart = Sentry.captureRouterTransitionStart;
