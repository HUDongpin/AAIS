export type Locale = "zh-CN" | "en-US";

export type LocalizedText = Record<Locale, string>;

export type AaisAgentId = "A1" | "A2" | "A3" | "A4";

export type AaisPhase = "training" | "practice";

export type AaisTaskDifficulty = "training" | "easy" | "medium" | "hard";

export type AaisCaModule =
  | "Articulation"
  | "Coaching"
  | "Fading"
  | "Modelling"
  | "Reflection"
  | "Scaffolding";

export type AaisCaPrincipleId =
  | "articulation"
  | "coaching"
  | "fading"
  | "modelling"
  | "reflection"
  | "scaffolding";

export type AaisCaPrinciple = {
  id: AaisCaPrincipleId;
  module: AaisCaModule;
  label: LocalizedText;
  description: LocalizedText;
  aaisUse: LocalizedText;
};

export type AaisCognitiveApprenticeshipBackground = {
  framework: "Cognitive Apprenticeship";
  learningGoal: LocalizedText;
  sequence: AaisCaModule[];
  principles: AaisCaPrinciple[];
};

export type AaisEventFamily =
  | "A1_GUIDE"
  | "A2_EXPERT"
  | "A3_SUPERVISION"
  | "A4_REFLECTION"
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
  | "recommendation_override"
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
  | "recommendation_override_recorded"
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

export type AaisAgentVoice = {
  persona: LocalizedText;
  tone: LocalizedText;
  replyContract: LocalizedText;
  maxSentences?: number;
  maxCharacters?: Record<Locale, number>;
  maxOutputTokens?: number;
};

