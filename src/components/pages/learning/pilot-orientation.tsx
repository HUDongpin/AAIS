"use client";

import { useState } from "react";
import { CheckCircle, LockKey, PlayCircle, Sparkle, WarningCircle } from "@phosphor-icons/react";
import type { AaisClientTaskRecord } from "@/components/pages/learning/learning-page-types";
import { pilotCopy } from "@/components/pages/learning/pilot-learning-copy";
import {
  getAggregateMilestoneStatus,
  getMilestoneStatus,
  InfoBlock,
  InlineMessage,
  localize,
  stageEvidenceKinds,
} from "@/components/pages/learning/pilot-learning-shared";
import type { PilotLearningActions } from "@/components/pages/learning/pilot-learning-types";
import { caasiPilotCoursePackage } from "@/data/aais-course-packages";
import type { Locale } from "@/data/aais";

export function PilotFlowOverview({ actions, locale, tasks }: {
  actions: PilotLearningActions;
  locale: Locale;
  tasks: AaisClientTaskRecord[];
}) {
  const copy = pilotCopy[locale];
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const orientationTask = tasks.find((task) => task.taskId === "training_task_1") ?? tasks[0];
  const launchStatus = getAggregateMilestoneStatus(tasks, "launch_import");

  async function acknowledgeOrientation() {
    if (!orientationTask || busy || launchStatus === "completed") return;
    setBusy(true);
    setError("");
    try {
      await actions.onRecordStageEvidence({
        taskId: orientationTask.taskId,
        stageId: "launch_import",
        evidenceKind: stageEvidenceKinds.launch_import,
      });
    } catch {
      setError(copy.actionFailed);
    } finally {
      setBusy(false);
    }
  }

  return (
    <section aria-labelledby="aais-pilot-flow-heading" className="mt-8 space-y-5">
      <div>
        <p className="text-xs font-bold uppercase tracking-[0.12em] text-[#536de8]">{copy.flowEyebrow}</p>
        <h3 id="aais-pilot-flow-heading" className="mt-2 text-xl font-semibold leading-7 text-[#171a21]">{copy.flowHeading}</h3>
        <p className="mt-2 text-[15px] leading-6 text-[#555d69]">
          {localize(caasiPilotCoursePackage.course.description, locale)}
        </p>
      </div>
      {caasiPilotCoursePackage.teacherReview.reviewRequired ? (
        <p role="status" className="flex items-start gap-2 rounded-xl border border-[#ead8a8] bg-[#fffaf0] px-4 py-3 text-sm font-medium leading-6 text-[#6f5310]">
          <WarningCircle className="mt-0.5 shrink-0" size={20} weight="duotone" aria-hidden="true" />
          <span>{copy.teacherReview}</span>
        </p>
      ) : null}
      <ol className="grid gap-3 sm:grid-cols-2">
        {caasiPilotCoursePackage.milestones.map((milestone) => {
          const status = getAggregateMilestoneStatus(tasks, milestone.id);
          const StatusIcon = status === "completed" ? CheckCircle : status === "open" ? PlayCircle : LockKey;
          return (
            <li
              key={milestone.id}
              data-pilot-milestone={milestone.id}
              data-milestone-status={status}
              className="min-w-0 rounded-xl border border-[#d7dce5] bg-white/85 p-4"
            >
              <div className="flex items-start gap-3">
                <span className="grid size-11 shrink-0 place-items-center rounded-xl bg-[#eef2ff] text-[#4059d1]">
                  <StatusIcon size={22} weight={status === "completed" ? "fill" : "duotone"} aria-hidden="true" />
                </span>
                <div className="min-w-0">
                  <p className="text-xs font-bold uppercase tracking-[0.08em] text-[#6b7280]">
                    {milestone.order}. {copy.milestoneStatus[status]}
                  </p>
                  <p className="mt-1 text-base font-semibold leading-6 text-[#202329]">{localize(milestone.label, locale)}</p>
                  <p className="mt-1 text-sm leading-5 text-[#596170]">{localize(milestone.description, locale)}</p>
                </div>
              </div>
            </li>
          );
        })}
      </ol>
      {orientationTask ? (
        <div className="flex flex-wrap items-center gap-3">
          <button
            type="button"
            disabled={busy || launchStatus === "completed"}
            onClick={() => { void acknowledgeOrientation(); }}
            className="inline-flex min-h-11 items-center justify-center rounded-xl bg-[#536de8] px-5 text-sm font-semibold text-white outline-none transition hover:bg-[#4059d1] focus-visible:ring-2 focus-visible:ring-[#253fb0] focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:bg-[#d5d9e4] disabled:text-[#586173]"
          >
            {launchStatus === "completed" ? copy.orientationDone : busy ? copy.actionSaving : copy.orientationAction}
          </button>
          {error ? <InlineMessage kind="error">{error}</InlineMessage> : null}
        </div>
      ) : null}
    </section>
  );
}

