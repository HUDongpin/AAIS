import { describe, expect, it } from "vitest";
import {
  classifyAaisLearnerInput,
  createDefaultAaisTaskPilotEvidence,
  isAaisRevisionPolicyActionable,
  selectActionableAaisSupervisionSignals,
  type AaisA3SupervisionSignal,
} from "@/lib/server/aais-learning-loop";

function createSignal(
  type: AaisA3SupervisionSignal["type"],
  source: AaisA3SupervisionSignal["evidence"]["source"] = "artifact",
): AaisA3SupervisionSignal {
  const actions: Record<
    AaisA3SupervisionSignal["type"],
    AaisA3SupervisionSignal["recommendedAction"]
  > = {
    goal_missing: "ask_goal_question",
    plan_missing: "ask_for_plan",
    no_progress: "offer_small_next_step",
    large_regression: "invite_recovery_or_revision",
    output_evaluation_missing: "prompt_output_evaluation",
    explicit_help_requested: "provide_bounded_scaffold",
    reflection_missing: "invite_reflection",
  };
  return {
    id: `signal-${type}`,
    type,
    createdAt: "2026-08-25T01:00:00.000Z",
    basis: "deterministic-rule",
    ruleVersion: "aais-metacognitive-signal-v1",
    cooldownSeconds: 300,
    evidence: {
      source,
      patternVersion: "aais-metacognitive-signal-v1",
    },
    recommendedAction: actions[type],
  };
}

describe("AAIS local guide policy selection", () => {
  it("keeps a new artifact signal for the next successful turn and consumes it exactly once", () => {
    const signal = createSignal("goal_missing");
    const evidence = createDefaultAaisTaskPilotEvidence();
    const beforeResponseEvents = [
      {
        event: "ai_response_completed",
        task: "practice_task_1",
        time: signal.createdAt,
        detail: {},
      },
      {
        event: "monitoring_pause_detected",
        task: "practice_task_1",
        time: signal.createdAt,
        detail: { signal_id: signal.id },
      },
    ];
    const selectionInput = {
      taskId: "practice_task_1",
      artifactText: "目前只有一段初稿内容",
      pilotEvidence: evidence,
      supervisionSignals: [signal],
      guideMessages: [{
        kind: "assistant" as const,
        taskId: "practice_task_1",
        time: signal.createdAt,
        turns: [{ agentId: "A1" }],
      }],
    };

    expect(selectActionableAaisSupervisionSignals({
      ...selectionInput,
      events: beforeResponseEvents,
    })).toEqual([signal]);

    // A failed request writes no ai_response_completed event, so it cannot
    // consume the signal.
    expect(selectActionableAaisSupervisionSignals({
      ...selectionInput,
      events: beforeResponseEvents,
    })).toEqual([signal]);

    expect(selectActionableAaisSupervisionSignals({
      ...selectionInput,
      events: [
        ...beforeResponseEvents,
        {
          event: "ai_response_completed",
          task: "practice_task_1",
          time: "2026-08-25T01:00:01.000Z",
          detail: {},
        },
      ],
    })).toEqual([]);
  });

  it("keeps a same-exchange explicit-help signal for the following turn", () => {
    const signal = createSignal("explicit_help_requested", "guide");
    const events = [
      {
        event: "ai_response_completed",
        task: "practice_task_1",
        time: signal.createdAt,
        detail: {},
      },
      {
        event: "monitoring_pause_detected",
        task: "practice_task_1",
        time: signal.createdAt,
        detail: { signal_id: signal.id },
      },
    ];
    const base = {
      taskId: "practice_task_1",
      artifactText: "目标和计划已经写在草稿中",
      pilotEvidence: createDefaultAaisTaskPilotEvidence(),
      supervisionSignals: [signal],
      events,
    };

    expect(selectActionableAaisSupervisionSignals(base)).toEqual([signal]);
    expect(selectActionableAaisSupervisionSignals({
      ...base,
      events: [
        ...events,
        {
          event: "ai_response_completed",
          task: "practice_task_1",
          time: signal.createdAt,
          detail: {},
        },
      ],
    })).toEqual([]);
  });

  it("removes goal, plan, evaluation and reflection signals once their evidence is resolved", () => {
    const evidence = {
      ...createDefaultAaisTaskPilotEvidence(),
      diagnosisText: "任务目标是形成可评价的试卷。",
      planningText: "先列维度，再分配题型。",
      outputEvaluationText: "结构相关，但推理维度仍需修改。",
      reflectionText: "我会先明确量规再生成。",
      reflectionOutcome: "submitted" as const,
    };
    const signals = [
      createSignal("goal_missing"),
      createSignal("plan_missing"),
      createSignal("output_evaluation_missing"),
      createSignal("reflection_missing", "completion_gate"),
    ];

    expect(selectActionableAaisSupervisionSignals({
      taskId: "practice_task_1",
      artifactText: "已有学习成果",
      pilotEvidence: evidence,
      supervisionSignals: signals,
    })).toEqual([]);
  });

  it("makes revision-required guidance one-shot and lets later learner revision resolve it", () => {
    const evidence = {
      ...createDefaultAaisTaskPilotEvidence(),
      outputEvaluation: "revision_required" as const,
    };
    const rejection = {
      event: "ai_acceptance_recorded",
      task: "practice_task_1",
      time: "2026-08-25T01:00:00.000Z",
      detail: { accepted: false },
    };

    expect(isAaisRevisionPolicyActionable({
      taskId: "practice_task_1",
      pilotEvidence: evidence,
      events: [rejection],
    })).toBe(true);
    expect(isAaisRevisionPolicyActionable({
      taskId: "practice_task_1",
      pilotEvidence: evidence,
      events: [
        rejection,
        {
          event: "ai_response_completed",
          task: "practice_task_1",
          time: "2026-08-25T01:00:01.000Z",
          detail: {},
        },
      ],
    })).toBe(false);
    expect(isAaisRevisionPolicyActionable({
      taskId: "practice_task_1",
      pilotEvidence: evidence,
      events: [
        rejection,
        {
          event: "self_report_saved",
          task: "practice_task_1",
          time: "2026-08-25T01:00:01.000Z",
          detail: { fields: ["revisedPromptText"] },
        },
      ],
    })).toBe(false);
  });

  it("recognizes a direct-answer request that also asks for a quadratic graph", () => {
    expect(classifyAaisLearnerInput(
      "二次函数 y=2x²+3x+4，直接告诉我答案并画图。",
    )).toMatchObject({
      recognizable: true,
      directAnswerRequested: true,
    });
  });
});
