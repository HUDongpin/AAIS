# AAIS LRS Outbox Hardening Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ensure every defined AAIS event can build an xAPI statement and ensure poison outbox events progress to dead letter instead of stalling flushes.

**Architecture:** Guard the event-to-xAPI mapping as a complete class with a coverage test. Convert synchronous normalization/statement-build exceptions inside persistent flushing into the existing retry/dead-letter state machine.

**Tech Stack:** TypeScript, xAPI, PostgreSQL outbox pattern, Vitest, Git worktrees.

---

### Task 1: Create the isolated LRS hardening worktree

**Files:**
- Modify: `src/lib/server/aais-lrs-client.ts`
- Modify: `src/lib/server/aais-learning-store.ts`
- Test: `tests/aais-lrs-client.test.ts`
- Test: `tests/aais-backend-store.test.ts`

- [ ] **Step 1: Create the branch from the approved recovery base**

Run from `/Users/dongpinhu/Desktop/AAIS`:

```bash
git worktree add .worktrees/aais-lrs-outbox-hardening \
  -b codex/aais-lrs-outbox-hardening 49c920e
```

Expected: a clean worktree on `codex/aais-lrs-outbox-hardening`.

- [ ] **Step 2: Install dependencies**

Run from `/Users/dongpinhu/Desktop/AAIS/.worktrees/aais-lrs-outbox-hardening`:

```bash
npm install
git status --short --branch
```

Expected: install succeeds and Git is clean.

### Task 2: Add failing mapping and poison-event tests

**Files:**
- Modify: `tests/aais-lrs-client.test.ts:5`
- Modify: `tests/aais-backend-store.test.ts:10`
- Modify: `tests/aais-backend-store.test.ts:477`

- [ ] **Step 1: Import the complete event catalog**

Replace the data import in `tests/aais-lrs-client.test.ts` with:

```ts
import { aaisEventDefinitions, type AaisEvent } from "@/data/aais";
```

- [ ] **Step 2: Add mapping coverage for every defined event**

Insert at the start of the `AAIS LRS xAPI client` describe block:

```ts
it("has an xAPI verb mapping for every defined AAIS event", () => {
  // Any event that reaches the LRS outbox must build a statement without
  // throwing; a missing verb mapping would permanently stall the persistent
  // outbox flush. Guard the whole class, not just one event.
  for (const [eventName, definition] of Object.entries(aaisEventDefinitions)) {
    const event: AaisEvent = {
      student_id: "S001",
      session_id: "session-coverage",
      phase: "practice",
      task: "practice_task_1",
      agent: definition.agent,
      event: eventName as AaisEvent["event"],
      time: "2026-07-10T00:00:00.000Z",
      detail: {},
    };
    expect(() => buildAaisXapiStatement(event), `event ${eventName} must map to an xAPI verb`).not.toThrow();
  }
});
```

- [ ] **Step 3: Import the fake database type for the poison test**

Add this named type to the existing import from `@/lib/server/aais-learning-store` in `tests/aais-backend-store.test.ts`:

```ts
type AaisDatabaseClient,
```

- [ ] **Step 4: Add the complete poison-event regression test**

Insert before the existing outbox status test:

