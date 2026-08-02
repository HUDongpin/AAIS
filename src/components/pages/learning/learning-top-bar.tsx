import { DownloadSimple, SignOut, Sparkle, Trash } from "@phosphor-icons/react";
import { anthropicNavigationFontFamily } from "@/components/pages/learning/learning-page-constants";

export function LearningTopBar({
  accountMenuOpen,
  displayName,
  loggingOut,
  privacyBusy,
  onDeleteLearnerData,
  onExportLearnerData,
  onLogout,
  onToggleAccountMenu,
}: {
  accountMenuOpen: boolean;
  displayName: string;
  loggingOut: boolean;
  privacyBusy: boolean;
  onDeleteLearnerData: () => void;
  onExportLearnerData: () => void;
  onLogout: () => void;
  onToggleAccountMenu: () => void;
}) {
  return (
    <header
      className="flex h-11 shrink-0 items-center justify-between border-b border-[#ececeb] bg-[#fcfcfb] px-3 text-[#0e0e0e]"
      style={{ fontFamily: anthropicNavigationFontFamily }}
    >
      <div className="flex min-w-0 items-center gap-2">
        <span
          role="img"
          aria-label="AAIS 登录界面 logo"
          className="grid size-6 shrink-0 place-items-center rounded-2xl bg-[#1f6feb] text-white shadow-[0_8px_18px_rgba(31,111,235,0.24)]"
        >
          <Sparkle size={14} weight="duotone" />
        </span>
        <span className="truncate text-xs font-medium leading-tight tracking-normal sm:text-sm">
          Cognitive Apprenticeship AI System (CAAS)
        </span>
      </div>
      <div className="relative flex shrink-0 items-center gap-2">
        <button
          type="button"
          aria-label={`${displayName} 账户菜单`}
          aria-haspopup="menu"
          aria-expanded={accountMenuOpen}
          className="flex items-center gap-2 rounded-full px-1 py-0.5 text-[#0e0e0e] outline-none transition hover:bg-[#0e0e0e]/5 focus-visible:ring-2 focus-visible:ring-[#0e0e0e]/40"
          onClick={onToggleAccountMenu}
        >
          <span className="text-xs font-medium">{displayName}</span>
          <span
            role="img"
            aria-label={`${displayName} 原创英雄人脸头像`}
            title={`${displayName} 原创英雄人脸头像`}
            className="relative grid size-8 place-items-center overflow-hidden rounded-full border-2 border-[#f8fafc] bg-[#26378f] shadow-[0_2px_10px_rgba(0,0,0,0.35)]"
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
            role="menu"
            aria-label={`${displayName} 账户信息`}
            aria-busy={privacyBusy || loggingOut}
            className="absolute right-0 top-[calc(100%+6px)] z-40 min-w-[168px] rounded-lg border border-[#d9def0] bg-white py-1 text-[#172033] shadow-[0_12px_28px_rgba(0,0,0,0.22)]"
          >
            <button
              type="button"
              role="menuitem"
              className="flex h-10 w-full items-center gap-2 px-3 text-left text-sm font-semibold outline-none transition hover:bg-[#f3f6fb] focus-visible:bg-[#f3f6fb] disabled:cursor-not-allowed disabled:opacity-60"
              disabled={privacyBusy || loggingOut}
              onClick={onExportLearnerData}
            >
              <DownloadSimple size={17} weight="duotone" />
              导出学习数据
            </button>
            <button
              type="button"
              role="menuitem"
              className="flex h-10 w-full items-center gap-2 px-3 text-left text-sm font-semibold text-[#a12f56] outline-none transition hover:bg-[#fff1f5] focus-visible:bg-[#fff1f5] disabled:cursor-not-allowed disabled:opacity-60"
              disabled={privacyBusy || loggingOut}
              onClick={onDeleteLearnerData}
            >
              <Trash size={17} weight="duotone" />
              删除学习数据
            </button>
            <div className="my-1 border-t border-[#edf1f8]" />
            <button
              type="button"
              role="menuitem"
              className="flex h-10 w-full items-center gap-2 px-3 text-left text-sm font-semibold outline-none transition hover:bg-[#f3f6fb] focus-visible:bg-[#f3f6fb] disabled:cursor-not-allowed disabled:opacity-60"
              disabled={privacyBusy || loggingOut}
              onClick={onLogout}
            >
              <SignOut size={17} weight="duotone" />
              退出
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
