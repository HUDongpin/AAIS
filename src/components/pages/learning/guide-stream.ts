import { getAaisApiErrorMessage } from "@/lib/client/aais-api-error";
import { guideRequestTimeoutMs } from "@/components/pages/learning/learning-page-constants";
import {
  getGuideAgentLabel,
} from "@/components/pages/learning/learning-copy";
import type { GuideTurn } from "@/components/pages/learning/learning-page-types";
import { normalizeAaisGuideVisualizations } from "@/lib/ai/aais-guide-function-scaffold";
import type { Locale } from "@/data/aais";

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
    };
  };
  error?: string | {
    code?: string;
    message?: string;
  };
};

export type GuideStreamProgress = {
  text: string;
  turns: GuideTurn[];
  fallback: boolean;
  graphId?: string;
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
  let graphId: string | undefined;
  let buffer = "";
  let streamCompleted = false;

  const emitProgress = (text: string) => {
    onProgress({
      text,
      turns: [...turns],
      fallback,
      graphId,
    });
  };
  const handleStreamEvent = (streamEvent: GuideStreamEvent) => {
    if (streamEvent.event === "heartbeat") {
      // Receiving this server-only liveness marker starts a fresh idle read
      // window without exposing it as learner-visible progress.
      return;
    }

    if (streamEvent.event === "error") {
      throw new Error(getAaisApiErrorMessage(
        { error: streamEvent.data as GuideResponseBody["error"] },
        "AAIS guide failed",
      ));
    }

    if (streamEvent.event === "ack") {
      graphId = typeof streamEvent.data.graphId === "string" ? streamEvent.data.graphId : graphId;
      emitProgress(getGuideStreamProgressText(locale));
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
        visualizations: normalizeAaisGuideVisualizations(streamEvent.data.visualizations),
      }, locale);
      emitProgress(getGuideStreamDoneText(locale));
      return;
    }

    if (streamEvent.event === "fallback") {
      fallback = true;
      emitProgress(turns.length ? getGuideStreamDoneText(locale) : getGuideStreamProgressText(locale));
      return;
    }

    if (streamEvent.event === "done" || streamEvent.event === "background_done") {
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
    throw new Error(getAaisApiErrorMessage(body, "AAIS guide failed"));
  }
}

export function isUsableGuideBody(body: GuideResponseBody) {
  return Boolean(body.message?.text || body.turns?.length);
}

export function isGuideEventStreamResponse(response: Response) {
  return response.headers.get("content-type")?.includes("text/event-stream") === true;
}

function upsertGuideStreamTurn(
  turns: GuideTurn[],
  input: {
    agentId: string;
    content: string;
    actions: string[];
    visualizations?: GuideTurn["visualizations"];
  },
  locale: Locale,
) {
  const nextTurn: GuideTurn = {
    agentId: input.agentId,
    label: readGuideStreamAgentLabel(input.agentId, locale),
    content: input.content,
    actions: input.actions,
    ...(input.visualizations?.length ? { visualizations: input.visualizations } : {}),
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
