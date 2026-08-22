import {
  useEffect,
  useId,
  useRef,
  type KeyboardEvent as ReactKeyboardEvent,
} from "react";
import { DownloadSimple, SignOut, Sparkle, Trash } from "@phosphor-icons/react";
import type { Locale } from "@/data/aais";
import { getLearningCopy } from "@/components/pages/learning/learning-copy";

type AccountMenuAction = () => void | Promise<void>;

export function LearningTopBar({
  accountMenuOpen,
  displayName,
  loggingOut,
  locale = "zh-CN",
  privacyBusy,
  onDeleteLearnerData,
  onExportLearnerData,
  onLogout,
  onToggleAccountMenu,
}: {
  accountMenuOpen: boolean;
  displayName: string;
  loggingOut: boolean;
  locale?: Locale;
  privacyBusy: boolean;
  onDeleteLearnerData: AccountMenuAction;
  onExportLearnerData: AccountMenuAction;
  onLogout: AccountMenuAction;
  onToggleAccountMenu: () => void;
}) {
  const copy = getLearningCopy(locale);
  const accountMenuId = useId();
  const accountRootRef = useRef<HTMLDivElement | null>(null);
  const accountTriggerRef = useRef<HTMLButtonElement | null>(null);
  const accountMenuItemRefs = useRef<Array<HTMLButtonElement | null>>([]);
  const initialMenuFocusRef = useRef(0);
  const closeRequestInFlightRef = useRef(false);
  const actionInFlightRef = useRef(false);
  const accountOperationBusy = privacyBusy || loggingOut;

  function focusMenuItem(index: number) {
    const enabledItems = accountMenuItemRefs.current.filter(
      (item): item is HTMLButtonElement => Boolean(item && !item.disabled),
    );
    if (enabledItems.length === 0) {
      return;
    }
    const normalizedIndex = ((index % enabledItems.length) + enabledItems.length) % enabledItems.length;
    enabledItems[normalizedIndex]?.focus();
  }

  function requestAccountMenuClose({ restoreTrigger = false } = {}) {
    if (!accountMenuOpen || closeRequestInFlightRef.current) {
      if (restoreTrigger) {
        accountTriggerRef.current?.focus();
      }
      return;
    }
    closeRequestInFlightRef.current = true;
    if (restoreTrigger) {
      accountTriggerRef.current?.focus();
    }
    onToggleAccountMenu();
    // Pointer-down followed by focus-in can otherwise request the same controlled
    // close twice before the parent has committed its next render.
    window.setTimeout(() => {
      closeRequestInFlightRef.current = false;
    }, 0);
  }

  function openAccountMenuAt(index: number) {
    initialMenuFocusRef.current = index;
    if (accountMenuOpen) {
      focusMenuItem(index);
      return;
    }
    onToggleAccountMenu();
  }

  function handleAccountTriggerKeyDown(event: ReactKeyboardEvent<HTMLButtonElement>) {
    if (event.key === "ArrowDown") {
      event.preventDefault();
      openAccountMenuAt(0);
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      openAccountMenuAt(-1);
    } else if (event.key === "Escape" && accountMenuOpen) {
      event.preventDefault();
      requestAccountMenuClose({ restoreTrigger: true });
    }
  }

  function handleAccountMenuKeyDown(event: ReactKeyboardEvent<HTMLDivElement>) {
    const enabledItems = accountMenuItemRefs.current.filter(
      (item): item is HTMLButtonElement => Boolean(item && !item.disabled),
    );
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      requestAccountMenuClose({ restoreTrigger: true });
      return;
    }
    if (enabledItems.length === 0) {
      return;
    }
    const currentIndex = Math.max(0, enabledItems.indexOf(document.activeElement as HTMLButtonElement));
    if (event.key === "ArrowDown") {
      event.preventDefault();
      focusMenuItem(currentIndex + 1);
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      focusMenuItem(currentIndex - 1);
    } else if (event.key === "Home") {
      event.preventDefault();
      focusMenuItem(0);
    } else if (event.key === "End") {
      event.preventDefault();
      focusMenuItem(-1);
    }
  }

  function runAccountAction(action: AccountMenuAction) {
    if (accountOperationBusy || actionInFlightRef.current) {
      return;
    }
    actionInFlightRef.current = true;
    try {
      const completion = action();
      if (!completion) {
        // A synchronous callback either completed or declined to start. In
        // both cases there is no in-flight work to protect from a second click.
        actionInFlightRef.current = false;
        return;
      }
      // Account hooks return their operation promise. Keep the short pre-render
      // double-click fence until that work settles, including early async
      // precondition exits that never transition a busy prop.
      void completion.then(
        () => {
          actionInFlightRef.current = false;
        },
        () => {
          actionInFlightRef.current = false;
        },
      );
    } catch (error) {
      actionInFlightRef.current = false;
      throw error;
    }
  }

  useEffect(() => {
    if (!accountMenuOpen) {
      initialMenuFocusRef.current = 0;
      closeRequestInFlightRef.current = false;
      actionInFlightRef.current = false;
      return;
    }
    focusMenuItem(initialMenuFocusRef.current);
  }, [accountMenuOpen]);

  useEffect(() => {
    if (!accountOperationBusy) {
      actionInFlightRef.current = false;
    }
  }, [accountOperationBusy]);

  useEffect(() => {
    if (!accountMenuOpen) {
      return;
    }
    function requestDocumentClose() {
      if (closeRequestInFlightRef.current) {
        return;
      }
      closeRequestInFlightRef.current = true;
      onToggleAccountMenu();
      window.setTimeout(() => {
        closeRequestInFlightRef.current = false;
      }, 0);
    }
    function handleDocumentPointerDown(event: PointerEvent) {
      if (!accountRootRef.current?.contains(event.target as Node)) {
        requestDocumentClose();
      }
    }
    function handleDocumentFocusIn(event: FocusEvent) {
      if (!accountRootRef.current?.contains(event.target as Node)) {
        requestDocumentClose();
      }
    }
    document.addEventListener("pointerdown", handleDocumentPointerDown);
    document.addEventListener("focusin", handleDocumentFocusIn);
    return () => {
      document.removeEventListener("pointerdown", handleDocumentPointerDown);
      document.removeEventListener("focusin", handleDocumentFocusIn);
    };
  }, [accountMenuOpen, onToggleAccountMenu]);

  return (
    <header
      className="aais-learning-navigation flex h-11 shrink-0 items-center justify-between border-b border-[#ececeb] bg-[#fcfcfb] px-3 text-[#0e0e0e]"
    >
      <div className="flex min-w-0 flex-1 items-center gap-2">
        <span
          role="img"
          aria-label={copy.brand.logoLabel}
          className="grid size-6 shrink-0 place-items-center rounded-2xl bg-[#1f6feb] text-white shadow-[0_8px_18px_rgba(31,111,235,0.24)]"
        >
          <Sparkle size={14} weight="duotone" />
        </span>
        <span className="truncate text-xs font-medium leading-tight tracking-normal sm:text-sm">
          Cognitive Apprenticeship AI System (CAAIS)
        </span>
      </div>
      <div
        ref={accountRootRef}
        data-account-root="true"
        className="relative flex min-w-0 max-w-[50%] shrink items-center gap-2"
      >
        <button
          ref={accountTriggerRef}
          type="button"
          aria-label={copy.brand.accountMenu(displayName)}
          aria-haspopup="menu"
          aria-expanded={accountMenuOpen}
          aria-controls={accountMenuId}
          className="flex min-h-11 min-w-11 max-w-full items-center justify-center gap-2 rounded-full px-1 py-0.5 text-[#0e0e0e] outline-none transition hover:bg-[#0e0e0e]/5 focus-visible:ring-2 focus-visible:ring-[#0e0e0e]/40"
          onClick={() => {
            if (accountMenuOpen) {
              requestAccountMenuClose();
            } else {
              openAccountMenuAt(0);
            }
          }}
          onKeyDown={handleAccountTriggerKeyDown}
        >
          <span
            data-account-display-name="true"
            title={displayName}
            className="min-w-0 truncate text-xs font-medium"
          >
            {displayName}
          </span>
          <span
            role="img"
            aria-label={copy.brand.avatar(displayName)}
            title={copy.brand.avatar(displayName)}
            className="relative grid size-8 shrink-0 place-items-center overflow-hidden rounded-full border-2 border-[#f8fafc] bg-[#26378f] shadow-[0_2px_10px_rgba(0,0,0,0.35)]"
          >
            <span aria-hidden="true" data-avatar-part="collar" className="absolute bottom-[-3px] h-3 w-[18px] rounded-t-full bg-[#d92332]" />
            <span aria-hidden="true" data-avatar-part="face" className="absolute left-[7px] top-[7px] h-[19px] w-[18px] rounded-[45%_45%_48%_48%] bg-[#f2c6a0]" />
            <span aria-hidden="true" data-avatar-part="hair" className="absolute left-[6px] top-[4px] h-[10px] w-5 rounded-t-full bg-[#10172f]" />
            <span aria-hidden="true" data-avatar-part="mask" className="absolute left-[6px] top-[11px] h-[8px] w-5 rounded-full bg-[#172554]" />
            <span aria-hidden="true" data-avatar-part="eye" className="absolute left-[11px] top-[13px] size-[3px] rounded-full bg-white" />
            <span aria-hidden="true" data-avatar-part="eye" className="absolute right-[11px] top-[13px] size-[3px] rounded-full bg-white" />
            <span aria-hidden="true" data-avatar-part="mouth" className="absolute left-[13px] top-[22px] h-px w-[6px] rounded-full bg-[#7c2d12]" />
          </span>
        </button>
        {accountMenuOpen ? (
          <div
            id={accountMenuId}
            role="menu"
            aria-label={copy.brand.accountInfo(displayName)}
            aria-busy={accountOperationBusy}
            onKeyDown={handleAccountMenuKeyDown}
            className="absolute right-0 top-[calc(100%+6px)] z-40 min-w-[168px] rounded-lg border border-[#d9def0] bg-white py-1 text-[#172033] shadow-[0_12px_28px_rgba(0,0,0,0.22)]"
          >
            <button
              ref={(item) => {
                accountMenuItemRefs.current[0] = item;
              }}
              type="button"
              role="menuitem"
              tabIndex={-1}
              className="flex min-h-11 w-full items-center gap-2 px-3 text-left text-sm font-semibold outline-none transition hover:bg-[#f3f6fb] focus-visible:bg-[#f3f6fb] disabled:cursor-not-allowed disabled:opacity-60"
              disabled={accountOperationBusy}
              onClick={() => runAccountAction(onExportLearnerData)}
            >
              <DownloadSimple size={17} weight="duotone" />
              {copy.brand.exportLearnerData}
            </button>
            <button
              ref={(item) => {
                accountMenuItemRefs.current[1] = item;
              }}
              type="button"
              role="menuitem"
              tabIndex={-1}
              className="flex min-h-11 w-full items-center gap-2 px-3 text-left text-sm font-semibold text-[#a12f56] outline-none transition hover:bg-[#fff1f5] focus-visible:bg-[#fff1f5] disabled:cursor-not-allowed disabled:opacity-60"
              disabled={accountOperationBusy}
              onClick={() => runAccountAction(onDeleteLearnerData)}
            >
              <Trash size={17} weight="duotone" />
              {copy.brand.deleteLearnerData}
            </button>
            <div className="my-1 border-t border-[#edf1f8]" />
            <button
              ref={(item) => {
                accountMenuItemRefs.current[2] = item;
              }}
              type="button"
              role="menuitem"
              tabIndex={-1}
              className="flex min-h-11 w-full items-center gap-2 px-3 text-left text-sm font-semibold outline-none transition hover:bg-[#f3f6fb] focus-visible:bg-[#f3f6fb] disabled:cursor-not-allowed disabled:opacity-60"
              disabled={accountOperationBusy}
              onClick={() => runAccountAction(onLogout)}
            >
              <SignOut size={17} weight="duotone" />
              {copy.brand.signOut}
            </button>
          </div>
        ) : null}
      </div>
    </header>
  );
}

export function LearningAccountFeedback({
  error,
  status,
}: {
  error: string;
  status: string;
}) {
  return (
    <>
      {status ? (
        <p
          className="border-b border-[#cce9d6] bg-[#effff4] px-4 py-2 text-sm font-semibold text-[#166534]"
          role="status"
          aria-live="polite"
          aria-atomic="true"
        >
          {status}
        </p>
      ) : null}
      {error ? (
        <p
          className="border-b border-[#f0b7c9] bg-[#fff1f5] px-4 py-2 text-sm font-semibold text-[#a12f56]"
          role="alert"
          aria-live="assertive"
          aria-atomic="true"
        >
          {error}
        </p>
      ) : null}
    </>
  );
}
