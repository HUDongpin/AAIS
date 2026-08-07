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
});
