import {
  ArrowLeft,
  BookOpen,
  CaretRight,
  FolderSimple,
  SquaresFour,
} from "@phosphor-icons/react";
import { formatHistoryDocumentTime } from "@/components/pages/learning/document-markdown";
import { getLearningCopy } from "@/components/pages/learning/learning-copy";
import type {
  ContentItemId,
  SavedLearningDocument,
} from "@/components/pages/learning/learning-page-types";
import type { Locale } from "@/data/aais";

export type ContentDisplayItem = {
  id: ContentItemId;
  label: string;
  body: string;
};

export function getContentDisplayItems(locale: Locale): ContentDisplayItem[] {
  const items = getLearningCopy(locale).content.items;
  return (["platform", "theory", "history"] as const).map((id) => ({
    id,
    ...items[id],
  }));
}

// The default remains available for callers that deliberately render Chinese.
export const contentDisplayItems = getContentDisplayItems("zh-CN");

export function ContentDisplay({
  activeContent,
  historyDocuments,
  locale = "zh-CN",
  navigationLocked = false,
  onBack,
  onOpen,
  onOpenDocument,
}: {
  activeContent: ContentDisplayItem | null;
  historyDocuments: SavedLearningDocument[];
  locale?: Locale;
  navigationLocked?: boolean;
  onBack: () => void;
  onOpen: (id: ContentItemId) => void;
  onOpenDocument: (document: SavedLearningDocument) => void;
}) {
  const copy = getLearningCopy(locale);
  const items = getContentDisplayItems(locale);
  if (activeContent) {
    return (
      <section className="px-6 py-7 sm:px-8">
        <header className="mb-8 flex items-center gap-4">
          <button
            type="button"
            disabled={navigationLocked}
            onClick={onBack}
            aria-label={copy.content.backToDisplay}
            className="group inline-flex h-10 min-w-[88px] items-center justify-center gap-2 rounded-[10px] border border-[#d9dde4] bg-white/75 px-3 text-[15px] font-medium leading-none text-[#5f6672] shadow-[0_6px_18px_rgba(17,24,39,0.04)] outline-none transition hover:-translate-y-px hover:border-[#bfc7d3] hover:bg-white hover:text-[#303744] focus-visible:ring-2 focus-visible:ring-[#536de8] focus-visible:ring-offset-2 focus-visible:ring-offset-[#f7f7f5] disabled:cursor-wait disabled:opacity-70 disabled:hover:translate-y-0"
          >
            <ArrowLeft size={20} weight="bold" className="transition group-hover:-translate-x-0.5" />
            <span>{copy.content.back}</span>
          </button>
          <div className="h-px flex-1 bg-[#e2e5eb]" aria-hidden="true" />
        </header>
        <div className="max-w-[920px]">
          <h2 className="mb-5 text-[22px] font-semibold leading-tight tracking-normal text-[#14171f]">
            {activeContent.label}
          </h2>
          {activeContent.id === "history" ? (
            <HistoryDocuments
              documents={historyDocuments}
              emptyText={activeContent.body}
              locale={locale}
              navigationLocked={navigationLocked}
              onOpenDocument={onOpenDocument}
            />
          ) : (
            <p className="break-words text-[28px] font-normal leading-[1.55] tracking-normal text-[#111318]">
              {activeContent.body}
            </p>
          )}
        </div>
      </section>
    );
  }

  return (
    <nav className="px-5 py-8 sm:px-6" aria-label={copy.content.displayNav}>
      <div className="grid gap-4">
        {items.map((item) => {
          const ContentIcon =
            item.id === "platform"
              ? SquaresFour
              : item.id === "theory"
                ? BookOpen
                : FolderSimple;

          return (
            <button
              key={item.id}
              type="button"
              disabled={navigationLocked}
              onClick={() => onOpen(item.id)}
              className="group flex min-h-[104px] w-full items-center gap-5 rounded-lg border border-[#d7dce5] bg-white/80 px-6 text-left text-[#111827] shadow-[0_8px_24px_rgba(17,24,39,0.04)] outline-none transition hover:-translate-y-px hover:border-[#bcc5d4] hover:bg-white focus-visible:ring-2 focus-visible:ring-[#536de8] focus-visible:ring-offset-2 focus-visible:ring-offset-[#fcfcfc] disabled:cursor-wait disabled:opacity-70 disabled:hover:translate-y-0"
            >
              <span
                data-content-entry-icon={item.id}
                className="grid size-14 shrink-0 place-items-center rounded-md bg-[#eef2ff] text-[#536de8] ring-1 ring-[#d7ddff]"
              >
                <ContentIcon size={30} weight="duotone" />
              </span>
              <span className="min-w-0 flex-1 text-[26px] font-semibold leading-tight tracking-normal text-[#14171f]">
                {item.label}
              </span>
              <CaretRight
                size={26}
                weight="bold"
                className="shrink-0 text-[#6b7280] transition group-hover:translate-x-1 group-hover:text-[#536de8]"
              />
            </button>
          );
        })}
      </div>
    </nav>
  );
}

function HistoryDocuments({
  documents,
  emptyText,
  locale,
  navigationLocked,
  onOpenDocument,
}: {
  documents: SavedLearningDocument[];
  emptyText: string;
  locale: Locale;
  navigationLocked: boolean;
  onOpenDocument: (document: SavedLearningDocument) => void;
}) {
  if (!documents.length) {
    return (
      <p className="break-words text-[28px] font-normal leading-[1.55] tracking-normal text-[#111318]">
        {emptyText}
      </p>
    );
  }

  return (
    <div className="grid grid-cols-[repeat(auto-fill,minmax(136px,1fr))] gap-x-8 gap-y-9">
      {documents.map((document) => (
        <button
          key={document.id}
          type="button"
          disabled={navigationLocked}
          onClick={() => onOpenDocument(document)}
          aria-label={getLearningCopy(locale).content.documentFolder(document.title)}
          className="group flex min-h-[128px] w-full max-w-[160px] flex-col items-center justify-start rounded-md px-2 py-1 text-center outline-none transition focus-visible:ring-2 focus-visible:ring-[#536de8] disabled:cursor-wait disabled:opacity-70"
        >
          <span
            data-history-folder="icon"
            className="relative block h-[76px] w-[124px] rounded-[10px] bg-gradient-to-b from-[#68d4ff] via-[#45bff3] to-[#249fe3] shadow-[inset_0_1px_0_rgba(255,255,255,0.75),0_9px_18px_rgba(22,105,170,0.25)] before:absolute before:-top-[11px] before:left-[8px] before:h-[24px] before:w-[58px] before:rounded-t-[10px] before:bg-gradient-to-b before:from-[#73dcff] before:to-[#42bdf2] before:content-[''] after:absolute after:inset-x-0 after:bottom-[9px] after:h-px after:bg-white/25 after:content-[''] group-hover:brightness-105"
          >
            <span className="absolute inset-x-[6px] bottom-[5px] h-[6px] rounded-full bg-[#168bd5]/35" />
          </span>
          <span className="mt-3 line-clamp-2 max-w-full break-words text-[15px] font-semibold leading-5 text-[#202329]">
            {document.title}
          </span>
          <span className="mt-1 text-xs leading-4 text-[#70757f]">
            {formatHistoryDocumentTime(document.savedAt, locale)}
          </span>
        </button>
      ))}
    </div>
  );
}
