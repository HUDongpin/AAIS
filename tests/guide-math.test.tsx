import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { GuideBubble } from "@/components/pages/learning/guide-chat";

describe("guide LaTeX rendering", () => {
  it("renders inline dollar-delimited LaTeX as accessible MathML", () => {
    render(
      <GuideBubble
        locale="en-US"
        message={{
          id: "formula-inline",
          kind: "assistant",
          text: "The quadratic is $y=ax^2+bx+c$.",
        }}
      />,
    );

    const expression = screen.getByTestId("math-inline");
    expect(expression.getAttribute("data-katex")).toBe("inline");
    expect(expression.querySelector("math")).toBeTruthy();
    expect(expression.querySelector("annotation[encoding='application/x-tex']")?.textContent)
      .toBe("y=ax^2+bx+c");
    expect(expression.querySelector("[style]")).toBeNull();
  });

  it("renders display math delimited by double dollars", () => {
    render(
      <GuideBubble
        locale="en-US"
        message={{
          id: "formula-display",
          kind: "assistant",
          text: String.raw`The quadratic formula is:
$$\frac{-b \pm \sqrt{b^2 - 4ac}}{2a}$$`,
        }}
      />,
    );

    const expression = screen.getByTestId("math-display");
    expect(expression.getAttribute("data-katex")).toBe("display");
    expect(expression.querySelector("math")).toBeTruthy();
    expect(expression.querySelector("annotation[encoding='application/x-tex']")?.textContent)
      .toBe("\\frac{-b \\pm \\sqrt{b^2 - 4ac}}{2a}");
  });
});
