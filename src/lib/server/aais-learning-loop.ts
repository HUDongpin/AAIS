import {
  caasiPilotCoursePackage,
  getCaasiPilotTaskDefinition,
  type AaisExpertModelStepId,
  type AaisTaskCompletionRequirementKind,
} from "@/data/aais-course-packages";

export const aaisLearningMilestoneIds = [
  "launch_import",
  "modeling",
  "coaching_scaffolding",
  "exploration",
  "articulation",
  "reflection",
  "summary_completion",
] as const;

export type AaisLearningMilestoneId = typeof aaisLearningMilestoneIds[number];
export type AaisLearningMilestoneStatus = "locked" | "open" | "completed";

export const aaisMilestoneEvidenceKinds = {
  launch_import: ["orientation_acknowledged"],
  modeling: ["expert_model_reviewed"],
  coaching_scaffolding: ["guided_practice_completed"],
  exploration: ["artifact_submitted"],
  articulation: ["strategy_articulated"],
  reflection: ["reflection_submitted"],
  summary_completion: ["summary_acknowledged"],
} as const satisfies Record<AaisLearningMilestoneId, readonly string[]>;

export type AaisMilestoneEvidenceKind =
  typeof aaisMilestoneEvidenceKinds[AaisLearningMilestoneId][number];

export type AaisLearningMilestoneRecord = {
  id: AaisLearningMilestoneId;
  status: AaisLearningMilestoneStatus;
  openedAt: string | null;
  completedAt: string | null;
  evidenceKinds: AaisMilestoneEvidenceKind[];
};

export type AaisAiUseMode = "ai-supported" | "ai-free";
export type AaisOutputEvaluation =
  | "pending"
  | "accepted"
  | "revision_required"
  | "ai_free";
export type AaisReflectionOutcome = "pending" | "submitted" | "declined";
export type AaisArticulationOutcome = AaisReflectionOutcome;

export type AaisTaskPilotEvidence = {
  diagnosisText: string;
  revisedPromptText: string;
  outputEvaluationText: string;
  planningText: string;
  monitoringText: string;
  evaluationText: string;
  articulationText: string;
  articulationOutcome: AaisArticulationOutcome;
  articulationDeclineReason: string;
  reflectionText: string;
  reflectionDeclineReason: string;
  expertComparisonText: string;
  outputEvaluation: AaisOutputEvaluation;
  reflectionOutcome: AaisReflectionOutcome;
  summaryAcknowledged: boolean;
  aiUseMode: AaisAiUseMode;
};

export type AaisA3SignalType =
  | "goal_missing"
  | "plan_missing"
  | "no_progress"
  | "large_regression"
  | "output_evaluation_missing"
  | "explicit_help_requested"
  | "reflection_missing";

export type AaisA3RecommendedAction =
  | "ask_goal_question"
  | "ask_for_plan"
  | "offer_small_next_step"
  | "invite_recovery_or_revision"
  | "prompt_output_evaluation"
  | "provide_bounded_scaffold"
  | "invite_reflection";

export type AaisA3SupervisionSignal = {
  id: string;
  type: AaisA3SignalType;
  createdAt: string;
  basis: "deterministic-rule";
  ruleVersion: "aais-metacognitive-signal-v1";
  cooldownSeconds: 300;
  evidence: {
    source: "artifact" | "guide" | "scaffold" | "self_report" | "completion_gate";
    previousCharacters?: number;
    currentCharacters?: number;
    directRequest?: boolean;
    patternVersion: "aais-metacognitive-signal-v1";
  };
  recommendedAction: AaisA3RecommendedAction;
};

type AaisGuideConsumptionMessage = {
  kind: "user" | "assistant";
  time: string;
  taskId?: string;
  turns?: Array<{ agentId: string }>;
};

type AaisGuideConsumptionEvent = {
  event: string;
  task: string;
  time: string;
  detail: Record<string, unknown>;
};

export type AaisScaffoldLevel = 1 | 2 | 3 | 4;
export type AaisScaffoldIntensity =
  | "prompt-question"
  | "step-breakdown"
  | "evaluation-cue"
  | "worked-model";

export type AaisTaskScaffoldState = {
  currentLevel: AaisScaffoldLevel;
  intensity: AaisScaffoldIntensity;
  fading: boolean;
  remainingDirectAssists: number;
};

export type AaisScaffoldArtifactCharacterBucket =
  | "under_8"
  | "8_99"
  | "100_799"
  | "800_plus";

export type AaisScaffoldEvidenceSnapshot = {
  schemaVersion: 1;
  structuredFieldsCompleted: number;
  artifactVisibleCharacterBucket: AaisScaffoldArtifactCharacterBucket;
  completedMilestones: number;
  rawTextIncluded: false;
};

export type AaisScaffoldFadingReason =
  | "evidence_improved"
  | "direct_assists_exhausted";

