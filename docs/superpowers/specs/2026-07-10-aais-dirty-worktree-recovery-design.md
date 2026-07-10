# AAIS Dirty Worktree Recovery Design

## 1. Purpose

This design converts the AAIS root checkout and related recovery worktrees into reviewable, provenance-preserving commits, validates the recovered behavior in a clean compose worktree, and closes every temporary worktree without losing unique content.

The operating model remains one branch and worktree per task, a clean integration source, no stash-based isolation, no history rewriting, and cleanup only after accepted-main equivalence is proven.

## 2. Refreshed Authoritative Snapshot

The current recorded rescue snapshot is:

`/Users/dongpinhu/Desktop/AAIS-dirty-worktree-backups/20260710-145253-worktree-recovery-refresh`

It was recorded owner-only (`700`) with these facts:

- Root checkout: `/Users/dongpinhu/Desktop/AAIS`.
- Root branch: `codex/aais-enterprise-standard`.
- Root HEAD: `2fd93838281581a6996f6f7a8a6bca0d8d95e420` (`chore: ignore local worktrees`).
- Recorded `origin/main`: `42e92a483842a2a601ecbdb10794a90c1f3eba1f`.
- Root inventory: 11 modified tracked paths plus untracked `migrations/postgres/0008_ai_guide_daily_usage.sql`.
- Root tracked-versus-HEAD patch SHA-256: `e3c385c8c57ddf582dad07fd9596476e13a3dcd231c1fef4b93979865d2e3211`.
- Root tracked-versus-recorded-origin patch SHA-256: `bfc1c311ae90c8369d8feaa1bcbe69802b392cd5c7b259dddb23f8b6f8219b6c`.
- Bobie main-fix2-versus-recorded-origin snapshot patch SHA-256: `57b7f506362620e1c8f21eca9e15ec38482a70a957bcd975052f672e2a92ec74`. This snapshot predates the final quality-review additions in `tests/auth-route.test.ts`; the frozen final commit-versus-base patch SHA-256 is `892d373fe7a71ebf0a216e126511501ec0642c198c14fea12e679b3079a98603`.
- Bobie prod-fix-versus-recorded-origin patch SHA-256: `fe3bfd7c9d6709660033a1856bd549daec929da14f0aa230a7a4542716663460`.
- Bobie main-deploy-versus-recorded-origin patch is empty, with SHA-256 `e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855`.
- The backed-up migration matches the root migration byte-for-byte and has SHA-256 `5460251a5560635b4b39229b22b360465ccfbb40b60c1812b3df4d9252ca98ce`.

These hashes and SHAs are snapshot facts, not assumptions about future live
state. The historical `42e92a483842a2a601ecbdb10794a90c1f3eba1f`
value is verified as a commit object and as the `origin_main=` entry in the
snapshot's `root/base-commit.txt`; it remains the baseline for recorded patch
hashes and worktree provenance. No executable step may require the current
mutable `refs/remotes/origin/main` to equal it. Executable integration fetches
live main, requires the live SHA to descend from the historical baseline,
recomputes live evidence against that captured SHA, and stops on rescue
inventory drift, non-fast-forward/unrelated main movement, or evidence mismatch
before publication or cleanup.

### 2.1 Refreshed Root Inventory

The 11 tracked root paths are:

1. `src/app/api/learning/ai-guide/route.ts`
2. `src/app/api/learning/scaffold/route.ts`
3. `src/lib/server/aais-learning-store.ts`
4. `src/lib/server/aais-lrs-client.ts`
5. `src/lib/server/aais-trial-accounts.ts`
6. `tests/aais-api-routes.test.ts`
7. `tests/aais-backend-store.test.ts`
8. `tests/aais-lrs-client.test.ts`
9. `tests/aais-session-revocations.test.ts`
10. `tests/auth-route.test.ts`
11. `tests/postgres-migrations.test.mjs`

The untracked path is `migrations/postgres/0008_ai_guide_daily_usage.sql`.

