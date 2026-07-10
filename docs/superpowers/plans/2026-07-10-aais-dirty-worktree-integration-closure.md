# AAIS Dirty Worktree Integration and Closure Plan

> **For agentic workers:** Use the executing-plans workflow task by task. Every mismatch is a stop condition. Do not improvise cleanup around failed provenance.

**Goal:** Freeze and merge five reviewed source commits into a clean compose branch, reconcile production learner-trial policy, record exact refreshed equivalence, pass full gates, merge a pinned PR head, and close the root plus every temporary worktree without losing unique content.

**Architecture:** The design branch is frozen first. Compose merges each source commit with `--no-ff`, adds a separate Bobie policy/test commit, integrates live `origin/main`, records checked-in equivalence, and reruns all gates. Root and worktree cleanup begins only after the accepted PR merge is proven on `origin/main`.

**Shell contract:** Commands target zsh. Multi-command blocks begin with `set -euo pipefail`. Never use variable name `path`; use `file_path`, `wt`, or `branch_name`. Exact inventories use sorted-set `diff`. Evidence uses exactly-once `key=value` parsing and delimited exact-set assertions. No stash, reset, force push, forced removal, or broad `git add .` is permitted.

---

## Fixed Reviewed Source Inputs

| Slice | Branch/worktree | Exact commit | Exact subject |
| --- | --- | --- | --- |
| Session baseline | `codex/aais-session-revocation-test` | `5e803c669b955abba8a3f6c1c665c5543875a21a` | `test: make session revocation checks time deterministic` |
| Locked guard | `codex/aais-locked-task-guard` | `735011b3e002f6be46ff34f4a13c70834a69cfeb` | `fix: reject mutations against locked learning tasks` |
| Daily budget | `codex/aais-daily-guide-budget` | `ad2d5a05114b9f19297fcae4a232cc434c8b2f35` | `fix: reserve durable daily AI guide usage` |
| LRS hardening | `codex/aais-lrs-outbox-hardening` | `33af4c30100f4c0ea02b765709eb83123e7b10ff` | `fix: harden LRS outbox delivery failures` |
| Bobie fallback | `codex/aais-bobie-production-fallback`, `/private/tmp/aais-bobie-main-fix2-20260710` | `1d97d16998e95a92ebecb3a69a2ad14c9e0a566c` | `fix: preserve production learner trial fallback` |

Fresh reviewers return the synchronized docs commit SHA out of band; execution binds that literal once to the immutable annotated reviewed-docs tag. Compose must not start before all five source tips and that tagged docs tip are frozen.

### Task 1: Freeze source tips, docs tip, refreshed snapshot, and all current worktrees

- [ ] **Step 1: Verify exact registered worktree inventory before compose exists**

Run from `/Users/dongpinhu/Desktop/AAIS`:

```bash
set -euo pipefail
ROOT=/Users/dongpinhu/Desktop/AAIS
diff -u \
  <(printf '%s\n' \
    '/Users/dongpinhu/Desktop/AAIS' \
    '/Users/dongpinhu/Desktop/AAIS/.worktrees/aais-daily-guide-budget' \
    '/Users/dongpinhu/Desktop/AAIS/.worktrees/aais-locked-task-guard' \
    '/Users/dongpinhu/Desktop/AAIS/.worktrees/aais-lrs-outbox-hardening' \
    '/Users/dongpinhu/Desktop/AAIS/.worktrees/aais-session-revocation-test' \
    '/Users/dongpinhu/Desktop/AAIS/.worktrees/aais-worktree-recovery-design' \
    '/private/tmp/aais-bobie-main-deploy-20260710' \
    '/private/tmp/aais-bobie-main-fix2-20260710' \
    '/private/tmp/aais-bobie-prod-fix-20260710' | LC_ALL=C sort) \
  <(git -C "$ROOT" worktree list --porcelain | \
    sed -n 's/^worktree //p' | LC_ALL=C sort)
```

Expected: the exact nine-path set matches. Any additional or missing worktree is classified before proceeding.

- [ ] **Step 2: Verify the five source tips and subjects exactly**

```bash
set -euo pipefail
ROOT=/Users/dongpinhu/Desktop/AAIS
test "$(git -C "$ROOT" rev-parse codex/aais-session-revocation-test)" = \
  '5e803c669b955abba8a3f6c1c665c5543875a21a'
test "$(git -C "$ROOT" show -s --format='%s' 5e803c669b955abba8a3f6c1c665c5543875a21a)" = \
  'test: make session revocation checks time deterministic'
test "$(git -C "$ROOT" rev-parse codex/aais-locked-task-guard)" = \
  '735011b3e002f6be46ff34f4a13c70834a69cfeb'
test "$(git -C "$ROOT" show -s --format='%s' 735011b3e002f6be46ff34f4a13c70834a69cfeb)" = \
  'fix: reject mutations against locked learning tasks'
test "$(git -C "$ROOT" rev-parse codex/aais-daily-guide-budget)" = \
  'ad2d5a05114b9f19297fcae4a232cc434c8b2f35'
test "$(git -C "$ROOT" show -s --format='%s' ad2d5a05114b9f19297fcae4a232cc434c8b2f35)" = \
  'fix: reserve durable daily AI guide usage'
test "$(git -C "$ROOT" rev-parse codex/aais-lrs-outbox-hardening)" = \
  '33af4c30100f4c0ea02b765709eb83123e7b10ff'
test "$(git -C "$ROOT" show -s --format='%s' 33af4c30100f4c0ea02b765709eb83123e7b10ff)" = \
  'fix: harden LRS outbox delivery failures'
test "$(git -C "$ROOT" rev-parse codex/aais-bobie-production-fallback)" = \
  '1d97d16998e95a92ebecb3a69a2ad14c9e0a566c'
test "$(git -C "$ROOT" show -s --format='%s' 1d97d16998e95a92ebecb3a69a2ad14c9e0a566c)" = \
  'fix: preserve production learner trial fallback'
test "$(git -C "$ROOT" rev-parse 1d97d16998e95a92ebecb3a69a2ad14c9e0a566c^)" = \
  '42e92a483842a2a601ecbdb10794a90c1f3eba1f'
```

Expected: all assertions exit `0`.

- [ ] **Step 3: Verify exact source paths and tracked/untracked source status**

```bash
set -euo pipefail
ROOT=/Users/dongpinhu/Desktop/AAIS
diff -u \
  <(printf '%s\n' 'tests/aais-session-revocations.test.ts') \
  <(git -C "$ROOT" diff-tree --no-commit-id --name-only -r \
    5e803c669b955abba8a3f6c1c665c5543875a21a | LC_ALL=C sort)
diff -u \
  <(printf '%s\n' \
    'src/app/api/learning/scaffold/route.ts' \
    'src/lib/server/aais-learning-store.ts' \
    'tests/aais-api-routes.test.ts' \
    'tests/aais-backend-store.test.ts' | LC_ALL=C sort) \
  <(git -C "$ROOT" diff-tree --no-commit-id --name-only -r \
    735011b3e002f6be46ff34f4a13c70834a69cfeb | LC_ALL=C sort)
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
  <(git -C "$ROOT" diff-tree --no-commit-id --name-only -r \
    ad2d5a05114b9f19297fcae4a232cc434c8b2f35 | LC_ALL=C sort)
diff -u \
  <(printf '%s\n' \
    'src/lib/server/aais-learning-store.ts' \
    'src/lib/server/aais-lrs-client.ts' \
    'tests/aais-backend-store.test.ts' \
    'tests/aais-lrs-client.test.ts' | LC_ALL=C sort) \
  <(git -C "$ROOT" diff-tree --no-commit-id --name-only -r \
    33af4c30100f4c0ea02b765709eb83123e7b10ff | LC_ALL=C sort)
diff -u \
  <(printf '%s\n' \
    'src/lib/server/aais-trial-accounts.ts' \
    'tests/auth-route.test.ts' | LC_ALL=C sort) \
  <(git -C "$ROOT" diff-tree --no-commit-id --name-only -r \
    1d97d16998e95a92ebecb3a69a2ad14c9e0a566c | LC_ALL=C sort)
for wt in \
  "$ROOT/.worktrees/aais-session-revocation-test" \
  "$ROOT/.worktrees/aais-locked-task-guard" \
  "$ROOT/.worktrees/aais-daily-guide-budget" \
  "$ROOT/.worktrees/aais-lrs-outbox-hardening" \
  '/private/tmp/aais-bobie-main-fix2-20260710'
do
  test -z "$(git -C "$wt" status --porcelain=v1 -uall)"
done
```

Expected: every exact path set matches and all five source worktrees are
tracked/untracked-clean. This does not inspect or authorize deletion of ignored
content; Task 9 Step 6 handles that separately.

- [ ] **Step 4: Bind fresh review approval to an immutable documentation tag**

The docs cannot contain their own commit SHA without a circular hash. Fresh spec and quality review instead return the exact approved commit SHA out of band. The operator supplies that literal as `AAIS_REVIEWED_DOCS_SHA`; this step refuses to infer it from the mutable branch, verifies the reviewed five-path commit, and binds it to a single annotated tag. The no-force policy forbids moving or replacing that tag.

```bash
set -euo pipefail
ROOT=/Users/dongpinhu/Desktop/AAIS
DOCS_WT=/Users/dongpinhu/Desktop/AAIS/.worktrees/aais-worktree-recovery-design
DOCS_TAG=aais-recovery-docs-reviewed-20260710
REVIEWED_DOCS_SHA=${AAIS_REVIEWED_DOCS_SHA:-}
printf '%s\n' "$REVIEWED_DOCS_SHA" | grep -Eq '^[0-9a-f]{40}$'
test "$(git -C "$DOCS_WT" branch --show-current)" = \
  'codex/aais-worktree-recovery-design'
test "$(git -C "$DOCS_WT" rev-parse HEAD)" = "$REVIEWED_DOCS_SHA"
test "$(git -C "$DOCS_WT" show -s --format='%s' HEAD)" = \
  'docs: sync recovery plans with reviewed slices'
test -z "$(git -C "$DOCS_WT" status --porcelain=v1 -uall)"
diff -u \
  <(printf '%s\n' \
    'docs/superpowers/plans/2026-07-10-aais-bobie-production-fallback.md' \
    'docs/superpowers/plans/2026-07-10-aais-daily-guide-budget.md' \
    'docs/superpowers/plans/2026-07-10-aais-dirty-worktree-integration-closure.md' \
    'docs/superpowers/plans/2026-07-10-aais-lrs-outbox-hardening.md' \
    'docs/superpowers/specs/2026-07-10-aais-dirty-worktree-recovery-design.md' | LC_ALL=C sort) \
  <(git -C "$DOCS_WT" diff-tree --no-commit-id --name-only -r \
    "$REVIEWED_DOCS_SHA" | LC_ALL=C sort)
DOCS_TREE=$(git -C "$ROOT" show -s --format='%T' "$REVIEWED_DOCS_SHA")
printf '%s\n' "$DOCS_TREE" | grep -Eq '^[0-9a-f]{40}$'
if git -C "$ROOT" show-ref --verify --quiet "refs/tags/$DOCS_TAG"; then
  test "$(git -C "$ROOT" cat-file -t "$DOCS_TAG")" = 'tag'
  test "$(git -C "$ROOT" rev-parse "$DOCS_TAG^{commit}")" = \
    "$REVIEWED_DOCS_SHA"
  git -C "$ROOT" for-each-ref "refs/tags/$DOCS_TAG" \
    --format='%(contents)' | grep -Fqx \
    "reviewed_docs_sha=$REVIEWED_DOCS_SHA"
  git -C "$ROOT" for-each-ref "refs/tags/$DOCS_TAG" \
    --format='%(contents)' | grep -Fqx \
    "reviewed_docs_tree=$DOCS_TREE"
else
  git -C "$ROOT" tag -a "$DOCS_TAG" "$REVIEWED_DOCS_SHA" \
    -m "reviewed_docs_sha=$REVIEWED_DOCS_SHA" \
    -m "reviewed_docs_tree=$DOCS_TREE"
fi
DOCS_TAG_OBJECT=$(git -C "$ROOT" rev-parse "$DOCS_TAG^{tag}")
printf '%s\n' "$DOCS_TAG_OBJECT" | grep -Eq '^[0-9a-f]{40}$'
test "$(git -C "$ROOT" rev-parse codex/aais-worktree-recovery-design)" = \
  "$(git -C "$ROOT" rev-parse "$DOCS_TAG^{commit}")"
printf 'Reviewed docs tag: %s\nReviewed docs tag object: %s\nReviewed docs tip: %s\nReviewed docs tree: %s\n' \
  "$DOCS_TAG" "$DOCS_TAG_OBJECT" "$REVIEWED_DOCS_SHA" "$DOCS_TREE"
```

Expected: the reviewer-supplied SHA, annotated tag object, commit, and tree are printed. Every later docs-tip use resolves this tag and separately asserts that the branch has not drifted.

- [ ] **Step 5: Verify the refreshed snapshot files and hashes**

```bash
set -euo pipefail
SNAP=/Users/dongpinhu/Desktop/AAIS-dirty-worktree-backups/20260710-145253-worktree-recovery-refresh
test "$(stat -f '%Sp' "$SNAP")" = 'drwx------'
test "$(shasum -a 256 "$SNAP/root/tracked-vs-head.patch" | awk '{print $1}')" = \
  'e3c385c8c57ddf582dad07fd9596476e13a3dcd231c1fef4b93979865d2e3211'
test "$(shasum -a 256 "$SNAP/root/tracked-vs-origin-main.patch" | awk '{print $1}')" = \
  'bfc1c311ae90c8369d8feaa1bcbe69802b392cd5c7b259dddb23f8b6f8219b6c'
test "$(shasum -a 256 "$SNAP/private-worktrees/aais-bobie-main-fix2-vs-origin-main.patch" | awk '{print $1}')" = \
  '57b7f506362620e1c8f21eca9e15ec38482a70a957bcd975052f672e2a92ec74'
test "$(shasum -a 256 "$SNAP/private-worktrees/aais-bobie-prod-fix-vs-origin-main.patch" | awk '{print $1}')" = \
  'fe3bfd7c9d6709660033a1856bd549daec929da14f0aa230a7a4542716663460'
test "$(shasum -a 256 "$SNAP/private-worktrees/aais-bobie-main-deploy-vs-origin-main.patch" | awk '{print $1}')" = \
  'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855'
test "$(shasum -a 256 "$SNAP/root/untracked/migrations/postgres/0008_ai_guide_daily_usage.sql" | awk '{print $1}')" = \
  '5460251a5560635b4b39229b22b360465ccfbb40b60c1812b3df4d9252ca98ce'
```

Expected: mode and all six hashes match.

- [ ] **Step 6: Verify the recorded root inventory and patch hashes remain exact**

```bash
set -euo pipefail
ROOT=/Users/dongpinhu/Desktop/AAIS
SNAP=/Users/dongpinhu/Desktop/AAIS-dirty-worktree-backups/20260710-145253-worktree-recovery-refresh
SNAPSHOT_MAIN=42e92a483842a2a601ecbdb10794a90c1f3eba1f
test "$(git -C "$ROOT" branch --show-current)" = \
  'codex/aais-enterprise-standard'
test "$(git -C "$ROOT" rev-parse HEAD)" = \
  '2fd93838281581a6996f6f7a8a6bca0d8d95e420'
test "$(git -C "$ROOT" cat-file -t "$SNAPSHOT_MAIN")" = 'commit'
test "$(grep -Fxc "origin_main=$SNAPSHOT_MAIN" \
  "$SNAP/root/base-commit.txt")" -eq 1
test "$(grep -Fxc \
  'root_head=2fd93838281581a6996f6f7a8a6bca0d8d95e420' \
  "$SNAP/root/base-commit.txt")" -eq 1
diff -u \
  <(printf '%s\n' \
    ' M src/app/api/learning/ai-guide/route.ts' \
    ' M src/app/api/learning/scaffold/route.ts' \
    ' M src/lib/server/aais-learning-store.ts' \
    ' M src/lib/server/aais-lrs-client.ts' \
    ' M src/lib/server/aais-trial-accounts.ts' \
    ' M tests/aais-api-routes.test.ts' \
    ' M tests/aais-backend-store.test.ts' \
    ' M tests/aais-lrs-client.test.ts' \
    ' M tests/aais-session-revocations.test.ts' \
    ' M tests/auth-route.test.ts' \
    ' M tests/postgres-migrations.test.mjs' \
    '?? migrations/postgres/0008_ai_guide_daily_usage.sql' | LC_ALL=C sort) \
  <(git -C "$ROOT" status --porcelain=v1 -uall | LC_ALL=C sort)
test "$(git -C "$ROOT" diff --binary | shasum -a 256 | awk '{print $1}')" = \
  'e3c385c8c57ddf582dad07fd9596476e13a3dcd231c1fef4b93979865d2e3211'
test "$(git -C "$ROOT" diff --binary "$SNAPSHOT_MAIN" -- | shasum -a 256 | awk '{print $1}')" = \
  'bfc1c311ae90c8369d8feaa1bcbe69802b392cd5c7b259dddb23f8b6f8219b6c'
cmp -s \
  "$ROOT/migrations/postgres/0008_ai_guide_daily_usage.sql" \
  /Users/dongpinhu/Desktop/AAIS-dirty-worktree-backups/20260710-145253-worktree-recovery-refresh/root/untracked/migrations/postgres/0008_ai_guide_daily_usage.sql
cmp -s \
  "$ROOT/tests/aais-session-revocations.test.ts" \
  <(git -C "$ROOT" show \
    "$SNAPSHOT_MAIN:tests/aais-session-revocations.test.ts")
```

Expected: exact status and hashes match; snapshot metadata names the historical
main object; migration backup matches; session-revocation root copy matches
that snapshot-time main. This step never compares mutable `origin/main` with
the historical SHA. Any rescue-state drift stops composition and requires a
new snapshot/review.

- [ ] **Step 7: Verify the three external worktree states exactly**

```bash
set -euo pipefail
ROOT=/Users/dongpinhu/Desktop/AAIS
MAIN_DEPLOY=/private/tmp/aais-bobie-main-deploy-20260710
MAIN_FIX2=/private/tmp/aais-bobie-main-fix2-20260710
PROD_FIX=/private/tmp/aais-bobie-prod-fix-20260710
test "$(git -C "$MAIN_DEPLOY" rev-parse HEAD)" = \
  '42e92a483842a2a601ecbdb10794a90c1f3eba1f'
test -z "$(git -C "$MAIN_DEPLOY" branch --show-current)"
test -z "$(git -C "$MAIN_DEPLOY" status --porcelain=v1 -uall)"
test "$(git -C "$MAIN_DEPLOY" diff --binary \
  42e92a483842a2a601ecbdb10794a90c1f3eba1f -- | \
  shasum -a 256 | awk '{print $1}')" = \
  'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855'
test "$(git -C "$MAIN_FIX2" rev-parse HEAD)" = \
  '1d97d16998e95a92ebecb3a69a2ad14c9e0a566c'
test "$(git -C "$MAIN_FIX2" branch --show-current)" = \
  'codex/aais-bobie-production-fallback'
test -z "$(git -C "$MAIN_FIX2" status --porcelain=v1 -uall)"
test "$(git -C "$MAIN_FIX2" diff --binary \
  42e92a483842a2a601ecbdb10794a90c1f3eba1f..HEAD -- | \
  shasum -a 256 | awk '{print $1}')" = \
  '892d373fe7a71ebf0a216e126511501ec0642c198c14fea12e679b3079a98603'
test "$(git -C "$PROD_FIX" rev-parse HEAD)" = \
  '2fd93838281581a6996f6f7a8a6bca0d8d95e420'
test -z "$(git -C "$PROD_FIX" branch --show-current)"
diff -u \
  <(printf '%s\n' \
    ' M src/lib/server/aais-trial-accounts.ts' \
    ' M tests/aais-session-revocations.test.ts' \
    ' M tests/auth-route.test.ts' | LC_ALL=C sort) \
  <(git -C "$PROD_FIX" status --porcelain=v1 -uall | LC_ALL=C sort)
diff -u \
  <(printf '%s\n' '.gitignore') \
  <(git -C "$PROD_FIX" diff --name-only \
    42e92a483842a2a601ecbdb10794a90c1f3eba1f -- | LC_ALL=C sort)
test "$(git -C "$PROD_FIX" diff --binary \
  42e92a483842a2a601ecbdb10794a90c1f3eba1f -- | \
  shasum -a 256 | awk '{print $1}')" = \
  'fe3bfd7c9d6709660033a1856bd549daec929da14f0aa230a7a4542716663460'
```

Expected: both clean external worktrees match recorded tips; prod-fix has the exact three working changes and only `.gitignore` differs from recorded main after those accepted working files are considered.

### Task 2: Create compose only after all tips are frozen

- [ ] **Step 1: Create the compose branch from the frozen docs tip**

```bash
set -euo pipefail
ROOT=/Users/dongpinhu/Desktop/AAIS
DOCS_WT="$ROOT/.worktrees/aais-worktree-recovery-design"
DOCS_TAG=aais-recovery-docs-reviewed-20260710
test "$(git -C "$ROOT" cat-file -t "$DOCS_TAG")" = 'tag'
DOCS_TIP=$(git -C "$ROOT" rev-parse "$DOCS_TAG^{commit}")
DOCS_TAG_OBJECT=$(git -C "$ROOT" rev-parse "$DOCS_TAG^{tag}")
DOCS_TREE=$(git -C "$ROOT" show -s --format='%T' "$DOCS_TIP")
test "$(git -C "$DOCS_WT" rev-parse HEAD)" = "$DOCS_TIP"
test "$(git -C "$ROOT" rev-parse codex/aais-worktree-recovery-design)" = \
  "$DOCS_TIP"
test -z "$(git -C "$DOCS_WT" status --porcelain=v1 -uall)"
if git -C "$ROOT" show-ref --verify --quiet refs/heads/codex/aais-recovery-compose; then
  exit 1
fi
git -C "$ROOT" worktree add "$ROOT/.worktrees/aais-recovery-compose" \
  -b codex/aais-recovery-compose "$DOCS_TIP"
cd "$ROOT/.worktrees/aais-recovery-compose"
npm install
test "$(git rev-parse HEAD)" = "$DOCS_TIP"
printf 'Compose docs tag object: %s\nCompose docs tip: %s\nCompose docs tree: %s\n' \
  "$DOCS_TAG_OBJECT" "$DOCS_TIP" "$DOCS_TREE"
test -z "$(git status --porcelain=v1 -uall)"
```

Expected: compose starts exactly at the clean frozen docs tip.

- [ ] **Step 2: Merge all five reviewed commits with no-ff**

```bash
set -euo pipefail
git merge --no-ff 5e803c669b955abba8a3f6c1c665c5543875a21a \
  -m 'merge: integrate deterministic revocation tests'
git merge --no-ff 735011b3e002f6be46ff34f4a13c70834a69cfeb \
  -m 'merge: integrate locked task guards'
git merge --no-ff ad2d5a05114b9f19297fcae4a232cc434c8b2f35 \
  -m 'merge: integrate durable daily guide budget'
git merge --no-ff 33af4c30100f4c0ea02b765709eb83123e7b10ff \
  -m 'merge: integrate LRS outbox hardening'
git merge --no-ff 1d97d16998e95a92ebecb3a69a2ad14c9e0a566c \
  -m 'merge: integrate production learner trial fallback'
```

Expected: all merges complete. A conflict stops the block.

If shared files conflict, resolve by behavior with `apply_patch`. Preserve locked guards, daily reservation/readiness/privacy, per-row LRS handling, Bobie fallback, and all tests. Never choose whole-file `ours` or `theirs`. Stage only conflicted paths, run `git diff --cached --check`, and finish the existing merge with `git commit --no-edit`.

- [ ] **Step 3: Prove all five reviewed SHAs are preserved as merge parents**

```bash
set -euo pipefail
for sha in \
  5e803c669b955abba8a3f6c1c665c5543875a21a \
  735011b3e002f6be46ff34f4a13c70834a69cfeb \
  ad2d5a05114b9f19297fcae4a232cc434c8b2f35 \
  33af4c30100f4c0ea02b765709eb83123e7b10ff \
  1d97d16998e95a92ebecb3a69a2ad14c9e0a566c
do
  git merge-base --is-ancestor "$sha" HEAD
  git rev-list --parents --merges HEAD | \
    awk -v sha="$sha" \
      '{ for (i = 3; i <= NF; i += 1) if ($i == sha) found = 1 } END { exit !found }'
done
git diff --check
test -z "$(git status --porcelain=v1 -uall)"
```

Expected: each source SHA is reachable and appears as a non-first merge parent.

### Task 3: Reconcile Bobie production policy and missing regressions

- [ ] **Step 1: Verify recorded policy drift before editing**

```bash
set -euo pipefail
grep -Fqx \
  'Open `http://localhost:3000/login`. Local development can use built-in learner accounts; production excludes them.' \
  README.md
