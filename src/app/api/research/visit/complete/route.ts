import { NextResponse } from "next/server";
import {
  AaisResearchValidationError,
  assertAaisResearchModeEnabled,
} from "@/lib/server/aais-research-contract";
import { requireAaisCsrf } from "@/lib/server/aais-csrf";
import {
  createAaisResearchErrorResponse,
  type AaisResearchAuditAuthMode,
} from "@/lib/server/aais-research-api";
import { requireAaisSessionActor } from "@/lib/server/aais-request-auth";
import { getAaisResearchStore } from "@/lib/server/aais-research-store";
import {
  AaisRequestBodyError,
  readAaisBoundedJson,
} from "@/lib/server/aais-request-json";

const aaisResearchCompletionBodyMaxBytes = 1024;

export async function POST(request: Request) {
  let authMode: AaisResearchAuditAuthMode = "none";
  try {
    assertAaisResearchModeEnabled();
    const actor = await requireAaisSessionActor(request);
    authMode = "session";
    requireAaisCsrf(request, actor.id);
    const body = await readAaisBoundedJson(request, {
      maxBytes: aaisResearchCompletionBodyMaxBytes,
    });
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
    if (error instanceof AaisRequestBodyError) {
      return createAaisResearchErrorResponse({
        error,
        route: "/api/research/visit/complete",
        operation: "visit.complete",
        authMode,
        responseInput: {
          code: error.reason === "too_large"
            ? "AAIS_RESEARCH_REQUEST_TOO_LARGE"
            : "AAIS_RESEARCH_REQUEST_INVALID",
          message: error.reason === "too_large"
            ? "AAIS research completion request is too large."
            : "AAIS research completion request is invalid.",
          status: error.status,
          extra: { secrets: "redacted" },
        },
      });
    }
    return createAaisResearchErrorResponse({
      error,
      route: "/api/research/visit/complete",
      operation: "visit.complete",
      authMode,
    });
  }
}
