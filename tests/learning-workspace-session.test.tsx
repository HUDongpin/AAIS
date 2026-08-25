import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fireEvent, render, screen } from "@testing-library/react";
import { useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useLearningWorkspaceSession } from "@/components/pages/learning/use-learning-workspace-session";
import { useLearningGuide } from "@/components/pages/learning/use-learning-guide";
import {
  createAaisLearnerSessionApiDto,
  createAaisLearningStore,
} from "@/lib/server/aais-learning-store";

const telemetryMocks = vi.hoisted(() => ({ operationCounter: 0 }));

vi.mock("@/lib/client/aais-research-telemetry", () => ({
  admitAaisResearchAction: () => true,
  captureAaisResearchActorGeneration: () => 0,
  classifyAaisResearchClientError: () => "request_failed",
  createAaisResearchOperationId: (prefix = "operation") => {
    telemetryMocks.operationCounter += 1;
    return `${prefix}-test-${telemetryMocks.operationCounter}`;
  },
  recordAaisResearchEvent: () => undefined,
}));

type PilotMutationKind = "record-ai-acceptance" | "save-pilot-evidence";

const tempRoots: string[] = [];

afterEach(async () => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  telemetryMocks.operationCounter = 0;
  await Promise.all(tempRoots.splice(0).map((root) => rm(root, { force: true, recursive: true })));
});

