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
    const body = await request.json().catch(() => null) as unknown;
    const event = await getAaisResearchStore().recordEvent(actor, body);
    return NextResponse.json(
      { event, secrets: "redacted" },
      {
        status: event.created ? 201 : 200,
        headers: { "cache-control": "no-store" },
      },
    );
  } catch (error) {
    return createAaisApiErrorResponse(
      getAaisResearchErrorResponseInput(error, "/api/research/events"),
    );
  }
}
