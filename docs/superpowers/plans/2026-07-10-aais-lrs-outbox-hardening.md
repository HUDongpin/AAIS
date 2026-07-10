# AAIS LRS Outbox Hardening Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ensure every defined AAIS event can build a safe xAPI statement and ensure malformed or unmappable outbox rows cannot stall valid delivery.

**Architecture:** Preflight each outbox row independently with a real runtime parser and statement builder, classify invalid rows before delivery, send only validated rows, and retain separate redacted invalid-event and delivery-error state transitions. Compile-time exhaustive mapping and own-property checks close prototype-chain gaps.

**Reviewed result:** `33af4c30100f4c0ea02b765709eb83123e7b10ff` — `fix: harden LRS outbox delivery failures`

**Tech Stack:** TypeScript, xAPI, PostgreSQL outbox pattern, Vitest, Git worktrees.

---

## Exact Slice Boundary

The final slice contains exactly four paths:

- Modify: `src/lib/server/aais-lrs-client.ts`
- Modify: `src/lib/server/aais-learning-store.ts`
- Modify: `tests/aais-lrs-client.test.ts`
- Modify: `tests/aais-backend-store.test.ts`

No other path belongs in this commit.

### Task 1: Create and verify the isolated worktree

- [ ] **Step 1: Create the branch from the approved recovery base**

Run from `/Users/dongpinhu/Desktop/AAIS`:

```bash
set -euo pipefail
git worktree add .worktrees/aais-lrs-outbox-hardening \
  -b codex/aais-lrs-outbox-hardening 49c920e9cb815fe75a510d57aaf3ec881f822641
```

Expected: a clean worktree on `codex/aais-lrs-outbox-hardening` at exact base `49c920e9cb815fe75a510d57aaf3ec881f822641`.

- [ ] **Step 2: Install dependencies and confirm the base**

```bash
set -euo pipefail
cd /Users/dongpinhu/Desktop/AAIS/.worktrees/aais-lrs-outbox-hardening
npm install
git rev-parse HEAD
git status --short --branch
```

Expected: installation succeeds, HEAD is the approved base, and no source path is dirty.

### Task 2: Add exhaustive mapping and prototype-safety tests first

**Files:**

- Modify: `tests/aais-lrs-client.test.ts`

- [ ] **Step 1: Import the authoritative event catalog**

Use this exact data import:

```ts
import { aaisEventDefinitions, type AaisEvent } from "@/data/aais";
```

- [ ] **Step 2: Add exhaustive statement-build coverage**

Add `has an xAPI verb mapping for every defined AAIS event`. Iterate over every entry of `aaisEventDefinitions`, construct a valid event using the definition's agent, and require `buildAaisXapiStatement` not to throw.

This is a class-level guard: any newly defined event must fail the test until a verb mapping exists.

- [ ] **Step 3: Pin the explicit completed verb**

Add `maps recommendation overrides to the standard completed xAPI verb` and require:

```ts
expect(statement.verb).toEqual({
  id: "http://adlnet.gov/expapi/verbs/completed",
  display: { "en-US": "completed" },
});
```

- [ ] **Step 4: Add prototype-key regressions**

Add `rejects prototype property names as unmapped xAPI events`. For `constructor`, `toString`, and `__proto__`, require the exact unmapped-event error from `buildAaisXapiStatement`.

The lookup must test own properties; inherited properties are never event definitions or verb mappings.

- [ ] **Step 5: Prove the new client tests are red**

```bash
set -euo pipefail
npx vitest run tests/aais-lrs-client.test.ts \
  -t "xAPI verb mapping|recommendation overrides|prototype property names"
```

Expected before implementation: `recommendation_override_recorded` lacks a mapping and at least one prototype key is accepted incorrectly. A test setup error is not an acceptable red result.

### Task 3: Add per-row preflight and mixed-batch regressions first

**Files:**

- Modify: `tests/aais-backend-store.test.ts`

- [ ] **Step 1: Add a typed delivery-row harness**

Import `type AaisDatabaseClient` from the learning store. Add a `DeliveryOutboxTestRow` with:

- `id`;
- status `pending`, `retry`, `sent`, or `dead_letter`;
- attempt count;
- unknown payload;
- nullable `lastError`.

Add `createDeliveryOutboxTestDatabase` that:

