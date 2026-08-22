import { NextResponse } from "next/server";
import {
  AaisResearchValidationError,
  assertAaisResearchModeEnabled,
} from "@/lib/server/aais-research-contract";
import {
  createAaisResearchErrorResponse,
  type AaisResearchAuditAuthMode,
} from "@/lib/server/aais-research-api";
import { getAaisResearchStore } from "@/lib/server/aais-research-store";
import { requireAaisSessionActor } from "@/lib/server/aais-request-auth";
import { requireAaisCsrf } from "@/lib/server/aais-csrf";

export async function GET(request: Request) {
  let authMode: AaisResearchAuditAuthMode = "none";
  try {
    assertAaisResearchModeEnabled();
    const actor = await requireAaisSessionActor(request);
    authMode = "session";
    requireAaisCsrf(request, actor.id);
    const url = new URL(request.url);
    const studyRunId = url.searchParams.get("studyRunId") ?? "";
    const format = readExportFormat(url.searchParams);
    const purpose = url.searchParams.get("purpose") ?? "";
    const rawLimit = url.searchParams.get("limit");
    const limit = rawLimit ? Number(rawLimit) : undefined;
    const exported = await getAaisResearchStore().exportEvents({
      actor,
      studyRunId,
      format,
      purpose: purpose as "approved_analysis" | "reconciliation" | "quality_audit" | "replication",
      limit,
    });
    return new NextResponse(exported.body, {
      headers: {
        "cache-control": "no-store",
        "content-type": exported.contentType,
        "content-disposition": `attachment; filename="${exported.fileName}"`,
        "x-aais-research-row-count": String(exported.rowCount),
        "x-aais-research-file-sha256": exported.fileSha256,
      },
    });
  } catch (error) {
    return createAaisResearchErrorResponse({
      error,
      route: "/api/research/events/export",
      operation: "events.export",
      authMode,
    });
  }
}

function readExportFormat(params: URLSearchParams): "json" | "csv" {
  const value = params.get("format")?.trim();
  if (!value) {
    return "json";
  }
  if (value === "json" || value === "csv") {
    return value;
  }
  throw new AaisResearchValidationError("AAIS research export format is invalid.");
}
