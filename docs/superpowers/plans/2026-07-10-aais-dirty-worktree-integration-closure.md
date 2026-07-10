# AAIS Dirty Worktree Integration and Closure Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Integrate the four reviewed recovery commits in a clean worktree, prove equivalence and full quality gates, merge through GitHub, and restore the AAIS root checkout to a clean local `main`.

**Architecture:** The design branch supplies governance documentation; four isolated branches supply one commit each. A compose worktree merges them without rewriting their commit SHAs, performs narrow-to-broad verification, and becomes the only publication source; the dirty root is cleaned only after the accepted commits are reachable from remote `main`.

**Tech Stack:** Git worktrees, GitHub CLI, TypeScript, Next.js, Vitest, Playwright, PostgreSQL migrations, npm.

---

### Task 1: Verify all prerequisite commits

**Files:**
- Reference: `docs/superpowers/specs/2026-07-10-aais-dirty-worktree-recovery-design.md`
- Reference: `docs/superpowers/plans/2026-07-10-aais-session-revocation-baseline.md`
- Reference: `docs/superpowers/plans/2026-07-10-aais-locked-task-guard.md`
- Reference: `docs/superpowers/plans/2026-07-10-aais-daily-guide-budget.md`
- Reference: `docs/superpowers/plans/2026-07-10-aais-lrs-outbox-hardening.md`

- [ ] **Step 1: Confirm every source worktree is clean**

Run from `/Users/dongpinhu/Desktop/AAIS`:

```bash
for path in \
  .worktrees/aais-worktree-recovery-design \
  .worktrees/aais-session-revocation-test \
  .worktrees/aais-locked-task-guard \
  .worktrees/aais-daily-guide-budget \
  .worktrees/aais-lrs-outbox-hardening
do
  git -C "$path" status --short --branch
done
```

Expected: each branch header is printed with no modified, staged, or untracked files.

- [ ] **Step 2: Verify exact commit subjects**

```bash
git log -1 --format='%s' codex/aais-session-revocation-test
git log -1 --format='%s' codex/aais-locked-task-guard
git log -1 --format='%s' codex/aais-daily-guide-budget
git log -1 --format='%s' codex/aais-lrs-outbox-hardening
```

Expected, in order:

```text
test: make session revocation checks time deterministic
fix: reject mutations against locked learning tasks
fix: reserve durable daily AI guide usage
fix: harden LRS outbox delivery failures
```

- [ ] **Step 3: Re-run each slice's focused acceptance test**

```bash
git -C .worktrees/aais-session-revocation-test status --porcelain=v1
git -C .worktrees/aais-locked-task-guard status --porcelain=v1
git -C .worktrees/aais-daily-guide-budget status --porcelain=v1
git -C .worktrees/aais-lrs-outbox-hardening status --porcelain=v1

(cd .worktrees/aais-session-revocation-test && npx vitest run tests/aais-session-revocations.test.ts)
(cd .worktrees/aais-locked-task-guard && npx vitest run tests/aais-backend-store.test.ts tests/aais-api-routes.test.ts -t "locked task")
(cd .worktrees/aais-daily-guide-budget && npx vitest run tests/aais-api-routes.test.ts tests/aais-backend-store.test.ts tests/postgres-migrations.test.mjs)
(cd .worktrees/aais-lrs-outbox-hardening && npx vitest run tests/aais-lrs-client.test.ts tests/aais-backend-store.test.ts)
```

Expected: all focused commands pass; if any fails, stop and return to the owning slice plan.

### Task 2: Create and populate the compose worktree

**Files:**
- Integrate: `.gitignore`
- Integrate: `docs/superpowers/specs/2026-07-10-aais-dirty-worktree-recovery-design.md`
- Integrate: `docs/superpowers/plans/*.md`
- Integrate: all four slice commits

- [ ] **Step 1: Create compose from the current design/plan tip**

```bash
DESIGN_TIP=$(git rev-parse codex/aais-worktree-recovery-design)
git worktree add .worktrees/aais-recovery-compose \
  -b codex/aais-recovery-compose "$DESIGN_TIP"
```

Expected: compose contains `.worktrees/` ignore policy, the approved spec, and all committed plan documents.

- [ ] **Step 2: Install dependencies**

```bash
cd /Users/dongpinhu/Desktop/AAIS/.worktrees/aais-recovery-compose
npm install
git status --short --branch
```

Expected: installation succeeds with zero vulnerabilities and the worktree remains clean.

- [ ] **Step 3: Merge the baseline and locked-task branches without rewriting commits**