- returns only pending/retry rows from the outbox select;
- applies sent updates by id;
- applies retry/dead-letter status, attempts, and redacted `last_error` by the final id parameter;
- throws on every unexpected SQL statement.

The harness must not swallow unexpected database behavior.

- [ ] **Step 2: Add a valid payload factory and malformed matrix**

The valid payload contains all runtime fields: `student_id`, `session_id`, phase `practice`, non-empty task, agent `A1`, event `scaffold_request`, strict timestamp `2026-07-10T00:00:00.000Z`, and object detail.

Add malformed cases for:

- missing `student_id`;
- blank `session_id`;
- non-string task;
- blank time;
- invalid phase `review`;
- invalid agent `A5`;
- non-ISO date text;
- impossible calendar timestamp `2026-02-30T00:00:00.000Z`;
- array detail;
- null detail;
- array payload;
- null payload;
- invalid JSON text.

- [ ] **Step 3: Add poison progression and mixed-batch isolation**

Add these tests with the exact acceptance:

1. `dead-letters an unmappable outbox event instead of stalling every flush`
   - an unknown event retries then dead-letters at the configured attempt limit;
   - `lastError` is `redacted:invalid_event`;
   - no HTTP call occurs.
2. `isolates a prototype-named event from valid rows in the same outbox batch`
   - `constructor` dead-letters as invalid;
   - a valid `scaffold_request` in the same batch is sent;
   - the HTTP body contains exactly the valid statement.
3. Parameterized `isolates malformed outbox payload: %s`
   - each malformed case dead-letters as invalid;
   - the valid companion row is sent;
   - the malformed row never reaches HTTP.

- [ ] **Step 4: Add not-configured, delivery, LRS 400, and chunk regressions**

Add these tests:

1. `keeps valid rows pending when an LRS is not configured after invalid-row preflight`
   - invalid rows still classify as `redacted:invalid_event`;
   - valid rows stay pending with attempts unchanged;
   - result is `not_configured`; no HTTP call occurs.
2. `uses a redacted delivery error category for transport failures`
   - a validated row receiving LRS `503` dead-letters as `redacted:delivery_error`;
   - endpoint and credentials do not appear in row state or result.
3. `preserves invalid-row classification when the validated batch gets an LRS 400`
   - the invalid companion remains `redacted:invalid_event`;
   - the valid row becomes `redacted:delivery_error`;
   - HTTP contains only the valid statement.
4. `isolates poison rows from valid events across separate outbox chunks`
   - with `maxBatchSize: 1`, one invalid chunk cannot prevent a later valid chunk from being sent;
   - result reports `sent: 1`, `failed: 1`, and `batches: 2`.

- [ ] **Step 5: Prove the outbox regressions are red**

```bash
set -euo pipefail
npx vitest run tests/aais-backend-store.test.ts \
  -t "unmappable outbox|prototype-named|malformed outbox|not configured after invalid-row preflight|redacted delivery error|LRS 400|separate outbox chunks"
```

Expected before implementation: batch-wide normalization/building either rejects the flush, misclassifies rows together, or stalls valid companions. Do not accept a red result caused by an incomplete fake database.

### Task 4: Implement exhaustive, own-property-safe xAPI mapping

**Files:**

- Modify: `src/lib/server/aais-lrs-client.ts`

- [ ] **Step 1: Make the event map exhaustive**

Declare `eventVerbMap` with:

```ts
} satisfies Record<AaisEvent["event"], AaisXapiVerb>;
```

Add:

```ts
recommendation_override_recorded: "completed",
```

The compile-time record and the runtime every-definition test must agree.

- [ ] **Step 2: Require own mappings and definitions**

In both `requireMappedVerb` and `requireEventDefinition`, use `Object.hasOwn` before indexing. Throw the existing redacted mapping/definition error when the key is not an own property.

This step is mandatory even though TypeScript narrows normal callers; outbox payloads are runtime data.

### Task 5: Implement the runtime parser and per-row preflight

**Files:**

- Modify: `src/lib/server/aais-learning-store.ts`

- [ ] **Step 1: Replace assertion-style normalization with a real parser**

`normalizeNullableOutboxPayload` must:

1. parse string JSON and reject invalid JSON;
2. reject null, arrays, and non-object shapes;
3. copy enumerable entries into a plain record;
4. read `student_id`, `session_id`, `phase`, `task`, `agent`, `event`, and `time` only as own, non-empty string properties;
5. accept phase only as `training` or `practice`;
6. accept agent only as `A1`, `A2`, `A3`, `A4`, or `platform`;
7. accept event only when `Object.hasOwn(aaisEventDefinitions, event)`;
8. accept only strict ISO timestamps with valid month/day/leap-year/hour/minute/second ranges;
9. require `detail` as an own, non-null, non-array object;
10. return a fresh normalized `AaisEvent`, otherwise `null`.

Do not use a TypeScript cast as runtime validation. Do not accept inherited event or detail properties.

- [ ] **Step 2: Preflight each row independently**

For every outbox chunk:

- normalize each row;
- call `buildAaisXapiStatement` during preflight;
- place successful rows in `validRows` and failures in `invalidRows`;
- advance invalid rows immediately with `redacted:invalid_event`;
- continue when a chunk contains no valid rows;
- send only the valid events.

This is row isolation, not batch-wide catch-and-retry.

- [ ] **Step 3: Preserve mixed delivery semantics and database visibility**

- `not_configured`: return after invalid preflight; leave valid rows pending and unmodified.
- `sent`: mark each valid row sent.
- transport exception or non-success response: advance only valid rows with `redacted:delivery_error`.
- final status: `partial` when any row failed, otherwise `sent`.
- database select and status-update errors: propagate; do not convert them into `invalid_event` or `delivery_error`.

Use a shared `advanceAaisLrsOutboxFailures` helper whose `lastError` type is exactly `redacted:invalid_event | redacted:delivery_error`.

### Task 6: Verify and commit exactly four paths

- [ ] **Step 1: Run the complete LRS-owned suites**

```bash
set -euo pipefail
npx vitest run \
  tests/aais-lrs-client.test.ts \
  tests/aais-backend-store.test.ts
npm run type-check
git diff --check
```

Expected: both files pass; TypeScript exits `0`; diff-check is silent. Passing coverage includes exhaustive mapping, explicit standard completed verb, prototype keys, strict runtime payload validation, malformed rows, mixed batches, not-configured behavior, transport `503`, LRS `400`, chunk isolation, and the existing outbox recovery/status contracts.

- [ ] **Step 2: Audit error categories and exact file boundary**

```bash
set -euo pipefail
grep -Fq 'Object.hasOwn' src/lib/server/aais-lrs-client.ts
grep -Fq 'Object.hasOwn' src/lib/server/aais-learning-store.ts
grep -Fq 'redacted:invalid_event' src/lib/server/aais-learning-store.ts
grep -Fq 'redacted:delivery_error' src/lib/server/aais-learning-store.ts
grep -Fq 'isParseableIsoTimestamp' src/lib/server/aais-learning-store.ts
diff -u \
  <(printf '%s\n' \
    'src/lib/server/aais-learning-store.ts' \
    'src/lib/server/aais-lrs-client.ts' \
    'tests/aais-backend-store.test.ts' \
    'tests/aais-lrs-client.test.ts' | LC_ALL=C sort) \
  <(git diff --name-only | LC_ALL=C sort)
```

Expected: both redacted categories and own-property checks are present; `git diff --name-only` prints exactly the four paths listed at the top of this plan.

- [ ] **Step 3: Stage and commit only the LRS slice**

```bash
set -euo pipefail
git add -- \
  src/lib/server/aais-lrs-client.ts \
  src/lib/server/aais-learning-store.ts \
  tests/aais-lrs-client.test.ts \
  tests/aais-backend-store.test.ts
git diff --cached --check
diff -u \
  <(printf '%s\n' \
    'src/lib/server/aais-learning-store.ts' \
    'src/lib/server/aais-lrs-client.ts' \
    'tests/aais-backend-store.test.ts' \
    'tests/aais-lrs-client.test.ts' | LC_ALL=C sort) \
  <(git diff --cached --name-only | LC_ALL=C sort)
git commit -m "fix: harden LRS outbox delivery failures"
git show --stat --oneline HEAD
test -z "$(git status --porcelain=v1 -uall)"
```

Expected: the commit subject is exactly `fix: harden LRS outbox delivery failures`, exactly four paths are committed, and the worktree is clean. The specification- and quality-approved result is `33af4c30100f4c0ea02b765709eb83123e7b10ff`.
