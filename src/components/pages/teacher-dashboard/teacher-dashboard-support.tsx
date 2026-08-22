import { UsersThree } from "@phosphor-icons/react";

export type AaisCohortAnalytics = {
  dashboard: {
    cohort: {
      learnerCount: number;
      trainingCompleted: number;
      completedPracticeTasks: number;
      scaffoldRequests: number;
      coachingSignals: number;
      aiInteractions: number;
      aiAcceptanceDecisions: number;
      riskBreakdown: {
        high: number;
        medium: number;
        low: number;
      };
    };
  };
  learners: AaisCohortLearner[];
  pagination?: {
    limit: number;
    offset: number;
    returnedLearners: number;
    totalLearners: number;
    hasPreviousPage: boolean;
    hasNextPage: boolean;
  };
  integrations: {
    factLayer: string;
    joinKeys: string[];
  };
  privacy: {
    actorMode: string;
    rawPromptStorage: string;
    minimumNecessaryFields: boolean;
  };
};

export type AaisCohortLearner = {
  learnerKey: string;
  sessionKey?: string;
  sessionId?: string;
  updatedAt: string;
  trainingCompleted: boolean;
  activePracticeTaskId: string | null;
  completedPracticeTasks: number;
  scaffoldRequests: number;
  coachingSignals: number;
  aiInteractions: number;
  aiAcceptanceDecisions: number;
  reflectionStatus: string;
  riskLevel: "high" | "medium" | "low";
  priorityReasons: string[];
};

export type AaisCohortAnalyticsResponse = {
  analytics?: AaisCohortAnalytics;
  error?: string | {
    code?: string;
    message?: string;
  };
};

export type AaisLearnerRecommendation = {
  id: string;
  learnerKey: string;
  sessionKey: string;
  ruleId: string;
  priority: "high" | "medium" | "low";
  targetTaskId: string | null;
  title: string;
  actionLabel: string;
  reasonCodes: string[];
  reasons: string[];
};

export type AaisRecommendationsResponse = {
  recommendations?: AaisLearnerRecommendation[];
  policy?: {
    enabled?: boolean;
  };
  error?: string | {
    code?: string;
    message?: string;
  };
};

export type CohortFilterState = {
  phase: "all" | "training" | "practice";
  agent: "all" | "A1" | "A2" | "A3" | "A4" | "platform";
  event: "all" | "artifact_saved" | "artifact_edited" | "planning_submitted" | "ai_acceptance_recorded" | "coaching_push" | "scaffold_request" | "self_report_saved";
};

export type CohortPaginationState = {
  limit: number;
  offset: number;
};

export const defaultFilters: CohortFilterState = {
  phase: "all",
  agent: "all",
  event: "all",
};

export const emptyAnalytics: AaisCohortAnalytics = {
  dashboard: {
    cohort: {
      learnerCount: 0,
      trainingCompleted: 0,
      completedPracticeTasks: 0,
      scaffoldRequests: 0,
      coachingSignals: 0,
      aiInteractions: 0,
      aiAcceptanceDecisions: 0,
      riskBreakdown: {
        high: 0,
        medium: 0,
        low: 0,
      },
    },
  },
  learners: [],
  pagination: {
    limit: 25,
    offset: 0,
    returnedLearners: 0,
    totalLearners: 0,
    hasPreviousPage: false,
    hasNextPage: false,
  },
  integrations: {
    factLayer: "lrs",
    joinKeys: [],
  },
  privacy: {
    actorMode: "pseudonymous",
    rawPromptStorage: "excluded_from_lrs",
    minimumNecessaryFields: true,
  },
};

