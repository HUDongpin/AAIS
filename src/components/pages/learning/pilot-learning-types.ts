import type { AaisLearningScaffoldResult } from "@/components/pages/learning/learning-session-client";
import type { AaisClientPilotEvidence } from "@/components/pages/learning/learning-page-types";
import type { AaisPilotLearningMilestoneId } from "@/data/aais-course-packages";

export type PilotLearningActions = {
  onEndIncomplete: (input: {
    outcome: "articulation" | "reflection";
    pilotEvidence: Partial<AaisClientPilotEvidence>;
    reason: string;
    taskId: string;
  }) => Promise<void>;
  onRecordAiAcceptance: (input: {
    accepted: boolean;
    messageId: string;
    reason: string;
    taskId: string;
  }) => Promise<void>;
  onRecordStageEvidence: (input: {
    evidenceKind: string;
    stageId: AaisPilotLearningMilestoneId;
    taskId: string;
  }) => Promise<void>;
  onRequestScaffold: (input: {
    taskId: string;
    toolId: string;
  }) => Promise<AaisLearningScaffoldResult>;
  onSaveAiUseMode: (input: {
    aiUseMode: "ai-supported" | "ai-free";
    taskId: string;
  }) => Promise<void>;
  onSavePilotEvidence: (input: {
    pilotEvidence: Partial<AaisClientPilotEvidence>;
    taskId: string;
  }) => Promise<void>;
};
