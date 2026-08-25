import type {
  AaisGuideAttachment,
  AaisGuideAttachmentMetadata,
} from "@/lib/ai/aais-guide-attachments";
import type { AaisGuideVisualization } from "@/lib/ai/aais-guide-function-scaffold";
import type {
  AaisExpertModelStepId,
  AaisPilotLearningMilestoneId,
} from "@/data/aais-course-packages";

export type ContentTab = "display" | "editor";
export type ContentItemId = "platform" | "theory" | "history";
export type AaisClientTaskStatus = "locked" | "available" | "active" | "completed";
export type DocumentFontFamily = "system" | "serif" | "mono";
export type DocumentFontSize = "17" | "20" | "24" | "28";
export type DocumentHeadingTag = "h1" | "h2" | "h3";
export type DocumentListTag = "ul" | "ol";

export type GuideMessage = {
  id: string;
  kind: "user" | "assistant";
  text: string;
  taskId?: string;
  phase?: "training" | "practice";
  attachments?: AaisGuideAttachmentMetadata[];
  turns?: GuideTurn[];
  runtime?: {
    fallback?: boolean;
  };
  trace?: {
    graphId?: string;
    topologicalOrder?: string[];
  };
};

export type GuideTurn = {
  agentId: string;
  label: string;
  content: string;
  actions: string[];
  visualizations?: AaisGuideVisualization[];
};

export type GuideQuickStart = {
  id: "clarify_goal" | "expert_model" | "request_scaffold" | "organize_reflection";
  label: string;
  prompt: string;
};

export type GuideClientAttachment = AaisGuideAttachment & {
  id: string;
};

export type SavedLearningDocument = {
  id: string;
  taskId: string;
  title: string;
  html: string;
  markdown: string;
  savedAt: Date;
};

export type AaisClientSavedDocumentRecord = Omit<SavedLearningDocument, "markdown" | "savedAt"> & {
  savedAt: string;
};

export type AaisClientTaskRecord = {
  taskId: string;
  phase?: "training" | "practice";
  status?: AaisClientTaskStatus;
  artifactText: string;
  artifactRevision: number;
  documentTitle?: string;
  activeDocumentId?: string | null;
  selfReport?: string;
  selfReportRevision: number;
  pilotEvidenceRevision?: number;
  scaffoldRequests?: number;
  scaffoldState?: {
    currentLevel: 1 | 2 | 3 | 4;
    intensity: string;
    fading: boolean;
    remainingDirectAssists: number;
  };
  scaffoldHistory?: AaisClientScaffoldHistoryEntry[];
  activeMilestone?: AaisPilotLearningMilestoneId;
  milestones?: AaisClientMilestoneRecord[];
  pilotEvidence?: AaisClientPilotEvidence;
  reflectionReport?: AaisClientReflectionReport | null;
  pilotOutcomeAudit?: AaisClientPilotOutcomeAuditRecord[];
  completionMissing?: string[];
  completionOutcome?: "in_progress" | "evidence_complete" | "ended_incomplete";
};

export type AaisClientScaffoldHistoryEntry = {
  toolId: string;
  mode: "tool-list" | "self-check";
  time: string;
  level?: 1 | 2 | 3 | 4;
  intensity?: string;
  remainingDirectAssists?: number;
  fading?: boolean;
  fadingReason?: AaisClientScaffoldFadingReason;
  evidenceSnapshot?: AaisClientScaffoldEvidenceSnapshot;
};

export type AaisClientScaffoldFadingReason =
  | "evidence_improved"
  | "direct_assists_exhausted";

export type AaisClientScaffoldEvidenceSnapshot = {
  schemaVersion: 1;
  structuredFieldsCompleted: number;
  artifactVisibleCharacterBucket: "under_8" | "8_99" | "100_799" | "800_plus";
  completedMilestones: number;
  rawTextIncluded: false;
};

export type AaisClientMilestoneRecord = {
  id: AaisPilotLearningMilestoneId;
  status: "locked" | "open" | "completed";
  openedAt?: string | null;
  completedAt?: string | null;
  evidenceKinds?: string[];
};

export type AaisClientPilotEvidence = {
  diagnosisText?: string;
  revisedPromptText?: string;
  outputEvaluationText?: string;
  planningText?: string;
  monitoringText?: string;
  evaluationText?: string;
  articulationText?: string;
  reflectionText?: string;
  expertComparisonText?: string;
  articulationOutcome?: "pending" | "submitted" | "declined";
  articulationDeclineReason?: string;
  outputEvaluation?: "pending" | "accepted" | "revision_required" | "ai_free";
  reflectionOutcome?: "pending" | "submitted" | "declined";
  reflectionDeclineReason?: string;
  summaryAcknowledged?: boolean;
  aiUseMode?: "ai-supported" | "ai-free";
};

export type AaisClientReflectionReport = {
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

export type AaisClientPilotOutcomeAuditRecord = {
  stage: "articulation" | "reflection";
  outcome: "pending" | "submitted" | "declined";
  reasonLength: number;
  attempt: number;
  recordedAt: string;
  rawReasonIncluded: false;
};

export type AaisClientSession = {
  dataGeneration: number;
  studentId: string;
  activeTaskId: string;
  tasks: AaisClientTaskRecord[];
  historyDocuments?: AaisClientSavedDocumentRecord[];
  guideMessages: Array<
    GuideMessage & {
      orchestration?: {
        graphId?: string;
        topologicalOrder?: string[];
      };
    }
  >;
};