export function selectSafeCohortAnalytics(analytics: AaisCohortAnalytics): AaisCohortAnalytics {
  return {
    dashboard: {
      cohort: {
        ...analytics.dashboard.cohort,
        aiAcceptanceDecisions: analytics.dashboard.cohort.aiAcceptanceDecisions ?? 0,
        riskBreakdown: analytics.dashboard.cohort.riskBreakdown
          ?? emptyAnalytics.dashboard.cohort.riskBreakdown,
      },
    },
    learners: analytics.learners.map((learner) => ({
      learnerKey: learner.learnerKey,
      sessionKey: learner.sessionKey ?? learner.sessionId ?? "session-redacted",
      updatedAt: learner.updatedAt,
      trainingCompleted: learner.trainingCompleted,
      activePracticeTaskId: learner.activePracticeTaskId,
      completedPracticeTasks: learner.completedPracticeTasks,
      scaffoldRequests: learner.scaffoldRequests,
      coachingSignals: learner.coachingSignals,
      aiInteractions: learner.aiInteractions,
      aiAcceptanceDecisions: learner.aiAcceptanceDecisions ?? 0,
      reflectionStatus: learner.reflectionStatus,
      riskLevel: learner.riskLevel ?? "low",
      priorityReasons: Array.isArray(learner.priorityReasons) ? learner.priorityReasons : [],
    })),
    pagination: analytics.pagination ?? {
      limit: analytics.learners.length || 25,
      offset: 0,
      returnedLearners: analytics.learners.length,
      totalLearners: analytics.dashboard.cohort.learnerCount,
      hasPreviousPage: false,
      hasNextPage: analytics.learners.length < analytics.dashboard.cohort.learnerCount,
    },
    integrations: analytics.integrations,
    privacy: analytics.privacy,
  };
}

export function selectSafeRecommendations(recommendations: AaisLearnerRecommendation[]): AaisLearnerRecommendation[] {
  return recommendations
    .filter((recommendation) =>
      /^recommendation-[a-f0-9]{12}$/.test(recommendation.id)
      && /^(?:learner-[a-f0-9]{12}|learner-v2-[a-f0-9]{32})$/.test(recommendation.learnerKey)
      && /^(?:session-[a-f0-9]{12}|session-v2-[a-f0-9]{32})$/.test(recommendation.sessionKey)
    )
    .map((recommendation) => {
      const priority: AaisLearnerRecommendation["priority"] =
        recommendation.priority === "high" || recommendation.priority === "medium"
          ? recommendation.priority
          : "low";
      return {
        id: recommendation.id,
        learnerKey: recommendation.learnerKey,
        sessionKey: recommendation.sessionKey,
        ruleId: recommendation.ruleId,
        priority,
        targetTaskId: recommendation.targetTaskId,
        title: recommendation.title,
        actionLabel: recommendation.actionLabel,
        reasonCodes: Array.isArray(recommendation.reasonCodes) ? recommendation.reasonCodes : [],
        reasons: Array.isArray(recommendation.reasons) ? recommendation.reasons : [],
      };
    });
}

export function buildCohortAnalyticsUrl(filters: CohortFilterState, pagination?: CohortPaginationState) {
  return buildCohortUrl("/api/learning/analytics", filters, undefined, pagination);
}

export function buildCohortRecommendationsUrl(filters: CohortFilterState) {
  void filters;
  return "/api/learning/recommendations?scope=cohort";
}

export function buildCohortExportUrl(filters: CohortFilterState, format: "csv" | "json") {
  return buildCohortUrl("/api/learning/export", filters, format);
}

export function parseAttachmentFileName(disposition: string | null) {
  const match = /filename="([^"]+)"/.exec(disposition ?? "");
  return match?.[1];
}

export function downloadText(fileName: string, text: string, contentType: string) {
  const blob = new Blob([text], { type: contentType });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = fileName;
  document.body.appendChild(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
}

export function shouldPrioritizeLearner(learner: AaisCohortLearner) {
  return learner.riskLevel !== "low"
    || !learner.trainingCompleted
    || learner.reflectionStatus !== "evidence_present"
    || learner.coachingSignals > 0;
}

export function formatRiskLevel(level: AaisCohortLearner["riskLevel"]) {
  if (level === "high") {
    return "高风险";
  }
  if (level === "medium") {
    return "中风险";
  }
  return "低风险";
}

export function formatRecommendationPriority(priority: AaisLearnerRecommendation["priority"]) {
  if (priority === "high") {
    return "高";
  }
  if (priority === "medium") {
    return "中";
  }
  return "低";
}

export function formatPriorityReason(reason: string) {
  const labels: Record<string, string> = {
    training_incomplete: "训练未完成",
    reflection_missing: "需补反思",
    a2_coaching_signals: "监督/教授已触发",
    high_scaffold_dependency: "支架依赖高",
    no_ai_interaction_after_coaching: "需要跟进 AI 使用决策",
  };
  return labels[reason] ?? "需跟进";
}

export function getAaisCsrfHeader(): Record<string, string> {
  const token = readClientCookie("aais_csrf");
  return token ? { "x-aais-csrf": token } : {};
}

export function formatReflectionStatus(status: string) {
  return status === "evidence_present" ? "证据充分" : "需补反思";
}

export function formatUpdatedAt(value: string) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return "更新时间未知";
  }
  return new Intl.DateTimeFormat("zh-HK", {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  }).format(date);
}

