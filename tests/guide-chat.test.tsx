import { fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { GuideBubble } from "@/components/pages/learning/guide-chat";

afterEach(() => {
  vi.unstubAllGlobals();
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

  it("labels deterministic development output as a local safe scaffold", () => {
    render(
      <GuideBubble
        message={{
          id: "assistant-local",
          kind: "assistant",
          text: "先确认你卡住的步骤。",
          runtime: {
            fallback: true,
            delivery: {
              responseMode: "deterministic",
              channel: "deterministic",
              degraded: true,
            },
          },
        }}
      />,
    );

    expect(screen.getByText("本地安全支架")).toBeTruthy();
    expect(screen.queryByText("离线支架模式")).toBeNull();
  });

  it.each(["primary", "secondary"] as const)(
    "does not label %s live delivery as offline even when a legacy fallback bit is present",
    (channel) => {
      render(
        <GuideBubble
          message={{
            id: `assistant-live-${channel}`,
            kind: "assistant",
            text: "实时回复。",
            runtime: {
              fallback: true,
              delivery: {
                responseMode: "live",
                channel,
                degraded: channel === "secondary",
              },
            },
          }}
        />,
      );

      expect(screen.queryByText("本地安全支架")).toBeNull();
      expect(screen.queryByText("离线支架模式")).toBeNull();
    },
  );

  it("shows, copies, and confirms a support code for an exhausted live chain", async () => {
    const onRetry = vi.fn();
    const writeText = vi.fn(async () => undefined);
    vi.stubGlobal("navigator", { clipboard: { writeText } });
    render(
      <GuideBubble
        message={{
          id: "assistant-chain-failed",
          kind: "assistant",
          text: "实时 AI 链路暂时不可用。你的问题仍保留在本页，可直接重试。",
          runtime: {
            failure: {
              kind: "provider_chain",
              code: "AAIS_AI_PROVIDER_CHAIN_EXHAUSTED",
              diagnosticId: "DG-CHAIN-01",
              retryable: true,
              learnerAction: "retry",
            },
          },
        }}
        onRetry={onRetry}
      />,
    );

    expect(screen.getByText("AI 暂时降级")).toBeTruthy();
    expect(screen.getByText("支持码：DG-CHAIN-01")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "复制支持码" }));
    expect(await screen.findByText("支持码已复制")).toBeTruthy();
    expect(writeText).toHaveBeenCalledWith("DG-CHAIN-01");
    fireEvent.click(screen.getByRole("button", { name: "重试这个问题" }));
    expect(onRetry).toHaveBeenCalledWith("assistant-chain-failed");
  });

  it("offers rewriting rather than retrying when output is blocked", () => {
    const onRewrite = vi.fn();
    render(
      <GuideBubble
        message={{
          id: "assistant-output-blocked",
          kind: "assistant",
          text: "请换一种表述后再试。",
          runtime: {
            failure: {
              kind: "guardrail",
              code: "AI_REPHRASE_REQUIRED",
              diagnosticId: "DG-SAFE-02",
              retryable: false,
              learnerAction: "rephrase",
            },
          },
        }}
        onRewrite={onRewrite}
      />,
    );

    expect(screen.getByText("这次问题无法提交给 AI")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "重试这个问题" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "改写这个问题" }));
    expect(onRewrite).toHaveBeenCalledWith("assistant-output-blocked");
  });

  it("uses guardrail copy that does not imply an alternative answer was generated", () => {
    render(
      <GuideBubble
        locale="en-US"
        message={{
          id: "assistant-output-blocked-en",
          kind: "assistant",
          text: "Please rephrase it and try again.",
          runtime: {
            failure: {
              kind: "guardrail",
              code: "AI_REPHRASE_REQUIRED",
              diagnosticId: "DG-SAFE-EN",
              retryable: false,
              learnerAction: "rephrase",
            },
          },
        }}
      />,
    );

    expect(screen.getByText("This question could not be submitted to AI")).toBeTruthy();
    expect(screen.getByText("Please rephrase it and try again.")).toBeTruthy();
    expect(screen.queryByText(/switched/i)).toBeNull();
  });

  it("shows configuration guidance and a support code without an unsafe retry promise", () => {
    render(
      <GuideBubble
        message={{
          id: "assistant-config",
          kind: "assistant",
          text: "实时 AI 服务尚未就绪。你的问题仍保留在本页，请凭支持码联系管理员。",
          runtime: {
            failure: {
              kind: "configuration",
              code: "AAIS_AI_PROVIDER_CONFIGURATION_INVALID",
              diagnosticId: "DG-CONFIG-01",
              retryable: false,
              learnerAction: "contact-support",
            },
          },
        }}
        onRetry={vi.fn()}
      />,
    );

    expect(screen.getByText("AI 服务配置未就绪")).toBeTruthy();
    expect(screen.getByText("支持码：DG-CONFIG-01")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "重试这个问题" })).toBeNull();
    expect(screen.queryByRole("button", { name: "改写这个问题" })).toBeNull();
  });

  it("reports clipboard failure without logging or hiding the support code", async () => {
    const writeText = vi.fn(async () => {
      throw new Error("clipboard denied");
    });
    vi.stubGlobal("navigator", { clipboard: { writeText } });
    render(
      <GuideBubble
        message={{
          id: "assistant-copy-failed",
          kind: "assistant",
          text: "实时 AI 链路暂时不可用。你的问题仍保留在本页，可直接重试。",
          runtime: {
            failure: {
              kind: "provider_chain",
              diagnosticId: "DG-COPY-FAIL",
              retryable: true,
              learnerAction: "retry",
            },
          },
        }}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "复制支持码" }));

    expect(await screen.findByText("复制失败，请手动选择支持码。")).toBeTruthy();
    expect(screen.getByText("支持码：DG-COPY-FAIL")).toBeTruthy();
  });
});
