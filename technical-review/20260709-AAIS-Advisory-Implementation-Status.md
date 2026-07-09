# AAIS Advisory Implementation Status

Status date: 2026-07-09 HKT

This file tracks Codex implementation progress against the accepted advisory in `20260708-AAIS-Technical-Advisory-Report-Codex-Clean.docx` and `AAIS-Technical-Review-Report.md`.

Important boundary: "Implemented locally" means the AAIS repository now contains the code, tests, docs, or scripts for the recommendation. It does not mean the item is production-ready when the acceptance criteria require provider-side proof, live deployment, account rotation, DPA confirmation, or owner approval.

## Summary

| Status | Count | Meaning |
| --- | ---: | --- |
| Implemented locally | 16 | Code/docs/tests are present in the repo and ready for normal release verification. |
| Partially implemented; external proof pending | 5 | Local wiring exists, but provider/account/live-environment acceptance criteria are still outside the repo. |
| Owner/provider action required | 1 | Cannot be completed safely by Codex without explicit owner/provider action. |

## Ticket Status

| Ticket | Current status | Evidence / remaining proof |
| --- | --- | --- |
| T-01 Rotate and re-home credentials | Owner/provider action required | `All API Keys.docx` must be rotated at each provider, moved to a password manager, and deleted only after owner confirmation. Codex did not read or print credential values. |
| T-02 Disable built-in demo accounts in production | Implemented locally; live rejection proof complete | `src/lib/server/aais-trial-accounts.ts` excludes built-in learners in production; `tests/auth-route.test.ts` covers production rejection and fail-closed behavior. Live proof on 2026-07-09 10:01 HKT: `https://aais-six.vercel.app` retired learner-password POSTs for `Bobie`/`Phoebe` returned `401` / `AAIS_INVALID_CREDENTIALS` with no `aais_session` or `aais_csrf` cookies. |
| T-03 Private GitHub repo, protected main, CI | Partially implemented; external proof pending | `.github/workflows/ci.yml`, `.github/workflows/preview-e2e.yml`, Dependabot, repo hygiene checks, dependency-audit guardrails, and the Vercel production build guard in `scripts/guard-vercel-production-deploy.mjs` are present; `technical-review/aais-dependency-audit-20260709.json` reports 0 high and 0 critical vulnerabilities. GitHub remote/protected `main`, provider-side CI run, Vercel Git integration, and direct-deploy permission lockout require owner/repo/provider setup. |
| T-04 Minimal-disclosure readiness endpoint | Implemented locally | Anonymous readiness returns bare `{status}`; admin session or bearer token returns the full report. Covered by `tests/readiness-route.test.ts`. |
| T-05 Sentry, uptime, cron alerts | Partially implemented; external proof pending | Sentry instrumentation, redacted monitoring helpers, Vercel cron monitor wiring, and readiness checks for Sentry DSN, alert-routing evidence, `/login` uptime evidence, `CRON_SECRET`, and cron-failure alert evidence are wired. Vercel production currently lacks a Sentry DSN env by name, and Sentry project/alerts plus external uptime still require owner/provider setup. |
| T-06 Staging environment and env docs | Partially implemented; external proof pending | `.env.example`, preview E2E workflow, migration/backfill/user-seed scripts, smoke docs, and staging checklist exist. Actual Vercel preview/staging URL and Neon branch must be created and smoke-proven. |
| T-07 Backups and restore rehearsal | Partially implemented; external proof pending | Restore verifier and OPERATIONS restore runbook exist. Neon PITR/snapshot capability, schedule, and real restored-branch timing need owner/provider confirmation. |
| T-08 Optimistic locking | Implemented locally | Learner sessions use a versioned write path with conflict handling; backend tests cover parallel write safety. |
| T-09 Migration framework and baseline | Implemented locally and applied to production | `migrations/postgres/` and `scripts/run-postgres-migrations.mjs` own schema setup; request handlers no longer create/alter tables. Production migration proof on 2026-07-09 HKT: `technical-review/aais-postgres-migrations-production-20260709.json` shows versions `0001`-`0007` applied with `secrets: "redacted"`. |
| T-10 Archive release-evidence pipeline | Implemented locally | Legacy release machinery is under `tools/release-legacy/`; package scripts keep focused product gates plus `smoke:prod`. |
| T-11 LangGraph dependency/labels | Implemented locally by adoption path | The advisory flagged misleading LangGraph labels because there were no imports. AAIS project instructions require LangGraph in the A1-A4 flow, so `src/lib/ai/orchestration/aais-learning-guide-graph.ts` now uses `StateGraph` nodes for A1-A4 and keeps CA background passing intact. |
| T-12 Documentation rewrite | Implemented locally | README is back to a one-page onboarding map with `tests/documentation-readme.test.ts` guarding the line budget; ARCHITECTURE includes the real Mermaid runtime/data-flow diagram plus deliberate Not Yet/revisit-trigger list guarded by `tests/documentation-architecture.test.ts`; OPERATIONS, CONTRIBUTING, privacy inventory, teacher recommendation rules, release checklist, and conservative production-readiness checklist are covered by documentation tests. |
| T-13 Playwright E2E in CI | Implemented locally | Playwright specs cover login, bad password, learning persistence, AI guide fallback/progress, dashboard access/export, and mobile learner usability; preview workflow is present. |
| T-14 Data model v2 and backfill | Implemented locally | Migrations add users, events, task state, course catalog, enrollments, rate limits, and revocations; backfill script mirrors existing session blobs into event/task-state tables. Staging rehearsal from a prod snapshot remains external. |
| T-15 Invites, registration, reset, admin users | Implemented locally | User/auth-token storage, invite/password route, admin users page, and redacted `db:seed-users` bootstrap path are present. Invite/reset one-time tokens stay server-side and are omitted from admin API responses. Real email provider and actual invite-to-login staging proof remain release tasks. |
| T-16 Individual teacher/admin accounts | Partially implemented; external proof pending | Role-bearing database users and admin management exist, and production now rejects `teacher`/`admin` trial accounts so educator env credentials cannot become production sessions. Every human receiving an individual credential and old shared env accounts being removed is an owner rollout task. |
| T-17 Durable rate limiting | Implemented locally; production live proof complete | Production login failures use Postgres-backed counters keyed by hashed account/client values; local development falls back to memory. `technical-review/aais-postgres-migrations-production-20260709.json` shows `0002_login_rate_limits` applied in production; live alias smoke on 2026-07-09 10:02 HKT returned `401` for attempts 1-5 and `429` / `AAIS_LOGIN_RATE_LIMITED` with `retry-after: 900` on attempt 6. |
| T-18 Frontend decomposition | Implemented locally | Learning cockpit logic is split into typed helpers, feature components, hooks, guide streaming, and client session utilities, with component and E2E coverage. |
| T-19 API error-code contract | Implemented locally | Server routes use stable error shapes and the client maps them to friendly copy through `src/lib/client/aais-api-error.ts`. |
| T-20 SQL cohort analytics | Implemented locally | Cohort analytics uses event/task-state SQL aggregates with learner drill-down pagination; tests cover correctness and flat behavior with 500 simulated learners. |
| T-21 Learner profiles and rule recommendations | Implemented locally | Rule-based recommendations, teacher override logging, UI integration, `AAIS_RECOMMENDATIONS_ENABLED` release gating, and teacher-facing rule documentation are present. |
| T-22 AI experience quality pass | Implemented locally | Runtime defaults now include a 600-token ceiling, one retry, visible fallback labeling, staged SSE progress, per-student daily guide budget, and AI guide busy/error live-region handling. Staging first-token/cost proof remains release evidence. |

