import type {
  AaisLearningScaffoldResult,
  LearningSessionPatchBody,
} from "@/components/pages/learning/learning-session-client";
import type { PilotLearningActions } from "@/components/pages/learning/pilot-learning-types";

export function createPilotLearningActions({
  patchSession,
  requestScaffold,
}: {
  patchSession: (body: LearningSessionPatchBody) => Promise<unknown>;
  requestScaffold: (taskId: string, toolId: string) => Promise<AaisLearningScaffoldResult>;
}): PilotLearningActions {
  return {
    async onEndIncomplete({ outcome, pilotEvidence, reason, taskId }) {
      await patchSession({
        action: "save-pilot-evidence",
        taskId,
        pilotEvidence: {
          ...pilotEvidence,
          ...(outcome === "articulation"
            ? {
              articulationOutcome: "declined",
              articulationDeclineReason: reason,
            }
            : {
              reflectionOutcome: "declined",
              reflectionDeclineReason: reason,
            }),
        },
      });
      await patchSession({ action: "complete-task", taskId, endIncomplete: true });
    },
    async onRecordAiAcceptance({ accepted, messageId, reason, taskId }) {
      await patchSession({
        action: "record-ai-acceptance",
        accepted,
        messageId,
        reason,
        taskId,
      });
    },
    async onRecordStageEvidence({ evidenceKind, stageId, taskId }) {
      await patchSession({ action: "record-stage-evidence", evidenceKind, stageId, taskId });
    },
    async onRequestScaffold({ taskId, toolId }) {
      return requestScaffold(taskId, toolId);
    },
    async onSaveAiUseMode({ aiUseMode, taskId }) {
      await patchSession({
        action: "save-pilot-evidence",
        pilotEvidence: { aiUseMode },
        taskId,
      });
    },
    async onSavePilotEvidence({ pilotEvidence, taskId }) {
      await patchSession({ action: "save-pilot-evidence", pilotEvidence, taskId });
    },
  };
}
