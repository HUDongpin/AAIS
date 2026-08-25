import type {
  AaisAgentId,
  AaisPhase,
  AaisTaskDifficulty,
  Locale,
  LocalizedText,
} from "@/data/aais";

export const aaisPilotLearningMilestoneIds = [
  "launch_import",
  "modeling",
  "coaching_scaffolding",
  "exploration",
  "articulation",
  "reflection",
  "summary_completion",
] as const;

export type AaisPilotLearningMilestoneId =
  (typeof aaisPilotLearningMilestoneIds)[number];

export type AaisTaskAvailability = "available" | "pilot-closed";

export type AaisTeacherReview = {
  status: "pending" | "approved" | "changes-requested";
  requirement: "review-required";
  reviewRequired: boolean;
  reviewedAt: string | null;
  reviewerId: string | null;
  note: LocalizedText;
};

export type AaisCoursePackageMilestone = {
  id: AaisPilotLearningMilestoneId;
  order: number;
  internal: true;
  label: LocalizedText;
  description: LocalizedText;
  ownerAgentIds: readonly AaisAgentId[];
};

export type AaisExpertLearningDimensionId =
  | "concept_understanding"
  | "formula_application"
  | "derivation_reasoning";

export type AaisExpertLearningDimension = {
  id: AaisExpertLearningDimensionId;
  label: LocalizedText;
  evidence: LocalizedText;
};

export type AaisExpertModelStepId =
  | "analyze_task"
  | "set_learning_goals"
  | "draft_prompt"
  | "monitor_generation"
  | "evaluate_and_revise";

export type AaisExpertModelStep = {
  id: AaisExpertModelStepId;
  ownerAgentId: "A2";
  title: LocalizedText;
  thinkAloud: LocalizedText;
};

export type AaisExpertMonitoringCheckpoint = {
  id: "before_prompt" | "after_draft" | "before_acceptance";
  label: LocalizedText;
  checks: readonly LocalizedText[];
};

export type AaisExpertRubricCriterionId =
  | "goal_alignment"
  | "mathematical_accuracy"
  | "cognitive_level"
  | "clarity"
  | "difficulty_balance";

export type AaisExpertRubricCriterion = {
  id: AaisExpertRubricCriterionId;
  label: LocalizedText;
  check: LocalizedText;
};

export type AaisCoursePackageCardSection = {
  id: string;
  title: LocalizedText;
  paragraphs?: readonly LocalizedText[];
  bullets?: readonly LocalizedText[];
};

export type AaisTaskCompletionRequirementKind =
  | "artifact"
  | "prompt-diagnosis"
  | "prompt-revision"
  | "output-evaluation"
  | "planning"
  | "monitoring"
  | "evaluation"
  | "articulation"
  | "reflection";

export type AaisTaskCompletionRequirement = {
  id: string;
  kind: AaisTaskCompletionRequirementKind;
  required: boolean;
  label: LocalizedText;
};

export type AaisCoursePackageTask = {
  taskId: "practice_task_1" | "practice_task_2" | "practice_task_3";
  visibleTaskNumber: 2 | 3 | 4;
  phase: Extract<AaisPhase, "practice">;
  difficulty: Exclude<AaisTaskDifficulty, "training">;
  availability: AaisTaskAvailability;
  title: LocalizedText;
  brief: LocalizedText;
  cardNote?: LocalizedText;
  cardSections?: readonly AaisCoursePackageCardSection[];
  exerciseIds: readonly ("exercise_1" | "exercise_2" | "exercise_3" | "exercise_4")[];
  milestoneIds: readonly AaisPilotLearningMilestoneId[];
  completionRequirements: readonly AaisTaskCompletionRequirement[];
};

