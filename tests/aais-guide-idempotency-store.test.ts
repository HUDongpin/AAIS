import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createAaisLearningStore } from "@/lib/server/aais-learning-store";

const operationId = "10000000-0000-4000-8000-000000000010";
const payloadDigest = "a".repeat(64);
let tempDir: string;

beforeEach(async () => {
  tempDir = await mkdtemp(path.join(tmpdir(), "aais-guide-operation-"));
});

afterEach(async () => {
  vi.useRealTimers();
  await rm(tempDir, { force: true, recursive: true });
});

describe("AAIS guide operation idempotency", () => {
  it("claims one logical operation and rejects a payload conflict", async () => {
    const store = createAaisLearningStore({ rootDir: tempDir });
    const first = await store.reserveDailyGuideRequest({
      reservationId: operationId,
      operationId,
      payloadDigest,
      studentId: "S001",
      dataGeneration: 1,
      limit: 4,
    });
    const replay = await store.reserveDailyGuideRequest({
      reservationId: operationId,
      operationId,
      payloadDigest,
      studentId: "S001",
      dataGeneration: 1,
      limit: 4,
    });
    const conflict = await store.reserveDailyGuideRequest({
      reservationId: operationId,
      operationId,
      payloadDigest: "b".repeat(64),
      studentId: "S001",
      dataGeneration: 1,
      limit: 4,
    });

    expect(first).toMatchObject({ status: "reserved", used: 1, reservationId: operationId });
    expect(replay).toMatchObject({ status: "in_progress", used: 1, reservationId: operationId });
    expect(conflict).toMatchObject({ status: "conflict", used: 1, reservationId: operationId });
  });

  it("replays a completed exchange without another budget reservation", async () => {
    const store = createAaisLearningStore({ rootDir: tempDir });
    await store.reserveDailyGuideRequest({
      reservationId: operationId,
      operationId,
      payloadDigest,
      studentId: "S001",
      dataGeneration: 1,
      limit: 4,
    });
    await store.finalizeDailyGuideRequest({
      reservationId: operationId,
      studentId: "S001",
      dataGeneration: 1,
      outcome: "dispatched",
    });
    await store.reserveGuideExchangeCapacity({
      reservationId: operationId,
      studentId: "S001",
      dataGeneration: 1,
    });
    await store.appendGuideExchange({
      operationId,
      studentId: "S001",
      phase: "training",
      taskId: "training_task_1",
      question: "我卡在第一步。",
      answer: "先说出已知条件。",
      orchestration: {
        graphId: "learning-ai-guide",
        topologicalOrder: ["A1"],
        threadId: "thread-idempotent",
        delivery: {
          schemaVersion: 1,
          responseMode: "live",
          channel: "secondary",
          degraded: true,
        },
      },
      budgetReservationId: operationId,
      capacityReservationId: operationId,
      dataGeneration: 1,
    });

    const replay = await store.reserveDailyGuideRequest({
      reservationId: operationId,
      operationId,
      payloadDigest,
      studentId: "S001",
      dataGeneration: 1,
      limit: 4,
    });
    const session = await store.readSession("S001");

    expect(replay).toMatchObject({
      status: "completed",
      used: 1,
      resultMessageId: `assistant-${operationId}`,
    });
    expect(session?.guideMessages).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: `user-${operationId}`, kind: "user" }),
      expect.objectContaining({
        id: `assistant-${operationId}`,
        kind: "assistant",
        orchestration: expect.objectContaining({
          delivery: {
            schemaVersion: 1,
            responseMode: "live",
            channel: "secondary",
            degraded: true,
          },
        }),
      }),
    ]));
  });

  it("does not redispatch an operation whose dispatch lease is uncertain", async () => {
    const store = createAaisLearningStore({ rootDir: tempDir });
    const startedAt = new Date("2026-08-21T00:00:00.000Z");
    vi.useFakeTimers();
    vi.setSystemTime(startedAt);
    await store.reserveDailyGuideRequest({
      reservationId: operationId,
      operationId,
      payloadDigest,
      studentId: "S001",
      dataGeneration: 1,
      limit: 4,
      now: startedAt,
    });
    await store.finalizeDailyGuideRequest({
      reservationId: operationId,
      studentId: "S001",
      dataGeneration: 1,
      outcome: "dispatched",
      now: startedAt,
    });

    const replay = await store.reserveDailyGuideRequest({
      reservationId: operationId,
      operationId,
      payloadDigest,
      studentId: "S001",
      dataGeneration: 1,
      limit: 4,
      now: new Date(startedAt.getTime() + 61_000),
    });

    expect(replay).toMatchObject({
      status: "dispatched_uncertain",
      used: 1,
      reservationId: operationId,
    });
  });

  it("atomically refunds a dispatched operation when the provider attempt provably never started", async () => {
    const store = createAaisLearningStore({ rootDir: tempDir });
    const nextOperationId = "30000000-0000-4000-8000-000000000030";
    await store.reserveDailyGuideRequest({
      reservationId: operationId,
      operationId,
      payloadDigest,
      studentId: "S001",
      dataGeneration: 1,
      limit: 1,
    });
    await store.finalizeDailyGuideRequest({
      reservationId: operationId,
      studentId: "S001",
      dataGeneration: 1,
      outcome: "dispatched",
    });

    await expect(store.finalizeDailyGuideRequest({
      reservationId: operationId,
      studentId: "S001",
      dataGeneration: 1,
      outcome: "released-before-provider-attempt",
    })).resolves.toEqual({ status: "released" });
    await expect(store.reserveDailyGuideRequest({
      reservationId: operationId,
      operationId,
      payloadDigest,
      studentId: "S001",
      dataGeneration: 1,
      limit: 1,
    })).resolves.toMatchObject({ status: "failed", used: 0, remaining: 1 });
    await expect(store.reserveDailyGuideRequest({
      reservationId: nextOperationId,
      operationId: nextOperationId,
      payloadDigest: "c".repeat(64),
      studentId: "S001",
      dataGeneration: 1,
      limit: 1,
    })).resolves.toMatchObject({ status: "reserved", used: 1, remaining: 0 });

    await expect(store.finalizeDailyGuideRequest({
      reservationId: operationId,
      studentId: "S001",
      dataGeneration: 1,
      outcome: "released-before-provider-attempt",
    })).resolves.toEqual({ status: "unchanged" });
  });

  it("releases pre-dispatch budget and capacity after an operation claim lease expires", async () => {
    const store = createAaisLearningStore({ rootDir: tempDir });
    const startedAt = new Date("2026-08-21T00:00:00.000Z");
    vi.useFakeTimers();
    vi.setSystemTime(startedAt);
    const afterOperationLease = new Date(startedAt.getTime() + 61_000);
    const nextOperationId = "20000000-0000-4000-8000-000000000020";
    await store.getOrCreateSession("S001", 1);
    await store.reserveDailyGuideRequest({
      reservationId: operationId,
      operationId,
      payloadDigest,
      studentId: "S001",
      dataGeneration: 1,
      limit: 1,
      now: startedAt,
    });
    await store.reserveGuideExchangeCapacity({
      reservationId: operationId,
      studentId: "S001",
      dataGeneration: 1,
      now: startedAt,
    });

    const recovered = await store.reserveDailyGuideRequest({
      reservationId: operationId,
      operationId,
      payloadDigest,
      studentId: "S001",
      dataGeneration: 1,
      limit: 1,
      now: afterOperationLease,
    });
    expect(recovered).toMatchObject({
      status: "failed",
      used: 0,
      remaining: 1,
    });

    await expect(store.releaseGuideExchangeCapacity({
      reservationId: operationId,
      studentId: "S001",
      dataGeneration: 1,
    })).resolves.toEqual({ status: "released" });
    expect((await store.readSession("S001"))?.guideCapacityReservations).toEqual([]);

    await expect(store.reserveDailyGuideRequest({
      reservationId: nextOperationId,
      operationId: nextOperationId,
      payloadDigest: "b".repeat(64),
      studentId: "S001",
      dataGeneration: 1,
      limit: 1,
      now: afterOperationLease,
    })).resolves.toMatchObject({
      status: "reserved",
      used: 1,
      remaining: 0,
    });
  });

  it("does not persist a file-backed guide exchange after its absolute mutation deadline", async () => {
    const store = createAaisLearningStore({ rootDir: tempDir });
    await store.getOrCreateSession("S001", 1);
    await store.reserveDailyGuideRequest({
      reservationId: operationId,
      operationId,
      payloadDigest,
      studentId: "S001",
      dataGeneration: 1,
      limit: 4,
    });
    await store.finalizeDailyGuideRequest({
      reservationId: operationId,
      studentId: "S001",
      dataGeneration: 1,
      outcome: "dispatched",
    });
    await store.reserveGuideExchangeCapacity({
      reservationId: operationId,
      studentId: "S001",
      dataGeneration: 1,
    });

    await expect(store.appendGuideExchange({
      operationId,
      studentId: "S001",
      phase: "training",
      taskId: "training_task_1",
      question: "这条问题已经越过持久化截止时间。",
      answer: "这条回答不得写入。",
      orchestration: {
        graphId: "learning-ai-guide",
        topologicalOrder: ["A1"],
        threadId: "deadline-expired",
      },
      budgetReservationId: operationId,
      capacityReservationId: operationId,
      dataGeneration: 1,
      deadlineAt: Date.now() - 1,
    })).rejects.toThrow("persistence deadline elapsed");

    expect((await store.readSession("S001"))?.guideMessages).toEqual([]);
  });

  it("rejects a late dispatch with an explicit route deadline but preserves legacy wall-clock defaults", async () => {
    const store = createAaisLearningStore({ rootDir: tempDir });
    const historicalNow = new Date("2026-08-20T12:00:00.000Z");
    await store.reserveDailyGuideRequest({
      reservationId: operationId,
      operationId,
      payloadDigest,
      studentId: "S001",
      dataGeneration: 1,
      limit: 4,
      now: historicalNow,
    });

    await expect(store.finalizeDailyGuideRequest({
      reservationId: operationId,
      studentId: "S001",
      dataGeneration: 1,
      outcome: "dispatched",
      now: historicalNow,
      operationDeadlineAt: new Date(Date.now() - 1),
    })).resolves.toEqual({ status: "unchanged" });

    await expect(store.finalizeDailyGuideRequest({
      reservationId: operationId,
      studentId: "S001",
      dataGeneration: 1,
      outcome: "dispatched",
      now: historicalNow,
    })).resolves.toEqual({ status: "dispatched" });
  });
});
