import { useRef, useState, type FormEvent } from "react";
import { aaisGuideAttachmentLimits, normalizeAaisGuideAttachments, type AaisGuideAttachment } from "@/lib/ai/aais-guide-attachments";
import { normalizeAaisGuideTargetAgentIds } from "@/lib/ai/aais-guide-targets";
import { readAaisGuideFileAttachment } from "@/lib/client/aais-guide-file-reader";
import {
  admitAaisResearchAction,
  captureAaisResearchActorGeneration,
  classifyAaisResearchClientError,
  createAaisResearchOperationId,
  isAaisResearchDisconnectError,
  recordAaisResearchEvent,
} from "@/lib/client/aais-research-telemetry";
import { createInitialGuideMessages, getGuideAttachmentOnlyPrompt } from "@/components/pages/learning/learning-page-constants";
import { getLearningCopy } from "@/components/pages/learning/learning-copy";
import { getVisibleGuideTurns, toGuideAttachmentPayload } from "@/components/pages/learning/guide-chat";
import { fetchGuideRequest, getAaisCsrfHeader, clientNowMs } from "@/components/pages/learning/client-helpers";
import type {
  GuideClientAttachment,
  GuideMessage,
  GuideQuickStart,
} from "@/components/pages/learning/learning-page-types";
import {
  getGuideStreamDoneText,
  getGuideStreamProgressText,
  isGuideEventStreamResponse,
  isUsableGuideBody,
  readGuideJsonBody,
  readGuideStreamResponse,
  validateGuideResponse,
  type GuideResponseBody,
  type GuideStreamProgress,
} from "@/components/pages/learning/guide-stream";
import type { Locale } from "@/data/aais";
type UseLearningGuideInput = {
  activeTaskId: string;
  artifactText: string;
  displayName: string;
  locale: Locale;
  studentId: string;
};
type GuideSubmissionOptions = {
  source?: "typed" | "quick_start";
  quickStartId?: GuideQuickStart["id"];
};
export function useLearningGuide({
  activeTaskId,
  artifactText,
  displayName,
  locale,
  studentId,
}: UseLearningGuideInput) {
  const copy = getLearningCopy(locale);
  const [guideDraft, setGuideDraft] = useState("");
  const [guideMessages, setGuideMessages] = useState<GuideMessage[]>(() =>
    createInitialGuideMessages(displayName, locale)
  );
  const [guideBusy, setGuideBusy] = useState(false);
  const [guideError, setGuideError] = useState("");
  const [guideAttachmentBusy, setGuideAttachmentBusy] = useState(false);
  const [guideAttachmentError, setGuideAttachmentError] = useState("");
  const [guideAttachments, setGuideAttachments] = useState<GuideClientAttachment[]>([]);
  const guideMessageIdRef = useRef(0);
  const guideAttachmentIdRef = useRef(0);
  const guideFileInputRef = useRef<HTMLInputElement | null>(null);

  const hasGuideDraft = guideDraft.trim().length > 0;
  const hasGuideSubmission = hasGuideDraft || guideAttachments.length > 0;

  async function submitGuideQuestion(
    rawQuestion: string,
    options: GuideSubmissionOptions = {},
  ) {
    if (guideBusy || guideAttachmentBusy) {
      return;
    }
    const telemetryActorGeneration = captureAaisResearchActorGeneration();
    const operationId = createAaisResearchOperationId("ai-guide");
    const startedAt = clientNowMs();
    const rawPromptLength = rawQuestion.trim().length;
    const inputMode = options.source === "quick_start"
      ? "quick_start"
      : rawPromptLength
        ? "typed"
        : "attachment_only";
    const baseEventDetail = {
      operation_id: operationId,
      task_id: activeTaskId,
      input_mode: inputMode,
      prompt_length: rawPromptLength,
      attachment_count: guideAttachments.length,
      has_attachments: guideAttachments.length > 0,
      ...(options.quickStartId ? { quick_start_id: options.quickStartId } : {}),
    };

    const attachments = guideAttachments.map(toGuideAttachmentPayload);
    let boundedAttachments: AaisGuideAttachment[] = [];
    try {
      boundedAttachments = normalizeAaisGuideAttachments(attachments);
    } catch (error) {
      if (!admitAaisResearchAction({
        eventName: "ai_guide_submit",
        outcome: "failure",
        actorGeneration: telemetryActorGeneration,
        detail: {
          ...baseEventDetail,
          error_kind: "attachment_validation",
        },
      })) {
        return;
      }
      setGuideAttachmentError(error instanceof Error ? error.message : copy.guide.attachmentUnavailable);
      return;
    }
    const question = rawQuestion.trim() || (boundedAttachments.length ? getGuideAttachmentOnlyPrompt(locale) : "");
    if (!question) {
      if (!admitAaisResearchAction({
        eventName: "ai_guide_submit",
        outcome: "failure",
        actorGeneration: telemetryActorGeneration,
        detail: {
          ...baseEventDetail,
          error_kind: "validation",
        },
      })) {
        return;
      }
      setGuideError(copy.guide.inputRequired);
      return;
    }
    if (!admitAaisResearchAction({
      eventName: "ai_guide_submit",
      outcome: "attempted",
      actorGeneration: telemetryActorGeneration,
      detail: baseEventDetail,
    })) {
      return;
    }

    const targetAgentIds = normalizeAaisGuideTargetAgentIds(undefined, question);
    const userId = createGuideMessageId("user");
    const assistantId = createGuideMessageId("assistant");
    setGuideMessages((current) => [
      ...current,
      {
        id: userId,
        kind: "user",
        text: question,
      },
      {
        id: assistantId,
        kind: "assistant",
        text: copy.guide.requestAccepted,
      },
    ]);
    setGuideDraft("");
    setGuideError("");
    setGuideAttachmentError("");
    setGuideBusy(true);
    let attemptNumber = 1;
    let retryReason: string | undefined;

    try {
      const requestInit = {
        method: "POST",
        headers: {
          "content-type": "application/json",
          ...getAaisCsrfHeader(),
        },
        body: JSON.stringify({
          locale,
          phase: "training",
          taskId: activeTaskId,
          learnerInput: question,
          ...(targetAgentIds ? { targetAgentIds } : {}),
          workspaceState: {
            studentId,
            currentStep: "home",
            artifactText,
            helpRequestsUsed: 0,
            ...(boundedAttachments.length ? { attachments: boundedAttachments } : {}),
          },
        }),
      };
      const body = await requestGuideResponse(requestInit, assistantId, () => {
        attemptNumber = 2;
        retryReason = "stream_protocol_fallback";
        return admitAaisResearchAction({
          eventName: "ai_guide_submit",
          outcome: "retry",
          actorGeneration: telemetryActorGeneration,
          latencyMs: clientNowMs() - startedAt,
          detail: {
            ...baseEventDetail,
            attempt_number: attemptNumber,
            retry_reason: retryReason,
          },
        });
      });
      applyGuideResponse(assistantId, body);
      setGuideAttachments([]);
      recordAaisResearchEvent({
        eventName: "ai_guide_submit",
        outcome: "success",
        actorGeneration: telemetryActorGeneration,
        latencyMs: clientNowMs() - startedAt,
        detail: {
          ...baseEventDetail,
          target_agent_count: targetAgentIds?.length ?? 2,
          agent_count: getVisibleGuideTurns(body.turns).length,
          fallback: body.orchestration?.runtime?.timings?.fallback === true,
          ...(attemptNumber > 1
            ? {
                attempt_number: attemptNumber,
                retry_reason: retryReason,
              }
            : {}),
        },
      });
    } catch (error) {
      setGuideMessages((current) =>
        current.map((message) =>
          message.id === assistantId
            ? {
                ...message,
                text: copy.guide.requestUnavailable,
                turns: undefined,
                runtime: undefined,
                trace: undefined,
              }
            : message,
        ),
      );
      setGuideError(copy.guide.requestErrorAlert);
      recordAaisResearchEvent({
        eventName: "ai_guide_submit",
        outcome: isAaisResearchDisconnectError(error) ? "disconnected" : "failure",
        actorGeneration: telemetryActorGeneration,
        latencyMs: clientNowMs() - startedAt,
        detail: {
          ...baseEventDetail,
          error_kind: classifyAaisResearchClientError(error),
          target_agent_count: targetAgentIds?.length ?? 2,
          ...(attemptNumber > 1
            ? {
                attempt_number: attemptNumber,
                retry_reason: retryReason,
              }
            : {}),
        },
      });
    } finally {
      setGuideBusy(false);
    }
  }

  async function requestGuideResponse(
    requestInit: RequestInit,
    assistantId: string,
    onTransportRetry: () => boolean,
  ): Promise<GuideResponseBody> {
    const streamResponse = await fetchGuideRequest(requestInit, { stream: true });
    if (isGuideEventStreamResponse(streamResponse)) {
      return readGuideStreamResponse(
        streamResponse,
        (progress) => updateGuideStreamMessage(assistantId, progress),
        undefined,
        locale,
      );
    }

    const streamedJsonBody = await readGuideJsonBody(streamResponse);
    if (!streamResponse.ok || isUsableGuideBody(streamedJsonBody)) {
      validateGuideResponse(streamResponse, streamedJsonBody);
      return streamedJsonBody;
    }

    if (!onTransportRetry()) {
      throw new Error("AAIS research telemetry blocked the guide retry.");
    }
    const response = await fetchGuideRequest(requestInit);
    const body = await readGuideJsonBody(response);
    validateGuideResponse(response, body);
    return body;
  }

  function applyGuideResponse(assistantId: string, body: GuideResponseBody) {
    const structuredTurns = getVisibleGuideTurns(body.turns);
    setGuideMessages((current) =>
      current.map((message) =>
        message.id === assistantId
          ? {
              ...message,
              text: structuredTurns.length ? getGuideStreamDoneText(locale) : body.message?.text ?? "",
              ...(structuredTurns.length ? { turns: structuredTurns } : { turns: undefined }),
              runtime: {
                fallback: body.orchestration?.runtime?.timings?.fallback === true,
              },
              trace: {
                graphId: body.orchestration?.graph?.graphId,
                topologicalOrder: body.orchestration?.graph?.topologicalOrder,
              },
            }
          : message,
      ),
    );
  }

  function updateGuideStreamMessage(
    assistantId: string,
    input: GuideStreamProgress,
  ) {
    const visibleTurns = getVisibleGuideTurns(input.turns);
    setGuideMessages((current) =>
      current.map((message) =>
        message.id === assistantId
          ? {
              ...message,
              text: visibleTurns.length ? input.text : getGuideStreamProgressText(locale),
              ...(visibleTurns.length ? { turns: [...visibleTurns] } : { turns: undefined }),
              runtime: {
                fallback: input.fallback,
              },
              trace: {
                graphId: input.graphId,
              },
            }
          : message,
      ),
    );
  }

  function createGuideMessageId(prefix: string) {
    guideMessageIdRef.current += 1;
    return `${prefix}-${guideMessageIdRef.current}`;
  }

  function createGuideAttachmentId() {
    guideAttachmentIdRef.current += 1;
    return `attachment-${guideAttachmentIdRef.current}`;
  }

  function sendGuideMessage(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    void submitGuideQuestion(guideDraft);
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
      ? getControlledResearchMimeType(selectedFiles[0]?.type)
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
          ...(await readAaisGuideFileAttachment(file)),
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
      setGuideError("");
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
      current.filter((attachment) => attachment.id !== attachmentId),
    );
    setGuideAttachmentError("");
  }

  return {
    addGuideFiles,
    guideAttachmentBusy,
    guideAttachmentError,
    guideAttachments,
    guideBusy,
    guideDraft,
    guideError,
    guideFileInputRef,
    guideMessages,
    hasGuideSubmission,
    removeGuideAttachment,
    sendGuideMessage,
    setGuideDraft,
    setGuideError,
    submitGuideQuestion,
  };
}

function getControlledResearchMimeType(value: string | undefined) {
  const normalized = value?.trim().toLowerCase();
  return normalized === "text/plain"
    || normalized === "text/markdown"
    || normalized === "text/csv"
    || normalized === "application/pdf"
    ? normalized
    : undefined;
}