The first recovery assessment covered eight of the tracked paths plus migration `0008`. The refresh adds three tracked paths:

- `tests/aais-session-revocations.test.ts` already matches recorded `origin/main` and contains no unrescued root-only behavior.
- `src/lib/server/aais-trial-accounts.ts` is unique Bobie behavior rescued by the reviewed Bobie slice.
- `tests/auth-route.test.ts` is unique Bobie coverage rescued and strengthened by the reviewed Bobie slice.

### 2.2 External Worktree Classification

| Worktree | Recorded state | Provenance and cleanup rule |
| --- | --- | --- |
| `/private/tmp/aais-bobie-main-deploy-20260710` | Tracked/untracked-clean detached HEAD at `42e92a483842a2a601ecbdb10794a90c1f3eba1f`; ignored `.aais-data` and reproducible artifacts exist | Remove normally only after exact accepted-main proof and private archive verification. |
| `/private/tmp/aais-bobie-main-fix2-20260710` | Clean attached branch `codex/aais-bobie-production-fallback` at `1d97d16998e95a92ebecb3a69a2ad14c9e0a566c` | Holds the reviewed Bobie source commit; remove only after the exact commit is reachable from accepted main. |
| `/private/tmp/aais-bobie-prod-fix-20260710` | Detached at `2fd93838281581a6996f6f7a8a6bca0d8d95e420`, with three modified working files | The three files match accepted commit `42e92a483842a2a601ecbdb10794a90c1f3eba1f`; its remaining working-tree comparison to that commit is `.gitignore`. Before normal removal, re-prove every dirty file against the accepted commit, restore those files from the current index only after provenance is safe, and stop if any mismatch appears. |

Every registered worktree, including the root, five reviewed source/design worktrees, compose, and these three external worktrees, must be inventoried and classified before any removal. No worktree is force-removed.

Tracked/untracked porcelain is not a complete cleanliness test. A name-only
review found `.aais-data` in six removal targets and `.vercel` in prod-fix;
`.gitignore` also covers `.env*` and `All API Keys.docx`. Cleanup inventories
ignored/untracked top-level names and metadata without printing contents.
`node_modules`, `.next`, `test-results`, and `tsconfig.tsbuildinfo` are the only
reproducible allowlist. Every `.aais-data`, `.vercel`, `.env*`, API-key DOCX,
unknown ignored path, and untracked path is preserved in an owner-only external
archive with counts, SHA-256, permission/archive verification, and scratch-only
restore instructions. Root private data is excluded and remains untouched.

## 3. Reviewed Recovery Inputs

These exact source commits are frozen recovery inputs:

| Slice | Branch/base | Exact final commit | Exact subject | Reviewed scope |
| --- | --- | --- | --- | --- |
| Session baseline | `codex/aais-session-revocation-test`, base `49c920e9cb815fe75a510d57aaf3ec881f822641` | `5e803c669b955abba8a3f6c1c665c5543875a21a` | `test: make session revocation checks time deterministic` | `tests/aais-session-revocations.test.ts` |
| Locked-task guard | `codex/aais-locked-task-guard`, base `49c920e9cb815fe75a510d57aaf3ec881f822641` | `735011b3e002f6be46ff34f4a13c70834a69cfeb` | `fix: reject mutations against locked learning tasks` | Four locked-task source/test paths |
| Daily guide budget | `codex/aais-daily-guide-budget`, base `49c920e9cb815fe75a510d57aaf3ec881f822641` | `ad2d5a05114b9f19297fcae4a232cc434c8b2f35` | `fix: reserve durable daily AI guide usage` | Eight daily source/test/readiness/privacy paths |
| LRS hardening | `codex/aais-lrs-outbox-hardening`, base `49c920e9cb815fe75a510d57aaf3ec881f822641` | `33af4c30100f4c0ea02b765709eb83123e7b10ff` | `fix: harden LRS outbox delivery failures` | Four LRS source/test paths |
| Bobie production fallback | `codex/aais-bobie-production-fallback`, base `42e92a483842a2a601ecbdb10794a90c1f3eba1f` | `1d97d16998e95a92ebecb3a69a2ad14c9e0a566c` | `fix: preserve production learner trial fallback` | `src/lib/server/aais-trial-accounts.ts`, `tests/auth-route.test.ts` |

