import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { TeacherDashboardPage } from "@/components/pages/teacher-dashboard-page";

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("AAIS TeacherDashboardPage", () => {
  it("renders cohort analytics from the teacher-only API without raw learner text", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      expect(String(input)).toBe("/api/learning/analytics?scope=cohort");
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
    });
    vi.stubGlobal("fetch", fetchMock);

    render(<TeacherDashboardPage />);

    expect(await screen.findByRole("heading", { name: "教师看板" })).toBeTruthy();
    expect(screen.getByText("学习者")).toBeTruthy();
    expect(screen.getAllByText("2").length).toBeGreaterThan(0);
    expect(screen.getByText("A2 监督信号")).toBeTruthy();
    expect(screen.getByText("AI 采纳")).toBeTruthy();
    expect(screen.getByText("风险分层")).toBeTruthy();
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
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
  });

  it("shows an educator authorization message when cohort analytics is forbidden", async () => {
    const fetchMock = vi.fn(async () =>
      Response.json(
        {
          error: "AAIS teacher analytics requires educator authorization.",
          secrets: "redacted",
        },
        { status: 403 },
      ),
    );
    vi.stubGlobal("fetch", fetchMock);

    render(<TeacherDashboardPage />);

    expect(await screen.findByText("教师或管理员登录后可查看 cohort dashboard。")).toBeTruthy();
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
      return Response.json({ error: "unexpected" }, { status: 500 });
    });
    vi.stubGlobal("fetch", fetchMock);

    render(<TeacherDashboardPage />);

    expect(await screen.findByRole("heading", { name: "教师看板" })).toBeTruthy();
    fireEvent.change(screen.getByLabelText("Phase"), { target: { value: "practice" } });
    fireEvent.change(screen.getByLabelText("Agent"), { target: { value: "A2" } });
    fireEvent.change(screen.getByLabelText("Event"), { target: { value: "coaching_push" } });

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith(
        "/api/learning/analytics?scope=cohort&phase=practice&agent=A2&event=coaching_push",
      );
    });

    fireEvent.click(screen.getByRole("button", { name: "CSV" }));

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith(
        "/api/learning/export?scope=cohort&format=csv&phase=practice&agent=A2&event=coaching_push",
      );
    });
    expect(click).toHaveBeenCalledTimes(1);
    expect(createObjectUrl).toHaveBeenCalledTimes(1);
    expect(revokeObjectUrl).toHaveBeenCalledWith("blob:aais-cohort");
  });
});

function createAnalyticsFixture() {
  return {
    dashboard: {
      cohort: {
        learnerCount: 1,
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
    learners: [
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
