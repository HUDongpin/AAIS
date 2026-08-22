import type { Dispatch, MutableRefObject, SetStateAction } from "react";
import { getLearningCopy } from "@/components/pages/learning/learning-copy";
import { createHistoryDocument } from "@/components/pages/learning/document-markdown";
import type { LearningSessionPatchBody } from "@/components/pages/learning/learning-session-client";
import { isAaisTextRevisionConflictClientError } from "@/components/pages/learning/learning-session-client";
import type { AaisClientSession, ContentItemId, ContentTab } from "@/components/pages/learning/learning-page-types";
import {
  clientNowMs,
  isRetryableArtifactSaveError,
} from "@/components/pages/learning/client-helpers";
import {
  admitAaisResearchAction,
  captureAaisResearchActorGeneration,
  classifyAaisResearchClientError,
  createAaisResearchOperationId,
  recordAaisResearchEvent,
} from "@/lib/client/aais-research-telemetry";
import type { Locale } from "@/data/aais";

export function useLearningDocumentArchive({
  activeHistoryDocumentId,
  activeTaskId,
  archiveIntentRef,
  artifactSaveBusy,
  artifactText,
  cancelPendingArtifactSave,
  documentTitle,
  hasPendingArtifactSave,
  isOperationCurrent,
  locale,
  onArchiveSucceeded,
  patchSession,
  restorePendingArtifactSave,
  setActiveContentId,
  setActiveHistoryDocumentId,
  setActiveTab,
  setArtifactSaveBusy,
  setArtifactSaveError,
  setArtifactSaveStatus,
  setDocumentArchiveBusy,
  setDocumentCloseError,
  setDocumentTitle,
}: {
  activeHistoryDocumentId: string | null;
  activeTaskId: string;
  archiveIntentRef: MutableRefObject<boolean>;
  artifactSaveBusy: boolean;
  artifactText: string;
  cancelPendingArtifactSave: () => void;
  documentTitle: string;
  hasPendingArtifactSave: () => boolean;
  isOperationCurrent: () => boolean;
  locale: Locale;
  onArchiveSucceeded: () => void;
  patchSession: (body: LearningSessionPatchBody) => Promise<AaisClientSession>;
  restorePendingArtifactSave: (
    taskId: string,
    value: string,
    options?: { defer?: boolean },
  ) => void;
  setActiveContentId: Dispatch<SetStateAction<ContentItemId | null>>;
  setActiveHistoryDocumentId: Dispatch<SetStateAction<string | null>>;
  setActiveTab: Dispatch<SetStateAction<ContentTab>>;
  setArtifactSaveBusy: Dispatch<SetStateAction<boolean>>;
  setArtifactSaveError: Dispatch<SetStateAction<string>>;
  setArtifactSaveStatus: Dispatch<SetStateAction<string>>;
  setDocumentArchiveBusy: Dispatch<SetStateAction<boolean>>;
  setDocumentCloseError: Dispatch<SetStateAction<string>>;
  setDocumentTitle: Dispatch<SetStateAction<string>>;
}) {
  const copy = getLearningCopy(locale);
  return async function saveAndCloseDocument() {
    if (artifactSaveBusy) {
      archiveIntentRef.current = false;
      return;
    }
    archiveIntentRef.current = true;
    const operationId = createAaisResearchOperationId("document-save-close");
    const mutationId = createAaisResearchOperationId("artifact-archive-mutation");
    const actorGeneration = captureAaisResearchActorGeneration();
    const startedAt = clientNowMs();
    const sourceHtml = artifactText.trim();
    const archivedDocument = sourceHtml || documentTitle.trim()
      ? createHistoryDocument({
          taskId: activeTaskId,
          title: documentTitle,
          html: sourceHtml,
          locale,
        })
      : null;
    const hadPendingSave = hasPendingArtifactSave();
    const detail = {
      operation_id: operationId,
      task_id: activeTaskId,
      pending_save: hadPendingSave,
      title_length: documentTitle.trim().length,
      artifact_length: artifactText.length,
    };
    if (!admitAaisResearchAction({
      actorGeneration,
      eventName: "document_save_closed",
      outcome: "attempted",
      detail,
    })) {
      archiveIntentRef.current = false;
      return;
    }
    cancelPendingArtifactSave();
    setDocumentArchiveBusy(true);
    setArtifactSaveBusy(true);
    setArtifactSaveStatus(copy.document.saving);
    setArtifactSaveError("");
    setDocumentCloseError("");
    try {
      const archiveRequest = {
        action: "archive-artifact",
        taskId: activeTaskId,
        activeDocumentId: activeHistoryDocumentId,
        mutationId,
        document: archivedDocument
          ? {
              id: activeHistoryDocumentId ?? archivedDocument.id,
              taskId: archivedDocument.taskId,
              title: archivedDocument.title,
              html: archivedDocument.html,
              savedAt: archivedDocument.savedAt.toISOString(),
            }
          : null,
      } satisfies LearningSessionPatchBody;
      try {
        await patchSession(archiveRequest);
      } catch (error) {
        if (!isRetryableArtifactSaveError(error)) {
          throw error;
        }
        await patchSession(archiveRequest);
      }
      if (!isOperationCurrent()) {
        return;
      }
      setDocumentTitle("");
      setActiveHistoryDocumentId(null);
      setActiveTab("display");
      setActiveContentId("history");
      setArtifactSaveStatus(copy.document.saved);
      onArchiveSucceeded();
      recordAaisResearchEvent({
        actorGeneration,
        eventName: "document_save_closed",
        outcome: "success",
        latencyMs: clientNowMs() - startedAt,
        detail,
      });
    } catch (error) {
      if (!isOperationCurrent()) {
        return;
      }
      restorePendingArtifactSave(activeTaskId, artifactText, {
        defer: isAaisTextRevisionConflictClientError(error),
      });
      setArtifactSaveStatus("");
      setDocumentCloseError(copy.document.archiveFailed);
      recordAaisResearchEvent({
        actorGeneration,
        eventName: "document_save_closed",
        outcome: "failure",
        latencyMs: clientNowMs() - startedAt,
        detail: {
          ...detail,
          error_kind: classifyAaisResearchClientError(error),
        },
      });
    } finally {
      archiveIntentRef.current = false;
      if (isOperationCurrent()) {
        setDocumentArchiveBusy(false);
        setArtifactSaveBusy(false);
      }
    }
  };
}