describe("useLearningWorkspaceSession pilot mutation recovery", () => {
  it("blocks guide submission while an AI-free choice is pending or unsaved, then replays its fence", async () => {
    const rootDir = await createTempRoot();
    const store = createAaisLearningStore({ rootDir });
    const studentId = "ai-use-mode-fail-closed";
    await store.getOrCreateSession(studentId);
    const requestBodies: Array<Record<string, unknown>> = [];
    let rejectFirstPatch!: (reason?: unknown) => void;
    const firstPatch = new Promise<Response>((_resolve, reject) => {
      rejectFirstPatch = reject;
    });
    let patchCount = 0;
    let guideRequestCount = 0;

    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input) === "/api/learning/session" && (!init || init.method === "GET")) {
        return jsonStoreSession(store, studentId);
      }
      if (String(input) === "/api/learning/session" && init?.method === "PATCH") {
        const body = JSON.parse(String(init.body)) as Record<string, unknown>;
        requestBodies.push(body);
        patchCount += 1;
        if (patchCount === 1) return firstPatch;
        const session = await store.savePilotEvidence(
          studentId,
          String(body.taskId),
          body.pilotEvidence as Parameters<(typeof store)["savePilotEvidence"]>[2],
          {
            dataGeneration: Number(body.dataGeneration),
            expectedPilotEvidenceRevision: Number(body.expectedPilotEvidenceRevision),
            mutationId: String(body.mutationId),
          },
        );
        return Response.json({ session: createAaisLearnerSessionApiDto(session) });
      }
      if (String(input).startsWith("/api/learning/ai-guide")) {
        guideRequestCount += 1;
      }
      return Response.json({ error: "unexpected request" }, { status: 500 });
    }));

    render(<AiUseModeFailClosedHarness studentId={studentId} />);
    await screen.findByText("revision:0");
    fireEvent.click(screen.getByRole("button", { name: "Save AI-free mode" }));
    await screen.findByText("mode:pending");
    fireEvent.click(screen.getByRole("button", { name: "Attempt guide" }));
    expect(guideRequestCount).toBe(0);
    expect(screen.getByText(/保存或重试当前 AI 使用选择/)).toBeTruthy();

    rejectFirstPatch(new TypeError("simulated mode-save network failure"));
    await screen.findByText("mode:unsaved");
    fireEvent.click(screen.getByRole("button", { name: "Attempt guide" }));
    expect(guideRequestCount).toBe(0);

    fireEvent.click(screen.getByRole("button", { name: "Save AI-free mode" }));
    await screen.findByText("mode:none");
    expect(requestBodies).toHaveLength(2);
    expect(requestBodies[1]).toMatchObject({
      expectedPilotEvidenceRevision: requestBodies[0]?.expectedPilotEvidenceRevision,
      mutationId: requestBodies[0]?.mutationId,
      pilotEvidence: { aiUseMode: "ai-free" },
    });
    expect((await store.readSession(studentId))?.tasks[0]?.pilotEvidence.aiUseMode)
      .toBe("ai-free");
  });

  it("replays a response-lost pilot evidence commit with the same mutation and revision", async () => {
    const rootDir = await createTempRoot();
    const store = createAaisLearningStore({ rootDir });
    const studentId = "pilot-evidence-response-lost";
    await store.getOrCreateSession(studentId);
    const requestBodies: Array<Record<string, unknown>> = [];
    let loseFirstResponse = true;

    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input) === "/api/learning/session" && (!init || init.method === "GET")) {
        return jsonStoreSession(store, studentId);
      }
      if (String(input) === "/api/learning/session" && init?.method === "PATCH") {
        const body = JSON.parse(String(init.body)) as Record<string, unknown>;
        requestBodies.push(body);
        const session = await store.savePilotEvidence(
          studentId,
          String(body.taskId),
          body.pilotEvidence as Parameters<(typeof store)["savePilotEvidence"]>[2],
          {
            dataGeneration: Number(body.dataGeneration),
            expectedPilotEvidenceRevision: Number(body.expectedPilotEvidenceRevision),
            mutationId: String(body.mutationId),
          },
        );
        if (loseFirstResponse) {
          loseFirstResponse = false;
          throw new TypeError("simulated response loss after commit");
        }
        return Response.json({ session: createAaisLearnerSessionApiDto(session) });
      }
      return Response.json({ error: "unexpected request" }, { status: 500 });
    }));

    render(<PilotMutationHarness kind="save-pilot-evidence" />);
    await screen.findByText("revision:0");

    fireEvent.click(screen.getByRole("button", { name: "Submit pilot mutation" }));
    await screen.findByText("mutation:error");
    fireEvent.click(screen.getByRole("button", { name: "Submit pilot mutation" }));
    await screen.findByText("mutation:success");

    expect(requestBodies).toHaveLength(2);
    expect(requestBodies[0]).toMatchObject({
      action: "save-pilot-evidence",
      expectedPilotEvidenceRevision: 0,
      mutationId: expect.stringMatching(/^pilot-evidence-mutation-test-/),
    });
    expect(requestBodies[1]).toMatchObject({
      expectedPilotEvidenceRevision: requestBodies[0]?.expectedPilotEvidenceRevision,
      mutationId: requestBodies[0]?.mutationId,
    });
    const replayed = await store.readSession(studentId);
    expect(replayed?.tasks[0]?.pilotEvidenceRevision).toBe(1);
    expect(replayed?.events.filter((event) =>
      event.event === "self_report_saved"
      && event.detail.source === "structured_pilot_evidence"
    )).toHaveLength(1);

    fireEvent.click(screen.getByRole("button", { name: "Change pilot payload" }));
    await screen.findByText("variant:2");
    fireEvent.click(screen.getByRole("button", { name: "Submit pilot mutation" }));
    await screen.findByText("mutation:success");
    expect(requestBodies).toHaveLength(3);
    expect(requestBodies[2]).toMatchObject({
      action: "save-pilot-evidence",
      expectedPilotEvidenceRevision: 1,
      mutationId: expect.stringMatching(/^pilot-evidence-mutation-test-/),
    });
    expect(requestBodies[2]?.mutationId).not.toBe(requestBodies[0]?.mutationId);
    const changed = await store.readSession(studentId);
    expect(changed?.tasks[0]?.pilotEvidenceRevision).toBe(2);
    expect(changed?.events.filter((event) =>
      event.event === "self_report_saved"
      && event.detail.source === "structured_pilot_evidence"
    )).toHaveLength(2);
  });

  it("replays a response-lost AI acceptance commit with the same mutation and revision", async () => {
    const rootDir = await createTempRoot();
    const store = createAaisLearningStore({ rootDir });
    const studentId = "ai-acceptance-response-lost";
    const exchange = await store.appendGuideExchange({
      studentId,
      phase: "training",
      taskId: "training_task_1",
      question: "请给我一个检查提示。",
      answer: "先检查目标和证据是否一致。",
      orchestration: {
        graphId: "recovery-test",
        threadId: "recovery-test-thread",
        topologicalOrder: ["A1"],
      },
    });
    const requestBodies: Array<Record<string, unknown>> = [];
    let loseFirstResponse = true;

    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input) === "/api/learning/session" && (!init || init.method === "GET")) {
        return jsonStoreSession(store, studentId);
      }
      if (String(input) === "/api/learning/session" && init?.method === "PATCH") {
        const body = JSON.parse(String(init.body)) as Record<string, unknown>;
        requestBodies.push(body);
        const session = await store.recordAiAcceptance(studentId, String(body.taskId), {
          accepted: body.accepted === true,
          dataGeneration: Number(body.dataGeneration),
          expectedPilotEvidenceRevision: Number(body.expectedPilotEvidenceRevision),
          messageId: String(body.messageId),
          mutationId: String(body.mutationId),
          reason: String(body.reason ?? ""),
        });
        if (loseFirstResponse) {
          loseFirstResponse = false;
          throw new TypeError("simulated response loss after commit");
        }
        return Response.json({ session: createAaisLearnerSessionApiDto(session) });
      }
      return Response.json({ error: "unexpected request" }, { status: 500 });
    }));

    render(
      <PilotMutationHarness
        kind="record-ai-acceptance"
        messageId={exchange.exchange.assistantMessageId}
      />,
    );
    await screen.findByText("revision:0");

    fireEvent.click(screen.getByRole("button", { name: "Submit pilot mutation" }));
    await screen.findByText("mutation:error");
    fireEvent.click(screen.getByRole("button", { name: "Submit pilot mutation" }));
    await screen.findByText("mutation:success");

    expect(requestBodies).toHaveLength(2);
    expect(requestBodies[0]).toMatchObject({
      action: "record-ai-acceptance",
      expectedPilotEvidenceRevision: 0,
      messageId: exchange.exchange.assistantMessageId,
      mutationId: expect.stringMatching(/^ai-acceptance-mutation-test-/),
    });
    expect(requestBodies[1]).toMatchObject({
      expectedPilotEvidenceRevision: requestBodies[0]?.expectedPilotEvidenceRevision,
      mutationId: requestBodies[0]?.mutationId,
    });
    const replayed = await store.readSession(studentId);
    expect(replayed?.tasks[0]?.pilotEvidenceRevision).toBe(1);
    expect(replayed?.events.filter((event) => event.event === "ai_acceptance_recorded"))
      .toHaveLength(1);
    expect(replayed?.events.filter((event) => event.event === "ai_acceptance_mutation_bound"))
      .toHaveLength(1);
  });

  it("reuses lost-response scaffold and task-selection receipts, then clears them on success", async () => {
    const rootDir = await createTempRoot();
    const store = createAaisLearningStore({ rootDir });
    const studentId = "workspace-stable-action-replay";
    await openPracticeTask(store, studentId);
    const requestBodies: Array<Record<string, unknown>> = [];
    let loseScaffoldResponse = true;
    let loseSelectionResponse = true;

    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input) === "/api/learning/session" && (!init || init.method === "GET")) {
        return jsonStoreSession(store, studentId);
      }
      if (String(input) === "/api/learning/scaffold" && init?.method === "POST") {
        const body = JSON.parse(String(init.body)) as Record<string, unknown>;
        requestBodies.push(body);
        const result = await store.requestScaffold(
          studentId,
          String(body.taskId),
          String(body.toolId),
          Number(body.dataGeneration),
          { mutationId: String(body.mutationId) },
        );
        if (loseScaffoldResponse) {
          loseScaffoldResponse = false;
          throw new TypeError("simulated scaffold response loss after commit");
        }
        return Response.json({ ...result, session: createAaisLearnerSessionApiDto(result.session) });
      }
      if (String(input) === "/api/learning/session" && init?.method === "PATCH") {
        const body = JSON.parse(String(init.body)) as Record<string, unknown>;
        requestBodies.push(body);
        const session = await store.selectTask(
          studentId,
          String(body.taskId),
          Number(body.dataGeneration),
          { mutationId: String(body.mutationId) },
        );
        if (loseSelectionResponse) {
          loseSelectionResponse = false;
          throw new TypeError("simulated selection response loss after commit");
        }
        return Response.json({ session: createAaisLearnerSessionApiDto(session) });
      }
      return Response.json({ error: "unexpected request" }, { status: 500 });
    }));

    render(<StableActionReplayHarness />);
    await screen.findByText("active:practice_task_1");
    fireEvent.click(screen.getByRole("button", { name: "Request scaffold" }));
    await screen.findByText("scaffold:error");
    fireEvent.click(screen.getByRole("button", { name: "Request scaffold" }));
    await screen.findByText("scaffold:success");
    expect(requestBodies[1]?.mutationId).toBe(requestBodies[0]?.mutationId);
    expect((await store.readSession(studentId))?.tasks.find((task) =>
      task.taskId === "practice_task_1"
    )?.scaffoldRequests).toBe(1);

    fireEvent.click(screen.getByRole("button", { name: "Request scaffold" }));
    await screen.findByText("scaffold:success-2");
    expect(requestBodies[2]?.mutationId).not.toBe(requestBodies[0]?.mutationId);
    expect((await store.readSession(studentId))?.tasks.find((task) =>
      task.taskId === "practice_task_1"
    )?.scaffoldRequests).toBe(2);

    fireEvent.click(screen.getByRole("button", { name: "Select task" }));
    await screen.findByText("selection:error");
    fireEvent.click(screen.getByRole("button", { name: "Select task" }));
    await screen.findByText("selection:success");
    expect(requestBodies[4]?.mutationId).toBe(requestBodies[3]?.mutationId);
    expect((await store.readSession(studentId))?.events.filter((event) =>
      event.detail.mutation_action === "select-task"
    )).toHaveLength(1);
  });
});

