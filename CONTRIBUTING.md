# Contributing

## Branches

Use short feature branches. In Codex-managed work, prefer the `codex/` prefix unless the owner asks for another branch name.

## Change Scope

Keep changes close to the advisory ticket or bug being fixed. Avoid broad rewrites while the worktree contains unrelated local changes.

Do not revert someone else's dirty work unless the owner explicitly asks.

## Verification

Before handing off code, run:

```bash
npm run type-check
npm run lint
npm test
npm run build
npm run e2e
npm run hygiene:check
git diff --check
```

Use focused tests first while developing, then run the full set before completion.

`npm run hygiene:check` is a redacted source-control and private-artifact preflight. It does not read credential values, but it must pass before merge/release: Git remotes must be configured, the worktree must be clean, and `.env*`, `output/`, or `All API Keys.docx` must not be staged.

Preview deployments are checked by `.github/workflows/preview-e2e.yml` after Vercel emits a successful `Preview` `deployment_status`. Keep the GitHub Actions `AAIS_E2E_*` secrets aligned with the non-production Vercel trial/smoke accounts so deployed Playwright tests authenticate through the real login flow instead of local cookie seeding.

The GitHub CI workflow also runs `npm audit --audit-level=high` and `npm run hygiene:check`; Dependabot watches npm and GitHub Actions weekly so dependency updates are reviewed through normal PRs.

Production releases must be Git-triggered from `main`. `vercel.json` invokes `scripts/guard-vercel-production-deploy.mjs` before Vercel builds; do not use laptop `vercel deploy --prod` for AAIS production.

## Database Changes

All Postgres schema changes must be represented as migrations in `migrations/postgres/` and applied with:

```bash
npm run db:migrate
```

Runtime application code must not create or alter tables.

## Secrets

Never commit, print, log, screenshot, or summarize credential values. This includes `.env.local`, Vercel env vars, database URLs, cookies, LRS credentials, AI provider keys, and local credential documents.

If a task requires a missing provider credential, stop and ask the owner for it.

Local inventory runs may use `npm run hygiene:check -- --allow-dirty --allow-local-private-artifacts`, but that exception is only for diagnosing a local checkout and is not a release pass.

## Pull Requests

A good PR includes:

- The advisory ticket or bug fixed.
- User-visible behavior changes.
- Database migration notes, if any.
- Verification commands and results.
- Remaining owner/external actions, if any.
