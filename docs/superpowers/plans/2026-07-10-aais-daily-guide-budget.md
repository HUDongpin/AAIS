# AAIS Durable Daily Guide Budget Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Enforce the per-student daily AI guide limit atomically in Postgres while retaining sequential, single-process best-effort file/memory behavior and a narrowly scoped pre-migration fallback.

**Architecture:** Validate the request first, then reserve usage through a guarded Postgres upsert keyed by student and UTC day before the guide runs. Migration `0008`, readiness, deletion, privacy inventory, route behavior, and regressions remain one rollback unit.

**Reviewed result:** `ad2d5a05114b9f19297fcae4a232cc434c8b2f35` — `fix: reserve durable daily AI guide usage`

**Tech Stack:** TypeScript, Next.js route handlers, PostgreSQL, Vitest, Node.js, Git worktrees.

---

## Exact Slice Boundary

The final slice contains exactly eight paths:

- Create: `migrations/postgres/0008_ai_guide_daily_usage.sql`
- Modify: `src/app/api/learning/ai-guide/route.ts`
- Modify: `src/lib/server/aais-learning-store.ts`
- Modify: `tests/aais-api-routes.test.ts`
- Modify: `tests/aais-backend-store.test.ts`
- Modify: `tests/postgres-migrations.test.mjs`
- Modify: `tests/readiness-route.test.ts`
- Modify: `docs/privacy-data-inventory.md`

No other path belongs in this commit.

### Task 1: Create and verify the isolated worktree

- [ ] **Step 1: Create the branch from the approved recovery base**

Run from `/Users/dongpinhu/Desktop/AAIS`:

```bash
set -euo pipefail
git worktree add .worktrees/aais-daily-guide-budget \
  -b codex/aais-daily-guide-budget 49c920e9cb815fe75a510d57aaf3ec881f822641
```

Expected: a clean worktree on `codex/aais-daily-guide-budget` at exact base `49c920e9cb815fe75a510d57aaf3ec881f822641`.

- [ ] **Step 2: Install dependencies and confirm the base**

```bash
set -euo pipefail
cd /Users/dongpinhu/Desktop/AAIS/.worktrees/aais-daily-guide-budget
npm install
git rev-parse HEAD
git status --short --branch
```

Expected: `git rev-parse HEAD` prints `49c920e9cb815fe75a510d57aaf3ec881f822641`; installation succeeds; no source path is dirty.

### Task 2: Add failing store, migration, readiness, deletion, and privacy acceptance first

**Files:**

- Modify: `tests/aais-backend-store.test.ts`
- Modify: `tests/postgres-migrations.test.mjs`
- Modify: `tests/readiness-route.test.ts`
- Modify: `docs/privacy-data-inventory.md`

- [ ] **Step 1: Add durable reservation regressions**

In `tests/aais-backend-store.test.ts`, add `AaisDatabaseClient` to the existing type imports and add the following exact behavioral cases:

1. `atomically reserves the durable daily guide budget and rejects once exhausted`
   - learner `S001`, limit `2`: reservations report `used` 1 then 2, followed by `exhausted` at 2;
   - exhausted attempts do not increment past the cap;
   - learner `S002` starts at 1 independently;
   - the SQL contains `where aais_ai_guide_daily_usage.used < $4`.
2. `degrades to prompt-event counting when the durable usage table is missing`
   - an insert error with SQLSTATE `42P01` falls back to the current UTC-day `aais_events` count;
   - the returned reservation is a sequential, single-process best-effort result within the configured limit; it is not atomic.
3. `propagates undefined-column errors instead of treating them as a missing durable table`
   - SQLSTATE `42703` rejects with the original error;
   - no prompt-event fallback is attempted.
4. `falls back to per-process prompt-event counting when no database is configured`
   - a pre-exchange reservation is best-effort;
   - after `appendGuideExchange` persists `ai_prompt_submitted`, the same UTC-day limit is exhausted.

Extend `createFakeDatabaseClient` with an in-memory `dailyGuideUsage` map and handlers for the guarded insert and the exhaustion read. The fake must preserve per-student/per-day isolation and return no row when the counter is already at the limit.

- [ ] **Step 2: Add learner-deletion regressions**

In `tests/aais-backend-store.test.ts`, add both cases:

1. `continues Postgres learner deletion when the durable usage table is missing`
   - deleting from `aais_ai_guide_daily_usage` throws SQLSTATE `42P01`;
   - deletion still reaches `aais_events` and `aais_learner_sessions`.
2. `propagates non-table errors from durable usage deletion`
   - deleting from the daily table throws SQLSTATE `42501`;
   - the original error propagates and later learner rows are not deleted.

The acceptance boundary is exact: only undefined-table `42P01` is migration-absence compatibility. Permission, connectivity, undefined-column, and every other database error remain visible.

- [ ] **Step 3: Add migration `0008` discovery and SQL assertions**

In `tests/postgres-migrations.test.mjs`, require migration metadata:

