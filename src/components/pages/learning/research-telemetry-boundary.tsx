"use client";

import { useEffect, useState, type ReactNode } from "react";
import { useRouter } from "next/navigation";
import { deleteAaisAppSession } from "@/components/pages/learning/learning-session-client";
import {
  clearAaisResearchTelemetryForActor,
  startAaisResearchTelemetry,
  type AaisResearchTelemetryBoundaryState,
  type AaisResearchVisit,
} from "@/lib/client/aais-research-telemetry";

export type LearningResearchBoundary = {
  required: boolean;
  initialVisit: AaisResearchVisit | null;
};

export function useLearningResearchBoundary({
  initialVisit,
  required,
}: LearningResearchBoundary) {
  const [snapshot, setSnapshot] = useState<{
    state: AaisResearchTelemetryBoundaryState;
    workspaceActivated: boolean;
  }>({
    state: required ? "initializing" : "ready",
    workspaceActivated: !required,
  });

  useEffect(() => startAaisResearchTelemetry({
    enabled: required,
    initialVisit,
    onBoundaryStateChange: (state) => {
      setSnapshot((current) => ({
        state,
        workspaceActivated: current.workspaceActivated || state === "ready",
      }));
    },
    required,
  }), [initialVisit, required]);

  return snapshot;
}

export function LearningResearchWorkspaceBoundary({
  children,
  research,
}: {
  children: ReactNode;
  research: LearningResearchBoundary;
}) {
  const {
    state: boundaryState,
    workspaceActivated,
  } = useLearningResearchBoundary(research);

  if (!workspaceActivated && boundaryState !== "ready") {
    return <LearningResearchBoundaryNotice state={boundaryState} />;
  }
  const paused = research.required && boundaryState !== "ready";
  return (
    <div
      className="relative min-h-[100dvh]"
      data-research-boundary-state={boundaryState}
    >
      <div
        aria-hidden={paused || undefined}
        data-testid="research-workspace-gate"
        inert={paused || undefined}
      >
        {children}
      </div>
      {paused ? (
        <LearningResearchBoundaryNotice state={boundaryState} overlay />
      ) : null}
    </div>
  );
}

export function LearningResearchBoundaryNotice({
  allowSafeExit = true,
  overlay = false,
  state,
}: {
  allowSafeExit?: boolean;
  overlay?: boolean;
  state: Exclude<AaisResearchTelemetryBoundaryState, "ready">;
}) {
  const router = useRouter();
  const [exitBusy, setExitBusy] = useState(false);
  const [exitError, setExitError] = useState("");

  async function safelyExitResearchSession() {
    if (exitBusy) {
      return;
    }
    setExitBusy(true);
    setExitError("");
    try {
      await deleteAaisAppSession();
      clearAaisResearchTelemetryForActor();
      window.localStorage.removeItem("aais_student_id");
      window.localStorage.removeItem("aais_display_name");
      router.replace("/login");
    } catch {
      setExitError("安全退出暂时失败，请恢复连接后重试。");
      setExitBusy(false);
    }
  }

  const message = state === "initializing"
    ? "正在建立受控研究会话，请稍候。"
    : state === "offline-or-temporary"
      ? "研究记录连接暂时不可用。为避免产生未记录操作，学习工作台已暂停，并将在连接恢复后自动继续。"
      : "本次研究会话不可继续。请停止操作并联系研究人员。";

  const content = (
    <section className="w-full max-w-xl rounded-2xl border border-[#d9def0] bg-white p-8 shadow-[0_18px_48px_rgba(23,32,51,0.12)]">
      <h1 id="aais-research-boundary-heading" className="text-xl font-bold">
        AAIS 研究会话保护
      </h1>
      <p className="mt-4 text-base leading-7" role="status" aria-live="polite">
        {message}
      </p>
      {allowSafeExit ? (
        <div className="mt-6">
          <button
            className="rounded-lg border border-[#aeb8d0] bg-white px-4 py-2 font-semibold text-[#25345f] disabled:cursor-not-allowed disabled:opacity-60"
            disabled={exitBusy}
            onClick={() => { void safelyExitResearchSession(); }}
            type="button"
          >
            {exitBusy ? "正在安全退出..." : "安全退出到登录页"}
          </button>
          {exitError ? (
            <p className="mt-3 text-sm text-[#b42318]" role="alert">{exitError}</p>
          ) : null}
        </div>
      ) : null}
    </section>
  );

  if (overlay) {
    return (
      <div
        aria-labelledby="aais-research-boundary-heading"
        aria-modal="true"
        className="fixed inset-0 z-[100] grid place-items-center bg-[#fcfcfc]/95 px-6 text-[#172033]"
        data-research-boundary-state={state}
        role="alertdialog"
      >
        {content}
      </div>
    );
  }

  return (
    <main
      aria-labelledby="aais-research-boundary-heading"
      className="grid min-h-[100dvh] place-items-center bg-[#fcfcfc] px-6 text-[#172033]"
      data-research-boundary-state={state}
    >
      {content}
    </main>
  );
}
