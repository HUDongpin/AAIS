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

Production Qwen uses a dated immutable snapshot and a signed, source-bound A1-A4 bilingual evaluation. The operator workflow is `npm run release:evaluate-ai` followed by `npm run release:sign-ai-manifest`; exact arguments, trust variables, redaction rules, and expiry behavior are documented in [OPERATIONS.md](./OPERATIONS.md#ai-guide-runtime).

## Deploy

This branch chooses a new, empty PostgreSQL 17 database on the existing Hong Kong
ECS. It neither copies nor deletes Neon data; Neon remains a retained rollback
reference, Vercel is not a writer, and no billable resource is added before cost approval.

1. Follow [the empty-PostgreSQL runbook](./docs/aliyun-postgres-empty-runbook.md): verify
   the exact ECS, install PostgreSQL 17, create an actually empty `aais` database,
   disable public TCP, and expose only the protected Unix socket.
2. Open the temporary `aais_migrator` window, apply the full ledger (including
   0028/0029), close it, create only the documented `aais_app_aliyun` allowlist role,
   and bind a new target ID.
3. Generate the root-owned bundle with `AAIS_DATABASE_DRIVER=pg`,
   `AAIS_DATABASE_PROVIDER=aliyun-postgres`, `AAIS_DATABASE_TRANSPORT=unix`, and
   the socket-bound URL. After local/ECS readiness evidence, the Owner may use the
   exact-digest Private GHCR preload and blue/green wrapper; no credential enters receipts.

The old [Neon warm-backup runbook](./docs/aliyun-primary-runbook.md) is frozen historical
material, not an activation procedure; a build, `READY`, HTTP 200, screenshot or DB
initialization alone does not prove production cutover.

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

The general privacy baseline, processor/DPA register, and consent/minor-user gate are in [docs/privacy-data-inventory.md](./docs/privacy-data-inventory.md). No real cohort should onboard until cohort age/region/institution, legal basis, consent workflow, provider DPA/data-region terms, and any non-research retention requirements are confirmed.

The named research study is limited to 30 participants and one visit each. Its exact Postgres-only data contract, raw-text boundary, access rules, 90/180/1825/35-day retention schedule, backup/restore controls, and withdrawal/LRS physical-deletion SOP are in [docs/research-data-governance.md](./docs/research-data-governance.md). Enable it only with `AAIS_RESEARCH_MODE=true`, `AAIS_RESEARCH_REQUIRED=true`, and a dedicated `AAIS_RESEARCH_DATABASE_URL`; apply the isolated fact-store schema with `npm run db:migrate:research`. Either research sentinel disables the legacy product event/LRS mirror and generic analytics/event exports so a stale `LRS_ENDPOINT` cannot receive study activity. Research mode must fail closed when Postgres or required study configuration is unavailable. New experiment statements use a clean, physically isolated, AAIS-only research store; the existing mixed 828-statement AAIS/MAIS pool is a legacy archive and is excluded from new-study queries, exports, and counts.

`npm run study:rehearse -- --participants 4 --output ./aais-research-rehearsal.json` runs exactly seven metadata-only semantic operations for each of 3-5 synthetic participants against migrated Postgres, then compares operation, Postgres-event, LRS-eligible outbox, and mock statement-id sets. It rolls back by default; `--commit` requires `AAIS_RESEARCH_REHEARSAL_APPROVED=true` and `AAIS_RESEARCH_ENVIRONMENT=research`. The command does not perform actual external LRS delivery or replace actual-UI browser evidence. Clean-store launch still requires an external provider receipt for isolation, zero baseline, delivery reconciliation, and physical deletion.

For an adult, low-risk, mainland-China-only internal CAAIS test, `npm run study:prepare-mainland-test -- --participants 5 --output output/restricted-study-operations/<run-id>` creates a permission-restricted test profile and six lightweight governance drafts. `npm run study:run-mainland-test-lrs -- --env-file output/restricted-study-operations/<run-id>/secrets.env --output output/restricted-study-operations/<run-id>/lrs-drill-evidence.json` then exercises four loopback-only in-memory stores. The generated environment explicitly clears inherited live-provider, monitoring, worker, and formal-receipt settings so the test profile remains fail-closed. This local profile is a rehearsal substitute only: its internal Ed25519 receipt is not provider attestation, and it deliberately leaves formal `studyLaunchReady` false. See [docs/mainland-caa-is-test-profile.md](./docs/mainland-caa-is-test-profile.md).

`npm run lrs:archive-legacy -- --expected-count 828 --stored-through <owner-approved-inclusive-provider-stored-ISO>` inventories that old pool only with read-only `AAIS_LEGACY_LRS_ENDPOINT`, `AAIS_LEGACY_LRS_USERNAME`, and `AAIS_LEGACY_LRS_PASSWORD`. The cutoff freezes the historical set by provider `stored` time and reports any later AAIS rows separately. A valid restricted receipt contains statement ids, content SHA-256 digests, and counts but no statement bodies; the selected historical set must equal exactly 828. The command's presence does not mean the external pool has actually been accessed.

Formal visit creation and event ingestion are runtime-gated by the approved access register, distinct research worker credentials and POST schedules, dedicated research LRS configuration, and pairwise-distinct SHA-256 receipts for database/LRS isolation, zero baseline, PUT/physical-DELETE behavior, backup policy, restore, the 828-row legacy archive, the signed access register, consent/legal basis, DPA, data region, successful daily backup, and 35-day backup destruction. A separately signed governance manifest must be verified within 36 hours, its validity window must remain open, the daily-backup evidence must be no older than 36 hours, and the destruction evidence must be no older than 45 days. `/api/system/readiness` reports ordinary `applicationReady` separately from `studyLaunchReady`; only `studyLaunchReady=true` authorizes the 30-participant run.

## Docs

- [ARCHITECTURE.md](./ARCHITECTURE.md): current system shape and deliberate not-yet list.
- [OPERATIONS.md](./OPERATIONS.md): deploy, smoke, migration, rollback, restore, monitoring, and staging load sanity.
- [CONTRIBUTING.md](./CONTRIBUTING.md): branch, review, verification, database, and secret rules.
- [docs/release-checklist.md](./docs/release-checklist.md): one-page release checklist.
- [docs/aliyun-postgres-empty-runbook.md](./docs/aliyun-postgres-empty-runbook.md): selected self-managed PostgreSQL 17 empty-database topology, socket binding, migration window, least-privilege roles, backup/restore and cost gates.
- [docs/aliyun-primary-runbook.md](./docs/aliyun-primary-runbook.md): frozen historical Neon warm-backup path; it is not the activation procedure for the empty-database candidate.
- [docs/research-data-governance.md](./docs/research-data-governance.md): enforceable research event, identity, access, retention, backup, export, and withdrawal contract.
- [docs/mainland-caa-is-test-profile.md](./docs/mainland-caa-is-test-profile.md): lightweight adult, low-risk, mainland-only CAAIS rehearsal profile and its evidence limits.
- [docs/teacher-recommendation-rules.md](./docs/teacher-recommendation-rules.md): teacher-facing recommendation policy.

Legacy enterprise evidence scripts are archived under `tools/release-legacy/` and are not part of active CI.
