import { useEffect, useRef, useState } from "react";
import {
  clearArtifactDraftJournal,
  clientNowMs,
  createArtifactSaveEventDetail,
  isRetryableArtifactSaveError,
  writeArtifactDraftJournal,
  type ArtifactDraftJournal,
  type PendingArtifactSave,
} from "@/components/pages/learning/client-helpers";
import { artifactSaveDebounceMs } from "@/components/pages/learning/learning-page-constants";
import type { LearningCopy } from "@/components/pages/learning/learning-copy";
import {
  isAaisTextRevisionConflictClientError,
  patchLearningSessionKeepalive,
  type LearningSessionPatchBody,
} from "@/components/pages/learning/learning-session-client";
import {
  admitAaisResearchAction,
  captureAaisResearchActorGeneration,
  classifyAaisResearchClientError,
  createAaisResearchOperationId,
  recordAaisResearchEvent,
} from "@/lib/client/aais-research-telemetry";

type UseLearningArtifactSaveOptions = {
  activeHistoryDocumentId: string | null;
  copy: LearningCopy;
  documentTitle: string;
  getArtifactRevision: (taskId: string) => number | null;
  initialDraftJournal: ArtifactDraftJournal | null;
  lastSavedArtifactLengthRef: { current: number };
  learnerDataGeneration: number | null;
  patchSession: (body: LearningSessionPatchBody) => Promise<unknown>;
  researchRequired: boolean;
  setBackendError: (value: string) => void;
  studentId: string;
};

