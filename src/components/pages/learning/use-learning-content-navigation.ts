import { useState } from "react";
import type {
  AaisClientSession,
  ContentItemId,
} from "@/components/pages/learning/learning-page-types";
import type { LearningSessionPatchBody } from "@/components/pages/learning/learning-session-client";
import {
  admitAaisResearchAction,
  createAaisResearchOperationId,
} from "@/lib/client/aais-research-telemetry";

export function useLearningContentNavigation({
  activeTaskId,
  flushPendingArtifactSave,
  hasUncommittedArtifactSave,
  onOpenTaskEditor,
  patchSession,
  taskActionErrorMessage,
}: {
  activeTaskId: string;
  flushPendingArtifactSave: (trigger: string) => boolean;
  hasUncommittedArtifactSave: () => boolean;
  onOpenTaskEditor: () => void;
  patchSession: (body: LearningSessionPatchBody) => Promise<AaisClientSession>;
  taskActionErrorMessage: string;
}) {
  const [activeContentId, setActiveContentId] = useState<ContentItemId | null>(null);
  const [taskActionBusy, setTaskActionBusy] = useState(false);
  const [taskActionError, setTaskActionError] = useState("");

  function resetContentNavigation() {
    setActiveContentId(null);
    setTaskActionBusy(false);
    setTaskActionError("");
  }

  function openContentItem(contentId: ContentItemId) {
    if (hasUncommittedArtifactSave()) {
      flushPendingArtifactSave("content-navigation");
      return;
    }
    if (!admitAaisResearchAction({
      eventName: "content_item_opened",
      outcome: "success",
      detail: {
        operation_id: createAaisResearchOperationId("content-item"),
        content_id: contentId,
      },
    })) {
      return;
    }
    setActiveContentId(contentId);
  }

  function returnToContentMenu() {
    if (hasUncommittedArtifactSave()) {
      flushPendingArtifactSave("content-navigation");
      return;
    }
    if (!admitAaisResearchAction({
      eventName: "content_item_back",
      outcome: "success",
      detail: {
        operation_id: createAaisResearchOperationId("content-back"),
        ...(activeContentId ? { content_id: activeContentId } : {}),
      },
    })) {
      return;
    }
    setActiveContentId(null);
  }

  async function selectLearningTask(taskId: string) {
    if (taskActionBusy) {
      return;
    }
    if (hasUncommittedArtifactSave()) {
      flushPendingArtifactSave("task-navigation");
      return;
    }
    setTaskActionBusy(true);
    setTaskActionError("");
    try {
      if (taskId !== activeTaskId) {
        await patchSession({
          action: "select-task",
          taskId,
        });
      }
      setActiveContentId(null);
      onOpenTaskEditor();
    } catch {
      setTaskActionError(taskActionErrorMessage);
    } finally {
      setTaskActionBusy(false);
    }
  }

  async function completeLearningTask(taskId: string) {
    if (taskActionBusy) {
      return;
    }
    if (hasUncommittedArtifactSave()) {
      flushPendingArtifactSave("task-completion");
      return;
    }
    setTaskActionBusy(true);
    setTaskActionError("");
    try {
      await patchSession({
        action: "complete-task",
        taskId,
      });
    } catch {
      setTaskActionError(taskActionErrorMessage);
    } finally {
      setTaskActionBusy(false);
    }
  }

  return {
    activeContentId,
    completeLearningTask,
    openContentItem,
    resetContentNavigation,
    returnToContentMenu,
    selectLearningTask,
    setActiveContentId,
    taskActionBusy,
    taskActionError,
  };
}
