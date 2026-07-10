# AAIS Privacy Data Inventory

This inventory is the code-level privacy baseline for AAIS before any real cohort onboarding. It records what the current application stores, which routes expose or delete it, and which owner/provider confirmations remain outside the repository.

Gate: no real student cohort, and especially no minors, should onboard until the owner confirms the first cohort's age group, region, institution, legal basis, formal consent record, data-retention schedule, processor/DPA status, and provider data-region terms.

## Current Data Inventory

| Category | Runtime source | Contains | Purpose | Export/delete behavior | Current retention boundary |
| --- | --- | --- | --- | --- | --- |
| Learner session snapshot | `aais_learner_sessions`; local `.aais-data/<student>.json` in development | Student actor id, session id, task records, raw artifact text, self-report text, guide turns, scaffold counts, timestamps | Restore the learner cockpit and support owner-scoped review | `GET /api/learning/privacy` exports it to the signed-in learner. CSRF-protected `DELETE /api/learning/privacy` removes it. | Retain only for the institution-approved learning period plus the confirmed deletion/grace window. Final values are owner/legal pending. |
| Learning event facts | `aais_events` | Student actor id, session id, phase, task, agent, event name, event time, JSON detail | Analytics, daily guide budget, rule-based teacher recommendations, audit evidence | Included in learner export and deleted by learner deletion. Cohort analytics use pseudonymous keys and exclude raw learner text. | Same learner-record schedule as the session snapshot unless the institution approves a shorter analytics window. |
| Daily AI guide usage counter | `aais_ai_guide_daily_usage` | Student actor id, UTC usage day, reserved-request count, updated timestamp; derived from atomic guide reservations and migration-day prompt-event counts | Enforce the per-student daily AI guide limit across concurrent serverless instances | Deleted by learner deletion. Not exported as a separate object because it is derived enforcement metadata rather than learner-authored content; completed guide exchanges and their source events remain covered by the learner export. | Operational need is the current UTC-day limit. The repository provides learner-scoped deletion but no age-based purge; the cleanup cadence and final retention window remain owner/legal pending. |
| Task-state mirror | `aais_learner_task_state` | Student actor id, session id, task, phase, status, artifact/self-report character counts, scaffold count | Fast cohort summaries without scanning raw learner-session blobs | Deleted by learner deletion. Not exported as a separate raw object because it is a derived mirror. | Rebuildable from learner/session records; delete with the learner record. |
| LRS/xAPI delivery queue | `aais_lrs_outbox` | xAPI statement payloads, deterministic statement id, pseudonymous actor, status, attempts, redacted last error | Retry and dead-letter delivery to the external LRS | Rows whose payload has the learner `student_id` are deleted by learner deletion. Health routes expose counts only. | Keep pending/dead-letter rows only as long as needed for delivery troubleshooting, then purge or archive under the owner-approved LRS policy. |
| Account records | `aais_users` | Email, normalized email, display name, role, status, password hash metadata, invite owner, created/updated/login timestamps | Sign-in, admin account lifecycle, role-gated access | Not deleted by learner-data deletion. Admin/institution workflow handles account disablement, SSO lifecycle, and legal retention. | Retain for the institution-approved account/audit period; disable inactive accounts when access ends. |
| Course catalog and enrollments | `aais_courses`, `aais_course_tasks`, `aais_enrollments` | Localized course/task metadata, expert traces, user id, cohort label, role, enrollment status | Move course/task structure toward relational configuration and support class/cohort membership | Catalog rows are shared product content. Enrollment rows are account-lifecycle records and are not deleted by learner-content deletion. | Keep catalog while the course is active. Retain enrollment records according to the institution-approved account/audit period. |
| Invite and password-reset tokens | `aais_user_auth_tokens` | Token hash, purpose, user id, creator, expiry, consumed timestamp | Account invitation and password reset | Raw tokens are never stored. Tokens expire or are marked consumed; deletion follows account lifecycle. | Expire quickly; `npm run db:cleanup` removes expired rows after a dry run. |
| Login rate limits | `aais_login_rate_limits`; process memory in local development | Hashed account/client keys, failure count, first failure, lock expiry | Serverless-safe brute-force mitigation | Not learner-exported. Success or expiry clears current lockout state. | Keep only active window/lock rows; `npm run db:cleanup` removes rows whose lock/window has passed. |
| Login consent acknowledgement | `POST /api/auth/app-session`; `consentAccepted: true`; redacted `auth.login.success` audit metadata | Boolean acknowledgement that the user confirmed the current terms, privacy notice, and guardian-consent condition before session creation | Prevent session creation without an explicit pre-login acknowledgement | Missing acknowledgement returns `AAIS_LOGIN_CONSENT_REQUIRED` and no session cookie. The audit marker is operational evidence, not a complete legal consent record. | Retain only as part of redacted operational audit/log policy unless the owner/institution approves a durable consent ledger. |
| Session revocations | `aais_session_revocations`; process memory in local development | Session token hash, hashed actor key, token expiry, revocation time | Invalidate logged-out sessions until original expiry | Not learner-exported. Rows expire when the original session expiry passes. | Retain only until `expires_at`; `npm run db:cleanup` removes expired rows after a dry run. |
| Monitoring and smoke evidence | Sentry when configured; Vercel/function logs; `npm run smoke:prod` console output | Redacted route/status/error metadata, release/environment tags, synthetic smoke status | Operations, alerting, production smoke proof | No learner export route. Monitoring must not include raw learner text, cookies, tokens, credentials, prompts, reports, or email-like fields. | Retain according to the confirmed Sentry/Vercel log-retention terms and the institution's incident policy. |
| AI provider requests | Live provider call from `/api/learning/ai-guide` when approved; deterministic fallback otherwise | Redacted Cognitive Apprenticeship context and learner prompt/attachments needed to answer the turn | A1/A2 guide response generation | Provider payloads are not stored as provider logs by AAIS; resulting guide turns are stored in the learner session and exported/deleted there. | Do not enable live provider processing for a real cohort until provider DPA, data-use, model-training, and data-region terms are confirmed. |

