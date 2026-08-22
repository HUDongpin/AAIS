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
import { getAaisApiErrorMessage } from "@/lib/client/aais-api-error";
import {
  MetricTile,
  RiskBand,
  SelectField,
  StatusPill,
  buildCohortAnalyticsUrl,
  buildCohortExportUrl,
  buildCohortRecommendationsUrl,
  defaultFilters,
  downloadText,
  emptyAnalytics,
  formatPriorityReason,
  formatRecommendationPriority,
  formatReflectionStatus,
  formatRiskLevel,
  formatUpdatedAt,
  getAaisCsrfHeader,
  parseAttachmentFileName,
  selectSafeCohortAnalytics,
  selectSafeRecommendations,
  shouldPrioritizeLearner,
  type AaisCohortAnalytics,
  type AaisCohortAnalyticsResponse,
  type AaisLearnerRecommendation,
  type AaisRecommendationsResponse,
  type CohortFilterState,
} from "@/components/pages/teacher-dashboard/teacher-dashboard-support";

type CohortRecommendationsLoadResult = {
  availability: "available" | "paused" | "unavailable";
  error: string;
  recommendations: AaisLearnerRecommendation[];
};

async function loadCohortRecommendations(
  url: string,
): Promise<CohortRecommendationsLoadResult> {
  try {
    const response = await fetch(url);
    const body = (await response.json().catch(() => null)) as AaisRecommendationsResponse | null;
    if (!response.ok) {
      return {
        availability: "unavailable",
        error: getAaisApiErrorMessage(
          body,
          response.status === 403
            ? "当前账户无权读取推荐跟进。"
            : "推荐跟进暂时不可用，请稍后刷新重试。",
        ),
        recommendations: [],
      };
    }
    if (!body || !Array.isArray(body.recommendations)) {
      return {
        availability: "unavailable",
        error: "推荐跟进响应无效，请稍后刷新重试。",
        recommendations: [],
      };
    }
    if (body.policy?.enabled === false) {
      return {
        availability: "paused",
        error: "",
        recommendations: [],
      };
    }
    return {
      availability: "available",
      error: "",
      recommendations: body.recommendations,
    };
  } catch {
    return {
      availability: "unavailable",
      error: "推荐跟进暂时不可用，请检查网络后刷新重试。",
      recommendations: [],
    };
  }
}

