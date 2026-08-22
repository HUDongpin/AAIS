import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useLearningAccount } from "@/components/pages/learning/use-learning-account";
import type { AaisResearchLogoutContext } from "@/lib/client/aais-research-telemetry";

const navigationMocks = vi.hoisted(() => ({
  replace: vi.fn(),
}));
const sessionMocks = vi.hoisted(() => ({
  deleteAppSession: vi.fn(),
  fetchLearnerPrivacyData: vi.fn(),
}));
const documentMocks = vi.hoisted(() => ({
  prepareJsonDocumentSaveToLocal: vi.fn(),
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
  fetchLearnerPrivacyData: sessionMocks.fetchLearnerPrivacyData,
}));

vi.mock("@/lib/client/aais-browser-navigation", () => ({
  replaceAaisBrowserLocation: navigationMocks.replace,
}));

vi.mock("@/components/pages/learning/document-markdown", () => ({
  createLearnerDataFileName: vi.fn(() => "learner-data.json"),
  prepareJsonDocumentSaveToLocal: documentMocks.prepareJsonDocumentSaveToLocal,
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

function AccountHarness({ operationBusy = false }: { operationBusy?: boolean }) {
  const account = useLearningAccount({
    learnerDataGeneration: 1,
    operationBusy,
    onLearnerDataDeleteSucceeded: vi.fn(),
    studentId: "learner-01",
  });
  return (
    <>
      <button onClick={() => { void account.handleLogout(); }} type="button">
        退出
      </button>
      <button onClick={() => { void account.handleExportLearnerData(); }} type="button">
        导出
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
  sessionMocks.fetchLearnerPrivacyData.mockReset();
  documentMocks.prepareJsonDocumentSaveToLocal.mockReset();
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
      sessionAbsent: false,
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

  it("routes an already-absent formal-research session to the ACK-gap login", async () => {
    telemetryMocks.logoutContext = {
      expectedVisitId: "10000000-0000-4000-8000-000000000011",
      failureClientEventId: "10000000-0000-4000-8000-000000000012",
      finalClientTime: "2026-08-01T10:00:00.000Z",
      operationId: "replaced-by-hook",
      successClientEventId: "10000000-0000-4000-8000-000000000013",
    };
    sessionMocks.deleteAppSession.mockResolvedValue({
      researchAcknowledged: false,
      sessionAbsent: true,
      sessionRevoked: false,
    });
    render(<AccountHarness />);

    fireEvent.click(screen.getByRole("button", { name: "退出" }));

    await waitFor(() => expect(navigationMocks.replace).toHaveBeenCalledWith(
      "/login?researchLogout=ack-failed",
    ));
    expect(window.sessionStorage.getItem("aais_research_logout_ack_gap_v1")).toBe("1");
    expect(telemetryMocks.clearActor).toHaveBeenCalledOnce();
  });

  it("acquires the JSON save target before awaiting the privacy response", async () => {
    let resolveExport: ((value: unknown) => void) | undefined;
    const exportResponse = new Promise<unknown>((resolve) => {
      resolveExport = resolve;
    });
    const writeDocument = vi.fn(async () => undefined);
    documentMocks.prepareJsonDocumentSaveToLocal.mockResolvedValue(writeDocument);
    sessionMocks.fetchLearnerPrivacyData.mockReturnValue(exportResponse);
    render(<AccountHarness />);

    fireEvent.click(screen.getByRole("button", { name: "导出" }));

    expect(documentMocks.prepareJsonDocumentSaveToLocal).toHaveBeenCalledWith({
      fileName: "learner-data.json",
    });
    await waitFor(() => expect(sessionMocks.fetchLearnerPrivacyData).toHaveBeenCalledOnce());
    expect(documentMocks.prepareJsonDocumentSaveToLocal.mock.invocationCallOrder[0]).toBeLessThan(
      sessionMocks.fetchLearnerPrivacyData.mock.invocationCallOrder[0],
    );
    expect(writeDocument).not.toHaveBeenCalled();

    resolveExport?.({ exportScope: "learner-data" });
    await waitFor(() => expect(writeDocument).toHaveBeenCalledWith({
      exportScope: "learner-data",
    }));
  });

  it("refuses an export while another learning operation can still change learner data", async () => {
    const writeDocument = vi.fn(async () => undefined);
    documentMocks.prepareJsonDocumentSaveToLocal.mockResolvedValue(writeDocument);
    sessionMocks.fetchLearnerPrivacyData.mockResolvedValue({ exportScope: "learner-data" });
    render(<AccountHarness operationBusy />);

    fireEvent.click(screen.getByRole("button", { name: "导出" }));

    expect(await screen.findByText("请等待当前保存、下载或智能体操作完成后再导出学习数据。"))
      .toBeTruthy();
    expect(documentMocks.prepareJsonDocumentSaveToLocal).not.toHaveBeenCalled();
    expect(sessionMocks.fetchLearnerPrivacyData).not.toHaveBeenCalled();
    expect(writeDocument).not.toHaveBeenCalled();
  });

  it("treats save-picker cancellation as a user cancellation without fetching data", async () => {
    const cancellation = new DOMException("The user aborted a request.", "AbortError");
    documentMocks.prepareJsonDocumentSaveToLocal.mockRejectedValue(cancellation);
    render(<AccountHarness />);

    fireEvent.click(screen.getByRole("button", { name: "导出" }));

    await waitFor(() => expect(telemetryMocks.record).toHaveBeenCalledWith(
      expect.objectContaining({
        eventName: "learner_data_export",
        outcome: "failure",
        detail: expect.objectContaining({ error_kind: "user_cancelled" }),
      }),
    ));
    expect(sessionMocks.fetchLearnerPrivacyData).not.toHaveBeenCalled();
    expect(screen.queryByText("学习数据导出未能完成，请稍后重试。")).toBeNull();
  });
});
