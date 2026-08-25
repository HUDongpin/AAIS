import { fetchGuideRequest } from "@/components/pages/learning/client-helpers";
import { applyGuideStreamProgressToMessages } from "@/components/pages/learning/guide-message-updates";
import type { GuideMessage } from "@/components/pages/learning/learning-page-types";
import {
  isGuideEventStreamResponse,
  isUsableGuideBody,
  readGuideJsonBody,
  readGuideStreamResponse,
  validateGuideResponse,
  type GuideResponseBody,
} from "@/components/pages/learning/guide-stream";
import type { Locale } from "@/data/aais";

export async function requestLearningGuideResponse({
  abortControllerRef,
  assistantId,
  locale,
  onTransportRetry,
  requestInit,
  setGuideMessages,
}: {
  abortControllerRef: { current: AbortController | null };
  assistantId: string;
  locale: Locale;
  onTransportRetry: () => boolean;
  requestInit: RequestInit;
  setGuideMessages: (update: (current: GuideMessage[]) => GuideMessage[]) => void;
}): Promise<GuideResponseBody> {
  const streamAbortController = new AbortController();
  abortControllerRef.current = streamAbortController;
  try {
    const streamResponse = await fetchGuideRequest(requestInit, {
      stream: true,
      signal: streamAbortController.signal,
    });
    if (isGuideEventStreamResponse(streamResponse)) {
      return await readGuideStreamResponse(
        streamResponse,
        (progress) => setGuideMessages((current) =>
          applyGuideStreamProgressToMessages(current, assistantId, progress)
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
    if (abortControllerRef.current === streamAbortController) {
      abortControllerRef.current = null;
    }
  }
  const response = await fetchGuideRequest(requestInit);
  const body = await readGuideJsonBody(response);
  validateGuideResponse(response, body);
  return body;
}