export type AaisCoursePackage = {
  schemaVersion: "aais-course-package/v1";
  course: {
    id: string;
    title: LocalizedText;
    description: LocalizedText;
    audience: LocalizedText;
  };
  version: string;
  locale: {
    default: Locale;
    supported: readonly Locale[];
  };
  teacherReview: AaisTeacherReview;
  agentIds: readonly AaisAgentId[];
  milestones: readonly AaisCoursePackageMilestone[];
  expertModel: {
    id: string;
    milestoneId: Extract<AaisPilotLearningMilestoneId, "modeling">;
    ownerAgentId: "A2";
    title: LocalizedText;
    role: LocalizedText;
    context: {
      grade: LocalizedText;
      subject: LocalizedText;
      topic: LocalizedText;
      durationMinutes: number;
      totalPoints: number;
    };
    learningDimensions: readonly AaisExpertLearningDimension[];
    steps: readonly AaisExpertModelStep[];
    promptTemplate: LocalizedText;
    monitoringCheckpoints: readonly AaisExpertMonitoringCheckpoint[];
    rubric: readonly AaisExpertRubricCriterion[];
  };
  taskAllowlist: readonly AaisCoursePackageTask["taskId"][];
  tasks: readonly AaisCoursePackageTask[];
  articulation: {
    milestoneId: Extract<AaisPilotLearningMilestoneId, "articulation">;
    ownerAgentIds: readonly ["A1", "A4"];
    trigger: "after-each-open-task";
    prompts: readonly LocalizedText[];
  };
  reflection: {
    milestoneId: Extract<AaisPilotLearningMilestoneId, "reflection">;
    ownerAgentIds: readonly ["A1", "A4"];
    trigger: "after-exploration-task";
    prompts: readonly LocalizedText[];
  };
  aiFree: {
    available: true;
    completionParity: "same-required-evidence";
    description: LocalizedText;
    resources: ReadonlyArray<{
      id: "static-expert-model" | "static-rubric" | "learner-authored-artifact";
      label: LocalizedText;
    }>;
  };
};

export const caasiPilotTaskAllowlist = [
  "practice_task_1",
  "practice_task_2",
  "practice_task_3",
] as const satisfies readonly AaisCoursePackageTask["taskId"][];

