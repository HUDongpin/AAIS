import { readFileSync } from "node:fs";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  LearningPage as LearningPageComponent,
  type LearningPageActor,
  type LearningPageResearchBoundary,
} from "@/components/pages/learning-page";
import type {
  AaisResearchLogoutContext,
  AaisResearchTelemetryBoundaryState,
  AaisResearchTelemetryStartOptions,
} from "@/lib/client/aais-research-telemetry";

const defaultLearningPageActor: LearningPageActor = {
  id: "Bobie",
  displayName: "Bobie",
};

function LearningPage({
  actor = defaultLearningPageActor,
  locale,
  research = {
    required: false,
    initialVisit: null,
  },
}: {
  actor?: LearningPageActor;
  locale?: "zh-CN" | "en-US";
  research?: LearningPageResearchBoundary;
}) {
  return <LearningPageComponent actor={actor} locale={locale} research={research} />;
}

const routerMocks = vi.hoisted(() => ({
  replace: vi.fn(),
}));
const browserNavigationMocks = vi.hoisted(() => ({
  replace: vi.fn(),
}));
const telemetryMocks = vi.hoisted(() => {
  const record = vi.fn();
  return {
    admit: vi.fn((event) => {
      record(event);
      return true;
    }),
    record,
    start: vi.fn((options?: AaisResearchTelemetryStartOptions) => {
      void options;
      return () => undefined;
    }),
    clearActor: vi.fn(),
    flush: vi.fn(async () => undefined),
    actorGeneration: 0,
    logoutContext: null as AaisResearchLogoutContext | null,
    operationCounter: 0,
  };
});

vi.mock("next/navigation", () => ({
  useRouter: () => ({
    replace: routerMocks.replace,
  }),
}));

vi.mock("@/lib/client/aais-browser-navigation", () => ({
  replaceAaisBrowserLocation: browserNavigationMocks.replace,
}));

vi.mock("@/lib/client/aais-research-telemetry", () => ({
  admitAaisResearchAction: telemetryMocks.admit,
  captureAaisResearchActorGeneration: () => telemetryMocks.actorGeneration,
  classifyAaisResearchClientError: (error: { name?: string } | null) =>
    error?.name === "AbortError" ? "timeout" : "request_failed",
  clearAaisResearchTelemetryForActor: telemetryMocks.clearActor,
  createAaisResearchLogoutContext: (operationId: string) => telemetryMocks.logoutContext
    ? { ...telemetryMocks.logoutContext, operationId }
    : null,
  createAaisResearchOperationId: (prefix = "operation") => {
    telemetryMocks.operationCounter += 1;
    return `${prefix}-test-${telemetryMocks.operationCounter}`;
  },
  isAaisResearchDisconnectError: (error: { name?: string } | null) =>
    error?.name === "AaisGuideStreamDisconnectedError",
  flushAaisResearchTelemetry: telemetryMocks.flush,
  getAaisResearchTelemetryPendingCount: () => 0,
  recordAaisResearchEvent: telemetryMocks.record,
  startAaisResearchTelemetry: telemetryMocks.start,
}));

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  routerMocks.replace.mockReset();
  browserNavigationMocks.replace.mockReset();
  telemetryMocks.record.mockReset();
  telemetryMocks.admit.mockReset();
  telemetryMocks.admit.mockImplementation((event) => {
    telemetryMocks.record(event);
    return true;
  });
  telemetryMocks.start.mockReset();
  telemetryMocks.start.mockImplementation(() => () => undefined);
  telemetryMocks.clearActor.mockReset();
  telemetryMocks.flush.mockReset();
  telemetryMocks.flush.mockImplementation(async () => undefined);
  telemetryMocks.actorGeneration = 0;
  telemetryMocks.logoutContext = null;
  telemetryMocks.operationCounter = 0;
  window.localStorage.clear();
  window.sessionStorage.clear();
  document.cookie = "aais_csrf=; Max-Age=0; path=/";
  document.cookie = "aais_locale=; Max-Age=0; path=/";
});

