import { describe, expect, it } from "vitest";
import {
  localizeAaisGuideAgentReferences,
  localizeAaisGuideTargetMentions,
  normalizeAaisGuideTargetAgentIds,
} from "@/lib/ai/aais-guide-targets";

describe("AAIS guide target parsing", () => {
  it("maps the named visible-agent handles to the matching guide target ids", () => {
    expect(normalizeAaisGuideTargetAgentIds(undefined, "@教授 请示范一次元认知思考。")).toEqual([
      "A2",
    ]);
    expect(normalizeAaisGuideTargetAgentIds(undefined, "@小张 请帮我拆下一步。")).toEqual([
      "A1",
    ]);
    expect(normalizeAaisGuideTargetAgentIds(undefined, "@Xiao Zhang help me plan the next step.")).toEqual([
      "A1",
    ]);
    expect(normalizeAaisGuideTargetAgentIds(undefined, "@Xiao   Zhang help me plan the next step.")).toEqual([
      "A1",
    ]);
    expect(normalizeAaisGuideTargetAgentIds(undefined, "@Xiao Zhangman is not an agent handle.")).toBeUndefined();
  });

  it("keeps legacy role handles as compatible aliases", () => {
    expect(normalizeAaisGuideTargetAgentIds(undefined, "@Professor 请示范一次元认知思考。")).toEqual([
      "A2",
    ]);
    expect(normalizeAaisGuideTargetAgentIds(undefined, "@专家智能体 请示范一次元认知思考。")).toEqual([
      "A2",
    ]);
    expect(normalizeAaisGuideTargetAgentIds(undefined, "@导学智能体 请帮我拆下一步。")).toEqual([
      "A1",
    ]);
  });

  it("replaces internal visible-agent ids with learner-facing names", () => {
    expect(localizeAaisGuideAgentReferences(
      "小张（A1）负责引导，Professor (A2) 负责示范。",
      "zh-CN",
    )).toBe("小张负责引导，教授负责示范。");
    expect(localizeAaisGuideAgentReferences(
      "A1 guides the next step; A2 models expert thinking.",
      "en-US",
    )).toBe("Xiao Zhang guides the next step; Professor models expert thinking.");
  });

  it("shows legacy internal mentions as public handles without changing other learner text", () => {
    expect(localizeAaisGuideTargetMentions(
      "@A1 帮我比较题目里的 A1 选项，再请 @A2 示范。",
      "zh-CN",
    )).toBe("@小张 帮我比较题目里的 A1 选项，再请 @教授 示范。");
  });
});
