import type {
  AaisGuideAttachment,
  AaisGuideAttachmentMetadata,
} from "@/lib/ai/aais-guide-attachments";

export type ContentTab = "display" | "editor";
export type ContentItemId = "platform" | "theory" | "history";
export type AaisClientTaskStatus = "locked" | "available" | "active" | "completed";
export type DocumentFontFamily = "system" | "serif" | "mono";
export type DocumentFontSize = "17" | "20" | "24" | "28";
export type DocumentHeadingTag = "h1" | "h2" | "h3";
export type DocumentListTag = "ul" | "ol";

export type GuideDeliveryReceipt = {
  schemaVersion?: number;
  mode?: string;
  responseMode?: string;
  channel?: string;
  degraded?: boolean;
  diagnosticId?: string;
  persisted?: boolean;
  budgetDisposition?: string;
};

export type GuidePersistedDeliveryReceipt = {
  schemaVersion: 1;
  responseMode: "live";
  channel: "primary" | "secondary";
  degraded: boolean;
};

export type GuideLearnerAction = "retry" | "rewrite" | "none" | string;

export type GuideFailureKind =
  | "provider_chain"
  | "guardrail"
  | "configuration"
  | "connection"
  | "unknown";

export type GuideFailure = {
  kind: GuideFailureKind;
  code?: string;
  diagnosticId: string;
  retryable: boolean;
  learnerAction: GuideLearnerAction;
};

export type GuideMessageRuntime = {
  fallback?: boolean;
  operationId?: string;
  requestAttemptId?: string;
  diagnosticId?: string;
  delivery?: GuideDeliveryReceipt;
  failure?: GuideFailure;
};

export type GuideMessage = {
  id: string;
  kind: "user" | "assistant";
  text: string;
  attachments?: AaisGuideAttachmentMetadata[];
  turns?: GuideTurn[];
  runtime?: GuideMessageRuntime;
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
  selfReportRevision: number;
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
        delivery?: GuidePersistedDeliveryReceipt;
      };
    }
  >;
};
