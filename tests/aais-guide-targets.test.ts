import { describe, expect, it } from "vitest";
import {
  localizeAaisGuideAgentReferences,
  localizeAaisGuideTargetMentions,
  selectAaisGuideReplyAgentIds,
} from "@/lib/ai/aais-guide-targets";

describe("AAIS guide target parsing", () => {
  it("routes ordinary text and bare expert names to A1 only", () => {
    expect(selectAaisGuideReplyAgentIds("请帮我拆解下一步。")).toEqual(["A1"]);
    expect(selectAaisGuideReplyAgentIds("教授，请帮我示范一次。")).toEqual(["A1"]);
    expect(selectAaisGuideReplyAgentIds("Professor, please show me an example.")).toEqual(["A1"]);
    expect(selectAaisGuideReplyAgentIds("@Xiao Zhangman is not an agent handle.")).toEqual(["A1"]);
  });

  it("routes valid Professor mentions to A2 only", () => {
    expect(selectAaisGuideReplyAgentIds("@教授 请示范一次元认知思考。")).toEqual(["A2"]);
    expect(selectAaisGuideReplyAgentIds("@Professor Please model your reasoning.")).toEqual(["A2"]);
    expect(selectAaisGuideReplyAgentIds("@A2 请示范一次元认知思考。")).toEqual(["A2"]);
    expect(selectAaisGuideReplyAgentIds("@A 2 请示范一次元认知思考。")).toEqual(["A2"]);
    expect(selectAaisGuideReplyAgentIds("@专家智能体 请示范一次元认知思考。")).toEqual(["A2"]);
  });

  it("keeps guide aliases on A1 and gives A2 precedence in mixed mentions", () => {
    expect(selectAaisGuideReplyAgentIds("@小张 请帮我拆下一步。")).toEqual(["A1"]);
    expect(selectAaisGuideReplyAgentIds("@Xiao   Zhang help me plan the next step.")).toEqual(["A1"]);
    expect(selectAaisGuideReplyAgentIds("@导学智能体 请帮我拆下一步。")).toEqual(["A1"]);
    expect(selectAaisGuideReplyAgentIds("@小张 先规划，再请 @教授 示范。")).toEqual(["A2"]);
    expect(selectAaisGuideReplyAgentIds("@Professor model it, then @A1 help me practice.")).toEqual(["A2"]);
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
