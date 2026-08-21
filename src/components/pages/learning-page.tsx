"use client";
import { useState } from "react";
import { ContentResizeSeparator, ContentSidePanel } from "@/components/pages/learning/content-side-panel";
import { GuidePanel } from "@/components/pages/learning/guide-panel";
import { LearningAccountFeedback, LearningTopBar } from "@/components/pages/learning/learning-top-bar";
import { getLearningCopy } from "@/components/pages/learning/learning-copy";
import { useLearningAccount } from "@/components/pages/learning/use-learning-account";
import { useContentPanelResize } from "@/components/pages/learning/use-content-panel-resize";
import { useLearningArtifactSave } from "@/components/pages/learning/use-learning-artifact-save";
import { useLearningGuide } from "@/components/pages/learning/use-learning-guide";
import { useLearningDocumentArchive } from "@/components/pages/learning/use-learning-document-archive";
import { useLearningDocumentDownload } from "@/components/pages/learning/use-learning-document-download";
import { useLearningContentNavigation } from "@/components/pages/learning/use-learning-content-navigation";
import { useHydratedArtifactDraft } from "@/components/pages/learning/use-hydrated-artifact-draft";
import { useLearningWorkspaceSession } from "@/components/pages/learning/use-learning-workspace-session";
import type { ArtifactDraftJournal } from "@/components/pages/learning/client-helpers";
import { LearningResearchWorkspaceBoundary, type LearningResearchBoundary } from "@/components/pages/learning/research-telemetry-boundary";
import { admitAaisResearchAction, createAaisResearchOperationId } from "@/lib/client/aais-research-telemetry";
import type { ContentTab, SavedLearningDocument } from "@/components/pages/learning/learning-page-types";
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
    hydrationReady={hydrationReady}
    initialDraftJournal={initialDraftJournal}
    initialLocale={initialLocale}
    researchRequired={researchRequired}
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
  const {
    activeHistoryDocumentId,
    activeTaskId,
    artifactText,
    backendError,
    documentTitle,
    getArtifactRevision,
    historyDocuments,
    lastSavedArtifactLengthRef,
    learnerDataGeneration,
    patchSession,
    persistedGuideMessages,
    resetWorkspaceSession,
    setArtifactText,
    setActiveHistoryDocumentId,
    setBackendError,
    setDocumentTitle,
    setHistoryDocuments,
    waitForLearnerDataGeneration,
    tasks,
  } = useLearningWorkspaceSession(
    locale,
    {
      activeDocumentId: initialDraftJournal?.activeDocumentId ?? null,
      artifactText: initialDraftJournal?.value ?? "",
      documentTitle: initialDraftJournal?.title ?? "",
    },
  );
  const editingTaskId = documentTaskId ?? activeTaskId;
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
    guideMessages,
    hasGuideSubmission,
    removeGuideAttachment,
    resetGuideState,
    retryGuideMessage,
    rewriteGuideMessage,
    sendGuideMessage,
    setGuideDraft,
    setGuideError,
  } = useLearningGuide({
    activeTaskId: editingTaskId,
    artifactText,
    displayName: actor.displayName,
    waitForLearnerDataGeneration,
    locale,
    persistedGuideMessages,
    studentId,
  });
  const {
    documentDownloadBusy,
    documentDownloadError,
    documentDownloadStatus,
    downloadDocumentToLocal,
    resetDocumentDownloadState,
  } = useLearningDocumentDownload({
    artifactText,
    editingTaskId,
    flushPendingArtifactSave,
    locale,
    setBackendError,
  });
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
    handleLogout,
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
    resetDocumentDownloadState();
    resetContentNavigation();
    resetGuideState();
    resetWorkspaceSession(nextDataGeneration);
    setActiveTab("display");
    setDocumentTitle("");
    setHistoryDocuments([]);
    setActiveHistoryDocumentId(null);
  }

  function recordArtifact(value: string) {
    resetDocumentDownloadState();
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
      <main
        data-testid="learning-shell"
        data-client-ready={hydrationReady ? "true" : "false"}
        aria-busy={!hydrationReady || undefined}
        aria-hidden={!hydrationReady || undefined}
        inert={!hydrationReady || undefined}
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
            guideBusy={guideBusy}
            guideDraft={guideDraft}
            guideError={guideError}
            guideFileInputRef={guideFileInputRef}
            guideMessages={guideMessages}
            hasGuideSubmission={hasGuideSubmission}
            locale={locale}
            onRemoveAttachment={removeGuideAttachment}
            onRetryGuideMessage={(messageId) => { void retryGuideMessage(messageId); }}
            onRewriteGuideMessage={rewriteGuideMessage}
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
