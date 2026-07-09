# AAIS Technical Review & 3-Month Recovery Plan

**Project:** AAIS — Adaptive AI Instruction System (Cognitive Apprenticeship learning platform)
**Production:** https://www.aais.site (Vercel + Neon Postgres)
**Review date:** July 8, 2026
**Reviewed by:** Senior Software Architect / Technical Advisor (Claude)
**Audience:** Founder / project owner, current junior developer, future engineers, product stakeholders
**Sources:** Full read of the AAIS repository (src, scripts, tests, docs, configs, git history), plus a live check of the production readiness endpoint on July 8, 2026. Statements not verifiable from these sources are labeled as assumptions.

---

## A. Executive Summary

AAIS is in **better shape than the phrase "vibe-coded by a junior developer" suggests — and in worse shape than its own documentation claims.** The core application is small (4 pages, ~10 API routes, ~12k lines of TypeScript), typed strictly, and shows real security awareness: signed HttpOnly session cookies, scrypt password hashing, CSRF protection, server-derived identity, security headers, and pseudonymized analytics. That is a genuinely solid foundation for a proof of concept.

The problem is **where the effort went, and what got skipped.** Roughly half the repository is an elaborate "enterprise release evidence" pipeline (22 scripts, ~20 test files, a 64KB README of ceremony commands) that fails its own gate — the last release check on July 1 reports `"status": "failed"` on all five steps, yet production ships anyway. Meanwhile, fundamentals a real product needs are missing:

1. **Anyone in the world can log into production.** The demo accounts `Bobie`/`Phoebe` with password `12345` are hardcoded in the source and are *always merged into the production account list*. These credentials are effectively public.
2. **The source code exists only on one laptop.** The git repository has **no remote** — no GitHub, no backup, one branch. The CI workflow in the repo has never run, because there is nothing for it to run on. A stolen or failed laptop loses the project's history.
3. **A Word file named "All API Keys.docx" sits in the project folder** containing real API keys and passwords (DeepSeek, SimpleTex, Mathpix, Resend, and more), and the project's own `agents.md` instructs AI coding tools to work alongside it.
4. **Learner data is stored as one big JSON blob per student**, rewritten in full on every click. Two simultaneous writes (autosave + AI chat, or two tabs) silently overwrite each other. There is no schema migration tooling, no staging environment, and analytics loads every student's entire history into memory.
5. **The "multi-agent adaptive AI" is partly theater.** LangGraph is claimed in the README, the code labels, and a dependency — but is never imported. Two of the four "agents" (A3, A4) always return canned template text. Live AI replies are capped at 180 tokens with zero retries.

**Biggest risks (next 90 days):** unauthorized access via the public demo credentials; total loss of source history; leaked API keys; silent learner-data loss under concurrent writes; and a schema that cannot support courses, classes, or real accounts without rework.

**Top priorities:** (1) lock down credentials and access this week; (2) get the code into a remote repo with working CI and a staging environment; (3) replace the blob storage with a small relational model (users, events) before adding features; (4) delete or archive the release-ceremony machinery and redirect that energy into tests for real user flows; (5) build the honest minimal version of adaptive learning on top of the event data that is already well designed.

**Verdict (detailed in Section J): keep the codebase, partially refactor.** Do not rebuild. The core server code is worth keeping; the data layer and frontend monolith need staged refactoring; the release-evidence pipeline should be archived, not maintained.

---

## B. Current System Assessment

### B.1 What is actually deployed

| Layer | Current state (verified) |
|---|---|
| Frontend | Next.js 16 (App Router) + React 19 + TypeScript (strict) + Tailwind CSS v4. Four routes: `/login`, `/learning`, `/dashboard` (teacher/admin), `/terms` + `/privacy`. Root `/` redirects to `/login`. |
| Backend | Next.js API routes on Vercel serverless. ~10 endpoints under `/api/auth/*`, `/api/learning/*`, `/api/system/readiness`. No separate backend service. |
| Database | Neon Postgres (verified live: `storage.mode=postgres, provider=neon`). **Two tables only**: `aais_learner_sessions` (one JSONB blob per student) and `aais_lrs_outbox` (event delivery queue). Tables are created at runtime via `CREATE TABLE IF NOT EXISTS` — no migration tool. Local dev falls back to JSON files in `.aais-data/`. |
| Authentication | Custom HMAC-SHA256-signed session cookie (8h TTL, HttpOnly, SameSite=Lax, Secure in prod). "Trial accounts" defined in env JSON with scrypt-hashed passwords — plus two hardcoded built-in accounts. OIDC/SSO code exists (PKCE, JWKS validation) but is **not configured in production** (verified: `oidc.mode: "missing"`). |
| Roles | `student`, `teacher`, `admin` in the session token. Page- and API-level gating exists and is correctly enforced for `/dashboard` and cohort analytics/export. |
| AI | OpenAI-compatible HTTP provider (production model fingerprint verified live; Qwen/DashScope keys in local env, DeepSeek evaluated). Four "agents" (A1 guide, A2 expert, A3 supervision, A4 reflection) fan out in parallel; A3/A4 always use a deterministic template provider. Guardrails: length cap + secret-pattern block. Deterministic fallback text if the provider fails. |
| Learning record store (LRS) | xAPI-style event mirroring to an external LRS over HTTP Basic auth, via a persistent outbox with retry/dead-letter and a daily Vercel cron flush. |
| Hosting/deploy | Vercel, deployed **manually from the developer's laptop** via `vercel deploy --prod`. No Git integration, no staging environment. Domain `www.aais.site` live. |
| Testing | Vitest, 44 test files. Roughly half test the release-evidence scripts rather than the product. Component tests exist for the main pages; no end-to-end browser tests in the repo. |
| Observability | `console.info` JSON audit lines (login, outbox ops) into Vercel logs; a public `/api/system/readiness` report; Vercel Analytics package. No error tracker, no alerting, no uptime monitor. |

