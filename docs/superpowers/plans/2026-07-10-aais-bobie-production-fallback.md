# AAIS Bobie Production Learner Fallback Recovery Plan

> **For agentic workers:** Use the executing-plans workflow task by task. This plan preserves the frozen reviewed source commit and assigns release-policy reconciliation to compose.

**Goal:** Preserve the reviewed production learner trial fallback for Bobie and Phoebe, while explicitly reconciling release documentation, duplicate identifier precedence, and production educator-denial coverage before publication.

**Reviewed source result:** `1d97d16998e95a92ebecb3a69a2ad14c9e0a566c` — `fix: preserve production learner trial fallback`

**Recorded review status:** specification PASS and quality PASS for the two-path source slice. Compose policy/test additions still require fresh review.

**Tech Stack:** TypeScript, Next.js authentication routes, Vitest, Git worktrees.

---

## Exact Frozen Slice

- Branch: `codex/aais-bobie-production-fallback`
- Worktree: `/private/tmp/aais-bobie-main-fix2-20260710`
- Base: `42e92a483842a2a601ecbdb10794a90c1f3eba1f`
- Final: `1d97d16998e95a92ebecb3a69a2ad14c9e0a566c`
- Subject: `fix: preserve production learner trial fallback`
- Modify: `src/lib/server/aais-trial-accounts.ts`
- Test: `tests/auth-route.test.ts`

No other path belongs to the frozen source slice.

### Task 1: Verify the exact reviewed source tip

- [ ] **Step 1: Verify worktree, branch, base, tip, subject, and tracked status**

```bash
set -euo pipefail
BOBIE_WT=/private/tmp/aais-bobie-main-fix2-20260710
test "$(git -C "$BOBIE_WT" branch --show-current)" = \
  "codex/aais-bobie-production-fallback"
test "$(git -C "$BOBIE_WT" rev-parse HEAD)" = \
  "1d97d16998e95a92ebecb3a69a2ad14c9e0a566c"
test "$(git -C "$BOBIE_WT" rev-parse HEAD^)" = \
  "42e92a483842a2a601ecbdb10794a90c1f3eba1f"
test "$(git -C "$BOBIE_WT" show -s --format='%s' HEAD)" = \
  "fix: preserve production learner trial fallback"
test -z "$(git -C "$BOBIE_WT" status --porcelain=v1 -uall)"
```

Expected: every assertion exits `0`.

- [ ] **Step 2: Verify the exact two-path boundary**

```bash
set -euo pipefail
BOBIE_WT=/private/tmp/aais-bobie-main-fix2-20260710
diff -u \
  <(printf '%s\n' \
    'src/lib/server/aais-trial-accounts.ts' \
    'tests/auth-route.test.ts' | LC_ALL=C sort) \
  <(git -C "$BOBIE_WT" diff-tree --no-commit-id --name-only -r HEAD | LC_ALL=C sort)
git -C "$BOBIE_WT" diff --check HEAD^..HEAD
```

Expected: the exact set matches and diff-check is silent.

- [ ] **Step 3: Run the frozen slice's focused acceptance**

```bash
set -euo pipefail
cd /private/tmp/aais-bobie-main-fix2-20260710
npx vitest run tests/auth-route.test.ts
test -z "$(git status --porcelain=v1 -uall)"
```

Expected: `tests/auth-route.test.ts` passes and the worktree remains
tracked/untracked-clean. Ignored/private state is classified separately before
removal.

### Task 2: Preserve the reviewed source behavior

The frozen commit has these accepted semantics:

1. `AAIS_TRIAL_LOGIN_ENABLED=false` disables the entry point.
2. Invalid configured trial-account JSON fails closed instead of falling back.
3. Missing configured trial-account JSON falls back to built-in Bobie and Phoebe learners in production.
4. Valid configured student accounts are merged with the two built-in learners.
5. Production configured `teacher` or `admin` trial accounts are invalid; educator access remains database/OIDC-only.
6. Built-in Bobie/Phoebe identifiers are inserted first; configured entries with the same identifiers are filtered out.
7. Login responses, audit output, and failures remain redacted.

The frozen commit must not be amended during composition. Merge exact SHA `1d97d16998e95a92ebecb3a69a2ad14c9e0a566c` with `--no-ff` so its provenance remains visible.

### Task 3: Record duplicate precedence and the complete policy matrix

The current implementation resolves configured duplicates with built-in precedence:

```ts
const builtInIds = new Set(builtInLearnerTrialAccounts.map((account) => account.id));
return [
  ...builtInLearnerTrialAccounts,
  ...configuredAccounts.filter((account) => !builtInIds.has(account.id)),
];
```

