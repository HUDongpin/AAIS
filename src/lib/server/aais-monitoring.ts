import * as Sentry from "@sentry/nextjs";
import type { SeverityLevel } from "@sentry/nextjs";
import {
  sanitizeAaisSentryExtra,
  toAaisSentryLevel,
} from "../../../sentry.common";

type AaisMonitoringIssueInput = {
  event: string;
  message?: string;
  level?: SeverityLevel;
  status?: number;
  route?: string;
  tags?: Record<string, string | number | boolean | undefined>;
  extra?: Record<string, unknown>;
};

export function recordAaisMonitoringIssue(input: AaisMonitoringIssueInput) {
  const level = input.level ?? toAaisSentryLevel(input.status ?? 500);
  Sentry.withScope((scope) => {
    scope.setLevel(level);
    scope.setTag("aais.event", input.event);
    if (input.route) {
      scope.setTag("aais.route", input.route);
    }
    for (const [key, value] of Object.entries(input.tags ?? {})) {
      if (value !== undefined) {
        scope.setTag(key, String(value));
      }
    }
    scope.setContext("aais", sanitizeAaisSentryExtra({
      status: input.status,
      route: input.route,
      ...(input.extra ?? {}),
    }) as Record<string, unknown>);
    Sentry.captureMessage(input.message ?? input.event, level);
  });
}
