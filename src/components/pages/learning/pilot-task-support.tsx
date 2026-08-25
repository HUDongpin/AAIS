import { WarningCircle } from "@phosphor-icons/react";
import type { AaisLearningScaffoldResult } from "@/components/pages/learning/learning-session-client";
import type {
  AaisClientScaffoldFadingReason,
  AaisClientScaffoldHistoryEntry,
} from "@/components/pages/learning/learning-page-types";
import { pilotCopy } from "@/components/pages/learning/pilot-learning-copy";
import { localize } from "@/components/pages/learning/pilot-learning-shared";
import type { AaisCoursePackageTask } from "@/data/aais-course-packages";
import type { Locale } from "@/data/aais";

export function PilotTaskBrief({ courseTask, locale }: {
  courseTask: AaisCoursePackageTask;
  locale: Locale;
}) {
  const copy = pilotCopy[locale];
  return (
    <>
      {courseTask.cardNote ? (
        <p className="rounded-xl border border-[#d7ddff] bg-[#f7f8ff] px-4 py-3 text-sm font-semibold leading-6 text-[#4059d1]">
          {localize(courseTask.cardNote, locale)}
        </p>
      ) : null}
      {courseTask.cardSections?.length ? (
        <section aria-label={copy.taskDetails} className="grid gap-3">
          {courseTask.cardSections.map((section) => (
            <article key={section.id} className="min-w-0 rounded-xl border border-[#e0e3ea] bg-white p-4">
              <h4 className="font-semibold leading-6 text-[#202329]">{localize(section.title, locale)}</h4>
              {section.paragraphs?.map((paragraph) => (
                <p key={localize(paragraph, locale)} className="mt-2 whitespace-pre-wrap break-words text-sm leading-6 text-[#596170]">{localize(paragraph, locale)}</p>
              ))}
              {section.bullets?.length ? (
                <ul className="mt-2 list-disc space-y-1 pl-5 text-sm leading-6 text-[#596170]">
                  {section.bullets.map((bullet) => <li key={localize(bullet, locale)}>{localize(bullet, locale)}</li>)}
                </ul>
              ) : null}
            </article>
          ))}
        </section>
      ) : null}
    </>
  );
}