export type AaisTaskLearningLoop = {
  version: "caasi-pilot-v1";
  activeMilestone: AaisLearningMilestoneId;
  milestones: AaisLearningMilestoneRecord[];
};

export type AaisA4ReflectionReport = {
  version: "aais-a4-reflection-report-v1";
  basis: "deterministic-field-presence";
  expertModelId: string;
  expertStepIds: AaisExpertModelStepId[];
  evidenceSummary: {
    artifactCharacters: number;
    structuredFieldCharacters: Record<string, number>;
    rawTextIncluded: false;
  };
  comparisons: Array<{
    expertStepId: AaisExpertModelStepId;
    evidenceFields: string[];
    status: "evidence-recorded" | "evidence-missing";
    recommendedAction: string;
  }>;
  learnerVisibleTurn: false;
};

export type AaisTaskCompletionInput = {
  taskId: string;
  phase: "training" | "practice";
  artifactText: string;
  selfReport: string;
  pilotEvidence: AaisTaskPilotEvidence;
  milestones: AaisLearningMilestoneRecord[];
};

export const pilotClosedTaskIds = new Set<string>(
  caasiPilotCoursePackage.tasks
    .filter((task) => task.availability === "pilot-closed")
    .map((task) => task.taskId),
);

export const aaisTask4MinimumArtifactCharacters = 800;
const minimumMeaningfulArtifactCharacters = aaisTask4MinimumArtifactCharacters;
const minimumMeaningfulReflectionCharacters = 12;

const legacyStageAliases: Record<string, AaisLearningMilestoneId> = {
  home: "launch_import",
  training: "modeling",
  practice: "coaching_scaffolding",
  guide: "modeling",
  assessment: "articulation",
  comparison: "reflection",
  reflection: "reflection",
};

const goalPattern = /(?:目标|目的|需要达到|goal|objective|aim)/iu;
const planPattern = /(?:计划|步骤|先.+再|安排|monitor|检查点|plan|step|first.+then)/iu;
const evaluationPattern = /(?:评估|评价|检验|检查|优点|不足|准确|相关|修改|改进|evaluate|assess|verify|revise|weakness)/iu;
const explicitHelpPattern = /(?:不知道|不会|卡住|帮帮|提示|求助|怎么做|直接给|答案|help|stuck|hint|show me|give me (?:the )?answer)/iu;
const directAnswerPattern = /(?:直接给|直接告诉我(?:完整)?答案|给我答案|替我完成|帮我写完|完整答案|give me (?:the )?answer|do it for me|write it for me)/iu;

export function createDefaultAaisTaskLearningLoop(): AaisTaskLearningLoop {
  return {
    version: "caasi-pilot-v1",
    activeMilestone: "launch_import",
    milestones: aaisLearningMilestoneIds.map((id) => ({
      id,
      status: "locked",
      openedAt: null,
      completedAt: null,
      evidenceKinds: [],
    })),
  };
}

export function createDefaultAaisTaskPilotEvidence(): AaisTaskPilotEvidence {
  return {
    diagnosisText: "",
    revisedPromptText: "",
    outputEvaluationText: "",
    planningText: "",
    monitoringText: "",
    evaluationText: "",
    articulationText: "",
    articulationOutcome: "pending",
    articulationDeclineReason: "",
    reflectionText: "",
    reflectionDeclineReason: "",
    expertComparisonText: "",
    outputEvaluation: "pending",
    reflectionOutcome: "pending",
    summaryAcknowledged: false,
    aiUseMode: "ai-supported",
  };
}

export function createDefaultAaisScaffoldState(): AaisTaskScaffoldState {
  return {
    currentLevel: 1,
    intensity: "prompt-question",
    fading: false,
    remainingDirectAssists: 4,
  };
}

export function normalizeAaisLearningMilestoneId(value: unknown) {
  if (typeof value !== "string") {
    return null;
  }
  if (aaisLearningMilestoneIds.includes(value as AaisLearningMilestoneId)) {
    return value as AaisLearningMilestoneId;
  }
  return legacyStageAliases[value] ?? null;
}

export function normalizeAaisTaskLearningLoop(value: unknown): AaisTaskLearningLoop {
  const fallback = createDefaultAaisTaskLearningLoop();
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return fallback;
  }
  const input = value as Partial<AaisTaskLearningLoop>;
  const activeMilestone = normalizeAaisLearningMilestoneId(input.activeMilestone)
    ?? fallback.activeMilestone;
  const sourceMilestones = Array.isArray(input.milestones) ? input.milestones : [];
  return {
    version: "caasi-pilot-v1",
    activeMilestone,
    milestones: aaisLearningMilestoneIds.map((id) => {
      const source = sourceMilestones.find((candidate) => candidate?.id === id);
      const allowedEvidence = aaisMilestoneEvidenceKinds[id];
      const evidenceKinds = Array.isArray(source?.evidenceKinds)
        ? source.evidenceKinds.filter((kind): kind is AaisMilestoneEvidenceKind =>
            typeof kind === "string" && allowedEvidence.includes(kind as never)
          )
        : [];
      const status = source?.status === "completed" && evidenceKinds.length
        ? "completed"
        : source?.status === "open"
          ? "open"
          : "locked";
      return {
        id,
        status,
        openedAt: normalizeIsoTime(source?.openedAt),
        completedAt: status === "completed" ? normalizeIsoTime(source?.completedAt) : null,
        evidenceKinds,
      };
    }),
  };
}

