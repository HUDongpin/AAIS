"use client";

import { useEffect, useRef, useState } from "react";
import { artifactSaveDebounceMs } from "@/components/pages/learning/learning-page-constants";
import { ContentResizeSeparator, ContentSidePanel } from "@/components/pages/learning/content-side-panel";
import { GuidePanel } from "@/components/pages/learning/guide-panel";
import { LearningAccountFeedback, LearningTopBar } from "@/components/pages/learning/learning-top-bar";
import { useLearningAccount } from "@/components/pages/learning/use-learning-account";
import { useContentPanelResize } from "@/components/pages/learning/use-content-panel-resize";
import { useLearningGuide } from "@/components/pages/learning/use-learning-guide";
import { useLearningWorkspaceSession } from "@/components/pages/learning/use-learning-workspace-session";
import { clientNowMs, createArtifactSaveEventDetail, isUserCancelledFilePicker, type PendingArtifactSave } from "@/components/pages/learning/client-helpers";
import {
  LearningResearchWorkspaceBoundary,
  type LearningResearchBoundary,
} from "@/components/pages/learning/research-telemetry-boundary";
import {
  admitAaisResearchAction,
  captureAaisResearchActorGeneration,
  classifyAaisResearchClientError,
  createAaisResearchOperationId,
  recordAaisResearchEvent,
} from "@/lib/client/aais-research-telemetry";
import {
  createHistoryDocument,
  createLearningDocumentFileName,
  createLearningDocumentMarkdown,
  saveMarkdownDocumentToLocal,
} from "@/components/pages/learning/document-markdown";
import type { ContentItemId, ContentTab, SavedLearningDocument } from "@/components/pages/learning/learning-page-types";

export type LearningPageActor = { id: string; displayName: string };
export type LearningPageResearchBoundary = LearningResearchBoundary;

export function LearningPage({ actor, research }: {
  actor: LearningPageActor;
  research: LearningResearchBoundary;
}) {
  return (
    <LearningResearchWorkspaceBoundary research={research}>
      <LearningWorkbench actor={actor} />
    </LearningResearchWorkspaceBoundary>
  );
}

function LearningWorkbench({ actor }: { actor: LearningPageActor }) {
  const studentId = actor.id;
  const [activeTab, setActiveTab] = useState<ContentTab>("display");
  const [activeContentId, setActiveContentId] = useState<ContentItemId | null>(null);
  const [documentTitle, setDocumentTitle] = useState("");
  const [historyDocuments, setHistoryDocuments] = useState<SavedLearningDocument[]>([]);
  const [artifactSaveBusy, setArtifactSaveBusy] = useState(false);
  const [artifactSaveStatus, setArtifactSaveStatus] = useState("");
  const [artifactSaveError, setArtifactSaveError] = useState("");
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
    lastSavedArtifactLengthRef,
    patchSession,
    resetWorkspaceSession,
    setArtifactText,
    setBackendError,
  } = useLearningWorkspaceSession();
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
    displayName: actor.displayName,
    studentId,
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
    studentId,
  });

  function resetLearnerWorkspace() {
    setArtifactSaveStatus("");
    setArtifactSaveError("");
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
      setArtifactSaveStatus("正在保存文档，最新更改已排队。");
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
      setArtifactSaveStatus("研究记录连接已暂停，文档更改仍待保存。");
      return false;
    }
    pendingArtifactSaveRef.current = null;
    artifactSaveInFlightRef.current = true;
    setArtifactSaveBusy(true);
    setArtifactSaveStatus("正在保存文档...");
    setArtifactSaveError("");
    void patchSession({
      action: "save-artifact",
      taskId: pending.taskId,
      artifactText: pending.value,
    })
      .then(() => {
        lastSavedArtifactLengthRef.current = pending.value.length;
        if (!pendingArtifactSaveRef.current) {
          setArtifactSaveStatus("文档已保存。");
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
        const message = "任务过程记录未能保存到后端。";
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
    setArtifactSaveStatus("文档更改待保存。");
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

  function recordArtifact(value: string) {
    setDocumentDownloadStatus("");
    setDocumentDownloadError("");
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
    }
  }

  function saveAndCloseDocument() {
    const operationId = createAaisResearchOperationId("document-save-close");
    const hadPendingSave = Boolean(pendingArtifactSaveRef.current);
    if (!flushPendingArtifactSave("save_close")) {
      return;
    }
    if (!admitAaisResearchAction({
      eventName: "document_save_closed",
      outcome: "success",
      detail: {
        operation_id: operationId,
        task_id: activeTaskId,
        pending_save: hadPendingSave,
        title_length: documentTitle.trim().length,
        artifact_length: artifactText.length,
      },
    })) {
      return;
    }
    const sourceHtml = artifactText.trim();
    if (sourceHtml || documentTitle.trim()) {
      const archivedDocument = createHistoryDocument({
        taskId: activeTaskId,
        title: documentTitle,
        html: sourceHtml,
      });
      setHistoryDocuments((currentDocuments) => [archivedDocument, ...currentDocuments]);
    }
    setActiveTab("display");
    setActiveContentId("history");
  }

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
    setDocumentDownloadStatus("正在准备下载...");
    setDocumentDownloadError("");
    try {
      await saveMarkdownDocumentToLocal({
        fileName: createLearningDocumentFileName(activeTaskId),
        markdown: createLearningDocumentMarkdown(artifactText),
      });
      setDocumentDownloadStatus("文档下载已准备。");
      recordAaisResearchEvent({
        actorGeneration: telemetryActorGeneration,
        eventName: "document_download",
        outcome: "success",
        latencyMs: clientNowMs() - startedAt,
        detail: downloadDetail,
      });
    } catch (error) {
      const message = "文档下载未能完成，请稍后重试。";
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
    >
      <main
        data-testid="learning-shell"
        className="flex min-h-[100dvh] w-full max-w-none flex-col bg-[#fcfcfc] text-[#0e0e0e] lg:h-[100dvh] lg:overflow-hidden"
        aria-labelledby="aais-learning-heading"
        aria-describedby="aais-learning-description"
      >
        <h1 id="aais-learning-heading" className="sr-only">
          CAAIS 学习工作台
        </h1>
        <p id="aais-learning-description" className="sr-only">
          使用智能导学、内容展示和文档编辑完成认知学徒学习任务。
        </p>

        <LearningTopBar
          accountMenuOpen={accountMenuOpen}
          displayName={actor.displayName}
          loggingOut={loggingOut}
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
            onRemoveAttachment={removeGuideAttachment}
            onSubmitGuideQuestion={(question, options) => { void submitGuideQuestion(question, options); }}
            sendGuideMessage={sendGuideMessage}
            setGuideDraft={setGuideDraft}
            setGuideError={setGuideError}
          />

          <ContentResizeSeparator
            contentPanelWidth={contentPanelWidth}
            getMaxContentPanelWidth={getMaxContentPanelWidth}
            onResizeBy={resizeContentPanelBy}
            onResizeStart={startContentPanelResize}
            setContentPanelWidth={setContentPanelWidth}
          />

          <ContentSidePanel
            activeContentId={activeContentId}
            activeTab={activeTab}
            artifactSaveBusy={artifactSaveBusy}
            artifactSaveError={artifactSaveError}
            artifactSaveStatus={artifactSaveStatus}
            artifactText={artifactText}
            documentDownloadBusy={documentDownloadBusy}
            documentDownloadError={documentDownloadError}
            documentDownloadStatus={documentDownloadStatus}
            documentTitle={documentTitle}
            flushPendingArtifactSave={() => flushPendingArtifactSave("blur")}
            historyDocuments={historyDocuments}
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