The Bobie slice has recorded specification and quality PASS status. The four earlier slices retain their previously reviewed path and evidence contracts. Fresh reviewers return the synchronized documentation SHA out of band; execution verifies its subject, exact five-path diff, and clean branch before binding it once to immutable annotated tag `aais-recovery-docs-reviewed-20260710`. Composition starts only after all five source tips and that tagged documentation tip are frozen.

## 4. Goals and Success Criteria

Recovery is complete only when:

1. The five exact source commits remain reachable through separate `--no-ff` merge commits; no source commit is squashed, rebased, or rewritten.
2. Fresh reviewers identify the exact approved documentation commit out of band. The operator verifies that literal SHA, exact five-path diff, subject, and clean branch, then creates the immutable annotated tag `aais-recovery-docs-reviewed-20260710`. Compose, evidence, publication, and cleanup resolve that tag and reject branch drift; they never infer approval from the current branch tip.
3. Every intended behavior in the refreshed root inventory is present on accepted main, with all review-driven deviations documented by slice.
4. The original daily readiness/privacy additions remain in scope: `tests/readiness-route.test.ts` and `docs/privacy-data-inventory.md`.
5. The Bobie slice remains exactly two source paths, while compose separately reconciles production-demo documentation and adds the missing policy regressions before release.
6. Production trial policy is explicit: when trial login is enabled, Bobie and Phoebe remain built-in learner fallbacks in production; a unique configured learner coexists with them; teacher and admin trial identities are each forbidden; invalid configured trial data fails closed; the disable switch rejects every trial login.
7. Duplicate configured Bobie/Phoebe identifiers have documented precedence. The accepted policy is the current implementation: built-in learner records win and same-id configured entries are ignored.
8. `README.md`, `OPERATIONS.md`, and `docs/release-checklist.md` no longer claim that Bobie/Phoebe are rejected production credentials. A blocked smoke credential uses a distinct retired identifier. The exact accepted checklist line occurs twice, replacing both staging and production lines, and both exact old lines are absent.
9. Regression coverage separately proves configured duplicate precedence and production admin-role denial; a teacher-only assertion is not treated as admin coverage.
10. The equivalence artifact has a machine-readable key/value manifest plus exact-set inventory, worktree-classification, deviation, focused-test, and full-gate sections. It records the refreshed snapshot path, all refreshed hashes, five source SHAs, reviewed docs tag object/commit/tree, policy tip, pre-evidence compose tip, predecessor evidence tip/generation, active publication repository path/branch, live-main SHA, root comparison hashes, actual test counts, and actual gate results. Initial generation is exactly `1`; every later generation is proven from Git to equal its predecessor plus exactly one.
11. Focused tests, `npm run ci` including production build, `npm run e2e`, strict `npm run hygiene:check`, and `git diff --check` pass on the final compose tree after the last live-main refresh.
12. The checked-in evidence declares generation-specific final-head and accepted-main tag names tied to the verified exact generation and names the active publication repository. Reviewed-docs and final-head annotated tags are created, verified, and published from the repository that actually contains the sealed head: compose for the initial cycle or the independent acceptance clone after drift. The root repository never creates a tag for a clone-only object. After merge an accepted-main annotated tag binds the actual server result. Every later root-side resolution first fetches the exact remote tag/object; local and remote tag objects plus peeled commits must match exactly without force or overwrite.
13. Publication creates at most one open PR for the evidence head branch and reuses it after later pushes. The PR number, head branch/SHA, base, and state are exact; PR checks pass; immediately before merge a fresh `origin/main` SHA must still equal the evidence's pinned live-main SHA; the merge uses `--match-head-commit`. These client checks narrow and detect races but are not atomic base protection. The fetched server result must be a two-parent merge whose first parent equals the pinned base, whose second parent equals the pinned PR head exactly, whose tree equals the pinned PR-head tree exactly, and whose OID equals GitHub's reported merge commit.
14. Root cleanup begins only when mutable `origin/main` equals the generation-bound accepted-main tag exactly, its second parent and tree equal the sealed gate head and tree exactly, refreshed backup verification, no-writer proof, source reachability, policy reconciliation, and full gates on that exact tree are proven. A descendant or merely ancestor-containing second parent is insufficient. Any advance or parent/tree mismatch starts a new exact-main clean-checkout equivalence/full-gate/evidence acceptance cycle; old sealed compose gates cannot authorize the new main.
15. Root tracked cleanup restores all 11 tracked dirty paths from the root rescue branch's current index/HEAD, not from `origin/main`. For the clean-root switch, archive and final fetch/tag/status checks finish first; writer detection and neutral-cwd whole-root `lsof` are repeated last, followed immediately by the switch to exact accepted `main` with no intervening operation.
16. The untracked migration is removed only after byte comparison and hash verification against the refreshed backup and accepted-main evidence for the improved migration.
17. Every worktree is classified before cleanup; dirty external worktrees are made tracked/untracked-clean only after each working file's accepted provenance is proven. Ignored/private cleanliness is never inferred from porcelain.
18. Every destructive root, prod-fix, worktree, checkout, and branch action runs in an operator-exclusive window with a named sentinel, immediate exact-main/status/hash/byte/archive checks, owner-only preimage, and read-only process/lsof evidence. Private-name manifests are NUL-delimited and consumed by macOS BSD tar with `--null -b 1`, preserving leading-option and embedded-newline names verbatim while keeping streamed archive hashes comparable. Before any whole-target `lsof +D`, the executing shell verifies and enters `/private/tmp`, proves that cwd is outside the target, and stays there while target operations use `git -C` or absolute paths; no arbitrary handle is filtered away to compensate for a self-count. For worktree and independent-checkout deletion, after the last fetch/tag/ref check the same block repeats tracked/untracked status, ignored/untracked names, archive integrity, live-byte equivalence to the owner-only preimage, exact accepted main, and writer/open-handle checks, then immediately performs the normal non-forced removal with no intervening writer, fetch, tag, or ref command. These guards narrow races but are not claimed as magical locks.
19. Secrets and private artifact contents are omitted. No stash, broad `git add .`, destructive reset, force push, forced worktree removal, or deletion of unpreserved unique/private content is used.

