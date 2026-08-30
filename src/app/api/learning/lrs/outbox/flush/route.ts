import { timingSafeEqual } from "node:crypto";
import { NextResponse } from "next/server";
import { recordAaisAuditEvent } from "@/lib/server/aais-audit-log";
import { recordAaisMonitoringIssue } from "@/lib/server/aais-monitoring";
import { isAaisCsrfError, requireAaisCsrf } from "@/lib/server/aais-csrf";
import {
  flushAaisPersistentLrsOutbox,
  requeueAaisPersistentLrsDeadLetters,
} from "@/lib/server/aais-learning-store";
import { isAaisAuthError, requireAaisSessionActor } from "@/lib/server/aais-request-auth";
import { createAaisApiErrorResponse } from "@/lib/server/aais-api-error";
import { isAaisStrongOpaqueSecret } from "@/lib/server/aais-opaque-secret";
import {
  acquireAaisRuntimeLease,
  assertAaisRuntimeLeaseHeld,
  isAaisRuntimeLeaseUnavailableError,
  releaseAaisRuntimeLease,
} from "@/lib/server/aais-runtime-lease";

export const dynamic = "force-dynamic";
export const revalidate = 0;
export const runtime = "nodejs";
// The worker stops starting provider calls within its 20-second budget. The
// wider cap covers worst-case bounded Postgres claim/fence/finalize queries so
// the platform does not kill an invocation after dispatch but before fencing.
export const maxDuration = 120;

type FlushAuthorization = {
  mode: "admin-session" | "bearer-token";
  actorId?: string;
};

type OutboxAction = "flush" | "requeue-dead-letter";

class AaisOutboxFlushAuthorizationError extends Error {
  constructor(message = "AAIS LRS outbox flush requires administrator authorization.") {
    super(message);
  }
}

class AaisOutboxFlushActionError extends Error {
  constructor(message = "AAIS LRS outbox action is not supported.") {
    super(message);
  }
}

export async function POST(request: Request) {
  return handleFlushRequest(request, { allowAdminSession: true });
}

export async function GET(request: Request) {
  return handleFlushRequest(request, { allowAdminSession: false });
}

async function handleFlushRequest(
  request: Request,
  input: {
    allowAdminSession: boolean;
  },
) {
  const searchParams = new URL(request.url).searchParams;
  const limit = readFlushLimit(searchParams.get("limit"));
  let action = readRequestedOutboxActionName(searchParams.get("action"));
  let authorization: FlushAuthorization | null = null;
  let lease: Awaited<ReturnType<typeof acquireAaisRuntimeLease>> | null = null;
  try {
    authorization = await authorizeFlushRequest(request, input);
    action = readOutboxAction(searchParams.get("action"), input);
    lease = await acquireAaisRuntimeLease("lrs-outbox");
    if (lease.status === "standby") {
      recordOutboxAudit({
        action,
        authorization,
        limit,
        outcome: "failure",
        result: {
          status: "standby",
          lease: "held_by_peer",
          secrets: "redacted",
        },
      });
      return NextResponse.json(
        {
          action,
          authorization: sanitizeAuthorization(authorization),
          outbox: {
            status: "standby",
            lease: "held_by_peer",
            secrets: "redacted",
          },
          secrets: "redacted",
        },
        {
          status: 202,
          headers: { "cache-control": "private, no-store" },
        },
      );
    }
    await assertAaisRuntimeLeaseHeld(lease);
    if (action === "requeue-dead-letter") {
      const result = await requeueAaisPersistentLrsDeadLetters({
        limit,
      });
      recordOutboxAudit({
        action,
        authorization,
        limit,
        outcome: result.status === "not_configured" ? "failure" : "success",
        result: sanitizeRequeueResult(result),
      });
      recordOutboxMonitoringIfNeeded({
        action,
        authorization,
        status: result.status,
        result: sanitizeRequeueResult(result),
      });
      return NextResponse.json(
        {
          action,
          authorization: sanitizeAuthorization(authorization),
          outbox: sanitizeRequeueResult(result),
          secrets: "redacted",
        },
        {
          status: result.status === "not_configured" ? 503 : 200,
          headers: { "cache-control": "private, no-store" },
        },
      );
    }
    const result = await flushAaisPersistentLrsOutbox({
      limit,
      beforeDispatch: () => assertAaisRuntimeLeaseHeld(lease!),
    });
    const flushFailed = isFlushResultFailure(result);
    recordOutboxAudit({
      action,
      authorization,
      limit,
      outcome: flushFailed ? "failure" : "success",
      result: sanitizeFlushResult(result),
    });
    recordOutboxMonitoringIfNeeded({
      action,
      authorization,
      status: result.status,
      result: sanitizeFlushResult(result),
    });
    return NextResponse.json(
      {
        action,
        authorization: sanitizeAuthorization(authorization),
        outbox: sanitizeFlushResult(result),
        secrets: "redacted",
      },
      {
        status: result.status === "not_configured"
          ? 503
          : flushFailed ? 502 : 200,
        headers: { "cache-control": "private, no-store" },
      },
    );
  } catch (error) {
    recordOutboxAudit({
      action,
      authorization,
      limit,
      outcome: "failure",
      errorStatus: getErrorStatus(error),
      errorKind: getAuditErrorKind(error),
    });
    if (getAuditErrorKind(error) === "operation_failed") {
      recordOutboxMonitoringIfNeeded({
        action,
        authorization,
        status: "operation_failed",
        result: {
          errorStatus: getErrorStatus(error),
          errorKind: getAuditErrorKind(error),
          secrets: "redacted",
        },
      });
    }
    return createAaisApiErrorResponse(getErrorResponseInput(error));
  } finally {
    if (lease?.status === "acquired") {
      await releaseAaisRuntimeLease(lease);
    }
  }
}

