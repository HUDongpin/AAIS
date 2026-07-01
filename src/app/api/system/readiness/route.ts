import { NextResponse } from "next/server";
import { getAaisReadinessReport } from "@/lib/server/aais-readiness";

export const dynamic = "force-dynamic";

export async function GET() {
  const report = await getAaisReadinessReport();
  return NextResponse.json(report, {
    status: report.status === "ready" ? 200 : 503,
    headers: {
      "cache-control": "no-store",
    },
  });
}
