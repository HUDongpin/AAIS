import { guideRequestTimeoutMs } from "@/components/pages/learning/learning-page-constants";
import {
  getGuideAgentLabel,
} from "@/components/pages/learning/learning-copy";
import type {
  GuideDeliveryReceipt,
  GuideLearnerAction,
  GuideTurn,
} from "@/components/pages/learning/learning-page-types";
import type { Locale } from "@/data/aais";

export type GuideErrorReceipt = {
  schemaVersion?: number;
  code?: string;
  diagnosticId?: string;
  retryable?: boolean;
  learnerAction?: GuideLearnerAction;
  message?: string;
};

export class GuideRequestError extends Error {
  readonly code?: string;
  readonly diagnosticId?: string;
  readonly retryable?: boolean;
  readonly learnerAction?: GuideLearnerAction;

  constructor(message: string, receipt?: GuideErrorReceipt) {
    super(message);
    this.name = "GuideRequestError";
    this.code = receipt?.code;
    this.diagnosticId = receipt?.diagnosticId;
    this.retryable = receipt?.retryable;
    this.learnerAction = receipt?.learnerAction;
  }
}

export type GuideResponseBody = {
  message?: {
    text?: string;
  };
  turns?: GuideTurn[];
  orchestration?: {
    graph?: {
      graphId?: string;
      topologicalOrder?: string[];
    };
    runtime?: {
      timings?: {
        fallback?: boolean;
      };
      delivery?: GuideDeliveryReceipt;
      operationId?: string;
      requestAttemptId?: string;
      diagnosticId?: string;
    };
  };
  error?: string | GuideErrorReceipt;
};

export type GuideStreamProgress = {
  text: string;
  turns: GuideTurn[];
  fallback: boolean;
  graphId?: string;
  operationId?: string;
  requestAttemptId?: string;
  diagnosticId?: string;
  delivery?: GuideDeliveryReceipt;
};

type GuideStreamEvent = {
  event: string;
  data: Record<string, unknown>;
};

export const guideStreamProgressText = "AAIS 智能体正在分步处理。";
export const guideStreamDoneText = "AAIS 智能体已回复。";

export function getGuideStreamProgressText(locale: Locale) {
  return locale === "en-US"
    ? "CAAIS agents are working through your request step by step."
    : guideStreamProgressText;
}

export function getGuideStreamDoneText(locale: Locale) {
  return locale === "en-US" ? "CAAIS agents replied." : guideStreamDoneText;
}

