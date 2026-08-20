import {
  ArrowLeft,
  CardsThree,
  CaretRight,
  CheckCircle,
  FolderSimple,
  LockKey,
  PlayCircle,
  SquaresFour,
} from "@phosphor-icons/react";
import { formatHistoryDocumentTime } from "@/components/pages/learning/document-markdown";
import { getLearningCopy } from "@/components/pages/learning/learning-copy";
import type {
  AaisClientTaskRecord,
  AaisClientTaskStatus,
  ContentItemId,
  SavedLearningDocument,
} from "@/components/pages/learning/learning-page-types";
import { aaisLearningProgram, type Locale } from "@/data/aais";

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
  activeTaskId,
  historyDocuments,
  locale = "zh-CN",
  navigationLocked = false,
  onBack,
  onCompleteTask,
  onOpen,
  onOpenDocument,
  onSelectTask,
  taskActionBusy = false,
  taskActionError = "",
  tasks,
}: {
  activeContent: ContentDisplayItem | null;
  activeTaskId: string;
  historyDocuments: SavedLearningDocument[];
  locale?: Locale;
  navigationLocked?: boolean;
  onBack: () => void;
  onCompleteTask: (taskId: string) => void;
  onOpen: (id: ContentItemId) => void;
  onOpenDocument: (document: SavedLearningDocument) => void;
  onSelectTask: (taskId: string) => void;
  taskActionBusy?: boolean;
  taskActionError?: string;
  tasks: AaisClientTaskRecord[];
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
          ) : activeContent.id === "theory" ? (
            <TaskCards
              activeTaskId={activeTaskId}
              busy={taskActionBusy}
              error={taskActionError}
              locale={locale}
              navigationLocked={navigationLocked}
              onCompleteTask={onCompleteTask}
              onSelectTask={onSelectTask}
              tasks={tasks}
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
                ? CardsThree
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

const taskDefinitions = [
  ...aaisLearningProgram.training.tasks,
  ...aaisLearningProgram.practice.tasks,
];

function TaskCards({
  activeTaskId,
  busy,
  error,
  locale,
  navigationLocked,
  onCompleteTask,
  onSelectTask,
  tasks,
}: {
  activeTaskId: string;
  busy: boolean;
  error: string;
  locale: Locale;
  navigationLocked: boolean;
  onCompleteTask: (taskId: string) => void;
  onSelectTask: (taskId: string) => void;
  tasks: AaisClientTaskRecord[];
}) {
  const copy = getLearningCopy(locale).content.taskCards;
  const taskCards = taskDefinitions.map((definition, index) => {
    const record = tasks.find((task) => task.taskId === definition.id);
    return {
      definition,
      index,
      status: resolveTaskCardStatus({
        activeTaskId,
        index,
        record,
      }),
    };
  });
  const completedCount = taskCards.filter((task) => task.status === "completed").length;

  return (
    <section aria-label={copy.listLabel}>
      <div className="mb-5 flex flex-wrap items-center justify-between gap-3">
        <p className="text-[15px] leading-6 text-[#5f6672]">
          {getLearningCopy(locale).content.items.theory.body}
        </p>
        <span
          aria-live="polite"
          className="shrink-0 rounded-full border border-[#d7ddff] bg-[#eef2ff] px-3 py-1 text-sm font-semibold text-[#3f55bb]"
        >
          {copy.progress(completedCount, taskCards.length)}
        </span>
      </div>
      {error ? (
        <p
          role="alert"
          aria-live="assertive"
          className="mb-4 rounded-xl border border-[#f0b7c9] bg-[#fff1f5] px-4 py-3 text-sm font-semibold text-[#8f2448]"
        >
          {error}
        </p>
      ) : null}
      <ol className="grid gap-4">
        {taskCards.map(({ definition, index, status }) => {
          const title = definition.title[locale];
          const brief = definition.brief[locale];
          const locked = status === "locked";
          const completed = status === "completed";
          const active = status === "active" && definition.id === activeTaskId;
          const StatusIcon = locked ? LockKey : completed ? CheckCircle : PlayCircle;
          const primaryLabel = completed
            ? copy.review
            : active
              ? copy.continue
              : copy.enter;
          const primaryAriaLabel = completed
            ? copy.reviewButton(title)
            : active
              ? copy.continueButton(title)
              : copy.enterButton(title);
          const cardStateClass = locked
            ? "border-[#d4d8e0] bg-[#f3f4f5]"
            : completed
              ? "border-[#badcc5] bg-[#f5fbf7]"
              : active
                ? "border-[#9eabf4] bg-[#f7f8ff] shadow-[0_10px_26px_rgba(83,109,232,0.10)]"
                : "border-[#d7dce5] bg-white shadow-[0_8px_24px_rgba(17,24,39,0.05)]";
          const statusClass = locked
            ? "border-[#d4d8e0] bg-[#e7e9ed] text-[#555d69]"
            : completed
              ? "border-[#badcc5] bg-[#e5f5ea] text-[#28613b]"
              : active
                ? "border-[#cbd2ff] bg-[#e8ecff] text-[#344ab8]"
                : "border-[#d7ddff] bg-[#eef2ff] text-[#3f55bb]";

          return (
            <li
              key={definition.id}
              data-task-card={definition.id}
              data-task-status={status}
              className={`rounded-2xl border p-5 transition-colors ${cardStateClass}`}
            >
              <article aria-labelledby={`aais-task-card-${definition.id}`}>
                <div className="flex items-start gap-4">
                  <span
                    aria-hidden="true"
                    className={`grid size-12 shrink-0 place-items-center rounded-xl border ${statusClass}`}
                  >
                    <StatusIcon size={25} weight={completed ? "fill" : "duotone"} />
                  </span>
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="text-xs font-semibold uppercase tracking-[0.08em] text-[#6b7280]">
                        {copy.ordinal(index + 1)} · {copy.phase[definition.phase]}
                      </span>
                      <span className={`rounded-full border px-2.5 py-1 text-xs font-bold ${statusClass}`}>
                        {copy.status[status]}
                      </span>
                    </div>
                    <h3
                      id={`aais-task-card-${definition.id}`}
                      className={`mt-2 text-[20px] font-semibold leading-7 ${locked ? "text-[#5d6470]" : "text-[#171a21]"}`}
                    >
                      {title}
                    </h3>
                    <p className={`mt-2 text-[15px] leading-6 ${locked ? "text-[#747b86]" : "text-[#555d69]"}`}>
                      {locked ? copy.lockedHint : brief}
                    </p>
                  </div>
                </div>
                <div className="mt-5 flex flex-wrap justify-end gap-3">
                  {locked ? (
                    <button
                      type="button"
                      disabled
                      aria-label={copy.lockedButton(title)}
                      className="inline-flex min-h-11 min-w-[132px] cursor-not-allowed items-center justify-center gap-2 rounded-xl border border-[#cfd3db] bg-[#e3e5e9] px-4 text-sm font-semibold text-[#555d69]"
                    >
                      <LockKey aria-hidden="true" size={18} weight="bold" />
                      {copy.status.locked}
                    </button>
                  ) : (
                    <>
                      <button
                        type="button"
                        disabled={busy || navigationLocked}
                        aria-label={primaryAriaLabel}
                        onClick={() => onSelectTask(definition.id)}
                        className="inline-flex min-h-11 min-w-[132px] items-center justify-center rounded-xl border border-[#c9cfda] bg-white px-4 text-sm font-semibold text-[#303744] outline-none transition hover:border-[#536de8] hover:text-[#324fd6] focus-visible:ring-2 focus-visible:ring-[#536de8] focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-60"
                      >
                        {primaryLabel}
                      </button>
                      {active ? (
                        <button
                          type="button"
                          disabled={busy || navigationLocked}
                          aria-label={copy.completeButton(title)}
                          onClick={() => onCompleteTask(definition.id)}
                          className="inline-flex min-h-11 min-w-[132px] items-center justify-center rounded-xl bg-[#536de8] px-4 text-sm font-semibold text-white shadow-[0_8px_18px_rgba(83,109,232,0.22)] outline-none transition hover:bg-[#4059d1] focus-visible:ring-2 focus-visible:ring-[#253fb0] focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-60"
                        >
                          {busy ? copy.completing : copy.complete}
                        </button>
                      ) : null}
                    </>
                  )}
                </div>
              </article>
            </li>
          );
        })}
      </ol>
    </section>
  );
}

function resolveTaskCardStatus({
  activeTaskId,
  index,
  record,
}: {
  activeTaskId: string;
  index: number;
  record?: AaisClientTaskRecord;
}): AaisClientTaskStatus {
  if (
    record?.status === "locked"
    || record?.status === "available"
    || record?.status === "active"
    || record?.status === "completed"
  ) {
    return record.status;
  }
  if (record?.taskId === activeTaskId || (!record && index === 0)) {
    return "active";
  }
  return "locked";
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