### B.2 Development maturity

This codebase reads like an AI coding agent was driven hard toward "enterprise readiness" as a goal in itself. Evidence: a fictional 11-role team in `agents.md` (S01 "App shell lead" … S22 "Production reliability lead"); 22 release/verify/handoff scripts; a README whose "Local Verification" section is 20+ multi-hundred-character commands; release artifacts in `output/` with SHA-256 manifests — all for a product with **one hardcoded course, four tasks, and env-file user accounts.**

Maturity summary: **code quality is mid-level and consistent; product architecture is early-POC; operational practice is pre-professional** (no remote repo, no staging, manual deploys, secrets in a Word file). The single most important insight for planning: *the team's effort allocation, not its skill, is the main problem.*

### B.3 Explicit assumptions (not verifiable from the repo)

- **A1:** The only people who have used production so far are the owner/developer and a small number of testers; no real students or minors yet. (If wrong, the privacy items in Section C escalate immediately.)
- **A2:** The Vercel project and Neon database are on hobby/starter tiers without a paid support/backup contract. Neon's point-in-time restore window is assumed short (typically ~24h–7 days on lower tiers).
- **A3:** The external LRS is a third-party or university-hosted xAPI store; its data-protection status is unknown.
- **A4:** One junior developer maintains the project part-time; a senior engineer is available in an advisory capacity only.
- **A5:** The production `AAIS_SESSION_SECRET`, `CRON_SECRET`, and AI keys are set in Vercel env vars (readiness reports session "ok"; cron flush is configured). Their strength/rotation history is unknown.

---

## C. Major Issues Table

Severity: **Critical** = fix before anything else; **High** = fix within the 3-month window or block feature work; **Medium** = schedule; **Low** = opportunistic.
Effort: Small ≤ 1 dev-day equivalent; Medium ≤ 1 week; Large > 1 week. Owner suggestions assume a junior dev doing the work with senior review where marked.

