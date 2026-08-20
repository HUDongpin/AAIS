import { timingSafeEqual } from "node:crypto";
import { NextResponse } from "next/server";
import { createAaisApiErrorResponse } from "@/lib/server/aais-api-error";
import { getAaisReadinessReport } from "@/lib/server/aais-readiness";
import { requireAaisSessionActor } from "@/lib/server/aais-request-auth";
import { isAaisStrongOpaqueSecret } from "@/lib/server/aais-opaque-secret";

export const dynamic = "force-dynamic";
const publicReadyCacheTtlMs = 1_000;
const publicNotReadyCacheTtlMs = 5_000;
const readinessDeadlineMs = 5_000;
type AaisReadinessReport = Awaited<ReturnType<typeof getAaisReadinessReport>>;
let publicReadinessCache: {
  status: "ready" | "not_ready";
  expiresAt: number;
} | undefined;
let publicReadinessInFlight: Promise<"ready" | "not_ready"> | undefined;
let readinessReportInFlight: Promise<AaisReadinessReport> | undefined;

export async function GET(request: Request) {
  const authorization = await authorizeReadinessReport(request);
  if (authorization.status === "forbidden") {
    return createAaisApiErrorResponse({
      code: "AAIS_READINESS_FORBIDDEN",
      message: "AAIS readiness authorization failed.",
      status: 403,
      extra: { secrets: "redacted" },
      headers: {
        "cache-control": "no-store",
      },
    });
  }
  if (authorization.status === "public") {
    const status = await getPublicReadinessStatus();
    return NextResponse.json(
      {
        status,
      },
      {
        status: status === "ready" ? 200 : 503,
        headers: {
          "cache-control": "no-store",
        },
      },
    );
  }
  try {
    const report = await getReadinessReportWithinDeadline();
    return NextResponse.json(report, {
      status: report.status === "ready" ? 200 : 503,
      headers: {
        "cache-control": "no-store",
      },
    });
  } catch (error) {
    return createAaisApiErrorResponse({
      code: error instanceof AaisReadinessDeadlineError
        ? "AAIS_READINESS_TIMEOUT"
        : "AAIS_READINESS_UNAVAILABLE",
      message: error instanceof AaisReadinessDeadlineError
        ? "AAIS readiness checks exceeded their runtime budget."
        : "AAIS readiness checks are temporarily unavailable.",
      status: 503,
      cause: error,
      extra: { secrets: "redacted" },
      headers: {
        "cache-control": "no-store",
      },
      route: "/api/system/readiness",
    });
  }
}

async function getPublicReadinessStatus() {
  const now = Date.now();
  if (publicReadinessCache && publicReadinessCache.expiresAt > now) {
    return publicReadinessCache.status;
  }
  if (!publicReadinessInFlight) {
    publicReadinessInFlight = getReadinessReportWithinDeadline()
      .then((report) => report.status)
      .catch(() => "not_ready" as const)
      .then((status) => {
        publicReadinessCache = {
          status,
          expiresAt: Date.now() + (status === "ready"
            ? publicReadyCacheTtlMs
            : publicNotReadyCacheTtlMs),
        };
        return status;
      })
      .finally(() => {
        publicReadinessInFlight = undefined;
      });
  }
  return publicReadinessInFlight;
}

function getReadinessReportWithinDeadline() {
  return withReadinessDeadline(getReadinessReportSingleflight());
}

function getReadinessReportSingleflight() {
  if (readinessReportInFlight) {
    return readinessReportInFlight;
  }
  const pending = getAaisReadinessReport();
  readinessReportInFlight = pending;
  void pending.finally(() => {
    if (readinessReportInFlight === pending) {
      readinessReportInFlight = undefined;
    }
  }).catch(() => undefined);
  return pending;
}

async function withReadinessDeadline<T>(pending: Promise<T>): Promise<T> {
  let timeoutId: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_resolve, reject) => {
    timeoutId = setTimeout(() => reject(new AaisReadinessDeadlineError()), readinessDeadlineMs);
  });
  try {
    return await Promise.race([pending, deadline]);
  } finally {
    if (timeoutId !== undefined) {
      clearTimeout(timeoutId);
    }
  }
}

class AaisReadinessDeadlineError extends Error {
  constructor() {
    super("AAIS readiness checks exceeded their runtime budget.");
    this.name = "AaisReadinessDeadlineError";
  }
}

async function authorizeReadinessReport(
  request: Request,
): Promise<{ status: "authorized" | "public" | "forbidden" }> {
  const bearer = readBearerToken(request.headers.get("authorization"));
  if (bearer) {
    const configuredToken = process.env.AAIS_READINESS_BEARER_TOKEN?.trim();
    return isAaisStrongOpaqueSecret(configuredToken) && tokenMatches(bearer, configuredToken)
      ? { status: "authorized" }
      : { status: "forbidden" };
  }

  const cookieHeader = request.headers.get("cookie");
  if (!cookieHeader) {
    return { status: "public" };
  }
  try {
    const actor = await requireAaisSessionActor(request);
    return actor.role === "admin" ? { status: "authorized" } : { status: "public" };
  } catch {
    return { status: "public" };
  }
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
