import { useRef, useState } from "react";
import {
  aaisGuideAttachmentLimits,
  normalizeAaisGuideAttachments,
} from "@/lib/ai/aais-guide-attachments";
import { readAaisGuideFileAttachment } from "@/lib/client/aais-guide-file-reader";
import {
  admitAaisResearchAction,
  captureAaisResearchActorGeneration,
  createAaisResearchOperationId,
  recordAaisResearchEvent,
} from "@/lib/client/aais-research-telemetry";
import { clientNowMs } from "@/components/pages/learning/client-helpers";
import { toGuideAttachmentPayload } from "@/components/pages/learning/guide-chat";
import { getControlledGuideAttachmentMimeType } from "@/components/pages/learning/guide-message-persistence";
import { getLearningCopy } from "@/components/pages/learning/learning-copy";
import type { GuideClientAttachment } from "@/components/pages/learning/learning-page-types";
import type { Locale } from "@/data/aais";

type UseLearningGuideAttachmentsInput = {
  activeTaskId: string;
  locale: Locale;
  onAttachmentsAdded: () => void;
};

export function useLearningGuideAttachments({
  activeTaskId,
  locale,
  onAttachmentsAdded,
}: UseLearningGuideAttachmentsInput) {
  const copy = getLearningCopy(locale);
  const [guideAttachmentBusy, setGuideAttachmentBusy] = useState(false);
  const [guideAttachmentError, setGuideAttachmentError] = useState("");
  const [guideAttachments, setGuideAttachments] = useState<GuideClientAttachment[]>([]);
  const guideAttachmentIdRef = useRef(0);
  const guideFileInputRef = useRef<HTMLInputElement | null>(null);

  function createGuideAttachmentId() {
    guideAttachmentIdRef.current += 1;
    return `attachment-${guideAttachmentIdRef.current}`;
  }

  async function addGuideFiles(files: FileList | File[] | null) {
    if (guideAttachmentBusy) {
      return;
    }
    const selectedFiles = Array.from(files ?? []);
    if (!selectedFiles.length) {
      return;
    }
    const telemetryActorGeneration = captureAaisResearchActorGeneration();
    const operationId = createAaisResearchOperationId("attachment-add");
    const startedAt = clientNowMs();
    const controlledMimeType = selectedFiles.length === 1
      ? getControlledGuideAttachmentMimeType(selectedFiles[0]?.type)
      : undefined;
    const eventDetail = {
      operation_id: operationId,
      task_id: activeTaskId,
      file_count: selectedFiles.length,
      total_size_bytes: selectedFiles.reduce((total, file) => total + file.size, 0),
      ...(controlledMimeType ? { mime_type: controlledMimeType } : {}),
    };

    if (guideAttachments.length + selectedFiles.length > aaisGuideAttachmentLimits.maxFiles) {
      if (!admitAaisResearchAction({
        actorGeneration: telemetryActorGeneration,
        eventName: "guide_attachment_add",
        outcome: "failure",
        latencyMs: clientNowMs() - startedAt,
        detail: {
          ...eventDetail,
          error_kind: "file_count_limit",
        },
      })) {
        return;
      }
      setGuideAttachmentError(copy.guide.attachmentLimit(aaisGuideAttachmentLimits.maxFiles));
      return;
    }
    if (!admitAaisResearchAction({
      actorGeneration: telemetryActorGeneration,
      eventName: "guide_attachment_add",
      outcome: "attempted",
      detail: eventDetail,
    })) {
      return;
    }

    setGuideAttachmentError("");
    setGuideAttachmentBusy(true);
    try {
      const nextAttachments = await Promise.all(
        selectedFiles.map(async (file) => ({
          id: createGuideAttachmentId(),
          ...(await readAaisGuideFileAttachment(file, locale)),
        })),
      );
      const boundedAttachments = normalizeAaisGuideAttachments([
        ...guideAttachments.map(toGuideAttachmentPayload),
        ...nextAttachments.map(toGuideAttachmentPayload),
      ]);
      setGuideAttachments(
        boundedAttachments.map((attachment) => ({
          ...attachment,
          id: createGuideAttachmentId(),
        })),
      );
      onAttachmentsAdded();
      recordAaisResearchEvent({
        actorGeneration: telemetryActorGeneration,
        eventName: "guide_attachment_add",
        outcome: "success",
        latencyMs: clientNowMs() - startedAt,
        detail: eventDetail,
      });
    } catch (error) {
      setGuideAttachmentError(error instanceof Error ? error.message : copy.guide.fileReadFailed);
      recordAaisResearchEvent({
        actorGeneration: telemetryActorGeneration,
        eventName: "guide_attachment_add",
        outcome: "failure",
        latencyMs: clientNowMs() - startedAt,
        detail: {
          ...eventDetail,
          error_kind: "file_read_failed",
        },
      });
    } finally {
      setGuideAttachmentBusy(false);
    }
  }

  function removeGuideAttachment(attachmentId: string) {
    const attachment = guideAttachments.find((candidate) => candidate.id === attachmentId);
    if (!admitAaisResearchAction({
      eventName: "guide_attachment_removed",
      outcome: "success",
      detail: {
        operation_id: createAaisResearchOperationId("attachment-remove"),
        task_id: activeTaskId,
        ...(attachment
          ? {
              mime_type: attachment.mediaType,
              size_bytes: attachment.sizeBytes,
            }
          : {}),
      },
    })) {
      return;
    }
    setGuideAttachments((current) =>
      current.filter((candidate) => candidate.id !== attachmentId),
    );
    setGuideAttachmentError("");
  }

  function resetGuideAttachments() {
    setGuideAttachmentBusy(false);
    setGuideAttachmentError("");
    setGuideAttachments([]);
    if (guideFileInputRef.current) {
      guideFileInputRef.current.value = "";
    }
  }

  return {
    addGuideFiles,
    guideAttachmentBusy,
    guideAttachmentError,
    guideAttachments,
    guideFileInputRef,
    removeGuideAttachment,
    resetGuideAttachments,
    setGuideAttachmentError,
    setGuideAttachments,
  };
}
