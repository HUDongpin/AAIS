# AAIS Operations

## Local Setup

```bash
npm ci
cp .env.example .env.local
npm run dev
```

Local file storage is used when no Postgres URL is configured. Do not commit `.env.local`, generated reports, database URLs, cookies, or credential documents.

## Required Checks

Run before opening or merging a PR:

```bash
npm run ci
npm audit --audit-level=high
npm run e2e
npm run hygiene:check
git diff --check
```

`npm run hygiene:check` must pass before merge or release. It is redacted and checks Git remote presence, dirty-worktree status, staged private paths, and local private artifact filenames without reading credential values. During local inventory only, `--allow-dirty --allow-local-private-artifacts` can be used to see the remaining external release blockers.

Run the migration test path when database schema changes:

```bash
npm run db:migrate -- --output ./aais-postgres-migrations.json
npm run db:backfill -- --dry-run --output ./aais-postgres-backfill-dry-run.json
npm run verify:postgres-restore -- --env-file ./.env.postgres-restore.local --output ./aais-postgres-restore-report.json
```

## Deploy

The intended release path is Git-based:

1. Merge a reviewed PR to `main`.
2. Let Vercel deploy from Git.
3. Confirm the deployment is ready in Vercel.
4. Run the deployed smoke check against staging first, then production when appropriate.

Do not run `vercel deploy --prod` from a laptop. `vercel.json` runs `scripts/guard-vercel-production-deploy.mjs` before production builds; the guard requires `VERCEL_ENV=production` builds to carry Vercel Git metadata for the `main` branch. Provider-side Vercel project permissions and token cleanup still need to be enforced outside the repo.

```bash
AAIS_SMOKE_BASE_URL=https://www.aais.site \
AAIS_SMOKE_TRIAL_ACCOUNT=<trial-account> \
AAIS_SMOKE_TRIAL_PASSWORD=<trial-password> \
AAIS_SMOKE_BLOCKED_TRIAL_ACCOUNT=Bobie \
AAIS_SMOKE_BLOCKED_TRIAL_PASSWORD=<old-demo-password> \
npm run smoke:prod
```

The smoke command checks `/login`, public readiness, optional rejection of a retired demo credential, trial login, and a synthetic artifact write for the smoke learner account. Use a dedicated learner smoke account in staging and production; the report keeps credentials, cookies, retired-demo passwords, and page HTML out of output. Production rejects `teacher` and `admin` trial accounts, so educator access must come from database users or OIDC identities.

## Staging Load Sanity

Before a real cohort pilot, run a staging/preview load sanity check with dedicated student accounts:

```bash
npm run load:staging -- --approved \
  --base-url https://aais-preview.example \
  --credentials ./.aais-load-users.json \
  --target-users 200 \
  --concurrency 200 \
  --output ./aais-load-sanity.json
```

The credentials file is local/ignored and should contain staging-only learners as either an array or `{ "students": [...] }` with `account` and `password` fields. The runner refuses known production hosts, logs in every supplied learner, reads `/api/learning/session`, writes one synthetic artifact update, and reports aggregate pass/fail plus timing only. It omits accounts, passwords, cookies, CSRF tokens, response bodies, and learner text.

## Preview E2E

When Vercel creates a successful `Preview` deployment for a same-repository PR,
the successful `AAIS CI` run triggers `.github/workflows/preview-e2e.yml`. An
owner must approve the exact PR head with `/aais-preview-e2e approve <sha>`.
The trusted workflow then attests the GitHub deployment and canonical Vercel
metadata before running the stateless student smoke suite against the Preview
URL.

The workflow requires these GitHub Actions secrets:

- `AAIS_E2E_STUDENT_ACCOUNT`
- `AAIS_E2E_STUDENT_PASSWORD`
- `VERCEL_AUTOMATION_BYPASS_SECRET`
- `VERCEL_E2E_METADATA_TOKEN`

The student credentials must match the non-production learner configured in
the Vercel Preview `AAIS_TRIAL_ACCOUNTS_JSON`; Preview also needs its own
`AAIS_SESSION_SECRET` and a separate canonical 32-byte base64url
`AAIS_PRODUCT_PSEUDONYM_SECRET`. The attested Preview smoke is intentionally
stateless and may use Vercel `/tmp` plus process-local revocations; production
builds outside `VERCEL_ENV=preview` still fail closed without Postgres-backed
learner storage and revocations. Teacher/admin tests remain in the local CI E2E suite and
must not receive teacher/admin secrets in the deployed Preview job.

Create `VERCEL_E2E_METADATA_TOKEN` in the Vercel personal-account Tokens page,
scope it only to the team that owns AAIS, and set an expiration of at most one
year. Record the same expiry in the GitHub repository variable
`VERCEL_E2E_METADATA_TOKEN_EXPIRES_AT`. Rotate it before expiry, update the
GitHub secret through standard input, and validate the replacement with a new
approved Preview PR. Never paste, print, commit, screenshot, or attach the
token or deployed Playwright artifacts.

The deployed run sets `AAIS_E2E_BASE_URL`, so Playwright skips the local dev server and signs in through `/login`. Do not reuse production learner or teacher credentials for preview E2E.

## Migrations

Migrations live in `migrations/postgres/` and are applied in lexical order. The runner records checksums in `aais_schema_migrations` and refuses checksum drift for already-applied versions. The active schema now includes the seeded course catalog (`aais_courses`, `aais_course_tasks`) and real-account cohort membership table (`aais_enrollments`) in addition to learner sessions, event mirrors, task state, users, LRS outbox, rate limits, and revocations.

For production schema changes:

1. Apply on a restored/staging Neon branch first.
2. Run `npm run db:backfill -- --dry-run --output ./aais-postgres-backfill-dry-run.json` to count existing JSONB learner sessions that can populate `aais_events` and `aais_learner_task_state`.
3. Seed or verify dedicated staging database users with `AAIS_SEED_USERS_JSON` and `npm run db:seed-users -- --approved --output ./aais-user-seed-report.json`, or create them through `/admin/users`.
4. Run `npm run ci` and `npm run e2e`.
5. Apply to production during a low-usage window.
6. If the dry run found existing session rows, run `npm run db:backfill -- --output ./aais-postgres-backfill.json`.
7. Run the deployed smoke check.

The backfill command is idempotent and safe to rerun after restoring/importing old `aais_learner_sessions` rows. Its reports are count-only: they include backfill status, scanned/skipped row counts, event/task mirror counts, source environment name, and `secrets: "redacted"`; they do not include learner ids, session ids, database URLs, artifact text, self reports, or event detail.

## Account Administration

Admins manage database-backed accounts at `/admin/users`. The console supports invites, password reset requests, and role/status updates; each action emits a redacted audit event. Configure `AAIS_APP_BASE_URL`, `RESEND_API_KEY`, and `AAIS_AUTH_EMAIL_FROM` before relying on email delivery in staging or production.

Invite and reset tokens are one-time credentials. They are stored hashed, sent only through the configured email provider, and omitted from `/api/auth/users` responses. If email delivery is not configured, the admin console records the invite/reset request but does not expose a manual setup link.

Do not configure production teacher/admin access through `AAIS_TRIAL_ACCOUNTS_JSON` or `AAIS_TRIAL_SMOKE_ACCOUNTS_JSON`; those roles are treated as invalid in production readiness and login. Preview E2E may use non-production educator smoke accounts, but pilot/production humans should be represented as individual database users or mapped OIDC identities.

Admin-created users are enrolled into `AAIS_DEFAULT_COURSE_ID` and `AAIS_DEFAULT_COHORT` when invited. Defaults are `cognitive-apprenticeship` and `default`; set explicit staging/pilot values before inviting real class accounts. Disabling a user marks that course enrollment as `withdrawn` while preserving the account record for audit/lifecycle management.

Staging and preview smoke users may be bootstrapped with `npm run db:seed-users -- --approved --output ./aais-user-seed-report.json`. Configure `AAIS_SEED_USERS_JSON` with one entry per user and prefer `passwordEnv` references so raw passwords live only in ignored local env files, Vercel environment variables, or the password manager. The seed report hashes email addresses and omits raw passwords, cookies, database URLs, and setup links.

### Controlled Test-Account Batches

