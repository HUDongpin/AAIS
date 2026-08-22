import { describe, expect, it, vi } from "vitest";
import { readGuideStreamResponse } from "@/components/pages/learning/guide-stream";

describe("guide stream visualization transport", () => {
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
          'event: done\ndata: {"status":"completed"}\n\n',
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
    expect(onProgress).toHaveBeenLastCalledWith(expect.objectContaining({
      turns: [expect.objectContaining({
        visualizations: [expect.objectContaining({ expression: "y = 2x² + 3x + 4" })],
      })],
    }));
  });
});