| # | Issue | Severity | Evidence / symptom | Risk if ignored | Recommended fix | Effort | Owner | Priority |
|---|---|---|---|---|---|---|---|---|
| ISS-01 | Hardcoded demo accounts (`Bobie`, `Phoebe`, password `12345`) are always merged into the production account list | **Critical** | `src/lib/server/aais-trial-accounts.ts` lines 45–58 and `mergeConfiguredAccountsWithBuiltInLearners()`; login confirmed working on the live site | Strangers log in, write junk learner data, consume paid AI tokens; any future real-student data is exposed; reputational damage | Exclude built-ins outside dev (`NODE_ENV`-gate), rotate all trial passwords to strong generated ones, re-deploy, verify | Small | Junior dev | Week 1 |
| ISS-02 | No git remote; code exists only on one laptop; CI has never run | **Critical** | `git remote -v` is empty; single branch `codex/aais-enterprise-standard`; CI workflow triggers on `main`/PRs which don't exist | Laptop loss/failure = permanent loss of source history; no code review; no automated quality gate | Push to private GitHub repo, make `main` the default protected branch, connect Vercel Git integration, confirm CI goes green | Small | Junior dev | Week 1 |
| ISS-03 | Plaintext credential store `All API Keys.docx` in the project folder; sanctioned by `agents.md` | **Critical** | File present at repo root (contains `sk-` keys, service passwords: DeepSeek, SimpleTex, Mathpix, Resend, …); gitignored but synced/shared with AI tools | One sync/backup/screen-share leaks every key; provider abuse billed to owner | Move secrets to a password manager; **rotate every key in the file**; delete the file; update `agents.md` | Small | Product owner + junior dev | Week 1 |
| ISS-04 | Learner state stored as one JSONB blob per student with read-modify-write and no locking | **High** | `aais_learner_sessions(student_id PK, payload jsonb)`; `writeSession()` upserts whole blob; no version check; events array grows without bound | Concurrent autosave + AI chat (or two tabs) silently loses learner work; rows grow to MBs; analytics slows then fails | Short-term: optimistic locking (version column, retry). Month 2: move events to append-only `aais_events` table; keep a slim session snapshot | Medium | Senior engineer (design) + junior (impl) | Weeks 2–6 |
| ISS-05 | No staging environment; no schema migration tool; schema created at runtime | **High** | Only production in `.vercel/project.json`; `CREATE TABLE IF NOT EXISTS` in `aais-learning-store.ts`; restore rehearsal is manual | Every schema change is an experiment on live users; restores are untested under pressure | Create staging (Vercel preview + Neon branch); adopt a migration tool (e.g., `node-pg-migrate`); forbid runtime DDL | Medium | Junior dev with senior review | Weeks 2–4 |
| ISS-06 | Public `/api/system/readiness` discloses internals | Medium | Live fetch (2026-07-08) returned release id, deploy git SHA, storage provider, trial-account count, outbox metrics, AI timeout/token config, admin endpoint paths | Free reconnaissance for attackers; combined with ISS-01, a guided tour | Return bare `{status}` publicly; full report only with admin session or bearer token | Small | Junior dev | Weeks 1–2 |
| ISS-07 | Login rate limiting is in-memory and ineffective on serverless | Medium | `Map` in `aais-auth-rate-limit.ts`; Vercel instances don't share memory and recycle | Credential stuffing/brute force is practical, against static passwords | Move counters to Postgres or Upstash Redis; consider Vercel WAF rules | Small–Medium | Junior dev | Month 2 |
| ISS-08 | No real user model: no registration, invites, password reset, or user table | **High** | Accounts only from `AAIS_TRIAL_ACCOUNTS_JSON` env var; teachers/admins use static shared-style credentials; OIDC unconfigured | Cannot onboard a real class; password changes require a redeploy; teacher/admin compromise likely | Add `users` table + invite-based registration + password reset (Resend key already owned); or finish OIDC for teachers/admins | Large | Senior + junior | Month 2 |
| ISS-09 | Frontend monolith: `learning-page.tsx` is 2,269 lines, 21 `useState`, all flows in one client component | **High** (maintainability) | Single file holds chat, editor, tasks, attachments, autosave, export, navigation | New developers can't change one feature without risking all; untestable in isolation | Split into feature components + extract a typed API client + custom hooks; do it incrementally behind identical behavior | Medium | Junior dev with senior review | Month 2 |
| ISS-10 | Release-evidence machinery larger than the product, and failing its own gate | Medium | 22 scripts in `scripts/`, ~20 test files for them; `output/aais-enterprise-release-check-latest.json` = `failed` on all 5 steps while prod deploys anyway | Maintenance drag; false confidence for stakeholders; buries real signals; intimidates new developers | Archive to `tools/release-legacy/` (keep in history), keep one smoke script + a 1-page release checklist | Small | Junior dev | Weeks 3–4 |
| ISS-11 | LangGraph claimed but never used; runtime labels say `langgraph` | Low–Medium | `@langchain/langgraph` in dependencies, zero imports; orchestration is `Promise.all`; runtime reports `engine: aais-langgraph-runtime` | Misleads future engineers and any technical due-diligence; dead dependency | Remove the dependency and rename labels honestly (or actually adopt LangGraph when there's a real graph to run) | Small | Junior dev | Weeks 3–4 |
| ISS-12 | AI system overstates itself: A3/A4 always canned; replies capped at 180 tokens; 0 retries; silent fallback | Medium (product) | `backgroundProvider = createDeterministicAaisProvider()` in the guide graph; live readiness shows `maxTokens: 180, maxRetries: 0`; provider failure returns template text labeled as agent output | Students receive truncated or canned guidance believing it's adaptive AI; pedagogy claims can't be defended | Decide the honest scope (Section E/F); raise token budget; surface "offline guidance" state in the UI when fallback triggers | Medium | Product owner + senior | Months 2–3 |
| ISS-13 | No error tracking, alerting, or uptime monitoring | Medium | Only `console.info` audit lines + Vercel function logs; no Sentry/alerts; cron failures invisible | Production breaks are discovered by users; debugging relies on scrolling logs | Add Sentry (free tier) for both client+server, an uptime check on `/login` and readiness, and a cron-failure alert | Small | Junior dev | Weeks 1–2 |
| ISS-14 | No end-to-end tests for the three real user flows | Medium | 44 unit test files, none driving a browser; `.playwright-cli` cache exists but no specs in repo | Refactors (Months 2–3) will regress login/learning/dashboard invisibly | 6–8 Playwright specs: login (+bad password), task flow, autosave, AI guide (+fallback), dashboard, export | Medium | Junior dev | Month 2 (start Weeks 3–4) |
| ISS-15 | Cohort analytics loads every learner blob into memory per request | Medium→High at scale | `readAllSessions()` then in-memory summarize on each `/api/learning/analytics?scope=cohort` call | With a few hundred active students: multi-second dashboards, then function OOM/timeouts | After ISS-04's event table: compute aggregates in SQL; paginate learner lists | Medium | Senior engineer | Months 2–3 |
| ISS-16 | Education-privacy baseline missing (consent, retention, deletion, data inventory, processor agreements) | **High** (gates real users) | `/privacy` text exists, but no per-user export/delete, no retention policy, unknown Neon/LRS data-processing terms; minors likely audience | Legal exposure (FERPA/COPPA/GDPR/PIPL depending on region); a school pilot will ask and there's no answer | Data inventory; retention policy; per-user export+delete endpoint; consent flow for minors; confirm Neon/LRS DPAs and regions | Medium | Product owner + senior | Month 3 (before any real cohort) |
| ISS-17 | Sessions not revocable server-side; logout only clears the cookie | Low–Medium | Stateless HMAC token valid for 8h regardless; no denylist | A leaked token stays valid up to 8h even after "logout" | Accept short-term; later add a session-id + denylist or DB-backed sessions | Small | Senior | Month 3 |
| ISS-18 | CSP permits `unsafe-inline` and `unsafe-eval` | Low | `next.config.ts` headers | XSS mitigations weakened | Move to nonce-based CSP; drop `unsafe-eval` in production builds | Small | Senior | Month 3 |
| ISS-19 | Accessibility and responsiveness gaps | Medium (UX) | 1 media query in 120-line `globals.css`; aria attributes: learning 51, login 4, dashboard 1; desktop-oriented workspace | Unusable for phone-first students; excludes assistive-tech users; school accessibility requirements unmet | Audit with axe + keyboard pass; fix top violations; define a mobile behavior (even if "tablet+ only", state it) | Medium | Designer + junior dev | Month 3 |
| ISS-20 | Documentation unusable for onboarding; README is 64KB of release commands | Medium | `README.md` (274 lines, very long lines); no setup guide, no architecture overview, no CONTRIBUTING | Every new engineer burns days; knowledge stays in one head | Rewrite docs set: README (what/run/deploy in 1 page), ARCHITECTURE.md, OPERATIONS.md, CONTRIBUTING.md | Small | Junior dev | Weeks 3–4 |
| ISS-21 | Fake streaming: SSE endpoint buffers the whole AI response, then replays it | Medium (UX) | `createGuideStreamResponse()` awaits the full graph, then emits events; up to 30s silent wait | Students stare at a spinner; perceived as broken; abandonment | Stream provider tokens through, or show honest staged progress; add timeout messaging | Medium | Senior | Months 2–3 |
| ISS-22 | Raw internal error messages returned to clients | Low | `error.message` passed through in most routes' JSON | Internal details leak; inconsistent UX copy | Map to stable error codes + safe messages; log details server-side | Small | Junior dev | Month 2 |

**What is genuinely good (keep and protect):** strict TypeScript everywhere; consistent `aais-*` module naming; scrypt + timing-safe comparisons; signed HttpOnly cookies; actor-bound double-submit CSRF; server-derived identity (client-sent `studentId` is ignored); security headers incl. HSTS; role-gated, pseudonymized cohort analytics; CSV formula-injection escaping; the LRS outbox with retry/dead-letter/coalescing; fail-closed 503 when production storage is missing; redacted audit logging; bilingual content data model; terms/privacy pages. This list is why the recommendation is *refactor, not rebuild*.

---

## D. 3-Month Technical Recovery Roadmap

Sized for one junior developer (majority of hands-on work) plus a senior engineer at ~2–4 hours/week (design review, pairing), and the product owner for decisions. If capacity halves, cut Month 3's feature expansion, never the security/data items.

### Weeks 1–2 — Stabilization and risk reduction (stop the bleeding)

Goals: no anonymous access, no single-point-of-loss, secrets contained, eyes on production.

1. Rotate every credential in `All API Keys.docx`; move to a password manager; delete the file. (ISS-03)
2. Remove built-in demo accounts from production; issue strong per-person trial passwords; redeploy; verify `Bobie/12345` fails. (ISS-01)
3. Create private GitHub repo; push all history; protect `main`; connect Vercel Git deploys; confirm CI (lint, type-check, test, build) runs green. (ISS-02)
4. Lock down `/api/system/readiness` (public = status only). (ISS-06)
5. Add Sentry + uptime monitor + cron alert. (ISS-13)
6. Verify Neon backup/PITR settings; take a manual snapshot; write down the restore steps actually available on the current plan. (supports ISS-05)
7. Create a staging environment: Vercel preview + Neon branch; document env vars for it. (ISS-05, first half)

Exit criteria: demo login fails in prod; repo on GitHub with green CI; keys rotated; error dashboard live; staging URL exists.

### Weeks 3–4 — Architecture cleanup and documentation (make it changeable)

1. Archive the release-evidence pipeline to `tools/release-legacy/`; keep one smoke script (`smoke:prod`) + a one-page release checklist. (ISS-10)
2. Remove the unused LangGraph dependency and rename misleading runtime labels. (ISS-11)
3. Rewrite documentation: 1-page README, ARCHITECTURE.md (with the real diagram), OPERATIONS.md (deploy/rollback/restore), CONTRIBUTING.md (branch/PR rules). (ISS-20)
4. Introduce the migration tool; write migration #1 that formalizes the two existing tables; remove runtime `CREATE TABLE`. (ISS-05, second half)
5. Add optimistic locking to session writes (version column + retry-on-conflict) as the interim fix for lost updates. (ISS-04, short-term)
6. First two Playwright specs (login, basic learning flow) running in CI against preview deploys. (ISS-14 start)

Exit criteria: a new engineer can clone, run, and deploy from docs alone; schema changes go through migrations; concurrent-write data loss demonstrably fixed at the interim level.

### Month 2 — Core refactoring and feature foundation

1. **Data model v2** (senior-designed, junior-built): `users`, `aais_events` (append-only), slim `learner_sessions` snapshot; backfill script migrating existing blobs; cutover on staging first, then prod with snapshot + rollback plan. (ISS-04, ISS-15 enabler)
2. **Real accounts**: invite-based registration, password reset via Resend, admin user management page; teachers/admins get individual credentials. OIDC stays optional behind config. (ISS-08)
3. **Frontend decomposition**: extract typed API client; split `learning-page.tsx` into ~6 feature components + hooks; no behavior change (Playwright as the safety net). (ISS-09)
4. Durable rate limiting (Postgres/Upstash). (ISS-07)
5. Error-code mapping for API responses. (ISS-22)
6. Complete the Playwright suite (6–8 specs) in CI. (ISS-14)

Exit criteria: real users can be invited and reset passwords; events live in their own table with SQL aggregates behind the dashboard; the learning page is componentized; CI runs E2E on every PR.

### Month 3 — Hardening, testing, and controlled feature expansion

1. **Adaptive-learning foundation (honest version)**: learner-profile aggregates computed from `aais_events` (mastery per task, scaffold dependency, reflection completeness); a rule-based recommendation endpoint ("next task / revisit / see expert trace") the UI can show and a teacher can override. Defer any ML. (Section E)
2. **AI quality pass**: raise token budget, add 1 retry, true streaming or honest progress UI, visible "guidance is offline (template)" state, per-student daily token budget. (ISS-12, ISS-21)
3. **Privacy baseline**: data inventory, retention policy, per-user export + delete, consent flow, Neon/LRS DPA + region check. Gate: no real cohort onboards before this is done. (ISS-16)
4. Accessibility + mobile pass on the three core screens. (ISS-19)
5. Security tightening: nonce CSP, session revocation decision, dependency audit in CI. (ISS-17, ISS-18)
6. Load sanity check: 200 concurrent students simulated against staging; fix the top bottleneck found.
7. Controlled pilot: one real class (10–30 students) with the owner watching Sentry + analytics; feedback loop into the backlog.

Exit criteria: pilot cohort ran without data loss or unauthorized access; recommendations visible and explainable; privacy questions answerable in writing.

---

## E. Recommended Target Architecture (near-term, small-team realistic)

**Principle: keep the current stack — Next.js on Vercel + Neon Postgres — and fix the shape of the data and the honesty of the AI layer.** No microservices, no Kubernetes, no separate backend, no ML infrastructure. The stack choice is not the problem.

### E.1 Components

- **Web app (unchanged host):** Next.js App Router on Vercel. Server components for pages, route handlers for the API. One repo, one deployable.
- **Auth:** keep the signed-cookie session mechanism (it is sound), but back it with a `users` table (id, email, display name, role, scrypt password hash, status, created_at). Invite-based signup + password reset via Resend. Teachers/admins = individual accounts. OIDC remains an optional add-on for institutions. Demo accounts exist only in dev builds.
- **Database (Neon Postgres), target schema — 6 core tables:**
  - `users` (identity + role)
  - `courses` (start = the one seeded course; authored content later)
  - `tasks` (belongs to course; phase, difficulty, brief, expert trace — move out of `src/data/aais.ts` into seed data)
  - `enrollments` (user ↔ course; cohort/class label lives here)
  - `learner_task_state` (per user+task: status, artifact text, self report, scaffold count — the *current* state, small)
  - `aais_events` (append-only: student, session, task, agent, event, time, detail JSONB — the existing, well-designed event vocabulary, one row per event)
  - keep `aais_lrs_outbox` as is.
  This preserves everything the current blob holds while making writes small, concurrent-safe, and queryable. Guide chat history can live in `aais_events` (kind `ai_interaction`) or a small `guide_messages` table.
- **Analytics:** SQL aggregates over `aais_events` (indexed on student, task, event, time) behind the existing dashboard API contract. No BI tool yet.
- **Adaptive learning (minimal honest architecture):**
  1. *Signals* — the existing event stream (already good: scaffold requests, pauses, regressions, AI acceptance, reflections).
  2. *Learner profile* — a nightly-or-on-read aggregate per user (mastery per task, help dependency, reflection completeness) stored in a `learner_profiles` table or computed view.
  3. *Policy* — a **rules engine in plain TypeScript** (e.g., "3+ scaffolds and failed self-check → recommend revisit with expert trace") producing recommendations with human-readable reasons.
  4. *LLM layer* — one well-prompted model call per interaction (guide/coach persona chosen by context), fed the learner profile summary — replacing the 4-way fan-out where A3/A4 are canned anyway. Keep the deterministic fallback, but label it in the UI.
  5. *Feedback loop* — teacher can accept/override recommendations; overrides are events too.
  This is defensible pedagogy, cheap to run, explainable to teachers, and a real substrate for ML later.
- **Secrets/config:** Vercel env vars only (prod + staging separated); local `.env.local` from a documented `.env.example`; password manager for human-held credentials.
- **Environments:** local (file or Neon branch) → staging (Vercel preview/branch + Neon branch, seeded) → production (Git-triggered deploy from `main`, instant rollback via Vercel deployment history + Neon PITR/snapshot).
- **Observability:** Sentry (client+server) + Vercel logs + one uptime check + cron alert. That's all a team this size needs.

### E.2 What deliberately stays out (for now)

Separate API service; message queues beyond the existing outbox; Redis (except possibly rate limiting); multi-region; ML pipelines; a CMS. Each has a trigger condition (e.g., >2k MAU, multi-school tenancy, dedicated data engineer) documented in ARCHITECTURE.md so the team knows when to revisit.

---

## F. Refactoring Strategy

**Refactor first (order matters):**
1. *Ops fundamentals before code* (Weeks 1–2): remote repo, secrets, demo accounts, monitoring, staging. These make every later change safe; none touch product code.
2. *Data layer* (Weeks 3–4 interim, Month 2 full): optimistic locking first — a small, testable change that stops silent data loss immediately — then the event-table migration with a backfill script rehearsed on staging. This is the highest-value refactor because everything (features, analytics, adaptive learning, scale) sits on it.
3. *Frontend monolith* (Month 2, after E2E tests exist): extract the API client first (pure code motion, no behavior change), then split components one feature at a time. Never refactor UI without the Playwright net.
4. *AI layer honesty* (Months 2–3): remove fake labels, then simplify the fan-out to one contextual call + rules. Do it after the event/profile tables exist so the model gets better input.

**Leave alone temporarily:**
- The session-cookie/CSRF implementation — custom but competent; replacing it is churn without benefit at this stage.
- The LRS outbox subsystem — it works, has tests, and is well-isolated.
- The OIDC module — unconfigured but harmless; revisit when an institution actually asks for SSO.
- Styling/design system — cosmetic churn is a trap until flows are stable; only the accessibility pass in Month 3.
- The release-evidence pipeline — do not fix it, do not extend it; archive it. Deleting code is also progress, but archiving preserves the option value.

**How to avoid breaking the live site:**
- All changes land via PR to `main` → preview deploy → staging check → production; direct `vercel deploy --prod` from the laptop ends in Week 1.
- Database changes: migration + backfill rehearsed on a Neon branch restored from a fresh snapshot (the runbook's own rehearsal idea — kept, simplified); production cutover during a announced low-usage window; snapshot immediately before; rollback = redeploy previous Vercel build + restore snapshot.
- The blob→table migration runs dual-read (new code reads events table, falls back to blob) for one release before dual-write is removed.
- Feature flags via env vars for anything user-visible (e.g., `AAIS_RECOMMENDATIONS_ENABLED`).
- Keep the deterministic AI fallback forever — it is a genuinely good resilience idea; just label it in the UI.

---

## G. Minimum Production-Readiness Checklist

*"Production-ready" here means: safe to invite one real class, not enterprise-grade.*

**Security**
- [ ] Built-in demo credentials disabled in production (verified by failed login)
- [ ] All API keys/passwords rotated after removal of `All API Keys.docx`; secrets only in Vercel env + password manager
- [ ] Individual accounts for every human (no shared teacher/admin credentials)
- [ ] Durable login rate limiting verified across serverless instances
- [ ] Readiness/diagnostics endpoints require auth beyond bare status
- [ ] `npm audit` (or Dependabot) clean of critical vulns in CI

**Data**
- [ ] Migration tool in place; zero runtime DDL
- [ ] Concurrent-write safety proven by a test (two parallel saves, nothing lost)
- [ ] Nightly snapshot or PITR confirmed on the Neon plan in writing
- [ ] Restore rehearsed end-to-end once per quarter (documented, < 1 hour)
- [ ] Per-user data export and deletion implemented and tested

**Deployment**
- [ ] Deploys only from Git (`main`) via CI; laptop deploys disabled
- [ ] Staging environment with seeded data; every change staged first
- [ ] One-step rollback documented and rehearsed (Vercel redeploy + snapshot)
- [ ] Env vars documented in `.env.example` for local/staging/prod

**Testing**
- [ ] CI gate: lint + type-check + unit + build on every PR
- [ ] Playwright E2E on the 3 core flows (login, learn+save, dashboard) against preview
- [ ] A regression test for every Critical/High issue fixed above

**Monitoring**
- [ ] Sentry receiving client + server errors with alerts to a human
- [ ] Uptime check on `/login` (and cron-failure alert)
- [ ] A weekly 15-minute "look at the dashboards" ritual owned by a named person

**Documentation**
- [ ] README ≤ 1 page: what it is, run locally, deploy
- [ ] ARCHITECTURE.md with the real diagram and the "not yet" list
- [ ] OPERATIONS.md: deploy, rollback, restore, incident basics
- [ ] CONTRIBUTING.md: branch, PR, review rules

**User experience**
- [ ] Loading and error states on every async action (esp. the AI guide)
- [ ] AI fallback/template responses visibly labeled
- [ ] Keyboard + screen-reader pass on the 3 core screens; contrast fixes
- [ ] Stated mobile policy (supported, or a graceful "use a larger screen" message)

---

## H. Suggested Backlog (22 tickets)

Priorities: **P0** = Weeks 1–2 · **P1** = Weeks 3–4 · **P2** = Month 2 · **P3** = Month 3. Effort S/M/L as in Section C.

**T-01 · Rotate and re-home all credentials (P0, S, owner+junior)** — Rotate every key/password in `All API Keys.docx` at each provider; store in a password manager; delete the file; amend `agents.md`. *AC: old keys revoked and fail; file gone from disk; managers entry exists; no plaintext secrets in repo folder besides `.env.local` (which is documented).* 

**T-02 · Disable built-in demo accounts in production (P0, S, junior)** — Gate `builtInLearnerTrialAccounts` to non-production; rotate all configured trial passwords. *AC: `Bobie/12345` returns 401 on www.aais.site; dev login still works locally; unit test asserts production exclusion.*

**T-03 · Push repo to GitHub with protected main + working CI (P0, S, junior)** — Private repo, full history, `main` default + protection, Vercel Git integration. *AC: CI green on a test PR; direct-to-prod CLI deploys stopped (documented); Vercel deploys triggered by merge.*

**T-04 · Minimal-disclosure readiness endpoint (P0, S, junior)** — Public GET returns `{status}` only; full report requires admin session or bearer. *AC: anonymous fetch shows no release id/SHA/config; admin fetch unchanged; test covers both.*

**T-05 · Error tracking + uptime + cron alerts (P0, S, junior)** — Sentry client+server, uptime monitor on `/login`, alert on cron flush failure. *AC: test error appears in Sentry with release tag; downtime and cron failure each trigger a notification.*

**T-06 · Staging environment + documented env vars (P0/P1, M, junior)** — Vercel preview env + Neon branch, seeded; `.env.example`. *AC: staging URL loads with seed data; deploy-to-staging documented; prod secrets not reused where separable.*

**T-07 · Verify backups and rehearse restore (P0, S, junior+owner)** — Confirm Neon plan's PITR/snapshot capability; take snapshot; restore to a branch; write OPERATIONS.md section. *AC: written restore procedure with actual timings; snapshot schedule decided and enabled.*

**T-08 · Optimistic locking on learner-session writes (P1, M, senior design/junior impl)** — Version column; compare-and-swap update; single retry with merge-or-fail. *AC: parallel-write test (two saves racing) loses no data; conflict metric logged.*

**T-09 · Migration framework + baseline migration (P1, S, junior)** — Adopt node-pg-migrate (or equal); migration 001 formalizes existing tables; remove runtime `CREATE TABLE`. *AC: fresh DB built solely by migrations; CI runs migrations against a temp DB; runtime DDL deleted.*

**T-10 · Archive release-evidence pipeline (P1, S, junior)** — Move 22 scripts + their tests to `tools/release-legacy/`; keep `smoke:prod` (readiness + login + one learning write on staging/prod). *AC: `npm run ci` time drops; test suite only covers product code + smoke; README no longer references archived commands; one-page release checklist exists.*

**T-11 · Remove LangGraph dependency and misleading labels (P1, S, junior)** — Drop `@langchain/langgraph`; rename `engine`/`runtime` strings to `aais-orchestrator-v1`. *AC: dependency gone from package.json; no source or API response mentions langgraph; tests updated.*

**T-12 · Documentation set rewrite (P1, S–M, junior)** — README (1 page), ARCHITECTURE.md, OPERATIONS.md, CONTRIBUTING.md. *AC: a new engineer (or the senior advisor) executes local setup from README alone in <30 min; old README archived.*

**T-13 · Playwright E2E suite in CI (P1 start/P2 done, M, junior)** — Specs: login ok/fail, task select+artifact save+reload persistence, AI guide happy path + fallback label, teacher dashboard access + student blocked, cohort export. *AC: suite runs on PR preview URLs in CI; failure blocks merge.*

**T-14 · Data model v2: users + events tables + backfill (P2, L, senior+junior)** — Create `users`, `aais_events`, `learner_task_state`; backfill from JSONB blobs; dual-read for one release. *AC: rehearsed on staging from a prod snapshot; row counts reconcile with blob event counts; app reads events from the new table; blob retained read-only until Month 3.*

**T-15 · Invite-based registration + password reset (P2, L, senior+junior)** — Admin invites by email (Resend); set-password flow; reset flow; admin user list page. *AC: full invite→login→reset cycle on staging; env-JSON accounts only as break-glass; audit events for each step.*

**T-16 · Individual teacher/admin accounts (P2, S, junior)** — Migrate the shared/static educator access to per-person users with roles. *AC: every human has own credentials; role changes logged; old educator env accounts removed.*

**T-17 · Durable rate limiting (P2, S–M, junior)** — Postgres or Upstash counters for login (account+IP) with lockout + audit. *AC: brute-force test across multiple serverless invocations gets 429; limits configurable by env.*

**T-18 · Frontend decomposition of learning page (P2, M–L, junior w/ senior review)** — Extract typed API client; split into TaskList, Workspace/Editor, GuideChat, ScaffoldPanel, ReflectionPanel, ExportMenu + hooks. *AC: no file >500 lines in the page tree; behavior identical (E2E green); component tests for 3 key components.*

**T-19 · API error-code contract (P2, S, junior)** — Stable `{error: {code, message}}` shape; internal messages logged not returned. *AC: all routes conform; client shows friendly copy; contract documented.*

**T-20 · SQL cohort analytics (P2/P3, M, senior)** — Replace load-everything with indexed SQL aggregates over `aais_events`; paginate learner drill-down. *AC: dashboard correct vs old output on test data; p95 < 500ms with 500 simulated learners; memory flat.*

**T-21 · Learner profiles + rule-based recommendations (P3, M–L, senior+junior+owner)** — Profile aggregates; 5–8 explainable rules; recommendation API + UI card with reasons; teacher override (logged as event). *AC: given scripted event fixtures, expected recommendations appear with correct reasons; override works and is auditable; rules documented for teachers.*

**T-22 · AI experience quality pass (P3, M, senior)** — Raise max tokens (~600), 1 retry, true token streaming (or staged honest progress), visible fallback labeling, per-student daily budget. *AC: p50 first-token < 3s on staging; fallback clearly labeled in UI; cost per student per day capped and logged.*

*(Also schedule from checklist, not ticketed in detail: privacy baseline work (ISS-16), accessibility pass (ISS-19), nonce CSP (ISS-18) — see Sections D Month 3 and G.)*

---

## I. Risks, Assumptions, and Open Questions

**Risks that remain even if the roadmap executes**
- One-developer bus factor: mitigated by docs/CI, not eliminated. The senior advisor should hold repo admin rights too.
- The blob→table migration is the riskiest single change; its safety depends on the staging rehearsal actually happening.
- AI provider concentration: a single OpenAI-compatible vendor (with the fallback being canned text). Cost spikes or provider policy changes hit the core feature. A per-student budget (T-22) is the mitigation.
- The "adaptive learning" research claims may outpace what the honest implementation does; align academic/marketing language with Section E.1's rules-based reality to avoid credibility damage.

**Assumptions to validate (owner, this month)**
1. No real students (especially minors) have used production yet — if any have, the privacy work moves to Week 1 and affected accounts/passwords rotate immediately.
2. Neon and Vercel plan tiers, backup windows, and data regions — get them in writing.
3. The external LRS: who operates it, where, under what agreement? If unclear, pause mirroring (the outbox will queue) until answered.
4. Whether `AAIS_SESSION_SECRET` and `CRON_SECRET` are strong and have never been in the docx file — if in doubt, rotate (invalidates active logins; cheap now).
5. Ownership: is the Vercel team/Neon account under the founder's org (not a personal account of one developer)?

**Open questions for the product owner**
1. Who is the first real cohort (age group, region, institution)? This decides which privacy regime (FERPA/COPPA/GDPR/PIPL/…) Section G must satisfy and the consent design.
2. Is the single hardcoded course the actual 3-month product, or must teachers author content within this window? (Authoring UI is deliberately *not* in this roadmap; seeding new courses via data files is.)
3. What is the monthly AI spend ceiling per student? (Sets token budgets and model choice.)
4. Bilingual commitment: is en-US a real requirement now, or is zh-CN-first acceptable for the pilot? (Affects ISS-19/UI copy scope.)
5. Does anyone external ever need the "enterprise evidence" artifacts (e.g., a university procurement)? If yes, keep one generator; if no, archive all (T-10).
6. Who is the named on-call/monitoring owner for the weekly check (Section G)?

**Could not verify from the repo**
- Actual Vercel env var values/strength; Neon plan and backup config; LRS operator; whether any real learner data exists in production beyond test accounts (readiness showed 4 trial accounts, 8 LRS events sent — consistent with test-only usage, but not proof); DNS/registrar ownership of aais.site.

---

## J. Final Recommendation

**Partially refactor the current codebase. Do not rebuild, and do not continue piling features on the current data layer.**

Reasoning:

1. **Rebuild is unjustified.** The expensive-to-recreate parts — a coherent event vocabulary for learning evidence, a working auth/CSRF layer, LRS integration with a real outbox, role-gated pseudonymized analytics, strict typing throughout — are the parts that are *good*. A rewrite would re-spend months to get back to a worse version of what exists, and rewrites by the same-size team historically re-introduce the same gaps (no tests, no staging) under schedule pressure.
2. **"Just keep modifying" is also unjustified.** The three Critical issues (public demo credentials, no code remote, plaintext key file) are not features of a codebase that can be safely extended — they are live hazards. And the blob-per-student store fails exactly when the product succeeds (more students, more concurrency, more analytics). Building adaptive-learning features on it means paying migration cost later *plus* losing data in the meantime.
3. **The refactor is small and bounded.** The genuinely structural work is: one data-model migration (6 small tables), one frontend decomposition, one honesty pass on the AI layer, and deleting (archiving) about half the repo's ceremony. Everything else is configuration and process. This fits in 3 months for the stated team *because* the codebase is small and consistently typed.
4. **Sequencing is the strategy.** Week 1's five actions (rotate keys, kill demo accounts, push to GitHub, lock readiness, add monitoring) cost roughly two days and remove the majority of catastrophic risk. Nothing else in this document matters if those don't happen first.

**The single sentence version:** secure it this week, put the data on rails this month, make the AI honest next month — and keep the parts of AAIS that are already better than its documentation suggests.