export async function readGuideStreamResponse(
  response: Response,
  onProgress: (progress: GuideStreamProgress) => void,
  idleTimeoutMs = guideRequestTimeoutMs,
  locale: Locale = "zh-CN",
  abortUpstream?: () => void,
): Promise<GuideResponseBody> {
  if (!response.body) {
    throw new Error("AAIS guide stream is unavailable");
  }

  const decoder = new TextDecoder();
  const reader = response.body.getReader();
  const turns: GuideTurn[] = [];
  let fallback = false;
  let pendingLegacyFallback = false;
  let graphId: string | undefined;
  let operationId: string | undefined;
  let requestAttemptId: string | undefined;
  let diagnosticId: string | undefined;
  let delivery: GuideDeliveryReceipt | undefined;
  let buffer = "";
  let streamCompleted = false;

  const emitProgress = (text: string) => {
    onProgress({
      text,
      turns: [...turns],
      fallback,
      graphId,
      operationId,
      requestAttemptId,
      diagnosticId,
      delivery,
    });
  };
  const handleStreamEvent = (streamEvent: GuideStreamEvent) => {
    if (streamEvent.event === "heartbeat") {
      // Receiving this server-only liveness marker starts a fresh idle read
      // window without exposing it as learner-visible progress.
      return;
    }

    if (streamEvent.event === "error") {
      throw createGuideResponseError(streamEvent.data, "AAIS guide failed");
    }

    if (streamEvent.event === "ack") {
      graphId = typeof streamEvent.data.graphId === "string" ? streamEvent.data.graphId : graphId;
      operationId = readOptionalString(streamEvent.data.operationId) ?? operationId;
      requestAttemptId = readOptionalString(streamEvent.data.requestAttemptId) ?? requestAttemptId;
      diagnosticId = readOptionalString(streamEvent.data.diagnosticId) ?? diagnosticId;
      emitProgress(getGuideStreamProgressText(locale));
      return;
    }

    if (streamEvent.event === "delivery") {
      delivery = readGuideDeliveryReceipt(streamEvent.data.delivery)
        ?? readGuideDeliveryReceipt(streamEvent.data)
        ?? delivery;
      diagnosticId = delivery?.diagnosticId ?? diagnosticId;
      if (isGuideLiveDelivery(delivery)) {
        fallback = false;
      } else if ((delivery?.responseMode ?? delivery?.mode) === "deterministic") {
        fallback = true;
      }
      emitProgress(turns.length ? getGuideStreamDoneText(locale) : getGuideStreamProgressText(locale));
      return;
    }

    if (streamEvent.event === "agent_start") {
      const agentId = readStreamAgentId(streamEvent.data);
      if (!agentId) {
        return;
      }
      upsertGuideStreamTurn(turns, {
        agentId,
        content: locale === "en-US"
          ? `${readGuideStreamAgentLabel(agentId, locale)} is working on your question...`
          : `${readGuideStreamAgentLabel(agentId, locale)}正在处理你的问题...`,
        actions: ["progress"],
      }, locale);
      emitProgress(getGuideStreamProgressText(locale));
      return;
    }

    if (streamEvent.event === "agent_delta") {
      const agentId = readStreamAgentId(streamEvent.data);
      const content = typeof streamEvent.data.content === "string" ? streamEvent.data.content : "";
      if (!agentId || !content.trim()) {
        return;
      }
      upsertGuideStreamTurn(turns, {
        agentId,
        content,
        actions: ["respond"],
      }, locale);
      emitProgress(getGuideStreamDoneText(locale));
      return;
    }

    if (streamEvent.event === "fallback") {
      // Legacy streams used this event for both a provider failover and a
      // deterministic scaffold. Wait for the final delivery receipt before
      // showing a local-mode label so a successful secondary live channel is
      // never momentarily described as offline.
      pendingLegacyFallback = true;
      emitProgress(turns.length ? getGuideStreamDoneText(locale) : getGuideStreamProgressText(locale));
      return;
    }

    if (streamEvent.event === "done" || streamEvent.event === "background_done") {
      const doneDelivery = readGuideDeliveryReceipt(streamEvent.data.delivery);
      if (doneDelivery) {
        delivery = doneDelivery;
        diagnosticId = doneDelivery.diagnosticId ?? diagnosticId;
        if (isGuideLiveDelivery(doneDelivery)) {
          fallback = false;
        } else if ((doneDelivery.responseMode ?? doneDelivery.mode) === "deterministic") {
          fallback = true;
        }
      } else if (pendingLegacyFallback) {
        fallback = true;
      }
      streamCompleted = true;
    }
  };

  try {
    while (true) {
      const { value, done } = await readGuideStreamChunk(reader, idleTimeoutMs);
      if (done) {
        break;
      }
      buffer += decoder.decode(value, { stream: true });
      const blocks = buffer.split(/\n\n/);
      buffer = blocks.pop() ?? "";
      for (const block of blocks) {
        const streamEvent = parseGuideStreamEvent(block);
        if (streamEvent) {
          handleStreamEvent(streamEvent);
        }
      }
    }
  } catch (error) {
    abortUpstream?.();
    await reader.cancel().catch(() => undefined);
    throw error;
  }
  try {
    buffer += decoder.decode();
    const streamEvent = parseGuideStreamEvent(buffer);
    if (streamEvent) {
      handleStreamEvent(streamEvent);
    }
  } catch (error) {
    abortUpstream?.();
    await reader.cancel().catch(() => undefined);
    throw error;
  }
  if (!streamCompleted) {
    abortUpstream?.();
    await reader.cancel().catch(() => undefined);
    throw Object.assign(new Error("AAIS guide stream disconnected before completion"), {
      name: "AaisGuideStreamDisconnectedError",
    });
  }

  const body: GuideResponseBody = {
    message: {
      text: getGuideStreamDoneText(locale),
    },
    turns,
    orchestration: {
      graph: {
        graphId,
      },
      runtime: {
        timings: {
          fallback,
        },
        delivery,
        operationId,
        requestAttemptId,
        diagnosticId,
      },
    },
  };
  validateGuideResponse(response, body);
  return body;
}

async function readGuideStreamChunk(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  idleTimeoutMs: number,
) {
  let timeoutId: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      reader.read(),
      new Promise<never>((_resolve, reject) => {
        timeoutId = setTimeout(() => {
          const error = new Error("AAIS guide stream timed out while waiting for data");
          error.name = "AbortError";
          reject(error);
        }, idleTimeoutMs);
      }),
    ]);
  } finally {
    if (timeoutId) {
      clearTimeout(timeoutId);
    }
  }
}

export async function readGuideJsonBody(response: Response): Promise<GuideResponseBody> {
  return response.json().catch(() => ({}));
}

