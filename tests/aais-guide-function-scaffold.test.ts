import { describe, expect, it } from "vitest";
import {
  createAaisFunctionScaffoldPlan,
  createAaisFunctionScaffoldResponse,
  evaluateAaisQuadratic,
  isAaisFunctionGraphRequest,
  normalizeAaisGuideVisualizations,
} from "@/lib/ai/aais-guide-function-scaffold";

describe("AAIS function graph scaffold", () => {
  it("turns an explicit quadratic graph request into an immediate visual scaffold", () => {
    const plan = createAaisFunctionScaffoldPlan({
      learnerInput: "给我看 y = 2x² + 3x + 4 的图像",
    });

    expect(plan).toMatchObject({
      mode: "visualize",
      visualization: {
        type: "quadratic-function",
        expression: "y = 2x² + 3x + 4",
        coefficients: { a: 2, b: 3, c: 4 },
        vertex: { x: -0.75, y: 2.875 },
        axisX: -0.75,
        yIntercept: 4,
      },
    });
    expect(createAaisFunctionScaffoldResponse(plan!, "zh-CN")).toContain("计算不是看图的前置条件");
  });

  it("switches to a worked demonstration when the learner says they cannot calculate", () => {
    const plan = createAaisFunctionScaffoldPlan({
      learnerInput: "我不会，你能帮我算吗？",
      conversationHistory: [
        { kind: "user", text: "给我看 y = 2x^2 + 3x + 4 的图像" },
        { kind: "assistant", text: "先把 x=-3/4 代入，算出来是多少？" },
      ],
    });

    expect(plan?.mode).toBe("demonstrate");
    const response = createAaisFunctionScaffoldResponse(plan!, "zh-CN");
    expect(response).toContain("我来示范");
    expect(response).toContain("23/8");
    expect(response).toContain("不用先算对才能看图");
  });

  it("breaks the repeated-question loop after a wrong numeric attempt", () => {
    const plan = createAaisFunctionScaffoldPlan({
      learnerInput: "y = 20?",
      conversationHistory: [
        { kind: "user", text: "我想看 y = 2x^2 + 3x + 4 的函数图像" },
        { kind: "assistant", text: "把 x=-3/4 代入后结果是多少？" },
      ],
    });

    expect(plan?.mode).toBe("demonstrate");
    expect(plan?.visualization.vertex).toEqual({ x: -0.75, y: 2.875 });
  });

  it("honors an explicit request to keep looking at the graph instead of repeating the gate", () => {
    const plan = createAaisFunctionScaffoldPlan({
      learnerInput: "我还是想看图像",
      conversationHistory: [
        { kind: "user", text: "给我看 y = 2x^2 + 3x + 4 的图像" },
        { kind: "assistant", text: "先代入 x=-3/4 算出结果，我再帮你画图。" },
        { kind: "user", text: "我不会" },
        { kind: "assistant", text: "再试一次，代入后 y 等于多少？" },
      ],
    });

    expect(plan?.mode).toBe("demonstrate");
    expect(createAaisFunctionScaffoldResponse(plan!, "zh-CN")).toContain("图像已显示在下面");
  });

  it("does not hijack an unrelated follow-up after an earlier graph request", () => {
    const plan = createAaisFunctionScaffoldPlan({
      learnerInput: "你是什么大模型？",
      conversationHistory: [
        { kind: "user", text: "我想看 y = 2x^2 + 3x + 4 的函数图像" },
        { kind: "assistant", text: "函数图像已经显示。" },
      ],
    });

    expect(plan).toBeNull();
  });

  it("stays fail-closed for unsupported or malformed expressions", () => {
    expect(createAaisFunctionScaffoldPlan({
      learnerInput: "给我看 y = x^3 + 2x 的图像",
    })).toBeNull();
    expect(createAaisFunctionScaffoldPlan({
      learnerInput: "给我看 y = x^20 + 1 的图像",
    })).toBeNull();
    expect(createAaisFunctionScaffoldPlan({
      learnerInput: "给我看 y = x^2 + x^3 的图像",
    })).toBeNull();
    expect(createAaisFunctionScaffoldPlan({
      learnerInput: "给我看 y = 999999x^2 + 2x 的图像",
    })).toBeNull();
    expect(isAaisFunctionGraphRequest("请分析附件中的图像")).toBe(false);
    expect(isAaisFunctionGraphRequest("请显示函数 y=x^3+2x 的图像")).toBe(true);
  });

  it("normalizes only bounded quadratic visualization payloads", () => {
    const plan = createAaisFunctionScaffoldPlan({
      learnerInput: "plot y=x^2-4",
    });
    const visualizations = normalizeAaisGuideVisualizations([
      plan?.visualization,
      { type: "quadratic-function", id: "unsafe", expression: "bad", coefficients: { a: 0 } },
    ]);

    expect(visualizations).toHaveLength(1);
    expect(evaluateAaisQuadratic(visualizations[0]!.coefficients, 2)).toBe(0);
  });
});