export function normalizeAaisTaskPilotEvidence(
  value: unknown,
  legacy: { artifactText?: string; selfReport?: string } = {},
): AaisTaskPilotEvidence {
  const fallback = createDefaultAaisTaskPilotEvidence();
  const input = value && typeof value === "object" && !Array.isArray(value)
    ? value as Partial<AaisTaskPilotEvidence>
    : {};
  const artifact = legacy.artifactText?.trim() ?? "";
  const selfReport = legacy.selfReport?.trim() ?? "";
  return {
    diagnosisText: normalizeEvidenceText(input.diagnosisText),
    revisedPromptText: normalizeEvidenceText(input.revisedPromptText),
    outputEvaluationText: normalizeEvidenceText(input.outputEvaluationText),
    planningText: normalizeEvidenceText(input.planningText),
    monitoringText: normalizeEvidenceText(input.monitoringText),
    evaluationText: normalizeEvidenceText(input.evaluationText),
    articulationText: normalizeEvidenceText(input.articulationText) || selfReport,
    articulationOutcome: isAaisReflectionOutcome(input.articulationOutcome)
      ? input.articulationOutcome
      : selfReport.length >= minimumMeaningfulReflectionCharacters
        ? "submitted"
        : fallback.articulationOutcome,
    articulationDeclineReason: normalizeEvidenceText(input.articulationDeclineReason),
    reflectionText: normalizeEvidenceText(input.reflectionText) || selfReport,
    reflectionDeclineReason: normalizeEvidenceText(input.reflectionDeclineReason),
    expertComparisonText: normalizeEvidenceText(input.expertComparisonText),
    outputEvaluation: isAaisOutputEvaluation(input.outputEvaluation)
      ? input.outputEvaluation
      : evaluationPattern.test(artifact) || Boolean(input.outputEvaluationText?.trim())
        ? "accepted"
        : fallback.outputEvaluation,
    reflectionOutcome: isAaisReflectionOutcome(input.reflectionOutcome)
      ? input.reflectionOutcome
      : selfReport.length >= minimumMeaningfulReflectionCharacters
        ? "submitted"
        : fallback.reflectionOutcome,
    summaryAcknowledged: input.summaryAcknowledged === true,
    aiUseMode: input.aiUseMode === "ai-free" ? "ai-free" : "ai-supported",
  };
}

export function mergeAaisTaskPilotEvidence(
  current: AaisTaskPilotEvidence,
  patch: Partial<AaisTaskPilotEvidence>,
) {
  const next = {
    ...current,
    ...patch,
  };
  if (
    patch.articulationText !== undefined
    && patch.articulationOutcome === undefined
    && countAaisVisibleCharacters(next.articulationText) >= 8
  ) {
    next.articulationOutcome = "submitted";
  }
  if (
    patch.reflectionText !== undefined
    && patch.reflectionOutcome === undefined
    && countAaisVisibleCharacters(next.reflectionText) >= 8
  ) {
    next.reflectionOutcome = "submitted";
  }
  if (next.articulationOutcome === "submitted") {
    next.articulationDeclineReason = "";
  }
  if (next.reflectionOutcome === "submitted") {
    next.reflectionDeclineReason = "";
  }
  if (next.aiUseMode === "ai-free" && next.outputEvaluation === "pending") {
    next.outputEvaluation = "ai_free";
  }
  if (next.aiUseMode === "ai-supported" && next.outputEvaluation === "ai_free") {
    next.outputEvaluation = "pending";
  }
  return next;
}

export function openAaisLearningMilestone(
  current: AaisTaskLearningLoop,
  milestoneId: AaisLearningMilestoneId,
  now = new Date().toISOString(),
): AaisTaskLearningLoop {
  const normalized = normalizeAaisTaskLearningLoop(current);
  return {
    ...normalized,
    activeMilestone: milestoneId,
    milestones: normalized.milestones.map((milestone) =>
      milestone.id === milestoneId && milestone.status !== "completed"
        ? {
            ...milestone,
            status: "open",
            openedAt: milestone.openedAt ?? now,
          }
        : milestone
    ),
  };
}