```bash
git merge --no-ff codex/aais-session-revocation-test \
  -m "merge: integrate deterministic revocation tests"
git merge --no-ff codex/aais-locked-task-guard \
  -m "merge: integrate locked task guards"
```

Expected: both commits apply cleanly.

- [ ] **Step 4: Merge the daily-budget branch**

```bash
git merge --no-ff codex/aais-daily-guide-budget \
  -m "merge: integrate durable daily guide budget"
```

Expected: migration `0008`, guide route changes, store reservation, and daily-budget tests apply.

- [ ] **Step 5: Merge the LRS branch and resolve only the known shared import if needed**

```bash
git merge --no-ff codex/aais-lrs-outbox-hardening \
  -m "merge: integrate LRS outbox hardening"
```

If Git reports a conflict in `tests/aais-backend-store.test.ts`, the resolved import must contain exactly one `type AaisDatabaseClient` entry, while the file must retain all locked-task, daily-budget, and poison-outbox tests. Then run:

```bash
git add -- tests/aais-backend-store.test.ts
git diff --cached --check
git commit --no-edit
```

Do not resolve a source-code conflict by choosing an entire `ours` or `theirs` file. Preserve both non-overlapping behavioral slices.

- [ ] **Step 6: Inspect the integrated history and worktree**

```bash
git log --oneline --decorate --graph -16
git status --short --branch
git diff --check codex/aais-worktree-recovery-design..HEAD
```

Expected: all four exact commit subjects are present, the worktree is clean, and diff-check is silent.

### Task 3: Prove recovered-path equivalence

**Files:**
- Compare: `src/app/api/learning/ai-guide/route.ts`
- Compare: `src/app/api/learning/scaffold/route.ts`
- Compare: `src/lib/server/aais-learning-store.ts`
- Compare: `src/lib/server/aais-lrs-client.ts`
- Compare: `tests/aais-api-routes.test.ts`
- Compare: `tests/aais-backend-store.test.ts`
- Compare: `tests/aais-lrs-client.test.ts`
- Compare: `tests/postgres-migrations.test.mjs`
- Compare: `migrations/postgres/0008_ai_guide_daily_usage.sql`

- [ ] **Step 1: Confirm the external snapshot still matches the root inventory**

Run from `/Users/dongpinhu/Desktop/AAIS`:

```bash
git diff --binary | shasum -a 256
shasum -a 256 \
  /Users/dongpinhu/Desktop/AAIS-dirty-worktree-backups/20260710-101016-worktree-recovery/tracked-changes.patch
cmp -s \
  migrations/postgres/0008_ai_guide_daily_usage.sql \
  /Users/dongpinhu/Desktop/AAIS-dirty-worktree-backups/20260710-101016-worktree-recovery/untracked/migrations/postgres/0008_ai_guide_daily_usage.sql
```

Expected: both patch hashes are identical and `cmp` exits `0`.

- [ ] **Step 2: Compare all nine recovered paths**

```bash
ROOT=/Users/dongpinhu/Desktop/AAIS
COMPOSE=/Users/dongpinhu/Desktop/AAIS/.worktrees/aais-recovery-compose
for path in \
  src/app/api/learning/ai-guide/route.ts \
  src/app/api/learning/scaffold/route.ts \
  src/lib/server/aais-learning-store.ts \
  src/lib/server/aais-lrs-client.ts \
  tests/aais-api-routes.test.ts \
  tests/aais-backend-store.test.ts \
  tests/aais-lrs-client.test.ts \
  tests/postgres-migrations.test.mjs \
  migrations/postgres/0008_ai_guide_daily_usage.sql
do
  diff -u "$ROOT/$path" "$COMPOSE/$path" || exit 1
done
```

Expected: no diff output. If a path differs, stop composition and fix the owning slice branch; do not hide the mismatch in a compose-only correction.

### Task 4: Run clean-source verification gates

**Files:**
- Verify: entire compose worktree

- [ ] **Step 1: Run the combined focused suite**

```bash
cd /Users/dongpinhu/Desktop/AAIS/.worktrees/aais-recovery-compose
npx vitest run \
  tests/aais-session-revocations.test.ts \
  tests/aais-api-routes.test.ts \
  tests/aais-backend-store.test.ts \
  tests/aais-lrs-client.test.ts \
  tests/postgres-migrations.test.mjs
```

Expected: all five files pass.

- [ ] **Step 2: Run the repository CI command**

```bash
npm run ci
```

Expected: lint, type-check, all Vitest files, and the Next.js production build pass.

- [ ] **Step 3: Run browser E2E**

```bash
npm run e2e
```

