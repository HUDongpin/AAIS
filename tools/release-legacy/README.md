# Legacy Release Evidence Archive

This folder keeps the pre-July-2026 enterprise release evidence tooling for reference. The technical advisory accepted on 2026-07-09 recommended archiving this machinery because it was larger than the product surface and was not the normal release gate.

The active project now uses:

- `npm run ci` for lint, type-check, unit tests, and build.
- `npm run e2e` for Playwright user-flow checks.
- `npm run db:migrate` for tracked Postgres migrations.
- `npm run smoke:prod` for a minimal deployed smoke check.

The archived scripts and tests are intentionally excluded from Vitest and from `package.json` scripts. If one is needed for forensic comparison, run it directly from this folder and review it before use; the code is not part of the supported product CI surface.
