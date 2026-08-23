import { useEffect, useRef, type Dispatch, type SetStateAction } from "react";
import {
  toAaisGuideAttachmentMetadata,
  type AaisGuideAttachment,
} from "@/lib/ai/aais-guide-attachments";
import type {
  AaisClientSession,
  GuideMessage,
} from "@/components/pages/learning/learning-page-types";
import { visibleGuideAgentIds } from "@/components/pages/learning/learning-page-constants";

export function useHydratePersistedGuideMessages(
  persistedGuideMessages: GuideMessage[],
  setGuideMessages: Dispatch<SetStateAction<GuideMessage[]>>,
) {
  const hydratedMessageIdsRef = useRef(new Set<string>());

  useEffect(() => {
    const unseenMessages = persistedGuideMessages.filter((message) => {
      if (hydratedMessageIdsRef.current.has(message.id)) {
        return false;
      }
      hydratedMessageIdsRef.current.add(message.id);
      return true;
    });
    if (unseenMessages.length) {
      setGuideMessages((current) => [...current, ...unseenMessages]);
    }
  }, [persistedGuideMessages, setGuideMessages]);
}

export function addReadAttachmentMetadataToGuideMessage(
  messages: GuideMessage[],
  userId: string,
  attachments: AaisGuideAttachment[],
) {
  const attachmentMetadata = attachments.map(toAaisGuideAttachmentMetadata);
  return messages.map((message) =>
    message.id === userId
      ? { ...message, attachments: attachmentMetadata }
      : message,
  );
}

export function getPersistedGuideMessages(
  guideMessages: AaisClientSession["guideMessages"] | undefined,
): GuideMessage[] {
  const messages = guideMessages ?? [];
  const restored: GuideMessage[] = [];
  for (let index = 0; index < messages.length; index += 1) {
    const user = messages[index];
    const assistant = messages[index + 1];
    if (user?.kind !== "user" || assistant?.kind !== "assistant") {
      continue;
    }

    const visibleTurns = assistant.turns?.filter((turn) =>
      visibleGuideAgentIds.includes(
        turn.agentId as (typeof visibleGuideAgentIds)[number],
      ) && !turn.actions.includes("progress")
    );
    const hadStructuredTurns = Boolean(assistant.turns?.length);
    const hasRenderableReply = visibleTurns?.length
      || (!hadStructuredTurns && assistant.text.trim());
    const hasRenderableQuestion = user.text.trim() || user.attachments?.length;
    if (!hasRenderableQuestion || !hasRenderableReply) {
      index += 1;
      continue;
    }

    restored.push({
      id: user.id,
      kind: "user",
      text: user.text,
      ...(user.attachments?.length ? { attachments: user.attachments } : {}),
    });
    restored.push({
      id: assistant.id,
      kind: "assistant",
      text: assistant.text,
      ...(visibleTurns?.length ? { turns: visibleTurns } : {}),
      trace: assistant.orchestration
        ? {
            graphId: assistant.orchestration.graphId,
            topologicalOrder: assistant.orchestration.topologicalOrder?.filter((agentId) =>
              visibleGuideAgentIds.includes(
                agentId as (typeof visibleGuideAgentIds)[number],
              )
            ),
          }
        : undefined,
    });
    index += 1;
  }
  return restored;
}

export function getControlledGuideAttachmentMimeType(value: string | undefined) {
  const normalized = value?.trim().toLowerCase();
  return normalized === "text/plain"
    || normalized === "text/markdown"
    || normalized === "text/csv"
    || normalized === "application/pdf"
    || normalized === "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
    ? normalized
    : undefined;
}
