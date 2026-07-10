# AAIS Durable Daily Guide Budget Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Enforce the per-student daily AI guide limit atomically in Postgres while retaining bounded file/memory and pre-migration fallbacks.

**Architecture:** Reserve usage before the guide runs through a guarded Postgres upsert keyed by student and UTC day. Keep migration `0008`, store behavior, route response, deletion semantics, and tests in one rollback unit.

**Tech Stack:** TypeScript, Next.js route handlers, PostgreSQL, Vitest, Node.js, Git worktrees.

---

### Task 1: Create the isolated daily-budget worktree

**Files:**
- Create: `migrations/postgres/0008_ai_guide_daily_usage.sql`
- Modify: `src/lib/server/aais-learning-store.ts`
- Modify: `src/app/api/learning/ai-guide/route.ts`
- Test: `tests/aais-backend-store.test.ts`
- Test: `tests/postgres-migrations.test.mjs`
- Test existing contract: `tests/aais-api-routes.test.ts`

- [ ] **Step 1: Create the branch from the approved recovery base**

Run from `/Users/dongpinhu/Desktop/AAIS`:

```bash
git worktree add .worktrees/aais-daily-guide-budget \
  -b codex/aais-daily-guide-budget 49c920e
```

Expected: a clean worktree on `codex/aais-daily-guide-budget`.

- [ ] **Step 2: Install dependencies**

Run from `/Users/dongpinhu/Desktop/AAIS/.worktrees/aais-daily-guide-budget`:

```bash
npm install
git status --short --branch
```

Expected: dependency installation succeeds and Git is clean.

### Task 2: Add the database reservation and migration tests first

**Files:**
- Modify: `tests/aais-backend-store.test.ts:10`
- Modify: `tests/aais-backend-store.test.ts:367`
- Modify: `tests/aais-backend-store.test.ts:1345`
- Modify: `tests/postgres-migrations.test.mjs:52`

- [ ] **Step 1: Import the database-client type**

Add this named type to the existing import from `@/lib/server/aais-learning-store`:

```ts
type AaisDatabaseClient,
```

- [ ] **Step 2: Add the atomic reservation test**

```ts
it("atomically reserves the durable daily guide budget and rejects once exhausted", async () => {
  const database = createFakeDatabaseClient();
  const store = createAaisLearningStore({ database });

  const first = await store.reserveDailyGuideRequest({ studentId: "S001", limit: 2 });
  const second = await store.reserveDailyGuideRequest({ studentId: "S001", limit: 2 });
  const third = await store.reserveDailyGuideRequest({ studentId: "S001", limit: 2 });

  expect(first).toMatchObject({ status: "reserved", limit: 2, used: 1, remaining: 1 });
  expect(second).toMatchObject({ status: "reserved", limit: 2, used: 2, remaining: 0 });
  expect(third).toMatchObject({ status: "exhausted", limit: 2, used: 2, remaining: 0 });

  // A different learner has an independent daily counter.
  const other = await store.reserveDailyGuideRequest({ studentId: "S002", limit: 2 });
  expect(other).toMatchObject({ status: "reserved", used: 1 });

  // The guarded upsert only increments while under the limit — the exhausted
  // attempt must not have advanced the counter past the cap.
  const usageQueries = database.queries.filter((query) =>
    /aais_ai_guide_daily_usage/i.test(query.sql),
  );
  expect(usageQueries.some((query) => /where aais_ai_guide_daily_usage\.used < \$4/i.test(query.sql))).toBe(
    true,
  );
});
```

- [ ] **Step 3: Add missing-table and memory fallback tests**

```ts
it("degrades to prompt-event counting when the durable usage table is missing", async () => {
  const missingTableError = Object.assign(new Error("relation does not exist"), {
    code: "42P01",
  });
  const database = {
    async query(sql: string) {
      if (/^insert into aais_ai_guide_daily_usage/i.test(sql.trim())) {
        throw missingTableError;
      }
      if (/^select count\(\*\)::int as count\s+from aais_events/i.test(sql.trim())) {
        return { rows: [{ count: 0 }] };
      }
      throw new Error(`Unexpected query: ${sql}`);
    },
  } as unknown as AaisDatabaseClient;
  const store = createAaisLearningStore({ database });

  const reservation = await store.reserveDailyGuideRequest({ studentId: "S001", limit: 3 });
  expect(reservation).toMatchObject({ status: "reserved", limit: 3, used: 1, remaining: 2 });
});

it("falls back to per-process prompt-event counting when no database is configured", async () => {
  const store = createAaisLearningStore({ rootDir: tempDir });

  const first = await store.reserveDailyGuideRequest({ studentId: "S001", limit: 1 });
  expect(first).toMatchObject({ status: "reserved", limit: 1, used: 1, remaining: 0 });

  // Nothing has been persisted yet (the prompt event is written when the exchange
  // is appended), so a follow-up reservation still sees head-room until an exchange
  // lands. Simulate a completed exchange, then confirm the cap holds.
  await store.appendGuideExchange({
    studentId: "S001",
    phase: "training",
    taskId: "training_task_1",
    question: "问题",
    answer: "回答",
    orchestration: { graphId: "g", topologicalOrder: ["A1"], threadId: "t" },
  });

  const afterExchange = await store.reserveDailyGuideRequest({ studentId: "S001", limit: 1 });
  expect(afterExchange).toMatchObject({ status: "exhausted", limit: 1, used: 1, remaining: 0 });
});
```

