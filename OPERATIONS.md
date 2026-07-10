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
AAIS_SMOKE_BLOCKED_TRIAL_ACCOUNT=retired-demo-account \
AAIS_SMOKE_BLOCKED_TRIAL_PASSWORD=<retired-demo-password> \
npm run smoke:prod
```

The smoke command checks `/login`, public readiness, optional rejection of a retired demo credential, trial login, and a synthetic artifact write for the smoke learner account. Use a dedicated learner smoke account in staging and production; the report keeps credentials, cookies, retired-demo passwords, and page HTML out of output. Production rejects `teacher` and `admin` trial accounts, so educator access must come from database users or OIDC identities.

Bobie and Phoebe are valid production learner fallbacks while trial login is enabled; never use them as blocked smoke credentials.

Use `retired-demo-account` only for the blocked-credential check and supply its retired password through `AAIS_SMOKE_BLOCKED_TRIAL_PASSWORD`.

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

When Vercel creates a successful `Preview` deployment, GitHub Actions runs `.github/workflows/preview-e2e.yml` against the deployment URL. The workflow requires these GitHub Actions secrets, which must match non-production accounts configured in the Vercel Preview environment:

- `AAIS_E2E_STUDENT_ACCOUNT`
- `AAIS_E2E_STUDENT_PASSWORD`
- `AAIS_E2E_TEACHER_ACCOUNT`
- `AAIS_E2E_TEACHER_PASSWORD`

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

The canonical privacy inventory and pre-cohort governance gate are in `docs/privacy-data-inventory.md`. Keep that file aligned with storage migrations, privacy routes, LRS behavior, monitoring settings, and account-lifecycle changes.

Local manual check:

```bash
curl -sS -H "Cookie: <aais-session-cookie>" http://localhost:3000/api/learning/privacy
curl -X DELETE -H "Cookie: <aais-session-cookie>" -H "x-aais-csrf-token: <csrf-token>" http://localhost:3000/api/learning/privacy
```

Remaining owner/provider governance items before live cohort onboarding:

- Confirm the first cohort age group, region, institution, and whether minors are included.
- Confirm the formal retention schedule and legal basis for learner artifacts, events, account records, monitoring data, and xAPI/LRS statements.
- Confirm processor inventory, DPA status, and data-region terms for Vercel, Neon, LRS, email, monitoring, and AI model providers.
- Verify the login acknowledgement remains enforced (`AAIS_LOGIN_CONSENT_REQUIRED` when omitted), then record the formal consent workflow for learners, parents/guardians, or the institution before issuing real learner accounts.
- Decide whether learner self-service deletion should trigger downstream institutional account workflows outside AAIS.

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

- `AAIS_AI_DAILY_GUIDE_LIMIT` caps guide requests per student per day; default is 40 and the route returns 429 when the cap is reached.
- `AAIS_AI_MAX_RETRIES` defaults to 1, so live provider calls get at most one retry before fallback.
- Live provider responses are capped at 600 output tokens in the provider request.
- Production live AI still requires `AAIS_AI_EVAL_APPROVED=true` and `AAIS_AI_EVAL_VERSION` to avoid unapproved provider behavior.
