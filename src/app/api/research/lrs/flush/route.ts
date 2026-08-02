import { timingSafeEqual } from "node:crypto";
import { NextResponse } from "next/server";
import { createAaisApiErrorResponse } from "@/lib/server/aais-api-error";
import {
  AaisResearchConfigurationError,
  AaisResearchValidationError,
  assertAaisResearchModeEnabled,
} from "@/lib/server/aais-research-contract";
import { getAaisResearchErrorResponseInput } from "@/lib/server/aais-research-api";
import {
  AaisResearchAuthorizationError,
  getAaisResearchStore,
} from "@/lib/server/aais-research-store";

export async function POST(request: Request) {
  return handleFlush(request);
}

async function handleFlush(request: Request) {
  try {
    assertAaisResearchModeEnabled();
    const authorization = authorize(request);
    const url = new URL(request.url);
    const action = url.searchParams.get("action") || "events";
    const rawLimit = url.searchParams.get("limit");
    const limit = rawLimit ? Number(rawLimit) : undefined;
    const store = getAaisResearchStore();
    const result = action === "events"
      ? await store.flushLrsOutbox(limit)
      : action === "deletions"
        ? await store.flushLrsDeletions(limit)
        : null;
    if (!result) {
      throw new AaisResearchValidationError("AAIS research LRS action is invalid.");
    }
    return NextResponse.json(
      {
        action,
        authorization,
        result,
        secrets: "redacted",
      },
      { headers: { "cache-control": "no-store" } },
    );
  } catch (error) {
    return createAaisApiErrorResponse(
      getAaisResearchErrorResponseInput(error, "/api/research/lrs/flush"),
    );
  }
}

function authorize(request: Request) {
  const bearer = readBearer(request.headers.get("authorization"));
  if (bearer) {
    const expected = process.env.AAIS_RESEARCH_LRS_OUTBOX_FLUSH_TOKEN?.trim();
    if (!expected) {
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
