# AAIS Codex Verification Report

Verification completed: 2026-07-08 23:09:50 HKT

Scope: `technical-review/` materials for the AAIS proof-of-concept deployed through Vercel. Codex read the Markdown checklist, advisory Markdown, advisory DOCX, and workbook; rendered the DOCX and workbook previews; checked current local source evidence; ran local quality gates; and smoke-tested the public Vercel production alias. No credential values were read, printed, copied, or logged.

## Executive Finding

The existing technical-review materials are directionally correct and materially useful. The main risk story is confirmed: public demo credentials remain usable on the deployed production alias, there is no git remote, a credential-bearing `All API Keys.docx` remains in the repo folder, learner state is still stored as one JSONB blob per learner, no migration framework or staging workflow is evident, and the release-evidence system is larger than the product and not controlling production release.

Codex made targeted corrections in the advisory DOCX rather than replacing the report wholesale. The important corrections are: AAIS currently has 11 API route handlers, not approximately 10; `learning-page.tsx` currently has 20 `useState` calls, not 21; production without configured trial-account env fails closed, but the configured production deployment merges built-in learner accounts and still allows the known demo login; and the archived release gate is failed, but not literally every subcheck is false.

## Materials Read

- `technical-review/AAIS-Technical-Review-Report.md`
- `technical-review/AAIS-Technical-Review-Report.docx`
- `technical-review/AAIS-Production-Readiness-Checklist.md`
- `technical-review/AAIS-Issues-Backlog-Tracker.xlsx`

## Fresh Verification Performed

- Rendered `AAIS-Technical-Review-Report.docx` to 17 page PNGs with LibreOffice through the bundled document renderer. Layout is usable; the major-issues table is dense but not broken.
- Imported `AAIS-Issues-Backlog-Tracker.xlsx` with the bundled spreadsheet artifact library. Workbook has 5 sheets and 5 table regions. Formula values report 22 issues, 22 open issues, 22 tickets, and 29 readiness checklist items.
- Rendered workbook previews. Caveat: the Summary preview showed stale-looking `0` subtotal values for some formula rows while direct workbook formula evaluation returned the correct counts. The workbook logic is correct; the rendered preview/cache should be refreshed in Excel/LibreOffice before external circulation.
- Ran `npm run ci`: lint passed, type-check passed, Vitest passed with 43 test files and 375 tests, and `next build` completed successfully.
- Ran `npm audit --audit-level=critical --json`: 0 critical, high, moderate, low, and info vulnerabilities reported.
- Checked live alias `https://aais-six.vercel.app/api/system/readiness`: HTTP 200, `status: ready`, storage `postgres`/`neon`, trial accounts configured with account count 4, LRS outbox persistent on Postgres, and AI runtime live with maxTokens 180 and maxRetries 0.
- Checked `https://aais-six.vercel.app/api/learning/lrs/health`: HTTP 200, `status: connected`.
- Checked known demo login against `https://aais-six.vercel.app/api/auth/app-session`: `Bobie` with the known demo password returned HTTP 200, set an `aais_session` cookie, and redirected to `/learning`.
- Attempted `https://www.aais.site` from this machine. Local DNS returned `ENOTFOUND`, so production behavior was verified through the Vercel alias rather than the custom domain.

## Confirmed High-Risk Findings

1. Public demo access is a real production issue. `src/lib/server/aais-trial-accounts.ts` defines built-in learner accounts and merges them into configured trial accounts. Live alias authentication confirms the known demo credential still works.
2. No git remote is configured. `git remote -v` returned no remotes, and the current branch is `codex/aais-enterprise-standard`.
3. `All API Keys.docx` is present at the repo root. Codex verified file presence only and did not inspect credential contents.
4. Learner state is persisted as whole-session JSONB in `aais_learner_sessions`, with read-modify-write upsert and no version/locking column.
5. Runtime DDL still exists through `CREATE TABLE IF NOT EXISTS` for `aais_learner_sessions` and `aais_lrs_outbox`; no migration framework dependency was found.
6. Login rate limiting is module-local `Map` state, which is not durable across serverless instances.
7. `/api/system/readiness` anonymously exposes a detailed report including release id, deployment git short SHA, storage provider, trial-account count, LRS outbox metrics, OIDC mode, and AI runtime metadata.
8. `@langchain/langgraph` is in dependencies and runtime labels still say `langgraph`, but no source import of LangGraph exists; orchestration is implemented with `Promise.all`.
9. A3/A4 use deterministic provider paths; live AI profile reports 180 max tokens and 0 retries.
10. SSE guide streaming sends acknowledgement/start events, then awaits the full guide graph before replaying deltas.
11. No Playwright end-to-end specs were found in the repo.
12. Observability is limited to Vercel Analytics plus structured logs. No Sentry or equivalent error tracker was found.

## Confirmed Strengths

- Session cookies are HMAC-signed, HttpOnly, SameSite=Lax, 8-hour TTL, and Secure in production.
- Mutating learning routes enforce actor-bound signed CSRF tokens.
- Learning APIs derive the student identity from the signed session rather than client-supplied `studentId`.
- Teacher/admin cohort analytics and cohort export are role gated.
- Cohort analytics uses pseudonymous learner/session keys and excludes raw learner text.
- CSV export escapes formula-like fields defensively.
- LRS integration uses a persistent Postgres outbox with metrics, coalescing, and dead-letter requeue support.
- Current local `npm run ci` is green.
- Current critical dependency audit is clean.

## Corrections Applied To The Advisory DOCX

- Changed attribution from Claude to Codex independent verification.
- Added the actual verification method and alias/DNS limitation.
- Replaced approximate `~10 API routes` with 11 API route handlers.
- Replaced the overbroad "always merged into production" phrasing with the verified configured-production nuance.
- Replaced "failed on all five steps" with a more precise failed-gate description.
- Updated the frontend monolith count from 21 to 20 `useState` calls.
- Clarified that Codex verified the credential file's presence only, without reading or printing secrets.
- Added current CI, audit, readiness, LRS, and production-login evidence.

## Not Independently Verified

- Actual Vercel environment variable values or secret strength.
- Whether all provider keys in `All API Keys.docx` are still live.
- Neon plan tier, PITR/snapshot guarantees, and restore capability.
- LRS operator, region, and data-processing agreement status.
- Whether real students or minors have used production.
- Custom domain reachability from networks other than this machine.

## Deliverable Status

- Codex verification report: this file.
- Tracked advisory report: `20260709-AAIS-Technical-Advisory-Report-Codex-Tracked.docx`.
- Clean accepted advisory report: `20260708-AAIS-Technical-Advisory-Report-Codex-Clean.docx`.