describe("AAIS LearningPage", () => {
  it("removes browser default spacing above the learning shell", () => {
    const globalCss = readFileSync("src/app/globals.css", "utf8");

    expect(globalCss).toMatch(/html,\s*body\s*\{[\s\S]*?margin:\s*0;[\s\S]*?padding:\s*0;/);
  });

  it("keeps pasted editor images bounded and renders one consistent underline weight", () => {
    const globalCss = readFileSync("src/app/globals.css", "utf8");

    expect(globalCss).toMatch(/\.aais-document-editor img\s*\{[\s\S]*?max-width:\s*100%;/);
    expect(globalCss).toMatch(/\.aais-document-editor img\s*\{[\s\S]*?user-select:\s*none;/);
    expect(globalCss).toMatch(/\.aais-document-editor u\s*\{[\s\S]*?text-decoration-thickness:\s*1px;/);
  });

  it("renders the simplified CAAIS learning shell with the content display menu", () => {
    render(<LearningPage />);

    const main = screen.getByRole("main", { name: "CAAIS 学习工作台" });
    expect(main.getAttribute("aria-describedby")).toBe("aais-learning-description");
    expect(main.textContent).not.toMatch(/\bA[12]\b/);
    expect(screen.getByText("使用智能导学、内容展示和文档编辑完成认知学徒学习任务。")).toBeTruthy();
    const brandText = screen.getByText("Cognitive Apprenticeship AI System (CAAIS)");
    const brandLogo = brandText.previousElementSibling;
    const loginLogo = screen.getByRole("img", { name: "CAAIS 标志" });

    expect(brandText).toBeTruthy();
    expect(brandText.className).toContain("text-xs");
    expect(brandText.className).toContain("sm:text-sm");
    expect(brandText.className).toContain("leading-tight");
    expect(brandText.className).not.toContain("leading-none");
    expect(brandText.className).not.toContain("text-[11px]");
    expect(brandText.className).not.toContain("sm:text-xs");
    expect(loginLogo).toBe(brandLogo);
    expect(brandLogo?.className).toContain("size-6");
    expect(brandLogo?.className).toContain("rounded-2xl");
    expect(brandLogo?.className).toContain("bg-[#1f6feb]");
    expect(brandLogo?.className).not.toContain("size-5");
    expect(loginLogo.querySelector("svg")).toBeTruthy();
    expect(screen.getByText("小张")).toBeTruthy();
    const a1Welcome = screen.getByText(/先选一个入口；需要专家示范就 @教授/);
    expect(a1Welcome.textContent?.length).toBeLessThanOrEqual(120);
    expect(screen.getByText(/@教授/)).toBeTruthy();
    expect(screen.getByRole("button", { name: "明确学习目标" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "开始示范" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "我卡住了，给我支架" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "整理反思记录" })).toBeTruthy();
    expect(screen.getByText("内容展示")).toBeTruthy();
    expect(screen.getByText("文档编辑")).toBeTruthy();
    expect(screen.getByRole("button", { name: "平台介绍" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "理论知识" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "历史文档" })).toBeTruthy();
    expect(screen.queryByText("全部字幕")).toBeNull();
    expect(screen.queryByText("课程目录")).toBeNull();
    expect(screen.queryByText("问这页")).toBeNull();
    expect(screen.queryByText("生成笔记")).toBeNull();
    expect(screen.queryByText("学习检查点")).toBeNull();
    expect(screen.queryByText("关键概念")).toBeNull();
    expect(screen.queryByText("导出笔记")).toBeNull();
    expect(screen.queryByText("播放设置")).toBeNull();
  });

  it("renders content display entries as refined row buttons instead of diamond bullets", () => {
    vi.stubGlobal("fetch", vi.fn(() => new Promise<Response>(() => undefined)));

    render(<LearningPage />);

    [
      ["平台介绍", "platform"],
      ["理论知识", "theory"],
      ["历史文档", "history"],
    ].forEach(([name, iconId]) => {
      const menuButton = screen.getByRole("button", { name });
      const label = Array.from(menuButton.querySelectorAll("span")).find(
        (span) => span.textContent === name,
      );
      const icon = menuButton.querySelector(`[data-content-entry-icon="${iconId}"]`);

      expect(menuButton.className).toContain("min-h-[104px]");
      expect(menuButton.className).toContain("rounded-lg");
      expect(menuButton.className).toContain("border-[#d7dce5]");
      expect(label?.className).toContain("text-[26px]");
      expect(label?.className).toContain("font-semibold");
      expect(icon).toBeTruthy();
      expect(icon?.className).toContain("bg-[#eef2ff]");
      expect(icon?.className).toContain("text-[#536de8]");
      expect(menuButton.className).not.toContain("rotate-45");
      expect(menuButton.className).not.toContain("bg-black");
      expect(menuButton.className).not.toContain("text-[34px]");
    });
  });

  it("matches the Claude Code desktop screenshot with a white canvas and serif page font", () => {
    render(<LearningPage />);

    const shell = screen.getByTestId("learning-shell");
    const pageRoot = shell.parentElement as HTMLElement;
    const guideInput = screen.getByLabelText("向智能导学输入你的想法");
    const composer = guideInput.closest("form");

    expect(pageRoot.className).toContain("bg-[#fcfcfc]");
    expect(pageRoot.className).toContain("text-[#0e0e0e]");
    expect(pageRoot.className).toContain("aais-learning-serif");
    expect(pageRoot.getAttribute("style")).toBeNull();
    expect(shell.className).toContain("bg-[#fcfcfc]");
    expect(composer?.className).toContain("from-[#fcfcfc]");
    expect(composer?.className).toContain("via-[#fcfcfc]");
  });

  it("matches the Claude Code desktop screenshot for the top learning header", () => {
    render(<LearningPage />);

    const brandText = screen.getByText("Cognitive Apprenticeship AI System (CAAIS)");
    const header = brandText.closest("header") as HTMLElement;
    const accountButton = screen.getByRole("button", { name: "Bobie 账户菜单" });

    expect(header.className).toContain("bg-[#fcfcfb]");
    expect(header.className).toContain("text-[#0e0e0e]");
    expect(header.className).not.toContain("bg-[#eeebe2]");
    expect(header.className).not.toContain("bg-[#11142a]");
    expect(header.className).toContain("aais-learning-navigation");
    expect(header.getAttribute("style")).toBeNull();
    expect(accountButton.className).toContain("text-[#0e0e0e]");
    expect(accountButton.className).not.toContain("text-white");
  });

  it("renders the learning workspace in English when the login preference is English", async () => {
    render(<LearningPage locale="en-US" />);

    const main = screen.getByRole("main", { name: "CAAIS Learning Workspace" });
    expect(main.getAttribute("aria-describedby")).toBe("aais-learning-description");
    expect(screen.getByText("Cognitive Apprenticeship AI System (CAAIS)")).toBeTruthy();
    expect(screen.getByText("Use AI guidance, learning content, and document editing to complete Cognitive Apprenticeship learning tasks.")).toBeTruthy();
    expect(screen.getByLabelText("Share your thinking with the AI guide")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Clarify my learning goal" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Upload file" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Learning content" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Document editor" })).toBeTruthy();
    expect(await screen.findByText("Xiao Zhang")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "内容展示" })).toBeNull();
    expect(screen.getByTestId("learning-shell").closest("[data-locale]")?.getAttribute("data-locale")).toBe("en-US");
  });

  it("sends the selected English locale to the guide service", async () => {
    setCsrfCookie();
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input).startsWith("/api/learning/session") && (!init || init.method === "GET")) {
        return Response.json({ session: createClientSessionFixture("") });
      }
      if (String(input) === "/api/learning/ai-guide" && init?.method === "POST") {
        return Response.json({
          message: { text: "CAAIS agents replied." },
          turns: [{
            agentId: "A1",
            label: "Guide Agent",
            content: "Let us clarify the first step.",
            actions: ["guide-flow", "scaffold"],
          }],
        });
      }
      return Response.json({ ok: true });
    });
    vi.stubGlobal("fetch", fetchMock);

    render(<LearningPage locale="en-US" />);

    fireEvent.change(screen.getByLabelText("Share your thinking with the AI guide"), {
      target: { value: "Help me begin." },
    });
    fireEvent.click(screen.getByRole("button", { name: "Send" }));

    await waitFor(() => {
      const guideCall = fetchMock.mock.calls.find(([input, init]) =>
        String(input) === "/api/learning/ai-guide" && init?.method === "POST"
      );
      expect(JSON.parse(String(guideCall?.[1]?.body))).toMatchObject({
        learnerInput: "Help me begin.",
        locale: "en-US",
      });
    });
    expect(await screen.findByText("Let us clarify the first step.")).toBeTruthy();
  });

  it("renders the server-provided app-session actor instead of stale browser identity", async () => {
    vi.stubGlobal("fetch", vi.fn(() => new Promise<Response>(() => undefined)));
    window.localStorage.setItem("aais_student_id", "Bobie");
    window.localStorage.setItem("aais_display_name", "Bobie");

    render(
      <LearningPage
        actor={{
          id: "Phoebe",
          displayName: "Phoebe",
        }}
      />,
    );

    expect(screen.getByRole("button", { name: "Phoebe 账户菜单" })).toBeTruthy();
    expect(screen.getByRole("img", { name: "Phoebe 原创英雄人脸头像" })).toBeTruthy();
    expect(screen.getByText(/你好，Phoebe/)).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Bobie 账户菜单" })).toBeNull();
  });

  it("does not mount the research workspace before telemetry reaches ready", () => {
    vi.stubGlobal("fetch", vi.fn(() => new Promise<Response>(() => undefined)));

    render(<LearningPage research={createRequiredResearchBoundary()} />);

    expect(screen.getByRole("main", { name: "CAAIS 研究会话保护" })).toBeTruthy();
    expect(screen.getByText("正在建立受控研究会话，请稍候。")).toBeTruthy();
    expect(screen.queryByTestId("learning-shell")).toBeNull();
    expect(screen.queryByRole("button", { name: "文档编辑" })).toBeNull();
  });

  it("keeps a blocked research boundary in English for an English login", () => {
    vi.stubGlobal("fetch", vi.fn(() => new Promise<Response>(() => undefined)));

    render(<LearningPage locale="en-US" research={createRequiredResearchBoundary()} />);

    expect(screen.getByRole("main", { name: "CAAIS Research Session Protection" })).toBeTruthy();
    expect(screen.getByText("A controlled research session is being established. Please wait.")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Exit safely to sign in" })).toBeTruthy();
  });

  it("keeps workspace state mounted but inert while offline or terminal", async () => {
    vi.stubGlobal("fetch", vi.fn(() => new Promise<Response>(() => undefined)));
    let updateBoundary: ((state: AaisResearchTelemetryBoundaryState) => void) | undefined;
    telemetryMocks.start.mockImplementation((options?: AaisResearchTelemetryStartOptions) => {
      updateBoundary = options?.onBoundaryStateChange;
      updateBoundary?.("ready");
      return () => undefined;
    });

    render(<LearningPage research={createRequiredResearchBoundary()} />);
    expect(await screen.findByTestId("learning-shell")).toBeTruthy();
    const guideInput = screen.getByLabelText("向智能导学输入你的想法") as HTMLTextAreaElement;
    fireEvent.change(guideInput, { target: { value: "保留的未提交草稿" } });

    act(() => updateBoundary?.("offline-or-temporary"));
    expect(screen.getByTestId("learning-shell")).toBeTruthy();
    expect(screen.getByTestId("research-workspace-gate").hasAttribute("inert")).toBe(true);
    expect(screen.getByTestId("research-workspace-gate").getAttribute("aria-hidden")).toBe("true");
    expect(screen.getByText(/避免产生未记录操作/)).toBeTruthy();
    expect(screen.queryByRole("button", { name: "明确学习目标" })).toBeNull();

    act(() => updateBoundary?.("ready"));
    expect(await screen.findByTestId("learning-shell")).toBeTruthy();
    expect(screen.getByTestId("research-workspace-gate").hasAttribute("inert")).toBe(false);
    expect((screen.getByLabelText("向智能导学输入你的想法") as HTMLTextAreaElement).value)
      .toBe("保留的未提交草稿");

    act(() => updateBoundary?.("terminal-blocked"));
    expect(screen.getByTestId("learning-shell")).toBeTruthy();
    expect(screen.getByTestId("research-workspace-gate").hasAttribute("inert")).toBe(true);
    expect(screen.getByText(/本次研究会话不可继续/)).toBeTruthy();
    expect(JSON.stringify(telemetryMocks.start.mock.calls)).not.toContain("原始学习文本");
  });

  it.each([
    ["revoked", { ok: true, sessionAbsent: false, sessionRevoked: true }],
    ["already absent", { ok: true, sessionAbsent: true, sessionRevoked: false }],
  ])("offers a telemetry-independent full-document safe exit when the session is %s", async (
    _label,
    acknowledgement,
  ) => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      expect(String(input)).toBe("/api/auth/app-session");
      expect(init?.method).toBe("DELETE");
      return Response.json(acknowledgement);
    });
    vi.stubGlobal("fetch", fetchMock);
    telemetryMocks.start.mockImplementation((options?: AaisResearchTelemetryStartOptions) => {
      options?.onBoundaryStateChange?.("terminal-blocked");
      return () => undefined;
    });

    render(<LearningPage research={createRequiredResearchBoundary()} />);
    fireEvent.click(await screen.findByRole("button", { name: "安全退出到登录页" }));

    await waitFor(() => expect(browserNavigationMocks.replace).toHaveBeenCalledWith("/login"));
    expect(routerMocks.replace).not.toHaveBeenCalled();
    expect(telemetryMocks.clearActor).toHaveBeenCalledOnce();
    expect(telemetryMocks.admit).not.toHaveBeenCalled();
  });

  it.each([
    ["empty 204", () => new Response(null, { status: 204 })],
    ["explicit false", () => Response.json({
      ok: true,
      sessionAbsent: false,
      sessionRevoked: false,
    })],
    ["missing acknowledgement", () => Response.json({ ok: true })],
  ])("preserves research state when safe exit receives %s", async (_label, createResponse) => {
    const fetchMock = vi.fn(async () => createResponse());
    vi.stubGlobal("fetch", fetchMock);
    telemetryMocks.start.mockImplementation((options?: AaisResearchTelemetryStartOptions) => {
      options?.onBoundaryStateChange?.("terminal-blocked");
      return () => undefined;
    });
    window.localStorage.setItem("aais_student_id", "Bobie");
    window.localStorage.setItem("aais_display_name", "Bobie");
    window.localStorage.setItem("aais_research_event_queue_v1", "durable-research-state");

    render(<LearningPage research={createRequiredResearchBoundary()} />);
    fireEvent.click(await screen.findByRole("button", { name: "安全退出到登录页" }));

    expect((await screen.findByRole("alert")).textContent)
      .toBe("安全退出暂时失败，请恢复连接后重试。");
    expect(telemetryMocks.clearActor).not.toHaveBeenCalled();
    expect(browserNavigationMocks.replace).not.toHaveBeenCalled();
    expect(routerMocks.replace).not.toHaveBeenCalled();
    expect(window.localStorage.getItem("aais_student_id")).toBe("Bobie");
    expect(window.localStorage.getItem("aais_display_name")).toBe("Bobie");
    expect(window.localStorage.getItem("aais_research_event_queue_v1"))
      .toBe("durable-research-state");
    expect((screen.getByRole("button", { name: "安全退出到登录页" }) as HTMLButtonElement).disabled)
      .toBe(false);
  });

  it("exports learner-owned privacy data from the account menu", async () => {
    let exportedJson = "";
    const write = vi.fn(async (blob: Blob) => {
      exportedJson = await blob.text();
    });
    const close = vi.fn();
    const createWritable = vi.fn(async () => ({
      write,
      close,
    }));
    const showSaveFilePicker = vi.fn(async () => ({
      createWritable,
    }));
    Object.defineProperty(window, "showSaveFilePicker", {
      configurable: true,
      value: showSaveFilePicker,
    });
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.startsWith("/api/learning/session")) {
        return Response.json({
          session: createClientSessionFixture("可导出的过程记录"),
        });
      }
      if (url === "/api/learning/privacy") {
        return Response.json({
          schemaVersion: 1,
          exportScope: "learner-data",
          studentId: "S001",
          data: {
            session: {
            dataGeneration: 1,
              tasks: [{ artifactText: "可导出的过程记录" }],
            },
            events: [],
          },
          privacy: {
            ownerScoped: true,
            includesRawLearnerText: true,
            secrets: "redacted",
          },
          secrets: "redacted",
        });
      }
      return Response.json({ ok: true });
    });
    vi.stubGlobal("fetch", fetchMock);

    render(<LearningPage />);

    fireEvent.click(screen.getByRole("button", { name: "Bobie 账户菜单" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "导出学习数据" }));

    await waitFor(() => expect(write).toHaveBeenCalledTimes(1));
    expect(showSaveFilePicker).toHaveBeenCalledWith(expect.objectContaining({
      suggestedName: "aais-Bobie-learner-data.json",
    }));
    expect(JSON.parse(exportedJson)).toMatchObject({
      exportScope: "learner-data",
      studentId: "S001",
      privacy: {
        secrets: "redacted",
      },
    });
    expect(screen.getByRole("status").textContent).toBe("学习数据已导出。");
  });

  it("refuses a learner-data export while an artifact save is still uncommitted", async () => {
    const showSaveFilePicker = vi.fn();
    Object.defineProperty(window, "showSaveFilePicker", {
      configurable: true,
      value: showSaveFilePicker,
    });
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.startsWith("/api/learning/session") && (!init || init.method === "GET")) {
        return Response.json({ session: createClientSessionFixture("") });
      }
      if (url === "/api/learning/privacy") {
        return Response.json({ exportScope: "learner-data" });
      }
      return Response.json({ ok: true });
    });
    vi.stubGlobal("fetch", fetchMock);

    render(<LearningPage />);
    fireEvent.click(screen.getByRole("button", { name: "文档编辑" }));
    const editor = await screen.findByLabelText("在这里写下任务理解、计划、执行过程或最终产出。");
    setRichEditorContent(editor, "<p>尚未提交到服务端的最新正文</p>");
    fireEvent.click(screen.getByRole("button", { name: "Bobie 账户菜单" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "导出学习数据" }));

    expect(await screen.findByText("请等待当前保存、下载或智能体操作完成后再导出学习数据。"))
      .toBeTruthy();
    expect(showSaveFilePicker).not.toHaveBeenCalled();
    expect(fetchMock.mock.calls.filter(([input]) =>
      String(input) === "/api/learning/privacy"
    )).toHaveLength(0);
  });

  it("announces account export progress and blocks overlapping account actions", async () => {
    const privacyResponse = createDeferred<Response>();
    const write = vi.fn(async () => undefined);
    const close = vi.fn(async () => undefined);
    const createWritable = vi.fn(async () => ({
      write,
      close,
    }));
    const showSaveFilePicker = vi.fn(async () => ({
      createWritable,
    }));
    Object.defineProperty(window, "showSaveFilePicker", {
      configurable: true,
      value: showSaveFilePicker,
    });
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.startsWith("/api/learning/session")) {
        return Response.json({
          session: createClientSessionFixture("可导出的过程记录"),
        });
      }
      if (url === "/api/learning/privacy" && !init?.method) {
        return privacyResponse.promise;
      }
      return Response.json({ ok: true });
    });
    vi.stubGlobal("fetch", fetchMock);
    telemetryMocks.actorGeneration = 11;

    render(<LearningPage />);

    fireEvent.click(screen.getByRole("button", { name: "Bobie 账户菜单" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "导出学习数据" }));

    expect(showSaveFilePicker).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(fetchMock.mock.calls.filter(([input, init]) =>
      String(input) === "/api/learning/privacy" && !init?.method
    )).toHaveLength(1));
    const privacyFetchIndex = fetchMock.mock.calls.findIndex(([input, init]) =>
      String(input) === "/api/learning/privacy" && !init?.method
    );
    expect(showSaveFilePicker.mock.invocationCallOrder[0]).toBeLessThan(
      fetchMock.mock.invocationCallOrder[privacyFetchIndex],
    );
    expect(createWritable).not.toHaveBeenCalled();

    const status = screen.getByRole("status");
    expect(status.textContent).toBe("正在导出学习数据...");
    expect(status.getAttribute("aria-live")).toBe("polite");
    expect(status.getAttribute("aria-atomic")).toBe("true");
    expect(screen.getByRole("menu", { name: "Bobie 账户信息" }).getAttribute("aria-busy")).toBe("true");
    expect((screen.getByRole("menuitem", { name: "导出学习数据" }) as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByRole("menuitem", { name: "删除学习数据" }) as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByRole("menuitem", { name: "退出" }) as HTMLButtonElement).disabled).toBe(true);

    fireEvent.click(screen.getByRole("menuitem", { name: "导出学习数据" }));
    expect(fetchMock.mock.calls.filter(([input, init]) =>
      String(input) === "/api/learning/privacy" && !init?.method
    )).toHaveLength(1);

    telemetryMocks.actorGeneration = 12;
    privacyResponse.resolve(Response.json({
      schemaVersion: 1,
      exportScope: "learner-data",
      studentId: "S001",
      data: {
        session: {
            dataGeneration: 1,
          tasks: [{ artifactText: "可导出的过程记录" }],
        },
        events: [],
      },
      privacy: {
        secrets: "redacted",
      },
      secrets: "redacted",
    }));

    await screen.findByText("学习数据已导出。");
    expect(write).toHaveBeenCalledTimes(1);
    expect(close).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole("menu", { name: "Bobie 账户信息" })).toBeNull();
    expect(getLastResearchEvent("learner_data_export")).toMatchObject({
      actorGeneration: 11,
      outcome: "success",
    });
  });

  it("deletes learner-owned privacy data with confirmation and CSRF", async () => {
    setCsrfCookie();
    const confirm = vi.fn(() => true);
    Object.defineProperty(window, "confirm", {
      configurable: true,
      value: confirm,
    });
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.startsWith("/api/learning/session")) {
        return Response.json({
          session: createClientSessionFixture("准备删除的过程记录"),
        });
      }
      if (url === "/api/learning/privacy" && init?.method === "DELETE") {
        expect(init.headers).toMatchObject({
          "x-aais-csrf": "test-csrf-token",
        });
        return Response.json({
          deletion: {
            studentId: "S001",
            storageMode: "postgres",
            learnerRecordDeleted: true,
            nextGeneration: 2,
            accountRetained: true,
            secrets: "redacted",
          },
        });
      }
      if (url === "/api/learning/ai-guide" && init?.method === "POST") {
        return Response.json({
          message: { text: "删除前回复" },
          turns: [{
            agentId: "A1",
            label: "小张",
            content: "删除前回复",
            actions: ["respond"],
          }],
        });
      }
      return Response.json({ ok: true });
    });
    vi.stubGlobal("fetch", fetchMock);

    render(<LearningPage />);

    const guideInput = screen.getByLabelText("向智能导学输入你的想法");
    fireEvent.change(guideInput, { target: { value: "删除前问题" } });
    fireEvent.click(screen.getByRole("button", { name: "发送" }));
    expect(await screen.findByText("删除前回复")).toBeTruthy();
    fireEvent.change(guideInput, { target: { value: "尚未提交的导学草稿" } });
    const guideFile = new File(["附件内容"], "delete-me.txt", { type: "text/plain" });
    fireEvent.change(screen.getByLabelText("选择上传文件"), { target: { files: [guideFile] } });
    expect(await screen.findByRole("button", { name: "移除 delete-me.txt" })).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Bobie 账户菜单" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "删除学习数据" }));

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith(
        "/api/learning/privacy",
        expect.objectContaining({ method: "DELETE" }),
      );
    });
    expect(confirm).toHaveBeenCalledWith("确定要删除当前学习数据吗？此操作会清除你的学习记录，但不会删除账号。");
    await waitFor(() => {
      expect(screen.getByRole("status").textContent).toBe("学习数据已删除。");
    });
    fireEvent.click(screen.getByRole("button", { name: "文档编辑" }));
    expect(screen.getByLabelText("在这里写下任务理解、计划、执行过程或最终产出。").textContent).toBe("");
    expect((screen.getByLabelText("向智能导学输入你的想法") as HTMLInputElement).value).toBe("");
    expect(screen.queryByText("删除前回复")).toBeNull();
    expect(screen.queryByRole("button", { name: "移除 delete-me.txt" })).toBeNull();
  });

  it("announces account deletion progress and clears progress when deletion fails", async () => {
    setCsrfCookie();
    const deleteResponse = createDeferred<Response>();
    const confirm = vi.fn(() => true);
    Object.defineProperty(window, "confirm", {
      configurable: true,
      value: confirm,
    });
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.startsWith("/api/learning/session")) {
        return Response.json({
          session: createClientSessionFixture("准备删除的过程记录"),
        });
      }
      if (url === "/api/learning/privacy" && init?.method === "DELETE") {
        return deleteResponse.promise;
      }
      return Response.json({ ok: true });
    });
    vi.stubGlobal("fetch", fetchMock);
    telemetryMocks.actorGeneration = 21;

    render(<LearningPage />);

    fireEvent.click(screen.getByRole("button", { name: "文档编辑" }));
    const retainedEditor = await screen.findByLabelText("在这里写下任务理解、计划、执行过程或最终产出。");
    await waitFor(() => expect(retainedEditor.textContent).toContain("准备删除的过程记录"));

    fireEvent.click(screen.getByRole("button", { name: "Bobie 账户菜单" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "删除学习数据" }));

    expect(screen.getByRole("status").textContent).toBe("正在删除学习数据...");
    expect(screen.getByRole("menu", { name: "Bobie 账户信息" }).getAttribute("aria-busy")).toBe("true");
    expect(screen.getByTestId("learning-split-layout").hasAttribute("inert")).toBe(true);

    telemetryMocks.actorGeneration = 22;
    deleteResponse.resolve(Response.json(
      {
        error: {
          code: "AAIS_TEST_DELETE_FAILED",
          message: "delete failed",
        },
        secrets: "redacted",
      },
      { status: 500 },
    ));

    await waitFor(() => {
      expect(screen.getByRole("alert").textContent).toBe("学习数据删除未能完成，请稍后重试。");
    });
    expect(screen.queryByText("正在删除学习数据...")).toBeNull();
    expect(retainedEditor.textContent).toContain("准备删除的过程记录");
    expect(screen.getByTestId("learning-split-layout").hasAttribute("inert")).toBe(false);
    expect(screen.getByRole("menu", { name: "Bobie 账户信息" }).getAttribute("aria-busy")).toBe("false");
    expect(getLastResearchEvent("learner_data_delete")).toMatchObject({
      actorGeneration: 21,
      outcome: "failure",
    });
  });

  it("uses a white background for inactive content tabs", () => {
    vi.stubGlobal("fetch", vi.fn(() => new Promise<Response>(() => undefined)));

    render(<LearningPage />);

    const displayTab = screen.getByRole("button", { name: "内容展示" });
    const editorTab = screen.getByRole("button", { name: "文档编辑" });

    expect(editorTab.className).toContain("bg-white");
    expect(displayTab.className).toContain("shadow-[inset_0_-3px_0_#536de8]");
    expect(editorTab.className).not.toContain("bg-[#f2f2f2]");

    fireEvent.click(editorTab);

    expect(displayTab.className).toContain("bg-white");
    expect(editorTab.className).toContain("shadow-[inset_0_-3px_0_#536de8]");
    expect(displayTab.className).not.toContain("bg-[#f2f2f2]");
  });

  it("uses a continuous content resize divider with an explicit grab handle", () => {
    render(<LearningPage />);

    const divider = screen.getByRole("separator", { name: "调整内容展示区域宽度" });
    const line = divider.querySelector('[data-content-resize-line="true"]');
    const handle = divider.querySelector('[data-content-resize-handle="true"]');

    expect(divider.className).toContain("w-6");
    expect(line?.className).toContain("inset-y-0");
    expect(line?.className).toContain("bg-[#d1d5dd]");
    expect(handle?.className).toContain("h-20");
    expect(handle?.className).toContain("rounded-full");
    expect(handle?.className).toContain("border-[#cfd4de]");
  });

  it("shows save and close only when the document editor tab is active", () => {
    vi.stubGlobal("fetch", vi.fn(() => new Promise<Response>(() => undefined)));

    render(<LearningPage />);

    expect(screen.queryByRole("button", { name: "保存并关闭" })).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "文档编辑" }));

    expect(screen.getByRole("button", { name: "保存并关闭" })).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "内容展示" }));

    expect(screen.queryByRole("button", { name: "保存并关闭" })).toBeNull();
  });

  it("places save and close before the local markdown download action", async () => {
    const write = vi.fn();
    const close = vi.fn();
    const createWritable = vi.fn(async () => ({
      write,
      close,
    }));
    const showSaveFilePicker = vi.fn(async () => ({
      createWritable,
    }));
    Object.defineProperty(window, "showSaveFilePicker", {
      configurable: true,
      value: showSaveFilePicker,
    });
    vi.stubGlobal("fetch", vi.fn(() => new Promise<Response>(() => undefined)));

    render(<LearningPage />);

    expect(screen.queryByRole("button", { name: "下载到本地" })).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "文档编辑" }));
    fireEvent.change(screen.getByLabelText("文档标题"), {
      target: {
        value: "学习计划",
      },
    });
    setRichEditorContent(
      screen.getByRole("textbox", {
        name: "在这里写下任务理解、计划、执行过程或最终产出。",
      }),
      "<h1>学习计划</h1><p><strong>重点记录</strong></p>",
    );

    const saveAndCloseButton = screen.getByRole("button", { name: "保存并关闭" });
    const downloadButton = screen.getByRole("button", { name: "下载到本地" });

    expect(saveAndCloseButton.className).not.toContain("ml-auto");
    expect(downloadButton.className).toContain("ml-auto");

    fireEvent.click(downloadButton);

    await waitFor(() => {
      expect(showSaveFilePicker).toHaveBeenCalledWith({
        suggestedName: "aais-training_task_1-document.md",
        types: [
          {
            description: "Markdown document",
            accept: {
              "text/markdown": [".md"],
            },
          },
        ],
      });
    });
    expect(createWritable).toHaveBeenCalledTimes(1);
    expect(write).toHaveBeenCalledTimes(1);
    const blob = write.mock.calls[0][0] as Blob;
    expect(blob.type).toBe("text/markdown;charset=utf-8");
    await expect(blob.text()).resolves.toContain("# 学习计划");
    await expect(blob.text()).resolves.toContain("**重点记录**");
    expect(close).toHaveBeenCalledTimes(1);
  });

  it("announces autosave progress and download progress while preventing duplicate local downloads", async () => {
    setCsrfCookie();
    const patchResponse = createDeferred<Response>();
    const fileHandleResponse = createDeferred<{
      createWritable: () => Promise<{
        write: (blob: Blob) => Promise<void>;
        close: () => Promise<void>;
      }>;
    }>();
    const write = vi.fn(async () => undefined);
    const close = vi.fn(async () => undefined);
    const createWritable = vi.fn(async () => ({
      write,
      close,
    }));
    const showSaveFilePicker = vi.fn(async () => fileHandleResponse.promise);
    Object.defineProperty(window, "showSaveFilePicker", {
      configurable: true,
      value: showSaveFilePicker,
    });
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.startsWith("/api/learning/session") && (!init || init.method === "GET")) {
        return Response.json({
          session: createClientSessionFixture(""),
        });
      }
      if (url === "/api/learning/session" && init?.method === "PATCH") {
        return patchResponse.promise;
      }
      return Response.json({ ok: true });
    });
    vi.stubGlobal("fetch", fetchMock);
    telemetryMocks.actorGeneration = 31;

    render(<LearningPage />);

    fireEvent.click(screen.getByRole("button", { name: "文档编辑" }));
    const artifactInput = await screen.findByLabelText("在这里写下任务理解、计划、执行过程或最终产出。");
    setRichEditorContent(artifactInput, "<p>需要保存和下载的记录</p>");

    let status = screen.getByRole("status");
    expect(status.textContent).toBe("文档更改待保存。");
    expect(status.className).toContain("shrink-0");
    expect(status.className).toContain("break-words");
    expect(status.getAttribute("aria-live")).toBe("polite");
    expect(status.getAttribute("aria-atomic")).toBe("true");

    telemetryMocks.actorGeneration = 32;
    fireEvent.blur(artifactInput);
    telemetryMocks.actorGeneration = 33;

    expect(screen.getByRole("status").textContent).toBe("正在保存文档...");
    expect(screen.getByLabelText("学习内容与文档").getAttribute("aria-busy")).toBe("true");
    expect(getPatchCalls(fetchMock)).toHaveLength(1);

    patchResponse.resolve(Response.json({
      session: createClientSessionFixture("<p>需要保存和下载的记录</p>"),
    }));

    await screen.findByText("文档已保存。");
    expect(screen.getByLabelText("学习内容与文档").getAttribute("aria-busy")).toBe("false");
    expect(getLastResearchEvent("document_artifact_save")).toMatchObject({
      actorGeneration: 32,
      outcome: "success",
    });

    telemetryMocks.actorGeneration = 34;
    fireEvent.click(screen.getByRole("button", { name: "下载到本地" }));

    const busyDownloadButton = screen.getByRole("button", { name: "下载中..." }) as HTMLButtonElement;
    expect(busyDownloadButton.disabled).toBe(true);
    status = screen.getByRole("status");
    expect(status.textContent).toBe("正在准备下载...");
    expect(screen.getByLabelText("学习内容与文档").getAttribute("aria-busy")).toBe("true");

    fireEvent.click(busyDownloadButton);
    expect(showSaveFilePicker).toHaveBeenCalledTimes(1);

    telemetryMocks.actorGeneration = 35;
    fileHandleResponse.resolve({
      createWritable,
    });

    await screen.findByText("文档下载已准备。");
    expect(write).toHaveBeenCalledTimes(1);
    expect(close).toHaveBeenCalledTimes(1);
    expect(screen.getByRole("button", { name: "下载到本地" })).toBeTruthy();
    expect(screen.getByLabelText("学习内容与文档").getAttribute("aria-busy")).toBe("false");
    expect(getLastResearchEvent("document_download")).toMatchObject({
      actorGeneration: 34,
      outcome: "success",
    });

    vi.useFakeTimers();
    setRichEditorContent(artifactInput, "<p>下载完成后继续编辑</p>");
    expect(screen.getByRole("status").textContent).toBe("文档更改待保存。");
    expect(screen.queryByText("文档下载已准备。")).toBeNull();
  });

  it("announces autosave and local download failures in the document panel", async () => {
    setCsrfCookie();
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.startsWith("/api/learning/session") && (!init || init.method === "GET")) {
        return Response.json({
          session: createClientSessionFixture(""),
        });
      }
      if (url === "/api/learning/session" && init?.method === "PATCH") {
        return Response.json(
          {
            error: {
              code: "AAIS_TEST_SAVE_FAILED",
              message: "backend save failed",
            },
            secrets: "redacted",
          },
          { status: 500 },
        );
      }
      return Response.json({ ok: true });
    });
    vi.stubGlobal("fetch", fetchMock);
    Object.defineProperty(window, "showSaveFilePicker", {
      configurable: true,
      value: vi.fn(async () => {
        throw new Error("picker closed");
      }),
    });

    render(<LearningPage />);

    fireEvent.click(screen.getByRole("button", { name: "文档编辑" }));
    const artifactInput = await screen.findByLabelText("在这里写下任务理解、计划、执行过程或最终产出。");
    setRichEditorContent(artifactInput, "<p>无法保存的记录</p>");
    fireEvent.blur(artifactInput);

    const saveAlerts = await screen.findAllByRole("alert");
    expect(saveAlerts.map((alert) => alert.textContent)).toContain("任务过程记录未能保存到后端。");
    expect(saveAlerts.every((alert) => alert.getAttribute("aria-live") === "assertive")).toBe(true);
    expect(saveAlerts.every((alert) => alert.getAttribute("aria-atomic") === "true")).toBe(true);

    fireEvent.click(screen.getByRole("button", { name: "下载到本地" }));

    await waitFor(() => {
      expect(screen.getAllByRole("alert").map((alert) => alert.textContent)).toContain(
        "文档下载未能完成，请稍后重试。",
      );
    });
  });

  it("shows Bobie with an original superhero face avatar in the top bar", () => {
    render(<LearningPage />);

    const avatar = screen.getByRole("img", { name: "Bobie 原创英雄人脸头像" });

    expect(avatar.className).toContain("size-8");
    expect(avatar.className).toContain("bg-[#26378f]");
    expect(avatar.className).toContain("shadow-[0_2px_10px_rgba(0,0,0,0.35)]");
    expect(avatar.querySelector('[data-avatar-part="face"]')).toBeTruthy();
    expect(avatar.querySelector('[data-avatar-part="mask"]')).toBeTruthy();
    expect(avatar.querySelector('[data-avatar-part="hair"]')).toBeTruthy();
    expect(avatar.querySelectorAll('[data-avatar-part="eye"]')).toHaveLength(2);
  });

  it("opens the Bobie account menu and logs out to the login page", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.startsWith("/api/learning/session") && (!init || init.method === "GET")) {
        return Response.json({
          session: {
            dataGeneration: 1,
            studentId: "S001",
            activeStage: "training",
            activeTaskId: "training_task_1",
            tasks: [],
            guideMessages: [],
            events: [],
          },
        });
      }
      if (url === "/api/auth/app-session" && init?.method === "DELETE") {
        return Response.json({ ok: true, sessionAbsent: true, sessionRevoked: false });
      }
      return Response.json({ ok: true });
    });
    vi.stubGlobal("fetch", fetchMock);
    window.localStorage.setItem("aais_student_id", "Bobie");
    window.localStorage.setItem("aais_display_name", "Bobie");

    render(<LearningPage />);

    expect(screen.queryByRole("menu", { name: "Bobie 账户信息" })).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Bobie 账户菜单" }));

    expect(screen.getByRole("menu", { name: "Bobie 账户信息" })).toBeTruthy();

    fireEvent.click(screen.getByRole("menuitem", { name: "退出" }));

    await waitFor(() => {
      expect(fetchMock.mock.calls.some(([input, init]) => (
        String(input) === "/api/auth/app-session"
        && (init as RequestInit | undefined)?.method === "DELETE"
        && (init as RequestInit | undefined)?.credentials === "same-origin"
      ))).toBe(true);
    });
    await waitFor(() => expect(browserNavigationMocks.replace).toHaveBeenCalledWith("/login"));
    const logoutEvents = telemetryMocks.record.mock.calls
      .map(([event]) => event)
      .filter((event) => event.eventName === "account_logout");
    expect(logoutEvents).toEqual([
      expect.objectContaining({ outcome: "attempted" }),
    ]);
    expect(telemetryMocks.flush).not.toHaveBeenCalled();
    expect(telemetryMocks.clearActor).toHaveBeenCalledTimes(1);
    expect(window.localStorage.getItem("aais_student_id")).toBeNull();
    expect(window.localStorage.getItem("aais_display_name")).toBeNull();
  });

  it("sends a visit-bound final research logout event before clearing the actor", async () => {
    setCsrfCookie();
    telemetryMocks.logoutContext = {
      expectedVisitId: "10000000-0000-4000-8000-000000000001",
      failureClientEventId: "10000000-0000-4000-8000-000000000002",
      finalClientTime: "2026-07-30T10:00:00.000Z",
      operationId: "replaced-by-hook-operation",
      successClientEventId: "10000000-0000-4000-8000-000000000003",
    };
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.startsWith("/api/learning/session") && (!init || init.method === "GET")) {
        return Response.json({ session: createClientSessionFixture("") });
      }
      if (url === "/api/auth/app-session" && init?.method === "DELETE") {
        const context = JSON.parse(String(init.body)).researchLogout;
        return Response.json({
          ok: true,
          sessionRevoked: true,
          researchLogout: {
            clientEventId: context.successClientEventId,
            visitId: context.expectedVisitId,
          },
        });
      }
      return Response.json({ ok: true });
    });
    vi.stubGlobal("fetch", fetchMock);

    render(<LearningPage />);
    fireEvent.click(screen.getByRole("button", { name: "Bobie 账户菜单" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "退出" }));

    await waitFor(() => expect(browserNavigationMocks.replace).toHaveBeenCalledWith("/login"));
    const deleteCall = fetchMock.mock.calls.find(([input, init]) =>
      String(input) === "/api/auth/app-session" && init?.method === "DELETE"
    );
    expect(deleteCall?.[1]).toMatchObject({
      credentials: "same-origin",
      headers: {
        "content-type": "application/json",
        "x-aais-csrf": "test-csrf-token",
      },
    });
    expect(JSON.parse(String(deleteCall?.[1]?.body))).toEqual({
      researchLogout: {
        expectedVisitId: telemetryMocks.logoutContext.expectedVisitId,
        failureClientEventId: telemetryMocks.logoutContext.failureClientEventId,
        finalClientTime: telemetryMocks.logoutContext.finalClientTime,
        operationId: expect.stringMatching(/^account-logout-test-/),
        successClientEventId: telemetryMocks.logoutContext.successClientEventId,
      },
    });
    expect(telemetryMocks.clearActor).toHaveBeenCalledOnce();
  });

  it("routes an already-absent formal-research session to the acknowledgement-gap outcome", async () => {
    setCsrfCookie();
    telemetryMocks.logoutContext = {
      expectedVisitId: "10000000-0000-4000-8000-000000000021",
      failureClientEventId: "10000000-0000-4000-8000-000000000022",
      finalClientTime: "2026-07-30T10:00:02.000Z",
      operationId: "replaced-by-hook-operation",
      successClientEventId: "10000000-0000-4000-8000-000000000023",
    };
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.startsWith("/api/learning/session") && (!init || init.method === "GET")) {
        return Response.json({ session: createClientSessionFixture("") });
      }
      if (url === "/api/auth/app-session" && init?.method === "DELETE") {
        return Response.json({
          ok: true,
          sessionAbsent: true,
          sessionRevoked: false,
        });
      }
      return Response.json({ ok: true });
    });
    vi.stubGlobal("fetch", fetchMock);
    window.localStorage.setItem("aais_student_id", "Bobie");

    render(<LearningPage />);
    fireEvent.click(screen.getByRole("button", { name: "Bobie 账户菜单" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "退出" }));

    await waitFor(() => expect(browserNavigationMocks.replace).toHaveBeenCalledWith(
      "/login?researchLogout=ack-failed",
    ));
    expect(window.sessionStorage.getItem("aais_research_logout_ack_gap_v1")).toBe("1");
    expect(window.localStorage.getItem("aais_student_id")).toBeNull();
    expect(telemetryMocks.clearActor).toHaveBeenCalledOnce();
    expect(telemetryMocks.record.mock.calls
      .map(([event]) => event)
      .filter((event) => event.eventName === "account_logout" && event.outcome === "failure"))
      .toHaveLength(0);
  });

  it("retains the actor and durable failure evidence when server logout revocation fails", async () => {
    setCsrfCookie();
    telemetryMocks.logoutContext = {
      expectedVisitId: "10000000-0000-4000-8000-000000000011",
      failureClientEventId: "10000000-0000-4000-8000-000000000012",
      finalClientTime: "2026-07-30T10:00:01.000Z",
      operationId: "replaced-by-hook-operation",
      successClientEventId: "10000000-0000-4000-8000-000000000013",
    };
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.startsWith("/api/learning/session") && (!init || init.method === "GET")) {
        return Response.json({ session: createClientSessionFixture("") });
      }
      if (url === "/api/auth/app-session" && init?.method === "DELETE") {
        return Response.json({
          error: { code: "AAIS_LOGOUT_FAILED" },
        }, { status: 503 });
      }
      return Response.json({ ok: true });
    });
    vi.stubGlobal("fetch", fetchMock);
    window.localStorage.setItem("aais_student_id", "Bobie");
    window.localStorage.setItem("aais_display_name", "Bobie");

    render(<LearningPage />);
    fireEvent.click(screen.getByRole("button", { name: "Bobie 账户菜单" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "退出" }));

    expect(await screen.findByText("退出未完成，服务器会话仍保持有效。请恢复连接后重试。")).toBeTruthy();
    const failureEvent = telemetryMocks.record.mock.calls
      .map(([event]) => event)
      .find((event) => event.eventName === "account_logout" && event.outcome === "failure");
    const attemptedEvent = telemetryMocks.record.mock.calls
      .map(([event]) => event)
      .find((event) => event.eventName === "account_logout" && event.outcome === "attempted");
    expect(failureEvent).toMatchObject({
      clientEventId: telemetryMocks.logoutContext.failureClientEventId,
      clientTime: telemetryMocks.logoutContext.finalClientTime,
      detail: {
        operation_id: attemptedEvent.detail.operation_id,
        error_kind: "session_revoke_failed",
      },
    });
    expect(telemetryMocks.flush).toHaveBeenCalledTimes(2);
    expect(telemetryMocks.clearActor).not.toHaveBeenCalled();
    expect(browserNavigationMocks.replace).not.toHaveBeenCalled();
    expect(window.localStorage.getItem("aais_student_id")).toBe("Bobie");
    expect(window.localStorage.getItem("aais_display_name")).toBe("Bobie");
  });

  it("announces logout progress while the app-session revoke request is pending", async () => {
    const logoutResponse = createDeferred<Response>();
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.startsWith("/api/learning/session") && (!init || init.method === "GET")) {
        return Response.json({
          session: createClientSessionFixture(""),
        });
      }
      if (url === "/api/auth/app-session" && init?.method === "DELETE") {
        return logoutResponse.promise;
      }
      return Response.json({ ok: true });
    });
    vi.stubGlobal("fetch", fetchMock);

    render(<LearningPage />);

    fireEvent.click(screen.getByRole("button", { name: "Bobie 账户菜单" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "退出" }));

    expect(screen.getByRole("status").textContent).toBe("正在退出...");
    expect(screen.getByRole("menu", { name: "Bobie 账户信息" }).getAttribute("aria-busy")).toBe("true");
    expect((screen.getByRole("menuitem", { name: "退出" }) as HTMLButtonElement).disabled).toBe(true);

    fireEvent.click(screen.getByRole("menuitem", { name: "退出" }));
    await waitFor(() => {
      expect(fetchMock.mock.calls.filter(([input, init]) =>
        String(input) === "/api/auth/app-session" && init?.method === "DELETE"
      )).toHaveLength(1);
    });

    logoutResponse.resolve(Response.json({ ok: true, sessionAbsent: true, sessionRevoked: false }));

    await waitFor(() => expect(browserNavigationMocks.replace).toHaveBeenCalledWith("/login"));
  });

  it("abandons a stale logout continuation after the actor generation changes", async () => {
    const telemetryFlush = createDeferred<void>();
    telemetryMocks.logoutContext = {
      expectedVisitId: "10000000-0000-4000-8000-000000000071",
      failureClientEventId: "10000000-0000-4000-8000-000000000072",
      finalClientTime: "2026-08-01T10:00:00.000Z",
      operationId: "replaced-by-hook-operation",
      successClientEventId: "10000000-0000-4000-8000-000000000073",
    };
    telemetryMocks.flush.mockImplementation(async () => {
      await telemetryFlush.promise;
      return undefined;
    });
    telemetryMocks.actorGeneration = 71;
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.startsWith("/api/learning/session") && (!init || init.method === "GET")) {
        return Response.json({ session: createClientSessionFixture("") });
      }
      return Response.json({ ok: true });
    });
    vi.stubGlobal("fetch", fetchMock);

    render(<LearningPage />);
    fireEvent.click(screen.getByRole("button", { name: "Bobie 账户菜单" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "退出" }));
    expect(telemetryMocks.flush).toHaveBeenCalled();

    telemetryMocks.actorGeneration = 72;
    telemetryFlush.resolve();
    await waitFor(() => {
      expect((screen.getByRole("menuitem", { name: "退出" }) as HTMLButtonElement).disabled).toBe(false);
    });

    expect(fetchMock.mock.calls.some(([input, init]) => (
      String(input) === "/api/auth/app-session" && init?.method === "DELETE"
    ))).toBe(false);
    expect(telemetryMocks.clearActor).not.toHaveBeenCalled();
    expect(browserNavigationMocks.replace).not.toHaveBeenCalled();
  });

  it("forces a full login reload after revocation without clearing a newer actor", async () => {
    const logoutResponse = createDeferred<Response>();
    telemetryMocks.actorGeneration = 81;
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.startsWith("/api/learning/session") && (!init || init.method === "GET")) {
        return Response.json({ session: createClientSessionFixture("") });
      }
      if (url === "/api/auth/app-session" && init?.method === "DELETE") {
        return logoutResponse.promise;
      }
      return Response.json({ ok: true });
    });
    vi.stubGlobal("fetch", fetchMock);

    render(<LearningPage />);
    fireEvent.click(screen.getByRole("button", { name: "Bobie 账户菜单" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "退出" }));
    await waitFor(() => expect(fetchMock.mock.calls.some(([input, init]) => (
      String(input) === "/api/auth/app-session" && init?.method === "DELETE"
    ))).toBe(true));

    telemetryMocks.actorGeneration = 82;
    window.localStorage.setItem("aais_student_id", "newer-actor");
    window.localStorage.setItem("aais_display_name", "Newer actor");
    logoutResponse.resolve(Response.json({ sessionRevoked: true }));

    await waitFor(() => expect(browserNavigationMocks.replace).toHaveBeenCalledWith("/login"));
    expect(telemetryMocks.clearActor).not.toHaveBeenCalled();
    expect(window.localStorage.getItem("aais_student_id")).toBe("newer-actor");
    expect(window.localStorage.getItem("aais_display_name")).toBe("Newer actor");
  });

  it("shows A1 and A2 with university education avatars instead of childlike cartoon badges", async () => {
    setCsrfCookie();
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.startsWith("/api/learning/session") && (!init || init.method === "GET")) {
        return Response.json({
          session: {
            dataGeneration: 1,
            studentId: "S001",
            activeStage: "training",
            activeTaskId: "training_task_1",
            tasks: [],
            guideMessages: [],
            events: [],
          },
        });
      }
      if (url === "/api/learning/ai-guide" && init?.method === "POST") {
        return Response.json({
          message: {
            text: "AAIS 智能体已回复。",
          },
          turns: [
            {
              agentId: "A1",
              label: "导学智能体",
              content: "A1 用路径图帮你拆下一步。",
              actions: ["guide-flow", "scaffold"],
            },
            {
              agentId: "A2",
              label: "专家智能体",
              content: "A2 用专家示范帮你检查理解。",
              actions: ["model", "coach"],
            },
          ],
        });
      }
      return Response.json({ ok: true });
    });
    vi.stubGlobal("fetch", fetchMock);

    render(<LearningPage />);

    fireEvent.click(screen.getByRole("button", { name: "开始示范" }));

    await waitFor(() => {
      const guideRequest = fetchMock.mock.calls.find(([input, init]) =>
        String(input) === "/api/learning/ai-guide" && init?.method === "POST"
      );
      expect(JSON.parse(String(guideRequest?.[1]?.body))).toMatchObject({
        learnerInput: "@教授 请示范一次元认知思考过程。",
        targetAgentIds: ["A2"],
      });
    });

    const a2Avatar = await screen.findByRole("img", {
      name: "教授大学教育风格头像",
    });
    const a1Avatar = screen.getAllByRole("img", {
      name: "小张大学教育风格头像",
    })[0];

    expect(a1Avatar.className).toContain("size-10");
    expect(a1Avatar.textContent).not.toContain("导");
    expect(a1Avatar.querySelector('[data-avatar-part="watercolor-wash"]')).toBeTruthy();
    expect(a1Avatar.querySelector('[data-avatar-part="advisor-book"]')).toBeTruthy();
    expect(a1Avatar.querySelector('[data-avatar-part="advisor-blazer"]')).toBeTruthy();
    expect(a1Avatar.querySelector('[data-avatar-part="guide-map"]')).toBeNull();
    expect(a2Avatar.className).toContain("size-10");
    expect(a2Avatar.textContent).not.toContain("专");
    expect(a2Avatar.querySelector('[data-avatar-part="watercolor-wash"]')).toBeTruthy();
    expect(a2Avatar.querySelector('[data-avatar-part="expert-glasses"]')).toBeTruthy();
    expect(a2Avatar.querySelector('[data-avatar-part="lecture-pointer"]')).toBeTruthy();
    expect(a2Avatar.querySelector('[data-avatar-part="research-chart"]')).toBeTruthy();
    expect(a2Avatar.querySelector('[data-avatar-part="expert-spark"]')).toBeNull();
  });

  it("shows streamed guide progress before the final agent answer", async () => {
    setCsrfCookie();
    const encoder = new TextEncoder();
    let streamController: ReadableStreamDefaultController<Uint8Array> | null = null;
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        streamController = controller;
        controller.enqueue(encoder.encode(
          'event: ack\ndata: {"status":"accepted","graphId":"learning-ai-guide"}\n\n',
        ));
        controller.enqueue(encoder.encode(
          'event: agent_start\ndata: {"agentId":"A1"}\n\n',
        ));
      },
    });
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.startsWith("/api/learning/session") && (!init || init.method === "GET")) {
        return Response.json({
          session: {
            dataGeneration: 1,
            studentId: "S001",
            activeStage: "training",
            activeTaskId: "training_task_1",
            tasks: [],
            guideMessages: [],
            events: [],
          },
        });
      }
      if (url === "/api/learning/ai-guide" && init?.method === "POST") {
        expect(new Headers(init.headers).get("accept")).toBe("text/event-stream");
        return new Response(stream, {
          status: 200,
          headers: {
            "content-type": "text/event-stream;charset=utf-8",
          },
        });
      }
      return Response.json({ ok: true });
    });
    vi.stubGlobal("fetch", fetchMock);

    render(<LearningPage />);

    fireEvent.click(screen.getByRole("button", { name: "明确学习目标" }));

    expect(await screen.findByText("小张正在处理你的问题...")).toBeTruthy();

    await act(async () => {
      streamController?.enqueue(encoder.encode(
        'event: agent_delta\ndata: {"agentId":"A1","content":"A1 已给出分步支架。"}\n\n',
      ));
      streamController?.enqueue(encoder.encode(
        'event: fallback\ndata: {"timeoutReason":"abort-timeout"}\n\n',
      ));
      streamController?.enqueue(encoder.encode(
        'event: done\ndata: {"status":"completed"}\n\n',
      ));
      streamController?.close();
    });

    expect(await screen.findByText("小张已给出分步支架。")).toBeTruthy();
    expect(screen.getByText("离线支架模式")).toBeTruthy();
  });

  it("does not open the file picker or launch a quick start when admission is rejected", () => {
    vi.stubGlobal("fetch", vi.fn(() => new Promise<Response>(() => undefined)));
    render(<LearningPage />);
    const fileInput = screen.getByLabelText("选择上传文件") as HTMLInputElement;
    const fileInputClick = vi.spyOn(fileInput, "click");
    telemetryMocks.admit.mockClear();
    telemetryMocks.admit.mockReturnValue(false);

    fireEvent.click(screen.getByRole("button", { name: "上传文件" }));
    fireEvent.click(screen.getByRole("button", { name: "明确学习目标" }));

    expect(fileInputClick).not.toHaveBeenCalled();
    expect(screen.queryByText("请帮我明确这个学习任务的目标，并拆成下一步。")).toBeNull();
    expect(telemetryMocks.admit.mock.calls.map(([event]) => event.eventName)).toEqual([
      "guide_attachment_picker_opened",
      "guide_quick_start_selected",
    ]);
  });

  it("prevents external guide navigation when link admission is rejected", async () => {
    setCsrfCookie();
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.startsWith("/api/learning/session") && (!init || init.method === "GET")) {
        return Response.json({ session: createClientSessionFixture("") });
      }
      if (url === "/api/learning/ai-guide" && init?.method === "POST") {
        return Response.json({
          message: { text: "已找到资料。" },
          turns: [{
            agentId: "A1",
            label: "导学智能体",
            content: "[外部资料](https://example.com/research)",
            actions: ["respond"],
          }],
        });
      }
      return Response.json({ ok: true });
    });
    vi.stubGlobal("fetch", fetchMock);
    render(<LearningPage />);
    const guideInput = await screen.findByLabelText("向智能导学输入你的想法");
    fireEvent.change(guideInput, { target: { value: "请提供资料" } });
    fireEvent.click(screen.getByRole("button", { name: "发送" }));
    const externalLink = await screen.findByRole("link", { name: "外部资料" });
    telemetryMocks.admit.mockReturnValue(false);

    expect(fireEvent.click(externalLink)).toBe(false);
    expect(telemetryMocks.admit).toHaveBeenLastCalledWith(expect.objectContaining({
      eventName: "guide_response_link_opened",
      outcome: "success",
      detail: expect.objectContaining({
        link_host: "external",
        link_protocol: "https:",
      }),
    }));
  });

  it("opens each content display item with a refined back control and reading layout", () => {
    render(<LearningPage />);

    fireEvent.click(screen.getByRole("button", { name: "平台介绍" }));
    const backButton = screen.getByRole("button", { name: "返回内容展示" });
    const backIcon = backButton.querySelector("svg");
    const platformIntro = screen.getByText(
      "CAAIS平台是一个基于认知学徒理论搭建的，AI赋能的学习平台……",
    );

    expect(backButton).toBeTruthy();
    expect(backButton.textContent).toContain("返回");
    expect(backButton.className).toContain("h-10");
    expect(backButton.className).toContain("min-w-[88px]");
    expect(backButton.className).toContain("rounded-[10px]");
    expect(backButton.className).toContain("border-[#d9dde4]");
    expect(backButton.className).not.toContain("size-16");
    expect(backButton.className).not.toContain("text-[#cfcfcf]");
    expect(backIcon?.getAttribute("width")).toBe("20");
    expect(backIcon?.getAttribute("height")).toBe("20");
    expect(screen.getByRole("heading", { name: "平台介绍", level: 2 }).className).toContain(
      "text-[22px]",
    );
    expect(platformIntro.parentElement?.className).toContain("max-w-[920px]");
    expect(platformIntro.className).toContain("text-[28px]");
    expect(platformIntro.textContent).not.toContain("。。。。");
    expect(screen.queryByRole("button", { name: "理论知识" })).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "返回内容展示" }));
    fireEvent.click(screen.getByRole("button", { name: "理论知识" }));
    expect(screen.getByRole("button", { name: "返回内容展示" })).toBeTruthy();
    expect(screen.getByText(/认知学徒理论强调专家示范/)).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "返回内容展示" }));
    fireEvent.click(screen.getByRole("button", { name: "历史文档" }));
    expect(screen.getByRole("button", { name: "返回内容展示" })).toBeTruthy();
    expect(screen.getByText(/历史文档用于保存学习过程/)).toBeTruthy();
  });

  it("keeps stale backend guide messages out of the simplified MVP shell", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.startsWith("/api/learning/session") && (!init || init.method === "GET")) {
        return Response.json({
          session: {
            dataGeneration: 1,
            studentId: "S001",
            activeStage: "training",
            activeTaskId: "training_task_1",
            tasks: [],
            guideMessages: [
              {
                id: "old-guide-message",
                kind: "user",
                text: "旧导学消息不应该出现在简化首页",
              },
            ],
            events: [],
          },
        });
      }
      return Response.json({ ok: true });
    });
    vi.stubGlobal("fetch", fetchMock);

    render(<LearningPage />);

    expect(await screen.findByText(/你好，Bobie/)).toBeTruthy();
    expect(screen.queryByText("旧导学消息不应该出现在简化首页")).toBeNull();
  });

  it("restores persisted attachment receipts after the learning page reloads", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input).startsWith("/api/learning/session") && (!init || init.method === "GET")) {
        return Response.json({
          session: {
            ...createClientSessionFixture(""),
            guideMessages: [
              {
                id: "persisted-user-attachment",
                kind: "user",
                text: "请概括论文",
                attachments: [{
                  name: "论文.docx",
                  mediaType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
                  sizeBytes: 2_048,
                  status: "read",
                }],
              },
              {
                id: "persisted-assistant-attachment",
                kind: "assistant",
                text: "已根据论文给出建议。",
              },
            ],
          },
        });
      }
      return Response.json({ ok: true });
    });
    vi.stubGlobal("fetch", fetchMock);

    render(<LearningPage />);

    expect(await screen.findByLabelText(
      "附件 论文.docx，Word 文档，2.0 KB，上传成功并已读取",
    )).toBeTruthy();
    expect(screen.getByText("请概括论文")).toBeTruthy();
    expect(screen.getByText("已根据论文给出建议。")).toBeTruthy();
  });

  it("runs the right-side intelligent guide through the AAIS API as structured agent turns", async () => {
    setCsrfCookie();
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.startsWith("/api/learning/session") && (!init || init.method === "GET")) {
        return Response.json({
          session: {
            dataGeneration: 1,
            studentId: "S001",
            activeStage: "training",
            activeTaskId: "training_task_1",
            tasks: [],
            guideMessages: [],
            events: [],
          },
        });
      }
      if (url === "/api/learning/ai-guide" && init?.method === "POST") {
        return Response.json({
          message: {
            text: "LangGraph 多智能体导学已完成：A1 A2 A3 A4",
          },
          turns: [
            {
              agentId: "A1",
              label: "导学智能体",
              content: "先确认目标并拆成下一步。",
              actions: ["respond"],
            },
            {
              agentId: "A2",
              label: "专家智能体",
              content: "我会示范专家如何监控自己的理解。",
              actions: ["model", "coach"],
            },
            {
              agentId: "A3",
              label: "监督智能体",
              content: "后台已记录行为信号，不应显示给学生。",
              actions: ["monitor", "signal-a1"],
            },
            {
              agentId: "A4",
              label: "反思智能体",
              content: "后台已形成反思记录，不应显示给学生。",
              actions: ["articulate", "reflect"],
            },
          ],
          orchestration: {
            graph: {
              runtime: "langgraph",
              graphId: "learning-ai-guide",
              topologicalOrder: ["A1", "A2"],
            },
          },
        });
      }
      return Response.json({ ok: true });
    });
    vi.stubGlobal("fetch", fetchMock);

    render(<LearningPage />);

    fireEvent.click(screen.getByRole("button", { name: "我卡住了，给我支架" }));

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith(
        "/api/learning/ai-guide",
        expect.objectContaining({
          method: "POST",
          headers: expect.objectContaining({
            "x-aais-csrf": "test-csrf-token",
          }),
        }),
      );
    });
    const guideCall = fetchMock.mock.calls.find(([input, init]) =>
      String(input) === "/api/learning/ai-guide" && init?.method === "POST"
    );
    expect(JSON.parse(String(guideCall?.[1]?.body))).toMatchObject({
      learnerInput: "我卡住了，想要一个支架提示。",
    });
    expect(await screen.findByText("先确认目标并拆成下一步。")).toBeTruthy();
    expect(screen.getByText("我会示范专家如何监控自己的理解。")).toBeTruthy();
    expect(screen.getAllByText("小张").length).toBeGreaterThanOrEqual(1);
    expect(screen.getByText("教授")).toBeTruthy();
    expect(screen.queryByText("后台已记录行为信号，不应显示给学生。")).toBeNull();
    expect(screen.queryByText("后台已形成反思记录，不应显示给学生。")).toBeNull();
    expect(screen.queryByText("LangGraph trace")).toBeNull();
    expect(screen.queryByText("graphId: learning-ai-guide")).toBeNull();
    expect(screen.queryByText("nodes: A1 -> A2 -> A3 -> A4")).toBeNull();
    expect(screen.queryByText("LangGraph 多智能体导学已完成：A1 A2 A3 A4")).toBeNull();
  });

  it("renders chat Markdown emphasis without inserting raw HTML", async () => {
    setCsrfCookie();
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.startsWith("/api/learning/session") && (!init || init.method === "GET")) {
        return Response.json({
          session: {
            dataGeneration: 1,
            studentId: "S001",
            activeStage: "training",
            activeTaskId: "training_task_1",
            tasks: [],
            guideMessages: [],
            events: [],
          },
        });
      }
      if (url === "/api/learning/ai-guide" && init?.method === "POST") {
        return Response.json({
          message: {
            text: "AAIS 智能体已回复。",
          },
          turns: [
            {
              agentId: "A1",
              label: "导学智能体",
              content:
                "我们先通过**观察专家思维**开始。\n\n1. **专家示范 (Modelling)**: 看专家如何拆解任务。\n<img src=x onerror=alert(1)>",
              actions: ["guide-flow", "scaffold"],
            },
          ],
        });
      }
      return Response.json({ ok: true });
    });
    vi.stubGlobal("fetch", fetchMock);

    render(<LearningPage />);

    fireEvent.change(screen.getByLabelText("向智能导学输入你的想法"), {
      target: {
        value: "请围绕 **我的目标** 给我支架",
      },
    });
    fireEvent.click(screen.getByRole("button", { name: "发送" }));

    expect(await screen.findByText("我的目标", { selector: "strong" })).toBeTruthy();
    expect(await screen.findByText("观察专家思维", { selector: "strong" })).toBeTruthy();
    expect(screen.getByText("专家示范 (Modelling)", { selector: "strong" })).toBeTruthy();
    expect(screen.queryByText(/\*\*观察专家思维\*\*/)).toBeNull();
    expect(document.querySelector("img")).toBeNull();
    expect(screen.getByText("<img src=x onerror=alert(1)>")).toBeTruthy();
  });

  it("sends @A1 mentions as a targeted guide request", async () => {
    setCsrfCookie();
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.startsWith("/api/learning/session") && (!init || init.method === "GET")) {
        return Response.json({
          session: {
            dataGeneration: 1,
            studentId: "S001",
            activeStage: "training",
            activeTaskId: "training_task_1",
            tasks: [],
            guideMessages: [],
            events: [],
          },
        });
      }
      if (url === "/api/learning/ai-guide" && init?.method === "POST") {
        return Response.json({
          message: {
            text: "AAIS 智能体已回复。",
          },
          turns: [
            {
              agentId: "A1",
              label: "导学智能体",
              content: "A1 收到你的专门提问。",
              actions: ["guide-flow", "scaffold"],
            },
          ],
        });
      }
      return Response.json({ ok: true });
    });
    vi.stubGlobal("fetch", fetchMock);

    render(<LearningPage />);

    fireEvent.change(screen.getByLabelText("向智能导学输入你的想法"), {
      target: {
        value: "@A1 请帮我拆下一步",
      },
    });
    fireEvent.click(screen.getByRole("button", { name: "发送" }));

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith(
        "/api/learning/ai-guide",
        expect.objectContaining({
          method: "POST",
        }),
      );
    });
    const guideCall = fetchMock.mock.calls.find(([input, init]) =>
      String(input) === "/api/learning/ai-guide" && init?.method === "POST"
    );
    expect(JSON.parse(String(guideCall?.[1]?.body))).toMatchObject({
      learnerInput: "@A1 请帮我拆下一步",
      targetAgentIds: ["A1"],
    });
    expect(screen.getByText("@小张 请帮我拆下一步")).toBeTruthy();
    expect(screen.queryByText("@A1 请帮我拆下一步")).toBeNull();
    expect(await screen.findByText("小张收到你的专门提问。")).toBeTruthy();
    expect(screen.queryByText("教授")).toBeNull();
  });

  it("shows the CAAIS pending acknowledgement while the guide request is running", async () => {
    setCsrfCookie();
    const fetchMock = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.startsWith("/api/learning/session") && (!init || init.method === "GET")) {
        return Promise.resolve(Response.json({
          session: {
            dataGeneration: 1,
            studentId: "S001",
            activeStage: "training",
            activeTaskId: "training_task_1",
            tasks: [],
            guideMessages: [],
            events: [],
          },
        }));
      }
      if (url === "/api/learning/ai-guide" && init?.method === "POST") {
        return new Promise<Response>(() => undefined);
      }
      return Promise.resolve(Response.json({ ok: true }));
    });
    vi.stubGlobal("fetch", fetchMock);

    render(<LearningPage />);

    fireEvent.click(screen.getByRole("button", { name: "我卡住了，给我支架" }));

    expect(screen.getByText("CAAIS 已收到，多智能体链路正在处理。")).toBeTruthy();
    expect(screen.queryByText("AAIS 已收到，多智能体链路正在处理。")).toBeNull();
  });

  it("replaces a stalled guide request with an unavailable message and unlocks input", async () => {
    vi.useFakeTimers();
    setCsrfCookie();
    const fetchMock = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.startsWith("/api/learning/session") && (!init || init.method === "GET")) {
        return Promise.resolve(Response.json({
          session: {
            dataGeneration: 1,
            studentId: "S001",
            activeStage: "training",
            activeTaskId: "training_task_1",
            tasks: [],
            guideMessages: [],
            events: [],
          },
        }));
      }
      if (url === "/api/learning/ai-guide" && init?.method === "POST") {
        return new Promise<Response>((_, reject) => {
          const signal = init.signal as AbortSignal | undefined;
          signal?.addEventListener("abort", () => {
            reject(Object.assign(new Error("guide request aborted"), { name: "AbortError" }));
          });
        });
      }
      return Promise.resolve(Response.json({ ok: true }));
    });
    vi.stubGlobal("fetch", fetchMock);

    render(<LearningPage />);

    fireEvent.click(screen.getByRole("button", { name: "我卡住了，给我支架" }));
    expect(screen.getByText("CAAIS 已收到，多智能体链路正在处理。")).toBeTruthy();

    await act(async () => {
      vi.advanceTimersByTime(30_001);
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(screen.queryByText("CAAIS 已收到，多智能体链路正在处理。")).toBeNull();
    expect(screen.getByText("智能服务暂时不可用，已保留你的问题。请稍后重试。")).toBeTruthy();
    expect((screen.getByRole("button", { name: "我卡住了，给我支架" }) as HTMLButtonElement).disabled).toBe(
      false,
    );
  });

  it("aborts the upstream fetch when an acknowledged guide stream stalls", async () => {
    vi.useFakeTimers();
    setCsrfCookie();
    const encoder = new TextEncoder();
    const cancelStream = vi.fn();
    let guideSignal: AbortSignal | undefined;
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode(
          'event: ack\ndata: {"status":"accepted","graphId":"learning-ai-guide"}\n\n',
        ));
      },
      cancel: cancelStream,
    });
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.startsWith("/api/learning/session") && (!init || init.method === "GET")) {
        return Response.json({
          session: {
            dataGeneration: 1,
            studentId: "S001",
            activeStage: "training",
            activeTaskId: "training_task_1",
            tasks: [],
            guideMessages: [],
            events: [],
          },
        });
      }
      if (url === "/api/learning/ai-guide" && init?.method === "POST") {
        guideSignal = init.signal as AbortSignal;
        return new Response(stream, {
          headers: { "content-type": "text/event-stream;charset=utf-8" },
        });
      }
      return Response.json({ ok: true });
    });
    vi.stubGlobal("fetch", fetchMock);

    render(<LearningPage />);
    fireEvent.click(screen.getByRole("button", { name: "我卡住了，给我支架" }));
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(guideSignal?.aborted).toBe(false);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(30_001);
    });

    expect(guideSignal?.aborted).toBe(true);
    expect(cancelStream).toHaveBeenCalledTimes(1);
    expect(screen.getByText("智能服务暂时不可用，已保留你的问题。请稍后重试。")).toBeTruthy();
    expect((screen.getByRole("button", { name: "我卡住了，给我支架" }) as HTMLButtonElement).disabled).toBe(
      false,
    );
  });

  it("keeps an acknowledged guide stream alive past 31 seconds when heartbeat comments arrive", async () => {
    vi.useFakeTimers();
    setCsrfCookie();
    const encoder = new TextEncoder();
    const cancelStream = vi.fn();
    let streamController: ReadableStreamDefaultController<Uint8Array> | null = null;
    let guideSignal: AbortSignal | undefined;
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        streamController = controller;
        controller.enqueue(encoder.encode(
          'event: ack\ndata: {"status":"accepted","graphId":"learning-ai-guide"}\n\n',
        ));
      },
      cancel: cancelStream,
    });
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.startsWith("/api/learning/session") && (!init || init.method === "GET")) {
        return Response.json({
          session: {
            dataGeneration: 1,
            studentId: "S001",
            activeStage: "training",
            activeTaskId: "training_task_1",
            tasks: [],
            guideMessages: [],
            events: [],
          },
        });
      }
      if (url === "/api/learning/ai-guide" && init?.method === "POST") {
        guideSignal = init.signal as AbortSignal;
        return new Response(stream, {
          headers: { "content-type": "text/event-stream;charset=utf-8" },
        });
      }
      return Response.json({ ok: true });
    });
    vi.stubGlobal("fetch", fetchMock);

    render(<LearningPage />);
    fireEvent.click(screen.getByRole("button", { name: "我卡住了，给我支架" }));
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    setTimeout(() => {
      streamController?.enqueue(encoder.encode(": aais-heartbeat\n\n"));
    }, 20_000);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(31_001);
    });

    expect(guideSignal?.aborted).toBe(false);
    expect(cancelStream).not.toHaveBeenCalled();

    await act(async () => {
      streamController?.enqueue(encoder.encode(
        'event: agent_delta\ndata: {"agentId":"A1","content":"心跳后回复。"}\n\n',
      ));
      streamController?.enqueue(encoder.encode(
        'event: done\ndata: {"status":"completed"}\n\n',
      ));
      streamController?.close();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(screen.getByText("心跳后回复。")).toBeTruthy();
    expect(guideSignal?.aborted).toBe(false);
  });

  it("allows the learning shell to use the full horizontal viewport", () => {
    render(<LearningPage />);

    const shell = screen.getByTestId("learning-shell");
    expect(shell.className).toContain("max-w-none");
    expect(shell.className).not.toContain("max-w-[1608px]");
    expect(shell.className).not.toContain("mx-auto");
    expect(shell.className).not.toContain("lg:max-w");
    expect(shell.className).toContain("min-h-[100dvh]");
  });

  it("uses a full-width ChatGPT-style guide input and switches the send arrow dark while typing", () => {
    render(<LearningPage />);

    const guideInput = screen.getByLabelText("向智能导学输入你的想法");
    const inputShell = guideInput.closest("div");
    const sendButton = screen.getByRole("button", { name: "发送" });

    expect(inputShell?.className).toContain("w-full");
    expect(inputShell?.className).toContain("min-h-[72px]");
    expect(inputShell?.className).not.toContain("max-w-[880px]");
    expect(inputShell?.className).toContain("rounded-[28px]");
    expect(guideInput.className).toContain("h-[72px]");
    expect(guideInput.className).toContain("text-base");
    expect(sendButton.className).toContain("bg-[#d7dbe3]");

    fireEvent.change(guideInput, {
      target: {
        value: "我想继续学习平台介绍",
      },
    });

    expect(sendButton.className).toContain("bg-[#202329]");
  });

  it("keeps the guide composer anchored while A1 and A2 replies scroll", () => {
    render(<LearningPage />);

    const shell = screen.getByTestId("learning-shell");
    const splitLayout = screen.getByTestId("learning-split-layout");
    const guideInput = screen.getByLabelText("向智能导学输入你的想法");
    const composer = guideInput.closest("form");
    const guidePanel = composer?.parentElement;
    const transcript = composer?.previousElementSibling;

    expect(shell.className).toContain("lg:h-[100dvh]");
    expect(splitLayout.className).toContain("lg:overflow-hidden");
    expect(guidePanel?.className).toContain("lg:min-h-0");
    expect(transcript?.className).toContain("overflow-y-auto");
    expect(composer?.className).toContain("sticky");
    expect(composer?.className).toContain("bottom-0");
    expect(composer?.className).toContain("shrink-0");
  });

  it("shows a localized upload-file control and turns a selected text file into a removable chip", async () => {
    render(<LearningPage />);

    expect(screen.getByRole("button", { name: "上传文件" })).toBeTruthy();
    const fileInput = screen.getByLabelText("选择上传文件");
    const file = new File(["目标：先阅读材料，再列出下一步。"], "strategy.md", {
      type: "text/markdown",
    });

    fireEvent.change(fileInput, {
      target: {
        files: [file],
      },
    });

    expect(await screen.findByText("strategy.md")).toBeTruthy();
    expect(screen.getByText(`${file.size} B`)).toBeTruthy();

    telemetryMocks.admit.mockReturnValue(false);
    fireEvent.click(screen.getByRole("button", { name: "移除 strategy.md" }));
    expect(screen.getByText("strategy.md")).toBeTruthy();

    telemetryMocks.admit.mockReturnValue(true);
    fireEvent.click(screen.getByRole("button", { name: "移除 strategy.md" }));
    expect(screen.queryByText("strategy.md")).toBeNull();
  });

  it("announces guide file-reading progress and disables composer actions until the chip is ready", async () => {
    const fileRead = createDeferred<string>();
    const file = new File(["稍后读取"], "delayed.md", {
      type: "text/markdown",
    });
    vi.spyOn(file, "text").mockImplementation(async () => fileRead.promise);
    telemetryMocks.actorGeneration = 41;

    render(<LearningPage />);

    fireEvent.change(screen.getByLabelText("选择上传文件"), {
      target: {
        files: [file],
      },
    });

    const status = screen.getByRole("status");
    expect(status.textContent).toBe("文件正在读取...");
    expect(status.getAttribute("aria-live")).toBe("polite");
    expect(status.getAttribute("aria-atomic")).toBe("true");
    expect(status.closest("section")?.getAttribute("aria-busy")).toBe("true");
    expect((screen.getByRole("button", { name: "上传文件" }) as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByRole("button", { name: "发送" }) as HTMLButtonElement).disabled).toBe(true);

    telemetryMocks.actorGeneration = 42;
    fileRead.resolve("延迟读取的上传材料。");

    expect(await screen.findByText("delayed.md")).toBeTruthy();
    expect(screen.queryByText("文件正在读取...")).toBeNull();
    expect((screen.getByRole("button", { name: "上传文件" }) as HTMLButtonElement).disabled).toBe(false);
    expect((screen.getByRole("button", { name: "发送" }) as HTMLButtonElement).disabled).toBe(false);
    const attachmentAttempt = telemetryMocks.admit.mock.calls
      .map(([event]) => event)
      .find((event) => event.eventName === "guide_attachment_add")!;
    const attachmentSuccess = getLastResearchEvent("guide_attachment_add");
    expect(attachmentAttempt).toMatchObject({
      actorGeneration: 41,
      outcome: "attempted",
    });
    expect(attachmentSuccess).toMatchObject({
      actorGeneration: 41,
      outcome: "success",
    });
    expect(attachmentAttempt.detail.operation_id).toBe(attachmentSuccess.detail.operation_id);
  });

  it("never places an unsupported browser MIME token into research telemetry", async () => {
    const file = new File(["synthetic"], "unsupported.png", {
      type: "image/png+PrivateToken",
    });
    render(<LearningPage />);

    fireEvent.change(screen.getByLabelText("选择上传文件"), {
      target: { files: [file] },
    });

    await waitFor(() => {
      expect(telemetryMocks.record.mock.calls
        .map(([event]) => event)
        .some((event) => (
          event.eventName === "guide_attachment_add"
          && event.outcome === "failure"
        ))).toBe(true);
    });
    const attachmentEvents = telemetryMocks.record.mock.calls
      .map(([event]) => event)
      .filter((event) => event.eventName === "guide_attachment_add");
    expect(attachmentEvents).toHaveLength(2);
    expect(attachmentEvents.every((event) => event.detail.mime_type === undefined)).toBe(true);
    expect(JSON.stringify(attachmentEvents)).not.toContain("PrivateToken");
  });

  it("sends selected file snippets and keeps a read receipt on the user message", async () => {
    setCsrfCookie();
    const fetchMock = installGuideFetchMock();
    const file = new File(["私有上传片段：请提炼三个关键点。"], "notes.txt", {
      type: "text/plain",
    });

    render(<LearningPage />);

    fireEvent.change(screen.getByLabelText("选择上传文件"), {
      target: {
        files: [file],
      },
    });
    expect(await screen.findByText("notes.txt")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "发送" }));

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith(
        "/api/learning/ai-guide",
        expect.objectContaining({
          method: "POST",
        }),
      );
    });
    const guideCall = fetchMock.mock.calls.find(([input, init]) =>
      String(input) === "/api/learning/ai-guide" && init?.method === "POST"
    );
    expect(JSON.parse(String(guideCall?.[1]?.body))).toMatchObject({
      learnerInput: "请阅读我上传的文件，并帮我提炼关键内容和下一步学习建议。",
      workspaceState: {
        attachments: [
          {
            name: "notes.txt",
            mediaType: "text/plain",
            sizeBytes: file.size,
            extractedText: "私有上传片段：请提炼三个关键点。",
          },
        ],
      },
    });
    expect(await screen.findByText("小张已阅读上传文件。")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "移除 notes.txt" })).toBeNull();
    expect(screen.getByRole("list", { name: "此消息已发送的文件" })).toBeTruthy();
    expect(screen.getByLabelText("附件 notes.txt，纯文本，48 B，上传成功并已读取")).toBeTruthy();
    expect(screen.getByText("上传成功 · 已读取")).toBeTruthy();
  });

  it("keeps an attachment available for retry and never claims success when the guide fails", async () => {
    setCsrfCookie();
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.startsWith("/api/learning/session") && (!init || init.method === "GET")) {
        return Response.json({ session: createClientSessionFixture("") });
      }
      if (url === "/api/learning/ai-guide" && init?.method === "POST") {
        return Response.json({ error: "guide unavailable" }, { status: 503 });
      }
      return Response.json({ ok: true });
    });
    vi.stubGlobal("fetch", fetchMock);
    const file = new File(["重试时仍需保留"], "retry-notes.txt", {
      type: "text/plain",
    });

    render(<LearningPage />);
    fireEvent.change(screen.getByLabelText("选择上传文件"), {
      target: { files: [file] },
    });
    expect(await screen.findByRole("button", { name: "移除 retry-notes.txt" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "发送" }));

    expect(await screen.findByText(
      "智能服务暂时不可用，已保留你的问题。请稍后重试。",
    )).toBeTruthy();
    expect(screen.getByRole("button", { name: "移除 retry-notes.txt" })).toBeTruthy();
    expect(screen.queryByRole("list", { name: "此消息已发送的文件" })).toBeNull();
    expect(screen.queryByText("上传成功 · 已读取")).toBeNull();
  });

  it("rejects oversized guide attachments inline before sending them", async () => {
    const fetchMock = installGuideFetchMock();
    const oversized = new File(["x"], "too-large.txt", {
      type: "text/plain",
    });
    Object.defineProperty(oversized, "size", { value: 20 * 1024 * 1024 + 1 });

    render(<LearningPage />);

    fireEvent.change(screen.getByLabelText("选择上传文件"), {
      target: {
        files: [oversized],
      },
    });

    expect(await screen.findByText("文件 too-large.txt 超过 20 MB 上传上限。")).toBeTruthy();
    expect(screen.queryByText("too-large.txt")).toBeNull();
    expect(fetchMock).not.toHaveBeenCalledWith(
      "/api/learning/ai-guide",
      expect.objectContaining({
        method: "POST",
      }),
    );
  });

  it("passes the English workspace locale to attachment error handling", async () => {
    const unsupported = new File(["x"], "unsupported.pages", {
      type: "application/octet-stream",
    });

    render(<LearningPage locale="en-US" />);
    fireEvent.change(screen.getByLabelText("Choose files to upload"), {
      target: { files: [unsupported] },
    });

    expect(await screen.findByText(
      "File unsupported.pages is not a supported file type.",
    )).toBeTruthy();
    expect(screen.queryByText("文件 unsupported.pages 暂不支持。")).toBeNull();
  });

  it("uses larger readable typography for learner, A1, and A2 chat messages", async () => {
    setCsrfCookie();
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.startsWith("/api/learning/session") && (!init || init.method === "GET")) {
        return Response.json({
          session: {
            dataGeneration: 1,
            studentId: "S001",
            activeStage: "training",
            activeTaskId: "training_task_1",
            tasks: [],
            guideMessages: [],
            events: [],
          },
        });
      }
      if (url === "/api/learning/ai-guide" && init?.method === "POST") {
        return Response.json({
          message: {
            text: "AAIS 智能体已回复。",
          },
          turns: [
            {
              agentId: "A1",
              label: "导学智能体",
              content: "A1 放大后的回复。",
              actions: ["respond"],
            },
            {
              agentId: "A2",
              label: "专家智能体",
              content: "A2 放大后的回复。",
              actions: ["coach"],
            },
          ],
        });
      }
      return Response.json({ ok: true });
    });
    vi.stubGlobal("fetch", fetchMock);

    render(<LearningPage />);

    fireEvent.click(screen.getByRole("button", { name: "我卡住了，给我支架" }));

    const pendingAssistantLabel = screen.getByText("AI 助教");
    expect(pendingAssistantLabel.className).toContain("text-sm");
    expect(pendingAssistantLabel.className).not.toContain("text-[11px]");

    const learnerBubble = screen.getByText("我卡住了，想要一个支架提示。").closest("div");
    expect(learnerBubble?.className).toContain("text-[17px]");
    expect(learnerBubble?.className).toContain("leading-8");

    const a1Bubble = (await screen.findByText("小张放大后的回复。")).closest("article");
    const a2Bubble = screen.getByText("教授放大后的回复。").closest("article");
    const a1Label = a1Bubble?.querySelector("p");
    const a2Label = a2Bubble?.querySelector("p");
    expect(a1Label?.className).toContain("text-sm");
    expect(a1Label?.className).not.toContain("text-[11px]");
    expect(a2Label?.className).toContain("text-sm");
    expect(a2Label?.className).not.toContain("text-[11px]");
    expect(a1Bubble?.className).toContain("text-[17px]");
    expect(a1Bubble?.className).toContain("leading-8");
    expect(a2Bubble?.className).toContain("text-[17px]");
    expect(a2Bubble?.className).toContain("leading-8");
  });

  it("lets the learner drag the vertical divider to resize the content panel", () => {
    render(<LearningPage />);

    const splitLayout = screen.getByTestId("learning-split-layout");
    const divider = screen.getByRole("separator", { name: "调整内容展示区域宽度" });

    vi.spyOn(splitLayout, "getBoundingClientRect").mockReturnValue({
      x: 0,
      y: 0,
      left: 0,
      top: 0,
      right: 1200,
      bottom: 700,
      width: 1200,
      height: 700,
      toJSON: () => ({}),
    });

    expect(splitLayout.getAttribute("data-content-panel-width")).toBe("600");

    fireEvent.pointerDown(divider, {
      clientX: 900,
      pointerId: 1,
    });
    fireEvent.pointerMove(document, {
      clientX: 760,
      pointerId: 1,
    });
    fireEvent.pointerUp(document, {
      pointerId: 1,
    });

    expect(splitLayout.getAttribute("data-content-panel-width")).toBe("440");
    expect(divider.getAttribute("aria-valuenow")).toBe("440");

    fireEvent.keyDown(divider, {
      key: "ArrowRight",
    });

    expect(splitLayout.getAttribute("data-content-panel-width")).toBe("416");
  });

  it("gates pointer and keyboard resize before either width mutation", () => {
    render(<LearningPage />);
    const splitLayout = screen.getByTestId("learning-split-layout");
    const divider = screen.getByRole("separator", { name: "调整内容展示区域宽度" });
    vi.spyOn(splitLayout, "getBoundingClientRect").mockReturnValue({
      x: 0,
      y: 0,
      left: 0,
      top: 0,
      right: 1200,
      bottom: 700,
      width: 1200,
      height: 700,
      toJSON: () => ({}),
    });
    telemetryMocks.admit.mockReturnValue(false);

    fireEvent.pointerDown(divider, { clientX: 900, pointerId: 7 });
    fireEvent.pointerMove(document, { clientX: 760, pointerId: 7 });
    fireEvent.pointerUp(document, { pointerId: 7 });
    fireEvent.keyDown(divider, { key: "ArrowRight" });

    expect(splitLayout.getAttribute("data-content-panel-width")).toBe("600");
    const resizeAdmissions = telemetryMocks.admit.mock.calls
      .map(([event]) => event)
      .filter((event) => event.eventName === "panel_resize_completed");
    expect(resizeAdmissions).toHaveLength(2);
    expect(resizeAdmissions.map((event) => event.outcome)).toEqual(["attempted", "success"]);
  });

  it("uses readable typography in the document editor area", () => {
    render(<LearningPage />);

    fireEvent.click(screen.getByRole("button", { name: "文档编辑" }));

    const titleInput = screen.getByLabelText("文档标题");
    const fontSelect = screen.getByLabelText("字体");
    const boldButton = screen.getByRole("button", { name: "加粗" });
    const artifactInput = screen.getByLabelText("在这里写下任务理解、计划、执行过程或最终产出。");

    expect(screen.getByRole("toolbar", { name: "文档格式工具" })).toBeTruthy();
    expect(titleInput.className).toContain("h-12");
    expect(titleInput.className).toContain("text-[17px]");
    expect(fontSelect.className).toContain("h-10");
    expect(fontSelect.className).toContain("text-base");
    expect(boldButton.className).toContain("min-h-11");
    expect(boldButton.className).toContain("min-w-11");
    expect(boldButton.className).toContain("text-sm");
    expect(boldButton.getAttribute("aria-pressed")).toBe("false");
    expect(screen.getByRole("button", { name: "左对齐" }).getAttribute("aria-pressed")).toBe("true");
    expect(artifactInput.getAttribute("contenteditable")).toBe("true");
    expect(artifactInput.getAttribute("data-font-family")).toBe("serif");
    expect(artifactInput.getAttribute("data-font-size")).toBe("17");
    expect(artifactInput.getAttribute("style")).toBeNull();
    expect(artifactInput.className).toContain("leading-7");
  });

  it("runs every document editor toolbar control", () => {
    const execCommand = installExecCommandMock();

    render(<LearningPage />);

    fireEvent.click(screen.getByRole("button", { name: "文档编辑" }));
    const artifactInput = screen.getByRole("textbox", {
      name: "在这里写下任务理解、计划、执行过程或最终产出。",
    });
    setRichEditorContent(artifactInput, "需要格式化的内容");

    fireEvent.change(screen.getByLabelText("字体"), {
      target: {
        value: "serif",
      },
    });
    expect(artifactInput.getAttribute("data-font-family")).toBe("serif");
    expect(execCommand).toHaveBeenCalledWith(
      "fontName",
      false,
      expect.stringContaining("Georgia"),
    );

    fireEvent.change(screen.getByLabelText("字号"), {
      target: {
        value: "24",
      },
    });
    expect(artifactInput.getAttribute("data-font-size")).toBe("24");

    fireEvent.click(screen.getByRole("button", { name: "加粗" }));
    fireEvent.click(screen.getByRole("button", { name: "斜体" }));
    fireEvent.click(screen.getByRole("button", { name: "下划线" }));
    fireEvent.click(screen.getByRole("button", { name: "左对齐" }));
    fireEvent.click(screen.getByRole("button", { name: "居中" }));
    fireEvent.click(screen.getByRole("button", { name: "右对齐" }));
    fireEvent.click(screen.getByRole("button", { name: "项目符号" }));
    fireEvent.click(screen.getByRole("button", { name: "编号列表" }));
    fireEvent.click(screen.getByRole("button", { name: "一级标题" }));
    fireEvent.click(screen.getByRole("button", { name: "二级标题" }));
    fireEvent.click(screen.getByRole("button", { name: "三级标题" }));

    expect(execCommand).toHaveBeenCalledWith("bold", false, undefined);
    expect(execCommand).toHaveBeenCalledWith("italic", false, undefined);
    expect(execCommand).toHaveBeenCalledWith("underline", false, undefined);
    expect(execCommand).not.toHaveBeenCalledWith("justifyLeft", false, undefined);
    expect(execCommand).not.toHaveBeenCalledWith("justifyCenter", false, undefined);
    expect(execCommand).not.toHaveBeenCalledWith("justifyRight", false, undefined);
    expect(execCommand).toHaveBeenCalledWith("insertUnorderedList", false);
    expect(execCommand).toHaveBeenCalledWith("insertOrderedList", false);
    expect(execCommand).toHaveBeenCalledWith("formatBlock", false, "<h1>");
    expect(execCommand).toHaveBeenCalledWith("formatBlock", false, "<h2>");
    expect(execCommand).toHaveBeenCalledWith("formatBlock", false, "<h3>");
  });

  it("does not apply editor formatting before its success event is admitted", () => {
    const execCommand = installExecCommandMock();
    render(<LearningPage />);
    fireEvent.click(screen.getByRole("button", { name: "文档编辑" }));
    const artifactInput = screen.getByRole("textbox", {
      name: "在这里写下任务理解、计划、执行过程或最终产出。",
    });
    telemetryMocks.admit.mockReturnValue(false);

    fireEvent.change(screen.getByLabelText("字号"), { target: { value: "24" } });
    fireEvent.click(screen.getByRole("button", { name: "加粗" }));

    expect(artifactInput.getAttribute("data-font-size")).toBe("17");
    expect(execCommand).not.toHaveBeenCalled();
    const formatAdmissions = telemetryMocks.admit.mock.calls
      .map(([event]) => event)
      .filter((event) => event.eventName === "editor_format_applied");
    expect(formatAdmissions).toHaveLength(2);
    expect(formatAdmissions.every((event) => event.outcome === "success")).toBe(true);
  });

  it("applies inline and alignment formatting with accessible pressed states when browser commands fail", () => {
    Object.defineProperty(document, "execCommand", {
      configurable: true,
      value: vi.fn(() => false),
    });
    render(<LearningPage />);
    fireEvent.click(screen.getByRole("button", { name: "文档编辑" }));
    const artifactInput = screen.getByRole("textbox", {
      name: "在这里写下任务理解、计划、执行过程或最终产出。",
    });
    setRichEditorContent(artifactInput, "<p>需要保留格式</p>");
    const paragraph = artifactInput.querySelector("p") as HTMLParagraphElement;
    const range = document.createRange();
    range.selectNodeContents(paragraph);
    window.getSelection()?.removeAllRanges();
    window.getSelection()?.addRange(range);
    fireEvent.mouseUp(artifactInput);

    fireEvent.click(screen.getByRole("button", { name: "加粗" }));
    fireEvent.click(screen.getByRole("button", { name: "斜体" }));
    fireEvent.click(screen.getByRole("button", { name: "居中" }));

    expect(artifactInput.innerHTML).toContain("<strong><em>需要保留格式</em></strong>");
    expect(artifactInput.querySelector("p")?.getAttribute("align")).toBe("center");
    expect(screen.getByRole("button", { name: "加粗" }).getAttribute("aria-pressed")).toBe("true");
    expect(screen.getByRole("button", { name: "斜体" }).getAttribute("aria-pressed")).toBe("true");
    expect(screen.getByRole("button", { name: "居中" }).getAttribute("aria-pressed")).toBe("true");
  });

  it("removes inline formatting only from the selected text while preserving selection", () => {
    Object.defineProperty(document, "execCommand", {
      configurable: true,
      value: vi.fn(() => false),
    });
    render(<LearningPage />);
    fireEvent.click(screen.getByRole("button", { name: "文档编辑" }));
    const artifactInput = screen.getByRole("textbox", {
      name: "在这里写下任务理解、计划、执行过程或最终产出。",
    });
    setRichEditorContent(artifactInput, "<p><strong>abcdef</strong></p>");
    const textNode = artifactInput.querySelector("strong")?.firstChild as Text;
    const range = document.createRange();
    range.setStart(textNode, 2);
    range.setEnd(textNode, 4);
    window.getSelection()?.removeAllRanges();
    window.getSelection()?.addRange(range);
    fireEvent.mouseUp(artifactInput);

    expect(screen.getByRole("button", { name: "加粗" }).getAttribute("aria-pressed")).toBe("true");
    fireEvent.click(screen.getByRole("button", { name: "加粗" }));

    expect(artifactInput.innerHTML).toBe("<p><strong>ab</strong>cd<strong>ef</strong></p>");
    expect(window.getSelection()?.toString()).toBe("cd");
    expect(screen.getByRole("button", { name: "加粗" }).getAttribute("aria-pressed")).toBe("false");
  });

  it("applies alignment fallback to every block intersecting the selection", () => {
    Object.defineProperty(document, "execCommand", {
      configurable: true,
      value: vi.fn(() => false),
    });
    render(<LearningPage />);
    fireEvent.click(screen.getByRole("button", { name: "文档编辑" }));
    const artifactInput = screen.getByRole("textbox", {
      name: "在这里写下任务理解、计划、执行过程或最终产出。",
    });
    setRichEditorContent(artifactInput, "<p>第一段</p><p>第二段</p>");
    const paragraphs = artifactInput.querySelectorAll("p");
    const range = document.createRange();
    range.setStart(paragraphs[0].firstChild as Text, 0);
    range.setEnd(paragraphs[1].firstChild as Text, paragraphs[1].textContent?.length ?? 0);
    window.getSelection()?.removeAllRanges();
    window.getSelection()?.addRange(range);
    fireEvent.mouseUp(artifactInput);

    fireEvent.click(screen.getByRole("button", { name: "右对齐" }));

    expect(Array.from(paragraphs).map((paragraph) => paragraph.getAttribute("align"))).toEqual([
      "right",
      "right",
    ]);
    expect(screen.getByRole("button", { name: "右对齐" }).getAttribute("aria-pressed")).toBe("true");
  });

  it("formats H1, H2, and H3 even when the browser command does not mutate the editor", () => {
    const execCommand = vi.fn(() => false);
    Object.defineProperty(document, "execCommand", {
      configurable: true,
      value: execCommand,
    });

    render(<LearningPage />);

    fireEvent.click(screen.getByRole("button", { name: "文档编辑" }));
    const artifactInput = screen.getByRole("textbox", {
      name: "在这里写下任务理解、计划、执行过程或最终产出。",
    });

    [
      ["一级标题", "h1"],
      ["二级标题", "h2"],
      ["三级标题", "h3"],
    ].forEach(([buttonName, tagName]) => {
      setRichEditorContent(artifactInput, "标题内容");
      window.getSelection()?.removeAllRanges();

      fireEvent.click(screen.getByRole("button", { name: buttonName }));

      expect(artifactInput.innerHTML.toLowerCase()).toBe(
        `<${tagName}>标题内容</${tagName}>`,
      );
    });
  });

  it("formats unordered and ordered lists even when the browser command does not mutate the editor", () => {
    const execCommand = vi.fn(() => false);
    Object.defineProperty(document, "execCommand", {
      configurable: true,
      value: execCommand,
    });

    render(<LearningPage />);

    fireEvent.click(screen.getByRole("button", { name: "文档编辑" }));
    const artifactInput = screen.getByRole("textbox", {
      name: "在这里写下任务理解、计划、执行过程或最终产出。",
    });

    [
      ["项目符号", "ul"],
      ["编号列表", "ol"],
    ].forEach(([buttonName, tagName]) => {
      setRichEditorContent(artifactInput, "列表内容");
      window.getSelection()?.removeAllRanges();

      fireEvent.click(screen.getByRole("button", { name: buttonName }));

      expect(artifactInput.innerHTML.toLowerCase()).toBe(
        `<${tagName}><li>列表内容</li></${tagName}>`,
      );
    });
  });

  it("does not replace document input when the initial session load finishes late", async () => {
    const initialSessionResponse = createDeferred<Response>();
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.startsWith("/api/learning/session") && (!init || init.method === "GET")) {
        return initialSessionResponse.promise;
      }
      return Response.json({ ok: true });
    });
    vi.stubGlobal("fetch", fetchMock);

    render(<LearningPage />);
    fireEvent.click(screen.getByRole("button", { name: "文档编辑" }));
    const artifactInput = screen.getByRole("textbox", {
      name: "在这里写下任务理解、计划、执行过程或最终产出。",
    });
    setRichEditorContent(artifactInput, "学习者已经开始输入");

    initialSessionResponse.resolve(Response.json({
      session: createClientSessionFixture("后端较旧的文档内容"),
    }));

    await waitFor(() => {
      expect(getLastResearchEvent("workspace_session_load")?.outcome).toBe("success");
    });
    expect(artifactInput.textContent).toBe("学习者已经开始输入");
  });

  it("hydrates persisted learner session and saves artifacts through the backend", async () => {
    setCsrfCookie();
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.startsWith("/api/learning/session") && (!init || init.method === "GET")) {
        return Response.json({
          session: {
            dataGeneration: 1,
            studentId: "S001",
            activeStage: "training",
            activeTaskId: "training_task_1",
            tasks: [
              {
                taskId: "training_task_1",
                phase: "training",
                status: "active",
                artifactText: "后端保存的训练记录",
                selfReport: "",
                scaffoldRequests: 0,
                scaffoldHistory: [],
              },
            ],
            guideMessages: [],
            events: [],
          },
        });
      }
      if (url === "/api/learning/session" && init?.method === "PATCH") {
        expect(JSON.parse(String(init.body))).toMatchObject({
          action: "save-artifact",
          taskId: "training_task_1",
          artifactText: "新的过程记录",
        });
        return Response.json({
          session: {
            dataGeneration: 1,
            studentId: "S001",
            activeStage: "training",
            activeTaskId: "training_task_1",
            tasks: [
              {
                taskId: "training_task_1",
                phase: "training",
                status: "active",
                artifactText: "新的过程记录",
                selfReport: "",
                scaffoldRequests: 0,
                scaffoldHistory: [],
              },
            ],
            guideMessages: [],
            events: [],
          },
        });
      }
      return Response.json({ ok: true });
    });
    vi.stubGlobal("fetch", fetchMock);
    telemetryMocks.actorGeneration = 51;

    render(<LearningPage />);
    telemetryMocks.actorGeneration = 52;

    fireEvent.click(screen.getByRole("button", { name: "文档编辑" }));
    const artifactInput = await screen.findByLabelText("在这里写下任务理解、计划、执行过程或最终产出。");
    await waitFor(() => {
      expect(artifactInput.textContent).toBe("后端保存的训练记录");
    });
    expect(getLastResearchEvent("workspace_session_load")).toMatchObject({
      actorGeneration: 51,
      outcome: "success",
    });
    setRichEditorContent(artifactInput, "新的过程记录");

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith(
        "/api/learning/session",
        expect.objectContaining({
          method: "PATCH",
          headers: expect.objectContaining({
            "x-aais-csrf": "test-csrf-token",
          }),
        }),
      );
    });
  });

  it("debounces rapid artifact edits before saving only the latest value", async () => {
    setCsrfCookie();
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.startsWith("/api/learning/session") && (!init || init.method === "GET")) {
        return Response.json({
          session: {
            dataGeneration: 1,
            studentId: "S001",
            activeStage: "training",
            activeTaskId: "training_task_1",
            tasks: [
              {
                taskId: "training_task_1",
                phase: "training",
                status: "active",
                artifactText: "",
                selfReport: "",
                scaffoldRequests: 0,
                scaffoldHistory: [],
              },
            ],
            guideMessages: [],
            events: [],
          },
        });
      }
      if (url === "/api/learning/session" && init?.method === "PATCH") {
        const body = JSON.parse(String(init.body)) as {
          artifactText: string;
        };
        return Response.json({
          session: {
            dataGeneration: 1,
            studentId: "S001",
            activeStage: "training",
            activeTaskId: "training_task_1",
            tasks: [
              {
                taskId: "training_task_1",
                phase: "training",
                status: "active",
                artifactText: body.artifactText,
                selfReport: "",
                scaffoldRequests: 0,
                scaffoldHistory: [],
              },
            ],
            guideMessages: [],
            events: [],
          },
        });
      }
      return Response.json({ ok: true });
    });
    vi.stubGlobal("fetch", fetchMock);

    render(<LearningPage />);

    fireEvent.click(screen.getByRole("button", { name: "文档编辑" }));
    const artifactInput = await screen.findByLabelText("在这里写下任务理解、计划、执行过程或最终产出。");
    vi.useFakeTimers();
    setRichEditorContent(artifactInput, "a");
    setRichEditorContent(artifactInput, "ab");
    setRichEditorContent(artifactInput, "abc");

    expect(artifactInput.textContent).toBe("abc");
    expect(getPatchCalls(fetchMock)).toHaveLength(0);

    await act(async () => {
      vi.advanceTimersByTime(650);
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(getPatchCalls(fetchMock)).toHaveLength(1);
    expect(JSON.parse(String(getPatchCalls(fetchMock)[0][1]?.body))).toMatchObject({
      action: "save-artifact",
      taskId: "training_task_1",
      artifactText: "abc",
    });
  });

  it("keeps newer rich text intact and queues its save while an older save is in flight", async () => {
    setCsrfCookie();
    const firstSaveResponse = createDeferred<Response>();
    const secondSaveResponse = createDeferred<Response>();
    let saveRequestCount = 0;
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.startsWith("/api/learning/session") && (!init || init.method === "GET")) {
        return Response.json({ session: createClientSessionFixture("") });
      }
      if (url === "/api/learning/session" && init?.method === "PATCH") {
        saveRequestCount += 1;
        return saveRequestCount === 1
          ? firstSaveResponse.promise
          : secondSaveResponse.promise;
      }
      return Response.json({ ok: true });
    });
    vi.stubGlobal("fetch", fetchMock);
    render(<LearningPage />);
    fireEvent.click(screen.getByRole("button", { name: "文档编辑" }));
    const artifactInput = await screen.findByRole("textbox", {
      name: "在这里写下任务理解、计划、执行过程或最终产出。",
    });
    const firstHtml = "<p><strong>第一版</strong></p>";
    const latestHtml = "<p><strong>第一版</strong><em>，继续输入第二版</em></p>";

    setRichEditorContent(artifactInput, firstHtml);
    fireEvent.blur(artifactInput);
    expect(getPatchCalls(fetchMock)).toHaveLength(1);
    expect(JSON.parse(String(getPatchCalls(fetchMock)[0][1]?.body))).toMatchObject({
      action: "save-artifact",
      artifactText: firstHtml,
      expectedArtifactRevision: 0,
      mutationId: expect.any(String),
    });

    setRichEditorContent(artifactInput, latestHtml);
    fireEvent.blur(artifactInput);
    expect(getPatchCalls(fetchMock)).toHaveLength(1);
    expect(screen.getByRole("status").textContent).toBe("正在保存文档，最新更改已排队。");

    firstSaveResponse.resolve(Response.json({
      session: createClientSessionFixture(firstHtml, [], 1),
    }));

    await waitFor(() => {
      expect(getPatchCalls(fetchMock)).toHaveLength(2);
    });
    expect(artifactInput.innerHTML).toBe(latestHtml);
    expect(JSON.parse(String(getPatchCalls(fetchMock)[1][1]?.body))).toMatchObject({
      action: "save-artifact",
      artifactText: latestHtml,
      expectedArtifactRevision: 1,
      mutationId: expect.any(String),
    });

    secondSaveResponse.resolve(Response.json({
      session: createClientSessionFixture(latestHtml, [], 2),
    }));
    await screen.findByText("文档已保存。");
    expect(artifactInput.innerHTML).toBe(latestHtml);
  });

  it("flushes a pending artifact save when the learner leaves the editor", async () => {
    setCsrfCookie();
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.startsWith("/api/learning/session") && (!init || init.method === "GET")) {
        return Response.json({
          session: {
            dataGeneration: 1,
            studentId: "S001",
            activeStage: "training",
            activeTaskId: "training_task_1",
            tasks: [
              {
                taskId: "training_task_1",
                phase: "training",
                status: "active",
                artifactText: "",
                selfReport: "",
                scaffoldRequests: 0,
                scaffoldHistory: [],
              },
            ],
            guideMessages: [],
            events: [],
          },
        });
      }
      if (url === "/api/learning/session" && init?.method === "PATCH") {
        const body = JSON.parse(String(init.body)) as {
          artifactText: string;
        };
        return Response.json({
          session: {
            dataGeneration: 1,
            studentId: "S001",
            activeStage: "training",
            activeTaskId: "training_task_1",
            tasks: [
              {
                taskId: "training_task_1",
                phase: "training",
                status: "active",
                artifactText: body.artifactText,
                selfReport: "",
                scaffoldRequests: 0,
                scaffoldHistory: [],
              },
            ],
            guideMessages: [],
            events: [],
          },
        });
      }
      return Response.json({ ok: true });
    });
    vi.stubGlobal("fetch", fetchMock);

    render(<LearningPage />);

    fireEvent.click(screen.getByRole("button", { name: "文档编辑" }));
    const artifactInput = await screen.findByLabelText("在这里写下任务理解、计划、执行过程或最终产出。");
    vi.useFakeTimers();
    setRichEditorContent(artifactInput, "离开前的最后过程记录");
    expect(getPatchCalls(fetchMock)).toHaveLength(0);

    await act(async () => {
      fireEvent.blur(artifactInput);
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(getPatchCalls(fetchMock)).toHaveLength(1);
    expect(JSON.parse(String(getPatchCalls(fetchMock)[0][1]?.body))).toMatchObject({
      action: "save-artifact",
      taskId: "training_task_1",
      artifactText: "离开前的最后过程记录",
    });

    await act(async () => {
      vi.advanceTimersByTime(650);
      await Promise.resolve();
    });
    expect(getPatchCalls(fetchMock)).toHaveLength(1);
  });

  it("flushes a pending artifact save and archives the editor document as a blue history folder", async () => {
    setCsrfCookie();
    let persistedHistory: Array<{
      id: string;
      taskId: string;
      title: string;
      html: string;
      savedAt: string;
    }> = [];
    let artifactRevision = 0;
    const showSaveFilePicker = vi.fn(async () => ({
      createWritable: vi.fn(),
    }));
    Object.defineProperty(window, "showSaveFilePicker", {
      configurable: true,
      value: showSaveFilePicker,
    });

    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.startsWith("/api/learning/session") && (!init || init.method === "GET")) {
        return Response.json({
          session: createClientSessionFixture("", persistedHistory, artifactRevision),
        });
      }
      if (url === "/api/learning/session" && init?.method === "PATCH") {
        const body = JSON.parse(String(init.body)) as {
          action: string;
          activeDocumentId?: string | null;
          document: (typeof persistedHistory)[number];
          expectedArtifactRevision: number;
          mutationId: string;
        };
        expect(body.action).toBe("archive-artifact");
        const activeDocument = body.activeDocumentId
          ? persistedHistory.find((document) => document.id === body.activeDocumentId)
          : null;
        persistedHistory = activeDocument
          ? persistedHistory.map((document) => document.id === activeDocument.id
            ? { ...body.document, id: activeDocument.id }
            : document)
          : [body.document, ...persistedHistory];
        artifactRevision += 1;
        return Response.json({
          session: createClientSessionFixture("", persistedHistory, artifactRevision),
        });
      }
      return Response.json({ ok: true });
    });
    vi.stubGlobal("fetch", fetchMock);

    render(<LearningPage />);

    fireEvent.click(screen.getByRole("button", { name: "文档编辑" }));
    fireEvent.change(screen.getByLabelText("文档标题"), {
      target: {
        value: "学习计划",
      },
    });
    const artifactInput = await screen.findByLabelText("在这里写下任务理解、计划、执行过程或最终产出。");
    const richDocumentHtml = "<h1>学习计划</h1><ul><li>先复述任务</li></ul><p><strong>重点记录</strong></p>";
    setRichEditorContent(artifactInput, richDocumentHtml);
    expect(getPatchCalls(fetchMock)).toHaveLength(0);
    fireEvent.click(screen.getByRole("button", { name: "保存并关闭" }));

    await waitFor(() => {
      expect(getPatchCalls(fetchMock)).toHaveLength(1);
    });
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/learning/session",
      expect.objectContaining({
        method: "PATCH",
        headers: expect.objectContaining({
          "x-aais-csrf": "test-csrf-token",
        }),
      }),
    );
    expect(JSON.parse(String(getPatchCalls(fetchMock)[0][1]?.body))).toMatchObject({
      action: "archive-artifact",
      taskId: "training_task_1",
      expectedArtifactRevision: 0,
      mutationId: expect.any(String),
      document: {
        title: "学习计划",
        html: richDocumentHtml,
      },
    });
    expect(showSaveFilePicker).not.toHaveBeenCalled();
    expect(screen.queryByLabelText("在这里写下任务理解、计划、执行过程或最终产出。")).toBeNull();
    expect(screen.getByRole("button", { name: "返回内容展示" })).toBeTruthy();
    const historyFolder = screen.getByRole("button", { name: "历史文档文件夹：学习计划" });
    expect(historyFolder).toBeTruthy();
    expect(historyFolder.querySelector('[data-history-folder="icon"]')?.className).toContain(
      "from-[#68d4ff]",
    );
    expect(screen.getByText("刚刚保存")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "文档编辑" }));
    expect((screen.getByLabelText("文档标题") as HTMLInputElement).value).toBe("");
    expect(screen.getByLabelText("在这里写下任务理解、计划、执行过程或最终产出。").innerHTML)
      .toBe("");
    fireEvent.click(screen.getByRole("button", { name: "内容展示" }));
    fireEvent.click(screen.getByRole("button", { name: "历史文档" }));

    fireEvent.click(screen.getByRole("button", { name: "历史文档文件夹：学习计划" }));
    const reopenedDocument = screen.getByLabelText("在这里写下任务理解、计划、执行过程或最终产出。");
    expect(reopenedDocument.innerHTML).toContain("<strong>重点记录</strong>");

    fireEvent.change(screen.getByLabelText("文档标题"), {
      target: {
        value: "最终学习计划",
      },
    });
    fireEvent.click(screen.getByRole("button", { name: "保存并关闭" }));

    await waitFor(() => expect(getPatchCalls(fetchMock)).toHaveLength(2));
    expect(JSON.parse(String(getPatchCalls(fetchMock)[1][1]?.body))).toMatchObject({
      action: "archive-artifact",
      taskId: "training_task_1",
      expectedArtifactRevision: 1,
      mutationId: expect.any(String),
    });

    const renamedHistoryFolder = await screen.findByRole("button", {
      name: "历史文档文件夹：最终学习计划",
    });
    expect(screen.queryByRole("button", { name: "历史文档文件夹：学习计划" })).toBeNull();
    expect(screen.getAllByRole("button", { name: /^历史文档文件夹：/ })).toHaveLength(1);
    fireEvent.click(renamedHistoryFolder);
    expect((screen.getByLabelText("文档标题") as HTMLInputElement).value).toBe("最终学习计划");
    expect(screen.getByLabelText("在这里写下任务理解、计划、执行过程或最终产出。").innerHTML)
      .toContain("<strong>重点记录</strong>");
  });

  it("retries a response-lost archive once with one mutation id and one caller revision", async () => {
    setCsrfCookie();
    const patchBodies: Array<Record<string, unknown>> = [];
    const archivedHistory: Array<{
      id: string;
      taskId: string;
      title: string;
      html: string;
      savedAt: string;
    }> = [];
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.startsWith("/api/learning/session") && (!init || init.method === "GET")) {
        return Response.json({
          session: createClientSessionFixture("<p>已提交但响应可能丢失</p>", [], 3),
        });
      }
      if (url === "/api/learning/session" && init?.method === "PATCH") {
        const body = JSON.parse(String(init.body)) as Record<string, unknown>;
        patchBodies.push(body);
        if (patchBodies.length === 1) {
          throw new TypeError("archive response disconnected");
        }
        archivedHistory.push(body.document as (typeof archivedHistory)[number]);
        return Response.json({
          session: createClientSessionFixture("", archivedHistory, 4),
        });
      }
      return Response.json({ ok: true });
    });
    vi.stubGlobal("fetch", fetchMock);
    render(<LearningPage />);

    fireEvent.click(screen.getByRole("button", { name: "文档编辑" }));
    const editor = await screen.findByLabelText(
      "在这里写下任务理解、计划、执行过程或最终产出。",
    );
    await waitFor(() => expect(editor.innerHTML).toContain("已提交但响应可能丢失"));
    fireEvent.change(screen.getByLabelText("文档标题"), {
      target: { value: "响应丢失归档" },
    });
    fireEvent.click(screen.getByRole("button", { name: "保存并关闭" }));

    await waitFor(() => expect(patchBodies).toHaveLength(2));
    expect(patchBodies[0]).toMatchObject({
      action: "archive-artifact",
      expectedArtifactRevision: 3,
      mutationId: expect.any(String),
    });
    expect(patchBodies[1]).toEqual(patchBodies[0]);
    expect(await screen.findByRole("button", {
      name: "历史文档文件夹：响应丢失归档",
    })).toBeTruthy();
    expect(window.sessionStorage.getItem("aais_artifact_draft_v1:Bobie")).toBeNull();
  });

  it("does not turn a stale archive conflict into an automatic full-document overwrite", async () => {
    setCsrfCookie();
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.startsWith("/api/learning/session") && (!init || init.method === "GET")) {
        return Response.json({ session: createClientSessionFixture("", [], 0) });
      }
      if (url === "/api/learning/session" && init?.method === "PATCH") {
        return Response.json({
          error: {
            code: "AAIS_ARTIFACT_REVISION_CONFLICT",
            message: "AAIS artifact changed after this edit started. Reload before saving again.",
          },
        }, { status: 409 });
      }
      return Response.json({ ok: true });
    });
    vi.stubGlobal("fetch", fetchMock);
    render(<LearningPage />);

    fireEvent.click(screen.getByRole("button", { name: "文档编辑" }));
    const editor = await screen.findByLabelText(
      "在这里写下任务理解、计划、执行过程或最终产出。",
    );
    setRichEditorContent(editor, "迟到标签页不得覆盖的新旧整稿");
    fireEvent.change(screen.getByLabelText("文档标题"), {
      target: { value: "冲突草稿" },
    });
    fireEvent.click(screen.getByRole("button", { name: "保存并关闭" }));

    await waitFor(() => expect(getPatchCalls(fetchMock)).toHaveLength(1));
    expect(JSON.parse(String(getPatchCalls(fetchMock)[0]?.[1]?.body))).toMatchObject({
      action: "archive-artifact",
      expectedArtifactRevision: 0,
      mutationId: expect.any(String),
    });
    expect(await screen.findByText("文档未能归档，工作区内容已保留。"))
      .toBeTruthy();
    await new Promise((resolve) => setTimeout(resolve, 800));
    expect(getPatchCalls(fetchMock)).toHaveLength(1);
    expect(editor.innerHTML).toBe("迟到标签页不得覆盖的新旧整稿");
    expect(window.sessionStorage.getItem("aais_artifact_draft_v1:Bobie"))
      .toContain("迟到标签页不得覆盖的新旧整稿");
  });

  it("keeps a closed document in durable history after reload while clearing only its working copy", async () => {
    setCsrfCookie();
    let persistedArtifact = "<h1>管理者记录</h1><p><strong>管理者遗留的文档编辑记录</strong></p><img alt=\"测试截图\" src=\"data:image/png;base64,QUFJUw==\">";
    let persistedHistory: Array<{
      id: string;
      taskId: string;
      title: string;
      html: string;
      savedAt: string;
    }> = [];
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.startsWith("/api/learning/session") && (!init || init.method === "GET")) {
        return Response.json({
          session: createClientSessionFixture(persistedArtifact, persistedHistory),
        });
      }
      if (url === "/api/learning/session" && init?.method === "PATCH") {
        const body = JSON.parse(String(init.body)) as {
          action: string;
          document?: (typeof persistedHistory)[number];
        };
        expect(body.action).toBe("archive-artifact");
        persistedHistory = body.document ? [body.document] : [];
        persistedArtifact = "";
        return Response.json({
          session: createClientSessionFixture(persistedArtifact, persistedHistory),
        });
      }
      return Response.json({ ok: true });
    });
    vi.stubGlobal("fetch", fetchMock);

    const firstView = render(<LearningPage />);
    fireEvent.click(screen.getByRole("button", { name: "文档编辑" }));
    const firstEditor = await screen.findByLabelText("在这里写下任务理解、计划、执行过程或最终产出。");
    await waitFor(() => expect(firstEditor.innerHTML).toContain("管理者遗留的文档编辑记录"));
    fireEvent.change(screen.getByLabelText("文档标题"), {
      target: { value: "管理者测试记录" },
    });
    fireEvent.click(screen.getByRole("button", { name: "保存并关闭" }));
    await waitFor(() => expect(persistedArtifact).toBe(""));
    expect(persistedHistory).toHaveLength(1);

    firstView.unmount();
    render(<LearningPage />);
    fireEvent.click(screen.getByRole("button", { name: "文档编辑" }));
    const reloadedEditor = await screen.findByLabelText("在这里写下任务理解、计划、执行过程或最终产出。");
    await waitFor(() => expect(reloadedEditor.innerHTML).toBe(""));
    fireEvent.click(screen.getByRole("button", { name: "内容展示" }));
    fireEvent.click(screen.getByRole("button", { name: "历史文档" }));
    const historyFolder = await screen.findByRole("button", {
      name: "历史文档文件夹：管理者测试记录",
    });
    fireEvent.click(historyFolder);
    expect((screen.getByLabelText("文档标题") as HTMLInputElement).value)
      .toBe("管理者测试记录");
    expect(screen.getByLabelText("在这里写下任务理解、计划、执行过程或最终产出。").innerHTML)
      .toContain("管理者遗留的文档编辑记录");
    expect(screen.getByLabelText("在这里写下任务理解、计划、执行过程或最终产出。").innerHTML)
      .toContain("<strong>");
    expect(screen.getByLabelText("在这里写下任务理解、计划、执行过程或最终产出。").innerHTML)
      .toContain("data:image/png;base64,QUFJUw==");
  });

  it("keeps history document identity when tabbing away and back before re-archiving", async () => {
    setCsrfCookie();
    const persistedHistory = [{
      id: "history-stable-id",
      taskId: "training_task_1",
      title: "原历史记录",
      html: "<p>保持同一个历史文档</p>",
      savedAt: "2026-08-19T00:00:00.000Z",
    }];
    let archivedBody: Record<string, unknown> | null = null;
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.startsWith("/api/learning/session") && (!init || init.method === "GET")) {
        return Response.json({ session: createClientSessionFixture("", persistedHistory) });
      }
      if (url === "/api/learning/session" && init?.method === "PATCH") {
        archivedBody = JSON.parse(String(init.body));
        return Response.json({ session: createClientSessionFixture("", persistedHistory) });
      }
      return Response.json({ ok: true });
    });
    vi.stubGlobal("fetch", fetchMock);
    render(<LearningPage />);

    fireEvent.click(screen.getByRole("button", { name: "历史文档" }));
    fireEvent.click(await screen.findByRole("button", { name: "历史文档文件夹：原历史记录" }));
    fireEvent.click(screen.getByRole("button", { name: "内容展示" }));
    fireEvent.click(screen.getByRole("button", { name: "文档编辑" }));
    fireEvent.change(screen.getByLabelText("文档标题"), { target: { value: "更新后的历史记录" } });
    fireEvent.click(screen.getByRole("button", { name: "保存并关闭" }));

    await waitFor(() => expect(archivedBody).not.toBeNull());
    expect(archivedBody).toMatchObject({
      action: "archive-artifact",
      activeDocumentId: "history-stable-id",
      document: { title: "更新后的历史记录" },
    });
  });

  it("keeps a history document bound to its source task while another task stays active", async () => {
    setCsrfCookie();
    const write = vi.fn(async () => undefined);
    const close = vi.fn(async () => undefined);
    const showSaveFilePicker = vi.fn(async () => ({
      createWritable: vi.fn(async () => ({ write, close })),
    }));
    Object.defineProperty(window, "showSaveFilePicker", {
      configurable: true,
      value: showSaveFilePicker,
    });
    let persistedHistory = [{
      id: "history-task-one",
      taskId: "training_task_1",
      title: "任务一历史记录",
      html: "<p>任务一原始内容</p>",
      savedAt: "2026-08-19T00:00:00.000Z",
    }];
    let taskOneArtifactRevision = 7;
    const patchBodies: Array<Record<string, unknown>> = [];
    const createCrossTaskSession = () => ({
      dataGeneration: 1,
      studentId: "S001",
      activeStage: "training",
      activeTaskId: "training_task_2",
      tasks: [
        {
          taskId: "training_task_1",
          phase: "training",
          status: "completed",
          artifactText: "",
          artifactRevision: taskOneArtifactRevision,
          documentTitle: "",
          activeDocumentId: null,
          selfReport: "",
          selfReportRevision: 0,
          scaffoldRequests: 0,
          scaffoldHistory: [],
        },
        {
          taskId: "training_task_2",
          phase: "training",
          status: "active",
          artifactText: "",
          artifactRevision: 2,
          documentTitle: "",
          activeDocumentId: null,
          selfReport: "",
          selfReportRevision: 0,
          scaffoldRequests: 0,
          scaffoldHistory: [],
        },
      ],
      historyDocuments: persistedHistory,
      guideMessages: [],
      events: [],
    });
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.startsWith("/api/learning/session") && (!init || init.method === "GET")) {
        return Response.json({ session: createCrossTaskSession() });
      }
      if (url === "/api/learning/session" && init?.method === "PATCH") {
        const body = JSON.parse(String(init.body)) as Record<string, unknown>;
        patchBodies.push(body);
        if (body.taskId === "training_task_1") {
          taskOneArtifactRevision += 1;
        }
        if (body.action === "archive-artifact") {
          const document = body.document as (typeof persistedHistory)[number];
          persistedHistory = [{
            ...document,
            id: "history-task-one",
            taskId: "training_task_1",
          }];
        }
        return Response.json({ session: createCrossTaskSession() });
      }
      if (url === "/api/learning/ai-guide" && init?.method === "POST") {
        return Response.json({
          message: { text: "任务一指导回复" },
          turns: [{
            agentId: "A1",
            label: "小张",
            content: "任务一指导回复",
            actions: ["guide-flow"],
          }],
        });
      }
      return Response.json({ ok: true });
    });
    vi.stubGlobal("fetch", fetchMock);
    render(<LearningPage />);

    fireEvent.click(screen.getByRole("button", { name: "历史文档" }));
    fireEvent.click(await screen.findByRole("button", {
      name: "历史文档文件夹：任务一历史记录",
    }));

    fireEvent.change(screen.getByLabelText("向智能导学输入你的想法"), {
      target: { value: "请检查这份任务一历史文档" },
    });
    fireEvent.click(screen.getByRole("button", { name: "发送" }));

    await screen.findByText("任务一指导回复");
    const guideCall = fetchMock.mock.calls.find(([input, init]) =>
      String(input) === "/api/learning/ai-guide" && init?.method === "POST"
    );
    expect(JSON.parse(String(guideCall?.[1]?.body))).toMatchObject({
      taskId: "training_task_1",
      workspaceState: {
        artifactText: "<p>任务一原始内容</p>",
      },
    });
    expect(getLastResearchEvent("ai_guide_submit")).toMatchObject({
      detail: expect.objectContaining({ task_id: "training_task_1" }),
    });

    fireEvent.click(screen.getByRole("button", { name: "下载到本地" }));
    await waitFor(() => expect(showSaveFilePicker).toHaveBeenCalledWith(expect.objectContaining({
      suggestedName: "aais-training_task_1-document.md",
    })));
    expect(getLastResearchEvent("document_download")).toMatchObject({
      detail: expect.objectContaining({ task_id: "training_task_1" }),
    });

    fireEvent.change(screen.getByLabelText("文档标题"), {
      target: { value: "任务一更新记录" },
    });

    await waitFor(() => expect(patchBodies).toHaveLength(1), { timeout: 2_000 });
    expect(patchBodies[0]).toMatchObject({
      action: "save-artifact",
      activeDocumentId: "history-task-one",
      documentTitle: "任务一更新记录",
      expectedArtifactRevision: 7,
      taskId: "training_task_1",
    });

    const editor = screen.getByLabelText("在这里写下任务理解、计划、执行过程或最终产出。");
    setRichEditorContent(editor, "<p>任务一更新内容</p>");

    await waitFor(() => expect(patchBodies).toHaveLength(2), { timeout: 2_000 });
    expect(patchBodies[1]).toMatchObject({
      action: "save-artifact",
      activeDocumentId: "history-task-one",
      artifactText: "<p>任务一更新内容</p>",
      expectedArtifactRevision: 8,
      taskId: "training_task_1",
    });

    fireEvent.click(screen.getByRole("button", { name: "保存并关闭" }));

    await waitFor(() => expect(patchBodies).toHaveLength(3));
    expect(patchBodies[2]).toMatchObject({
      action: "archive-artifact",
      activeDocumentId: "history-task-one",
      expectedArtifactRevision: 9,
      mutationId: expect.any(String),
      taskId: "training_task_1",
      document: {
        id: "history-task-one",
        taskId: "training_task_1",
        title: "任务一更新记录",
        html: "<p>任务一更新内容</p>",
      },
    });
    expect(await screen.findByRole("button", {
      name: "历史文档文件夹：任务一更新记录",
    })).toBeTruthy();
    expect(screen.getAllByRole("button", { name: /^历史文档文件夹：/ })).toHaveLength(1);
  });

  it("refuses history navigation while a failed autosave still owns the single draft journal", async () => {
    setCsrfCookie();
    const firstSave = createDeferred<Response>();
    const retrySave = createDeferred<Response>();
    const historyDocuments = [
      {
        id: "history-a",
        taskId: "training_task_1",
        title: "文档 A",
        html: "<p>文档 A 原文</p>",
        savedAt: "2026-08-19T00:00:00.000Z",
      },
      {
        id: "history-b",
        taskId: "training_task_1",
        title: "文档 B",
        html: "<p>文档 B 原文</p>",
        savedAt: "2026-08-19T01:00:00.000Z",
      },
    ];
    let patchCount = 0;
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.startsWith("/api/learning/session") && (!init || init.method === "GET")) {
        return Response.json({ session: createClientSessionFixture("", historyDocuments) });
      }
      if (url === "/api/learning/session" && init?.method === "PATCH") {
        patchCount += 1;
        return patchCount === 1 ? firstSave.promise : retrySave.promise;
      }
      return Response.json({ ok: true });
    });
    vi.stubGlobal("fetch", fetchMock);
    render(<LearningPage />);

    fireEvent.click(screen.getByRole("button", { name: "历史文档" }));
    fireEvent.click(await screen.findByRole("button", {
      name: "历史文档文件夹：文档 A",
    }));
    const editor = screen.getByLabelText(
      "在这里写下任务理解、计划、执行过程或最终产出。",
    );
    setRichEditorContent(editor, "<p>文档 A 尚未持久化的修改</p>");
    fireEvent.blur(editor);
    await waitFor(() => expect(getPatchCalls(fetchMock)).toHaveLength(1));

    firstSave.resolve(Response.json({ error: "invalid" }, { status: 400 }));
    expect(await screen.findAllByText("任务过程记录未能保存到后端。"))
      .not.toHaveLength(0);
    expect(window.sessionStorage.getItem("aais_artifact_draft_v1:Bobie"))
      .toContain("文档 A 尚未持久化的修改");

    fireEvent.click(screen.getByRole("button", { name: "内容展示" }));

    // If the tab transition leaks through, follow the exact destructive path:
    // open B and type into it. The regression used to replace A in the one-slot
    // recovery journal at this point.
    const exposedHistoryEntry = screen.queryByRole("button", { name: "历史文档" });
    if (exposedHistoryEntry) {
      fireEvent.click(exposedHistoryEntry);
      fireEvent.click(screen.getByRole("button", {
        name: "历史文档文件夹：文档 B",
      }));
      setRichEditorContent(screen.getByLabelText(
        "在这里写下任务理解、计划、执行过程或最终产出。",
      ), "<p>文档 B 不得覆盖 A 的恢复槽</p>");
    }

    expect(getPatchCalls(fetchMock)).toHaveLength(2);
    expect(screen.queryByRole("button", { name: "历史文档文件夹：文档 B" })).toBeNull();
    expect((screen.getByLabelText("文档标题") as HTMLInputElement).value).toBe("文档 A");
    expect(screen.getByLabelText(
      "在这里写下任务理解、计划、执行过程或最终产出。",
    ).innerHTML).toBe("<p>文档 A 尚未持久化的修改</p>");
    expect(window.sessionStorage.getItem("aais_artifact_draft_v1:Bobie"))
      .toContain("文档 A 尚未持久化的修改");
    expect(window.sessionStorage.getItem("aais_artifact_draft_v1:Bobie"))
      .not.toContain("文档 B 原文");
  });

  it("keeps the editor title and content intact when durable archiving fails", async () => {
    setCsrfCookie();
    const persistedArtifact = "<p>归档失败也不能丢失</p>";
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.startsWith("/api/learning/session") && (!init || init.method === "GET")) {
        return Response.json({ session: createClientSessionFixture(persistedArtifact) });
      }
      if (url === "/api/learning/session" && init?.method === "PATCH") {
        return Response.json({
          error: {
            code: "AAIS_SESSION_ARCHIVE_FAILED",
            message: "Archive failed.",
          },
        }, { status: 503 });
      }
      return Response.json({ ok: true });
    });
    vi.stubGlobal("fetch", fetchMock);

    render(<LearningPage />);
    fireEvent.click(screen.getByRole("button", { name: "文档编辑" }));
    const editor = await screen.findByLabelText("在这里写下任务理解、计划、执行过程或最终产出。");
    await waitFor(() => expect(editor.innerHTML).toContain("归档失败也不能丢失"));
    fireEvent.change(screen.getByLabelText("文档标题"), {
      target: { value: "不能丢失的标题" },
    });
    fireEvent.click(screen.getByRole("button", { name: "保存并关闭" }));

    expect((await screen.findByRole("alert")).textContent)
      .toBe("文档未能归档，工作区内容已保留。");
    expect((screen.getByLabelText("文档标题") as HTMLInputElement).value)
      .toBe("不能丢失的标题");
    expect(editor.innerHTML).toContain("归档失败也不能丢失");
    expect(screen.queryByRole("button", { name: /^历史文档文件夹：/ })).toBeNull();
  });

  it("does not emit research events from guide, title, or document keystroke-level changes", () => {
    vi.stubGlobal("fetch", vi.fn(() => new Promise<Response>(() => undefined)));
    render(<LearningPage />);

    fireEvent.click(screen.getByRole("button", { name: "文档编辑" }));
    telemetryMocks.record.mockClear();
    fireEvent.change(screen.getByLabelText("向智能导学输入你的想法"), {
      target: { value: "未提交的导学草稿" },
    });
    fireEvent.change(screen.getByLabelText("文档标题"), {
      target: { value: "尚未提交的标题" },
    });
    const editor = screen.getByLabelText("在这里写下任务理解、计划、执行过程或最终产出。");
    editor.innerHTML = "<p>逐键击不应上报</p>";
    fireEvent.input(editor);
    fireEvent.keyUp(editor, { key: "入" });

    expect(telemetryMocks.record).not.toHaveBeenCalled();
  });

  it("admits AI work before fetch and preserves retry plus success with one operation id", async () => {
    setCsrfCookie();
    let guideAttempts = 0;
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.startsWith("/api/learning/session") && (!init || init.method === "GET")) {
        return Response.json({ session: createClientSessionFixture("") });
      }
      if (url === "/api/learning/ai-guide" && init?.method === "POST") {
        guideAttempts += 1;
        if (guideAttempts === 1) {
          return Response.json({});
        }
        return Response.json({
          message: { text: "AAIS 智能体已回复。" },
          turns: [{
            agentId: "A1",
            label: "导学智能体",
            content: "已完成重试。",
            actions: ["respond"],
          }],
          orchestration: {
            runtime: {
              timings: { fallback: false },
            },
          },
        });
      }
      return Response.json({ ok: true });
    });
    vi.stubGlobal("fetch", fetchMock);
    render(<LearningPage />);
    await screen.findByRole("button", { name: "发送" });
    telemetryMocks.record.mockClear();
    telemetryMocks.actorGeneration = 61;

    const rawQuestion = "这段原始问题不应进入遥测 detail";
    fireEvent.change(screen.getByLabelText("向智能导学输入你的想法"), {
      target: { value: rawQuestion },
    });
    fireEvent.click(screen.getByRole("button", { name: "发送" }));
    telemetryMocks.actorGeneration = 62;

    expect(await screen.findByText("已完成重试。")).toBeTruthy();
    const attemptedEvent = telemetryMocks.admit.mock.calls
      .map(([event]) => event)
      .find((event) => event.eventName === "ai_guide_submit")!;
    const aiEvents = telemetryMocks.record.mock.calls
      .map(([event]) => event)
      .filter((event) => event.eventName === "ai_guide_submit");
    expect(attemptedEvent).toMatchObject({
      actorGeneration: 61,
      outcome: "attempted",
    });
    expect(aiEvents).toHaveLength(3);
    expect(aiEvents[0]).toMatchObject({
      actorGeneration: 61,
      outcome: "attempted",
    });
    expect(aiEvents[1]).toMatchObject({
      actorGeneration: 61,
      outcome: "retry",
      detail: {
        attempt_number: 2,
        retry_reason: "stream_protocol_fallback",
      },
    });
    expect(aiEvents[2]).toMatchObject({
      actorGeneration: 61,
      outcome: "success",
      detail: {
        attempt_number: 2,
        retry_reason: "stream_protocol_fallback",
      },
    });
    expect(aiEvents[2].latencyMs).toEqual(expect.any(Number));
    expect(attemptedEvent.detail.operation_id).toBe(aiEvents[0].detail.operation_id);
    expect(aiEvents[0].detail.operation_id).toBe(aiEvents[1].detail.operation_id);
    expect(aiEvents[1].detail.operation_id).toBe(aiEvents[2].detail.operation_id);
    expect(JSON.stringify([attemptedEvent, ...aiEvents])).not.toContain(rawQuestion);
    expect(attemptedEvent.detail.prompt_length).toBe(rawQuestion.length);
  });

  it("does not mutate the guide transcript or call AI when admission is rejected", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input).startsWith("/api/learning/session") && (!init || init.method === "GET")) {
        return Response.json({ session: createClientSessionFixture("") });
      }
      return Response.json({ ok: true });
    });
    vi.stubGlobal("fetch", fetchMock);
    render(<LearningPage />);
    const guideInput = await screen.findByLabelText("向智能导学输入你的想法");
    telemetryMocks.admit.mockImplementation((event) => event.eventName !== "ai_guide_submit");

    fireEvent.change(guideInput, { target: { value: "不应发送的原始文本" } });
    fireEvent.click(screen.getByRole("button", { name: "发送" }));

    expect(fetchMock.mock.calls.some(([input, init]) =>
      String(input) === "/api/learning/ai-guide" && init?.method === "POST"
    )).toBe(false);
    expect((guideInput as HTMLInputElement).value).toBe("不应发送的原始文本");
    expect(screen.queryByText("不应发送的原始文本", { selector: "p" })).toBeNull();
    expect(JSON.stringify(telemetryMocks.admit.mock.calls)).not.toContain("不应发送的原始文本");
  });

  it("retries a transient autosave once with one stable mutation id", async () => {
    setCsrfCookie();
    let attempts = 0;
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.startsWith("/api/learning/session") && (!init || init.method === "GET")) {
        return Response.json({ session: createClientSessionFixture("") });
      }
      if (url === "/api/learning/session" && init?.method === "PATCH") {
        attempts += 1;
        return attempts === 1
          ? Response.json({ error: "temporary" }, { status: 503 })
          : Response.json({ session: createClientSessionFixture("可恢复保存") });
      }
      return Response.json({ ok: true });
    });
    vi.stubGlobal("fetch", fetchMock);
    render(<LearningPage />);

    fireEvent.click(screen.getByRole("button", { name: "文档编辑" }));
    const editor = await screen.findByLabelText("在这里写下任务理解、计划、执行过程或最终产出。");
    setRichEditorContent(editor, "可恢复保存");
    fireEvent.blur(editor);

    await waitFor(() => expect(getPatchCalls(fetchMock)).toHaveLength(2));
    const bodies = getPatchCalls(fetchMock).map(([, init]) => JSON.parse(String(init?.body)));
    expect(bodies[0].mutationId).toEqual(expect.any(String));
    expect(bodies[1].mutationId).toBe(bodies[0].mutationId);
    expect(bodies[1].artifactText).toBe("可恢复保存");
    expect(await screen.findByText("文档已保存。")).toBeTruthy();
  });

  it("does not retry a rejected 4xx autosave", async () => {
    setCsrfCookie();
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.startsWith("/api/learning/session") && (!init || init.method === "GET")) {
        return Response.json({ session: createClientSessionFixture("") });
      }
      if (url === "/api/learning/session" && init?.method === "PATCH") {
        return Response.json({ error: "invalid" }, { status: 400 });
      }
      return Response.json({ ok: true });
    });
    vi.stubGlobal("fetch", fetchMock);
    render(<LearningPage />);

    fireEvent.click(screen.getByRole("button", { name: "文档编辑" }));
    const editor = await screen.findByLabelText("在这里写下任务理解、计划、执行过程或最终产出。");
    setRichEditorContent(editor, "服务端拒绝的保存");
    fireEvent.blur(editor);

    expect(await screen.findAllByText("任务过程记录未能保存到后端。")).not.toHaveLength(0);
    expect(getPatchCalls(fetchMock)).toHaveLength(1);
    expect(window.sessionStorage.getItem("aais_artifact_draft_v1:Bobie"))
      .toContain("服务端拒绝的保存");
    fireEvent.blur(editor);
    await waitFor(() => expect(getPatchCalls(fetchMock)).toHaveLength(2));
  });

  it("keeps a stale restored journal for recovery without overwriting a newer server draft", async () => {
    setCsrfCookie();
    window.sessionStorage.setItem("aais_artifact_draft_v1:Bobie", JSON.stringify({
      expectedArtifactRevision: 0,
      mutationId: "stale-restored-journal-mutation",
      revision: 1,
      taskId: "training_task_1",
      title: "旧标签页草稿",
      value: "旧标签页迟到正文",
    }));
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.startsWith("/api/learning/session") && (!init || init.method === "GET")) {
        return Response.json({
          session: createClientSessionFixture("新标签页已保存正文", [], 1),
        });
      }
      if (url === "/api/learning/session" && init?.method === "PATCH") {
        return Response.json({
          error: {
            code: "AAIS_ARTIFACT_REVISION_CONFLICT",
            message: "AAIS artifact changed after this edit started. Reload before saving again.",
          },
        }, { status: 409 });
      }
      return Response.json({ ok: true });
    });
    vi.stubGlobal("fetch", fetchMock);

    render(<LearningPage />);

    await waitFor(() => expect(getPatchCalls(fetchMock)).toHaveLength(1), { timeout: 2_000 });
    expect(JSON.parse(String(getPatchCalls(fetchMock)[0]?.[1]?.body))).toMatchObject({
      action: "save-artifact",
      artifactText: "旧标签页迟到正文",
      expectedArtifactRevision: 0,
      mutationId: "stale-restored-journal-mutation",
    });
    expect(await screen.findAllByText("任务过程记录未能保存到后端。"))
      .not.toHaveLength(0);
    await new Promise((resolve) => setTimeout(resolve, 800));
    expect(getPatchCalls(fetchMock)).toHaveLength(1);
    expect(window.sessionStorage.getItem("aais_artifact_draft_v1:Bobie"))
      .toContain("旧标签页迟到正文");
    fireEvent.click(screen.getByRole("button", { name: "文档编辑" }));
    expect((await screen.findByLabelText("文档标题") as HTMLInputElement).value)
      .toBe("旧标签页草稿");
    expect((await screen.findByLabelText(
      "在这里写下任务理解、计划、执行过程或最终产出。",
    )).innerHTML).toBe("旧标签页迟到正文");
  });

  it("discards a failed older autosave and sends the newest pending value", async () => {
    setCsrfCookie();
    const firstSave = createDeferred<Response>();
    let patchCount = 0;
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.startsWith("/api/learning/session") && (!init || init.method === "GET")) {
        return Response.json({ session: createClientSessionFixture("") });
      }
      if (url === "/api/learning/session" && init?.method === "PATCH") {
        patchCount += 1;
        return patchCount === 1
          ? firstSave.promise
          : Response.json({ session: createClientSessionFixture("最新版本") });
      }
      return Response.json({ ok: true });
    });
    vi.stubGlobal("fetch", fetchMock);
    render(<LearningPage />);

    fireEvent.click(screen.getByRole("button", { name: "文档编辑" }));
    const editor = await screen.findByLabelText("在这里写下任务理解、计划、执行过程或最终产出。");
    setRichEditorContent(editor, "旧版本");
    fireEvent.blur(editor);
    setRichEditorContent(editor, "最新版本");
    fireEvent.blur(editor);
    firstSave.reject(new TypeError("network disconnected"));

    await waitFor(() => expect(getPatchCalls(fetchMock)).toHaveLength(2));
    const bodies = getPatchCalls(fetchMock).map(([, init]) => JSON.parse(String(init?.body)));
    expect(bodies.map((body) => body.artifactText)).toEqual(["旧版本", "最新版本"]);
    expect(bodies[1].mutationId).not.toBe(bodies[0].mutationId);
    expect(editor.innerHTML).toBe("最新版本");
    expect(await screen.findByText("文档已保存。")).toBeTruthy();
  });

  it("restores an ordinary quick-unload journal but never writes raw research text", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input).startsWith("/api/learning/session") && (!init || init.method === "GET")) {
        return Response.json({ session: createClientSessionFixture("") });
      }
      if (String(input) === "/api/learning/session" && init?.method === "PATCH") {
        const body = JSON.parse(String(init.body)) as { artifactText?: string };
        return Response.json({ session: createClientSessionFixture(body.artifactText ?? "") });
      }
      return Response.json({ session: createClientSessionFixture("") });
    });
    vi.stubGlobal("fetch", fetchMock);
    const firstView = render(<LearningPage />);
    fireEvent.click(screen.getByRole("button", { name: "文档编辑" }));
    const editor = await screen.findByLabelText("在这里写下任务理解、计划、执行过程或最终产出。");
    fireEvent.change(screen.getByLabelText("文档标题"), { target: { value: "快速草稿" } });
    setRichEditorContent(editor, "尚未到 debounce 的正文");
    firstView.unmount();

    expect(window.sessionStorage.getItem("aais_artifact_draft_v1:Bobie"))
      .toContain("尚未到 debounce 的正文");
    const journalMutationId = JSON.parse(String(
      window.sessionStorage.getItem("aais_artifact_draft_v1:Bobie"),
    )).mutationId;
    const secondView = render(<LearningPage />);
    await waitFor(() => expect(getPatchCalls(fetchMock)).toHaveLength(1), { timeout: 2_000 });
    expect(JSON.parse(String(getPatchCalls(fetchMock)[0]?.[1]?.body))).toMatchObject({
      action: "save-artifact",
      artifactText: "尚未到 debounce 的正文",
      expectedArtifactRevision: 0,
      mutationId: journalMutationId,
    });
    expect(window.sessionStorage.getItem("aais_artifact_draft_v1:Bobie")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "文档编辑" }));
    const restored = await screen.findByLabelText("在这里写下任务理解、计划、执行过程或最终产出。");
    await waitFor(() => expect(restored.innerHTML).toBe("尚未到 debounce 的正文"));
    expect((screen.getByLabelText("文档标题") as HTMLInputElement).value).toBe("快速草稿");

    secondView.unmount();
    window.sessionStorage.clear();
    telemetryMocks.start.mockImplementation((options?: AaisResearchTelemetryStartOptions) => {
      options?.onBoundaryStateChange?.("ready");
      return () => undefined;
    });
    const researchView = render(<LearningPage research={createRequiredResearchBoundary()} />);
    const researchEditorTab = await screen.findAllByRole("button", { name: "文档编辑" });
    fireEvent.click(researchEditorTab.at(-1)!);
    const researchEditors = await screen.findAllByLabelText("在这里写下任务理解、计划、执行过程或最终产出。");
    setRichEditorContent(researchEditors.at(-1)!, "研究模式原始正文不得进入 journal");
    expect(JSON.stringify(window.sessionStorage)).not.toContain("研究模式原始正文");
    expect(window.sessionStorage.getItem("aais_artifact_draft_v1:Bobie")).toBeNull();
    researchView.unmount();
  });

  it("restores and saves a title-only quick-unload journal", async () => {
    setCsrfCookie();
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input).startsWith("/api/learning/session") && (!init || init.method === "GET")) {
        return Response.json({ session: createClientSessionFixture("") });
      }
      if (String(input) === "/api/learning/session" && init?.method === "PATCH") {
        return Response.json({ session: createClientSessionFixture("") });
      }
      return Response.json({ ok: true });
    });
    vi.stubGlobal("fetch", fetchMock);

    const firstView = render(<LearningPage />);
    fireEvent.click(screen.getByRole("button", { name: "文档编辑" }));
    await screen.findByLabelText("文档标题");
    fireEvent.change(screen.getByLabelText("文档标题"), {
      target: { value: "只有标题也必须恢复" },
    });
    firstView.unmount();

    expect(window.sessionStorage.getItem("aais_artifact_draft_v1:Bobie"))
      .toContain("只有标题也必须恢复");
    render(<LearningPage />);

    await waitFor(() => expect(getPatchCalls(fetchMock)).toHaveLength(1), { timeout: 2_000 });
    expect(JSON.parse(String(getPatchCalls(fetchMock)[0]?.[1]?.body))).toMatchObject({
      action: "save-artifact",
      artifactText: "",
      documentTitle: "只有标题也必须恢复",
      expectedArtifactRevision: 0,
      mutationId: expect.any(String),
    });
    fireEvent.click(screen.getByRole("button", { name: "文档编辑" }));
    expect((await screen.findByLabelText("文档标题") as HTMLInputElement).value)
      .toBe("只有标题也必须恢复");
    expect(window.sessionStorage.getItem("aais_artifact_draft_v1:Bobie")).toBeNull();
  });

  it("warns before closing an ordinary draft and submits it with pagehide keepalive", async () => {
    setCsrfCookie();
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input).startsWith("/api/learning/session") && (!init || init.method === "GET")) {
        return Response.json({ session: createClientSessionFixture("") });
      }
      if (String(input) === "/api/learning/session" && init?.method === "PATCH") {
        return Response.json({ session: createClientSessionFixture("普通模式快速离开正文") });
      }
      return Response.json({ ok: true });
    });
    vi.stubGlobal("fetch", fetchMock);
    render(<LearningPage />);
    fireEvent.click(screen.getByRole("button", { name: "文档编辑" }));
    const editor = await screen.findByLabelText("在这里写下任务理解、计划、执行过程或最终产出。");
    setRichEditorContent(editor, "普通模式快速离开正文");

    const beforeUnload = new Event("beforeunload", { cancelable: true });
    expect(window.dispatchEvent(beforeUnload)).toBe(false);
    expect(beforeUnload.defaultPrevented).toBe(true);
    window.dispatchEvent(new Event("pagehide"));

    await waitFor(() => expect(getPatchCalls(fetchMock)).toHaveLength(1));
    expect(getPatchCalls(fetchMock)[0]?.[1]).toMatchObject({
      method: "PATCH",
      credentials: "same-origin",
      keepalive: true,
    });
    expect(JSON.parse(String(getPatchCalls(fetchMock)[0]?.[1]?.body))).toMatchObject({
      action: "save-artifact",
      artifactText: "普通模式快速离开正文",
      dataGeneration: 1,
    });
  });

  it("protects an uncommitted research draft and submits it with pagehide keepalive", async () => {
    setCsrfCookie();
    telemetryMocks.start.mockImplementation((options?: AaisResearchTelemetryStartOptions) => {
      options?.onBoundaryStateChange?.("ready");
      return () => undefined;
    });
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input).startsWith("/api/learning/session") && (!init || init.method === "GET")) {
        return Response.json({ session: createClientSessionFixture("") });
      }
      if (String(input) === "/api/learning/session" && init?.method === "PATCH") {
        return Response.json({ session: createClientSessionFixture("研究模式快速离开正文") });
      }
      return Response.json({ ok: true });
    });
    vi.stubGlobal("fetch", fetchMock);
    const view = render(<LearningPage research={createRequiredResearchBoundary()} />);
    fireEvent.click(await screen.findByRole("button", { name: "文档编辑" }));
    const editor = await screen.findByLabelText("在这里写下任务理解、计划、执行过程或最终产出。");
    setRichEditorContent(editor, "研究模式快速离开正文");

    const beforeUnload = new Event("beforeunload", { cancelable: true });
    expect(window.dispatchEvent(beforeUnload)).toBe(false);
    expect(beforeUnload.defaultPrevented).toBe(true);
    window.dispatchEvent(new Event("pagehide"));

    await waitFor(() => expect(getPatchCalls(fetchMock)).toHaveLength(1));
    const [, request] = getPatchCalls(fetchMock)[0];
    expect(request).toMatchObject({
      method: "PATCH",
      credentials: "same-origin",
      keepalive: true,
      headers: {
        "content-type": "application/json",
        "x-aais-csrf": "test-csrf-token",
      },
    });
    expect(JSON.parse(String(request?.body))).toMatchObject({
      action: "save-artifact",
      artifactText: "研究模式快速离开正文",
      mutationId: expect.any(String),
      taskId: "training_task_1",
    });
    expect(window.sessionStorage.getItem("aais_artifact_draft_v1:Bobie")).toBeNull();
    view.unmount();
  });

  it("proactively flushes a hidden research draft without writing raw text to Web Storage", async () => {
    setCsrfCookie();
    telemetryMocks.start.mockImplementation((options?: AaisResearchTelemetryStartOptions) => {
      options?.onBoundaryStateChange?.("ready");
      return () => undefined;
    });
    vi.spyOn(document, "visibilityState", "get").mockReturnValue("hidden");
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input).startsWith("/api/learning/session") && (!init || init.method === "GET")) {
        return Response.json({ session: createClientSessionFixture("") });
      }
      if (String(input) === "/api/learning/session" && init?.method === "PATCH") {
        const body = JSON.parse(String(init.body)) as { artifactText?: string };
        return Response.json({ session: createClientSessionFixture(body.artifactText ?? "") });
      }
      return Response.json({ ok: true });
    });
    vi.stubGlobal("fetch", fetchMock);
    render(<LearningPage research={createRequiredResearchBoundary()} />);
    fireEvent.click(await screen.findByRole("button", { name: "文档编辑" }));
    const editor = await screen.findByLabelText("在这里写下任务理解、计划、执行过程或最终产出。");
    setRichEditorContent(editor, "切到后台前主动保存的研究正文");

    document.dispatchEvent(new Event("visibilitychange"));

    await waitFor(() => expect(getPatchCalls(fetchMock)).toHaveLength(1));
    const [, request] = getPatchCalls(fetchMock)[0];
    expect(request?.keepalive).not.toBe(true);
    expect(JSON.parse(String(request?.body))).toMatchObject({
      action: "save-artifact",
      artifactText: "切到后台前主动保存的研究正文",
      taskId: "training_task_1",
    });
    expect(window.localStorage.getItem("aais_artifact_draft_v1:Bobie")).toBeNull();
    expect(window.sessionStorage.getItem("aais_artifact_draft_v1:Bobie")).toBeNull();
  });

  it("falls back to an ordinary best-effort flush when a research draft exceeds keepalive limits", async () => {
    setCsrfCookie();
    telemetryMocks.start.mockImplementation((options?: AaisResearchTelemetryStartOptions) => {
      options?.onBoundaryStateChange?.("ready");
      return () => undefined;
    });
    const oversizedResearchDraft = "研".repeat(25_000);
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input).startsWith("/api/learning/session") && (!init || init.method === "GET")) {
        return Response.json({ session: createClientSessionFixture("") });
      }
      if (String(input) === "/api/learning/session" && init?.method === "PATCH") {
        const body = JSON.parse(String(init.body)) as { artifactText?: string };
        return Response.json({ session: createClientSessionFixture(body.artifactText ?? "") });
      }
      return Response.json({ ok: true });
    });
    vi.stubGlobal("fetch", fetchMock);
    render(<LearningPage research={createRequiredResearchBoundary()} />);
    fireEvent.click(await screen.findByRole("button", { name: "文档编辑" }));
    const editor = await screen.findByLabelText("在这里写下任务理解、计划、执行过程或最终产出。");
    setRichEditorContent(editor, oversizedResearchDraft);

    const beforeUnload = new Event("beforeunload", { cancelable: true });
    expect(window.dispatchEvent(beforeUnload)).toBe(false);
    expect(beforeUnload.defaultPrevented).toBe(true);
    window.dispatchEvent(new Event("pagehide"));

    await waitFor(() => expect(getPatchCalls(fetchMock)).toHaveLength(1));
    const [, request] = getPatchCalls(fetchMock)[0];
    expect(request?.keepalive).not.toBe(true);
    expect(JSON.parse(String(request?.body))).toMatchObject({
      action: "save-artifact",
      artifactText: oversizedResearchDraft,
      taskId: "training_task_1",
    });
    expect(window.localStorage.getItem("aais_artifact_draft_v1:Bobie")).toBeNull();
    expect(window.sessionStorage.getItem("aais_artifact_draft_v1:Bobie")).toBeNull();
  });

  it("locks the whole document surface during archive and skips blur autosave", async () => {
    setCsrfCookie();
    const archiveResponse = createDeferred<Response>();
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.startsWith("/api/learning/session") && (!init || init.method === "GET")) {
        return Response.json({ session: createClientSessionFixture("") });
      }
      if (url === "/api/learning/session" && init?.method === "PATCH") {
        return archiveResponse.promise;
      }
      return Response.json({ ok: true });
    });
    vi.stubGlobal("fetch", fetchMock);
    render(<LearningPage />);

    fireEvent.click(screen.getByRole("button", { name: "文档编辑" }));
    const editor = await screen.findByLabelText("在这里写下任务理解、计划、执行过程或最终产出。");
    setRichEditorContent(editor, "归档中的正文");
    const archive = screen.getByRole("button", { name: "保存并关闭" });
    fireEvent.pointerDown(archive);
    fireEvent.blur(editor, { relatedTarget: archive });
    fireEvent.click(archive);

    await waitFor(() => expect(getPatchCalls(fetchMock)).toHaveLength(1));
    expect(JSON.parse(String(getPatchCalls(fetchMock)[0][1]?.body)).action).toBe("archive-artifact");
    await waitFor(() => {
      expect(screen.getByLabelText("文档标题").matches(":disabled")).toBe(true);
    });
    expect(editor.getAttribute("contenteditable")).toBe("false");
    expect((screen.getByRole("button", { name: "内容展示" }) as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByRole("button", { name: "下载到本地" }) as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByRole("button", { name: "加粗" }).matches(":disabled")).toBe(true);

    archiveResponse.resolve(Response.json({ session: createClientSessionFixture("") }));
    await screen.findByRole("button", { name: "返回内容展示" });
  });

  it("does not let an unmounted save response clear a newer page journal", async () => {
    setCsrfCookie();
    const oldSave = createDeferred<Response>();
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.startsWith("/api/learning/session") && (!init || init.method === "GET")) {
        return Response.json({ session: createClientSessionFixture("") });
      }
      if (url === "/api/learning/session" && init?.method === "PATCH") {
        return oldSave.promise;
      }
      return Response.json({ ok: true });
    });
    vi.stubGlobal("fetch", fetchMock);
    const oldPage = render(<LearningPage />);
    fireEvent.click(screen.getByRole("button", { name: "文档编辑" }));
    const editor = await screen.findByLabelText("在这里写下任务理解、计划、执行过程或最终产出。");
    setRichEditorContent(editor, "旧页面正文");
    fireEvent.blur(editor);
    await waitFor(() => expect(getPatchCalls(fetchMock)).toHaveLength(1));
    oldPage.unmount();

    window.sessionStorage.setItem("aais_artifact_draft_v1:Bobie", JSON.stringify({
      revision: 99,
      taskId: "training_task_1",
      title: "新页面",
      value: "新页面正文",
    }));
    oldSave.resolve(Response.json({ session: createClientSessionFixture("旧页面正文") }));
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(window.sessionStorage.getItem("aais_artifact_draft_v1:Bobie"))
      .toContain("新页面正文");
  });

  it("rejects learner deletion while an artifact request is in flight", async () => {
    setCsrfCookie();
    const saveResponse = createDeferred<Response>();
    const confirm = vi.fn(() => true);
    Object.defineProperty(window, "confirm", { configurable: true, value: confirm });
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.startsWith("/api/learning/session") && (!init || init.method === "GET")) {
        return Response.json({ session: createClientSessionFixture("") });
      }
      if (url === "/api/learning/session" && init?.method === "PATCH") {
        return saveResponse.promise;
      }
      return Response.json({ ok: true });
    });
    vi.stubGlobal("fetch", fetchMock);
    render(<LearningPage />);
    fireEvent.click(screen.getByRole("button", { name: "文档编辑" }));
    const editor = await screen.findByLabelText("在这里写下任务理解、计划、执行过程或最终产出。");
    setRichEditorContent(editor, "保存进行中");
    fireEvent.blur(editor);
    await waitFor(() => expect(getPatchCalls(fetchMock)).toHaveLength(1));

    fireEvent.click(screen.getByRole("button", { name: "Bobie 账户菜单" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "删除学习数据" }));
    expect(confirm).not.toHaveBeenCalled();
    expect(screen.getByRole("alert").textContent)
      .toBe("请等待当前保存、下载或智能体操作完成后再退出。");
    expect(fetchMock.mock.calls.some(([input, init]) =>
      String(input) === "/api/learning/privacy" && init?.method === "DELETE"
    )).toBe(false);

    saveResponse.resolve(Response.json({ session: createClientSessionFixture("保存进行中") }));
    await screen.findByText("文档已保存。");

    fireEvent.click(screen.getByRole("menuitem", { name: "删除学习数据" }));
    await waitFor(() => expect(confirm).toHaveBeenCalledTimes(1));
    expect(fetchMock.mock.calls.filter(([input, init]) =>
      String(input) === "/api/learning/privacy" && init?.method === "DELETE"
    )).toHaveLength(1);
  });
});