- [ ] **Step 4: Extend the fake database with daily usage state**

Add beside the other maps in `createFakeDatabaseClient`:

```ts
const dailyGuideUsage = new Map<string, number>();
```

Add before the fake database's final unexpected-query throw:

```ts
if (/^insert into aais_ai_guide_daily_usage/i.test(sql.trim())) {
  const key = `${String(params[0])}\0${String(params[1]).slice(0, 10)}`;
  const limit = Number(params[3]);
  const existing = dailyGuideUsage.get(key);
  if (existing === undefined) {
    dailyGuideUsage.set(key, 1);
    return { rows: [{ used: 1 }] };
  }
  if (existing < limit) {
    const used = existing + 1;
    dailyGuideUsage.set(key, used);
    return { rows: [{ used }] };
  }
  return { rows: [] };
}
if (/^select used\s+from aais_ai_guide_daily_usage/i.test(sql.trim())) {
  const used = dailyGuideUsage.get(`${String(params[0])}\0${String(params[1]).slice(0, 10)}`);
  return { rows: used === undefined ? [] : [{ used }] };
}
```

- [ ] **Step 5: Add migration `0008` expectations**

Add this object to the migration metadata assertion:

```js
expect.objectContaining({
  version: "0008",
  name: "ai_guide_daily_usage",
  fileName: "0008_ai_guide_daily_usage.sql",
  checksum: expect.stringMatching(/^[a-f0-9]{64}$/),
}),
```

Add these SQL assertions after the migration `0007` assertions:

```js
expect(migrations[7].sql).toContain("create table if not exists aais_ai_guide_daily_usage");
expect(migrations[7].sql).toContain("primary key (student_id, usage_day)");
```

- [ ] **Step 6: Prove the new tests fail before implementation**

```bash
npx vitest run \
  tests/aais-backend-store.test.ts \
  tests/postgres-migrations.test.mjs \
  -t "daily guide budget|durable usage table|per-process|Postgres migrations"
```

Expected: failures report missing `reserveDailyGuideRequest` and missing migration `0008`.

### Task 3: Add migration `0008`

**Files:**
- Create: `migrations/postgres/0008_ai_guide_daily_usage.sql`

- [ ] **Step 1: Create the complete migration**

```sql
create table if not exists aais_ai_guide_daily_usage (
  student_id text not null,
  usage_day date not null,
  used integer not null default 0,
  updated_at timestamptz not null default now(),
  primary key (student_id, usage_day)
);
```

- [ ] **Step 2: Verify migration discovery**

```bash
npx vitest run tests/postgres-migrations.test.mjs
```

Expected: all Postgres migration tests pass and report migration `0008`.

### Task 4: Implement atomic reservation in the learning store

**Files:**
- Modify: `src/lib/server/aais-learning-store.ts:776`
- Modify: `src/lib/server/aais-learning-store.ts:859`
- Modify: `src/lib/server/aais-learning-store.ts:1186`
- Modify: `src/lib/server/aais-learning-store.ts:2816`

- [ ] **Step 1: Delete durable usage during learner-data deletion**

Insert after deletion from `aais_learner_task_state`:

```ts
await database.query(
  "delete from aais_ai_guide_daily_usage where student_id = $1",
  [safeStudentId],
);
```

- [ ] **Step 2: Add the reservation method before `getCohortAnalytics`**

