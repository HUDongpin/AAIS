import { formatHistoryDocumentTime } from "@/components/pages/learning/document-markdown";
import { getLearningCopy } from "@/components/pages/learning/learning-copy";
import type { SavedLearningDocument } from "@/components/pages/learning/learning-page-types";
import type { Locale } from "@/data/aais";

export function HistoryDocuments({
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
