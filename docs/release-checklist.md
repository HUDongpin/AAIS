# AAIS Release Checklist

Use this checklist for staging and production releases.

## Before Merge

- [ ] `npm run ci` passes.
- [ ] `npm run e2e` passes.
- [ ] `npm run hygiene:check` passes with a configured Git remote, clean worktree, and no staged private artifacts.
- [ ] `git diff --check` passes.
- [ ] Dependency audit is clean in CI and Dependabot alerts are reviewed.
- [ ] Database changes have migrations in `migrations/postgres/`.
- [ ] No secrets, cookies, database URLs, or generated private reports are staged.
- [ ] Vercel production deploys are Git-connected to `main`; direct laptop production deploy permissions/tokens are disabled outside the repo.

## Staging

- [ ] Vercel preview or staging deployment is ready.
- [ ] Preview deployment Playwright workflow passed, or a staging `AAIS_E2E_BASE_URL=... npm run e2e` run passed with dedicated smoke accounts.
- [ ] Sentry env vars are present in staging when monitoring changes are being released.
- [ ] Staging Postgres migrations have been applied.
- [ ] Dedicated staging database users are seeded or verified with `npm run db:seed-users`, `/admin/users`, or OIDC mapping; no teacher/admin trial accounts are used.
- [ ] Restored-branch verification passed with `npm run verify:postgres-restore`.
- [ ] Privacy inventory and retention/processor/consent gates in `docs/privacy-data-inventory.md` are reviewed for any release that touches learner data, auth, LRS, monitoring, or providers.
- [ ] Production smoke proves Bobie and Phoebe or a dedicated learner can sign in and the distinct `retired-demo-account` credential is rejected without a session cookie.
- [ ] Before a real cohort pilot, `npm run load:staging -- --approved --target-users 200 --concurrency 200` passes against staging/preview with dedicated student accounts.
- [ ] Any changed learner/dashboard flow was manually checked once.
- [ ] Responsive policy reviewed: login and learner cockpit pass the phone-width E2E smoke; teacher/admin operational routes are checked on tablet/desktop.
- [ ] If monitoring changed, a staging test client error and server/API error appear in Sentry with redacted details.

## Production

- [ ] Owner approves the release window.
- [ ] For any real cohort, owner has confirmed cohort age/region/institution, legal basis, retention values, consent flow, and Vercel/Neon/LRS/provider DPA plus data-region evidence.
- [ ] Production migrations, if any, are applied during the release window.
- [ ] Vercel production deployment is ready from the Git-connected `main` flow; `scripts/guard-vercel-production-deploy.mjs` passes in the Vercel build log.
- [ ] Production smoke proves Bobie and Phoebe or a dedicated learner can sign in and the distinct `retired-demo-account` credential is rejected without a session cookie.
- [ ] Rollback target is known.

## After Release

- [ ] Check Sentry issues, request errors, and Cron monitor status, or confirm the fallback error-log review.
- [ ] Check LRS outbox health.
- [ ] Record deployment URL, commit SHA, migration versions, and smoke result.
