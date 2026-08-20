import { describe, expect, it, vi } from "vitest";
import { runAaisLearningGuideGraph } from "@/lib/ai/orchestration/aais-learning-guide-graph";
import {
  createDeterministicAaisProvider,
  type AaisModelProvider,
  type AaisModelRequest,
} from "@/lib/ai/aais-ai-provider";

describe("AAIS LangGraph learning guide", () => {
  it("matches the attached four-agent operating loop for learner support", async () => {
    const result = await runAaisLearningGuideGraph({
      locale: "zh-CN",
      studentId: "S-image-loop",
      phase: "practice",
      taskId: "practice_task_1",
      learnerInput: "我已经写了过程记录，但不确定如何反思并继续修改。",
      workspaceState: {
        currentStep: "practice-articulation-reflection",
        artifactText: "目标：先理解任务，再比较专家示范和自己的过程。",
        helpRequestsUsed: 4,
      },
    }, {
      modelProvider: createDeterministicAaisProvider(),
    });

    expect(result.graph).toMatchObject({
      runtime: "langgraph",
      graphId: "learning-ai-guide",
      topologicalOrder: ["A1", "A2", "A3", "A4"],
    });
    expect(result.runtime).toMatchObject({
      engine: "aais-langgraph-runtime",
      status: "completed",
      eventCount: 4,
      modelProvider: {
        provider: "deterministic",
        generatedTurns: 4,
        fallbackTurns: 4,
      },
      timings: {
        fallback: true,
      },
    });
    expect(result.runtimeEvents.map((event) => event.nodeId)).toEqual(["A1", "A2", "A3", "A4"]);
    expect(result.runtimeEvents.every((event) => event.redaction.secrets === "omitted")).toBe(true);
    expect(result.visibleTurns.map((turn) => turn.agentId)).toEqual(["A1", "A2"]);
    expect(result.backgroundTurns.map((turn) => turn.agentId)).toEqual(["A3", "A4"]);

    expect(result.turns).toEqual([
      expect.objectContaining({
        agentId: "A1",
        label: "小张",
        actions: ["guide-flow", "scaffold"],
        content: expect.stringContaining("4 次直接辅助已用完"),
      }),
      expect.objectContaining({
        agentId: "A2",
        label: "教授",
        actions: ["model", "coach", "mention-expert"],
        content: expect.stringContaining("Modelling"),
      }),
      expect.objectContaining({
        agentId: "A3",
        label: "监督智能体",
        actions: ["monitor", "signal-a1"],
        content: expect.stringContaining("向 A1 发出信号"),
      }),
      expect.objectContaining({
        agentId: "A4",
        label: "反思智能体",
        actions: ["articulate", "reflect", "compare"],
        content: expect.stringContaining("专家过程进行对比评估"),
      }),
    ]);
    expect(result.turns[0]?.content.length).toBeLessThanOrEqual(120);
    expect(result.turns[0]?.content).toContain("我只给一个小提示");
    expect(result.turns[0]?.content).not.toContain("Modelling");
    expect(result.turns[1]?.content).toContain("Coaching");
    expect(result.turns[1]?.content).toContain("@");
    expect(result.turns[1]?.content.length).toBeGreaterThan(result.turns[0]?.content.length ?? 0);
    expect(result.turns[2]?.content).toContain("practice-articulation-reflection");
    expect(result.turns[3]?.content).toContain("反思性提问");
    expect(result.messageText).toContain("AAIS 智能体已回复");
    expect(result.messageText).toContain("小张");
    expect(result.messageText).toContain("教授");
    expect(result.messageText).not.toContain("监督智能体");
    expect(result.messageText).not.toContain("反思智能体");

    expect(result.trace.handoffs).toEqual(expect.arrayContaining([
      { fromNodeId: "A1", toNodeId: "A2", reason: "ca-flow-to-expert-modelling" },
      { fromNodeId: "A2", toNodeId: "A3", reason: "practice-behavior-data" },
      { fromNodeId: "A3", toNodeId: "A1", reason: "scaffold-signal" },
      { fromNodeId: "A4", toNodeId: "A1", reason: "reflection-report-feedback" },
    ]));
  });

  it("runs only the requested visible agent through the governed provider", async () => {
    const generate = vi.fn(async (request: AaisModelRequest) => ({
        text: `${request.agentId} live provider response`,
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
      studentId: "S-target-a2",
      phase: "training",
      taskId: "training_task_1",
      learnerInput: "@A2 请示范专家会怎样监控理解。",
      targetAgentIds: ["A2"],
      workspaceState: {
        currentStep: "guide",
      },
    }, {
      modelProvider,
    });

    expect(generate).toHaveBeenCalledTimes(1);
    expect(generate.mock.calls.map(([request]) => request.agentId)).toEqual(["A2"]);
    expect(result.turns.map((turn) => turn.agentId)).toEqual(["A2", "A3", "A4"]);
    expect(result.visibleTurns.map((turn) => turn.agentId)).toEqual(["A2"]);
    expect(result.backgroundTurns.map((turn) => turn.agentId)).toEqual(["A3", "A4"]);
    expect(result.messageText).toContain("教授");
    expect(result.messageText).not.toContain("小张");
    expect(result.runtimeEvents.map((event) => event.nodeId)).toEqual(["A2", "A3", "A4"]);
    expect(result.runtime.timings).toMatchObject({
      fallback: false,
      timeoutReason: null,
    });
    expect(result.runtime.modelProvider).toMatchObject({
      provider: "mixed",
      generatedTurns: 3,
      fallbackTurns: 2,
    });
    expect(result.runtime.timings.agents.map((agent) => ({
      agentId: agent.agentId,
      visible: agent.visible,
      status: agent.status,
    }))).toEqual([
      { agentId: "A2", visible: true, status: "ok" },
      { agentId: "A3", visible: false, status: "fallback" },
      { agentId: "A4", visible: false, status: "fallback" },
    ]);
  });

  it("keeps deterministic English guidance in English when the workspace locale is en-US", async () => {
    const result = await runAaisLearningGuideGraph({
      locale: "en-US",
      studentId: "S-english-guide",
      phase: "training",
      taskId: "training_task_1",
      learnerInput: "@A2 Help me understand calculus.",
      targetAgentIds: ["A2"],
      workspaceState: {
        currentStep: "guide",
      },
    }, {
      modelProvider: createDeterministicAaisProvider(),
    });

    expect(result.visibleTurns).toEqual([
      expect.objectContaining({
        agentId: "A2",
        label: "Professor",
        content: expect.stringContaining("university calculus"),
      }),
    ]);
    expect(result.messageText).toContain("AAIS agents replied:");
    expect(result.messageText).toContain("Professor");
    expect(result.messageText).not.toContain("专家智能体");
  });

  it("honors an explicit English reply preference and carries it across bounded history", async () => {
    const first = await runAaisLearningGuideGraph({
      locale: "zh-CN",
      studentId: "S-explicit-english",
      phase: "training",
      taskId: "training_task_1",
      learnerInput: "I mean answer all questions in English.",
      targetAgentIds: ["A1"],
      workspaceState: {
        currentStep: "guide",
      },
    }, {
      modelProvider: createDeterministicAaisProvider(),
    });

    expect(first.visibleTurns[0]?.content).toContain("direct assists remain");
    expect(first.visibleTurns[0]?.content).not.toMatch(/[\u4e00-\u9fff]/);

    const second = await runAaisLearningGuideGraph({
      locale: "zh-CN",
      studentId: "S-explicit-english",
      phase: "training",
      taskId: "training_task_1",
      learnerInput: "I do not have the target.",
      targetAgentIds: ["A1"],
      conversationHistory: [
        { kind: "user", text: "I mean answer all questions in English." },
        { kind: "assistant", text: first.messageText },
      ],
      workspaceState: {
        currentStep: "guide",
      },
    }, {
      modelProvider: createDeterministicAaisProvider(),
    });

    expect(second.visibleTurns[0]?.content).toContain("direct assists remain");
    expect(second.visibleTurns[0]?.content).not.toMatch(/[\u4e00-\u9fff]/);
  });

  it("gives A1 the prior learner context when the learner refers back to a stated difficulty", async () => {
    const generate = vi.fn(async (request: AaisModelRequest) => ({
      text: `${request.agentId} received context`,
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

    await runAaisLearningGuideGraph({
      locale: "zh-CN",
      studentId: "S-context",
      phase: "training",
      taskId: "training_task_1",
      learnerInput: "@小张 我刚才说的卡点是什么？",
      targetAgentIds: ["A1"],
      conversationHistory: [
        { kind: "user", text: "我的卡点是高性能虚拟滚动列表。" },
        { kind: "assistant", text: "请先说明具体困难。" },
      ],
      workspaceState: {
        currentStep: "guide",
      },
    }, {
      modelProvider: { generate },
    });

    const [request] = generate.mock.calls[0] ?? [];
    expect(request?.conversationHistory).toEqual([
      { kind: "user", text: "我的卡点是高性能虚拟滚动列表。" },
      { kind: "assistant", text: "请先说明具体困难。" },
    ]);
  });

  it("uses contextual local scaffold text when A2 falls back for a learner topic", async () => {
    const result = await runAaisLearningGuideGraph({
      locale: "zh-CN",
      studentId: "S-a2-contextual-fallback",
      phase: "training",
      taskId: "training_task_1",
      learnerInput: "@A2 帮我分析下，如何学习大学微积分？",
      targetAgentIds: ["A2"],
      workspaceState: {
        currentStep: "guide",
      },
    }, {
      modelProvider: createDeterministicAaisProvider(),
    });

    expect(result.visibleTurns).toEqual([
      expect.objectContaining({
        agentId: "A2",
        content: expect.stringContaining("本地支架模式"),
      }),
    ]);
    expect(result.visibleTurns[0]?.content).toContain("大学微积分");
    expect(result.visibleTurns[0]?.content).toContain("概念");
    expect(result.visibleTurns[0]?.content).not.toContain("两位专家会在 Modelling 阶段共同展示元认知过程");
  });

  it("starts default A1 and A2 provider work in parallel", async () => {
    const releases = {
      A1: createDeferred<void>(),
      A2: createDeferred<void>(),
    };
    const generate = vi.fn(async (request: AaisModelRequest) => {
      const release = releases[request.agentId as "A1" | "A2"];
      if (release) {
        await release.promise;
      }
      return {
        text: `${request.agentId} parallel provider response`,
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
      };
    });
    const modelProvider: AaisModelProvider = { generate };
    const resultPromise = runAaisLearningGuideGraph({
      locale: "zh-CN",
      studentId: "S-parallel",
      phase: "training",
      taskId: "training_task_1",
      learnerInput: "请同时给我导学和专家建议。",
      workspaceState: {
        currentStep: "guide",
      },
    }, {
      modelProvider,
    });

    try {
      await waitUntil(() => generate.mock.calls.length >= 2);
      expect(generate.mock.calls.map(([request]) => request.agentId)).toEqual(["A1", "A2"]);
    } finally {
      releases.A1.resolve();
      releases.A2.resolve();
    }

    const result = await resultPromise;
    expect(result.visibleTurns.map((turn) => turn.agentId)).toEqual(["A1", "A2"]);
    expect(result.backgroundTurns.map((turn) => turn.agentId)).toEqual(["A3", "A4"]);
    expect(result.runtime.timings.agents.filter((agent) => agent.visible).map((agent) => agent.agentId)).toEqual([
      "A1",
      "A2",
    ]);
  });

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
    expect(result.visibleTurns.map((turn) => turn.agentId)).toEqual(["A1", "A2"]);
    expect(result.backgroundTurns.map((turn) => turn.agentId)).toEqual(["A3", "A4"]);
    expect(result.turns[0].label).toBe("小张");
    expect(result.turns[0].content).toContain("还可直接求助 3 次");
    expect(result.turns[0].content.length).toBeLessThanOrEqual(120);
    expect(result.turns[1].content).toContain("教授");
    expect(result.turns[1].content).toContain("本地支架模式");
    expect(result.turns[1].content).toContain("Modelling/Coaching");
    expect(result.turns[1].content).toContain("@");
    expect(result.turns[2].content).toContain("监督智能体");
    expect(result.turns[2].content).toContain("向 A1 发出信号");
    expect(result.turns[3].content).toContain("反思智能体");
    expect(result.turns[3].content).toContain("反思性提问");
    expect(result.runtime.redaction).toEqual({
      secrets: "omitted",
      localFiles: "omitted",
      assets: "ids-only",
    });
  });

  it("uses a governed model provider for visible agent turns when configured", async () => {
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

    expect(generate).toHaveBeenCalledTimes(2);
    expect(generate.mock.calls.map(([request]) => request.caBackground?.framework)).toEqual([
      "Cognitive Apprenticeship",
      "Cognitive Apprenticeship",
    ]);
    expect(generate.mock.calls[0]?.[0].caBackground?.principles.map((principle) => principle.id)).toEqual([
      "modelling",
      "coaching",
      "scaffolding",
      "fading",
      "articulation",
      "reflection",
    ]);
    expect(generate.mock.calls[0]?.[0].voice).toMatchObject({
      persona: expect.stringContaining("同龄学长"),
      maxSentences: 2,
      maxCharacters: 120,
      maxOutputTokens: 120,
    });
    expect(generate.mock.calls[1]?.[0].voice).toMatchObject({
      persona: expect.stringContaining("教授型专家教练"),
      replyContract: expect.stringContaining("专家思路"),
    });
    expect(generate.mock.calls[0]?.[0].voice?.persona).not.toBe(
      generate.mock.calls[1]?.[0].voice?.persona,
    );
    expect(result.turns.map((turn) => turn.content)).toEqual([
      "小张 governed provider response",
      "教授 governed provider response",
      expect.stringContaining("监督智能体"),
      expect.stringContaining("反思智能体"),
    ]);
    expect(result.visibleTurns.map((turn) => turn.content)).toEqual([
      "小张 governed provider response",
      "教授 governed provider response",
    ]);
    expect(result.backgroundTurns.map((turn) => turn.content)).toEqual([
      expect.stringContaining("监督智能体"),
      expect.stringContaining("反思智能体"),
    ]);
    expect(result.runtime.modelProvider).toMatchObject({
      provider: "mixed",
      generatedTurns: 4,
      redaction: {
        secrets: "omitted",
      },
    });
  });

  it("passes bounded guide attachment context to every governed provider turn", async () => {
    const longAttachmentText = `${"a".repeat(12_000)}tail-marker`;
    const generate = vi.fn(async (request: AaisModelRequest) => ({
        text: `${request.agentId} read ${request.workspaceState.attachments?.[0]?.name}`,
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
      studentId: "S-upload-context",
      phase: "training",
      taskId: "training_task_1",
      learnerInput: "请阅读上传文件。",
      workspaceState: {
        currentStep: "guide",
        attachments: [
          {
            name: "long-notes.txt",
            mediaType: "text/plain",
            sizeBytes: longAttachmentText.length,
            extractedText: longAttachmentText,
          },
        ],
      },
    }, {
      modelProvider,
    });

    expect(generate).toHaveBeenCalledTimes(2);
    for (const [request] of generate.mock.calls) {
      expect(request.workspaceState.attachments).toHaveLength(1);
      expect(request.workspaceState.attachments?.[0]).toMatchObject({
        name: "long-notes.txt",
        mediaType: "text/plain",
      });
      expect(request.workspaceState.attachments?.[0]?.extractedText).toHaveLength(12_000);
      expect(request.workspaceState.attachments?.[0]?.extractedText).not.toContain("tail-marker");
    }
    expect(result.messageText).toContain("long-notes.txt");
  });

  it("propagates caller cancellation through LangGraph without converting it to fallback", async () => {
    const controller = new AbortController();
    let notifyGenerateStarted!: () => void;
    const generateStarted = new Promise<void>((resolve) => {
      notifyGenerateStarted = resolve;
    });
    const generate = vi.fn((request: AaisModelRequest) => {
      notifyGenerateStarted();
      return new Promise<never>((_resolve, reject) => {
        request.signal?.addEventListener(
          "abort",
          () => reject(request.signal?.reason),
          { once: true },
        );
      });
    });

    const result = runAaisLearningGuideGraph({
      locale: "zh-CN",
      studentId: "S-cancelled-graph",
      phase: "training",
      taskId: "training_task_1",
      learnerInput: "@A1 这个请求会被取消。",
      targetAgentIds: ["A1"],
      workspaceState: { currentStep: "guide" },
    }, {
      modelProvider: { generate },
      signal: controller.signal,
    });
    await generateStarted;
    controller.abort();

    await expect(result).rejects.toMatchObject({ name: "AbortError" });
    expect(generate).toHaveBeenCalledTimes(1);
    expect(generate.mock.calls[0]?.[0].signal?.aborted).toBe(true);
  });
});

function createDeferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((nextResolve) => {
    resolve = nextResolve;
  });
  return { promise, resolve };
}

async function waitUntil(predicate: () => boolean) {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    if (predicate()) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
}
