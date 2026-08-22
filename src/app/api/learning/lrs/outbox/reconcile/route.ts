import { NextResponse } from "next/server";
import { recordAaisAuditEvent } from "@/lib/server/aais-audit-log";
import {
  AaisApiRouteError,
  createAaisApiErrorResponse,
  isAaisApiRouteError,
} from "@/lib/server/aais-api-error";
import { isAaisCsrfError, requireAaisCsrf } from "@/lib/server/aais-csrf";
import {
  type AaisLrsDeliveryReconciliationEvidence,
  isAaisLrsDeliveryReconciliationConflictError,
  isAaisLrsDeliveryReconciliationStoreError,
  listAaisPendingLrsDeliveryAttempts,
  reconcileAaisLrsDeliveryAttempt,
} from "@/lib/server/aais-learning-store";
import {
  AaisRequestBodyError,
  readAaisBoundedJson,
} from "@/lib/server/aais-request-json";
import { isAaisAuthError, requireAaisSessionActor } from "@/lib/server/aais-request-auth";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const reconciliationBodyMaxBytes = 32 * 1024;
const reconciliationListDefaultLimit = 20;
const reconciliationListMaxLimit = 50;
const privateHeaders = { "cache-control": "private, no-store" } as const;

type ReconciliationRequest = {
  claimId: string;
  evidence: AaisLrsDeliveryReconciliationEvidence;
};

export async function GET(request: Request) {
  try {
    const actor = await requireAaisSessionActor(request);
    if (actor.role !== "admin") {
      throw new AaisLrsDeliveryReconciliationAuthorizationError();
    }
    const limit = readReconciliationListLimit(request);
    const attempts = await listAaisPendingLrsDeliveryAttempts({ limit });
    const boundedAttempts = attempts.slice(0, limit);
    return NextResponse.json(
      {
        attempts: boundedAttempts.map((attempt) => ({
          claimId: attempt.claimId,
          state: attempt.state,
          startedAt: attempt.startedAt,
          reconcileAfter: attempt.reconcileAfter,
          statementCount: attempt.statementCount,
          statementIds: [...attempt.statementIds].sort((left, right) => left.localeCompare(right)),
        })),
        count: boundedAttempts.length,
        secrets: "redacted",
      },
      { headers: privateHeaders },
    );
  } catch (error) {
    return createAaisApiErrorResponse({
      ...getErrorResponseInput(error),
      headers: privateHeaders,
      route: "/api/learning/lrs/outbox/reconcile",
    });
  }
}

export async function POST(request: Request) {
  const auditOnce = createAuditOnce();
  let actorId: string | undefined;
  try {
    const actor = await requireAaisSessionActor(request);
    actorId = actor.id;
    if (actor.role !== "admin") {
      throw new AaisLrsDeliveryReconciliationAuthorizationError();
    }
    requireAaisCsrf(request, actor.id);
    const body = await readReconciliationRequest(request);
    const reconciliation = await reconcileAaisLrsDeliveryAttempt({
      actorId: actor.id,
      claimId: body.claimId,
      evidence: body.evidence,
    });
    auditOnce({
      event: "lrs_outbox_delivery_reconciled",
      actorId: actor.id,
      outcome: "success",
      metadata: {
        claimId: reconciliation.claimId,
        result: reconciliation.result,
        statementCount: reconciliation.statementCount,
        stored: reconciliation.stored,
        absent: reconciliation.absent,
        exactStatementSetRequired: true,
        automaticStaleRelease: false,
        secrets: "redacted",
      },
    });
    return NextResponse.json(
      { reconciliation, secrets: "redacted" },
      { headers: privateHeaders },
    );
  } catch (error) {
    const responseInput = getErrorResponseInput(error);
    auditOnce({
      event: "lrs_outbox_delivery_reconciliation_failed",
      ...(actorId ? { actorId } : {}),
      outcome: "failure",
      metadata: {
        operation: "reconcile",
        code: responseInput.code,
        status: responseInput.status,
        actorContext: actorId ? "authenticated" : "unauthenticated",
        secrets: "redacted",
      },
    });
    return createAaisApiErrorResponse({
      ...responseInput,
      headers: privateHeaders,
      route: "/api/learning/lrs/outbox/reconcile",
    });
  }
}

function readReconciliationListLimit(request: Request) {
  const searchParams = new URL(request.url).searchParams;
  if ([...searchParams.keys()].some((key) => key !== "limit")) {
    throw invalidListRequest();
  }
  const values = searchParams.getAll("limit");
  if (!values.length) {
    return reconciliationListDefaultLimit;
  }
  if (values.length !== 1 || !/^[1-9][0-9]?$/.test(values[0] ?? "")) {
    throw invalidListRequest();
  }
  const limit = Number(values[0]);
  if (limit > reconciliationListMaxLimit) {
    throw invalidListRequest();
  }
  return limit;
}

