import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import {
  GuideBubble,
  GuideThinkingBubble,
} from "@/components/pages/learning/guide-chat";

describe("GuideThinkingBubble", () => {
  it.each([
    ["zh-CN" as const, "教授正在思考", "教授大学教育风格头像"],
    ["en-US" as const, "Professor is thinking", "Professor university-education avatar"],
  ])("renders one accessible %s Professor status with decorative dots hidden", (
    locale,
    statusText,
    avatarLabel,
  ) => {
    const { container } = render(<GuideThinkingBubble locale={locale} />);

    expect(screen.getByText(statusText)).toBeTruthy();
    expect(screen.getByRole("img", { name: avatarLabel })).toBeTruthy();
    const indicator = container.querySelector('[data-guide-thinking-agent="A2"]');
    const dots = indicator?.querySelectorAll(".aais-guide-thinking-dot");
    const decorativeDotGroup = dots?.[0]?.parentElement;

    expect(indicator?.className).toContain("aais-guide-thinking-bubble");
    expect(dots).toHaveLength(3);
    expect(decorativeDotGroup?.getAttribute("aria-hidden")).toBe("true");
    expect(indicator?.textContent).toBe(statusText);
  });
});

describe("GuideBubble safe rich-text output", () => {
  it("renders provider markdown headings instead of leaking heading markers", () => {
    render(
      <GuideBubble
        message={{
          id: "assistant-format",
          kind: "assistant",
          text: "done",
          turns: [{
            agentId: "A2",
            label: "Professor",
            content: "### 1. Task interpretation\n\n- Define the target\n- Verify the constraint",
            actions: ["model"],
          }],
        }}
      />,
    );

    expect(screen.getByRole("heading", { level: 3, name: "1. Task interpretation" })).toBeTruthy();
    expect(screen.queryByText(/### 1\. Task interpretation/)).toBeNull();
    expect(screen.getByText("Define the target").closest("ul")).toBeTruthy();
  });

  it("renders single-star emphasis and quoted reasoning without leaking their markers", () => {
    const { container } = render(
      <GuideBubble
        message={{
          id: "assistant-quote-emphasis",
          kind: "assistant",
          text: "done",
          turns: [{
            agentId: "A2",
            label: "Professor",
            content: "> *内心独白*：先判断证据。\n> 再核对结论。",
            actions: ["model"],
          }],
        }}
      />,
    );

    const quote = container.querySelector("blockquote");
    expect(quote?.textContent).toBe("内心独白：先判断证据。\n再核对结论。");
    expect(quote?.querySelector("em")?.textContent).toBe("内心独白");
    expect(quote?.textContent).not.toContain(">");
    expect(quote?.textContent).not.toContain("*");
  });

  it("keeps HTML and unsafe links inert inside quotes and emphasis", () => {
    const { container } = render(
      <GuideBubble
        message={{
          id: "assistant-safe-formatting",
          kind: "assistant",
          text: "> *<img src=x onerror=alert(1)>* [unsafe](javascript:alert(1))",
        }}
      />,
    );

    expect(container.querySelector("img")).toBeNull();
    expect(container.querySelector("script")).toBeNull();
    expect(screen.queryByRole("link", { name: "unsafe" })).toBeNull();
    expect(container.querySelector("blockquote em")?.textContent).toContain("<img");
  });

  it("renders an accessible quadratic graph with key data and learner-controlled next steps", () => {
    const onSuggestedPrompt = vi.fn();
    render(
      <GuideBubble
        locale="zh-CN"
        onSuggestedPrompt={onSuggestedPrompt}
        message={{
          id: "assistant-function-graph",
          kind: "assistant",
          text: "done",
          turns: [{
            agentId: "A1",
            label: "小张",
            content: "当然，先看图。",
            actions: ["show-function-graph"],
            visualizations: [{
              id: "quadratic-2-3-4",
              type: "quadratic-function",
              expression: "y = 2x² + 3x + 4",
              coefficients: { a: 2, b: 3, c: 4 },
              domain: { xMin: -5, xMax: 4 },
              vertex: { x: -0.75, y: 2.875 },
              axisX: -0.75,
              yIntercept: 4,
            }],
          }],
        }}
      />,
    );

    expect(screen.getByRole("img", { name: /y = 2x² \+ 3x \+ 4 的函数图像/ })).toBeTruthy();
    expect(screen.getByRole("table", { name: "图像关键点" })).toBeTruthy();
    expect(screen.getAllByText("顶点（-3/4，23/8）").length).toBeGreaterThanOrEqual(1);
    expect(screen.getByText("对称轴 x = -3/4")).toBeTruthy();
    expect(screen.getByRole("button", { name: "解释顶点" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "示范代入" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "我先观察" })).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "示范代入" }));
    expect(onSuggestedPrompt).toHaveBeenCalledWith(
      "请示范把 x = -3/4 代入 y = 2x² + 3x + 4。",
    );
  });
});
