import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { GuideBubble } from "@/components/pages/learning/guide-chat";

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
});
