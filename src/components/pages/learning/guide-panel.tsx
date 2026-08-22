import {
  useLayoutEffect,
  useRef,
  type Dispatch,
  type FormEvent,
  type RefObject,
  type SetStateAction,
} from "react";
import { ArrowUp, FileText, Plus, X } from "@phosphor-icons/react";
import type { AaisGuideTargetAgentId } from "@/lib/ai/aais-guide-targets";
import { aaisGuideFileAccept } from "@/lib/client/aais-guide-file-reader";
import {
  admitAaisResearchAction,
  createAaisResearchOperationId,
} from "@/lib/client/aais-research-telemetry";
import { getLearningCopy } from "@/components/pages/learning/learning-copy";
import {
  formatGuideAttachmentSize,
  GuideBubble,
  GuideThinkingBubble,
} from "@/components/pages/learning/guide-chat";
import type {
  GuideClientAttachment,
  GuideMessage,
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
  pendingGuideAgentId = null,
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
  pendingGuideAgentId?: AaisGuideTargetAgentId | null;
  sendGuideMessage: (event: FormEvent<HTMLFormElement>) => void;
  setGuideDraft: Dispatch<SetStateAction<string>>;
  setGuideError: Dispatch<SetStateAction<string>>;
}) {
  const copy = getLearningCopy(locale);
  const guideTextInputRef = useRef<HTMLInputElement | null>(null);
  const latestUserMessageId = getLatestUserMessageId(guideMessages);
  const latestAgentMessage = getLatestAgentMessage(guideMessages);
  const latestAgentMessageRevision = getAgentMessageRevision(latestAgentMessage);
  const previousLatestUserMessageIdRef = useRef(latestUserMessageId);
  const previousLatestAgentMessageRevisionRef = useRef(latestAgentMessageRevision);
  const latestUserMessageRef = useRef<HTMLDivElement | null>(null);
  const latestAgentMessageEndRef = useRef<HTMLSpanElement | null>(null);
  const guidePanelBusy = guideBusy || guideAttachmentBusy;
  const guideStatusText = guideAttachmentBusy ? copy.guide.readingFiles : "";

  useLayoutEffect(() => {
    const previousLatestUserMessageId = previousLatestUserMessageIdRef.current;
    const previousLatestAgentMessageRevision = previousLatestAgentMessageRevisionRef.current;
    const userMessageChanged = Boolean(
      latestUserMessageId && latestUserMessageId !== previousLatestUserMessageId,
    );
    const agentMessageChanged = Boolean(
      latestAgentMessageRevision
      && latestAgentMessageRevision !== previousLatestAgentMessageRevision,
    );
    previousLatestUserMessageIdRef.current = latestUserMessageId;
    previousLatestAgentMessageRevisionRef.current = latestAgentMessageRevision;

    if (userMessageChanged) {
      latestUserMessageRef.current?.scrollIntoView?.({
        block: "nearest",
        inline: "nearest",
      });
      return;
    }
    if (agentMessageChanged) {
      latestAgentMessageEndRef.current?.scrollIntoView?.({
        block: "end",
        inline: "nearest",
      });
    }
  }, [latestAgentMessageRevision, latestUserMessageId]);

  return (
    <section className="flex min-h-[620px] min-w-0 flex-col bg-[#fcfcfc] lg:min-h-0">
      <div className="min-h-0 flex-1 overflow-y-auto px-5 py-6 sm:px-8">
        <div className="space-y-4" aria-live="polite">
          {guideMessages.map((message) => {
            const isBlankAssistantMessage = message.kind === "assistant"
              && !message.text.trim()
              && !message.turns?.length;
            const showProfessorThinking = isBlankAssistantMessage
              && guideBusy
              && pendingGuideAgentId === "A2"
              && message.id === latestAgentMessage?.id;
            if (isBlankAssistantMessage && !showProfessorThinking) {
              return null;
            }
            const isLatestUserMessage = message.id === latestUserMessageId;
            const isLatestAgentMessage = message.id === latestAgentMessage?.id;
            return (
              <div
                data-guide-message-id={message.id}
                data-guide-message-kind={message.kind}
                key={message.id}
                ref={isLatestUserMessage ? latestUserMessageRef : undefined}
                className={isLatestUserMessage ? "scroll-mb-4" : undefined}
              >
                {showProfessorThinking ? (
                  <GuideThinkingBubble locale={locale} />
                ) : (
                  <GuideBubble
                    locale={locale}
                    message={message}
                    onSuggestedPrompt={(prompt) => {
                      setGuideDraft(prompt);
                      setGuideError("");
                      guideTextInputRef.current?.focus();
                    }}
                    suggestionsDisabled={guidePanelBusy}
                  />
                )}
                {isLatestAgentMessage ? (
                  <span
                    aria-hidden="true"
                    className="block h-px scroll-mb-4"
                    data-guide-message-end={message.id}
                    ref={latestAgentMessageEndRef}
                  />
                ) : null}
              </div>
            );
          })}
        </div>
      </div>

      <form
        onSubmit={sendGuideMessage}
        className="sticky bottom-0 z-10 shrink-0 border-t border-[#ececeb] bg-gradient-to-t from-[#fcfcfc] via-[#fcfcfc] to-[#fcfcfc]/90 px-5 py-3 sm:px-8"
      >
        <div
          aria-busy={guidePanelBusy}
          className="flex min-h-[72px] w-full items-center rounded-[28px] border border-[#d9dde7] bg-white px-5 shadow-[0_10px_32px_rgba(17,24,39,0.08)]"
        >
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
            ref={guideTextInputRef}
            aria-label={copy.guide.inputLabel}
            disabled={guidePanelBusy}
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

function getLatestUserMessageId(messages: GuideMessage[]) {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    if (messages[index]?.kind === "user") {
      return messages[index].id;
    }
  }
  return null;
}

function getLatestAgentMessage(messages: GuideMessage[]) {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    if (messages[index]?.kind === "assistant") {
      return messages[index];
    }
  }
  return null;
}

function getAgentMessageRevision(message: GuideMessage | null) {
  return message && (message.text.trim() || message.turns?.length)
    ? JSON.stringify(message)
    : null;
}
