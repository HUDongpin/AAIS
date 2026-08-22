import { afterEach, describe, expect, it, vi } from "vitest";

afterEach(() => {
  delete process.env.AAIS_RECOMMENDATIONS_ENABLED;
  vi.doUnmock("@/lib/server/aais-learning-store");
  vi.doUnmock("@/lib/server/aais-request-auth");
  vi.doUnmock("@/lib/server/aais-csrf");
  vi.resetModules();
});

describe("AAIS recommendation route request boundaries", () => {
  it("globally prioritizes recommendations before applying bounded pagination", async () => {
    const { route, getEducatorCohortAnalytics } = await loadRecommendationsRoute();
    getEducatorCohortAnalytics.mockResolvedValue({
      learners: [
        ...Array.from({ length: 25 }, (_, index) => ({
          learnerKey: `learner-${String(index).padStart(12, "0")}`,
          sessionKey: `session-${String(index).padStart(12, "0")}`,
          trainingCompleted: true,
          activePracticeTaskId: "practice_task_1",
          scaffoldRequests: 0,
          coachingSignals: 0,
          aiInteractions: 1,
          reflectionStatus: "evidence_present",
          riskLevel: "low" as const,
          priorityReasons: [],
        })),
        {
          learnerKey: "learner-ffffffffffff",
          sessionKey: "session-ffffffffffff",
          trainingCompleted: false,
          activePracticeTaskId: null,
          scaffoldRequests: 0,
          coachingSignals: 0,
          aiInteractions: 0,
          reflectionStatus: "evidence_present",
          riskLevel: "high" as const,
          priorityReasons: ["training_incomplete"],
        },
      ],
      integrations: { factLayer: "aais_events" },
    });

    const response = await route.GET(new Request(
      "http://localhost/api/learning/recommendations?scope=cohort",
    ));

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      recommendations: [
        expect.objectContaining({
          learnerKey: "learner-ffffffffffff",
          priority: "high",
          ruleId: "complete_training",
        }),
        ...Array.from({ length: 24 }, () => expect.any(Object)),
      ],
      pagination: {
        limit: 25,
        returnedRecommendations: 25,
        totalRecommendations: 26,
        hasNextPage: true,
      },
    });
    expect(getEducatorCohortAnalytics).toHaveBeenCalledWith(
      { actorId: "teacher-a", actorRole: "teacher" },
      {},
    );
  });

  it("rejects invalid recommendation pagination before storage access", async () => {
    const { route, getEducatorCohortAnalytics } = await loadRecommendationsRoute();
    const response = await route.GET(new Request(
      "http://localhost/api/learning/recommendations?limit=not-a-number",
    ));

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({
      error: { code: "AAIS_RECOMMENDATION_PAGINATION_INVALID" },
    });
    expect(getEducatorCohortAnalytics).not.toHaveBeenCalled();
  });

  it("rejects an oversized override before invoking storage", async () => {
    const { route, recordRecommendationOverride } = await loadRecommendationsRoute();
    const response = await route.POST(new Request("http://localhost/api/learning/recommendations", {
      method: "POST",
      body: JSON.stringify({
        recommendationId: "recommendation-000000000000",
        learnerKey: "learner-000000000000",
        sessionKey: "session-000000000000",
        ruleId: "rule-a",
        decision: "accepted",
        note: "x".repeat(17 * 1024),
      }),
    }));

    expect(response.status).toBe(413);
    await expect(response.json()).resolves.toMatchObject({
      error: {
        code: "AAIS_RECOMMENDATION_BODY_TOO_LARGE",
        message: "AAIS recommendation request body is too large.",
      },
    });
    expect(recordRecommendationOverride).not.toHaveBeenCalled();
  });

  it("rejects malformed JSON before invoking storage", async () => {
    const { route, recordRecommendationOverride } = await loadRecommendationsRoute();
    const response = await route.POST(new Request("http://localhost/api/learning/recommendations", {
      method: "POST",
      body: "{not-json",
    }));

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({
      error: {
        code: "AAIS_RECOMMENDATION_BODY_INVALID",
        message: "AAIS recommendation request body is invalid.",
      },
    });
    expect(recordRecommendationOverride).not.toHaveBeenCalled();
  });

  it("does not convert an explicit empty target task into a null fallback", async () => {
    const { route, recordRecommendationOverride } = await loadRecommendationsRoute();
    const response = await route.POST(new Request("http://localhost/api/learning/recommendations", {
      method: "POST",
      body: JSON.stringify({
        recommendationId: "recommendation-000000000000",
        learnerKey: "learner-000000000000",
        sessionKey: "session-000000000000",
        ruleId: "rule-a",
        targetTaskId: "",
        decision: "accepted",
      }),
    }));

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({
      error: {
        code: "AAIS_RECOMMENDATION_REQUIRED_FIELD",
      },
    });
    expect(recordRecommendationOverride).not.toHaveBeenCalled();
  });
});

async function loadRecommendationsRoute() {
  const recordRecommendationOverride = vi.fn();
  const getEducatorCohortAnalytics = vi.fn();
  vi.doMock("@/lib/server/aais-learning-store", async () => {
    const actual = await vi.importActual<typeof import("@/lib/server/aais-learning-store")>(
      "@/lib/server/aais-learning-store",
    );
    return {
      ...actual,
      getAaisLearningStore: () => ({
        getEducatorCohortAnalytics,
        recordRecommendationOverride,
      }),
    };
  });
  vi.doMock("@/lib/server/aais-request-auth", () => ({
    isAaisAuthError: () => false,
    requireAaisSessionActor: vi.fn(async () => ({
      id: "teacher-a",
      role: "teacher",
      displayName: "Teacher A",
    })),
  }));
  vi.doMock("@/lib/server/aais-csrf", () => ({
    isAaisCsrfError: () => false,
    requireAaisCsrf: vi.fn(),
  }));
  const route = await import("@/app/api/learning/recommendations/route");
  return {
    route,
    recordRecommendationOverride,
    getEducatorCohortAnalytics,
  };
}