grep -Fq 'AAIS_SMOKE_BLOCKED_TRIAL_ACCOUNT=Bobie' OPERATIONS.md
grep -Fq 'retired-demo credential rejection' docs/release-checklist.md
```

Expected: all three recorded conflicts are present. If live content differs, stop and review the new policy text.

- [ ] **Step 2: Add and run the complete exact policy matrix**

Use `apply_patch` in `tests/auth-route.test.ts` so these exact independent test names exist:

1. `refuses trial account login when the trial-login entry is disabled`
2. `keeps Bobie and Phoebe available as production learner fallbacks`
3. `keeps a unique configured learner available alongside production fallbacks`
4. `keeps built-in credentials authoritative for duplicate Bobie and Phoebe identifiers`
5. `refuses production teacher trial accounts`
6. `refuses production admin trial accounts`

The fallback test exercises Bobie and Phoebe separately in production without configured accounts. The unique learner test proves a non-duplicate configured learner remains accessible alongside both built-ins. The duplicate test proves built-in passwords work, configured duplicate passwords fail, actors remain learners, and secrets are absent. Teacher and admin denials each prove `503`, `AAIS_AUTH_NOT_CONFIGURED`, no session cookie, and redaction.

```bash
set -euo pipefail
for test_name in \
  'refuses trial account login when the trial-login entry is disabled' \
  'keeps Bobie and Phoebe available as production learner fallbacks' \
  'keeps a unique configured learner available alongside production fallbacks' \
  'keeps built-in credentials authoritative for duplicate Bobie and Phoebe identifiers' \
  'refuses production teacher trial accounts' \
  'refuses production admin trial accounts'
do
  grep -Fq "it(\"$test_name\"" tests/auth-route.test.ts
  npx vitest run tests/auth-route.test.ts -t "$test_name"
done
npx vitest run tests/smoke-prod.test.mjs \
  -t 'optionally proves a known demo credential is rejected without setting a session cookie'
```

Expected: all six independently named auth behaviors and the blocked-credential smoke behavior pass.

- [ ] **Step 3: Apply the accepted documentation policy**

Use `apply_patch` to add the exact accepted sentences specified in the Bobie plan:

- README: `Production may use the built-in Bobie and Phoebe learner fallback while trial login is enabled; set \`AAIS_TRIAL_LOGIN_ENABLED=false\` to disable all trial login. Production teacher and admin trial identities are forbidden and must use database users or OIDC identities.`
- Operations: `Bobie and Phoebe are valid production learner fallbacks while trial login is enabled; never use them as blocked smoke credentials.`
- Operations: `Use \`retired-demo-account\` only for the blocked-credential check and supply its retired password through \`AAIS_SMOKE_BLOCKED_TRIAL_PASSWORD\`.`
- Release checklist: replace both the old Staging and Production smoke lines with the identical line `- [ ] Production smoke proves Bobie and Phoebe or a dedicated learner can sign in and the distinct \`retired-demo-account\` credential is rejected without a session cookie.`; its exact full-line count must be `2`.

Assert each fixed string independently:

```bash
set -euo pipefail
grep -Fqx \
  'Production may use the built-in Bobie and Phoebe learner fallback while trial login is enabled; set `AAIS_TRIAL_LOGIN_ENABLED=false` to disable all trial login. Production teacher and admin trial identities are forbidden and must use database users or OIDC identities.' \
  README.md
grep -Fq 'AAIS_SMOKE_BLOCKED_TRIAL_ACCOUNT=retired-demo-account' OPERATIONS.md
grep -Fqx \
  'Bobie and Phoebe are valid production learner fallbacks while trial login is enabled; never use them as blocked smoke credentials.' \
  OPERATIONS.md
grep -Fqx \
  'Use `retired-demo-account` only for the blocked-credential check and supply its retired password through `AAIS_SMOKE_BLOCKED_TRIAL_PASSWORD`.' \
  OPERATIONS.md
ACCEPTED_CHECKLIST='- [ ] Production smoke proves Bobie and Phoebe or a dedicated learner can sign in and the distinct `retired-demo-account` credential is rejected without a session cookie.'
test "$(grep -Fxc -- "$ACCEPTED_CHECKLIST" docs/release-checklist.md)" -eq 2
for old_checklist_line in \
  '- [ ] `npm run smoke:prod` passes against the staging URL using a dedicated smoke account and retired-demo credential rejection.' \
  '- [ ] `npm run smoke:prod` passes against `https://www.aais.site`, including retired-demo credential rejection.'
do
  if grep -Fqx -- "$old_checklist_line" docs/release-checklist.md; then exit 1; fi
done
if grep -Fq 'production excludes them' README.md; then exit 1; fi
if grep -Fq 'AAIS_SMOKE_BLOCKED_TRIAL_ACCOUNT=Bobie' OPERATIONS.md; then exit 1; fi
```

Expected: every accepted line exists exactly and both old contradictions are absent.

- [ ] **Step 4: Commit exactly the policy/test reconciliation paths**

```bash
set -euo pipefail
git add -- \
  README.md \
  OPERATIONS.md \
  docs/release-checklist.md \
  tests/auth-route.test.ts
git diff --cached --check
diff -u \
  <(printf '%s\n' \
    'OPERATIONS.md' \
    'README.md' \
    'docs/release-checklist.md' \
    'tests/auth-route.test.ts' | LC_ALL=C sort) \
  <(git diff --cached --name-only | LC_ALL=C sort)
git commit -m 'test: pin production trial fallback policy'
test "$(git show -s --format='%s' HEAD)" = \
  'test: pin production trial fallback policy'
