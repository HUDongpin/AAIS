import { describe, expect, it, vi } from "vitest";
import {
  GuideRequestError,
  readGuideStreamResponse,
  validateGuideResponse,
} from "@/components/pages/learning/guide-stream";

function createGuideStream(blocks: string[]) {
  const encoder = new TextEncoder();
  return new Response(new ReadableStream<Uint8Array>({
    start(controller) {
      for (const block of blocks) {
        controller.enqueue(encoder.encode(block));
      }
      controller.close();
    },
  }), {
    headers: { "content-type": "text/event-stream;charset=utf-8" },
  });
}

describe("guide stream delivery receipts", () => {
  it("keeps one operation identity and treats secondary delivery as live", async () => {
    const onProgress = vi.fn();
    const response = createGuideStream([
      'event: ack\ndata: {"operationId":"11111111-1111-4111-8111-111111111111","requestAttemptId":"ATT-2","diagnosticId":"DG-LIVE-02"}\n\n',
      'event: agent_delta\ndata: {"agentId":"A1","content":"从你卡住的步骤开始。"}\n\n',
      'event: fallback\ndata: {"timeoutReason":"abort-timeout"}\n\n',
      'event: delivery\ndata: {"schemaVersion":1,"responseMode":"live","channel":"secondary","degraded":true,"diagnosticId":"DG-LIVE-02","persisted":true,"budgetDisposition":"charged-once"}\n\n',
      'event: done\ndata: {"status":"completed","delivery":{"schemaVersion":1,"responseMode":"live","channel":"secondary","degraded":true,"diagnosticId":"DG-LIVE-02","persisted":true,"budgetDisposition":"charged-once"}}\n\n',
    ]);

    const body = await readGuideStreamResponse(response, onProgress);

    expect(body.orchestration?.runtime).toMatchObject({
      operationId: "11111111-1111-4111-8111-111111111111",
      requestAttemptId: "ATT-2",
      diagnosticId: "DG-LIVE-02",
      timings: { fallback: false },
      delivery: {
        responseMode: "live",
        channel: "secondary",
        degraded: true,
        persisted: true,
        budgetDisposition: "charged-once",
      },
    });
    expect(body.turns?.[0]?.content).toBe("从你卡住的步骤开始。");
    expect(onProgress).toHaveBeenLastCalledWith(expect.objectContaining({
      fallback: false,
      operationId: "11111111-1111-4111-8111-111111111111",
      delivery: expect.objectContaining({ channel: "secondary" }),
    }));
    expect(onProgress.mock.calls.every(([progress]) => progress.fallback === false)).toBe(true);
  });

  it("reads the final delivery receipt from done when no delivery event was emitted", async () => {
    const response = createGuideStream([
      'event: agent_delta\ndata: {"agentId":"A2","content":"先示范一次。"}\n\n',
      'event: done\ndata: {"status":"completed","delivery":{"schemaVersion":1,"responseMode":"live","channel":"primary","degraded":false,"diagnosticId":"DG-LIVE-01","persisted":true,"budgetDisposition":"charged-once"}}\n\n',
    ]);

    const body = await readGuideStreamResponse(response, vi.fn());

    expect(body.orchestration?.runtime?.delivery).toMatchObject({
      responseMode: "live",
      channel: "primary",
      diagnosticId: "DG-LIVE-01",
    });
  });

  it("throws only the structured learner-safe error receipt from SSE", async () => {
    const response = createGuideStream([
      'event: error\ndata: {"error":{"schemaVersion":1,"code":"AAIS_AI_OUTPUT_BLOCKED","diagnosticId":"DG-SAFE-01","retryable":false,"learnerAction":"rephrase","message":"请改写问题后重试。"}}\n\n',
    ]);

    await expect(readGuideStreamResponse(response, vi.fn())).rejects.toMatchObject({
      name: "GuideRequestError",
      code: "AAIS_AI_OUTPUT_BLOCKED",
      diagnosticId: "DG-SAFE-01",
      retryable: false,
      learnerAction: "rephrase",
    });
  });

  it("preserves structured JSON error metadata for the learner UI", () => {
    let thrown: unknown;
    try {
      validateGuideResponse(new Response(null, { status: 503 }), {
        error: {
          schemaVersion: 1,
          code: "AAIS_AI_PROVIDER_CHAIN_EXHAUSTED",
          diagnosticId: "DG-CHAIN-01",
          retryable: true,
          learnerAction: "retry",
          message: "实时 AI 链路暂时不可用。",
        },
      });
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(GuideRequestError);
    expect(thrown).toMatchObject({
      code: "AAIS_AI_PROVIDER_CHAIN_EXHAUSTED",
      diagnosticId: "DG-CHAIN-01",
      retryable: true,
      learnerAction: "retry",
    });
  });

  it("does not promote an unstructured server error body into a browser error message", () => {
    const privateBody = "private prompt fragment that must not reach browser logs";
    let thrown: unknown;
    try {
      validateGuideResponse(new Response(null, { status: 500 }), { error: privateBody });
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(GuideRequestError);
    expect((thrown as Error).message).toBe("AAIS guide failed");
    expect((thrown as Error).message).not.toContain(privateBody);
  });
});
