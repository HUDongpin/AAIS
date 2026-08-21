import { useState } from "react";
import {
  clientNowMs,
  isUserCancelledFilePicker,
} from "@/components/pages/learning/client-helpers";
import {
  createLearningDocumentFileName,
  createLearningDocumentMarkdown,
  saveMarkdownDocumentToLocal,
} from "@/components/pages/learning/document-markdown";
import { getLearningCopy } from "@/components/pages/learning/learning-copy";
import {
  admitAaisResearchAction,
  captureAaisResearchActorGeneration,
  classifyAaisResearchClientError,
  createAaisResearchOperationId,
  recordAaisResearchEvent,
} from "@/lib/client/aais-research-telemetry";
import type { Locale } from "@/data/aais";

type UseLearningDocumentDownloadInput = {
  artifactText: string;
  editingTaskId: string;
  flushPendingArtifactSave: (reason: "download") => boolean;
  locale: Locale;
  setBackendError: (message: string) => void;
};

export function useLearningDocumentDownload({
  artifactText,
  editingTaskId,
  flushPendingArtifactSave,
  locale,
  setBackendError,
}: UseLearningDocumentDownloadInput) {
  const copy = getLearningCopy(locale);
  const [documentDownloadBusy, setDocumentDownloadBusy] = useState(false);
  const [documentDownloadStatus, setDocumentDownloadStatus] = useState("");
  const [documentDownloadError, setDocumentDownloadError] = useState("");

  async function downloadDocumentToLocal() {
    if (documentDownloadBusy) {
      return;
    }
    const operationId = createAaisResearchOperationId("document-download");
    const telemetryActorGeneration = captureAaisResearchActorGeneration();
    const startedAt = clientNowMs();
    const downloadMethod = "showSaveFilePicker" in window ? "file_picker" : "browser_download";
    if (!flushPendingArtifactSave("download")) {
      return;
    }
    const downloadDetail = {
      operation_id: operationId,
      task_id: editingTaskId,
      download_method: downloadMethod,
      artifact_length: artifactText.length,
    };
    if (!admitAaisResearchAction({
      actorGeneration: telemetryActorGeneration,
      eventName: "document_download",
      outcome: "attempted",
      detail: downloadDetail,
    })) {
      return;
    }
    setDocumentDownloadBusy(true);
    setDocumentDownloadStatus(copy.document.downloadPreparing);
    setDocumentDownloadError("");
    try {
      await saveMarkdownDocumentToLocal({
        fileName: createLearningDocumentFileName(editingTaskId),
        markdown: createLearningDocumentMarkdown(artifactText),
      });
      setDocumentDownloadStatus(copy.document.downloadReady);
      recordAaisResearchEvent({
        actorGeneration: telemetryActorGeneration,
        eventName: "document_download",
        outcome: "success",
        latencyMs: clientNowMs() - startedAt,
        detail: downloadDetail,
      });
    } catch (error) {
      const message = copy.document.downloadFailed;
      setBackendError(message);
      setDocumentDownloadStatus("");
      setDocumentDownloadError(message);
      recordAaisResearchEvent({
        actorGeneration: telemetryActorGeneration,
        eventName: "document_download",
        outcome: "failure",
        latencyMs: clientNowMs() - startedAt,
        detail: {
          ...downloadDetail,
          error_kind: isUserCancelledFilePicker(error)
            ? "user_cancelled"
            : classifyAaisResearchClientError(error),
        },
      });
    } finally {
      setDocumentDownloadBusy(false);
    }
  }

  return {
    documentDownloadBusy,
    documentDownloadError,
    documentDownloadStatus,
    downloadDocumentToLocal,
    resetDocumentDownloadState: () => {
      setDocumentDownloadStatus("");
      setDocumentDownloadError("");
    },
  };
}
