import { describe, expect, it } from "vitest";
import { normalizeAaisGuideTargetAgentIds } from "@/lib/ai/aais-guide-targets";

describe("AAIS guide target parsing", () => {
  it("maps visible Chinese agent handles to the matching guide target ids", () => {
    expect(normalizeAaisGuideTargetAgentIds(undefined, "@专家智能体 请示范一次元认知思考。")).toEqual([
      "A2",
    ]);
    expect(normalizeAaisGuideTargetAgentIds(undefined, "@导学智能体 请帮我拆下一步。")).toEqual([
      "A1",
    ]);
  });
});
