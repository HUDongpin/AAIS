import { useCallback, useEffect, useRef, useState } from "react";
import { defaultTaskId } from "@/components/pages/learning/learning-page-constants";
import { getLearningCopy } from "@/components/pages/learning/learning-copy";
import {
  fetchLearningSession,
  patchLearningSession,
  requestLearningScaffold,
  type LearningSessionPatchBody,
} from "@/components/pages/learning/learning-session-client";
import type {
  AaisClientTaskRecord,
  AaisClientSession,
  GuideMessage,
} from "@/components/pages/learning/learning-page-types";
import { hydrateHistoryDocuments } from "@/components/pages/learning/document-markdown";
import type { SavedLearningDocument } from "@/components/pages/learning/learning-page-types";
import { getPersistedGuideMessages } from "@/components/pages/learning/guide-message-persistence";
import {
  admitAaisResearchAction,
  captureAaisResearchActorGeneration,
  classifyAaisResearchClientError,
  createAaisResearchOperationId,
  recordAaisResearchEvent,
} from "@/lib/client/aais-research-telemetry";
import type { Locale } from "@/data/aais";
import {
  attachStableReplayMutation,
  clearStableReplayMutation,
  createPendingPilotMutationKey,
  getAiUseModeMutationValue,
  isExplicitClientRejection,
  isPilotMutationAction,
  readExpectedPilotEvidenceRevision,
  stableSerializePilotMutationPayload,
  type PendingPilotMutation,
  type PendingStableReplayMutation,
} from "@/components/pages/learning/learning-pilot-mutation";

type AiUseModeMutationStatus = "pending" | "unsaved";

type AiUseModeMutationHandle = {
  taskId: string;
  token: string;
};