```ts
async function reserveDailyGuideRequest(input: {
  studentId: string;
  limit: number;
  now?: Date;
}): Promise<AaisDailyGuideReservation> {
  const safeStudentId = requireSafeId(input.studentId, "student id");
  const now = input.now ?? new Date();
  const dayRange = getAaisUtcDayRange(now);
  const limit = Math.max(1, Math.floor(input.limit));
  if (database) {
    try {
      // Atomic reserve-then-run gate: the guarded upsert increments the daily
      // counter only while it is below the limit, so concurrent requests (even on
      // separate serverless instances) cannot both slip past the cap.
      const reserved = await database.query(
        `insert into aais_ai_guide_daily_usage (student_id, usage_day, used, updated_at)
         values ($1, $2::date, 1, $3::timestamptz)
         on conflict (student_id, usage_day)
         do update set used = aais_ai_guide_daily_usage.used + 1, updated_at = $3::timestamptz
         where aais_ai_guide_daily_usage.used < $4
         returning used`,
        [safeStudentId, dayRange.start, now.toISOString(), limit],
      );
      if (reserved.rows.length > 0) {
        return buildDailyGuideReservation("reserved", limit, Number(reserved.rows[0]?.used) || 1, dayRange.end);
      }
      const current = await database.query(
        `select used
           from aais_ai_guide_daily_usage
          where student_id = $1
            and usage_day = $2::date
          limit 1`,
        [safeStudentId, dayRange.start],
      );
      return buildDailyGuideReservation("exhausted", limit, Number(current.rows[0]?.used ?? limit) || limit, dayRange.end);
    } catch (error) {
      // If migration 0008 has not been applied yet, degrade to best-effort
      // prompt-event counting rather than failing every guide request.
      if (!isMissingAaisRelationError(error)) {
        throw error;
      }
    }
  }
  // File/memory backend (or a database still missing the durable counter table) is
  // single-process best effort; the increment lands when the exchange is appended.
  const usage = await getDailyGuideUsage(safeStudentId, now);
  if (usage.used >= limit) {
    return buildDailyGuideReservation("exhausted", limit, usage.used, usage.end);
  }
  return buildDailyGuideReservation("reserved", limit, usage.used + 1, usage.end);
}
```

- [ ] **Step 3: Export the method from the store return object**

Add `reserveDailyGuideRequest,` between `recordAiAcceptance,` and `requestScaffold,`.

- [ ] **Step 4: Add the reservation type and helpers after `getAaisUtcDayRange`**

```ts
export type AaisDailyGuideReservation = {
  status: "reserved" | "exhausted";
  limit: number;
  used: number;
  remaining: number;
  resetsAt: string;
};

function buildDailyGuideReservation(
  status: AaisDailyGuideReservation["status"],
  limit: number,
  used: number,
  resetsAt: string,
): AaisDailyGuideReservation {
  return {
    status,
    limit,
    used,
    remaining: Math.max(0, limit - used),
    resetsAt,
  };
}

function isMissingAaisRelationError(error: unknown) {
  if (typeof error !== "object" || error === null || !("code" in error)) {
    return false;
  }
  const code = (error as { code?: unknown }).code;
  return code === "42P01" || code === "42703";
}
```

- [ ] **Step 5: Run store and migration tests**

```bash
npx vitest run tests/aais-backend-store.test.ts tests/postgres-migrations.test.mjs
```

Expected: both files pass.

### Task 5: Reserve the budget before running the AI guide

**Files:**
- Modify: `src/app/api/learning/ai-guide/route.ts:57`
- Test: `tests/aais-api-routes.test.ts:406`

- [ ] **Step 1: Replace the old read-then-finalize budget flow**

Rename `requireDailyGuideBudget` to `reserveDailyGuideBudget`. Its complete body must be:

```ts
async function reserveDailyGuideBudget(
  studentId: string,
  store: ReturnType<typeof getAaisLearningStore>,
): Promise<AaisGuideDailyBudget> {
  const limit = readDailyGuideLimit();
  const reservation = await store.reserveDailyGuideRequest({ studentId, limit });
  const budget: AaisGuideDailyBudget = {
    limit: reservation.limit,
    used: reservation.used,
    remaining: reservation.remaining,
    resetsAt: reservation.resetsAt,
  };
  if (reservation.status === "exhausted") {
    recordGuideBudgetAudit({
      studentId,
      event: "ai.guide.budget.exceeded",
      outcome: "rejected",
      budget,
    });
    throw new AaisGuideDailyBudgetError(budget);
  }
  return budget;
}
```

Call `reserveDailyGuideBudget` at the start of `POST`. Delete `finalizeDailyGuideBudget`. Return and audit the reserved `budget` directly in both JSON and streaming response paths.

- [ ] **Step 2: Run the route contract and complete owning suite**

```bash
npx vitest run \
  tests/aais-api-routes.test.ts \
  tests/aais-backend-store.test.ts \
  tests/postgres-migrations.test.mjs
npm run type-check
git diff --check
```

Expected: all three files pass, the daily budget response remains `{ limit: 1, used: 1, remaining: 0 }`, TypeScript passes, and diff-check is silent.

- [ ] **Step 3: Commit the migration and application behavior as one unit**

```bash
git add -- \
  migrations/postgres/0008_ai_guide_daily_usage.sql \
  src/lib/server/aais-learning-store.ts \
  src/app/api/learning/ai-guide/route.ts \
  tests/aais-backend-store.test.ts \
  tests/postgres-migrations.test.mjs
git diff --cached --check
git diff --cached --name-status
git commit -m "fix: reserve durable daily AI guide usage"
git status --short --branch
```

Expected: exactly five paths are committed and the worktree is clean.
