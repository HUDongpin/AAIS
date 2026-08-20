import { NextResponse } from "next/server";
import {
  type AaisAuthEmailProviderEvidence,
  type AaisAuthEmailReconciliationDisposition,
  isAaisAuthEmailOutboxStoreError,
  isAaisAuthEmailReconciliationConflictError,
  reconcileAaisAuthEmailOutbox,
} from "@/lib/server/aais-auth-delivery";
import { isAaisAuthError, requireAaisSessionActor } from "@/lib/server/aais-request-auth";
import { isAaisCsrfError, requireAaisCsrf } from "@/lib/server/aais-csrf";
import { recordAaisAuditEvent } from "@/lib/server/aais-audit-log";
import {
  AaisApiRouteError,
  createAaisApiErrorResponse,
  isAaisApiRouteError,
} from "@/lib/server/aais-api-error";
import {
  AaisRequestBodyError,
  readAaisBoundedJson,
} from "@/lib/server/aais-request-json";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const reconciliationBodyMaxBytes = 4 * 1024;
const privateHeaders = { "cache-control": "private, no-store" } as const;

type ReconciliationRequest = {
  outboxId: string;
  disposition: AaisAuthEmailReconciliationDisposition;
  evidence: AaisAuthEmailProviderEvidence;
};

export async function POST(request: Request) {
  try {
    const actor = await requireAaisSessionActor(request);
    if (actor.role !== "admin") {
      throw new AaisAuthEmailReconciliationAuthorizationError();
    }
    requireAaisCsrf(request, actor.id);
    const body = await readReconciliationRequest(request);
    const reconciliation = await reconcileAaisAuthEmailOutbox({
      actorId: actor.id,
      disposition: body.disposition,
      evidence: body.evidence,
      outboxId: body.outboxId,
    });
    recordAaisAuditEvent({
      event: "auth.email_outbox.reconciled",
      actorId: actor.id,
      outcome: "success",
      metadata: {
        outboxId: reconciliation.outboxId,
        disposition: reconciliation.disposition,
        evidenceProvider: body.evidence.provider,
        evidenceStatus: body.evidence.status,
        reissueAllowed: reconciliation.reissueAllowed,
        automaticUncertainRelease: false,
      },
    });
    return NextResponse.json(
      { reconciliation, secrets: "redacted" },
      { headers: privateHeaders },
    );
  } catch (error) {
    return createAaisApiErrorResponse({
      ...getErrorResponseInput(error),
      headers: privateHeaders,
      route: "/api/auth/email-outbox/reconcile",
    });
  }
}

async function readReconciliationRequest(request: Request): Promise<ReconciliationRequest> {
  let value: unknown;
  try {
    value = await readAaisBoundedJson(request, { maxBytes: reconciliationBodyMaxBytes });
  } catch (error) {
    if (error instanceof AaisRequestBodyError && error.reason === "too_large") {
      throw requestError(
        "AAIS_AUTH_EMAIL_RECONCILIATION_TOO_LARGE",
        "AAIS authentication email reconciliation evidence is too large.",
        413,
      );
    }
    throw requestError(
      "AAIS_AUTH_EMAIL_RECONCILIATION_INVALID",
      "AAIS authentication email reconciliation evidence is invalid.",
      400,
    );
  }
  if (!isPlainRecord(value) || !hasOnlyKeys(value, ["outboxId", "disposition", "evidence"])) {
    throw invalidRequest();
  }
  if (
    typeof value.outboxId !== "string"
    || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
      .test(value.outboxId)
    || (value.disposition !== "sent" && value.disposition !== "not_sent")
    || !isPlainRecord(value.evidence)
    || !hasOnlyKeys(value.evidence, ["provider", "messageId", "status", "observedAt"])
    || value.evidence.provider !== "resend"
    || typeof value.evidence.messageId !== "string"
    || !/^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$/.test(value.evidence.messageId)
    || typeof value.evidence.status !== "string"
    || typeof value.evidence.observedAt !== "string"
  ) {
    throw invalidRequest();
  }
  const validStatuses = value.disposition === "sent"
    ? ["sent", "delivered"]
    : ["failed", "bounced", "canceled", "suppressed"];
  const observedAt = new Date(value.evidence.observedAt);
  if (
    !validStatuses.includes(value.evidence.status)
    || !Number.isFinite(observedAt.getTime())
    || observedAt.toISOString() !== value.evidence.observedAt
    || observedAt.getTime() > Date.now()
  ) {
    throw invalidRequest();
  }
  return {
    outboxId: value.outboxId.toLowerCase(),
    disposition: value.disposition,
    evidence: {
      provider: "resend",
      messageId: value.evidence.messageId,
      status: value.evidence.status as AaisAuthEmailProviderEvidence["status"],
      observedAt: value.evidence.observedAt,
    },
  };
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function hasOnlyKeys(record: Record<string, unknown>, allowed: readonly string[]) {
  const keys = Object.keys(record);
  return keys.length === allowed.length && keys.every((key) => allowed.includes(key));
}

function invalidRequest() {
  return requestError(
    "AAIS_AUTH_EMAIL_RECONCILIATION_INVALID",
    "AAIS authentication email reconciliation evidence is invalid.",
    400,
  );
}

function requestError(code: string, message: string, status: 400 | 413) {
  return new AaisApiRouteError({ code, message, status });
}

class AaisAuthEmailReconciliationAuthorizationError extends Error {
  constructor() {
    super("AAIS authentication email reconciliation requires administrator authorization.");
    this.name = "AaisAuthEmailReconciliationAuthorizationError";
  }
}

function getErrorResponseInput(error: unknown) {
  if (isAaisApiRouteError(error)) {
    return { code: error.code, message: error.message, status: error.status };
  }
  if (isAaisAuthError(error)) {
    return {
      code: "AAIS_AUTH_REQUIRED",
      message: "AAIS authentication is required.",
      status: 401,
    };
  }
  if (error instanceof AaisAuthEmailReconciliationAuthorizationError) {
    return {
      code: "AAIS_AUTH_EMAIL_RECONCILIATION_FORBIDDEN",
      message: "AAIS authentication email reconciliation requires administrator authorization.",
      status: 403,
    };
  }
  if (isAaisCsrfError(error)) {
    return {
      code: "AAIS_CSRF_REQUIRED",
      message: "AAIS CSRF token is required.",
      status: 403,
    };
  }
  if (isAaisAuthEmailReconciliationConflictError(error)) {
    return {
      code: "AAIS_AUTH_EMAIL_RECONCILIATION_CONFLICT",
      message: "AAIS authentication email reconciliation conflicts with the current delivery state.",
      status: 409,
    };
  }
  if (isAaisAuthEmailOutboxStoreError(error)) {
    return {
      code: "AAIS_AUTH_EMAIL_OUTBOX_NOT_READY",
      message: "AAIS authentication email outbox is not ready.",
      status: 503,
    };
  }
  return {
    code: "AAIS_AUTH_EMAIL_RECONCILIATION_FAILED",
    message: "AAIS authentication email reconciliation failed.",
    status: 500,
    cause: error,
  };
}
