"use client";

import Link from "next/link";
import { BookOpen, SignOut, Sparkle, UserCircle } from "@phosphor-icons/react";

export function Header() {
  return (
    <header className="sticky top-0 z-30 border-b border-[#e6eaf2] bg-white/92 backdrop-blur-xl">
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
          aria-label="Primary"
          className="hidden min-w-0 items-center justify-center gap-8 md:absolute md:left-1/2 md:top-0 md:flex md:h-full md:-translate-x-1/2"
        >
          <Link
            href="/learning"
            className="relative flex h-[72px] items-center whitespace-nowrap px-1 text-base font-semibold text-[#1f6feb] outline-none transition focus-visible:ring-2 focus-visible:ring-[#1f6feb]"
          >
            我的学习
            <span className="absolute bottom-0 left-0 h-0.5 w-full rounded-full bg-[#1f6feb]" />
          </Link>
          <Link
            href="/dashboard"
            className="relative flex h-[72px] items-center whitespace-nowrap px-1 text-base font-semibold text-[#5e6680] outline-none transition hover:text-[#1f6feb] focus-visible:ring-2 focus-visible:ring-[#1f6feb]"
          >
            教师看板
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
            aria-label="用户"
          >
            <UserCircle size={20} weight="duotone" />
            <span className="hidden sm:inline">用户</span>
          </button>
          <Link
            href="/login"
            className="grid size-10 place-items-center rounded-full text-[#5e6680] outline-none transition hover:bg-[#f4f6fb] hover:text-[#1f6feb] focus-visible:ring-2 focus-visible:ring-[#1f6feb]"
            aria-label="退出账号"
          >
            <SignOut size={19} weight="duotone" />
          </Link>
        </div>
      </div>
    </header>
  );
}