export function PilotScaffoldPanel({
  busy,
  fading,
  fadingReason,
  latestScaffold,
  locale,
  nextScaffoldLevel,
  onRequest,
  remainingDirectAssists,
  result,
  taskId,
}: {
  busy: boolean;
  fading: boolean;
  fadingReason?: AaisClientScaffoldFadingReason;
  latestScaffold?: AaisClientScaffoldHistoryEntry;
  locale: Locale;
  nextScaffoldLevel: number;
  onRequest: () => void;
  remainingDirectAssists: number;
  result: AaisLearningScaffoldResult | null;
  taskId: string;
}) {
  const copy = pilotCopy[locale];
  const deliveredMode = result?.mode ?? latestScaffold?.mode;
  const visibleLevel = deliveredMode === "self-check"
    ? undefined
    : result?.level ?? latestScaffold?.level;
  const statusText = fadingReason === "evidence_improved"
    ? copy.scaffoldEvidenceImproved(remainingDirectAssists)
    : fading
      ? copy.scaffoldFading
      : copy.scaffoldRemaining(remainingDirectAssists);
  const nextAction = fadingReason === "evidence_improved"
    ? copy.scaffoldResumeDirect(nextScaffoldLevel, remainingDirectAssists)
    : fading
      ? copy.scaffoldSelfCheck
      : copy.scaffoldNext(nextScaffoldLevel);
  return (
    <section aria-labelledby={`aais-scaffold-${taskId}`} className="rounded-xl border border-[#cfe0d3] bg-[#f7fcf8] p-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h4 id={`aais-scaffold-${taskId}`} className="font-semibold text-[#214f32]">{copy.scaffoldHeading}</h4>
          <p className="mt-1 text-sm leading-6 text-[#466451]">
            {statusText}
          </p>
        </div>
        {visibleLevel ? (
          <span className="rounded-full border border-[#b9dbc2] bg-white px-3 py-1 text-xs font-bold text-[#28613b]">
            {copy.scaffoldLevel(visibleLevel)}
          </span>
        ) : null}
      </div>
      <button
        type="button"
        disabled={busy}
        onClick={onRequest}
        className="mt-3 inline-flex min-h-11 items-center justify-center rounded-xl border border-[#b9d4c0] bg-white px-4 py-2 text-sm font-semibold leading-5 text-[#285d39] outline-none transition hover:border-[#4d9160] hover:bg-[#f0faf3] focus-visible:ring-2 focus-visible:ring-[#39784b] focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-60"
      >
        {nextAction}
      </button>
      {result ? (
        <div className="mt-3 rounded-lg border border-[#d7e9dc] bg-white px-4 py-3" role="status" aria-live="polite">
          <p className="text-sm font-semibold text-[#285d39]">{result.tool.label}</p>
          <p className="mt-1 whitespace-pre-wrap text-sm leading-6 text-[#4d6554]">{result.tool.body}</p>
        </div>
      ) : null}
    </section>
  );
}

export function PilotIncompleteExit({
  blockingReasons,
  busy,
  courseTaskId,
  locale,
  onCancel,
  onConfirm,
  onOpen,
  onReasonChange,
  outcome,
  reason,
  show,
}: {
  blockingReasons: string[];
  busy: boolean;
  courseTaskId: string;
  locale: Locale;
  onCancel: () => void;
  onConfirm: () => void;
  onOpen: () => void;
  onReasonChange: (reason: string) => void;
  outcome: "articulation" | "reflection";
  reason: string;
  show: boolean;
}) {
  const copy = pilotCopy[locale];
  return (
    <div className="mt-5 border-t border-[#e0e3ea] pt-5">
      {!show ? (
        <button
          type="button"
          disabled={busy}
          onClick={onOpen}
          className="inline-flex min-h-11 items-center justify-center rounded-xl border border-[#c9cfda] bg-white px-5 text-sm font-semibold text-[#555d69] outline-none transition hover:border-[#a12f56] hover:text-[#8f2448] focus-visible:ring-2 focus-visible:ring-[#a12f56] focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-60"
        >
          {copy.incompleteExit}
        </button>
      ) : (
        <div className="rounded-xl border border-[#ead8a8] bg-[#fffaf0] p-4">
          <p className="flex items-start gap-2 text-sm font-semibold leading-6 text-[#6f5310]" role="alert">
            <WarningCircle className="mt-0.5 shrink-0" size={20} weight="duotone" aria-hidden="true" />
            <span>{copy.incompleteWarning(outcome)}</span>
          </p>
          {blockingReasons.length ? (
            <div className="mt-3 rounded-lg border border-[#e2c36c] bg-white px-3 py-2 text-sm leading-6 text-[#6f5310]" role="status">
              <p className="font-semibold">{copy.incompleteBlocked}</p>
              <ul className="mt-1 list-disc pl-5">
                {blockingReasons.map((reason) => <li key={reason}>{reason}</li>)}
              </ul>
            </div>
          ) : null}
          <label htmlFor={`${courseTaskId}-incomplete-reason`} className="mt-4 block text-sm font-semibold text-[#594713]">
            {copy.incompleteReason(outcome)}
          </label>
          <textarea
            id={`${courseTaskId}-incomplete-reason`}
            value={reason}
            onChange={(event) => onReasonChange(event.target.value)}
            className="mt-2 min-h-24 w-full resize-y rounded-xl border border-[#d8c88e] bg-white px-4 py-3 text-base leading-6 text-[#303744] outline-none focus:border-[#9b7a13] focus:ring-2 focus:ring-[#eadca5]"
          />
          <div className="mt-4 flex flex-wrap gap-3">
            <button type="button" disabled={busy || blockingReasons.length > 0} onClick={onConfirm} className="inline-flex min-h-11 items-center justify-center rounded-xl bg-[#8f6d0f] px-5 text-sm font-semibold text-white outline-none transition hover:bg-[#72570c] focus-visible:ring-2 focus-visible:ring-[#594308] focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-60">
              {busy ? copy.actionSaving : copy.confirmIncompleteExit}
            </button>
            <button type="button" disabled={busy} onClick={onCancel} className="inline-flex min-h-11 items-center justify-center rounded-xl border border-[#c9cfda] bg-white px-5 text-sm font-semibold text-[#555d69] outline-none transition hover:border-[#536de8] hover:text-[#4059d1] focus-visible:ring-2 focus-visible:ring-[#536de8] focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-60">
              {copy.cancelIncompleteExit}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