```js
expect.objectContaining({
  version: "0008",
  name: "ai_guide_daily_usage",
  fileName: "0008_ai_guide_daily_usage.sql",
  checksum: expect.stringMatching(/^[a-f0-9]{64}$/),
})
```

Require its SQL to contain all of these semantics:

- `create table if not exists aais_ai_guide_daily_usage`;
- primary key `(student_id, usage_day)`;
- `where event = 'ai_prompt_submitted'`;
- current-day bounds from `date_trunc('day', now() at time zone 'UTC')` and the next UTC day;
- selection and grouping by `(event_time at time zone 'UTC')::date` from `aais_events`;
- `on conflict (student_id, usage_day)`;
- `greatest(aais_ai_guide_daily_usage.used, excluded.used)`.

These assertions prove that backfill uses actual event timestamps, covers only the current UTC day, is safe to rerun, and never lowers a counter that already contains live reservations.

- [ ] **Step 4: Make production readiness require the new table**

In the storage-probe fixtures in `tests/aais-backend-store.test.ts`:

- add `dailyGuideUsageTable?: boolean` to `createProbeDatabaseClient`;
- return `daily_guide_usage_table` as `aais_ai_guide_daily_usage` unless explicitly false;
- extend the existing required-table test so a false value yields storage status `failed`;
- assert the probe query includes `to_regclass('public.aais_ai_guide_daily_usage')` and does not create or alter schema.

In `tests/readiness-route.test.ts`, extend the mocked `to_regclass` row:

```ts
daily_guide_usage_table:
  databaseProbeMode === "missing_schema" ? null : "aais_ai_guide_daily_usage",
```

The existing production readiness fixtures must continue to return `200 ready` when all tables are present and `503 not_ready` with blocked Postgres storage when schema is missing. This is route-level regression coverage for the new required table.

- [ ] **Step 5: Extend the privacy inventory acceptance**

In `docs/privacy-data-inventory.md`, add the daily counter to all relevant sections:

- fields: student id, UTC usage day, reserved-request count, updated timestamp;
- purpose: concurrent daily guide-limit enforcement and migration-day prompt-event backfill;
- deletion: learner deletion removes the row;
- export: no separate export object because it is derived enforcement metadata;
- retention: current-day operational need exists, but cleanup cadence and final retention remain owner/legal decisions.

No secret, connection string, credential, raw prompt, or private artifact may be added.

- [ ] **Step 6: Prove the tests are red before implementation**

```bash
set -euo pipefail
npx vitest run \
  tests/aais-backend-store.test.ts \
  tests/postgres-migrations.test.mjs \
  tests/readiness-route.test.ts \
  -t "daily guide|durable usage|Postgres migrations|production database migrations|required Postgres schema"
```

Expected before implementation: failures identify the missing reservation API, missing migration `0008`, and missing required-table probe. A failure caused only by a test typo must be corrected before implementation starts.

### Task 3: Add request-order regression before route implementation

**Files:**

- Modify: `tests/aais-api-routes.test.ts`

- [ ] **Step 1: Add the exact invalid-attachment case**

Add `does not reserve daily guide budget for an invalid attachment request` and assert:

- a signed-in, CSRF-valid request with unsupported `image/png` attachment returns `400`;
- `reserveDailyGuideRequest` is not called;
- no `ai.guide.budget.used` audit is emitted;
- a valid request immediately afterward succeeds with `{ limit: 1, used: 1, remaining: 0 }`;
- the reservation and used-audit occur exactly once.

This pins the ordering contract: learner input, authentication, CSRF, target normalization, attachment normalization, and other fallible request normalization must complete before the durable reservation.

- [ ] **Step 2: Prove the route regression is red**

```bash
set -euo pipefail
npx vitest run tests/aais-api-routes.test.ts \
  -t "does not reserve daily guide budget for an invalid attachment request"
```

Expected before the route reorder: the invalid request reaches reservation. Do not weaken the assertion to accept a consumed reservation.

### Task 4: Implement migration, store behavior, readiness, route ordering, and privacy inventory

**Files:** all eight slice paths.

- [ ] **Step 1: Create migration `0008`**

Create `migrations/postgres/0008_ai_guide_daily_usage.sql` with:

1. the `(student_id, usage_day)` primary-key table;
2. a `utc_day` CTE for the current UTC-day start and exclusive next-day end;
3. a backfill from `aais_events` for current-day `ai_prompt_submitted` rows grouped by student and the UTC date of `event_time`;
4. conflict handling that sets `used` to `greatest(existing, excluded)` and updates `updated_at` only when the backfill count is higher.

- [ ] **Step 2: Implement the durable reservation and narrow compatibility helper**

In `src/lib/server/aais-learning-store.ts`:

- add `reserveDailyGuideRequest({ studentId, limit, now })`;
- derive UTC-day boundaries with `getAaisUtcDayRange`;
- perform the guarded insert/upsert and read the existing count only when no row was reserved;
- return `{ status, limit, used, remaining, resetsAt }`;
- use fallback prompt-event counting only when `isMissingAaisTableError` sees `code === "42P01"`;
- export the method from the store object;
- delete the learner's daily usage row, tolerating only the same `42P01` case;
- require `aais_ai_guide_daily_usage` in `probeAaisLearningStorage`.

