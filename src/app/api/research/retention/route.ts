import { timingSafeEqual } from "node:crypto";
import { NextResponse } from "next/server";
import { createAaisApiErrorResponse } from "@/lib/server/aais-api-error";
import {
  AaisResearchConfigurationError,
  assertAaisResearchModeEnabled,
} from "@/lib/server/aais-research-contract";
import { getAaisResearchErrorResponseInput } from "@/lib/server/aais-research-api";
import {
  AaisResearchAuthorizationError,
  getAaisResearchStore,
} from "@/lib/server/aais-research-store";

export async function POST(request: Request) {
  return handleRetention(request);
}

async function handleRetention(request: Request) {
  try {
    assertAaisResearchModeEnabled();
    authorize(request);
    const rawLimit = new URL(request.url).searchParams.get("limit");
    const limit = rawLimit ? Number(rawLimit) : undefined;
    const result = await getAaisResearchStore().runRetention(limit);
    return NextResponse.json(
      { result, secrets: "redacted" },
      { headers: { "cache-control": "no-store" } },
    );
  } catch (error) {
    return createAaisApiErrorResponse(
      getAaisResearchErrorResponseInput(error, "/api/research/retention"),
    );
  }
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
  if (!expected) {
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
