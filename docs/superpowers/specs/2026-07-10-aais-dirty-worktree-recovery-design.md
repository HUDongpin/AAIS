# AAIS Dirty Worktree Recovery Design

## 1. Purpose

This design converts the current AAIS root checkout from a mixed dirty integration inventory into reviewable commits, validates the recovered behavior in a clean linked worktree, and establishes a worktree-first operating model for future Codex tasks.

The design follows the workflow principles in Daniel Mackay's article, [Parallel Vibe Coding: Using Git Worktrees with Claude Code](https://www.dandoescode.com/blog/parallel-vibe-coding-with-git-worktrees): one branch and working directory per task, a clean integration base, no stash-based task isolation, and explicit cleanup after merge.

## 2. Authoritative Starting State

The assessment baseline is the state observed on 2026-07-10 in `/Users/dongpinhu/Desktop/AAIS`.

- Remote `origin/main` and the pre-recovery local HEAD pointed to `d20024f3256a970c4ca4a9360211a6b485d9d82d`.
- The root checkout used branch `codex/aais-enterprise-standard`; no local `main` branch existed.
- The dirty inventory contained eight modified tracked files and one untracked migration, with no staged, deleted, conflicted, or stashed changes.
- The tracked diff contained 391 insertions and 35 deletions.
- Focused validation passed 77 tests in four files.
- A clean baseline run reproduced two failures in `tests/aais-session-revocations.test.ts`; all other baseline tests passed.
- The two failures are independent of the dirty inventory. The test creates an eight-hour token at `2026-07-09T12:00:00Z`, which expired at `2026-07-09T20:00:00Z`, but later revocation checks default to the real clock.
- The repository hygiene check reports both Git dirt and local private artifacts. The private artifacts are already ignored and are not cleanup targets.

Before any staging, the dirty inventory was copied to the external recovery snapshot:

`/Users/dongpinhu/Desktop/AAIS-dirty-worktree-backups/20260710-101016-worktree-recovery`

The snapshot contains the binary tracked patch, diff statistics, base commit metadata, and the untracked migration. The tracked patch checksum matches a fresh binary diff, the migration copy matches byte-for-byte, and the snapshot directory is owner-only (`700`).

Commit `2fd9383` adds `.worktrees/` to `.gitignore`. It contains no feature files and is the common local recovery base.

## 3. Goals and Success Criteria

The recovery is complete only when all of the following are true:

1. Every behavior represented by the nine dirty paths exists in committed, reviewable history or is deliberately removed because stronger evidence proves it redundant or incorrect.
2. The three functional concerns are separated into independent commits with clear rollback boundaries.
3. The time-sensitive session-revocation baseline failure is fixed in its own test-only commit.
4. The nine original dirty paths in the clean integration worktree match the approved recovered result, and any deviation from the snapshot is documented and covered by tests.
5. `npm run ci`, `npm run e2e`, and `git diff --check` pass in the clean integration worktree.
6. Strict `npm run hygiene:check` passes in the clean integration worktree, where private root-only artifacts are absent.
7. The root checkout ends on a local `main` branch that tracks the accepted mainline state and has no tracked or untracked source changes.
8. Owner-approved private and generated paths remain ignored and untouched, including `.env*`, `All API Keys.docx`, `.aais-data`, `.vercel`, `.next`, `output`, and `node_modules`.
9. No stash is used, and no broad `git add .` operation is used.
10. Temporary worktrees and their branches are removed only after their commits are integrated and verified.

## 4. Non-Goals

- Do not change provider credentials, environment values, or private local artifacts.
- Do not deploy AAIS directly from the dirty root checkout.
- Do not combine unrelated refactors with the recovery.
- Do not rewrite existing public history.
- Do not treat a passing focused test run as proof that the full recovery is complete.
- Do not delete the external recovery snapshot during this recovery.

## 5. Worktree and Branch Topology

The root checkout remains the immutable rescue source until equivalence is proven. Implementation and validation occur in linked worktrees under the ignored `.worktrees/` directory.

