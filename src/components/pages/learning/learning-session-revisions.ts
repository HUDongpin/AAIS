import {
  createPendingPilotMutationKey,
  isPilotMutationAction,
  readExpectedPilotEvidenceRevision,
  stableSerializePilotMutationPayload,
  type PendingPilotMutation,
} from "@/components/pages/learning/learning-pilot-mutation";
import type { LearningSessionPatchBody } from "@/components/pages/learning/learning-session-client";

export type TaskTextRevisions = {
  artifactRevision: number;
  pilotEvidenceRevision: number;
  selfReportRevision: number;
};

export function attachExpectedTextRevision(
  body: LearningSessionPatchBody,
  taskTextRevisions: Map<string, TaskTextRevisions>,
  pendingPilotMutations: Map<string, PendingPilotMutation>,
  createMutationId: (prefix: string) => string,
): LearningSessionPatchBody {
  const action = body.action;
  if (
    action !== "save-artifact"
    && action !== "archive-artifact"
    && action !== "record-ai-acceptance"
    && action !== "save-pilot-evidence"
    && action !== "save-self-report"
  ) {
    return body;
  }
  if (typeof body.taskId !== "string") {
    throw new Error("AAIS learner task revision is unavailable.");
  }
  const revisions = taskTextRevisions.get(body.taskId);
  if (action === "save-pilot-evidence" || action === "record-ai-acceptance") {
    if (body.expectedPilotEvidenceRevision !== undefined && body.mutationId !== undefined) {
      return body;
    }
    if (!revisions && body.expectedPilotEvidenceRevision === undefined) {
      throw new Error("AAIS learner pilot-evidence revision is unavailable.");
    }
    const pendingKey = createPendingPilotMutationKey(action, body.taskId);
    const payloadSignature = stableSerializePilotMutationPayload(body);
    const currentPending = pendingPilotMutations.get(pendingKey);
    const pending = currentPending?.payloadSignature === payloadSignature
      ? currentPending
      : {
          expectedPilotEvidenceRevision: readExpectedPilotEvidenceRevision(
            body.expectedPilotEvidenceRevision,
            revisions?.pilotEvidenceRevision,
          ),
          mutationId: typeof body.mutationId === "string"
            ? body.mutationId
            : createMutationId(
                action === "record-ai-acceptance"
                  ? "ai-acceptance-mutation"
                  : "pilot-evidence-mutation",
              ),
          payloadSignature,
        };
    pendingPilotMutations.set(pendingKey, pending);
    return {
      ...body,
      expectedPilotEvidenceRevision: pending.expectedPilotEvidenceRevision,
      mutationId: pending.mutationId,
    };
  }
  if (action === "save-self-report") {
    if (body.expectedSelfReportRevision !== undefined) {
      return body;
    }
    if (!revisions) {
      throw new Error("AAIS learner self-report revision is unavailable.");
    }
    return {
      ...body,
      expectedSelfReportRevision: revisions.selfReportRevision,
    };
  }
  if (body.expectedArtifactRevision !== undefined) {
    return body;
  }
  if (!revisions) {
    throw new Error("AAIS learner artifact revision is unavailable.");
  }
  return {
    ...body,
    expectedArtifactRevision: revisions.artifactRevision,
  };
}

export function clearPendingPilotMutation(
  body: LearningSessionPatchBody,
  pendingPilotMutations: Map<string, PendingPilotMutation>,
) {
  if (!isPilotMutationAction(body.action) || typeof body.taskId !== "string") {
    return;
  }
  const key = createPendingPilotMutationKey(body.action, body.taskId);
  const pending = pendingPilotMutations.get(key);
  if (pending?.mutationId === body.mutationId) {
    pendingPilotMutations.delete(key);
  }
}