export function recordAaisMilestoneEvidence(
  current: AaisTaskLearningLoop,
  milestoneId: AaisLearningMilestoneId,
  evidenceKind: string,
  now = new Date().toISOString(),
): AaisTaskLearningLoop | null {
  if (!aaisMilestoneEvidenceKinds[milestoneId].includes(evidenceKind as never)) {
    return null;
  }
  const opened = openAaisLearningMilestone(current, milestoneId, now);
  return {
    ...opened,
    milestones: opened.milestones.map((milestone) =>
      milestone.id === milestoneId
        ? {
            ...milestone,
            status: "completed",
            openedAt: milestone.openedAt ?? now,
            completedAt: milestone.completedAt ?? now,
            evidenceKinds: [...new Set([
              ...milestone.evidenceKinds,
              evidenceKind as AaisMilestoneEvidenceKind,
            ])],
          }
        : milestone
    ),
  };
}

export function deriveAaisTaskCompletionMissing(input: AaisTaskCompletionInput) {
  if (input.taskId === "training_task_1") {
    return [
      ...(!isMilestoneComplete(input.milestones, "launch_import")
        ? ["orientation_acknowledged"]
        : []),
      ...(!isMilestoneComplete(input.milestones, "modeling")
        ? ["expert_model_reviewed"]
        : []),
    ];
  }
  const taskDefinition = getCaasiPilotTaskDefinition(input.taskId);
  if (taskDefinition?.availability === "pilot-closed") {
    return ["pilot_closed"];
  }
  if (taskDefinition) {
    const requirementMissing = taskDefinition.completionRequirements.flatMap((requirement) =>
      requirement.required && !hasCompletionRequirementEvidence(
        requirement.kind,
        input.artifactText,
        input.pilotEvidence,
      )
        ? [requirement.id]
        : []
    );
    const milestoneRequirementIds = completionRequirementIdsByMilestone[input.taskId] ?? [];
    const milestoneMissing = milestoneRequirementIds.flatMap(({ milestoneId, requirementId }) =>
      !isMilestoneComplete(input.milestones, milestoneId) ? [requirementId] : []
    );
    return [...new Set([...requirementMissing, ...milestoneMissing])];
  }
  return input.phase === "training" ? [] : ["completion_requirements_unknown"];
}

const completionRequirementIdsByMilestone: Record<
  string,
  Array<{ milestoneId: AaisLearningMilestoneId; requirementId: string }>
> = {
  practice_task_1: [
    {
      milestoneId: "coaching_scaffolding",
      requirementId: "evaluate_generated_outline",
    },
    {
      milestoneId: "articulation",
      requirementId: "articulate_task_two_process",
    },
  ],
  practice_task_3: [
    { milestoneId: "exploration", requirementId: "submit_guide_draft" },
    { milestoneId: "articulation", requirementId: "articulate_task_four_process" },
    { milestoneId: "reflection", requirementId: "reflect_after_task_four" },
  ],
};

export function deriveAaisScaffoldState(requestCount: number): AaisTaskScaffoldState {
  const count = Math.max(0, Math.floor(requestCount));
  if (count >= 5) {
    return {
      currentLevel: 1,
      intensity: "prompt-question",
      fading: true,
      remainingDirectAssists: 0,
    };
  }
  const level = Math.max(1, Math.min(4, count || 1)) as AaisScaffoldLevel;
  return {
    currentLevel: level,
    intensity: scaffoldIntensityForLevel(level),
    fading: false,
    remainingDirectAssists: Math.max(0, 4 - count),
  };
}

export function createAaisScaffoldEvidenceSnapshot(input: {
  taskId: string;
  artifactText: string;
  pilotEvidence: AaisTaskPilotEvidence;
  milestones: AaisLearningMilestoneRecord[];
}): AaisScaffoldEvidenceSnapshot {
  const hasText = (value: string) => countAaisVisibleCharacters(value) >= 8;
  const evidence = input.pilotEvidence;
  const completedStructuredFields = input.taskId === "practice_task_1"
    ? [
        hasText(evidence.diagnosisText),
        hasText(evidence.revisedPromptText),
        hasText(evidence.outputEvaluationText),
        evidence.articulationOutcome === "submitted" && hasText(evidence.articulationText),
      ]
    : input.taskId === "practice_task_3"
      ? [
          hasText(evidence.planningText),
          hasText(evidence.monitoringText),
          hasText(evidence.evaluationText),
          hasText(evidence.outputEvaluationText),
          evidence.articulationOutcome === "submitted" && hasText(evidence.articulationText),
          evidence.reflectionOutcome === "submitted" && hasText(evidence.reflectionText),
          evidence.reflectionOutcome === "submitted" && hasText(evidence.expertComparisonText),
        ]
      : [];
  const artifactCharacters = countAaisVisibleCharacters(input.artifactText);
  const artifactVisibleCharacterBucket: AaisScaffoldArtifactCharacterBucket =
    artifactCharacters >= 800
      ? "800_plus"
      : artifactCharacters >= 100
        ? "100_799"
        : artifactCharacters >= 8
          ? "8_99"
          : "under_8";
  return {
    schemaVersion: 1,
    structuredFieldsCompleted: completedStructuredFields.filter(Boolean).length,
    artifactVisibleCharacterBucket,
    completedMilestones: input.milestones.filter((milestone) =>
      milestone.status === "completed"
    ).length,
    rawTextIncluded: false,
  };
}

