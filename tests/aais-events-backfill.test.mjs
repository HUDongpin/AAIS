import { describe, expect, it } from "vitest";
import { backfillAaisPostgresSessionMirrors } from "../scripts/backfill-aais-events.mjs";

describe("AAIS event/task-state backfill", () => {
  it("backfills learner session mirrors and is safe to rerun", async () => {
    const database = new FakeBackfillDatabase([createSessionRow()]);

    const first = await backfillAaisPostgresSessionMirrors({
      database,
      batchSize: 1,
    });
    const second = await backfillAaisPostgresSessionMirrors({
      database,
      batchSize: 1,
    });

    expect(first).toMatchObject({
      status: "pass",
      dryRun: false,
      batches: 1,
      sessionsScanned: 1,
      sessionsSkipped: 0,
      eventsSeen: 2,
      eventsSkipped: 0,
      eventsInserted: 2,
      taskRowsSeen: 2,
      taskRowsSkipped: 0,
      taskRowsUpserted: 2,
      secrets: "redacted",
    });
    expect(second).toMatchObject({
      status: "pass",
      sessionsScanned: 1,
      eventsInserted: 0,
      taskRowsUpserted: 0,
    });
    expect(database.events.size).toBe(2);
    expect(database.taskRows.size).toBe(2);
  });

  it("supports dry-run scans without mutating mirrored tables", async () => {
    const database = new FakeBackfillDatabase([createSessionRow()]);

    const report = await backfillAaisPostgresSessionMirrors({
      database,
      dryRun: true,
    });

    expect(report).toMatchObject({
      status: "pass",
      dryRun: true,
      sessionsScanned: 1,
      eventsSeen: 2,
      eventsInserted: 0,
      taskRowsSeen: 2,
      taskRowsUpserted: 0,
    });
    expect(database.events.size).toBe(0);
    expect(database.taskRows.size).toBe(0);
    expect(database.writeQueries).toEqual([]);
  });

  it("keeps reports free of learner ids and raw learner text", async () => {
    const database = new FakeBackfillDatabase([createSessionRow({
      studentId: "student-private-001",
      artifactText: "private artifact text",
      selfReport: "private self report",
      eventDetail: { note: "private event note" },
    })]);

    const report = await backfillAaisPostgresSessionMirrors({ database });
    const serializedReport = JSON.stringify(report);

    expect(serializedReport).not.toContain("student-private-001");
    expect(serializedReport).not.toContain("private artifact text");
    expect(serializedReport).not.toContain("private self report");
    expect(serializedReport).not.toContain("private event note");
    expect(serializedReport).toContain("redacted");
  });

  it("skips malformed session rows without exposing row content", async () => {
    const database = new FakeBackfillDatabase([
      {
        student_id: "student-invalid",
        payload: "{not-json",
        updated_at: new Date("2026-07-08T00:00:00.000Z"),
      },
      createSessionRow(),
    ]);

    const report = await backfillAaisPostgresSessionMirrors({
      database,
      batchSize: 2,
    });

    expect(report).toMatchObject({
      status: "partial",
      sessionsScanned: 2,
      sessionsSkipped: 1,
      eventsInserted: 2,
      taskRowsUpserted: 2,
      secrets: "redacted",
    });
    expect(JSON.stringify(report)).not.toContain("student-invalid");
  });
});

function createSessionRow(input = {}) {
  const studentId = input.studentId ?? "student-001";
  const sessionId = input.sessionId ?? "session-001";
  const artifactText = input.artifactText ?? "draft";
  const selfReport = input.selfReport ?? "reflection";
  const updatedAt = "2026-07-08T01:02:03.000Z";
  return {
    student_id: studentId,
    updated_at: new Date(updatedAt),
    payload: {
      schemaVersion: 1,
      studentId,
      sessionId,
      createdAt: "2026-07-08T00:00:00.000Z",
      updatedAt,
      activeTaskId: "practice-1",
      activeStage: "practice",
      tasks: [
        {
          taskId: "training-1",
          phase: "training",
          status: "completed",
          artifactText,
          selfReport,
          scaffoldRequests: 1,
          scaffoldHistory: [],
        },
        {
          taskId: "practice-1",
          phase: "practice",
          status: "active",
          artifactText: "",
          selfReport: "",
          scaffoldRequests: 0,
          scaffoldHistory: [],
        },
      ],
      guideMessages: [],
      events: [
        {
          student_id: studentId,
          session_id: sessionId,
          phase: "training",
          task: "training-1",
          agent: "A3",
          event: "artifact_saved",
          time: "2026-07-08T00:01:00.000Z",
          detail: input.eventDetail ?? { artifact_characters: artifactText.length },
        },
        {
          student_id: studentId,
          session_id: sessionId,
          phase: "practice",
          task: "practice-1",
          agent: "A1",
          event: "ai_response_completed",
          time: "2026-07-08T00:02:00.000Z",
          detail: { response_mode: "offline" },
        },
      ],
    },
  };
}

class FakeBackfillDatabase {
  constructor(rows) {
    this.rows = rows;
    this.events = new Map();
    this.eventNaturalKeys = new Set();
    this.taskRows = new Map();
    this.writeQueries = [];
  }

  async query(sql, params = []) {
    const normalized = sql.trim().toLowerCase();
    if (normalized.startsWith("select student_id, payload, updated_at")) {
      const limit = Number(params[0]);
      const offset = Number(params[1]);
      return {
        rows: this.rows.slice(offset, offset + limit),
      };
    }
    if (normalized.startsWith("insert into aais_events")) {
      this.writeQueries.push({ sql, params });
      const naturalKey = JSON.stringify(params.slice(1));
      const id = String(params[0]);
      if (this.events.has(id) || this.eventNaturalKeys.has(naturalKey)) {
        return { rows: [] };
      }
      this.events.set(id, params);
      this.eventNaturalKeys.add(naturalKey);
      return { rows: [{ id }] };
    }
    if (normalized.startsWith("insert into aais_learner_task_state")) {
      this.writeQueries.push({ sql, params });
      const key = `${params[0]}:${params[2]}`;
      const nextValue = JSON.stringify(params);
      if (this.taskRows.get(key) === nextValue) {
        return { rows: [] };
      }
      this.taskRows.set(key, nextValue);
      return { rows: [{ task: params[2] }] };
    }
    return { rows: [] };
  }
}
