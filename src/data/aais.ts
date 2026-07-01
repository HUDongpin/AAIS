export type Locale = "zh-CN" | "en-US";

export type LocalizedText = Record<Locale, string>;

export type AaisAgentId = "A1" | "A2" | "A3" | "A4";

export type AaisPhase = "training" | "practice";

export type AaisTaskDifficulty = "training" | "easy" | "medium" | "hard";

export type AaisEventFamily =
  | "A1_GUIDE"
  | "A2_MONITOR"
  | "A3_REFLECTION"
  | "A4_SCAFFOLD"
  | "PLATFORM";

export type AaisEvidenceKind =
  | "ai_interaction"
  | "articulation"
  | "artifact"
  | "coaching"
  | "expert_trace_comparison"
  | "expert_modeling"
  | "monitoring"
  | "planning"
  | "scaffold"
  | "self_check"
  | "self_report"
  | "session_lifecycle"
  | "stage_navigation"
  | "task_progress"
  | "task_release"
  | "understanding_check";

export type AaisEventName =
  | "ai_acceptance_recorded"
  | "ai_prompt_submitted"
  | "ai_response_completed"
  | "artifact_edited"
  | "artifact_saved"
  | "articulation_submitted"
  | "coaching_push"
  | "expert_model_viewed"
  | "expert_trace_compared"
  | "monitoring_pause_detected"
  | "planning_submitted"
  | "scaffold_request"
  | "scaffold_self_check_started"
  | "self_report_saved"
  | "session_created"
  | "session_opened"
  | "stage_selected"
  | "task_completed"
  | "task_released"
  | "task_selected"
  | "understanding_check_completed";

export type AaisEventDefinition = {
  agent: AaisAgentId | "platform";
  family: AaisEventFamily;
  evidenceKind: AaisEvidenceKind;
  description: string;
};

export type AaisAgent = {
  id: AaisAgentId;
  handle: string;
  name: LocalizedText;
  mission: LocalizedText;
  phaseScope: "both" | "practice-only";
  evidence: string[];
};

export type AaisLearningTask = {
  id: string;
  phase: AaisPhase;
  title: LocalizedText;
  difficulty: AaisTaskDifficulty;
  lockedUntilPreviousComplete: boolean;
  brief: LocalizedText;
  expertTrace: LocalizedText[];
};

export type AaisLearningProgram = {
  courseTitle: LocalizedText;
  training: {
    title: LocalizedText;
    tasks: AaisLearningTask[];
  };
  practice: {
    title: LocalizedText;
    tasks: AaisLearningTask[];
  };
};

export type AaisEvent = {
  student_id: string;
  session_id: string;
  phase: AaisPhase;
  task: string;
  agent: AaisAgentId | "platform";
  event: AaisEventName;
  time: string;
  detail: Record<string, unknown>;
};

