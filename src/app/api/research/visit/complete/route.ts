import { NextResponse } from "next/server";
import { createAaisApiErrorResponse } from "@/lib/server/aais-api-error";
import {
  AaisResearchValidationError,
  assertAaisResearchModeEnabled,
} from "@/lib/server/aais-research-contract";
import { requireAaisCsrf } from "@/lib/server/aais-csrf";
import { getAaisResearchErrorResponseInput } from "@/lib/server/aais-research-api";
import { requireAaisSessionActor } from "@/lib/server/aais-request-auth";
import { getAaisResearchStore } from "@/lib/server/aais-research-store";

export async function POST(request: Request) {
  try {
    assertAaisResearchModeEnabled();
    const actor = await requireAaisSessionActor(request);
    requireAaisCsrf(request, actor.id);
    const body = await request.json().catch(() => null) as unknown;
    if (!body || typeof body !== "object" || Array.isArray(body)) {
      throw new AaisResearchValidationError("AAIS research completion request is invalid.");
    }
    const keys = Object.keys(body);
    if (keys.length !== 1 || keys[0] !== "studyRunId") {
      throw new AaisResearchValidationError("AAIS research completion request is invalid.");
    }
    const completion = await getAaisResearchStore().completeStudyRun({
      actor,
      studyRunId: String((body as Record<string, unknown>).studyRunId ?? ""),
    });
    return NextResponse.json(
      { completion, secrets: "redacted" },
      { headers: { "cache-control": "no-store" } },
    );
  } catch (error) {
    return createAaisApiErrorResponse(
      getAaisResearchErrorResponseInput(error, "/api/research/visit/complete"),
    );
  }
}
