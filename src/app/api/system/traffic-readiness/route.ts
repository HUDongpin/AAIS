import { NextResponse } from "next/server";
import {
  getAaisTrafficReadinessReport,
  type AaisTrafficReadinessReport,
} from "@/lib/server/aais-traffic-readiness";

export const dynamic = "force-dynamic";
const trafficReadinessDeadlineMs = 5_000;

export async function GET() {
  const report = await getReportWithinDeadline();
  return NextResponse.json(report, {
    status: report.status === "ready" ? 200 : 503,
    headers: {
      "cache-control": "no-store",
    },
  });
}

async function getReportWithinDeadline(): Promise<AaisTrafficReadinessReport> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      getAaisTrafficReadinessReport({ cacheTtlMs: 2_000 }),
      new Promise<AaisTrafficReadinessReport>((resolve) => {
        timeout = setTimeout(() => resolve({
          status: "not_ready",
          releaseId: null,
          provider: "unknown",
          deployment: "invalid",
          database: "unavailable",
          schema: "unavailable",
        }), trafficReadinessDeadlineMs);
      }),
    ]);
  } finally {
    if (timeout) {
      clearTimeout(timeout);
    }
  }
}