export const aaisEventDefinitions: Record<AaisEventName, AaisEventDefinition> = {
  ai_acceptance_recorded: {
    agent: "A2",
    family: "A2_MONITOR",
    evidenceKind: "ai_interaction",
    description: "Learner accepted or rejected an AI suggestion with a reason.",
  },
  ai_prompt_submitted: {
    agent: "A2",
    family: "A2_MONITOR",
    evidenceKind: "ai_interaction",
    description: "Learner submitted a prompt to the AAIS guide flow.",
  },
  ai_response_completed: {
    agent: "A1",
    family: "A1_GUIDE",
    evidenceKind: "ai_interaction",
    description: "AAIS completed a guided multi-agent response.",
  },
  artifact_edited: {
    agent: "A2",
    family: "A2_MONITOR",
    evidenceKind: "artifact",
    description: "Learner edited the task artifact locally.",
  },
  artifact_saved: {
    agent: "A2",
    family: "A2_MONITOR",
    evidenceKind: "planning",
    description: "Learner saved task understanding, plan, execution notes, or final artifact.",
  },
  articulation_submitted: {
    agent: "A3",
    family: "A3_REFLECTION",
    evidenceKind: "articulation",
    description: "Learner articulated thinking during or after a task moment.",
  },
  coaching_push: {
    agent: "A2",
    family: "A2_MONITOR",
    evidenceKind: "coaching",
    description: "A2 delivered low-interruption coaching from behavior signals.",
  },
  expert_model_viewed: {
    agent: "A1",
    family: "A1_GUIDE",
    evidenceKind: "expert_modeling",
    description: "Learner reached the expert modeling stage.",
  },
  expert_trace_compared: {
    agent: "A3",
    family: "A3_REFLECTION",
    evidenceKind: "expert_trace_comparison",
    description: "Learner reached the student trace versus expert trace comparison.",
  },
  monitoring_pause_detected: {
    agent: "A2",
    family: "A2_MONITOR",
    evidenceKind: "monitoring",
    description: "A2 detected a pause or possible stuck moment.",
  },
  planning_submitted: {
    agent: "A2",
    family: "A2_MONITOR",
    evidenceKind: "planning",
    description: "Learner submitted a planning artifact for a task.",
  },
  scaffold_request: {
    agent: "A4",
    family: "A4_SCAFFOLD",
    evidenceKind: "scaffold",
    description: "Learner requested a practice-stage scaffold tool.",
  },
  scaffold_self_check_started: {
    agent: "A4",
    family: "A4_SCAFFOLD",
    evidenceKind: "self_check",
    description: "A4 switched repeated practice-stage help into self-check mode.",
  },
  self_report_saved: {
    agent: "A3",
    family: "A3_REFLECTION",
    evidenceKind: "self_report",
    description: "Learner saved a self-report comparing their process with the expert trace.",
  },
  session_created: {
    agent: "platform",
    family: "PLATFORM",
    evidenceKind: "session_lifecycle",
    description: "AAIS created a learner session.",
  },
  session_opened: {
    agent: "platform",
    family: "PLATFORM",
    evidenceKind: "session_lifecycle",
    description: "Learner opened the AAIS workspace.",
  },
  stage_selected: {
    agent: "platform",
    family: "PLATFORM",
    evidenceKind: "stage_navigation",
    description: "Learner selected a Cognitive Apprenticeship stage.",
  },
  task_completed: {
    agent: "platform",
    family: "PLATFORM",
    evidenceKind: "task_progress",
    description: "Learner completed a training or practice task.",
  },
  task_released: {
    agent: "A1",
    family: "A1_GUIDE",
    evidenceKind: "task_release",
    description: "A1 released a training or practice task.",
  },
  task_selected: {
    agent: "platform",
    family: "PLATFORM",
    evidenceKind: "task_progress",
    description: "Learner selected an available task.",
  },
  understanding_check_completed: {
    agent: "A1",
    family: "A1_GUIDE",
    evidenceKind: "understanding_check",
    description: "Learner reached or completed the understanding check stage.",
  },
};

export const aaisAgents: AaisAgent[] = [
  {
    id: "A1",
    handle: "@导学智能体",
    name: {
      "zh-CN": "导学智能体",
      "en-US": "Guide Agent",
    },
    mission: {
      "zh-CN": "播放专家示范、组织测评，并按阶段分发训练与练习任务。",
      "en-US": "Runs expert modeling, checks understanding, and releases tasks by phase.",
    },
    phaseScope: "both",
    evidence: ["video_watch", "quiz_score", "task_release"],
  },
  {
    id: "A2",
    handle: "@监督智能体",
    name: {
      "zh-CN": "监督智能体",
      "en-US": "Monitoring Agent",
    },
    mission: {
      "zh-CN": "监测停顿、删改、AI 采纳和平台行为，低打扰地推送引导并打包数据给 A3。",
      "en-US": "Monitors behavior signals, nudges without interruption, and packages data for A3.",
    },
    phaseScope: "both",
    evidence: ["editing_events", "ai_interactions", "coaching_pushes"],
  },
  {
    id: "A3",
    handle: "@反思智能体",
    name: {
      "zh-CN": "反思智能体",
      "en-US": "Reflection Agent",
    },
    mission: {
      "zh-CN": "引导 articulation，整合学生思维轨迹，并与专家轨迹并排对比形成自评。",
      "en-US": "Elicits articulation, organizes the learner trace, and compares it with an expert trace.",
    },
    phaseScope: "both",
    evidence: ["articulation_text", "reflection_report", "expert_comparison"],
  },
  {
    id: "A4",
    handle: "@支架智能体",
    name: {
      "zh-CN": "支架智能体",
      "en-US": "Scaffolding Agent",
    },
    mission: {
      "zh-CN": "在练习阶段按次数提供元认知工具包，只帮助思考，不代做任务。",
      "en-US": "Provides a capped metacognitive toolkit during practice without doing the work.",
    },
    phaseScope: "practice-only",
    evidence: ["scaffold_request", "tool_choice", "self_check_after_four_requests"],
  },
];

