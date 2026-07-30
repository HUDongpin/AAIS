import { NextResponse } from "next/server";
import { createAaisApiErrorResponse } from "@/lib/server/aais-api-error";
import { assertAaisResearchModeEnabled } from "@/lib/server/aais-research-contract";
import { getAaisResearchErrorResponseInput } from "@/lib/server/aais-research-api";
import { getAaisResearchStore } from "@/lib/server/aais-research-store";
import { requireAaisSessionActor } from "@/lib/server/aais-request-auth";
import { requireAaisCsrf } from "@/lib/server/aais-csrf";

export async function POST(request: Request) {
  try {
    assertAaisResearchModeEnabled();
    const actor = await requireAaisSessionActor(request);
    requireAaisCsrf(request, actor.id);
    const visit = await getAaisResearchStore().getOrCreateVisit(actor);
    return NextResponse.json(
      { visit, secrets: "redacted" },
      { headers: { "cache-control": "no-store" } },
    );
  } catch (error) {
    return createAaisApiErrorResponse(
      getAaisResearchErrorResponseInput(error, "/api/research/visit"),
    );
  }
}