export function SelectField({
  label,
  value,
  options,
  onChange,
}: {
  label: string;
  value: string;
  options: Array<[string, string]>;
  onChange: (value: string) => void;
}) {
  return (
    <label className="grid gap-1 text-xs font-bold text-[#4f5873]">
      <span>{label}</span>
      <select
        aria-label={label}
        value={value}
        onChange={(event) => onChange(event.target.value)}
        className="h-11 rounded-lg border border-[#d8e6fb] bg-white px-3 text-sm font-bold text-[#222842] outline-none transition focus:border-[#1f6feb] focus-visible:ring-2 focus-visible:ring-[#1f6feb]"
      >
        {options.map(([optionValue, optionLabel]) => (
          <option key={optionValue} value={optionValue}>
            {optionLabel}
          </option>
        ))}
      </select>
    </label>
  );
}

export function MetricTile({
  icon: Icon,
  label,
  value,
}: {
  icon: typeof UsersThree;
  label: string;
  value: number;
}) {
  return (
    <article className="rounded-2xl border border-[#dfe7f6] bg-white p-4 shadow-[0_18px_44px_rgba(46,58,91,0.08)]">
      <div className="flex items-center justify-between gap-3">
        <span className="grid size-10 shrink-0 place-items-center rounded-xl bg-[#eef6ff] text-[#1557c0]">
          <Icon size={22} weight="duotone" />
        </span>
        <p className="text-2xl font-black tracking-normal text-[#171b35]">{value}</p>
      </div>
      <p className="mt-3 text-sm font-bold text-[#4f5873]">{label}</p>
    </article>
  );
}

export function StatusPill({
  children,
  tone,
}: {
  children: string;
  tone: "ok" | "risk";
}) {
  return (
    <span
      className={[
        "inline-flex min-h-7 items-center rounded-full border px-2.5 py-1 text-xs font-bold",
        tone === "ok"
          ? "border-[#cfe0f5] bg-[#f8fbff] text-[#1557c0]"
          : "border-[#f0d5b4] bg-[#fff8ed] text-[#8a5a12]",
      ].join(" ")}
    >
      {children}
    </span>
  );
}

export function RiskBand({
  label,
  value,
  tone,
}: {
  label: string;
  value: number;
  tone: "risk" | "watch" | "ok";
}) {
  const toneClass = {
    risk: "border-[#f0d5b4] bg-[#fff8ed] text-[#8a5a12]",
    watch: "border-[#d8e6fb] bg-[#f8fbff] text-[#1557c0]",
    ok: "border-[#cfe8dd] bg-[#f4fbf7] text-[#1d6b45]",
  }[tone];
  return (
    <div className={`flex items-center justify-between rounded-lg border px-3 py-2 ${toneClass}`}>
      <span className="text-sm font-bold">{label}</span>
      <span className="text-lg font-black">{value}</span>
    </div>
  );
}

function buildCohortUrl(
  basePath: string,
  filters: CohortFilterState,
  format?: "csv" | "json",
  pagination?: CohortPaginationState,
) {
  const params = new URLSearchParams({
    scope: "cohort",
  });
  if (format) {
    params.set("format", format);
  }
  if (filters.phase !== "all") {
    params.set("phase", filters.phase);
  }
  if (filters.agent !== "all") {
    params.set("agent", filters.agent);
  }
  if (filters.event !== "all") {
    params.set("event", filters.event);
  }
  if (pagination) {
    params.set("limit", String(pagination.limit));
    params.set("offset", String(pagination.offset));
  }
  return `${basePath}?${params.toString()}`;
}

function readClientCookie(name: string) {
  if (typeof document === "undefined") {
    return "";
  }
  try {
    const cookie = document.cookie
      .split(";")
      .map((part) => part.trim())
      .find((part) => part.startsWith(`${name}=`));
    return cookie ? decodeURIComponent(cookie.slice(name.length + 1)) : "";
  } catch {
    return "";
  }
}