export const aaisLearningProgram: AaisLearningProgram = {
  courseTitle: {
    "zh-CN": "Cognitive Apprenticeship: 元认知训练",
    "en-US": "Cognitive Apprenticeship: Metacognition Studio",
  },
  training: {
    title: {
      "zh-CN": "训练阶段",
      "en-US": "Training Stage",
    },
    tasks: [
      {
        id: "training_task_1",
        phase: "training",
        title: {
          "zh-CN": "专家示范后的案例训练",
          "en-US": "Guided case after expert modeling",
        },
        difficulty: "training",
        lockedUntilPreviousComplete: false,
        brief: {
          "zh-CN":
            "阅读一个学习案例，说明任务要求、规划步骤、AI 可以帮助的位置，以及完成前的自我检查标准。",
          "en-US":
            "Read a learning case, restate the task, plan steps, decide where AI can help, and define a final self-check.",
        },
        expertTrace: [
          {
            "zh-CN": "专家先复述目标，再标出不确定条件。",
            "en-US": "The expert restates the goal and marks uncertain conditions first.",
          },
          {
            "zh-CN": "专家将 AI 放在生成备选解释的位置，而不是直接接受答案。",
            "en-US": "The expert uses AI for alternative explanations, not direct acceptance.",
          },
          {
            "zh-CN": "专家完成前回到评分标准，检查证据和边界情况。",
            "en-US": "Before finishing, the expert revisits the rubric, evidence, and boundary cases.",
          },
        ],
      },
    ],
  },
  practice: {
    title: {
      "zh-CN": "练习阶段",
      "en-US": "Practice Stage",
    },
    tasks: [
      {
        id: "practice_task_1",
        phase: "practice",
        title: {
          "zh-CN": "L1 挑战：复述与计划",
          "en-US": "L1 Challenge: Restate and Plan",
        },
        difficulty: "easy",
        lockedUntilPreviousComplete: false,
        brief: {
          "zh-CN": "独立完成一个低难度任务，重点展示你如何理解题目和制定计划。",
          "en-US": "Complete an easier task independently, focusing on task interpretation and planning.",
        },
        expertTrace: [
          {
            "zh-CN": "专家先写出产出物格式，再写步骤。",
            "en-US": "The expert states the output format before writing steps.",
          },
          {
            "zh-CN": "专家只向 AI 询问可能遗漏的检查点。",
            "en-US": "The expert asks AI only for possible missed checkpoints.",
          },
        ],
      },
      {
        id: "practice_task_2",
        phase: "practice",
        title: {
          "zh-CN": "L2 挑战：执行与监控",
          "en-US": "L2 Challenge: Execute and Monitor",
        },
        difficulty: "medium",
        lockedUntilPreviousComplete: true,
        brief: {
          "zh-CN": "完成一个进阶任务，重点记录删改、采纳 AI 建议与偏离计划的原因。",
          "en-US": "Complete a medium task, recording revisions, AI acceptance, and plan changes.",
        },
        expertTrace: [
          {
            "zh-CN": "专家每次采纳 AI 建议都会写下理由。",
            "en-US": "The expert records a reason for every accepted AI suggestion.",
          },
          {
            "zh-CN": "专家发现偏离计划时，先判断是问题变化还是执行失误。",
            "en-US": "When drifting from plan, the expert distinguishes task change from execution error.",
          },
        ],
      },
      {
        id: "practice_task_3",
        phase: "practice",
        title: {
          "zh-CN": "L3 挑战：迁移与自评",
          "en-US": "L3 Challenge: Transfer and Self-Evaluate",
        },
        difficulty: "hard",
        lockedUntilPreviousComplete: true,
        brief: {
          "zh-CN": "完成一个高难度迁移任务，提交最终成果和对专家差异的自评报告。",
          "en-US": "Complete a harder transfer task, then submit the product and self-evaluation.",
        },
        expertTrace: [
          {
            "zh-CN": "专家先列反例和失败条件，再完善答案。",
            "en-US": "The expert lists counterexamples and failure conditions before polishing.",
          },
          {
            "zh-CN": "专家自评分数不只看结果，也看过程证据是否完整。",
            "en-US": "The expert score considers process evidence as well as final output.",
          },
        ],
      },
    ],
  },
};