function setCsrfCookie() {
  document.cookie = "aais_csrf=test-csrf-token; path=/";
}

function getPatchCalls(fetchMock: ReturnType<typeof vi.fn>) {
  return fetchMock.mock.calls.filter(([input, init]) =>
    String(input) === "/api/learning/session" && init?.method === "PATCH"
  );
}

function getLastResearchEvent(eventName: string) {
  return telemetryMocks.record.mock.calls
    .map(([event]) => event)
    .filter((event) => event.eventName === eventName)
    .at(-1);
}

function setRichEditorContent(editor: HTMLElement, value: string) {
  editor.innerHTML = value;
  fireEvent.input(editor);
}

function createDeferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((nextResolve, nextReject) => {
    resolve = nextResolve;
    reject = nextReject;
  });
  return {
    promise,
    reject,
    resolve,
  };
}

function createClientSessionFixture(
  artifactText: string,
  historyDocuments: Array<{
    id: string;
    taskId: string;
    title: string;
    html: string;
    savedAt: string;
  }> = [],
  artifactRevision = 0,
) {
  return {
    dataGeneration: 1,
    studentId: "S001",
    activeStage: "training",
    activeTaskId: "training_task_1",
    tasks: [
      {
        taskId: "training_task_1",
        phase: "training",
        status: "active",
        artifactText,
        artifactRevision,
        selfReport: "",
        selfReportRevision: 0,
        scaffoldRequests: 0,
        scaffoldHistory: [],
      },
    ],
    historyDocuments,
    guideMessages: [],
    events: [],
  };
}

