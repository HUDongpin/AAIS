import { timingSafeEqual } from "node:crypto";
import { NextResponse } from "next/server";
import { isAaisCsrfError, requireAaisCsrf } from "@/lib/server/aais-csrf";
import { flushAaisPersistentLrsOutbox } from "@/lib/server/aais-learning-store";
import { isAaisAuthError, requireAaisSessionActor } from "@/lib/server/aais-request-auth";

type FlushAuthorization = {
  mode: "admin-session" | "bearer-token";
};

class AaisOutboxFlushAuthorizationError extends Error {
  constructor(message = "AAIS LRS outbox flush requires administrator authorization.") {
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
  try {
    const authorization = authorizeFlushRequest(request, input);
    const result = await flushAaisPersistentLrsOutbox({
      limit: readFlushLimit(new URL(request.url).searchParams.get("limit")),
    });
    return NextResponse.json(
      {
        authorization,
        outbox: sanitizeFlushResult(result),
        secrets: "redacted",
      },
      { status: result.status === "not_configured" ? 503 : 200 },
    );
  } catch (error) {
    return NextResponse.json(
      {
        error: error instanceof Error ? error.message : "AAIS LRS outbox flush failed.",
        secrets: "redacted",
      },
      { status: getErrorStatus(error) },
    );
  }
}

function authorizeFlushRequest(
  request: Request,
  input: {
    allowAdminSession: boolean;
  },
): FlushAuthorization {
  const bearer = readBearerToken(request.headers.get("authorization"));
  const configuredTokens = [
    process.env.AAIS_LRS_OUTBOX_FLUSH_TOKEN?.trim(),
    process.env.CRON_SECRET?.trim(),
  ].filter((token): token is string => Boolean(token));
  if (bearer) {
    if (configuredTokens.some((token) => tokenMatches(bearer, token))) {
      return { mode: "bearer-token" };
    }
    throw new AaisOutboxFlushAuthorizationError("AAIS LRS outbox flush bearer token is invalid.");
  }
  if (!input.allowAdminSession) {
    throw new AaisOutboxFlushAuthorizationError("AAIS LRS outbox flush bearer token is required.");
  }

  const actor = requireAaisSessionActor(request);
  if (actor.role !== "admin") {
    throw new AaisOutboxFlushAuthorizationError();
  }
  requireAaisCsrf(request, actor.id);
  return { mode: "admin-session" };
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

function sanitizeFlushResult(result: Awaited<ReturnType<typeof flushAaisPersistentLrsOutbox>>) {
  return {
    status: result.status,
    sent: result.sent,
    ...(typeof result.batches === "number" ? { batches: result.batches } : {}),
    ...(typeof result.failed === "number" ? { failed: result.failed } : {}),
    secrets: "redacted" as const,
  };
}

function getErrorStatus(error: unknown) {
  if (isAaisAuthError(error)) {
    return 401;
  }
  if (error instanceof AaisOutboxFlushAuthorizationError || isAaisCsrfError(error)) {
    return 403;
  }
  return 500;
}