export const articulationPrompts = [
  "用自己的话说明任务要求是什么？有什么不确定的？",
  "你打算怎么做？哪些步骤用 AI 帮你？",
  "回顾已完成部分：有没有偏离规划？AI 的输出你评估了吗？",
  "通读你的成果：满分 10 分给自己几分？哪里可以改进？",
];

export const scaffoldTools = [
  {
    id: "stage-checklist",
    label: "阶段检查表",
    body: "□ 我能复述任务要求 □ 找到了关键要素 □ 知道产出物是什么 □ 有不确定的点：___",
  },
  {
    id: "sentence-starters",
    label: "思维句子开头",
    body: "这一步我的目标是 ___ / AI 的建议让我觉得 ___，因为 ___ / 如果有第二次机会，我会 ___",
  },
  {
    id: "contrast-case",
    label: "对比案例",
    body: "新手直接写问卷题；专家先分析对象、目的、误差来源，再决定题型。",
  },
  {
    id: "pause-prompt",
    label: "暂停提示",
    body: "你现在在哪个阶段？刚才效率如何？有没有偏离方向？最大困惑是什么？",
  },
];

export function createAaisEvent(input: {
  studentId: string;
  sessionId?: string;
  phase: AaisPhase;
  task: string;
  agent: AaisAgentId | "platform";
  event: AaisEventName;
  detail: Record<string, unknown>;
  now?: () => Date;
}): AaisEvent {
  return {
    student_id: input.studentId,
    session_id: input.sessionId ?? `session:${input.studentId}`,
    phase: input.phase,
    task: input.task,
    agent: input.agent,
    event: input.event,
    time: (input.now ?? (() => new Date()))().toISOString(),
    detail: input.detail,
  };
}

export function exportAaisEventsAsJson(events: AaisEvent[]) {
  return JSON.stringify(events, null, 2);
}

export function exportAaisEventsAsCsv(events: AaisEvent[]) {
  const header = ["student_id", "session_id", "phase", "task", "agent", "event", "time", "detail"];
  const rows = events.map((event) =>
    [
      event.student_id,
      event.session_id,
      event.phase,
      event.task,
      event.agent,
      event.event,
      event.time,
      JSON.stringify(event.detail),
    ]
      .map(escapeAaisCsvField)
      .join(","),
  );
  return [header.join(","), ...rows].join("\n");
}

export function escapeAaisCsvField(value: string) {
  const spreadsheetSafeValue = /^[\s]*[=+\-@]/.test(value)
    ? `'${value}`
    : value;
  if (!/[",\n\r]/.test(spreadsheetSafeValue)) {
    return spreadsheetSafeValue;
  }
  return `"${spreadsheetSafeValue.replaceAll('"', '""')}"`;
}