export function hasAaisScaffoldEvidenceImproved(
  current: AaisScaffoldEvidenceSnapshot,
  previous: AaisScaffoldEvidenceSnapshot | null | undefined,
) {
  if (!previous) return false;
  return current.structuredFieldsCompleted > previous.structuredFieldsCompleted
    || scaffoldArtifactBucketRank(current.artifactVisibleCharacterBucket)
      > scaffoldArtifactBucketRank(previous.artifactVisibleCharacterBucket)
    || current.completedMilestones > previous.completedMilestones;
}

export function normalizeAaisScaffoldEvidenceSnapshot(
  value: unknown,
): AaisScaffoldEvidenceSnapshot | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const input = value as Partial<AaisScaffoldEvidenceSnapshot>;
  if (
    input.schemaVersion !== 1
    || input.rawTextIncluded !== false
    || !Number.isSafeInteger(input.structuredFieldsCompleted)
    || Number(input.structuredFieldsCompleted) < 0
    || !Number.isSafeInteger(input.completedMilestones)
    || Number(input.completedMilestones) < 0
    || !isAaisScaffoldArtifactCharacterBucket(input.artifactVisibleCharacterBucket)
  ) {
    return null;
  }
  return {
    schemaVersion: 1,
    structuredFieldsCompleted: Number(input.structuredFieldsCompleted),
    artifactVisibleCharacterBucket: input.artifactVisibleCharacterBucket,
    completedMilestones: Number(input.completedMilestones),
    rawTextIncluded: false,
  };
}

export function createAaisSignalDrafts(input: {
  source: AaisA3SupervisionSignal["evidence"]["source"];
  text?: string;
  previousText?: string;
  pilotEvidence: AaisTaskPilotEvidence;
}) {
  const text = input.text?.trim() ?? "";
  const previousCharacters = countAaisVisibleCharacters(input.previousText ?? "");
  const currentCharacters = countAaisVisibleCharacters(text);
  const signalTypes: AaisA3SignalType[] = [];
  if (input.source === "artifact") {
    if (!input.pilotEvidence.diagnosisText.trim() && !goalPattern.test(text)) {
      signalTypes.push("goal_missing");
    }
    if (!input.pilotEvidence.planningText.trim() && !planPattern.test(text)) {
      signalTypes.push("plan_missing");
    }
    if (previousCharacters > 0 && currentCharacters <= previousCharacters + 2) {
      signalTypes.push("no_progress");
    }
    if (previousCharacters >= 80 && previousCharacters - currentCharacters >= 40) {
      signalTypes.push("large_regression");
    }
    if (
      currentCharacters >= minimumMeaningfulArtifactCharacters
      && input.pilotEvidence.outputEvaluation === "pending"
      && !input.pilotEvidence.outputEvaluationText.trim()
      && !evaluationPattern.test(text)
    ) {
      signalTypes.push("output_evaluation_missing");
    }
  }
  if ((input.source === "guide" || input.source === "scaffold") && explicitHelpPattern.test(text)) {
    signalTypes.push("explicit_help_requested");
  }
  if (
    (input.source === "self_report" || input.source === "completion_gate")
    && input.pilotEvidence.reflectionOutcome !== "submitted"
  ) {
    signalTypes.push("reflection_missing");
  }
  return [...new Set(signalTypes)].map((type) => ({
    type,
    basis: "deterministic-rule" as const,
    evidence: {
      source: input.source,
      ...(input.source === "artifact"
        ? { previousCharacters, currentCharacters }
        : {}),
      ...(type === "explicit_help_requested" ? { directRequest: true } : {}),
      patternVersion: "aais-metacognitive-signal-v1" as const,
    },
    recommendedAction: recommendedActionForSignal(type),
  }));
}

/**
 * Keeps the append-only A3 audit trail intact while selecting only signals
 * that can still change A1's next response. A persisted learner-visible
 * assistant response consumes every signal that existed before that response.
 * Event order is authoritative for current records, which also makes equal
 * millisecond timestamps deterministic. The timestamp fallback deliberately
 * treats equality as unconsumed so a signal written after an older assistant
 * message is never lost.
 */
export function selectActionableAaisSupervisionSignals(input: {
  taskId: string;
  artifactText: string;
  pilotEvidence: AaisTaskPilotEvidence;
  supervisionSignals: AaisA3SupervisionSignal[];
  guideMessages?: AaisGuideConsumptionMessage[];
  events?: AaisGuideConsumptionEvent[];
}) {
  return input.supervisionSignals.filter((signal) =>
    !isAaisSupervisionSignalSemanticallyResolved(
      signal,
      input.artifactText,
      input.pilotEvidence,
    )
    && !wasAaisPolicySignalConsumed({
      taskId: input.taskId,
      createdAt: signal.createdAt,
      sourceEventIndex: findAaisSignalEventIndex(input.events, signal.id, input.taskId),
      guideMessages: input.guideMessages,
      events: input.events,
    })
  );
}

