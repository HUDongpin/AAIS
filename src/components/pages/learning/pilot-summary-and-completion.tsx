"use client";

import { useState } from "react";
import { CheckCircle, WarningCircle } from "@phosphor-icons/react";
import type { AaisClientTaskRecord } from "@/components/pages/learning/learning-page-types";
import { pilotCopy } from "@/components/pages/learning/pilot-learning-copy";
import {
  getCompletionRequirementLabel,
  getMilestoneStatus,
  InlineMessage,
  stageEvidenceKinds,
} from "@/components/pages/learning/pilot-learning-shared";
import type { PilotLearningActions } from "@/components/pages/learning/pilot-learning-types";
import type { AaisCoursePackageTask } from "@/data/aais-course-packages";
import type { Locale } from "@/data/aais";

export function PilotSummaryCard({ actions, locale, task }: {
  actions: PilotLearningActions;
  locale: Locale;
  task: AaisClientTaskRecord;
}) {
  const copy = pilotCopy[locale];
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const complete = getMilestoneStatus(task, "summary_completion") === "completed";
  const endedIncomplete = task.completionOutcome === "ended_incomplete";

  if (endedIncomplete) {
    return (
      <section aria-labelledby="aais-pilot-summary-incomplete-heading" className="mt-5 rounded-2xl border border-[#ead8a8] bg-[#fffaf0] p-5">
        <div className="flex items-start gap-3">
          <span className="grid size-11 shrink-0 place-items-center rounded-xl bg-[#fff2c7] text-[#7a5b0c]">
            <WarningCircle size={23} weight="duotone" aria-hidden="true" />
          </span>
          <div className="min-w-0">
            <h4 id="aais-pilot-summary-incomplete-heading" className="text-lg font-semibold text-[#664d0d]">{copy.summaryIncompleteHeading}</h4>
            <p className="mt-2 text-sm leading-6 text-[#6f5a23]">{copy.summaryIncompleteBody}</p>
          </div>
        </div>
      </section>
    );
  }

  async function acknowledgeSummary() {
    if (busy || complete) return;
    setBusy(true);
    setError("");
    try {
      await actions.onRecordStageEvidence({
        taskId: task.taskId,
        stageId: "summary_completion",
        evidenceKind: stageEvidenceKinds.summary_completion,
      });
    } catch {
      setError(copy.actionFailed);
    } finally {
      setBusy(false);
    }
  }

  return (
    <section
      aria-labelledby="aais-pilot-summary-heading"
      className="mt-5 rounded-2xl border border-[#badcc5] bg-[#f5fbf7] p-5"
      data-pilot-summary={task.taskId}
    >
      <div className="flex items-start gap-3">
        <span className="grid size-11 shrink-0 place-items-center rounded-xl bg-[#e5f5ea] text-[#28613b]">
          <CheckCircle size={23} weight="fill" aria-hidden="true" />
        </span>
        <div className="min-w-0">
          <h4 id="aais-pilot-summary-heading" className="text-lg font-semibold text-[#214f32]">{copy.summaryHeading}</h4>
          <p className="mt-2 text-sm leading-6 text-[#466451]">{copy.summaryBody}</p>
        </div>
      </div>
      <div className="mt-4 flex flex-wrap items-center gap-3">
        <button
          type="button"
          disabled={busy || complete}
          onClick={() => { void acknowledgeSummary(); }}
          className="inline-flex min-h-11 items-center justify-center rounded-xl bg-[#39784b] px-5 text-sm font-semibold text-white outline-none transition hover:bg-[#2d653d] focus-visible:ring-2 focus-visible:ring-[#245432] focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:bg-[#c8ddce] disabled:text-[#31543c]"
        >
          {complete ? copy.summaryDone : busy ? copy.actionSaving : copy.summaryAction}
        </button>
        {error ? <InlineMessage kind="error">{error}</InlineMessage> : null}
      </div>
    </section>
  );
}

export function CompletionGate({ completionMissing, courseTask, locale }: {
  completionMissing: string[];
  courseTask?: AaisCoursePackageTask;
  locale: Locale;
}) {
  const copy = pilotCopy[locale];
  if (!completionMissing.length) {
    return (
      <p className="flex items-center gap-2 rounded-xl border border-[#badcc5] bg-[#f5fbf7] px-4 py-3 text-sm font-semibold text-[#28613b]" role="status" aria-live="polite">
        <CheckCircle size={20} weight="fill" aria-hidden="true" />
        {copy.completionReady}
      </p>
    );
  }
  return (
    <section
      aria-labelledby={`aais-completion-missing-${courseTask?.taskId ?? "task"}`}
      className="rounded-xl border border-[#f0b7c9] bg-[#fff7f9] px-4 py-3"
      role="status"
      aria-live="polite"
    >
      <h4 id={`aais-completion-missing-${courseTask?.taskId ?? "task"}`} className="flex items-center gap-2 text-sm font-semibold text-[#8f2448]">
        <WarningCircle size={20} weight="duotone" aria-hidden="true" />
        {copy.completionHeading}
      </h4>
      <ul className="mt-2 list-disc space-y-1 pl-5 text-sm leading-6 text-[#713148]">
        {completionMissing.map((missing) => <li key={missing}>{getCompletionRequirementLabel(missing, courseTask, locale)}</li>)}
      </ul>
    </section>
  );
}
