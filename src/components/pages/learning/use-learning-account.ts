import { useState } from "react";
import {
  deleteAaisAppSession,
  deleteLearnerPrivacyData,
  fetchLearnerPrivacyData,
} from "@/components/pages/learning/learning-session-client";
import { replaceAaisBrowserLocation } from "@/lib/client/aais-browser-navigation";
import {
  createLearnerDataFileName,
  prepareJsonDocumentSaveToLocal,
} from "@/components/pages/learning/document-markdown";
import { getLearningCopy } from "@/components/pages/learning/learning-copy";
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
import type { Locale } from "@/data/aais";

type UseLearningAccountInput = {
  learnerDataGeneration: number | null;
  operationBusy: boolean;
  onLearnerDataDeleteSucceeded: (nextGeneration: number) => void;
  locale?: Locale;
  studentId: string;
};

export function useLearningAccount({
  learnerDataGeneration,
  operationBusy,
  onLearnerDataDeleteSucceeded,
  locale = "zh-CN",
  studentId,
}: UseLearningAccountInput) {
  const copy = getLearningCopy(locale);
  const [accountMenuOpen, setAccountMenuOpen] = useState(false);
  const [loggingOut, setLoggingOut] = useState(false);
  const [privacyBusy, setPrivacyBusy] = useState(false);
  const [learnerDeleteBusy, setLearnerDeleteBusy] = useState(false);
  const [accountStatus, setAccountStatus] = useState("");
  const [accountError, setAccountError] = useState("");

  async function performLogout(allowOperationBusy: boolean) {
    if (loggingOut) {
      return;
    }
    if ((!allowOperationBusy && operationBusy) || privacyBusy) {
      setAccountError(copy.account.waitForOperation);
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
    setAccountStatus(copy.account.signingOut);
    setAccountError("");
    // Ordinary (non-research) sessions must not be gated by a research queue.
    // A non-null context is the fail-closed proof that this logout belongs to a
    // validated formal-research visit and therefore requires a complete flush.
    const telemetryFlushed = researchLogout
      ? await flushResearchTelemetryBeforeActorClear()
      : true;
    if (telemetryActorGeneration !== captureAaisResearchActorGeneration()) {
      setLoggingOut(false);
      return;
    }
    if (!telemetryFlushed) {
      setAccountStatus("");
      setAccountError(copy.account.researchSyncRequired);
      setLoggingOut(false);
      return;
    }
    try {
      const logoutResult = await deleteAaisAppSession(researchLogout);
      if (!logoutResult.sessionRevoked && !logoutResult.sessionAbsent) {
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
      setAccountError(copy.account.signOutFailed);
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

  function handleLogout() {
    return performLogout(false);
  }

  function handleSessionFailureLogout() {
    return performLogout(true);
  }

  async function handleExportLearnerData() {
    if (privacyBusy) {
      return;
    }
    if (operationBusy || loggingOut) {
      setAccountStatus("");
      setAccountError(copy.account.waitForExportOperation);
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
    setAccountStatus(copy.account.exporting);
    setAccountError("");
    try {
      // The picker must be invoked from the original click activation. Waiting
      // for the export response first causes browsers to reject the picker.
      const saveDocument = await prepareJsonDocumentSaveToLocal({
        fileName: createLearnerDataFileName(studentId),
      });
      const data = await fetchLearnerPrivacyData();
      await saveDocument(data);
      setAccountStatus(copy.account.exported);
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
      setAccountError(isUserCancelledFilePicker(error) ? "" : copy.account.exportFailed);
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
    if (operationBusy || loggingOut) {
      setAccountError(copy.account.waitForOperation);
      return;
    }
    const telemetryActorGeneration = captureAaisResearchActorGeneration();
    const operationId = createAaisResearchOperationId("learner-delete");
    const startedAt = clientNowMs();
    const confirmed = window.confirm(copy.account.deleteConfirmation);
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
    setLearnerDeleteBusy(true);
    setAccountStatus(copy.account.deleting);
    setAccountError("");
    try {
      if (learnerDataGeneration === null) {
        throw new Error("AAIS learner data generation is unavailable.");
      }
      const deletionResult = await deleteLearnerPrivacyData(learnerDataGeneration);
      onLearnerDataDeleteSucceeded(deletionResult.deletion.nextGeneration);
      setAccountStatus(copy.account.deleted);
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
      setAccountError(copy.account.deleteFailed);
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
      setLearnerDeleteBusy(false);
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
    handleSessionFailureLogout,
    loggingOut,
    learnerDeleteBusy,
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
  return typeof error === "object"
    && error !== null
    && "name" in error
    && error.name === "AbortError";
}
