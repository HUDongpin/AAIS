import { useCallback, useEffect, useRef, useState } from "react";
import { defaultTaskId } from "@/components/pages/learning/learning-page-constants";
import { getLearningCopy } from "@/components/pages/learning/learning-copy";
import {
  fetchLearningSession,
  patchLearningSession,
  type LearningSessionPatchBody,
} from "@/components/pages/learning/learning-session-client";
import type {
  AaisClientSession,
  GuideMessage,
} from "@/components/pages/learning/learning-page-types";
import { hydrateHistoryDocuments } from "@/components/pages/learning/document-markdown";
import type { SavedLearningDocument } from "@/components/pages/learning/learning-page-types";
import { getPersistedAttachmentGuideMessages } from "@/components/pages/learning/guide-message-persistence";
import {
  admitAaisResearchAction,
  captureAaisResearchActorGeneration,
  classifyAaisResearchClientError,
  createAaisResearchOperationId,
  recordAaisResearchEvent,
} from "@/lib/client/aais-research-telemetry";
import type { Locale } from "@/data/aais";

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
  const [learnerDataGeneration, setLearnerDataGeneration] = useState<number | null>(null);
  const [backendError, setBackendError] = useState("");
  const artifactRevisionRef = useRef(0);
  const taskTextRevisionsRef = useRef(new Map<string, {
    artifactRevision: number;
    selfReportRevision: number;
  }>());
  const lastSavedArtifactLengthRef = useRef(0);
  const sessionGenerationRef = useRef(0);
  const learnerDataGenerationRef = useRef<number | null>(null);
  const learnerDataGenerationWaitersRef = useRef<Array<(generation: number) => void>>([]);
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
      nextTaskTextRevisions.set(task.taskId, {
        artifactRevision: Math.max(current?.artifactRevision ?? 0, artifactRevision),
        selfReportRevision: Math.max(current?.selfReportRevision ?? 0, selfReportRevision),
      });
    }
    if (!Number.isSafeInteger(session.dataGeneration) || session.dataGeneration < 1) {
      throw new Error("AAIS learner data generation is unavailable.");
    }
    taskTextRevisionsRef.current = nextTaskTextRevisions;
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
      setPersistedGuideMessages(getPersistedAttachmentGuideMessages(session.guideMessages));
    }
    lastSavedArtifactLengthRef.current = selectedTask?.artifactText?.length ?? 0;
  }

  function setArtifactText(value: string) {
    artifactRevisionRef.current += 1;
    setArtifactTextState(value);
  }

  async function patchSession(body: LearningSessionPatchBody) {
    const sessionGeneration = sessionGenerationRef.current;
    const dataGeneration = learnerDataGenerationRef.current
      ?? await waitForLearnerDataGeneration();
    const requestBody = attachExpectedTextRevision(body);
    const session = await patchLearningSession({
      ...requestBody,
      dataGeneration,
    });
    if (sessionGeneration === sessionGenerationRef.current) {
      applySession(session, {
        preserveArtifactText: body.action === "save-artifact",
        preserveGuideMessages: true,
      });
      setBackendError("");
    }
    return session;
  }

  function attachExpectedTextRevision(body: LearningSessionPatchBody) {
    const action = body.action;
    if (
      action !== "save-artifact"
      && action !== "archive-artifact"
      && action !== "save-self-report"
    ) {
      return body;
    }
    if (typeof body.taskId !== "string") {
      throw new Error("AAIS learner task revision is unavailable.");
    }
    const revisions = taskTextRevisionsRef.current.get(body.taskId);
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

  const getArtifactRevision = useCallback((taskId: string) => {
    return taskTextRevisionsRef.current.get(taskId)?.artifactRevision ?? null;
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
    setActiveTaskId(defaultTaskId);
    setArtifactTextState("");
    setDocumentTitle("");
    setActiveHistoryDocumentId(null);
    setHistoryDocuments([]);
    setPersistedGuideMessages([]);
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
    documentTitle,
    lastSavedArtifactLengthRef,
    learnerDataGeneration,
    patchSession,
    persistedGuideMessages,
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