## 5. Non-Goals

- Do not change credentials, environment values, or private local artifacts during recovery.
- Do not deploy from the dirty root or any unreviewed external worktree.
- Do not require byte identity between the original rescue inventory and the improved reviewed result.
- Do not silently accept snapshot, branch-tip, inventory, live-main, test, or PR-head drift.
- Do not remove the refreshed external snapshot.

## 6. Recovery Slice Contracts

### 6.1 Session Baseline

Only `tests/aais-session-revocations.test.ts` changes. Fixed times make revocation checks deterministic; production session behavior does not change. The refreshed root copy already matches recorded `origin/main`, but the exact reviewed source commit is still preserved in compose history.

### 6.2 Locked-Task Guard

- `src/lib/server/aais-learning-store.ts` rejects completion, scaffolding, AI acceptance, and mutable task operations against locked tasks.
- `src/app/api/learning/scaffold/route.ts` returns redacted `AAIS_TASK_LOCKED` behavior.
- `tests/aais-backend-store.test.ts` and `tests/aais-api-routes.test.ts` prove state remains unchanged and routes cannot bypass sequencing.

### 6.3 Durable Daily Guide Budget

The reviewed eight paths remain:

- `migrations/postgres/0008_ai_guide_daily_usage.sql`
- `src/app/api/learning/ai-guide/route.ts`
- `src/lib/server/aais-learning-store.ts`
- `tests/aais-api-routes.test.ts`
- `tests/aais-backend-store.test.ts`
- `tests/postgres-migrations.test.mjs`
- `tests/readiness-route.test.ts`
- `docs/privacy-data-inventory.md`

