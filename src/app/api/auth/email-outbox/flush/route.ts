import { timingSafeEqual } from "node:crypto";
import { NextResponse } from "next/server";
import {
  flushAaisAuthEmailOutbox,
  isAaisAuthDeliveryConfigurationError,
  isAaisAuthEmailOutboxStoreError,
} from "@/lib/server/aais-auth-delivery";
import { isAaisStrongOpaqueSecret } from "@/lib/server/aais-opaque-secret";
import { recordAaisAuditEvent } from "@/lib/server/aais-audit-log";
import { recordAaisMonitoringIssue } from "@/lib/server/aais-monitoring";
import {
  acquireAaisRuntimeLease,
  assertAaisRuntimeLeaseHeld,
  isAaisRuntimeLeaseUnavailableError,
  releaseAaisRuntimeLease,
} from "@/lib/server/aais-runtime-lease";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
// The worker stops dispatching provider calls within 20 seconds. The wider
// function cap leaves room for bounded Postgres claim/finalize queries.
export const maxDuration = 120;

const privateHeaders = { "cache-control": "private, no-store" } as const;

export async function GET(request: Request) {
  return handleFlush(request);
}

export async function POST(request: Request) {
  return handleFlush(request);
}

async function handleFlush(request: Request) {
  if (!hasValidWorkerBearer(request)) {
    return NextResponse.json(
      {
        error: {
          code: "AAIS_AUTH_EMAIL_OUTBOX_UNAUTHORIZED",
          message: "AAIS authentication email outbox authorization is required.",
        },
      },
      { status: 401, headers: privateHeaders },
    );
  }
  let lease: Awaited<ReturnType<typeof acquireAaisRuntimeLease>> | null = null;
  try {
    lease = await acquireAaisRuntimeLease("auth-email-outbox");
    if (lease.status === "standby") {
      return NextResponse.json(
        {
          status: "standby",
          lease: "held_by_peer",
          secrets: "redacted",
        },
        { status: 202, headers: privateHeaders },
      );
    }
    await assertAaisRuntimeLeaseHeld(lease);
    const report = await flushAaisAuthEmailOutbox({
      beforeDispatch: () => assertAaisRuntimeLeaseHeld(lease!),
    });
    const deliveryDegraded = report.retry > 0 || report.deadLetter > 0;
    recordAaisAuditEvent({
      event: "auth.email_outbox.flush",
      actorId: "auth-email-worker",
      outcome: deliveryDegraded ? "failure" : "success",
      metadata: { ...report },
    });
    if (deliveryDegraded) {
      recordAaisMonitoringIssue({
        event: "aais.auth_email_outbox.degraded",
        message: report.deadLetter > 0
          ? "AAIS authentication email outbox has dead-letter deliveries."
          : "AAIS authentication email outbox has retryable delivery failures.",
        status: 503,
        route: "/api/auth/email-outbox/flush",
        tags: {
          "aais.outbox_status": report.deadLetter > 0 ? "dead_letter" : "retry",
        },
        extra: {
          claimed: report.claimed,
          sent: report.sent,
          retry: report.retry,
          deadLetter: report.deadLetter,
          stale: report.stale,
          deferred: report.deferred,
          hasMore: report.hasMore,
          stoppedReason: report.stoppedReason,
          secrets: "redacted",
        },
      });
    }
    return NextResponse.json(
      deliveryDegraded
        ? { ...report, status: "degraded" as const }
        : report,
      {
        status: deliveryDegraded ? 502 : 200,
        headers: privateHeaders,
      },
    );
  } catch (error) {
    if (
      isAaisAuthDeliveryConfigurationError(error)
      || isAaisAuthEmailOutboxStoreError(error)
      || isAaisRuntimeLeaseUnavailableError(error)
    ) {
      recordAaisMonitoringIssue({
        event: "aais.auth_email_outbox.not_ready",
        message: "AAIS authentication email outbox is not ready.",
        status: 503,
        route: "/api/auth/email-outbox/flush",
        tags: { "aais.outbox_status": "not_ready" },
        extra: { secrets: "redacted" },
      });
      return NextResponse.json(
        {
          error: {
            code: "AAIS_AUTH_EMAIL_OUTBOX_NOT_READY",
            message: "AAIS authentication email outbox is not ready.",
          },
        },
        { status: 503, headers: privateHeaders },
      );
    }
    console.error("AAIS auth email outbox flush failed.", {
      error_kind: "auth_email_outbox_flush_failed",
    });
    recordAaisMonitoringIssue({
      event: "aais.auth_email_outbox.failed",
      message: "AAIS authentication email outbox flush failed.",
      status: 500,
      route: "/api/auth/email-outbox/flush",
      tags: { "aais.outbox_status": "failed" },
      extra: { secrets: "redacted" },
    });
    return NextResponse.json(
      {
        error: {
          code: "AAIS_AUTH_EMAIL_OUTBOX_FLUSH_FAILED",
          message: "AAIS authentication email outbox flush failed.",
        },
      },
      { status: 500, headers: privateHeaders },
    );
  } finally {
    if (lease?.status === "acquired") {
      await releaseAaisRuntimeLease(lease);
    }
  }
}

function hasValidWorkerBearer(request: Request) {
  const match = request.headers.get("authorization")?.match(/^Bearer ([^\s]+)$/);
  if (!match) {
    return false;
  }
  const candidate = match[1];
  const accepted = [
    process.env.AAIS_AUTH_EMAIL_OUTBOX_FLUSH_TOKEN,
    process.env.CRON_SECRET,
  ]
    .map((value) => value?.trim() ?? "")
    .filter((value, index, values) =>
      isAaisStrongOpaqueSecret(value) && values.indexOf(value) === index
    );
  return accepted.some((secret) => constantTimeEqual(candidate, secret));
}

function constantTimeEqual(left: string, right: string) {
  const leftBuffer = Buffer.from(left, "utf8");
  const rightBuffer = Buffer.from(right, "utf8");
  return leftBuffer.length === rightBuffer.length
    && timingSafeEqual(leftBuffer, rightBuffer);
}
