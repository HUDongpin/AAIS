import type { Dispatch, FormEvent, RefObject, SetStateAction } from "react";
import { ArrowUp, FileText, Plus, X } from "@phosphor-icons/react";
import { aaisGuideFileAccept } from "@/lib/client/aais-guide-file-reader";
import {
  admitAaisResearchAction,
  createAaisResearchOperationId,
} from "@/lib/client/aais-research-telemetry";
import { getGuideQuickStarts } from "@/components/pages/learning/learning-page-constants";
import { getLearningCopy } from "@/components/pages/learning/learning-copy";
import {
  formatGuideAttachmentSize,
  GuideBubble,
} from "@/components/pages/learning/guide-chat";
import type {
  GuideClientAttachment,
  GuideMessage,
  GuideQuickStart,
} from "@/components/pages/learning/learning-page-types";
import type { Locale } from "@/data/aais";

export function GuidePanel({
  addGuideFiles,
  backendError,
  guideAttachmentBusy,
  guideAttachmentError,
  guideAttachments,
  guideBusy,
  guideDraft,
  guideError,
  guideFileInputRef,
  guideMessages,
  hasGuideSubmission,
  locale = "zh-CN",
  onRemoveAttachment,
  onSubmitGuideQuestion,
  sendGuideMessage,
  setGuideDraft,
  setGuideError,
}: {
  addGuideFiles: (files: FileList | File[] | null) => void;
  backendError: string;
  guideAttachmentBusy: boolean;
  guideAttachmentError: string;
  guideAttachments: GuideClientAttachment[];
  guideBusy: boolean;
  guideDraft: string;
  guideError: string;
  guideFileInputRef: RefObject<HTMLInputElement | null>;
  guideMessages: GuideMessage[];
  hasGuideSubmission: boolean;
  locale?: Locale;
  onRemoveAttachment: (attachmentId: string) => void;
  onSubmitGuideQuestion: (
    question: string,
    options?: { source: "quick_start"; quickStartId: GuideQuickStart["id"] },
  ) => void;
  sendGuideMessage: (event: FormEvent<HTMLFormElement>) => void;
  setGuideDraft: Dispatch<SetStateAction<string>>;
  setGuideError: Dispatch<SetStateAction<string>>;
}) {
  const copy = getLearningCopy(locale);
  const quickStarts = getGuideQuickStarts(locale);
  const guidePanelBusy = guideBusy || guideAttachmentBusy;
  const guideStatusText = guideBusy
    ? copy.guide.busy
    : guideAttachmentBusy
      ? copy.guide.readingFiles
      : "";

  return (
    <section
      className="flex min-h-[620px] min-w-0 flex-col bg-[#fcfcfc] lg:min-h-0"
      aria-busy={guidePanelBusy}
    >
      <div className="min-h-0 flex-1 overflow-y-auto px-5 py-6 sm:px-8">
        <div className="space-y-4" aria-live="polite">
          {guideMessages.map((message) => (
            <GuideBubble key={message.id} locale={locale} message={message} />
          ))}
        </div>
      </div>

      <form
        onSubmit={sendGuideMessage}
        className="sticky bottom-0 z-10 shrink-0 border-t border-[#ececeb] bg-gradient-to-t from-[#fcfcfc] via-[#fcfcfc] to-[#fcfcfc]/90 px-5 py-3 sm:px-8"
      >
        <div className="mb-3 flex flex-wrap gap-2" aria-label={copy.guide.quickStarts}>
          {quickStarts.map((item) => (
            <button
              key={item.label}
              type="button"
              disabled={guidePanelBusy}
              onClick={() => {
                if (!admitAaisResearchAction({
                  eventName: "guide_quick_start_selected",
                  outcome: "success",
                  detail: {
                    operation_id: createAaisResearchOperationId("quick-start"),
                    quick_start_id: item.id,
                  },
                })) {
                  return;
                }
                onSubmitGuideQuestion(item.prompt, {
                  source: "quick_start",
                  quickStartId: item.id,
                });
              }}
              className="min-h-9 rounded-full border border-[#d9dde7] bg-white px-3 text-[13px] font-semibold text-[#3d4656] shadow-[0_4px_14px_rgba(17,24,39,0.04)] outline-none transition hover:border-[#536de8] hover:text-[#324fd6] focus-visible:ring-2 focus-visible:ring-[#536de8] disabled:cursor-not-allowed disabled:opacity-60"
            >
              {item.label}
            </button>
          ))}
        </div>
        <div className="flex min-h-[72px] w-full items-center rounded-[28px] border border-[#d9dde7] bg-white px-5 shadow-[0_10px_32px_rgba(17,24,39,0.08)]">
          <input
            ref={guideFileInputRef}
            aria-label={copy.guide.chooseFiles}
            aria-hidden="true"
            tabIndex={-1}
            type="file"
            multiple
            accept={aaisGuideFileAccept}
            onChange={(event) => {
              addGuideFiles(event.target.files);
              event.target.value = "";
            }}
            disabled={guidePanelBusy}
            className="sr-only"
          />
          <button
            type="button"
            disabled={guidePanelBusy}
            aria-label={copy.guide.uploadFile}
            title={copy.guide.uploadFile}
            onClick={() => {
              if (!admitAaisResearchAction({
                eventName: "guide_attachment_picker_opened",
                outcome: "success",
                detail: {
                  operation_id: createAaisResearchOperationId("attachment-picker"),
                  trigger: "upload_button",
                },
              })) {
                return;
              }
              guideFileInputRef.current?.click();
            }}
            className="grid size-10 shrink-0 place-items-center rounded-full text-[#4b5563] outline-none transition hover:bg-[#f2f4f8] focus-visible:ring-2 focus-visible:ring-[#536de8] disabled:cursor-not-allowed disabled:opacity-60"
          >
            <Plus size={22} weight="bold" />
          </button>
          <input
            aria-label={copy.guide.inputLabel}
            value={guideDraft}
            onChange={(event) => {
              setGuideDraft(event.target.value);
              setGuideError("");
            }}
            placeholder={copy.guide.inputPlaceholder}
            className="h-[72px] min-w-0 flex-1 rounded-[28px] bg-transparent px-4 text-base text-[#2b2f36] outline-none placeholder:text-[#a6adbb]"
          />
          <button
            type="submit"
            disabled={guidePanelBusy}
            aria-label={copy.guide.send}
            className={[
              "grid size-10 shrink-0 place-items-center rounded-full text-white outline-none transition active:translate-y-px focus-visible:ring-2 focus-visible:ring-[#202329] focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-70",
              hasGuideSubmission
                ? "bg-[#202329] shadow-[0_10px_20px_rgba(17,24,39,0.18)] hover:bg-[#111318]"
                : "bg-[#d7dbe3] shadow-none hover:bg-[#cfd4df]",
            ].join(" ")}
          >
            <ArrowUp size={22} weight="bold" />
          </button>
        </div>
        {guideAttachments.length ? (
          <div className="mt-2 flex flex-wrap gap-2" aria-label={copy.guide.uploadedFiles}>
            {guideAttachments.map((attachment) => (
              <span
                key={attachment.id}
                className="inline-flex h-9 max-w-full items-center gap-2 rounded-full border border-[#d9dde7] bg-white px-3 text-xs font-medium text-[#3d4656] shadow-[0_4px_12px_rgba(17,24,39,0.04)]"
              >
                <FileText size={16} weight="duotone" className="shrink-0 text-[#536de8]" />
                <span className="max-w-[180px] truncate">{attachment.name}</span>
                <span className="shrink-0 text-[#8a92a3]">
                  {formatGuideAttachmentSize(attachment.sizeBytes)}
                </span>
                <button
                  type="button"
                  aria-label={copy.guide.removeFile(attachment.name)}
                  disabled={guidePanelBusy}
                  onClick={() => onRemoveAttachment(attachment.id)}
                  className="-mr-1 grid size-6 shrink-0 place-items-center rounded-full text-[#7b8190] outline-none hover:bg-[#f2f4f8] hover:text-[#202329] disabled:cursor-not-allowed disabled:opacity-60 focus-visible:ring-2 focus-visible:ring-[#536de8]"
                >
                  <X size={14} weight="bold" />
                </button>
              </span>
            ))}
          </div>
        ) : null}
        {guideAttachmentError ? (
          <p
            className="mt-2 w-full text-xs font-medium text-[#9b2445]"
            role="alert"
            aria-live="assertive"
            aria-atomic="true"
          >
            {guideAttachmentError}
          </p>
        ) : null}
        {guideError ? (
          <p
            className="mt-2 w-full text-xs font-medium text-[#9b2445]"
            role="alert"
            aria-live="assertive"
            aria-atomic="true"
          >
            {guideError}
          </p>
        ) : null}
        {backendError ? (
          <p
            className="mt-2 w-full text-xs font-medium text-[#9b2445]"
            role="alert"
            aria-live="assertive"
            aria-atomic="true"
          >
            {backendError}
          </p>
        ) : null}
        {guideStatusText ? (
          <p
            className="mt-2 w-full text-xs font-semibold text-[#4f5873]"
            role="status"
            aria-live="polite"
            aria-atomic="true"
          >
            {guideStatusText}
          </p>
        ) : null}
      </form>
    </section>
  );
}