function AiUseModeFailClosedHarness({ studentId }: { studentId: string }) {
  const workspace = useLearningWorkspaceSession();
  const activeTask = workspace.tasks.find((task) => task.taskId === "training_task_1");
  const modeStatus = workspace.getAiUseModeMutationStatus("training_task_1");
  const guide = useLearningGuide({
    activeTaskId: "training_task_1",
    artifactText: "",
    displayName: "Test learner",
    isGuideSubmissionBlocked: () =>
      workspace.getAiUseModeMutationStatus("training_task_1") !== null,
    getHelpRequestsUsed: workspace.getTaskScaffoldRequests,
    locale: "zh-CN",
    onHelpRequestsUsedConfirmed: workspace.confirmTaskScaffoldRequests,
    studentId,
    waitForLearnerDataGeneration: workspace.waitForLearnerDataGeneration,
  });
  const [saveStatus, setSaveStatus] = useState("idle");

  async function saveAiFreeMode() {
    setSaveStatus("pending");
    try {
      await workspace.patchSession({
        action: "save-pilot-evidence",
        pilotEvidence: { aiUseMode: "ai-free" },
        taskId: "training_task_1",
      });
      setSaveStatus("success");
    } catch {
      setSaveStatus("error");
    }
  }

  return (
    <div>
      <output>{`revision:${activeTask?.pilotEvidenceRevision ?? "loading"}`}</output>
      <output>{`mode:${modeStatus ?? "none"}`}</output>
      <output>{`save:${saveStatus}`}</output>
      <output>{guide.guideError}</output>
      <button type="button" onClick={() => { void saveAiFreeMode(); }}>Save AI-free mode</button>
      <button type="button" onClick={() => {
        void guide.submitGuideQuestion("继续讨论课程任务");
      }}>
        Attempt guide
      </button>
    </div>
  );
}

