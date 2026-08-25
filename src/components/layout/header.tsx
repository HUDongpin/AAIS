"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { BookOpen, SignOut, Sparkle, UserCircle } from "@phosphor-icons/react";
import { deleteAaisAppSession } from "@/components/pages/learning/learning-session-client";
import type { Locale } from "@/data/aais";
import { replaceAaisBrowserLocation } from "@/lib/client/aais-browser-navigation";

const headerCopyByLocale = {
  "zh-CN": {
    primaryNavigation: "主导航",
    learning: "我的学习",
    dashboard: "教师看板",
    user: "用户",
    signOut: "退出账号",
    signingOut: "正在退出账号",
    signOutFailed: "退出失败，会话仍然有效。请稍后重试。",
  },
  "en-US": {
    primaryNavigation: "Primary navigation",
    learning: "My learning",
    dashboard: "Teacher dashboard",
    user: "User",
    signOut: "Sign out",
    signingOut: "Signing out",
    signOutFailed: "Sign-out failed. Your session is still active. Please try again.",
  },
} as const satisfies Record<Locale, Record<string, string>>;

export function Header({ locale = "zh-CN" }: { locale?: Locale }) {
  const copy = headerCopyByLocale[locale];
  const [loggingOut, setLoggingOut] = useState(false);
  const [logoutError, setLogoutError] = useState("");
  const logoutErrorRef = useRef<HTMLParagraphElement>(null);

  useEffect(() => {
    if (logoutError) {
      logoutErrorRef.current?.focus();
    }
  }, [logoutError]);

  async function handleLogout() {
    if (loggingOut) {
      return;
    }
    setLoggingOut(true);
    setLogoutError("");
    try {
      const result = await deleteAaisAppSession();
      if (!result.sessionRevoked && !result.sessionAbsent) {
        throw new Error("AAIS logout revocation was not acknowledged.");
      }
      replaceAaisBrowserLocation("/login");
    } catch {
      setLogoutError(copy.signOutFailed);
      setLoggingOut(false);
    }
  }

  return (
    <header
      className="sticky top-0 z-30 border-b border-[#e6eaf2] bg-white/92 backdrop-blur-xl"
      lang={locale}
    >
      <div className="relative mx-auto flex min-h-[72px] w-full max-w-[1608px] items-center justify-between gap-6 px-4 sm:px-6 lg:px-8">
        <Link
          href="/learning"
          className="flex shrink-0 items-center gap-3 rounded-2xl px-1 py-2 text-[#141833] outline-none transition focus-visible:ring-2 focus-visible:ring-[#1f6feb]"
          aria-label="AAIS"
        >
          <span className="flex size-10 items-center justify-center rounded-2xl bg-[#1f6feb] text-white shadow-[0_12px_30px_rgba(31,111,242,0.2)]">
            <Sparkle size={22} weight="duotone" />
          </span>
          <span className="hidden leading-tight sm:block">
            <span className="block text-base font-semibold tracking-normal">AAIS</span>
            <span className="block text-xs text-[#5e6680]">Apprenticeship AI System</span>
          </span>
        </Link>

        <nav
          aria-label={copy.primaryNavigation}
          className="hidden min-w-0 items-center justify-center gap-8 md:absolute md:left-1/2 md:top-0 md:flex md:h-full md:-translate-x-1/2"
        >
          <Link
            href="/learning"
            className="relative flex h-[72px] items-center whitespace-nowrap px-1 text-base font-semibold text-[#1f6feb] outline-none transition focus-visible:ring-2 focus-visible:ring-[#1f6feb]"
          >
            {copy.learning}
            <span className="absolute bottom-0 left-0 h-0.5 w-full rounded-full bg-[#1f6feb]" />
          </Link>
          <Link
            href="/dashboard"
            className="relative flex h-[72px] items-center whitespace-nowrap px-1 text-base font-semibold text-[#5e6680] outline-none transition hover:text-[#1f6feb] focus-visible:ring-2 focus-visible:ring-[#1f6feb]"
          >
            {copy.dashboard}
          </Link>
        </nav>

        <div className="flex shrink-0 items-center gap-2 text-[#202640]">
          <span className="hidden h-10 items-center gap-2 rounded-full px-3 text-sm font-medium md:inline-flex">
            <BookOpen size={19} weight="duotone" />
            Cognitive Apprenticeship
          </span>
          <button
            type="button"
            className="inline-flex h-10 items-center gap-2 rounded-full border border-[#dfe6f2] bg-white px-3 text-sm font-semibold text-[#202640] outline-none transition hover:border-[#bfdbfe] hover:text-[#1f6feb] focus-visible:ring-2 focus-visible:ring-[#1f6feb]"
            aria-label={copy.user}
          >
            <UserCircle size={20} weight="duotone" />
            <span className="hidden sm:inline">{copy.user}</span>
          </button>
          <button
            type="button"
            onClick={() => void handleLogout()}
            disabled={loggingOut}
            className="grid min-h-11 min-w-11 place-items-center rounded-full text-[#5e6680] outline-none transition hover:bg-[#f4f6fb] hover:text-[#1f6feb] disabled:cursor-wait disabled:opacity-60 focus-visible:ring-2 focus-visible:ring-[#1f6feb]"
            aria-label={loggingOut ? copy.signingOut : copy.signOut}
            aria-busy={loggingOut}
            aria-describedby={logoutError ? "aais-header-logout-error" : undefined}
          >
            <SignOut size={19} weight="duotone" aria-hidden="true" />
          </button>
        </div>
      </div>
      {loggingOut ? (
        <p className="sr-only" role="status" aria-live="polite" aria-atomic="true">
          {copy.signingOut}
        </p>
      ) : null}
      {logoutError ? (
        <p
          id="aais-header-logout-error"
          ref={logoutErrorRef}
          className="mx-auto w-full max-w-[1608px] border-t border-[#f0b7c9] bg-[#fff1f5] px-4 py-3 text-sm font-semibold text-[#a12f56] outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-[#a12f56] sm:px-6 lg:px-8"
          role="alert"
          aria-live="assertive"
          aria-atomic="true"
          tabIndex={-1}
        >
          {logoutError}
        </p>
      ) : null}
    </header>
  );
}
