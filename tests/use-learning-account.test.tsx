import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useLearningAccount } from "@/components/pages/learning/use-learning-account";
import type { AaisResearchLogoutContext } from "@/lib/client/aais-research-telemetry";

const navigationMocks = vi.hoisted(() => ({
  replace: vi.fn(),
}));
const sessionMocks = vi.hoisted(() => ({
  deleteAppSession: vi.fn(),
}));
const telemetryMocks = vi.hoisted(() => ({
  clearActor: vi.fn(),
  flush: vi.fn(async () => undefined),
  logoutContext: null as AaisResearchLogoutContext | null,
  pendingCount: 0,
  record: vi.fn(),
}));

vi.mock("@/components/pages/learning/learning-session-client", () => ({
  deleteAaisAppSession: sessionMocks.deleteAppSession,
  deleteLearnerPrivacyData: vi.fn(),
  fetchLearnerPrivacyData: vi.fn(),
}));

vi.mock("@/lib/client/aais-browser-navigation", () => ({
  replaceAaisBrowserLocation: navigationMocks.replace,
}));

vi.mock("@/components/pages/learning/document-markdown", () => ({
  createLearnerDataFileName: vi.fn(() => "learner-data.json"),
  saveJsonDocumentToLocal: vi.fn(),
}));

vi.mock("@/lib/client/aais-research-telemetry", () => ({
  admitAaisResearchAction: vi.fn(() => true),
  captureAaisResearchActorGeneration: vi.fn(() => 0),
  classifyAaisResearchClientError: vi.fn(() => "request_failed"),
  clearAaisResearchTelemetryForActor: telemetryMocks.clearActor,
  createAaisResearchLogoutContext: vi.fn((operationId: string) => (
    telemetryMocks.logoutContext
      ? { ...telemetryMocks.logoutContext, operationId }
      : null
  )),
  createAaisResearchOperationId: vi.fn(() => "account-logout-test"),
  flushAaisResearchTelemetry: telemetryMocks.flush,
  getAaisResearchTelemetryPendingCount: vi.fn(() => telemetryMocks.pendingCount),
  recordAaisResearchEvent: telemetryMocks.record,
}));

function AccountHarness() {
  const account = useLearningAccount({
    operationBusy: false,
    onLearnerDataDeleteStarted: vi.fn(),
    studentId: "learner-01",
  });
  return (
    <>
      <button onClick={() => { void account.handleLogout(); }} type="button">
        退出
      </button>
      <p>{account.accountError}</p>
      <p>{account.accountStatus}</p>
    </>
  );
}

afterEach(() => {
  vi.restoreAllMocks();
  navigationMocks.replace.mockReset();
  sessionMocks.deleteAppSession.mockReset();
  telemetryMocks.clearActor.mockReset();
  telemetryMocks.flush.mockReset();
  telemetryMocks.flush.mockImplementation(async () => undefined);
  telemetryMocks.logoutContext = null;
  telemetryMocks.pendingCount = 0;
  telemetryMocks.record.mockReset();
  window.localStorage.clear();
  window.sessionStorage.clear();
});

describe("useLearningAccount research logout boundary", () => {
  it("does not let a stale research queue block ordinary logout", async () => {
    telemetryMocks.pendingCount = 2;
    sessionMocks.deleteAppSession.mockResolvedValue({
      researchAcknowledged: false,
      sessionRevoked: true,
    });
    window.localStorage.setItem("aais_student_id", "learner-01");
    window.localStorage.setItem("aais_display_name", "Learner");
    render(<AccountHarness />);

    fireEvent.click(screen.getByRole("button", { name: "退出" }));

    await waitFor(() => expect(sessionMocks.deleteAppSession).toHaveBeenCalledWith(null));
    expect(telemetryMocks.flush).not.toHaveBeenCalled();
    expect(telemetryMocks.clearActor).toHaveBeenCalledOnce();
    expect(navigationMocks.replace).toHaveBeenCalledWith("/login");
    expect(window.localStorage.getItem("aais_student_id")).toBeNull();
    expect(window.localStorage.getItem("aais_display_name")).toBeNull();
  });

  it("still fails closed on a pending queue for a validated research logout", async () => {
    telemetryMocks.logoutContext = {
      expectedVisitId: "10000000-0000-4000-8000-000000000001",
      failureClientEventId: "10000000-0000-4000-8000-000000000002",
      finalClientTime: "2026-08-01T10:00:00.000Z",
      operationId: "replaced-by-hook",
      successClientEventId: "10000000-0000-4000-8000-000000000003",
    };
    telemetryMocks.pendingCount = 1;
    render(<AccountHarness />);

    fireEvent.click(screen.getByRole("button", { name: "退出" }));

    expect(await screen.findByText("研究事件尚未安全同步，请保持联网并稍后重试退出。")).toBeTruthy();
    expect(telemetryMocks.flush).toHaveBeenCalledOnce();
    expect(sessionMocks.deleteAppSession).not.toHaveBeenCalled();
    expect(telemetryMocks.clearActor).not.toHaveBeenCalled();
    expect(navigationMocks.replace).not.toHaveBeenCalled();
  });
});
