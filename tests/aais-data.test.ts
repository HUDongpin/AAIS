import { describe, expect, it } from "vitest";
import {
  aaisAgents,
  aaisCognitiveApprenticeshipBackground,
  aaisLearningProgram,
  createAaisEvent,
  escapeAaisCsvField,
  exportAaisEventsAsCsv,
  type LocalizedText,
} from "@/data/aais";
import {
  aaisCoursePackages,
  aaisPilotLearningMilestoneIds,
  caasiPilotCoursePackage,
  caasiPilotTaskAllowlist,
  getAaisCoursePackage,
  getCaasiPilotTaskDefinition,
} from "@/data/aais-course-packages";
import * as aaisData from "@/data/aais";

function expectBilingualText(text: LocalizedText) {
  expect(text["zh-CN"].trim().length).toBeGreaterThan(0);
  expect(text["en-US"].trim().length).toBeGreaterThan(0);
}

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

  it("defines one versioned, teacher-review-gated pilot course package", () => {
    expect(aaisCoursePackages).toHaveLength(1);
    expect(getAaisCoursePackage(
      "caasi-metacognition-pilot",
      "0.1.0-pilot.1",
    )).toBe(caasiPilotCoursePackage);
    expect(getAaisCoursePackage("caasi-metacognition-pilot", "not-a-version"))
      .toBeUndefined();
    expect(caasiPilotCoursePackage).toMatchObject({
      schemaVersion: "aais-course-package/v1",
      version: "0.1.0-pilot.1",
      locale: {
        default: "zh-CN",
        supported: ["zh-CN", "en-US"],
      },
      teacherReview: {
        status: "pending",
        requirement: "review-required",
        reviewRequired: true,
        reviewedAt: null,
        reviewerId: null,
      },
      agentIds: ["A1", "A2", "A3", "A4"],
    });
    expectBilingualText(caasiPilotCoursePackage.course.title);
    expectBilingualText(caasiPilotCoursePackage.course.description);
    expectBilingualText(caasiPilotCoursePackage.course.audience);
    expectBilingualText(caasiPilotCoursePackage.teacherReview.note);
  });

  it("uses the seven canonical internal learning milestone IDs without aliases", () => {
    const milestoneIds: readonly string[] = caasiPilotCoursePackage.milestones.map(
      (milestone) => milestone.id,
    );
    expect(aaisPilotLearningMilestoneIds).toEqual([
      "launch_import",
      "modeling",
      "coaching_scaffolding",
      "exploration",
      "articulation",
      "reflection",
      "summary_completion",
    ]);
    expect(milestoneIds).toEqual(aaisPilotLearningMilestoneIds);
    expect(caasiPilotCoursePackage.milestones.map((milestone) => milestone.order))
      .toEqual([0, 1, 2, 3, 4, 5, 6]);
    expect(caasiPilotCoursePackage.milestones.every((milestone) => milestone.internal))
      .toBe(true);
    expect(milestoneIds).not.toContain("modelling");
    expect(milestoneIds).not.toContain("summary_close");
    for (const milestone of caasiPilotCoursePackage.milestones) {
      expectBilingualText(milestone.label);
      expectBilingualText(milestone.description);
      expect(milestone.ownerAgentIds.length).toBeGreaterThan(0);
    }
  });

  it("provides a bilingual circle-area expert model with steps, monitoring, and rubric", () => {
    const expertModel = caasiPilotCoursePackage.expertModel;

    expect(expertModel).toMatchObject({
      milestoneId: "modeling",
      ownerAgentId: "A2",
      role: {
        "zh-CN": "具有小学数学教学与教育测量经验的专家",
        "en-US": "An expert in primary mathematics teaching and educational measurement",
      },
      context: {
        durationMinutes: 20,
        totalPoints: 100,
      },
    });
    expect(expertModel.learningDimensions.map((dimension) => dimension.id)).toEqual([
      "concept_understanding",
      "formula_application",
      "derivation_reasoning",
    ]);
    expect(expertModel.steps.map((step) => step.id)).toEqual([
      "analyze_task",
      "set_learning_goals",
      "draft_prompt",
      "monitor_generation",
      "evaluate_and_revise",
    ]);
    expect(expertModel.monitoringCheckpoints.map((checkpoint) => checkpoint.id)).toEqual([
      "before_prompt",
      "after_draft",
      "before_acceptance",
    ]);
    expect(expertModel.rubric.map((criterion) => criterion.id)).toEqual([
      "goal_alignment",
      "mathematical_accuracy",
      "cognitive_level",
      "clarity",
      "difficulty_balance",
    ]);
    expect(expertModel.promptTemplate["zh-CN"]).toContain("四年级");
    expect(expertModel.promptTemplate["zh-CN"]).toContain("20 分钟");
    expect(expertModel.promptTemplate["zh-CN"]).toContain("100 分");
    expect(expertModel.promptTemplate["zh-CN"]).toContain("S = πr²");
    expect(expertModel.promptTemplate["zh-CN"]).toContain("化曲为直");
    expectBilingualText(expertModel.title);
    expectBilingualText(expertModel.role);
    expectBilingualText(expertModel.promptTemplate);
    for (const dimension of expertModel.learningDimensions) {
      expectBilingualText(dimension.label);
      expectBilingualText(dimension.evidence);
    }
    for (const step of expertModel.steps) {
      expectBilingualText(step.title);
      expectBilingualText(step.thinkAloud);
    }
    for (const checkpoint of expertModel.monitoringCheckpoints) {
      expectBilingualText(checkpoint.label);
      checkpoint.checks.forEach(expectBilingualText);
    }
    for (const criterion of expertModel.rubric) {
      expectBilingualText(criterion.label);
      expectBilingualText(criterion.check);
    }
  });

  it("absorbs only the approved Task 2-to-Task 4 pilot content", () => {
    expect(caasiPilotTaskAllowlist).toEqual([
      "practice_task_1",
      "practice_task_2",
      "practice_task_3",
    ]);
    expect(caasiPilotCoursePackage.taskAllowlist).toEqual(caasiPilotTaskAllowlist);
    expect(caasiPilotCoursePackage.tasks.map((task) => [
      task.taskId,
      task.visibleTaskNumber,
      task.availability,
    ])).toEqual([
      ["practice_task_1", 2, "available"],
      ["practice_task_2", 3, "pilot-closed"],
      ["practice_task_3", 4, "available"],
    ]);

    const taskTwo = getCaasiPilotTaskDefinition("practice_task_1");
    const taskThree = getCaasiPilotTaskDefinition("practice_task_2");
    const taskFour = getCaasiPilotTaskDefinition("practice_task_3");
    const taskTwoContent = JSON.stringify(taskTwo?.cardSections);
    const taskFourContent = JSON.stringify(taskFour?.cardSections);

    expect(taskTwo?.exerciseIds).toEqual(["exercise_1", "exercise_2", "exercise_3"]);
    expect(taskTwoContent).toContain("请指出这个提示词的不足并说明理由。");
    expect(taskTwoContent).not.toContain("不足指出");
    expect(taskTwo?.completionRequirements.map((requirement) => requirement.kind)).toEqual([
      "prompt-diagnosis",
      "prompt-revision",
      "output-evaluation",
      "articulation",
    ]);

    expect(taskThree).toMatchObject({
      visibleTaskNumber: 3,
      availability: "pilot-closed",
      cardNote: {
        "zh-CN": "先导实验阶段，任务3暂不开放，完成任务2后，会自动进入任务4",
      },
      exerciseIds: [],
      milestoneIds: [],
      completionRequirements: [],
    });
    expect(taskThree?.cardSections).toBeUndefined();

    expect(taskFour?.exerciseIds).toEqual(["exercise_4"]);
    expect(taskFourContent).toContain("不少于800字");
    expect(taskFourContent).toContain("计划、监控、评价");
    expect(taskFourContent).toContain("偏差、局限或错误");
    expect(taskFour?.milestoneIds).toEqual([
      "exploration",
      "articulation",
      "reflection",
    ]);
    expect(taskFour?.completionRequirements.map((requirement) => requirement.kind)).toEqual([
      "artifact",
      "planning",
      "monitoring",
      "evaluation",
      "output-evaluation",
      "articulation",
      "reflection",
    ]);

    const packageText = JSON.stringify(caasiPilotCoursePackage);
    expect(packageText).not.toContain("exercise_5");
    expect(packageText).not.toContain("练习5");
    expect(getCaasiPilotTaskDefinition("not-allowlisted")).toBeUndefined();
  });

  it("keeps articulation, reflection, and an equal-evidence AI-free path renderable", () => {
    expect(caasiPilotCoursePackage.articulation).toMatchObject({
      milestoneId: "articulation",
      ownerAgentIds: ["A1", "A4"],
      trigger: "after-each-open-task",
    });
    expect(caasiPilotCoursePackage.reflection).toMatchObject({
      milestoneId: "reflection",
      ownerAgentIds: ["A1", "A4"],
      trigger: "after-exploration-task",
    });
    expect(caasiPilotCoursePackage.aiFree).toMatchObject({
      available: true,
      completionParity: "same-required-evidence",
    });
    expect(caasiPilotCoursePackage.aiFree.resources.map((resource) => resource.id)).toEqual([
      "static-expert-model",
      "static-rubric",
      "learner-authored-artifact",
    ]);
    caasiPilotCoursePackage.articulation.prompts.forEach(expectBilingualText);
    caasiPilotCoursePackage.reflection.prompts.forEach(expectBilingualText);
    expectBilingualText(caasiPilotCoursePackage.aiFree.description);
    for (const resource of caasiPilotCoursePackage.aiFree.resources) {
      expectBilingualText(resource.label);
    }
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
      deterministic_guide_prompt_submitted: {
        agent: "platform",
        family: "PLATFORM",
        evidenceKind: "session_lifecycle",
        lrsEligible: false,
      },
      deterministic_guide_response_completed: {
        agent: "platform",
        family: "PLATFORM",
        evidenceKind: "session_lifecycle",
        lrsEligible: false,
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
