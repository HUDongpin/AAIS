"use client";

import { useMemo, useState } from "react";
import { FileText } from "@phosphor-icons/react";
import type { AaisLearningScaffoldResult } from "@/components/pages/learning/learning-session-client";
import type {
  AaisClientPilotEvidence,
  AaisClientTaskRecord,
} from "@/components/pages/learning/learning-page-types";
import {
  pilotCopy,
  pilotTextMinimumCharacters,
} from "@/components/pages/learning/pilot-learning-copy";
import { PilotReflectionReport } from "@/components/pages/learning/pilot-reflection-report";
import {
  ChoiceCard,
  FieldError,
  getArtifactCharacterCount,
  getCompletionRequirementLabel,
  getRemainingDirectAssists,
  getScaffoldTaskSnapshot,
  getValidReflectionReport,
  InlineMessage,
  isPilotEvidenceConflict,
  localize,
  matchesScaffoldTaskSnapshot,
  type PilotEvidenceDraft,
  type PilotTextRequirement,
  type ScaffoldTaskSnapshot,
  requirementFieldByKind,
  shouldRecordMilestone,
  stageEvidenceKinds,
  toDraft,
} from "@/components/pages/learning/pilot-learning-shared";
import { CompletionGate } from "@/components/pages/learning/pilot-summary-and-completion";
import {
  PilotIncompleteExit,
  PilotScaffoldPanel,
  PilotTaskBrief,
} from "@/components/pages/learning/pilot-task-support";
import type { PilotLearningActions } from "@/components/pages/learning/pilot-learning-types";
import { caasiPilotCoursePackage, type AaisCoursePackageTask } from "@/data/aais-course-packages";
import type { Locale } from "@/data/aais";

type ScaffoldDelivery = {
  after: ScaffoldTaskSnapshot;
  before: ScaffoldTaskSnapshot;
  result: AaisLearningScaffoldResult;
  taskId: string;
};