Use the controlled batch workflow when an operator needs the fixed acceptance batch of 40 students and 2 teachers. These are database-backed test users, not Vercel trial accounts. A batch is bound to one batch ID, course, cohort, Git commit, Vercel project, private credential CSV, and lifecycle from generation through disablement. Do not mix rows from different batches or reuse a credential file under a new batch ID.

The private CSV contract is exactly:

```text
batch_id,role,display_name,account,password,course_id,cohort,user_id
```

It must contain exactly 42 data rows: 40 `student` rows followed by 2 `teacher` rows. The file is a private operator artifact, not repository content or release evidence. Keep its parent directory mode `0700` and the CSV mode `0600`; the generator refuses symlinks, overwrites, and paths that are not ignored by Git. Store it only below an ignored private root such as the fictional `output/private-account-batches/example-qa-batch-20990101/`. Never paste, print, `cat`, preview, attach, screenshot, stage, commit, upload as an Actions artifact, or copy any account, password, or `user_id` into GitHub, Vercel logs, shell tracing, tickets, chat, or receipts. Keep shell tracing and Vercel CLI debug output disabled. Non-generation commands emit aggregate JSON to stdout and do not write receipt files; only that redacted aggregate may be retained in the controlled operator record.

The examples below use fictional batch and cohort names and intentionally do not satisfy the fixed Production batch binding. Set the variables once in a dedicated operator shell and replace them with the approved binding before running any command; do not paste the fictional block into a Production run unchanged:

```bash
AAIS_TEST_BATCH_ID="example-qa-batch-20990101"
AAIS_TEST_COHORT="example-qa-cohort-20990101"
AAIS_TEST_COURSE_ID="cognitive-apprenticeship"
AAIS_TEST_CSV="output/private-account-batches/${AAIS_TEST_BATCH_ID}/credentials.csv"
AAIS_TEST_EXPECTED_COUNT="42"
AAIS_TEST_VERCEL_PROJECT_ID="prj_example000000000000000000000000"
```

For the approved Production batch, the manager accepts only the exact relative custody path printed by `npm run accounts:test-batch -- --help`, ending in `AAIS-PROD-QA-20260827-40S-2T/credentials.csv`; any alternate filename or directory fails before file or database access.

#### 1. Generate the private batch

Run generation locally. It creates the directory and CSV with restrictive permissions, gives every row a unique 24-character base64url password from a cryptographically secure random source, and fails rather than replacing an existing file:

```bash
npm run accounts:test-batch -- generate \
  --output "${AAIS_TEST_CSV}" \
  --batch-id "${AAIS_TEST_BATCH_ID}" \
  --course-id "${AAIS_TEST_COURSE_ID}" \
  --cohort "${AAIS_TEST_COHORT}"
```

Do not inspect the rows to validate generation. Check only metadata that cannot reveal contents:

```bash
file_mode() {
  if stat -c '%a' -- "$1" >/dev/null 2>&1; then
    stat -c '%a' -- "$1"
  else
    stat -f '%Lp' "$1"
  fi
}
git check-ignore -q "${AAIS_TEST_CSV}"
test "$(file_mode "${AAIS_TEST_CSV}")" = "600"
test "$(file_mode "$(dirname "${AAIS_TEST_CSV}")")" = "700"
unset -f file_mode
```

The helper uses GNU `stat -c` when available and otherwise falls back to BSD/macOS `stat -f`. If generation or either metadata check fails, stop. Do not weaken permissions, add an ignore exception after the fact, move the file into a tracked path, or rerun with an overwrite option.

#### 2. Audit Git before any push

The Git audit compares the private CSV values against tracked `HEAD` blobs and the current index without emitting a value or matching path. Run it before staging, after staging, after provisioning, and once more before closing the batch:

```bash
npm run accounts:test-batch -- audit-git \
  --input "${AAIS_TEST_CSV}" \
  --batch-id "${AAIS_TEST_BATCH_ID}" \
  --expected-count "${AAIS_TEST_EXPECTED_COUNT}" \
  --course-id "${AAIS_TEST_COURSE_ID}" \
  --cohort "${AAIS_TEST_COHORT}"
```

The only passing result is zero occurrences and zero matched values for every audited credential category. Any match is a release stop: do not push, do not waive the check, and do not try to identify the leaked value through command output. Remove the staged or tracked exposure safely, rotate the affected batch credentials, regenerate a fresh batch, and rerun the audit.

#### 3. Merge code and bind the Production SHA

The private CSV never travels through the PR. A PR may contain only the reviewed batch CLI, tests, package wiring, documentation, and other non-secret source changes. Before merge, require all of the following:

- `git diff --check`, the focused batch tests, `npm run ci`, and `npm run e2e` pass.
- The staged-file inventory contains no private batch path, account list, generated receipt with identifiers, local env file, or credential document.
- `audit-git` passes against both `HEAD` and the final staged index.
- GitHub `verify` and Vercel Preview checks pass for the exact PR head. If Preview E2E is required, the Owner approves that exact head with `/aais-preview-e2e approve <sha>` and the resulting workflow passes.
- The reviewed PR is merged to `main`; Vercel creates Production from the Git-connected `main` flow, and the GitHub Production deployment, Vercel deployment, immutable URL, and production aliases all resolve to the same merge SHA.

After checking out the exact deployed merge, bind the operator run to it:

```bash
AAIS_TEST_EXPECTED_SHA="$(git rev-parse HEAD)"
test "$(git branch --show-current)" = "main"
test -z "$(git status --porcelain)"
```

Account provisioning is a data operation and must not trigger or substitute for a deployment. Never run `vercel deploy`, `vercel deploy --prod`, or an equivalent direct Production upload. Production code must continue to arrive only through the Git-connected `main` deployment guarded by `scripts/guard-vercel-production-deploy.mjs`.

#### 4. Provision Production with create-only semantics

Invoke every Production account command (`provision`, `verify`, and `disable`) through the single `npm run accounts:test-batch -- ...` entry below. That entry first executes the official `vercel --version` check against the exact package `vercel@59.7.0`, then internally launches the manager through `npx --yes vercel@59.7.0 env run -e production -- ...`; the manager rejects a missing or mismatched wrapper attestation. The wrapper never invokes `env pull` or writes an environment file. It independently requires both `VERCEL_ENV=production` and `VERCEL_TARGET_ENV=production`, and it fails closed if `AAIS_RESEARCH_MODE=true`, `AAIS_RESEARCH_REQUIRED=true`, or `AAIS_RESEARCH_ENVIRONMENT=research`; this batch is outside formal research and its page checks must not create research visits or study data. Record the attested CLI version and non-research isolation result in the aggregate operator receipt. Do not prepend a second Vercel command, invoke the internal manager directly, inject Production values locally, use a copied database URL or locally sourced secret file, or perform a direct Vercel deployment. If Vercel cannot provide a required Production-only sensitive integration value to the child process, stop at the resulting no-connection error; do not weaken the integration or substitute a stale local value.

Before any database or authentication operation, the same entry uses pinned, read-only `vercel inspect https://www.aais.site --json` and the GitHub Deployment API. It requires the canonical alias to resolve to one `READY` Vercel `production` deployment and requires the matching immutable deployment URL to have a Vercel-bot-authored GitHub `Production` deployment status of `success` for the exact expected SHA. Local `HEAD`, tracking `origin/main`, and live `origin/main` must all equal that SHA. A pending, failed, superseded, differently aliased, or differently versioned deployment stops before opening a database connection or sending an authentication request; a locally inherited `VERCEL_GIT_COMMIT_SHA` is not accepted as deployment evidence.

Immediately before provisioning, use the Vercel project dashboard or an equivalently authoritative read-only project inspection to verify that the linked project is exactly `aais`, its Production Storage integration is named exactly `aais-neon`, and the Production database binding resolves to that Neon project. Record only the resource name and non-secret project/deployment identifiers in the private operator evidence. The CLI project-link gate does not prove the database resource name; if this independent resource check is missing or mismatched, stop before opening a database transaction. Never print or record the database URL while performing this check.

