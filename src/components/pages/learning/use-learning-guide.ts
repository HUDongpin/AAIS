import { useRef, useState, type FormEvent } from "react";
import {
  aaisGuideAttachmentLimits,
  normalizeAaisGuideAttachments,
  type AaisGuideAttachment,
} from "@/lib/ai/aais-guide-attachments";
import { normalizeAaisGuideTargetAgentIds } from "@/lib/ai/aais-guide-targets";
import { readAaisGuideFileAttachment } from "@/lib/client/aais-guide-file-reader";
import {
  guideAttachmentOnlyPrompt,
  initialGuideMessages,
} from "@/components/pages/learning/learning-page-constants";
import {
  getVisibleGuideTurns,
  toGuideAttachmentPayload,
} from "@/components/pages/learning/guide-chat";
import {
  fetchGuideRequest,
  getAaisCsrfHeader,
} from "@/components/pages/learning/client-helpers";
import type {
  GuideClientAttachment,
  GuideMessage,
} from "@/components/pages/learning/learning-page-types";
import {
  guideStreamDoneText,
  guideStreamProgressText,
  isGuideEventStreamResponse,
  isUsableGuideBody,
  readGuideJsonBody,
  readGuideStreamResponse,
  validateGuideResponse,
  type GuideResponseBody,
  type GuideStreamProgress,
} from "@/components/pages/learning/guide-stream";

type UseLearningGuideInput = {
  activeTaskId: string;
  artifactText: string;
  studentId: string;
};

export function useLearningGuide({
  activeTaskId,
  artifactText,
  studentId,
}: UseLearningGuideInput) {
  const [guideDraft, setGuideDraft] = useState("");
  const [guideMessages, setGuideMessages] = useState<GuideMessage[]>(initialGuideMessages);
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

  async function submitGuideQuestion(rawQuestion: string) {
    const attachments = guideAttachments.map(toGuideAttachmentPayload);
    let boundedAttachments: AaisGuideAttachment[] = [];
    try {
      boundedAttachments = normalizeAaisGuideAttachments(attachments);
    } catch (error) {
      setGuideAttachmentError(error instanceof Error ? error.message : "上传文件不可用。");
      return;
    }
    const question = rawQuestion.trim() || (boundedAttachments.length ? guideAttachmentOnlyPrompt : "");
    if (guideBusy || guideAttachmentBusy) {
      return;
    }
    if (!question) {
      setGuideError("请输入你的想法后再发送。");
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
        text: "CAAIS 已收到，多智能体链路正在处理。",
      },
    ]);
    setGuideDraft("");
    setGuideError("");
    setGuideAttachmentError("");
    setGuideBusy(true);

    try {
      const requestInit = {
        method: "POST",
        headers: {
          "content-type": "application/json",
          ...getAaisCsrfHeader(),
        },
        body: JSON.stringify({
          locale: "zh-CN",
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
      const body = await requestGuideResponse(requestInit, assistantId);
      applyGuideResponse(assistantId, body);
      setGuideAttachments([]);
    } catch {
      setGuideMessages((current) =>
        current.map((message) =>
          message.id === assistantId
            ? {
                ...message,
                text: "智能服务暂时不可用，已保留你的问题。请稍后重试。",
                turns: undefined,
                runtime: undefined,
                trace: undefined,
              }
            : message,
        ),
      );
      setGuideError("智能服务暂时不可用，已保留你的问题。");
    } finally {
      setGuideBusy(false);
    }
  }

  async function requestGuideResponse(
    requestInit: RequestInit,
    assistantId: string,
  ): Promise<GuideResponseBody> {
    const streamResponse = await fetchGuideRequest(requestInit, { stream: true });
    if (isGuideEventStreamResponse(streamResponse)) {
      return readGuideStreamResponse(streamResponse, (progress) =>
        updateGuideStreamMessage(assistantId, progress)
      );
    }

    const streamedJsonBody = await readGuideJsonBody(streamResponse);
    if (!streamResponse.ok || isUsableGuideBody(streamedJsonBody)) {
      validateGuideResponse(streamResponse, streamedJsonBody);
      return streamedJsonBody;
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
              text: structuredTurns.length ? guideStreamDoneText : body.message?.text ?? "",
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
              text: visibleTurns.length ? input.text : guideStreamProgressText,
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
    setGuideAttachmentError("");

    if (guideAttachments.length + selectedFiles.length > aaisGuideAttachmentLimits.maxFiles) {
      setGuideAttachmentError(`一次最多上传 ${aaisGuideAttachmentLimits.maxFiles} 个文件。`);
      return;
    }

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
    } catch (error) {
      setGuideAttachmentError(error instanceof Error ? error.message : "文件未能读取。");
    } finally {
      setGuideAttachmentBusy(false);
    }
  }

  function removeGuideAttachment(attachmentId: string) {
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
