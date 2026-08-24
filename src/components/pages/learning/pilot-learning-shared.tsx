import type { AaisLearningScaffoldResult } from "@/components/pages/learning/learning-session-client";
import type {
  AaisClientPilotEvidence,
  AaisClientReflectionReport,
  AaisClientTaskRecord,
} from "@/components/pages/learning/learning-page-types";
import {
  type AaisCoursePackageTask,
  type AaisPilotLearningMilestoneId,
  type AaisTaskCompletionRequirement,
  type AaisTaskCompletionRequirementKind,
} from "@/data/aais-course-packages";
import type { Locale, LocalizedText } from "@/data/aais";
import { taskFourArtifactMinimumCharacters } from "@/components/pages/learning/pilot-learning-copy";

export type PilotEvidenceTextKey = Extract<
  keyof AaisClientPilotEvidence,
  | "diagnosisText"
  | "revisedPromptText"
  | "outputEvaluationText"
  | "planningText"
  | "monitoringText"
  | "evaluationText"
  | "articulationText"
  | "reflectionText"
  | "expertComparisonText"
>;

export type PilotEvidenceDraft = Record<PilotEvidenceTextKey, string> & {
  aiUseMode: "" | "ai-supported" | "ai-free";
  aiDecision: "" | "accepted" | "revision_required";
};

export type PilotTextRequirement = AaisTaskCompletionRequirement & {
  field: PilotEvidenceTextKey;
};

export const stageEvidenceKinds: Record<AaisPilotLearningMilestoneId, string> = {
  launch_import: "orientation_acknowledged",
  modeling: "expert_model_reviewed",
  coaching_scaffolding: "guided_practice_completed",
  exploration: "artifact_submitted",
  articulation: "strategy_articulated",
  reflection: "reflection_submitted",
  summary_completion: "summary_acknowledged",
};

export const requirementFieldByKind: Partial<
  Record<AaisTaskCompletionRequirementKind, PilotEvidenceTextKey>
> = {
  "prompt-diagnosis": "diagnosisText",
  "prompt-revision": "revisedPromptText",
  "output-evaluation": "outputEvaluationText",
  planning: "planningText",
  monitoring: "monitoringText",
  evaluation: "evaluationText",
  articulation: "articulationText",
  reflection: "reflectionText",
};

export const emptyDraft: PilotEvidenceDraft = {
  diagnosisText: "",
  revisedPromptText: "",
  outputEvaluationText: "",
  planningText: "",
  monitoringText: "",
  evaluationText: "",
  articulationText: "",
  reflectionText: "",
  expertComparisonText: "",
  aiUseMode: "",
  aiDecision: "",
};

export function localize(value: LocalizedText, locale: Locale) {
  return value[locale];
}

export function getMilestoneStatus(
  task: AaisClientTaskRecord | undefined,
  milestoneId: AaisPilotLearningMilestoneId,
): "locked" | "open" | "completed" {
  const record = task?.milestones?.find((milestone) => milestone.id === milestoneId);
  if (record) return record.status;
  if (task?.activeMilestone === milestoneId) return "open";
  if (milestoneId === "launch_import" && task?.status !== "locked") return "open";
  return "locked";
}

export function getAggregateMilestoneStatus(
  tasks: AaisClientTaskRecord[],
  milestoneId: AaisPilotLearningMilestoneId,
): "locked" | "open" | "completed" {
  const statuses = tasks.map((task) => getMilestoneStatus(task, milestoneId));
  if (statuses.includes("completed")) return "completed";
  if (statuses.includes("open")) return "open";
  return "locked";
}

export function getValidReflectionReport(
  report: AaisClientReflectionReport | null | undefined,
) {
  const requiredStepIds = [
    "analyze_task",
    "set_learning_goals",
    "draft_prompt",
    "monitor_generation",
    "evaluate_and_revise",
  ] as const;
  if (
    report?.version !== "aais-a4-reflection-report-v1"
    || report.basis !== "deterministic-field-presence"
    || report.learnerVisibleTurn !== false
    || report.evidenceSummary?.rawTextIncluded !== false
    || !Array.isArray(report.expertStepIds)
    || report.expertStepIds.length !== requiredStepIds.length
    || requiredStepIds.some((stepId) => !report.expertStepIds.includes(stepId))
    || !Array.isArray(report.comparisons)
    || requiredStepIds.some((stepId) => !report.comparisons.some((comparison) =>
      comparison.expertStepId === stepId
      && Array.isArray(comparison.evidenceFields)
      && (comparison.status === "evidence-recorded" || comparison.status === "evidence-missing")
      && typeof comparison.recommendedAction === "string"
    ))
  ) {
    return null;
  }
  return report;
}