```bash
npm run accounts:test-batch -- provision \
  --input "${AAIS_TEST_CSV}" \
  --target production \
  --approved \
  --expected-sha "${AAIS_TEST_EXPECTED_SHA}" \
  --project-id "${AAIS_TEST_VERCEL_PROJECT_ID}" \
  --batch-id "${AAIS_TEST_BATCH_ID}" \
  --expected-count "${AAIS_TEST_EXPECTED_COUNT}" \
  --course-id "${AAIS_TEST_COURSE_ID}" \
  --cohort "${AAIS_TEST_COHORT}"
```

The manager must invoke the seed capability in `create-only` mode. The lower-level supported seed form is `npm run db:seed-users -- --approved --mode create-only --batch-id <safe-id> --output <private-redacted-receipt.json>`; do not invoke its default `upsert` mode for a new controlled batch. Before the first write, the same transaction requires the six runtime tables used by account creation, login-rate limiting, and session revocation; the required login-rate-limit column; migrations `0002`, `0005`, `0006`, `0007`, `0010`, and `0026`; and the exact active course row held under a share lock through commit. Create-only provisioning then takes the batch transaction lock, checks the entire set for account/email/user-ID collisions, uses race-safe insert checks, creates the matching enrollments, and commits only after all 42 users and the exact in-transaction aggregate succeed. Any missing auth-runtime dependency, preflight collision, concurrent collision, count mismatch, enrollment mismatch, or intermediate error normally rolls back the whole batch. `AAIS_TEST_ACCOUNT_PROVISION_ROLLBACK_FAILED` means rollback could not be confirmed and database state is unknown. `AAIS_TEST_ACCOUNT_PROVISION_COMMITTED_UNVERIFIED` instead means the transaction committed but the separate post-commit aggregate could not be confirmed; it explicitly reports `committed=true` and `retryProvisioning=forbidden`. For either code, stop, preserve the fixed aggregate-only evidence, and require authorized read-only reconciliation; never rerun create-only provisioning, because a committed batch will correctly collide. Never convert a collision into an update, delete an existing user to make room, or claim a partial batch.

Provisioning passes only when the redacted aggregate JSON reports:

- `status="pass"`, `seed.created=42`, and `seed.enrollments=42`;
- `seed.upserted=42`, `seed.updated=0`, and `seed.collisions=0`;
- `preflight.requiredTables=6`, `preflight.requiredMigrations=6`, `preflight.authRuntime="ready"`, and `preflight.course="active"`;
- `transactionValidation.beforeWrite="passed"`, `transactionValidation.beforeCommit="passed"`, and the transaction aggregate contains exactly 42 users plus 42 enrollments before commit;
- both the transaction and post-commit aggregates report 40 active students, 2 active teachers, and 0 admins in the exact course and cohort;
- no partial commit and no secret, raw account, `user_id`, database URL, or password in stdout or stderr.

#### 5. Verify all 42 accounts on the canonical domain

A readiness response or database count is not authenticated acceptance. Run the bounded Production verifier through the same Vercel Production environment:

```bash
npm run accounts:test-batch -- verify \
  --input "${AAIS_TEST_CSV}" \
  --target production \
  --approved \
  --base-url https://www.aais.site \
  --expected-sha "${AAIS_TEST_EXPECTED_SHA}" \
  --project-id "${AAIS_TEST_VERCEL_PROJECT_ID}" \
  --batch-id "${AAIS_TEST_BATCH_ID}" \
  --expected-count "${AAIS_TEST_EXPECTED_COUNT}" \
  --course-id "${AAIS_TEST_COURSE_ID}" \
  --cohort "${AAIS_TEST_COHORT}"
```

The verifier uses concurrency `2`, applies a fixed `15,000 ms` deadline to every connection, response-header, and response-body operation, and must authenticate and log out every row. A timed-out request is reported as a failed aggregate check; if its response already exposed a session and CSRF cookie, the verifier makes a separately bounded best-effort logout before continuing. For each of the 40 students it confirms the actor role/ID, `/learning` access, and denial or redirect from `/dashboard`. For each of the 2 teachers it confirms the actor role/ID, `/dashboard` access, and denial or redirect from `/admin/users`. Acceptance is exactly `results.attempted=42`, `results.passed=42`, `results.failed=0`, `results.roles.student.passed=40`, `results.roles.teacher.passed=2`, `results.roles.admin.expected=0`, and `results.checks.logout.passed=42`. The three negative authentication cases must also report `passed=3`, `failed=0`, `sessionCookiesSet=0`, and no cleanup attempt; an unexpected session is a failure even if its immediate best-effort logout succeeds. Any single failure keeps the whole batch at `NO_GO`. Retain only the aggregate result and the bound batch ID, deployed SHA, Vercel/GitHub deployment IDs, course, cohort, timestamps, and operator approval reference.

#### 6. Disable the exact batch

Use the same private CSV and all original bindings. Never disable by email pattern, cohort-wide wildcard, display-name prefix, guessed range, or a newly generated list:

```bash
npm run accounts:test-batch -- disable \
  --input "${AAIS_TEST_CSV}" \
  --target production \
  --approved \
  --expected-sha "${AAIS_TEST_EXPECTED_SHA}" \
  --project-id "${AAIS_TEST_VERCEL_PROJECT_ID}" \
  --batch-id "${AAIS_TEST_BATCH_ID}" \
  --expected-count "${AAIS_TEST_EXPECTED_COUNT}" \
  --course-id "${AAIS_TEST_COURSE_ID}" \
  --cohort "${AAIS_TEST_COHORT}"
```

Disablement transactionally resolves the exact 42 `user_id` and enrollment pairs, changes active users to `disabled`, increments each changed user's `auth_version` once, and changes their matching `active` or `completed` enrollments to `withdrawn`. A repeat run is idempotent: users already disabled with withdrawn enrollments remain unchanged and must not receive another auth-version increment. The command passes only when its aggregate postcondition reports `users.matched=42` and `enrollments.matched=42`, each newly/already-disabled or withdrawn pair sums to 42, `users.authVersionsIncremented` equals `users.newlyDisabled`, and no out-of-scope row changed.

After disablement, rerun `audit-git`, retain the aggregate disable receipt, and handle the private CSV under the approved retention and destruction decision. Do not destroy the only exact-batch binding before disablement and its postcondition are proven; do not retain it indefinitely merely because Git ignores it.

#### PR, CI, and Vercel monitoring checklist

- [ ] Private CSV is under an ignored path with directory `0700` and file `0600`; it has never entered Git, logs, screenshots, artifacts, or chat.
- [ ] Pre-stage and post-stage `audit-git` results are zero, and the PR contains only non-secret source changes.
- [ ] Focused tests, `git diff --check`, `npm run ci`, `npm run e2e`, GitHub `verify`, Vercel Preview, and any Owner-approved Preview E2E are green for the exact PR head.
- [ ] Remote `main`, the merge commit, GitHub Production deployment, Vercel Production deployment, immutable URL, and `www.aais.site` aliases are bound to one exact SHA.
- [ ] An independent authoritative read-only check records that linked project `aais` uses the Production Storage integration `aais-neon` and that its Production database binding resolves to that Neon project; the evidence contains no database URL.
- [ ] Production environment attestation proves this is a non-research run: research mode and research-required are not enabled, the environment is not `research`, and the 42/42 verifier will not create research visits or study data.
- [ ] Production provisioning, verification, and disablement used the single npm entry whose receipt proves pinned Vercel CLI `59.7.0`, exact live Production deployment SHA/status/IDs, and canonical alias binding; no env pull, copied database URL, internal-manager bypass, or direct Production deploy was used.
- [ ] Create-only receipt is `42/42` with zero updates/collisions, both database aggregates have the 40/2/0 role split, authenticated verification is `42/42` with the 40/2/0 role split and 42 logouts, all three negative cases set zero sessions, and final Git audit remains zero.
- [ ] Disablement, if due, targets the original exact 42 IDs and proves 42 disabled users plus 42 withdrawn enrollments without a second auth-version increment.
- [ ] Only aggregate receipts, exact source/deployment identifiers, timestamps, approvals, and remaining blockers are recorded; readiness, deployment, database counts, and authenticated acceptance remain separately labelled.

## Teacher Recommendations