export function validateGuideResponse(response: Response, body: GuideResponseBody) {
  if (!response.ok || !isUsableGuideBody(body)) {
    throw createGuideResponseError(body, "AAIS guide failed");
  }
}

export function isUsableGuideBody(body: GuideResponseBody) {
  return Boolean(body.message?.text || body.turns?.length);
}

export function isGuideEventStreamResponse(response: Response) {
  return response.headers.get("content-type")?.includes("text/event-stream") === true;
}

export function isGuideLiveDelivery(delivery: GuideDeliveryReceipt | undefined) {
  return (delivery?.responseMode ?? delivery?.mode) === "live"
    && (delivery?.channel === "primary" || delivery?.channel === "secondary");
}

export function readGuideDeliveryReceipt(value: unknown): GuideDeliveryReceipt | undefined {
  const record = readRecord(value);
  if (!record) {
    return undefined;
  }
  const receipt: GuideDeliveryReceipt = {
    schemaVersion: readOptionalNumber(record.schemaVersion),
    mode: readOptionalString(record.mode),
    responseMode: readOptionalString(record.responseMode),
    channel: readOptionalString(record.channel),
    degraded: readOptionalBoolean(record.degraded),
    diagnosticId: readOptionalString(record.diagnosticId),
    persisted: readOptionalBoolean(record.persisted),
    budgetDisposition: readOptionalString(record.budgetDisposition),
  };
  return Object.values(receipt).some((entry) => entry !== undefined) ? receipt : undefined;
}

export function getGuideRequestErrorReceipt(error: unknown): GuideErrorReceipt | undefined {
  if (error instanceof GuideRequestError) {
    return {
      code: error.code,
      diagnosticId: error.diagnosticId,
      retryable: error.retryable,
      learnerAction: error.learnerAction,
    };
  }
  return undefined;
}

function upsertGuideStreamTurn(
  turns: GuideTurn[],
  input: {
    agentId: string;
    content: string;
    actions: string[];
  },
  locale: Locale,
) {
  const nextTurn: GuideTurn = {
    agentId: input.agentId,
    label: readGuideStreamAgentLabel(input.agentId, locale),
    content: input.content,
    actions: input.actions,
  };
  const index = turns.findIndex((turn) => turn.agentId === input.agentId);
  if (index >= 0) {
    turns[index] = nextTurn;
    return;
  }
  turns.push(nextTurn);
}

function parseGuideStreamEvent(block: string): GuideStreamEvent | null {
  const lines = block.replace(/\r\n?/g, "\n").split("\n");
  let event = "message";
  const dataLines: string[] = [];
  let heartbeat = false;
  for (const line of lines) {
    if (line.startsWith("event:")) {
      event = line.slice("event:".length).trim();
    } else if (line.startsWith("data:")) {
      dataLines.push(line.slice("data:".length).trim());
    } else if (line.trim() === ": aais-heartbeat") {
      heartbeat = true;
    }
  }
  if (!dataLines.length) {
    return heartbeat ? { event: "heartbeat", data: {} } : null;
  }
  try {
    const data = JSON.parse(dataLines.join("\n"));
    return data && typeof data === "object" ? { event, data } : null;
  } catch {
    return null;
  }
}

function readStreamAgentId(data: Record<string, unknown>) {
  return typeof data.agentId === "string" ? data.agentId : null;
}

function readGuideStreamAgentLabel(agentId: string, locale: Locale) {
  return getGuideAgentLabel(locale, agentId);
}

function createGuideResponseError(value: unknown, fallbackMessage: string) {
  const record = readRecord(value);
  const nestedError = record && "error" in record ? record.error : value;
  const receipt = readGuideErrorReceipt(nestedError);
  return new GuideRequestError(fallbackMessage, receipt);
}

function readGuideErrorReceipt(value: unknown): GuideErrorReceipt | undefined {
  const record = readRecord(value);
  if (!record) {
    return undefined;
  }
  const receipt: GuideErrorReceipt = {
    schemaVersion: readOptionalNumber(record.schemaVersion),
    code: readOptionalString(record.code),
    diagnosticId: readOptionalString(record.diagnosticId),
    retryable: readOptionalBoolean(record.retryable),
    learnerAction: readOptionalString(record.learnerAction),
    message: readOptionalString(record.message),
  };
  return Object.values(receipt).some((entry) => entry !== undefined) ? receipt : undefined;
}

function readRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function readOptionalString(value: unknown) {
  return typeof value === "string" && value.length ? value : undefined;
}

function readOptionalNumber(value: unknown) {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function readOptionalBoolean(value: unknown) {
  return typeof value === "boolean" ? value : undefined;
}
