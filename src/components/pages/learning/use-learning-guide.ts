import { useEffect, useRef, useState, type FormEvent } from "react";
import {
  normalizeAaisGuideAttachments,
  type AaisGuideAttachment,
} from "@/lib/ai/aais-guide-attachments";
import { selectAaisGuideReplyAgentIds } from "@/lib/ai/aais-guide-targets";
import {
  admitAaisResearchAction,
  captureAaisResearchActorGeneration,
  classifyAaisResearchClientError,
  recordAaisResearchEvent,
} from "@/lib/client/aais-research-telemetry";
import {
  createInitialGuideMessages,
  getGuideAttachmentOnlyPrompt,
} from "@/components/pages/learning/learning-page-constants";
import { getLearningCopy } from "@/components/pages/learning/learning-copy";
import {
  addReadAttachmentMetadataToGuideMessage,
  useHydratePersistedGuideMessages,
} from "@/components/pages/learning/guide-message-persistence";
import {
  getGuideFailurePresentation,
  getVisibleGuideTurns,
  toGuideAttachmentPayload,
} from "@/components/pages/learning/guide-chat";
import { getAaisCsrfHeader, clientNowMs } from "@/components/pages/learning/client-helpers";
import type {
  GuideMessage,
} from "@/components/pages/learning/learning-page-types";
import {
  isGuideLiveDelivery,
  readGuideDeliveryReceipt,
} from "@/components/pages/learning/guide-stream";
import {
  applyGuideResponseToMessages,
  applyGuideStreamProgressToMessages,
} from "@/components/pages/learning/guide-message-updates";
import {
  createGuideFailure,
  createGuideOperationId,
  isGuideBrowserOffline,
  isGuideConnectionError,
} from "@/components/pages/learning/guide-operation-client";
import { requestGuideResponse } from "@/components/pages/learning/guide-request-client";
import { useLearningGuideAttachments } from "@/components/pages/learning/use-learning-guide-attachments";
import type {
  GuideSubmissionEventDetail,
  GuideSubmissionOptions,
  GuideSubmissionSnapshot,
} from "@/components/pages/learning/guide-submission-types";
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
  const guideMessageIdRef = useRef(0);
  const guideRequestAbortControllerRef = useRef<AbortController | null>(null);
  const retryableGuideSubmissionsRef = useRef(new Map<string, GuideSubmissionSnapshot>());
  const {
    addGuideFiles,
    guideAttachmentBusy,
    guideAttachmentError,
    guideAttachments,
    guideFileInputRef,
    removeGuideAttachment,
    resetGuideAttachments,
    setGuideAttachmentError,
    setGuideAttachments,
  } = useLearningGuideAttachments({
    activeTaskId,
    locale,
    onAttachmentsAdded: () => setGuideError(""),
  });
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
    const operationId = createGuideOperationId();
    if (!operationId) {
      setGuideError(copy.guide.requestIdentityUnavailable);
      return;
    }
    const startedAt = clientNowMs();
    const rawPromptLength = rawQuestion.trim().length;
    const inputMode: GuideSubmissionEventDetail["input_mode"] = options.source === "quick_start"
      ? "quick_start"
      : rawPromptLength
        ? "typed"
        : "attachment_only";
    const baseEventDetail: GuideSubmissionEventDetail = {
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
    const submission: GuideSubmissionSnapshot = {
      operationId,
      userId,
      assistantId,
      taskId: activeTaskId,
      artifactText,
      studentId,
      locale,
      question,
      editableQuestion: rawQuestion.trim(),
      boundedAttachments,
      targetAgentIds,
      telemetryActorGeneration,
      baseEventDetail,
    };
    retryableGuideSubmissionsRef.current.set(assistantId, submission);
    await runGuideSubmission(submission, startedAt);
  }

  async function runGuideSubmission(
    submission: GuideSubmissionSnapshot,
    startedAt = clientNowMs(),
  ) {
    setGuideBusy(true);
    let attemptNumber = 1;
    let retryReason: string | undefined;

    try {
      if (isGuideBrowserOffline()) {
        const offlineError = new Error("AAIS guide request is offline");
        offlineError.name = "AaisGuideBrowserOfflineError";
        throw offlineError;
      }
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
          operationId: submission.operationId,
          dataGeneration,
          locale: submission.locale,
          phase: "training",
          taskId: submission.taskId,
          learnerInput: submission.question,
          targetAgentIds: submission.targetAgentIds,
          workspaceState: {
            studentId: submission.studentId,
            currentStep: "home",
            artifactText: submission.artifactText,
            helpRequestsUsed: 0,
            ...(submission.boundedAttachments.length
              ? { attachments: submission.boundedAttachments }
              : {}),
          },
        }),
      };
      const body = await requestGuideResponse({
        controllerRef: guideRequestAbortControllerRef,
        locale,
        onStreamProgress: (progress) => setGuideMessages((current) =>
          applyGuideStreamProgressToMessages(current, submission.assistantId, progress, locale),
        ),
        onTransportRetry: () => {
          attemptNumber = 2;
          retryReason = "stream_protocol_fallback";
          return admitAaisResearchAction({
            eventName: "ai_guide_submit",
            outcome: "retry",
            actorGeneration: submission.telemetryActorGeneration,
            latencyMs: clientNowMs() - startedAt,
            detail: {
              ...submission.baseEventDetail,
              attempt_number: attemptNumber,
              retry_reason: retryReason,
            },
          });
        },
        requestInit,
      });
      setGuideMessages((current) =>
        applyGuideResponseToMessages(current, submission.assistantId, body, submission.locale),
      );
      if (submission.boundedAttachments.length) {
        setGuideMessages((current) =>
          addReadAttachmentMetadataToGuideMessage(
            current,
            submission.userId,
            submission.boundedAttachments,
          ),
        );
      }
      setGuideAttachments([]);
      retryableGuideSubmissionsRef.current.delete(submission.assistantId);
      const responseRuntime = body.orchestration?.runtime;
      const delivery = readGuideDeliveryReceipt(responseRuntime?.delivery);
      recordAaisResearchEvent({
        eventName: "ai_guide_submit",
        outcome: "success",
        actorGeneration: submission.telemetryActorGeneration,
        latencyMs: clientNowMs() - startedAt,
        detail: {
          ...submission.baseEventDetail,
          target_agent_count: submission.targetAgentIds.length,
          agent_count: getVisibleGuideTurns(body.turns).length,
          fallback: isGuideLiveDelivery(delivery)
            ? false
            : responseRuntime?.timings?.fallback === true,
          ...(attemptNumber > 1
            ? {
                attempt_number: attemptNumber,
                retry_reason: retryReason,
              }
            : {}),
        },
      });
    } catch (error) {
      const failure = createGuideFailure(error, submission.operationId);
      const presentation = getGuideFailurePresentation(submission.locale, failure.kind);
      setGuideMessages((current) =>
        current.map((message) =>
          message.id === submission.assistantId
            ? {
                ...message,
                text: presentation.message,
                turns: undefined,
                runtime: {
                  fallback: false,
                  operationId: submission.operationId,
                  diagnosticId: failure.diagnosticId,
                  failure,
                },
                trace: undefined,
              }
            : message,
        ),
      );
      setGuideError("");
      recordAaisResearchEvent({
        eventName: "ai_guide_submit",
        outcome: isGuideConnectionError(error) ? "disconnected" : "failure",
        actorGeneration: submission.telemetryActorGeneration,
        latencyMs: clientNowMs() - startedAt,
        detail: {
          ...submission.baseEventDetail,
          error_kind: classifyAaisResearchClientError(error),
          target_agent_count: submission.targetAgentIds.length,
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

  async function retryGuideMessage(assistantId: string) {
    if (guideBusy || guideAttachmentBusy) {
      return;
    }
    const submission = retryableGuideSubmissionsRef.current.get(assistantId);
    if (!submission) {
      return;
    }
    const operationId = createGuideOperationId();
    if (!operationId) {
      setGuideError(getLearningCopy(submission.locale).guide.requestIdentityUnavailable);
      return;
    }
    const retrySubmission: GuideSubmissionSnapshot = {
      ...submission,
      operationId,
      baseEventDetail: {
        ...submission.baseEventDetail,
        operation_id: operationId,
      },
    };
    if (!admitAaisResearchAction({
      eventName: "ai_guide_submit",
      outcome: "retry",
      actorGeneration: retrySubmission.telemetryActorGeneration,
      detail: {
        ...retrySubmission.baseEventDetail,
        attempt_number: 1,
        retry_reason: "learner_retry",
      },
    })) {
      return;
    }
    retryableGuideSubmissionsRef.current.set(assistantId, retrySubmission);
    setGuideMessages((current) => current.map((message) =>
      message.id === assistantId
        ? {
            ...message,
            text: getLearningCopy(submission.locale).guide.requestAccepted,
            turns: undefined,
            runtime: undefined,
            trace: undefined,
          }
        : message
    ));
    setGuideError("");
    await runGuideSubmission(retrySubmission);
  }

  function rewriteGuideMessage(assistantId: string) {
    if (guideBusy || guideAttachmentBusy) {
      return;
    }
    const submission = retryableGuideSubmissionsRef.current.get(assistantId);
    if (!submission) {
      return;
    }
    setGuideDraft(submission.editableQuestion);
    setGuideError("");
  }

  function createGuideMessageId(prefix: string) {
    guideMessageIdRef.current += 1;
    return `${prefix}-${guideMessageIdRef.current}`;
  }

  function sendGuideMessage(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    void submitGuideQuestion(guideDraft);
  }

  function resetGuideState() {
    guideRequestAbortControllerRef.current?.abort();
    guideRequestAbortControllerRef.current = null;
    setGuideDraft("");
    setGuideMessages(createInitialGuideMessages(displayName, locale));
    setGuideBusy(false);
    setGuideError("");
    resetGuideAttachments();
    retryableGuideSubmissionsRef.current.clear();
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
    retryGuideMessage,
    rewriteGuideMessage,
    sendGuideMessage,
    setGuideDraft,
    setGuideError,
    submitGuideQuestion,
  };
}