Expected: every configured Playwright project passes. If the browser runtime is missing, install the repository-declared Playwright browser once and rerun the same command; do not weaken or skip tests.

- [ ] **Step 4: Run strict hygiene and final diff checks**

```bash
npm run hygiene:check
git diff --check
git status --porcelain=v1 -uall
```

Expected: hygiene reports `passed`, diff-check is silent, and status prints nothing.

### Task 5: Refresh, publish, and merge the reviewed compose branch

**Files:**
- Publish: branch `codex/aais-recovery-compose`
- Target: `main`

- [ ] **Step 1: Refresh live main and revalidate if it advanced**

```bash
git fetch origin main
if ! git merge-base --is-ancestor origin/main HEAD; then
  git merge --no-ff origin/main -m "merge: refresh recovery base from main"

  ROOT=/Users/dongpinhu/Desktop/AAIS
  for path in \
    src/app/api/learning/ai-guide/route.ts \
    src/app/api/learning/scaffold/route.ts \
    src/lib/server/aais-learning-store.ts \
    src/lib/server/aais-lrs-client.ts \
    tests/aais-api-routes.test.ts \
    tests/aais-backend-store.test.ts \
    tests/aais-lrs-client.test.ts \
    tests/postgres-migrations.test.mjs \
    migrations/postgres/0008_ai_guide_daily_usage.sql
  do
    diff -u "$ROOT/$path" "$PWD/$path" || exit 1
  done

  npx vitest run \
    tests/aais-session-revocations.test.ts \
    tests/aais-api-routes.test.ts \
    tests/aais-backend-store.test.ts \
    tests/aais-lrs-client.test.ts \
    tests/postgres-migrations.test.mjs
  npm run ci
  npm run e2e
  npm run hygiene:check
  git diff --check
  test -z "$(git status --porcelain=v1 -uall)"
fi
```

Expected: either `origin/main` was already an ancestor, or the refresh merge and every repeated equivalence/quality gate pass. A conflict or path mismatch stops publication.

- [ ] **Step 2: Verify remote identity and ancestry before publication**

```bash
gh repo view HUDongpin/AAIS --json nameWithOwner,defaultBranchRef,url
git ls-remote origin refs/heads/main
git merge-base --is-ancestor origin/main HEAD
```

Expected: repository is `HUDongpin/AAIS`, default branch is `main`, and current remote main is an ancestor of compose.

- [ ] **Step 3: Push the compose branch**

```bash
git push -u origin codex/aais-recovery-compose
```

Expected: push succeeds and upstream tracking is configured.

- [ ] **Step 4: Create a reviewable PR**

```bash
gh pr create \
  --base main \
  --head codex/aais-recovery-compose \
  --title "Recover AAIS dirty integration inventory" \
  --body "Recovers the AAIS dirty integration inventory as four reviewable commits: deterministic session-revocation tests, locked-task mutation guards, durable daily guide budgeting with migration 0008, and LRS outbox hardening. Validation: npm run ci, npm run e2e, npm run hygiene:check, git diff --check."
```

Expected: GitHub returns a PR URL targeting `main`.

- [ ] **Step 5: Wait for checks and review the exact PR state**

```bash
gh pr checks codex/aais-recovery-compose --watch
gh pr view codex/aais-recovery-compose --json mergeStateStatus,reviewDecision,statusCheckRollup,url
```

Expected: required checks are successful and merge state is not blocked by conflicts.

- [ ] **Step 6: Merge without squashing the reviewable commits**

```bash
gh pr merge codex/aais-recovery-compose --merge
git fetch origin main
```

Expected: the PR is merged and `origin/main` contains the compose tip through a merge commit. The remote compose branch remains until local closure is proven.

### Task 6: Close the dirty root checkout safely

**Files:**
- Clean tracked root paths: the eight modified paths listed in Task 3
- Reconcile untracked root path: `migrations/postgres/0008_ai_guide_daily_usage.sql`
- Preserve: `/Users/dongpinhu/Desktop/AAIS-dirty-worktree-backups/20260710-101016-worktree-recovery`

- [ ] **Step 1: Prove the accepted mainline contains every recovered path**

Run from `/Users/dongpinhu/Desktop/AAIS`:

```bash
git fetch origin main
for path in \
  src/app/api/learning/ai-guide/route.ts \
  src/app/api/learning/scaffold/route.ts \
  src/lib/server/aais-learning-store.ts \
  src/lib/server/aais-lrs-client.ts \
  tests/aais-api-routes.test.ts \
  tests/aais-backend-store.test.ts \
  tests/aais-lrs-client.test.ts \
  tests/postgres-migrations.test.mjs
do
  git show "origin/main:$path" | cmp -s - "$path" || exit 1
done
git show origin/main:migrations/postgres/0008_ai_guide_daily_usage.sql | \
  cmp -s - migrations/postgres/0008_ai_guide_daily_usage.sql
```

