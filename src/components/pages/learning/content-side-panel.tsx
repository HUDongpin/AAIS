import type { KeyboardEvent, PointerEvent as ReactPointerEvent } from "react";
import {
  contentPanelResizeStep,
  maxContentPanelWidth,
  minContentPanelWidth,
} from "@/components/pages/learning/learning-page-constants";
import {
  ContentDisplay,
  contentDisplayItems,
} from "@/components/pages/learning/content-display";
import { DocumentEditor } from "@/components/pages/learning/document-editor";
import type {
  ContentItemId,
  ContentTab,
  SavedLearningDocument,
} from "@/components/pages/learning/learning-page-types";

export function ContentResizeSeparator({
  contentPanelWidth,
  getMaxContentPanelWidth,
  onResizeBy,
  onResizeStart,
  setContentPanelWidth,
}: {
  contentPanelWidth: number;
  getMaxContentPanelWidth: () => number;
  onResizeBy: (delta: number) => void;
  onResizeStart: (event: ReactPointerEvent<HTMLDivElement>) => void;
  setContentPanelWidth: (width: number) => void;
}) {
  function handleKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    if (event.key === "ArrowLeft") {
      event.preventDefault();
      onResizeBy(contentPanelResizeStep);
    } else if (event.key === "ArrowRight") {
      event.preventDefault();
      onResizeBy(-contentPanelResizeStep);
    } else if (event.key === "Home") {
      event.preventDefault();
      setContentPanelWidth(minContentPanelWidth);
    } else if (event.key === "End") {
      event.preventDefault();
      setContentPanelWidth(getMaxContentPanelWidth());
    }
  }

  return (
    <div
      role="separator"
      aria-label="调整内容展示区域宽度"
      aria-orientation="vertical"
      aria-valuemin={minContentPanelWidth}
      aria-valuemax={maxContentPanelWidth}
      aria-valuenow={Math.round(contentPanelWidth)}
      tabIndex={0}
      onPointerDown={onResizeStart}
      onKeyDown={handleKeyDown}
      className="group relative hidden w-6 min-h-0 cursor-col-resize touch-none select-none bg-[#fcfcfc] outline-none lg:block"
    >
      <span
        data-content-resize-line="true"
        className="absolute inset-y-0 left-1/2 w-px -translate-x-1/2 bg-[#d1d5dd]"
      />
      <span
        data-content-resize-handle="true"
        className="absolute left-1/2 top-1/2 grid h-20 w-4 -translate-x-1/2 -translate-y-1/2 place-items-center rounded-full border border-[#cfd4de] bg-[#fcfcfc] shadow-[0_8px_20px_rgba(17,24,39,0.08)] transition group-hover:border-[#b7bfcd] group-focus-visible:border-[#536de8]"
      >
        <span className="grid gap-1">
          <span className="size-1 rounded-full bg-[#a6adba]" />
          <span className="size-1 rounded-full bg-[#a6adba]" />
          <span className="size-1 rounded-full bg-[#a6adba]" />
        </span>
      </span>
      <span className="absolute inset-y-0 left-0 w-full transition group-hover:bg-[#0e0e0e]/5 group-focus-visible:bg-[#0e0e0e]/5" />
    </div>
  );
}

