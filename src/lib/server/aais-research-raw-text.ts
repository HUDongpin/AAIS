import type { AaisSessionActor } from "@/lib/server/aais-session";
import { AaisApiRouteError } from "@/lib/server/aais-api-error";
import {
  AaisResearchConfigurationError,
  isAaisResearchModeEnabled,
  requiresAaisResearchDataPlaneIsolation,
} from "@/lib/server/aais-research-contract";
import { getAaisResearchStore } from "@/lib/server/aais-research-store";

export type AaisResearchRawTextWriteLease = {
  release: () => Promise<void>;
};

/**
 * Coordinates product-database raw-text writes with research withdrawal.
 * A withdrawal closes admission in the research database before deleting the
 * product copy, and cannot proceed while one of these leases is unreleased.
 * The database expiry is diagnostic only; it never fences out a slow writer.
 */
export async function acquireAaisResearchRawTextWriteLeaseIfRequired(
  actor: AaisSessionActor,
): Promise<AaisResearchRawTextWriteLease | null> {
  if (!requiresAaisResearchDataPlaneIsolation()) {
    return null;
  }
  if (!isAaisResearchModeEnabled()) {
    throw new AaisApiRouteError({
      code: "AAIS_RESEARCH_MODE_REQUIRED",
      message: "AAIS research collection is required but not enabled.",
      status: 503,
    });
  }

  const store = getAaisResearchStore();
  const lease = await store.acquireRawTextWriteLease(actor);
  let released = false;
  return {
    async release() {
      if (released) {
        return;
      }
      const didRelease = await store.releaseRawTextWriteLease(lease.leaseId);
      if (!didRelease) {
        throw new AaisResearchConfigurationError(
          "AAIS research raw-text write lease release was not acknowledged.",
        );
      }
      released = true;
    },
  };
}