export const caasiPilotCoursePackage = {
  schemaVersion: "aais-course-package/v1",
  course: {
    id: "caasi-metacognition-pilot",
    title: {
      "zh-CN": "CAAIS 元认知学习先导课程",
      "en-US": "CAAIS Metacognitive Learning Pilot",
    },
    description: {
      "zh-CN": "通过专家示范、任务练习、表达和反思，学习如何规划、监控并评价使用生成式人工智能的过程。",
      "en-US":
        "Learn to plan, monitor, and evaluate the use of generative AI through expert modelling, task practice, articulation, and reflection.",
    },
    audience: {
      "zh-CN": "参加 CAAIS 先导学习活动的学生",
      "en-US": "Learners participating in the CAAIS pilot learning activity",
    },
  },
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
    note: {
      "zh-CN": "课程包在学生正式使用前必须完成教师审核；当前内容尚未获得教师批准。",
      "en-US":
        "Teacher review is required before formal learner use; this package has not yet been teacher-approved.",
    },
  },
  agentIds: ["A1", "A2", "A3", "A4"],
  milestones: [
    {
      id: "launch_import",
      order: 0,
      internal: true,
      label: {
        "zh-CN": "启动与导入",
        "en-US": "Launch and orientation",
      },
      description: {
        "zh-CN": "由小张介绍学习目标、学习流程和专家示范入口。",
        "en-US": "Xiao Zhang introduces the learning goal, flow, and expert-model entry point.",
      },
      ownerAgentIds: ["A1"],
    },
    {
      id: "modeling",
      order: 1,
      internal: true,
      label: {
        "zh-CN": "专家示范",
        "en-US": "Expert modelling",
      },
      description: {
        "zh-CN": "教授公开展示任务分析、目标设定、提示词设计、过程监控和结果评价。",
        "en-US":
          "Professor makes task analysis, goal setting, prompt design, monitoring, and evaluation visible.",
      },
      ownerAgentIds: ["A2"],
    },
    {
      id: "coaching_scaffolding",
      order: 2,
      internal: true,
      label: {
        "zh-CN": "教练与支架",
        "en-US": "Coaching and scaffolding",
      },
      description: {
        "zh-CN": "学生在任务练习中获得针对当前困难的追问、提示和有限支持。",
        "en-US":
          "Learners receive questions, prompts, and bounded support targeted to current difficulty.",
      },
      ownerAgentIds: ["A1", "A2", "A3"],
    },
    {
      id: "exploration",
      order: 3,
      internal: true,
      label: {
        "zh-CN": "独立探索",
        "en-US": "Independent exploration",
      },
      description: {
        "zh-CN": "学生独立推进开放任务，并在需要时主动向小张或教授求助。",
        "en-US":
          "Learners advance an open task independently and ask Xiao Zhang or Professor for help when needed.",
      },
      ownerAgentIds: ["A1", "A2", "A3"],
    },
    {
      id: "articulation",
      order: 4,
      internal: true,
      label: {
        "zh-CN": "表达",
        "en-US": "Articulation",
      },
      description: {
        "zh-CN": "学生说明自己如何规划、监控和评价，并指出最困难的部分。",
        "en-US":
          "Learners explain how they planned, monitored, and evaluated, and identify the hardest part.",
      },
      ownerAgentIds: ["A1", "A4"],
    },
    {
      id: "reflection",
      order: 5,
      internal: true,
      label: {
        "zh-CN": "反思",
        "en-US": "Reflection",
      },
      description: {
        "zh-CN": "学生比较专家过程与自己的过程，形成下一次可执行的改进策略。",
        "en-US":
          "Learners compare the expert process with their own and form an actionable strategy for next time.",
      },
      ownerAgentIds: ["A1", "A4"],
    },
    {
      id: "summary_completion",
      order: 6,
      internal: true,
      label: {
        "zh-CN": "总结与结束",
        "en-US": "Summary and close",
      },
      description: {
        "zh-CN": "由小张总结元认知策略、生成式人工智能使用原则和后续迁移方向。",
        "en-US":
          "Xiao Zhang summarizes metacognitive strategies, responsible generative-AI use, and transfer to future tasks.",
      },
      ownerAgentIds: ["A1"],
    },
  ],
  expertModel: {
    id: "circle-area-classroom-assessment",
    milestoneId: "modeling",
    ownerAgentId: "A2",
    title: {
      "zh-CN": "专家示范：设计“圆的面积”课堂随堂测试",
      "en-US": "Expert model: design an area-of-a-circle classroom quiz",
    },
    role: {
      "zh-CN": "具有小学数学教学与教育测量经验的专家",
      "en-US": "An expert in primary mathematics teaching and educational measurement",
    },
    context: {
      grade: {
        "zh-CN": "四年级",
        "en-US": "Grade 4",
      },
      subject: {
        "zh-CN": "小学数学",
        "en-US": "Primary mathematics",
      },
      topic: {
        "zh-CN": "圆的面积",
        "en-US": "Area of a circle",
      },
      durationMinutes: 20,
      totalPoints: 100,
    },
    learningDimensions: [
      {
        id: "concept_understanding",
        label: {
          "zh-CN": "概念理解",
          "en-US": "Conceptual understanding",
        },
        evidence: {
          "zh-CN": "学生能用自己的语言解释什么是圆的面积，并区分面积与周长。",
          "en-US":
            "The learner can explain the area of a circle in their own words and distinguish area from circumference.",
        },
      },
      {
        id: "formula_application",
        label: {
          "zh-CN": "公式掌握",
          "en-US": "Formula application",
        },
        evidence: {
          "zh-CN": "学生能正确运用 S = πr² 解决基本计算问题，并处理简单变式。",
          "en-US":
            "The learner can correctly use S = πr² for basic calculations and simple variations.",
        },
      },
      {
        id: "derivation_reasoning",
        label: {
          "zh-CN": "推导过程与推理",
          "en-US": "Derivation and reasoning",
        },
        evidence: {
          "zh-CN": "学生能描述将圆转化为近似长方形等图形的推导思路，理解“化曲为直”。",
          "en-US":
            "The learner can describe transforming a circle into an approximate rectangle or related shape and explain the idea of straightening a curve.",
        },
      },
    ],
    steps: [
      {
        id: "analyze_task",
        ownerAgentId: "A2",
        title: {
          "zh-CN": "分析任务约束",
          "en-US": "Analyze task constraints",
        },
        thinkAloud: {
          "zh-CN": "我先确认对象、教学时点、20 分钟时限和 100 分总分，避免只生成一组没有使用情境的题目。",
          "en-US":
            "I first confirm the learners, instructional timing, 20-minute limit, and 100-point total so the result is not a context-free list of questions.",
        },
      },
      {
        id: "set_learning_goals",
        ownerAgentId: "A2",
        title: {
          "zh-CN": "把目标转为可观察证据",
          "en-US": "Turn goals into observable evidence",
        },
        thinkAloud: {
          "zh-CN": "我把概念理解、公式运用和推导推理分别写成学生需要表现出的证据，防止试卷只测机械计算。",
          "en-US":
            "I express conceptual understanding, formula use, and derivation as observable evidence so the quiz does not measure computation alone.",
        },
      },
      {
        id: "draft_prompt",
        ownerAgentId: "A2",
        title: {
          "zh-CN": "构造完整提示词",
          "en-US": "Draft a complete prompt",
        },
        thinkAloud: {
          "zh-CN": "我写清专家角色、三个目标维度、题型与题量配置、每题分值、参考答案和评分要点，再要求模型先给出结构表。",
          "en-US":
            "I specify the expert role, three goal dimensions, item-format and item-count plan, points per item, answers, and scoring guidance, and ask for a structure table first.",
        },
      },
      {
        id: "monitor_generation",
        ownerAgentId: "A2",
        title: {
          "zh-CN": "在生成过程中监控",
          "en-US": "Monitor during generation",
        },
        thinkAloud: {
          "zh-CN": "生成初稿后，我暂停检查三类目标是否都有证据、总分是否为 100 分、任务量是否适合 20 分钟，并标记需要修订的位置。",
          "en-US":
            "After the draft, I pause to check coverage of all three goals, the 100-point total, the 20-minute workload, and locations needing revision.",
        },
      },
      {
        id: "evaluate_and_revise",
        ownerAgentId: "A2",
        title: {
          "zh-CN": "按量规评价并修订",
          "en-US": "Evaluate with the rubric and revise",
        },
        thinkAloud: {
          "zh-CN": "我不会直接接受输出，而是逐项检查目标一致性、数学准确性、认知层级、清晰度和难度，再根据证据修改提示词或题目。",
          "en-US":
            "I do not accept the output immediately; I check goal alignment, mathematical accuracy, cognitive level, clarity, and difficulty, then revise the prompt or items based on evidence.",
        },
      },
    ],
    promptTemplate: {
      "zh-CN":
        "你是一名具有小学数学教学与教育测量经验的专家。请为完成“圆的面积”教学后的四年级学生设计一份 20 分钟、总分 100 分的课堂随堂测试。测试必须覆盖：1）概念理解——能用自己的语言解释圆的面积，并区分面积与周长；2）公式掌握——能正确运用 S = πr² 解决基本问题和简单变式；3）推导过程与推理——能描述把圆转化为近似长方形或其他图形的思路，理解“化曲为直”。请先给出题型、题量、分值和目标对应关系表，再给出完整试题、参考答案与评分要点，并在结尾按目标一致性、数学准确性、认知层级、表述清晰度和难度适切性进行自检。",
      "en-US":
        "You are an expert in primary mathematics teaching and educational measurement. Design a 20-minute, 100-point classroom quiz for Grade 4 learners after instruction on the area of a circle. It must cover: (1) conceptual understanding—explain area in the learner's own words and distinguish area from circumference; (2) formula application—correctly use S = πr² for basic problems and simple variations; and (3) derivation and reasoning—describe transforming the circle into an approximate rectangle or another shape and explain the idea of straightening a curve. First provide a table mapping item formats, item counts, points, and objectives. Then provide the full quiz, reference answers, and scoring guidance. Finish with a self-check for goal alignment, mathematical accuracy, cognitive level, clarity, and appropriate difficulty.",
    },
    monitoringCheckpoints: [
      {
        id: "before_prompt",
        label: {
          "zh-CN": "提交提示词前",
          "en-US": "Before submitting the prompt",
        },
        checks: [
          {
            "zh-CN": "角色、年级、教学时点、20 分钟和 100 分是否完整？",
            "en-US":
              "Are the role, grade, instructional timing, 20-minute limit, and 100-point total explicit?",
          },
          {
            "zh-CN": "三个学习维度是否都转化为可观察的学生表现？",
            "en-US": "Has each learning dimension been translated into observable learner evidence?",
          },
        ],
      },
      {
        id: "after_draft",
        label: {
          "zh-CN": "收到初稿后",
          "en-US": "After receiving the draft",
        },
        checks: [
          {
            "zh-CN": "分值是否合计 100 分，题量是否能在 20 分钟内完成？",
            "en-US": "Do the points total 100, and is the workload feasible in 20 minutes?",
          },
          {
            "zh-CN": "是否同时覆盖概念、公式和推导，而不是只测计算？",
            "en-US":
              "Does the draft cover concepts, formulas, and derivation rather than computation alone?",
          },
        ],
      },
      {
        id: "before_acceptance",
        label: {
          "zh-CN": "接受成品前",
          "en-US": "Before accepting the result",
        },
        checks: [
          {
            "zh-CN": "面积与周长是否区分准确，S = πr² 和推导说明是否无数学错误？",
            "en-US":
              "Are area and circumference distinguished correctly, and are S = πr² and the derivation mathematically accurate?",
          },
          {
            "zh-CN": "参考答案、评分要点、语言清晰度和难度是否适合目标学生？",
            "en-US":
              "Are the answers, scoring guidance, language, and difficulty appropriate for the target learners?",
          },
        ],
      },
    ],
    rubric: [
      {
        id: "goal_alignment",
        label: {
          "zh-CN": "目标一致性",
          "en-US": "Goal alignment",
        },
        check: {
          "zh-CN": "每个学习维度都有明确题目和评分证据。",
          "en-US": "Every learning dimension has explicit item and scoring evidence.",
        },
      },
      {
        id: "mathematical_accuracy",
        label: {
          "zh-CN": "数学准确性",
          "en-US": "Mathematical accuracy",
        },
        check: {
          "zh-CN": "概念、公式、计算、答案和推导均准确。",
          "en-US": "Concepts, formulas, calculations, answers, and derivation are accurate.",
        },
      },
      {
        id: "cognitive_level",
        label: {
          "zh-CN": "认知层级",
          "en-US": "Cognitive level",
        },
        check: {
          "zh-CN": "任务同时要求解释、应用和推理，而非只要求记忆。",
          "en-US": "The tasks require explanation, application, and reasoning, not recall alone.",
        },
      },
      {
        id: "clarity",
        label: {
          "zh-CN": "表述清晰度",
          "en-US": "Clarity",
        },
        check: {
          "zh-CN": "题干、作答要求、单位和评分标准清楚且无歧义。",
          "en-US": "Prompts, response directions, units, and scoring criteria are clear and unambiguous.",
        },
      },
      {
        id: "difficulty_balance",
        label: {
          "zh-CN": "难度适切性",
          "en-US": "Appropriate difficulty",
        },
        check: {
          "zh-CN": "难度和题量适合目标学生，并能在 20 分钟内完成。",
          "en-US": "Difficulty and workload suit the target learners and fit the 20-minute limit.",
        },
      },
    ],
  },
  taskAllowlist: caasiPilotTaskAllowlist,
  tasks: [
    {
      taskId: "practice_task_1",
      visibleTaskNumber: 2,
      phase: "practice",
      difficulty: "easy",
      availability: "available",
      title: {
        "zh-CN": "社交媒体与大学生心理健康课程论文大纲",
        "en-US": "Course-paper outline on social media and student mental health",
      },
      brief: {
        "zh-CN": "围绕给定提示词，依次完成不足诊断、提示词修改、内容生成与结果评价。",
        "en-US":
          "Use the given prompt to diagnose weaknesses, revise the prompt, generate an outline, and evaluate the result.",
      },
      cardSections: [
        {
          id: "task_background",
          title: {
            "zh-CN": "任务背景",
            "en-US": "Task background",
          },
          paragraphs: [
            {
              "zh-CN":
                "我想写一篇关于社交媒体对大学生心理健康影响的课程论文，请帮我写一个大纲，要有引言、文献综述、分析和结论。",
              "en-US":
                "I want to write a course paper about how social media affects university students' mental health. Please create an outline with an introduction, literature review, analysis, and conclusion.",
            },
          ],
        },
        {
          id: "exercise_1",
          title: {
            "zh-CN": "练习1",
            "en-US": "Exercise 1",
          },
          paragraphs: [
            {
              "zh-CN": "请指出这个提示词的不足并说明理由。",
              "en-US": "Identify the weaknesses in this prompt and explain your reasons.",
            },
          ],
        },
        {
          id: "exercise_2",
          title: {
            "zh-CN": "练习2",
            "en-US": "Exercise 2",
          },
          paragraphs: [
            {
              "zh-CN":
                "请按照今天的学习内容，修改这个提示词，使其清晰、具体、完整，确保GenAI能输出符合你需求的结果。",
              "en-US":
                "Using today's learning, revise the prompt so it is clear, specific, and complete, enabling GenAI to produce a result that meets your needs.",
            },
          ],
        },
        {
          id: "exercise_3",
          title: {
            "zh-CN": "练习3",
            "en-US": "Exercise 3",
          },
          paragraphs: [
            {
              "zh-CN": "请用修改的提示词生成内容，并且评价生成的内容是否符合任务要求。",
              "en-US":
                "Use the revised prompt to generate the content, then evaluate whether the generated content meets the task requirements.",
            },
          ],
        },
      ],
      exerciseIds: ["exercise_1", "exercise_2", "exercise_3"],
      milestoneIds: ["coaching_scaffolding", "articulation"],
      completionRequirements: [
        {
          id: "diagnose_original_prompt",
          kind: "prompt-diagnosis",
          required: true,
          label: {
            "zh-CN": "指出原提示词的不足并说明理由",
            "en-US": "Identify weaknesses in the original prompt and explain why",
          },
        },
        {
          id: "submit_revised_prompt",
          kind: "prompt-revision",
          required: true,
          label: {
            "zh-CN": "提交清晰、具体、完整的修改版提示词",
            "en-US": "Submit a clear, specific, and complete revised prompt",
          },
        },
        {
          id: "evaluate_generated_outline",
          kind: "output-evaluation",
          required: true,
          label: {
            "zh-CN": "生成内容并评价其是否符合任务要求",
            "en-US": "Generate the content and evaluate whether it meets the task requirements",
          },
        },
        {
          id: "articulate_task_two_process",
          kind: "articulation",
          required: true,
          label: {
            "zh-CN": "说明本任务中使用的规划、监控和评价方法",
            "en-US": "Explain the planning, monitoring, and evaluation used in this task",
          },
        },
      ],
    },
    {
      taskId: "practice_task_2",
      visibleTaskNumber: 3,
      phase: "practice",
      difficulty: "medium",
      availability: "pilot-closed",
      title: {
        "zh-CN": "L2 挑战：执行与监控",
        "en-US": "L2 Challenge: Execute and Monitor",
      },
      brief: {
        "zh-CN": "先导实验阶段暂不开放本任务。",
        "en-US": "This task is unavailable during the pilot study.",
      },
      cardNote: {
        "zh-CN": "先导实验阶段，任务3暂不开放，完成任务2后，会自动进入任务4",
        "en-US":
          "During the pilot study, Task 3 is unavailable. Completing Task 2 will automatically take you to Task 4.",
      },
      exerciseIds: [],
      milestoneIds: [],
      completionRequirements: [],
    },
    {
      taskId: "practice_task_3",
      visibleTaskNumber: 4,
      phase: "practice",
      difficulty: "hard",
      availability: "available",
      title: {
        "zh-CN": "设计一份《大学生GenAI学习使用指南》",
        "en-US": "Design a Guide to Using GenAI for University Learning",
      },
      brief: {
        "zh-CN": "独立完成指南设计，并记录元认知策略以及对GenAI输出的批判性评估。",
        "en-US":
          "Design the guide independently while documenting metacognitive strategies and critically evaluating GenAI output.",
      },
      cardNote: {
        "zh-CN": "练习4 （测试阶段，先用一个大练习）",
        "en-US": "Exercise 4 (testing stage: one comprehensive exercise for now)",
      },
      cardSections: [
        {
          id: "task_background",
          title: {
            "zh-CN": "任务背景",
            "en-US": "Task background",
          },
          paragraphs: [
            {
              "zh-CN":
                "随着生成式人工智能在校园中的普及，越来越多的大学生开始使用GenAI辅助学习。然而，如何合理、负责任地使用GenAI，避免学术不端和过度依赖，成为亟需解决的问题。某大学学生会计划编制一份《大学生GenAI学习使用指南》，面向全校学生发布，帮助同学们科学利用GenAI提升学习效率，同时明确使用边界。",
              "en-US":
                "As generative AI becomes widespread on campus, more university students are using GenAI to support their learning. However, using GenAI reasonably and responsibly while avoiding academic misconduct and overreliance has become an urgent issue. A university student union plans to publish a Guide to Using GenAI for University Learning to help students improve learning efficiency while understanding appropriate boundaries.",
            },
            {
              "zh-CN":
                "你作为学生代表，需要独立完成这份指南的设计。在设计过程中，你需要使用GenAI获取参考资料和多元观点，但必须对其输出进行批判性评估，不能直接照搬。",
              "en-US":
                "As a student representative, you must independently design this guide. During the process, use GenAI to gather reference material and diverse viewpoints, but critically evaluate its output rather than copying it directly.",
            },
          ],
        },
        {
          id: "task_goals",
          title: {
            "zh-CN": "任务目标",
            "en-US": "Task goals",
          },
          bullets: [
            {
              "zh-CN":
                "产出一份结构完整、内容合理、可操作性强的《大学生GenAI学习使用指南》设计稿（不少于800字）。",
              "en-US":
                "Produce a complete, well-reasoned, and actionable draft Guide to Using GenAI for University Learning of at least 800 Chinese characters (or equivalent length).",
            },
            {
              "zh-CN":
                "在任务过程中，系统运用计划、监控、评价三种元认知技能，并记录你的策略使用情况。",
              "en-US":
                "Systematically apply the three metacognitive skills of planning, monitoring, and evaluation, and record how you use each strategy.",
            },
            {
              "zh-CN":
                "学会批判性地使用GenAI辅助设计，能够识别其输出中的偏差、局限或错误。",
              "en-US":
                "Learn to use GenAI critically during the design process and identify bias, limitations, or errors in its output.",
            },
          ],
        },
      ],
      exerciseIds: ["exercise_4"],
      milestoneIds: ["exploration", "articulation", "reflection"],
      completionRequirements: [
        {
          id: "submit_guide_draft",
          kind: "artifact",
          required: true,
          label: {
            "zh-CN": "提交不少于 800 字的指南设计稿",
            "en-US": "Submit the guide draft at the required equivalent length",
          },
        },
        {
          id: "record_plan",
          kind: "planning",
          required: true,
          label: {
            "zh-CN": "记录任务计划及 GenAI 使用位置",
            "en-US": "Record the task plan and where GenAI is used",
          },
        },
        {
          id: "record_monitoring",
          kind: "monitoring",
          required: true,
          label: {
            "zh-CN": "记录过程中的检查点、偏离和调整",
            "en-US": "Record checkpoints, deviations, and adjustments during the process",
          },
        },
        {
          id: "record_evaluation",
          kind: "evaluation",
          required: true,
          label: {
            "zh-CN": "评价最终成果是否满足任务目标",
            "en-US": "Evaluate whether the final artifact meets the task goals",
          },
        },
        {
          id: "critique_genai_output",
          kind: "output-evaluation",
          required: true,
          label: {
            "zh-CN": "指出 GenAI 输出中的偏差、局限或错误及处理方式",
            "en-US": "Identify bias, limitations, or errors in GenAI output and explain how they were handled",
          },
        },
        {
          id: "articulate_task_four_process",
          kind: "articulation",
          required: true,
          label: {
            "zh-CN": "表达本任务中的元认知过程和最大困难",
            "en-US": "Articulate the metacognitive process and greatest difficulty in this task",
          },
        },
        {
          id: "reflect_after_task_four",
          kind: "reflection",
          required: true,
          label: {
            "zh-CN": "比较专家过程并写出下一次改进策略",
            "en-US": "Compare with the expert process and write a strategy for next time",
          },
        },
      ],
    },
  ],
  articulation: {
    milestoneId: "articulation",
    ownerAgentIds: ["A1", "A4"],
    trigger: "after-each-open-task",
    prompts: [
      {
        "zh-CN": "你刚才在完成任务时，是如何进行规划、监控和评价的？请各举一个具体例子。",
        "en-US":
          "How did you plan, monitor, and evaluate while completing the task? Give one concrete example of each.",
      },
      {
        "zh-CN": "你觉得最困难的部分是什么？你是如何判断并处理这个困难的？",
        "en-US":
          "What was the hardest part, and how did you identify and address that difficulty?",
      },
    ],
  },
  reflection: {
    milestoneId: "reflection",
    ownerAgentIds: ["A1", "A4"],
    trigger: "after-exploration-task",
    prompts: [
      {
        "zh-CN": "比较专家的思考过程和你自己的过程：最明显的一项差异是什么？",
        "en-US":
          "Compare the expert thinking process with your own. What is the most important difference?",
      },
      {
        "zh-CN": "你最需要改进的一个环节是什么？依据是什么？",
        "en-US": "Which one part most needs improvement, and what evidence supports that judgment?",
      },
      {
        "zh-CN": "下一次完成类似任务时，你会采用什么具体策略？",
        "en-US": "What specific strategy will you use the next time you complete a similar task?",
      },
    ],
  },
  aiFree: {
    available: true,
    completionParity: "same-required-evidence",
    description: {
      "zh-CN":
        "没有可用的实时 GenAI 时，学生仍可使用静态专家示范和评价量规完成自己的作品、过程记录、表达与反思；所需学习证据不降低。",
      "en-US":
        "When live GenAI is unavailable, learners can still use the static expert model and rubric to complete their own artifact, process record, articulation, and reflection without reducing the required evidence.",
    },
    resources: [
      {
        id: "static-expert-model",
        label: {
          "zh-CN": "静态专家示范",
          "en-US": "Static expert model",
        },
      },
      {
        id: "static-rubric",
        label: {
          "zh-CN": "静态评价量规",
          "en-US": "Static evaluation rubric",
        },
      },
      {
        id: "learner-authored-artifact",
        label: {
          "zh-CN": "学生独立完成的作品与过程记录",
          "en-US": "Learner-authored artifact and process record",
        },
      },
    ],
  },
} as const satisfies AaisCoursePackage;

export const aaisCoursePackages = [
  caasiPilotCoursePackage,
] as const satisfies readonly AaisCoursePackage[];

export function getCaasiPilotTaskDefinition(
  taskId: string,
): AaisCoursePackageTask | undefined {
  return caasiPilotCoursePackage.tasks.find((task) => task.taskId === taskId);
}

export function getAaisCoursePackage(
  courseId: string,
  version: string,
): AaisCoursePackage | undefined {
  return aaisCoursePackages.find((coursePackage) =>
    coursePackage.course.id === courseId && coursePackage.version === version
  );
}
