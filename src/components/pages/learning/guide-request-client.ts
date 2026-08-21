import { fetchGuideRequest, clientNowMs } from "@/components/pages/learning/client-helpers";
import { guideRequestTimeoutMs } from "@/components/pages/learning/learning-page-constants";
import {
  GuideRequestError,
  isGuideEventStreamResponse,
  isUsableGuideBody,
  readGuideJsonBody,
  readGuideStreamResponse,
  validateGuideResponse,
  type GuideResponseBody,
  type GuideStreamProgress,
} from "@/components/pages/learning/guide-stream";
import type { Locale } from "@/data/aais";

type GuideAbortControllerRef = {
  current: AbortController | null;
};

type RequestGuideResponseInput = {
  controllerRef: GuideAbortControllerRef;
  locale: Locale;
  onStreamProgress: (progress: GuideStreamProgress) => void;
  onTransportRetry: () => boolean;
  requestInit: RequestInit;
};

export async function requestGuideResponse({
  controllerRef,
  locale,
  onStreamProgress,
  onTransportRetry,
  requestInit,
}: RequestGuideResponseInput): Promise<GuideResponseBody> {
  const streamAbortController = new AbortController();
  const requestStartedAt = clientNowMs();
  controllerRef.current = streamAbortController;
  try {
    const streamResponse = await fetchGuideRequest(requestInit, {
      stream: true,
      signal: streamAbortController.signal,
    });
    if (isGuideEventStreamResponse(streamResponse)) {
      try {
        return await readGuideStreamResponse(
          streamResponse,
          onStreamProgress,
          undefined,
          locale,
        );
      } catch (error) {
        if (error instanceof GuideRequestError || streamAbortController.signal.aborted) {
          throw error;
        }
        if (!onTransportRetry()) {
          throw new Error("AAIS research telemetry blocked the guide retry.");
        }
        const remainingMs = guideRequestTimeoutMs - (clientNowMs() - requestStartedAt);
        if (remainingMs <= 0) {
          streamAbortController.abort(createGuidePollAbortError());
          throw createGuidePollTimeoutError({});
        }
        const response = await fetchGuidePollResponse({
          body: {},
          remainingMs,
          requestInit,
          signal: streamAbortController.signal,
        });
        const body = await readGuideJsonBody(response);
        if (isGuideOperationInProgress(response, body)) {
          return await pollGuideOperation({
            initialBody: body,
            initialResponse: response,
            requestInit,
            requestStartedAt,
            signal: streamAbortController.signal,
          });
        }
        validateGuideResponse(response, body);
        return body;
      }
    }

    const streamedJsonBody = await readGuideJsonBody(streamResponse);
    if (isGuideOperationInProgress(streamResponse, streamedJsonBody)) {
      return await pollGuideOperation({
        initialBody: streamedJsonBody,
        initialResponse: streamResponse,
        requestInit,
        requestStartedAt,
        signal: streamAbortController.signal,
      });
    }
    if (!streamResponse.ok || isUsableGuideBody(streamedJsonBody)) {
      validateGuideResponse(streamResponse, streamedJsonBody);
      return streamedJsonBody;
    }

    if (!onTransportRetry()) {
      throw new Error("AAIS research telemetry blocked the guide retry.");
    }
    const response = await fetchGuideRequest(requestInit, {
      signal: streamAbortController.signal,
    });
    const body = await readGuideJsonBody(response);
    if (isGuideOperationInProgress(response, body)) {
      return await pollGuideOperation({
        initialBody: body,
        initialResponse: response,
        requestInit,
        requestStartedAt,
        signal: streamAbortController.signal,
      });
    }
    validateGuideResponse(response, body);
    return body;
  } finally {
    if (controllerRef.current === streamAbortController) {
      controllerRef.current = null;
    }
  }
}

async function pollGuideOperation(input: {
  initialBody: GuideResponseBody;
  initialResponse: Response;
  requestInit: RequestInit;
  requestStartedAt: number;
  signal: AbortSignal;
}) {
  let body = input.initialBody;
  let response = input.initialResponse;
  while (isGuideOperationInProgress(response, body)) {
    input.signal.throwIfAborted();
    const elapsedMs = clientNowMs() - input.requestStartedAt;
    const remainingMs = guideRequestTimeoutMs - elapsedMs;
    if (remainingMs <= 0) {
      throw createGuidePollTimeoutError(body);
    }
    const retryDelayMs = Math.min(readGuideRetryAfterMs(response), remainingMs);
    await waitForGuidePoll(retryDelayMs, input.signal);
    const fetchRemainingMs = guideRequestTimeoutMs
      - (clientNowMs() - input.requestStartedAt);
    if (fetchRemainingMs <= 0) {
      throw createGuidePollTimeoutError(body);
    }
    response = await fetchGuidePollResponse({
      body,
      remainingMs: fetchRemainingMs,
      requestInit: input.requestInit,
      signal: input.signal,
    });
    body = await readGuideJsonBody(response);
  }
  validateGuideResponse(response, body);
  return body;
}

async function fetchGuidePollResponse(input: {
  body: GuideResponseBody;
  remainingMs: number;
  requestInit: RequestInit;
  signal: AbortSignal;
}) {
  const controller = new AbortController();
  let deadlineReached = false;
  const timeout = setTimeout(() => {
    deadlineReached = true;
    controller.abort(createGuidePollAbortError());
  }, input.remainingMs);
  const onAbort = () => controller.abort(input.signal.reason ?? createGuidePollAbortError());
  input.signal.addEventListener("abort", onAbort, { once: true });
  if (input.signal.aborted) {
    onAbort();
  }
  try {
    return await fetchGuideRequest(input.requestInit, { signal: controller.signal });
  } catch (error) {
    if (deadlineReached) {
      throw createGuidePollTimeoutError(input.body);
    }
    throw error;
  } finally {
    clearTimeout(timeout);
    input.signal.removeEventListener("abort", onAbort);
  }
}

function isGuideOperationInProgress(response: Response, body: GuideResponseBody) {
  return response.status === 202
    && typeof body.error === "object"
    && body.error !== null
    && body.error.code === "AI_OPERATION_IN_PROGRESS";
}

function readGuideRetryAfterMs(response: Response) {
  const retryAfter = response.headers.get("retry-after")?.trim();
  if (retryAfter) {
    const seconds = Number(retryAfter);
    if (Number.isFinite(seconds) && seconds >= 0) {
      return Math.max(100, Math.round(seconds * 1_000));
    }
    const retryAt = Date.parse(retryAfter);
    if (Number.isFinite(retryAt)) {
      return Math.max(100, retryAt - Date.now());
    }
  }
  return 1_000;
}

function waitForGuidePoll(delayMs: number, signal: AbortSignal) {
  return new Promise<void>((resolve, reject) => {
    if (signal.aborted) {
      reject(signal.reason ?? createGuidePollAbortError());
      return;
    }
    const timeout = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, delayMs);
    const onAbort = () => {
      clearTimeout(timeout);
      signal.removeEventListener("abort", onAbort);
      reject(signal.reason ?? createGuidePollAbortError());
    };
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

function createGuidePollTimeoutError(body: GuideResponseBody) {
  const receipt = typeof body.error === "object" && body.error !== null
    ? body.error
    : undefined;
  return new GuideRequestError("AAIS guide operation polling timed out", {
    code: "AI_LIVE_TIMEOUT",
    diagnosticId: receipt?.diagnosticId,
    retryable: true,
    learnerAction: "retry",
  });
}

function createGuidePollAbortError() {
  const error = new Error("AAIS guide operation polling was aborted");
  error.name = "AbortError";
  return error;
}
