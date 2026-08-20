import { access, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import {
  createAaisLearningStore,
  summarizeAaisCohortAnalytics,
  type AaisDatabaseClient,
  type AaisLearnerSession,
} from "@/lib/server/aais-learning-store";
import { buildAaisLearnerRecommendations } from "@/lib/server/aais-recommendations";

const temporaryRoots: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map((root) =>
    rm(root, { recursive: true, force: true })
  ));
});

describe("AAIS enrollment-scoped cohort access", () => {
  it("intersects educator grants with unambiguous active learner enrollments", async () => {
    const sessions = await createSeedSessions(["S001", "S002", "S003", "S004"]);
    const database = createScopedDatabase({
      sessions,
      enrollments: [
        enrollment("teacher-a", "course-a", "alpha", "teacher"),
        enrollment("S001", "course-a", "alpha", "student"),
        enrollment("S002", "course-a", "beta", "student"),
        enrollment("S003", "course-b", "alpha", "student"),
        enrollment("S004", "course-a", "alpha", "student"),
        enrollment("S004", "course-b", "alpha", "student"),
      ],
    });
    const store = createAaisLearningStore({ database });

    const analytics = await store.getEducatorCohortAnalytics({
      actorId: "teacher-a",
      actorRole: "teacher",
    });

    expect(analytics.dashboard.cohort.learnerCount).toBe(1);
    expect(analytics.learners).toHaveLength(1);
    expect(analytics.learners[0]?.learnerKey).toBe(
      summarizeAaisCohortAnalytics([sessions.get("S001")!]).learners[0]?.learnerKey,
    );
    const scopedQuery = database.queries.find((query) =>
      /with unambiguous_active_learner_scope as materialized/i.test(query.sql)
      && /matching_sessions as/i.test(query.sql)
    );
    expect(scopedQuery?.sql).toMatch(/having count\(\*\) = 1/i);
    expect(scopedQuery?.sql).toMatch(/inner join educator_scope/i);
    expect(scopedQuery?.params.slice(0, 2)).toEqual(["teacher-a", "teacher"]);
  });

  it("lets client course and cohort filters narrow but never widen educator scope", async () => {
    const sessions = await createSeedSessions(["S001", "S002"]);
    const database = createScopedDatabase({
      sessions,
      enrollments: [
        enrollment("teacher-a", "course-a", "alpha", "teacher"),
        enrollment("S001", "course-a", "alpha", "student"),
        enrollment("S002", "course-a", "beta", "student"),
      ],
    });
    const store = createAaisLearningStore({ database });

    const widened = await store.getEducatorCohortAnalytics({
      actorId: "teacher-a",
      actorRole: "teacher",
    }, {
      courseId: "course-a",
      cohort: "beta",
    });

    expect(widened.dashboard.cohort.learnerCount).toBe(0);
    const scopedQuery = database.queries.find((query) => /matching_sessions as/i.test(query.sql));
    expect(scopedQuery?.params.slice(6, 9)).toEqual(["beta", null, "course-a"]);
  });

  it("denies a role-bearing actor without an active matching enrollment", async () => {
    const sessions = await createSeedSessions(["S001"]);
    const database = createScopedDatabase({
      sessions,
      enrollments: [enrollment("S001", "course-a", "alpha", "student")],
    });
    const store = createAaisLearningStore({ database });

    await expect(store.getEducatorCohortAnalytics({
      actorId: "teacher-without-grant",
      actorRole: "teacher",
    })).rejects.toMatchObject({
      name: "AaisEducatorScopeAuthorizationError",
    });
    expect(database.queries.some((query) => /matching_sessions as/i.test(query.sql))).toBe(false);
  });

  it("fails closed for cohort reads, exports, and overrides in file mode", async () => {
    const root = await createTemporaryRoot();
    const store = createAaisLearningStore({ rootDir: root });
    const accessScope = { actorId: "teacher-a", actorRole: "teacher" as const };

    await expect(store.getEducatorCohortAnalytics(accessScope)).rejects.toMatchObject({
      name: "AaisLearningStorageConfigurationError",
    });
    await expect(store.exportEducatorCohortAnalytics("json", accessScope)).rejects.toMatchObject({
      name: "AaisLearningStorageConfigurationError",
    });
    await expect(store.recordRecommendationOverride({
      ...accessScope,
      learnerKey: "learner-000000000000",
      sessionKey: "session-000000000000",
      recommendationId: "recommendation-000000000000",
      ruleId: "rule-a",
      targetTaskId: null,
      decision: "dismissed",
    })).rejects.toMatchObject({
      name: "AaisLearningStorageConfigurationError",
    });
  });

  it("rejects an explicit nonexistent recommendation target without writing", async () => {
    const sessions = await createSeedSessions(["S001"]);
    const session = sessions.get("S001")!;
    const database = createScopedDatabase({
      sessions,
      enrollments: [
        enrollment("teacher-a", "course-a", "alpha", "teacher"),
        enrollment("S001", "course-a", "alpha", "student"),
      ],
    });
    const store = createAaisLearningStore({ database });
    const keys = summarizeAaisCohortAnalytics([session]).learners[0]!;

    await expect(store.recordRecommendationOverride({
      actorId: "teacher-a",
      actorRole: "teacher",
      learnerKey: keys.learnerKey,
      sessionKey: keys.sessionKey,
      recommendationId: "recommendation-000000000000",
      ruleId: "rule-a",
      targetTaskId: "nonexistent_task",
      decision: "dismissed",
    })).rejects.toMatchObject({
      name: "AaisRecommendationOverrideTargetError",
    });
    expect(database.queries.some((query) => /session_insert as/i.test(query.sql))).toBe(false);
  });

  it("guards a valid recommendation override with the same enrollment snapshot", async () => {
    const sessions = await createSeedSessions(["S001", "S002"]);
    const session = sessions.get("S001")!;
    const database = createScopedDatabase({
      sessions,
      enrollments: [
        enrollment("teacher-a", "course-a", "alpha", "teacher"),
        enrollment("S001", "course-a", "alpha", "student"),
        enrollment("S002", "course-a", "alpha", "student"),
      ],
    });
    const store = createAaisLearningStore({ database });
    const keys = summarizeAaisCohortAnalytics([session]).learners[0]!;
    const recommendation = buildAaisLearnerRecommendations(
      summarizeAaisCohortAnalytics([session]),
    ).recommendations[0]!;

    const firstOverride = await store.recordRecommendationOverride({
      actorId: "teacher-a",
      actorRole: "teacher",
      learnerKey: keys.learnerKey,
      sessionKey: keys.sessionKey,
      recommendationId: recommendation.id,
      ruleId: recommendation.ruleId,
      targetTaskId: recommendation.targetTaskId,
      decision: "accepted",
    });
    expect(firstOverride).toMatchObject({
      event: {
        task: recommendation.targetTaskId,
        event: "recommendation_override_recorded",
      },
    });
    const identityLookup = database.queries.find((query) =>
      /select\s+session\.student_id,[\s\S]*as session_id/i.test(query.sql)
    );
    expect(identityLookup?.sql).not.toMatch(/select\s+session\.payload\b/i);
    const exactPayloadLookups = database.queries.filter((query) =>
      /select\s+session\.payload,[\s\S]*where session\.student_id = \$1/i.test(query.sql)
    );
    expect(exactPayloadLookups).toHaveLength(1);
    expect(exactPayloadLookups[0]?.params).toEqual(["S001", "teacher-a", "teacher"]);
    const write = database.queries.find((query) => /session_insert as/i.test(query.sql));
    expect(write?.sql).toMatch(/for share of learner, educator/i);
    expect(write?.sql).toMatch(/select count\(\*\)[\s\S]*learner_scope/i);
    expect(write?.params.slice(10, 12)).toEqual(["teacher-a", "teacher"]);

    const writesAfterFirst = database.queries.filter((query) => /session_insert as/i.test(query.sql)).length;
    const replay = await store.recordRecommendationOverride({
      actorId: "teacher-a",
      actorRole: "teacher",
      learnerKey: keys.learnerKey,
      sessionKey: keys.sessionKey,
      recommendationId: recommendation.id,
      ruleId: recommendation.ruleId,
      targetTaskId: recommendation.targetTaskId,
      decision: "accepted",
    });
    expect(replay.event).toEqual(firstOverride.event);
    expect(database.queries.filter((query) => /session_insert as/i.test(query.sql)))
      .toHaveLength(writesAfterFirst);

    const refreshedAnalytics = await store.getEducatorCohortAnalytics({
      actorId: "teacher-a",
      actorRole: "teacher",
    });
    expect(buildAaisLearnerRecommendations(refreshedAnalytics).recommendations)
      .not.toContainEqual(expect.objectContaining({ id: recommendation.id }));
  });

  it("accepts a strictly valid legacy card and records a canonical v2 override", async () => {
    const sessions = await createSeedSessions(["S001"]);
    const session = sessions.get("S001")!;
    const currentAnalytics = summarizeAaisCohortAnalytics([session]);
    const currentRecommendation = buildAaisLearnerRecommendations(
      currentAnalytics,
      { includeResolved: true },
    ).recommendations[0]!;
    const legacyAnalytics = createLegacyAnalytics(session);
    const legacyRecommendation = buildAaisLearnerRecommendations(
      legacyAnalytics,
      { includeResolved: true },
    ).recommendations.find((candidate) =>
      candidate.ruleId === currentRecommendation.ruleId
      && candidate.targetTaskId === currentRecommendation.targetTaskId
    )!;
    const database = createScopedDatabase({
      sessions,
      enrollments: [
        enrollment("teacher-a", "course-a", "alpha", "teacher"),
        enrollment("S001", "course-a", "alpha", "student"),
      ],
    });
    const store = createAaisLearningStore({ database });

    const result = await store.recordRecommendationOverride({
      actorId: "teacher-a",
      actorRole: "teacher",
      learnerKey: legacyRecommendation.learnerKey,
      sessionKey: legacyRecommendation.sessionKey,
      recommendationId: legacyRecommendation.id,
      ruleId: legacyRecommendation.ruleId,
      targetTaskId: legacyRecommendation.targetTaskId,
      decision: "accepted",
    });

    expect(result.event.detail).toMatchObject({
      recommendation_id: currentRecommendation.id,
      learner_key: currentRecommendation.learnerKey,
      session_key: currentRecommendation.sessionKey,
      source_key_version: "legacy",
    });
    expect(result.event.detail).not.toMatchObject({
      learner_key: legacyRecommendation.learnerKey,
      session_key: legacyRecommendation.sessionKey,
    });
    const writesAfterFirst = database.queries.filter((query) => /session_insert as/i.test(query.sql)).length;

    const replay = await store.recordRecommendationOverride({
      actorId: "teacher-a",
      actorRole: "teacher",
      learnerKey: legacyRecommendation.learnerKey,
      sessionKey: legacyRecommendation.sessionKey,
      recommendationId: legacyRecommendation.id,
      ruleId: legacyRecommendation.ruleId,
      targetTaskId: legacyRecommendation.targetTaskId,
      decision: "accepted",
    });
    expect(replay.event).toEqual(result.event);
    expect(database.queries.filter((query) => /session_insert as/i.test(query.sql)))
      .toHaveLength(writesAfterFirst);

    const refreshed = await store.getEducatorCohortAnalytics({
      actorId: "teacher-a",
      actorRole: "teacher",
    });
    expect(buildAaisLearnerRecommendations(refreshed).recommendations)
      .not.toContainEqual(expect.objectContaining({ id: currentRecommendation.id }));
  });

  it.each([
    {
      label: "newer current deferred reopens an older legacy accepted card",
      firstVersion: "legacy" as const,
      firstDecision: "accepted" as const,
      secondVersion: "v2" as const,
      secondDecision: "deferred" as const,
      visible: true,
    },
    {
      label: "newer current accepted closes an older legacy deferred card",
      firstVersion: "legacy" as const,
      firstDecision: "deferred" as const,
      secondVersion: "v2" as const,
      secondDecision: "accepted" as const,
      visible: false,
    },
  ])("uses cross-version chronology when $label", async (scenario) => {
    const sessions = await createSeedSessions(["S001"]);
    const session = sessions.get("S001")!;
    const currentAnalytics = summarizeAaisCohortAnalytics([session]);
    const legacyAnalytics = createLegacyAnalytics(session);
    const currentRecommendation = buildAaisLearnerRecommendations(
      currentAnalytics,
      { includeResolved: true },
    ).recommendations[0]!;
    const legacyRecommendation = buildAaisLearnerRecommendations(
      legacyAnalytics,
      { includeResolved: true },
    ).recommendations.find((candidate) =>
      candidate.ruleId === currentRecommendation.ruleId
      && candidate.targetTaskId === currentRecommendation.targetTaskId
    )!;
    const variants = {
      legacy: legacyRecommendation,
      v2: currentRecommendation,
    };
    appendRecommendationOverrideEvent(
      session,
      variants[scenario.firstVersion],
      scenario.firstDecision,
      "2026-08-20T01:00:00.000Z",
    );
    appendRecommendationOverrideEvent(
      session,
      variants[scenario.secondVersion],
      scenario.secondDecision,
      "2026-08-20T01:00:01.000Z",
    );

    const recommendations = buildAaisLearnerRecommendations(
      summarizeAaisCohortAnalytics([session]),
    ).recommendations;
    expect(recommendations.some((candidate) => candidate.id === currentRecommendation.id))
      .toBe(scenario.visible);

    const database = createScopedDatabase({
      sessions,
      enrollments: [
        enrollment("teacher-a", "course-a", "alpha", "teacher"),
        enrollment("S001", "course-a", "alpha", "student"),
      ],
    });
    const sqlAnalytics = await createAaisLearningStore({ database })
      .getEducatorCohortAnalytics({ actorId: "teacher-a", actorRole: "teacher" });
    expect(buildAaisLearnerRecommendations(sqlAnalytics).recommendations
      .some((candidate) => candidate.id === currentRecommendation.id))
      .toBe(scenario.visible);
  });

  it.each([
    ["recommendation id", { recommendationId: "recommendation-000000000000" }],
    ["rule id", { ruleId: "advance_practice" }],
    ["target task", { targetTaskId: "practice_task_2" }],
  ])("rejects a forged or stale %s without writing evidence", async (_label, override) => {
    const sessions = await createSeedSessions(["S001"]);
    const session = sessions.get("S001")!;
    const database = createScopedDatabase({
      sessions,
      enrollments: [
        enrollment("teacher-a", "course-a", "alpha", "teacher"),
        enrollment("S001", "course-a", "alpha", "student"),
      ],
    });
    const store = createAaisLearningStore({ database });
    const analytics = summarizeAaisCohortAnalytics([session]);
    const keys = analytics.learners[0]!;
    const recommendation = buildAaisLearnerRecommendations(analytics).recommendations[0]!;

    await expect(store.recordRecommendationOverride({
      actorId: "teacher-a",
      actorRole: "teacher",
      learnerKey: keys.learnerKey,
      sessionKey: keys.sessionKey,
      recommendationId: recommendation.id,
      ruleId: recommendation.ruleId,
      targetTaskId: recommendation.targetTaskId,
      decision: "dismissed",
      ...override,
    })).rejects.toMatchObject({
      name: "AaisRecommendationOverrideTargetError",
    });
    expect(database.queries.some((query) => /session_insert as/i.test(query.sql))).toBe(false);
  });

  it("fails closed for a learner with multiple active course enrollments", async () => {
    const sessions = await createSeedSessions(["S004"]);
    const session = sessions.get("S004")!;
    const database = createScopedDatabase({
      sessions,
      enrollments: [
        enrollment("teacher-a", "course-a", "alpha", "teacher"),
        enrollment("S004", "course-a", "alpha", "student"),
        enrollment("S004", "course-b", "alpha", "student"),
      ],
    });
    const store = createAaisLearningStore({ database });
    const keys = summarizeAaisCohortAnalytics([session]).learners[0]!;

    await expect(store.recordRecommendationOverride({
      actorId: "teacher-a",
      actorRole: "teacher",
      learnerKey: keys.learnerKey,
      sessionKey: keys.sessionKey,
      recommendationId: "recommendation-000000000000",
      ruleId: "rule-a",
      targetTaskId: null,
      decision: "dismissed",
    })).rejects.toMatchObject({
      name: "AaisRecommendationOverrideTargetError",
    });
    expect(database.queries.some((query) => /session_insert as/i.test(query.sql))).toBe(false);
  });
});

