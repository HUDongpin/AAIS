import { getAaisReleaseMetadata } from "@/lib/server/aais-deployment-metadata";
import {
  getAaisDatabaseConfiguration,
  probeAaisTrafficStorage,
} from "@/lib/server/aais-learning-store";
import { requiresAaisDurableStorage } from "@/lib/server/aais-runtime";

export type AaisTrafficReadinessReport = {
  status: "ready" | "not_ready";
  releaseId: string | null;
  provider: "aliyun" | "vercel" | "unknown";
  deployment: "valid" | "not_required" | "invalid";
  database: "ok" | "not_required" | "unavailable";
  schema: "current" | "not_required" | "unavailable";
};

let cachedTrafficReadiness: {
  expiresAt: number;
  report: AaisTrafficReadinessReport;
} | null = null;
let trafficReadinessInFlight: Promise<AaisTrafficReadinessReport> | null = null;

export async function getAaisTrafficReadinessReport(input: {
  cacheTtlMs?: number;
} = {}): Promise<AaisTrafficReadinessReport> {
  const cacheTtlMs = Math.max(0, Math.min(5_000, input.cacheTtlMs ?? 0));
  const now = Date.now();
  const cached = cachedTrafficReadiness;
  if (cacheTtlMs > 0 && cached && cached.expiresAt > now) {
    return cached.report;
  }
  if (cacheTtlMs > 0 && trafficReadinessInFlight) {
    return trafficReadinessInFlight;
  }
  const pending = computeAaisTrafficReadinessReport();
  if (cacheTtlMs === 0) {
    return pending;
  }
  trafficReadinessInFlight = pending;
  try {
    const report = await pending;
    cachedTrafficReadiness = {
      expiresAt: Date.now() + cacheTtlMs,
      report,
    };
    return report;
  } finally {
    trafficReadinessInFlight = null;
  }
}

async function computeAaisTrafficReadinessReport(): Promise<AaisTrafficReadinessReport> {
  const release = getAaisReleaseMetadata();
  const base = {
    releaseId: release.id,
    provider: release.deployment.provider,
  } as const;
  try {
    const durableStorageRequired = requiresAaisDurableStorage();
    if (
      durableStorageRequired
      && (
        release.deployment.provider === "unknown"
        || !release.id
        || !release.deployment.gitCommit.present
      )
    ) {
      return createUnavailableReport(base);
    }
    const databaseConfiguration = getAaisDatabaseConfiguration();
    const databaseConfigured = Boolean(databaseConfiguration);
    if (!databaseConfigured && !durableStorageRequired) {
      return {
        status: "ready",
        ...base,
        deployment: "not_required",
        database: "not_required",
        schema: "not_required",
      };
    }
    if (!databaseConfigured) {
      return createUnavailableReport(base);
    }
    if (durableStorageRequired && databaseConfiguration?.sourceEnv !== "AAIS_DATABASE_URL") {
      return createUnavailableReport(base);
    }
    const expectedTargetId = process.env.AAIS_DATABASE_TARGET_ID?.trim() ?? "";
    if (!expectedTargetId) {
      return createUnavailableReport(base);
    }
    const probe = await probeAaisTrafficStorage({ expectedTargetId });
    if (probe.mode !== "postgres" || probe.status !== "connected") {
      return createUnavailableReport(base);
    }
    return {
      status: "ready",
      ...base,
      deployment: "valid",
      database: "ok",
      schema: "current",
    };
  } catch {
    return createUnavailableReport(base);
  }
}

function createUnavailableReport(base: {
  releaseId: string | null;
  provider: "aliyun" | "vercel" | "unknown";
}): AaisTrafficReadinessReport {
  return {
    status: "not_ready",
    ...base,
    deployment: "invalid",
    database: "unavailable",
    schema: "unavailable",
  };
}
