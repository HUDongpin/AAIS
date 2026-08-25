import { getVisibleGuideTurns } from "@/components/pages/learning/guide-chat";
import {
  getCanonicalGuideExchange,
  getGuideStreamDoneText,
  type GuideResponseBody,
  type GuideStreamProgress,
} from "@/components/pages/learning/guide-stream";
import type { GuideMessage } from "@/components/pages/learning/learning-page-types";
import type { Locale } from "@/data/aais";

export function applyGuideResponseToMessages(
  messages: GuideMessage[],
  temporaryIds: { userId: string; assistantId: string },
  body: GuideResponseBody,
  locale: Locale,
): GuideMessage[] {
  const structuredTurns = getRenderableGuideTurns(body.turns);
  const temporaryUser = messages.find((message) => message.id === temporaryIds.userId);
  const temporaryAssistant = messages.find((message) => message.id === temporaryIds.assistantId);
  const candidateExchange = getCanonicalGuideExchange(body);
  const exchange = structuredTurns.length
    && temporaryUser?.kind === "user"
    && temporaryAssistant?.kind === "assistant"
    && temporaryUser.taskId === temporaryAssistant.taskId
    && temporaryUser.phase === temporaryAssistant.phase
    ? candidateExchange
    : null;
  const updated = messages.map((message) =>
    message.id === temporaryIds.userId && message.kind === "user" && exchange
      ? { ...message, id: exchange.userMessageId }
      : message.id === temporaryIds.assistantId && message.kind === "assistant"
      ? {
          ...message,
          ...(exchange ? { id: exchange.assistantMessageId } : {}),
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
  );
  return exchange ? deduplicateGuideMessagesById(updated) : updated;
}

export function applyGuideStreamProgressToMessages(
  messages: GuideMessage[],
  assistantId: string,
  input: GuideStreamProgress,
): GuideMessage[] {
  const visibleTurns = getRenderableGuideTurns(input.turns);
  return messages.map((message) =>
    message.id === assistantId
      ? {
          ...message,
          text: visibleTurns.length ? input.text : "",
          ...(visibleTurns.length ? { turns: [...visibleTurns] } : { turns: undefined }),
          runtime: {
            fallback: input.fallback,
          },
          trace: {
            graphId: input.graphId,
          },
        }
      : message,
  );
}

function getRenderableGuideTurns(turns?: GuideResponseBody["turns"]) {
  return getVisibleGuideTurns(turns).filter((turn) =>
    !turn.actions.includes("progress"),
  );
}

function deduplicateGuideMessagesById(messages: GuideMessage[]) {
  const seen = new Set<string>();
  return [...messages].reverse().filter((message) => {
    if (seen.has(message.id)) return false;
    seen.add(message.id);
    return true;
  }).reverse();
}
