"use client";

import * as Sentry from "@sentry/nextjs";
import { useEffect } from "react";

export default function GlobalError({
  error,
}: {
  error: Error & { digest?: string };
}) {
  useEffect(() => {
    Sentry.captureException(error);
  }, [error]);

  return (
    <html lang="zh-CN">
      <body>
        <main className="flex min-h-screen items-center justify-center bg-[#f7f8fb] px-6 text-[#252b3f]">
          <section className="w-full max-w-md rounded-lg border border-[#d8deea] bg-white p-8 shadow-sm">
            <p className="text-sm font-semibold uppercase tracking-normal text-[#1f6feb]">
              AAIS
            </p>
            <h1 className="mt-3 text-2xl font-bold tracking-normal">
              系统暂时无法显示页面
            </h1>
            <p className="mt-3 text-sm leading-6 text-[#5d667f]">
              错误已记录。请返回登录页后重试；如果问题持续，请联系管理员。
            </p>
            <a
              className="mt-6 inline-flex rounded-md bg-[#1f6feb] px-4 py-2 text-sm font-semibold text-white"
              href="/login"
            >
              返回登录
            </a>
          </section>
        </main>
      </body>
    </html>
  );
}
