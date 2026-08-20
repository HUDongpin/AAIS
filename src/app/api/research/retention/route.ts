import { timingSafeEqual } from "node:crypto";
import { NextResponse } from "next/server";
import { recordAaisAuditEvent } from "@/lib/server/aais-audit-log";
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
import {
  AaisResearchAuthorizationError,
  getAaisResearchStore,
  normalizeAaisResearchWorkerLimit,
} from "@/lib/server/aais-research-store";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const maxDuration = 60;

export async function POST(request: Request) {
  return handleRetention(request);
}

async function handleRetention(request: Request) {
  const authMode: AaisResearchAuditAuthMode = hasBearerAuthorization(request)
    ? "research-bearer"
    : "none";
  try {
    assertAaisResearchModeEnabled();
    authorize(request);
    const rawLimit = new URL(request.url).searchParams.get("limit");
    const limit = readRetentionWorkerLimit(rawLimit);
    const result = await getAaisResearchStore().runRetention(limit);
    const blocked = result.status === "blocked";
    if (blocked) {
      recordAaisAuditEvent({
        event: "research_retention_blocked",
        outcome: "failure",
        metadata: {
          authMode: "research-bearer",
          limit,
          blockedActiveVisitCount: result.blockedActiveVisitCount,
          staleRawTextWriteLeaseCount: result.staleRawTextWriteLeaseCount,
          stoppedReason: result.stoppedReason,
          hasMore: result.hasMore,
          secrets: "redacted",
        },
      });
      recordAaisMonitoringIssue({
        event: "aais.research_retention.blocked",
        message: "AAIS research retention is blocked by overdue active visits",
        status: 503,
        route: "/api/research/retention",
        tags: {
          "aais.auth_mode": "research-bearer",
        },
        extra: {
          blockedActiveVisitCount: result.blockedActiveVisitCount,
          staleRawTextWriteLeaseCount: result.staleRawTextWriteLeaseCount,
          stoppedReason: result.stoppedReason,
          hasMore: result.hasMore,
          secrets: "redacted",
        },
      });
    }
    return NextResponse.json(
      { result, secrets: "redacted" },
      {
        status: blocked ? 503 : 200,
        headers: { "cache-control": "no-store" },
      },
    );
  } catch (error) {
    return createAaisResearchErrorResponse({
      error,
      route: "/api/research/retention",
      operation: "retention.run",
      authMode,
    });
  }
}

function readRetentionWorkerLimit(value: string | null) {
  const normalized = value?.trim() ?? "";
  if (!normalized) {
    return normalizeAaisResearchWorkerLimit();
  }
  if (!/^[1-9][0-9]*$/.test(normalized)) {
    throw new AaisResearchValidationError("AAIS research worker limit is invalid.");
  }
  return normalizeAaisResearchWorkerLimit(Number(normalized));
}

function hasBearerAuthorization(request: Request) {
  return /^Bearer\s+[^\s]+$/i.test(
    request.headers.get("authorization")?.trim() ?? "",
  );
}

function authorize(request: Request) {
  const match = /^Bearer\s+([^\s]+)$/i.exec(
    request.headers.get("authorization")?.trim() ?? "",
  );
  const actual = match?.[1] ?? "";
  if (!actual) {
    throw new AaisResearchAuthorizationError();
  }
  const expected = process.env.AAIS_RESEARCH_RETENTION_TOKEN?.trim();
  if (!isAaisStrongOpaqueSecret(expected)) {
    throw new AaisResearchConfigurationError(
      "AAIS research retention token is not configured.",
    );
  }
  const actualBuffer = Buffer.from(actual);
  const expectedBuffer = Buffer.from(expected);
  if (
    actualBuffer.length !== expectedBuffer.length
    || !timingSafeEqual(actualBuffer, expectedBuffer)
  ) {
    throw new AaisResearchAuthorizationError();
  }
}
