import { timingSafeEqual } from "node:crypto";
import { NextResponse } from "next/server";
import { recordAaisAuditEvent } from "@/lib/server/aais-audit-log";
import { requireAaisCsrf } from "@/lib/server/aais-csrf";
import { recordAaisMonitoringIssue } from "@/lib/server/aais-monitoring";
import {
  AaisResearchConfigurationError,
  AaisResearchValidationError,
  assertAaisResearchModeEnabled,
} from "@/lib/server/aais-research-contract";
import {
  createAaisResearchErrorResponse,
  type AaisResearchAuditAuthMode,
} from "@/lib/server/aais-research-api";
import { isAaisStrongOpaqueSecret } from "@/lib/server/aais-opaque-secret";
import { requireAaisSessionActor } from "@/lib/server/aais-request-auth";
import {
  AaisResearchAuthorizationError,
  getAaisResearchStore,
  normalizeAaisResearchWorkerLimit,
} from "@/lib/server/aais-research-store";

export const dynamic = "force-dynamic";
export const revalidate = 0;
export const runtime = "nodejs";
export const maxDuration = 60;

type ResearchLrsAction =
  | "events"
  | "deletions"
  | "requeue-events"
  | "requeue-deletions";

type ResearchLrsAuthorization = {
  mode: "research-bearer" | "admin-session";
  actorId?: string;
};

type ResearchLrsRouteResult = {
  selected: number;
  sent?: number;
  confirmed?: number;
  retried?: number;
  deadLetter?: number;
  requeued?: number;
  rejected?: number;
  stoppedReason: "empty" | "limit" | "runtime_budget";
  hasMore: boolean;
};

export async function POST(request: Request) {
  return handleFlush(request);
}

async function handleFlush(request: Request) {
  const requestedAction = readRequestedAction(request);
  let authMode: AaisResearchAuditAuthMode = readBearer(
    request.headers.get("authorization"),
  )
    ? "research-bearer"
    : hasSessionCookie(request) ? "session" : "none";
  try {
    assertAaisResearchModeEnabled();
    const requeueRequested = requestedAction === "requeue-events"
      || requestedAction === "requeue-deletions";
    const authorization = requeueRequested
      ? await authorizeRequeue(request)
      : authorizeBearer(request);
    authMode = authorization.mode === "admin-session" ? "session" : "research-bearer";
    const action = readAction(requestedAction);
    const limit = readWorkerLimit(new URL(request.url).searchParams.get("limit"));
    const store = getAaisResearchStore();
    const result = action === "events"
      ? await store.flushLrsOutbox(limit)
      : action === "deletions"
        ? await store.flushLrsDeletions(limit)
        : action === "requeue-events"
          ? await store.requeueLrsOutboxDeadLetters(limit)
          : await store.requeueLrsDeletionDeadLetters(limit);
    const degraded = action === "events" || action === "deletions"
      ? "retried" in result && (result.retried > 0 || result.deadLetter > 0)
      : "rejected" in result && result.rejected > 0;
    recordResearchLrsAudit({
      action,
      authorization,
      limit,
      result,
      outcome: degraded ? "failure" : "success",
    });
    if (degraded) {
      recordResearchLrsMonitoring({ action, authorization, result });
    }
    return NextResponse.json(
      {
        action,
        authorization: { mode: authorization.mode },
        result,
        secrets: "redacted",
      },
      {
        status: degraded ? 502 : 200,
        headers: { "cache-control": "no-store" },
      },
    );
  } catch (error) {
    return createAaisResearchErrorResponse({
      error,
      route: "/api/research/lrs/flush",
      operation: "lrs.flush",
      authMode,
    });
  }
}

function authorizeBearer(request: Request): ResearchLrsAuthorization {
  const bearer = readBearer(request.headers.get("authorization"));
  if (bearer) {
    const expected = process.env.AAIS_RESEARCH_LRS_OUTBOX_FLUSH_TOKEN?.trim();
    if (!isAaisStrongOpaqueSecret(expected)) {
      throw new AaisResearchConfigurationError(
        "AAIS research LRS flush token is not configured.",
      );
    }
    if (!tokensMatch(bearer, expected)) {
      throw new AaisResearchAuthorizationError();
    }
    return { mode: "research-bearer" as const };
  }
  throw new AaisResearchAuthorizationError();
}

