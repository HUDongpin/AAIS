import { useRef, type Dispatch, type SetStateAction } from "react";
import { getLearningCopy } from "@/components/pages/learning/learning-copy";
import { createHistoryDocument } from "@/components/pages/learning/document-markdown";
import type { LearningSessionPatchBody } from "@/components/pages/learning/learning-session-client";
import type { AaisClientSession, ContentItemId, ContentTab } from "@/components/pages/learning/learning-page-types";
import { clientNowMs } from "@/components/pages/learning/client-helpers";
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
  artifactSaveBusy,
  artifactText,
  cancelPendingArtifactSave,
  documentTitle,
  hasPendingArtifactSave,
  locale,
  patchSession,
  restorePendingArtifactSave,
  setActiveContentId,
  setActiveHistoryDocumentId,
  setActiveTab,
  setArtifactSaveBusy,
  setArtifactSaveError,
  setArtifactSaveStatus,
  setDocumentCloseError,
  setDocumentTitle,
}: {
  activeHistoryDocumentId: string | null;
  activeTaskId: string;
  artifactSaveBusy: boolean;
  artifactText: string;
  cancelPendingArtifactSave: () => void;
  documentTitle: string;
  hasPendingArtifactSave: () => boolean;
  locale: Locale;
  patchSession: (body: LearningSessionPatchBody) => Promise<AaisClientSession>;
  restorePendingArtifactSave: (taskId: string, value: string) => void;
  setActiveContentId: Dispatch<SetStateAction<ContentItemId | null>>;
  setActiveHistoryDocumentId: Dispatch<SetStateAction<string | null>>;
  setActiveTab: Dispatch<SetStateAction<ContentTab>>;
  setArtifactSaveBusy: Dispatch<SetStateAction<boolean>>;
  setArtifactSaveError: Dispatch<SetStateAction<string>>;
  setArtifactSaveStatus: Dispatch<SetStateAction<string>>;
  setDocumentCloseError: Dispatch<SetStateAction<string>>;
  setDocumentTitle: Dispatch<SetStateAction<string>>;
}) {
  const copy = getLearningCopy(locale);
  const archiveInFlightRef = useRef(false);

  return async function saveAndCloseDocument() {
    if (artifactSaveBusy || archiveInFlightRef.current) {
      return;
    }
    archiveInFlightRef.current = true;
    const operationId = createAaisResearchOperationId("document-save-close");
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
      archiveInFlightRef.current = false;
      return;
    }
    cancelPendingArtifactSave();
    setArtifactSaveBusy(true);
    setArtifactSaveStatus(copy.document.saving);
    setArtifactSaveError("");
    setDocumentCloseError("");
    try {
      await patchSession({
        action: "archive-artifact",
        taskId: activeTaskId,
        activeDocumentId: activeHistoryDocumentId,
        document: archivedDocument
          ? {
              id: archivedDocument.id,
              taskId: archivedDocument.taskId,
              title: archivedDocument.title,
              html: archivedDocument.html,
              savedAt: archivedDocument.savedAt.toISOString(),
            }
          : null,
      });
      setDocumentTitle("");
      setActiveHistoryDocumentId(null);
      setActiveTab("display");
      setActiveContentId("history");
      setArtifactSaveStatus(copy.document.saved);
      recordAaisResearchEvent({
        actorGeneration,
        eventName: "document_save_closed",
        outcome: "success",
        latencyMs: clientNowMs() - startedAt,
        detail,
      });
    } catch (error) {
      restorePendingArtifactSave(activeTaskId, artifactText);
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
      archiveInFlightRef.current = false;
      setArtifactSaveBusy(false);
    }
  };
}
