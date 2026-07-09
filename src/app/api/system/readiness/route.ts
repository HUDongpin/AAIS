import { timingSafeEqual } from "node:crypto";
import { NextResponse } from "next/server";
import { createAaisApiErrorResponse } from "@/lib/server/aais-api-error";
import { getAaisReadinessReport } from "@/lib/server/aais-readiness";
import { requireAaisSessionActor } from "@/lib/server/aais-request-auth";

export const dynamic = "force-dynamic";

export async function GET(request?: Request) {
  const report = await getAaisReadinessReport();
  const authorization = request ? await authorizeReadinessReport(request) : { status: "authorized" as const };
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
    return NextResponse.json(
      {
        status: report.status,
      },
      {
        status: report.status === "ready" ? 200 : 503,
        headers: {
          "cache-control": "no-store",
        },
      },
    );
  }
  return NextResponse.json(report, {
    status: report.status === "ready" ? 200 : 503,
    headers: {
      "cache-control": "no-store",
    },
  });
}

async function authorizeReadinessReport(
  request: Request,
): Promise<{ status: "authorized" | "public" | "forbidden" }> {
  const bearer = readBearerToken(request.headers.get("authorization"));
  if (bearer) {
    const configuredToken = process.env.AAIS_READINESS_BEARER_TOKEN?.trim();
    return configuredToken && tokenMatches(bearer, configuredToken)
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
