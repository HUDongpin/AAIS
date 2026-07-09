import { createHash } from "node:crypto";

export type AaisRecommendationRuleId =
  | "complete_training"
  | "complete_reflection"
  | "respond_to_coaching"
  | "fade_scaffold"
  | "advance_practice";

export type AaisRecommendationPriority = "high" | "medium" | "low";

export type AaisRecommendationOverrideDecision = "accepted" | "dismissed" | "deferred";

export type AaisLearnerRecommendation = {
  id: string;
  learnerKey: string;
  sessionKey: string;
  ruleId: AaisRecommendationRuleId;
  priority: AaisRecommendationPriority;
  targetTaskId: string | null;
  title: string;
  actionLabel: string;
  reasonCodes: string[];
  reasons: string[];
  profile: {
    riskLevel: string;
    trainingCompleted: boolean;
    scaffoldRequests: number;
    coachingSignals: number;
    aiInteractions: number;
    reflectionStatus: string;
  };
};

type AaisRecommendationAnalytics = {
  learners: AaisRecommendationLearner[];
  integrations: {
    factLayer: string;
  };
};

type AaisRecommendationLearner = {
  learnerKey: string;
  sessionKey?: string;
  sessionId?: string;
  trainingCompleted: boolean;
  activePracticeTaskId: string | null;
  completedPracticeTasks?: number;
  scaffoldRequests: number;
  coachingSignals: number;
  aiInteractions: number;
  aiAcceptanceDecisions?: number;
  reflectionStatus: string;
  riskLevel: "high" | "medium" | "low";
  priorityReasons: string[];
};

export const aaisRecommendationPolicy = {
  version: "aais-rule-recommendations-v1",
  source: "cohort-analytics",
  enabled: true,
  rules: [
    "complete_training",
    "complete_reflection",
    "respond_to_coaching",
    "fade_scaffold",
    "advance_practice",
  ] satisfies AaisRecommendationRuleId[],
  teacherOverride: true,
  privacy: {
    learnerIdentity: "pseudonymous",
    rawLearnerText: "excluded",
  },
};

export function buildAaisLearnerRecommendations(
  analytics: AaisRecommendationAnalytics,
) {
  const recommendations = analytics.learners.flatMap(createLearnerRecommendations);
  return {
    recommendations: recommendations.sort(compareRecommendations),
    policy: {
      ...aaisRecommendationPolicy,
      factLayer: analytics.integrations.factLayer,
    },
    privacy: {
      actorMode: "pseudonymous",
      rawLearnerText: "excluded",
      minimumNecessaryFields: true,
    },
  };
}

export function buildDisabledAaisRecommendations() {
  return {
    recommendations: [],
    policy: {
      ...aaisRecommendationPolicy,
      enabled: false,
      factLayer: "disabled",
    },
    privacy: {
      actorMode: "pseudonymous",
      rawLearnerText: "excluded",
      minimumNecessaryFields: true,
    },
  };
}

export function isAaisRecommendationsEnabled(env: Record<string, string | undefined> = process.env) {
  const configured = env.AAIS_RECOMMENDATIONS_ENABLED?.trim().toLowerCase();
  return configured !== "false" && configured !== "0" && configured !== "off";
}

