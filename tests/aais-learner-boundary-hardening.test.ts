import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  createAaisLearnerSessionApiDto,
  createAaisLearningStore,
  type AaisGuideMessageRecord,
} from "@/lib/server/aais-learning-store";
import { createAaisEvent } from "@/data/aais";

const tempRoots: string[] = [];

afterEach(async () => {
  await Promise.all(tempRoots.splice(0).map((root) =>
    rm(root, { force: true, recursive: true })
  ));
});

describe("learner DTO and mutation replay hardening", () => {
  it("projects only canonical learner-visible guide pairs and learner-safe event fields", async () => {
    const store = createAaisLearningStore({ rootDir: await createTempRoot() });
    const session = await store.getOrCreateSession("dto-hardening");
    session.guideMessages = [
      guideMessage("user-visible", "user", "请给我下一步。"),
      {
        ...guideMessage("assistant-visible", "assistant", "unsafe aggregate"),
        turns: [
          { agentId: "A1", label: "小张", content: "先写下目标。", actions: ["scaffold"] },
          { agentId: "A3", label: "监督", content: "internal signal", actions: ["supervise"] },
          { agentId: "A4", label: "反思", content: "internal report", actions: ["reflect"] },
        ],
        orchestration: {
          graphId: "internal-graph",
          threadId: "internal-thread",
          topologicalOrder: ["A1", "A3", "A4"],
        },
      },
      guideMessage("user-internal-only", "user", "隐藏这一对。"),
      {
        ...guideMessage("assistant-internal-only", "assistant", "internal aggregate"),
        turns: [{
          agentId: "A3",
          label: "监督",
          content: "internal only",
          actions: ["supervise"],
        }],
      },
      guideMessage("legacy-user", "user", "旧会话问题"),
      guideMessage("legacy-assistant", "assistant", "旧会话可见答复"),
      guideMessage("orphan-assistant", "assistant", "orphan"),
    ];
    session.tasks[0]!.supervisionSignals = [{
      id: "private-a3-signal",
      type: "goal_missing",
      createdAt: session.updatedAt,
      basis: "deterministic-rule",
      ruleVersion: "aais-metacognitive-signal-v1",
      cooldownSeconds: 300,
      evidence: { source: "artifact", patternVersion: "aais-metacognitive-signal-v1" },
      recommendedAction: "ask_goal_question",
    }];
    session.events.push(
      createAaisEvent({
        studentId: session.studentId,
        sessionId: session.sessionId,
        phase: "training",
        task: "training_task_1",
        agent: "A3",
        event: "monitoring_pause_detected",
        detail: { raw_internal_signal: "never expose" },
      }),
      createAaisEvent({
        studentId: session.studentId,
        sessionId: session.sessionId,
        phase: "training",
        task: "training_task_1",
        agent: "platform",
        event: "stage_selected",
        detail: {
          stageId: "modeling",
          milestoneId: "modeling",
          lifecycle: "stage_opened",
          origin: "learner_navigation",
          mutation_key: "private-key",
          mutation_payload_hash: "private-hash",
        },
      }),
    );

    const dto = createAaisLearnerSessionApiDto(session);
    expect(dto.guideMessages.map((message) => message.id)).toEqual([
      "user-visible",
      "assistant-visible",
      "legacy-user",
      "legacy-assistant",
    ]);
    expect(dto.guideMessages[1]).toMatchObject({
      text: "先写下目标。",
      turns: [{ agentId: "A1", content: "先写下目标。" }],
    });
    expect(dto.guideMessages[1]).not.toHaveProperty("orchestration");
    expect(JSON.stringify(dto.guideMessages)).not.toMatch(/A3|A4|internal/);
    expect(dto.tasks[0]).not.toHaveProperty("supervisionSignals");
    expect(dto.tasks[0]).not.toHaveProperty("pilotOutcomeAudit");
    const stageEvent = dto.events.find((event) => event.event === "stage_selected");
    expect(stageEvent?.detail).toEqual({
      stageId: "modeling",
      milestoneId: "modeling",
      lifecycle: "stage_opened",
      origin: "learner_navigation",
    });
    expect(dto.events.some((event) => event.agent === "A3" || event.agent === "A4")).toBe(false);
    expect(JSON.stringify(dto.events)).not.toContain("private-key");
  });

  it("does not infer planning or articulation outcomes from arbitrary saved text", async () => {
    const store = createAaisLearningStore({ rootDir: await createTempRoot() });
    await store.getOrCreateSession("explicit-evidence-only");
    await store.saveArtifact(
      "explicit-evidence-only",
      "training_task_1",
      "任意非空成果不能自动成为规划证据。",
    );
    await store.saveSelfReport(
      "explicit-evidence-only",
      "training_task_1",
      "任意非空自述也不能自动成为表达完成证据。",
    );
    const beforeEvidence = await store.readSession("explicit-evidence-only");
    expect(beforeEvidence?.events.some((event) => event.event === "planning_submitted")).toBe(false);
    expect(beforeEvidence?.events.some((event) => event.event === "articulation_submitted")).toBe(false);

    await store.recordStageEvidence(
      "explicit-evidence-only",
      "training_task_1",
      "launch_import",
      "orientation_acknowledged",
      1,
      { mutationId: "explicit-orientation-evidence" },
    );
    const explicit = await store.recordStageEvidence(
      "explicit-evidence-only",
      "training_task_1",
      "modeling",
      "expert_model_reviewed",
      1,
      { mutationId: "explicit-model-evidence" },
    );
    expect(explicit.events.some((event) =>
      event.event === "milestone_evidence_recorded"
      && event.detail.lifecycle === "completion_evidence_recorded"
    )).toBe(true);
    expect(explicit.events.some((event) => event.event === "expert_model_viewed")).toBe(true);
  });

  it("replays scaffold and navigation mutations without consuming or appending twice", async () => {
    const store = createAaisLearningStore({ rootDir: await createTempRoot() });
    await openFirstPracticeTask(store, "stable-replay");

    const selected = await store.selectTask(
      "stable-replay",
      "practice_task_1",
      1,
      { mutationId: "select-practice-once" },
    );
    const selectedReplay = await store.selectTask(
      "stable-replay",
      "practice_task_1",
      1,
      { mutationId: "select-practice-once" },
    );
    expect(selectedReplay.events).toHaveLength(selected.events.length);
    expect(selectedReplay.events.filter((event) =>
      event.detail.mutation_action === "select-task"
    )).toHaveLength(1);

    const first = await store.requestScaffold(
      "stable-replay",
      "practice_task_1",
      "stage-checklist",
      1,
      { mutationId: "scaffold-response-lost" },
    );
    const replay = await store.requestScaffold(
      "stable-replay",
      "practice_task_1",
      "stage-checklist",
      1,
      { mutationId: "scaffold-response-lost" },
    );
    expect(replay.requestCount).toBe(first.requestCount);
    expect(replay.session.tasks.find((task) => task.taskId === "practice_task_1"))
      .toMatchObject({ scaffoldRequests: 1 });
    expect(replay.session.events.filter((event) => event.event === "scaffold_request"))
      .toHaveLength(1);
    await expect(store.requestScaffold(
      "stable-replay",
      "practice_task_1",
      "sentence-starters",
      1,
      { mutationId: "scaffold-response-lost" },
    )).rejects.toMatchObject({ reason: "mutation_replay_conflict" });

    const stage = await store.selectStage(
      "stable-replay",
      "coaching_scaffolding",
      1,
      { mutationId: "stage-payload-fence" },
    );
    const stageReplay = await store.selectStage(
      "stable-replay",
      "coaching_scaffolding",
      1,
      { mutationId: "stage-payload-fence" },
    );
    expect(stageReplay.events).toHaveLength(stage.events.length);
    await expect(store.selectStage(
      "stable-replay",
      "articulation",
      1,
      { mutationId: "stage-payload-fence" },
    )).rejects.toMatchObject({ reason: "mutation_replay_conflict" });
  });

  it("claims, releases, expires, and completes guide mutations without duplicating raw replies", async () => {
    const store = createAaisLearningStore({ rootDir: await createTempRoot() });
    const studentId = "guide-mutation-store";
    await store.getOrCreateSession(studentId);
    const payloadHash = "a".repeat(64);
    const first = await store.claimGuideMutation({
      studentId,
      mutationId: "guide-store-once",
      payloadHash,
      dataGeneration: 1,
    });
    expect(first.status).toBe("claimed");
    await expect(store.claimGuideMutation({
      studentId,
      mutationId: "guide-store-once",
      payloadHash,
      dataGeneration: 1,
    })).rejects.toMatchObject({ name: "AaisGuideMutationInProgressError" });
    if (first.status !== "claimed") throw new Error("Expected a claimed guide mutation.");
    await store.releaseGuideMutation({
      studentId,
      receipt: first.receipt,
      dataGeneration: 1,
    });
    const retried = await store.claimGuideMutation({
      studentId,
      mutationId: "guide-store-once",
      payloadHash,
      dataGeneration: 1,
    });
    expect(retried.status).toBe("claimed");
    if (retried.status !== "claimed") throw new Error("Expected a retried guide mutation.");
    const appended = await store.appendGuideExchange({
      studentId,
      phase: "training",
      taskId: "training_task_1",
      question: "冻结的问题",
      answer: "冻结的回答",
      turns: [{
        agentId: "A1",
        label: "小张",
        content: "冻结的回答",
        actions: ["respond"],
      }],
      orchestration: {
        graphId: "learning-ai-guide",
        topologicalOrder: ["A1"],
        threadId: "frozen-thread",
      },
      guideMutation: {
        receipt: retried.receipt,
        runtime: {
          engine: "test-runtime",
          status: "completed",
          visibleMs: 12,
          attempts: 1,
          fallback: false,
          timeoutReason: null,
          agentStatuses: [{ agentId: "A1", status: "completed" }],
        },
        budget: {
          limit: 1000,
          used: 1,
          remaining: 999,
          resetsAt: "2026-08-26T00:00:00.000Z",
        },
      },
      dataGeneration: 1,
    });
    const completed = await store.claimGuideMutation({
      studentId,
      mutationId: "guide-store-once",
      payloadHash,
      dataGeneration: 1,
    });
    expect(completed).toMatchObject({
      status: "completed",
      replay: {
        exchange: appended.exchange,
        messageText: "冻结的回答",
        turns: [{ agentId: "A1", content: "冻结的回答" }],
      },
    });
    expect(completed.session.guideMessages).toHaveLength(2);
    expect(completed.session.guideMutationReservations).toEqual([]);
    expect(JSON.stringify(completed.session.events)).not.toContain(retried.receipt.mutationKey);
    await expect(store.claimGuideMutation({
      studentId,
      mutationId: "guide-store-once",
      payloadHash: "b".repeat(64),
      dataGeneration: 1,
    })).rejects.toMatchObject({ reason: "mutation_replay_conflict" });
    const dto = createAaisLearnerSessionApiDto(completed.session);
    expect(dto).not.toHaveProperty("guideMutationReservations");
    expect(JSON.stringify(dto)).not.toContain("guideMutation");

    const startedAt = new Date();
    await store.claimGuideMutation({
      studentId,
      mutationId: "guide-expired-claim",
      payloadHash: "c".repeat(64),
      dataGeneration: 1,
      now: startedAt,
    });
    const reclaimed = await store.claimGuideMutation({
      studentId,
      mutationId: "guide-expired-claim",
      payloadHash: "c".repeat(64),
      dataGeneration: 1,
      now: new Date(startedAt.getTime() + 11 * 60 * 1000),
    });
    expect(reclaimed.status).toBe("claimed");
  });
});

function guideMessage(
  id: string,
  kind: AaisGuideMessageRecord["kind"],
  text: string,
): AaisGuideMessageRecord {
  return { id, kind, text, time: "2026-08-25T00:00:00.000Z" };
}

async function createTempRoot() {
  const root = await mkdtemp(path.join(tmpdir(), "aais-hardening-"));
  tempRoots.push(root);
  return root;
}

async function openFirstPracticeTask(
  store: ReturnType<typeof createAaisLearningStore>,
  studentId: string,
) {
  await store.recordStageEvidence(
    studentId,
    "training_task_1",
    "launch_import",
    "orientation_acknowledged",
  );
  await store.recordStageEvidence(
    studentId,
    "training_task_1",
    "modeling",
    "expert_model_reviewed",
  );
  await store.completeTask(studentId, "training_task_1");
  await store.selectTask(studentId, "practice_task_1");
}
