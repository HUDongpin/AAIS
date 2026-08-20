import { timingSafeEqual } from "node:crypto";
import { NextResponse } from "next/server";
import {
  getLrsConfigurationStatus,
  getAaisLrsDeliveryQueueStatus,
  probeAaisLrsConnection,
  sendAaisLrsHealthStatement,
} from "@/lib/server/aais-lrs-client";
import { isAaisCsrfError, requireAaisCsrf } from "@/lib/server/aais-csrf";
import { isAaisAuthError, requireAaisSessionActor } from "@/lib/server/aais-request-auth";
import { getAaisPersistentLrsOutboxStatus } from "@/lib/server/aais-learning-store";
import { createAaisApiErrorResponse } from "@/lib/server/aais-api-error";
import { isAaisStrongOpaqueSecret } from "@/lib/server/aais-opaque-secret";

export async function GET(request: Request) {
  try {
    await authorizeLrsHealthRequest(request, { write: false });
    const result = await probeAaisLrsConnection({ timeoutMs: 5_000 });
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
      headers: { "cache-control": "private, no-store" },
    });
  } catch (error) {
    return createAaisApiErrorResponse(getErrorResponseInput(error));
  }
}

export async function POST(request: Request) {
  try {
    const authorization = await authorizeLrsHealthRequest(request, { write: true });
    const result = await sendAaisLrsHealthStatement(
      authorization.actorId ?? "aais-lrs-health-operator",
      { timeoutMs: 5_000 },
    );
    return NextResponse.json({
      ...result,
      checkedAt: new Date().toISOString(),
      secrets: "redacted",
    }, {
      status: result.status === "error" ? 502 : 200,
      headers: { "cache-control": "private, no-store" },
    });
  } catch (error) {
    return createAaisApiErrorResponse(getErrorResponseInput(error));
  }
}

class AaisLrsHealthAuthorizationError extends Error {
  constructor() {
    super("AAIS LRS health requires operator authorization.");
    this.name = "AaisLrsHealthAuthorizationError";
  }
}

async function authorizeLrsHealthRequest(
  request: Request,
  input: { write: boolean },
): Promise<{ actorId?: string }> {
  const bearer = readBearerToken(request.headers.get("authorization"));
  if (bearer) {
    const expectedTokens = input.write
      ? [process.env.AAIS_LRS_OUTBOX_FLUSH_TOKEN?.trim(), process.env.CRON_SECRET?.trim()]
      : [process.env.AAIS_READINESS_BEARER_TOKEN?.trim()];
    if (expectedTokens.some((token) =>
      isAaisStrongOpaqueSecret(token) && tokenMatches(bearer, String(token))
    )) {
      return {};
    }
    throw new AaisLrsHealthAuthorizationError();
  }

  const actor = await requireAaisSessionActor(request);
  if (actor.role !== "admin") {
    throw new AaisLrsHealthAuthorizationError();
  }
  if (input.write) {
    requireAaisCsrf(request, actor.id);
  }
  return { actorId: actor.id };
}

function readBearerToken(value: string | null) {
  const match = /^Bearer\s+(.+)$/i.exec(String(value ?? "").trim());
  return match?.[1]?.trim() ?? "";
}

function tokenMatches(actual: string, expected: string) {
  const actualBuffer = Buffer.from(actual);
  const expectedBuffer = Buffer.from(expected);
  return actualBuffer.length === expectedBuffer.length
    && timingSafeEqual(actualBuffer, expectedBuffer);
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
  if (error instanceof AaisLrsHealthAuthorizationError) {
    return {
      code: "AAIS_LRS_HEALTH_FORBIDDEN",
      message: "AAIS LRS health requires operator authorization.",
      status: 403,
      extra: { secrets: "redacted" },
    };
  }
  return {
    code: "AAIS_LRS_HEALTH_WRITE_FAILED",
    message: "AAIS LRS health write failed.",
    status: 500,
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
