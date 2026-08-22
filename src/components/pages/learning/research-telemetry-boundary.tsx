"use client";

import { useEffect, useState, type ReactNode } from "react";
import { deleteAaisAppSession } from "@/components/pages/learning/learning-session-client";
import { replaceAaisBrowserLocation } from "@/lib/client/aais-browser-navigation";
import {
  clearAaisResearchTelemetryForActor,
  startAaisResearchTelemetry,
  type AaisResearchTelemetryBoundaryState,
  type AaisResearchVisit,
} from "@/lib/client/aais-research-telemetry";
import { getLearningCopy } from "@/components/pages/learning/learning-copy";
import type { Locale } from "@/data/aais";

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
  locale = "zh-CN",
  research,
}: {
  children: ReactNode;
  locale?: Locale;
  research: LearningResearchBoundary;
}) {
  const {
    state: boundaryState,
    workspaceActivated,
  } = useLearningResearchBoundary(research);

  if (!workspaceActivated && boundaryState !== "ready") {
    return <LearningResearchBoundaryNotice locale={locale} state={boundaryState} />;
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
        <LearningResearchBoundaryNotice locale={locale} state={boundaryState} overlay />
      ) : null}
    </div>
  );
}

export function LearningResearchBoundaryNotice({
  allowSafeExit = true,
  locale = "zh-CN",
  overlay = false,
  state,
}: {
  allowSafeExit?: boolean;
  locale?: Locale;
  overlay?: boolean;
  state: Exclude<AaisResearchTelemetryBoundaryState, "ready">;
}) {
  const copy = getLearningCopy(locale).researchBoundary;
  const [exitBusy, setExitBusy] = useState(false);
  const [exitError, setExitError] = useState("");

  async function safelyExitResearchSession() {
    if (exitBusy) {
      return;
    }
    setExitBusy(true);
    setExitError("");
    try {
      const logoutResult = await deleteAaisAppSession();
      if (!logoutResult.sessionRevoked && !logoutResult.sessionAbsent) {
        throw new Error("AAIS safe logout revocation was not acknowledged.");
      }
      clearAaisResearchTelemetryForActor();
      window.localStorage.removeItem("aais_student_id");
      window.localStorage.removeItem("aais_display_name");
      replaceAaisBrowserLocation("/login");
    } catch {
      setExitError(copy.safeExitFailed);
      setExitBusy(false);
    }
  }

  const message = state === "initializing"
    ? copy.initializing
    : state === "offline-or-temporary"
      ? copy.offlineOrTemporary
      : copy.terminalBlocked;

  const content = (
    <section className="w-full max-w-xl rounded-2xl border border-[#d9def0] bg-white p-8 shadow-[0_18px_48px_rgba(23,32,51,0.12)]">
      <h1 id="aais-research-boundary-heading" className="text-xl font-bold">
        {copy.heading}
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
            {exitBusy ? copy.safeExiting : copy.safeExit}
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
