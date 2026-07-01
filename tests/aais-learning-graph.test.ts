import { describe, expect, it, vi } from "vitest";
import { runAaisLearningGuideGraph } from "@/lib/ai/orchestration/aais-learning-guide-graph";
import type { AaisModelProvider, AaisModelRequest } from "@/lib/ai/aais-ai-provider";

describe("AAIS LangGraph learning guide", () => {
  it("runs the four requirement agents as first-class LangGraph nodes", async () => {
    const result = await runAaisLearningGuideGraph({
      locale: "zh-CN",
      studentId: "S001",
      phase: "practice",
      taskId: "practice_task_1",
      learnerInput: "我不确定应该怎样规划这个任务。",
      workspaceState: {
        currentStep: "practice-task",
        artifactText: "初稿",
        helpRequestsUsed: 1,
      },
    });

    expect(result.graph).toEqual({
      runtime: "langgraph",
      graphId: "learning-ai-guide",
      topologicalOrder: ["A1", "A2", "A3", "A4"],
    });
    expect(result.turns.map((turn) => turn.agentId)).toEqual(["A1", "A2", "A3", "A4"]);
    expect(result.turns[0].content).toContain("导学智能体");
    expect(result.turns[1].content).toContain("监督智能体");
    expect(result.turns[2].content).toContain("反思智能体");
    expect(result.turns[3].content).toContain("支架智能体");
    expect(result.runtime.redaction).toEqual({
      secrets: "omitted",
      localFiles: "omitted",
      assets: "ids-only",
    });
  });

  it("uses a governed model provider for every agent turn when configured", async () => {
    const generate = vi.fn(async (request: AaisModelRequest) => ({
        text: `${request.agentId} governed provider response`,
        runtime: {
          provider: "test-provider",
          model: "fixture-model",
          attempts: 1,
          status: "ok" as const,
          guardrail: {
            policy: "aais-age-appropriate-output-v1" as const,
            status: "passed" as const,
            reasons: [],
          },
          redaction: {
            secrets: "omitted" as const,
            prompt: "summarized" as const,
          },
        },
      }));
    const modelProvider: AaisModelProvider = { generate };

    const result = await runAaisLearningGuideGraph({
      locale: "zh-CN",
      studentId: "S001",
      phase: "training",
      taskId: "training_task_1",
      learnerInput: "请给我一个任务计划。",
      workspaceState: {
        currentStep: "guide",
      },
    }, {
      modelProvider,
    });

    expect(generate).toHaveBeenCalledTimes(4);
    expect(result.turns.map((turn) => turn.content)).toEqual([
      "A1 governed provider response",
      "A2 governed provider response",
      "A3 governed provider response",
      "A4 governed provider response",
    ]);
    expect(result.runtime.modelProvider).toMatchObject({
      provider: "test-provider",
      generatedTurns: 4,
      redaction: {
        secrets: "omitted",
      },
    });
  });
});
