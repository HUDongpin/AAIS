import type { AaisGuideAttachment } from "@/lib/ai/aais-guide-attachments";
import type { GuideQuickStart } from "@/components/pages/learning/learning-page-types";
import type { Locale } from "@/data/aais";

export type GuideSubmissionOptions = {
  source?: "typed" | "quick_start";
  quickStartId?: GuideQuickStart["id"];
};

export type GuideSubmissionEventDetail = {
  operation_id: string;
  task_id: string;
  input_mode: "typed" | "quick_start" | "attachment_only";
  prompt_length: number;
  attachment_count: number;
  has_attachments: boolean;
  quick_start_id?: GuideQuickStart["id"];
};

export type GuideSubmissionSnapshot = {
  operationId: string;
  userId: string;
  assistantId: string;
  taskId: string;
  artifactText: string;
  studentId: string;
  locale: Locale;
  question: string;
  editableQuestion: string;
  boundedAttachments: AaisGuideAttachment[];
  targetAgentIds: string[];
  telemetryActorGeneration: number;
  baseEventDetail: GuideSubmissionEventDetail;
};
