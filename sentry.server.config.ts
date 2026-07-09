import * as Sentry from "@sentry/nextjs";
import {
  getAaisSentryDsn,
  getAaisSentryEnvironment,
  getAaisSentryRelease,
  getAaisSentrySampleRate,
  sanitizeAaisSentryEvent,
} from "./sentry.common";

const dsn = getAaisSentryDsn();

if (dsn) {
  Sentry.init({
    dsn,
    environment: getAaisSentryEnvironment(),
    release: getAaisSentryRelease(),
    sendDefaultPii: false,
    tracesSampleRate: getAaisSentrySampleRate(
      process.env.SENTRY_TRACES_SAMPLE_RATE,
      process.env.NODE_ENV === "production" ? 0.05 : 0,
    ),
    enableLogs: true,
    beforeSend: sanitizeAaisSentryEvent,
  });
}
