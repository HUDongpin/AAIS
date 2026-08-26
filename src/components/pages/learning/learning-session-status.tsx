import type { LearningCopy } from "@/components/pages/learning/learning-copy";
import type { LearningSessionLoadState } from "@/components/pages/learning/use-learning-workspace-session";

export function LearningSessionStatus({
  copy,
  logoutError,
  loggingOut,
  onLogout,
  onRetry,
  signingOutLabel,
  signOutLabel,
  state,
}: {
  copy: LearningCopy["workspace"];
  logoutError: string;
  loggingOut: boolean;
  onLogout: () => void;
  onRetry: () => void;
  signingOutLabel: string;
  signOutLabel: string;
  state: LearningSessionLoadState;
}) {
  return (
    <div
      className="fixed inset-0 z-50 flex min-h-[100dvh] items-center justify-center bg-[#fcfcfc] px-6 text-center"
      data-testid="learning-session-status"
    >
      <div className="max-w-lg rounded-2xl border border-[#d8ddd8] bg-white px-6 py-5 shadow-sm">
        <p
          role={state === "error" ? "alert" : "progressbar"}
          aria-label={state === "error" ? undefined : copy.sessionLoading}
          aria-live={state === "error" ? undefined : "polite"}
          className="text-sm leading-6 text-[#303630]"
        >
          {state === "error" ? copy.sessionUnavailable : copy.sessionLoading}
        </p>
        {logoutError ? <p role="alert" className="mt-3 text-sm text-[#8f2f2f]">{logoutError}</p> : null}
        {state === "error" ? (
          <div className="mt-4 flex flex-wrap justify-center gap-3">
            <button
              type="button"
              className="min-h-11 rounded-lg border border-[#1d4d2a] px-4 py-2 text-sm font-semibold text-[#1d4d2a] focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#1d4d2a] disabled:opacity-60"
              disabled={loggingOut}
              onClick={onRetry}
            >
              {copy.retrySessionLoad}
            </button>
            <button
              type="button"
              className="min-h-11 rounded-lg border border-[#555] px-4 py-2 text-sm font-semibold text-[#333] focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#333] disabled:opacity-60"
              disabled={loggingOut}
              onClick={onLogout}
            >
              {loggingOut ? signingOutLabel : signOutLabel}
            </button>
          </div>
        ) : null}
      </div>
    </div>
  );
}
