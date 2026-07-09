import { NextResponse } from "next/server";
import {
  getLrsConfigurationStatus,
  getAaisLrsDeliveryQueueStatus,
  probeAaisLrsConnection,
  sendAaisLrsHealthStatement,
} from "@/lib/server/aais-lrs-client";
import { isAaisCsrfError, requireAaisCsrf } from "@/lib/server/aais-csrf";
import { isAaisAuthError, resolveAaisStudentId } from "@/lib/server/aais-request-auth";
import { getAaisPersistentLrsOutboxStatus } from "@/lib/server/aais-learning-store";
import { createAaisApiErrorResponse } from "@/lib/server/aais-api-error";

export async function GET() {
  const result = await probeAaisLrsConnection();
  const persistentOutbox = await getAaisPersistentLrsOutboxStatus();
  return NextResponse.json({
    ...result,
    checkedAt: new Date().toISOString(),
    configuration: getLrsConfigurationStatus(),
    delivery: {
      ...getAaisLrsDeliveryQueueStatus(),
      persistentOutbox: sanitizePersistentOutboxStatus(persistentOutbox),
    },
    secrets: "redacted",
  }, {
    status: result.status === "error" ? 502 : 200,
  });
}

export async function POST(request: Request) {
  try {
    const studentId = await resolveAaisStudentId(request);
    requireAaisCsrf(request, studentId);
    const result = await sendAaisLrsHealthStatement(studentId);
    return NextResponse.json({
      ...result,
      checkedAt: new Date().toISOString(),
      secrets: "redacted",
    }, {
      status: result.status === "error" ? 502 : 200,
    });
  } catch (error) {
    return createAaisApiErrorResponse(getErrorResponseInput(error));
  }
}

function getErrorResponseInput(error: unknown) {
  if (isAaisAuthError(error)) {
    return {
      code: "AAIS_AUTH_REQUIRED",
      message: "AAIS authentication is required.",
      status: 401,
      extra: { secrets: "redacted" },
    };
  }
  if (isAaisCsrfError(error)) {
    return {
      code: "AAIS_CSRF_REQUIRED",
      message: "AAIS CSRF token is required.",
      status: 403,
      extra: { secrets: "redacted" },
    };
  }
  return {
    code: "AAIS_LRS_HEALTH_WRITE_FAILED",
    message: "AAIS LRS health write failed.",
    status: 400,
    extra: { secrets: "redacted" },
    cause: error,
    route: "/api/learning/lrs/health",
  };
}

function sanitizePersistentOutboxStatus(
  status: Awaited<ReturnType<typeof getAaisPersistentLrsOutboxStatus>>,
) {
  return {
    mode: status.mode,
    storage: status.storage,
    configured: status.configured,
    pending: status.pending,
    retry: status.retry,
    sent: status.sent,
    deadLetter: status.deadLetter,
    total: status.total,
    coalescing: {
      enabled: status.coalescing.enabled,
      windowSeconds: status.coalescing.windowSeconds,
      events: [...status.coalescing.events],
      strategy: status.coalescing.strategy,
    },
    recovery: {
      deadLetterRequeue: status.recovery.deadLetterRequeue,
      action: status.recovery.action,
      auth: [...status.recovery.auth],
      redaction: status.recovery.redaction,
    },
    secrets: "redacted" as const,
  };
}