export function useLearningArtifactSave({
  activeHistoryDocumentId,
  copy,
  documentTitle,
  getArtifactRevision,
  initialDraftJournal,
  lastSavedArtifactLengthRef,
  learnerDataGeneration,
  patchSession,
  researchRequired,
  setBackendError,
  studentId,
}: UseLearningArtifactSaveOptions) {
  const documentTitleRef = useRef(initialDraftJournal?.title ?? "");
  const [artifactSaveBusy, setArtifactSaveBusy] = useState(false);
  const [artifactSaveStatus, setArtifactSaveStatus] = useState(
    () => initialDraftJournal ? copy.document.saveQueued : "",
  );
  const [artifactSaveError, setArtifactSaveError] = useState("");
  const artifactSaveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const artifactSaveInFlightRef = useRef<PendingArtifactSave | null>(null);
  const artifactSaveRevisionRef = useRef(
    initialDraftJournal ? Math.max(1, initialDraftJournal.revision) : 0,
  );
  const archiveIntentRef = useRef(false);
  const workbenchMountedRef = useRef(true);
  const flushPendingArtifactSaveRef = useRef<(trigger?: string) => boolean>(() => false);
  const pendingArtifactSaveRef = useRef<PendingArtifactSave | null>(
    initialDraftJournal
      ? {
          activeDocumentId: initialDraftJournal.activeDocumentId ?? null,
          documentTitle: initialDraftJournal.title,
          expectedArtifactRevision: Number.isSafeInteger(
            initialDraftJournal.expectedArtifactRevision,
          ) && Number(initialDraftJournal.expectedArtifactRevision) >= 0
            ? Number(initialDraftJournal.expectedArtifactRevision)
            : null,
          mutationId: initialDraftJournal.mutationId
            ?? createAaisResearchOperationId("artifact-mutation"),
          retryCount: 0,
          revision: Math.max(1, initialDraftJournal.revision),
          revisionLocked: true,
          taskId: initialDraftJournal.taskId,
          value: initialDraftJournal.value,
        }
      : null,
  );

  useEffect(() => {
    documentTitleRef.current = documentTitle;
  }, [documentTitle]);

  function flushPendingArtifactSave(trigger = "manual") {
    if (archiveIntentRef.current) {
      return true;
    }
    const queuedPending = pendingArtifactSaveRef.current;
    if (artifactSaveTimerRef.current) {
      clearTimeout(artifactSaveTimerRef.current);
      artifactSaveTimerRef.current = null;
    }
    if (!queuedPending) {
      return true;
    }
    if (artifactSaveInFlightRef.current) {
      setArtifactSaveStatus(copy.document.saveQueuedWhileSaving);
      return true;
    }
    const currentArtifactRevision = getArtifactRevision(queuedPending.taskId);
    const expectedArtifactRevision = queuedPending.revisionLocked
      ? queuedPending.expectedArtifactRevision
      : currentArtifactRevision ?? queuedPending.expectedArtifactRevision;
    if (expectedArtifactRevision === null) {
      pendingArtifactSaveRef.current = queuedPending;
      setArtifactSaveStatus(copy.document.saveQueued);
      return true;
    }
    const pending: PendingArtifactSave = {
      ...queuedPending,
      expectedArtifactRevision,
      revisionLocked: true,
    };
    const operationId = createAaisResearchOperationId("artifact-save");
    const telemetryActorGeneration = captureAaisResearchActorGeneration();
    const startedAt = clientNowMs();
    const previousCharacters = lastSavedArtifactLengthRef.current;
    const eventDetail = createArtifactSaveEventDetail({
      operationId,
      pending,
      previousCharacters,
      trigger,
    });
    if (!admitAaisResearchAction({
      actorGeneration: telemetryActorGeneration,
      eventName: "document_artifact_save",
      outcome: "attempted",
      detail: eventDetail,
    })) {
      pendingArtifactSaveRef.current = pending;
      setArtifactSaveStatus(copy.document.saveResearchPaused);
      return false;
    }
    pendingArtifactSaveRef.current = null;
    artifactSaveInFlightRef.current = pending;
    if (!researchRequired) {
      writeArtifactDraftJournal(studentId, {
        activeDocumentId: pending.activeDocumentId,
        expectedArtifactRevision,
        mutationId: pending.mutationId,
        revision: pending.revision,
        taskId: pending.taskId,
        title: pending.documentTitle,
        value: pending.value,
      });
    }
    let retrySameRevision = false;
    let stopQueuedAfterConflict = false;
    setArtifactSaveBusy(true);
    setArtifactSaveStatus(copy.document.saving);
    setArtifactSaveError("");
    void patchSession({
      action: "save-artifact",
      activeDocumentId: pending.activeDocumentId,
      documentTitle: pending.documentTitle,
      expectedArtifactRevision,
      mutationId: pending.mutationId,
      taskId: pending.taskId,
      artifactText: pending.value,
    })
      .then(() => {
        if (!workbenchMountedRef.current) {
          return;
        }
        lastSavedArtifactLengthRef.current = pending.value.length;
        const isLatest = pending.revision === artifactSaveRevisionRef.current
          && !pendingArtifactSaveRef.current;
        if (isLatest) {
          setArtifactSaveStatus(copy.document.saved);
          clearArtifactDraftJournal(studentId);
        }
        recordAaisResearchEvent({
          actorGeneration: telemetryActorGeneration,
          eventName: "document_artifact_save",
          outcome: "success",
          latencyMs: clientNowMs() - startedAt,
          detail: eventDetail,
        });
      })
      .catch((error) => {
        if (!workbenchMountedRef.current) {
          return;
        }
        const newerPending = pendingArtifactSaveRef.current
          && pendingArtifactSaveRef.current.revision > pending.revision
          ? pendingArtifactSaveRef.current
          : null;
        if (isAaisTextRevisionConflictClientError(error)) {
          const preserved = {
            ...(newerPending ?? pending),
            expectedArtifactRevision: pending.expectedArtifactRevision,
            revisionLocked: true,
          };
          pendingArtifactSaveRef.current = preserved;
          if (!researchRequired) {
            writeArtifactDraftJournal(studentId, {
              activeDocumentId: preserved.activeDocumentId,
              expectedArtifactRevision: preserved.expectedArtifactRevision ?? undefined,
              mutationId: preserved.mutationId,
              revision: preserved.revision,
              taskId: preserved.taskId,
              title: preserved.documentTitle,
              value: preserved.value,
            });
          }
          stopQueuedAfterConflict = true;
          const message = copy.document.saveFailed;
          setBackendError(message);
          setArtifactSaveStatus("");
          setArtifactSaveError(message);
        }
        const shouldRetry = !stopQueuedAfterConflict
          && !newerPending
          && pending.revision === artifactSaveRevisionRef.current
          && pending.retryCount < 1
          && isRetryableArtifactSaveError(error);
        if (shouldRetry) {
          pendingArtifactSaveRef.current = {
            ...pending,
            retryCount: pending.retryCount + 1,
          };
          retrySameRevision = true;
          setArtifactSaveStatus(copy.document.saveQueued);
          setArtifactSaveError("");
        } else if (!stopQueuedAfterConflict && !newerPending) {
          pendingArtifactSaveRef.current = pending;
          const message = copy.document.saveFailed;
          setBackendError(message);
          setArtifactSaveStatus("");
          setArtifactSaveError(message);
        }
        recordAaisResearchEvent({
          actorGeneration: telemetryActorGeneration,
          eventName: "document_artifact_save",
          outcome: "failure",
          latencyMs: clientNowMs() - startedAt,
          detail: {
            ...eventDetail,
            error_kind: classifyAaisResearchClientError(error),
          },
        });
      })
      .finally(() => {
        artifactSaveInFlightRef.current = null;
        if (!workbenchMountedRef.current) {
          return;
        }
        setArtifactSaveBusy(false);
        const queued = pendingArtifactSaveRef.current;
        if (
          !stopQueuedAfterConflict
          && queued
          && (retrySameRevision || queued.revision > pending.revision)
        ) {
          flushPendingArtifactSave("queued");
        }
      });
    return true;
  }
  flushPendingArtifactSaveRef.current = flushPendingArtifactSave;

  function scheduleArtifactSave(
    taskId: string,
    value: string,
    metadata: {
      activeDocumentId?: string | null;
      documentTitle?: string;
    } = {},
  ) {
    const revision = artifactSaveRevisionRef.current + 1;
    artifactSaveRevisionRef.current = revision;
    const pendingDocumentTitle = metadata.documentTitle ?? documentTitleRef.current;
    const pendingActiveDocumentId = metadata.activeDocumentId === undefined
      ? activeHistoryDocumentId
      : metadata.activeDocumentId;
    const mutationId = createAaisResearchOperationId("artifact-mutation");
    const expectedArtifactRevision = getArtifactRevision(taskId);
    setArtifactSaveStatus(copy.document.saveQueued);
    setArtifactSaveError("");
    pendingArtifactSaveRef.current = {
      activeDocumentId: pendingActiveDocumentId,
      documentTitle: pendingDocumentTitle,
      expectedArtifactRevision,
      mutationId,
      retryCount: 0,
      revision,
      revisionLocked: false,
      taskId,
      value,
    };
    if (!researchRequired) {
      writeArtifactDraftJournal(studentId, {
        activeDocumentId: pendingActiveDocumentId,
        ...(expectedArtifactRevision === null
          ? {}
          : { expectedArtifactRevision }),
        mutationId,
        revision,
        taskId,
        title: pendingDocumentTitle,
        value,
      });
    }
    if (artifactSaveTimerRef.current) {
      clearTimeout(artifactSaveTimerRef.current);
    }
    artifactSaveTimerRef.current = setTimeout(
      () => flushPendingArtifactSave("debounce"),
      artifactSaveDebounceMs,
    );
  }

  function cancelPendingArtifactSave() {
    if (artifactSaveTimerRef.current) {
      clearTimeout(artifactSaveTimerRef.current);
      artifactSaveTimerRef.current = null;
    }
    pendingArtifactSaveRef.current = null;
  }

  function restorePendingArtifactSave(
    taskId: string,
    value: string,
    options: { defer?: boolean } = {},
  ) {
    scheduleArtifactSave(taskId, value);
    if (options.defer && artifactSaveTimerRef.current) {
      clearTimeout(artifactSaveTimerRef.current);
      artifactSaveTimerRef.current = null;
    }
  }

  function resetArtifactSaveState() {
    archiveIntentRef.current = false;
    artifactSaveRevisionRef.current += 1;
    clearArtifactDraftJournal(studentId);
    setArtifactSaveStatus("");
    setArtifactSaveError("");
    if (artifactSaveTimerRef.current) {
      clearTimeout(artifactSaveTimerRef.current);
      artifactSaveTimerRef.current = null;
    }
    pendingArtifactSaveRef.current = null;
    documentTitleRef.current = "";
  }

  function completeArtifactArchive() {
    documentTitleRef.current = "";
    clearArtifactDraftJournal(studentId);
  }

  useEffect(() => {
    workbenchMountedRef.current = true;
    if (pendingArtifactSaveRef.current && !artifactSaveTimerRef.current) {
      artifactSaveTimerRef.current = setTimeout(
        () => flushPendingArtifactSaveRef.current("recovery"),
        artifactSaveDebounceMs,
      );
    }
    return () => {
      workbenchMountedRef.current = false;
      if (artifactSaveTimerRef.current) {
        clearTimeout(artifactSaveTimerRef.current);
      }
    };
  }, []);

  useEffect(() => {
    const getUncommittedSave = () =>
      pendingArtifactSaveRef.current ?? artifactSaveInFlightRef.current;
    const handleBeforeUnload = (event: BeforeUnloadEvent) => {
      if (!getUncommittedSave()) {
        return;
      }
      event.preventDefault();
      event.returnValue = "";
    };
    const handlePageHide = () => {
      const pending = getUncommittedSave();
      if (!pending) {
        return;
      }
      if (learnerDataGeneration === null) {
        // A normal request is only a best-effort fallback during teardown, but
        // it is still safer than silently dropping a draft that cannot yet be
        // bound to a learner-data generation.
        flushPendingArtifactSaveRef.current("pagehide-generation-fallback");
        return;
      }
      const expectedArtifactRevision = pending.revisionLocked
        ? pending.expectedArtifactRevision
        : getArtifactRevision(pending.taskId) ?? pending.expectedArtifactRevision;
      if (expectedArtifactRevision === null) {
        flushPendingArtifactSaveRef.current("pagehide-revision-fallback");
        return;
      }
      const keepaliveAccepted = patchLearningSessionKeepalive({
        action: "save-artifact",
        activeDocumentId: pending.activeDocumentId,
        documentTitle: pending.documentTitle,
        expectedArtifactRevision,
        mutationId: pending.mutationId,
        taskId: pending.taskId,
        artifactText: pending.value,
        dataGeneration: learnerDataGeneration,
      });
      if (!keepaliveAccepted) {
        // Browsers cap keepalive request bodies. Oversized drafts therefore
        // fall back to the existing normal save path. The request remains
        // best-effort once navigation has started, and beforeunload continues
        // to warn while it is uncommitted.
        flushPendingArtifactSaveRef.current("pagehide-keepalive-fallback");
      }
    };
    const handleVisibilityChange = () => {
      if (document.visibilityState === "hidden") {
        // Start the ordinary request before page teardown. This materially
        // improves the chance that a large research draft finishes without
        // ever persisting its raw text in Web Storage.
        flushPendingArtifactSaveRef.current("visibility-hidden");
      }
    };
    window.addEventListener("beforeunload", handleBeforeUnload);
    window.addEventListener("pagehide", handlePageHide);
    document.addEventListener("visibilitychange", handleVisibilityChange);
    return () => {
      window.removeEventListener("beforeunload", handleBeforeUnload);
      window.removeEventListener("pagehide", handlePageHide);
      document.removeEventListener("visibilitychange", handleVisibilityChange);
    };
  }, [getArtifactRevision, learnerDataGeneration]);

  return {
    archiveIntentRef,
    artifactSaveBusy,
    artifactSaveError,
    artifactSaveStatus,
    cancelPendingArtifactSave,
    completeArtifactArchive,
    documentTitleRef,
    flushPendingArtifactSave,
    hasPendingArtifactSave: () => Boolean(pendingArtifactSaveRef.current),
    hasUncommittedArtifactSave: () => Boolean(
      pendingArtifactSaveRef.current || artifactSaveInFlightRef.current,
    ),
    isOperationCurrent: () => workbenchMountedRef.current,
    resetArtifactSaveState,
    restorePendingArtifactSave,
    scheduleArtifactSave,
    setArtifactSaveBusy,
    setArtifactSaveError,
    setArtifactSaveStatus,
  };
}
