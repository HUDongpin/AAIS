# AAIS Minimum Production-Readiness Checklist

*"Production-ready" here means: safe to invite one real class — not enterprise-grade.*
*Companion to AAIS-Technical-Review-Report (Section G). Track status in AAIS-Issues-Backlog-Tracker.xlsx → "Readiness Checklist" sheet.*

Codex implementation progress is tracked separately in `20260709-AAIS-Advisory-Implementation-Status.md`. Keep this checklist conservative: only check an item when the full acceptance condition is proven, including live provider or owner evidence where required.

## Security

- [x] Built-in demo credentials (`Bobie`/`Phoebe`) disabled in production — live proof on 2026-07-09 10:01 HKT: `https://aais-six.vercel.app` retired learner-password POSTs for both accounts returned `401` / `AAIS_INVALID_CREDENTIALS` with no `aais_session` or `aais_csrf` cookies
- [ ] All API keys/passwords rotated after removing `All API Keys.docx`; secrets only in Vercel env + password manager
- [ ] Individual accounts for every human (no shared teacher/admin credentials)
- [x] Durable login rate limiting verified across serverless invocations — production migration report `technical-review/aais-postgres-migrations-production-20260709.json` applied `0002_login_rate_limits`; live alias smoke on 2026-07-09 10:02 HKT returned `401` for attempts 1-5 and `429` / `AAIS_LOGIN_RATE_LIMITED` with `retry-after: 900` on attempt 6
- [x] Readiness/diagnostics endpoints require auth beyond bare status — source proof: `tests/readiness-route.test.ts`
- [x] Dependency audit (`npm audit` / Dependabot) clean of critical vulnerabilities in CI — source proof: `.github/workflows/ci.yml`, `.github/dependabot.yml`, `tests/ci-workflow.test.mjs`; current local audit proof: `technical-review/aais-dependency-audit-20260709.json` reports 0 high and 0 critical vulnerabilities

## Data

- [x] Migration tool in place; zero runtime DDL — source proof: `scripts/run-postgres-migrations.mjs`, `migrations/postgres/`, `tests/postgres-migrations.test.mjs`, `tests/aais-backend-store.test.ts`
- [x] Concurrent-write safety proven by a test (two parallel saves, nothing lost) — source proof: `tests/aais-backend-store.test.ts`
- [ ] Nightly snapshot or PITR confirmed on the Neon plan **in writing**
- [ ] Restore rehearsed end-to-end quarterly (documented, under 1 hour)
- [x] Per-user data export and deletion implemented and tested — source proof: `src/app/api/learning/privacy/`, `tests/aais-privacy-route.test.ts`

## Deployment

- [ ] Deploys only from Git (`main`) via CI; laptop deploys disabled — private GitHub repo `https://github.com/HUDongpin/AAIS` exists and commit `c3f5261` is on remote `main`; local source guard exists in `vercel.json`, `scripts/guard-vercel-production-deploy.mjs`, and `tests/vercel-production-deploy-guard.test.mjs`; protected `main` is blocked by GitHub's private-repo plan limit until GitHub Pro or public visibility is available; Vercel Git integration and provider-side direct-deploy lockout still require owner/provider proof
- [ ] Staging environment with seeded data; every change staged first
- [ ] One-step rollback documented and rehearsed (Vercel redeploy + snapshot)
- [x] Environment variables documented in `.env.example` for local/staging/prod — source proof: `.env.example`

## Testing

- [ ] CI gate: lint + type-check + unit + build on every PR
- [ ] Playwright E2E on the 3 core flows (login, learn+save, dashboard) against preview deploys
- [x] A regression test exists for every Critical/High issue fixed locally — source proof: `technical-review/AAIS-Critical-High-Regression-Coverage.md`, `tests/auth-route.test.ts`, `tests/aais-backend-store.test.ts`, `tests/postgres-migrations.test.mjs`, `tests/aais-users.test.ts`, `tests/auth-users-route.test.ts`, `tests/login-page.test.tsx`, `tests/admin-users-page.test.tsx`, `tests/learning-page-architecture.test.ts`, `tests/teacher-dashboard-page.test.tsx`, `tests/privacy-governance-docs.test.ts`, `tests/aais-privacy-route.test.ts`

## Monitoring

- [ ] Sentry receiving client + server errors, with alerts reaching a named human — source proof exists in Sentry wiring and readiness checks; provider evidence pending for `SENTRY_DSN` / `NEXT_PUBLIC_SENTRY_DSN` and `AAIS_SENTRY_ALERTS_CONFIGURED=true`
- [ ] Uptime check on `/login` and a cron-failure alert — readiness now requires `AAIS_UPTIME_LOGIN_CHECK_URL`, `CRON_SECRET`, and `AAIS_CRON_FAILURE_ALERTS_CONFIGURED=true`; external monitor/alert proof pending
- [ ] Weekly 15-minute dashboard review owned by a named person

## Documentation

- [x] README ≤ 1 page: what it is, run locally, deploy — source proof: `README.md`, `tests/documentation-readme.test.ts`
- [x] ARCHITECTURE.md with the real diagram and the deliberate "not yet" list — source proof: `ARCHITECTURE.md`, `tests/documentation-architecture.test.ts`
- [x] OPERATIONS.md: deploy, rollback, restore, incident basics — source proof: `OPERATIONS.md`
- [x] CONTRIBUTING.md: branch, PR, and review rules — source proof: `CONTRIBUTING.md`

## User experience

- [x] Loading and error states on every async action (especially the AI guide) — full client async-action audit and source proof: `technical-review/AAIS-Async-Action-Audit.md`, `tests/login-page.test.tsx`, `tests/learning-components.test.tsx`, `tests/learning-page.test.tsx`, `tests/teacher-dashboard-page.test.tsx`, `tests/admin-users-page.test.tsx`
- [x] AI fallback/template responses visibly labeled — source proof: `tests/e2e/ai-guide.spec.ts`
- [ ] Keyboard + screen-reader pass on the 3 core screens; contrast fixes — keyboard, named-landmark, and browser contrast proof: `tests/e2e/core-accessibility.spec.ts`, `tests/login-page.test.tsx`, `tests/learning-page.test.tsx`, `tests/teacher-dashboard-page.test.tsx`; manual screen-reader spot check pending
- [x] Stated mobile policy (supported, or a graceful "use a larger screen" message) — source proof: `README.md`, `OPERATIONS.md`, `tests/responsive-policy-docs.test.ts`

---

**Gate rule:** no real student cohort onboards until every Security and Data item is checked, plus the privacy baseline from the report (data inventory, retention policy, consent flow, Neon/LRS DPAs — Report §D Month 3 / ISS-16).
