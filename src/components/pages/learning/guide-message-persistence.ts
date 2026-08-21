import { useEffect, useRef, type Dispatch, type SetStateAction } from "react";
import {
  toAaisGuideAttachmentMetadata,
  type AaisGuideAttachment,
} from "@/lib/ai/aais-guide-attachments";
import type {
  AaisClientSession,
  GuideMessage,
  GuidePersistedDeliveryReceipt,
} from "@/components/pages/learning/learning-page-types";

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

export function getPersistedAttachmentGuideMessages(
  guideMessages: AaisClientSession["guideMessages"] | undefined,
): GuideMessage[] {
  const messages = guideMessages ?? [];
  const restored: GuideMessage[] = [];
  for (let index = 0; index < messages.length; index += 1) {
    const message = messages[index];
    if (message?.kind !== "user" || !message.attachments?.length) {
      continue;
    }
    restored.push({
      id: message.id,
      kind: "user",
      text: message.text,
      attachments: message.attachments,
    });
    const assistant = messages[index + 1];
    if (assistant?.kind === "assistant") {
      const delivery = readSafePersistedGuideDelivery(assistant.orchestration?.delivery);
      restored.push({
        id: assistant.id,
        kind: "assistant",
        text: assistant.text,
        turns: assistant.turns,
        runtime: delivery
          ? {
              fallback: false,
              delivery,
            }
          : undefined,
        trace: assistant.orchestration
          ? {
              graphId: assistant.orchestration.graphId,
              topologicalOrder: assistant.orchestration.topologicalOrder,
            }
          : undefined,
      });
    }
  }
  return restored;
}

export function readSafePersistedGuideDelivery(
  value: unknown,
): GuidePersistedDeliveryReceipt | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  const delivery = value as Record<string, unknown>;
  if (
    delivery.schemaVersion !== 1
    || delivery.responseMode !== "live"
    || (delivery.channel !== "primary" && delivery.channel !== "secondary")
    || typeof delivery.degraded !== "boolean"
    || delivery.degraded !== (delivery.channel === "secondary")
  ) {
    return undefined;
  }
  return {
    schemaVersion: 1,
    responseMode: "live",
    channel: delivery.channel,
    degraded: delivery.degraded,
  };
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
