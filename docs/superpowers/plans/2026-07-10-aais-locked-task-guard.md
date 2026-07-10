# AAIS Locked Task Guard Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Prevent every learner mutation from bypassing Cognitive Apprenticeship task sequencing and return a redacted locked-task API error.

**Architecture:** Add one store-level `requireUnlockedTask` guard and route all mutable task operations through it. Keep HTTP redaction at the API boundary and prove both store and route behavior before committing.

**Tech Stack:** TypeScript, Next.js route handlers, Vitest, file-backed AAIS learning store, Git worktrees.

---

### Task 1: Create the isolated locked-task worktree

**Files:**
- Modify: `src/lib/server/aais-learning-store.ts`
- Modify: `src/app/api/learning/scaffold/route.ts`
- Test: `tests/aais-backend-store.test.ts`
- Test: `tests/aais-api-routes.test.ts`

- [ ] **Step 1: Create the branch from the approved recovery base**

Run from `/Users/dongpinhu/Desktop/AAIS`:

```bash
git worktree add .worktrees/aais-locked-task-guard \
  -b codex/aais-locked-task-guard 49c920e
```

Expected: a clean worktree on `codex/aais-locked-task-guard`.

- [ ] **Step 2: Install dependencies and confirm cleanliness**

Run from `/Users/dongpinhu/Desktop/AAIS/.worktrees/aais-locked-task-guard`:

```bash
npm install
git status --short --branch
```

Expected: install succeeds and Git has no source changes.

### Task 2: Add failing store and route tests

**Files:**
- Modify: `tests/aais-backend-store.test.ts:98`
- Modify: `tests/aais-api-routes.test.ts:1065`

- [ ] **Step 1: Add the store regression test**

Insert after the existing training-to-practice sequencing test:

```ts
it("rejects every learner mutation targeting a locked task", async () => {
  const store = createAaisLearningStore({ rootDir: tempDir });
  await store.getOrCreateSession("S001");

  // A brand-new learner has only training_task_1 active; every practice task is
  // locked until its prerequisite is completed. None of these mutations may act on
  // a locked task, otherwise sequencing (and cohort analytics) can be bypassed.
  await expect(store.completeTask("S001", "practice_task_2")).rejects.toThrow(
    "Task practice_task_2 is locked",
  );
  await expect(store.saveArtifact("S001", "practice_task_2", "x")).rejects.toThrow(
    "Task practice_task_2 is locked",
  );
  await expect(store.saveSelfReport("S001", "practice_task_2", "x")).rejects.toThrow(
    "Task practice_task_2 is locked",
  );
  await expect(
    store.requestScaffold("S001", "practice_task_2", "stage-checklist"),
  ).rejects.toThrow("Task practice_task_2 is locked");
  await expect(
    store.recordAiAcceptance("S001", "practice_task_2", { accepted: true }),
  ).rejects.toThrow("Task practice_task_2 is locked");

  const session = await store.getOrCreateSession("S001");
  expect(session.tasks.find((task) => task.taskId === "practice_task_2")?.status).toBe(
    "locked",
  );
  expect(session.tasks.filter((task) => task.status === "completed")).toHaveLength(0);
});
```

- [ ] **Step 2: Add the complete-task route regression test**

Insert before the cohort analytics tests:

```ts
it("rejects completing a locked task through the session route", async () => {
  const sessionRoute = await import("@/app/api/learning/session/route");
  const s001Cookie = createAuthedCookie("S001");

  // A brand-new learner may not complete practice_task_3 (locked) directly —
  // this would otherwise bypass server-side sequencing and inflate analytics.
  const response = await sessionRoute.PATCH(
    new Request("http://localhost/api/learning/session", {
      method: "PATCH",
      headers: {
        cookie: s001Cookie,
        "x-aais-csrf": createAaisCsrfToken("S001"),
      },
      body: JSON.stringify({
        action: "complete-task",
        taskId: "practice_task_3",
      }),
    }),
  );
  const body = await response.json();

  expect(response.status).toBe(400);
  expect(body.error).toEqual({
    code: "AAIS_TASK_LOCKED",
    message: "AAIS task is locked.",
  });

  // The locked task must remain uncompleted after the rejected request.
  const sessionResponse = await sessionRoute.GET(
    new Request("http://localhost/api/learning/session", {
      headers: { cookie: s001Cookie },
    }),
  );
  const sessionBody = await sessionResponse.json();
  expect(
    sessionBody.session.tasks.find(
      (task: { taskId: string }) => task.taskId === "practice_task_3",
    )?.status,
  ).toBe("locked");
});
```

- [ ] **Step 3: Prove the new tests fail against the baseline**

```bash
npx vitest run \
  tests/aais-backend-store.test.ts \
  tests/aais-api-routes.test.ts \
  -t "locked task"
```

Expected: the new tests fail because `completeTask`, mutable task fields, scaffolding, and AI acceptance still use `requireTask`.

### Task 3: Implement the shared store guard and API mapping

**Files:**
- Modify: `src/lib/server/aais-learning-store.ts:466`
- Modify: `src/lib/server/aais-learning-store.ts:533`
- Modify: `src/lib/server/aais-learning-store.ts:615`
- Modify: `src/lib/server/aais-learning-store.ts:936`
- Modify: `src/lib/server/aais-learning-store.ts:2545`
- Modify: `src/app/api/learning/scaffold/route.ts:82`

- [ ] **Step 1: Route all mutable task lookups through the unlocked guard**

Apply these exact substitutions in `createAaisLearningStore`:

```diff
-const completed = requireTask(session, taskId);
+const completed = requireUnlockedTask(session, taskId);

-const task = requireTask(session, taskId);
+const task = requireUnlockedTask(session, taskId);
```

The `task` substitution applies in `requestScaffold`, `recordAiAcceptance`, and the inner loop of `saveTaskText`. Do not change the read-only `requireTask` call inside `selectTask`; that function already performs its own locked-state check.

- [ ] **Step 2: Add the shared helper immediately after `requireTask`**

```ts
function requireUnlockedTask(session: AaisLearnerSession, taskId: string) {
  const task = requireTask(session, taskId);
  if (task.status === "locked") {
    throw new Error(`Task ${taskId} is locked`);
  }
  return task;
}
```

- [ ] **Step 3: Map locked scaffold errors without exposing task ids**

Insert this branch in `getErrorResponseInput`, before the practice-only scaffold error:

```ts
if (error instanceof Error && error.message.startsWith("Task ") && error.message.endsWith(" is locked")) {
  return {
    code: "AAIS_TASK_LOCKED",
    message: "AAIS task is locked.",
    status: 400,
  };
}
```

- [ ] **Step 4: Run the focused locked-task tests**

```bash
npx vitest run \
  tests/aais-backend-store.test.ts \
  tests/aais-api-routes.test.ts \
  -t "locked task"
```

Expected: all tests matching `locked task` pass.

- [ ] **Step 5: Run the complete owning test files**

```bash
npx vitest run tests/aais-backend-store.test.ts tests/aais-api-routes.test.ts
npm run type-check
git diff --check
```

Expected: both test files pass, TypeScript passes, and diff-check is silent.

- [ ] **Step 6: Commit only the locked-task slice**

```bash
git add -- \
  src/lib/server/aais-learning-store.ts \
  src/app/api/learning/scaffold/route.ts \
  tests/aais-backend-store.test.ts \
  tests/aais-api-routes.test.ts
git diff --cached --check
git diff --cached --name-status
git commit -m "fix: reject mutations against locked learning tasks"
git status --short --branch
```

Expected: exactly four paths are committed and the worktree is clean.
