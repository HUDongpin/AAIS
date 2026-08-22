import { getVisibleGuideTurns } from "@/components/pages/learning/guide-chat";
import {
  getGuideStreamDoneText,
  type GuideResponseBody,
  type GuideStreamProgress,
} from "@/components/pages/learning/guide-stream";
import type { GuideMessage } from "@/components/pages/learning/learning-page-types";
import type { Locale } from "@/data/aais";

export function applyGuideResponseToMessages(
  messages: GuideMessage[],
  assistantId: string,
  body: GuideResponseBody,
  locale: Locale,
): GuideMessage[] {
  const structuredTurns = getRenderableGuideTurns(body.turns);
  return messages.map((message) =>
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
  );
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
