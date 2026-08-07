import { useEffect, useRef, useState } from "react";
import { defaultTaskId } from "@/components/pages/learning/learning-page-constants";
import { getLearningCopy } from "@/components/pages/learning/learning-copy";
import {
  fetchLearningSession,
  patchLearningSession,
  type LearningSessionPatchBody,
} from "@/components/pages/learning/learning-session-client";
import type { AaisClientSession } from "@/components/pages/learning/learning-page-types";
import {
  admitAaisResearchAction,
  captureAaisResearchActorGeneration,
  classifyAaisResearchClientError,
  createAaisResearchOperationId,
  recordAaisResearchEvent,
} from "@/lib/client/aais-research-telemetry";
import type { Locale } from "@/data/aais";

export function useLearningWorkspaceSession(locale: Locale = "zh-CN") {
  const [activeTaskId, setActiveTaskId] = useState(defaultTaskId);
  const [artifactText, setArtifactTextState] = useState("");
  const [backendError, setBackendError] = useState("");
  const artifactRevisionRef = useRef(0);
  const lastSavedArtifactLengthRef = useRef(0);
  const sessionGenerationRef = useRef(0);
  const localeRef = useRef(locale);

  useEffect(() => {
    localeRef.current = locale;
  }, [locale]);

  function applySession(
    session: AaisClientSession,
    { preserveArtifactText = false }: { preserveArtifactText?: boolean } = {},
  ) {
    const nextTaskId = session.activeTaskId || defaultTaskId;
    setActiveTaskId(nextTaskId);
    const selectedTask =
      session.tasks?.find((task) => task.taskId === nextTaskId) ?? session.tasks?.[0];
    if (!preserveArtifactText) {
      setArtifactTextState(selectedTask?.artifactText ?? "");
    }
    lastSavedArtifactLengthRef.current = selectedTask?.artifactText?.length ?? 0;
  }

  function setArtifactText(value: string) {
    artifactRevisionRef.current += 1;
    setArtifactTextState(value);
  }

  async function patchSession(body: LearningSessionPatchBody) {
    const session = await patchLearningSession(body);
    applySession(session, {
      preserveArtifactText: body.action === "save-artifact",
    });
    setBackendError("");
    return session;
  }

  function resetWorkspaceSession() {
    sessionGenerationRef.current += 1;
    setActiveTaskId(defaultTaskId);
    setArtifactTextState("");
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
            preserveArtifactText: artifactRevision !== artifactRevisionRef.current,
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
  }, []);

  return {
    activeTaskId,
    artifactText,
    backendError,
    lastSavedArtifactLengthRef,
    patchSession,
    resetWorkspaceSession,
    setArtifactText,
    setBackendError,
  };
}

function clientNowMs() {
  return typeof performance !== "undefined" ? performance.now() : Date.now();
}