export type AaisAgent = {
  id: AaisAgentId;
  handle: string;
  name: LocalizedText;
  role: LocalizedText;
  mission: LocalizedText;
  voice?: AaisAgentVoice;
  caModules: AaisCaModule[];
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

export const aaisCognitiveApprenticeshipBackground: AaisCognitiveApprenticeshipBackground = {
  framework: "Cognitive Apprenticeship",
  learningGoal: {
    "zh-CN": "让学生在真实任务中观察专家元认知、练习策略、表达过程，并通过反馈反思逐步独立完成任务。",
    "en-US":
      "Help learners observe expert metacognition, practice strategies, articulate process evidence, and reflect toward independent task performance.",
  },
  sequence: ["Modelling", "Coaching", "Scaffolding", "Articulation", "Reflection"],
  principles: [
    {
      id: "modelling",
      module: "Modelling",
      label: {
        "zh-CN": "专家示范",
        "en-US": "Expert modelling",
      },
      description: {
        "zh-CN": "专家公开展示如何理解任务、设定目标、监控执行并修正思路，使隐性的元认知过程可见。",
        "en-US":
          "Experts make task interpretation, goal setting, monitoring, and revision visible so tacit metacognition can be observed.",
      },
      aaisUse: {
        "zh-CN": "A2 以两位专家共同完成一个任务的方式展示元认知过程。",
        "en-US": "A2 uses a two-expert task demonstration to make metacognitive process visible.",
      },
    },
    {
      id: "coaching",
      module: "Coaching",
      label: {
        "zh-CN": "练习教练",
        "en-US": "Coaching",
      },
      description: {
        "zh-CN": "学生练习时获得针对任务表现的提示、追问和反馈，而不是直接代做答案。",
        "en-US":
          "Learners receive task-responsive prompts, questions, and feedback during practice without having the work done for them.",
      },
      aaisUse: {
        "zh-CN": "A2 在学生练习学习内容时继续提供专家式追问和教练反馈。",
        "en-US": "A2 continues expert questioning and coaching feedback while learners practice.",
      },
    },
    {
      id: "scaffolding",
      module: "Scaffolding",
      label: {
        "zh-CN": "支架",
        "en-US": "Scaffolding",
      },
      description: {
        "zh-CN": "系统在学习者还不能独立完成时提供结构化帮助，帮助其跨过当前任务难点。",
        "en-US":
          "The system provides structured help when learners cannot yet complete the task independently.",
      },
      aaisUse: {
        "zh-CN": "A1 管理每个任务 4 次直接辅助机会；A3 只在后端发信号，由 A1 给出 scaffolds。",
        "en-US":
          "A1 manages four direct help opportunities per task; A3 only signals from the backend so A1 provides scaffolds.",
      },
    },
    {
      id: "fading",
      module: "Fading",
      label: {
        "zh-CN": "逐步撤除",
        "en-US": "Fading",
      },
      description: {
        "zh-CN": "随着学生能力增长，直接帮助逐步减少，先转为对话诊断，再给一定程度协助。",
        "en-US":
          "Direct help is gradually reduced as learners gain capability, shifting first to diagnostic dialogue and then limited assistance.",
      },
      aaisUse: {
        "zh-CN": "A1 在 4 次直接辅助用完后先询问卡点，再提供有限支架。",
        "en-US": "After four direct assists, A1 asks about the sticking point before offering limited support.",
      },
    },
    {
      id: "articulation",
      module: "Articulation",
      label: {
        "zh-CN": "表达过程",
        "en-US": "Articulation",
      },
      description: {
        "zh-CN": "学生把理解、计划、监控、调整和依据说出来或写出来，使思维过程可以被反馈。",
        "en-US":
          "Learners make understanding, planning, monitoring, adjustments, and evidence explicit so the process can be reviewed.",
      },
      aaisUse: {
        "zh-CN": "A4 通过 A1 要求学生用文字表达解决问题时的元认知过程并形成记录。",
        "en-US":
          "A4 works through A1 prompts that ask learners to write their metacognitive process and create records.",
      },
    },
    {
      id: "reflection",
      module: "Reflection",
      label: {
        "zh-CN": "反思",
        "en-US": "Reflection",
      },
      description: {
        "zh-CN": "学生回看自己的过程记录，与专家过程对比，回答反思性提问并调整下一轮策略。",
        "en-US":
          "Learners revisit their process records, compare them with expert processes, answer reflective prompts, and adjust future strategy.",
      },
      aaisUse: {
        "zh-CN": "A4 将报告反馈给学生，进行反思性提问，并与专家对比评估。",
        "en-US":
          "A4 returns reports to learners, asks reflective questions, and compares student process with expert process.",
      },
    },
  ],
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
    family: "A2_EXPERT",
    evidenceKind: "ai_interaction",
    description: "Learner accepted or rejected an AI suggestion with a reason.",
  },
  ai_prompt_submitted: {
    agent: "A2",
    family: "A2_EXPERT",
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
    agent: "A3",
    family: "A3_SUPERVISION",
    evidenceKind: "artifact",
    description: "A3 captured learner artifact editing behavior locally.",
  },
  artifact_saved: {
    agent: "A3",
    family: "A3_SUPERVISION",
    evidenceKind: "planning",
    description: "A3 captured saved task understanding, plan, execution notes, or final artifact.",
  },
  articulation_submitted: {
    agent: "A4",
    family: "A4_REFLECTION",
    evidenceKind: "articulation",
    description: "A4 recorded learner-articulated thinking during or after a task moment.",
  },
  coaching_push: {
    agent: "A2",
    family: "A2_EXPERT",
    evidenceKind: "coaching",
    description: "A2 delivered low-interruption coaching from A3 behavior signals.",
  },
  expert_model_viewed: {
    agent: "A2",
    family: "A2_EXPERT",
    evidenceKind: "expert_modeling",
    description: "Learner reached A2 expert modeling.",
  },
  expert_trace_compared: {
    agent: "A4",
    family: "A4_REFLECTION",
    evidenceKind: "expert_trace_comparison",
    description: "A4 compared the learner trace with the expert trace.",
  },
  monitoring_pause_detected: {
    agent: "A3",
    family: "A3_SUPERVISION",
    evidenceKind: "monitoring",
    description: "A3 detected a pause or possible stuck moment and signaled A1/A2.",
  },
  planning_submitted: {
    agent: "A3",
    family: "A3_SUPERVISION",
    evidenceKind: "planning",
    description: "A3 captured a planning artifact for a task.",
  },
  recommendation_override_recorded: {
    agent: "platform",
    family: "PLATFORM",
    evidenceKind: "recommendation_override",
    description: "Teacher or admin recorded an override decision for a rule-based recommendation.",
  },
  scaffold_request: {
    agent: "A1",
    family: "A1_GUIDE",
    evidenceKind: "scaffold",
    description: "A1 provided a practice-stage scaffold tool.",
  },
  scaffold_self_check_started: {
    agent: "A1",
    family: "A1_GUIDE",
    evidenceKind: "self_check",
    description: "A1 switched repeated practice-stage help into self-check mode.",
  },
  self_report_saved: {
    agent: "A4",
    family: "A4_REFLECTION",
    evidenceKind: "self_report",
    description: "A4 saved a self-report comparing learner process with the expert trace.",
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
    handle: "@小张",
    name: {
      "zh-CN": "小张",
      "en-US": "Xiao Zhang",
    },
    role: {
      "zh-CN": "前端，与学生直接对话",
      "en-US": "Front end, direct student dialogue",
    },
    mission: {
      "zh-CN":
        "引导学习流程，把 CA 的核心环节串联起来；每个任务提供 4 次直接辅助机会，用完后先与学生对话，再给一定程度协助，体现 fading。",
      "en-US":
        "Guides the CA learning flow and provides four direct scaffold opportunities per task before fading into dialogue-first support.",
    },
    voice: {
      persona: {
        "zh-CN": "像熟悉学习流程的同龄学长：亲切、可靠、利落；不扮演专家，也不长篇讲课。",
        "en-US":
          "A friendly, reliable peer learning guide who knows the workflow; never acts like the expert or gives a lecture.",
      },
      tone: {
        "zh-CN": "自然口语、温和直接，只指出当前最有用的一步；不复述学生原话，不堆砌 CA 术语。",
        "en-US":
          "Warm, natural, and direct; state only the most useful next step without repeating the learner or piling on CA terminology.",
      },
      replyContract: {
        "zh-CN": "最多 2 句；先给一个可执行的下一步，必要时只问 1 个短问题；不用标题、清单或长解释。",
        "en-US":
          "Use at most 2 sentences. Give one actionable next step and, only if needed, one short question. No headings, lists, or long explanations.",
      },
      maxSentences: 2,
      maxCharacters: {
        "zh-CN": 120,
        "en-US": 240,
      },
      maxOutputTokens: 120,
    },
    caModules: ["Scaffolding", "Fading"],
    phaseScope: "both",
    evidence: ["learning_flow", "scaffold_request", "fading_dialogue"],
  },
  {
    id: "A2",
    handle: "@教授",
    name: {
      "zh-CN": "教授",
      "en-US": "Professor",
    },
    role: {
      "zh-CN": "前端，与学生直接对话",
      "en-US": "Front end, direct student dialogue",
    },
    mission: {
      "zh-CN":
        "作为专家智能体，在 Modelling 阶段展示元认知过程；两位专家共同完成一个任务，随后引导学生练习，学生可用 @ 引出其中一位专家对话。",
      "en-US":
        "Shows metacognitive processes during Modelling with two experts, then coaches practice; learners can mention one expert with @.",
    },
    voice: {
      persona: {
        "zh-CN": "严谨、耐心的教授型专家教练；把专家如何判断、为什么这样做说清楚。",
        "en-US":
          "A rigorous, patient professor-coach who makes expert judgment and its reasoning visible.",
      },
      tone: {
        "zh-CN": "专业但易懂，善用有条理的思维示范、例子和追问；不模仿小张的流程提醒语气。",
        "en-US":
          "Professional but accessible, using structured think-aloud modelling, examples, and coaching questions; never imitates Xiao Zhang's workflow-guide voice.",
      },
      replyContract: {
        "zh-CN": "紧凑呈现专家思路、关键理由和一个练习提示；需要时可用短清单或例子。",
        "en-US":
          "Compactly show the expert approach, the key reason, and one practice prompt; a short list or example is allowed when useful.",
      },
    },
    caModules: ["Modelling", "Coaching"],
    phaseScope: "both",
    evidence: ["expert_modeling", "expert_dialogue", "coaching_practice"],
  },
  {
    id: "A3",
    handle: "@监督智能体",
    name: {
      "zh-CN": "监督智能体",
      "en-US": "Supervision Agent",
    },
    role: {
      "zh-CN": "后端，与 A1 交互",
      "en-US": "Back end, interacts with A1",
    },
    mission: {
      "zh-CN": "收集学生在做任务时的行为数据，向 A1 发出信号，由 A1 给出 scaffolds。",
      "en-US": "Collects task behavior data, signals A1, and lets A1 provide scaffolds.",
    },
    caModules: ["Scaffolding"],
    phaseScope: "both",
    evidence: ["behavior_data", "scaffold_signal", "a1_handoff"],
  },
  {
    id: "A4",
    handle: "@反思智能体",
    name: {
      "zh-CN": "反思智能体",
      "en-US": "Reflection Agent",
    },
    role: {
      "zh-CN": "后端，与 A1 交互",
      "en-US": "Back end, interacts with A1",
    },
    mission: {
      "zh-CN":
        "收集学生解决问题时表现出的元认知过程，由 A1 要求学生用文字表达，之后形成记录和报告；报告反馈给学生后进行反思性提问，并与专家对比评估。",
      "en-US":
        "Collects metacognitive process evidence through A1 prompts, creates a report, then returns reflective questions and expert comparison.",
    },
    caModules: ["Articulation", "Reflection"],
    phaseScope: "both",
    evidence: ["metacognitive_process", "reflection_report", "expert_comparison"],
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