export function PilotExpertModel({ actions, locale, task }: {
  actions: PilotLearningActions;
  locale: Locale;
  task?: AaisClientTaskRecord;
}) {
  const copy = pilotCopy[locale];
  const model = caasiPilotCoursePackage.expertModel;
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const status = getMilestoneStatus(task, "modeling");

  async function recordReview() {
    if (!task || busy || status === "completed") return;
    setBusy(true);
    setError("");
    try {
      await actions.onRecordStageEvidence({
        taskId: task.taskId,
        stageId: "modeling",
        evidenceKind: stageEvidenceKinds.modeling,
      });
    } catch {
      setError(copy.actionFailed);
    } finally {
      setBusy(false);
    }
  }

  return (
    <section aria-labelledby="aais-expert-model-heading" className="mt-5 overflow-hidden rounded-2xl border border-[#cbd2ff] bg-white">
      <header className="border-b border-[#dce1ff] bg-[#f4f6ff] px-4 py-4 sm:px-5">
        <div className="flex items-start gap-3">
          <span className="grid size-11 shrink-0 place-items-center rounded-xl bg-[#536de8] text-white">
            <Sparkle size={22} weight="fill" aria-hidden="true" />
          </span>
          <div className="min-w-0">
            <p className="text-xs font-bold uppercase tracking-[0.1em] text-[#4059d1]">{copy.expertSpeaker}</p>
            <h4 id="aais-expert-model-heading" className="mt-1 text-lg font-semibold leading-7 text-[#171a21]">{localize(model.title, locale)}</h4>
          </div>
        </div>
      </header>
      <div className="space-y-6 p-4 sm:p-5">
        <div className="grid gap-3 sm:grid-cols-2">
          <InfoBlock label={copy.expertRole} value={localize(model.role, locale)} />
          <InfoBlock
            label={copy.expertContext}
            value={locale === "zh-CN"
              ? `${localize(model.context.grade, locale)} · ${localize(model.context.topic, locale)} · ${model.context.durationMinutes} 分钟 · ${model.context.totalPoints} 分`
              : `${localize(model.context.grade, locale)} · ${localize(model.context.topic, locale)} · ${model.context.durationMinutes} min · ${model.context.totalPoints} points`}
          />
        </div>
        <section aria-labelledby="aais-expert-dimensions-heading">
          <h5 id="aais-expert-dimensions-heading" className="text-base font-semibold text-[#202329]">{copy.learningDimensions}</h5>
          <div className="mt-3 grid gap-3 sm:grid-cols-3">
            {model.learningDimensions.map((dimension) => (
              <article key={dimension.id} className="rounded-xl border border-[#e0e3ea] bg-[#fbfbfa] p-4">
                <h6 className="font-semibold leading-6 text-[#25304d]">{localize(dimension.label, locale)}</h6>
                <p className="mt-2 text-sm leading-6 text-[#596170]">{localize(dimension.evidence, locale)}</p>
              </article>
            ))}
          </div>
        </section>
        <section aria-labelledby="aais-think-aloud-heading">
          <h5 id="aais-think-aloud-heading" className="text-base font-semibold text-[#202329]">{copy.thinkAloud}</h5>
          <ol className="mt-3 grid gap-3">
            {model.steps.map((step, index) => (
              <li key={step.id} className="flex gap-3 rounded-xl border border-[#e0e3ea] bg-white p-4">
                <span className="grid size-11 shrink-0 place-items-center rounded-full bg-[#eef2ff] text-sm font-bold text-[#4059d1]">{index + 1}</span>
                <div className="min-w-0">
                  <p className="font-semibold leading-6 text-[#202329]">{localize(step.title, locale)}</p>
                  <p className="mt-1 text-sm leading-6 text-[#596170]">{localize(step.thinkAloud, locale)}</p>
                </div>
              </li>
            ))}
          </ol>
        </section>
        <section aria-labelledby="aais-model-prompt-heading">
          <h5 id="aais-model-prompt-heading" className="text-base font-semibold text-[#202329]">{copy.promptTemplate}</h5>
          <p className="mt-3 whitespace-pre-wrap break-words rounded-xl border border-[#d7ddff] bg-[#f7f8ff] p-4 text-sm leading-6 text-[#303744]">
            {localize(model.promptTemplate, locale)}
          </p>
        </section>
        <div className="grid gap-4 lg:grid-cols-2">
          <section aria-labelledby="aais-monitoring-heading" className="rounded-xl border border-[#e0e3ea] p-4">
            <h5 id="aais-monitoring-heading" className="font-semibold text-[#202329]">{copy.monitoring}</h5>
            <div className="mt-3 space-y-4">
              {model.monitoringCheckpoints.map((checkpoint) => (
                <div key={checkpoint.id}>
                  <p className="text-sm font-semibold text-[#4059d1]">{localize(checkpoint.label, locale)}</p>
                  <ul className="mt-2 list-disc space-y-1 pl-5 text-sm leading-6 text-[#596170]">
                    {checkpoint.checks.map((check) => <li key={localize(check, locale)}>{localize(check, locale)}</li>)}
                  </ul>
                </div>
              ))}
            </div>
          </section>
          <section aria-labelledby="aais-rubric-heading" className="rounded-xl border border-[#e0e3ea] p-4">
            <h5 id="aais-rubric-heading" className="font-semibold text-[#202329]">{copy.rubric}</h5>
            <ul className="mt-3 space-y-3">
              {model.rubric.map((criterion) => (
                <li key={criterion.id} className="text-sm leading-6 text-[#596170]">
                  <strong className="text-[#303744]">{localize(criterion.label, locale)}：</strong>
                  {localize(criterion.check, locale)}
                </li>
              ))}
            </ul>
          </section>
        </div>
        <div className="flex flex-wrap items-center gap-3">
          <button
            type="button"
            disabled={!task || busy || status === "completed"}
            onClick={() => { void recordReview(); }}
            className="inline-flex min-h-11 items-center justify-center rounded-xl bg-[#536de8] px-5 text-sm font-semibold text-white outline-none transition hover:bg-[#4059d1] focus-visible:ring-2 focus-visible:ring-[#253fb0] focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:bg-[#d5d9e4] disabled:text-[#586173]"
          >
            {status === "completed" ? copy.expertReviewDone : busy ? copy.actionSaving : copy.expertReviewAction}
          </button>
          {error ? <InlineMessage kind="error">{error}</InlineMessage> : null}
        </div>
      </div>
    </section>
  );
}
