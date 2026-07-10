# AAIS Session Revocation Baseline Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the session-revocation tests independent of the wall clock without changing production revocation behavior.

**Architecture:** Use the existing optional `now` dependency in `isAaisSessionTokenRevoked` and `revokeAaisSessionToken`. The test will create one fixed verification instant and pass that same instant through every revocation operation.

**Tech Stack:** TypeScript, Vitest, Node.js date handling, Git worktrees.

---

### Task 1: Create the isolated baseline-fix worktree

**Files:**
- Reference: `docs/superpowers/specs/2026-07-10-aais-dirty-worktree-recovery-design.md`
- Modify: `tests/aais-session-revocations.test.ts`

- [ ] **Step 1: Confirm the common recovery base exists**

Run from `/Users/dongpinhu/Desktop/AAIS`:

```bash
git show --no-patch --oneline 49c920e
git worktree list --porcelain
```

Expected: commit `49c920e` is `docs: define AAIS worktree recovery`, and no worktree already uses branch `codex/aais-session-revocation-test`.

- [ ] **Step 2: Create the branch and worktree**

```bash
git worktree add .worktrees/aais-session-revocation-test \
  -b codex/aais-session-revocation-test 49c920e
```

Expected: Git reports a new worktree on `codex/aais-session-revocation-test`.

- [ ] **Step 3: Install dependencies**

Run from `/Users/dongpinhu/Desktop/AAIS/.worktrees/aais-session-revocation-test`:

```bash
npm install
git status --short --branch
```

Expected: install succeeds with zero vulnerabilities and Git reports a clean branch.

### Task 2: Reproduce and fix the time-dependent test

**Files:**
- Modify: `tests/aais-session-revocations.test.ts:11`
- Test: `tests/aais-session-revocations.test.ts`

- [ ] **Step 1: Run the failing test before editing**

```bash
npx vitest run tests/aais-session-revocations.test.ts --reporter=verbose
```

Expected before the fix: two failures at the final revoked-state assertions because the fixed token expired at `2026-07-09T20:00:00Z`.

- [ ] **Step 2: Pass a fixed clock through the memory-mode test**

Change the first test to this complete form:

```ts
it("revokes tokens with the local memory fallback", async () => {
  clearAaisSessionRevocationsForTest();
  const { verified, now } = createVerifiedToken();

  await expect(isAaisSessionTokenRevoked({
    tokenHash: verified.tokenHash,
    now,
    database: null,
  })).resolves.toBe(false);

  await expect(revokeAaisSessionToken({
    tokenHash: verified.tokenHash,
    actorId: verified.actor.id,
    expiresAt: verified.expiresAt,
    now,
    database: null,
  })).resolves.toMatchObject({
    status: "revoked",
    storageMode: "memory",
    secrets: "redacted",
  });

  await expect(isAaisSessionTokenRevoked({
    tokenHash: verified.tokenHash,
    now,
    database: null,
  })).resolves.toBe(true);
});
```

- [ ] **Step 3: Pass the same fixed clock through the Postgres-mode test**

Change the second test to this complete form:

```ts
it("persists revocations in Postgres without storing raw tokens or actor ids", async () => {
  const database = new FakeSessionRevocationDatabase();
  const { token, verified, now } = createVerifiedToken();

  await expect(isAaisSessionTokenRevoked({
    tokenHash: verified.tokenHash,
    now,
    database,
  })).resolves.toBe(false);
  await revokeAaisSessionToken({
    tokenHash: verified.tokenHash,
    actorId: verified.actor.id,
    expiresAt: verified.expiresAt,
    now,
    database,
  });

  await expect(isAaisSessionTokenRevoked({
    tokenHash: verified.tokenHash,
    now,
    database,
  })).resolves.toBe(true);
  expect(database.rows.get(verified.tokenHash)).toMatchObject({
    actor_key: expect.stringMatching(/^actor-[a-f0-9]{16}$/),
    expires_at: verified.expiresAt,
  });
  expect(JSON.stringify(database.queries)).not.toContain("S001");
  expect(JSON.stringify(database.queries)).not.toContain(token);
});
```

- [ ] **Step 4: Return the fixed verification instant from the fixture**

Replace `createVerifiedToken` with:

```ts
function createVerifiedToken() {
  const issuedAt = new Date(Date.UTC(2026, 6, 9, 12, 0, 0));
  const now = new Date(Date.UTC(2026, 6, 9, 12, 1, 0));
  const token = createAaisSessionToken(
    {
      id: "S001",
      role: "student",
      displayName: "Student",
    },
    issuedAt,
  );
  const verified = verifyAaisSessionTokenWithMetadata(token, now);
  if (!verified) {
    throw new Error("Expected test AAIS session token to verify.");
  }
  return { token, verified, now };
}
```

- [ ] **Step 5: Verify deterministic behavior repeatedly**

```bash
for run in 1 2 3; do
  npx vitest run tests/aais-session-revocations.test.ts || exit 1
done
```

Expected: each run reports one passing test file and two passing tests.

- [ ] **Step 6: Verify the clean baseline suite**

```bash
npm test
git diff --check
```

Expected: 50 test files and 321 tests pass; `git diff --check` prints nothing.

- [ ] **Step 7: Commit only the deterministic test change**

```bash
git add -- tests/aais-session-revocations.test.ts
git diff --cached --check
git diff --cached --name-status
git commit -m "test: make session revocation checks time deterministic"
git status --short --branch
```

Expected: the cached path list contains only `tests/aais-session-revocations.test.ts`, the commit succeeds, and the worktree is clean.