function PilotMutationHarness({
  kind,
  messageId,
}: {
  kind: PilotMutationKind;
  messageId?: string;
}) {
  const workspace = useLearningWorkspaceSession();
  const [status, setStatus] = useState("idle");
  const [variant, setVariant] = useState(1);
  const activeTask = workspace.tasks.find((task) => task.taskId === workspace.activeTaskId);

  async function submit() {
    setStatus("pending");
    try {
      if (kind === "save-pilot-evidence") {
        await workspace.patchSession({
          action: kind,
          taskId: "training_task_1",
          pilotEvidence: {
            diagnosisText: variant === 1
              ? "第一版任务诊断只在本地请求正文中使用。"
              : "第二版任务诊断应产生一个全新的操作标识。",
          },
        });
      } else {
        await workspace.patchSession({
          accepted: true,
          action: kind,
          messageId,
          reason: "我核对了目标和证据后决定采纳。",
          taskId: "training_task_1",
        });
      }
      setStatus("success");
    } catch {
      setStatus("error");
    }
  }

  return (
    <div>
      <output>{`revision:${activeTask?.pilotEvidenceRevision ?? "loading"}`}</output>
      <output>{`mutation:${status}`}</output>
      <output>{`variant:${variant}`}</output>
      <button type="button" onClick={() => { void submit(); }}>Submit pilot mutation</button>
      <button type="button" onClick={() => {
        setStatus("idle");
        setVariant(2);
      }}>
        Change pilot payload
      </button>
    </div>
  );
}