| Purpose | Branch | Worktree role |
| --- | --- | --- |
| Written design and plan | `codex/aais-worktree-recovery-design` | Holds the approved design and implementation plan |
| Baseline CI repair | `codex/aais-session-revocation-test` | Makes the session-revocation test clock deterministic |
| Locked-task protection | `codex/aais-locked-task-guard` | Recovers server-side task-sequencing protection |
| Durable guide budget | `codex/aais-daily-guide-budget` | Recovers atomic daily usage reservation and migration `0008` |
| LRS outbox hardening | `codex/aais-lrs-outbox-hardening` | Recovers xAPI mapping coverage and poison-event handling |
| Combined validation | `codex/aais-recovery-compose` | Integrates all recovery commits and runs full gates |

Each feature branch starts from the same accepted recovery base. A branch may be rebased onto a newer `origin/main` only before its recovery patch is applied and only after the new base passes the same baseline audit.

## 6. Recovery Slices

### 6.1 Baseline CI Repair

This is a test-only prerequisite and is not part of the original dirty inventory.

**File:** `tests/aais-session-revocations.test.ts`

The test must pass an explicit fixed `now` to `revokeAaisSessionToken` and `isAaisSessionTokenRevoked`, using a time after issuance and before the token's fixed expiry. Production token or revocation behavior must not change.

The commit is accepted when the isolated test passes repeatedly and the full clean baseline has no remaining failure attributable to the clock.

### 6.2 Locked-Task Protection

**Source responsibilities:**

- `src/lib/server/aais-learning-store.ts`: require an unlocked task for completion, scaffolding, AI acceptance, and mutable task fields.
- `src/app/api/learning/scaffold/route.ts`: translate a locked-task error into the redacted `AAIS_TASK_LOCKED` API response.

**Test responsibilities:**

- `tests/aais-backend-store.test.ts`: prove every learner mutation rejects locked tasks and leaves task state unchanged.
- `tests/aais-api-routes.test.ts`: prove `complete-task` cannot bypass sequencing and does not alter the locked task.

The existing `select-task` redaction test is not a duplicate. It covers a different mutation and remains intact.

### 6.3 Durable Daily Guide Budget

**Source responsibilities:**

- `migrations/postgres/0008_ai_guide_daily_usage.sql`: create a per-student, per-UTC-day usage table.
- `src/lib/server/aais-learning-store.ts`: atomically reserve a request below the configured limit, report exhaustion, delete usage rows during learner-data deletion, and provide a bounded fallback when the migration is absent.
- `src/app/api/learning/ai-guide/route.ts`: reserve before running the guide and return the reserved budget consistently for JSON and stream responses.

**Test responsibilities:**

- `tests/aais-backend-store.test.ts`: cover atomic increments, exhaustion, per-student isolation, missing-table fallback, and memory fallback.
- `tests/postgres-migrations.test.mjs`: register and inspect migration `0008`.
- Existing daily-budget API tests remain the route-level contract.

The migration and application code form one rollback unit and must never be split across different accepted revisions.

### 6.4 LRS Outbox Hardening

**Source responsibilities:**

- `src/lib/server/aais-lrs-client.ts`: map `recommendation_override_recorded` to an xAPI verb.
- `src/lib/server/aais-learning-store.ts`: convert statement-build or normalization failures into retry/dead-letter progression instead of an unhandled flush rejection.

**Test responsibilities:**

- `tests/aais-lrs-client.test.ts`: require a mapping for every defined AAIS event.
- `tests/aais-backend-store.test.ts`: prove an unmappable poison event progresses from retry to dead letter without an HTTP call or a stalled flush.

## 7. Extraction and Commit Rules

The root rescue checkout is the source of truth for the original hunks. Extraction uses explicit pathspecs and patch hunks; it never stages every changed path at once.

The commits are created in this order:

1. `test: make session revocation checks time deterministic`
2. `fix: reject mutations against locked learning tasks`
3. `fix: reserve durable daily AI guide usage`
4. `fix: harden LRS outbox delivery failures`