export function PilotTaskExperience({
  actions,
  artifactText,
  courseTask,
  latestAssistantMessageId,
  locale,
  task,
}: {
  actions: PilotLearningActions;
  artifactText: string;
  courseTask: AaisCoursePackageTask;
  latestAssistantMessageId: string | null;
  locale: Locale;
  task?: AaisClientTaskRecord;
}) {
  const copy = pilotCopy[locale];
  const [draft, setDraft] = useState<PilotEvidenceDraft>(() => toDraft(task?.pilotEvidence));
  const [busy, setBusy] = useState(false);
  const [aiModeBusy, setAiModeBusy] = useState(false);
  const [aiModeError, setAiModeError] = useState("");
  const [aiModeStatus, setAiModeStatus] = useState("");
  const [error, setError] = useState("");
  const [status, setStatus] = useState("");
  const [touchedFields, setTouchedFields] = useState<Set<string>>(() => new Set());
  const [scaffoldDelivery, setScaffoldDelivery] = useState<ScaffoldDelivery | null>(null);
  const [showIncompleteExit, setShowIncompleteExit] = useState(false);
  const [incompleteReason, setIncompleteReason] = useState("");

  const textRequirements = useMemo(() => courseTask.completionRequirements
    .filter((requirement) => requirement.required && requirement.kind !== "artifact")
    .map((requirement) => ({ ...requirement, field: requirementFieldByKind[requirement.kind] }))
    .filter((requirement): requirement is PilotTextRequirement => Boolean(requirement.field)), [courseTask]);
  const hasArtifactRequirement = courseTask.completionRequirements.some((requirement) =>
    requirement.required && requirement.kind === "artifact"
  );
  const hasReflectionRequirement = textRequirements.some((requirement) => requirement.kind === "reflection");
  const taskFourReflectionGate = courseTask.taskId === "practice_task_3" && hasReflectionRequirement;
  const reflectionReport = getValidReflectionReport(task?.reflectionReport);
  const reflectionUnlocked = !taskFourReflectionGate || reflectionReport !== null;
  const preReflectionRequirements = textRequirements.filter((requirement) => requirement.kind !== "reflection");
  const reflectionRequirements = textRequirements.filter((requirement) => requirement.kind === "reflection");
  const visibleTextRequirements = reflectionUnlocked ? textRequirements : preReflectionRequirements;
  const hasArticulationRequirement = textRequirements.some((requirement) => requirement.kind === "articulation");
  const currentScaffoldSnapshot = getScaffoldTaskSnapshot(task);
  const currentScaffoldResult = scaffoldDelivery
    && task?.taskId === scaffoldDelivery.taskId
    && (
      matchesScaffoldTaskSnapshot(currentScaffoldSnapshot, scaffoldDelivery.before)
      || matchesScaffoldTaskSnapshot(currentScaffoldSnapshot, scaffoldDelivery.after)
    )
    ? scaffoldDelivery.result
    : null;
  const remainingDirectAssists = getRemainingDirectAssists(task, currentScaffoldResult);
  const latestScaffold = task?.scaffoldHistory?.at(-1);
  const nextScaffoldLevel = Math.min(4, Math.max(1, 5 - remainingDirectAssists));
  const deliveredScaffoldFading = currentScaffoldResult
    ? currentScaffoldResult.fading === true
    : latestScaffold?.fading === true;
  const deliveredFadingReason = currentScaffoldResult
    ? currentScaffoldResult.fadingReason
    : latestScaffold?.fadingReason;
  const fadingReason = remainingDirectAssists === 0
    ? "direct_assists_exhausted" as const
    : deliveredFadingReason;
  const fading = deliveredScaffoldFading || remainingDirectAssists === 0;
  const incompleteOutcome = courseTask.taskId === "practice_task_1" ? "articulation" as const : "reflection" as const;
  const allowedIncompleteRequirement = incompleteOutcome === "articulation"
    ? "articulate_task_two_process"
    : "reflect_after_task_four";
  const incompleteBlockingReasons = [
    ...(task?.completionMissing ?? [])
      .filter((requirement) => requirement !== allowedIncompleteRequirement)
      .map((requirement) => getCompletionRequirementLabel(requirement, courseTask, locale)),
    ...(courseTask.taskId === "practice_task_3" && !reflectionUnlocked
      ? [copy.reflectionExitLocked]
      : []),
  ].filter((reason, index, reasons) => reasons.indexOf(reason) === index);

  function updateDraft(field: keyof PilotEvidenceDraft, value: string) {
    setDraft((current) => ({ ...current, [field]: value }));
    setStatus("");
    setError("");
  }

  function markTouched(field: string) {
    setTouchedFields((current) => new Set(current).add(field));
  }

  async function persistAiUseMode(
    aiUseMode: "ai-supported" | "ai-free",
    updateSelection = true,
  ) {
    if (!task || busy || aiModeBusy) return;
    if (updateSelection) {
      setDraft((current) => ({
        ...current,
        aiDecision: "",
        aiUseMode,
      }));
    }
    setTouchedFields((current) => new Set(current).add("aiUseMode"));
    setStatus("");
    setError("");
    setAiModeError("");
    setAiModeStatus(copy.aiChoiceSaving);
    setAiModeBusy(true);
    try {
      await actions.onSaveAiUseMode({ aiUseMode, taskId: task.taskId });
      setAiModeStatus(copy.aiChoiceSaved);
    } catch {
      setAiModeStatus("");
      setAiModeError(copy.aiChoiceSaveFailed);
    } finally {
      setAiModeBusy(false);
    }
  }

  function renderTextRequirement(requirement: PilotTextRequirement) {
    const helperPrompts = requirement.kind === "articulation"
      ? caasiPilotCoursePackage.articulation.prompts
      : requirement.kind === "reflection"
        ? caasiPilotCoursePackage.reflection.prompts
        : [];
    const fieldId = `${courseTask.taskId}-${requirement.field}`;
    const invalid = touchedFields.has(requirement.field)
      && getArtifactCharacterCount(draft[requirement.field]) < pilotTextMinimumCharacters;
    return (
      <div key={requirement.id}>
        <label htmlFor={fieldId} className="block text-sm font-semibold leading-6 text-[#303744]">
          {localize(requirement.label, locale)} <span aria-hidden="true" className="text-[#a12f56]">*</span>
        </label>
        {helperPrompts.length ? (
          <ul className="mt-1 list-disc space-y-1 pl-5 text-xs leading-5 text-[#6b7280]">
            {helperPrompts.map((prompt) => <li key={localize(prompt, locale)}>{localize(prompt, locale)}</li>)}
          </ul>
        ) : null}
        <textarea
          id={fieldId}
          required
          aria-invalid={invalid || undefined}
          aria-describedby={invalid ? `${fieldId}-error` : undefined}
          value={draft[requirement.field]}
          onBlur={() => markTouched(requirement.field)}
          onChange={(event) => updateDraft(requirement.field, event.target.value)}
          className="mt-2 min-h-28 w-full resize-y rounded-xl border border-[#cfd4de] bg-white px-4 py-3 text-base leading-6 text-[#202329] outline-none transition placeholder:text-[#9aa0ad] focus:border-[#536de8] focus:ring-2 focus:ring-[#cbd2ff] aria-[invalid=true]:border-[#c94e72] aria-[invalid=true]:ring-2 aria-[invalid=true]:ring-[#f6c8d5]"
        />
        {invalid ? <FieldError id={`${fieldId}-error`}>{copy.responseTooShort}</FieldError> : null}
      </div>
    );
  }

  function createDraftPilotEvidence(options: {
    declinedOutcome?: "articulation" | "reflection";
  } = {}): Partial<AaisClientPilotEvidence> {
    const textEvidence = Object.fromEntries(visibleTextRequirements.flatMap((requirement) => {
      const value = draft[requirement.field].trim();
      return requirement.kind === options.declinedOutcome && !value
        ? []
        : [[requirement.field, value]];
    }));
    return {
      ...textEvidence,
      ...(hasReflectionRequirement
        && reflectionUnlocked
        && (options.declinedOutcome !== "reflection" || draft.expertComparisonText.trim())
        ? { expertComparisonText: draft.expertComparisonText.trim() }
        : {}),
      ...(draft.aiUseMode ? { aiUseMode: draft.aiUseMode } : {}),
      ...(draft.aiUseMode === "ai-free"
        ? { outputEvaluation: "ai_free" as const }
        : draft.aiUseMode === "ai-supported" && draft.aiDecision
          ? { outputEvaluation: draft.aiDecision }
          : {}),
      ...(hasArticulationRequirement && options.declinedOutcome !== "articulation"
        ? { articulationOutcome: draft.articulationText.trim() ? "submitted" as const : "pending" as const }
        : {}),
      ...(hasReflectionRequirement
        && reflectionUnlocked
        && options.declinedOutcome !== "reflection"
        ? { reflectionOutcome: draft.reflectionText.trim() ? "submitted" as const : "pending" as const }
        : {}),
    };
  }

  async function saveEvidence() {
    if (!task || busy || aiModeBusy || aiModeError) return;
    setError("");
    setStatus("");
    const saveTextRequirements = courseTask.taskId === "practice_task_1"
      && getArtifactCharacterCount(draft.articulationText) < pilotTextMinimumCharacters
      ? visibleTextRequirements.filter((requirement) => requirement.kind !== "articulation")
      : visibleTextRequirements;
    setTouchedFields(new Set([
      ...saveTextRequirements.map((requirement) => requirement.field),
      ...(hasReflectionRequirement && reflectionUnlocked ? ["expertComparisonText"] : []),
      "aiUseMode",
      ...(draft.aiUseMode === "ai-supported" ? ["aiDecision"] : []),
    ]));
    const missingRequiredText = saveTextRequirements.some((requirement) =>
      getArtifactCharacterCount(draft[requirement.field]) < pilotTextMinimumCharacters
    );
    const missingExpertComparison = hasReflectionRequirement
      && reflectionUnlocked
      && getArtifactCharacterCount(draft.expertComparisonText) < pilotTextMinimumCharacters;
    if (!draft.aiUseMode || missingRequiredText || missingExpertComparison) {
      setError(copy.responseRequired);
      return;
    }
    if (draft.aiUseMode === "ai-supported" && !draft.aiDecision) {
      setError(copy.responseRequired);
      return;
    }
    if (draft.aiUseMode === "ai-supported" && !latestAssistantMessageId) {
      setError(copy.aiMessageMissing);
      return;
    }
    setBusy(true);
    try {
      const pilotEvidence = createDraftPilotEvidence();
      await actions.onSavePilotEvidence({ taskId: task.taskId, pilotEvidence });
      if (draft.aiUseMode === "ai-supported" && draft.aiDecision) {
        await actions.onRecordAiAcceptance({
          taskId: task.taskId,
          messageId: latestAssistantMessageId!,
          accepted: draft.aiDecision === "accepted",
          reason: draft.outputEvaluationText.trim(),
        });
      }
      for (const milestoneId of courseTask.milestoneIds) {
        if (!shouldRecordMilestone(milestoneId, draft, artifactText)) continue;
        await actions.onRecordStageEvidence({
          taskId: task.taskId,
          stageId: milestoneId,
          evidenceKind: stageEvidenceKinds[milestoneId],
        });
      }
      setStatus(copy.evidenceSaved);
    } catch (caught) {
      setError(isPilotEvidenceConflict(caught)
        ? copy.evidenceConflict
        : caught instanceof Error && caught.message
          ? caught.message
          : copy.actionFailed);
    } finally {
      setBusy(false);
    }
  }

  async function requestScaffold() {
    if (!task || busy) return;
    const before = getScaffoldTaskSnapshot(task);
    setBusy(true);
    setError("");
    setStatus("");
    try {
      const result = await actions.onRequestScaffold({ taskId: task.taskId, toolId: "stage-checklist" });
      const resultTask = result.session.tasks?.find((candidate) => candidate.taskId === task.taskId);
      setScaffoldDelivery({
        after: resultTask
          ? getScaffoldTaskSnapshot(resultTask)
          : {
              requestCount: result.requestCount,
              remainingDirectAssists: result.remainingDirectAssists,
            },
        before,
        result,
        taskId: task.taskId,
      });
      setStatus(copy.scaffoldReady(result.tool.label));
    } catch {
      setError(copy.actionFailed);
    } finally {
      setBusy(false);
    }
  }

  async function endIncomplete() {
    if (
      !task
      || busy
      || aiModeBusy
      || Boolean(aiModeError)
      || incompleteBlockingReasons.length > 0
      || (courseTask.taskId !== "practice_task_1" && courseTask.taskId !== "practice_task_3")
    ) return;
    setBusy(true);
    setError("");
    setStatus("");
    try {
      await actions.onEndIncomplete({
        outcome: incompleteOutcome,
        pilotEvidence: createDraftPilotEvidence({ declinedOutcome: incompleteOutcome }),
        reason: incompleteReason.trim(),
        taskId: task.taskId,
      });
      setShowIncompleteExit(false);
      setStatus(copy.incompleteSaved);
    } catch (caught) {
      setError(caught instanceof Error && caught.message ? caught.message : copy.actionFailed);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="mt-5 space-y-5 border-t border-[#dfe3ec] pt-5">
      <PilotTaskBrief courseTask={courseTask} locale={locale} />
      {task?.status === "active" ? (
        <PilotScaffoldPanel
          busy={busy || aiModeBusy}
          fading={fading}
          fadingReason={fadingReason}
          latestScaffold={latestScaffold}
          locale={locale}
          nextScaffoldLevel={nextScaffoldLevel}
          onRequest={() => { void requestScaffold(); }}
          remainingDirectAssists={remainingDirectAssists}
          result={currentScaffoldResult}
          taskId={task.taskId}
        />
      ) : null}
      <section aria-labelledby={`aais-evidence-${courseTask.taskId}`} className="rounded-xl border border-[#d7dce5] bg-[#fbfbfa] p-4 sm:p-5">
        <h4 id={`aais-evidence-${courseTask.taskId}`} className="text-lg font-semibold leading-7 text-[#202329]">{copy.evidenceHeading}</h4>
        <p className="mt-1 text-sm leading-6 text-[#596170]">{copy.evidenceHelp}</p>
        {hasArtifactRequirement ? (
          <div className="mt-4 rounded-xl border border-[#d7ddff] bg-white p-4">
            <div className="flex items-start gap-3">
              <span className="grid size-11 shrink-0 place-items-center rounded-xl bg-[#eef2ff] text-[#4059d1]">
                <FileText size={22} weight="duotone" aria-hidden="true" />
              </span>
              <div>
                <p className="font-semibold text-[#25304d]">{copy.artifactHeading}</p>
                <p className="mt-1 text-sm leading-6 text-[#596170]">{copy.artifactCount(getArtifactCharacterCount(artifactText))}</p>
              </div>
            </div>
          </div>
        ) : null}
        <fieldset aria-busy={aiModeBusy || undefined} className="mt-5">
          <legend className="text-sm font-semibold text-[#303744]">{copy.aiChoiceLegend}</legend>
          <div className="mt-2 grid gap-2 sm:grid-cols-2">
            <ChoiceCard checked={draft.aiUseMode === "ai-supported"} disabled={!task || busy || aiModeBusy} label={copy.aiSupported} name={`${courseTask.taskId}-ai-mode`} onChange={() => { void persistAiUseMode("ai-supported"); }} value="ai-supported" />
            <ChoiceCard checked={draft.aiUseMode === "ai-free"} disabled={!task || busy || aiModeBusy} label={copy.aiFree} name={`${courseTask.taskId}-ai-mode`} onChange={() => { void persistAiUseMode("ai-free"); }} value="ai-free" />
          </div>
          {touchedFields.has("aiUseMode") && !draft.aiUseMode ? <FieldError>{copy.responseRequired}</FieldError> : null}
          {aiModeStatus ? <div className="mt-2"><InlineMessage kind="success">{aiModeStatus}</InlineMessage></div> : null}
          {aiModeError ? (
            <div className="mt-2 flex flex-wrap items-center gap-3">
              <InlineMessage kind="error">{aiModeError}</InlineMessage>
              <button
                type="button"
                disabled={aiModeBusy || !draft.aiUseMode}
                onClick={() => {
                  if (draft.aiUseMode) void persistAiUseMode(draft.aiUseMode, false);
                }}
                className="inline-flex min-h-11 items-center justify-center rounded-xl border border-[#536de8] bg-white px-4 text-sm font-semibold text-[#4059d1] outline-none transition hover:bg-[#f4f6ff] focus-visible:ring-2 focus-visible:ring-[#536de8] focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-60"
              >
                {copy.aiChoiceRetry}
              </button>
            </div>
          ) : null}
          {draft.aiUseMode === "ai-free" ? (
            <div className="mt-3 rounded-xl border border-[#d7ddff] bg-[#f7f8ff] p-4 text-sm leading-6 text-[#46516c]">
              <p>{copy.aiFreeHelp}</p>
              <ul className="mt-2 list-disc pl-5">
                {caasiPilotCoursePackage.aiFree.resources.map((resource) => <li key={resource.id}>{localize(resource.label, locale)}</li>)}
              </ul>
            </div>
          ) : null}
        </fieldset>
        {taskFourReflectionGate && !reflectionUnlocked ? (
          <div className="mt-5 rounded-xl border border-[#d7ddff] bg-[#f7f8ff] px-4 py-3">
            <p className="font-semibold leading-6 text-[#344ab8]">{copy.preReflectionHeading}</p>
            <p className="mt-1 text-sm leading-6 text-[#596170]">{copy.preReflectionHelp}</p>
          </div>
        ) : null}
        <div className="mt-5 grid gap-5" data-pilot-evidence-form={courseTask.taskId}>
          {preReflectionRequirements.map(renderTextRequirement)}
          {taskFourReflectionGate && reflectionReport ? (
            <PilotReflectionReport courseTask={courseTask} locale={locale} report={reflectionReport} />
          ) : null}
          {reflectionUnlocked ? reflectionRequirements.map(renderTextRequirement) : null}
          {hasReflectionRequirement && reflectionUnlocked ? (
            <div>
              <label htmlFor={`${courseTask.taskId}-expertComparisonText`} className="block text-sm font-semibold leading-6 text-[#303744]">
                {copy.expertComparisonLabel} <span aria-hidden="true" className="text-[#a12f56]">*</span>
              </label>
              <p className="mt-1 text-xs leading-5 text-[#6b7280]">{copy.expertComparisonHelp}</p>
              <textarea
                id={`${courseTask.taskId}-expertComparisonText`}
                required
                aria-invalid={touchedFields.has("expertComparisonText") && getArtifactCharacterCount(draft.expertComparisonText) < pilotTextMinimumCharacters || undefined}
                aria-describedby={touchedFields.has("expertComparisonText") && getArtifactCharacterCount(draft.expertComparisonText) < pilotTextMinimumCharacters ? `${courseTask.taskId}-expertComparisonText-error` : undefined}
                value={draft.expertComparisonText}
                onBlur={() => markTouched("expertComparisonText")}
                onChange={(event) => updateDraft("expertComparisonText", event.target.value)}
                className="mt-2 min-h-28 w-full resize-y rounded-xl border border-[#cfd4de] bg-white px-4 py-3 text-base leading-6 text-[#202329] outline-none transition focus:border-[#536de8] focus:ring-2 focus:ring-[#cbd2ff] aria-[invalid=true]:border-[#c94e72]"
              />
              {touchedFields.has("expertComparisonText") && getArtifactCharacterCount(draft.expertComparisonText) < pilotTextMinimumCharacters ? (
                <FieldError id={`${courseTask.taskId}-expertComparisonText-error`}>{copy.responseTooShort}</FieldError>
              ) : null}
            </div>
          ) : null}
        </div>
        {draft.aiUseMode === "ai-supported" ? (
          <fieldset className="mt-5">
            <legend className="text-sm font-semibold text-[#303744]">{copy.aiDecisionLegend}</legend>
            <div className="mt-2 grid gap-2 sm:grid-cols-2">
              <ChoiceCard checked={draft.aiDecision === "accepted"} label={copy.aiAccepted} name={`${courseTask.taskId}-ai-decision`} onChange={() => updateDraft("aiDecision", "accepted")} value="accepted" />
              <ChoiceCard checked={draft.aiDecision === "revision_required"} label={copy.aiRejected} name={`${courseTask.taskId}-ai-decision`} onChange={() => updateDraft("aiDecision", "revision_required")} value="revision_required" />
            </div>
            {touchedFields.has("aiDecision") && !draft.aiDecision ? <FieldError>{copy.responseRequired}</FieldError> : null}
            {!latestAssistantMessageId ? <p className="mt-3 rounded-lg border border-[#ead8a8] bg-[#fffaf0] px-3 py-2 text-xs font-medium leading-5 text-[#6f5310]">{copy.aiMessageMissing}</p> : null}
          </fieldset>
        ) : null}
        <div className="mt-5 flex flex-wrap items-center gap-3">
          <button
            type="button"
            disabled={!task || busy || aiModeBusy || Boolean(aiModeError) || task.status === "locked"}
            onClick={() => { void saveEvidence(); }}
            className="inline-flex min-h-11 items-center justify-center rounded-xl bg-[#536de8] px-5 text-sm font-semibold text-white outline-none transition hover:bg-[#4059d1] focus-visible:ring-2 focus-visible:ring-[#253fb0] focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:bg-[#d5d9e4] disabled:text-[#586173]"
          >
            {busy ? copy.actionSaving : taskFourReflectionGate && !reflectionUnlocked ? copy.savePreReflectionEvidence : copy.saveEvidence}
          </button>
          {status ? <InlineMessage kind="success">{status}</InlineMessage> : null}
          {error ? <InlineMessage kind="error">{error}</InlineMessage> : null}
        </div>
        {(courseTask.taskId === "practice_task_1" || courseTask.taskId === "practice_task_3") && task?.status === "active" ? (
          <PilotIncompleteExit
            blockingReasons={incompleteBlockingReasons}
            busy={busy || aiModeBusy || Boolean(aiModeError)}
            courseTaskId={courseTask.taskId}
            locale={locale}
            onCancel={() => setShowIncompleteExit(false)}
            onConfirm={() => { void endIncomplete(); }}
            onOpen={() => setShowIncompleteExit(true)}
            onReasonChange={setIncompleteReason}
            outcome={incompleteOutcome}
            reason={incompleteReason}
            show={showIncompleteExit}
          />
        ) : null}
      </section>
      <CompletionGate completionMissing={task?.completionMissing ?? []} courseTask={courseTask} locale={locale} />
    </div>
  );
}
