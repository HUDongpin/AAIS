import { NextResponse } from "next/server";
import { assertAaisResearchModeEnabled } from "@/lib/server/aais-research-contract";
import {
  createAaisResearchErrorResponse,
  type AaisResearchAuditAuthMode,
} from "@/lib/server/aais-research-api";
import { getAaisResearchStore } from "@/lib/server/aais-research-store";
import { requireAaisSessionActor } from "@/lib/server/aais-request-auth";
import { requireAaisCsrf } from "@/lib/server/aais-csrf";

export async function POST(request: Request) {
  let authMode: AaisResearchAuditAuthMode = "none";
  try {
    assertAaisResearchModeEnabled();
    const actor = await requireAaisSessionActor(request);
    authMode = "session";
    requireAaisCsrf(request, actor.id);
    const visit = await getAaisResearchStore().getOrCreateVisit(actor);
    return NextResponse.json(
      { visit, secrets: "redacted" },
      { headers: { "cache-control": "no-store" } },
    );
  } catch (error) {
    return createAaisResearchErrorResponse({
      error,
      route: "/api/research/visit",
      operation: "visit.create",
      authMode,
    });
  }
}