async function readReconciliationRequest(request: Request): Promise<ReconciliationRequest> {
  let value: unknown;
  try {
    value = await readAaisBoundedJson(request, { maxBytes: reconciliationBodyMaxBytes });
  } catch (error) {
    if (error instanceof AaisRequestBodyError && error.reason === "too_large") {
      throw requestError(
        "AAIS_LRS_DELIVERY_RECONCILIATION_TOO_LARGE",
        "AAIS LRS delivery reconciliation evidence is too large.",
        413,
      );
    }
    throw invalidRequest();
  }
  if (
    !isPlainRecord(value)
    || !hasOnlyKeys(value, ["claimId", "evidence"])
    || !isUuid(value.claimId)
    || !isPlainRecord(value.evidence)
    || !hasOnlyKeys(value.evidence, ["observedAt", "statements"])
    || typeof value.evidence.observedAt !== "string"
    || !Array.isArray(value.evidence.statements)
    || value.evidence.statements.length < 1
    || value.evidence.statements.length > 50
  ) {
    throw invalidRequest();
  }
  const observedAt = new Date(value.evidence.observedAt);
  if (
    !Number.isFinite(observedAt.getTime())
    || observedAt.toISOString() !== value.evidence.observedAt
    || observedAt.getTime() > Date.now()
  ) {
    throw invalidRequest();
  }
  const seen = new Set<string>();
  const statements = value.evidence.statements.map((statement) => {
    if (
      !isPlainRecord(statement)
      || !hasOnlyKeys(statement, ["statementId", "status"])
      || !isUuid(statement.statementId)
      || (statement.status !== "stored" && statement.status !== "absent")
    ) {
      throw invalidRequest();
    }
    const statementId = statement.statementId.toLowerCase();
    if (seen.has(statementId)) {
      throw invalidRequest();
    }
    seen.add(statementId);
    return {
      statementId,
      status: statement.status as "stored" | "absent",
    };
  });
  return {
    claimId: value.claimId.toLowerCase(),
    evidence: {
      observedAt: value.evidence.observedAt,
      statements,
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

function isUuid(value: unknown): value is string {
  return typeof value === "string"
    && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
      .test(value);
}

function invalidRequest() {
  return requestError(
    "AAIS_LRS_DELIVERY_RECONCILIATION_INVALID",
    "AAIS LRS delivery reconciliation evidence is invalid.",
    400,
  );
}

function invalidListRequest() {
  return requestError(
    "AAIS_LRS_DELIVERY_RECONCILIATION_LIST_INVALID",
    "AAIS LRS delivery reconciliation list parameters are invalid.",
    400,
  );
}

function requestError(code: string, message: string, status: 400 | 413) {
  return new AaisApiRouteError({ code, message, status });
}

class AaisLrsDeliveryReconciliationAuthorizationError extends Error {
  constructor() {
    super("AAIS LRS delivery reconciliation requires administrator authorization.");
    this.name = "AaisLrsDeliveryReconciliationAuthorizationError";
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
  if (error instanceof AaisLrsDeliveryReconciliationAuthorizationError) {
    return {
      code: "AAIS_LRS_DELIVERY_RECONCILIATION_FORBIDDEN",
      message: "AAIS LRS delivery reconciliation requires administrator authorization.",
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
  if (isAaisLrsDeliveryReconciliationConflictError(error)) {
    return {
      code: "AAIS_LRS_DELIVERY_RECONCILIATION_CONFLICT",
      message: "AAIS LRS delivery reconciliation evidence conflicts with the current attempt.",
      status: 409,
    };
  }
  if (isAaisLrsDeliveryReconciliationStoreError(error)) {
    return {
      code: "AAIS_LRS_DELIVERY_RECONCILIATION_NOT_READY",
      message: "AAIS LRS delivery reconciliation storage is not ready.",
      status: 503,
    };
  }
  return {
    code: "AAIS_LRS_DELIVERY_RECONCILIATION_FAILED",
    message: "AAIS LRS delivery reconciliation failed.",
    status: 500,
    cause: error,
  };
}

function createAuditOnce() {
  let recorded = false;
  return (event: Parameters<typeof recordAaisAuditEvent>[0]) => {
    if (recorded) {
      return;
    }
    recorded = true;
    recordAaisAuditEvent(event);
  };
}
