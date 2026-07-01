"use client";

import { useEffect, useMemo, useState } from "react";
import {
  ArrowsLeftRight,
  ChartLineUp,
  CheckCircle,
  Database,
  ShieldCheck,
  Student,
  WarningCircle,
  UsersThree,
} from "@phosphor-icons/react";
import { Header } from "@/components/layout/header";

type AaisCohortAnalytics = {
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

type AaisCohortLearner = {
  learnerKey: string;
  sessionId: string;
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

type AaisCohortAnalyticsResponse = {
  analytics?: AaisCohortAnalytics;
  error?: string;
};

type CohortFilterState = {
  phase: "all" | "training" | "practice";
  agent: "all" | "A1" | "A2" | "A3" | "A4" | "platform";
  event: "all" | "artifact_saved" | "artifact_edited" | "planning_submitted" | "ai_acceptance_recorded" | "coaching_push" | "scaffold_request" | "self_report_saved";
};

const defaultFilters: CohortFilterState = {
  phase: "all",
  agent: "all",
  event: "all",
};

const emptyAnalytics: AaisCohortAnalytics = {
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

export function TeacherDashboardPage() {
  const [analytics, setAnalytics] = useState<AaisCohortAnalytics | null>(null);
  const [error, setError] = useState("");
  const [filters, setFilters] = useState<CohortFilterState>(defaultFilters);
  const [refreshTick, setRefreshTick] = useState(0);
  const [exportStatus, setExportStatus] = useState("");
  const analyticsUrl = useMemo(() => buildCohortAnalyticsUrl(filters), [filters]);

  useEffect(() => {
    let cancelled = false;

    async function loadCohortAnalytics() {
      try {
        const response = await fetch(analyticsUrl);
        const body = (await response.json()) as AaisCohortAnalyticsResponse;
        if (!response.ok || !body.analytics) {
          throw new Error(response.status === 403
            ? "教师或管理员登录后可查看 cohort dashboard。"
            : body.error ?? "AAIS cohort analytics request failed.");
        }
        if (!cancelled) {
          setAnalytics(selectSafeCohortAnalytics(body.analytics));
          setError("");
        }
      } catch (caught) {
        if (!cancelled) {
          setAnalytics(null);
          setError(caught instanceof Error
            ? caught.message
            : "AAIS cohort analytics request failed.");
        }
      }
    }

    void loadCohortAnalytics();

    return () => {
      cancelled = true;
    };
  }, [analyticsUrl, refreshTick]);

  const safeAnalytics = analytics ?? emptyAnalytics;
  const cohort = safeAnalytics.dashboard.cohort;
  const followUpLearners = useMemo(
    () => safeAnalytics.learners.filter(shouldPrioritizeLearner),
    [safeAnalytics.learners],
  );
  const rows = followUpLearners.length ? followUpLearners : safeAnalytics.learners;

  async function downloadCohortExport(format: "csv" | "json") {
    try {
      const response = await fetch(buildCohortExportUrl(filters, format));
      if (!response.ok) {
        throw new Error("AAIS cohort export failed.");
      }
      const text = await response.text();
      const fileName = parseAttachmentFileName(response.headers.get("content-disposition"))
        ?? `aais-cohort-analytics.${format}`;
      downloadText(fileName, text, format === "csv" ? "text/csv;charset=utf-8" : "application/json;charset=utf-8");
      setExportStatus(format === "csv" ? "CSV 已生成" : "JSON 已生成");
    } catch {
      setExportStatus("Cohort export failed.");
    }
  }

  return (
    <div className="min-h-[100dvh] bg-[var(--background)] text-[var(--foreground)]">
      <Header />
      <main className="mx-auto grid w-full max-w-[1608px] gap-5 px-3 py-6 sm:px-4 lg:px-5 2xl:px-6">
        <section className="rounded-2xl border border-[#dfe7f6] bg-white p-5 shadow-[0_18px_44px_rgba(46,58,91,0.08)] sm:p-6">
          <div className="flex flex-wrap items-start justify-between gap-4">
            <div>
              <p className="text-sm font-semibold text-[#1f6feb]">Cohort learning analytics</p>
              <h1 className="mt-1 text-3xl font-black tracking-normal text-[#171b35]">教师看板</h1>
              <p className="mt-2 max-w-3xl text-sm leading-6 text-[#59657a]">
                聚合训练完成、支架依赖、A2 监督信号、AI 互动和反思证据，帮助教师快速定位需要跟进的学习者。
              </p>
            </div>
            <div className="grid gap-2 rounded-xl border border-[#d8e6fb] bg-[#f8fbff] px-4 py-3 text-sm font-semibold text-[#3f4b69]">
              <span className="inline-flex items-center gap-2">
                <ShieldCheck size={18} weight="duotone" className="text-[#1f6feb]" />
                {safeAnalytics.privacy.actorMode}
              </span>
              <span className="inline-flex items-center gap-2">
                <Database size={18} weight="duotone" className="text-[#1f6feb]" />
                {safeAnalytics.integrations.factLayer}
              </span>
            </div>
          </div>

          {error ? (
            <p className="mt-5 rounded-lg border border-[#f0b7c9] bg-[#fff1f5] px-4 py-3 text-sm font-semibold text-[#a12f56]">
              {error}
            </p>
          ) : null}

          <div className="mt-5 grid gap-3 rounded-xl border border-[#dfe7f6] bg-[#fbfdff] p-3 lg:grid-cols-[repeat(3,minmax(150px,1fr))_auto_auto_auto]">
            <SelectField
              label="Phase"
              value={filters.phase}
              onChange={(value) => setFilters((current) => ({ ...current, phase: value as CohortFilterState["phase"] }))}
              options={[
                ["all", "全部"],
                ["training", "Training"],
                ["practice", "Practice"],
              ]}
            />
            <SelectField
              label="Agent"
              value={filters.agent}
              onChange={(value) => setFilters((current) => ({ ...current, agent: value as CohortFilterState["agent"] }))}
              options={[
                ["all", "全部"],
                ["platform", "Platform"],
                ["A1", "A1"],
                ["A2", "A2"],
                ["A3", "A3"],
                ["A4", "A4"],
              ]}
            />
            <SelectField
              label="Event"
              value={filters.event}
              onChange={(value) => setFilters((current) => ({ ...current, event: value as CohortFilterState["event"] }))}
              options={[
                ["all", "全部"],
                ["coaching_push", "A2 coaching"],
                ["ai_acceptance_recorded", "AI acceptance"],
                ["artifact_saved", "Artifact saved"],
                ["artifact_edited", "Artifact edited"],
                ["planning_submitted", "Planning submitted"],
                ["scaffold_request", "Scaffold"],
                ["self_report_saved", "Self report"],
              ]}
            />
            <button
              type="button"
              onClick={() => setRefreshTick((value) => value + 1)}
              className="inline-flex min-h-11 items-center justify-center gap-2 rounded-lg border border-[#cfe0f5] bg-white px-3 text-sm font-bold text-[#1f6feb] outline-none transition hover:border-[#1f6feb] focus-visible:ring-2 focus-visible:ring-[#1f6feb]"
            >
              <ChartLineUp size={16} weight="duotone" />
              刷新
            </button>
            <button
              type="button"
              onClick={() => void downloadCohortExport("csv")}
              className="inline-flex min-h-11 items-center justify-center gap-2 rounded-lg border border-[#d8e6fb] bg-white px-3 text-sm font-bold text-[#3f4b69] outline-none transition hover:border-[#1f6feb] focus-visible:ring-2 focus-visible:ring-[#1f6feb]"
            >
              <Database size={16} weight="duotone" />
              CSV
            </button>
            <button
              type="button"
              onClick={() => void downloadCohortExport("json")}
              className="inline-flex min-h-11 items-center justify-center gap-2 rounded-lg border border-[#d8e6fb] bg-white px-3 text-sm font-bold text-[#3f4b69] outline-none transition hover:border-[#1f6feb] focus-visible:ring-2 focus-visible:ring-[#1f6feb]"
            >
              <ShieldCheck size={16} weight="duotone" />
              JSON
            </button>
          </div>
          {exportStatus ? (
            <p className="mt-2 text-xs font-bold text-[#4f5873]">{exportStatus}</p>
          ) : null}
        </section>

        <section className="grid gap-3 sm:grid-cols-2 xl:grid-cols-7">
          <MetricTile icon={UsersThree} label="学习者" value={cohort.learnerCount} />
          <MetricTile icon={CheckCircle} label="完成训练" value={cohort.trainingCompleted} />
          <MetricTile icon={Student} label="练习完成数" value={cohort.completedPracticeTasks} />
          <MetricTile icon={ArrowsLeftRight} label="支架请求" value={cohort.scaffoldRequests} />
          <MetricTile icon={WarningCircle} label="A2 监督信号" value={cohort.coachingSignals} />
          <MetricTile icon={ChartLineUp} label="AI 互动" value={cohort.aiInteractions} />
          <MetricTile icon={CheckCircle} label="AI 采纳" value={cohort.aiAcceptanceDecisions} />
        </section>

        <section className="grid gap-5 xl:grid-cols-[minmax(0,1fr)_360px]">
          <div className="rounded-2xl border border-[#dfe7f6] bg-white shadow-[0_18px_44px_rgba(46,58,91,0.08)]">
            <div className="border-b border-[#e9ecf4] px-5 py-4">
              <div className="flex flex-wrap items-center justify-between gap-3">
                <div>
                  <h2 className="text-lg font-black text-[#171b35]">学习者风险队列</h2>
                  <p className="mt-1 text-sm text-[#68708a]">优先显示训练未完成、反思证据不足或 A2 监督信号较多的学习者。</p>
                </div>
                <span className="rounded-full border border-[#d8e6fb] bg-[#f8fbff] px-3 py-1 text-xs font-bold text-[#1f6feb]">
                  {followUpLearners.length || rows.length} 条
                </span>
              </div>
            </div>

            <div className="overflow-x-auto">
              <table className="w-full min-w-[820px] border-collapse text-left text-sm">
                <thead>
                  <tr className="border-b border-[#e9ecf4] bg-[#f8fbff] text-xs uppercase text-[#68708a]">
                    <th className="px-5 py-3 font-bold">Learner</th>
                    <th className="px-4 py-3 font-bold">Training</th>
                    <th className="px-4 py-3 font-bold">Practice</th>
                    <th className="px-4 py-3 font-bold">Scaffold</th>
                    <th className="px-4 py-3 font-bold">A2</th>
                    <th className="px-4 py-3 font-bold">AI</th>
                    <th className="px-4 py-3 font-bold">Reflection</th>
                    <th className="px-5 py-3 font-bold">Action</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.length ? rows.map((learner) => (
                    <tr key={learner.learnerKey} className="border-b border-[#eef2f8] last:border-b-0">
                      <td className="px-5 py-4">
                        <p className="font-bold text-[#222842]">{learner.learnerKey}</p>
                        <p className="mt-1 text-xs text-[#68708a]">{formatUpdatedAt(learner.updatedAt)}</p>
                      </td>
                      <td className="px-4 py-4">
                        <StatusPill tone={learner.trainingCompleted ? "ok" : "risk"}>
                          {learner.trainingCompleted ? "完成" : "未完成"}
                        </StatusPill>
                      </td>
                      <td className="px-4 py-4 font-semibold text-[#303650]">
                        {learner.completedPracticeTasks} / {learner.activePracticeTaskId ?? "未开始"}
                      </td>
                      <td className="px-4 py-4 font-semibold text-[#303650]">{learner.scaffoldRequests} 次</td>
                      <td className="px-4 py-4 font-semibold text-[#303650]">{learner.coachingSignals}</td>
                      <td className="px-4 py-4 font-semibold text-[#303650]">
                        <p>{learner.aiInteractions}</p>
                        <p className="mt-1 text-xs font-bold text-[#68708a]">采纳 {learner.aiAcceptanceDecisions}</p>
                      </td>
                      <td className="px-4 py-4">
                        <StatusPill tone={learner.reflectionStatus === "evidence_present" ? "ok" : "risk"}>
                          {formatReflectionStatus(learner.reflectionStatus)}
                        </StatusPill>
                      </td>
                      <td className="px-5 py-4">
                        <div className="grid gap-2">
                          <StatusPill tone={learner.riskLevel === "low" ? "ok" : "risk"}>
                            {formatRiskLevel(learner.riskLevel)}
                          </StatusPill>
                          {learner.priorityReasons.length ? (
                            <div className="flex max-w-[220px] flex-wrap gap-1">
                              {learner.priorityReasons.map((reason) => (
                                <span
                                  key={reason}
                                  className="rounded-full bg-[#fff8ed] px-2 py-0.5 text-[11px] font-bold leading-5 text-[#8a5a12]"
                                >
                                  {formatPriorityReason(reason)}
                                </span>
                              ))}
                            </div>
                          ) : null}
                        </div>
                      </td>
                    </tr>
                  )) : (
                    <tr>
                      <td className="px-5 py-8 text-sm font-semibold text-[#68708a]" colSpan={8}>
                        暂无 cohort 学习记录。
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
          </div>

          <aside className="grid content-start gap-5">
            <section className="rounded-2xl border border-[#dfe7f6] bg-white p-5 shadow-[0_18px_44px_rgba(46,58,91,0.08)]">
              <h2 className="text-lg font-black text-[#171b35]">风险分层</h2>
              <div className="mt-4 grid gap-3">
                <RiskBand label="高风险" value={cohort.riskBreakdown.high} tone="risk" />
                <RiskBand label="中风险" value={cohort.riskBreakdown.medium} tone="watch" />
                <RiskBand label="低风险" value={cohort.riskBreakdown.low} tone="ok" />
              </div>
            </section>

            <section className="rounded-2xl border border-[#dfe7f6] bg-white p-5 shadow-[0_18px_44px_rgba(46,58,91,0.08)]">
              <h2 className="text-lg font-black text-[#171b35]">数据边界</h2>
              <div className="mt-4 grid gap-3 text-sm leading-6 text-[#4f5873]">
                <p className="rounded-lg border border-[#e1e8f5] bg-[#f8fbff] px-3 py-2">
                  Actor mode: <strong className="text-[#1f6feb]">{safeAnalytics.privacy.actorMode}</strong>
                </p>
                <p className="rounded-lg border border-[#e1e8f5] bg-[#f8fbff] px-3 py-2">
                  Raw prompt storage: <strong className="text-[#1f6feb]">{safeAnalytics.privacy.rawPromptStorage}</strong>
                </p>
                <p className="rounded-lg border border-[#e1e8f5] bg-[#f8fbff] px-3 py-2">
                  Minimum necessary fields: <strong className="text-[#1f6feb]">{String(safeAnalytics.privacy.minimumNecessaryFields)}</strong>
                </p>
              </div>
            </section>

            <section className="rounded-2xl border border-[#dfe7f6] bg-white p-5 shadow-[0_18px_44px_rgba(46,58,91,0.08)]">
              <h2 className="text-lg font-black text-[#171b35]">Join keys</h2>
              <div className="mt-4 flex flex-wrap gap-2">
                {safeAnalytics.integrations.joinKeys.map((key) => (
                  <span
                    key={key}
                    className="rounded-full border border-[#d8e6fb] bg-[#f8fbff] px-3 py-1 text-xs font-bold text-[#1f6feb]"
                  >
                    {key}
                  </span>
                ))}
              </div>
            </section>
          </aside>
        </section>
      </main>
    </div>
  );
}

function selectSafeCohortAnalytics(analytics: AaisCohortAnalytics): AaisCohortAnalytics {
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
      sessionId: learner.sessionId,
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
    integrations: analytics.integrations,
    privacy: analytics.privacy,
  };
}

function buildCohortAnalyticsUrl(filters: CohortFilterState) {
  return buildCohortUrl("/api/learning/analytics", filters);
}

function buildCohortExportUrl(filters: CohortFilterState, format: "csv" | "json") {
  return buildCohortUrl("/api/learning/export", filters, format);
}

function buildCohortUrl(basePath: string, filters: CohortFilterState, format?: "csv" | "json") {
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
  return `${basePath}?${params.toString()}`;
}

function SelectField({
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

function parseAttachmentFileName(disposition: string | null) {
  const match = /filename="([^"]+)"/.exec(disposition ?? "");
  return match?.[1];
}

function downloadText(fileName: string, text: string, contentType: string) {
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

function shouldPrioritizeLearner(learner: AaisCohortLearner) {
  return learner.riskLevel !== "low"
    || !learner.trainingCompleted
    || learner.reflectionStatus !== "evidence_present"
    || learner.coachingSignals > 0;
}

function formatRiskLevel(level: AaisCohortLearner["riskLevel"]) {
  if (level === "high") {
    return "高风险";
  }
  if (level === "medium") {
    return "中风险";
  }
  return "低风险";
}

function formatPriorityReason(reason: string) {
  const labels: Record<string, string> = {
    training_incomplete: "训练未完成",
    reflection_missing: "需补反思",
    a2_coaching_signals: "A2 已触发",
    high_scaffold_dependency: "支架依赖高",
    no_ai_interaction_after_coaching: "需要跟进 AI 使用决策",
  };
  return labels[reason] ?? "需跟进";
}

function formatReflectionStatus(status: string) {
  return status === "evidence_present" ? "证据充分" : "需补反思";
}

function formatUpdatedAt(value: string) {
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

function MetricTile({
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
        <span className="grid size-10 shrink-0 place-items-center rounded-xl bg-[#eef6ff] text-[#1f6feb]">
          <Icon size={22} weight="duotone" />
        </span>
        <p className="text-2xl font-black tracking-normal text-[#171b35]">{value}</p>
      </div>
      <p className="mt-3 text-sm font-bold text-[#4f5873]">{label}</p>
    </article>
  );
}

function StatusPill({
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
          ? "border-[#cfe0f5] bg-[#f8fbff] text-[#1f6feb]"
          : "border-[#f0d5b4] bg-[#fff8ed] text-[#8a5a12]",
      ].join(" ")}
    >
      {children}
    </span>
  );
}

function RiskBand({
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
    watch: "border-[#d8e6fb] bg-[#f8fbff] text-[#1f6feb]",
    ok: "border-[#cfe8dd] bg-[#f4fbf7] text-[#1d6b45]",
  }[tone];
  return (
    <div className={`flex items-center justify-between rounded-lg border px-3 py-2 ${toneClass}`}>
      <span className="text-sm font-bold">{label}</span>
      <span className="text-lg font-black">{value}</span>
    </div>
  );
}