The shared files `src/lib/server/aais-learning-store.ts` and `tests/aais-backend-store.test.ts` contain hunks for multiple slices. Their hunks must be assigned by behavior, not copied wholesale into the first commit. The `AaisDatabaseClient` test import belongs to the first slice that requires the typed fake database; later commits reuse it without duplicating the import.

After each commit:

- inspect `git show --stat --oneline HEAD`;
- run `git diff --check HEAD^..HEAD`;
- run the focused tests for that slice;
- confirm `git status --short` contains no unintended paths.

If a hunk cannot be assigned unambiguously, extraction stops. The root inventory and external snapshot remain unchanged while the hunk is reviewed.

## 8. Integration and Verification Flow

The compose worktree begins at the accepted recovery base and integrates the design/infrastructure commit plus the four recovery commits in dependency order.

Verification proceeds from narrow to broad:

1. Run the focused test file or test-name pattern for each commit.
2. Run the combined backend/API/migration/LRS focused suite.
3. Compare the nine recovered paths against the root rescue inventory. Exact differences are expected only when a documented correction is intentional.
4. Run `npm run lint`.
5. Run `npm run type-check`.
6. Run `npm test`.
7. Run `npm run build` through `npm run ci`.
8. Run `npm run e2e`.
9. Run `npm run hygiene:check` in the clean compose worktree.
10. Run `git diff --check` and confirm the compose worktree is clean.

The original binary patch and migration copy remain available until all gates pass and the accepted commits are present in the intended mainline history.

## 9. Root Checkout Closure

Root cleanup happens last.

Before removing any root-only dirty state:

1. prove the accepted integration contains the recovered nine-path behavior;
2. prove the external snapshot is still readable and checksum-valid;
3. record the accepted commit SHAs;
4. confirm no agent or process is still writing to the root checkout.

After those proofs, the root checkout is aligned to the accepted mainline and a local `main` branch is created or updated to track `origin/main`. The final root checks are:

- `git branch --show-current` returns `main`;
- `git rev-list --left-right --count main...origin/main` returns `0 0` after the accepted changes reach the remote mainline;
- `git status --porcelain=v1 -uall` returns no source paths;
- `git worktree list --porcelain` contains only worktrees that are intentionally retained.

Root-local private artifacts may remain present and ignored. Developer-root hygiene may therefore use `npm run hygiene:check -- --allow-local-private-artifacts`, while release evidence must come from the strict clean compose or release worktree.

## 10. Ongoing Worktree Policy

After recovery, `/Users/dongpinhu/Desktop/AAIS` is the clean integration and review checkout. Codex implementation tasks use a linked worktree and a unique `codex/` branch.

The lifecycle for every task is:

1. update and verify the clean main base;
2. create one worktree and one branch for the task;
3. install dependencies within that worktree;
4. verify the baseline before editing;
5. implement and test only the assigned scope;
6. push and open a reviewable PR when external publication is authorized;
7. merge only after required gates pass;
8. remove the worktree and delete the merged branch;
9. run `git worktree prune` and confirm the registry is accurate.

Stashes are not used for task isolation. The same branch is never checked out in multiple worktrees. Production release evidence is generated only from a clean, reviewed source.

## 11. Failure Handling and Rollback

- A patch-application conflict stops that slice; no cleanup is attempted in the root.
- A focused test failure keeps the slice unaccepted and prevents composition.
- A compose-only failure is treated as an integration problem and is fixed in the owning slice whenever possible.
- A full-gate failure unrelated to the recovered paths is isolated into its own prerequisite commit, as with the session-revocation test.
- A failed PR or rejected review leaves the root rescue state and external snapshot intact.
- Worktrees are never force-removed while they contain uncommitted changes.
- No branch is deleted until its accepted commit is reachable from the intended mainline.

## 12. Ownership

- S07 owns the AI guide route behavior.
- S12 owns backend storage, API error handling, migration, and LRS delivery behavior.
- S11 owns focused and full verification evidence.
- S22 owns clean-source integration, worktree closure, and release-readiness evidence.

Cross-owner files are split by behavior and validated in the compose worktree before acceptance.
