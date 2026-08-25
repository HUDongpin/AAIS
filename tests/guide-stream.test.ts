import { describe, expect, it, vi } from "vitest";
import {
  getGuideDailyBudgetExceededDetails,
  readGuideStreamResponse,
  validateGuideResponse,
} from "@/components/pages/learning/guide-stream";

describe("guide stream visualization transport", () => {
  const canonicalExchange = {
    userMessageId: "user-11111111-1111-4111-8111-111111111111",
    assistantMessageId: "assistant-22222222-2222-4222-8222-222222222222",
  };
  it("preserves daily-budget metadata from a 429 guide response", () => {
    const response = Response.json({}, { status: 429 });
    const body = {
      error: {
        code: "AAIS_GUIDE_DAILY_BUDGET_EXCEEDED",
        message: "AAIS daily guide request budget has been reached.",
      },
      budget: {
        limit: 1_000,
        used: 1_000,
        remaining: 0,
        resetsAt: "2026-08-23T00:00:00.000Z",
      },
    };

    let requestError: unknown;
    try {
      validateGuideResponse(response, body);
    } catch (error) {
      requestError = error;
    }

    expect(getGuideDailyBudgetExceededDetails(requestError)).toEqual({
      limit: 1_000,
      resetsAt: "2026-08-23T00:00:00.000Z",
    });
  });

  it("does not classify an unrelated 429 as the daily guide budget", () => {
    const response = Response.json({}, { status: 429 });

    expect(() => validateGuideResponse(response, {
      error: {
        code: "AAIS_RATE_LIMITED",
        message: "Try again later.",
      },
    })).toThrow("Try again later.");

    try {
      validateGuideResponse(response, {
        error: {
          code: "AAIS_RATE_LIMITED",
          message: "Try again later.",
        },
      });
    } catch (error) {
      expect(getGuideDailyBudgetExceededDetails(error)).toBeNull();
    }
  });

  it("keeps a validated function graph attached to its streamed agent turn", async () => {
    const encoder = new TextEncoder();
    const visualization = {
      id: "quadratic-2-3-4",
      type: "quadratic-function",
      expression: "y = 2x² + 3x + 4",
      coefficients: { a: 2, b: 3, c: 4 },
      domain: { xMin: -5, xMax: 4 },
      vertex: { x: -0.75, y: 2.875 },
      axisX: -0.75,
      yIntercept: 4,
    };
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode(
          'event: ack\ndata: {"status":"accepted","graphId":"learning-ai-guide"}\n\n',
        ));
        controller.enqueue(encoder.encode(
          'event: agent_start\ndata: {"agentId":"A1"}\n\n',
        ));
        controller.enqueue(encoder.encode(
          `event: agent_delta\ndata: ${JSON.stringify({
            agentId: "A1",
            content: "图像已经显示在下面。",
            visualizations: [visualization],
          })}\n\n`,
        ));
        controller.enqueue(encoder.encode(
          `event: done\ndata: ${JSON.stringify({
            status: "completed",
            exchange: canonicalExchange,
            workspaceState: { helpRequestsUsed: 4 },
          })}\n\n`,
        ));
        controller.close();
      },
    });
    const onProgress = vi.fn();

    const body = await readGuideStreamResponse(
      new Response(stream, {
        status: 200,
        headers: { "content-type": "text/event-stream;charset=utf-8" },
      }),
      onProgress,
      1_000,
      "zh-CN",
    );

    expect(body.turns?.[0]).toMatchObject({
      agentId: "A1",
      content: "图像已经显示在下面。",
      visualizations: [{
        type: "quadratic-function",
        vertex: { x: -0.75, y: 2.875 },
      }],
    });
    expect(body.exchange).toEqual(canonicalExchange);
    expect(onProgress).toHaveBeenLastCalledWith(expect.objectContaining({
      turns: [expect.objectContaining({
        visualizations: [expect.objectContaining({ expression: "y = 2x² + 3x + 4" })],
      })],
    }));
    expect(body.workspaceState).toEqual({ helpRequestsUsed: 4 });
  });

  it("accepts canonical ids only from the final done event", async () => {
    const encoder = new TextEncoder();
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode(
          `event: ack\ndata: ${JSON.stringify({
            status: "accepted",
            graphId: "learning-ai-guide",
            exchange: canonicalExchange,
          })}\n\n`,
        ));
        controller.enqueue(encoder.encode(
          'event: agent_delta\ndata: {"agentId":"A1","content":"已完成。"}\n\n',
        ));
        controller.enqueue(encoder.encode(
          'event: done\ndata: {"status":"completed","exchange":{"userMessageId":"user-1","assistantMessageId":"assistant-2"}}\n\n',
        ));
        controller.close();
      },
    });

    const body = await readGuideStreamResponse(
      new Response(stream, {
        status: 200,
        headers: { "content-type": "text/event-stream;charset=utf-8" },
      }),
      vi.fn(),
      1_000,
      "zh-CN",
    );

    expect(body.exchange).toBeUndefined();
    expect(body.turns).toEqual([
      expect.objectContaining({ agentId: "A1", content: "已完成。" }),
    ]);
  });
});