describe("AAIS read-only learner analytics and export", () => {
  it("does not create learner data when a session does not exist", async () => {
    const root = await createTemporaryRoot();
    const store = createAaisLearningStore({ rootDir: root });

    await expect(store.getAnalytics("S001")).rejects.toMatchObject({
      name: "AaisLearnerSessionNotFoundError",
    });
    await expect(store.exportEvents("S001", "json")).rejects.toMatchObject({
      name: "AaisLearnerSessionNotFoundError",
    });
    await expect(access(path.join(root, "sessions", "S001.json"))).rejects.toMatchObject({ code: "ENOENT" });
    await expect(access(path.join(root, "learner-data-generations", "S001.json"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("does not recreate a session or advance its tombstone after privacy deletion", async () => {
    const root = await createTemporaryRoot();
    const store = createAaisLearningStore({ rootDir: root });
    await store.getOrCreateSession("S001", 1);
    await store.deleteLearnerData("S001", 1);
    const generationPath = path.join(root, "learner-data-generations", "S001.json");
    const before = await readFile(generationPath, "utf8");

    await expect(store.getAnalytics("S001")).rejects.toMatchObject({
      name: "AaisLearnerSessionNotFoundError",
    });
    await expect(store.exportEvents("S001", "csv")).rejects.toMatchObject({
      name: "AaisLearnerSessionNotFoundError",
    });

    expect(await readFile(generationPath, "utf8")).toBe(before);
    await expect(access(path.join(root, "sessions", "S001.json"))).rejects.toMatchObject({ code: "ENOENT" });
  });
});

type Enrollment = {
  userId: string;
  courseId: string;
  cohort: string;
  role: "student" | "teacher" | "admin";
  status: "active" | "withdrawn";
};

function enrollment(
  userId: string,
  courseId: string,
  cohort: string,
  role: Enrollment["role"],
  status: Enrollment["status"] = "active",
): Enrollment {
  return { userId, courseId, cohort, role, status };
}

async function createTemporaryRoot() {
  const root = await mkdtemp(path.join(tmpdir(), "aais-cohort-access-"));
  temporaryRoots.push(root);
  return root;
}

async function createSeedSessions(studentIds: string[]) {
  const root = await createTemporaryRoot();
  const store = createAaisLearningStore({ rootDir: root });
  const sessions = new Map<string, AaisLearnerSession>();
  for (const studentId of studentIds) {
    sessions.set(studentId, await store.getOrCreateSession(studentId, 1));
  }
  return sessions;
}

function createScopedDatabase(input: {
  sessions: Map<string, AaisLearnerSession>;
  enrollments: Enrollment[];
}) {
  const sessions = new Map(Array.from(input.sessions, ([studentId, session]) => [
    studentId,
    { payload: structuredClone(session), version: 0 },
  ]));
  const queries: Array<{ sql: string; params: unknown[] }> = [];
  const database: AaisDatabaseClient & { queries: typeof queries } = {
    queries,
    async query(sql: string, params: unknown[] = []) {
      queries.push({ sql, params });
      const normalized = sql.trim();
      if (/^select exists \([\s\S]*from aais_enrollments educator/i.test(normalized)) {
        return { rows: [{ authorized: hasActiveEducatorScope(input.enrollments, String(params[0]), String(params[1])) }] };
      }
      if (/^select exists \([\s\S]*learner_scope/i.test(normalized)) {
        return {
          rows: [{
            authorized: canAccessStudent(
              input.enrollments,
              String(params[1]),
              String(params[2]),
              String(params[0]),
            ),
          }],
        };
      }
      if (/^with unambiguous_active_learner_scope as materialized/i.test(normalized)
        && /matching_sessions as/i.test(normalized)) {
        const [actorId, actorRole, phase, task, agent, eventName, cohort, role, courseId] = params;
        const accessible = getAccessibleStudentIds(
          input.enrollments,
          String(actorId),
          String(actorRole),
          { cohort, role, courseId },
        );
        return {
          rows: Array.from(accessible)
            .map((studentId) => sessions.get(studentId)?.payload)
            .filter((session): session is AaisLearnerSession => Boolean(session))
            .filter((session) => !phase || session.events.some((entry) => entry.phase === phase))
            .filter((session) => !task || session.events.some((entry) => entry.task === task))
            .filter((session) => !agent || session.events.some((entry) => entry.agent === agent))
            .filter((session) => !eventName || session.events.some((entry) => entry.event === eventName))
            .map(createAnalyticsRow),
        };
      }
      if (/^with unambiguous_active_learner_scope as materialized/i.test(normalized)
        && /select\s+session\.student_id,[\s\S]*as session_id/i.test(normalized)) {
        const accessible = getAccessibleStudentIds(
          input.enrollments,
          String(params[0]),
          String(params[1]),
          {},
        );
        return {
          rows: Array.from(accessible)
            .map((studentId) => sessions.get(studentId)?.payload)
            .filter((session): session is AaisLearnerSession => Boolean(session))
            .map((session) => ({
              student_id: session.studentId,
              session_id: session.sessionId,
              created_at: session.createdAt,
            })),
        };
      }
      if (/^with unambiguous_active_learner_scope as materialized/i.test(normalized)
        && /select session\.payload/i.test(normalized)) {
        const [studentId, actorId, actorRole] = params.map(String);
        const row = sessions.get(studentId);
        if (
          !row
          || !canAccessStudent(input.enrollments, actorId, actorRole, studentId)
        ) {
          return { rows: [] };
        }
        return { rows: [{ ...row, data_generation: 1 }] };
      }
      if (/^with generation_guard as materialized/i.test(normalized)
        && /session_insert as/i.test(normalized)) {
        const studentId = String(params[0]);
        const actorId = params[10] === null ? null : String(params[10]);
        const actorRole = params[11] === null ? null : String(params[11]);
        if (!actorId || !actorRole || !canAccessStudent(input.enrollments, actorId, actorRole, studentId)) {
          return { rows: [] };
        }
        const current = sessions.get(studentId);
        if (!current || current.version !== Number(params[2])) {
          return { rows: [] };
        }
        current.payload = JSON.parse(String(params[1])) as AaisLearnerSession;
        current.version += 1;
        return { rows: [{ version: current.version }] };
      }
      if (/^with candidate as \([\s\S]*from aais_lrs_outbox/i.test(normalized)) {
        return { rows: [] };
      }
      throw new Error(`Unexpected scoped test query: ${sql}`);
    },
  };
  return database;
}

function hasActiveEducatorScope(enrollments: Enrollment[], actorId: string, actorRole: string) {
  return enrollments.some((entry) =>
    entry.userId === actorId
    && entry.role === actorRole
    && entry.status === "active"
    && (entry.role === "teacher" || entry.role === "admin")
  );
}

function getAccessibleStudentIds(
  enrollments: Enrollment[],
  actorId: string,
  actorRole: string,
  filters: { cohort?: unknown; role?: unknown; courseId?: unknown },
) {
  const educatorScopes = enrollments.filter((entry) =>
    entry.userId === actorId
    && entry.role === actorRole
    && entry.status === "active"
  );
  const byStudent = new Map<string, Enrollment[]>();
  for (const entry of enrollments) {
    if (entry.role === "student" && entry.status === "active") {
      byStudent.set(entry.userId, [...(byStudent.get(entry.userId) ?? []), entry]);
    }
  }
  return new Set(Array.from(byStudent)
    .filter(([, entries]) => entries.length === 1)
    .filter(([, [entry]]) => Boolean(entry)
      && educatorScopes.some((scope) => scope.courseId === entry!.courseId && scope.cohort === entry!.cohort)
      && (!filters.cohort || filters.cohort === entry!.cohort)
      && (!filters.role || filters.role === entry!.role)
      && (!filters.courseId || filters.courseId === entry!.courseId))
    .map(([studentId]) => studentId));
}

function canAccessStudent(
  enrollments: Enrollment[],
  actorId: string,
  actorRole: string,
  studentId: string,
) {
  return getAccessibleStudentIds(enrollments, actorId, actorRole, {}).has(studentId);
}

function createLegacyAnalytics(session: AaisLearnerSession) {
  const analytics = summarizeAaisCohortAnalytics([session]);
  const learner = analytics.learners[0]!;
  return {
    ...analytics,
    learners: [{
      ...learner,
      learnerKey: `learner-${createHash("sha256")
        .update(`aais-analytics:${session.studentId}`)
        .digest("hex")
        .slice(0, 12)}`,
      sessionKey: `session-${createHash("sha256")
        .update(`aais-analytics-session:${session.sessionId}`)
        .digest("hex")
        .slice(0, 12)}`,
      recommendationOverrideDecisions: {},
    }],
  };
}

function appendRecommendationOverrideEvent(
  session: AaisLearnerSession,
  recommendation: ReturnType<typeof buildAaisLearnerRecommendations>["recommendations"][number],
  decision: "accepted" | "dismissed" | "deferred",
  time: string,
) {
  const targetTaskId = recommendation.targetTaskId ?? session.activeTaskId;
  const task = session.tasks.find((candidate) => candidate.taskId === targetTaskId)!;
  session.events.push({
    student_id: session.studentId,
    session_id: session.sessionId,
    phase: task.phase,
    task: targetTaskId,
    agent: "platform",
    event: "recommendation_override_recorded",
    time,
    detail: {
      recommendation_id: recommendation.id,
      rule_id: recommendation.ruleId,
      learner_key: recommendation.learnerKey,
      session_key: recommendation.sessionKey,
      decision,
    },
  });
}

function createAnalyticsRow(session: AaisLearnerSession) {
  const recommendationOverrideDecisions = session.events.reduce<Record<string, string>>(
    (decisions, event) => {
      const recommendationId = event.detail.recommendation_id;
      const decision = event.detail.decision;
      if (
        event.event === "recommendation_override_recorded"
        && typeof recommendationId === "string"
        && typeof decision === "string"
      ) {
        decisions[recommendationId] = decision;
      }
      return decisions;
    },
    {},
  );
  return {
    student_id: session.studentId,
    session_id: session.sessionId,
    updated_at: session.updatedAt,
    training_completed: session.tasks.some((task) => task.phase === "training" && task.status === "completed"),
    active_practice_task_id: session.tasks.find((task) => task.taskId === session.activeTaskId && task.phase === "practice")?.taskId ?? null,
    completed_practice_tasks: session.tasks.filter((task) => task.phase === "practice" && task.status === "completed").length,
    scaffold_requests: session.events.filter((event) => event.event === "scaffold_request").length,
    coaching_signals: session.events.filter((event) => event.event === "coaching_push" || event.event === "monitoring_pause_detected").length,
    ai_prompt_response_events: session.events.filter((event) => event.event === "ai_prompt_submitted" || event.event === "ai_response_completed").length,
    ai_acceptance_decisions: session.events.filter((event) => event.event === "ai_acceptance_recorded").length,
    self_report_count: session.events.filter((event) => event.event === "self_report_saved").length,
    expert_trace_count: session.events.filter((event) => event.event === "expert_trace_compared").length,
    recommendation_override_decisions: recommendationOverrideDecisions,
    recommendation_override_evidence: session.events
      .filter((event) => event.event === "recommendation_override_recorded")
      .map((event, index) => ({
        recommendationId: event.detail.recommendation_id,
        ruleId: event.detail.rule_id,
        targetTaskId: event.task,
        learnerKey: event.detail.learner_key,
        sessionKey: event.detail.session_key,
        decision: event.detail.decision,
        eventTime: event.time,
        eventId: `test-event-${String(index).padStart(8, "0")}`,
      })),
  };
}