async function authorizeFlushRequest(
  request: Request,
  input: {
    allowAdminSession: boolean;
  },
): Promise<FlushAuthorization> {
  const bearer = readBearerToken(request.headers.get("authorization"));
  const configuredTokens = [
    process.env.AAIS_LRS_OUTBOX_FLUSH_TOKEN?.trim(),
    process.env.CRON_SECRET?.trim(),
  ].filter((token): token is string => isAaisStrongOpaqueSecret(token));
  if (bearer) {
    if (configuredTokens.some((token) => tokenMatches(bearer, token))) {
      return { mode: "bearer-token" };
    }
    throw new AaisOutboxFlushAuthorizationError("AAIS LRS outbox flush bearer token is invalid.");
  }
  if (!input.allowAdminSession) {
    throw new AaisOutboxFlushAuthorizationError("AAIS LRS outbox flush bearer token is required.");
  }

  const actor = await requireAaisSessionActor(request);
  if (actor.role !== "admin") {
    throw new AaisOutboxFlushAuthorizationError();
  }
  requireAaisCsrf(request, actor.id);
  return { mode: "admin-session", actorId: actor.id };
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

function readFlushLimit(value: string | null) {
  const parsed = Number.parseInt(String(value ?? ""), 10);
  if (!Number.isFinite(parsed)) {
    return 50;
  }
  return Math.min(200, Math.max(1, parsed));
}

function readOutboxAction(
  value: string | null,
  input: {
    allowAdminSession: boolean;
  },
): OutboxAction {
  const action = String(value ?? "flush").trim() || "flush";
  if (action === "flush") {
    return "flush";
  }
  if (action === "requeue-dead-letter") {
    if (!input.allowAdminSession) {
      throw new AaisOutboxFlushActionError("AAIS LRS outbox GET only supports flush.");
    }
    return "requeue-dead-letter";
  }
  throw new AaisOutboxFlushActionError();
}

function readRequestedOutboxActionName(value: string | null): OutboxAction | "unsupported" {
  const action = String(value ?? "flush").trim() || "flush";
  if (action === "flush" || action === "requeue-dead-letter") {
    return action;
  }
  return "unsupported";
}

function sanitizeFlushResult(result: Awaited<ReturnType<typeof flushAaisPersistentLrsOutbox>>) {
  return {
    status: result.status,
    sent: result.sent,
    ...(typeof result.batches === "number" ? { batches: result.batches } : {}),
    ...(typeof result.failed === "number" ? { failed: result.failed } : {}),
    ...(typeof result.deferred === "number" ? { deferred: result.deferred } : {}),
    ...(typeof result.stoppedReason === "string"
      ? { stoppedReason: result.stoppedReason }
      : {}),
    ...(typeof result.hasMore === "boolean" ? { hasMore: result.hasMore } : {}),
    secrets: "redacted" as const,
  };
}

function isFlushResultFailure(
  result: Awaited<ReturnType<typeof flushAaisPersistentLrsOutbox>>,
) {
  return result.status === "not_configured"
    || (typeof result.failed === "number" && result.failed > 0);
}

function sanitizeAuthorization(authorization: FlushAuthorization) {
  return {
    mode: authorization.mode,
  };
}

function sanitizeRequeueResult(result: Awaited<ReturnType<typeof requeueAaisPersistentLrsDeadLetters>>) {
  return {
    status: result.status,
    requeued: result.requeued,
    secrets: "redacted" as const,
  };
}

function getErrorStatus(error: unknown) {
  if (isAaisAuthError(error)) {
    return 401;
  }
  if (error instanceof AaisOutboxFlushActionError) {
    return 400;
  }
  if (error instanceof AaisOutboxFlushAuthorizationError || isAaisCsrfError(error)) {
    return 403;
  }
  if (isAaisRuntimeLeaseUnavailableError(error)) {
    return 503;
  }
  return 500;
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
  if (error instanceof AaisOutboxFlushActionError) {
    return {
      code: "AAIS_LRS_OUTBOX_ACTION_UNSUPPORTED",
      message: "AAIS LRS outbox action is not supported.",
      status: 400,
      extra: { secrets: "redacted" },
    };
  }
  if (error instanceof AaisOutboxFlushAuthorizationError || isAaisCsrfError(error)) {
    return {
      code: "AAIS_LRS_OUTBOX_FORBIDDEN",
      message: "AAIS LRS outbox flush requires administrator authorization.",
      status: 403,
      extra: { secrets: "redacted" },
    };
  }
  if (isAaisRuntimeLeaseUnavailableError(error)) {
    return {
      code: "AAIS_LRS_OUTBOX_LEASE_NOT_READY",
      message: "AAIS LRS outbox worker lease is not ready.",
      status: 503,
      extra: { secrets: "redacted" },
    };
  }
  return {
    code: "AAIS_LRS_OUTBOX_FLUSH_FAILED",
    message: "AAIS LRS outbox flush failed.",
    status: 500,
    extra: { secrets: "redacted" },
    cause: error,
    route: "/api/learning/lrs/outbox/flush",
  };
}

function recordOutboxAudit(input: {
  action: OutboxAction | "unsupported";
  authorization: FlushAuthorization | null;
  limit: number;
  outcome: "success" | "failure";
  result?: Record<string, unknown>;
  errorStatus?: number;
  errorKind?: string;
}) {
  recordAaisAuditEvent({
    event: input.action === "requeue-dead-letter"
      ? "lrs_outbox_requeue_dead_letter"
      : "lrs_outbox_flush",
    actorId: input.authorization?.actorId,
    outcome: input.outcome,
    metadata: {
      action: input.action,
      authMode: input.authorization?.mode ?? "none",
      limit: input.limit,
      ...(input.result ?? {}),
      ...(typeof input.errorStatus === "number" ? { errorStatus: input.errorStatus } : {}),
      ...(input.errorKind ? { errorKind: input.errorKind } : {}),
      secrets: "redacted",
    },
  });
}

function recordOutboxMonitoringIfNeeded(input: {
  action: OutboxAction | "unsupported";
  authorization: FlushAuthorization | null;
  status: string;
  result: Record<string, unknown>;
}) {
  const partialFailure = input.status === "partial"
    && typeof input.result.failed === "number"
    && input.result.failed > 0;
  if (
    input.status !== "not_configured"
    && input.status !== "operation_failed"
    && !partialFailure
  ) {
    return;
  }
  recordAaisMonitoringIssue({
    event: "aais.lrs_outbox.degraded",
    message: `AAIS LRS outbox ${input.action} ${input.status}`,
    status: input.status === "partial" ? 502 : 503,
    route: "/api/learning/lrs/outbox/flush",
    tags: {
      "aais.outbox_action": input.action,
      "aais.outbox_status": input.status,
      "aais.auth_mode": input.authorization?.mode ?? "none",
    },
    extra: {
      action: input.action,
      authMode: input.authorization?.mode ?? "none",
      ...input.result,
      secrets: "redacted",
    },
  });
}

function getAuditErrorKind(error: unknown) {
  if (isAaisAuthError(error)) {
    return "auth_required";
  }
  if (error instanceof AaisOutboxFlushActionError) {
    return "unsupported_action";
  }
  if (error instanceof AaisOutboxFlushAuthorizationError || isAaisCsrfError(error)) {
    return "authorization_failed";
  }
  return "operation_failed";
}