/** A rejected output needs one local revision response, not a sticky mode. */
export function isAaisRevisionPolicyActionable(input: {
  taskId: string;
  pilotEvidence: AaisTaskPilotEvidence;
  guideMessages?: AaisGuideConsumptionMessage[];
  events?: AaisGuideConsumptionEvent[];
}) {
  if (input.pilotEvidence.outputEvaluation !== "revision_required") {
    return false;
  }
  const events = input.events ?? [];
  const rejectionIndex = events.findLastIndex((event) =>
    event.task === input.taskId
    && event.event === "ai_acceptance_recorded"
    && event.detail.accepted === false
  );
  if (rejectionIndex < 0) {
    // Backwards-compatible records may predate decision events. Preserve one
    // safe local revision response rather than silently invoking a provider.
    return true;
  }
  const rejection = events[rejectionIndex];
  const revisionAlreadyHandled = events.slice(rejectionIndex + 1).some((event) =>
    event.task === input.taskId
    && (
      isAaisLearnerVisibleResponseEvent(event.event)
      || didAaisLearnerReviseEvaluationEvidence(event)
    )
  );
  if (revisionAlreadyHandled) {
    return false;
  }
  return !wasAaisPolicySignalConsumed({
    taskId: input.taskId,
    createdAt: rejection.time,
    sourceEventIndex: rejectionIndex,
    guideMessages: input.guideMessages,
    events,
  });
}

function isAaisSupervisionSignalSemanticallyResolved(
  signal: AaisA3SupervisionSignal,
  artifactText: string,
  evidence: AaisTaskPilotEvidence,
) {
  if (signal.type === "goal_missing") {
    return Boolean(evidence.diagnosisText.trim()) || goalPattern.test(artifactText);
  }
  if (signal.type === "plan_missing") {
    return Boolean(evidence.planningText.trim()) || planPattern.test(artifactText);
  }
  if (signal.type === "output_evaluation_missing") {
    return evidence.outputEvaluation !== "pending"
      || Boolean(evidence.outputEvaluationText.trim())
      || evaluationPattern.test(artifactText);
  }
  if (signal.type === "reflection_missing") {
    return evidence.reflectionOutcome === "submitted"
      || Boolean(evidence.reflectionText.trim());
  }
  return false;
}

function findAaisSignalEventIndex(
  events: AaisGuideConsumptionEvent[] | undefined,
  signalId: string,
  taskId: string,
) {
  return (events ?? []).findLastIndex((event) =>
    event.task === taskId
    && event.detail.signal_id === signalId
  );
}

function wasAaisPolicySignalConsumed(input: {
  taskId: string;
  createdAt: string;
  sourceEventIndex: number;
  guideMessages?: AaisGuideConsumptionMessage[];
  events?: AaisGuideConsumptionEvent[];
}) {
  const events = input.events ?? [];
  if (input.sourceEventIndex >= 0) {
    return events.slice(input.sourceEventIndex + 1).some((event) =>
      event.task === input.taskId && isAaisLearnerVisibleResponseEvent(event.event)
    );
  }
  const createdAtMs = Date.parse(input.createdAt);
  if (!Number.isFinite(createdAtMs)) {
    return false;
  }
  return (input.guideMessages ?? []).some((message) => {
    if (!isAaisLearnerVisibleAssistantMessage(message, input.taskId)) {
      return false;
    }
    const assistantAtMs = Date.parse(message.time);
    // Equality stays actionable. Modern records use event order above; this
    // fallback cannot safely infer whether the signal or assistant came first.
    return Number.isFinite(assistantAtMs) && assistantAtMs > createdAtMs;
  });
}

function isAaisLearnerVisibleResponseEvent(event: string) {
  return event === "ai_response_completed"
    || event === "deterministic_guide_response_completed";
}

function isAaisLearnerVisibleAssistantMessage(
  message: AaisGuideConsumptionMessage,
  taskId: string,
) {
  if (message.kind !== "assistant" || message.taskId !== taskId) {
    return false;
  }
  return !message.turns?.length
    || message.turns.some((turn) => turn.agentId === "A1" || turn.agentId === "A2");
}

function didAaisLearnerReviseEvaluationEvidence(event: AaisGuideConsumptionEvent) {
  if (event.event !== "self_report_saved" || !Array.isArray(event.detail.fields)) {
    return false;
  }
  return event.detail.fields.some((field) =>
    field === "revisedPromptText" || field === "outputEvaluationText"
  );
}

