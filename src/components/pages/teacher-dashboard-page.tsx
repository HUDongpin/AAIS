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
import {
  getTeacherDashboardCopy,
  getTeacherRecommendationPresentation,
  type TeacherDashboardCopy,
} from "@/components/pages/teacher-dashboard/teacher-dashboard-copy";
import { getAaisApiErrorMessage } from "@/lib/client/aais-api-error";
import { applyAaisLocaleToDocument } from "@/lib/aais-locale";
import type { Locale } from "@/data/aais";
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
  copy: TeacherDashboardCopy,
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
            ? copy.recommendationsForbidden
            : copy.recommendationsUnavailable,
        ),
        recommendations: [],
      };
    }
    if (!body || !Array.isArray(body.recommendations)) {
      return {
        availability: "unavailable",
        error: copy.recommendationsInvalid,
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
      error: copy.recommendationsNetwork,
      recommendations: [],
    };
  }
}

export function TeacherDashboardPage({ locale = "zh-CN" }: { locale?: Locale }) {
  const copy = getTeacherDashboardCopy(locale);
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
    applyAaisLocaleToDocument(locale);
  }, [locale]);

  useEffect(() => {
    let cancelled = false;

    async function loadCohortAnalytics() {
      setLoading(true);
      setRecommendationsAvailability("loading");
      setRecommendationsError("");
      try {
        const [response, recommendationsResult] = await Promise.all([
          fetch(analyticsUrl),
          loadCohortRecommendations(recommendationsUrl, copy),
        ]);
        const body = (await response.json().catch(() => null)) as AaisCohortAnalyticsResponse | null;
        if (!response.ok || !body?.analytics) {
          throw new Error(response.status === 403
            ? copy.analyticsForbidden
            : getAaisApiErrorMessage(body, copy.analyticsFailed));
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
            : copy.analyticsFailed);
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
  }, [analyticsUrl, copy, recommendationsUrl, refreshTick]);

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
    setExportStatus(format === "csv" ? copy.export.csvStarting : copy.export.jsonStarting);
    try {
      const response = await fetch(buildCohortExportUrl(filters, format));
      if (!response.ok) {
        throw new Error("AAIS cohort export failed.");
      }
      const text = await response.text();
      const fileName = parseAttachmentFileName(response.headers.get("content-disposition"))
        ?? `aais-cohort-analytics.${format}`;
      downloadText(fileName, text, format === "csv" ? "text/csv;charset=utf-8" : "application/json;charset=utf-8");
      setExportStatus(format === "csv" ? copy.export.csvDone : copy.export.jsonDone);
    } catch {
      setExportStatus(copy.export.failed);
    } finally {
      setExportingFormat(null);
    }
  }

  async function recordRecommendationOverride(recommendation: AaisLearnerRecommendation) {
    if (activeOverrideId) {
      return;
    }
    setActiveOverrideId(recommendation.id);
    setOverrideStatus(copy.recommendations.recordingStatus);
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
        throw new Error(getAaisApiErrorMessage(body, copy.recommendations.overrideFailed));
      }
      setRecommendations((current) =>
        current.filter((candidate) => candidate.id !== recommendation.id)
      );
      setOverrideStatus(copy.recommendations.recordedStatus);
    } catch (caught) {
      setOverrideStatus(caught instanceof Error
        ? caught.message
        : copy.recommendations.overrideFailed);
    } finally {
      setActiveOverrideId(null);
    }
  }

  return (
    <div
      className="min-h-[100dvh] min-w-0 bg-[var(--background)] text-[var(--foreground)]"
      data-locale={locale}
      lang={locale}
    >
      <Header locale={locale} />
      <main
        className="mx-auto grid min-w-0 w-full max-w-[1608px] gap-5 px-3 py-6 sm:px-4 lg:px-5 2xl:px-6"
        aria-labelledby="aais-dashboard-heading"
        aria-busy={loading || Boolean(exportingFormat) || Boolean(activeOverrideId)}
      >
        <section className="min-w-0 rounded-2xl border border-[#dfe7f6] bg-white p-5 shadow-[0_18px_44px_rgba(46,58,91,0.08)] sm:p-6">
          <div className="flex flex-wrap items-start justify-between gap-4">
            <div>
              <p className="text-sm font-semibold text-[#1557c0]">{copy.hero.eyebrow}</p>
              <h1
                id="aais-dashboard-heading"
                className="mt-1 text-3xl font-black tracking-normal text-[#171b35]"
              >
                {copy.hero.heading}
              </h1>
              <p className="mt-2 max-w-3xl text-sm leading-6 text-[#59657a]">
                {copy.hero.description}
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
              {copy.loading}
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
              label={copy.filters.phase}
              value={filters.phase}
              onChange={(value) => updateFilter({ ...filters, phase: value as CohortFilterState["phase"] })}
              options={[
                ["all", copy.filters.all],
                ["training", "Training"],
                ["practice", "Practice"],
              ]}
            />
            <SelectField
              label={copy.filters.agent}
              value={filters.agent}
              onChange={(value) => updateFilter({ ...filters, agent: value as CohortFilterState["agent"] })}
              options={[
                ["all", copy.filters.all],
                ["platform", copy.filters.platform],
                ["A1", copy.filters.guide],
                ["A2", copy.filters.professor],
                ["A3", "A3"],
                ["A4", "A4"],
              ]}
            />
            <SelectField
              label={copy.filters.event}
              value={filters.event}
              onChange={(value) => updateFilter({ ...filters, event: value as CohortFilterState["event"] })}
              options={[
                ["all", copy.filters.all],
                ["coaching_push", copy.filters.professorCoaching],
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
              {loading ? copy.controls.refreshing : copy.controls.refresh}
            </button>
            <button
              type="button"
              onClick={() => void downloadCohortExport("csv")}
              disabled={loading || Boolean(exportingFormat)}
              className="inline-flex min-h-11 items-center justify-center gap-2 rounded-lg border border-[#d8e6fb] bg-white px-3 text-sm font-bold text-[#3f4b69] outline-none transition hover:border-[#1f6feb] disabled:cursor-not-allowed disabled:opacity-60 focus-visible:ring-2 focus-visible:ring-[#1f6feb]"
            >
              <Database size={16} weight="duotone" />
              {exportingFormat === "csv" ? copy.controls.csvBusy : "CSV"}
            </button>
            <button
              type="button"
              onClick={() => void downloadCohortExport("json")}
              disabled={loading || Boolean(exportingFormat)}
              className="inline-flex min-h-11 items-center justify-center gap-2 rounded-lg border border-[#d8e6fb] bg-white px-3 text-sm font-bold text-[#3f4b69] outline-none transition hover:border-[#1f6feb] disabled:cursor-not-allowed disabled:opacity-60 focus-visible:ring-2 focus-visible:ring-[#1f6feb]"
            >
              <ShieldCheck size={16} weight="duotone" />
              {exportingFormat === "json" ? copy.controls.jsonBusy : "JSON"}
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

        <section className="grid min-w-0 gap-3 sm:grid-cols-2 xl:grid-cols-7">
          <MetricTile icon={UsersThree} label={copy.metrics.learners} value={cohort.learnerCount} />
          <MetricTile icon={CheckCircle} label={copy.metrics.trainingCompleted} value={cohort.trainingCompleted} />
          <MetricTile icon={Student} label={copy.metrics.practiceCompleted} value={cohort.completedPracticeTasks} />
          <MetricTile icon={ArrowsLeftRight} label={copy.metrics.scaffoldRequests} value={cohort.scaffoldRequests} />
          <MetricTile icon={WarningCircle} label={copy.metrics.coachingSignals} value={cohort.coachingSignals} />
          <MetricTile icon={ChartLineUp} label={copy.metrics.aiInteractions} value={cohort.aiInteractions} />
          <MetricTile icon={CheckCircle} label={copy.metrics.aiAcceptance} value={cohort.aiAcceptanceDecisions} />
        </section>

        <section className="grid min-w-0 gap-5 xl:grid-cols-[minmax(0,1fr)_360px]">
          <div className="min-w-0 max-w-full rounded-2xl border border-[#dfe7f6] bg-white shadow-[0_18px_44px_rgba(46,58,91,0.08)]">
            <div className="border-b border-[#e9ecf4] px-5 py-4">
              <div className="flex flex-wrap items-center justify-between gap-3">
                <div>
                  <h2 className="text-lg font-black text-[#171b35]">{copy.queue.heading}</h2>
                  <p className="mt-1 text-sm text-[#68708a]">{copy.queue.description}</p>
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
                    {copy.controls.previous}
                  </button>
                  <button
                    type="button"
                    onClick={() => setLearnerOffset((value) => value + pagination.limit)}
                    disabled={loading || !pagination.hasNextPage}
                    className="inline-flex min-h-8 items-center rounded-lg border border-[#d8e6fb] bg-white px-3 text-xs font-bold text-[#3f4b69] outline-none transition hover:border-[#1f6feb] disabled:cursor-not-allowed disabled:opacity-45 focus-visible:ring-2 focus-visible:ring-[#1f6feb]"
                  >
                    {copy.controls.next}
                  </button>
                </div>
              </div>
            </div>

            <div
              className="w-full max-w-full overflow-x-auto overscroll-x-contain outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-[#1f6feb]"
              role="region"
              aria-label={`${copy.queue.heading} ${locale === "en-US" ? "table" : "表格"}`}
              tabIndex={0}
            >
              <table className="w-full min-w-[820px] border-collapse text-left text-sm">
                <thead>
                  <tr className="border-b border-[#e9ecf4] bg-[#f8fbff] text-xs uppercase text-[#68708a]">
                    <th className="px-5 py-3 font-bold">{copy.queue.learner}</th>
                    <th className="px-4 py-3 font-bold">{copy.queue.training}</th>
                    <th className="px-4 py-3 font-bold">{copy.queue.practice}</th>
                    <th className="px-4 py-3 font-bold">{copy.queue.scaffold}</th>
                    <th className="px-4 py-3 font-bold">{copy.queue.professor}</th>
                    <th className="px-4 py-3 font-bold">{copy.queue.ai}</th>
                    <th className="px-4 py-3 font-bold">{copy.queue.reflection}</th>
                    <th className="px-5 py-3 font-bold">{copy.queue.action}</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.length ? rows.map((learner) => (
                    <tr key={learner.learnerKey} className="border-b border-[#eef2f8] last:border-b-0">
                      <td className="px-5 py-4">
                        <p className="font-bold text-[#222842]">{learner.learnerKey}</p>
                        <p className="mt-1 text-xs text-[#68708a]">{formatUpdatedAt(learner.updatedAt, locale)}</p>
                      </td>
                      <td className="px-4 py-4">
                        <StatusPill tone={learner.trainingCompleted ? "ok" : "risk"}>
                          {learner.trainingCompleted ? copy.queue.completed : copy.queue.incomplete}
                        </StatusPill>
                      </td>
                      <td className="px-4 py-4 font-semibold text-[#303650]">
                        {learner.completedPracticeTasks} / {learner.activePracticeTaskId ?? copy.queue.notStarted}
                      </td>
                      <td className="px-4 py-4 font-semibold text-[#303650]">
                        {learner.scaffoldRequests} {copy.queue.requestsSuffix}
                      </td>
                      <td className="px-4 py-4 font-semibold text-[#303650]">{learner.coachingSignals}</td>
                      <td className="px-4 py-4 font-semibold text-[#303650]">
                        <p>{learner.aiInteractions}</p>
                        <p className="mt-1 text-xs font-bold text-[#68708a]">
                          {copy.queue.acceptedPrefix} {learner.aiAcceptanceDecisions}
                        </p>
                      </td>
                      <td className="px-4 py-4">
                        <StatusPill tone={learner.reflectionStatus === "evidence_present" ? "ok" : "risk"}>
                          {formatReflectionStatus(learner.reflectionStatus, locale)}
                        </StatusPill>
                      </td>
                      <td className="px-5 py-4">
                        <div className="grid gap-2">
                          <StatusPill tone={learner.riskLevel === "low" ? "ok" : "risk"}>
                            {formatRiskLevel(learner.riskLevel, locale)}
                          </StatusPill>
                          {learner.priorityReasons.length ? (
                            <div className="flex max-w-[220px] flex-wrap gap-1">
                              {learner.priorityReasons.map((reason) => (
                                <span
                                  key={reason}
                                  className="rounded-full bg-[#fff8ed] px-2 py-0.5 text-[11px] font-bold leading-5 text-[#8a5a12]"
                                >
                                  {formatPriorityReason(reason, locale)}
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
                        {copy.queue.empty}
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
          </div>

          <aside className="grid min-w-0 content-start gap-5">
            <section
              className="rounded-2xl border border-[#dfe7f6] bg-white p-5 shadow-[0_18px_44px_rgba(46,58,91,0.08)]"
              aria-busy={Boolean(activeOverrideId)}
            >
              <div className="flex items-center justify-between gap-3">
                <h2 className="text-lg font-black text-[#171b35]">{copy.recommendations.heading}</h2>
                <span className="text-xs font-bold text-[#68708a]">
                  {recommendationsAvailability === "available"
                    ? `${recommendations.length} ${copy.recommendations.itemSuffix}`
                    : recommendationsAvailability === "paused"
                      ? copy.recommendations.pausedBadge
                      : recommendationsAvailability === "unavailable"
                        ? copy.recommendations.unavailableBadge
                        : copy.recommendations.loadingBadge}
                </span>
              </div>
              <div className="mt-4 grid gap-3">
                {recommendationsAvailability === "loading" ? (
                  <p className="text-sm font-semibold leading-6 text-[#68708a]">
                    {copy.recommendations.loading}
                  </p>
                ) : recommendationsAvailability === "unavailable" ? (
                  recommendationsError ? (
                    <p
                      className="rounded-lg border border-[#f0b7c9] bg-[#fff1f5] px-3 py-2 text-sm font-semibold leading-6 text-[#a12f56]"
                      role="alert"
                      aria-label={copy.recommendations.unavailableLabel}
                      aria-live="assertive"
                      aria-atomic="true"
                    >
                      {recommendationsError}
                    </p>
                  ) : null
                ) : recommendationsAvailability === "paused" ? (
                  <p className="text-sm font-semibold leading-6 text-[#68708a]">
                    {copy.recommendations.paused}
                  </p>
                ) : recommendations.length ? recommendations.slice(0, 4).map((recommendation) => {
                  const presentation = getTeacherRecommendationPresentation(recommendation, locale);
                  return (
                  <div key={recommendation.id} className="border-t border-[#edf1f8] pt-3 first:border-t-0 first:pt-0">
                    <div className="flex items-start justify-between gap-3">
                      <div>
                        <p className="text-sm font-black text-[#222842]">{presentation.title}</p>
                        <p className="mt-1 text-xs font-bold text-[#68708a]">{recommendation.learnerKey}</p>
                      </div>
                      <StatusPill tone={recommendation.priority === "low" ? "ok" : "risk"}>
                        {formatRecommendationPriority(recommendation.priority, locale)}
                      </StatusPill>
                    </div>
                    <p className="mt-2 text-sm leading-6 text-[#4f5873]">{presentation.reason}</p>
                    <button
                      type="button"
                      onClick={() => void recordRecommendationOverride(recommendation)}
                      disabled={Boolean(activeOverrideId)}
                      className="mt-3 inline-flex min-h-9 items-center justify-center gap-2 rounded-lg border border-[#d8e6fb] bg-[#f8fbff] px-3 text-xs font-bold text-[#1557c0] outline-none transition hover:border-[#1f6feb] disabled:cursor-not-allowed disabled:opacity-60 focus-visible:ring-2 focus-visible:ring-[#1f6feb]"
                    >
                      <CheckCircle size={14} weight="duotone" />
                      {activeOverrideId === recommendation.id
                        ? copy.recommendations.recording
                        : copy.recommendations.markHandled}
                    </button>
                  </div>
                  );
                }) : (
                  <p className="text-sm font-semibold leading-6 text-[#68708a]">
                    {copy.recommendations.empty}
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
              <h2 className="text-lg font-black text-[#171b35]">{copy.risk.heading}</h2>
              <div className="mt-4 grid gap-3">
                <RiskBand label={copy.risk.high} value={cohort.riskBreakdown.high} tone="risk" />
                <RiskBand label={copy.risk.medium} value={cohort.riskBreakdown.medium} tone="watch" />
                <RiskBand label={copy.risk.low} value={cohort.riskBreakdown.low} tone="ok" />
              </div>
            </section>

            <section className="rounded-2xl border border-[#dfe7f6] bg-white p-5 shadow-[0_18px_44px_rgba(46,58,91,0.08)]">
              <h2 className="text-lg font-black text-[#171b35]">{copy.dataBoundary.heading}</h2>
              <div className="mt-4 grid gap-3 text-sm leading-6 text-[#4f5873]">
                <p className="rounded-lg border border-[#e1e8f5] bg-[#f8fbff] px-3 py-2">
                  {copy.dataBoundary.actorMode}: <strong className="text-[#1557c0]">{safeAnalytics.privacy.actorMode}</strong>
                </p>
                <p className="rounded-lg border border-[#e1e8f5] bg-[#f8fbff] px-3 py-2">
                  {copy.dataBoundary.rawPromptStorage}: <strong className="text-[#1557c0]">{safeAnalytics.privacy.rawPromptStorage}</strong>
                </p>
                <p className="rounded-lg border border-[#e1e8f5] bg-[#f8fbff] px-3 py-2">
                  {copy.dataBoundary.minimumNecessaryFields}: <strong className="text-[#1557c0]">{String(safeAnalytics.privacy.minimumNecessaryFields)}</strong>
                </p>
              </div>
            </section>

            <section className="rounded-2xl border border-[#dfe7f6] bg-white p-5 shadow-[0_18px_44px_rgba(46,58,91,0.08)]">
              <h2 className="text-lg font-black text-[#171b35]">{copy.dataBoundary.joinKeys}</h2>
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