The accepted policy is exact:

- Built-in Bobie and Phoebe records win over configured records with the same identifier.
- A configured duplicate cannot replace a built-in display name, role, or password record.
- A unique configured learner remains available alongside the two built-ins.
- `AAIS_TRIAL_LOGIN_ENABLED=false` disables all trial login, including built-ins.
- Production configured teacher and admin trial identities are denied independently.
- Invalid configured trial data fails closed.

Compose must make these exact test names exist in `tests/auth-route.test.ts`:

1. `refuses trial account login when the trial-login entry is disabled`
2. `keeps Bobie and Phoebe available as production learner fallbacks`
3. `keeps a unique configured learner available alongside production fallbacks`
4. `keeps built-in credentials authoritative for duplicate Bobie and Phoebe identifiers`
5. `refuses production teacher trial accounts`
6. `refuses production admin trial accounts`

The positive fallback case exercises Bobie and Phoebe separately in production with no configured accounts. The unique configured case proves a non-duplicate learner and both built-ins remain accessible. Duplicate coverage proves built-in passwords succeed, configured duplicate passwords fail, actors remain learners, and secret values are absent. Teacher and admin denial are separate tests; neither is inferred from the other.

Assert and run each case independently:

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

Expected: all six exact auth cases and the blocked-credential smoke contract pass.

### Task 4: Reconcile production-demo documentation in compose

The initial recorded drift is checked only during the first policy reconciliation. A late-main refresh must never re-expect these contradictory strings.

Before the first edit, assert the recorded drift exactly:

```bash
set -euo pipefail
grep -Fqx \
  'Open `http://localhost:3000/login`. Local development can use built-in learner accounts; production excludes them.' \
  README.md
grep -Fq 'AAIS_SMOKE_BLOCKED_TRIAL_ACCOUNT=Bobie' OPERATIONS.md
grep -Fq 'retired-demo credential rejection' docs/release-checklist.md
```

Use `apply_patch` to establish these exact accepted lines:

```text
Production may use the built-in Bobie and Phoebe learner fallback while trial login is enabled; set `AAIS_TRIAL_LOGIN_ENABLED=false` to disable all trial login. Production teacher and admin trial identities are forbidden and must use database users or OIDC identities.
Bobie and Phoebe are valid production learner fallbacks while trial login is enabled; never use them as blocked smoke credentials.
Use `retired-demo-account` only for the blocked-credential check and supply its retired password through `AAIS_SMOKE_BLOCKED_TRIAL_PASSWORD`.
- [ ] Production smoke proves Bobie and Phoebe or a dedicated learner can sign in and the distinct `retired-demo-account` credential is rejected without a session cookie.
```

The first line is the accepted `README.md` paragraph. The next two are exact
`OPERATIONS.md` paragraphs. Insert the identical checklist line once under
Staging and once under Production, replacing both exact old smoke lines; its
required full-line count is `2`.

Assert every accepted line independently and reject the old contradictions:

```bash
set -euo pipefail
grep -Fqx \
  'Production may use the built-in Bobie and Phoebe learner fallback while trial login is enabled; set `AAIS_TRIAL_LOGIN_ENABLED=false` to disable all trial login. Production teacher and admin trial identities are forbidden and must use database users or OIDC identities.' \
  README.md
grep -Fqx \
  'Bobie and Phoebe are valid production learner fallbacks while trial login is enabled; never use them as blocked smoke credentials.' \
  OPERATIONS.md
grep -Fqx \
  'Use `retired-demo-account` only for the blocked-credential check and supply its retired password through `AAIS_SMOKE_BLOCKED_TRIAL_PASSWORD`.' \
  OPERATIONS.md
grep -Fq 'AAIS_SMOKE_BLOCKED_TRIAL_ACCOUNT=retired-demo-account' OPERATIONS.md
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

Stage and commit exactly the four compose-policy paths:

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
test -z "$(git status --porcelain=v1 -uall)"
```

This compose-only commit is created once. Late-main refreshes reassert it and never create an empty duplicate policy commit.

### Task 5: Final Bobie-focused integration acceptance

```bash
set -euo pipefail
npx vitest run tests/auth-route.test.ts
npx vitest run tests/smoke-prod.test.mjs \
  -t 'optionally proves a known demo credential is rejected without setting a session cookie'
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
git diff --check
test -z "$(git status --porcelain=v1 -uall)"
```

Expected: exact behavior names, docs sentences, auth tests, blocked-credential smoke, diff-check, and clean status all pass.
