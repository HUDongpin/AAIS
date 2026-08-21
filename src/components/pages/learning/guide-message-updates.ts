import { getVisibleGuideTurns } from "@/components/pages/learning/guide-chat";
import {
  getGuideStreamDoneText,
  getGuideStreamProgressText,
  isGuideLiveDelivery,
  readGuideDeliveryReceipt,
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
  const structuredTurns = getVisibleGuideTurns(body.turns);
  const responseRuntime = body.orchestration?.runtime;
  const delivery = readGuideDeliveryReceipt(responseRuntime?.delivery);
  const fallback = isGuideLiveDelivery(delivery)
    ? false
    : responseRuntime?.timings?.fallback === true;
  return messages.map((message) =>
    message.id === assistantId
      ? {
          ...message,
          text: structuredTurns.length ? getGuideStreamDoneText(locale) : body.message?.text ?? "",
          ...(structuredTurns.length ? { turns: structuredTurns } : { turns: undefined }),
          runtime: {
            fallback,
            delivery,
            operationId: responseRuntime?.operationId,
            requestAttemptId: responseRuntime?.requestAttemptId,
            diagnosticId: delivery?.diagnosticId ?? responseRuntime?.diagnosticId,
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
  locale: Locale,
): GuideMessage[] {
  const visibleTurns = getVisibleGuideTurns(input.turns);
  const fallback = isGuideLiveDelivery(input.delivery) ? false : input.fallback;
  return messages.map((message) =>
    message.id === assistantId
      ? {
          ...message,
          text: visibleTurns.length ? input.text : getGuideStreamProgressText(locale),
          ...(visibleTurns.length ? { turns: [...visibleTurns] } : { turns: undefined }),
          runtime: {
            fallback,
            delivery: input.delivery,
            operationId: input.operationId,
            requestAttemptId: input.requestAttemptId,
            diagnosticId: input.delivery?.diagnosticId ?? input.diagnosticId,
          },
          trace: {
            graphId: input.graphId,
          },
        }
      : message,
  );
}
