"use client";
import { useEffect, useRef, useState } from "react";
import { artifactSaveDebounceMs } from "@/components/pages/learning/learning-page-constants";
import { ContentResizeSeparator, ContentSidePanel } from "@/components/pages/learning/content-side-panel";
import { GuidePanel } from "@/components/pages/learning/guide-panel";
import { LearningAccountFeedback, LearningTopBar } from "@/components/pages/learning/learning-top-bar";
import { getLearningCopy } from "@/components/pages/learning/learning-copy";
import { useLearningAccount } from "@/components/pages/learning/use-learning-account";
import { useContentPanelResize } from "@/components/pages/learning/use-content-panel-resize";
import { useLearningGuide } from "@/components/pages/learning/use-learning-guide";
import { useLearningDocumentArchive } from "@/components/pages/learning/use-learning-document-archive";
import { useLearningWorkspaceSession } from "@/components/pages/learning/use-learning-workspace-session";
import { clientNowMs, createArtifactSaveEventDetail, isUserCancelledFilePicker, type PendingArtifactSave } from "@/components/pages/learning/client-helpers";
import { LearningResearchWorkspaceBoundary, type LearningResearchBoundary } from "@/components/pages/learning/research-telemetry-boundary";
import { admitAaisResearchAction, captureAaisResearchActorGeneration, classifyAaisResearchClientError, createAaisResearchOperationId, recordAaisResearchEvent } from "@/lib/client/aais-research-telemetry";
import { createLearningDocumentFileName, createLearningDocumentMarkdown, saveMarkdownDocumentToLocal } from "@/components/pages/learning/document-markdown";
import type { ContentItemId, ContentTab, SavedLearningDocument } from "@/components/pages/learning/learning-page-types";
import type { Locale } from "@/data/aais";
import { useLearningLocale } from "@/components/pages/learning/use-learning-locale";
export type LearningPageActor = { id: string; displayName: string };
export type LearningPageResearchBoundary = LearningResearchBoundary;
export function LearningPage({ actor, locale: initialLocale = "zh-CN", research }: {
  actor: LearningPageActor;
  locale?: Locale;
  research: LearningResearchBoundary;
}) {
  return (
    <LearningResearchWorkspaceBoundary locale={initialLocale} research={research}>
      <LearningWorkbench actor={actor} initialLocale={initialLocale} />
    </LearningResearchWorkspaceBoundary>
  );
}
function LearningWorkbench({ actor, initialLocale }: { actor: LearningPageActor; initialLocale: Locale }) {
  const locale = useLearningLocale(initialLocale);
  const copy = getLearningCopy(locale);
  const studentId = actor.id;
  const [activeTab, setActiveTab] = useState<ContentTab>("display");
  const [activeContentId, setActiveContentId] = useState<ContentItemId | null>(null);
  const [documentTitle, setDocumentTitle] = useState("");
  const [activeHistoryDocumentId, setActiveHistoryDocumentId] = useState<string | null>(null);
  const [artifactSaveBusy, setArtifactSaveBusy] = useState(false);
  const [artifactSaveStatus, setArtifactSaveStatus] = useState("");
  const [artifactSaveError, setArtifactSaveError] = useState("");
  const [documentCloseError, setDocumentCloseError] = useState("");
  const [documentDownloadBusy, setDocumentDownloadBusy] = useState(false);
  const [documentDownloadStatus, setDocumentDownloadStatus] = useState("");
  const [documentDownloadError, setDocumentDownloadError] = useState("");
  const artifactSaveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const artifactSaveInFlightRef = useRef(false);
  const pendingArtifactSaveRef = useRef<PendingArtifactSave | null>(null);
  const {
    activeTaskId,
    artifactText,
    backendError,
    historyDocuments,
    lastSavedArtifactLengthRef,
    patchSession,
    persistedGuideMessages,
    resetWorkspaceSession,
    setArtifactText,
    setBackendError,
    setHistoryDocuments,
  } = useLearningWorkspaceSession(locale);
  const {
    contentPanelWidth,
    getMaxContentPanelWidth,
    resizeContentPanelBy,
    setContentPanelWidth,
    splitLayoutRef,
    startContentPanelResize,
  } = useContentPanelResize();
  const {
    addGuideFiles,
    guideAttachmentBusy,
    guideAttachmentError,
    guideAttachments,
    guideBusy,
    guideDraft,
    guideError,
    guideFileInputRef,
    guideMessages,
    hasGuideSubmission,
    removeGuideAttachment,
    sendGuideMessage,
    setGuideDraft,
    setGuideError,
    submitGuideQuestion,
  } = useLearningGuide({
    activeTaskId,
    artifactText,
    displayName: actor.displayName, locale, persistedGuideMessages, studentId,
  });
  const {
    accountError,
    accountMenuOpen,
    accountStatus,
    handleDeleteLearnerData,
    handleExportLearnerData,
    handleLogout,
    loggingOut,
    privacyBusy,
    toggleAccountMenu,
  } = useLearningAccount({
    operationBusy:
      guideBusy || guideAttachmentBusy || artifactSaveBusy || documentDownloadBusy,
    onLearnerDataDeleteStarted: resetLearnerWorkspace,
    locale,
    studentId,
  });

  function resetLearnerWorkspace() {
    setArtifactSaveStatus("");
    setArtifactSaveError("");
    setDocumentCloseError("");
    setDocumentDownloadStatus("");
    setDocumentDownloadError("");
    if (artifactSaveTimerRef.current) {
      clearTimeout(artifactSaveTimerRef.current);
      artifactSaveTimerRef.current = null;
    }
    pendingArtifactSaveRef.current = null;
    resetWorkspaceSession();
    setActiveTab("display");
    setActiveContentId(null);
    setDocumentTitle("");
    setHistoryDocuments([]);
    setActiveHistoryDocumentId(null);
  }
  function flushPendingArtifactSave(trigger = "manual") {
    const pending = pendingArtifactSaveRef.current;
    if (artifactSaveTimerRef.current) {
      clearTimeout(artifactSaveTimerRef.current);
      artifactSaveTimerRef.current = null;
    }
    if (!pending) {
      return true;
    }
    if (artifactSaveInFlightRef.current) {
      setArtifactSaveStatus(copy.document.saveQueuedWhileSaving);
      return true;
    }
    const operationId = createAaisResearchOperationId("artifact-save");
    const telemetryActorGeneration = captureAaisResearchActorGeneration();
    const startedAt = clientNowMs();
    const previousCharacters = lastSavedArtifactLengthRef.current;
    const eventDetail = createArtifactSaveEventDetail({
      operationId,
      pending,
      previousCharacters,
      trigger,
    });
    if (!admitAaisResearchAction({
      actorGeneration: telemetryActorGeneration,
      eventName: "document_artifact_save",
      outcome: "attempted",
      detail: eventDetail,
    })) {
      pendingArtifactSaveRef.current = pending;
      setArtifactSaveStatus(copy.document.saveResearchPaused);
      return false;
    }
    pendingArtifactSaveRef.current = null;
    artifactSaveInFlightRef.current = true;
    setArtifactSaveBusy(true);
    setArtifactSaveStatus(copy.document.saving);
    setArtifactSaveError("");
    void patchSession({
      action: "save-artifact",
      taskId: pending.taskId,
      artifactText: pending.value,
    })
      .then(() => {
        lastSavedArtifactLengthRef.current = pending.value.length;
        if (!pendingArtifactSaveRef.current) {
          setArtifactSaveStatus(copy.document.saved);
        }
        recordAaisResearchEvent({
          actorGeneration: telemetryActorGeneration,
          eventName: "document_artifact_save",
          outcome: "success",
          latencyMs: clientNowMs() - startedAt,
          detail: eventDetail,
        });
      })
      .catch((error) => {
        const message = copy.document.saveFailed;
        setBackendError(message);
        setArtifactSaveStatus("");
        setArtifactSaveError(message);
        recordAaisResearchEvent({
          actorGeneration: telemetryActorGeneration,
          eventName: "document_artifact_save",
          outcome: "failure",
          latencyMs: clientNowMs() - startedAt,
          detail: {
            ...eventDetail,
            error_kind: classifyAaisResearchClientError(error),
          },
        });
      })
      .finally(() => {
        artifactSaveInFlightRef.current = false;
        setArtifactSaveBusy(false);
        if (pendingArtifactSaveRef.current) {
          flushPendingArtifactSave("queued");
        }
      });
    return true;
  }

  function scheduleArtifactSave(taskId: string, value: string) {
    setArtifactSaveStatus(copy.document.saveQueued);
    setArtifactSaveError("");
    pendingArtifactSaveRef.current = {
      taskId,
      value,
    };
    if (artifactSaveTimerRef.current) {
      clearTimeout(artifactSaveTimerRef.current);
    }
    artifactSaveTimerRef.current = setTimeout(
      () => flushPendingArtifactSave("debounce"),
      artifactSaveDebounceMs,
    );
  }

  function cancelPendingArtifactSave() {
    if (artifactSaveTimerRef.current) {
      clearTimeout(artifactSaveTimerRef.current);
      artifactSaveTimerRef.current = null;
    }
    pendingArtifactSaveRef.current = null;
  }

  function restorePendingArtifactSave(taskId: string, value: string) {
    scheduleArtifactSave(taskId, value);
  }

  function recordArtifact(value: string) {
    setDocumentDownloadStatus("");
    setDocumentDownloadError("");
    setDocumentCloseError("");
    setArtifactText(value);
    scheduleArtifactSave(activeTaskId, value);
  }

  function selectContentTab(nextTab: ContentTab) {
    if (!admitAaisResearchAction({
      eventName: "content_tab_selected",
      outcome: "success",
      detail: {
        operation_id: createAaisResearchOperationId("content-tab"),
        tab_id: nextTab,
      },
    })) {
      return;
    }
    setActiveTab(nextTab);
    if (nextTab === "display") {
      setActiveContentId(null);
      setActiveHistoryDocumentId(null);
    }
  }

  const saveAndCloseDocument = useLearningDocumentArchive({
    activeHistoryDocumentId,
    activeTaskId,
    artifactSaveBusy,
    artifactText,
    cancelPendingArtifactSave,
    documentTitle,
    hasPendingArtifactSave: () => Boolean(pendingArtifactSaveRef.current),
    locale,
    patchSession,
    restorePendingArtifactSave,
    setActiveContentId,
    setActiveHistoryDocumentId,
    setActiveTab,
    setArtifactSaveBusy,
    setArtifactSaveError,
    setArtifactSaveStatus,
    setDocumentCloseError,
    setDocumentTitle,
  });

  async function downloadDocumentToLocal() {
    if (documentDownloadBusy) {
      return;
    }
    const operationId = createAaisResearchOperationId("document-download");
    const telemetryActorGeneration = captureAaisResearchActorGeneration();
    const startedAt = clientNowMs();
    const downloadMethod = "showSaveFilePicker" in window ? "file_picker" : "browser_download";
    if (!flushPendingArtifactSave("download")) {
      return;
    }
    const downloadDetail = {
      operation_id: operationId,
      task_id: activeTaskId,
      download_method: downloadMethod,
      artifact_length: artifactText.length,
    };
    if (!admitAaisResearchAction({
      actorGeneration: telemetryActorGeneration,
      eventName: "document_download",
      outcome: "attempted",
      detail: downloadDetail,
    })) {
      return;
    }
    setDocumentDownloadBusy(true);
    setDocumentDownloadStatus(copy.document.downloadPreparing);
    setDocumentDownloadError("");
    try {
      await saveMarkdownDocumentToLocal({
        fileName: createLearningDocumentFileName(activeTaskId),
        markdown: createLearningDocumentMarkdown(artifactText),
      });
      setDocumentDownloadStatus(copy.document.downloadReady);
      recordAaisResearchEvent({
        actorGeneration: telemetryActorGeneration,
        eventName: "document_download",
        outcome: "success",
        latencyMs: clientNowMs() - startedAt,
        detail: downloadDetail,
      });
    } catch (error) {
      const message = copy.document.downloadFailed;
      setBackendError(message);
      setDocumentDownloadStatus("");
      setDocumentDownloadError(message);
      recordAaisResearchEvent({
        actorGeneration: telemetryActorGeneration,
        eventName: "document_download",
        outcome: "failure",
        latencyMs: clientNowMs() - startedAt,
        detail: {
          ...downloadDetail,
          error_kind: isUserCancelledFilePicker(error)
            ? "user_cancelled"
            : classifyAaisResearchClientError(error),
        },
      });
    } finally {
      setDocumentDownloadBusy(false);
    }
  }

  function openHistoryDocument(document: SavedLearningDocument) {
    if (!admitAaisResearchAction({
      eventName: "history_document_opened",
      outcome: "success",
      detail: {
        operation_id: createAaisResearchOperationId("history-document"),
        task_id: document.taskId,
        document_id: document.id,
        title_length: document.title.length,
        artifact_length: document.html.length,
      },
    })) {
      return;
    }
    setDocumentTitle(document.title);
    setArtifactText(document.html);
    setActiveHistoryDocumentId(document.id);
    setActiveContentId(null);
    setActiveTab("editor");
  }
  function openContentItem(contentId: ContentItemId) {
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

  useEffect(() => () => {
    if (artifactSaveTimerRef.current) {
      clearTimeout(artifactSaveTimerRef.current);
    }
  }, []);

  return (
    <div
      className="aais-learning-serif min-h-[100dvh] bg-[#fcfcfc] text-[#0e0e0e]"
      data-locale={locale}
      lang={locale}
    >
      <main
        data-testid="learning-shell"
        className="flex min-h-[100dvh] w-full max-w-none flex-col bg-[#fcfcfc] text-[#0e0e0e] lg:h-[100dvh] lg:overflow-hidden"
        aria-labelledby="aais-learning-heading"
        aria-describedby="aais-learning-description"
      >
        <h1 id="aais-learning-heading" className="sr-only">
          {copy.main.heading}
        </h1>
        <p id="aais-learning-description" className="sr-only">
          {copy.main.description}
        </p>

        <LearningTopBar
          accountMenuOpen={accountMenuOpen}
          displayName={actor.displayName}
          loggingOut={loggingOut}
          locale={locale}
          privacyBusy={privacyBusy}
          onDeleteLearnerData={() => { void handleDeleteLearnerData(); }}
          onExportLearnerData={() => { void handleExportLearnerData(); }}
          onLogout={handleLogout}
          onToggleAccountMenu={toggleAccountMenu}
        />

        <LearningAccountFeedback error={accountError} status={accountStatus} />

        <div
          ref={splitLayoutRef}
          data-testid="learning-split-layout"
          data-content-panel-width={Math.round(contentPanelWidth)}
          className="aais-learning-split-layout grid min-h-0 flex-1 lg:overflow-hidden"
        >
          <GuidePanel
            addGuideFiles={(files) => { void addGuideFiles(files); }}
            backendError={backendError}
            guideAttachmentBusy={guideAttachmentBusy}
            guideAttachmentError={guideAttachmentError}
            guideAttachments={guideAttachments}
            guideBusy={guideBusy}
            guideDraft={guideDraft}
            guideError={guideError}
            guideFileInputRef={guideFileInputRef}
            guideMessages={guideMessages}
            hasGuideSubmission={hasGuideSubmission}
            locale={locale}
            onRemoveAttachment={removeGuideAttachment}
            onSubmitGuideQuestion={(question, options) => { void submitGuideQuestion(question, options); }}
            sendGuideMessage={sendGuideMessage}
            setGuideDraft={setGuideDraft}
            setGuideError={setGuideError}
          />

          <ContentResizeSeparator
            contentPanelWidth={contentPanelWidth}
            getMaxContentPanelWidth={getMaxContentPanelWidth}
            locale={locale}
            onResizeBy={resizeContentPanelBy}
            onResizeStart={startContentPanelResize}
            setContentPanelWidth={setContentPanelWidth}
          />

          <ContentSidePanel
            activeContentId={activeContentId}
            activeTab={activeTab}
            artifactSaveBusy={artifactSaveBusy}
            artifactSaveError={documentCloseError || artifactSaveError}
            artifactSaveStatus={artifactSaveStatus}
            artifactText={artifactText}
            documentDownloadBusy={documentDownloadBusy}
            documentDownloadError={documentDownloadError}
            documentDownloadStatus={documentDownloadStatus}
            documentTitle={documentTitle}
            flushPendingArtifactSave={() => flushPendingArtifactSave("blur")}
            historyDocuments={historyDocuments}
            locale={locale}
            onDocumentTitleChange={setDocumentTitle}
            onDownloadDocument={() => { void downloadDocumentToLocal(); }}
            onOpenDocument={openHistoryDocument}
            onRecordArtifact={recordArtifact}
            onSaveAndCloseDocument={saveAndCloseDocument}
            selectContentTab={selectContentTab}
            onBackContent={returnToContentMenu}
            onOpenContent={openContentItem}
          />
        </div>
      </main>
    </div>
  );
}
