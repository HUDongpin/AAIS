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
    const studentId = resolveAaisStudentId(request);
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
    return NextResponse.json(
      {
        error: error instanceof Error ? error.message : "AAIS LRS health write failed.",
        secrets: "redacted",
      },
      { status: getErrorStatus(error) },
    );
  }
}

function getErrorStatus(error: unknown) {
  if (isAaisAuthError(error)) {
    return 401;
  }
  if (isAaisCsrfError(error)) {
    return 403;
  }
  return 400;
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
    secrets: "redacted" as const,
  };
}
