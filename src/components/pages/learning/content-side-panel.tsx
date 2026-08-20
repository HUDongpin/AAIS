import type { FocusEvent, KeyboardEvent, PointerEvent as ReactPointerEvent } from "react";
import {
  contentPanelResizeStep,
  maxContentPanelWidth,
  minContentPanelWidth,
} from "@/components/pages/learning/learning-page-constants";
import {
  admitAaisResearchAction,
  createAaisResearchOperationId,
} from "@/lib/client/aais-research-telemetry";
import {
  ContentDisplay,
  getContentDisplayItems,
} from "@/components/pages/learning/content-display";
import { DocumentEditor } from "@/components/pages/learning/document-editor";
import { getLearningCopy } from "@/components/pages/learning/learning-copy";
import type {
  ContentItemId,
  ContentTab,
  SavedLearningDocument,
} from "@/components/pages/learning/learning-page-types";
import type { Locale } from "@/data/aais";

export function ContentResizeSeparator({
  contentPanelWidth,
  getMaxContentPanelWidth,
  locale = "zh-CN",
  onResizeBy,
  onResizeStart,
  setContentPanelWidth,
}: {
  contentPanelWidth: number;
  getMaxContentPanelWidth: () => number;
  locale?: Locale;
  onResizeBy: (delta: number) => void;
  onResizeStart: (event: ReactPointerEvent<HTMLDivElement>) => void;
  setContentPanelWidth: (width: number) => void;
}) {
  const copy = getLearningCopy(locale);
  function handleKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    let nextWidth: number | null = null;
    let applyResize: (() => void) | null = null;
    if (event.key === "ArrowLeft") {
      event.preventDefault();
      nextWidth = Math.min(getMaxContentPanelWidth(), contentPanelWidth + contentPanelResizeStep);
      applyResize = () => onResizeBy(contentPanelResizeStep);
    } else if (event.key === "ArrowRight") {
      event.preventDefault();
      nextWidth = Math.max(minContentPanelWidth, contentPanelWidth - contentPanelResizeStep);
      applyResize = () => onResizeBy(-contentPanelResizeStep);
    } else if (event.key === "Home") {
      event.preventDefault();
      nextWidth = minContentPanelWidth;
      applyResize = () => setContentPanelWidth(minContentPanelWidth);
    } else if (event.key === "End") {
      event.preventDefault();
      const maxWidth = getMaxContentPanelWidth();
      nextWidth = maxWidth;
      applyResize = () => setContentPanelWidth(maxWidth);
    }
    if (
      nextWidth !== null
      && applyResize
      && Math.round(nextWidth) !== Math.round(contentPanelWidth)
    ) {
      if (!admitAaisResearchAction({
        eventName: "panel_resize_completed",
        outcome: "success",
        detail: {
          operation_id: createAaisResearchOperationId("panel-resize"),
          input_method: "keyboard",
          trigger: event.key.toLowerCase(),
          width_px: nextWidth,
          delta_px: nextWidth - contentPanelWidth,
        },
      })) {
        return;
      }
      applyResize();
    }
  }

  return (
    <div
      role="separator"
      aria-label={copy.content.resize}
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
  documentArchiveBusy = false,
  documentNavigationLocked = false,
  flushPendingArtifactSave,
  historyDocuments,
  locale = "zh-CN",
  onDocumentTitleChange,
  onDownloadDocument,
  onBackContent,
  onOpenContent,
  onOpenDocument,
  onRecordArtifact,
  onSaveAndCloseDocument,
  onSaveAndClosePointerDown = () => undefined,
  selectContentTab,
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
  documentArchiveBusy?: boolean;
  documentNavigationLocked?: boolean;
  flushPendingArtifactSave: () => void;
  historyDocuments: SavedLearningDocument[];
  locale?: Locale;
  onDocumentTitleChange: (value: string) => void;
  onDownloadDocument: () => void;
  onBackContent: () => void;
  onOpenContent: (id: ContentItemId) => void;
  onOpenDocument: (document: SavedLearningDocument) => void;
  onRecordArtifact: (value: string) => void;
  onSaveAndCloseDocument: () => void;
  onSaveAndClosePointerDown?: () => void;
  selectContentTab: (nextTab: ContentTab) => void;
}) {
  const copy = getLearningCopy(locale);
  const activeContent =
    getContentDisplayItems(locale).find((item) => item.id === activeContentId) ?? null;
  const documentStatus = documentDownloadStatus || artifactSaveStatus;
  const documentError = documentDownloadError || artifactSaveError;
  const documentBusy = activeTab === "editor" && (artifactSaveBusy || documentDownloadBusy);

  return (
    <aside
      className="flex min-h-[620px] flex-col bg-[#fcfcfc] lg:min-h-0 lg:overflow-hidden"
      aria-label={copy.content.panel}
      aria-busy={documentBusy}
    >
      <div className="grid h-auto shrink-0 grid-cols-2 items-stretch border-b border-[#d7d7d7] bg-[#fcfcfc] lg:flex lg:h-14">
        <TabButton
          active={activeTab === "display"}
          ariaDisabled={activeTab === "editor" && documentNavigationLocked}
          disabled={documentArchiveBusy || (activeTab === "editor" && artifactSaveBusy)}
          onClick={() => selectContentTab("display")}
        >
          {copy.content.displayTab}
        </TabButton>
        <TabButton active={activeTab === "editor"} disabled={documentArchiveBusy} onClick={() => selectContentTab("editor")}>
          {copy.content.editorTab}
        </TabButton>
        {activeTab === "editor" ? (
          <>
            <button
              type="button"
              data-document-archive-action="true"
              onPointerDown={onSaveAndClosePointerDown}
              onClick={onSaveAndCloseDocument}
              disabled={artifactSaveBusy || documentArchiveBusy}
              className="inline-flex h-14 min-w-0 items-center justify-center whitespace-nowrap border-t border-[#d7d7d7] px-2 text-[14px] font-semibold text-[#536de8] outline-none transition hover:bg-white focus-visible:ring-2 focus-visible:ring-[#536de8] disabled:cursor-not-allowed disabled:opacity-70 lg:min-w-[104px] lg:shrink-0 lg:border-t-0 lg:px-3"
            >
              {copy.content.saveAndClose}
            </button>
            <button
              type="button"
              onClick={onDownloadDocument}
              disabled={documentDownloadBusy || documentArchiveBusy}
              className="inline-flex h-14 min-w-0 items-center justify-center whitespace-nowrap border-t border-l border-[#d7d7d7] px-2 text-[14px] font-semibold text-[#536de8] outline-none transition hover:bg-white focus-visible:ring-2 focus-visible:ring-[#536de8] disabled:cursor-not-allowed disabled:opacity-70 lg:ml-auto lg:min-w-[104px] lg:shrink-0 lg:border-t-0 lg:border-l-0 lg:px-3"
            >
              {documentDownloadBusy ? copy.content.downloading : copy.content.download}
            </button>
          </>
        ) : null}
      </div>

      {activeTab === "editor" && documentStatus ? (
        <p
          className="relative z-10 min-h-9 shrink-0 break-words border-b border-[#cce9d6] bg-[#effff4] px-3 py-2 text-sm font-semibold leading-5 text-[#166534]"
          role="status"
          aria-live="polite"
          aria-atomic="true"
        >
          {documentStatus}
        </p>
      ) : null}
      {activeTab === "editor" && documentError ? (
        <p
          className="relative z-10 min-h-9 shrink-0 break-words border-b border-[#f0b7c9] bg-[#fff1f5] px-3 py-2 text-sm font-semibold leading-5 text-[#a12f56]"
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
            locale={locale}
            navigationLocked={documentNavigationLocked}
            onBack={onBackContent}
            onOpen={onOpenContent}
            onOpenDocument={onOpenDocument}
          />
        ) : (
          <DocumentEditor
            artifactText={artifactText}
            documentTitle={documentTitle}
            disabled={documentArchiveBusy}
            locale={locale}
            onArtifactChange={onRecordArtifact}
            onArtifactBlur={(event: FocusEvent<HTMLDivElement>) => {
              const nextTarget = event.relatedTarget as HTMLElement | null;
              if (!nextTarget?.dataset.documentArchiveAction) {
                flushPendingArtifactSave();
              }
            }}
            onDocumentTitleChange={onDocumentTitleChange}
          />
        )}
      </div>
    </aside>
  );
}

function TabButton({
  active,
  ariaDisabled = false,
  children,
  disabled,
  onClick,
}: {
  active: boolean;
  ariaDisabled?: boolean;
  children: string;
  disabled: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      disabled={disabled}
      aria-disabled={ariaDisabled || undefined}
      onClick={onClick}
      aria-pressed={active}
      className={[
        "relative h-14 min-w-0 whitespace-nowrap border-r border-[#d7d7d7] px-2 text-center text-[17px] font-black leading-[56px] tracking-normal outline-none transition focus-visible:ring-2 focus-visible:ring-[#536de8] lg:min-w-[148px] lg:shrink-0 lg:px-6 lg:text-[20px]",
        active
          ? "bg-[#f0f0ef] text-[#10131a] shadow-[inset_0_-3px_0_#536de8]"
          : ariaDisabled
            ? "cursor-wait bg-white text-[#6b7280]"
            : "bg-white text-[#16181d] hover:bg-[#f8f8f7]",
      ].join(" ")}
    >
      {children}
    </button>
  );
}
