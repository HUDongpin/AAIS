# AAIS

AAIS is a focused Cognitive Apprenticeship learning system with a learner cockpit at `/learning`, a teacher/admin cohort dashboard at `/dashboard`, and an admin account console at `/admin/users`.

The product agents are `A1` Guide, `A2` Expert, `A3` Supervision, and `A4` Reflection. The shared CA background lives in `src/data/aais.ts` as `aaisCognitiveApprenticeshipBackground` and must be passed into every A1-A4 model turn.

## Run Locally

AAIS uses Node.js 24.x (see `.nvmrc`) and npm 11.x. Install dependencies with
`npm ci`; `.npmrc` enables strict peer-dependency checks so incompatible
dependency updates fail during installation instead of reaching deployment.

```bash
npm ci
cp .env.example .env.local
npm run dev
```

Open `http://localhost:3000/login`. Local development can use built-in learner accounts; production excludes them.

Local file storage uses `.aais-data/` when no Postgres URL is configured. Production requires Postgres migrations through `npm run db:migrate`; request handlers must not create or alter tables at runtime.

## Verify

```bash
npm run ci
npm run e2e
npm run hygiene:check
git diff --check
```

`npm run ci` covers lint, TypeScript, unit tests, and build. `npm run e2e` covers login, learner persistence, AI fallback labeling, dashboard access/export, and a 390px phone-width learner cockpit smoke. Teacher/admin operational routes are supported for tablet and desktop review.

`npm run hygiene:check` is redacted: it checks remotes, dirty state, staged private paths, and local private artifacts such as `.env*`, `output/`, and `All API Keys.docx` without reading secret values.

## Deploy

AAIS should deploy from reviewed Git changes through Vercel, not from a laptop-only release path.

1. Merge a reviewed PR to `main`.
2. Let Vercel create the preview or production deployment.
3. Run the preview E2E workflow or `AAIS_E2E_BASE_URL=<url> npm run e2e`.
4. Run `npm run smoke:prod` against staging first, then production.
5. Before a real cohort pilot, run `npm run load:staging` against staging/preview with dedicated student accounts.

Production Vercel builds run `scripts/guard-vercel-production-deploy.mjs`, which requires Git metadata for `main` and fails local-style production uploads without it.

Production trial accounts are learner-only smoke accounts. Teacher/admin access must use database users or OIDC identities.

## Data And Privacy

Database commands:

```bash
npm run db:migrate
npm run db:backfill -- --dry-run
npm run db:seed-users -- --approved
npm run db:cleanup -- --dry-run
npm run verify:postgres-restore -- --env-file ./.env.postgres-restore.local
```

Login requires explicit terms/privacy/guardian-consent acknowledgement. Signed-in learners can export and delete their learning data through `/api/learning/privacy`; account lifecycle remains administrator-owned.

The privacy baseline, retention notes, processor/DPA register, and consent/minor-user gate are in [docs/privacy-data-inventory.md](./docs/privacy-data-inventory.md). No real cohort should onboard until cohort age/region/institution, legal basis, retention schedule, consent workflow, and provider DPA/data-region terms are confirmed.

## Docs

- [ARCHITECTURE.md](./ARCHITECTURE.md): current system shape and deliberate not-yet list.
- [OPERATIONS.md](./OPERATIONS.md): deploy, smoke, migration, rollback, restore, monitoring, and staging load sanity.
- [CONTRIBUTING.md](./CONTRIBUTING.md): branch, review, verification, database, and secret rules.
- [docs/release-checklist.md](./docs/release-checklist.md): one-page release checklist.
- [docs/teacher-recommendation-rules.md](./docs/teacher-recommendation-rules.md): teacher-facing recommendation policy.

Legacy enterprise evidence scripts are archived under `tools/release-legacy/` and are not part of active CI.
