import { getAaisApiErrorMessage } from "@/lib/client/aais-api-error";
import { guideRequestTimeoutMs } from "@/components/pages/learning/learning-page-constants";
import type { GuideTurn } from "@/components/pages/learning/learning-page-types";

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

const guideStreamAgentLabels: Record<string, string> = {
  A1: "导学智能体",
  A2: "专家智能体",
  A3: "监督智能体",
  A4: "反思智能体",
};

export async function readGuideStreamResponse(
  response: Response,
  onProgress: (progress: GuideStreamProgress) => void,
  idleTimeoutMs = guideRequestTimeoutMs,
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
    if (streamEvent.event === "error") {
      throw new Error(getAaisApiErrorMessage(
        { error: streamEvent.data as GuideResponseBody["error"] },
        "AAIS guide failed",
      ));
    }

    if (streamEvent.event === "ack") {
      graphId = typeof streamEvent.data.graphId === "string" ? streamEvent.data.graphId : graphId;
      emitProgress(guideStreamProgressText);
      return;
    }

    if (streamEvent.event === "agent_start") {
      const agentId = readStreamAgentId(streamEvent.data);
      if (!agentId) {
        return;
      }
      upsertGuideStreamTurn(turns, {
        agentId,
        content: `${readGuideStreamAgentLabel(agentId)}正在处理你的问题...`,
        actions: ["progress"],
      });
      emitProgress(guideStreamProgressText);
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
      });
      emitProgress(guideStreamDoneText);
      return;
    }

    if (streamEvent.event === "fallback") {
      fallback = true;
      emitProgress(turns.length ? guideStreamDoneText : guideStreamProgressText);
      return;
    }

    if (streamEvent.event === "background_done") {
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
    await reader.cancel().catch(() => undefined);
    throw error;
  }
  buffer += decoder.decode();
  const streamEvent = parseGuideStreamEvent(buffer);
  if (streamEvent) {
    handleStreamEvent(streamEvent);
  }
  if (!streamCompleted) {
    throw Object.assign(new Error("AAIS guide stream disconnected before completion"), {
      name: "AaisGuideStreamDisconnectedError",
    });
  }

  const body: GuideResponseBody = {
    message: {
      text: guideStreamDoneText,
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
  },
) {
  const nextTurn: GuideTurn = {
    agentId: input.agentId,
    label: readGuideStreamAgentLabel(input.agentId),
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
  for (const line of lines) {
    if (line.startsWith("event:")) {
      event = line.slice("event:".length).trim();
    } else if (line.startsWith("data:")) {
      dataLines.push(line.slice("data:".length).trim());
    }
  }
  if (!dataLines.length) {
    return null;
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

function readGuideStreamAgentLabel(agentId: string) {
  return guideStreamAgentLabels[agentId] ?? agentId;
}