Required behavior remains:

- atomic Postgres reservation keyed by student and UTC day;
- fallback only for undefined-table SQLSTATE `42P01`; other database failures propagate;
- missing-table-safe learner deletion with non-`42P01` propagation;
- request validation before reservation;
- current UTC-day idempotent, non-lowering backfill from `aais_events.event_time`;
- readiness requires the new table;
- privacy inventory covers the counter;
- JSON and stream responses use the reserved budget.

The file/memory and missing-table fallback is sequential, single-process best-effort. It is not atomic and must not be described as bounded concurrency enforcement.

### 6.4 LRS Outbox Hardening

The reviewed four paths remain:

- `src/lib/server/aais-learning-store.ts`
- `src/lib/server/aais-lrs-client.ts`
- `tests/aais-backend-store.test.ts`
- `tests/aais-lrs-client.test.ts`

Required behavior remains per-row runtime parsing, valid/invalid isolation, mixed-batch delivery, `redacted:invalid_event` versus `redacted:delivery_error`, pending valid rows when not configured, database-error propagation, prototype-safe `Object.hasOwn`, strict payload/timestamp/detail validation, exhaustive event mapping, and the explicit standard `completed` verb.

### 6.5 Bobie Production Learner Fallback

The reviewed source slice changes exactly:

- `src/lib/server/aais-trial-accounts.ts`
- `tests/auth-route.test.ts`

It preserves built-in Bobie and Phoebe learner authentication in production when configured trial accounts are missing, merges built-in learners with valid configured student accounts, rejects invalid configuration, rejects production educator trial configuration, respects `AAIS_TRIAL_LOGIN_ENABLED=false`, and keeps responses redacted.

The merge order makes built-in Bobie/Phoebe records authoritative over configured records with the same identifiers. That precedence is intentional for this recovery and must be documented and directly tested in compose. The reviewed test says teachers and admins are refused but exercises only a teacher account; compose must add a separate admin-role denial regression.

## 7. Production Trial Policy Reconciliation

Before release, compose creates one separate policy-regression commit after merging the frozen Bobie slice. Its six independent exact test names are:

1. `refuses trial account login when the trial-login entry is disabled`
2. `keeps Bobie and Phoebe available as production learner fallbacks`
3. `keeps a unique configured learner available alongside production fallbacks`
4. `keeps built-in credentials authoritative for duplicate Bobie and Phoebe identifiers`
5. `refuses production teacher trial accounts`
6. `refuses production admin trial accounts`

The distinct blocked-credential smoke test retains the exact name `optionally proves a known demo credential is rejected without setting a session cookie`. The accepted documentation sentences are exact:

```text
Production may use the built-in Bobie and Phoebe learner fallback while trial login is enabled; set `AAIS_TRIAL_LOGIN_ENABLED=false` to disable all trial login. Production teacher and admin trial identities are forbidden and must use database users or OIDC identities.
Bobie and Phoebe are valid production learner fallbacks while trial login is enabled; never use them as blocked smoke credentials.
Use `retired-demo-account` only for the blocked-credential check and supply its retired password through `AAIS_SMOKE_BLOCKED_TRIAL_PASSWORD`.
- [ ] Production smoke proves Bobie and Phoebe or a dedicated learner can sign in and the distinct `retired-demo-account` credential is rejected without a session cookie.
```

The first line belongs to `README.md`, the next two to `OPERATIONS.md`, and the
checklist line appears exactly twice in `docs/release-checklist.md`, replacing
the old Staging and Production smoke lines. This yields the following exact
edits:

- `README.md:15`: replace the statement that production excludes built-in learners with the accepted production learner-fallback policy and trial-login disable control.
- `OPERATIONS.md:50`: stop using Bobie as the blocked/retired smoke account; use the distinct identifier `retired-demo-account` with an operator-supplied retired password.
- `docs/release-checklist.md:25` and the production smoke item: require positive Bobie/Phoebe or dedicated learner smoke plus rejection of a distinct retired identifier.
- `tests/auth-route.test.ts`: establish all six independently named policy cases above.