## Non-Ticketed Advisory Items

| Item | Current status | Evidence / remaining proof |
| --- | --- | --- |
| Privacy baseline / ISS-16 | Partially implemented; external proof pending | Data inventory, retention boundaries, learner export/delete route, login consent acknowledgement, and redacted `db:cleanup` for expired security rows exist. Cohort age/region/legal basis, formal consent record, DPAs, and data-region evidence require owner/provider confirmation. |
| Accessibility and responsive pass / ISS-19 | Implemented locally, with manual screen-reader spot check still open | Skip link, named `main` landmarks for login/learning/dashboard, keyboard-operable core-screen Playwright proof, browser contrast audit/fixes, focus/reduced-motion CSS, accessible labels, AI guide alerts/status, login and password-management duplicate-submit busy states, guide upload-read busy state, dashboard loading/pagination/export/override busy states, admin invite and row-action busy states, learner account export/delete/logout busy states, learner autosave/download busy/error states, `technical-review/AAIS-Async-Action-Audit.md`, tests, and a 390px learner-cockpit Playwright smoke exist. Teacher/admin phone support is intentionally not promised; manual screen-reader spot-check evidence remains open in the readiness checklist. |
| Critical/High regression coverage | Implemented locally | `technical-review/AAIS-Critical-High-Regression-Coverage.md` maps every Critical/High advisory issue already fixed in-repo to concrete regression tests, while leaving owner/provider and live-environment acceptance criteria open. |
| Nonce CSP / ISS-18 | Implemented locally | Page routes use middleware-generated nonces; production policy removes `unsafe-inline` and `unsafe-eval`. |
| Session revocation / ISS-17 | Implemented locally | Logout revokes session token hashes until expiry using the database-backed revocation store when available. |
| Load sanity check | Partially implemented; external proof pending | `npm run load:staging` provides an approval-gated, staging/preview-only 200-student synthetic learner flow with redacted aggregate timing. Actual staging run and bottleneck review require a staging URL plus dedicated student accounts. |

## Release Gate

Do not onboard a real student cohort until these are proven outside the repo:

- T-01 credential rotation and deletion of the plaintext credential file after owner confirmation.
- T-03 private GitHub remote, protected `main`, green CI on a PR, Vercel Git deploy flow, and provider-side direct-deploy lockout.
- T-05 provider-side Sentry alert routing, uptime check, and cron/degraded-outbox notification.
- T-06 staging URL and Neon branch with `db:seed-users`, admin invite, or OIDC smoke accounts proven end to end.
- T-07 Neon PITR/snapshot confirmation and a real restored-branch rehearsal with recorded timing.
- T-16 individual credentials issued to every human and old shared/break-glass accounts removed or documented.
- Privacy owner/provider evidence: cohort age/region/institution, legal basis, retention schedule, consent workflow, DPA/subprocessor/data-region terms for Vercel, Neon, LRS, Sentry, email, and AI provider.