export function toDraft(evidence?: AaisClientPilotEvidence): PilotEvidenceDraft {
  return {
    ...emptyDraft,
    diagnosisText: evidence?.diagnosisText ?? "",
    revisedPromptText: evidence?.revisedPromptText ?? "",
    outputEvaluationText: evidence?.outputEvaluationText ?? "",
    planningText: evidence?.planningText ?? "",
    monitoringText: evidence?.monitoringText ?? "",
    evaluationText: evidence?.evaluationText ?? "",
    articulationText: evidence?.articulationText ?? "",
    reflectionText: evidence?.reflectionText ?? "",
    expertComparisonText: evidence?.expertComparisonText ?? "",
    aiUseMode: evidence?.aiUseMode ?? "",
    aiDecision: evidence?.outputEvaluation === "accepted"
      ? "accepted"
      : evidence?.outputEvaluation === "revision_required"
        ? "revision_required"
        : "",
  };
}

export function shouldRecordMilestone(
  milestoneId: AaisPilotLearningMilestoneId,
  draft: PilotEvidenceDraft,
  artifactText: string,
) {
  if (milestoneId === "coaching_scaffolding") {
    return getArtifactCharacterCount(draft.diagnosisText) >= 8
      && getArtifactCharacterCount(draft.revisedPromptText) >= 8
      && getArtifactCharacterCount(draft.outputEvaluationText) >= 8;
  }
  if (milestoneId === "exploration") {
    return getArtifactCharacterCount(artifactText) >= taskFourArtifactMinimumCharacters;
  }
  if (milestoneId === "articulation") {
    return getArtifactCharacterCount(draft.articulationText) >= 8;
  }
  if (milestoneId === "reflection") {
    return getArtifactCharacterCount(draft.reflectionText) >= 8
      && getArtifactCharacterCount(draft.expertComparisonText) >= 8;
  }
  return false;
}

export function isPilotEvidenceConflict(error: unknown) {
  const code = error && typeof error === "object" && "code" in error
    ? (error as { code?: unknown }).code
    : null;
  return code === "AAIS_PILOT_EVIDENCE_REVISION_CONFLICT"
    || code === "AAIS_MUTATION_ID_CONFLICT";
}

export function getRemainingDirectAssists(
  task: AaisClientTaskRecord | undefined,
  result: AaisLearningScaffoldResult | null,
) {
  const latest = task?.scaffoldHistory?.at(-1);
  const serverRemaining = result?.remainingDirectAssists
    ?? task?.scaffoldState?.remainingDirectAssists
    ?? latest?.remainingDirectAssists;
  if (Number.isSafeInteger(serverRemaining) && Number(serverRemaining) >= 0) {
    return Number(serverRemaining);
  }
  return Math.max(0, 4 - Math.max(0, task?.scaffoldRequests ?? 0));
}

export function getArtifactCharacterCount(value: string) {
  const decoded = value
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&(?:nbsp|ensp|emsp|thinsp);/gi, " ")
    .replace(/&#(?:x[0-9a-f]+|\d+);/gi, (entity) => decodeNumericEntity(entity))
    .replace(/&(amp|lt|gt|quot|apos);/gi, (_, name: string) => ({
      amp: "&",
      lt: "<",
      gt: ">",
      quot: "\"",
      apos: "'",
    })[name.toLowerCase()] ?? " ")
    .replace(/&[a-z][a-z0-9]+;/gi, " ")
    .replace(/[\s\u200B-\u200D\uFEFF]/gu, "");
  return Array.from(decoded).length;
}

function decodeNumericEntity(entity: string) {
  const hex = entity.toLowerCase().startsWith("&#x");
  const parsed = Number.parseInt(entity.slice(hex ? 3 : 2, -1), hex ? 16 : 10);
  if (!Number.isSafeInteger(parsed) || parsed < 0 || parsed > 0x10ffff) return " ";
  try {
    return String.fromCodePoint(parsed);
  } catch {
    return " ";
  }
}