export function ContentSidePanel({
  activeContentId,
  activeTab,
  artifactSaveBusy,
  artifactSaveError,
  artifactSaveStatus,
  artifactText,
  documentDownloadBusy,
  documentDownloadError,
  documentDownloadStatus,
  documentTitle,
  flushPendingArtifactSave,
  historyDocuments,
  onDocumentTitleChange,
  onDownloadDocument,
  onOpenDocument,
  onRecordArtifact,
  onSaveAndCloseDocument,
  selectContentTab,
  setActiveContentId,
}: {
  activeContentId: ContentItemId | null;
  activeTab: ContentTab;
  artifactSaveBusy: boolean;
  artifactSaveError: string;
  artifactSaveStatus: string;
  artifactText: string;
  documentDownloadBusy: boolean;
  documentDownloadError: string;
  documentDownloadStatus: string;
  documentTitle: string;
  flushPendingArtifactSave: () => void;
  historyDocuments: SavedLearningDocument[];
  onDocumentTitleChange: (value: string) => void;
  onDownloadDocument: () => void;
  onOpenDocument: (document: SavedLearningDocument) => void;
  onRecordArtifact: (value: string) => void;
  onSaveAndCloseDocument: () => void;
  selectContentTab: (nextTab: ContentTab) => void;
  setActiveContentId: (id: ContentItemId | null) => void;
}) {
  const activeContent =
    contentDisplayItems.find((item) => item.id === activeContentId) ?? null;
  const documentStatus = documentDownloadStatus || artifactSaveStatus;
  const documentError = documentDownloadError || artifactSaveError;
  const documentBusy = activeTab === "editor" && (artifactSaveBusy || documentDownloadBusy);

  return (
    <aside
      className="flex min-h-[620px] flex-col bg-[#fcfcfc] lg:min-h-0 lg:overflow-hidden"
      aria-label="学习内容与文档"
      aria-busy={documentBusy}
    >
      <div className="flex h-14 shrink-0 items-stretch border-b border-[#d7d7d7] bg-[#fcfcfc]">
        <TabButton active={activeTab === "display"} onClick={() => selectContentTab("display")}>
          内容展示
        </TabButton>
        <TabButton active={activeTab === "editor"} onClick={() => selectContentTab("editor")}>
          文档编辑
        </TabButton>
        {activeTab === "editor" ? (
          <>
            <button
              type="button"
              onClick={onSaveAndCloseDocument}
              className="inline-flex h-14 min-w-[104px] shrink-0 items-center justify-center whitespace-nowrap px-3 text-[14px] font-semibold text-[#536de8] outline-none transition hover:bg-white focus-visible:ring-2 focus-visible:ring-[#536de8]"
            >
              保存并关闭
            </button>
            <button
              type="button"
              onClick={onDownloadDocument}
              disabled={documentDownloadBusy}
              className="ml-auto inline-flex h-14 min-w-[104px] shrink-0 items-center justify-center whitespace-nowrap px-3 text-[14px] font-semibold text-[#536de8] outline-none transition hover:bg-white focus-visible:ring-2 focus-visible:ring-[#536de8] disabled:cursor-not-allowed disabled:opacity-70"
            >
              {documentDownloadBusy ? "下载中..." : "下载到本地"}
            </button>
          </>
        ) : null}
      </div>

      {activeTab === "editor" && documentStatus ? (
        <p
          className="border-b border-[#cce9d6] bg-[#effff4] px-3 py-2 text-sm font-semibold text-[#166534]"
          role="status"
          aria-live="polite"
          aria-atomic="true"
        >
          {documentStatus}
        </p>
      ) : null}
      {activeTab === "editor" && documentError ? (
        <p
          className="border-b border-[#f0b7c9] bg-[#fff1f5] px-3 py-2 text-sm font-semibold text-[#a12f56]"
          role="alert"
          aria-live="assertive"
          aria-atomic="true"
        >
          {documentError}
        </p>
      ) : null}

      <div className="min-h-[580px] lg:min-h-0 lg:flex-1 lg:overflow-y-auto">
        {activeTab === "display" ? (
          <ContentDisplay
            activeContent={activeContent}
            historyDocuments={historyDocuments}
            onBack={() => setActiveContentId(null)}
            onOpen={setActiveContentId}
            onOpenDocument={onOpenDocument}
          />
        ) : (
          <DocumentEditor
            artifactText={artifactText}
            documentTitle={documentTitle}
            onArtifactChange={onRecordArtifact}
            onArtifactBlur={flushPendingArtifactSave}
            onDocumentTitleChange={onDocumentTitleChange}
          />
        )}
      </div>
    </aside>
  );
}

function TabButton({
  active,
  children,
  onClick,
}: {
  active: boolean;
  children: string;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      className={[
        "relative h-14 min-w-[148px] shrink-0 whitespace-nowrap border-r border-[#d7d7d7] px-6 text-center text-[20px] font-black leading-[56px] tracking-normal outline-none transition focus-visible:ring-2 focus-visible:ring-[#536de8]",
        active
          ? "bg-[#f0f0ef] text-[#10131a] shadow-[inset_0_-3px_0_#536de8]"
          : "bg-white text-[#16181d] hover:bg-[#f8f8f7]",
      ].join(" ")}
    >
      {children}
    </button>
  );
}
