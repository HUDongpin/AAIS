import { describe, expect, it } from "vitest";
import {
  aaisAgents,
  aaisCognitiveApprenticeshipBackground,
  aaisLearningProgram,
  createAaisEvent,
  escapeAaisCsvField,
  exportAaisEventsAsCsv,
} from "@/data/aais";
import * as aaisData from "@/data/aais";

describe("AAIS cognitive apprenticeship data", () => {
  it("keeps only the four agents from the platform requirements", () => {
    expect(aaisAgents.map((agent) => agent.id)).toEqual([
      "A1",
      "A2",
      "A3",
      "A4",
    ]);
    expect(aaisAgents.map((agent) => agent.name["zh-CN"])).toEqual([
      "小张",
      "教授",
      "监督智能体",
      "反思智能体",
    ]);
    expect(aaisAgents.slice(0, 2).map((agent) => agent.handle)).toEqual([
      "@小张",
      "@教授",
    ]);
  });

  it("matches the Cognitive Apprenticeship multi-agent settings from the specification", () => {
    expect(aaisAgents).toEqual([
      expect.objectContaining({
        id: "A1",
        role: expect.objectContaining({
          "zh-CN": "前端，与学生直接对话",
        }),
        mission: expect.objectContaining({
          "zh-CN": expect.stringContaining("4 次直接辅助机会"),
        }),
        caModules: ["Scaffolding", "Fading"],
      }),
      expect.objectContaining({
        id: "A2",
        role: expect.objectContaining({
          "zh-CN": "前端，与学生直接对话",
        }),
        mission: expect.objectContaining({
          "zh-CN": expect.stringContaining("两位专家"),
        }),
        caModules: ["Modelling", "Coaching"],
      }),
      expect.objectContaining({
        id: "A3",
        role: expect.objectContaining({
          "zh-CN": "后端，与 A1 交互",
        }),
        mission: expect.objectContaining({
          "zh-CN": expect.stringContaining("向 A1 发出信号"),
        }),
        caModules: ["Scaffolding"],
      }),
      expect.objectContaining({
        id: "A4",
        role: expect.objectContaining({
          "zh-CN": "后端，与 A1 交互",
        }),
        mission: expect.objectContaining({
          "zh-CN": expect.stringContaining("反思性提问"),
        }),
        caModules: ["Articulation", "Reflection"],
      }),
    ]);
  });

  it("gives A1 and A2 distinct voices and keeps A1 deliberately brief", () => {
    const a1 = aaisAgents.find((agent) => agent.id === "A1");
    const a2 = aaisAgents.find((agent) => agent.id === "A2");

    expect(a1?.voice).toMatchObject({
      persona: {
        "zh-CN": expect.stringContaining("同龄学长"),
      },
      tone: {
        "zh-CN": expect.stringContaining("温和直接"),
      },
      replyContract: {
        "zh-CN": expect.stringContaining("最多 2 句"),
      },
      maxSentences: 2,
      maxCharacters: {
        "zh-CN": 120,
        "en-US": 240,
      },
      maxOutputTokens: 120,
    });
    expect(a2?.voice).toMatchObject({
      persona: {
        "zh-CN": expect.stringContaining("教授型专家教练"),
      },
      tone: {
        "zh-CN": expect.stringContaining("思维示范"),
      },
      replyContract: {
        "zh-CN": expect.stringContaining("专家思路"),
      },
    });
    expect(a1?.voice?.persona["zh-CN"]).not.toBe(a2?.voice?.persona["zh-CN"]);
    expect(a1?.voice?.tone["zh-CN"]).not.toBe(a2?.voice?.tone["zh-CN"]);
  });

  it("keeps a runtime Cognitive Apprenticeship background model for the agents", () => {
    expect(aaisCognitiveApprenticeshipBackground.framework).toBe("Cognitive Apprenticeship");
    expect(aaisCognitiveApprenticeshipBackground.sequence).toEqual([
      "Modelling",
      "Coaching",
      "Scaffolding",
      "Articulation",
      "Reflection",
    ]);
    expect(aaisCognitiveApprenticeshipBackground.principles).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: "modelling",
          module: "Modelling",
          description: expect.objectContaining({
            "zh-CN": expect.stringContaining("专家"),
          }),
        }),
        expect.objectContaining({
          id: "coaching",
          module: "Coaching",
          aaisUse: expect.objectContaining({
            "zh-CN": expect.stringContaining("练习"),
          }),
        }),
        expect.objectContaining({
          id: "scaffolding",
          module: "Scaffolding",
          aaisUse: expect.objectContaining({
            "zh-CN": expect.stringContaining("4 次直接辅助"),
          }),
        }),
        expect.objectContaining({
          id: "fading",
          module: "Fading",
          description: expect.objectContaining({
            "zh-CN": expect.stringContaining("逐步减少"),
          }),
        }),
        expect.objectContaining({
          id: "articulation",
          module: "Articulation",
          aaisUse: expect.objectContaining({
            "zh-CN": expect.stringContaining("文字表达"),
          }),
        }),
        expect.objectContaining({
          id: "reflection",
          module: "Reflection",
          aaisUse: expect.objectContaining({
            "zh-CN": expect.stringContaining("专家"),
          }),
        }),
      ]),
    );
  });

  it("models one guided training task and three locked practice tasks", () => {
    expect(aaisLearningProgram.training.tasks).toHaveLength(1);
    expect(aaisLearningProgram.practice.tasks.map((task) => task.difficulty)).toEqual([
      "easy",
      "medium",
      "hard",
    ]);
    expect(aaisLearningProgram.practice.tasks.map((task) => task.lockedUntilPreviousComplete)).toEqual([
      false,
      true,
      true,
    ]);
  });

  it("records product-language events with learner, session, phase, task, agent, and detail fields", () => {
    const event = createAaisEvent({
      studentId: "S001",
      sessionId: "session-S001-2026",
      phase: "training",
      task: "training_task_1",
      agent: "A2",
      event: "coaching_push",
      detail: {
        trigger: "long_inactivity",
      },
      now: () => new Date("2026-07-15T14:32:08.123Z"),
    });

    expect(event).toMatchObject({
      student_id: "S001",
      session_id: "session-S001-2026",
      phase: "training",
      task: "training_task_1",
      agent: "A2",
      event: "coaching_push",
      time: "2026-07-15T14:32:08.123Z",
      detail: {
        trigger: "long_inactivity",
      },
    });
  });

  it("defines cognitive apprenticeship event families for A1 through A4 and platform events", () => {
    expect(aaisData.aaisEventDefinitions).toMatchObject({
      expert_model_viewed: {
        agent: "A2",
        family: "A2_EXPERT",
        evidenceKind: "expert_modeling",
      },
      understanding_check_completed: {
        agent: "A1",
        family: "A1_GUIDE",
        evidenceKind: "understanding_check",
      },
      task_released: {
        agent: "A1",
        family: "A1_GUIDE",
        evidenceKind: "task_release",
      },
      monitoring_pause_detected: {
        agent: "A3",
        family: "A3_SUPERVISION",
        evidenceKind: "monitoring",
      },
      coaching_push: {
        agent: "A2",
        family: "A2_EXPERT",
        evidenceKind: "coaching",
      },
      articulation_submitted: {
        agent: "A4",
        family: "A4_REFLECTION",
        evidenceKind: "articulation",
      },
      expert_trace_compared: {
        agent: "A4",
        family: "A4_REFLECTION",
        evidenceKind: "expert_trace_comparison",
      },
      scaffold_request: {
        agent: "A1",
        family: "A1_GUIDE",
        evidenceKind: "scaffold",
      },
      scaffold_self_check_started: {
        agent: "A1",
        family: "A1_GUIDE",
        evidenceKind: "self_check",
      },
      stage_selected: {
        agent: "platform",
        family: "PLATFORM",
        evidenceKind: "stage_navigation",
      },
    });
  });

  it("exports events as analysis-ready CSV", () => {
    const event = createAaisEvent({
      studentId: "S001",
      phase: "practice",
      task: "practice_task_1",
      agent: "A1",
      event: "scaffold_request",
      detail: {
        tool: "阶段检查表",
      },
      now: () => new Date("2026-07-15T14:33:08.123Z"),
    });

    expect(exportAaisEventsAsCsv([event])).toContain(
      "student_id,session_id,phase,task,agent,event,time,detail",
    );
    expect(exportAaisEventsAsCsv([event])).toContain("practice_task_1");
  });

  it("escapes CSV fields defensively for spreadsheet and BI imports", () => {
    expect(escapeAaisCsvField("=cmd|'/C calc'!A0")).toBe("'=cmd|'/C calc'!A0");
    expect(escapeAaisCsvField("+SUM(A1:A2)")).toBe("'+SUM(A1:A2)");
    expect(escapeAaisCsvField(" -10")).toBe("' -10");
    expect(escapeAaisCsvField("@lookup")).toBe("'@lookup");
    expect(escapeAaisCsvField('safe, "quoted"')).toBe('"safe, ""quoted"""');

    const event = createAaisEvent({
      studentId: "=S001",
      sessionId: "session:=S001",
      phase: "practice",
      task: "practice_task_1",
      agent: "A1",
      event: "scaffold_request",
      detail: {
        note: "=raw learner formula should be nested inside JSON detail",
      },
      now: () => new Date("2026-07-15T14:33:08.123Z"),
    });

    const csv = exportAaisEventsAsCsv([event]);

    expect(csv).toContain("'=S001");
    expect(csv).not.toContain("\n=S001");
  });
});
