import type {
  GuideMessage,
  GuideQuickStart,
} from "@/components/pages/learning/learning-page-types";
import type { Locale } from "@/data/aais";

export const artifactSaveDebounceMs = 600;
export const guideRequestTimeoutMs = 30_000;
export const defaultTaskId = "training_task_1";
export const documentDownloadContentType = "text/markdown;charset=utf-8";
export const defaultContentPanelWidth = 600;
export const minContentPanelWidth = 220;
export const maxContentPanelWidth = 620;
export const minGuidePanelWidth = 420;
export const contentPanelResizeStep = 24;
export const anthropicLearningFontFamily =
  '"Anthropic Serif", "Tiempos Text", Georgia, "Times New Roman", "Songti SC", "SimSun", serif';
export const anthropicNavigationFontFamily =
  '"Anthropic Sans", Arial, "Helvetica Neue", "PingFang SC", "Microsoft YaHei", sans-serif';
export const visibleGuideAgentIds = ["A1", "A2"] as const;

export function getGuideAttachmentOnlyPrompt(locale: Locale) {
  return locale === "en-US"
    ? "Please read the files I uploaded, identify the key ideas, and suggest my next learning step."
    : "请阅读我上传的文件，并帮我提炼关键内容和下一步学习建议。";
}

export function getGuideQuickStarts(locale: Locale): GuideQuickStart[] {
  if (locale === "en-US") {
    return [
      {
        id: "clarify_goal",
        label: "Clarify my learning goal",
        prompt: "Help me clarify this learning task's goal and break it into a next step.",
      },
      {
        id: "expert_model",
        label: "See an expert model",
        prompt: "@Professor Please model one metacognitive thinking process.",
      },
      {
        id: "request_scaffold",
        label: "I am stuck—give me a scaffold",
        prompt: "I am stuck and would like one scaffolded hint.",
      },
      {
        id: "organize_reflection",
        label: "Organize my reflection",
        prompt: "Help me organize the learning process just completed into a reflection record.",
      },
    ];
  }
  return [
    {
      id: "clarify_goal",
      label: "明确学习目标",
      prompt: "请帮我明确这个学习任务的目标，并拆成下一步。",
    },
    {
      id: "expert_model",
      label: "开始示范",
      prompt: "@教授 请示范一次元认知思考过程。",
    },
    {
      id: "request_scaffold",
      label: "我卡住了，给我支架",
      prompt: "我卡住了，想要一个支架提示。",
    },
    {
      id: "organize_reflection",
      label: "整理反思记录",
      prompt: "请帮我把刚才的学习过程整理成反思记录。",
    },
  ];
}

// Retained for consumers that use the default Chinese workspace.
export const guideQuickStarts = getGuideQuickStarts("zh-CN");

export function createInitialGuideMessages(
  displayName: string,
  locale: Locale = "zh-CN",
): GuideMessage[] {
  if (locale === "en-US") {
    return [
      {
        id: "assistant-welcome",
        kind: "assistant",
        text:
          `Hi, ${displayName}—I am Xiao Zhang. Pick one starting point; mention @Professor for an expert model.`,
        turns: [
          {
            agentId: "A1",
            label: "Xiao Zhang",
            content:
              `Hi, ${displayName}—I am Xiao Zhang. Pick one starting point; mention @Professor for an expert model.`,
            actions: ["guide-flow", "scaffold"],
          },
        ],
      },
    ];
  }
  return [
    {
      id: "assistant-welcome",
      kind: "assistant",
      text:
        `你好，${displayName}，我是小张。先选一个入口；需要专家示范就 @教授。`,
      turns: [
        {
          agentId: "A1",
          label: "小张",
          content:
            `你好，${displayName}，我是小张。先选一个入口；需要专家示范就 @教授。`,
          actions: ["guide-flow", "scaffold"],
        },
      ],
    },
  ];
}