function createLearnerRecommendations(learner: AaisRecommendationLearner): AaisLearnerRecommendation[] {
  const recommendations: AaisLearnerRecommendation[] = [];
  const targetTaskId = learner.activePracticeTaskId ?? "practice_task_1";

  if (!learner.trainingCompleted) {
    recommendations.push(createRecommendation({
      learner,
      ruleId: "complete_training",
      priority: "high",
      targetTaskId: "training_task_1",
      title: "完成训练任务",
      actionLabel: "安排训练补做",
      reasonCodes: ["training_incomplete"],
      reasons: ["训练任务尚未完成，先补齐专家示范前的基础流程。"],
    }));
  }

  if (learner.reflectionStatus !== "evidence_present") {
    recommendations.push(createRecommendation({
      learner,
      ruleId: "complete_reflection",
      priority: learner.riskLevel === "high" ? "high" : "medium",
      targetTaskId,
      title: "补齐反思证据",
      actionLabel: "提示学生提交反思",
      reasonCodes: ["reflection_missing"],
      reasons: ["缺少自我报告或专家轨迹比较证据，教师可要求学生补充解释过程。"],
    }));
  }

  if (learner.coachingSignals > 0 && learner.aiInteractions === 0) {
    recommendations.push(createRecommendation({
      learner,
      ruleId: "respond_to_coaching",
      priority: learner.riskLevel === "low" ? "medium" : "high",
      targetTaskId,
      title: "跟进 A2 coaching",
      actionLabel: "查看教练提示后的下一步",
      reasonCodes: ["a2_coaching_signals", "no_ai_interaction_after_coaching"],
      reasons: ["A3/A2 已出现 coaching 信号，但学生尚未形成后续 AI 互动或采纳决策。"],
    }));
  }

  if (learner.scaffoldRequests >= 5) {
    recommendations.push(createRecommendation({
      learner,
      ruleId: "fade_scaffold",
      priority: "high",
      targetTaskId,
      title: "降低支架依赖",
      actionLabel: "切换为自检式支架",
      reasonCodes: ["high_scaffold_dependency"],
      reasons: ["支架请求达到自检阈值，下一步应逐步退支架并要求学生说明判断依据。"],
    }));
  }

  if (
    learner.trainingCompleted
    && learner.riskLevel === "low"
    && learner.reflectionStatus === "evidence_present"
  ) {
    recommendations.push(createRecommendation({
      learner,
      ruleId: "advance_practice",
      priority: "low",
      targetTaskId,
      title: "推进下一项练习",
      actionLabel: "保持正常推进",
      reasonCodes: ["low_risk_progress"],
      reasons: ["训练与反思证据稳定，可继续推进下一项练习并观察是否需要轻量提示。"],
    }));
  }

  return recommendations;
}

function createRecommendation(input: {
  learner: AaisRecommendationLearner;
  ruleId: AaisRecommendationRuleId;
  priority: AaisRecommendationPriority;
  targetTaskId: string | null;
  title: string;
  actionLabel: string;
  reasonCodes: string[];
  reasons: string[];
}): AaisLearnerRecommendation {
  const sessionKey = input.learner.sessionKey ?? input.learner.sessionId ?? "session-redacted";
  return {
    id: createRecommendationId(input.learner.learnerKey, sessionKey, input.ruleId, input.targetTaskId),
    learnerKey: input.learner.learnerKey,
    sessionKey,
    ruleId: input.ruleId,
    priority: input.priority,
    targetTaskId: input.targetTaskId,
    title: input.title,
    actionLabel: input.actionLabel,
    reasonCodes: input.reasonCodes,
    reasons: input.reasons,
    profile: {
      riskLevel: input.learner.riskLevel,
      trainingCompleted: input.learner.trainingCompleted,
      scaffoldRequests: input.learner.scaffoldRequests,
      coachingSignals: input.learner.coachingSignals,
      aiInteractions: input.learner.aiInteractions,
      reflectionStatus: input.learner.reflectionStatus,
    },
  };
}

function createRecommendationId(
  learnerKey: string,
  sessionKey: string,
  ruleId: AaisRecommendationRuleId,
  targetTaskId: string | null,
) {
  const hash = createHash("sha256")
    .update([
      "aais-recommendation",
      learnerKey,
      sessionKey,
      ruleId,
      targetTaskId ?? "none",
    ].join(":"))
    .digest("hex")
    .slice(0, 12);
  return `recommendation-${hash}`;
}

function compareRecommendations(
  left: AaisLearnerRecommendation,
  right: AaisLearnerRecommendation,
) {
  return priorityRank(right.priority) - priorityRank(left.priority)
    || left.learnerKey.localeCompare(right.learnerKey)
    || left.ruleId.localeCompare(right.ruleId);
}

function priorityRank(priority: AaisRecommendationPriority) {
  if (priority === "high") {
    return 3;
  }
  if (priority === "medium") {
    return 2;
  }
  return 1;
}