Expected: every comparison exits `0`. If any comparison fails, stop without cleaning the root.

- [ ] **Step 2: Confirm no writer is using the root checkout**

```bash
ps -Ao pid=,ppid=,etime=,command= | \
  rg '/Users/dongpinhu/Desktop/AAIS' | \
  rg -v '/\.worktrees/|rg ' || true
```

Expected: no active build, test, dev server, or agent process is writing root source files.

- [ ] **Step 3: Restore tracked paths from accepted `origin/main`**

```bash
git restore --source=origin/main --worktree -- \
  src/app/api/learning/ai-guide/route.ts \
  src/app/api/learning/scaffold/route.ts \
  src/lib/server/aais-learning-store.ts \
  src/lib/server/aais-lrs-client.ts \
  tests/aais-api-routes.test.ts \
  tests/aais-backend-store.test.ts \
  tests/aais-lrs-client.test.ts \
  tests/postgres-migrations.test.mjs
```

Expected: all eight tracked dirty entries disappear from `git status --short`.

- [ ] **Step 4: Remove only the verified duplicate untracked migration**

```bash
rm -- migrations/postgres/0008_ai_guide_daily_usage.sql
git status --short --branch
```

This removal is authorized only because Step 1 proved byte identity with `origin/main` and the external copy remains intact. Expected: the untracked migration disappears.

- [ ] **Step 5: Create the local tracking `main` branch**

```bash
git switch -c main --track origin/main
git rev-list --left-right --count main...origin/main
git status --porcelain=v1 -uall
```

Expected: branch is `main`, divergence is `0 0`, and status prints nothing.

- [ ] **Step 6: Verify developer-root hygiene without touching private artifacts**

```bash
npm run hygiene:check -- --allow-local-private-artifacts
git check-ignore -v \
  .env \
  .env.local \
  "All API Keys.docx" \
  .aais-data \
  .vercel \
  .next \
  output \
  node_modules
```

Expected: hygiene passes for a clean Git worktree, and every owner-approved local path remains ignored.

### Task 7: Remove merged temporary worktrees and branches

**Files:**
- Remove only merged linked worktrees and local feature branches
- Preserve external recovery snapshot

- [ ] **Step 0: Move the shell to the retained root checkout**

```bash
cd /Users/dongpinhu/Desktop/AAIS
```

Expected: `pwd` resolves to the root checkout, not to a linked worktree that will be removed.

- [ ] **Step 1: Confirm all feature commits are reachable from `main`**

```bash
for branch in \
  codex/aais-worktree-recovery-design \
  codex/aais-session-revocation-test \
  codex/aais-locked-task-guard \
  codex/aais-daily-guide-budget \
  codex/aais-lrs-outbox-hardening \
  codex/aais-recovery-compose
do
  git merge-base --is-ancestor "$branch" main || exit 1
done
```

Expected: all branches are ancestors of `main`.

- [ ] **Step 2: Confirm every temporary worktree is clean**

```bash
git worktree list --porcelain
for path in .worktrees/*; do
  git -C "$path" status --porcelain=v1 -uall || exit 1
done
```

Expected: every retained temporary worktree reports no changes.

- [ ] **Step 3: Remove the linked worktrees without force**

```bash
for path in \
  .worktrees/aais-session-revocation-test \
  .worktrees/aais-locked-task-guard \
  .worktrees/aais-daily-guide-budget \
  .worktrees/aais-lrs-outbox-hardening \
  .worktrees/aais-recovery-compose \
  .worktrees/aais-worktree-recovery-design
do
  git worktree remove "$path"
done
```

Expected: every clean worktree is removed; Git refuses rather than discards if any unexpected change exists.

- [ ] **Step 4: Delete only merged local branches and prune metadata**

```bash
git branch -d \
  codex/aais-enterprise-standard \
  codex/aais-worktree-recovery-design \
  codex/aais-session-revocation-test \
  codex/aais-locked-task-guard \
  codex/aais-daily-guide-budget \
  codex/aais-lrs-outbox-hardening \
  codex/aais-recovery-compose
git push origin --delete codex/aais-recovery-compose
git worktree prune
git worktree list --porcelain
git stash list
git status --short --branch
```

Expected: only the clean root `main` worktree remains, the stash list is empty, and the external recovery snapshot still exists.