export function getCompletionRequirementLabel(
  missing: string,
  courseTask: AaisCoursePackageTask | undefined,
  locale: Locale,
) {
  const trainingLabels: Record<string, LocalizedText> = {
    orientation_acknowledged: {
      "zh-CN": "确认启动说明与学习流程",
      "en-US": "Acknowledge the orientation and learning flow",
    },
    expert_model_reviewed: {
      "zh-CN": "阅读并比较教授的专家示范",
      "en-US": "Review and compare the Professor's expert model",
    },
  };
  if (trainingLabels[missing]) return localize(trainingLabels[missing], locale);
  const direct = courseTask?.completionRequirements.find((requirement) =>
    requirement.id === missing || requirement.kind === missing
  );
  if (direct) return localize(direct.label, locale);
  const normalized = missing.replaceAll("_", " ").replaceAll("-", " ");
  return normalized.charAt(0).toUpperCase() + normalized.slice(1);
}

export function getEvidenceFieldLabel(
  field: string,
  courseTask: AaisCoursePackageTask,
  locale: Locale,
) {
  if (field === "artifact" || field === "artifactText") {
    const artifactRequirement = courseTask.completionRequirements.find((requirement) =>
      requirement.kind === "artifact"
    );
    if (artifactRequirement) return localize(artifactRequirement.label, locale);
  }
  const requirement = courseTask.completionRequirements.find((candidate) =>
    candidate.id === field || requirementFieldByKind[candidate.kind] === field
  );
  if (requirement) return localize(requirement.label, locale);
  const fallbackLabels: Partial<Record<PilotEvidenceTextKey, LocalizedText>> = {
    diagnosisText: { "zh-CN": "原提示词诊断", "en-US": "Original-prompt diagnosis" },
    revisedPromptText: { "zh-CN": "修改版提示词", "en-US": "Revised prompt" },
    outputEvaluationText: { "zh-CN": "生成结果评价", "en-US": "Generated-output evaluation" },
    planningText: { "zh-CN": "规划记录", "en-US": "Planning record" },
    monitoringText: { "zh-CN": "监控记录", "en-US": "Monitoring record" },
    evaluationText: { "zh-CN": "评价记录", "en-US": "Evaluation record" },
    articulationText: { "zh-CN": "学习过程表达", "en-US": "Learning-process articulation" },
    reflectionText: { "zh-CN": "反思记录", "en-US": "Reflection record" },
    expertComparisonText: { "zh-CN": "与专家过程比较", "en-US": "Expert-process comparison" },
  };
  const fallback = fallbackLabels[field as PilotEvidenceTextKey];
  if (fallback) return localize(fallback, locale);
  const normalized = field.replaceAll("_", " ").replaceAll(/([a-z])([A-Z])/g, "$1 $2");
  return normalized.charAt(0).toUpperCase() + normalized.slice(1);
}

export function ChoiceCard({ checked, disabled = false, label, name, onChange, value }: {
  checked: boolean;
  disabled?: boolean;
  label: string;
  name: string;
  onChange: () => void;
  value: string;
}) {
  return (
    <label className="flex min-h-11 cursor-pointer items-center gap-3 rounded-xl border border-[#cfd4de] bg-white px-4 py-2 text-sm font-semibold leading-5 text-[#303744] outline-none transition has-[:checked]:border-[#536de8] has-[:checked]:bg-[#f4f6ff] has-[:disabled]:cursor-not-allowed has-[:disabled]:opacity-60 has-[:focus-visible]:ring-2 has-[:focus-visible]:ring-[#536de8] has-[:focus-visible]:ring-offset-2">
      <input type="radio" checked={checked} disabled={disabled} name={name} value={value} onChange={onChange} className="size-5 shrink-0 accent-[#536de8]" />
      <span>{label}</span>
    </label>
  );
}

export function FieldError({ children, id }: { children: string; id?: string }) {
  return <p id={id} className="mt-1 text-xs font-semibold leading-5 text-[#a12f56]" role="alert">{children}</p>;
}

export function InlineMessage({ children, kind }: { children: string; kind: "error" | "success" }) {
  return (
    <p
      className={kind === "error" ? "text-sm font-semibold leading-6 text-[#a12f56]" : "text-sm font-semibold leading-6 text-[#28613b]"}
      role={kind === "error" ? "alert" : "status"}
      aria-live={kind === "error" ? "assertive" : "polite"}
    >
      {children}
    </p>
  );
}

export function InfoBlock({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-xl border border-[#e0e3ea] bg-[#fbfbfa] p-4">
      <p className="text-xs font-bold uppercase tracking-[0.08em] text-[#6b7280]">{label}</p>
      <p className="mt-1 text-sm font-semibold leading-6 text-[#303744]">{value}</p>
    </div>
  );
}
