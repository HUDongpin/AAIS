import { CheckCircle, WarningCircle } from "@phosphor-icons/react";
import type { AaisClientReflectionReport } from "@/components/pages/learning/learning-page-types";
import { pilotCopy } from "@/components/pages/learning/pilot-learning-copy";
import { getEvidenceFieldLabel, localize } from "@/components/pages/learning/pilot-learning-shared";
import { caasiPilotCoursePackage, type AaisCoursePackageTask } from "@/data/aais-course-packages";
import type { Locale } from "@/data/aais";

export function PilotReflectionReport({ courseTask, locale, report }: {
  courseTask: AaisCoursePackageTask;
  locale: Locale;
  report: AaisClientReflectionReport;
}) {
  const copy = pilotCopy[locale];
  const reportStepIds = new Set(report.expertStepIds);
  const comparisons = caasiPilotCoursePackage.expertModel.steps
    .filter((step) => reportStepIds.has(step.id))
    .map((step) => ({
      step,
      comparison: report.comparisons.find((candidate) => candidate.expertStepId === step.id),
    }));
  if (!comparisons.length) return null;
  const structuredCharacters = Object.values(report.evidenceSummary.structuredFieldCharacters)
    .reduce((sum, count) => sum + (Number.isFinite(count) ? Math.max(0, count) : 0), 0);

  return (
    <section
      aria-labelledby={`aais-reflection-report-${courseTask.taskId}`}
      className="rounded-2xl border border-[#cbd2ff] bg-[#f7f8ff] p-4 sm:p-5"
      data-pilot-reflection-report={courseTask.taskId}
    >
      <p className="text-xs font-bold uppercase tracking-[0.1em] text-[#4059d1]">{copy.reportEyebrow}</p>
      <h5 id={`aais-reflection-report-${courseTask.taskId}`} className="mt-1 text-lg font-semibold leading-7 text-[#202329]">{copy.reportHeading}</h5>
      <p className="mt-2 text-sm leading-6 text-[#596170]">{copy.reportBasis}</p>
      <div className="mt-3 flex flex-wrap gap-2 text-xs font-semibold text-[#46516c]">
        <span className="rounded-full border border-[#d7ddff] bg-white px-3 py-1.5">{copy.reportArtifactCount(report.evidenceSummary.artifactCharacters)}</span>
        <span className="rounded-full border border-[#d7ddff] bg-white px-3 py-1.5">{copy.reportStructuredCount(structuredCharacters)}</span>
      </div>
      <ol className="mt-4 grid gap-3">
        {comparisons.map(({ comparison, step }) => {
          const recorded = comparison?.status === "evidence-recorded";
          return (
            <li
              key={step.id}
              className="rounded-xl border border-[#dce1ff] bg-white p-4"
              data-expert-step-id={step.id}
              data-evidence-status={comparison?.status ?? "evidence-missing"}
            >
              <div className="flex items-start gap-3">
                <span className={recorded
                  ? "grid size-11 shrink-0 place-items-center rounded-xl bg-[#e5f5ea] text-[#28613b]"
                  : "grid size-11 shrink-0 place-items-center rounded-xl bg-[#fff2c7] text-[#7a5b0c]"}
                >
                  {recorded
                    ? <CheckCircle size={22} weight="fill" aria-hidden="true" />
                    : <WarningCircle size={22} weight="duotone" aria-hidden="true" />}
                </span>
                <div className="min-w-0 flex-1">
                  <p className="font-semibold leading-6 text-[#25304d]">{localize(step.title, locale)}</p>
                  <p className={recorded ? "mt-1 text-sm font-semibold text-[#28613b]" : "mt-1 text-sm font-semibold text-[#7a5b0c]"}>
                    {recorded ? copy.reportStatusRecorded : copy.reportStatusMissing}
                  </p>
                  {comparison?.evidenceFields.length ? (
                    <p className="mt-2 text-xs leading-5 text-[#596170]">
                      <strong>{copy.reportEvidenceFields}{locale === "zh-CN" ? "：" : ":"}</strong>{" "}
                      {comparison.evidenceFields
                        .map((field) => getEvidenceFieldLabel(field, courseTask, locale))
                        .join(locale === "zh-CN" ? "、" : ", ")}
                    </p>
                  ) : null}
                  {comparison?.recommendedAction ? <p className="mt-2 text-sm leading-6 text-[#596170]">{comparison.recommendedAction}</p> : null}
                </div>
              </div>
            </li>
          );
        })}
      </ol>
      <p className="mt-4 rounded-lg border border-[#badcc5] bg-[#f5fbf7] px-3 py-2 text-sm font-semibold leading-6 text-[#28613b]" role="status">
        {copy.reflectionUnlocked}
      </p>
    </section>
  );
}
