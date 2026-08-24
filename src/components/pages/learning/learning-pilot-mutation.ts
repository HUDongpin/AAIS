import type { LearningSessionPatchBody } from "@/components/pages/learning/learning-session-client";

export type PendingPilotMutation = {
  expectedPilotEvidenceRevision: number;
  mutationId: string;
  payloadSignature: string;
};

export type PendingStableReplayMutation = {
  mutationId: string;
  payloadSignature: string;
};

export type PilotMutationAction = "record-ai-acceptance" | "save-pilot-evidence";
export type StableReplayMutationAction =
  | "complete-task"
  | "record-stage-evidence"
  | "request-scaffold"
  | "select-stage"
  | "select-task";

export function createPendingPilotMutationKey(
  action: PilotMutationAction,
  taskId: string,
) {
  return `${action}:${taskId}`;
}

export function isPilotMutationAction(value: unknown): value is PilotMutationAction {
  return value === "record-ai-acceptance" || value === "save-pilot-evidence";
}

export function attachStableReplayMutation<T extends Record<string, unknown>>(
  body: T,
  pendingMutations: Map<string, PendingStableReplayMutation>,
  createMutationId: (prefix: string) => string,
): T & { mutationId?: string } {
  if (!isStableReplayMutationAction(body.action)) {
    return body;
  }
  const target = typeof body.taskId === "string" ? body.taskId : "session";
  const key = `${body.action}:${target}`;
  const payloadSignature = stableSerializePilotMutationPayload(body);
  const current = pendingMutations.get(key);
  const pending = current?.payloadSignature === payloadSignature
    ? current
    : {
        mutationId: typeof body.mutationId === "string"
          ? body.mutationId
          : createMutationId(`${body.action}-mutation`),
        payloadSignature,
      };
  pendingMutations.set(key, pending);
  return { ...body, mutationId: pending.mutationId };
}

export function clearStableReplayMutation(
  body: Record<string, unknown>,
  pendingMutations: Map<string, PendingStableReplayMutation>,
) {
  if (!isStableReplayMutationAction(body.action)) {
    return;
  }
  const target = typeof body.taskId === "string" ? body.taskId : "session";
  const key = `${body.action}:${target}`;
  if (pendingMutations.get(key)?.mutationId === body.mutationId) {
    pendingMutations.delete(key);
  }
}

export function isStableReplayMutationAction(
  value: unknown,
): value is StableReplayMutationAction {
  return value === "complete-task"
    || value === "record-stage-evidence"
    || value === "request-scaffold"
    || value === "select-stage"
    || value === "select-task";
}

export function readExpectedPilotEvidenceRevision(
  explicitRevision: unknown,
  currentRevision: number | undefined,
) {
  if (Number.isSafeInteger(explicitRevision) && Number(explicitRevision) >= 0) {
    return Number(explicitRevision);
  }
  if (Number.isSafeInteger(currentRevision) && Number(currentRevision) >= 0) {
    return Number(currentRevision);
  }
  throw new Error("AAIS learner pilot-evidence revision is unavailable.");
}

export function stableSerializePilotMutationPayload(body: LearningSessionPatchBody) {
  const payload = Object.fromEntries(Object.entries(body).filter(([field]) =>
    field !== "dataGeneration"
    && field !== "expectedPilotEvidenceRevision"
    && field !== "mutationId"
  ));
  return stableSerializeJsonValue(payload);
}

function stableSerializeJsonValue(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) {
    return `[${value.map((entry) => stableSerializeJsonValue(entry ?? null)).join(",")}]`;
  }
  if (typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, entry]) => entry !== undefined)
      .sort(([left], [right]) => left.localeCompare(right));
    return `{${entries.map(([key, entry]) =>
      `${JSON.stringify(key)}:${stableSerializeJsonValue(entry)}`
    ).join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

export function isExplicitClientRejection(error: unknown) {
  const status = error && typeof error === "object" && "status" in error
    ? (error as { status?: unknown }).status
    : null;
  return typeof status === "number" && status >= 400 && status < 500;
}

export function getAiUseModeMutationValue(body: LearningSessionPatchBody) {
  if (
    body.action !== "save-pilot-evidence"
    || !body.pilotEvidence
    || typeof body.pilotEvidence !== "object"
    || Array.isArray(body.pilotEvidence)
  ) {
    return null;
  }
  const aiUseMode = (body.pilotEvidence as Record<string, unknown>).aiUseMode;
  return aiUseMode === "ai-supported" || aiUseMode === "ai-free" ? aiUseMode : null;
}