export function classifyAaisLearnerInput(text: string) {
  const trimmed = text.trim();
  const visible = [...trimmed].filter((character) => !/\s/u.test(character));
  const meaningful = visible.filter((character) => /[\p{L}\p{N}\p{Script=Han}]/u.test(character));
  const repeated = /^(.)\1{5,}$/u.test(visible.join(""));
  const recognizable = Boolean(trimmed)
    && !repeated
    && meaningful.length >= 2
    && meaningful.length / Math.max(1, visible.length) >= 0.3;
  return {
    recognizable,
    explicitHelpRequested: explicitHelpPattern.test(trimmed),
    directAnswerRequested: directAnswerPattern.test(trimmed),
  };
}

export function buildAaisA4ReflectionReport(input: {
  artifactText: string;
  pilotEvidence: AaisTaskPilotEvidence;
}): AaisA4ReflectionReport {
  const expertStepIds = caasiPilotCoursePackage.expertModel.steps.map((step) => step.id);
  const structuredEvidenceFields = [
    "diagnosisText",
    "revisedPromptText",
    "outputEvaluationText",
    "planningText",
    "monitoringText",
    "evaluationText",
    "articulationText",
    "reflectionText",
    "expertComparisonText",
  ] as const satisfies readonly (keyof AaisTaskPilotEvidence)[];
  const structuredFieldCharacters = Object.fromEntries(
    structuredEvidenceFields.map((field) => [
      field,
      countAaisVisibleCharacters(String(input.pilotEvidence[field] ?? "")),
    ]),
  );
  const artifactCharacters = countAaisVisibleCharacters(input.artifactText);
  const fieldLengths: Record<string, number> = {
    artifactText: artifactCharacters,
    ...structuredFieldCharacters,
  };
  const evidenceFieldsByStep: Record<AaisExpertModelStepId, string[]> = {
    analyze_task: ["diagnosisText", "artifactText"],
    set_learning_goals: ["planningText"],
    draft_prompt: ["revisedPromptText"],
    monitor_generation: ["monitoringText"],
    evaluate_and_revise: [
      "evaluationText",
      "outputEvaluationText",
      "reflectionText",
      "expertComparisonText",
    ],
  };
  const recommendedActionByStep: Record<AaisExpertModelStepId, string> = {
    analyze_task: "record_task_diagnosis",
    set_learning_goals: "record_goal_and_plan",
    draft_prompt: "record_prompt_revision",
    monitor_generation: "record_monitoring_checkpoint",
    evaluate_and_revise: "record_evaluation_and_revision",
  };
  return {
    version: "aais-a4-reflection-report-v1",
    basis: "deterministic-field-presence",
    expertModelId: caasiPilotCoursePackage.expertModel.id,
    expertStepIds,
    evidenceSummary: {
      artifactCharacters,
      structuredFieldCharacters,
      rawTextIncluded: false,
    },
    comparisons: expertStepIds.map((expertStepId) => {
      const evidenceFields = evidenceFieldsByStep[expertStepId];
      return {
        expertStepId,
        evidenceFields,
        status: evidenceFields.some((field) => (fieldLengths[field] ?? 0) >= 8)
          ? "evidence-recorded"
          : "evidence-missing",
        recommendedAction: recommendedActionByStep[expertStepId],
      };
    }),
    learnerVisibleTurn: false,
  };
}

export function deriveAaisA4ReflectionReport(input: {
  taskId: string;
  artifactText: string;
  pilotEvidence: AaisTaskPilotEvidence;
}): AaisA4ReflectionReport | null {
  if (
    input.taskId !== "practice_task_3"
    || countAaisVisibleCharacters(input.artifactText) < aaisTask4MinimumArtifactCharacters
    || countAaisVisibleCharacters(input.pilotEvidence.planningText) < 8
    || countAaisVisibleCharacters(input.pilotEvidence.monitoringText) < 8
    || countAaisVisibleCharacters(input.pilotEvidence.evaluationText) < 8
    || countAaisVisibleCharacters(input.pilotEvidence.outputEvaluationText) < 8
    || countAaisVisibleCharacters(input.pilotEvidence.articulationText) < 8
    || input.pilotEvidence.articulationOutcome !== "submitted"
  ) {
    return null;
  }
  return buildAaisA4ReflectionReport(input);
}

export function isAaisOutputEvaluation(value: unknown): value is AaisOutputEvaluation {
  return value === "pending"
    || value === "accepted"
    || value === "revision_required"
    || value === "ai_free";
}

export function isAaisReflectionOutcome(value: unknown): value is AaisReflectionOutcome {
  return value === "pending" || value === "submitted" || value === "declined";
}

/**
 * Counts learner-visible, non-whitespace Unicode code points. HTML markup,
 * comments, script/style bodies and entity syntax do not satisfy evidence
 * length gates. Known visible entities count as the character they render.
 */
