import { useMemo, useSyncExternalStore } from "react";
import {
  readArtifactDraftJournal,
  type ArtifactDraftJournal,
} from "@/components/pages/learning/client-helpers";

export function useHydratedArtifactDraft(
  studentId: string,
  researchRequired: boolean,
): {
  hydrationReady: boolean;
  initialDraftJournal: ArtifactDraftJournal | null;
} {
  const hydrationReady = useSyncExternalStore(
    subscribeToHydration,
    getClientHydrationSnapshot,
    getServerHydrationSnapshot,
  );
  const initialDraftJournal = useMemo(
    () => hydrationReady && !researchRequired
      ? readArtifactDraftJournal(studentId)
      : null,
    [hydrationReady, researchRequired, studentId],
  );
  return { hydrationReady, initialDraftJournal };
}

function subscribeToHydration() {
  return () => undefined;
}

function getClientHydrationSnapshot() {
  return true;
}

function getServerHydrationSnapshot() {
  return false;
}
