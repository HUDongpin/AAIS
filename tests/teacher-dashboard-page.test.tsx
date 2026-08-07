import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { TeacherDashboardPage } from "@/components/pages/teacher-dashboard-page";

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  document.cookie = "aais_csrf=; Max-Age=0; path=/";
});

describe("AAIS TeacherDashboardPage", () => {
  it("renders cohort analytics from the teacher-only API without raw learner text", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url === "/api/learning/analytics?scope=cohort&limit=25&offset=0") {
        return Response.json({
          analytics: {
            dashboard: {
              cohort: {
                learnerCount: 2,
                trainingCompleted: 1,
                completedPracticeTasks: 3,
                scaffoldRequests: 5,
                coachingSignals: 2,
                aiInteractions: 4,
                aiAcceptanceDecisions: 2,
                riskBreakdown: {
                  high: 1,
                  medium: 0,
                  low: 1,
                },
              },
            },
            pagination: {
              limit: 25,
              offset: 0,
              returnedLearners: 2,
              totalLearners: 2,
              hasPreviousPage: false,
              hasNextPage: false,
            },
            learners: [
              {
                learnerKey: "learner-alpha",
                sessionId: "session-alpha",
                updatedAt: "2026-07-01T08:00:00.000Z",
                trainingCompleted: true,
                activePracticeTaskId: "practice_task_2",
                completedPracticeTasks: 2,
                scaffoldRequests: 3,
                coachingSignals: 1,
                aiInteractions: 4,
                aiAcceptanceDecisions: 2,
                reflectionStatus: "evidence_present",
                riskLevel: "low",
                priorityReasons: [],
              },
              {
                learnerKey: "learner-beta",
                sessionId: "session-beta",
                updatedAt: "2026-07-01T08:05:00.000Z",
                trainingCompleted: false,
                activePracticeTaskId: null,
                completedPracticeTasks: 1,
                scaffoldRequests: 2,
                coachingSignals: 1,
                aiInteractions: 0,
                aiAcceptanceDecisions: 0,
                reflectionStatus: "needs_reflection_evidence",
                riskLevel: "high",
                priorityReasons: [
                  "training_incomplete",
                  "reflection_missing",
                  "a2_coaching_signals",
                  "no_ai_interaction_after_coaching",
                ],
                rawLearnerText: "不能出现在教师看板的原始学习文本",
              },
            ],
            integrations: {
              factLayer: "lrs",
              joinKeys: ["session_id", "phase", "task", "agent", "event", "cohort", "role", "course_id"],
            },
            privacy: {
              actorMode: "pseudonymous",
              rawPromptStorage: "excluded_from_lrs",
              minimumNecessaryFields: true,
            },
          },
          secrets: "redacted",
        });
      }
      if (url === "/api/learning/recommendations?scope=cohort") {
        return Response.json({
          recommendations: [
            {
              id: "recommendation-abcdef123456",
              learnerKey: "learner-abcdef123456",
              sessionKey: "session-abcdef123456",
              ruleId: "complete_reflection",
              priority: "high",
              targetTaskId: "practice_task_1",
              title: "补齐反思证据",
              actionLabel: "提示学生提交反思",
              reasonCodes: ["reflection_missing"],
              reasons: ["缺少自我报告或专家轨迹比较证据，教师可要求学生补充解释过程。"],
            },
          ],
          secrets: "redacted",
        });
      }
      return Response.json({ error: { code: "AAIS_TEST_UNEXPECTED", message: "unexpected" } }, { status: 500 });
    });
    vi.stubGlobal("fetch", fetchMock);

    render(<TeacherDashboardPage />);

    expect(await screen.findByRole("heading", { name: "教师看板" })).toBeTruthy();
    expect(screen.getByRole("main", { name: "教师看板" })).toBeTruthy();
    expect(screen.getByText("学习者")).toBeTruthy();
    expect(screen.getAllByText("2").length).toBeGreaterThan(0);
    expect(screen.getByText("监督/教授信号")).toBeTruthy();
    expect(screen.getByRole("option", { name: "小张" })).toBeTruthy();
    expect(screen.getByRole("option", { name: "教授" })).toBeTruthy();
    expect(document.body.textContent).not.toMatch(/\bA[12]\b/);
    expect(screen.getByText("AI 采纳")).toBeTruthy();
    expect(screen.getByText("风险分层")).toBeTruthy();
    expect(screen.getByText("推荐跟进")).toBeTruthy();
    expect(screen.getByText("补齐反思证据")).toBeTruthy();
    expect(screen.getAllByText("高风险").length).toBeGreaterThan(0);
    expect(screen.getAllByText("需补反思").length).toBeGreaterThan(0);
    expect(screen.getByText("需要跟进 AI 使用决策")).toBeTruthy();
    expect(screen.getByText("learner-alpha")).toBeTruthy();
    expect(screen.getByText("learner-beta")).toBeTruthy();
    expect(screen.getByText("session_id")).toBeTruthy();
    expect(screen.getByText("course_id")).toBeTruthy();
    expect(screen.getAllByText("pseudonymous").length).toBeGreaterThan(0);
    expect(screen.getByText("lrs")).toBeTruthy();
    expect(screen.queryByText("不能出现在教师看板的原始学习文本")).toBeNull();
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
  });

  it("shows an educator authorization message when cohort analytics is forbidden", async () => {
    const fetchMock = vi.fn(async () =>
      Response.json(
        {
          error: {
            code: "AAIS_COHORT_ANALYTICS_FORBIDDEN",
            message: "AAIS teacher analytics requires educator authorization.",
          },
          secrets: "redacted",
        },
        { status: 403 },
      ),
    );
    vi.stubGlobal("fetch", fetchMock);

    render(<TeacherDashboardPage />);

    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toBe("教师或管理员登录后可查看 cohort dashboard。");
    expect(alert.getAttribute("aria-live")).toBe("assertive");
    expect(alert.getAttribute("aria-atomic")).toBe("true");
  });

  it("shows when teacher recommendations are paused by environment policy", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url === "/api/learning/analytics?scope=cohort&limit=25&offset=0") {
        return Response.json({ analytics: createAnalyticsFixture() });
      }
      if (url === "/api/learning/recommendations?scope=cohort") {
        return Response.json({
          recommendations: [],
          policy: {
            enabled: false,
          },
          secrets: "redacted",
        });
      }
      return Response.json(
        { error: { code: "AAIS_TEST_UNEXPECTED", message: "unexpected" } },
        { status: 500 },
      );
    });
    vi.stubGlobal("fetch", fetchMock);

    render(<TeacherDashboardPage />);

    expect(await screen.findByRole("heading", { name: "教师看板" })).toBeTruthy();
    expect(screen.getByText("推荐跟进")).toBeTruthy();
    expect(await screen.findByText("已暂停")).toBeTruthy();
    expect(screen.getByText("规则推荐已暂停。")).toBeTruthy();
    expect(screen.queryByText("暂无需要立即跟进的规则建议。")).toBeNull();
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
  });

  it("announces dashboard loading and disables refresh/export while cohort data loads", async () => {
    const analytics = createDeferred<Response>();
    const recommendations = createDeferred<Response>();
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url === "/api/learning/analytics?scope=cohort&limit=25&offset=0") {
        return analytics.promise;
      }
      if (url === "/api/learning/recommendations?scope=cohort") {
        return recommendations.promise;
      }
      return Response.json(
        { error: { code: "AAIS_TEST_UNEXPECTED", message: "unexpected" } },
        { status: 500 },
      );
    });
    vi.stubGlobal("fetch", fetchMock);

    render(<TeacherDashboardPage />);

    const loadingStatus = screen.getByRole("status");
    expect(loadingStatus.textContent).toBe("正在加载 cohort analytics...");
    expect(loadingStatus.getAttribute("aria-live")).toBe("polite");
    expect(loadingStatus.getAttribute("aria-atomic")).toBe("true");
    expect(screen.getByRole("main").getAttribute("aria-busy")).toBe("true");
    expect((screen.getByRole("button", { name: "刷新中" }) as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByRole("button", { name: "CSV" }) as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByRole("button", { name: "JSON" }) as HTMLButtonElement).disabled).toBe(true);

    analytics.resolve(Response.json({ analytics: createAnalyticsFixture() }));
    recommendations.resolve(Response.json({ recommendations: [] }));

    await waitFor(() => expect(screen.queryByText("正在加载 cohort analytics...")).toBeNull());
    expect(screen.getByRole("main").getAttribute("aria-busy")).toBe("false");
  });

  it("filters and exports cohort analytics with enterprise join keys", async () => {
    const createObjectUrl = vi.fn(() => "blob:aais-cohort");
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
      if (url.startsWith("/api/learning/analytics")) {
        return Response.json({ analytics: createAnalyticsFixture() });
      }
      if (url.startsWith("/api/learning/export")) {
        return new Response("learner_key,risk_level\nlearner-beta,high", {
          headers: {
            "content-type": "text/csv;charset=utf-8",
            "content-disposition": 'attachment; filename="aais-cohort-analytics.csv"',
          },
        });
      }
      return Response.json(
        { error: { code: "AAIS_TEST_UNEXPECTED", message: "unexpected" } },
        { status: 500 },
      );
    });
    vi.stubGlobal("fetch", fetchMock);

    render(<TeacherDashboardPage />);

    expect(await screen.findByRole("heading", { name: "教师看板" })).toBeTruthy();
    fireEvent.change(screen.getByLabelText("Phase"), { target: { value: "practice" } });
    fireEvent.change(screen.getByLabelText("Agent"), { target: { value: "A2" } });
    fireEvent.change(screen.getByLabelText("Event"), { target: { value: "coaching_push" } });

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith(
        "/api/learning/analytics?scope=cohort&phase=practice&agent=A2&event=coaching_push&limit=25&offset=0",
      );
    });

    const csvButton = screen.getByRole("button", { name: "CSV" }) as HTMLButtonElement;
    await waitFor(() => {
      expect(csvButton.disabled).toBe(false);
    });
    fireEvent.click(csvButton);

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith(
        "/api/learning/export?scope=cohort&format=csv&phase=practice&agent=A2&event=coaching_push",
      );
    });
    expect(click).toHaveBeenCalledTimes(1);
    expect(createObjectUrl).toHaveBeenCalledTimes(1);
    expect(revokeObjectUrl).toHaveBeenCalledWith("blob:aais-cohort");
    const status = await screen.findByRole("status");
    expect(status.textContent).toBe("CSV 已生成");
    expect(status.getAttribute("aria-live")).toBe("polite");
    expect(status.getAttribute("aria-atomic")).toBe("true");
  });

  it("announces export progress and prevents duplicate export actions", async () => {
    const createObjectUrl = vi.fn(() => "blob:aais-cohort");
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
    const exportResponse = createDeferred<Response>();
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.startsWith("/api/learning/analytics")) {
        return Response.json({ analytics: createAnalyticsFixture() });
      }
      if (url.startsWith("/api/learning/recommendations")) {
        return Response.json({ recommendations: [] });
      }
      if (url.startsWith("/api/learning/export")) {
        return exportResponse.promise;
      }
      return Response.json(
        { error: { code: "AAIS_TEST_UNEXPECTED", message: "unexpected" } },
        { status: 500 },
      );
    });
    vi.stubGlobal("fetch", fetchMock);

    render(<TeacherDashboardPage />);

    expect(await screen.findByText("learner-beta")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "CSV" }));

    const csvBusyButton = screen.getByRole("button", { name: "CSV 生成中" }) as HTMLButtonElement;
    expect(csvBusyButton.disabled).toBe(true);
    expect((screen.getByRole("button", { name: "JSON" }) as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByRole("main").getAttribute("aria-busy")).toBe("true");
    expect(screen.getByRole("status").textContent).toBe("CSV 正在生成...");

    fireEvent.click(csvBusyButton);
    expect(fetchMock.mock.calls.filter(([input]) => String(input).startsWith("/api/learning/export"))).toHaveLength(1);

    exportResponse.resolve(new Response("learner_key,risk_level\nlearner-beta,high", {
      headers: {
        "content-type": "text/csv;charset=utf-8",
        "content-disposition": 'attachment; filename="aais-cohort-analytics.csv"',
      },
    }));

    await screen.findByText("CSV 已生成");
    expect(click).toHaveBeenCalledTimes(1);
    expect(revokeObjectUrl).toHaveBeenCalledWith("blob:aais-cohort");
    expect(screen.getByRole("main").getAttribute("aria-busy")).toBe("false");
  });

  it("announces learner-page loading and disables pagination while the next page loads", async () => {
    const nextPageResponse = createDeferred<Response>();
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url === "/api/learning/analytics?scope=cohort&limit=25&offset=0") {
        return Response.json({ analytics: createAnalyticsFixture({
          learnerKey: "learner-page-one",
          pagination: {
            limit: 25,
            offset: 0,
            returnedLearners: 25,
            totalLearners: 26,
            hasPreviousPage: false,
            hasNextPage: true,
          },
        }) });
      }
      if (url === "/api/learning/analytics?scope=cohort&limit=25&offset=25") {
        return nextPageResponse.promise;
      }
      if (url === "/api/learning/recommendations?scope=cohort") {
        return Response.json({ recommendations: [] });
      }
      return Response.json(
        { error: { code: "AAIS_TEST_UNEXPECTED", message: "unexpected" } },
        { status: 500 },
      );
    });
    vi.stubGlobal("fetch", fetchMock);

    render(<TeacherDashboardPage />);

    expect(await screen.findByText("learner-page-one")).toBeTruthy();
    const nextButton = screen.getByRole("button", { name: "下一页" }) as HTMLButtonElement;
    expect(nextButton.disabled).toBe(false);

    fireEvent.click(nextButton);

    expect(screen.getByRole("status").textContent).toBe("正在加载 cohort analytics...");
    expect(screen.getByRole("main").getAttribute("aria-busy")).toBe("true");
    expect((screen.getByRole("button", { name: "下一页" }) as HTMLButtonElement).disabled).toBe(true);

    nextPageResponse.resolve(Response.json({ analytics: createAnalyticsFixture({
      learnerKey: "learner-page-two",
      pagination: {
        limit: 25,
        offset: 25,
        returnedLearners: 1,
        totalLearners: 26,
        hasPreviousPage: true,
        hasNextPage: false,
      },
    }) }));

    expect(await screen.findByText("learner-page-two")).toBeTruthy();
    expect(screen.getByRole("main").getAttribute("aria-busy")).toBe("false");
  });

  it("pages the cohort learner queue without changing aggregate totals", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url === "/api/learning/analytics?scope=cohort&limit=25&offset=0") {
        return Response.json({ analytics: createAnalyticsFixture({
          learnerKey: "learner-page-one",
          pagination: {
            limit: 25,
            offset: 0,
            returnedLearners: 25,
            totalLearners: 26,
            hasPreviousPage: false,
            hasNextPage: true,
          },
        }) });
      }
      if (url === "/api/learning/analytics?scope=cohort&limit=25&offset=25") {
        return Response.json({ analytics: createAnalyticsFixture({
          learnerKey: "learner-page-two",
          pagination: {
            limit: 25,
            offset: 25,
            returnedLearners: 1,
            totalLearners: 26,
            hasPreviousPage: true,
            hasNextPage: false,
          },
        }) });
      }
      if (url === "/api/learning/recommendations?scope=cohort") {
        return Response.json({ recommendations: [] });
      }
      return Response.json(
        { error: { code: "AAIS_TEST_UNEXPECTED", message: "unexpected" } },
        { status: 500 },
      );
    });
    vi.stubGlobal("fetch", fetchMock);

    render(<TeacherDashboardPage />);

    expect(await screen.findByText("learner-page-one")).toBeTruthy();
    expect(screen.getByText("1-25 / 26")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "下一页" }));

    expect(await screen.findByText("learner-page-two")).toBeTruthy();
    expect(screen.getByText("26-26 / 26")).toBeTruthy();
    expect(screen.getByText("学习者")).toBeTruthy();
    expect(screen.getAllByText("26").length).toBeGreaterThan(0);
  });

  it("records a teacher recommendation override from the dashboard card", async () => {
    document.cookie = "aais_csrf=teacher-csrf-token; path=/";
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.startsWith("/api/learning/analytics")) {
        return Response.json({ analytics: createAnalyticsFixture() });
      }
      if (url.startsWith("/api/learning/recommendations") && init?.method !== "POST") {
        return Response.json({
          recommendations: [
            {
              id: "recommendation-abcdef123456",
              learnerKey: "learner-abcdef123456",
              sessionKey: "session-abcdef123456",
              ruleId: "complete_reflection",
              priority: "high",
              targetTaskId: "practice_task_1",
              title: "补齐反思证据",
              actionLabel: "提示学生提交反思",
              reasonCodes: ["reflection_missing"],
              reasons: ["缺少自我报告或专家轨迹比较证据，教师可要求学生补充解释过程。"],
            },
          ],
        });
      }
      if (url === "/api/learning/recommendations" && init?.method === "POST") {
        expect(init.headers).toMatchObject({
          "content-type": "application/json",
          "x-aais-csrf": "teacher-csrf-token",
        });
        expect(JSON.parse(String(init.body))).toMatchObject({
          recommendationId: "recommendation-abcdef123456",
          learnerKey: "learner-abcdef123456",
          sessionKey: "session-abcdef123456",
          ruleId: "complete_reflection",
          decision: "accepted",
        });
        return Response.json({
          override: {
            recommendationId: "recommendation-abcdef123456",
            learnerKey: "learner-abcdef123456",
            sessionKey: "session-abcdef123456",
            decision: "accepted",
            event: "recommendation_override_recorded",
          },
          secrets: "redacted",
        });
      }
      return Response.json(
        { error: { code: "AAIS_TEST_UNEXPECTED", message: "unexpected" } },
        { status: 500 },
      );
    });
    vi.stubGlobal("fetch", fetchMock);

    render(<TeacherDashboardPage />);

    expect(await screen.findByText("补齐反思证据")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "标记已处理" }));

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith(
        "/api/learning/recommendations",
        expect.objectContaining({ method: "POST" }),
      );
    });
    const status = await screen.findByRole("status");
    expect(status.textContent).toBe("推荐处理已记录");
    expect(status.getAttribute("aria-live")).toBe("polite");
  });

  it("announces recommendation override progress and blocks duplicate override actions", async () => {
    document.cookie = "aais_csrf=teacher-csrf-token; path=/";
    const overrideResponse = createDeferred<Response>();
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.startsWith("/api/learning/analytics")) {
        return Response.json({ analytics: createAnalyticsFixture() });
      }
      if (url.startsWith("/api/learning/recommendations") && init?.method !== "POST") {
        return Response.json({
          recommendations: [{
            id: "recommendation-abcdef123456",
            learnerKey: "learner-abcdef123456",
            sessionKey: "session-abcdef123456",
            ruleId: "complete_reflection",
            priority: "high",
            targetTaskId: "practice_task_1",
            title: "补齐反思证据",
            actionLabel: "提示学生提交反思",
            reasonCodes: ["reflection_missing"],
            reasons: ["缺少自我报告或专家轨迹比较证据，教师可要求学生补充解释过程。"],
          }],
        });
      }
      if (url === "/api/learning/recommendations" && init?.method === "POST") {
        return overrideResponse.promise;
      }
      return Response.json(
        { error: { code: "AAIS_TEST_UNEXPECTED", message: "unexpected" } },
        { status: 500 },
      );
    });
    vi.stubGlobal("fetch", fetchMock);

    render(<TeacherDashboardPage />);

    expect(await screen.findByText("补齐反思证据")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "标记已处理" }));

    const busyButton = screen.getByRole("button", { name: "记录中..." }) as HTMLButtonElement;
    expect(busyButton.disabled).toBe(true);
    expect(busyButton.closest("section")?.getAttribute("aria-busy")).toBe("true");
    expect(screen.getByRole("main").getAttribute("aria-busy")).toBe("true");
    expect(screen.getByRole("status").textContent).toBe("正在记录推荐处理...");

    fireEvent.click(busyButton);
    expect(fetchMock.mock.calls.filter(([input, init]) =>
      String(input) === "/api/learning/recommendations" && init?.method === "POST"
    )).toHaveLength(1);

    overrideResponse.resolve(Response.json({
      override: {
        recommendationId: "recommendation-abcdef123456",
        learnerKey: "learner-abcdef123456",
        sessionKey: "session-abcdef123456",
        decision: "accepted",
        event: "recommendation_override_recorded",
      },
      secrets: "redacted",
    }));

    await screen.findByText("推荐处理已记录");
    expect(screen.getByRole("main").getAttribute("aria-busy")).toBe("false");
  });
});

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

