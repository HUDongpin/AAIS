import type {
  GuideMessage,
  GuideQuickStart,
} from "@/components/pages/learning/learning-page-types";

export const artifactSaveDebounceMs = 600;
export const guideRequestTimeoutMs = 30_000;
export const guideAttachmentOnlyPrompt = "请阅读我上传的文件，并帮我提炼关键内容和下一步学习建议。";
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

export const guideQuickStarts: GuideQuickStart[] = [
  {
    label: "明确学习目标",
    prompt: "请帮我明确这个学习任务的目标，并拆成下一步。",
  },
  {
    label: "看 A2 专家如何思考",
    prompt: "@专家智能体 请示范一次元认知思考过程。",
  },
  {
    label: "我卡住了，给我支架",
    prompt: "我卡住了，想要一个支架提示。",
  },
  {
    label: "整理反思记录",
    prompt: "请帮我把刚才的学习过程整理成反思记录。",
  },
];

export const initialGuideMessages: GuideMessage[] = [
  {
    id: "assistant-welcome",
    kind: "assistant",
    text:
      "你好，Bobie！我是你的认知学徒制 AI 助教。今天你想学习什么？我可以陪你练习解决问题，或者帮你整理学习笔记。",
    turns: [
      {
        agentId: "A1",
        label: "导学智能体",
        content:
          "你好，Bobie！我是 A1 导学智能体。今天你可以先选一个入口，我会帮你明确目标、邀请 A2 专家智能体示范思考，或给出逐步减少的支架。需要专家时，也可以直接输入 @专家智能体。",
        actions: ["guide-flow", "scaffold"],
      },
    ],
  },
];
