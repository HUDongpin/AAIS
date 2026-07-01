import { describe, expect, it } from "vitest";
import {
  aaisAgents,
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
      "导学智能体",
      "监督智能体",
      "反思智能体",
      "支架智能体",
    ]);
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
        agent: "A1",
        family: "A1_GUIDE",
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
        agent: "A2",
        family: "A2_MONITOR",
        evidenceKind: "monitoring",
      },
      coaching_push: {
        agent: "A2",
        family: "A2_MONITOR",
        evidenceKind: "coaching",
      },
      articulation_submitted: {
        agent: "A3",
        family: "A3_REFLECTION",
        evidenceKind: "articulation",
      },
      expert_trace_compared: {
        agent: "A3",
        family: "A3_REFLECTION",
        evidenceKind: "expert_trace_comparison",
      },
      scaffold_request: {
        agent: "A4",
        family: "A4_SCAFFOLD",
        evidenceKind: "scaffold",
      },
      scaffold_self_check_started: {
        agent: "A4",
        family: "A4_SCAFFOLD",
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
      agent: "A4",
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
      agent: "A4",
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