export function countAaisVisibleCharacters(value: string) {
  const withoutMarkup = value
    .replace(/<!--[\s\S]*?-->/gu, " ")
    .replace(/<script\b[^>]*>[\s\S]*?<\/script\s*>/giu, " ")
    .replace(/<style\b[^>]*>[\s\S]*?<\/style\s*>/giu, " ")
    .replace(/<[^>]*>/gu, " ");
  const decoded = withoutMarkup
    .replace(/&(nbsp|ensp|emsp|thinsp|zwnj|zwj);/giu, " ")
    .replace(/&(amp|lt|gt|quot|apos|#39);/giu, (entity) => ({
      "&amp;": "&",
      "&lt;": "<",
      "&gt;": ">",
      "&quot;": '"',
      "&apos;": "'",
      "&#39;": "'",
    })[entity.toLowerCase()] ?? "")
    .replace(/&#(\d{1,7});/gu, (_entity, decimal: string) =>
      decodeHtmlCodePoint(Number.parseInt(decimal, 10)))
    .replace(/&#x([\da-f]{1,6});/giu, (_entity, hexadecimal: string) =>
      decodeHtmlCodePoint(Number.parseInt(hexadecimal, 16)))
    .replace(/&[a-z][a-z\d]{1,31};/giu, "");
  return [...decoded].filter((character) =>
    !/[\s\u200B-\u200D\u2060\uFEFF]/u.test(character)
  ).length;
}

function scaffoldIntensityForLevel(level: AaisScaffoldLevel): AaisScaffoldIntensity {
  return ({
    1: "prompt-question",
    2: "step-breakdown",
    3: "evaluation-cue",
    4: "worked-model",
  } as const)[level];
}

function isAaisScaffoldArtifactCharacterBucket(
  value: unknown,
): value is AaisScaffoldArtifactCharacterBucket {
  return value === "under_8"
    || value === "8_99"
    || value === "100_799"
    || value === "800_plus";
}

function scaffoldArtifactBucketRank(value: AaisScaffoldArtifactCharacterBucket) {
  return ({
    under_8: 0,
    "8_99": 1,
    "100_799": 2,
    "800_plus": 3,
  } as const)[value];
}

function recommendedActionForSignal(type: AaisA3SignalType): AaisA3RecommendedAction {
  const actions: Record<AaisA3SignalType, AaisA3RecommendedAction> = {
    goal_missing: "ask_goal_question",
    plan_missing: "ask_for_plan",
    no_progress: "offer_small_next_step",
    large_regression: "invite_recovery_or_revision",
    output_evaluation_missing: "prompt_output_evaluation",
    explicit_help_requested: "provide_bounded_scaffold",
    reflection_missing: "invite_reflection",
  };
  return actions[type];
}

function normalizeIsoTime(value: unknown) {
  return typeof value === "string" && Number.isFinite(Date.parse(value)) ? value : null;
}

function normalizeEvidenceText(value: unknown) {
  return typeof value === "string" ? value.trim().slice(0, 20_000) : "";
}

function isMilestoneComplete(
  milestones: AaisLearningMilestoneRecord[],
  milestoneId: AaisLearningMilestoneId,
) {
  return milestones.some((milestone) =>
    milestone.id === milestoneId && milestone.status === "completed"
  );
}

function hasCompletionRequirementEvidence(
  kind: AaisTaskCompletionRequirementKind,
  artifactText: string,
  evidence: AaisTaskPilotEvidence,
) {
  if (kind === "artifact") {
    return countAaisVisibleCharacters(artifactText) >= minimumMeaningfulArtifactCharacters;
  }
  if (kind === "reflection") {
    return evidence.reflectionOutcome === "submitted"
      && countAaisVisibleCharacters(evidence.reflectionText) >= 8
      && countAaisVisibleCharacters(evidence.expertComparisonText) >= 8;
  }
  if (kind === "articulation") {
    return evidence.articulationOutcome === "submitted"
      && countAaisVisibleCharacters(evidence.articulationText) >= 8;
  }
  const fieldByKind: Record<
    Exclude<AaisTaskCompletionRequirementKind, "artifact" | "articulation" | "reflection">,
    keyof AaisTaskPilotEvidence
  > = {
    "prompt-diagnosis": "diagnosisText",
    "prompt-revision": "revisedPromptText",
    "output-evaluation": "outputEvaluationText",
    planning: "planningText",
    monitoring: "monitoringText",
    evaluation: "evaluationText",
  };
  const field = fieldByKind[kind];
  return typeof evidence[field] === "string"
    && countAaisVisibleCharacters(evidence[field]) >= 8;
}

function decodeHtmlCodePoint(codePoint: number) {
  if (
    !Number.isSafeInteger(codePoint)
    || codePoint <= 0
    || codePoint > 0x10ffff
    || (codePoint >= 0xd800 && codePoint <= 0xdfff)
  ) {
    return "";
  }
  return String.fromCodePoint(codePoint);
}