## Export And Deletion Contract

- `GET /api/learning/privacy` requires the signed AAIS learner session and returns owner-scoped `learner-data` JSON with `cache-control: no-store`.
- The export can include raw learner artifacts, self reports, guide turns, and events, so it is never used as a cohort analytics feed.
- `DELETE /api/learning/privacy` requires the signed learner session and actor-bound CSRF token.
- In Postgres mode, deletion removes the learner's `aais_lrs_outbox`, `aais_learner_task_state`, `aais_ai_guide_daily_usage`, `aais_events`, and `aais_learner_sessions` rows.
- The daily guide counter is not a separate learner-export payload. It is derived request-enforcement metadata and is deleted with the learner record.
- In local file mode, deletion removes the learner session JSON under `.aais-data/`.
- Deletion does not delete `aais_users` or `aais_user_auth_tokens`; account lifecycle remains an administrator or institution SSO action.

## Retention Policy To Confirm Before A Real Cohort

AAIS has code-level deletion and short-lived security rows, but the final retention schedule is an owner/legal decision. Record the approved values before onboarding:

| Data class | Default code stance | Owner/legal value required |
| --- | --- | --- |
| Raw learner artifacts, self reports, guide turns | Keep only for the active course/pilot plus a short correction/deletion window | Exact number of days/months and who can approve extension |
| Learning event facts and task-state mirrors | Delete with learner record; use pseudonymous cohort outputs for reporting | Whether aggregate reports may outlive raw records and for how long |
| Daily AI guide usage counters | Delete with learner record; retain only for daily enforcement subject to an approved cleanup process | Cleanup cadence, retention window, and whether operational audit requirements justify any extension |
| LRS/xAPI statements and outbox rows | Do not mirror real learners until LRS operator, DPA, region, and purge rights are confirmed | LRS retention, deletion propagation, and failed-delivery purge window |
| Account records and auth tokens | Keep account records separate from learner data; expire one-time tokens quickly | Account/audit retention period, disabled-account handling, SSO deletion behavior |
| Login lockouts and session revocations | Retain only while active security windows require them | Cleanup cadence and whether logs need an audit retention period |
| Monitoring/error data | Redact by default; no Session Replay without separate review | Sentry/Vercel log-retention period and incident evidence retention |

## Processor, DPA, And Data-Region Register

Fill this register with written owner/provider evidence before live learners use the system.

| Processor/provider | Current use | Required confirmation | Status |
| --- | --- | --- | --- |
| Vercel | Hosting, serverless runtime, deployment logs, environment variables | Team ownership, plan tier, production data region, log retention, DPA/subprocessor terms | Owner/provider pending |
| Neon/Postgres | Production learner/session/event/account database | Plan tier, backup/PITR window, data region, DPA/subprocessor terms, restore rehearsal | Owner/provider pending |
| External LRS | xAPI statement receiver from `aais_lrs_outbox` | Operator, endpoint region, DPA, deletion propagation, failed-statement retention, support contact | Owner/provider pending |
| Sentry | Optional client/server/edge error monitoring | Project ownership, DPA, region/log-retention, PII settings, no Session Replay unless reviewed | Owner/provider pending |
| Resend or email provider | Optional invite/password-reset delivery | DPA, email region, retention, sender-domain ownership | Owner/provider pending |
| AI model provider | Optional live guide responses | DPA, data-use/model-training terms, region, retention, prompt/attachment handling, budget controls | Owner/provider pending |

## Consent And Minor-User Gate

The login page now requires an explicit acknowledgement before `POST /api/auth/app-session` creates a session. The acknowledgement covers `/terms`, `/privacy`, and the condition that a learner under the local legal age has parent/guardian consent. The API rejects missing acknowledgement with `AAIS_LOGIN_CONSENT_REQUIRED`, sets no session cookie, and records only redacted success metadata for accepted logins.

That code gate is still not a complete legal consent workflow for a school cohort with minors. Before a real cohort starts, the owner must document:

- First cohort institution, age range, region, and whether any learner is a minor.
- Applicable regime and institution policy, such as FERPA, COPPA, GDPR, PIPL, or local education-data rules.
- Whether consent comes from the learner, parent/guardian, institution, or a combined workflow.
- How formal consent is recorded, versioned, withdrawn, and connected to account disablement or learner-data deletion.
- Teacher/admin training language explaining that recommendations are support signals, not final grades or disciplinary decisions.

Until those answers are recorded, AAIS should remain limited to owner/developer testing, synthetic smoke accounts, or explicitly approved non-student testers.
