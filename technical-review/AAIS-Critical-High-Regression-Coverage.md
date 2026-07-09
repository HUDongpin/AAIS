# AAIS Critical/High Regression Coverage

Status date: 2026-07-09 HKT

Scope: Critical and High issues from `AAIS-Technical-Review-Report.md` that have been fixed or partially fixed in the repository. This audit does not claim completion for owner/provider actions such as credential rotation, private GitHub protection, Vercel Git integration, live staging, Neon written backup confirmation, DPA evidence, or issued human accounts.

## Covered Fixed Items

| Advisory issue | Local fix scope | Regression evidence |
| --- | --- | --- |
| ISS-01 / T-02 hardcoded demo accounts in production | Built-in learner demo accounts are excluded in production, production without configured accounts fails closed, and login stays closed when durable rate-limit storage is unavailable. | `tests/auth-route.test.ts` covers production built-in rejection, fail-closed production auth, rate-limit-storage outage response, disabled trial-login mode, and redacted auth audit behavior. |
| ISS-04 / T-08 learner-session concurrent writes | Learner session writes use versioned/conflict-aware storage and parallel saves preserve data. | `tests/aais-backend-store.test.ts` covers concurrent write safety, artifact/event preservation, and conflict behavior. |
| ISS-05 / T-09 runtime DDL and migration baseline | Postgres schema is represented as migrations, runtime routes no longer own schema creation, and the migration CLI can use Neon's HTTP transaction path for live production migrations. | `tests/postgres-migrations.test.mjs` validates migration loading/application/checksums, non-interactive transaction clients, and safe statement splitting; `tests/aais-backend-store.test.ts` validates store behavior against the migrated schema. |
| ISS-08 / T-15 real user model, invites, registration, reset, admin users | User table, auth-token storage, invite/set-password/reset route, and admin user-management UI exist with redacted responses. | `tests/aais-users.test.ts`, `tests/auth-users-route.test.ts`, `tests/login-page.test.tsx`, and `tests/admin-users-page.test.tsx` cover invite, password reset, access updates, redaction, and UI states. |
| ISS-09 / T-18 learning-page frontend monolith | Learning cockpit behavior is split across typed helpers, hooks, panels, and component tests while preserving the `/learning` flow. | `tests/learning-page-architecture.test.ts`, `tests/learning-components.test.tsx`, `tests/learning-session-client.test.ts`, and `tests/learning-page.test.tsx` cover decomposition boundaries and preserved behavior. |
| ISS-15 / T-20 cohort analytics scale | Cohort analytics uses SQL-style event/task-state aggregates with pagination instead of scanning every raw learner blob for dashboard rows. | `tests/aais-backend-store.test.ts` covers SQL cohort analytics, 500 simulated learners, pagination, and pseudonymous export; `tests/teacher-dashboard-page.test.tsx` covers dashboard pagination/export behavior. |
| ISS-16 privacy baseline local controls | Code-level data inventory, consent acknowledgement, learner export/delete, retention cleanup, and legal-page copy exist. | `tests/privacy-governance-docs.test.ts`, `tests/aais-privacy-route.test.ts`, `tests/aais-retention-cleanup.test.mjs`, `tests/legal-pages.test.tsx`, `tests/auth-route.test.ts`, and `tests/login-page.test.tsx` cover the source-proven privacy baseline. |

## Still Not Claimed By This Audit

- ISS-02 / T-03 private GitHub remote, protected `main`, green provider-side CI, and Vercel Git deploy flow.
- ISS-03 / T-01 real credential rotation, password-manager migration, and owner-approved deletion of local plaintext credential files.
- ISS-05 / T-06 real staging URL and Neon branch smoke proof.
- ISS-05 / T-07 written Neon backup/PITR confirmation and restored-branch timing.
- ISS-08 / T-16 issuing every human an individual production credential and retiring old shared/break-glass access.
- ISS-16 provider/institution privacy evidence: cohort age/region/legal basis, retention schedule, consent workflow, DPAs, subprocessors, and data-region confirmations.

Those items remain open in `AAIS-Production-Readiness-Checklist.md` because their acceptance evidence must come from owner/provider or live-environment state, not from local source tests alone.
