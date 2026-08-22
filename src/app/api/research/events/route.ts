import { NextResponse } from "next/server";
import { assertAaisResearchModeEnabled } from "@/lib/server/aais-research-contract";
import {
  createAaisResearchErrorResponse,
  type AaisResearchAuditAuthMode,
} from "@/lib/server/aais-research-api";
import { getAaisResearchStore } from "@/lib/server/aais-research-store";
import { requireAaisSessionActor } from "@/lib/server/aais-request-auth";
import { requireAaisCsrf } from "@/lib/server/aais-csrf";
import {
  AaisRequestBodyError,
  readAaisBoundedJson,
} from "@/lib/server/aais-request-json";

const aaisResearchEventBodyMaxBytes = 16 * 1024;

export async function POST(request: Request) {
  let authMode: AaisResearchAuditAuthMode = "none";
  try {
    assertAaisResearchModeEnabled();
    const actor = await requireAaisSessionActor(request);
    authMode = "session";
    requireAaisCsrf(request, actor.id);
    const body = await readAaisBoundedJson(request, {
      maxBytes: aaisResearchEventBodyMaxBytes,
    });
    const event = await getAaisResearchStore().recordEvent(actor, body);
    return NextResponse.json(
      { event, secrets: "redacted" },
      {
        status: event.created ? 201 : 200,
        headers: { "cache-control": "no-store" },
      },
    );
  } catch (error) {
    if (error instanceof AaisRequestBodyError) {
      return createAaisResearchErrorResponse({
        error,
        route: "/api/research/events",
        operation: "event.record",
        authMode,
        responseInput: {
          code: error.reason === "too_large"
            ? "AAIS_RESEARCH_REQUEST_TOO_LARGE"
            : "AAIS_RESEARCH_REQUEST_INVALID",
          message: error.reason === "too_large"
            ? "AAIS research event request is too large."
            : "AAIS research event request is invalid.",
          status: error.status,
          extra: { secrets: "redacted" },
        },
      });
    }
    return createAaisResearchErrorResponse({
      error,
      route: "/api/research/events",
      operation: "event.record",
      authMode,
    });
  }
}
