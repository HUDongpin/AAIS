import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  aaisRecommendationPolicy,
  buildAaisLearnerRecommendations,
  isAaisRecommendationsEnabled,
} from "@/lib/server/aais-recommendations";

describe("AAIS rule-based recommendations", () => {
  it("creates explainable learner recommendations from pseudonymous cohort analytics", () => {
    const result = buildAaisLearnerRecommendations({
      learners: [
        {
          learnerKey: "learner-111111111111",
          sessionKey: "session-111111111111",
          trainingCompleted: false,
          activePracticeTaskId: null,
          completedPracticeTasks: 0,
          scaffoldRequests: 5,
          coachingSignals: 1,
          aiInteractions: 0,
          aiAcceptanceDecisions: 0,
          reflectionStatus: "needs_reflection_evidence",
          riskLevel: "high",
          priorityReasons: [
            "training_incomplete",
            "reflection_missing",
            "a2_coaching_signals",
            "high_scaffold_dependency",
          ],
        },
        {
          learnerKey: "learner-222222222222",
          sessionKey: "session-222222222222",
          trainingCompleted: true,
          activePracticeTaskId: "practice_task_2",
          completedPracticeTasks: 1,
          scaffoldRequests: 1,
          coachingSignals: 0,
          aiInteractions: 2,
          aiAcceptanceDecisions: 1,
          reflectionStatus: "evidence_present",
          riskLevel: "low",
          priorityReasons: [],
        },
      ],
      integrations: {
        factLayer: "aais_events",
      },
    });

    expect(result.policy).toMatchObject({
      version: "aais-rule-recommendations-v1",
      factLayer: "aais_events",
      teacherOverride: true,
    });
    expect(result.recommendations.map((recommendation) => recommendation.ruleId)).toEqual([
      "complete_reflection",
      "complete_training",
      "fade_scaffold",
      "respond_to_coaching",
      "advance_practice",
    ]);
    expect(result.recommendations[0]).toMatchObject({
      id: expect.stringMatching(/^recommendation-[a-f0-9]{12}$/),
      learnerKey: "learner-111111111111",
      sessionKey: "session-111111111111",
      priority: "high",
      reasons: [expect.stringContaining("缺少自我报告")],
    });
    expect(JSON.stringify(result)).not.toContain("S001");
    expect(JSON.stringify(result)).not.toContain("原始学习文本");
  });

  it("documents every teacher-facing recommendation rule", () => {
    const documentation = readFileSync("docs/teacher-recommendation-rules.md", "utf8");

    expect(documentation).toContain(aaisRecommendationPolicy.version);
    for (const ruleId of aaisRecommendationPolicy.rules) {
      expect(documentation).toContain(`\`${ruleId}\``);
    }
    expect(documentation).toContain("recommendation_override_recorded");
    expect(documentation).toContain("pseudonymous");
  });

  it("keeps the recommendation queue feature-flagged on unless explicitly disabled", () => {
    expect(isAaisRecommendationsEnabled({})).toBe(true);
    expect(isAaisRecommendationsEnabled({ AAIS_RECOMMENDATIONS_ENABLED: "true" })).toBe(true);
    expect(isAaisRecommendationsEnabled({ AAIS_RECOMMENDATIONS_ENABLED: "false" })).toBe(false);
    expect(isAaisRecommendationsEnabled({ AAIS_RECOMMENDATIONS_ENABLED: "0" })).toBe(false);
    expect(isAaisRecommendationsEnabled({ AAIS_RECOMMENDATIONS_ENABLED: "off" })).toBe(false);
  });
});