This compose policy commit does not alter the frozen two-path Bobie source commit. It is created exactly once. Late-main refreshes reassert every accepted sentence and test name without replaying the initial contradictory-drift check or creating an empty duplicate commit.

## 8. Evidence Scope

The checked-in artifact is:

`docs/superpowers/recovery/2026-07-10-aais-dirty-inventory-equivalence.md`

It uses exact `key=value` lines and delimited sorted-set sections. It covers:

- the 11 tracked root paths and untracked migration from the refreshed inventory;
- the original four-slice reviewed path contracts;
- `tests/readiness-route.test.ts` and `docs/privacy-data-inventory.md`;
- the two Bobie source paths;
- `README.md`, `OPERATIONS.md`, and `docs/release-checklist.md` policy reconciliation;
- all five exact source commits plus the reviewed docs tag name, tag object, commit, and tree;
- the refreshed snapshot directory, mode, five recorded patch hashes, migration hash, and final Bobie commit-versus-base patch hash;
- all registered worktrees and their unique/duplicate/dirty provenance;
- every intentional deviation from root rescue content;
- live `origin/main` before publication and before cleanup;
- predecessor evidence tip and generation, with first generation fixed to `1`
  from predecessor `NONE`/`0` and every later generation proven as exact `+1`;
- actual focused/full Vitest totals, Playwright totals, and each gate status captured from machine-readable output;
- a pre-evidence compose tip and generation-specific final-head binding tag. Because a commit cannot contain its own SHA without circularity, the annotated seal tag created after the evidence commit is the immutable actual-final-head binding;
- generation-specific accepted-main binding tag, publication branch, and
  optional independent acceptance-checkout path;
- explicit conclusions that no rescued behavior was lost and secret values were omitted.

Evidence assertions parse each key exactly once and compare it with live Git/test values. Before a late evidence edit, the workflow captures the old generation from `git show HEAD:<evidence-path>`; both before and after the evidence commit it proves the new integer is exactly old plus one. Inventory, worktree, deviation, and test-file sections are compared as exact sorted sets. Cleanup re-runs the same structured gate capture and revalidates the pinned prepublication main/root hashes, docs tag, policy tip, final seal tag, inventories, and counts; PASS text alone is never sufficient. Multi-command shell blocks use `set -euo pipefail`, avoid zsh's reserved `path` variable, and stop on mismatch.

## 9. Integration, Publication, and Root Closure

Compose begins only after all five slice tips and the reviewer-supplied docs SHA are frozen, with the docs SHA bound to the annotated reviewed-docs tag. It merges each source commit with `--no-ff`, preserves shared-file behavior during conflict resolution, commits Bobie policy/test reconciliation once, fetches and integrates live `origin/main`, then repeats equivalence and every gate.

Before initial equivalence and on every repeated Task 5 pass, live main is
fetched and captured again. It must descend from the snapshot-time main and be
an ancestor of compose before comparisons are recorded. A legitimate forward
advance redirects through the idempotent live-main integration and restarts all
Task 5 comparisons; it is not rejected merely because it differs from the
historical snapshot SHA. A backward, rewritten, or unrelated ref stops.

Immediately before publication, live main is fetched again. Any forward
advance from the evidence-pinned main is merged into compose through an
idempotent refresh flow that reasserts the already-accepted policy, captures
the predecessor evidence generation, recomputes dynamic evidence, proves the
next generation is exactly predecessor plus one, and reruns gates without
replaying the initial drift check or making another policy commit. A
generation-specific annotated seal tag pins the resulting actual head in the
active publication repository recorded by evidence. Initial compose and a
later independent acceptance clone are separate object stores, so every
evidence/tagging step derives and verifies that repository explicitly; final
tagging and push never delegate a clone-only head to the root object store.