The dashboard consumes deterministic rule-based recommendations from `/api/learning/recommendations`. The policy is documented in `docs/teacher-recommendation-rules.md`; keep that file aligned with `aaisRecommendationPolicy.rules` whenever recommendation rules change. Teacher/admin override decisions are recorded as redacted `recommendation_override_recorded` events and must not include raw learner text in the override note.

Set `AAIS_RECOMMENDATIONS_ENABLED=false` to pause the teacher recommendation queue in a staging or pilot environment without changing cohort analytics, exports, or learner flows. The disabled GET response stays educator-only, returns an empty redacted policy with `enabled: false`, and rejects override writes after auth plus CSRF.

## Login Rate Limiting

Production login lockouts use the Postgres `aais_login_rate_limits` table, keyed by hashed account and client-address values so a fresh serverless function invocation still sees prior failures without storing raw account ids or IP addresses. Local development falls back to process memory when no database URL is configured.

Tune the default lockout with `AAIS_LOGIN_RATE_LIMIT_MAX_FAILURES`, `AAIS_LOGIN_RATE_LIMIT_WINDOW_SECONDS`, and `AAIS_LOGIN_RATE_LIMIT_LOCK_SECONDS`. Apply `npm run db:migrate` before deploying auth routes to any new Postgres-backed environment so the durable table exists before login traffic arrives.

## Session Revocation

`DELETE /api/auth/app-session` clears browser cookies and records a hashed session-token revocation until that token's original expiry. Protected API routes and protected pages reject revoked cookies even when the HMAC signature and expiry are otherwise valid.

Production revocations are stored in Postgres table `aais_session_revocations`; local development falls back to process memory when no database URL is configured. Apply `npm run db:migrate` before deploying this auth path to a new Postgres environment.

## Security Headers

Page responses receive a nonce-based Content Security Policy from `middleware.ts`. The middleware skips API routes and static assets, generates a fresh nonce per page request, and sets both the request CSP and response CSP so Next.js can attach nonces to framework scripts and styles during server rendering. Public pages are marked dynamic for this reason.

Production CSP must not include `unsafe-inline` or `unsafe-eval`. Development keeps React/Next debugging allowances, so validate production behavior with `npm run build` and Playwright rather than development headers alone.

## API Error Contract

API failures return a stable JSON envelope:

```json
{ "error": { "code": "AAIS_EXAMPLE_CODE", "message": "Safe client copy." } }
```

Handlers should map expected validation/auth/storage cases to route-owned codes and messages. Raw exception messages, provider responses, SQL details, learner text, cookies, tokens, and credentials must stay out of client JSON and flow only to redacted server logs or monitoring.

## Privacy Lifecycle

Learner-owned export and deletion are served from `/api/learning/privacy`:

- `GET /api/learning/privacy` returns the signed-in learner's `learner-data` JSON with `cache-control: no-store`. This is an owner-scoped export and can include raw learner artifacts, self reports, guide turns, and events.
- `DELETE /api/learning/privacy` requires the signed learner session and actor-bound CSRF token. It deletes learner sessions, task state, mirrored analytics rows, and persistent LRS outbox rows for that learner.
- In local file mode, deletion removes the learner session JSON under `.aais-data/`; no persistent LRS outbox exists in that mode.
- Deleting learner data does not delete the auth account. Account deactivation, invite state, password reset tokens, and institution SSO identity lifecycle remain administrator or institution-owned actions.

Short-lived security rows can be cleaned from Postgres without touching learner records:

```bash
npm run db:cleanup -- --dry-run --output ./aais-retention-cleanup-dry-run.json
npm run db:cleanup -- --approved --output ./aais-retention-cleanup.json
```

The command removes expired `aais_user_auth_tokens`, expired `aais_session_revocations`, and inactive `aais_login_rate_limits` rows whose lock/window has passed. Reports are count-only and omit token hashes, account keys, client keys, database URLs, and row ids.

The canonical privacy inventory and pre-cohort governance gate are in `docs/privacy-data-inventory.md`. The enforceable 30-participant research-study contract, including data minimization, access, retention, backup, withdrawal, and LRS physical deletion, is in `docs/research-data-governance.md`. Keep both files aligned with storage migrations, privacy routes, LRS behavior, monitoring settings, and account-lifecycle changes.

Local manual check:

```bash
curl -sS -H "Cookie: <aais-session-cookie>" http://localhost:3000/api/learning/privacy
curl -X DELETE -H "Cookie: <aais-session-cookie>" -H "x-aais-csrf-token: <csrf-token>" http://localhost:3000/api/learning/privacy
```

Remaining owner/provider governance items before live cohort onboarding:

- Confirm the first cohort age group, region, institution, and whether minors are included.
- Apply the operative research-study retention schedule in `docs/research-data-governance.md`; separately confirm the legal basis and any non-research account, monitoring, or cohort retention requirements.
- Confirm processor inventory, DPA status, and data-region terms for Vercel, Neon, LRS, email, monitoring, and AI model providers.
- Verify the login acknowledgement remains enforced (`AAIS_LOGIN_CONSENT_REQUIRED` when omitted), then record the formal consent workflow for learners, parents/guardians, or the institution before issuing real learner accounts.
- Decide whether learner self-service deletion should trigger downstream institutional account workflows outside AAIS.

## Research Study Data Operations

The study admits exactly 30 participants, each with one experiment, one `study_run_id`, and one `visit_id`. Postgres is the sole source of truth for research events. Research mode must fail closed rather than use `.aais-data` or session JSON as the event ledger. A permission-revoked HMAC participation ledger survives the 90-day ciphertext map, preserves the original run/visit and AES-GCM nonce reservation, and rejects duplicate or withdrawn admission.

Required deployment configuration:

- `AAIS_RESEARCH_DATABASE_URL` for the dedicated research Postgres fact store. It must not fall back to `AAIS_DATABASE_URL`; apply the tracked schema with `npm run db:migrate:research` before enabling collection.
- `AAIS_RESEARCH_MODE=true` and `AAIS_RESEARCH_REQUIRED=true`, immutable `AAIS_RESEARCH_PROJECT_ID`, immutable `AAIS_RESEARCH_STUDY_ID`, and `AAIS_RESEARCH_ENVIRONMENT=research`. `AAIS_RESEARCH_REQUIRED` keeps the dedicated study deployment terminal-blocked if the mode switch is accidentally omitted. The server derives `project_id`, `study_id`, `environment`, and namespace from these approved values. `AAIS_RESEARCH_LRS_NAMESPACE` must exactly match the validated server-derived value beneath `https://www.aais.site/xapi/`; it is not a client-selectable authority.
- `AAIS_RESEARCH_DATABASE_INSTANCE_ID` and `AAIS_RESEARCH_LRS_STORE_ID`, matching the signed infrastructure/provider isolation receipts. Runtime rejects a research database URL or instance id matching configured AAIS product/production/staging or MAIS targets.
- `AAIS_RESEARCH_IDENTITY_ENCRYPTION_KEY`, a rotatable base64-encoded 32-byte AES-256-GCM key, plus a separate stable `AAIS_RESEARCH_IDENTITY_FINGERPRINT_KEY`; neither may enter Postgres, logs, reports, or backups.
- `AAIS_RESEARCH_PARTICIPANT_ACTOR_IDS`, the signed server-side roster (exactly 30 ids for formal collection; 3–5 approved synthetic ids only during rehearsal).
- `AAIS_RESEARCH_PI_ACTOR_IDS` and `AAIS_RESEARCH_DATA_CUSTODIAN_ACTOR_IDS`, matching the signed access register.
- `AAIS_RESEARCH_EXPORT_ENABLED=true` only after authorization and audit checks pass.
- `AAIS_RESEARCH_LRS_ENDPOINT`, `AAIS_RESEARCH_LRS_USERNAME`, and `AAIS_RESEARCH_LRS_PASSWORD` for a clean, physically isolated, AAIS-only research store. Research mode must not fall back to generic `LRS_ENDPOINT`, `LRS_USERNAME`, or `LRS_PASSWORD`.
- `AAIS_RESEARCH_LRS_RECEIPT_VERIFYING_KEY_ID` and `AAIS_RESEARCH_LRS_RECEIPT_VERIFYING_KEY_SPKI` for the pinned provider key id and canonical base64 DER Ed25519 public key. Formal readiness fails without both; a rehearsal may omit them, but unverifiable deletion responses remain retryable and never become confirmed.
- `AAIS_RESEARCH_LRS_OUTBOX_FLUSH_TOKEN` for the research-only delivery/deletion worker. Do not reuse product or MAIS operations tokens.
- `AAIS_RESEARCH_EXPORT_ACTOR_IDS` for the signed per-event export grant. A generic `researcher` role without this allowlist is denied.
- `AAIS_RESEARCH_RETENTION_TOKEN` for the scheduled research-retention worker. Do not reuse the LRS flush token or any browser session.
- Three distinct external POST scheduler ids: `AAIS_RESEARCH_LRS_EVENT_FLUSH_SCHEDULE_ID`, `AAIS_RESEARCH_LRS_DELETION_SCHEDULE_ID`, and `AAIS_RESEARCH_RETENTION_SCHEDULE_ID`. The existing product Vercel GET cron is not a research scheduler.
- Fourteen pairwise-distinct SHA-256 evidence digests. The existing infrastructure/provider digests are `AAIS_RESEARCH_DATABASE_ISOLATION_RECEIPT_SHA256`, `AAIS_RESEARCH_LRS_ISOLATION_RECEIPT_SHA256`, `AAIS_RESEARCH_LRS_ZERO_BASELINE_RECEIPT_SHA256`, `AAIS_RESEARCH_LRS_PUT_DELETE_RECEIPT_SHA256`, `AAIS_RESEARCH_BACKUP_POLICY_RECEIPT_SHA256`, `AAIS_RESEARCH_RESTORE_RECEIPT_SHA256`, and `AAIS_RESEARCH_LEGACY_ARCHIVE_RECEIPT_SHA256`. The explicit governance/operations digests are `AAIS_RESEARCH_ACCESS_REGISTER_RECEIPT_SHA256`, `AAIS_RESEARCH_CONSENT_LEGAL_BASIS_RECEIPT_SHA256`, `AAIS_RESEARCH_DPA_RECEIPT_SHA256`, `AAIS_RESEARCH_DATA_REGION_RECEIPT_SHA256`, `AAIS_RESEARCH_DAILY_BACKUP_RECEIPT_SHA256`, `AAIS_RESEARCH_BACKUP_DESTRUCTION_RECEIPT_SHA256`, and `AAIS_RESEARCH_GOVERNANCE_MANIFEST_RECEIPT_SHA256`. Every source digest points to a different redacted, signed file in the restricted operations register; the manifest digest points to the verifier's sanitized successful report. Never reuse one receipt or digest for multiple gates.
- Freshness values copied only from the successful governance verifier report: `AAIS_RESEARCH_GOVERNANCE_MANIFEST_VERIFIED_AT`, `AAIS_RESEARCH_GOVERNANCE_MANIFEST_VALID_UNTIL`, `AAIS_RESEARCH_DAILY_BACKUP_COMPLETED_AT`, and `AAIS_RESEARCH_BACKUP_DESTRUCTION_OBSERVED_AT`. Formal readiness requires verification and daily backup no more than 36 hours old, a still-current manifest, and 35-day destruction evidence no more than 45 days old.
- `AAIS_APP_VERSION` and `VERCEL_GIT_COMMIT_SHA`; `AAIS_COMMIT_SHA` is allowed only as an approved non-Vercel fallback.
- `AAIS_RESEARCH_IDENTITY_RETENTION_DAYS=90`, `AAIS_RESEARCH_RAW_TEXT_RETENTION_DAYS=180`, `AAIS_RESEARCH_EVENT_RETENTION_DAYS=1825`, and `AAIS_RESEARCH_BACKUP_RETENTION_DAYS=35`. Lower values implement a shorter approved rule. Higher values require a registered written exception and otherwise fail closed.

### Restricted governance-evidence manifest

Keep the governance register outside the repository in a mode-0700 directory. Put each redacted source receipt, the exact manifest JSON, its raw 64-byte detached Ed25519 signature, and the canonical DER SPKI verification key in that register with mode 0600. The manifest uses schema `aais-research-governance-evidence/v1`, binds `project_id=aais`, the approved `study_id`, `environment=research`, the exact AAIS namespace/store, generation and validity times, signing key id, and exactly these thirteen source categories:

`database_isolation`, `lrs_isolation`, `lrs_zero_baseline`, `lrs_put_delete`, `backup_policy`, `restore`, `legacy_archive`, `access_register`, `consent_legal_basis`, `dpa`, `data_region`, `daily_backup`, and `backup_destruction`.

Every source entry has a unique relative `file`, its lowercase SHA-256, `declared_signed=true`, `effective_at`, and `expires_at`. `backup_policy` and `backup_destruction` also declare `retention_days=35`; `daily_backup` declares `completed_at`; `backup_destruction` declares `observed_at`, `coverage_start_at`, and `coverage_end_at`, with a coverage interval of at least 35 days. The signature covers the manifest's exact bytes; changing whitespace requires a new signature.

Run:

```bash
npm run study:verify-governance-evidence -- \
  --register-root /restricted/aais-study-register \
  --manifest /restricted/aais-study-register/manifest.json \
  --signature /restricted/aais-study-register/manifest.sig \
  --verifying-key-spki /restricted/aais-study-register/governance-verifying-key.der \
  --key-id institution-governance-2026-01 \
  --output /restricted/aais-study-register/reports/governance-verification-20260730.json
```

The verifier does not parse or print source-document content. It rejects symlinks, non-regular or empty files, paths outside the register, group/world-readable files, hash reuse/mismatch, incomplete category sets, invalid scope, invalid manifest signature, stale daily/destruction evidence, and expired controls. Its mode-0600 report contains only booleans, receipt categories/digests, approved scope/timestamps, stable issue codes, and a redaction declaration. The command prints only status, report digest, count, distinctness, and issue codes. Copy the thirteen source digest/timestamp values from a successful report into the matching deployment variables, then set `AAIS_RESEARCH_GOVERNANCE_MANIFEST_RECEIPT_SHA256` to the printed report digest. Never configure those variables from a `blocked` report.

This verifier proves that the reviewed manifest was signed and its restricted files match the declared digests and time windows. It does not parse contract terms or independently validate the legal sufficiency of consent/DPA language or embedded institution/provider signatures; the PI/custodian review and external authority remain separate.

Every permitted learner-session raw-text mutation must first acquire the opaque, visit-scoped research raw-text write lease. Its five-minute `expires_at` value is observation-only for stale-writer alerts: it never releases or invalidates a lease. The session save path holds the lease through the product-store write, and the AI guide path holds it through the complete streamed turn and final persistence. Starting withdrawal atomically moves the visit to `withdrawing` before it counts unreleased leases. That barrier rejects every new raw-text lease and every new research event. If an already-admitted raw-text write is still in flight, the withdrawal route returns HTTP `409` with `AAIS_RESEARCH_WITHDRAWAL_PENDING`; retry the same withdrawal only after the writer explicitly releases the lease. A timestamp that has passed requires operator investigation and remains blocking. Do not reopen the visit, retry the participant write, or erase raw text while any unreleased lease remains. The retry continues the already-established `withdrawing` barrier and may proceed to erasure only when the unreleased-lease count is zero.

Research `detail` is a controlled metadata surface, not a free-form JSON field. In particular, `link_host` is an abstract category and may be only `aais_site` or `external`; never record a hostname. `mime_type` may be emitted only for the allowlisted values `text/plain`, `text/markdown`, `text/csv`, and `application/pdf`. When the browser supplies any other or unknown MIME token, omit `mime_type` entirely rather than forwarding, normalizing, or logging the token.