Do not treat `42703` as a missing-table error. Do not catch the whole learner-deletion sequence.

- [ ] **Step 3: Reorder and simplify the guide route**

In `src/app/api/learning/ai-guide/route.ts`:

- validate and normalize the full request first;
- determine stream mode before reservation;
- call `reserveDailyGuideBudget` only after the request is valid;
- throw the existing redacted `AAIS_GUIDE_DAILY_BUDGET_EXCEEDED` response for exhaustion;
- remove read-then-finalize behavior;
- use the reserved budget directly in JSON, streaming, and redacted audit results.

- [ ] **Step 4: Apply readiness and privacy changes**

Update both readiness fixture families and `docs/privacy-data-inventory.md` exactly as pinned in Task 2. These are part of the slice, not follow-up documentation.

### Task 5: Verify the reviewed slice and commit exactly eight paths

- [ ] **Step 1: Run the complete focused slice**

```bash
set -euo pipefail
npx vitest run \
  tests/aais-api-routes.test.ts \
  tests/aais-backend-store.test.ts \
  tests/postgres-migrations.test.mjs \
  tests/readiness-route.test.ts
npm run type-check
git diff --check
```

Expected: all four test files pass; TypeScript exits `0`; diff-check is silent. The passing cases include invalid-before-reservation, atomic exhaustion, learner isolation, `42P01`-only fallback, non-`42P01` propagation, missing-table-safe deletion, current-UTC-day non-lowering backfill, readiness failure for a missing counter table, and the existing readiness route contract.

- [ ] **Step 2: Audit the exact file boundary and documentation contract**

```bash
set -euo pipefail
diff -u \
  <(printf '%s\n' \
    'docs/privacy-data-inventory.md' \
    'migrations/postgres/0008_ai_guide_daily_usage.sql' \
    'src/app/api/learning/ai-guide/route.ts' \
    'src/lib/server/aais-learning-store.ts' \
    'tests/aais-api-routes.test.ts' \
    'tests/aais-backend-store.test.ts' \
    'tests/postgres-migrations.test.mjs' \
    'tests/readiness-route.test.ts' | LC_ALL=C sort) \
  <(git diff --name-only | LC_ALL=C sort)
grep -Fq 'aais_ai_guide_daily_usage' docs/privacy-data-inventory.md
grep -Fq 'derived enforcement metadata' docs/privacy-data-inventory.md
grep -Fq 'cleanup cadence' docs/privacy-data-inventory.md
```

Expected: `git diff --name-only` prints exactly the eight paths listed at the top of this plan, and the privacy inventory contains storage, deletion/export, and retention coverage without secrets.

- [ ] **Step 3: Run the isolated branch full suite and apply the known-baseline caveat**

```bash
set -euo pipefail
npm test
```

Expected on this isolated branch, which is based on `49c920e9cb815fe75a510d57aaf3ec881f822641`: the only full-suite failures are the two known clock-sensitive cases in `tests/aais-session-revocations.test.ts`. Those failures are fixed by the separate reviewed commit `5e803c669b955abba8a3f6c1c665c5543875a21a`. Any daily-budget failure, any third failure, or any failure in another file blocks the slice.

The compose branch must include `5e803c669b955abba8a3f6c1c665c5543875a21a` and then rerun the full suite to green; this caveat does not authorize publication with failing tests.

- [ ] **Step 4: Stage exactly eight paths and commit**

```bash
set -euo pipefail
git add -- \
  migrations/postgres/0008_ai_guide_daily_usage.sql \
  src/app/api/learning/ai-guide/route.ts \
  src/lib/server/aais-learning-store.ts \
  tests/aais-api-routes.test.ts \
  tests/aais-backend-store.test.ts \
  tests/postgres-migrations.test.mjs \
  tests/readiness-route.test.ts \
  docs/privacy-data-inventory.md
git diff --cached --check
diff -u \
  <(printf '%s\n' \
    'docs/privacy-data-inventory.md' \
    'migrations/postgres/0008_ai_guide_daily_usage.sql' \
    'src/app/api/learning/ai-guide/route.ts' \
    'src/lib/server/aais-learning-store.ts' \
    'tests/aais-api-routes.test.ts' \
    'tests/aais-backend-store.test.ts' \
    'tests/postgres-migrations.test.mjs' \
    'tests/readiness-route.test.ts' | LC_ALL=C sort) \
  <(git diff --cached --name-only | LC_ALL=C sort)
git commit -m "fix: reserve durable daily AI guide usage"
git show --stat --oneline HEAD
test -z "$(git status --porcelain=v1 -uall)"
```

Expected: the commit subject is exactly `fix: reserve durable daily AI guide usage`, exactly eight paths are committed, and the worktree is clean. The specification- and quality-approved result is `ad2d5a05114b9f19297fcae4a232cc434c8b2f35`.