export function TeacherDashboardPage() {
  const [analytics, setAnalytics] = useState<AaisCohortAnalytics | null>(null);
  const [recommendations, setRecommendations] = useState<AaisLearnerRecommendation[]>([]);
  const [recommendationsAvailability, setRecommendationsAvailability] = useState<
    "loading" | "available" | "paused" | "unavailable"
  >("loading");
  const [recommendationsError, setRecommendationsError] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);
  const [filters, setFilters] = useState<CohortFilterState>(defaultFilters);
  const [learnerOffset, setLearnerOffset] = useState(0);
  const [refreshTick, setRefreshTick] = useState(0);
  const [exportingFormat, setExportingFormat] = useState<"csv" | "json" | null>(null);
  const [activeOverrideId, setActiveOverrideId] = useState<string | null>(null);
  const [exportStatus, setExportStatus] = useState("");
  const [overrideStatus, setOverrideStatus] = useState("");
  const learnerPageLimit = 25;
  const analyticsUrl = useMemo(() => buildCohortAnalyticsUrl(filters, {
    limit: learnerPageLimit,
    offset: learnerOffset,
  }), [filters, learnerOffset]);
  const recommendationsUrl = useMemo(() => buildCohortRecommendationsUrl(filters), [filters]);

  useEffect(() => {
    let cancelled = false;

    async function loadCohortAnalytics() {
      setLoading(true);
      setRecommendationsAvailability("loading");
      setRecommendationsError("");
      try {
        const [response, recommendationsResult] = await Promise.all([
          fetch(analyticsUrl),
          loadCohortRecommendations(recommendationsUrl),
        ]);
        const body = (await response.json().catch(() => null)) as AaisCohortAnalyticsResponse | null;
        if (!response.ok || !body?.analytics) {
          throw new Error(response.status === 403
            ? "教师或管理员登录后可查看 cohort dashboard。"
            : getAaisApiErrorMessage(body, "AAIS cohort analytics request failed."));
        }
        if (!cancelled) {
          setAnalytics(selectSafeCohortAnalytics(body.analytics));
          setRecommendations(
            recommendationsResult.availability === "available"
              ? selectSafeRecommendations(recommendationsResult.recommendations)
              : [],
          );
          setRecommendationsAvailability(recommendationsResult.availability);
          setRecommendationsError(recommendationsResult.error);
          setError("");
        }
      } catch (caught) {
        if (!cancelled) {
          setAnalytics(null);
          setRecommendations([]);
          setRecommendationsAvailability("unavailable");
          setRecommendationsError("");
          setError(caught instanceof Error
            ? caught.message
            : "AAIS cohort analytics request failed.");
        }
      } finally {
        if (!cancelled) {
          setLoading(false);
        }
      }
    }

    void loadCohortAnalytics();

    return () => {
      cancelled = true;
    };
  }, [analyticsUrl, recommendationsUrl, refreshTick]);

  const safeAnalytics = analytics ?? emptyAnalytics;
  const cohort = safeAnalytics.dashboard.cohort;
  const pagination = safeAnalytics.pagination ?? {
    limit: learnerPageLimit,
    offset: 0,
    returnedLearners: safeAnalytics.learners.length,
    totalLearners: cohort.learnerCount,
    hasPreviousPage: false,
    hasNextPage: safeAnalytics.learners.length < cohort.learnerCount,
  };
  const followUpLearners = useMemo(
    () => safeAnalytics.learners.filter(shouldPrioritizeLearner),
    [safeAnalytics.learners],
  );
  const rows = followUpLearners.length ? followUpLearners : safeAnalytics.learners;
  const pageStart = pagination.totalLearners ? pagination.offset + 1 : 0;
  const pageEnd = pagination.offset + pagination.returnedLearners;

  function updateFilter(nextFilters: CohortFilterState) {
    setLearnerOffset(0);
    setFilters(nextFilters);
  }

  async function downloadCohortExport(format: "csv" | "json") {
    if (exportingFormat) {
      return;
    }
    setExportingFormat(format);
    setExportStatus(format === "csv" ? "CSV 正在生成..." : "JSON 正在生成...");
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
    } finally {
      setExportingFormat(null);
    }
  }

  async function recordRecommendationOverride(recommendation: AaisLearnerRecommendation) {
    if (activeOverrideId) {
      return;
    }
    setActiveOverrideId(recommendation.id);
    setOverrideStatus("正在记录推荐处理...");
    try {
      const response = await fetch("/api/learning/recommendations", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          ...getAaisCsrfHeader(),
        },
        body: JSON.stringify({
          recommendationId: recommendation.id,
          learnerKey: recommendation.learnerKey,
          sessionKey: recommendation.sessionKey,
          ruleId: recommendation.ruleId,
          targetTaskId: recommendation.targetTaskId,
          decision: "accepted",
        }),
      });
      const body = (await response.json().catch(() => null)) as AaisRecommendationsResponse | null;
      if (!response.ok) {
        throw new Error(getAaisApiErrorMessage(body, "AAIS recommendation override failed."));
      }
      setRecommendations((current) =>
        current.filter((candidate) => candidate.id !== recommendation.id)
      );
      setOverrideStatus("推荐处理已记录");
    } catch (caught) {
      setOverrideStatus(caught instanceof Error
        ? caught.message
        : "AAIS recommendation override failed.");
    } finally {
      setActiveOverrideId(null);
    }
  }

  return (
    <div className="min-h-[100dvh] bg-[var(--background)] text-[var(--foreground)]">
      <Header />
      <main
        className="mx-auto grid w-full max-w-[1608px] gap-5 px-3 py-6 sm:px-4 lg:px-5 2xl:px-6"
        aria-labelledby="aais-dashboard-heading"
        aria-busy={loading || Boolean(exportingFormat) || Boolean(activeOverrideId)}
      >
        <section className="rounded-2xl border border-[#dfe7f6] bg-white p-5 shadow-[0_18px_44px_rgba(46,58,91,0.08)] sm:p-6">
          <div className="flex flex-wrap items-start justify-between gap-4">
            <div>
              <p className="text-sm font-semibold text-[#1557c0]">Cohort learning analytics</p>
              <h1
                id="aais-dashboard-heading"
                className="mt-1 text-3xl font-black tracking-normal text-[#171b35]"
              >
                教师看板
              </h1>
              <p className="mt-2 max-w-3xl text-sm leading-6 text-[#59657a]">
                聚合训练完成、支架依赖、后台监督与教授 coaching 信号、AI 互动和反思证据，帮助教师快速定位需要跟进的学习者。
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

          {loading ? (
            <p
              className="mt-5 rounded-lg border border-[#d8e6fb] bg-[#f8fbff] px-4 py-3 text-sm font-semibold text-[#3f4b69]"
              role="status"
              aria-live="polite"
              aria-atomic="true"
            >
              正在加载 cohort analytics...
            </p>
          ) : null}

          {error ? (
            <p
              className="mt-5 rounded-lg border border-[#f0b7c9] bg-[#fff1f5] px-4 py-3 text-sm font-semibold text-[#a12f56]"
              role="alert"
              aria-live="assertive"
              aria-atomic="true"
            >
              {error}
            </p>
          ) : null}

          <div className="mt-5 grid gap-3 rounded-xl border border-[#dfe7f6] bg-[#fbfdff] p-3 lg:grid-cols-[repeat(3,minmax(150px,1fr))_auto_auto_auto]">
            <SelectField
              label="Phase"
              value={filters.phase}
              onChange={(value) => updateFilter({ ...filters, phase: value as CohortFilterState["phase"] })}
              options={[
                ["all", "全部"],
                ["training", "Training"],
                ["practice", "Practice"],
              ]}
            />
            <SelectField
              label="Agent"
              value={filters.agent}
              onChange={(value) => updateFilter({ ...filters, agent: value as CohortFilterState["agent"] })}
              options={[
                ["all", "全部"],
                ["platform", "Platform"],
                ["A1", "小张"],
                ["A2", "教授"],
                ["A3", "A3"],
                ["A4", "A4"],
              ]}
            />
            <SelectField
              label="Event"
              value={filters.event}
              onChange={(value) => updateFilter({ ...filters, event: value as CohortFilterState["event"] })}
              options={[
                ["all", "全部"],
                ["coaching_push", "教授 coaching"],
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
              disabled={loading}
              className="inline-flex min-h-11 items-center justify-center gap-2 rounded-lg border border-[#cfe0f5] bg-white px-3 text-sm font-bold text-[#1557c0] outline-none transition hover:border-[#1f6feb] disabled:cursor-not-allowed disabled:opacity-60 focus-visible:ring-2 focus-visible:ring-[#1f6feb]"
            >
              <ChartLineUp size={16} weight="duotone" />
              {loading ? "刷新中" : "刷新"}
            </button>
            <button
              type="button"
              onClick={() => void downloadCohortExport("csv")}
              disabled={loading || Boolean(exportingFormat)}
              className="inline-flex min-h-11 items-center justify-center gap-2 rounded-lg border border-[#d8e6fb] bg-white px-3 text-sm font-bold text-[#3f4b69] outline-none transition hover:border-[#1f6feb] disabled:cursor-not-allowed disabled:opacity-60 focus-visible:ring-2 focus-visible:ring-[#1f6feb]"
            >
              <Database size={16} weight="duotone" />
              {exportingFormat === "csv" ? "CSV 生成中" : "CSV"}
            </button>
            <button
              type="button"
              onClick={() => void downloadCohortExport("json")}
              disabled={loading || Boolean(exportingFormat)}
              className="inline-flex min-h-11 items-center justify-center gap-2 rounded-lg border border-[#d8e6fb] bg-white px-3 text-sm font-bold text-[#3f4b69] outline-none transition hover:border-[#1f6feb] disabled:cursor-not-allowed disabled:opacity-60 focus-visible:ring-2 focus-visible:ring-[#1f6feb]"
            >
              <ShieldCheck size={16} weight="duotone" />
              {exportingFormat === "json" ? "JSON 生成中" : "JSON"}
            </button>
          </div>
          {exportStatus ? (
            <p
              className="mt-2 text-xs font-bold text-[#4f5873]"
              role="status"
              aria-live="polite"
              aria-atomic="true"
            >
              {exportStatus}
            </p>
          ) : null}
        </section>

        <section className="grid gap-3 sm:grid-cols-2 xl:grid-cols-7">
          <MetricTile icon={UsersThree} label="学习者" value={cohort.learnerCount} />
          <MetricTile icon={CheckCircle} label="完成训练" value={cohort.trainingCompleted} />
          <MetricTile icon={Student} label="练习完成数" value={cohort.completedPracticeTasks} />
          <MetricTile icon={ArrowsLeftRight} label="支架请求" value={cohort.scaffoldRequests} />
          <MetricTile icon={WarningCircle} label="监督/教授信号" value={cohort.coachingSignals} />
          <MetricTile icon={ChartLineUp} label="AI 互动" value={cohort.aiInteractions} />
          <MetricTile icon={CheckCircle} label="AI 采纳" value={cohort.aiAcceptanceDecisions} />
        </section>

        <section className="grid gap-5 xl:grid-cols-[minmax(0,1fr)_360px]">
          <div className="rounded-2xl border border-[#dfe7f6] bg-white shadow-[0_18px_44px_rgba(46,58,91,0.08)]">
            <div className="border-b border-[#e9ecf4] px-5 py-4">
              <div className="flex flex-wrap items-center justify-between gap-3">
                <div>
                  <h2 className="text-lg font-black text-[#171b35]">学习者风险队列</h2>
                  <p className="mt-1 text-sm text-[#68708a]">优先显示训练未完成、反思证据不足或监督/教授信号较多的学习者。</p>
                </div>
                <div className="flex flex-wrap items-center gap-2">
                  <span className="rounded-full border border-[#d8e6fb] bg-[#f8fbff] px-3 py-1 text-xs font-bold text-[#1557c0]">
                    {pageStart}-{pageEnd} / {pagination.totalLearners}
                  </span>
                  <button
                    type="button"
                    onClick={() => setLearnerOffset((value) => Math.max(0, value - pagination.limit))}
                    disabled={loading || !pagination.hasPreviousPage}
                    className="inline-flex min-h-8 items-center rounded-lg border border-[#d8e6fb] bg-white px-3 text-xs font-bold text-[#3f4b69] outline-none transition hover:border-[#1f6feb] disabled:cursor-not-allowed disabled:opacity-45 focus-visible:ring-2 focus-visible:ring-[#1f6feb]"
                  >
                    上一页
                  </button>
                  <button
                    type="button"
                    onClick={() => setLearnerOffset((value) => value + pagination.limit)}
                    disabled={loading || !pagination.hasNextPage}
                    className="inline-flex min-h-8 items-center rounded-lg border border-[#d8e6fb] bg-white px-3 text-xs font-bold text-[#3f4b69] outline-none transition hover:border-[#1f6feb] disabled:cursor-not-allowed disabled:opacity-45 focus-visible:ring-2 focus-visible:ring-[#1f6feb]"
                  >
                    下一页
                  </button>
                </div>
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
                    <th className="px-4 py-3 font-bold">教授</th>
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
            <section
              className="rounded-2xl border border-[#dfe7f6] bg-white p-5 shadow-[0_18px_44px_rgba(46,58,91,0.08)]"
              aria-busy={Boolean(activeOverrideId)}
            >
              <div className="flex items-center justify-between gap-3">
                <h2 className="text-lg font-black text-[#171b35]">推荐跟进</h2>
                <span className="text-xs font-bold text-[#68708a]">
                  {recommendationsAvailability === "available"
                    ? `${recommendations.length} 条`
                    : recommendationsAvailability === "paused"
                      ? "已暂停"
                      : recommendationsAvailability === "unavailable"
                        ? "不可用"
                        : "加载中"}
                </span>
              </div>
              <div className="mt-4 grid gap-3">
                {recommendationsAvailability === "loading" ? (
                  <p className="text-sm font-semibold leading-6 text-[#68708a]">
                    正在加载规则推荐...
                  </p>
                ) : recommendationsAvailability === "unavailable" ? (
                  recommendationsError ? (
                    <p
                      className="rounded-lg border border-[#f0b7c9] bg-[#fff1f5] px-3 py-2 text-sm font-semibold leading-6 text-[#a12f56]"
                      role="alert"
                      aria-label="推荐跟进不可用"
                      aria-live="assertive"
                      aria-atomic="true"
                    >
                      {recommendationsError}
                    </p>
                  ) : null
                ) : recommendationsAvailability === "paused" ? (
                  <p className="text-sm font-semibold leading-6 text-[#68708a]">
                    规则推荐已暂停。
                  </p>
                ) : recommendations.length ? recommendations.slice(0, 4).map((recommendation) => (
                  <div key={recommendation.id} className="border-t border-[#edf1f8] pt-3 first:border-t-0 first:pt-0">
                    <div className="flex items-start justify-between gap-3">
                      <div>
                        <p className="text-sm font-black text-[#222842]">{recommendation.title}</p>
                        <p className="mt-1 text-xs font-bold text-[#68708a]">{recommendation.learnerKey}</p>
                      </div>
                      <StatusPill tone={recommendation.priority === "low" ? "ok" : "risk"}>
                        {formatRecommendationPriority(recommendation.priority)}
                      </StatusPill>
                    </div>
                    <p className="mt-2 text-sm leading-6 text-[#4f5873]">{recommendation.reasons[0]}</p>
                    <button
                      type="button"
                      onClick={() => void recordRecommendationOverride(recommendation)}
                      disabled={Boolean(activeOverrideId)}
                      className="mt-3 inline-flex min-h-9 items-center justify-center gap-2 rounded-lg border border-[#d8e6fb] bg-[#f8fbff] px-3 text-xs font-bold text-[#1557c0] outline-none transition hover:border-[#1f6feb] disabled:cursor-not-allowed disabled:opacity-60 focus-visible:ring-2 focus-visible:ring-[#1f6feb]"
                    >
                      <CheckCircle size={14} weight="duotone" />
                      {activeOverrideId === recommendation.id ? "记录中..." : "标记已处理"}
                    </button>
                  </div>
                )) : (
                  <p className="text-sm font-semibold leading-6 text-[#68708a]">
                    暂无需要立即跟进的规则建议。
                  </p>
                )}
              </div>
              {overrideStatus ? (
                <p
                  className="mt-3 text-xs font-bold text-[#4f5873]"
                  role="status"
                  aria-live="polite"
                  aria-atomic="true"
                >
                  {overrideStatus}
                </p>
              ) : null}
            </section>

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
                  Actor mode: <strong className="text-[#1557c0]">{safeAnalytics.privacy.actorMode}</strong>
                </p>
                <p className="rounded-lg border border-[#e1e8f5] bg-[#f8fbff] px-3 py-2">
                  Raw prompt storage: <strong className="text-[#1557c0]">{safeAnalytics.privacy.rawPromptStorage}</strong>
                </p>
                <p className="rounded-lg border border-[#e1e8f5] bg-[#f8fbff] px-3 py-2">
                  Minimum necessary fields: <strong className="text-[#1557c0]">{String(safeAnalytics.privacy.minimumNecessaryFields)}</strong>
                </p>
              </div>
            </section>

            <section className="rounded-2xl border border-[#dfe7f6] bg-white p-5 shadow-[0_18px_44px_rgba(46,58,91,0.08)]">
              <h2 className="text-lg font-black text-[#171b35]">Join keys</h2>
              <div className="mt-4 flex flex-wrap gap-2">
                {safeAnalytics.integrations.joinKeys.map((key) => (
                  <span
                    key={key}
                    className="rounded-full border border-[#d8e6fb] bg-[#f8fbff] px-3 py-1 text-xs font-bold text-[#1557c0]"
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