function createRequiredResearchBoundary(): LearningPageResearchBoundary {
  return {
    required: true,
    initialVisit: {
      participantId: "participant-01",
      studyRunId: "study-run-01",
      visitId: "visit-01",
      condition: "condition-a",
      appVersion: "0.1.0",
      commitSha: "abc1234",
    },
  };
}

function installExecCommandMock() {
  const execCommand = vi.fn(() => true);
  Object.defineProperty(document, "execCommand", {
    configurable: true,
    value: execCommand,
  });
  return execCommand;
}

function installGuideFetchMock() {
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url.startsWith("/api/learning/session") && (!init || init.method === "GET")) {
      return Response.json({
        session: {
            dataGeneration: 1,
          studentId: "S001",
          activeStage: "training",
          activeTaskId: "training_task_1",
          tasks: [],
          guideMessages: [],
          events: [],
        },
      });
    }
    if (url === "/api/learning/ai-guide" && init?.method === "POST") {
      return Response.json({
        message: {
          text: "AAIS 智能体已回复。",
        },
        turns: [
          {
            agentId: "A1",
            label: "导学智能体",
            content: "A1 已阅读上传文件。",
            actions: ["guide-flow", "scaffold"],
          },
        ],
      });
    }
    return Response.json({ ok: true });
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}
