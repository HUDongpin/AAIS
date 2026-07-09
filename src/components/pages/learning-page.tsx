"use client";

import {
  useEffect,
  useRef,
  useState,
  type CSSProperties,
} from "react";
import { useRouter } from "next/navigation";
import {
  anthropicLearningFontFamily,
  artifactSaveDebounceMs,
  defaultTaskId,
} from "@/components/pages/learning/learning-page-constants";
import {
  ContentResizeSeparator,
  ContentSidePanel,
} from "@/components/pages/learning/content-side-panel";
import { GuidePanel } from "@/components/pages/learning/guide-panel";
import { LearningTopBar } from "@/components/pages/learning/learning-top-bar";
import { getInitialStudentId } from "@/components/pages/learning/client-helpers";
import {
  deleteAaisAppSession,
  deleteLearnerPrivacyData,
  fetchLearningSession,
  fetchLearnerPrivacyData,
  patchLearningSession,
} from "@/components/pages/learning/learning-session-client";
import { useContentPanelResize } from "@/components/pages/learning/use-content-panel-resize";
import { useLearningGuide } from "@/components/pages/learning/use-learning-guide";
import {
  createHistoryDocument,
  createLearnerDataFileName,
  createLearningDocumentFileName,
  createLearningDocumentMarkdown,
  saveJsonDocumentToLocal,
  saveMarkdownDocumentToLocal,
} from "@/components/pages/learning/document-markdown";
import type {
  AaisClientSession,
  ContentItemId,
  ContentTab,
  SavedLearningDocument,
} from "@/components/pages/learning/learning-page-types";

