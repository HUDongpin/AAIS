import { useState } from "react";
import {
  deleteAaisAppSession,
  deleteLearnerPrivacyData,
  fetchLearnerPrivacyData,
} from "@/components/pages/learning/learning-session-client";
import { replaceAaisBrowserLocation } from "@/lib/client/aais-browser-navigation";
import {
  createLearnerDataFileName,
  saveJsonDocumentToLocal,
} from "@/components/pages/learning/document-markdown";
import {
  admitAaisResearchAction,
  captureAaisResearchActorGeneration,
  classifyAaisResearchClientError,
  clearAaisResearchTelemetryForActor,
  createAaisResearchLogoutContext,
  createAaisResearchOperationId,
  flushAaisResearchTelemetry,
  getAaisResearchTelemetryPendingCount,
  recordAaisResearchEvent,
} from "@/lib/client/aais-research-telemetry";

type UseLearningAccountInput = {
  operationBusy: boolean;
  onLearnerDataDeleteStarted: () => void;
  studentId: string;
};

export function useLearningAccount({
  operationBusy,
  onLearnerDataDeleteStarted,
  studentId,
}: UseLearningAccountInput) {
  const [accountMenuOpen, setAccountMenuOpen] = useState(false);
  const [loggingOut, setLoggingOut] = useState(false);
  const [privacyBusy, setPrivacyBusy] = useState(false);
  const [accountStatus, setAccountStatus] = useState("");
  const [accountError, setAccountError] = useState("");

  async function handleLogout() {
    if (loggingOut) {
      return;
    }
    if (operationBusy || privacyBusy) {
      setAccountError("请等待当前保存、下载或智能体操作完成后再退出。");
      return;
    }
    const telemetryActorGeneration = captureAaisResearchActorGeneration();
    const operationId = createAaisResearchOperationId("account-logout");
    const researchLogout = createAaisResearchLogoutContext(operationId);
    if (!admitAaisResearchAction({
      actorGeneration: telemetryActorGeneration,
      eventName: "account_logout",
      outcome: "attempted",
      detail: {
        operation_id: operationId,
      },
    })) {
      return;
    }
    setLoggingOut(true);
    setAccountStatus("正在退出...");
    setAccountError("");
    const telemetryFlushed = await flushResearchTelemetryBeforeActorClear();
    if (telemetryActorGeneration !== captureAaisResearchActorGeneration()) {
      setLoggingOut(false);
      return;
    }
    if (!telemetryFlushed) {
      setAccountStatus("");
      setAccountError("研究事件尚未安全同步，请保持联网并稍后重试退出。");
      setLoggingOut(false);
      return;
    }
    try {
      const logoutResult = await deleteAaisAppSession(researchLogout);
      if (!logoutResult.sessionRevoked) {
        throw new Error("AAIS logout revocation was not acknowledged.");
      }
      if (researchLogout && !logoutResult.researchAcknowledged) {
        // The product session is already revoked and must still be cleared.
        // Keep a non-sensitive, durable operator/participant-visible marker so
        // the missing final research ACK is never mistaken for a complete run.
        window.sessionStorage.setItem("aais_research_logout_ack_gap_v1", "1");
      } else {
        window.sessionStorage.removeItem("aais_research_logout_ack_gap_v1");
      }
    } catch {
      if (researchLogout) {
        recordAaisResearchEvent({
          actorGeneration: telemetryActorGeneration,
          clientEventId: researchLogout.failureClientEventId,
          clientTime: researchLogout.finalClientTime,
          eventName: "account_logout",
          outcome: "failure",
          detail: {
            operation_id: operationId,
            error_kind: "session_revoke_failed",
          },
        });
        await flushAaisResearchTelemetry();
      }
      setAccountStatus("");
      setAccountError("退出未完成，服务器会话仍保持有效。请恢复连接后重试。");
      setLoggingOut(false);
      return;
    }
    if (telemetryActorGeneration === captureAaisResearchActorGeneration()) {
      clearAaisResearchTelemetryForActor();
      window.localStorage.removeItem("aais_student_id");
      window.localStorage.removeItem("aais_display_name");
      setAccountMenuOpen(false);
    }
    replaceAaisBrowserLocation(
      window.sessionStorage.getItem("aais_research_logout_ack_gap_v1") === "1"
        ? "/login?researchLogout=ack-failed"
        : "/login",
    );
    setLoggingOut(false);
  }

  async function handleExportLearnerData() {
    if (privacyBusy) {
      return;
    }
    const telemetryActorGeneration = captureAaisResearchActorGeneration();
    const operationId = createAaisResearchOperationId("learner-export");
    const startedAt = clientNowMs();
    if (!admitAaisResearchAction({
      actorGeneration: telemetryActorGeneration,
      eventName: "learner_data_export",
      outcome: "attempted",
      detail: {
        operation_id: operationId,
      },
    })) {
      return;
    }
    setPrivacyBusy(true);
    setAccountStatus("正在导出学习数据...");
    setAccountError("");
    try {
      const data = await fetchLearnerPrivacyData();
      await saveJsonDocumentToLocal({
        fileName: createLearnerDataFileName(studentId),
        data,
      });
      setAccountStatus("学习数据已导出。");
      setAccountMenuOpen(false);
      recordAaisResearchEvent({
        actorGeneration: telemetryActorGeneration,
        eventName: "learner_data_export",
        outcome: "success",
        latencyMs: clientNowMs() - startedAt,
        detail: {
          operation_id: operationId,
        },
      });
    } catch (error) {
      setAccountStatus("");
      setAccountError("学习数据导出未能完成，请稍后重试。");
      recordAaisResearchEvent({
        actorGeneration: telemetryActorGeneration,
        eventName: "learner_data_export",
        outcome: "failure",
        latencyMs: clientNowMs() - startedAt,
        detail: {
          operation_id: operationId,
          error_kind: isUserCancelledFilePicker(error)
            ? "user_cancelled"
            : classifyAaisResearchClientError(error),
        },
      });
    } finally {
      setPrivacyBusy(false);
    }
  }

  async function handleDeleteLearnerData() {
    if (privacyBusy) {
      return;
    }
    const telemetryActorGeneration = captureAaisResearchActorGeneration();
    const operationId = createAaisResearchOperationId("learner-delete");
    const startedAt = clientNowMs();
    const confirmed = window.confirm("确定要删除当前学习数据吗？此操作会清除你的学习记录，但不会删除账号。");
    if (!confirmed) {
      recordAaisResearchEvent({
        actorGeneration: telemetryActorGeneration,
        eventName: "learner_data_delete",
        outcome: "failure",
        latencyMs: clientNowMs() - startedAt,
        detail: {
          operation_id: operationId,
          confirmed: false,
          error_kind: "user_cancelled",
        },
      });
      return;
    }
    if (!admitAaisResearchAction({
      actorGeneration: telemetryActorGeneration,
      eventName: "learner_data_delete",
      outcome: "attempted",
      detail: {
        operation_id: operationId,
        confirmed: true,
      },
    })) {
      return;
    }
    setPrivacyBusy(true);
    setAccountStatus("正在删除学习数据...");
    setAccountError("");
    onLearnerDataDeleteStarted();
    try {
      await deleteLearnerPrivacyData();
      setAccountStatus("学习数据已删除。");
      setAccountMenuOpen(false);
      recordAaisResearchEvent({
        actorGeneration: telemetryActorGeneration,
        eventName: "learner_data_delete",
        outcome: "success",
        latencyMs: clientNowMs() - startedAt,
        detail: {
          operation_id: operationId,
          confirmed: true,
        },
      });
    } catch (error) {
      setAccountStatus("");
      setAccountError("学习数据删除未能完成，请稍后重试。");
      recordAaisResearchEvent({
        actorGeneration: telemetryActorGeneration,
        eventName: "learner_data_delete",
        outcome: "failure",
        latencyMs: clientNowMs() - startedAt,
        detail: {
          operation_id: operationId,
          confirmed: true,
          error_kind: classifyAaisResearchClientError(error),
        },
      });
    } finally {
      setPrivacyBusy(false);
    }
  }

  function toggleAccountMenu() {
    const nextOpen = !accountMenuOpen;
    if (!admitAaisResearchAction({
      eventName: "account_menu_toggled",
      outcome: "success",
      detail: {
        operation_id: createAaisResearchOperationId("account-menu"),
        value_id: nextOpen ? "open" : "closed",
      },
    })) {
      return;
    }
    setAccountMenuOpen(nextOpen);
  }

  return {
    accountError,
    accountMenuOpen,
    accountStatus,
    handleDeleteLearnerData,
    handleExportLearnerData,
    handleLogout,
    loggingOut,
    privacyBusy,
    toggleAccountMenu,
  };
}

function clientNowMs() {
  return typeof performance !== "undefined" ? performance.now() : Date.now();
}

async function flushResearchTelemetryBeforeActorClear(maxWaitMs = 5_000) {
  let timeoutId: ReturnType<typeof setTimeout> | undefined;
  await Promise.race([
    flushAaisResearchTelemetry(),
    new Promise<void>((resolve) => {
      timeoutId = setTimeout(resolve, maxWaitMs);
    }),
  ]);
  if (timeoutId) {
    clearTimeout(timeoutId);
  }
  return getAaisResearchTelemetryPendingCount() === 0;
}

function isUserCancelledFilePicker(error: unknown) {
  return error instanceof Error && error.name === "AbortError";
}