function StableActionReplayHarness() {
  const workspace = useLearningWorkspaceSession();
  const [scaffoldStatus, setScaffoldStatus] = useState("idle");
  const [scaffoldSuccesses, setScaffoldSuccesses] = useState(0);
  const [selectionStatus, setSelectionStatus] = useState("idle");
  async function requestScaffold() {
    try {
      await workspace.requestScaffold("practice_task_1", "stage-checklist");
      setScaffoldSuccesses((count) => count + 1);
      setScaffoldStatus("success");
    } catch {
      setScaffoldStatus("error");
    }
  }
  async function selectTask() {
    try {
      await workspace.patchSession({ action: "select-task", taskId: "practice_task_1" });
      setSelectionStatus("success");
    } catch {
      setSelectionStatus("error");
    }
  }
  return (
    <div>
      <output>{`active:${workspace.activeTaskId}`}</output>
      <output>{`scaffold:${scaffoldStatus}${scaffoldSuccesses > 1 ? `-${scaffoldSuccesses}` : ""}`}</output>
      <output>{`selection:${selectionStatus}`}</output>
      <button type="button" onClick={() => { void requestScaffold(); }}>Request scaffold</button>
      <button type="button" onClick={() => { void selectTask(); }}>Select task</button>
    </div>
  );
}

async function createTempRoot() {
  const root = await mkdtemp(path.join(tmpdir(), "aais-workspace-session-"));
  tempRoots.push(root);
  return root;
}

async function jsonStoreSession(
  store: ReturnType<typeof createAaisLearningStore>,
  studentId: string,
) {
  const session = await store.readSession(studentId);
  if (!session) {
    return Response.json({ error: "missing session" }, { status: 404 });
  }
  return Response.json({ session: createAaisLearnerSessionApiDto(session) });
}

async function openPracticeTask(
  store: ReturnType<typeof createAaisLearningStore>,
  studentId: string,
) {
  await store.recordStageEvidence(
    studentId, "training_task_1", "launch_import", "orientation_acknowledged",
  );
  await store.recordStageEvidence(
    studentId, "training_task_1", "modeling", "expert_model_reviewed",
  );
  await store.completeTask(studentId, "training_task_1");
  await store.selectTask(studentId, "practice_task_1");
}
