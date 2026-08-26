"use client";
import { useState } from "react";
import { ContentResizeSeparator, ContentSidePanel } from "@/components/pages/learning/content-side-panel";
import { GuidePanel } from "@/components/pages/learning/guide-panel";
import { LearningAccountFeedback, LearningTopBar } from "@/components/pages/learning/learning-top-bar";
import { getLearningCopy } from "@/components/pages/learning/learning-copy";
import { LearningSessionStatus } from "@/components/pages/learning/learning-session-status";
import { useLearningAccount } from "@/components/pages/learning/use-learning-account";
import { useContentPanelResize } from "@/components/pages/learning/use-content-panel-resize";
import { useLearningArtifactSave } from "@/components/pages/learning/use-learning-artifact-save";
import { useLearningGuide } from "@/components/pages/learning/use-learning-guide";
import { useLearningDocumentArchive } from "@/components/pages/learning/use-learning-document-archive";
import { useLearningContentNavigation } from "@/components/pages/learning/use-learning-content-navigation";
import { useHydratedArtifactDraft } from "@/components/pages/learning/use-hydrated-artifact-draft";
import { useLearningWorkspaceSession } from "@/components/pages/learning/use-learning-workspace-session";
import { createPilotLearningActions } from "@/components/pages/learning/pilot-learning-actions";
import { clientNowMs, isUserCancelledFilePicker, type ArtifactDraftJournal } from "@/components/pages/learning/client-helpers";
import { LearningResearchWorkspaceBoundary, type LearningResearchBoundary } from "@/components/pages/learning/research-telemetry-boundary";
import { admitAaisResearchAction, captureAaisResearchActorGeneration, classifyAaisResearchClientError, createAaisResearchOperationId, recordAaisResearchEvent } from "@/lib/client/aais-research-telemetry";
import { createLearningDocumentFileName, createLearningDocumentMarkdown, saveMarkdownDocumentToLocal } from "@/components/pages/learning/document-markdown";
import type { ContentTab, SavedLearningDocument } from "@/components/pages/learning/learning-page-types";
import type { Locale } from "@/data/aais";
import { useLearningLocale } from "@/components/pages/learning/use-learning-locale";
export type LearningPageActor = { id: string; displayName: string };
export type LearningPageResearchBoundary = LearningResearchBoundary;
export function LearningPage({ actor, locale: initialLocale = "zh-CN", research }: { actor: LearningPageActor; locale?: Locale; research: LearningResearchBoundary }) {
  return (
    <LearningResearchWorkspaceBoundary locale={initialLocale} research={research}>
      <LearningWorkbench
        actor={actor}
        initialLocale={initialLocale}
        researchRequired={research.required}
      />
    </LearningResearchWorkspaceBoundary>
  );
}
function LearningWorkbench({ actor, initialLocale, researchRequired }: {
  actor: LearningPageActor;
  initialLocale: Locale;
  researchRequired: boolean;
}) {
  const { hydrationReady, initialDraftJournal } = useHydratedArtifactDraft(actor.id, researchRequired);
  return <LearningWorkbenchState
    key={hydrationReady ? "hydrated" : "server"} actor={actor}
    hydrationReady={hydrationReady} initialDraftJournal={initialDraftJournal}
    initialLocale={initialLocale} researchRequired={researchRequired}
  />;
}
function LearningWorkbenchState({
  actor, hydrationReady,
  initialDraftJournal,
  initialLocale,
  researchRequired,
}: {
  actor: LearningPageActor; hydrationReady: boolean;
  initialDraftJournal: ArtifactDraftJournal | null;
  initialLocale: Locale;
  researchRequired: boolean;
}) {
  const locale = useLearningLocale(initialLocale);
  const copy = getLearningCopy(locale);
  const studentId = actor.id;
  const [documentTaskId, setDocumentTaskId] = useState<string | null>(
    () => initialDraftJournal?.taskId ?? null,
  );
  const [activeTab, setActiveTab] = useState<ContentTab>("display");
  const [documentArchiveBusy, setDocumentArchiveBusy] = useState(false);
  const [documentCloseError, setDocumentCloseError] = useState("");
  const [documentDownloadBusy, setDocumentDownloadBusy] = useState(false);
  const [documentDownloadStatus, setDocumentDownloadStatus] = useState("");
  const [documentDownloadError, setDocumentDownloadError] = useState("");
  const {
    activeHistoryDocumentId,
    activeTaskId,
    artifactText,
    backendError,
    documentTitle,
    getArtifactRevision,
    getAiUseModeMutationStatus,
    getTaskScaffoldRequests,
    historyDocuments,
    lastSavedArtifactLengthRef,
    learnerDataGeneration,
    patchSession,
    persistedGuideMessages,
    requestScaffold, retrySessionLoad, resetWorkspaceSession, sessionLoadState,
    setArtifactText,
    setActiveHistoryDocumentId,
    setBackendError,
    setDocumentTitle,
    setHistoryDocuments,
    waitForLearnerDataGeneration, tasks, confirmTaskScaffoldRequests,
  } = useLearningWorkspaceSession(
    locale,
    {
      activeDocumentId: initialDraftJournal?.activeDocumentId ?? null,
      artifactText: initialDraftJournal?.value ?? "",
      documentTitle: initialDraftJournal?.title ?? "",
    }, hydrationReady);
  const sessionReady = sessionLoadState === "ready";
  const workspaceReady = hydrationReady && sessionReady;
  const editingTaskId = documentTaskId ?? activeTaskId;
  const aiUseModeMutationStatus = getAiUseModeMutationStatus(editingTaskId);
  const activeTaskPhase = tasks.find((task) => task.taskId === editingTaskId)?.phase
    ?? (editingTaskId.startsWith("practice_") ? "practice" : "training");
  const {
    archiveIntentRef,
    artifactSaveBusy,
    artifactSaveError,
    artifactSaveStatus,
    cancelPendingArtifactSave,
    completeArtifactArchive,
    documentTitleRef,
    flushPendingArtifactSave,
    hasPendingArtifactSave,
    hasUncommittedArtifactSave,
    isOperationCurrent,
    resetArtifactSaveState,
    restorePendingArtifactSave,
    scheduleArtifactSave,
    setArtifactSaveBusy,
    setArtifactSaveError,
    setArtifactSaveStatus,
  } = useLearningArtifactSave({
    activeHistoryDocumentId,
    copy,
    documentTitle,
    getArtifactRevision,
    initialDraftJournal,
    lastSavedArtifactLengthRef,
    learnerDataGeneration,
    patchSession,
    researchRequired,
    setBackendError,
    studentId,
  });
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
    guideMessages, hasGuideSubmission, pendingGuideAgentId,
    removeGuideAttachment,
    resetGuideState,
    sendGuideMessage,
    setGuideDraft,
    setGuideError,
  } = useLearningGuide({
    activeTaskId: editingTaskId,
    activeTaskPhase,
    artifactText,
    displayName: actor.displayName,
    isGuideSubmissionBlocked: () => getAiUseModeMutationStatus(editingTaskId) !== null,
    getHelpRequestsUsed: getTaskScaffoldRequests,
    waitForLearnerDataGeneration,
    locale,
    onHelpRequestsUsedConfirmed: confirmTaskScaffoldRequests,
    persistedGuideMessages,
    studentId,
  });
  const pilotActions = createPilotLearningActions({ patchSession, requestScaffold });
  const {
    activeContentId,
    completeLearningTask,
    openContentItem,
    resetContentNavigation,
    returnToContentMenu,
    selectLearningTask,
    setActiveContentId,
    taskActionBusy,
    taskActionError,
  } = useLearningContentNavigation({
    activeTaskId,
    flushPendingArtifactSave,
    hasUncommittedArtifactSave,
    onOpenTaskEditor: () => {
      setDocumentTaskId(null);
      selectContentTab("editor");
    },
    patchSession,
    taskActionErrorMessage: copy.content.taskCards.actionFailed,
  });
  const operationBusy = guideBusy
    || aiUseModeMutationStatus !== null
    || guideAttachmentBusy
    || hasUncommittedArtifactSave()
    || documentArchiveBusy
    || documentDownloadBusy
    || taskActionBusy;
  const {
    accountError,
    accountMenuOpen,
    accountStatus,
    handleDeleteLearnerData,
    handleExportLearnerData,
    handleLogout, handleSessionFailureLogout,
    learnerDeleteBusy,
    loggingOut,
    privacyBusy,
    toggleAccountMenu,
  } = useLearningAccount({
    learnerDataGeneration,
    operationBusy,
    onLearnerDataDeleteSucceeded: resetLearnerWorkspace,
    locale,
    studentId,
  });
  function resetLearnerWorkspace(nextDataGeneration: number) {
    resetArtifactSaveState();
    setDocumentTaskId(null);
    setDocumentCloseError("");
    setDocumentDownloadStatus("");
    setDocumentDownloadError("");
    resetContentNavigation();
    resetGuideState();
    resetWorkspaceSession(nextDataGeneration);
    setActiveTab("display");
    setDocumentTitle("");
    setHistoryDocuments([]);
    setActiveHistoryDocumentId(null);
  }
  function recordArtifact(value: string) {
    setDocumentDownloadStatus("");
    setDocumentDownloadError("");
    setDocumentCloseError("");
    setArtifactText(value);
    scheduleArtifactSave(editingTaskId, value);
  }
  function recordDocumentTitle(value: string) {
    documentTitleRef.current = value;
    setDocumentTitle(value);
    scheduleArtifactSave(editingTaskId, artifactText, { documentTitle: value });
  }
  function selectContentTab(nextTab: ContentTab) {
    if (
      activeTab === "editor"
      && nextTab !== "editor"
      && hasUncommittedArtifactSave()
    ) {
      flushPendingArtifactSave("navigation");
      return;
    }
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
    }
  }
  const saveAndCloseDocument = useLearningDocumentArchive({
    activeHistoryDocumentId,
    activeTaskId: editingTaskId,
    archiveIntentRef,
    artifactSaveBusy,
    artifactText,
    cancelPendingArtifactSave,
    documentTitle,
    hasPendingArtifactSave,
    locale,
    isOperationCurrent,
    onArchiveSucceeded: () => {
      completeArtifactArchive();
      setDocumentTaskId(null);
    },
    patchSession,
    restorePendingArtifactSave,
    setActiveContentId,
    setActiveHistoryDocumentId,
    setActiveTab,
    setArtifactSaveBusy,
    setArtifactSaveError,
    setArtifactSaveStatus,
    setDocumentArchiveBusy,
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
      task_id: editingTaskId,
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
        fileName: createLearningDocumentFileName(editingTaskId),
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
    if (hasUncommittedArtifactSave()) {
      flushPendingArtifactSave("history-navigation");
      return;
    }
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
    documentTitleRef.current = document.title;
    setDocumentTitle(document.title);
    setArtifactText(document.html);
    setActiveHistoryDocumentId(document.id);
    setDocumentTaskId(document.taskId);
    setActiveContentId(null);
    setActiveTab("editor");
  }
  return (
    <div
      className="aais-learning-serif min-h-[100dvh] bg-[#fcfcfc] text-[#0e0e0e]"
      data-locale={locale}
      lang={locale}
    >
      {!workspaceReady ? <LearningSessionStatus
        copy={copy.workspace} logoutError={accountError} loggingOut={loggingOut} onLogout={handleSessionFailureLogout}
        onRetry={retrySessionLoad} signingOutLabel={copy.account.signingOut} signOutLabel={copy.brand.signOut} state={sessionLoadState}
      /> : null}
      <main
        data-testid="learning-shell"
        data-client-ready={hydrationReady ? "true" : "false"}
        data-session-ready={sessionReady ? "true" : "false"} data-session-load-state={sessionLoadState}
        aria-busy={!workspaceReady || undefined} inert={!workspaceReady || undefined}
        className={`flex min-h-[100dvh] w-full max-w-none flex-col bg-[#fcfcfc] text-[#0e0e0e] lg:h-[100dvh] lg:overflow-hidden ${workspaceReady ? "" : "pointer-events-none opacity-0"}`}
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
          onDeleteLearnerData={handleDeleteLearnerData}
          onExportLearnerData={handleExportLearnerData}
          onLogout={handleLogout}
          onToggleAccountMenu={toggleAccountMenu}
        />
        <LearningAccountFeedback error={accountError} status={accountStatus} />
        <div
          ref={splitLayoutRef}
          aria-busy={learnerDeleteBusy}
          data-testid="learning-split-layout"
          data-content-panel-width={Math.round(contentPanelWidth)}
          inert={learnerDeleteBusy || undefined}
          className="aais-learning-split-layout grid min-h-0 flex-1 lg:overflow-hidden"
        >
          <GuidePanel
            addGuideFiles={(files) => { void addGuideFiles(files); }}
            backendError={backendError}
            guideAttachmentBusy={guideAttachmentBusy}
            guideAttachmentError={guideAttachmentError}
            guideAttachments={guideAttachments}
            guideBusy={guideBusy || aiUseModeMutationStatus !== null}
            guideDraft={guideDraft}
            guideError={guideError}
            guideFileInputRef={guideFileInputRef}
            guideMessages={guideMessages}
            hasGuideSubmission={hasGuideSubmission}
            locale={locale}
            onRemoveAttachment={removeGuideAttachment}
            pendingGuideAgentId={pendingGuideAgentId}
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
            activeTaskId={activeTaskId}
            activeTab={activeTab}
            artifactSaveBusy={artifactSaveBusy}
            artifactSaveError={documentCloseError || artifactSaveError}
            artifactSaveStatus={artifactSaveStatus}
            artifactText={artifactText}
            documentDownloadBusy={documentDownloadBusy}
            documentDownloadError={documentDownloadError}
            documentDownloadStatus={documentDownloadStatus}
            documentTitle={documentTitle}
            documentArchiveBusy={documentArchiveBusy}
            documentNavigationLocked={hasUncommittedArtifactSave()}
            flushPendingArtifactSave={() => flushPendingArtifactSave("blur")}
            guideMessages={guideMessages}
            historyDocuments={historyDocuments}
            locale={locale}
            onDocumentTitleChange={recordDocumentTitle}
            onDownloadDocument={() => { void downloadDocumentToLocal(); }}
            onCompleteTask={(taskId) => { void completeLearningTask(taskId); }}
            onOpenDocument={openHistoryDocument}
            onRecordArtifact={recordArtifact}
            onSaveAndCloseDocument={saveAndCloseDocument}
            onSaveAndClosePointerDown={() => {
              archiveIntentRef.current = true;
            }}
            onSelectTask={(taskId) => { void selectLearningTask(taskId); }}
            pilotActions={pilotActions}
            selectContentTab={selectContentTab}
            onBackContent={returnToContentMenu}
            onOpenContent={openContentItem}
            taskActionBusy={taskActionBusy}
            taskActionError={taskActionError}
            tasks={tasks}
          />
        </div>
      </main>
    </div>
  );
}