POLICY_TIP=$(git rev-parse HEAD)
test -n "$POLICY_TIP"
test -z "$(git status --porcelain=v1 -uall)"
```

Expected: a single separate four-path compose commit records policy and missing coverage without changing the frozen Bobie SHA. This task is not repeated after later main advances.

### Task 4: Refresh and integrate live main before equivalence

- [ ] **Step 1: Fetch current main and merge it when necessary**

```bash
set -euo pipefail
SNAPSHOT_MAIN=42e92a483842a2a601ecbdb10794a90c1f3eba1f
EVIDENCE=docs/superpowers/recovery/2026-07-10-aais-dirty-inventory-equivalence.md
test "$(git cat-file -t "$SNAPSHOT_MAIN")" = 'commit'
git fetch origin main
LIVE_MAIN=$(git rev-parse refs/remotes/origin/main)
printf '%s\n' "$LIVE_MAIN" | grep -Eq '^[0-9a-f]{40}$'
git merge-base --is-ancestor "$SNAPSHOT_MAIN" "$LIVE_MAIN"
if git cat-file -e "HEAD:$EVIDENCE" 2>/dev/null; then
  PRIOR_PINNED_MAIN=$(git show "HEAD:$EVIDENCE" | awk -F= '
    $1 == "reviewed_live_main_sha" { count += 1; value = $2 }
    END { if (count != 1) exit 1; print value }
  ')
  printf '%s\n' "$PRIOR_PINNED_MAIN" | grep -Eq '^[0-9a-f]{40}$'
  git merge-base --is-ancestor "$PRIOR_PINNED_MAIN" "$LIVE_MAIN"
fi
if ! git merge-base --is-ancestor "$LIVE_MAIN" HEAD; then
  git merge --no-ff "$LIVE_MAIN" -m 'merge: refresh recovery base from main'
fi
git merge-base --is-ancestor "$LIVE_MAIN" HEAD
printf 'Integrated live main: %s\n' "$LIVE_MAIN"
```

Expected: fetched live main contains the historical snapshot base and is an
ancestor of compose. An unrelated or rewritten live ref stops. A legitimate
forward advance merges normally; conflicts are resolved narrowly and require
all later evidence/gates.

- [ ] **Step 2: Re-prove source ancestry, policy, and clean state after refresh**

```bash
set -euo pipefail
for sha in \
  5e803c669b955abba8a3f6c1c665c5543875a21a \
  735011b3e002f6be46ff34f4a13c70834a69cfeb \
  ad2d5a05114b9f19297fcae4a232cc434c8b2f35 \
  33af4c30100f4c0ea02b765709eb83123e7b10ff \
  1d97d16998e95a92ebecb3a69a2ad14c9e0a566c
do
  git merge-base --is-ancestor "$sha" HEAD
done
for test_name in \
  'refuses trial account login when the trial-login entry is disabled' \
  'keeps Bobie and Phoebe available as production learner fallbacks' \
  'keeps a unique configured learner available alongside production fallbacks' \
  'keeps built-in credentials authoritative for duplicate Bobie and Phoebe identifiers' \
  'refuses production teacher trial accounts' \
  'refuses production admin trial accounts'
do
  grep -Fq "it(\"$test_name\"" tests/auth-route.test.ts
done
grep -Fqx \
  'Production may use the built-in Bobie and Phoebe learner fallback while trial login is enabled; set `AAIS_TRIAL_LOGIN_ENABLED=false` to disable all trial login. Production teacher and admin trial identities are forbidden and must use database users or OIDC identities.' \
  README.md
grep -Fq 'AAIS_SMOKE_BLOCKED_TRIAL_ACCOUNT=retired-demo-account' OPERATIONS.md
grep -Fqx \
  'Bobie and Phoebe are valid production learner fallbacks while trial login is enabled; never use them as blocked smoke credentials.' \
  OPERATIONS.md
ACCEPTED_CHECKLIST='- [ ] Production smoke proves Bobie and Phoebe or a dedicated learner can sign in and the distinct `retired-demo-account` credential is rejected without a session cookie.'
test "$(grep -Fxc -- "$ACCEPTED_CHECKLIST" docs/release-checklist.md)" -eq 2
for old_checklist_line in \
  '- [ ] `npm run smoke:prod` passes against the staging URL using a dedicated smoke account and retired-demo credential rejection.' \
  '- [ ] `npm run smoke:prod` passes against `https://www.aais.site`, including retired-demo credential rejection.'
do
  if grep -Fqx -- "$old_checklist_line" docs/release-checklist.md; then exit 1; fi
done
if grep -Fq 'production excludes them' README.md; then exit 1; fi
if grep -Fq 'AAIS_SMOKE_BLOCKED_TRIAL_ACCOUNT=Bobie' OPERATIONS.md; then exit 1; fi
git diff --check
test -z "$(git status --porcelain=v1 -uall)"
```

Expected: source history and reconciled policy survive live-main integration.

### Task 5: Recompute and inspect exact equivalence after live refresh

- [ ] **Step 1: Re-run refreshed snapshot and root inventory assertions**

First fetch and capture the mutable live ref independently from snapshot
provenance:

```bash
set -euo pipefail
SNAPSHOT_MAIN=42e92a483842a2a601ecbdb10794a90c1f3eba1f
EVIDENCE=docs/superpowers/recovery/2026-07-10-aais-dirty-inventory-equivalence.md
git fetch origin main
TASK5_LIVE_MAIN=$(git rev-parse refs/remotes/origin/main)
printf '%s\n' "$TASK5_LIVE_MAIN" | grep -Eq '^[0-9a-f]{40}$'
git merge-base --is-ancestor "$SNAPSHOT_MAIN" "$TASK5_LIVE_MAIN"
if git cat-file -e "HEAD:$EVIDENCE" 2>/dev/null; then
  PRIOR_PINNED_MAIN=$(git show "HEAD:$EVIDENCE" | awk -F= '
    $1 == "reviewed_live_main_sha" { count += 1; value = $2 }
    END { if (count != 1) exit 1; print value }
  ')
  printf '%s\n' "$PRIOR_PINNED_MAIN" | grep -Eq '^[0-9a-f]{40}$'
  git merge-base --is-ancestor "$PRIOR_PINNED_MAIN" "$TASK5_LIVE_MAIN"
fi
if ! git merge-base --is-ancestor "$TASK5_LIVE_MAIN" HEAD; then
  printf 'legitimate_live_advance_requires_reintegration=%s\n' \
    "$TASK5_LIVE_MAIN"
  exit 2
fi
printf 'task5_live_main=%s\n' "$TASK5_LIVE_MAIN"
```

Exit `2` is a controlled forward-advance redirect: return to Task 4 Step 1,
integrate that freshly fetched SHA, and restart Task 5. Failure of the
historical-base ancestry assertion is not a legitimate advance and stops for
review. Then repeat Task 1 Steps 5, 6, and 7 without weakening any expected set
or hash. Those steps validate immutable snapshot provenance and rescue state;
they never require mutable `origin/main` to equal the snapshot-time SHA. A
snapshot mismatch stops pending a new owner-only snapshot and review.

- [ ] **Step 2: Inspect every refreshed root path against compose**

```bash
set -euo pipefail
ROOT=/Users/dongpinhu/Desktop/AAIS
COMPOSE=/Users/dongpinhu/Desktop/AAIS/.worktrees/aais-recovery-compose
for file_path in \
  src/app/api/learning/ai-guide/route.ts \
  src/app/api/learning/scaffold/route.ts \
  src/lib/server/aais-learning-store.ts \
  src/lib/server/aais-lrs-client.ts \
  src/lib/server/aais-trial-accounts.ts \
  tests/aais-api-routes.test.ts \
  tests/aais-backend-store.test.ts \
  tests/aais-lrs-client.test.ts \
  tests/aais-session-revocations.test.ts \
  tests/auth-route.test.ts \
  tests/postgres-migrations.test.mjs \
  migrations/postgres/0008_ai_guide_daily_usage.sql
do
  if cmp -s "$ROOT/$file_path" "$COMPOSE/$file_path"; then
    printf 'IDENTICAL %s\n' "$file_path"
  else
    diff_status=0
    git diff --no-index -- "$ROOT/$file_path" "$COMPOSE/$file_path" || diff_status=$?
    test "$diff_status" -eq 1
  fi
done
```

Expected: every path is read and each difference is classified. No diff is hidden.

- [ ] **Step 3: Inspect review-added and policy paths from the docs base**

```bash
set -euo pipefail
ROOT=/Users/dongpinhu/Desktop/AAIS
DOCS_TAG=aais-recovery-docs-reviewed-20260710
test "$(git -C "$ROOT" cat-file -t "$DOCS_TAG")" = 'tag'
DOCS_TIP=$(git -C "$ROOT" rev-parse "$DOCS_TAG^{commit}")
test "$(git -C "$ROOT" rev-parse codex/aais-worktree-recovery-design)" = \
  "$DOCS_TIP"
git diff --no-ext-diff "$DOCS_TIP"..HEAD -- \
  docs/privacy-data-inventory.md \
  tests/readiness-route.test.ts \
  README.md \
  OPERATIONS.md \
  docs/release-checklist.md \
  tests/auth-route.test.ts
```

Expected: daily readiness/privacy and Bobie policy/test additions are visible.

- [ ] **Step 4: Refetch, pin, and record live comparison hashes**

```bash
set -euo pipefail
ROOT=/Users/dongpinhu/Desktop/AAIS
SNAPSHOT_MAIN=42e92a483842a2a601ecbdb10794a90c1f3eba1f
EVIDENCE=docs/superpowers/recovery/2026-07-10-aais-dirty-inventory-equivalence.md
git fetch origin main
LIVE_MAIN=$(git rev-parse refs/remotes/origin/main)
printf '%s\n' "$LIVE_MAIN" | grep -Eq '^[0-9a-f]{40}$'
git merge-base --is-ancestor "$SNAPSHOT_MAIN" "$LIVE_MAIN"
if git cat-file -e "HEAD:$EVIDENCE" 2>/dev/null; then
  PRIOR_PINNED_MAIN=$(git show "HEAD:$EVIDENCE" | awk -F= '
    $1 == "reviewed_live_main_sha" { count += 1; value = $2 }
    END { if (count != 1) exit 1; print value }
  ')
  printf '%s\n' "$PRIOR_PINNED_MAIN" | grep -Eq '^[0-9a-f]{40}$'
  git merge-base --is-ancestor "$PRIOR_PINNED_MAIN" "$LIVE_MAIN"
fi
if ! git merge-base --is-ancestor "$LIVE_MAIN" HEAD; then
  printf 'legitimate_live_advance_requires_reintegration=%s\n' "$LIVE_MAIN"
  exit 2
fi
ROOT_VS_LIVE_SHA=$(git -C "$ROOT" diff --binary "$LIVE_MAIN" -- | \
  shasum -a 256 | awk '{print $1}')
COMPOSE_VS_LIVE_SHA=$(git diff --binary "$LIVE_MAIN"..HEAD -- | \
  shasum -a 256 | awk '{print $1}')
test "${#ROOT_VS_LIVE_SHA}" -eq 64
test "${#COMPOSE_VS_LIVE_SHA}" -eq 64
printf 'Live main: %s\nRoot vs live: %s\nCompose vs live: %s\n' \
  "$LIVE_MAIN" "$ROOT_VS_LIVE_SHA" "$COMPOSE_VS_LIVE_SHA"
```

Expected: the freshly fetched live SHA descends from the historical snapshot
base, is already integrated, and is printed with its two exact comparison
hashes for evidence. Exit `2` returns to Task 4 Step 1 and then restarts all of
Task 5; it does not accept stale comparisons or reject a legitimate forward
advance.

Classify all deviations by session, locked, daily, LRS, Bobie, policy reconciliation, live-main merge, and shared-file resolution. Specifically record that the root session-revocation copy already matched recorded main; the Bobie source behavior was rescued in `1d97d16`; the final auth test strengthens the root copy; daily adds readiness/privacy and stricter database behavior; LRS replaces batch-wide failure handling with per-row validation.

### Task 6: Capture structured focused and full gate evidence

- [ ] **Step 1: Run focused/full Vitest and Playwright with machine-readable reporters**

```bash
set -euo pipefail
COMPOSE_TIP_BEFORE_EVIDENCE=$(git rev-parse HEAD)
GATE_DIR="/tmp/aais-recovery-gates-$COMPOSE_TIP_BEFORE_EVIDENCE"
test ! -e "$GATE_DIR"
mkdir -m 700 "$GATE_DIR"
FOCUSED_JSON="$GATE_DIR/focused-vitest.json"
FULL_JSON="$GATE_DIR/full-vitest.json"
E2E_JSON="$GATE_DIR/playwright.json"
npx vitest run \
  tests/aais-session-revocations.test.ts \
  tests/auth-route.test.ts \
  tests/smoke-prod.test.mjs \
  tests/aais-api-routes.test.ts \
  tests/aais-backend-store.test.ts \
  tests/aais-lrs-client.test.ts \
  tests/postgres-migrations.test.mjs \
  tests/readiness-route.test.ts \
  --reporter=json --outputFile="$FOCUSED_JSON"
jq -e '.numFailedTests == 0 and .numFailedTestSuites == 0' "$FOCUSED_JSON"
npx vitest run --reporter=json --outputFile="$FULL_JSON"
jq -e '.numFailedTests == 0 and .numFailedTestSuites == 0' "$FULL_JSON"
npm run --silent e2e -- --reporter=json > "$E2E_JSON"
jq -e '.stats.unexpected == 0' "$E2E_JSON"
printf 'gate_dir=%s\nfocused_total=%s\nfocused_passed=%s\nfull_total=%s\nfull_passed=%s\ne2e_expected=%s\ne2e_unexpected=%s\n' \
  "$GATE_DIR" \
  "$(jq -r '.numTotalTests' "$FOCUSED_JSON")" \
  "$(jq -r '.numPassedTests' "$FOCUSED_JSON")" \
  "$(jq -r '.numTotalTests' "$FULL_JSON")" \
  "$(jq -r '.numPassedTests' "$FULL_JSON")" \
  "$(jq -r '.stats.expected' "$E2E_JSON")" \
  "$(jq -r '.stats.unexpected' "$E2E_JSON")"
```

Expected: the exact eight focused files, full Vitest suite, and Playwright suite pass. The JSON files contain the actual totals used by evidence.

- [ ] **Step 2: Run CI/build, hygiene, diff, and clean-tree gates**

```bash
set -euo pipefail
COMPOSE_TIP_BEFORE_EVIDENCE=$(git rev-parse HEAD)
GATE_DIR="/tmp/aais-recovery-gates-$COMPOSE_TIP_BEFORE_EVIDENCE"
test -d "$GATE_DIR"
test "$(node -p "require('./package.json').scripts.ci")" = \
  'npm run lint && npm run type-check && npm test && npm run build'
npm run ci 2>&1 | tee "$GATE_DIR/ci.log"
printf 'PASS\n' > "$GATE_DIR/ci.status"
printf 'PASS\n' > "$GATE_DIR/build.status"
npm run hygiene:check 2>&1 | tee "$GATE_DIR/hygiene.log"
printf 'PASS\n' > "$GATE_DIR/hygiene.status"
git diff --check > "$GATE_DIR/diff-check.log"
printf 'PASS\n' > "$GATE_DIR/diff-check.status"
test -z "$(git status --porcelain=v1 -uall)"
printf 'PASS\n' > "$GATE_DIR/clean-tree.status"
for status_file in \
  ci.status build.status hygiene.status diff-check.status clean-tree.status
do
  test "$(cat "$GATE_DIR/$status_file")" = 'PASS'
done
```

Expected: CI proves lint, type-check, full tests, and production build; strict hygiene, diff-check, and clean status pass. Evidence records each status as `PASS` only because its command exited `0`, while actual test counts come from the JSON reports.

### Task 7: Create and commit exact equivalence evidence

**Create:** `docs/superpowers/recovery/2026-07-10-aais-dirty-inventory-equivalence.md`

- [ ] **Step 1: Write a fail-closed manifest and exact-set sections**

Before the first `apply_patch`, prove that no earlier evidence generation exists:

```bash
set -euo pipefail
PUBLICATION_REPO=$(git rev-parse --show-toplevel)
EVIDENCE_PATH=docs/superpowers/recovery/2026-07-10-aais-dirty-inventory-equivalence.md
EVIDENCE="$PUBLICATION_REPO/$EVIDENCE_PATH"
test ! -e "$EVIDENCE"
if git cat-file -e "HEAD:$EVIDENCE_PATH" 2>/dev/null; then exit 1; fi
INITIAL_EVIDENCE_GENERATION=1
test "$INITIAL_EVIDENCE_GENERATION" -eq 1
```

Use `apply_patch` after Tasks 5 and 6. The evidence contains one and only one
raw `key=value` line for each key below. Values in angle brackets are replaced
with values computed during this run, never prose such as `current` or
`latest`:

```text
schema_version=2
evidence_generation=1
previous_evidence_generation=0
previous_evidence_tip=NONE
accepted_main_binding_tag=aais-recovery-accepted-main-20260710-1
acceptance_checkout_path=NONE
publication_head_branch=codex/aais-recovery-compose
publication_repo_path=/Users/dongpinhu/Desktop/AAIS/.worktrees/aais-recovery-compose
snapshot_path=/Users/dongpinhu/Desktop/AAIS-dirty-worktree-backups/20260710-145253-worktree-recovery-refresh
snapshot_mode=drwx------
snapshot_root_head=2fd93838281581a6996f6f7a8a6bca0d8d95e420
snapshot_recorded_origin_main=42e92a483842a2a601ecbdb10794a90c1f3eba1f
snapshot_root_tracked_vs_head_sha256=e3c385c8c57ddf582dad07fd9596476e13a3dcd231c1fef4b93979865d2e3211
snapshot_root_tracked_vs_recorded_main_sha256=bfc1c311ae90c8369d8feaa1bcbe69802b392cd5c7b259dddb23f8b6f8219b6c
snapshot_bobie_main_fix2_sha256=57b7f506362620e1c8f21eca9e15ec38482a70a957bcd975052f672e2a92ec74
snapshot_bobie_prod_fix_sha256=fe3bfd7c9d6709660033a1856bd549daec929da14f0aa230a7a4542716663460
snapshot_bobie_main_deploy_sha256=e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855
snapshot_migration_sha256=5460251a5560635b4b39229b22b360465ccfbb40b60c1812b3df4d9252ca98ce
bobie_commit_vs_base_sha256=892d373fe7a71ebf0a216e126511501ec0642c198c14fea12e679b3079a98603
session_source_tip=5e803c669b955abba8a3f6c1c665c5543875a21a
locked_source_tip=735011b3e002f6be46ff34f4a13c70834a69cfeb
daily_source_tip=ad2d5a05114b9f19297fcae4a232cc434c8b2f35
lrs_source_tip=33af4c30100f4c0ea02b765709eb83123e7b10ff
bobie_source_tip=1d97d16998e95a92ebecb3a69a2ad14c9e0a566c
reviewed_live_main_sha=<40-hex live origin/main>
root_tracked_vs_head_sha256=<64-hex root tracked diff hash>
root_vs_reviewed_live_main_sha256=<64-hex root versus pinned live-main hash>
compose_vs_reviewed_live_main_sha256=<64-hex compose versus pinned live-main hash>
reviewed_docs_tag=aais-recovery-docs-reviewed-20260710
reviewed_docs_tag_object=<40-hex annotated tag object>
reviewed_docs_tip=<40-hex reviewed docs commit>
reviewed_docs_tree=<40-hex reviewed docs tree>
policy_tip=<40-hex policy commit>
compose_tip_before_evidence=<40-hex compose tip>
gate_capture_dir=<absolute Task 6 gate directory>
final_head_binding_tag=aais-recovery-final-head-20260710-1
focused_file_count=8
focused_total_tests=<integer from focused-vitest.json>
focused_passed_tests=<integer from focused-vitest.json>
focused_failed_tests=0
full_total_tests=<integer from full-vitest.json>
full_passed_tests=<integer from full-vitest.json>
full_failed_tests=0
e2e_expected_tests=<integer from playwright.json>
e2e_unexpected_tests=0
ci_status=PASS
build_status=PASS
hygiene_status=PASS
diff_check_status=PASS
clean_tree_status=PASS
production_trial_policy_status=PASS
rescued_behavior_status=PASS
secret_values_status=OMITTED
```

The file also contains exactly four delimited raw sections:

- `BEGIN_ROOT_INVENTORY` / `END_ROOT_INVENTORY`: the exact sorted 11 ` M`
  paths plus the one `??` migration from Task 1 Step 6;
- `BEGIN_WORKTREE_CLASSIFICATIONS` / `END_WORKTREE_CLASSIFICATIONS`: the exact
  ten path/class/state lines below, separated by `|`;
- `BEGIN_DEVIATIONS` / `END_DEVIATIONS`: the exact intentional deviation set
  below;
- `BEGIN_FOCUSED_FILES` / `END_FOCUSED_FILES`: the exact eight focused test
  paths from Task 6.

The worktree classification set is:

```text
/Users/dongpinhu/Desktop/AAIS|root-rescue|dirty-11-tracked-plus-1-untracked-root-private-untouched
/Users/dongpinhu/Desktop/AAIS/.worktrees/aais-daily-guide-budget|reviewed-source|tracked-untracked-clean-ignored-separate
/Users/dongpinhu/Desktop/AAIS/.worktrees/aais-locked-task-guard|reviewed-source|tracked-untracked-clean-ignored-separate
/Users/dongpinhu/Desktop/AAIS/.worktrees/aais-lrs-outbox-hardening|reviewed-source|tracked-untracked-clean-ignored-separate
/Users/dongpinhu/Desktop/AAIS/.worktrees/aais-recovery-compose|integration-owner|tracked-untracked-clean-ignored-separate
/Users/dongpinhu/Desktop/AAIS/.worktrees/aais-session-revocation-test|reviewed-source|tracked-untracked-clean-ignored-separate
/Users/dongpinhu/Desktop/AAIS/.worktrees/aais-worktree-recovery-design|reviewed-docs|tracked-untracked-clean-ignored-separate
/private/tmp/aais-bobie-main-deploy-20260710|accepted-duplicate|tracked-untracked-clean-ignored-separate
/private/tmp/aais-bobie-main-fix2-20260710|reviewed-source|tracked-untracked-clean-ignored-separate
/private/tmp/aais-bobie-prod-fix-20260710|accepted-duplicate|dirty-three-proven-files-private-archive-required
```

The exact deviation set is:

```text
bobie|source behavior comes from 1d97d16; final auth coverage strengthens the root copy
daily|adds readiness and privacy paths and stricter durable database behavior
locked|preserves locked-task mutation rejection across shared store and route files
lrs|replaces batch-wide failure handling with per-row response validation
live-main|integrated when required and pinned by reviewed_live_main_sha
policy|reconciles learner fallback, disable, unique learner, teacher denial, admin denial, and retired credential behavior
session|root copy matched recorded main; reviewed deterministic source remains a non-first merge parent
shared-files|resolved by preserving all independently reviewed behaviors and rerunning focused plus full gates
```

- [ ] **Step 2: Parse each key once and compare every value and section to live evidence**

```bash
set -euo pipefail
ROOT=/Users/dongpinhu/Desktop/AAIS
DOCS_WT="$ROOT/.worktrees/aais-worktree-recovery-design"
PUBLICATION_REPO=$(git rev-parse --show-toplevel)
EVIDENCE_PATH=docs/superpowers/recovery/2026-07-10-aais-dirty-inventory-equivalence.md
EVIDENCE="$PUBLICATION_REPO/$EVIDENCE_PATH"
evidence_value() {
  local key=$1
  awk -v key="$key" '
    index($0, key "=") == 1 {
      count += 1
      value = substr($0, length(key) + 2)
    }
    END { if (count != 1) exit 1; print value }
  ' "$EVIDENCE"
}
evidence_section() {
  local begin_marker=$1
  local end_marker=$2
  awk -v begin_marker="$begin_marker" -v end_marker="$end_marker" '
    $0 == begin_marker { if (inside || seen) exit 2; inside = 1; seen = 1; next }
    $0 == end_marker { if (!inside || ended) exit 3; inside = 0; ended = 1; next }
    inside { print }
    END { if (!seen || !ended || inside) exit 4 }
  ' "$EVIDENCE"
}
diff -u \
  <(printf '%s\n' \
    accepted_main_binding_tag \
    acceptance_checkout_path \
    bobie_commit_vs_base_sha256 \
    bobie_source_tip \
    build_status \
    ci_status \
    clean_tree_status \
    compose_tip_before_evidence \
    compose_vs_reviewed_live_main_sha256 \
    daily_source_tip \
    diff_check_status \
    e2e_expected_tests \
    e2e_unexpected_tests \
    evidence_generation \
    final_head_binding_tag \
    focused_failed_tests \
    focused_file_count \
    focused_passed_tests \
    focused_total_tests \
    full_failed_tests \
    full_passed_tests \
    full_total_tests \
    gate_capture_dir \
    hygiene_status \
    locked_source_tip \
    lrs_source_tip \
    policy_tip \
    previous_evidence_generation \
    previous_evidence_tip \
    publication_head_branch \
    publication_repo_path \
    production_trial_policy_status \
    rescued_behavior_status \
    reviewed_docs_tag \
    reviewed_docs_tag_object \
    reviewed_docs_tip \
    reviewed_docs_tree \
    reviewed_live_main_sha \
    root_tracked_vs_head_sha256 \
    root_vs_reviewed_live_main_sha256 \
    schema_version \
    secret_values_status \
    session_source_tip \
    snapshot_bobie_main_deploy_sha256 \
    snapshot_bobie_main_fix2_sha256 \
    snapshot_bobie_prod_fix_sha256 \
    snapshot_migration_sha256 \
    snapshot_mode \
    snapshot_path \
    snapshot_recorded_origin_main \
    snapshot_root_head \
    snapshot_root_tracked_vs_head_sha256 \
    snapshot_root_tracked_vs_recorded_main_sha256 | LC_ALL=C sort) \
  <(sed -n 's/^\([a-z0-9_]*\)=.*/\1/p' "$EVIDENCE" | LC_ALL=C sort)
test "$(evidence_value schema_version)" = '2'
GENERATION=$(evidence_value evidence_generation)
printf '%s\n' "$GENERATION" | grep -Eq '^[1-9][0-9]*$'
PREVIOUS_GENERATION=$(evidence_value previous_evidence_generation)
printf '%s\n' "$PREVIOUS_GENERATION" | grep -Eq '^(0|[1-9][0-9]*)$'
PREVIOUS_EVIDENCE_TIP=$(evidence_value previous_evidence_tip)
if test "$GENERATION" -eq 1; then
  test "$PREVIOUS_GENERATION" -eq 0
  test "$PREVIOUS_EVIDENCE_TIP" = 'NONE'
  if git cat-file -e "HEAD:$EVIDENCE_PATH" 2>/dev/null; then exit 1; fi
else
  printf '%s\n' "$PREVIOUS_EVIDENCE_TIP" | grep -Eq '^[0-9a-f]{40}$'
  test "$PREVIOUS_EVIDENCE_TIP" = "$(git rev-parse HEAD)"
  git cat-file -e "$PREVIOUS_EVIDENCE_TIP:$EVIDENCE_PATH"
  RECORDED_PREVIOUS_GENERATION=$(git show \
    "$PREVIOUS_EVIDENCE_TIP:$EVIDENCE_PATH" | awk -F= '
      $1 == "evidence_generation" { count += 1; value = $2 }
      END { if (count != 1) exit 1; print value }
    ')
  printf '%s\n' "$RECORDED_PREVIOUS_GENERATION" | grep -Eq '^[1-9][0-9]*$'
  test "$PREVIOUS_GENERATION" -eq "$RECORDED_PREVIOUS_GENERATION"
  test "$GENERATION" -eq "$((PREVIOUS_GENERATION + 1))"
fi
test "$(evidence_value snapshot_path)" = \
  '/Users/dongpinhu/Desktop/AAIS-dirty-worktree-backups/20260710-145253-worktree-recovery-refresh'
test "$(evidence_value snapshot_mode)" = 'drwx------'
test "$(evidence_value snapshot_root_head)" = \
  '2fd93838281581a6996f6f7a8a6bca0d8d95e420'
test "$(evidence_value snapshot_recorded_origin_main)" = \
  '42e92a483842a2a601ecbdb10794a90c1f3eba1f'
test "$(evidence_value snapshot_root_tracked_vs_head_sha256)" = \
  'e3c385c8c57ddf582dad07fd9596476e13a3dcd231c1fef4b93979865d2e3211'
test "$(evidence_value snapshot_root_tracked_vs_recorded_main_sha256)" = \
  'bfc1c311ae90c8369d8feaa1bcbe69802b392cd5c7b259dddb23f8b6f8219b6c'
test "$(evidence_value snapshot_bobie_main_fix2_sha256)" = \
  '57b7f506362620e1c8f21eca9e15ec38482a70a957bcd975052f672e2a92ec74'
test "$(evidence_value snapshot_bobie_prod_fix_sha256)" = \
  'fe3bfd7c9d6709660033a1856bd549daec929da14f0aa230a7a4542716663460'
test "$(evidence_value snapshot_bobie_main_deploy_sha256)" = \
  'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855'
test "$(evidence_value snapshot_migration_sha256)" = \
  '5460251a5560635b4b39229b22b360465ccfbb40b60c1812b3df4d9252ca98ce'
test "$(evidence_value bobie_commit_vs_base_sha256)" = \
  '892d373fe7a71ebf0a216e126511501ec0642c198c14fea12e679b3079a98603'
test "$(evidence_value session_source_tip)" = \
  '5e803c669b955abba8a3f6c1c665c5543875a21a'
test "$(evidence_value locked_source_tip)" = \
  '735011b3e002f6be46ff34f4a13c70834a69cfeb'
test "$(evidence_value daily_source_tip)" = \
  'ad2d5a05114b9f19297fcae4a232cc434c8b2f35'
test "$(evidence_value lrs_source_tip)" = \
  '33af4c30100f4c0ea02b765709eb83123e7b10ff'
test "$(evidence_value bobie_source_tip)" = \
  '1d97d16998e95a92ebecb3a69a2ad14c9e0a566c'
LIVE_MAIN=$(git rev-parse refs/remotes/origin/main)
test "$(evidence_value reviewed_live_main_sha)" = "$LIVE_MAIN"
git merge-base --is-ancestor \
  "$(evidence_value snapshot_recorded_origin_main)" "$LIVE_MAIN"
ROOT_TRACKED_VS_HEAD=$(git -C "$ROOT" diff --binary | \
  shasum -a 256 | awk '{print $1}')
ROOT_VS_LIVE=$(git -C "$ROOT" diff --binary "$LIVE_MAIN" -- | \
  shasum -a 256 | awk '{print $1}')
test "$(evidence_value root_tracked_vs_head_sha256)" = \
  "$ROOT_TRACKED_VS_HEAD"
test "$(evidence_value root_vs_reviewed_live_main_sha256)" = \
  "$ROOT_VS_LIVE"
COMPOSE_TIP=$(evidence_value compose_tip_before_evidence)
test "$COMPOSE_TIP" = "$(git rev-parse HEAD)"
COMPOSE_VS_LIVE=$(git diff --binary "$LIVE_MAIN".."$COMPOSE_TIP" -- | \
  shasum -a 256 | awk '{print $1}')
test "$(evidence_value compose_vs_reviewed_live_main_sha256)" = \
  "$COMPOSE_VS_LIVE"
DOCS_TAG=$(evidence_value reviewed_docs_tag)
test "$DOCS_TAG" = 'aais-recovery-docs-reviewed-20260710'
REMOTE_DOCS_OBJECT=$(git -C "$PUBLICATION_REPO" ls-remote --tags origin \
  "refs/tags/$DOCS_TAG" | awk '
    NF == 2 { count += 1; value = $1 }
    END { if (count > 1) exit 1; print value }
  ')
REMOTE_DOCS_COMMIT=$(git -C "$PUBLICATION_REPO" ls-remote --tags origin \
  "refs/tags/$DOCS_TAG^{}" | awk '
    NF == 2 { count += 1; value = $1 }
    END { if (count > 1) exit 1; print value }
  ')
if ! git -C "$PUBLICATION_REPO" show-ref --verify --quiet \
  "refs/tags/$DOCS_TAG"; then
  test -n "$REMOTE_DOCS_OBJECT"
  test -n "$REMOTE_DOCS_COMMIT"
  git -C "$PUBLICATION_REPO" fetch origin \
    "refs/tags/$DOCS_TAG:refs/tags/$DOCS_TAG"
fi
test "$(git -C "$PUBLICATION_REPO" cat-file -t "$DOCS_TAG")" = 'tag'
test "$(evidence_value reviewed_docs_tag_object)" = \
  "$(git -C "$PUBLICATION_REPO" rev-parse "$DOCS_TAG^{tag}")"
test "$(evidence_value reviewed_docs_tip)" = \
  "$(git -C "$PUBLICATION_REPO" rev-parse "$DOCS_TAG^{commit}")"
test "$(evidence_value reviewed_docs_tree)" = \
  "$(git -C "$PUBLICATION_REPO" show -s --format='%T' \
    "$DOCS_TAG^{commit}")"
if test -n "$REMOTE_DOCS_OBJECT" || test -n "$REMOTE_DOCS_COMMIT"; then
  test "$REMOTE_DOCS_OBJECT" = \
    "$(git -C "$PUBLICATION_REPO" rev-parse "$DOCS_TAG^{tag}")"
  test "$REMOTE_DOCS_COMMIT" = \
    "$(git -C "$PUBLICATION_REPO" rev-parse "$DOCS_TAG^{commit}")"
fi
test "$(git -C "$DOCS_WT" rev-parse HEAD)" = \
  "$(evidence_value reviewed_docs_tip)"
test "$(git -C "$ROOT" rev-parse codex/aais-worktree-recovery-design)" = \
  "$(evidence_value reviewed_docs_tip)"
POLICY_TIP=$(evidence_value policy_tip)
test "$(git show -s --format='%s' "$POLICY_TIP")" = \
  'test: pin production trial fallback policy'
git merge-base --is-ancestor "$POLICY_TIP" "$COMPOSE_TIP"
test "$(git log --format='%s' "$COMPOSE_TIP" | \
  awk '$0 == "test: pin production trial fallback policy" { count += 1 } END { print count + 0 }')" = '1'
GATE_DIR=$(evidence_value gate_capture_dir)
test "$GATE_DIR" = "/tmp/aais-recovery-gates-$COMPOSE_TIP"
test "$(evidence_value focused_file_count)" = '8'
test "$(evidence_value focused_total_tests)" = \
  "$(jq -r '.numTotalTests' "$GATE_DIR/focused-vitest.json")"
test "$(evidence_value focused_passed_tests)" = \
  "$(jq -r '.numPassedTests' "$GATE_DIR/focused-vitest.json")"
test "$(evidence_value focused_failed_tests)" = \
  "$(jq -r '.numFailedTests' "$GATE_DIR/focused-vitest.json")"
test "$(evidence_value full_total_tests)" = \
  "$(jq -r '.numTotalTests' "$GATE_DIR/full-vitest.json")"
test "$(evidence_value full_passed_tests)" = \
  "$(jq -r '.numPassedTests' "$GATE_DIR/full-vitest.json")"
test "$(evidence_value full_failed_tests)" = \
  "$(jq -r '.numFailedTests' "$GATE_DIR/full-vitest.json")"
test "$(evidence_value e2e_expected_tests)" = \
  "$(jq -r '.stats.expected' "$GATE_DIR/playwright.json")"
test "$(evidence_value e2e_unexpected_tests)" = \
  "$(jq -r '.stats.unexpected' "$GATE_DIR/playwright.json")"
for key_status_file in \
  ci_status:ci.status \
  build_status:build.status \
  hygiene_status:hygiene.status \
  diff_check_status:diff-check.status \
  clean_tree_status:clean-tree.status
do
  key=${key_status_file%%:*}
  status_file=${key_status_file#*:}
  test "$(evidence_value "$key")" = 'PASS'
  test "$(cat "$GATE_DIR/$status_file")" = 'PASS'
done
test "$(evidence_value production_trial_policy_status)" = 'PASS'
test "$(evidence_value rescued_behavior_status)" = 'PASS'
test "$(evidence_value secret_values_status)" = 'OMITTED'
FINAL_TAG=$(evidence_value final_head_binding_tag)
test "$FINAL_TAG" = "aais-recovery-final-head-20260710-$GENERATION"
ACCEPTED_MAIN_TAG=$(evidence_value accepted_main_binding_tag)
test "$ACCEPTED_MAIN_TAG" = \
  "aais-recovery-accepted-main-20260710-$GENERATION"
ACCEPTANCE_CHECKOUT=$(evidence_value acceptance_checkout_path)
if test "$ACCEPTANCE_CHECKOUT" != 'NONE'; then
  case "$ACCEPTANCE_CHECKOUT" in
    /private/tmp/aais-recovery-main-acceptance-*) ;;
    *) exit 1 ;;
  esac
  test "$(git rev-parse --show-toplevel)" = "$ACCEPTANCE_CHECKOUT"
fi
PUBLICATION_HEAD_BRANCH=$(evidence_value publication_head_branch)
case "$PUBLICATION_HEAD_BRANCH" in
  codex/aais-recovery-compose|codex/aais-recovery-main-acceptance-*) ;;
  *) exit 1 ;;
esac
PUBLICATION_REPO=$(evidence_value publication_repo_path)
test "$(git rev-parse --show-toplevel)" = "$PUBLICATION_REPO"
if test "$ACCEPTANCE_CHECKOUT" = 'NONE'; then
  test "$PUBLICATION_REPO" = \
    "$ROOT/.worktrees/aais-recovery-compose"
else
  test "$PUBLICATION_REPO" = "$ACCEPTANCE_CHECKOUT"
fi
diff -u \
  <(printf '%s\n' \
    ' M src/app/api/learning/ai-guide/route.ts' \
    ' M src/app/api/learning/scaffold/route.ts' \
    ' M src/lib/server/aais-learning-store.ts' \
    ' M src/lib/server/aais-lrs-client.ts' \
    ' M src/lib/server/aais-trial-accounts.ts' \
    ' M tests/aais-api-routes.test.ts' \
    ' M tests/aais-backend-store.test.ts' \
    ' M tests/aais-lrs-client.test.ts' \
    ' M tests/aais-session-revocations.test.ts' \
    ' M tests/auth-route.test.ts' \
    ' M tests/postgres-migrations.test.mjs' \
    '?? migrations/postgres/0008_ai_guide_daily_usage.sql' | LC_ALL=C sort) \
  <(evidence_section BEGIN_ROOT_INVENTORY END_ROOT_INVENTORY | LC_ALL=C sort)
diff -u \
  <(git -C "$ROOT" status --porcelain=v1 -uall | LC_ALL=C sort) \
  <(evidence_section BEGIN_ROOT_INVENTORY END_ROOT_INVENTORY | LC_ALL=C sort)
diff -u \
  <(printf '%s\n' \
    '/Users/dongpinhu/Desktop/AAIS|root-rescue|dirty-11-tracked-plus-1-untracked-root-private-untouched' \
    '/Users/dongpinhu/Desktop/AAIS/.worktrees/aais-daily-guide-budget|reviewed-source|tracked-untracked-clean-ignored-separate' \
    '/Users/dongpinhu/Desktop/AAIS/.worktrees/aais-locked-task-guard|reviewed-source|tracked-untracked-clean-ignored-separate' \
    '/Users/dongpinhu/Desktop/AAIS/.worktrees/aais-lrs-outbox-hardening|reviewed-source|tracked-untracked-clean-ignored-separate' \
    '/Users/dongpinhu/Desktop/AAIS/.worktrees/aais-recovery-compose|integration-owner|tracked-untracked-clean-ignored-separate' \
    '/Users/dongpinhu/Desktop/AAIS/.worktrees/aais-session-revocation-test|reviewed-source|tracked-untracked-clean-ignored-separate' \
    '/Users/dongpinhu/Desktop/AAIS/.worktrees/aais-worktree-recovery-design|reviewed-docs|tracked-untracked-clean-ignored-separate' \
    '/private/tmp/aais-bobie-main-deploy-20260710|accepted-duplicate|tracked-untracked-clean-ignored-separate' \
    '/private/tmp/aais-bobie-main-fix2-20260710|reviewed-source|tracked-untracked-clean-ignored-separate' \
    '/private/tmp/aais-bobie-prod-fix-20260710|accepted-duplicate|dirty-three-proven-files-private-archive-required' | LC_ALL=C sort) \
  <(evidence_section BEGIN_WORKTREE_CLASSIFICATIONS \
    END_WORKTREE_CLASSIFICATIONS | LC_ALL=C sort)
diff -u \
  <(git -C "$ROOT" worktree list --porcelain | \
    sed -n 's/^worktree //p' | LC_ALL=C sort) \
  <(evidence_section BEGIN_WORKTREE_CLASSIFICATIONS \
    END_WORKTREE_CLASSIFICATIONS | cut -d '|' -f 1 | LC_ALL=C sort)
diff -u \
  <(printf '%s\n' \
    'bobie|source behavior comes from 1d97d16; final auth coverage strengthens the root copy' \
    'daily|adds readiness and privacy paths and stricter durable database behavior' \
    'locked|preserves locked-task mutation rejection across shared store and route files' \
    'lrs|replaces batch-wide failure handling with per-row response validation' \
    'live-main|integrated when required and pinned by reviewed_live_main_sha' \
    'policy|reconciles learner fallback, disable, unique learner, teacher denial, admin denial, and retired credential behavior' \
    'session|root copy matched recorded main; reviewed deterministic source remains a non-first merge parent' \
    'shared-files|resolved by preserving all independently reviewed behaviors and rerunning focused plus full gates' | LC_ALL=C sort) \
  <(evidence_section BEGIN_DEVIATIONS END_DEVIATIONS | LC_ALL=C sort)
diff -u \
  <(printf '%s\n' \
    'tests/aais-api-routes.test.ts' \
    'tests/aais-backend-store.test.ts' \
    'tests/aais-lrs-client.test.ts' \
    'tests/aais-session-revocations.test.ts' \
    'tests/auth-route.test.ts' \
    'tests/postgres-migrations.test.mjs' \
    'tests/readiness-route.test.ts' \
    'tests/smoke-prod.test.mjs' | LC_ALL=C sort) \
  <(evidence_section BEGIN_FOCUSED_FILES END_FOCUSED_FILES | LC_ALL=C sort)
```

Expected: the parser rejects missing or duplicate keys and section markers.
Every dynamic value equals Git, the root, or a machine-readable gate result;
every exact-set comparison is empty.

- [ ] **Step 3: Commit evidence alone with the exact subject**

```bash
set -euo pipefail
PUBLICATION_REPO=$(git rev-parse --show-toplevel)
EVIDENCE=docs/superpowers/recovery/2026-07-10-aais-dirty-inventory-equivalence.md
cd "$PUBLICATION_REPO"
test "$(awk -F= '
  $1 == "publication_repo_path" { count += 1; value = $2 }
  END { if (count != 1) exit 1; print value }
' "$EVIDENCE")" = "$PUBLICATION_REPO"
git add -- "$EVIDENCE"
git diff --cached --check
diff -u \
  <(printf '%s\n' \
    "$EVIDENCE") \
  <(git diff --cached --name-only)
git commit -m 'docs: record AAIS dirty inventory equivalence'
test "$(git show -s --format='%s' HEAD)" = \
  'docs: record AAIS dirty inventory equivalence'
NEW_GENERATION=$(git show "HEAD:docs/superpowers/recovery/2026-07-10-aais-dirty-inventory-equivalence.md" | \
  awk -F= '
    $1 == "evidence_generation" { count += 1; value = $2 }
    END { if (count != 1) exit 1; print value }
  ')
PREVIOUS_GENERATION=$(git show "HEAD:docs/superpowers/recovery/2026-07-10-aais-dirty-inventory-equivalence.md" | \
  awk -F= '
    $1 == "previous_evidence_generation" { count += 1; value = $2 }
    END { if (count != 1) exit 1; print value }
  ')
PREVIOUS_EVIDENCE_TIP=$(git show "HEAD:docs/superpowers/recovery/2026-07-10-aais-dirty-inventory-equivalence.md" | \
  awk -F= '
    $1 == "previous_evidence_tip" { count += 1; value = $2 }
    END { if (count != 1) exit 1; print value }
  ')
if test "$NEW_GENERATION" -eq 1; then
  test "$PREVIOUS_GENERATION" -eq 0
  test "$PREVIOUS_EVIDENCE_TIP" = 'NONE'
  if git cat-file -e "HEAD^:docs/superpowers/recovery/2026-07-10-aais-dirty-inventory-equivalence.md" \
    2>/dev/null; then exit 1; fi
else
  test "$PREVIOUS_EVIDENCE_TIP" = "$(git rev-parse HEAD^)"
  PARENT_GENERATION=$(git show \
    "HEAD^:docs/superpowers/recovery/2026-07-10-aais-dirty-inventory-equivalence.md" | \
    awk -F= '
      $1 == "evidence_generation" { count += 1; value = $2 }
      END { if (count != 1) exit 1; print value }
    ')
  test "$PREVIOUS_GENERATION" -eq "$PARENT_GENERATION"
  test "$NEW_GENERATION" -eq "$((PARENT_GENERATION + 1))"
fi
test -z "$(git status --porcelain=v1 -uall)"
```

Expected: evidence is committed alone. Publication is blocked without this commit.

- [ ] **Step 4: Bind the actual evidence head without a self-SHA placeholder**

The evidence commit cannot contain its own SHA. Its generation-specific annotated
tag is the immutable final-head binding. Never move or replace an existing tag.

```bash
set -euo pipefail
PUBLICATION_REPO=$(git rev-parse --show-toplevel)
EVIDENCE="$PUBLICATION_REPO/docs/superpowers/recovery/2026-07-10-aais-dirty-inventory-equivalence.md"
evidence_value() {
  local key=$1
  awk -v key="$key" '
    index($0, key "=") == 1 { count += 1; value = substr($0, length(key) + 2) }
    END { if (count != 1) exit 1; print value }
  ' "$EVIDENCE"
}
test "$(evidence_value publication_repo_path)" = "$PUBLICATION_REPO"
GENERATION=$(evidence_value evidence_generation)
FINAL_TAG=$(evidence_value final_head_binding_tag)
test "$FINAL_TAG" = "aais-recovery-final-head-20260710-$GENERATION"
FINAL_HEAD=$(git -C "$PUBLICATION_REPO" rev-parse HEAD)
EVIDENCE_BLOB=$(git -C "$PUBLICATION_REPO" rev-parse \
  "HEAD:docs/superpowers/recovery/2026-07-10-aais-dirty-inventory-equivalence.md")
if git -C "$PUBLICATION_REPO" show-ref --verify --quiet \
  "refs/tags/$FINAL_TAG"; then
  test "$(git -C "$PUBLICATION_REPO" cat-file -t "$FINAL_TAG")" = 'tag'
  test "$(git -C "$PUBLICATION_REPO" rev-parse \
    "$FINAL_TAG^{commit}")" = "$FINAL_HEAD"
else
  git -C "$PUBLICATION_REPO" tag -a "$FINAL_TAG" "$FINAL_HEAD" \
    -m "final_head_sha=$FINAL_HEAD" \
    -m "evidence_blob_sha=$EVIDENCE_BLOB" \
    -m "evidence_generation=$GENERATION"
fi
test "$(git -C "$PUBLICATION_REPO" cat-file -t "$FINAL_TAG")" = 'tag'
test "$(git -C "$PUBLICATION_REPO" rev-parse \
  "$FINAL_TAG^{commit}")" = "$FINAL_HEAD"
for tag_line in \
  "final_head_sha=$FINAL_HEAD" \
  "evidence_blob_sha=$EVIDENCE_BLOB" \
  "evidence_generation=$GENERATION"
do
  git -C "$PUBLICATION_REPO" for-each-ref "refs/tags/$FINAL_TAG" \
    --format='%(contents)' | grep -Fqx "$tag_line"
done
```

Expected: the annotated tag is created in the active publication repository
recorded by evidence. It targets that repository's actual evidence commit and
binds its blob plus generation without placing a circular SHA in the file.
The initial cycle uses the compose worktree's shared object store; a drift cycle
uses the independent acceptance clone's object store. The root repository is
never asked to tag an object that exists only in the clone.

- [ ] **Step 5: Re-run final gates after evidence is committed**

From `publication_repo_path`, repeat Task 6 with the evidence commit as the new
publication tip. Its distinct SHA creates a distinct gate directory.
Documentation-only evidence must not weaken any structured count, status, or
clean-tree assertion.

### Task 8: Refresh again immediately before publication and pin the PR head

- [ ] **Step 1: Detect zero, one, or multiple late-main advances**

```bash
set -euo pipefail
EVIDENCE=docs/superpowers/recovery/2026-07-10-aais-dirty-inventory-equivalence.md
SNAPSHOT_MAIN=42e92a483842a2a601ecbdb10794a90c1f3eba1f
evidence_value() {
  local key=$1
  awk -v key="$key" '
    index($0, key "=") == 1 { count += 1; value = substr($0, length(key) + 2) }
    END { if (count != 1) exit 1; print value }
  ' "$EVIDENCE"
}
git fetch origin main
CURRENT_MAIN=$(git rev-parse refs/remotes/origin/main)
EVIDENCE_MAIN=$(evidence_value reviewed_live_main_sha)
for sha in "$CURRENT_MAIN" "$EVIDENCE_MAIN"; do
  printf '%s\n' "$sha" | grep -Eq '^[0-9a-f]{40}$'
done
git merge-base --is-ancestor "$SNAPSHOT_MAIN" "$CURRENT_MAIN"
if test "$CURRENT_MAIN" = "$EVIDENCE_MAIN"; then
  git merge-base --is-ancestor "$CURRENT_MAIN" HEAD
  printf 'late_advance_required=no\n'
  exit 0
fi
if ! git merge-base --is-ancestor "$EVIDENCE_MAIN" "$CURRENT_MAIN"; then
  printf 'non_fast_forward_or_unrelated_main\npinned_main=%s\ncurrent_main=%s\n' \
    "$EVIDENCE_MAIN" "$CURRENT_MAIN"
  exit 5
fi
if ! git merge-base --is-ancestor "$CURRENT_MAIN" HEAD; then
  if ! git merge --no-ff "$CURRENT_MAIN" \
    -m 'merge: refresh recovery base from main'; then
    git diff --name-only --diff-filter=U
    exit 3
  fi
fi
git merge-base --is-ancestor "$CURRENT_MAIN" HEAD
printf 'late_advance_required=yes\nreviewed_live_main_sha=%s\n' "$CURRENT_MAIN"
```

Exit `5` stops on a rewritten, backward, or unrelated live ref; it is never
treated as a legitimate advance. Exit `3` preserves the in-progress merge and
stops. Inspect every printed
conflict, use `apply_patch` to preserve the accepted policy and all reviewed
slice behaviors, stage only the exact resolved paths, run `git diff --check`,
and complete `git merge --continue`. Then start Task 8 Step 2. Do not abort by
discarding reviewed work, and do not replay Task 3's initial old-drift checks.

- [ ] **Step 2: Reassert the accepted policy after a late merge**

This is an idempotent invariant check, not a second policy commit:

```bash
set -euo pipefail
for test_name in \
  'refuses trial account login when the trial-login entry is disabled' \
  'keeps Bobie and Phoebe available as production learner fallbacks' \
  'keeps a unique configured learner available alongside production fallbacks' \
  'keeps built-in credentials authoritative for duplicate Bobie and Phoebe identifiers' \
  'refuses production teacher trial accounts' \
  'refuses production admin trial accounts'
do
  grep -Fq "it(\"$test_name\"" tests/auth-route.test.ts
done
grep -Fq \
  "it(\"optionally proves a known demo credential is rejected without setting a session cookie\"" \
  tests/smoke-prod.test.mjs
grep -Fqx \
  'Production may use the built-in Bobie and Phoebe learner fallback while trial login is enabled; set `AAIS_TRIAL_LOGIN_ENABLED=false` to disable all trial login. Production teacher and admin trial identities are forbidden and must use database users or OIDC identities.' \
  README.md
grep -Fqx \
  'Bobie and Phoebe are valid production learner fallbacks while trial login is enabled; never use them as blocked smoke credentials.' \
  OPERATIONS.md
grep -Fqx \
  'Use `retired-demo-account` only for the blocked-credential check and supply its retired password through `AAIS_SMOKE_BLOCKED_TRIAL_PASSWORD`.' \
  OPERATIONS.md
ACCEPTED_CHECKLIST='- [ ] Production smoke proves Bobie and Phoebe or a dedicated learner can sign in and the distinct `retired-demo-account` credential is rejected without a session cookie.'
test "$(grep -Fxc -- "$ACCEPTED_CHECKLIST" docs/release-checklist.md)" -eq 2
for old_checklist_line in \
  '- [ ] `npm run smoke:prod` passes against the staging URL using a dedicated smoke account and retired-demo credential rejection.' \
  '- [ ] `npm run smoke:prod` passes against `https://www.aais.site`, including retired-demo credential rejection.'
do
  if grep -Fqx -- "$old_checklist_line" docs/release-checklist.md; then exit 1; fi
done
if grep -Fq 'production excludes them' README.md; then exit 1; fi
if grep -Fq 'AAIS_SMOKE_BLOCKED_TRIAL_ACCOUNT=Bobie' OPERATIONS.md; then exit 1; fi
test "$(git log --format='%s' | \
  awk '$0 == "test: pin production trial fallback policy" { count += 1 } END { print count + 0 }')" = '1'
git diff --check
test -z "$(git status --porcelain=v1 -uall)"
```

Expected: disable behavior, Bobie/Phoebe fallback, the unique configured
learner, teacher denial, admin denial, and the distinct retired-demo smoke
credential are all still independently pinned. Any failure stops publication
for explicit resolution; no empty or duplicate policy commit is allowed.

- [ ] **Step 3: Generate the next evidence generation after an advance**

If Step 1 printed `late_advance_required=yes`, repeat Task 5's dynamic
comparisons and Task 6. Immediately before editing, capture the exact prior
generation from the post-merge, pre-evidence commit:

```bash
set -euo pipefail
EVIDENCE=docs/superpowers/recovery/2026-07-10-aais-dirty-inventory-equivalence.md
PREVIOUS_EVIDENCE_TIP=$(git rev-parse HEAD)
git cat-file -e "$PREVIOUS_EVIDENCE_TIP:$EVIDENCE"
PREVIOUS_GENERATION=$(git show "$PREVIOUS_EVIDENCE_TIP:$EVIDENCE" | \
  awk -F= '
    $1 == "evidence_generation" { count += 1; value = $2 }
    END { if (count != 1) exit 1; print value }
  ')
printf '%s\n' "$PREVIOUS_GENERATION" | grep -Eq '^[1-9][0-9]*$'
NEXT_GENERATION=$((PREVIOUS_GENERATION + 1))
test "$NEXT_GENERATION" -gt "$PREVIOUS_GENERATION"
printf 'previous_evidence_tip=%s\nprevious_generation=%s\nnext_generation=%s\n' \
  "$PREVIOUS_EVIDENCE_TIP" "$PREVIOUS_GENERATION" "$NEXT_GENERATION"
```

Use `apply_patch` to set `previous_evidence_tip` and
`previous_evidence_generation` to those captured values and set
`evidence_generation` to exactly `NEXT_GENERATION`. Update all of these values
from the new Git state and machine-readable gate directory:

```text
previous_evidence_tip
previous_evidence_generation
accepted_main_binding_tag
acceptance_checkout_path
publication_head_branch
publication_repo_path
reviewed_live_main_sha
root_tracked_vs_head_sha256
root_vs_reviewed_live_main_sha256
compose_vs_reviewed_live_main_sha256
compose_tip_before_evidence
gate_capture_dir
final_head_binding_tag
focused_total_tests
focused_passed_tests
focused_failed_tests
full_total_tests
full_passed_tests
full_failed_tests
e2e_expected_tests
e2e_unexpected_tests
ci_status
build_status
hygiene_status
diff_check_status
clean_tree_status
```

Re-run Task 7 Step 2, commit only the evidence path with subject
`docs: record AAIS dirty inventory equivalence`, create the new annotated seal
with Task 7 Step 4, and rerun Task 6 at the new evidence head. Preserve every
older generation tag. Task 7 Steps 2 and 3 must prove from Git that the new
generation equals the captured old generation plus exactly one; a skipped,
reused, or non-integer generation stops before tagging. Never re-expect the
initial contradictory policy and never create another
`test: pin production trial fallback policy` commit.

After that generation, fetch main again and return to Task 8 Step 1. This loop
handles any number of consecutive advances. It ends only when the evidence's
exact `reviewed_live_main_sha` equals fetched `origin/main`, that SHA is an
ancestor of the current head, and the current head is the latest seal target.
Each accepted advance must descend from both the historical snapshot main and
the prior evidence main; non-fast-forward or unrelated movement stops.

- [ ] **Step 4: Push the latest seal and create or reuse exactly one open PR**

```bash
set -euo pipefail
PUBLICATION_REPO=$(git rev-parse --show-toplevel)
EVIDENCE="$PUBLICATION_REPO/docs/superpowers/recovery/2026-07-10-aais-dirty-inventory-equivalence.md"
BASE_BRANCH=main
evidence_value() {
  local key=$1
  awk -v key="$key" '
    index($0, key "=") == 1 { count += 1; value = substr($0, length(key) + 2) }
    END { if (count != 1) exit 1; print value }
  ' "$EVIDENCE"
}
test "$(evidence_value publication_repo_path)" = "$PUBLICATION_REPO"
cd "$PUBLICATION_REPO"
HEAD_BRANCH=$(evidence_value publication_head_branch)
test "$(git branch --show-current)" = "$HEAD_BRANCH"
git fetch origin main
PINNED_MAIN=$(evidence_value reviewed_live_main_sha)
CURRENT_MAIN=$(git rev-parse origin/main)
if test "$CURRENT_MAIN" != "$PINNED_MAIN"; then
  printf 'late_main_advance=%s\npinned_main=%s\n' \
    "$CURRENT_MAIN" "$PINNED_MAIN"
  exit 4
fi
EXPECTED_HEAD=$(git rev-parse HEAD)
FINAL_TAG=$(evidence_value final_head_binding_tag)
DOCS_TAG=$(evidence_value reviewed_docs_tag)
test "$(git -C "$PUBLICATION_REPO" cat-file -t "$FINAL_TAG")" = 'tag'
test "$(git -C "$PUBLICATION_REPO" rev-parse \
  "$FINAL_TAG^{commit}")" = "$EXPECTED_HEAD"
if ! git -C "$PUBLICATION_REPO" show-ref --verify --quiet \
  "refs/tags/$DOCS_TAG"; then
  git -C "$PUBLICATION_REPO" fetch origin \
    "refs/tags/$DOCS_TAG:refs/tags/$DOCS_TAG"
fi
test "$(git -C "$PUBLICATION_REPO" cat-file -t "$DOCS_TAG")" = 'tag'
test "$(git -C "$PUBLICATION_REPO" rev-parse \
  "$DOCS_TAG^{tag}")" = "$(evidence_value reviewed_docs_tag_object)"
test "$(git -C "$PUBLICATION_REPO" rev-parse \
  "$DOCS_TAG^{commit}")" = "$(evidence_value reviewed_docs_tip)"
git merge-base --is-ancestor origin/main "$EXPECTED_HEAD"
remote_tag_state() {
  local tag_name=$1
  local local_object local_commit remote_object remote_commit
  local_object=$(git -C "$PUBLICATION_REPO" rev-parse "$tag_name^{tag}")
  local_commit=$(git -C "$PUBLICATION_REPO" rev-parse \
    "$tag_name^{commit}")
  remote_object=$(git -C "$PUBLICATION_REPO" ls-remote --tags origin \
    "refs/tags/$tag_name" | awk '
      NF == 2 { count += 1; value = $1 }
      END { if (count > 1) exit 1; print value }
    ')
  remote_commit=$(git -C "$PUBLICATION_REPO" ls-remote --tags origin \
    "refs/tags/$tag_name^{}" | awk '
      NF == 2 { count += 1; value = $1 }
      END { if (count > 1) exit 1; print value }
    ')
  if test -z "$remote_object" && test -z "$remote_commit"; then
    printf 'ABSENT\n'
  else
    test "$remote_object" = "$local_object"
    test "$remote_commit" = "$local_commit"
    printf 'EXACT\n'
  fi
}
DOCS_REMOTE_STATE=$(remote_tag_state "$DOCS_TAG")
FINAL_REMOTE_STATE=$(remote_tag_state "$FINAL_TAG")
for tag_state in "$DOCS_REMOTE_STATE" "$FINAL_REMOTE_STATE"; do
  test "$tag_state" = 'ABSENT' || test "$tag_state" = 'EXACT'
done
if test "$DOCS_REMOTE_STATE" = 'ABSENT'; then
  git -C "$PUBLICATION_REPO" push origin "refs/tags/$DOCS_TAG"
fi
if test "$FINAL_REMOTE_STATE" = 'ABSENT'; then
  git -C "$PUBLICATION_REPO" push origin "refs/tags/$FINAL_TAG"
fi
test "$(remote_tag_state "$DOCS_TAG")" = 'EXACT'
test "$(remote_tag_state "$FINAL_TAG")" = 'EXACT'
git -C "$PUBLICATION_REPO" push -u origin "$HEAD_BRANCH"
OPEN_FOR_HEAD=$(gh pr list \
  --state open \
  --head "$HEAD_BRANCH" \
  --limit 100 \
  --json number,headRefName,headRefOid,baseRefName,state)
OPEN_COUNT=$(printf '%s\n' "$OPEN_FOR_HEAD" | jq -r 'length')
printf '%s\n' "$OPEN_COUNT" | grep -Eq '^[0-9]+$'
test "$OPEN_COUNT" -le 1
if test "$OPEN_COUNT" -eq 0; then
  gh pr create \
    --base "$BASE_BRANCH" \
    --head "$HEAD_BRANCH" \
    --title 'Recover AAIS dirty integration inventory' \
    --body 'Integrates five reviewed source commits with preserved no-ff history, reconciles production learner-trial policy, records refreshed root/worktree equivalence, and reports passing focused, CI/build, E2E, hygiene, and diff gates. Merge method: merge commit only.'
  OPEN_FOR_HEAD=$(gh pr list \
    --state open \
    --head "$HEAD_BRANCH" \
    --limit 100 \
    --json number,headRefName,headRefOid,baseRefName,state)
fi
test "$(printf '%s\n' "$OPEN_FOR_HEAD" | jq -r 'length')" -eq 1
PR_NUMBER=$(printf '%s\n' "$OPEN_FOR_HEAD" | jq -er '.[0].number')
printf '%s\n' "$PR_NUMBER" | grep -Eq '^[1-9][0-9]*$'
test "$(printf '%s\n' "$OPEN_FOR_HEAD" | jq -r '.[0].headRefName')" = \
  "$HEAD_BRANCH"
test "$(printf '%s\n' "$OPEN_FOR_HEAD" | jq -r '.[0].headRefOid')" = \
  "$EXPECTED_HEAD"
test "$(printf '%s\n' "$OPEN_FOR_HEAD" | jq -r '.[0].baseRefName')" = \
  "$BASE_BRANCH"
test "$(printf '%s\n' "$OPEN_FOR_HEAD" | jq -r '.[0].state')" = 'OPEN'
EXACT_OPEN=$(gh pr list \
  --state open \
  --head "$HEAD_BRANCH" \
  --base "$BASE_BRANCH" \
  --limit 100 \
  --json number,headRefName,headRefOid,baseRefName,state)
test "$(printf '%s\n' "$EXACT_OPEN" | jq -r 'length')" -eq 1
test "$(printf '%s\n' "$EXACT_OPEN" | jq -er '.[0].number')" = \
  "$PR_NUMBER"
```

Expected: a repeated publication pass pushes the new head to the same branch,
then reuses its single open PR. A second open PR for the head, an unexpected
base/head/state, or a nonmatching `headRefOid` fails closed. `gh pr create`
runs only when the exact head has no open PR.

- [ ] **Step 5: Watch checks, refetch the base immediately before merge, and loop on advance**

Re-derive the sealed head and re-query the exact open PR so this block is
independently fail-closed:

```bash
set -euo pipefail
EVIDENCE=docs/superpowers/recovery/2026-07-10-aais-dirty-inventory-equivalence.md
BASE_BRANCH=main
evidence_value() {
  local key=$1
  awk -v key="$key" '
    index($0, key "=") == 1 { count += 1; value = substr($0, length(key) + 2) }
    END { if (count != 1) exit 1; print value }
  ' "$EVIDENCE"
}
PUBLICATION_REPO=$(evidence_value publication_repo_path)
test "$(git rev-parse --show-toplevel)" = "$PUBLICATION_REPO"
cd "$PUBLICATION_REPO"
HEAD_BRANCH=$(evidence_value publication_head_branch)
test "$(git branch --show-current)" = "$HEAD_BRANCH"
PINNED_MAIN=$(evidence_value reviewed_live_main_sha)
EXPECTED_HEAD=$(git rev-parse HEAD)
EXPECTED_TREE=$(git rev-parse "$EXPECTED_HEAD^{tree}")
FINAL_TAG=$(evidence_value final_head_binding_tag)
git fetch origin "refs/tags/$FINAL_TAG:refs/tags/$FINAL_TAG"
test "$(git rev-parse "$FINAL_TAG^{commit}")" = "$EXPECTED_HEAD"
EXACT_OPEN=$(gh pr list \
  --state open \
  --head "$HEAD_BRANCH" \
  --base "$BASE_BRANCH" \
  --limit 100 \
  --json number,headRefName,headRefOid,baseRefName,state)
test "$(printf '%s\n' "$EXACT_OPEN" | jq -r 'length')" -eq 1
PR_NUMBER=$(printf '%s\n' "$EXACT_OPEN" | jq -er '.[0].number')
printf '%s\n' "$PR_NUMBER" | grep -Eq '^[1-9][0-9]*$'
PR_JSON=$(gh pr view "$PR_NUMBER" \
  --json number,headRefName,headRefOid,baseRefName,state)
test "$(printf '%s\n' "$PR_JSON" | jq -er '.number')" = "$PR_NUMBER"
test "$(printf '%s\n' "$PR_JSON" | jq -r '.headRefName')" = "$HEAD_BRANCH"
test "$(printf '%s\n' "$PR_JSON" | jq -r '.headRefOid')" = "$EXPECTED_HEAD"
test "$(printf '%s\n' "$PR_JSON" | jq -r '.baseRefName')" = "$BASE_BRANCH"
test "$(printf '%s\n' "$PR_JSON" | jq -r '.state')" = 'OPEN'
gh pr checks "$PR_NUMBER" --watch
PR_JSON=$(gh pr view "$PR_NUMBER" \
  --json number,headRefName,headRefOid,baseRefName,state)
test "$(printf '%s\n' "$PR_JSON" | jq -er '.number')" = "$PR_NUMBER"
test "$(printf '%s\n' "$PR_JSON" | jq -r '.headRefName')" = "$HEAD_BRANCH"
test "$(printf '%s\n' "$PR_JSON" | jq -r '.headRefOid')" = "$EXPECTED_HEAD"
test "$(printf '%s\n' "$PR_JSON" | jq -r '.baseRefName')" = "$BASE_BRANCH"
test "$(printf '%s\n' "$PR_JSON" | jq -r '.state')" = 'OPEN'
test "$(gh pr view "$PR_NUMBER" --json mergeStateStatus \
  --jq '.mergeStateStatus')" = 'CLEAN'
git fetch origin main
FRESH_MAIN=$(git rev-parse origin/main)
if test "$FRESH_MAIN" != "$PINNED_MAIN"; then
  printf 'late_main_advance_after_checks=%s\npinned_main=%s\n' \
  "$FRESH_MAIN" "$PINNED_MAIN"
  exit 4
fi
gh pr merge "$PR_NUMBER" --merge --match-head-commit "$EXPECTED_HEAD"
git fetch origin main
ACTUAL_MERGE=$(git rev-parse refs/remotes/origin/main)
test "$(git rev-list --parents -n 1 "$ACTUAL_MERGE" | awk '{print NF}')" -eq 3
ACTUAL_FIRST_PARENT=$(git rev-parse "$ACTUAL_MERGE^1")
ACTUAL_SECOND_PARENT=$(git rev-parse "$ACTUAL_MERGE^2")
ACTUAL_TREE=$(git rev-parse "$ACTUAL_MERGE^{tree}")
test "$ACTUAL_FIRST_PARENT" = "$PINNED_MAIN"
test "$ACTUAL_SECOND_PARENT" = "$EXPECTED_HEAD"
test "$ACTUAL_TREE" = "$EXPECTED_TREE"
PR_MERGE_JSON=$(gh pr view "$PR_NUMBER" --json state,mergeCommit)
test "$(printf '%s\n' "$PR_MERGE_JSON" | jq -r '.state')" = 'MERGED'
test "$(printf '%s\n' "$PR_MERGE_JSON" | jq -r '.mergeCommit.oid')" = \
  "$ACTUAL_MERGE"
ACCEPTED_MAIN_TAG=$(evidence_value accepted_main_binding_tag)
GENERATION=$(evidence_value evidence_generation)
test "$ACCEPTED_MAIN_TAG" = \
  "aais-recovery-accepted-main-20260710-$GENERATION"
if git show-ref --verify --quiet "refs/tags/$ACCEPTED_MAIN_TAG"; then
  test "$(git cat-file -t "$ACCEPTED_MAIN_TAG")" = 'tag'
  test "$(git rev-parse "$ACCEPTED_MAIN_TAG^{commit}")" = "$ACTUAL_MERGE"
else
  git tag -a "$ACCEPTED_MAIN_TAG" "$ACTUAL_MERGE" \
    -m "accepted_main_sha=$ACTUAL_MERGE" \
    -m "accepted_main_first_parent=$PINNED_MAIN" \
    -m "accepted_main_second_parent=$EXPECTED_HEAD" \
    -m "accepted_main_pr_head=$EXPECTED_HEAD" \
    -m "accepted_main_tree=$EXPECTED_TREE" \
    -m "evidence_generation=$GENERATION"
fi
for accepted_tag_line in \
  "accepted_main_sha=$ACTUAL_MERGE" \
  "accepted_main_first_parent=$PINNED_MAIN" \
  "accepted_main_second_parent=$EXPECTED_HEAD" \
  "accepted_main_pr_head=$EXPECTED_HEAD" \
  "accepted_main_tree=$EXPECTED_TREE" \
  "evidence_generation=$GENERATION"
do
  git for-each-ref "refs/tags/$ACCEPTED_MAIN_TAG" \
    --format='%(contents)' | grep -Fqx "$accepted_tag_line"
done
LOCAL_TAG_OBJECT=$(git rev-parse "$ACCEPTED_MAIN_TAG^{tag}")
LOCAL_TAG_COMMIT=$(git rev-parse "$ACCEPTED_MAIN_TAG^{commit}")
REMOTE_TAG_OBJECT=$(git ls-remote --tags origin \
  "refs/tags/$ACCEPTED_MAIN_TAG" | awk '
    NF == 2 { count += 1; value = $1 }
    END { if (count > 1) exit 1; print value }
  ')
REMOTE_TAG_COMMIT=$(git ls-remote --tags origin \
  "refs/tags/$ACCEPTED_MAIN_TAG^{}" | awk '
    NF == 2 { count += 1; value = $1 }
    END { if (count > 1) exit 1; print value }
  ')
if test -z "$REMOTE_TAG_OBJECT" && test -z "$REMOTE_TAG_COMMIT"; then
  git push origin "refs/tags/$ACCEPTED_MAIN_TAG"
else
  test "$REMOTE_TAG_OBJECT" = "$LOCAL_TAG_OBJECT"
  test "$REMOTE_TAG_COMMIT" = "$LOCAL_TAG_COMMIT"
fi
test "$(git ls-remote --tags origin "refs/tags/$ACCEPTED_MAIN_TAG" | \
  awk 'NF == 2 { count += 1; value = $1 } END { if (count != 1) exit 1; print value }')" = \
  "$LOCAL_TAG_OBJECT"
test "$(git ls-remote --tags origin "refs/tags/$ACCEPTED_MAIN_TAG^{}" | \
  awk 'NF == 2 { count += 1; value = $1 } END { if (count != 1) exit 1; print value }')" = \
  "$ACTUAL_MERGE"
test "$(git rev-parse refs/remotes/origin/main)" = "$ACTUAL_MERGE"
```

Exit `4` from either Step 4 or Step 5 means return to Task 8 Step 1, integrate
the newly fetched main, reassert policy, capture the predecessor generation,
create exactly the next evidence generation, rerun gates, and push the updated
sealed head. Then reuse the same open PR in Step 4, watch its new checks, and
perform this fresh-base comparison again. This loop handles any number of
consecutive advances. Only the exact latest seal target with checks passing and
`origin/main` still equal to `reviewed_live_main_sha` merges; PR head protection
still uses `--match-head-commit`, while the client-side SHA comparison only
narrows and detects part of the base race. The exact post-merge first parent,
second parent, tree, and GitHub merge OID checks close acceptance of the server
result. Execution never returns to the one-time Task 3.

The server result, not the pre-merge ancestry check, creates the cleanup pin.
If the actual commit is not a two-parent merge whose first parent is
`PINNED_MAIN`, whose second parent equals `EXPECTED_HEAD` exactly, whose tree
equals `EXPECTED_HEAD^{tree}` exactly, and whose OID matches GitHub's reported
merge commit, do not create the accepted-main tag and do not clean anything.
Enter the Task 9 drift-acceptance cycle on the exact actual fetched main, run
gates/evidence there, and accept only a later server result that passes the same
exact parent/tree checks. The pre-merge fetch and client SHA checks narrow and
detect races but cannot atomically prevent a server-side base advance.

### Task 9: Prove accepted-main prerequisites before any cleanup

- [ ] **Step 1: Prove source merges and immutable docs/policy/final bindings**

```bash
set -euo pipefail
ROOT=/Users/dongpinhu/Desktop/AAIS
EVIDENCE_PATH=docs/superpowers/recovery/2026-07-10-aais-dirty-inventory-equivalence.md
git -C "$ROOT" fetch origin main
EVIDENCE_COPY=$(mktemp /tmp/aais-recovery-evidence.XXXXXX)
trap 'rm -f "$EVIDENCE_COPY"' EXIT
git -C "$ROOT" show "origin/main:$EVIDENCE_PATH" > "$EVIDENCE_COPY"
evidence_value() {
  local key=$1
  awk -v key="$key" '
    index($0, key "=") == 1 { count += 1; value = substr($0, length(key) + 2) }
    END { if (count != 1) exit 1; print value }
  ' "$EVIDENCE_COPY"
}
ACCEPTED_MAIN_TAG=$(evidence_value accepted_main_binding_tag)
DOCS_TAG=$(evidence_value reviewed_docs_tag)
FINAL_TAG=$(evidence_value final_head_binding_tag)
for tag_name in "$DOCS_TAG" "$FINAL_TAG" "$ACCEPTED_MAIN_TAG"; do
  git -C "$ROOT" fetch origin \
    "refs/tags/$tag_name:refs/tags/$tag_name"
done
test "$(git -C "$ROOT" cat-file -t "$ACCEPTED_MAIN_TAG")" = 'tag'
ACCEPTED_MAIN=$(git -C "$ROOT" rev-parse "$ACCEPTED_MAIN_TAG^{commit}")
CURRENT_MAIN=$(git -C "$ROOT" rev-parse refs/remotes/origin/main)
if test "$CURRENT_MAIN" != "$ACCEPTED_MAIN"; then
  printf 'accepted_main_drift=%s\nrequired_exact_main=%s\n' \
    "$CURRENT_MAIN" "$ACCEPTED_MAIN"
  exit 6
fi
test "$(git -C "$ROOT" rev-list --parents -n 1 "$ACCEPTED_MAIN" | \
  awk '{print NF}')" -eq 3
for sha in \
  5e803c669b955abba8a3f6c1c665c5543875a21a \
  735011b3e002f6be46ff34f4a13c70834a69cfeb \
  ad2d5a05114b9f19297fcae4a232cc434c8b2f35 \
  33af4c30100f4c0ea02b765709eb83123e7b10ff \
  1d97d16998e95a92ebecb3a69a2ad14c9e0a566c
do
  git -C "$ROOT" merge-base --is-ancestor "$sha" "$ACCEPTED_MAIN"
  git -C "$ROOT" rev-list --parents --merges "$ACCEPTED_MAIN" | \
    awk -v sha="$sha" \
      '{ for (i = 3; i <= NF; i += 1) if ($i == sha) found = 1 } END { exit !found }'
done
DOCS_TAG_OBJECT=$(evidence_value reviewed_docs_tag_object)
DOCS_TIP=$(evidence_value reviewed_docs_tip)
DOCS_TREE=$(evidence_value reviewed_docs_tree)
test "$DOCS_TAG" = 'aais-recovery-docs-reviewed-20260710'
test "$(git -C "$ROOT" cat-file -t "$DOCS_TAG")" = 'tag'
test "$(git -C "$ROOT" rev-parse "$DOCS_TAG^{tag}")" = "$DOCS_TAG_OBJECT"
test "$(git -C "$ROOT" rev-parse "$DOCS_TAG^{commit}")" = "$DOCS_TIP"
test "$(git -C "$ROOT" show -s --format='%T' "$DOCS_TIP")" = "$DOCS_TREE"
test "$(git -C "$ROOT" rev-parse codex/aais-worktree-recovery-design)" = \
  "$DOCS_TIP"
git -C "$ROOT" merge-base --is-ancestor "$DOCS_TIP" "$ACCEPTED_MAIN"
POLICY_TIP=$(evidence_value policy_tip)
test "$(git -C "$ROOT" show -s --format='%s' "$POLICY_TIP")" = \
  'test: pin production trial fallback policy'
git -C "$ROOT" merge-base --is-ancestor "$POLICY_TIP" "$ACCEPTED_MAIN"
PINNED_MAIN=$(evidence_value reviewed_live_main_sha)
GENERATION=$(evidence_value evidence_generation)
test "$FINAL_TAG" = "aais-recovery-final-head-20260710-$GENERATION"
test "$(git -C "$ROOT" cat-file -t "$FINAL_TAG")" = 'tag'
SEALED_HEAD=$(git -C "$ROOT" rev-parse "$FINAL_TAG^{commit}")
test "$(git -C "$ROOT" rev-parse "$ACCEPTED_MAIN^1")" = "$PINNED_MAIN"
ACCEPTED_SECOND_PARENT=$(git -C "$ROOT" rev-parse "$ACCEPTED_MAIN^2")
ACCEPTED_TREE=$(git -C "$ROOT" rev-parse "$ACCEPTED_MAIN^{tree}")
SEALED_TREE=$(git -C "$ROOT" rev-parse "$SEALED_HEAD^{tree}")
test "$ACCEPTED_SECOND_PARENT" = "$SEALED_HEAD"
test "$ACCEPTED_TREE" = "$SEALED_TREE"
PREVIOUS_GENERATION=$(evidence_value previous_evidence_generation)
PREVIOUS_EVIDENCE_TIP=$(evidence_value previous_evidence_tip)
if test "$GENERATION" -eq 1; then
  test "$PREVIOUS_GENERATION" -eq 0
  test "$PREVIOUS_EVIDENCE_TIP" = 'NONE'
  if git -C "$ROOT" cat-file -e "$SEALED_HEAD^:$EVIDENCE_PATH" \
    2>/dev/null; then exit 1; fi
else
  test "$PREVIOUS_EVIDENCE_TIP" = \
    "$(git -C "$ROOT" rev-parse "$SEALED_HEAD^")"
  RECORDED_PREVIOUS_GENERATION=$(git -C "$ROOT" show \
    "$PREVIOUS_EVIDENCE_TIP:$EVIDENCE_PATH" | awk -F= '
      $1 == "evidence_generation" { count += 1; value = $2 }
      END { if (count != 1) exit 1; print value }
    ')
  test "$PREVIOUS_GENERATION" -eq "$RECORDED_PREVIOUS_GENERATION"
  test "$GENERATION" -eq "$((RECORDED_PREVIOUS_GENERATION + 1))"
fi
EVIDENCE_BLOB=$(git -C "$ROOT" rev-parse "$SEALED_HEAD:$EVIDENCE_PATH")
for tag_line in \
  "final_head_sha=$SEALED_HEAD" \
  "evidence_blob_sha=$EVIDENCE_BLOB" \
  "evidence_generation=$GENERATION"
do
  git -C "$ROOT" for-each-ref "refs/tags/$FINAL_TAG" \
    --format='%(contents)' | grep -Fqx "$tag_line"
done
for tag_name in "$DOCS_TAG" "$FINAL_TAG" "$ACCEPTED_MAIN_TAG"; do
  test "$(git -C "$ROOT" cat-file -t "$tag_name")" = 'tag'
  LOCAL_OBJECT=$(git -C "$ROOT" rev-parse "$tag_name^{tag}")
  LOCAL_COMMIT=$(git -C "$ROOT" rev-parse "$tag_name^{commit}")
  test "$(git -C "$ROOT" ls-remote --tags origin \
    "refs/tags/$tag_name" | awk '
      NF == 2 { count += 1; value = $1 }
      END { if (count != 1) exit 1; print value }
    ')" = "$LOCAL_OBJECT"
  test "$(git -C "$ROOT" ls-remote --tags origin \
    "refs/tags/$tag_name^{}" | awk '
      NF == 2 { count += 1; value = $1 }
      END { if (count != 1) exit 1; print value }
    ')" = "$LOCAL_COMMIT"
done
for accepted_tag_line in \
  "accepted_main_sha=$ACCEPTED_MAIN" \
  "accepted_main_first_parent=$PINNED_MAIN" \
  "accepted_main_second_parent=$SEALED_HEAD" \
  "accepted_main_pr_head=$SEALED_HEAD" \
  "accepted_main_tree=$SEALED_TREE" \
  "evidence_generation=$GENERATION"
do
  git -C "$ROOT" for-each-ref "refs/tags/$ACCEPTED_MAIN_TAG" \
    --format='%(contents)' | grep -Fqx "$accepted_tag_line"
done
```

Expected: current `origin/main` equals the generation-bound accepted-main tag
exactly; the merge's first parent is the pinned base, its second parent equals
the sealed PR head exactly, and its tree equals the sealed head tree exactly.
The five source parents, docs, policy, and evidence are present, and
reviewed-docs/final/accepted annotated tag objects and peeled commits match the
remote exactly. An advance or parent/tree mismatch exits before any gate or
cleanup action.

Exit `6` starts a new evidence-acceptance cycle; it never resumes cleanup by
ancestry alone and never runs gates in the old sealed compose worktree. Create
an independent clean checkout at the newly fetched exact main:

```bash
set -euo pipefail
ROOT=/Users/dongpinhu/Desktop/AAIS
EVIDENCE_PATH=docs/superpowers/recovery/2026-07-10-aais-dirty-inventory-equivalence.md
git -C "$ROOT" fetch origin main
DRIFT_MAIN=$(git -C "$ROOT" rev-parse refs/remotes/origin/main)
printf '%s\n' "$DRIFT_MAIN" | grep -Eq '^[0-9a-f]{40}$'
CURRENT_EVIDENCE=$(mktemp /tmp/aais-recovery-current-evidence.XXXXXX)
trap 'rm -f "$CURRENT_EVIDENCE"' EXIT
git -C "$ROOT" show "refs/remotes/origin/main:$EVIDENCE_PATH" > \
  "$CURRENT_EVIDENCE"
OLD_GENERATION=$(awk -F= '
  $1 == "evidence_generation" { count += 1; value = $2 }
  END { if (count != 1) exit 1; print value }
' "$CURRENT_EVIDENCE")
OLD_ACCEPTED_TAG=$(awk -F= '
  $1 == "accepted_main_binding_tag" { count += 1; value = $2 }
  END { if (count != 1) exit 1; print value }
' "$CURRENT_EVIDENCE")
REMOTE_OLD_ACCEPTED_OBJECT=$(git -C "$ROOT" ls-remote --tags origin \
  "refs/tags/$OLD_ACCEPTED_TAG" | awk '
    NF == 2 { count += 1; value = $1 }
    END { if (count > 1) exit 1; print value }
  ')
if test -n "$REMOTE_OLD_ACCEPTED_OBJECT"; then
  git -C "$ROOT" fetch origin \
    "refs/tags/$OLD_ACCEPTED_TAG:refs/tags/$OLD_ACCEPTED_TAG"
fi
if git -C "$ROOT" show-ref --verify --quiet "refs/tags/$OLD_ACCEPTED_TAG"; then
  OLD_ACCEPTED_MAIN=$(git -C "$ROOT" rev-parse \
    "$OLD_ACCEPTED_TAG^{commit}")
else
  OLD_ACCEPTED_MAIN=$(awk -F= '
    $1 == "reviewed_live_main_sha" { count += 1; value = $2 }
    END { if (count != 1) exit 1; print value }
  ' "$CURRENT_EVIDENCE")
fi
git -C "$ROOT" merge-base --is-ancestor "$OLD_ACCEPTED_MAIN" "$DRIFT_MAIN"
NEXT_GENERATION=$((OLD_GENERATION + 1))
ACCEPTANCE_BRANCH="codex/aais-recovery-main-acceptance-$NEXT_GENERATION"
ACCEPTANCE_WT="/private/tmp/aais-recovery-main-acceptance-$DRIFT_MAIN"
test ! -e "$ACCEPTANCE_WT"
REMOTE_URL=$(git -C "$ROOT" remote get-url origin)
git clone --no-checkout "$REMOTE_URL" "$ACCEPTANCE_WT"
git -C "$ACCEPTANCE_WT" fetch origin main
test "$(git -C "$ACCEPTANCE_WT" rev-parse refs/remotes/origin/main)" = \
  "$DRIFT_MAIN"
git -C "$ACCEPTANCE_WT" switch -c "$ACCEPTANCE_BRANCH" "$DRIFT_MAIN"
test -z "$(git -C "$ACCEPTANCE_WT" status --porcelain=v1 -uall)"
```

From `ACCEPTANCE_WT`, run `npm ci`; rerun all Task 5 root/snapshot/path
comparisons with the comparison target set to this checkout; then run every
Task 6 focused/full/E2E/CI-build/hygiene/diff/clean gate. Do not use the old
compose gate directory or counts. Update the checked-in evidence with
`previous_evidence_tip=DRIFT_MAIN`, the exact old/next generations,
`reviewed_live_main_sha=DRIFT_MAIN`, all newly computed root/comparison/gate
values, `acceptance_checkout_path=ACCEPTANCE_WT`,
`publication_head_branch=ACCEPTANCE_BRANCH`,
`publication_repo_path=ACCEPTANCE_WT`, and the generation-specific
final/accepted tag names. Re-run Task 7 Steps 2-5 from `ACCEPTANCE_WT` so exact
`+1`, structured sets/counts, and a new final tag in that clone's object store
are proven on the clean checkout.

Publish this evidence-only branch through Task 8 Steps 4-5. That creates or
reuses only its exact PR, watches the new checks, rechecks the base, proves the
server merge parents, and creates the next accepted-main tag. If main advances
again, stay in the clean acceptance checkout and repeat the same generation
loop. When Task 9 Step 1 finally proves exact equality, retain the independent
checkout as a declared removal target from `acceptance_checkout_path`; it is
subject to the same private-artifact preservation and last-moment guards as
every other target.

- [ ] **Step 2: Prove the structured evidence schema and exact policy content**

```bash
set -euo pipefail
ROOT=/Users/dongpinhu/Desktop/AAIS
EVIDENCE_PATH=docs/superpowers/recovery/2026-07-10-aais-dirty-inventory-equivalence.md
git -C "$ROOT" fetch origin main
EVIDENCE_COPY=$(mktemp /tmp/aais-recovery-evidence.XXXXXX)
trap 'rm -f "$EVIDENCE_COPY"' EXIT
git -C "$ROOT" show "origin/main:$EVIDENCE_PATH" > "$EVIDENCE_COPY"
evidence_value() {
  local key=$1
  awk -v key="$key" '
    index($0, key "=") == 1 { count += 1; value = substr($0, length(key) + 2) }
    END { if (count != 1) exit 1; print value }
  ' "$EVIDENCE_COPY"
}
diff -u \
  <(printf '%s\n' \
    accepted_main_binding_tag acceptance_checkout_path bobie_commit_vs_base_sha256 bobie_source_tip build_status ci_status \
    clean_tree_status compose_tip_before_evidence \
    compose_vs_reviewed_live_main_sha256 daily_source_tip diff_check_status \
    e2e_expected_tests e2e_unexpected_tests evidence_generation \
    final_head_binding_tag focused_failed_tests focused_file_count \
    focused_passed_tests focused_total_tests full_failed_tests \
    full_passed_tests full_total_tests gate_capture_dir hygiene_status \
    locked_source_tip lrs_source_tip policy_tip \
    previous_evidence_generation previous_evidence_tip publication_head_branch \
    publication_repo_path \
    production_trial_policy_status rescued_behavior_status \
    reviewed_docs_tag reviewed_docs_tag_object reviewed_docs_tip \
    reviewed_docs_tree reviewed_live_main_sha root_tracked_vs_head_sha256 \
    root_vs_reviewed_live_main_sha256 schema_version secret_values_status \
    session_source_tip snapshot_bobie_main_deploy_sha256 \
    snapshot_bobie_main_fix2_sha256 snapshot_bobie_prod_fix_sha256 \
    snapshot_migration_sha256 snapshot_mode snapshot_path \
    snapshot_recorded_origin_main snapshot_root_head \
    snapshot_root_tracked_vs_head_sha256 \
    snapshot_root_tracked_vs_recorded_main_sha256 | LC_ALL=C sort) \
  <(sed -n 's/^\([a-z0-9_]*\)=.*/\1/p' "$EVIDENCE_COPY" | LC_ALL=C sort)
test "$(evidence_value schema_version)" = '2'
test "$(evidence_value production_trial_policy_status)" = 'PASS'
test "$(evidence_value rescued_behavior_status)" = 'PASS'
test "$(evidence_value secret_values_status)" = 'OMITTED'
test "$(git -C "$ROOT" log -1 --format='%s' origin/main -- "$EVIDENCE_PATH")" = \
  'docs: record AAIS dirty inventory equivalence'
for test_name in \
  'refuses trial account login when the trial-login entry is disabled' \
  'keeps Bobie and Phoebe available as production learner fallbacks' \
  'keeps a unique configured learner available alongside production fallbacks' \
  'keeps built-in credentials authoritative for duplicate Bobie and Phoebe identifiers' \
  'refuses production teacher trial accounts' \
  'refuses production admin trial accounts'
do
  git -C "$ROOT" show origin/main:tests/auth-route.test.ts | \
    grep -Fq "it(\"$test_name\""
done
git -C "$ROOT" show origin/main:tests/smoke-prod.test.mjs | grep -Fq \
  'optionally proves a known demo credential is rejected without setting a session cookie'
git -C "$ROOT" show origin/main:README.md | grep -Fqx \
  'Production may use the built-in Bobie and Phoebe learner fallback while trial login is enabled; set `AAIS_TRIAL_LOGIN_ENABLED=false` to disable all trial login. Production teacher and admin trial identities are forbidden and must use database users or OIDC identities.'
git -C "$ROOT" show origin/main:OPERATIONS.md | grep -Fqx \
  'Bobie and Phoebe are valid production learner fallbacks while trial login is enabled; never use them as blocked smoke credentials.'
git -C "$ROOT" show origin/main:OPERATIONS.md | grep -Fqx \
  'Use `retired-demo-account` only for the blocked-credential check and supply its retired password through `AAIS_SMOKE_BLOCKED_TRIAL_PASSWORD`.'
git -C "$ROOT" show origin/main:OPERATIONS.md | grep -Fq \
  'AAIS_SMOKE_BLOCKED_TRIAL_ACCOUNT=retired-demo-account'
ACCEPTED_CHECKLIST='- [ ] Production smoke proves Bobie and Phoebe or a dedicated learner can sign in and the distinct `retired-demo-account` credential is rejected without a session cookie.'
CHECKLIST_CONTENT=$(git -C "$ROOT" show \
  origin/main:docs/release-checklist.md)
test "$(printf '%s\n' "$CHECKLIST_CONTENT" | \
  grep -Fxc -- "$ACCEPTED_CHECKLIST")" -eq 2
for old_checklist_line in \
  '- [ ] `npm run smoke:prod` passes against the staging URL using a dedicated smoke account and retired-demo credential rejection.' \
  '- [ ] `npm run smoke:prod` passes against `https://www.aais.site`, including retired-demo credential rejection.'
do
  if printf '%s\n' "$CHECKLIST_CONTENT" | \
    grep -Fqx -- "$old_checklist_line"; then exit 1; fi
done
if git -C "$ROOT" show origin/main:README.md | \
  grep -Fq 'production excludes them'; then exit 1; fi
if git -C "$ROOT" show origin/main:OPERATIONS.md | \
  grep -Fq 'AAIS_SMOKE_BLOCKED_TRIAL_ACCOUNT=Bobie'; then exit 1; fi
```

Expected: the exact schema is complete with one value per key, and all six
independent auth behaviors plus all accepted documentation sentences survive.

- [ ] **Step 3: Prove every intended accepted-main path exists**

```bash
set -euo pipefail
ROOT=/Users/dongpinhu/Desktop/AAIS
for file_path in \
  src/app/api/learning/ai-guide/route.ts \
  src/app/api/learning/scaffold/route.ts \
  src/lib/server/aais-learning-store.ts \
  src/lib/server/aais-lrs-client.ts \
  src/lib/server/aais-trial-accounts.ts \
  tests/aais-api-routes.test.ts \
  tests/aais-backend-store.test.ts \
  tests/aais-lrs-client.test.ts \
  tests/aais-session-revocations.test.ts \
  tests/auth-route.test.ts \
  tests/postgres-migrations.test.mjs \
  migrations/postgres/0008_ai_guide_daily_usage.sql \
  tests/readiness-route.test.ts \
  docs/privacy-data-inventory.md \
  README.md \
  OPERATIONS.md \
  docs/release-checklist.md \
  docs/superpowers/recovery/2026-07-10-aais-dirty-inventory-equivalence.md
do
  git -C "$ROOT" cat-file -e "origin/main:$file_path"
done
```

Expected: all 18 intended source/review/policy/evidence paths exist.

- [ ] **Step 4: Re-run structured gates and compare actual counts**

Run from the sealed checkout named by evidence: the original clean compose for
the initial generation, or the independent clean acceptance checkout after a
post-merge main advance. Cleanup never runs these gates on an old sealed
compose after drift and never trusts recorded `PASS` strings:

```bash
set -euo pipefail
ROOT=/Users/dongpinhu/Desktop/AAIS
EVIDENCE_PATH=docs/superpowers/recovery/2026-07-10-aais-dirty-inventory-equivalence.md
EVIDENCE_COPY=$(mktemp /tmp/aais-recovery-evidence.XXXXXX)
trap 'rm -f "$EVIDENCE_COPY"' EXIT
git -C "$ROOT" show "origin/main:$EVIDENCE_PATH" > "$EVIDENCE_COPY"
evidence_value() {
  local key=$1
  awk -v key="$key" '
    index($0, key "=") == 1 { count += 1; value = substr($0, length(key) + 2) }
    END { if (count != 1) exit 1; print value }
  ' "$EVIDENCE_COPY"
}
ACCEPTED_MAIN_TAG=$(evidence_value accepted_main_binding_tag)
git -C "$ROOT" fetch origin \
  "refs/tags/$ACCEPTED_MAIN_TAG:refs/tags/$ACCEPTED_MAIN_TAG"
ACCEPTED_MAIN=$(git -C "$ROOT" rev-parse \
  "$ACCEPTED_MAIN_TAG^{commit}")
if test "$(git -C "$ROOT" rev-parse refs/remotes/origin/main)" != \
  "$ACCEPTED_MAIN"; then
  exit 6
fi
ACCEPTANCE_CHECKOUT=$(evidence_value acceptance_checkout_path)
if test "$ACCEPTANCE_CHECKOUT" = 'NONE'; then
  GATE_CHECKOUT="$ROOT/.worktrees/aais-recovery-compose"
else
  GATE_CHECKOUT="$ACCEPTANCE_CHECKOUT"
fi
test "$(evidence_value publication_repo_path)" = "$GATE_CHECKOUT"
cd "$GATE_CHECKOUT"
FINAL_TAG=$(evidence_value final_head_binding_tag)
git fetch origin "refs/tags/$FINAL_TAG:refs/tags/$FINAL_TAG"
SEALED_HEAD=$(git rev-parse "$FINAL_TAG^{commit}")
test "$(git rev-parse HEAD)" = "$SEALED_HEAD"
test "$(git -C "$ROOT" rev-parse "$ACCEPTED_MAIN^2")" = \
  "$SEALED_HEAD"
test "$(git -C "$ROOT" rev-parse "$ACCEPTED_MAIN^{tree}")" = \
  "$(git rev-parse "$SEALED_HEAD^{tree}")"
CLEANUP_GATE_DIR="/tmp/aais-recovery-cleanup-gates-$SEALED_HEAD"
test ! -e "$CLEANUP_GATE_DIR"
mkdir -m 700 "$CLEANUP_GATE_DIR"
npx vitest run \
  tests/aais-session-revocations.test.ts \
  tests/auth-route.test.ts \
  tests/smoke-prod.test.mjs \
  tests/aais-api-routes.test.ts \
  tests/aais-backend-store.test.ts \
  tests/aais-lrs-client.test.ts \
  tests/postgres-migrations.test.mjs \
  tests/readiness-route.test.ts \
  --reporter=json --outputFile="$CLEANUP_GATE_DIR/focused-vitest.json"
npx vitest run --reporter=json \
  --outputFile="$CLEANUP_GATE_DIR/full-vitest.json"
npm run --silent e2e -- --reporter=json > \
  "$CLEANUP_GATE_DIR/playwright.json"
test "$(jq -r '.numTotalTests' "$CLEANUP_GATE_DIR/focused-vitest.json")" = \
  "$(evidence_value focused_total_tests)"
test "$(jq -r '.numPassedTests' "$CLEANUP_GATE_DIR/focused-vitest.json")" = \
  "$(evidence_value focused_passed_tests)"
test "$(jq -r '.numFailedTests' "$CLEANUP_GATE_DIR/focused-vitest.json")" = \
  "$(evidence_value focused_failed_tests)"
test "$(jq -r '.numTotalTests' "$CLEANUP_GATE_DIR/full-vitest.json")" = \
  "$(evidence_value full_total_tests)"
test "$(jq -r '.numPassedTests' "$CLEANUP_GATE_DIR/full-vitest.json")" = \
  "$(evidence_value full_passed_tests)"
test "$(jq -r '.numFailedTests' "$CLEANUP_GATE_DIR/full-vitest.json")" = \
  "$(evidence_value full_failed_tests)"
test "$(jq -r '.stats.expected' "$CLEANUP_GATE_DIR/playwright.json")" = \
  "$(evidence_value e2e_expected_tests)"
test "$(jq -r '.stats.unexpected' "$CLEANUP_GATE_DIR/playwright.json")" = \
  "$(evidence_value e2e_unexpected_tests)"
test "$(node -p "require('./package.json').scripts.ci")" = \
  'npm run lint && npm run type-check && npm test && npm run build'
npm run ci
test "$(evidence_value ci_status)" = 'PASS'
test "$(evidence_value build_status)" = 'PASS'
npm run hygiene:check
test "$(evidence_value hygiene_status)" = 'PASS'
git diff --check
test "$(evidence_value diff_check_status)" = 'PASS'
test -z "$(git status --porcelain=v1 -uall)"
test "$(evidence_value clean_tree_status)" = 'PASS'
```

Expected: fresh focused, full, and E2E counts exactly equal the pinned counts;
CI/build, hygiene, diff, and clean-tree commands all pass again.

- [ ] **Step 5: Revalidate pinned root hashes and exact inventory sections**

```bash
set -euo pipefail
ROOT=/Users/dongpinhu/Desktop/AAIS
EVIDENCE_PATH=docs/superpowers/recovery/2026-07-10-aais-dirty-inventory-equivalence.md
EVIDENCE_COPY=$(mktemp /tmp/aais-recovery-evidence.XXXXXX)
trap 'rm -f "$EVIDENCE_COPY"' EXIT
git -C "$ROOT" show "origin/main:$EVIDENCE_PATH" > "$EVIDENCE_COPY"
evidence_value() {
  local key=$1
  awk -v key="$key" '
    index($0, key "=") == 1 { count += 1; value = substr($0, length(key) + 2) }
    END { if (count != 1) exit 1; print value }
  ' "$EVIDENCE_COPY"
}
evidence_section() {
  local begin_marker=$1
  local end_marker=$2
  awk -v begin_marker="$begin_marker" -v end_marker="$end_marker" '
    $0 == begin_marker { if (inside || seen) exit 2; inside = 1; seen = 1; next }
    $0 == end_marker { if (!inside || ended) exit 3; inside = 0; ended = 1; next }
    inside { print }
    END { if (!seen || !ended || inside) exit 4 }
  ' "$EVIDENCE_COPY"
}
PINNED_MAIN=$(evidence_value reviewed_live_main_sha)
ACCEPTED_MAIN_TAG=$(evidence_value accepted_main_binding_tag)
git -C "$ROOT" fetch origin \
  "refs/tags/$ACCEPTED_MAIN_TAG:refs/tags/$ACCEPTED_MAIN_TAG"
ACCEPTED_MAIN=$(git -C "$ROOT" rev-parse "$ACCEPTED_MAIN_TAG^{commit}")
git -C "$ROOT" fetch origin main
test "$(git -C "$ROOT" rev-parse refs/remotes/origin/main)" = \
  "$ACCEPTED_MAIN"
test "$(git -C "$ROOT" diff --binary | shasum -a 256 | awk '{print $1}')" = \
  "$(evidence_value root_tracked_vs_head_sha256)"
test "$(git -C "$ROOT" diff --binary "$PINNED_MAIN" -- | \
  shasum -a 256 | awk '{print $1}')" = \
  "$(evidence_value root_vs_reviewed_live_main_sha256)"
test "$(git -C "$ROOT" rev-parse HEAD)" = \
  "$(evidence_value snapshot_root_head)"
diff -u \
  <(git -C "$ROOT" status --porcelain=v1 -uall | LC_ALL=C sort) \
  <(evidence_section BEGIN_ROOT_INVENTORY END_ROOT_INVENTORY | LC_ALL=C sort)
diff -u \
  <(git -C "$ROOT" worktree list --porcelain | \
    sed -n 's/^worktree //p' | LC_ALL=C sort) \
  <(evidence_section BEGIN_WORKTREE_CLASSIFICATIONS \
    END_WORKTREE_CLASSIFICATIONS | cut -d '|' -f 1 | LC_ALL=C sort)
diff -u \
  <(printf '%s\n' \
    'bobie|source behavior comes from 1d97d16; final auth coverage strengthens the root copy' \
    'daily|adds readiness and privacy paths and stricter durable database behavior' \
    'locked|preserves locked-task mutation rejection across shared store and route files' \
    'lrs|replaces batch-wide failure handling with per-row response validation' \
    'live-main|integrated when required and pinned by reviewed_live_main_sha' \
    'policy|reconciles learner fallback, disable, unique learner, teacher denial, admin denial, and retired credential behavior' \
    'session|root copy matched recorded main; reviewed deterministic source remains a non-first merge parent' \
    'shared-files|resolved by preserving all independently reviewed behaviors and rerunning focused plus full gates' | LC_ALL=C sort) \
  <(evidence_section BEGIN_DEVIATIONS END_DEVIATIONS | LC_ALL=C sort)
```

Expected: cleanup sees exact accepted-main equality, the same pinned root HEAD,
tracked diff, root-versus-pinned prepublication-main diff, root 11+1 set,
ten-worktree set, and deviation set recorded by the latest evidence generation.
Any current-main change stops; ancestry alone never authorizes cleanup.

Finally repeat Task 1 Steps 5 and 7 to recheck snapshot mode/hashes and the
three external-worktree states. Do not weaken any expected value. Any drift
stops cleanup.

- [ ] **Step 6: Inventory and preserve ignored/private content before cleanup**

The reviewed name-only baseline found `.aais-data` in six removal targets and
`.vercel` in prod-fix. `node_modules`, `.next`, `test-results`, and
`tsconfig.tsbuildinfo` are the only explicit reproducible allowlist. Every
`.aais-data`, `.vercel`, `.env`, `.env.*`, `All API Keys.docx`, other unknown
ignored path, or untracked path is private/unknown and must be archived. The
root checkout is deliberately excluded and its ignored/private data remains
untouched.

This block records only top-level names and metadata; it never prints or reads
secret file contents except as opaque bytes while building/verifying the
owner-only archive:

```bash
set -euo pipefail
ROOT=/Users/dongpinhu/Desktop/AAIS
EVIDENCE_PATH=docs/superpowers/recovery/2026-07-10-aais-dirty-inventory-equivalence.md
EVIDENCE_COPY=$(mktemp /tmp/aais-recovery-evidence.XXXXXX)
TAR_PROOF=$(mktemp -d /private/tmp/aais-tar-null-proof.XXXXXX)
trap 'rm -f "$EVIDENCE_COPY"; rm -r -- "$TAR_PROOF"' EXIT
git -C "$ROOT" show "refs/remotes/origin/main:$EVIDENCE_PATH" > \
  "$EVIDENCE_COPY"
evidence_value() {
  local key=$1
  awk -v key="$key" '
    index($0, key "=") == 1 { count += 1; value = substr($0, length(key) + 2) }
    END { if (count != 1) exit 1; print value }
  ' "$EVIDENCE_COPY"
}
ACCEPTED_MAIN_TAG=$(evidence_value accepted_main_binding_tag)
git -C "$ROOT" fetch origin \
  "refs/tags/$ACCEPTED_MAIN_TAG:refs/tags/$ACCEPTED_MAIN_TAG"
ACCEPTED_MAIN=$(git -C "$ROOT" rev-parse "$ACCEPTED_MAIN_TAG^{commit}")
git -C "$ROOT" fetch origin main
test "$(git -C "$ROOT" rev-parse refs/remotes/origin/main)" = \
  "$ACCEPTED_MAIN"
tar --version | grep -Eq '^bsdtar '
TAR_PROOF_SOURCE="$TAR_PROOF/source"
TAR_PROOF_RESTORE="$TAR_PROOF/restore"
TAR_PROOF_LIST="$TAR_PROOF/names.nul"
TAR_PROOF_ARCHIVE="$TAR_PROOF/adversarial.tar"
mkdir -m 700 "$TAR_PROOF_SOURCE" "$TAR_PROOF_RESTORE"
TAR_DASH_NAME='-C'
TAR_NEWLINE_NAME=$'line\nbreak'
mkdir "$TAR_PROOF_SOURCE/$TAR_DASH_NAME" \
  "$TAR_PROOF_SOURCE/$TAR_NEWLINE_NAME"
printf 'dash-entry\n' > "$TAR_PROOF_SOURCE/$TAR_DASH_NAME/value.txt"
printf 'newline-entry\n' > \
  "$TAR_PROOF_SOURCE/$TAR_NEWLINE_NAME/value.txt"
printf '%s\0%s\0' "$TAR_DASH_NAME" "$TAR_NEWLINE_NAME" > \
  "$TAR_PROOF_LIST"
test "$(tr -cd '\000' < "$TAR_PROOF_LIST" | wc -c | tr -d ' ')" -eq 2
tar --null -b 1 -cf "$TAR_PROOF_ARCHIVE" -C "$TAR_PROOF_SOURCE" \
  -T "$TAR_PROOF_LIST"
tar -tf "$TAR_PROOF_ARCHIVE" >/dev/null
tar -xf "$TAR_PROOF_ARCHIVE" -C "$TAR_PROOF_RESTORE"
cmp -s "$TAR_PROOF_SOURCE/$TAR_DASH_NAME/value.txt" \
  "$TAR_PROOF_RESTORE/$TAR_DASH_NAME/value.txt"
cmp -s "$TAR_PROOF_SOURCE/$TAR_NEWLINE_NAME/value.txt" \
  "$TAR_PROOF_RESTORE/$TAR_NEWLINE_NAME/value.txt"
test "$(tar --null -b 1 -cf - -C "$TAR_PROOF_SOURCE" \
  -T "$TAR_PROOF_LIST" | shasum -a 256 | awk '{print $1}')" = \
  "$(shasum -a 256 "$TAR_PROOF_ARCHIVE" | awk '{print $1}')"
ARCHIVE_ROOT="/Users/dongpinhu/Desktop/AAIS-private-worktree-archives/$ACCEPTED_MAIN"
umask 077
mkdir -p "$ARCHIVE_ROOT"
chmod 700 "$ARCHIVE_ROOT"
targets=(
  '/private/tmp/aais-bobie-main-deploy-20260710'
  '/private/tmp/aais-bobie-main-fix2-20260710'
  '/private/tmp/aais-bobie-prod-fix-20260710'
  "$ROOT/.worktrees/aais-session-revocation-test"
  "$ROOT/.worktrees/aais-locked-task-guard"
  "$ROOT/.worktrees/aais-daily-guide-budget"
  "$ROOT/.worktrees/aais-lrs-outbox-hardening"
  "$ROOT/.worktrees/aais-recovery-compose"
  "$ROOT/.worktrees/aais-worktree-recovery-design"
)
ACCEPTANCE_CHECKOUT=$(evidence_value acceptance_checkout_path)
if test "$ACCEPTANCE_CHECKOUT" != 'NONE'; then
  targets+=("$ACCEPTANCE_CHECKOUT")
fi
inventory_top_level_nul() {
  local wt=$1
  git -C "$wt" status --porcelain=v1 --ignored -z -uall | \
    while IFS= read -r -d '' record; do
      case "$record" in
        '!! '*|'?? '*)
          relative_name=${record#???}
          printf '%s\0' "${relative_name%%/*}"
          ;;
      esac
    done | LC_ALL=C sort -zu
}
for wt in "${targets[@]}"; do
  test "$wt" != "$ROOT"
  test -d "$wt"
  target_id=$(printf '%s' "$wt" | shasum -a 256 | awk '{print $1}')
  target_archive_dir="$ARCHIVE_ROOT/$target_id"
  mkdir -m 700 "$target_archive_dir"
  printf 'source_worktree=%s\naccepted_main=%s\n' "$wt" "$ACCEPTED_MAIN" > \
    "$target_archive_dir/source.txt"
  inventory_top_level_nul "$wt" > "$target_archive_dir/top-level.nul"
  : > "$target_archive_dir/reproducible.nul"
  : > "$target_archive_dir/preserve.nul"
  : > "$target_archive_dir/metadata.nul"
  while IFS= read -r -d '' relative_name; do
    test -n "$relative_name"
    case "$relative_name" in
      node_modules|.next|test-results|tsconfig.tsbuildinfo)
        classification=reproducible
        printf '%s\0' "$relative_name" >> \
          "$target_archive_dir/reproducible.nul"
        ;;
      .aais-data|.vercel|.env|.env.*|'All API Keys.docx')
        classification=private
        printf '%s\0' "$relative_name" >> \
          "$target_archive_dir/preserve.nul"
        ;;
      *)
        classification=unknown-private
        printf '%s\0' "$relative_name" >> \
          "$target_archive_dir/preserve.nul"
        ;;
    esac
    entry="$wt/$relative_name"
    test -e "$entry" || test -L "$entry"
    entry_count=$(find "$entry" -xdev -print0 | \
      tr -cd '\000' | wc -c | tr -d ' ')
    entry_kib=$(du -sk "$entry" | awk '{print $1}')
    entry_metadata=$(stat -f '%HT|%Sp|%u|%g|%z|%m' "$entry")
    printf '%s\0%s\0%s\0entries=%s\0kib=%s\0' \
      "$relative_name" "$classification" "$entry_metadata" \
      "$entry_count" "$entry_kib" >> "$target_archive_dir/metadata.nul"
  done < "$target_archive_dir/top-level.nul"
  LC_ALL=C sort -zu "$target_archive_dir/preserve.nul" -o \
    "$target_archive_dir/preserve.nul"
  PRIVATE_ARCHIVE="$target_archive_dir/private-unknown-preimage.tar"
  tar --null -b 1 -cf "$PRIVATE_ARCHIVE" -C "$wt" \
    -T "$target_archive_dir/preserve.nul"
  shasum -a 256 "$PRIVATE_ARCHIVE" > \
    "$target_archive_dir/private-unknown-preimage.sha256"
  PRESERVE_COUNT=$(tr -cd '\000' < "$target_archive_dir/preserve.nul" | \
    wc -c | tr -d ' ')
  printf 'preserved_top_level_count=%s\narchive=%s\nrestore_to_owner_only_scratch=tar -xf %s -C SCRATCH_DIRECTORY\n' \
    "$PRESERVE_COUNT" "$PRIVATE_ARCHIVE" "$PRIVATE_ARCHIVE" > \
    "$target_archive_dir/restore-instructions.txt"
  chmod 600 "$target_archive_dir"/*
  test "$(stat -f '%Sp' "$target_archive_dir")" = 'drwx------'
  for archive_file in "$target_archive_dir"/*; do
    test "$(stat -f '%Sp' "$archive_file")" = '-rw-------'
  done
  (cd "$target_archive_dir" && shasum -a 256 -c \
    private-unknown-preimage.sha256 >/dev/null)
  tar -tf "$PRIVATE_ARCHIVE" >/dev/null
  inventory_top_level_nul "$wt" > "$target_archive_dir/top-level-now.nul"
  chmod 600 "$target_archive_dir/top-level-now.nul"
  cmp -s "$target_archive_dir/top-level.nul" \
    "$target_archive_dir/top-level-now.nul"
done
test "$(stat -f '%Sp' "$ARCHIVE_ROOT")" = 'drwx------'
test "$(find "$ARCHIVE_ROOT" -mindepth 1 -maxdepth 1 -type d | \
  wc -l | tr -d ' ')" -eq "${#targets[@]}"
```

Expected: every ignored/untracked top-level name is classified without content
logging. All name-bearing manifests are NUL-delimited; BSD tar reads them with
`--null`, which disables special `-C` handling, and uses `-b 1` so later
streamed byte comparisons match the regular archive. Reproducible artifacts are
allowlisted separately; every private or unknown item has an owner-only
archive, NUL-safe metadata/count manifest, SHA-256, permission/archive check,
and scratch-only restore instruction. A missing archive, changed
classification, or permission/hash mismatch stops. Leading-option and embedded
newline names remain opaque and preserved. No root ignored path is read, moved,
or deleted.

### Task 10: Close the dirty root from its current rescue index

- [ ] **Step 1: Open an exclusive root window and restore the exact 11 tracked paths**

The named sentinel, process scan, and read-only `lsof` are evidence supporting
an operator-exclusive window; they are not a magical filesystem lock. The
operator must stop editors, dev servers, and background writers first and set
the exact confirmation value only for this block.

```bash
set -euo pipefail
ROOT=/Users/dongpinhu/Desktop/AAIS
SNAP=/Users/dongpinhu/Desktop/AAIS-dirty-worktree-backups/20260710-145253-worktree-recovery-refresh
EVIDENCE_PATH=docs/superpowers/recovery/2026-07-10-aais-dirty-inventory-equivalence.md
test "${AAIS_CLEANUP_EXCLUSIVE_CONFIRMATION:-}" = \
  'root-exclusive-no-editor-dev-server-or-background-writer'
LOCK=/private/tmp/aais-recovery-root-tracked-cleanup.lock
mkdir -m 700 "$LOCK"
trap 'rmdir "$LOCK"' EXIT
git -C "$ROOT" fetch origin main
EVIDENCE_COPY=$(mktemp /tmp/aais-recovery-evidence.XXXXXX)
trap 'rm -f "$EVIDENCE_COPY"; rmdir "$LOCK"' EXIT
git -C "$ROOT" show "refs/remotes/origin/main:$EVIDENCE_PATH" > \
  "$EVIDENCE_COPY"
evidence_value() {
  local key=$1
  awk -v key="$key" '
    index($0, key "=") == 1 { count += 1; value = substr($0, length(key) + 2) }
    END { if (count != 1) exit 1; print value }
  ' "$EVIDENCE_COPY"
}
ACCEPTED_MAIN_TAG=$(evidence_value accepted_main_binding_tag)
git -C "$ROOT" fetch origin \
  "refs/tags/$ACCEPTED_MAIN_TAG:refs/tags/$ACCEPTED_MAIN_TAG"
ACCEPTED_MAIN=$(git -C "$ROOT" rev-parse \
  "$ACCEPTED_MAIN_TAG^{commit}")
test "$(git -C "$ROOT" rev-parse refs/remotes/origin/main)" = \
  "$ACCEPTED_MAIN"
ROOT_WRITERS=$(ps -Ao pid=,command= | awk -v root="$ROOT" \
  'index($0, root) > 0 && index($0, "/.worktrees/") == 0 && index($0, "ps -Ao") == 0 { print }')
test -z "$ROOT_WRITERS"
assert_no_open_dirty_files() {
  local file_path
  for file_path in \
    src/app/api/learning/ai-guide/route.ts \
    src/app/api/learning/scaffold/route.ts \
    src/lib/server/aais-learning-store.ts \
    src/lib/server/aais-lrs-client.ts \
    src/lib/server/aais-trial-accounts.ts \
    tests/aais-api-routes.test.ts \
    tests/aais-backend-store.test.ts \
    tests/aais-lrs-client.test.ts \
    tests/aais-session-revocations.test.ts \
    tests/auth-route.test.ts \
    tests/postgres-migrations.test.mjs \
    migrations/postgres/0008_ai_guide_daily_usage.sql
  do
    if lsof "$ROOT/$file_path" >/dev/null 2>&1; then exit 1; fi
  done
}
assert_no_open_dirty_files
assert_exact_root_inventory() {
  diff -u \
    <(printf '%s\n' \
      ' M src/app/api/learning/ai-guide/route.ts' \
      ' M src/app/api/learning/scaffold/route.ts' \
      ' M src/lib/server/aais-learning-store.ts' \
      ' M src/lib/server/aais-lrs-client.ts' \
      ' M src/lib/server/aais-trial-accounts.ts' \
      ' M tests/aais-api-routes.test.ts' \
      ' M tests/aais-backend-store.test.ts' \
      ' M tests/aais-lrs-client.test.ts' \
      ' M tests/aais-session-revocations.test.ts' \
      ' M tests/auth-route.test.ts' \
      ' M tests/postgres-migrations.test.mjs' \
      '?? migrations/postgres/0008_ai_guide_daily_usage.sql' | LC_ALL=C sort) \
    <(git -C "$ROOT" status --porcelain=v1 -uall | LC_ALL=C sort)
}
assert_exact_root_inventory
cd "$ROOT"
test "$(git branch --show-current)" = 'codex/aais-enterprise-standard'
test "$(git rev-parse HEAD)" = '2fd93838281581a6996f6f7a8a6bca0d8d95e420'
diff -u \
  <(printf '%s\n' \
    ' M src/app/api/learning/ai-guide/route.ts' \
    ' M src/app/api/learning/scaffold/route.ts' \
    ' M src/lib/server/aais-learning-store.ts' \
    ' M src/lib/server/aais-lrs-client.ts' \
    ' M src/lib/server/aais-trial-accounts.ts' \
    ' M tests/aais-api-routes.test.ts' \
    ' M tests/aais-backend-store.test.ts' \
    ' M tests/aais-lrs-client.test.ts' \
    ' M tests/aais-session-revocations.test.ts' \
    ' M tests/auth-route.test.ts' \
    ' M tests/postgres-migrations.test.mjs' \
    '?? migrations/postgres/0008_ai_guide_daily_usage.sql' | LC_ALL=C sort) \
  <(git status --porcelain=v1 -uall | LC_ALL=C sort)
test "$(git diff --binary | shasum -a 256 | awk '{print $1}')" = \
  "$(evidence_value root_tracked_vs_head_sha256)"
test "$(git diff --binary "$(evidence_value reviewed_live_main_sha)" -- | \
  shasum -a 256 | awk '{print $1}')" = \
  "$(evidence_value root_vs_reviewed_live_main_sha256)"
test "$(shasum -a 256 "$SNAP/root/tracked-vs-head.patch" | \
  awk '{print $1}')" = \
  "$(evidence_value snapshot_root_tracked_vs_head_sha256)"
cmp -s migrations/postgres/0008_ai_guide_daily_usage.sql \
  "$SNAP/root/untracked/migrations/postgres/0008_ai_guide_daily_usage.sql"
ROOT_PREIMAGE_DIR="/Users/dongpinhu/Desktop/AAIS-private-worktree-archives/$ACCEPTED_MAIN/root-preimage"
umask 077
mkdir -p "$ROOT_PREIMAGE_DIR"
chmod 700 "$ROOT_PREIMAGE_DIR"
ROOT_PREIMAGE="$ROOT_PREIMAGE_DIR/root-11-plus-1-preimage.tar"
tar -cf "$ROOT_PREIMAGE" \
  src/app/api/learning/ai-guide/route.ts \
  src/app/api/learning/scaffold/route.ts \
  src/lib/server/aais-learning-store.ts \
  src/lib/server/aais-lrs-client.ts \
  src/lib/server/aais-trial-accounts.ts \
  tests/aais-api-routes.test.ts \
  tests/aais-backend-store.test.ts \
  tests/aais-lrs-client.test.ts \
  tests/aais-session-revocations.test.ts \
  tests/auth-route.test.ts \
  tests/postgres-migrations.test.mjs \
  migrations/postgres/0008_ai_guide_daily_usage.sql
chmod 600 "$ROOT_PREIMAGE"
shasum -a 256 "$ROOT_PREIMAGE" > "$ROOT_PREIMAGE.sha256"
chmod 600 "$ROOT_PREIMAGE.sha256"
(cd "$ROOT_PREIMAGE_DIR" && shasum -a 256 -c \
  root-11-plus-1-preimage.tar.sha256 >/dev/null)
test "$(stat -f '%Sp' "$ROOT_PREIMAGE_DIR")" = 'drwx------'
test "$(stat -f '%Sp' "$ROOT_PREIMAGE")" = '-rw-------'
tar -tf "$ROOT_PREIMAGE" >/dev/null
git fetch origin main
test "$(git rev-parse refs/remotes/origin/main)" = "$ACCEPTED_MAIN"
test "$(git diff --binary | shasum -a 256 | awk '{print $1}')" = \
  "$(evidence_value root_tracked_vs_head_sha256)"
assert_exact_root_inventory
assert_no_open_dirty_files
git restore --worktree -- \
  src/app/api/learning/ai-guide/route.ts \
  src/app/api/learning/scaffold/route.ts \
  src/lib/server/aais-learning-store.ts \
  src/lib/server/aais-lrs-client.ts \
  src/lib/server/aais-trial-accounts.ts \
  tests/aais-api-routes.test.ts \
  tests/aais-backend-store.test.ts \
  tests/aais-lrs-client.test.ts \
  tests/aais-session-revocations.test.ts \
  tests/auth-route.test.ts \
  tests/postgres-migrations.test.mjs
diff -u \
  <(printf '%s\n' '?? migrations/postgres/0008_ai_guide_daily_usage.sql') \
  <(git status --porcelain=v1 -uall)
```

Expected: tracked rescue dirt is removed from the current rescue index; exactly the untracked migration remains. No improved-main content is copied directly during this cleanup.

- [ ] **Step 2: Revalidate and remove only the backed-up untracked migration**

```bash
set -euo pipefail
ROOT=/Users/dongpinhu/Desktop/AAIS
SNAP=/Users/dongpinhu/Desktop/AAIS-dirty-worktree-backups/20260710-145253-worktree-recovery-refresh
EVIDENCE_PATH=docs/superpowers/recovery/2026-07-10-aais-dirty-inventory-equivalence.md
test "${AAIS_CLEANUP_EXCLUSIVE_CONFIRMATION:-}" = \
  'root-exclusive-no-editor-dev-server-or-background-writer'
LOCK=/private/tmp/aais-recovery-root-migration-cleanup.lock
mkdir -m 700 "$LOCK"
EVIDENCE_COPY=$(mktemp /tmp/aais-recovery-evidence.XXXXXX)
trap 'rm -f "$EVIDENCE_COPY"; rmdir "$LOCK"' EXIT
git -C "$ROOT" fetch origin main
git -C "$ROOT" show "refs/remotes/origin/main:$EVIDENCE_PATH" > \
  "$EVIDENCE_COPY"
ACCEPTED_MAIN_TAG=$(awk -F= '
  $1 == "accepted_main_binding_tag" { count += 1; value = $2 }
  END { if (count != 1) exit 1; print value }
' "$EVIDENCE_COPY")
git -C "$ROOT" fetch origin \
  "refs/tags/$ACCEPTED_MAIN_TAG:refs/tags/$ACCEPTED_MAIN_TAG"
ACCEPTED_MAIN=$(git -C "$ROOT" rev-parse "$ACCEPTED_MAIN_TAG^{commit}")
test "$(git -C "$ROOT" rev-parse refs/remotes/origin/main)" = \
  "$ACCEPTED_MAIN"
ROOT_WRITERS=$(ps -Ao pid=,command= | awk -v root="$ROOT" \
  'index($0, root) > 0 && index($0, "/.worktrees/") == 0 && index($0, "ps -Ao") == 0 { print }')
test -z "$ROOT_WRITERS"
if lsof "$ROOT/migrations/postgres/0008_ai_guide_daily_usage.sql" \
  >/dev/null 2>&1; then exit 1; fi
cd "$ROOT"
diff -u \
  <(printf '%s\n' '?? migrations/postgres/0008_ai_guide_daily_usage.sql') \
  <(git status --porcelain=v1 -uall)
cmp -s \
  migrations/postgres/0008_ai_guide_daily_usage.sql \
  "$SNAP/root/untracked/migrations/postgres/0008_ai_guide_daily_usage.sql"
test "$(shasum -a 256 "$SNAP/root/untracked/migrations/postgres/0008_ai_guide_daily_usage.sql" | awk '{print $1}')" = \
  '5460251a5560635b4b39229b22b360465ccfbb40b60c1812b3df4d9252ca98ce'
git cat-file -e "$ACCEPTED_MAIN:migrations/postgres/0008_ai_guide_daily_usage.sql"
ROOT_PREIMAGE_DIR="/Users/dongpinhu/Desktop/AAIS-private-worktree-archives/$ACCEPTED_MAIN/root-preimage"
test "$(stat -f '%Sp' "$ROOT_PREIMAGE_DIR")" = 'drwx------'
(cd "$ROOT_PREIMAGE_DIR" && shasum -a 256 -c \
  root-11-plus-1-preimage.tar.sha256 >/dev/null)
MIGRATION_PREIMAGE="$ROOT_PREIMAGE_DIR/migration-last-preimage.tar"
tar -cf "$MIGRATION_PREIMAGE" \
  migrations/postgres/0008_ai_guide_daily_usage.sql
chmod 600 "$MIGRATION_PREIMAGE"
shasum -a 256 "$MIGRATION_PREIMAGE" > "$MIGRATION_PREIMAGE.sha256"
chmod 600 "$MIGRATION_PREIMAGE.sha256"
(cd "$ROOT_PREIMAGE_DIR" && shasum -a 256 -c \
  migration-last-preimage.tar.sha256 >/dev/null)
tar -tf "$MIGRATION_PREIMAGE" >/dev/null
git fetch origin main
test "$(git rev-parse refs/remotes/origin/main)" = "$ACCEPTED_MAIN"
diff -u \
  <(printf '%s\n' '?? migrations/postgres/0008_ai_guide_daily_usage.sql') \
  <(git status --porcelain=v1 -uall)
cmp -s migrations/postgres/0008_ai_guide_daily_usage.sql \
  "$SNAP/root/untracked/migrations/postgres/0008_ai_guide_daily_usage.sql"
if lsof "$ROOT/migrations/postgres/0008_ai_guide_daily_usage.sql" \
  >/dev/null 2>&1; then exit 1; fi
rm -- migrations/postgres/0008_ai_guide_daily_usage.sql
test "$(git branch --show-current)" = 'codex/aais-enterprise-standard'
test -z "$(git status --porcelain=v1 -uall)"
```

Expected: migration removal occurs only after backup and accepted-main proof; the rescue branch is clean.

- [ ] **Step 3: Switch the clean root to newly tracked accepted main**

`lsof +D` reports process cwd handles. This block therefore verifies and enters
`/private/tmp` before the whole-root handle check, never re-enters the root, and
uses only `git -C "$ROOT"`, absolute paths, and `npm --prefix "$ROOT"` for root
operations.

```bash
set -euo pipefail
ROOT=/Users/dongpinhu/Desktop/AAIS
NEUTRAL_DIR=/private/tmp
EVIDENCE_PATH=docs/superpowers/recovery/2026-07-10-aais-dirty-inventory-equivalence.md
test "${AAIS_CLEANUP_EXCLUSIVE_CONFIRMATION:-}" = \
  'root-exclusive-no-editor-dev-server-or-background-writer'
LOCK=/private/tmp/aais-recovery-root-switch-cleanup.lock
mkdir -m 700 "$LOCK"
EVIDENCE_COPY=$(mktemp /tmp/aais-recovery-evidence.XXXXXX)
trap 'rm -f "$EVIDENCE_COPY"; rmdir "$LOCK"' EXIT
git -C "$ROOT" fetch origin main
git -C "$ROOT" show "refs/remotes/origin/main:$EVIDENCE_PATH" > \
  "$EVIDENCE_COPY"
ACCEPTED_MAIN_TAG=$(awk -F= '
  $1 == "accepted_main_binding_tag" { count += 1; value = $2 }
  END { if (count != 1) exit 1; print value }
' "$EVIDENCE_COPY")
git -C "$ROOT" fetch origin \
  "refs/tags/$ACCEPTED_MAIN_TAG:refs/tags/$ACCEPTED_MAIN_TAG"
ACCEPTED_MAIN=$(git -C "$ROOT" rev-parse "$ACCEPTED_MAIN_TAG^{commit}")
test -d "$NEUTRAL_DIR"
test ! -L "$NEUTRAL_DIR"
cd "$NEUTRAL_DIR"
test "$(pwd -P)" = "$NEUTRAL_DIR"
case "$(pwd -P)/" in "$ROOT/"*) exit 1 ;; esac
ROOT_PREIMAGE_DIR="/Users/dongpinhu/Desktop/AAIS-private-worktree-archives/$ACCEPTED_MAIN/root-preimage"
(cd "$ROOT_PREIMAGE_DIR" && shasum -a 256 -c \
  root-11-plus-1-preimage.tar.sha256 >/dev/null)
git -C "$ROOT" fetch origin main
git -C "$ROOT" fetch origin \
  "refs/tags/$ACCEPTED_MAIN_TAG:refs/tags/$ACCEPTED_MAIN_TAG"
test "$(git -C "$ROOT" rev-parse \
  "$ACCEPTED_MAIN_TAG^{commit}")" = "$ACCEPTED_MAIN"
test "$(git -C "$ROOT" rev-parse refs/remotes/origin/main)" = \
  "$ACCEPTED_MAIN"
test "$(git -C "$ROOT" branch --show-current)" = \
  'codex/aais-enterprise-standard'
test -z "$(git -C "$ROOT" status --porcelain=v1 -uall)"
if git -C "$ROOT" show-ref --verify --quiet refs/heads/main; then
  exit 1
fi
test "$(pwd -P)" = "$NEUTRAL_DIR"
ROOT_WRITERS=$(ps -Ao pid=,command= | awk -v root="$ROOT" \
  'index($0, root) > 0 && index($0, "/.worktrees/") == 0 && index($0, "ps -Ao") == 0 { print }')
test -z "$ROOT_WRITERS"
if lsof +D "$ROOT" >/dev/null 2>&1; then exit 1; fi
git -C "$ROOT" switch -c main --track origin/main
test "$(git -C "$ROOT" rev-parse HEAD)" = "$ACCEPTED_MAIN"
test "$(git -C "$ROOT" branch --show-current)" = 'main'
test "$(git -C "$ROOT" rev-list --left-right --count \
  main...origin/main)" = $'0\t0'
test -z "$(git -C "$ROOT" status --porcelain=v1 -uall)"
test "$(pwd -P)" = "$NEUTRAL_DIR"
npm --prefix "$ROOT" run hygiene:check -- --allow-local-private-artifacts
```

Expected: the executing shell remains in the verified neutral directory while
the archive and final main/tag/status assertions complete. The block then
repeats writer detection and whole-root `lsof`, immediately switches the clean
rescue branch with no intervening fetch/ref/archive/other operation, and updates
the root index/worktree to accepted main. Local main is clean and aligned, and
the whole-root `lsof` check cannot self-count the shell's cwd.

### Task 11: Classify and close every external and linked worktree without force

- [ ] **Step 1: Verify the exact pre-cleanup worktree inventory and accepted reachability**

```bash
set -euo pipefail
ROOT=/Users/dongpinhu/Desktop/AAIS
EVIDENCE_PATH=docs/superpowers/recovery/2026-07-10-aais-dirty-inventory-equivalence.md
git -C "$ROOT" fetch origin main
EVIDENCE_COPY=$(mktemp /tmp/aais-recovery-evidence.XXXXXX)
trap 'rm -f "$EVIDENCE_COPY"' EXIT
git -C "$ROOT" show "refs/remotes/origin/main:$EVIDENCE_PATH" > \
  "$EVIDENCE_COPY"
evidence_value() {
  local key=$1
  awk -v key="$key" '
    index($0, key "=") == 1 { count += 1; value = substr($0, length(key) + 2) }
    END { if (count != 1) exit 1; print value }
  ' "$EVIDENCE_COPY"
}
DOCS_TAG=$(evidence_value reviewed_docs_tag)
FINAL_TAG=$(evidence_value final_head_binding_tag)
ACCEPTED_MAIN_TAG=$(evidence_value accepted_main_binding_tag)
for tag_name in "$DOCS_TAG" "$FINAL_TAG" "$ACCEPTED_MAIN_TAG"; do
  git -C "$ROOT" fetch origin \
    "refs/tags/$tag_name:refs/tags/$tag_name"
  test "$(git -C "$ROOT" cat-file -t "$tag_name")" = 'tag'
done
ACCEPTED_MAIN=$(git -C "$ROOT" rev-parse \
  "$ACCEPTED_MAIN_TAG^{commit}")
test "$(git -C "$ROOT" rev-parse refs/remotes/origin/main)" = \
  "$ACCEPTED_MAIN"
test "$(git -C "$ROOT" rev-parse main)" = "$ACCEPTED_MAIN"
test "$(git -C "$ROOT" rev-parse HEAD)" = "$ACCEPTED_MAIN"
test "$(git -C "$ROOT" branch --show-current)" = 'main'
test -z "$(git -C "$ROOT" status --porcelain=v1 -uall)"
PINNED_MAIN=$(evidence_value reviewed_live_main_sha)
SEALED_HEAD=$(git -C "$ROOT" rev-parse "$FINAL_TAG^{commit}")
test "$(git -C "$ROOT" rev-parse "$ACCEPTED_MAIN^1")" = "$PINNED_MAIN"
test "$(git -C "$ROOT" rev-parse "$ACCEPTED_MAIN^2")" = "$SEALED_HEAD"
test "$(git -C "$ROOT" rev-parse "$ACCEPTED_MAIN^{tree}")" = \
  "$(git -C "$ROOT" rev-parse "$SEALED_HEAD^{tree}")"
diff -u \
  <(printf '%s\n' \
    '/Users/dongpinhu/Desktop/AAIS' \
    '/Users/dongpinhu/Desktop/AAIS/.worktrees/aais-daily-guide-budget' \
    '/Users/dongpinhu/Desktop/AAIS/.worktrees/aais-locked-task-guard' \
    '/Users/dongpinhu/Desktop/AAIS/.worktrees/aais-lrs-outbox-hardening' \
    '/Users/dongpinhu/Desktop/AAIS/.worktrees/aais-recovery-compose' \
    '/Users/dongpinhu/Desktop/AAIS/.worktrees/aais-session-revocation-test' \
    '/Users/dongpinhu/Desktop/AAIS/.worktrees/aais-worktree-recovery-design' \
    '/private/tmp/aais-bobie-main-deploy-20260710' \
    '/private/tmp/aais-bobie-main-fix2-20260710' \
    '/private/tmp/aais-bobie-prod-fix-20260710' | LC_ALL=C sort) \
  <(git -C "$ROOT" worktree list --porcelain | \
    sed -n 's/^worktree //p' | LC_ALL=C sort)
for sha in \
  42e92a483842a2a601ecbdb10794a90c1f3eba1f \
  5e803c669b955abba8a3f6c1c665c5543875a21a \
  735011b3e002f6be46ff34f4a13c70834a69cfeb \
  ad2d5a05114b9f19297fcae4a232cc434c8b2f35 \
  33af4c30100f4c0ea02b765709eb83123e7b10ff \
  1d97d16998e95a92ebecb3a69a2ad14c9e0a566c
do
  git -C "$ROOT" merge-base --is-ancestor "$sha" "$ACCEPTED_MAIN"
done
```

Expected: current remote and local main equal the accepted-main tag exactly;
the accepted merge's first parent, exact second parent, and exact tree still
match the pinned base and sealed gated head. All ten registered worktrees are
present, and accepted source provenance is reachable. The optional independent
acceptance checkout is not a registered root worktree and is handled from its
evidence path later.

- [ ] **Step 2: Prove prod-fix dirty files equal accepted commit content, then clean it from its current index**

```bash
set -euo pipefail
ROOT=/Users/dongpinhu/Desktop/AAIS
PROD_FIX=/private/tmp/aais-bobie-prod-fix-20260710
NEUTRAL_DIR=/private/tmp
ACCEPTED_DUPLICATE=42e92a483842a2a601ecbdb10794a90c1f3eba1f
EVIDENCE_PATH=docs/superpowers/recovery/2026-07-10-aais-dirty-inventory-equivalence.md
test "${AAIS_CLEANUP_EXCLUSIVE_CONFIRMATION:-}" = \
  'worktree-exclusive-no-editor-dev-server-or-background-writer'
LOCK=/private/tmp/aais-recovery-prod-fix-cleanup.lock
mkdir -m 700 "$LOCK"
test -d "$NEUTRAL_DIR"
test ! -L "$NEUTRAL_DIR"
cd "$NEUTRAL_DIR"
test "$(pwd -P)" = "$NEUTRAL_DIR"
case "$(pwd -P)/" in "$PROD_FIX/"*) exit 1 ;; esac
EVIDENCE_COPY=$(mktemp /tmp/aais-recovery-evidence.XXXXXX)
target_id=$(printf '%s' "$PROD_FIX" | shasum -a 256 | awk '{print $1}')
trap 'rm -f "$EVIDENCE_COPY"; rmdir "$LOCK"' EXIT
git -C "$ROOT" fetch origin main
git -C "$ROOT" show "refs/remotes/origin/main:$EVIDENCE_PATH" > \
  "$EVIDENCE_COPY"
ACCEPTED_MAIN_TAG=$(awk -F= '
  $1 == "accepted_main_binding_tag" { count += 1; value = $2 }
  END { if (count != 1) exit 1; print value }
' "$EVIDENCE_COPY")
git -C "$ROOT" fetch origin \
  "refs/tags/$ACCEPTED_MAIN_TAG:refs/tags/$ACCEPTED_MAIN_TAG"
ACCEPTED_MAIN=$(git -C "$ROOT" rev-parse "$ACCEPTED_MAIN_TAG^{commit}")
test "$(git -C "$ROOT" rev-parse refs/remotes/origin/main)" = \
  "$ACCEPTED_MAIN"
ARCHIVE_DIR="/Users/dongpinhu/Desktop/AAIS-private-worktree-archives/$ACCEPTED_MAIN/$target_id"
test "$(stat -f '%Sp' "$ARCHIVE_DIR")" = 'drwx------'
(cd "$ARCHIVE_DIR" && shasum -a 256 -c \
  private-unknown-preimage.sha256 >/dev/null)
tar -tf "$ARCHIVE_DIR/private-unknown-preimage.tar" >/dev/null
test "$(git -C "$PROD_FIX" rev-parse HEAD)" = \
  '2fd93838281581a6996f6f7a8a6bca0d8d95e420'
test -z "$(git -C "$PROD_FIX" branch --show-current)"
diff -u \
  <(printf '%s\n' \
    ' M src/lib/server/aais-trial-accounts.ts' \
    ' M tests/aais-session-revocations.test.ts' \
    ' M tests/auth-route.test.ts' | LC_ALL=C sort) \
  <(git -C "$PROD_FIX" status --porcelain=v1 -uall | LC_ALL=C sort)
test "$(git -C "$PROD_FIX" diff --binary "$ACCEPTED_DUPLICATE" -- | \
  shasum -a 256 | awk '{print $1}')" = \
  'fe3bfd7c9d6709660033a1856bd549daec929da14f0aa230a7a4542716663460'
git -C "$ROOT" merge-base --is-ancestor "$ACCEPTED_DUPLICATE" \
  "$ACCEPTED_MAIN"
for file_path in \
  src/lib/server/aais-trial-accounts.ts \
  tests/aais-session-revocations.test.ts \
  tests/auth-route.test.ts
do
  cmp -s "$PROD_FIX/$file_path" \
    <(git -C "$ROOT" show "$ACCEPTED_DUPLICATE:$file_path")
done
diff -u \
  <(printf '%s\n' '.gitignore') \
  <(git -C "$PROD_FIX" diff --name-only "$ACCEPTED_DUPLICATE" -- | LC_ALL=C sort)
PROD_PREIMAGE="$ARCHIVE_DIR/prod-fix-three-file-preimage.tar"
tar -cf "$PROD_PREIMAGE" -C "$PROD_FIX" \
  src/lib/server/aais-trial-accounts.ts \
  tests/aais-session-revocations.test.ts \
  tests/auth-route.test.ts
chmod 600 "$PROD_PREIMAGE"
shasum -a 256 "$PROD_PREIMAGE" > "$PROD_PREIMAGE.sha256"
chmod 600 "$PROD_PREIMAGE.sha256"
(cd "$ARCHIVE_DIR" && shasum -a 256 -c \
  prod-fix-three-file-preimage.tar.sha256 >/dev/null)
for file_path in \
  src/lib/server/aais-trial-accounts.ts \
  tests/aais-session-revocations.test.ts \
  tests/auth-route.test.ts
do
  if lsof "$PROD_FIX/$file_path" >/dev/null 2>&1; then exit 1; fi
done
PROD_WRITERS=$(ps -Ao pid=,command= | awk -v wt="$PROD_FIX" \
  'index($0, wt) > 0 && index($0, "ps -Ao") == 0 { print }')
test -z "$PROD_WRITERS"
git -C "$PROD_FIX" status --porcelain=v1 --ignored -z -uall | \
  while IFS= read -r -d '' record; do
    case "$record" in
      '!! '*|'?? '*)
        relative_name=${record#???}
        printf '%s\0' "${relative_name%%/*}"
        ;;
    esac
  done | LC_ALL=C sort -zu > "$ARCHIVE_DIR/top-level-immediate.nul"
chmod 600 "$ARCHIVE_DIR/top-level-immediate.nul"
cmp -s "$ARCHIVE_DIR/top-level.nul" \
  "$ARCHIVE_DIR/top-level-immediate.nul"
CURRENT_PRIVATE="$ARCHIVE_DIR/private-current.tar"
tar --null -b 1 -cf "$CURRENT_PRIVATE" -C "$PROD_FIX" \
  -T "$ARCHIVE_DIR/preserve.nul"
chmod 600 "$CURRENT_PRIVATE"
test "$(shasum -a 256 "$CURRENT_PRIVATE" | awk '{print $1}')" = \
  "$(shasum -a 256 "$ARCHIVE_DIR/private-unknown-preimage.tar" | awk '{print $1}')"
rm -- "$CURRENT_PRIVATE"
git -C "$ROOT" fetch origin main
test "$(git -C "$ROOT" rev-parse refs/remotes/origin/main)" = \
  "$ACCEPTED_MAIN"
diff -u \
  <(printf '%s\n' \
    ' M src/lib/server/aais-trial-accounts.ts' \
    ' M tests/aais-session-revocations.test.ts' \
    ' M tests/auth-route.test.ts' | LC_ALL=C sort) \
  <(git -C "$PROD_FIX" status --porcelain=v1 -uall | LC_ALL=C sort)
test "$(git -C "$PROD_FIX" diff --binary "$ACCEPTED_DUPLICATE" -- | \
  shasum -a 256 | awk '{print $1}')" = \
  'fe3bfd7c9d6709660033a1856bd549daec929da14f0aa230a7a4542716663460'
for file_path in \
  src/lib/server/aais-trial-accounts.ts \
  tests/aais-session-revocations.test.ts \
  tests/auth-route.test.ts
do
  cmp -s "$PROD_FIX/$file_path" \
    <(git -C "$ROOT" show "$ACCEPTED_DUPLICATE:$file_path")
  if lsof "$PROD_FIX/$file_path" >/dev/null 2>&1; then exit 1; fi
done
test "$(pwd -P)" = "$NEUTRAL_DIR"
git -C "$PROD_FIX" restore --worktree -- \
  src/lib/server/aais-trial-accounts.ts \
  tests/aais-session-revocations.test.ts \
  tests/auth-route.test.ts
test -z "$(git -C "$PROD_FIX" status --porcelain=v1 -uall)"
```

Expected: exact accepted main, tracked status, patch hash, byte provenance,
private archive, last-moment three-file preimage, process/lsof evidence, and a
second immediate guard all pass in one operator-exclusive block. Only tracked
prod-fix dirt is restored; ignored `.aais-data`, `.vercel`, and reproducible
artifacts remain in place with private copies archived. Porcelain-empty means
tracked/untracked-clean only, not private-clean.

- [ ] **Step 3: Run a non-authorizing tracked/untracked and writer preflight**

```bash
set -euo pipefail
ROOT=/Users/dongpinhu/Desktop/AAIS
for wt in \
  '/private/tmp/aais-bobie-main-deploy-20260710' \
  '/private/tmp/aais-bobie-main-fix2-20260710' \
  '/private/tmp/aais-bobie-prod-fix-20260710' \
  "$ROOT/.worktrees/aais-session-revocation-test" \
  "$ROOT/.worktrees/aais-locked-task-guard" \
  "$ROOT/.worktrees/aais-daily-guide-budget" \
  "$ROOT/.worktrees/aais-lrs-outbox-hardening" \
  "$ROOT/.worktrees/aais-recovery-compose" \
  "$ROOT/.worktrees/aais-worktree-recovery-design"
do
  test -z "$(git -C "$wt" status --porcelain=v1 -uall)"
  WT_WRITERS=$(ps -Ao pid=,command= | awk -v wt="$wt" \
    'index($0, wt) > 0 && index($0, "ps -Ao") == 0 { print }')
  test -z "$WT_WRITERS"
done
```

Expected: every target is tracked/untracked-clean and has no detected writer at
this preliminary instant. This does not classify ignored content, does not
authorize removal, and is not called a clean-worktree proof. Task 9 Step 6
archives ignored/private state; Task 11 Step 4 repeats exact main, archive,
classification, status, process, and lsof guards inside each destructive
window.

- [ ] **Step 4: Remove all worktrees normally and delete only merged branches**

Keep the retained root as the Git control repository, but do not keep the
executing shell inside it or any removal target. The block verifies and enters
`/private/tmp`, uses `git -C "$ROOT"` plus absolute target paths, and remains in
that neutral directory through every normal removal:

```bash
set -euo pipefail
ROOT=/Users/dongpinhu/Desktop/AAIS
NEUTRAL_DIR=/private/tmp
EVIDENCE_PATH=docs/superpowers/recovery/2026-07-10-aais-dirty-inventory-equivalence.md
test "${AAIS_CLEANUP_EXCLUSIVE_CONFIRMATION:-}" = \
  'worktree-exclusive-no-editor-dev-server-or-background-writer'
test -d "$NEUTRAL_DIR"
test ! -L "$NEUTRAL_DIR"
cd "$NEUTRAL_DIR"
test "$(pwd -P)" = "$NEUTRAL_DIR"
case "$(pwd -P)/" in "$ROOT/"*) exit 1 ;; esac
git -C "$ROOT" fetch origin main
EVIDENCE_COPY=$(mktemp /tmp/aais-recovery-evidence.XXXXXX)
trap 'rm -f "$EVIDENCE_COPY"' EXIT
git -C "$ROOT" show "refs/remotes/origin/main:$EVIDENCE_PATH" > \
  "$EVIDENCE_COPY"
evidence_value() {
  local key=$1
  awk -v key="$key" '
    index($0, key "=") == 1 { count += 1; value = substr($0, length(key) + 2) }
    END { if (count != 1) exit 1; print value }
  ' "$EVIDENCE_COPY"
}
DOCS_TAG=$(evidence_value reviewed_docs_tag)
FINAL_TAG=$(evidence_value final_head_binding_tag)
ACCEPTED_MAIN_TAG=$(evidence_value accepted_main_binding_tag)
fetch_evidence_tags() {
  local tag_name
  for tag_name in "$DOCS_TAG" "$FINAL_TAG" "$ACCEPTED_MAIN_TAG"; do
    git -C "$ROOT" fetch origin \
      "refs/tags/$tag_name:refs/tags/$tag_name"
  done
}
fetch_evidence_tags
ACCEPTED_MAIN=$(git -C "$ROOT" rev-parse "$ACCEPTED_MAIN_TAG^{commit}")
test "$(git -C "$ROOT" rev-parse refs/remotes/origin/main)" = \
  "$ACCEPTED_MAIN"
test "$(git -C "$ROOT" rev-parse main)" = "$ACCEPTED_MAIN"
ARCHIVE_ROOT="/Users/dongpinhu/Desktop/AAIS-private-worktree-archives/$ACCEPTED_MAIN"
verify_remote_tags() {
  local tag_name local_object local_commit
  for tag_name in "$DOCS_TAG" "$FINAL_TAG" "$ACCEPTED_MAIN_TAG"
  do
    test "$(git -C "$ROOT" cat-file -t "$tag_name")" = 'tag'
    local_object=$(git -C "$ROOT" rev-parse "$tag_name^{tag}")
    local_commit=$(git -C "$ROOT" rev-parse "$tag_name^{commit}")
    test "$(git -C "$ROOT" ls-remote --tags origin \
      "refs/tags/$tag_name" | awk '
      NF == 2 { count += 1; value = $1 }
      END { if (count != 1) exit 1; print value }
    ')" = "$local_object"
    test "$(git -C "$ROOT" ls-remote --tags origin \
      "refs/tags/$tag_name^{}" | awk '
      NF == 2 { count += 1; value = $1 }
      END { if (count != 1) exit 1; print value }
    ')" = "$local_commit"
  done
}
inventory_top_level_nul() {
  local wt=$1
  git -C "$wt" status --porcelain=v1 --ignored -z -uall | \
    while IFS= read -r -d '' record; do
      case "$record" in
        '!! '*|'?? '*)
          relative_name=${record#???}
          printf '%s\0' "${relative_name%%/*}"
          ;;
      esac
    done | LC_ALL=C sort -zu
}
targets=(
  '/private/tmp/aais-bobie-main-deploy-20260710' \
  '/private/tmp/aais-bobie-main-fix2-20260710' \
  '/private/tmp/aais-bobie-prod-fix-20260710' \
  "$ROOT/.worktrees/aais-session-revocation-test" \
  "$ROOT/.worktrees/aais-locked-task-guard" \
  "$ROOT/.worktrees/aais-daily-guide-budget" \
  "$ROOT/.worktrees/aais-lrs-outbox-hardening" \
  "$ROOT/.worktrees/aais-recovery-compose" \
  "$ROOT/.worktrees/aais-worktree-recovery-design"
)
for wt in "${targets[@]}"
do
  test "$(pwd -P)" = "$NEUTRAL_DIR"
  case "$(pwd -P)/" in "$wt/"*) exit 1 ;; esac
  target_id=$(printf '%s' "$wt" | shasum -a 256 | awk '{print $1}')
  LOCK="/private/tmp/aais-recovery-worktree-remove-$target_id.lock"
  mkdir -m 700 "$LOCK"
  archive_dir="$ARCHIVE_ROOT/$target_id"
  test "$(stat -f '%Sp' "$archive_dir")" = 'drwx------'
  (cd "$archive_dir" && shasum -a 256 -c \
    private-unknown-preimage.sha256 >/dev/null)
  tar -tf "$archive_dir/private-unknown-preimage.tar" >/dev/null
  git -C "$ROOT" fetch origin main
  test "$(git -C "$ROOT" rev-parse refs/remotes/origin/main)" = \
    "$ACCEPTED_MAIN"
  test "$(git -C "$ROOT" rev-parse main)" = "$ACCEPTED_MAIN"
  test -z "$(git -C "$wt" status --porcelain=v1 -uall)"
  inventory_top_level_nul "$wt" > "$archive_dir/top-level-removal.nul"
  chmod 600 "$archive_dir/top-level-removal.nul"
  cmp -s "$archive_dir/top-level.nul" \
    "$archive_dir/top-level-removal.nul"
  private_now="$archive_dir/private-removal-now.tar"
  tar --null -b 1 -cf "$private_now" -C "$wt" \
    -T "$archive_dir/preserve.nul"
  chmod 600 "$private_now"
  test "$(shasum -a 256 "$private_now" | awk '{print $1}')" = \
    "$(shasum -a 256 "$archive_dir/private-unknown-preimage.tar" | \
      awk '{print $1}')"
  rm -- "$private_now"
  WT_WRITERS=$(ps -Ao pid=,command= | awk -v wt="$wt" \
    'index($0, wt) > 0 && index($0, "ps -Ao") == 0 { print }')
  test -z "$WT_WRITERS"
  test "$(pwd -P)" = "$NEUTRAL_DIR"
  if lsof +D "$wt" >/dev/null 2>&1; then exit 1; fi
  verify_remote_tags
  git -C "$ROOT" fetch origin main
  fetch_evidence_tags
  verify_remote_tags
  test "$(git -C "$ROOT" rev-parse refs/remotes/origin/main)" = \
    "$ACCEPTED_MAIN"
  test "$(git -C "$ROOT" rev-parse main)" = "$ACCEPTED_MAIN"
  test -z "$(git -C "$wt" status --porcelain=v1 -uall)"
  cmp -s "$archive_dir/top-level.nul" \
    <(inventory_top_level_nul "$wt")
  (cd "$archive_dir" && shasum -a 256 -c \
    private-unknown-preimage.sha256 >/dev/null)
  tar -tf "$archive_dir/private-unknown-preimage.tar" >/dev/null
  test "$(tar --null -b 1 -cf - -C "$wt" \
    -T "$archive_dir/preserve.nul" | \
    shasum -a 256 | awk '{print $1}')" = \
    "$(shasum -a 256 "$archive_dir/private-unknown-preimage.tar" | \
      awk '{print $1}')"
  test "$(git -C "$ROOT" rev-parse refs/remotes/origin/main)" = \
    "$ACCEPTED_MAIN"
  test "$(git -C "$ROOT" rev-parse main)" = "$ACCEPTED_MAIN"
  WT_WRITERS=$(ps -Ao pid=,command= | awk -v wt="$wt" \
    'index($0, wt) > 0 && index($0, "ps -Ao") == 0 { print }')
  test -z "$WT_WRITERS"
  test "$(pwd -P)" = "$NEUTRAL_DIR"
  if lsof +D "$wt" >/dev/null 2>&1; then exit 1; fi
  git -C "$ROOT" worktree remove "$wt"
  rmdir "$LOCK"
done
ACCEPTANCE_CHECKOUT=$(evidence_value acceptance_checkout_path)
if test "$ACCEPTANCE_CHECKOUT" != 'NONE'; then
  test "$(pwd -P)" = "$NEUTRAL_DIR"
  case "$(pwd -P)/" in "$ACCEPTANCE_CHECKOUT/"*) exit 1 ;; esac
  target_id=$(printf '%s' "$ACCEPTANCE_CHECKOUT" | \
    shasum -a 256 | awk '{print $1}')
  LOCK="/private/tmp/aais-recovery-acceptance-remove-$target_id.lock"
  mkdir -m 700 "$LOCK"
  archive_dir="$ARCHIVE_ROOT/$target_id"
  git -C "$ROOT" fetch origin main
  test "$(git -C "$ROOT" rev-parse refs/remotes/origin/main)" = \
    "$ACCEPTED_MAIN"
  test "$(git -C "$ACCEPTANCE_CHECKOUT" rev-parse HEAD)" = \
    "$(git -C "$ROOT" rev-parse \
      "$(evidence_value final_head_binding_tag)^{commit}")"
  test -z "$(git -C "$ACCEPTANCE_CHECKOUT" status --porcelain=v1 -uall)"
  inventory_top_level_nul "$ACCEPTANCE_CHECKOUT" > \
    "$archive_dir/top-level-final.nul"
  chmod 600 "$archive_dir/top-level-final.nul"
  cmp -s "$archive_dir/top-level.nul" \
    "$archive_dir/top-level-final.nul"
  (cd "$archive_dir" && shasum -a 256 -c \
    private-unknown-preimage.sha256 >/dev/null)
  private_now="$archive_dir/private-removal-now.tar"
  tar --null -b 1 -cf "$private_now" -C "$ACCEPTANCE_CHECKOUT" \
    -T "$archive_dir/preserve.nul"
  chmod 600 "$private_now"
  test "$(shasum -a 256 "$private_now" | awk '{print $1}')" = \
    "$(shasum -a 256 "$archive_dir/private-unknown-preimage.tar" | \
      awk '{print $1}')"
  rm -- "$private_now"
  ACCEPTANCE_WRITERS=$(ps -Ao pid=,command= | \
    awk -v wt="$ACCEPTANCE_CHECKOUT" \
      'index($0, wt) > 0 && index($0, "ps -Ao") == 0 { print }')
  test -z "$ACCEPTANCE_WRITERS"
  test "$(pwd -P)" = "$NEUTRAL_DIR"
  if lsof +D "$ACCEPTANCE_CHECKOUT" >/dev/null 2>&1; then exit 1; fi
  verify_remote_tags
  git -C "$ROOT" fetch origin main
  fetch_evidence_tags
  verify_remote_tags
  SEALED_HEAD=$(git -C "$ROOT" rev-parse "$FINAL_TAG^{commit}")
  test "$(git -C "$ROOT" rev-parse refs/remotes/origin/main)" = \
    "$ACCEPTED_MAIN"
  test "$(git -C "$ROOT" rev-parse main)" = "$ACCEPTED_MAIN"
  test "$(git -C "$ACCEPTANCE_CHECKOUT" rev-parse HEAD)" = \
    "$SEALED_HEAD"
  test -z "$(git -C "$ACCEPTANCE_CHECKOUT" status --porcelain=v1 -uall)"
  cmp -s "$archive_dir/top-level.nul" \
    <(inventory_top_level_nul "$ACCEPTANCE_CHECKOUT")
  (cd "$archive_dir" && shasum -a 256 -c \
    private-unknown-preimage.sha256 >/dev/null)
  tar -tf "$archive_dir/private-unknown-preimage.tar" >/dev/null
  test "$(tar --null -b 1 -cf - -C "$ACCEPTANCE_CHECKOUT" \
    -T "$archive_dir/preserve.nul" | \
    shasum -a 256 | awk '{print $1}')" = \
    "$(shasum -a 256 "$archive_dir/private-unknown-preimage.tar" | \
      awk '{print $1}')"
  test "$(git -C "$ROOT" rev-parse refs/remotes/origin/main)" = \
    "$ACCEPTED_MAIN"
  test "$(git -C "$ROOT" rev-parse main)" = "$ACCEPTED_MAIN"
  ACCEPTANCE_WRITERS=$(ps -Ao pid=,command= | \
    awk -v wt="$ACCEPTANCE_CHECKOUT" \
      'index($0, wt) > 0 && index($0, "ps -Ao") == 0 { print }')
  test -z "$ACCEPTANCE_WRITERS"
  test "$(pwd -P)" = "$NEUTRAL_DIR"
  if lsof +D "$ACCEPTANCE_CHECKOUT" >/dev/null 2>&1; then exit 1; fi
  rm -r -- "$ACCEPTANCE_CHECKOUT"
  rmdir "$LOCK"
fi
for branch_name in \
  codex/aais-enterprise-standard \
  codex/aais-worktree-recovery-design \
  codex/aais-session-revocation-test \
  codex/aais-locked-task-guard \
  codex/aais-daily-guide-budget \
  codex/aais-lrs-outbox-hardening \
  codex/aais-bobie-production-fallback \
  codex/aais-recovery-compose
do
  branch_id=$(printf '%s' "$branch_name" | shasum -a 256 | awk '{print $1}')
  LOCK="/private/tmp/aais-recovery-local-branch-delete-$branch_id.lock"
  mkdir -m 700 "$LOCK"
  git -C "$ROOT" fetch origin main
  test "$(git -C "$ROOT" rev-parse refs/remotes/origin/main)" = \
    "$ACCEPTED_MAIN"
  verify_remote_tags
  git -C "$ROOT" merge-base --is-ancestor "$branch_name" "$ACCEPTED_MAIN"
  git -C "$ROOT" branch -d "$branch_name"
  rmdir "$LOCK"
done
remote_branches=(codex/aais-recovery-compose)
PUBLICATION_HEAD_BRANCH=$(evidence_value publication_head_branch)
if test "$PUBLICATION_HEAD_BRANCH" != 'codex/aais-recovery-compose'; then
  remote_branches+=("$PUBLICATION_HEAD_BRANCH")
fi
for branch_name in "${remote_branches[@]}"; do
  branch_id=$(printf '%s' "$branch_name" | shasum -a 256 | awk '{print $1}')
  LOCK="/private/tmp/aais-recovery-remote-branch-delete-$branch_id.lock"
  mkdir -m 700 "$LOCK"
  git -C "$ROOT" fetch origin main
  test "$(git -C "$ROOT" rev-parse refs/remotes/origin/main)" = \
    "$ACCEPTED_MAIN"
  verify_remote_tags
  test "$(git -C "$ROOT" ls-remote --heads origin \
    "refs/heads/$branch_name" | \
    awk 'NF == 2 { count += 1 } END { print count + 0 }')" -eq 1
  git -C "$ROOT" push origin --delete "$branch_name"
  rmdir "$LOCK"
done
git -C "$ROOT" worktree prune
diff -u \
  <(printf '%s\n' '/Users/dongpinhu/Desktop/AAIS') \
  <(git -C "$ROOT" worktree list --porcelain | \
    sed -n 's/^worktree //p')
test -z "$(git -C "$ROOT" status --porcelain=v1 -uall)"
test "$(git -C "$ROOT" branch --show-current)" = 'main'
test "$(pwd -P)" = "$NEUTRAL_DIR"
```

Expected: each destructive action has its own sentinel and repeats exact
accepted-main equality, tracked/untracked status, ignored classification,
private archive hash/preimage comparison, process/lsof evidence, and remote tag
proof immediately before normal removal. The optional independent acceptance
checkout receives the same guard before non-forced recursive removal. After
each action's last fetch and remote-tag/ref proof, the final status/name/archive
and streaming preimage-byte comparisons are read-only; no writer, fetch, tag,
push, or ref-update command intervenes before the unavoidable normal removal.
The shell cwd remains the verified neutral directory before every whole-target
`lsof +D` call and through both normal removal commands, so the guard neither
self-counts nor filters away arbitrary handles.
Branches are deleted only after accepted reachability and remote tags are
exact. Only root `main` remains; root private data was never a target.

- [ ] **Step 5: Preserve the snapshot and immutable evidence tags after cleanup**

```bash
set -euo pipefail
ROOT=/Users/dongpinhu/Desktop/AAIS
SNAP=/Users/dongpinhu/Desktop/AAIS-dirty-worktree-backups/20260710-145253-worktree-recovery-refresh
EVIDENCE_PATH=docs/superpowers/recovery/2026-07-10-aais-dirty-inventory-equivalence.md
test -d "$SNAP"
test "$(stat -f '%Sp' "$SNAP")" = 'drwx------'
test "$(shasum -a 256 "$SNAP/root/tracked-vs-head.patch" | awk '{print $1}')" = \
  'e3c385c8c57ddf582dad07fd9596476e13a3dcd231c1fef4b93979865d2e3211'
test "$(shasum -a 256 "$SNAP/private-worktrees/aais-bobie-main-fix2-vs-origin-main.patch" | awk '{print $1}')" = \
  '57b7f506362620e1c8f21eca9e15ec38482a70a957bcd975052f672e2a92ec74'
EVIDENCE_COPY=$(mktemp /tmp/aais-recovery-evidence.XXXXXX)
trap 'rm -f "$EVIDENCE_COPY"' EXIT
git -C "$ROOT" show "main:$EVIDENCE_PATH" > "$EVIDENCE_COPY"
evidence_value() {
  local key=$1
  awk -v key="$key" '
    index($0, key "=") == 1 { count += 1; value = substr($0, length(key) + 2) }
    END { if (count != 1) exit 1; print value }
  ' "$EVIDENCE_COPY"
}
DOCS_TAG=$(evidence_value reviewed_docs_tag)
FINAL_TAG=$(evidence_value final_head_binding_tag)
ACCEPTED_MAIN_TAG=$(evidence_value accepted_main_binding_tag)
git -C "$ROOT" fetch origin main
for tag_name in "$DOCS_TAG" "$FINAL_TAG" "$ACCEPTED_MAIN_TAG"; do
  git -C "$ROOT" fetch origin \
    "refs/tags/$tag_name:refs/tags/$tag_name"
done
ACCEPTED_MAIN=$(git -C "$ROOT" rev-parse "$ACCEPTED_MAIN_TAG^{commit}")
test "$(git -C "$ROOT" rev-parse refs/remotes/origin/main)" = \
  "$ACCEPTED_MAIN"
test "$(git -C "$ROOT" rev-parse main)" = "$ACCEPTED_MAIN"
ARCHIVE_ROOT="/Users/dongpinhu/Desktop/AAIS-private-worktree-archives/$ACCEPTED_MAIN"
test "$(stat -f '%Sp' "$ARCHIVE_ROOT")" = 'drwx------'
test -d "$ARCHIVE_ROOT/root-preimage"
test "$(git -C "$ROOT" cat-file -t "$DOCS_TAG")" = 'tag'
test "$(git -C "$ROOT" rev-parse "$DOCS_TAG^{tag}")" = \
  "$(evidence_value reviewed_docs_tag_object)"
test "$(git -C "$ROOT" rev-parse "$DOCS_TAG^{commit}")" = \
  "$(evidence_value reviewed_docs_tip)"
test "$(git -C "$ROOT" cat-file -t "$FINAL_TAG")" = 'tag'
SEALED_HEAD=$(git -C "$ROOT" rev-parse "$FINAL_TAG^{commit}")
test "$(git -C "$ROOT" rev-parse "$ACCEPTED_MAIN^2")" = "$SEALED_HEAD"
test "$(git -C "$ROOT" rev-parse "$ACCEPTED_MAIN^{tree}")" = \
  "$(git -C "$ROOT" rev-parse "$SEALED_HEAD^{tree}")"
test "$(git -C "$ROOT" cat-file -t "$ACCEPTED_MAIN_TAG")" = 'tag'
for tag_name in "$DOCS_TAG" "$FINAL_TAG" "$ACCEPTED_MAIN_TAG"; do
  test "$(git -C "$ROOT" ls-remote --tags origin \
    "refs/tags/$tag_name" | awk '
      NF == 2 { count += 1; value = $1 }
      END { if (count != 1) exit 1; print value }
    ')" = "$(git -C "$ROOT" rev-parse "$tag_name^{tag}")"
  test "$(git -C "$ROOT" ls-remote --tags origin \
    "refs/tags/$tag_name^{}" | awk '
      NF == 2 { count += 1; value = $1 }
      END { if (count != 1) exit 1; print value }
    ')" = "$(git -C "$ROOT" rev-parse "$tag_name^{commit}")"
done
test "$(git -C "$ROOT" rev-parse "$SEALED_HEAD:$EVIDENCE_PATH")" = \
  "$(git -C "$ROOT" rev-parse "main:$EVIDENCE_PATH")"
```

Expected: exact accepted main still has the sealed head as its exact second
parent and the sealed tree as its exact tree; the external owner-only
rescue/private preimage archives and immutable
reviewed-docs/final-head/accepted-main annotated tags remain intact locally and
remotely after worktrees and mutable branches are removed.