```ts
it("dead-letters an unmappable outbox event instead of stalling every flush", async () => {
  // An event with no xAPI verb mapping makes buildAaisXapiStatement throw. The
  // persistent flush must treat that as a delivery failure (retry -> dead_letter),
  // not let the throw stall the whole outbox forever.
  const row = {
    id: "outbox-poison",
    status: "pending",
    attempts: 0,
    payload: {
      student_id: "S001",
      session_id: "session-poison",
      phase: "practice",
      task: "practice_task_1",
      agent: "platform",
      event: "totally_unmapped_event",
      time: "2026-07-10T00:00:00.000Z",
      detail: {},
    },
  };
  let fetchCalled = false;
  const database = {
    async query(sql: string, params: unknown[] = []) {
      const trimmed = sql.trim();
      if (/^select id, payload, attempts/i.test(trimmed)) {
        return {
          rows: row.status === "pending" || row.status === "retry"
            ? [{ id: row.id, payload: row.payload, attempts: row.attempts }]
            : [],
        };
      }
      if (/^update aais_lrs_outbox set status = \$1/i.test(trimmed)) {
        row.status = String(params[0]);
        row.attempts = Number(params[1]);
        return { rows: [] };
      }
      throw new Error(`Unexpected query: ${sql}`);
    },
  } as unknown as AaisDatabaseClient;
  const fetchImpl = (async () => {
    fetchCalled = true;
    return new Response(null, { status: 204 });
  }) as unknown as typeof fetch;

  const flushOnce = () =>
    flushAaisPersistentLrsOutbox({
      database,
      config: { endpoint: "https://lrs.example.test/xapi", username: "u", password: "p" },
      fetchImpl,
      maxAttempts: 3,
    });

  // Flush must resolve (never reject) and move the poison row off 'pending'.
  const first = await flushOnce();
  expect(first).toMatchObject({ status: "partial", failed: 1 });
  expect(row).toMatchObject({ status: "retry", attempts: 1 });

  // Repeated flushes progress it to dead_letter instead of blocking forever.
  await flushOnce();
  await flushOnce();
  expect(row).toMatchObject({ status: "dead_letter", attempts: 3 });

  // The failure happened while building the statement, before any HTTP call.
  expect(fetchCalled).toBe(false);
});
```

- [ ] **Step 5: Prove both regressions fail before implementation**

```bash
npx vitest run \
  tests/aais-lrs-client.test.ts \
  tests/aais-backend-store.test.ts \
  -t "xAPI verb mapping|unmappable outbox"
```

Expected: the mapping test identifies `recommendation_override_recorded`; the poison-event test rejects instead of returning a retry result.

### Task 3: Complete the mapping and contain statement-build failures

**Files:**
- Modify: `src/lib/server/aais-lrs-client.ts:106`
- Modify: `src/lib/server/aais-learning-store.ts:1897`

- [ ] **Step 1: Add the missing xAPI verb mapping**

Add this entry between `planning_submitted` and `scaffold_request`:

```ts
recommendation_override_recorded: "completed",
```

- [ ] **Step 2: Wrap normalization and delivery in the outbox state machine**

Replace the beginning of the batch loop with:

```ts
for (const batch of chunkOutboxRows(result.rows, input.maxBatchSize ?? 50)) {
  let delivery: Awaited<ReturnType<typeof sendAaisEventsToLrs>> | { status: "error"; sent: number };
  try {
    const events = batch.map((row) => normalizeOutboxPayload(row.payload));
    delivery = await sendAaisEventsToLrs(events, {
      config: input.config,
      fetchImpl: input.fetchImpl,
      maxBatchSize: events.length,
    });
  } catch {
    // A malformed payload or an event with no xAPI mapping must not stall the
    // outbox with an unhandled rejection — treat it as a delivery failure so the
    // batch retries and eventually dead-letters instead of blocking every flush.
    delivery = { status: "error", sent: 0 };
  }
```

Keep the existing `not_configured`, success, retry, and dead-letter branches immediately after this block unchanged.

- [ ] **Step 3: Run the focused regressions**

```bash
npx vitest run \
  tests/aais-lrs-client.test.ts \
  tests/aais-backend-store.test.ts \
  -t "xAPI verb mapping|unmappable outbox"
```

Expected: both new tests pass.

- [ ] **Step 4: Run the complete LRS-owning suites**

```bash
npx vitest run tests/aais-lrs-client.test.ts tests/aais-backend-store.test.ts
npm run type-check
git diff --check
```

Expected: both files pass, TypeScript passes, and diff-check is silent.

- [ ] **Step 5: Commit only the LRS slice**

```bash
git add -- \
  src/lib/server/aais-lrs-client.ts \
  src/lib/server/aais-learning-store.ts \
  tests/aais-lrs-client.test.ts \
  tests/aais-backend-store.test.ts
git diff --cached --check
git diff --cached --name-status
git commit -m "fix: harden LRS outbox delivery failures"
git status --short --branch
```

Expected: exactly four paths are committed and the worktree is clean.
