import { NextResponse } from "next/server";
import { getAaisReleaseMetadata } from "@/lib/server/aais-deployment-metadata";

export const dynamic = "force-dynamic";

export async function GET() {
  const release = getAaisReleaseMetadata();
  return NextResponse.json(
    {
      status: "live",
      releaseId: release.id,
      provider: release.deployment.provider,
    },
    {
      headers: {
        "cache-control": "no-store",
      },
    },
  );
}