At the end of each experiment, the PI or written-designated custodian calls `POST /api/research/visit/complete` with the run id, authenticated researcher session, and actor-bound CSRF token. Schedule `POST /api/research/retention?limit=100` with `Authorization: Bearer $AAIS_RESEARCH_RETENTION_TOKEN` at least daily. A successful run deletes only the due restricted learner-session raw-text fields, preserving unrelated product task/event/analytics/outbox history, then deletes due identity rows, preserves the HMAC admission/nonce reservation through the fact deadline, atomically converts due event/outbox rows into `reason='retention'` LRS deletion requests, deletes due Postgres research facts, status-gates cleanup of due operational receipts, and records count-only evidence. Export audits contain schema version, commit SHA, and `retention_due_at`; export, retention-run, LRS deletion, and archived-legacy receipts all have an explicit deadline. Never purge an unconfirmed LRS deletion, a receipt attached to a live withdrawal, or an uncompleted legacy inventory. Any `blockedActiveVisitCount > 0`, worker failure, dead-letter deletion, or missed deadline pauses collection and opens an incident. Drain `POST /api/research/lrs/flush?action=deletions` afterward. A plain 2xx or 404 is not confirmation. The provider must return the exact confirmation time, response-body SHA-256, pinned key id, and an unpadded base64url Ed25519 signature in the four `x-aais-lrs-absence-*` headers. AAIS verifies that signature against the configured SPKI over the canonical compact JSON envelope documented in `docs/research-data-governance.md`, binding store id, statement id, confirmation time, receipt digest, and key id. Missing configuration or failed verification leaves the row retryable with `research_lrs_absence_confirmation_pending`; the verified key id is persisted with the receipt evidence. Provider-side encrypted daily backup creation and 35-day destruction remain separately evidenced controls.

Before participant 1:

1. The PI and written-designated data custodian sign the protocol, access register, condition manifest, 30-participant boundary, and one-visit rule.
2. Verify Postgres-only storage; separate AES-256-GCM identity ciphertext; required `project_id`, `study_id`, `environment`, `participant_id`, `visit_id`, and `schema_version`; immutable condition, application version, and commit fields; one-to-one event/outbox writes; and raw-text exclusion from research events, LRS, logs, and audit evidence. Project, study, environment, and namespace must be server-derived.
   Confirm that both `AAIS_RESEARCH_MODE=true` and the fail-closed `AAIS_RESEARCH_REQUIRED=true` sentinel disable the generic `aais_events`, `aais_lrs_outbox`, in-memory/product LRS senders, dead-letter replay, and legacy analytics/event exports. A configured legacy `LRS_ENDPOINT` must receive zero requests during the rehearsal.
3. Confirm AAIS and MAIS use physically separate LRS stores/tenants and credentials, and that AAIS production, staging, and research are separately isolated. The only AAIS namespace prefix is `https://www.aais.site/xapi/`; `https://www.mais.ac/xapi/` is MAIS-only, while `mais-mvp.local` and `www.mais.hk` are forbidden. Every AAIS query/export must add the AAIS namespace filter server-side.
4. Confirm the research LRS starts empty and rehearse physical statement deletion. The existing 828 intact AAIS historical statements remain in the mixed AAIS/MAIS pool as a read-only legacy archive and must not be replayed, queried, exported, or counted as part of the new experiment. An xAPI void statement is not physical deletion and cannot satisfy the gate.
5. Run `npm run study:rehearse -- --participants 4 --output ./aais-research-rehearsal.json` against the migrated isolated Postgres target. Verify the exact event-id sets and counts for actual semantic operations, Postgres research events, LRS-eligible outbox events, and mock LRS statement ids; verify continuous per-visit sequence and success, failure, retry, disconnection, reconnection, and AI-latency coverage. Retain separate browser evidence for the actual UI wiring.
6. Complete an isolated restore rehearsal, reapply withdrawal tombstones, and verify event sequence plus event/outbox set equality.
7. Verify controlled researcher export from Postgres, stable event ordering, mandatory server-side AAIS namespace filtering, no raw text or identity map, an audit receipt, and denial for student, teacher, admin, and unapproved actors.
8. Call the authenticated readiness endpoint in enterprise mode and require `checks.research.applicationReady=true`, `checks.research.studyLaunchReady=true`, and overall `status=ready`. Formal visit creation and event ingestion enforce the same evidence/access/worker gate; a missing receipt cannot be waived by opening the UI directly.

Legacy archive inventory SOP:

1. Obtain `AAIS_LEGACY_LRS_ENDPOINT`, `AAIS_LEGACY_LRS_USERNAME`, and `AAIS_LEGACY_LRS_PASSWORD` as read-only credentials for the old mixed AAIS/MAIS pool. These credentials must never be used for new delivery, outbox flush, deletion, or the clean research store.
2. Run the read-only inventory into a restricted local receipt:

   ```bash
   AAIS_LEGACY_LRS_ENDPOINT=<legacy-mixed-pool-endpoint> \
   AAIS_LEGACY_LRS_USERNAME=<read-only-username> \
   AAIS_LEGACY_LRS_PASSWORD=<read-only-password> \
   npm run lrs:archive-legacy -- --expected-count 828 --stored-through <owner-approved-inclusive-provider-stored-ISO> --output ./aais-legacy-lrs-archive-manifest.json
   ```

3. Accept the inventory only when status is `pass`, both expected and actual counts strictly equal 828, statement ids are unique, and namespace integrity passes. `count_mismatch` or any count other than 828 means the archive is incomplete; do not change `--expected-count` to conceal the discrepancy.
4. When later AAIS rows already exist in the shared pool, freeze the authorized 828-row set with `--stored-through` using the provider `stored` timestamp, inclusively; never use client `timestamp` as this boundary. The receipt must also expose the total AAIS pool count, post-cutoff count, post-cutoff set digest, and provider-stored range so later rows cannot disappear from the audit. The data-bearing receipt fields are limited to statement ids, per-statement content SHA-256 digests, and counts. The operational envelope may also contain manifest SHA-256, time range/classification, and redaction markers. It must not contain raw statement bodies, learner text, or credentials. The command refuses to overwrite an existing receipt. Keep its mode-0600 output in the restricted study operations register and do not commit or stage it.
5. The command, script, docs, and synthetic tests are only readiness evidence. They do not mean this task has actually accessed the external legacy pool. Record live access only after an owner-authorized run using the read-only legacy credentials produces and verifies the exact 828-statement receipt.

Synthetic participant reconciliation SOP:

1. Apply all research migrations to an isolated Postgres target. Run `npm run study:rehearse -- --participants 4 --output ./aais-research-rehearsal.json`; `--participants` accepts only 3, 4, or 5 and defaults to 4.
2. The fixed metadata-only manifest performs exactly seven semantic operations per synthetic participant in one Postgres transaction. Accept only `status: pass` with actual semantic operations = Postgres research events = LRS-eligible outbox events = mock LRS statement ids by both count and exact event-id set, continuous per-visit sequence beginning at 1, and coverage for success, failure, retry, disconnection, reconnection, and AI latency.
3. The default run rolls back after reconciliation. A persistent run requires written approval, `AAIS_RESEARCH_REHEARSAL_APPROVED=true`, `AAIS_RESEARCH_ENVIRONMENT=research`, and the explicit `--commit` flag. No other environment may commit rehearsal data.
4. Keep the mode-0600 report in the restricted study operations register. It must omit plaintext identity, raw learner text, and credentials. Keep separate browser evidence because this fixed manifest does not itself drive the actual UI.
5. The rehearsal uses mock statement ids and does not perform actual external LRS delivery. The clean AAIS-only research store cannot launch until an external provider receipt proves physical store/tenant and credential isolation, a zero-statement baseline, successful delivery reconciliation, and the physical-deletion workflow.

For actual-UI evidence, run `npm run study:capture-browser` to freeze the strict action manifest before opening the browser, record the opaque visit ids separately after each authenticated bootstrap, and retain only the allowlisted metadata-only transport summary. The capture harness never retains a raw browser/network trace. Its artifacts are strict allowlists; extra identity-bearing fields such as `actor_id` invalidate them:

- The manifest root has exactly `evidence_schema_version`, `declared_at`, `declared_before_run`, `project_id`, `study_id`, `environment`, `lrs_namespace`, `lrs_store_id`, `participant_count`, `counting_contract`, and `participants`. `evidence_schema_version` is at least 2, `declared_before_run` is `true`, and `lrs_store_id` is the immutable store id checked against every outbox payload. `counting_contract` has exactly `physical_ui_triggers`, `expected_semantic_event_records`, and `note`. Each manifest participant has exactly `slot`, `physical_ui_triggers`, and `expected_events`; each ordered expected event has exactly `event_name`, `outcome`, and one-based `sequence`.
- The observed-visits root has exactly `evidence_schema_version`, `observed_at`, `source`, `project_id`, `study_id`, `environment`, `lrs_namespace`, and `participants`. Its `source` is `Playwright localStorage after each authenticated research bootstrap`. Each observed participant has exactly `slot`, `participant_id`, `study_run_id`, `visit_id`, and `condition`; the three ids must be UUIDs and unique across the 3–5 slots.
- Each retained acknowledgement has exactly `route`, `method`, `status`, `client_event_id`, and `visit_id`. An ordinary event must be `/api/research/events` + `POST` + `201`; a successful `account_logout` must be `/api/auth/app-session` + `DELETE` + `200`. The reconciler binds that exact tuple to one Postgres event and rejects aggregate-only, swapped-route, duplicated, missing, or extra acknowledgements. Never retain request bodies, passwords, learner prompts, response text, cookies, headers, or credentials.

Run `npm run study:attest-runtime`, `npm run study:attest-network`, and then `npm run study:reconcile-browser -- --manifest <manifest.json> --observed-visits <observed-visits.json> --transport-summary <transport-summary.json> --output <browser-reconciliation.json> --application-mode production-build --lrs-counter-url <local-counter-url> --runtime-build-attestation <runtime-build-attestation.json> --external-lrs-attestation <external-lrs-attestation.json>` with separate read-only `AAIS_PRODUCT_RECONCILIATION_DATABASE_URL` and `AAIS_RESEARCH_RECONCILIATION_DATABASE_URL`. The runtime-build attestation must bind the production build id and bundle SHA-256 to the same scope and event commit. The external-LRS attestation must be a complete, checksummed, sanitized network capture whose window encloses every visit start and server-received event time; full pass also requires `observed_external_lrs_requests=0`. Omitting either attestation leaves its status `not_verified` and limits the result to `limited-pass`, even when all core data gates pass. A mismatched build/commit, nonzero observed external request count, or incomplete network window likewise cannot produce `pass`.

Use `--application-mode local-development-build` only for explicitly limited local evidence. Acceptance requires an exact ordered manifest match, event/outbox and transport-acknowledgement set differences of zero, all outbox rows pending when no LRS was contacted, participant/identity/visit/ciphertext counts equal to the manifest, safe event detail, continuous sequence, required outcome coverage, generic product events/outbox zero, zero requests to both configured local LRS counters, and a clean working tree whose HEAD equals every event commit SHA. Local mock counters prove only that the endpoints configured to point at those counters received zero requests; they do not independently prove that the process made no external network contact. Only a complete external-LRS network attestation covering the whole event window can close that browser-run contact gate, and it still does not replace provider isolation, zero-baseline, delivery, or physical-deletion receipts. A missing exact acknowledgement list, dirty/unretained source snapshot, missing attestation, or other provenance gap produces `limited-pass`, never a full browser-evidence pass. Count physical UI triggers separately because one trigger may intentionally produce `attempted` plus a final outcome; the equality gate is predeclared semantic event records = Postgres events = LRS-eligible outbox rows.

The successful logout event is not inferred from local cookie or session revocation. If the session is revoked but the final `account_logout` acknowledgement is missing or non-matching, the client exposes the logout ACK gap and requires operator review. Treat it as a fail-evident incident: do not count the logout as a successful event, do not mark that participant's experimental evidence complete, and do not manufacture or backfill an acknowledgement from aggregate counters.

Daily and quarterly operation:

- Create an encrypted Postgres backup every day and retain online generations for no more than 35 calendar days. Never back up the identity encryption key, credentials, secrets, or exported datasets.
- Review sequence gaps/duplicates, atomic-write failures, namespace/project/study/environment mismatches, outbox retry/dead-letter state, and Postgres/outbox set differences each study day. Pause collection on any unexplained mismatch or cross-store result.
- Rehearse restore to an isolated target every quarter. Disable outbound LRS delivery, supply the identity key separately, apply withdrawal tombstones before queries, and preserve only a redacted count/set-difference receipt.
- Restrict identifiable and raw-text access to the PI and written-designated data custodian. A researcher role may receive only the de-identified per-event export; teacher and admin roles have no research-data access by default.

Withdrawal SOP:

1. Open a restricted withdrawal record and resolve the opaque participant/run/visit from the restricted HMAC participation ledger by `study_run_id`. Database withdrawal must work after the identity ciphertext has expired. If identity still exists, only the PI or written-designated data custodian decrypts it to delete product raw text; if it is absent, require the visit's prior raw-text deletion evidence.
2. Within 1 business day, stop new collection by beginning withdrawal. The database first sets the visit to `withdrawing`, which immediately rejects new raw-text leases, new research events, completion, and queued client events. Revoke the study visit; never reopen it to finish a client operation.
3. If the withdrawal response is HTTP `409` with `AAIS_RESEARCH_WITHDRAWAL_PENDING`, an already-admitted raw-text write still owns an unreleased lease. Keep the `withdrawing` barrier in place and retry the same withdrawal only after the writer explicitly releases the lease. An elapsed `expires_at` is an alert for operator investigation, never authority to ignore or delete the lease. This 409 is a retry instruction for the custodian's withdrawal call, not authorization to retry or accept the participant's write. Within 7 calendar days, delete restricted raw text, Postgres research events, the identity-map row, and all pending/retry/dead-letter outbox rows, but only after the unreleased-lease count reaches zero; mark opaque participant/run/visit and the scoped HMAC admission row withdrawn so re-enrolment stays rejected; capture count-only before/after evidence.
4. Within the same 7 calendar days, request physical deletion of every delivered external LRS statement. After the provider's documented maximum in-flight settlement window, query every exact statement id, repeat DELETE for any late arrival, and retain a provider-signed final absence receipt. A first 404, a client timeout, or an xAPI void statement cannot close the case.
5. Add a non-identifying restore tombstone and reapply it to every restore until affected records disappear through the 35-day rolling backup cycle.
6. Close only after scoped Postgres event/outbox zero-count evidence, a successful re-enrolment rejection check, the LRS physical-deletion receipt, collection revocation, and tombstone expiry are recorded.

Treat plaintext identity, raw text in telemetry, unauthorized export, key exposure, AES-GCM nonce reuse/lost reservation, a visit without its HMAC admission row, sequence/count/set mismatch, post-withdrawal collection, a raw-text erasure attempted while a write lease is live, a logout ACK gap, missed retention deletion, or unverified LRS deletion as a research-data incident. Immediately pause affected collection and LRS delivery, preserve redacted audit evidence, notify the PI and data custodian, rotate affected secrets, reconcile or delete affected records, and resume only with written PI approval. A fail-evident logout ACK gap is never relabelled as successful solely because the browser session or cookie was revoked.

Acceptance evidence is stored in the restricted study operations register: signed access and condition approvals, redacted readiness/migration receipt, 3-5 participant reconciliation report, separate actual-UI browser evidence, clean-store provider isolation/zero-baseline/delivery receipt, LRS physical-deletion rehearsal receipt, daily-backup and quarterly-restore receipt, researcher-export audit receipt, and withdrawal rehearsal receipt. Evidence must not include credentials, identity correspondence, or raw learner text.

## Responsive Support

AAIS treats login and the learner cockpit as phone-width supported. The release proof is the Playwright mobile learner smoke in `tests/e2e/mobile-learning.spec.ts`, currently using a 390px viewport and checking for no horizontal document overflow. Teacher/admin operational routes such as `/dashboard` and `/admin/users` are tablet/desktop supported surfaces; if a release changes those flows, review them on a wider viewport rather than promising phone-table ergonomics.

## Rollback

Application rollback:

1. Redeploy the last known-good Vercel deployment from the Vercel dashboard.
2. Re-run `npm run smoke:prod` with the target base URL.
3. Record the incident, commit SHA, deployment URL, and smoke result.

Database rollback:

1. Prefer forward-fix migrations for small reversible mistakes.
2. For destructive data issues, restore a Neon branch or snapshot first and inspect it.
3. Only point production back to restored data after owner approval and a written impact note.

## Backups And Restore

Before onboarding a real cohort, rehearse a Neon/Postgres restore to a separate branch and verify it with a local ignored env file:

```bash
cat > .env.postgres-restore.local <<'EOF'
AAIS_RESTORE_DATABASE_URL=<restored-staging-postgres-url>
AAIS_RESTORE_TARGET_PURPOSE=restored-staging
EOF

npm run db:migrate -- --output ./aais-postgres-migrations.json
npm run verify:postgres-restore -- --env-file ./.env.postgres-restore.local --output ./aais-postgres-restore-report.json
```

The restore verifier fails closed unless `AAIS_RESTORE_TARGET_PURPOSE=restored-staging`, checks that every AAIS Postgres table exists, reads only aggregate row counts, and runs a rolled-back synthetic insert into `aais_learner_sessions`. The report records only status, table presence, counts, the source variable name, and redaction markers; it omits database URLs, learner ids, learner payloads, and secrets.

For the isolated research database, use a different restore URL and the explicit research mode:

```bash
cat > .env.research-postgres-restore.local <<'EOF'
AAIS_RESEARCH_RESTORE_DATABASE_URL=<isolated-restored-research-postgres-url>
AAIS_RESTORE_TARGET_PURPOSE=restored-staging
EOF

npm run verify:postgres-restore -- --research --env-file ./.env.research-postgres-restore.local --output ./aais-research-postgres-restore-report.json
```

`--research` reads only `AAIS_RESEARCH_RESTORE_DATABASE_URL`; it never falls back to the product restore URL or the live `AAIS_RESEARCH_DATABASE_URL`. Run it after all currently due fact-retention batches have drained. It verifies the exact local 0009 migration checksum, all research tables/functions, required participation/nonce constraints and receipt columns, participation-ledger coverage, aggregate identity-ciphertext structure, continuous sequence among retained events for non-withdrawn visits, exact event/outbox set equality, and non-revived withdrawal tombstones. A legally expired sequence prefix may be absent after fact retention, but an internal gap among retained events still fails; a bounded retention run may create such a transient gap until the remaining due batches drain, so it is not an acceptable final restore receipt. Withdrawn visits are checked through the tombstone invariants because withdrawal intentionally deletes their event rows without resetting their historical sequence counter. The rolled-back fixture creates and records a participant, deletes its identity row, proves repeat admission returns the original run, proves a reserved nonce collision fails closed, withdraws by run, and proves post-withdrawal re-enrolment is rejected. No external LRS request is made. To exercise AES-256-GCM AAD/`bytea` round-trip compatibility, inject a separate 32-byte base64 `AAIS_RESEARCH_RESTORE_IDENTITY_ENCRYPTION_KEY` through the approved secret channel; the verifier decrypts only its post-restore synthetic fixture with the production AAD contract and never writes the key, ciphertext, identity, or identifiers to stdout or the report.

Evidence boundary: before running the command, the custodian must reapply the complete withdrawal-tombstone set from the restricted external operations register. The verifier checks only tombstones present in the restored database plus its rolled-back synthetic rejection path; `tombstoneCount=0` does not prove the external register was empty or completely reapplied. Likewise, `identityDecryption.evidence=post-restore-round-trip` proves the live restored schema, production AAD construction, supplied key, and Postgres `bytea` path work together, but it does not prove that a ciphertext created before backup survived backup/restore. That stronger claim requires a separately governed pre-backup synthetic fixture and receipt.

Owner/provider actions still required:

- Confirm the Neon plan, backup/PITR window, and data region in writing.
- Rehearse restore to a branch at least once before onboarding a real cohort.
- Record actual restore duration and any Neon support constraints.

## Monitoring

AAIS includes Sentry wiring for client, server, edge, App Router request errors, and the global React error boundary. Explicit operational events also report degraded LRS outbox drains through a redacted monitoring helper.

Required Sentry/Vercel environment variables:

- `NEXT_PUBLIC_SENTRY_DSN` for browser reporting.
- `SENTRY_DSN` if server/edge reporting should use a non-public DSN.
- `SENTRY_ORG`, `SENTRY_PROJECT`, and `SENTRY_AUTH_TOKEN` for CI/Vercel source-map upload.
- Optional `SENTRY_TRACES_SAMPLE_RATE` and `NEXT_PUBLIC_SENTRY_TRACES_SAMPLE_RATE`; default production sampling is 0.05.
- `AAIS_SENTRY_ALERTS_CONFIGURED=true` only after the named owner confirms Sentry alert routing reaches a human.
- `AAIS_UPTIME_LOGIN_CHECK_URL=<https-url>` after the external uptime check for `/login` is created.
- `AAIS_CRON_FAILURE_ALERTS_CONFIGURED=true` only after the LRS outbox cron-failure alert or Sentry Cron monitor is confirmed.

Privacy guardrails:

- `sendDefaultPii` stays disabled.
- Explicit AAIS monitoring events redact cookies, tokens, credentials, prompts, learner artifact text, messages, reports, and email-like fields.
- Session Replay is not enabled by default because learner work can include sensitive education data.

External setup still required:

- Create the Sentry project and store the environment variables in Vercel/CI.
- Trigger one test client error and one server/API error in staging, then confirm both appear with the expected release/environment tags.
- Configure an uptime check for `/login`.
- Configure notification routing for the explicit `aais.lrs_outbox.degraded` Sentry event and/or a Sentry Cron monitor on `/api/learning/lrs/outbox/flush`.
- Confirm `/api/system/readiness` no longer reports `SENTRY_DSN/NEXT_PUBLIC_SENTRY_DSN`, `AAIS_SENTRY_ALERTS_CONFIGURED`, `AAIS_UPTIME_LOGIN_CHECK_URL`, `CRON_SECRET`, or `AAIS_CRON_FAILURE_ALERTS_CONFIGURED`.

These systems need owner/provider access and cannot be completed from code alone.

## AI Guide Runtime

AAIS keeps the guide usable without a live provider: deterministic fallback replies are rendered with an offline scaffolding label, and provider failures preserve that label instead of hiding the degradation. The learning cockpit requests `text/event-stream` progress for guide turns, so learners see accepted/agent-start updates before the final answer when the route can stream.

Runtime controls:

- `AAIS_AI_DAILY_GUIDE_LIMIT` caps guide requests per student per day; the default and maximum are 1,000, lower positive values may be configured, and the route returns 429 when the cap is reached.
- `AAIS_AI_MAX_RETRIES` defaults to 1 for ordinary development. The signed Production snapshot contract is evaluated and deployed with `AAIS_AI_MAX_RETRIES=0`; changing it invalidates approval.
- Live provider responses are capped at 600 output tokens in the provider request.
- Production Qwen uses the immutable `qwen3.7-max-2026-06-08` snapshot. Rolling aliases are intentionally not approval-eligible.
- Production live AI requires `AAIS_AI_EVAL_APPROVED=true`, the exact `AAIS_AI_EVAL_VERSION`, `AAIS_AI_EVAL_MANIFEST_SHA256`, `AAIS_AI_EVAL_SIGNING_KEY_ID`, and `AAIS_AI_EVAL_VERIFYING_KEY_SPKI`. The bundled manifest must verify against all five values and the current endpoint/runtime/source contracts.
- Every snapshot response must return a `model` field that exactly equals the requested snapshot. A missing or different value is treated as provider failure and the learner sees the existing explicit offline support state.

Formal snapshot evaluation and signing:

1. Run `npm run release:evaluate-ai -- --env-file .env.local --model <dated-snapshot> --endpoint https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions --eval-version <version> --output tmp/<unsigned>.json`. It sends eight synthetic A1-A4/zh-CN/en-US samples and stores no raw prompts, outputs, or secrets.
2. Review the redacted manifest, then sign it with `npm run release:sign-ai-manifest`. The Ed25519 private key must be supplied through a mode-0600 ignored file or a secret environment variable and must never be committed; only the signed manifest and redacted public receipt enter source control.
3. Configure the exact model, zero retries, eval version, manifest digest, signing key id, and receipt public SPKI in Preview first. A changed prompt, CA background, guardrail, endpoint, model, retry count, signature, key, or expired evidence blocks live inference.
4. Merge only after CI and Preview A1/A2 probes pass. Production remains Git-connected; do not use a laptop `vercel --prod` deployment.

The 2026-08-23 snapshot evidence expires on 2027-08-23. Re-evaluate and rotate the signed manifest before that time; expiration deliberately returns Production to explicit offline support instead of silently accepting stale evidence.
