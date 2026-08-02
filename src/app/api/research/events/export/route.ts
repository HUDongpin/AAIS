import { NextResponse } from "next/server";
import { createAaisApiErrorResponse } from "@/lib/server/aais-api-error";
import { assertAaisResearchModeEnabled } from "@/lib/server/aais-research-contract";
import { getAaisResearchErrorResponseInput } from "@/lib/server/aais-research-api";
import { getAaisResearchStore } from "@/lib/server/aais-research-store";
import { requireAaisSessionActor } from "@/lib/server/aais-request-auth";
import { requireAaisCsrf } from "@/lib/server/aais-csrf";

export async function GET(request: Request) {
  try {
    assertAaisResearchModeEnabled();
    const actor = await requireAaisSessionActor(request);
    requireAaisCsrf(request, actor.id);
    const url = new URL(request.url);
    const studyRunId = url.searchParams.get("studyRunId") ?? "";
    const format = url.searchParams.get("format") === "csv" ? "csv" : "json";
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
    return createAaisApiErrorResponse(
      getAaisResearchErrorResponseInput(error, "/api/research/events/export"),
    );
  }
}
