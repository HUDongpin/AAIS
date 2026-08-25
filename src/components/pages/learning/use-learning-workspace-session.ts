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
  attachExpectedTextRevision,
  clearPendingPilotMutation,
  type TaskTextRevisions,
} from "@/components/pages/learning/learning-session-revisions";
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
  getAiUseModeMutationValue,
  isExplicitClientRejection,
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
  const tasksRef = useRef<AaisClientTaskRecord[]>([]);
  const [learnerDataGeneration, setLearnerDataGeneration] = useState<number | null>(null);
  const [backendError, setBackendError] = useState("");
  const artifactRevisionRef = useRef(0);
  const taskTextRevisionsRef = useRef(new Map<string, TaskTextRevisions>());
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
    const nextTasks = session.tasks ?? [];
    tasksRef.current = nextTasks;
    setTasks(nextTasks);
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
      requestBody = attachExpectedTextRevision(
        requestBody,
        taskTextRevisionsRef.current,
        pendingPilotMutationsRef.current,
        createAaisResearchOperationId,
      );
      const session = await patchLearningSession({
        ...requestBody,
        dataGeneration,
      });
      clearPendingPilotMutation(requestBody, pendingPilotMutationsRef.current);
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
        clearPendingPilotMutation(requestBody, pendingPilotMutationsRef.current);
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

  const getArtifactRevision = useCallback((taskId: string) => {
    return taskTextRevisionsRef.current.get(taskId)?.artifactRevision ?? null;
  }, []);

  function getAiUseModeMutationStatus(taskId: string) {
    // Reading the revision keeps this getter tied to the render that observed
    // the latest ref-backed mutation state without memoizing a stale identity.
    void aiUseModeMutationRevision;
    return aiUseModeMutationsRef.current.get(taskId)?.status ?? null;
  }

  const getTaskScaffoldRequests = useCallback((taskId: string) => {
    const count = tasksRef.current.find((task) => task.taskId === taskId)?.scaffoldRequests;
    return Number.isSafeInteger(count) && Number(count) >= 0 ? Number(count) : 0;
  }, []);

  const confirmTaskScaffoldRequests = useCallback((taskId: string, count: number) => {
    if (!Number.isSafeInteger(count) || count < 0) {
      return;
    }
    const nextTasks = tasksRef.current.map((task) =>
      task.taskId === taskId
        ? { ...task, scaffoldRequests: count }
        : task
    );
    tasksRef.current = nextTasks;
    setTasks(nextTasks);
  }, []);

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
    tasksRef.current = [];
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
    getTaskScaffoldRequests,
    documentTitle,
    lastSavedArtifactLengthRef,
    learnerDataGeneration,
    patchSession,
    persistedGuideMessages,
    requestScaffold,
    tasks,
    confirmTaskScaffoldRequests,
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
