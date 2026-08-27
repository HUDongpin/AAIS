import type { GuideMessage } from "@/components/pages/learning/learning-page-types";
import type { Locale } from "@/data/aais";

export const artifactSaveDebounceMs = 600;
export const learningSessionLoadTimeoutMs = 15_000;
export const guideRequestTimeoutMs = 30_000;
export const guideStreamHeartbeatIntervalMs = 10_000;
export const defaultTaskId = "training_task_1";
export const documentDownloadContentType = "text/markdown;charset=utf-8";
export const defaultContentPanelWidth = 600;
export const minContentPanelWidth = 220;
export const maxContentPanelWidth = 620;
export const minGuidePanelWidth = 420;
export const contentPanelResizeStep = 24;
export const anthropicLearningFontFamily =
  '"Anthropic Serif", "Tiempos Text", Georgia, "Times New Roman", "Songti SC", "SimSun", serif';
export const visibleGuideAgentIds = ["A1", "A2"] as const;

export function getGuideAttachmentOnlyPrompt(locale: Locale) {
  return locale === "en-US"
    ? "Please read the files I uploaded, identify the key ideas, and suggest my next learning step."
    : "请阅读我上传的文件，并帮我提炼关键内容和下一步学习建议。";
}

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
        `你好，${displayName}，我是小张。欢迎来到CAAIS。请你先阅读下“平台介绍”。`,
      turns: [
        {
          agentId: "A1",
          label: "小张",
          content:
            `你好，${displayName}，我是小张。欢迎来到CAAIS。请你先阅读下“平台介绍”。`,
          actions: ["guide-flow", "scaffold"],
        },
      ],
    },
  ];
}
