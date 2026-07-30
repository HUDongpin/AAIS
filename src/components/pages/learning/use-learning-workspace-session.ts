import { useEffect, useRef, useState } from "react";
import { defaultTaskId } from "@/components/pages/learning/learning-page-constants";
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

export function useLearningWorkspaceSession() {
  const [activeTaskId, setActiveTaskId] = useState(defaultTaskId);
  const [artifactText, setArtifactText] = useState("");
  const [backendError, setBackendError] = useState("");
  const lastSavedArtifactLengthRef = useRef(0);
  const sessionGenerationRef = useRef(0);

  function applySession(session: AaisClientSession) {
    const nextTaskId = session.activeTaskId || defaultTaskId;
    setActiveTaskId(nextTaskId);
    const selectedTask =
      session.tasks?.find((task) => task.taskId === nextTaskId) ?? session.tasks?.[0];
    setArtifactText(selectedTask?.artifactText ?? "");
    lastSavedArtifactLengthRef.current = selectedTask?.artifactText?.length ?? 0;
  }

  async function patchSession(body: LearningSessionPatchBody) {
    const session = await patchLearningSession(body);
    applySession(session);
    setBackendError("");
    return session;
  }

  function resetWorkspaceSession() {
    sessionGenerationRef.current += 1;
    setActiveTaskId(defaultTaskId);
    setArtifactText("");
    setBackendError("");
  }

  useEffect(() => {
    let cancelled = false;
    const sessionGeneration = sessionGenerationRef.current;

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
          applySession(session);
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
          setBackendError("学习记录服务暂时不可用，本页会保留当前输入但不会完成持久化。");
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