function createAnalyticsFixture(input: {
  learnerKey?: string;
  pagination?: {
    limit: number;
    offset: number;
    returnedLearners: number;
    totalLearners: number;
    hasPreviousPage: boolean;
    hasNextPage: boolean;
  };
} = {}) {
  return {
    dashboard: {
      cohort: {
        learnerCount: input.pagination?.totalLearners ?? 1,
        trainingCompleted: 0,
        completedPracticeTasks: 1,
        scaffoldRequests: 2,
        coachingSignals: 1,
        aiInteractions: 0,
        aiAcceptanceDecisions: 0,
        riskBreakdown: {
          high: 1,
          medium: 0,
          low: 0,
        },
      },
    },
    ...(input.pagination ? { pagination: input.pagination } : {}),
    learners: [
      {
        learnerKey: input.learnerKey ?? "learner-beta",
        sessionId: "session-beta",
        updatedAt: "2026-07-01T08:05:00.000Z",
        trainingCompleted: false,
        activePracticeTaskId: null,
        completedPracticeTasks: 1,
        scaffoldRequests: 2,
        coachingSignals: 1,
        aiInteractions: 0,
        aiAcceptanceDecisions: 0,
        reflectionStatus: "needs_reflection_evidence",
        riskLevel: "high",
        priorityReasons: ["training_incomplete", "reflection_missing", "a2_coaching_signals"],
      },
    ],
    integrations: {
      factLayer: "lrs",
      joinKeys: ["session_id", "phase", "task", "agent", "event", "cohort", "role", "course_id"],
    },
    privacy: {
      actorMode: "pseudonymous",
      rawPromptStorage: "excluded_from_lrs",
      minimumNecessaryFields: true,
    },
  };
}