async function authorizeRequeue(request: Request): Promise<ResearchLrsAuthorization> {
  if (readBearer(request.headers.get("authorization"))) {
    return authorizeBearer(request);
  }
  const actor = await requireAaisSessionActor(request);
  if (actor.role !== "admin") {
    throw new AaisResearchAuthorizationError(
      "AAIS research LRS dead-letter recovery requires administrator authorization.",
    );
  }
  requireAaisCsrf(request, actor.id);
  return { mode: "admin-session", actorId: actor.id };
}

function readRequestedAction(request: Request) {
  return new URL(request.url).searchParams.get("action")?.trim() || "events";
}

function readAction(value: string): ResearchLrsAction {
  if (
    value === "events"
    || value === "deletions"
    || value === "requeue-events"
    || value === "requeue-deletions"
  ) {
    return value;
  }
  throw new AaisResearchValidationError("AAIS research LRS action is invalid.");
}

function readWorkerLimit(value: string | null) {
  const normalized = value?.trim() ?? "";
  if (!normalized) {
    return normalizeAaisResearchWorkerLimit();
  }
  if (!/^[1-9][0-9]*$/.test(normalized)) {
    throw new AaisResearchValidationError("AAIS research worker limit is invalid.");
  }
  return normalizeAaisResearchWorkerLimit(Number(normalized));
}

function hasSessionCookie(request: Request) {
  return /(?:^|;\s*)aais_session=/.test(request.headers.get("cookie") ?? "");
}

function readBearer(value: string | null) {
  const match = /^Bearer\s+([^\s]+)$/i.exec(value?.trim() ?? "");
  return match?.[1] ?? "";
}

function tokensMatch(actual: string, expected: string) {
  const actualBuffer = Buffer.from(actual);
  const expectedBuffer = Buffer.from(expected);
  return actualBuffer.length === expectedBuffer.length
    && timingSafeEqual(actualBuffer, expectedBuffer);
}

function recordResearchLrsAudit(input: {
  action: ResearchLrsAction;
  authorization: ResearchLrsAuthorization;
  limit: number;
  result: ResearchLrsRouteResult;
  outcome: "success" | "failure";
}) {
  recordAaisAuditEvent({
    event: input.action.startsWith("requeue-")
      ? "research_lrs_dead_letter_requeue"
      : "research_lrs_flush",
    actorId: input.authorization.actorId,
    outcome: input.outcome,
    metadata: {
      action: input.action,
      authMode: input.authorization.mode,
      limit: input.limit,
      ...sanitizeResult(input.result),
      secrets: "redacted",
    },
  });
}

function recordResearchLrsMonitoring(input: {
  action: ResearchLrsAction;
  authorization: ResearchLrsAuthorization;
  result: ResearchLrsRouteResult;
}) {
  recordAaisMonitoringIssue({
    event: "aais.research_lrs.degraded",
    message: `AAIS research LRS ${input.action} requires delivery follow-up`,
    status: 502,
    route: "/api/research/lrs/flush",
    tags: {
      "aais.research_lrs_action": input.action,
      "aais.auth_mode": input.authorization.mode,
    },
    extra: {
      action: input.action,
      authMode: input.authorization.mode,
      ...sanitizeResult(input.result),
      secrets: "redacted",
    },
  });
}

function sanitizeResult(result: ResearchLrsRouteResult) {
  return {
    selected: result.selected,
    ...(typeof result.sent === "number" ? { sent: result.sent } : {}),
    ...(typeof result.confirmed === "number" ? { confirmed: result.confirmed } : {}),
    ...(typeof result.retried === "number" ? { retried: result.retried } : {}),
    ...(typeof result.deadLetter === "number" ? { deadLetter: result.deadLetter } : {}),
    ...(typeof result.requeued === "number" ? { requeued: result.requeued } : {}),
    ...(typeof result.rejected === "number" ? { rejected: result.rejected } : {}),
    stoppedReason: result.stoppedReason,
    hasMore: result.hasMore,
  };
}