export function LearningPage() {
  const router = useRouter();
  const [studentId] = useState(() => getInitialStudentId());
  const [activeTaskId, setActiveTaskId] = useState(defaultTaskId);
  const [activeTab, setActiveTab] = useState<ContentTab>("display");
  const [activeContentId, setActiveContentId] = useState<ContentItemId | null>(null);
  const [accountMenuOpen, setAccountMenuOpen] = useState(false);
  const [loggingOut, setLoggingOut] = useState(false);
  const [privacyBusy, setPrivacyBusy] = useState(false);
  const [accountStatus, setAccountStatus] = useState("");
  const [accountError, setAccountError] = useState("");
  const [artifactText, setArtifactText] = useState("");
  const [documentTitle, setDocumentTitle] = useState("");
  const [historyDocuments, setHistoryDocuments] = useState<SavedLearningDocument[]>([]);
  const [backendError, setBackendError] = useState("");
  const [artifactSaveBusy, setArtifactSaveBusy] = useState(false);
  const [artifactSaveStatus, setArtifactSaveStatus] = useState("");
  const [artifactSaveError, setArtifactSaveError] = useState("");
  const [documentDownloadBusy, setDocumentDownloadBusy] = useState(false);
  const [documentDownloadStatus, setDocumentDownloadStatus] = useState("");
  const [documentDownloadError, setDocumentDownloadError] = useState("");
  const artifactSaveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pendingArtifactSaveRef = useRef<{
    taskId: string;
    value: string;
  } | null>(null);
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
    studentId,
  });

  function applySession(session: AaisClientSession) {
    const nextTaskId = session.activeTaskId || defaultTaskId;
    setActiveTaskId(nextTaskId);
    const selectedTask =
      session.tasks?.find((task) => task.taskId === nextTaskId) ?? session.tasks?.[0];
    setArtifactText(selectedTask?.artifactText ?? "");
  }

  async function patchSession(body: Record<string, unknown>) {
    const session = await patchLearningSession(body);
    applySession(session);
    setBackendError("");
    return session;
  }

  async function handleLogout() {
    if (loggingOut) {
      return;
    }
    setLoggingOut(true);
    setAccountStatus("正在退出...");
    setAccountError("");
    try {
      await deleteAaisAppSession();
    } catch {
      // A local redirect still returns the learner to the login surface if the network call fails.
    }
    window.localStorage.removeItem("aais_student_id");
    window.localStorage.removeItem("aais_display_name");
    setAccountMenuOpen(false);
    router.replace("/login");
    setLoggingOut(false);
  }

  async function handleExportLearnerData() {
    if (privacyBusy) {
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
    } catch {
      setAccountStatus("");
      setAccountError("学习数据导出未能完成，请稍后重试。");
    } finally {
      setPrivacyBusy(false);
    }
  }

  async function handleDeleteLearnerData() {
    if (privacyBusy) {
      return;
    }
    const confirmed = window.confirm("确定要删除当前学习数据吗？此操作会清除你的学习记录，但不会删除账号。");
    if (!confirmed) {
      return;
    }
    setPrivacyBusy(true);
    setAccountStatus("正在删除学习数据...");
    setAccountError("");
    setArtifactSaveStatus("");
    setArtifactSaveError("");
    setDocumentDownloadStatus("");
    setDocumentDownloadError("");
    if (artifactSaveTimerRef.current) {
      clearTimeout(artifactSaveTimerRef.current);
      artifactSaveTimerRef.current = null;
    }
    pendingArtifactSaveRef.current = null;
    try {
      await deleteLearnerPrivacyData();
      setActiveTaskId(defaultTaskId);
      setActiveTab("display");
      setActiveContentId(null);
      setArtifactText("");
      setDocumentTitle("");
      setHistoryDocuments([]);
      setBackendError("");
      setAccountStatus("学习数据已删除。");
      setAccountMenuOpen(false);
    } catch {
      setAccountStatus("");
      setAccountError("学习数据删除未能完成，请稍后重试。");
    } finally {
      setPrivacyBusy(false);
    }
  }

  function flushPendingArtifactSave() {
    const pending = pendingArtifactSaveRef.current;
    pendingArtifactSaveRef.current = null;
    if (artifactSaveTimerRef.current) {
      clearTimeout(artifactSaveTimerRef.current);
      artifactSaveTimerRef.current = null;
    }
    if (!pending) {
      return;
    }
    setArtifactSaveBusy(true);
    setArtifactSaveStatus("正在保存文档...");
    setArtifactSaveError("");
    void patchSession({
      action: "save-artifact",
      taskId: pending.taskId,
      artifactText: pending.value,
    })
      .then(() => {
        setArtifactSaveStatus("文档已保存。");
      })
      .catch(() => {
        const message = "任务过程记录未能保存到后端。";
        setBackendError(message);
        setArtifactSaveStatus("");
        setArtifactSaveError(message);
      })
      .finally(() => {
        setArtifactSaveBusy(false);
      });
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
    artifactSaveTimerRef.current = setTimeout(flushPendingArtifactSave, artifactSaveDebounceMs);
  }

  function recordArtifact(value: string) {
    setArtifactText(value);
    scheduleArtifactSave(activeTaskId, value);
  }

  function selectContentTab(nextTab: ContentTab) {
    setActiveTab(nextTab);
    if (nextTab === "display") {
      setActiveContentId(null);
    }
  }

  function saveAndCloseDocument() {
    flushPendingArtifactSave();
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
    flushPendingArtifactSave();
    setDocumentDownloadBusy(true);
    setDocumentDownloadStatus("正在准备下载...");
    setDocumentDownloadError("");
    try {
      await saveMarkdownDocumentToLocal({
        fileName: createLearningDocumentFileName(activeTaskId),
        markdown: createLearningDocumentMarkdown(artifactText),
      });
      setDocumentDownloadStatus("文档下载已准备。");
    } catch {
      const message = "文档下载未能完成，请稍后重试。";
      setBackendError(message);
      setDocumentDownloadStatus("");
      setDocumentDownloadError(message);
    } finally {
      setDocumentDownloadBusy(false);
    }
  }

  function openHistoryDocument(document: SavedLearningDocument) {
    setDocumentTitle(document.title);
    setArtifactText(document.html);
    setActiveContentId(null);
    setActiveTab("editor");
  }
  useEffect(() => {
    let cancelled = false;

    async function loadSession() {
      try {
        const session = await fetchLearningSession();
        if (!cancelled) {
          applySession(session);
          setBackendError("");
        }
      } catch {
        if (!cancelled) {
          setBackendError("学习记录服务暂时不可用，本页会保留当前输入但不会完成持久化。");
        }
      }
    }

    void loadSession();

    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => () => {
    if (artifactSaveTimerRef.current) {
      clearTimeout(artifactSaveTimerRef.current);
    }
  }, []);

  return (
    <div
      className="min-h-[100dvh] bg-[#fcfcfc] text-[#0e0e0e]"
      style={{ fontFamily: anthropicLearningFontFamily }}
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
          loggingOut={loggingOut}
          privacyBusy={privacyBusy}
          onDeleteLearnerData={() => { void handleDeleteLearnerData(); }}
          onExportLearnerData={() => { void handleExportLearnerData(); }}
          onLogout={handleLogout}
          onToggleAccountMenu={() => setAccountMenuOpen((open) => !open)}
        />

        {accountStatus ? (
          <p
            className="border-b border-[#cce9d6] bg-[#effff4] px-4 py-2 text-sm font-semibold text-[#166534]"
            role="status"
            aria-live="polite"
            aria-atomic="true"
          >
            {accountStatus}
          </p>
        ) : null}
        {accountError ? (
          <p
            className="border-b border-[#f0b7c9] bg-[#fff1f5] px-4 py-2 text-sm font-semibold text-[#a12f56]"
            role="alert"
            aria-live="assertive"
            aria-atomic="true"
          >
            {accountError}
          </p>
        ) : null}

        <div
          ref={splitLayoutRef}
          data-testid="learning-split-layout"
          style={
            {
              "--content-panel-width": `${contentPanelWidth}px`,
            } as CSSProperties
          }
          className="grid min-h-0 flex-1 lg:grid-cols-[minmax(0,1fr)_8px_var(--content-panel-width)] lg:overflow-hidden"
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
            onSubmitGuideQuestion={(question) => { void submitGuideQuestion(question); }}
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
            flushPendingArtifactSave={flushPendingArtifactSave}
            historyDocuments={historyDocuments}
            onDocumentTitleChange={setDocumentTitle}
            onDownloadDocument={() => { void downloadDocumentToLocal(); }}
            onOpenDocument={openHistoryDocument}
            onRecordArtifact={recordArtifact}
            onSaveAndCloseDocument={saveAndCloseDocument}
            selectContentTab={selectContentTab}
            setActiveContentId={setActiveContentId}
          />
        </div>
      </main>
    </div>
  );
}
