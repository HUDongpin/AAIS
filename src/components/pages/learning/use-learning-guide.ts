import { useEffect, useRef, useState, type FormEvent } from "react";
import {
  aaisGuideAttachmentLimits,
  normalizeAaisGuideAttachments,
  type AaisGuideAttachment,
} from "@/lib/ai/aais-guide-attachments";
import { selectAaisGuideReplyAgentIds } from "@/lib/ai/aais-guide-targets";
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
import {
  addReadAttachmentMetadataToGuideMessage,
  getControlledGuideAttachmentMimeType,
  useHydratePersistedGuideMessages,
} from "@/components/pages/learning/guide-message-persistence";
import { getVisibleGuideTurns, toGuideAttachmentPayload } from "@/components/pages/learning/guide-chat";
import { fetchGuideRequest, getAaisCsrfHeader, clientNowMs } from "@/components/pages/learning/client-helpers";
import type {
  GuideClientAttachment,
  GuideMessage,
  GuideQuickStart,
} from "@/components/pages/learning/learning-page-types";
import {
  isGuideEventStreamResponse,
  isUsableGuideBody,
  readGuideJsonBody,
  readGuideStreamResponse,
  validateGuideResponse,
  type GuideResponseBody,
} from "@/components/pages/learning/guide-stream";
import {
  applyGuideResponseToMessages,
  applyGuideStreamProgressToMessages,
} from "@/components/pages/learning/guide-message-updates";
import type { Locale } from "@/data/aais";
type UseLearningGuideInput = {
  activeTaskId: string;
  artifactText: string;
  displayName: string;
  waitForLearnerDataGeneration: () => number | Promise<number>;
  locale: Locale;
  persistedGuideMessages?: GuideMessage[];
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
  waitForLearnerDataGeneration,
  locale,
  persistedGuideMessages = [],
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
  const guideRequestAbortControllerRef = useRef<AbortController | null>(null);
  useHydratePersistedGuideMessages(persistedGuideMessages, setGuideMessages);
  useEffect(() => () => {
    guideRequestAbortControllerRef.current?.abort();
    guideRequestAbortControllerRef.current = null;
  }, []);

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

    const targetAgentIds = selectAaisGuideReplyAgentIds(question);
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
      const generationResult = waitForLearnerDataGeneration();
      const dataGeneration = typeof generationResult === "number"
        ? generationResult
        : await generationResult;
      const requestInit = {
        method: "POST",
        headers: {
          "content-type": "application/json",
          ...getAaisCsrfHeader(),
        },
        body: JSON.stringify({
          dataGeneration,
          locale,
          phase: "training",
          taskId: activeTaskId,
          learnerInput: question,
          targetAgentIds,
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
      setGuideMessages((current) =>
        applyGuideResponseToMessages(current, assistantId, body, locale),
      );
      if (boundedAttachments.length) {
        setGuideMessages((current) =>
          addReadAttachmentMetadataToGuideMessage(current, userId, boundedAttachments),
        );
      }
      setGuideAttachments([]);
      recordAaisResearchEvent({
        eventName: "ai_guide_submit",
        outcome: "success",
        actorGeneration: telemetryActorGeneration,
        latencyMs: clientNowMs() - startedAt,
        detail: {
          ...baseEventDetail,
          target_agent_count: targetAgentIds.length,
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
          target_agent_count: targetAgentIds.length,
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
    const streamAbortController = new AbortController();
    guideRequestAbortControllerRef.current = streamAbortController;
    try {
      const streamResponse = await fetchGuideRequest(requestInit, {
        stream: true,
        signal: streamAbortController.signal,
      });
      if (isGuideEventStreamResponse(streamResponse)) {
        return await readGuideStreamResponse(
          streamResponse,
          (progress) => setGuideMessages((current) =>
            applyGuideStreamProgressToMessages(current, assistantId, progress, locale),
          ),
          undefined,
          locale,
          () => streamAbortController.abort(),
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
    } finally {
      if (guideRequestAbortControllerRef.current === streamAbortController) {
        guideRequestAbortControllerRef.current = null;
      }
    }
    const response = await fetchGuideRequest(requestInit);
    const body = await readGuideJsonBody(response);
    validateGuideResponse(response, body);
    return body;
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

  function resetGuideState() {
    guideRequestAbortControllerRef.current?.abort();
    guideRequestAbortControllerRef.current = null;
    setGuideDraft("");
    setGuideMessages(createInitialGuideMessages(displayName, locale));
    setGuideBusy(false);
    setGuideError("");
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
    guideBusy,
    guideDraft,
    guideError,
    guideFileInputRef,
    guideMessages,
    hasGuideSubmission,
    removeGuideAttachment,
    resetGuideState,
    sendGuideMessage,
    setGuideDraft,
    setGuideError,
    submitGuideQuestion,
  };
}
