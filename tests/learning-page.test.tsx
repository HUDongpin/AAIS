import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { LearningPage } from "@/components/pages/learning-page";

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  document.cookie = "aais_csrf=; Max-Age=0; path=/";
});

describe("AAIS LearningPage", () => {
  it("keeps My Learning focused on intelligent guidance without subtitles, outline, audio, or study-action buttons", () => {
    render(<LearningPage />);

    expect(screen.getByRole("heading", { name: "我的学习" })).toBeTruthy();
    expect(screen.getByText("智能导学")).toBeTruthy();
    expect(screen.queryByText("全部字幕")).toBeNull();
    expect(screen.queryByText("课程目录")).toBeNull();
    expect(screen.queryByText("问这页")).toBeNull();
    expect(screen.queryByText("生成笔记")).toBeNull();
    expect(screen.queryByText("学习检查点")).toBeNull();
    expect(screen.queryByText("关键概念")).toBeNull();
    expect(screen.queryByText("导出笔记")).toBeNull();
    expect(screen.queryByText("播放设置")).toBeNull();
  });

  it("shows the four AAIS agents and the PPT-inspired learning stages", () => {
    render(<LearningPage />);

    expect(screen.getByText("导学智能体")).toBeTruthy();
    expect(screen.getByText("监督智能体")).toBeTruthy();
    expect(screen.getByText("反思智能体")).toBeTruthy();
    expect(screen.getByText("支架智能体")).toBeTruthy();
    expect(screen.getByText("训练阶段")).toBeTruthy();
    expect(screen.getByText("练习阶段")).toBeTruthy();
    expect(screen.getByText("专家思维轨迹")).toBeTruthy();
  });

  it("runs the right-side intelligent guide through the AAIS API as structured agent turns", async () => {
    setCsrfCookie();
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.startsWith("/api/learning/session") && (!init || init.method === "GET")) {
        return Response.json({
          session: {
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
              agentId: "A4",
              label: "支架智能体",
              content: "请先说明卡点再选工具。",
              actions: ["self-check"],
            },
          ],
          orchestration: {
            graph: {
              runtime: "langgraph",
              graphId: "learning-ai-guide",
              topologicalOrder: ["A1", "A2", "A3", "A4"],
            },
          },
        });
      }
      return Response.json({ ok: true });
    });
    vi.stubGlobal("fetch", fetchMock);

    render(<LearningPage />);

    fireEvent.change(screen.getByLabelText("向智能导学输入你的想法"), {
      target: {
        value: "我卡住了",
      },
    });
    fireEvent.click(screen.getByRole("button", { name: "发送" }));

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
    expect(await screen.findByText("先确认目标并拆成下一步。")).toBeTruthy();
    expect(screen.getByText("请先说明卡点再选工具。")).toBeTruthy();
    expect(screen.getByText("LangGraph trace")).toBeTruthy();
    expect(screen.queryByText("LangGraph 多智能体导学已完成：A1 A2 A3 A4")).toBeNull();
  });

  it("allows the learning shell to use the full horizontal viewport", () => {
    render(<LearningPage />);

    const shell = screen.getByTestId("learning-shell");
    expect(shell.className).toContain("max-w-none");
    expect(shell.className).not.toContain("max-w-[1608px]");
  });

  it("hydrates persisted learner session and saves artifacts through the backend", async () => {
    setCsrfCookie();
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.startsWith("/api/learning/session") && (!init || init.method === "GET")) {
        return Response.json({
          session: {
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

    render(<LearningPage />);

    expect(await screen.findByDisplayValue("后端保存的训练记录")).toBeTruthy();
    fireEvent.change(screen.getByLabelText("在这里写下任务理解、计划、执行过程或最终产出。"), {
      target: {
        value: "新的过程记录",
      },
    });

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

    const artifactInput = await screen.findByLabelText("在这里写下任务理解、计划、执行过程或最终产出。");
    vi.useFakeTimers();
    fireEvent.change(artifactInput, { target: { value: "a" } });
    fireEvent.change(artifactInput, { target: { value: "ab" } });
    fireEvent.change(artifactInput, { target: { value: "abc" } });

    expect((artifactInput as HTMLTextAreaElement).value).toBe("abc");
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

  it("flushes a pending artifact save when the learner leaves the editor", async () => {
    setCsrfCookie();
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.startsWith("/api/learning/session") && (!init || init.method === "GET")) {
        return Response.json({
          session: {
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

    const artifactInput = await screen.findByLabelText("在这里写下任务理解、计划、执行过程或最终产出。");
    vi.useFakeTimers();
    fireEvent.change(artifactInput, { target: { value: "离开前的最后过程记录" } });
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

  it("requests scaffolding through the backend instead of only changing local state", async () => {
    setCsrfCookie();
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.startsWith("/api/learning/session") && (!init || init.method === "GET")) {
        return Response.json({
          session: {
            studentId: "S001",
            activeStage: "practice",
            activeTaskId: "practice_task_1",
            tasks: [
              {
                taskId: "training_task_1",
                phase: "training",
                status: "completed",
                artifactText: "",
                selfReport: "",
                scaffoldRequests: 0,
                scaffoldHistory: [],
              },
              {
                taskId: "practice_task_1",
                phase: "practice",
                status: "active",
                artifactText: "",
                selfReport: "",
                scaffoldRequests: 4,
                scaffoldHistory: [],
              },
            ],
            guideMessages: [],
            events: [],
          },
        });
      }
      if (url === "/api/learning/scaffold" && init?.method === "POST") {
        expect(JSON.parse(String(init.body))).toMatchObject({
          taskId: "practice_task_1",
          toolId: "stage-checklist",
        });
        return Response.json({
          mode: "self-check",
          requestCount: 5,
          tool: {
            id: "stage-checklist",
            label: "阶段检查表",
            body: "工具内容",
          },
          session: {
            studentId: "S001",
            activeStage: "practice",
            activeTaskId: "practice_task_1",
            tasks: [
              {
                taskId: "practice_task_1",
                phase: "practice",
                status: "active",
                artifactText: "",
                selfReport: "",
                scaffoldRequests: 5,
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

    expect(await screen.findByText("A4 元认知工具包")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "获取帮助" }));

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith(
        "/api/learning/scaffold",
        expect.objectContaining({
          method: "POST",
          headers: expect.objectContaining({
            "x-aais-csrf": "test-csrf-token",
          }),
        }),
      );
    });
    expect(await screen.findByText("A4 本次支架")).toBeTruthy();
    expect(screen.getByText("阶段检查表")).toBeTruthy();
    expect(screen.getByText("工具内容")).toBeTruthy();
    expect(screen.getByText(/已记录第 5 次求助/)).toBeTruthy();
    expect(await screen.findByText(/第 5 次及以后求助/)).toBeTruthy();
  });

  it("completes the active task through the backend so the next task unlocks", async () => {
    setCsrfCookie();
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.startsWith("/api/learning/session") && (!init || init.method === "GET")) {
        return Response.json({
          session: {
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
              {
                taskId: "practice_task_1",
                phase: "practice",
                status: "locked",
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
        expect(JSON.parse(String(init.body))).toMatchObject({
          action: "complete-task",
          taskId: "training_task_1",
        });
        return Response.json({
          session: {
            studentId: "S001",
            activeStage: "training",
            activeTaskId: "training_task_1",
            tasks: [
              {
                taskId: "training_task_1",
                phase: "training",
                status: "completed",
                artifactText: "",
                selfReport: "",
                scaffoldRequests: 0,
                scaffoldHistory: [],
              },
              {
                taskId: "practice_task_1",
                phase: "practice",
                status: "available",
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
      return Response.json({ ok: true });
    });
    vi.stubGlobal("fetch", fetchMock);

    render(<LearningPage />);

    fireEvent.click(await screen.findByRole("button", { name: "完成当前任务" }));

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
    expect((screen.getByRole("button", { name: "L1 挑战：复述与计划" }) as HTMLButtonElement).disabled).toBe(false);
  });

  it("uses backend export endpoints for JSON and CSV downloads", async () => {
    const createObjectUrl = vi.fn(() => "blob:aais");
    const revokeObjectUrl = vi.fn();
    vi.stubGlobal("URL", {
      ...URL,
      createObjectURL: createObjectUrl,
      revokeObjectURL: revokeObjectUrl,
    });
    const click = vi.fn();
    const originalCreateElement = document.createElement.bind(document);
    vi.spyOn(document, "createElement").mockImplementation((tagName: string) => {
      const element = originalCreateElement(tagName);
      if (tagName === "a") {
        Object.defineProperty(element, "click", {
          configurable: true,
          value: click,
        });
      }
      return element;
    });

    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.startsWith("/api/learning/session")) {
        return Response.json({
          session: {
            studentId: "S001",
            activeStage: "training",
            activeTaskId: "training_task_1",
            tasks: [],
            guideMessages: [],
            events: [],
          },
        });
      }
      if (url === "/api/learning/export?format=json") {
        return new Response("[{\"event\":\"artifact_saved\"}]", {
          headers: {
            "content-type": "application/json;charset=utf-8",
            "content-disposition": "attachment; filename=\"aais-S001-events.json\"",
          },
        });
      }
      if (url === "/api/learning/export?format=csv") {
        return new Response("student_id,event\nS001,artifact_saved", {
          headers: {
            "content-type": "text/csv;charset=utf-8",
            "content-disposition": "attachment; filename=\"aais-S001-events.csv\"",
          },
        });
      }
      return Response.json({ ok: true });
    });
    vi.stubGlobal("fetch", fetchMock);

    render(<LearningPage />);

    fireEvent.click(await screen.findByRole("button", { name: "导出 JSON" }));
    fireEvent.click(screen.getByRole("button", { name: "导出 CSV" }));

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith("/api/learning/export?format=json");
      expect(fetchMock).toHaveBeenCalledWith("/api/learning/export?format=csv");
    });
    expect(click).toHaveBeenCalledTimes(2);
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