Publication queries all open PRs for the evidence-pinned head branch, fails on more than one or an unexpected base/head/state, reuses the exact main-targeting PR when present, and calls `gh pr create` only when none exists. Each later evidence head is pushed to that branch, so the existing PR updates and checks rerun. Reviewed-docs and final-head annotated tags are published with exact remote object/peeled verification before mutable branches can be deleted. After every `gh pr checks --watch`, the workflow fetches `origin/main` immediately before merge and compares its exact SHA with the evidence's `reviewed_live_main_sha`. A difference returns to the idempotent late-main integration/evidence/gate/push loop and reuses the PR again.

The pre-merge fetch and client SHA comparison narrow and detect races but are
not atomic base protection; a server-side advance remains possible. After the
server merge, the actual commit must have the exact pinned first parent, the
exact sealed head as its second parent, the exact sealed-head tree, and the OID
reported by GitHub. Only that proven result receives and publishes the
generation-specific accepted-main tag. If base, parent, tree, or OID differs,
cleanup remains blocked: an independent clean checkout at exact actual main
reruns root equivalence and all gates on that exact tree, increments structured
evidence, publishes an evidence-only acceptance PR, and creates a new
accepted-main tag only after the same exact post-merge checks pass. This repeats
until mutable main equals the exact newly tested tag.

Root cleanup never restores tracked files directly from improved `origin/main`. After accepted main contains every rescued behavior and evidence is complete, the 11 tracked dirty paths are restored from the root's current rescue index/HEAD. Status must then contain only the backed-up untracked migration. After migration comparison/hash and accepted-main checks, that untracked copy is removed. Only a clean `codex/aais-enterprise-standard` root may create local tracking `main`, which updates the index/worktree to accepted main.

## 10. Worktree Cleanup and Failure Policy

Before removing any worktree or independent acceptance checkout:

1. fetch and require current main equals the accepted-main tag exactly;
2. verify the refreshed snapshot, preimage archives, and exact worktree inventory;
3. prove all five source commits, docs tip, policy reconciliation, and evidence commits are reachable;
4. verify reviewed-docs/final/accepted remote annotated tag objects and peeled commits;
5. enter the named operator-exclusive window, move the executing shell to the
   verified neutral directory outside every target, and prove no writer/open
   handle without filtering away the shell or arbitrary processes;
6. prove exact tracked/untracked status and accepted provenance for every dirty file;
7. re-inventory ignored names with NUL-delimited manifests, compare the
   private/unknown archive preimage using the verified BSD-tar
   `--null -b 1` contract, and preserve root private state untouched;
8. after the last fetch/tag/ref check, repeat exact main, tracked/untracked
   status, ignored/untracked name inventory, archive integrity, and live-byte
   equivalence to the owner-only preimage, then repeat writer/open-handle checks
   and immediately perform normal non-forced removal without an intervening
   writer, fetch, tag, or ref command.

For `/private/tmp/aais-bobie-prod-fix-20260710`, the three dirty working files are compared byte-for-byte with accepted commit `42e92a483842a2a601ecbdb10794a90c1f3eba1f`. Only after exact accepted-main, private archive, last-moment preimage, status/hash, and writer checks may those files be restored from the worktree's current index to make its tracked/untracked state clean. Ignored `.aais-data` and `.vercel` remain until normal removal and are never inferred clean from porcelain. Any mismatch preserves the worktree and stops cleanup.

Merge shape, exact accepted-main, evidence, inventory, snapshot, archive,
remote-tag, gate, PR-head, or provenance mismatch is a hard stop. No cleanup
step may convert ignored/private or unknown content into an assumed duplicate.

## 11. Ownership

- S07 owns AI guide behavior.
- S12 owns backend storage, auth, API error handling, migrations, and LRS delivery.
- S11 owns focused/full verification and policy regression evidence.
- S22 owns live-main refresh, worktree provenance, publication, root closure, and release-readiness evidence.

Cross-owner files are validated together in compose before release.