export function useLearningWorkspaceSession(
  locale: Locale = "zh-CN",
  initialDocument: {
    activeDocumentId?: string | null;
    artifactText?: string;
    documentTitle?: string;
  } = {},
) {
  const initialArtifactText = initialDocument.artifactText ?? "";
  const initialDocumentTitle = initialDocument.documentTitle ?? "";
  const initialActiveDocumentId = initialDocument.activeDocumentId ?? null;
  const hasInitialDocumentDraft = Boolean(
    initialArtifactText || initialDocumentTitle || initialActiveDocumentId,
  );
  const [activeTaskId, setActiveTaskId] = useState(defaultTaskId);
  const [artifactText, setArtifactTextState] = useState(initialArtifactText);
  const [documentTitle, setDocumentTitle] = useState(initialDocumentTitle);
  const [activeHistoryDocumentId, setActiveHistoryDocumentId] = useState<string | null>(
    initialActiveDocumentId,
  );
  const [historyDocuments, setHistoryDocuments] = useState<SavedLearningDocument[]>([]);
  const [persistedGuideMessages, setPersistedGuideMessages] = useState<GuideMessage[]>([]);
  const [tasks, setTasks] = useState<AaisClientTaskRecord[]>([]);
  const [learnerDataGeneration, setLearnerDataGeneration] = useState<number | null>(null);
  const [backendError, setBackendError] = useState("");
  const artifactRevisionRef = useRef(0);
  const taskTextRevisionsRef = useRef(new Map<string, {
    artifactRevision: number;
    pilotEvidenceRevision: number;
    selfReportRevision: number;
  }>());
  const lastSavedArtifactLengthRef = useRef(0);
  const sessionGenerationRef = useRef(0);
  const learnerDataGenerationRef = useRef<number | null>(null);
  const learnerDataGenerationWaitersRef = useRef<Array<(generation: number) => void>>([]);
  const pendingPilotMutationsRef = useRef(new Map<string, PendingPilotMutation>());
  const pendingStableMutationsRef = useRef(new Map<string, PendingStableReplayMutation>());
  const aiUseModeMutationsRef = useRef(new Map<string, {
    status: AiUseModeMutationStatus;
    token: string;
  }>());
  const [aiUseModeMutationRevision, setAiUseModeMutationRevision] = useState(0);
  const localeRef = useRef(locale);

  useEffect(() => {
    localeRef.current = locale;
  }, [locale]);

  function applySession(
    session: AaisClientSession,
    {
      preserveArtifactText = false,
      preserveGuideMessages = false,
    }: {
      preserveArtifactText?: boolean;
      preserveGuideMessages?: boolean;
    } = {},
  ) {
    const nextTaskTextRevisions = new Map(taskTextRevisionsRef.current);
    for (const task of session.tasks ?? []) {
      const current = nextTaskTextRevisions.get(task.taskId);
      const artifactRevision = Number.isSafeInteger(task.artifactRevision)
        && task.artifactRevision >= 0
        ? task.artifactRevision
        : current?.artifactRevision ?? 0;
      const selfReportRevision = Number.isSafeInteger(task.selfReportRevision)
        && task.selfReportRevision >= 0
        ? task.selfReportRevision
        : current?.selfReportRevision ?? 0;
      const pilotEvidenceRevision = Number.isSafeInteger(task.pilotEvidenceRevision)
        && Number(task.pilotEvidenceRevision) >= 0
        ? Number(task.pilotEvidenceRevision)
        : current?.pilotEvidenceRevision ?? 0;
      nextTaskTextRevisions.set(task.taskId, {
        artifactRevision: Math.max(current?.artifactRevision ?? 0, artifactRevision),
        pilotEvidenceRevision: Math.max(
          current?.pilotEvidenceRevision ?? 0,
          pilotEvidenceRevision,
        ),
        selfReportRevision: Math.max(current?.selfReportRevision ?? 0, selfReportRevision),
      });
    }
    if (!Number.isSafeInteger(session.dataGeneration) || session.dataGeneration < 1) {
      throw new Error("AAIS learner data generation is unavailable.");
    }
    taskTextRevisionsRef.current = nextTaskTextRevisions;
    setTasks(session.tasks ?? []);
    learnerDataGenerationRef.current = session.dataGeneration;
    setLearnerDataGeneration(session.dataGeneration);
    for (const resolve of learnerDataGenerationWaitersRef.current.splice(0)) {
      resolve(session.dataGeneration);
    }
    const nextTaskId = session.activeTaskId || defaultTaskId;
    setActiveTaskId(nextTaskId);
    const selectedTask =
      session.tasks?.find((task) => task.taskId === nextTaskId) ?? session.tasks?.[0];
    if (!preserveArtifactText) {
      setArtifactTextState(selectedTask?.artifactText ?? "");
      setDocumentTitle(selectedTask?.documentTitle ?? "");
      setActiveHistoryDocumentId(selectedTask?.activeDocumentId ?? null);
    }
    if (session.historyDocuments) {
      setHistoryDocuments(hydrateHistoryDocuments(session.historyDocuments));
    }
    if (!preserveGuideMessages) {
      setPersistedGuideMessages(getPersistedGuideMessages(session.guideMessages));
    }
    lastSavedArtifactLengthRef.current = selectedTask?.artifactText?.length ?? 0;
  }

  function setArtifactText(value: string) {
    artifactRevisionRef.current += 1;
    setArtifactTextState(value);
  }

  async function patchSession(body: LearningSessionPatchBody) {
    const aiUseModeMutation = beginAiUseModeMutation(body);
    const sessionGeneration = sessionGenerationRef.current;
    let requestBody = body;
    try {
      const dataGeneration = learnerDataGenerationRef.current
        ?? await waitForLearnerDataGeneration();
      requestBody = attachStableReplayMutation(
        body,
        pendingStableMutationsRef.current,
        createAaisResearchOperationId,
      );
      requestBody = attachExpectedTextRevision(requestBody);
      const session = await patchLearningSession({
        ...requestBody,
        dataGeneration,
      });
      clearPendingPilotMutation(requestBody);
      clearStableReplayMutation(requestBody, pendingStableMutationsRef.current);
      settleAiUseModeMutation(aiUseModeMutation, null);
      if (sessionGeneration === sessionGenerationRef.current) {
        applySession(session, {
          preserveArtifactText: body.action === "save-artifact",
          preserveGuideMessages: true,
        });
        setBackendError("");
      }
      return session;
    } catch (error) {
      if (isExplicitClientRejection(error)) {
        clearPendingPilotMutation(requestBody);
        clearStableReplayMutation(requestBody, pendingStableMutationsRef.current);
      }
      settleAiUseModeMutation(aiUseModeMutation, "unsaved");
      throw error;
    }
  }

  function beginAiUseModeMutation(
    body: LearningSessionPatchBody,
  ): AiUseModeMutationHandle | null {
    const aiUseMode = getAiUseModeMutationValue(body);
    if (!aiUseMode || typeof body.taskId !== "string") {
      return null;
    }
    const handle = {
      taskId: body.taskId,
      token: createAaisResearchOperationId("ai-use-mode-choice"),
    };
    aiUseModeMutationsRef.current.set(handle.taskId, {
      status: "pending",
      token: handle.token,
    });
    setAiUseModeMutationRevision((revision) => revision + 1);
    return handle;
  }

  function settleAiUseModeMutation(
    handle: AiUseModeMutationHandle | null,
    status: AiUseModeMutationStatus | null,
  ) {
    if (!handle || aiUseModeMutationsRef.current.get(handle.taskId)?.token !== handle.token) {
      return;
    }
    if (status) {
      aiUseModeMutationsRef.current.set(handle.taskId, {
        status,
        token: handle.token,
      });
    } else {
      aiUseModeMutationsRef.current.delete(handle.taskId);
    }
    setAiUseModeMutationRevision((revision) => revision + 1);
  }

  async function requestScaffold(taskId: string, toolId: string) {
    const sessionGeneration = sessionGenerationRef.current;
    const dataGeneration = learnerDataGenerationRef.current
      ?? await waitForLearnerDataGeneration();
    const requestBody = attachStableReplayMutation({
      action: "request-scaffold",
      dataGeneration,
      taskId,
      toolId,
    }, pendingStableMutationsRef.current, createAaisResearchOperationId);
    try {
      const result = await requestLearningScaffold({
        dataGeneration,
        mutationId: String(requestBody.mutationId),
        taskId,
        toolId,
      });
      clearStableReplayMutation(requestBody, pendingStableMutationsRef.current);
      if (sessionGeneration === sessionGenerationRef.current) {
        applySession(result.session, { preserveArtifactText: true, preserveGuideMessages: true });
        setBackendError("");
      }
      return result;
    } catch (error) {
      if (isExplicitClientRejection(error)) {
        clearStableReplayMutation(requestBody, pendingStableMutationsRef.current);
      }
      throw error;
    }
  }

  function attachExpectedTextRevision(body: LearningSessionPatchBody) {
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
    const revisions = taskTextRevisionsRef.current.get(body.taskId);
    if (action === "save-pilot-evidence" || action === "record-ai-acceptance") {
      if (body.expectedPilotEvidenceRevision !== undefined && body.mutationId !== undefined) {
        return body;
      }
      if (!revisions && body.expectedPilotEvidenceRevision === undefined) {
        throw new Error("AAIS learner pilot-evidence revision is unavailable.");
      }
      const pendingKey = createPendingPilotMutationKey(action, body.taskId);
      const payloadSignature = stableSerializePilotMutationPayload(body);
      const currentPending = pendingPilotMutationsRef.current.get(pendingKey);
      const pending = currentPending?.payloadSignature === payloadSignature
        ? currentPending
        : {
            expectedPilotEvidenceRevision: readExpectedPilotEvidenceRevision(
              body.expectedPilotEvidenceRevision,
              revisions?.pilotEvidenceRevision,
            ),
            mutationId: typeof body.mutationId === "string"
              ? body.mutationId
              : createAaisResearchOperationId(
                  action === "record-ai-acceptance"
                    ? "ai-acceptance-mutation"
                    : "pilot-evidence-mutation",
                ),
            payloadSignature,
          };
      pendingPilotMutationsRef.current.set(pendingKey, pending);
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

  function clearPendingPilotMutation(body: LearningSessionPatchBody) {
    if (!isPilotMutationAction(body.action) || typeof body.taskId !== "string") {
      return;
    }
    const key = createPendingPilotMutationKey(body.action, body.taskId);
    const pending = pendingPilotMutationsRef.current.get(key);
    if (pending?.mutationId === body.mutationId) {
      pendingPilotMutationsRef.current.delete(key);
    }
  }

  const getArtifactRevision = useCallback((taskId: string) => {
    return taskTextRevisionsRef.current.get(taskId)?.artifactRevision ?? null;
  }, []);

  function getAiUseModeMutationStatus(taskId: string) {
    // Reading the revision keeps this getter tied to the render that observed
    // the latest ref-backed mutation state without memoizing a stale identity.
    void aiUseModeMutationRevision;
    return aiUseModeMutationsRef.current.get(taskId)?.status ?? null;
  }

  function waitForLearnerDataGeneration() {
    const current = learnerDataGenerationRef.current;
    if (current !== null) {
      return current;
    }
    return new Promise<number>((resolve, reject) => {
      const timeout = window.setTimeout(() => {
        learnerDataGenerationWaitersRef.current = learnerDataGenerationWaitersRef.current
          .filter((waiter) => waiter !== resolveGeneration);
        reject(new Error("AAIS learner data generation is unavailable."));
      }, 10_000);
      const resolveGeneration = (generation: number) => {
        window.clearTimeout(timeout);
        resolve(generation);
      };
      learnerDataGenerationWaitersRef.current.push(resolveGeneration);
    });
  }

  function resetWorkspaceSession(nextDataGeneration: number | null = null) {
    sessionGenerationRef.current += 1;
    artifactRevisionRef.current += 1;
    taskTextRevisionsRef.current = new Map();
    pendingPilotMutationsRef.current.clear();
    pendingStableMutationsRef.current.clear();
    aiUseModeMutationsRef.current.clear();
    setAiUseModeMutationRevision((revision) => revision + 1);
    setActiveTaskId(defaultTaskId);
    setArtifactTextState("");
    setDocumentTitle("");
    setActiveHistoryDocumentId(null);
    setHistoryDocuments([]);
    setPersistedGuideMessages([]);
    setTasks([]);
    learnerDataGenerationRef.current = nextDataGeneration;
    setLearnerDataGeneration(nextDataGeneration);
    if (nextDataGeneration !== null) {
      for (const resolve of learnerDataGenerationWaitersRef.current.splice(0)) {
        resolve(nextDataGeneration);
      }
    }
    setBackendError("");
  }

  useEffect(() => {
    let cancelled = false;
    const sessionGeneration = sessionGenerationRef.current;
    const artifactRevision = artifactRevisionRef.current;

    async function loadSession() {
      const telemetryActorGeneration = captureAaisResearchActorGeneration();
      const operationId = createAaisResearchOperationId("session-load");
      const startedAt = clientNowMs();
      if (!admitAaisResearchAction({
        actorGeneration: telemetryActorGeneration,
        eventName: "workspace_session_load",
        outcome: "attempted",
        detail: {
          operation_id: operationId,
          trigger: "page_mount",
          task_id: defaultTaskId,
        },
      })) {
        return;
      }
      try {
        const session = await fetchLearningSession();
        if (!cancelled && sessionGeneration === sessionGenerationRef.current) {
          applySession(session, {
            preserveArtifactText: hasInitialDocumentDraft
              || artifactRevision !== artifactRevisionRef.current,
          });
          setBackendError("");
          recordAaisResearchEvent({
            actorGeneration: telemetryActorGeneration,
            eventName: "workspace_session_load",
            outcome: "success",
            latencyMs: clientNowMs() - startedAt,
            detail: {
              operation_id: operationId,
              trigger: "page_mount",
              task_id: session.activeTaskId || defaultTaskId,
            },
          });
        }
      } catch (error) {
        if (!cancelled && sessionGeneration === sessionGenerationRef.current) {
          setBackendError(getLearningCopy(localeRef.current).workspace.sessionUnavailable);
          recordAaisResearchEvent({
            actorGeneration: telemetryActorGeneration,
            eventName: "workspace_session_load",
            outcome: "failure",
            latencyMs: clientNowMs() - startedAt,
            detail: {
              operation_id: operationId,
              trigger: "page_mount",
              error_kind: classifyAaisResearchClientError(error),
            },
          });
        }
      }
    }

    void loadSession();

    return () => {
      cancelled = true;
    };
  }, [hasInitialDocumentDraft, initialArtifactText]);

  return {
    activeTaskId,
    activeHistoryDocumentId,
    artifactText,
    backendError,
    historyDocuments,
    getArtifactRevision,
    getAiUseModeMutationStatus,
    documentTitle,
    lastSavedArtifactLengthRef,
    learnerDataGeneration,
    patchSession,
    persistedGuideMessages,
    requestScaffold,
    tasks,
    resetWorkspaceSession,
    setArtifactText,
    setActiveHistoryDocumentId,
    setBackendError,
    setHistoryDocuments,
    setDocumentTitle,
    waitForLearnerDataGeneration,
  };
}

function clientNowMs() {
  return typeof performance !== "undefined" ? performance.now() : Date.now();
}
