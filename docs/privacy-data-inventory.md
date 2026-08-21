# AAIS Privacy Data Inventory

This inventory is the code-level privacy baseline for AAIS before any real cohort onboarding. It records what the current application stores, which routes expose or delete it, and which owner/provider confirmations remain outside the repository. The enforceable data-management contract for the 30-participant, one-visit research study is [docs/research-data-governance.md](./research-data-governance.md).

Gate: the research study uses the operative 90/180/1825/35-day retention schedule below; no real student cohort or participant, and especially no minor, should onboard until the PI also confirms age group, region, institution, legal basis, formal consent record, processor/DPA status, provider data-region terms, and the signed access register. A non-research cohort requires its own approved retention schedule.

## Current Data Inventory

| Category | Runtime source | Contains | Purpose | Export/delete behavior | Current retention boundary |
| --- | --- | --- | --- | --- | --- |
| Learner session snapshot | `aais_learner_sessions`; local `.aais-data/<student>.json` in development | Student actor id, session id, task records, raw artifact text, self-report text, guide turns, successful attachment-receipt metadata (sanitized file name, MIME type, byte size, read status), scaffold counts, timestamps; no attachment source bytes or extracted attachment text | Restore the learner cockpit, including successful attachment receipts, and support owner-scoped review | `GET /api/learning/privacy` exports it to the signed-in learner. CSRF-protected `DELETE /api/learning/privacy` removes it. Restricted research raw-text erasure also removes attachment-receipt metadata and file names. | In the named research study, only the four allowed raw-text classes may be retained and they expire 180 calendar days after the participant visit; research attachments are prohibited. Non-research use requires a separately approved schedule. |
| Learning event facts | `aais_events` | Student actor id, session id, phase, task, agent, event name, event time, JSON detail | Analytics, daily guide budget, rule-based teacher recommendations, audit evidence | Included in learner export and deleted by learner deletion. Cohort analytics use purpose-separated HMAC pseudonyms keyed by the dedicated, stable `AAIS_PRODUCT_PSEUDONYM_SECRET` and exclude raw learner text. The key must be distinct from session, worker, provider, and research secrets; routine session-secret rotation must not rotate product identities. | Dedicated research event facts are retained for at most 1825 calendar days after server receipt; non-research facts follow their separately approved learner-record schedule. |
| Task-state mirror | `aais_learner_task_state` | Student actor id, session id, task, phase, status, artifact/self-report character counts, scaffold count | Fast cohort summaries without scanning raw learner-session blobs | Deleted by learner deletion. Not exported as a separate raw object because it is a derived mirror. | Rebuildable from learner/session records; delete with the learner record. |
| LRS/xAPI delivery queue | `aais_lrs_outbox` | xAPI statement payloads, deterministic statement id, pseudonymous actor, status, attempts, redacted last error | Retry and dead-letter delivery to the external LRS | Rows whose payload has the learner `student_id` are deleted by learner deletion. Health routes expose counts only. Frozen statements keep their original pseudonym across retries. A product-pseudonym-key compromise requires a reviewed cutover that drains old application nodes, records the external LRS identity discontinuity, and verifies teacher-decision compatibility before traffic resumes. Research withdrawal also requires physical deletion of already-delivered statements. | Dedicated research LRS statements expire no later than 1825 calendar days after server receipt. Pending/dead-letter rows are operational copies and are removed on approved retention purge or the 7-day withdrawal deadline. |
| Research encrypted identity map | `aais_research_identity.aais_research_identity_map` | Opaque participant id, AES-256-GCM ciphertext, nonce, authentication tag, key version, lifecycle dates; no plaintext identity or HMAC admission fingerprint | PI/custodian-only identity resolution while the short correspondence window remains open | Never appears in researcher export or LRS. Withdrawal deletes it; retention deletes it after raw-text deletion evidence. | Maximum 90 calendar days after map creation. |
| Research HMAC participation ledger | `aais_research_identity.aais_research_participation_ledger` | Scoped HMAC admission fingerprint, opaque participant/run/visit ids, status, key version and nonce reservation; no plaintext identity, ciphertext, or raw text | Enforce one participation and withdrawal after the identity map expires; prevent AES-GCM nonce reuse | Permission-revoked from public roles; excluded from researcher export/LRS. Fact retention purges it only after raw/local facts and live withdrawal dependencies are gone. | Maximum 1825 days through the study fact lifecycle; associated key version is retired before its final nonce reservation is purged. |
| Research operational receipts | `aais_research_export_audit`, `aais_research_retention_runs`, `aais_research_lrs_deletions`, `aais_research_legacy_archives` | Scoped counts/status, schema version, commit SHA, checksums, statement ids and deadlines; no raw learner text or credentials | Prove controlled export, retention, physical LRS deletion and legacy inventory | Every row has `retention_due_at`. Scoped cleanup deletes due export/retention receipts; LRS receipts require confirmed status and no live withdrawal; legacy inventory requires archived status. | Maximum 1825 days; an LRS deletion receipt is retained at least 35 days from request. Pending deletion and uncompleted legacy inventory are not auto-purged. |
| Account records | `aais_users` | Email, normalized email, display name, role, status, password hash metadata, invite owner, created/updated/login timestamps | Sign-in, admin account lifecycle, role-gated access | Not deleted by learner-data deletion. Admin/institution workflow handles account disablement, SSO lifecycle, and legal retention. | Retain for the institution-approved account/audit period; disable inactive accounts when access ends. |
| Course catalog and enrollments | `aais_courses`, `aais_course_tasks`, `aais_enrollments` | Localized course/task metadata, expert traces, user id, cohort label, role, enrollment status | Move course/task structure toward relational configuration and support class/cohort membership | Catalog rows are shared product content. Enrollment rows are account-lifecycle records and are not deleted by learner-content deletion. | Keep catalog while the course is active. Retain enrollment records according to the institution-approved account/audit period. |
| Invite and password-reset tokens | `aais_user_auth_tokens` | Token hash, purpose, user id, creator, expiry, consumed timestamp | Account invitation and password reset | Raw tokens are never stored. Tokens expire or are marked consumed; deletion follows account lifecycle. | Expire quickly; `npm run db:cleanup` removes expired rows after a dry run. |
| Login rate limits | `aais_login_rate_limits`; process memory in local development | Hashed account/client keys, failure count, first failure, lock expiry | Serverless-safe brute-force mitigation | Not learner-exported. Success or expiry clears current lockout state. | Keep only active window/lock rows; `npm run db:cleanup` removes rows whose lock/window has passed. |
| Login consent acknowledgement | `POST /api/auth/app-session`; `consentAccepted: true`; redacted `auth.login.success` audit metadata | Boolean acknowledgement that the user confirmed the current terms, privacy notice, and guardian-consent condition before session creation | Prevent session creation without an explicit pre-login acknowledgement | Missing acknowledgement returns `AAIS_LOGIN_CONSENT_REQUIRED` and no session cookie. The audit marker is operational evidence, not a complete legal consent record. | Retain only as part of redacted operational audit/log policy unless the owner/institution approves a durable consent ledger. |
| Session revocations | `aais_session_revocations`; process memory in local development | Session token hash, hashed actor key, token expiry, revocation time | Invalidate logged-out sessions until original expiry | Not learner-exported. Rows expire when the original session expiry passes. | Retain only until `expires_at`; `npm run db:cleanup` removes expired rows after a dry run. |
| Monitoring and smoke evidence | Sentry when configured; Vercel/function logs; `npm run smoke:prod`; protected fixed-input AI live probe; external `npm run release:verify-ai-live` audit | Redacted route/status/error metadata, release/environment tags, provider role/model and manifest fingerprints, synthetic smoke status, live-canary/replay digests, privacy deletion/absence status, and signed audit metadata; no model output | Operations, alerting, production smoke and promotion proof | No learner export route. Monitoring, probes, formal-route canaries, and audit artifacts must not include raw learner text, cookies, tokens, credentials, private signing keys, prompts, provider bodies, model responses, full canary bodies, reports, or email-like fields. The AI live probe does not create learner sessions, consume learner quota, or persist its fixed synthetic prompt/output. The external gate uses a dedicated empty synthetic learner, verifies formal session persistence, then deletes its data and verifies absence. The after-deployment audit artifact is not injected into runtime readiness. | Configure Sentry, hosting/function logs, and the external signed release-audit artifact to a maximum of 30 calendar days; a shorter applicable legal, institution, incident-response, or provider rule wins. Provider-console settings and a redacted privacy/settings receipt are required because an env declaration alone is not proof. |
| AI model provider requests | Production `/api/learning/ai-guide` live calls to the independently approved Qwen primary or DeepSeek secondary | Cognitive Apprenticeship context, learner prompt, and bounded browser-extracted text from a supported attachment; AAIS sends no attachment source bytes | Learner-visible A1/A2 guide response generation | Provider payloads are not stored as provider logs by AAIS; resulting guide turns are stored in the learner session and exported/deleted there. Provider-side handling remains governed by each provider's separately approved contract. Production A1/A2 never returns deterministic content: two-provider exhaustion produces an explicit typed error. Deterministic generation is limited to local/development use and hidden A3/A4 background work. | Keep Production `RELEASE_BLOCKED` until both providers have a named owner plus approved DPA, data-use/model-training, prompt/attachment, retention/deletion, subprocessor, incident, and processing/data-region evidence. |

Research LRS isolation is stricter than the product inventory above. AAIS and MAIS use physically separate LRS stores/tenants and endpoint credentials; AAIS production, staging, and research are also physically separate. On the dedicated research deployment, both `AAIS_RESEARCH_MODE=true` and `AAIS_RESEARCH_REQUIRED=true` disable the generic product event/LRS mirror and legacy analytics/event export server-side, including when old `LRS_*` values are still present. AAIS accepts only the `https://www.aais.site/xapi/` namespace prefix, MAIS accepts only `https://www.mais.ac/xapi/`, and `mais-mvp.local` plus `www.mais.hk` are forbidden. The 828 intact historical AAIS statements in the mixed AAIS/MAIS external pool are a read-only legacy archive, not part of the new study. The new study uses an empty AAIS-only research store and never counts, replays, queries, or exports that archive. `npm run lrs:archive-legacy -- --expected-count 828 --stored-through <owner-approved-inclusive-provider-stored-ISO>` may inventory the archive only with read-only `AAIS_LEGACY_LRS_ENDPOINT`, `AAIS_LEGACY_LRS_USERNAME`, and `AAIS_LEGACY_LRS_PASSWORD`; the frozen boundary uses provider `stored`, not client `timestamp`, and separately reports post-cutoff rows. The receipt contains statement ids, content SHA-256 digests, and counts but no raw bodies, and a count mismatch is not completion. Command availability is not evidence that the external pool has actually been accessed.

## Export And Deletion Contract

- `GET /api/learning/privacy` requires the signed AAIS learner session and returns owner-scoped `learner-data` JSON with `cache-control: no-store`.
- The export can include raw learner artifacts, self reports, guide turns, successful attachment-receipt metadata, and events, so it is never used as a cohort analytics feed.
- `DELETE /api/learning/privacy` requires the signed learner session and actor-bound CSRF token.
- In Postgres mode, deletion removes the learner's `aais_lrs_outbox`, `aais_learner_task_state`, `aais_events`, and `aais_learner_sessions` rows.
- In local file mode, deletion removes the learner session JSON under `.aais-data/`.
- Deletion does not delete `aais_users` or `aais_user_auth_tokens`; account lifecycle remains an administrator or institution SSO action.
- Research withdrawal follows [docs/research-data-governance.md](./research-data-governance.md): stop collection within 1 business day, clear Postgres and outbox records and request external LRS physical deletion within 7 calendar days, and maintain a restore tombstone through the 35-day backup rotation. An xAPI void statement is not physical deletion.
- Research raw-text erasure is deliberately narrower than `DELETE /api/learning/privacy`: it blanks artifact, self-report, guide-message, AI-turn, and AI-action text and removes attachment-receipt metadata/file names from the learner-session payload while preserving unrelated product task state, events, analytics, and outbox history. Research facts and LRS statements are removed separately by scoped withdrawal/retention operations.
- An external LRS deletion stays open after an ordinary 2xx or 404. Database status becomes `confirmed` only when the provider response supplies an absence timestamp, a response-body SHA-256 that matches locally, and a detached receipt signature; the signature is also checked against the provider's registered signing authority during controlled case closure.
- Every research query/export applies the AAIS namespace filter on the server. Every experimental row requires `project_id`, `study_id`, `environment`, `participant_id`, `visit_id`, and `schema_version`; project, study, environment, and namespace are server-derived rather than client-authoritative.

## Retention Policy

For the named 30-participant research study, the 90/180/1825/35-day clocks and their derived ledger/receipt lifecycles are operative and are not pending. A protocol, ethics, legal, institution, or withdrawal requirement that is shorter takes precedence; extension requires prior written approval. General account, monitoring, and non-research cohort retention still requires the owner/institution decisions shown below.

| Data class | Operative research-study rule | Remaining external decision |
| --- | --- | --- |
| Encrypted identity correspondence | Delete within 90 calendar days after identity-map creation; AES-256-GCM key remains outside Postgres and backups | Confirm named PI and written-designated data custodian in the access register |
| Submitted/semantically saved raw text | Delete within 180 calendar days after participant visit completion; artifact autosave keeps a latest snapshot after the 600 ms/blur/save boundary, never a per-keystroke history, and raw text never enters research events, LRS, logs, or audit reports | Confirm protocol and consent cover the four allowed text classes and the disclosed autosave behavior |
| De-identified research events and LRS statements | Delete within 1825 calendar days after each event's server receipt; withdrawal physical-deletion SLA remains 7 calendar days | Confirm external LRS operator can physically delete statements and issue a receipt |
| HMAC participation ledger and operational receipts | Keep the HMAC admission/nonce reservation through identity deletion, then purge at the 1825-day fact boundary only after dependencies are gone. Receipts use explicit deadlines and status-gated cleanup. | Confirm key-version retirement and restricted operations-register custody. |
| Online encrypted backups | Daily backup with a rolling maximum of 35 calendar days; apply withdrawal tombstones to restores | Confirm provider plan, region, and recovery ownership |
| Account records and auth tokens | Keep account records separate from learner data; expire one-time tokens quickly | Account/audit retention period, disabled-account handling, SSO deletion behavior |
| Login lockouts and session revocations | Retain only while active security windows require them | Cleanup cadence and whether logs need an audit retention period |
| Monitoring/error data | Redact by default; no Session Replay; Sentry and hosting/function logs retained for no more than 30 calendar days | Verify provider-console retention settings and preserve a redacted configuration receipt; a shorter applicable rule wins |

## Processor, DPA, And Data-Region Register

Fill this register with written owner/provider evidence before live learners use the system. Qwen/DashScope and DeepSeek are separate processors: evidence for one cannot approve the other. The mandatory DeepSeek secondary may not be disabled to evade this gate. The DeepSeek row now has a dated Owner decision with explicit risk acceptance; that decision does not approve Qwen, a real learner cohort, or any other pending processor.

| Processor/provider | Current use | Required confirmation | Status |
| --- | --- | --- | --- |
| Vercel | Hosting, serverless runtime, deployment logs, environment variables | Team ownership, plan tier, production data region, log retention, DPA/subprocessor terms | Owner/provider pending |
| Neon/Postgres | Production learner/session/event/account database | Plan tier, backup/PITR window, data region, DPA/subprocessor terms, restore rehearsal | Owner/provider pending |
| External LRS | xAPI statement receiver from `aais_lrs_outbox` | Operator, endpoint region, DPA, deletion propagation, failed-statement retention, support contact | Owner/provider pending |
| Sentry | Optional client/server/edge error monitoring | Project ownership, DPA, region/log-retention, PII settings, no Session Replay unless reviewed | Owner/provider pending |
| Resend or email provider | Optional invite/password-reset delivery | DPA, email region, retention, sender-domain ownership | Owner/provider pending |
| Alibaba Cloud DashScope / Qwen | Required Production primary for A1/A2 (`qwen3.8-max`) | Named accountable owner; DPA/data-processing terms; processing and storage region; data-use/model-training, retention/deletion, subprocessors, prompt/attachment handling, incident contact, and budget controls | Owner/DPA/region/provider evidence pending — blocks Production promotion |
| DeepSeek | Required Production secondary for A1/A2 (`deepseek-v4-flash`) | Named accountable owner; DPA/data-processing terms; processing and storage region; data-use/model-training, retention/deletion, subprocessors, prompt/attachment handling, incident contact, and budget controls | Owner approved with explicit risk acceptance on 2026-08-21; approval id `aais-deepseek-processor-approval-20260821-v1`; review by 2026-09-20 or immediately upon provider-term change. No separate executed bilateral DPA was observed, and that gap is explicitly accepted rather than represented as a supplier signature. |

### Dated operator observations (not approvals)

The following 2026-08-21 observations narrow the unresolved decisions but do
not constitute a DPA, legal approval, processor appointment, or permission for
live learner traffic:

- The exact AAIS Vercel project is on the Pro team. Its Runtime Logs date
  selector allowed 2026-07-22 and disabled 2026-07-21 when inspected on
  2026-08-21, establishing the current 30-calendar-day console boundary. The
  selected Function Region was `iad1` (Washington, D.C., US East). The project
  had no custom alert rules. At team scope, sensitive-environment-variable
  enforcement and 2FA enforcement were disabled, while IP visibility in both
  the dashboard and Log Drains was enabled. These access/privacy settings need
  an accountable-owner decision; the console observations do not prove an
  executed Vercel DPA.
- No Sentry integration or Sentry environment configuration was present on the
  exact AAIS Vercel project, and no authenticated Sentry organization evidence
  was available. Sentry region, retention, DPA, access control, alerts, Session
  Replay state, and the privacy canary therefore remain unverified.
- DeepSeek's [current Privacy Policy](https://cdn.deepseek.com/policies/en-US/deepseek-privacy-policy.html)
  (last update 2026-02-10) says that downstream applications' end-user
  personal-data processing rules are not covered by that general policy; it
  says Personal Data is directly collected, processed, and stored in the
  People's Republic of China. Its retention period varies with data type,
  purpose, sensitivity, and legal requirements rather than providing a fixed
  AAIS-compatible maximum, and its corporate-group processing purposes include
  foundation-model training and optimization. The
  [DeepSeek Open Platform Terms](https://cdn.deepseek.com/policies/en-US/deepseek-open-platform-terms-of-service.html)
  separately place downstream notice, lawful-basis/consent, data-subject-rights,
  and organizational/security duties on the application operator. No executed
  DPA, fixed learner-input retention limit, training-use exclusion, subprocessor
  schedule, or approved cross-border/PRC processing decision was observed at
  inspection time. The Owner subsequently issued the explicit, time-bounded
  risk-acceptance decision below; the underlying provider gaps remain facts
  that must not be rewritten as supplier commitments.

### DeepSeek Owner approval — 2026-08-21

The AAIS Owner explicitly approved the current DeepSeek DPA/data-processing,
region, privacy, and provider-use-license decision on 2026-08-21. The durable
decision record is
`docs/evidence/deepseek-processor-approval-2026-08-21.json`, approval id
`aais-deepseek-processor-approval-20260821-v1`.

The approval appoints the DeepSeek Open Platform API as the required Production
secondary for bounded A1/A2 learner guidance and accepts the current public
Open Platform Terms, Terms of Use, and Privacy Policy as the governing
data-processing instrument. It explicitly accepts PRC processing and storage,
cross-border risk, variable provider retention, corporate-group foundation-
model training and optimization use, the lack of a customer-specific training
exclusion, the lack of a contract-specific subprocessor schedule, PRC law and
jurisdiction, and the absence of a separately executed bilateral DPA. The last
fact is an Owner risk acceptance—not evidence that DeepSeek signed a separate
DPA.

This approval permits the current API integration under the provider's license
terms, including downstream A1/A2 use and the provider's stated Input/Output
rights allocation. AAIS remains responsible for end-user notice, lawful basis
or consent, data-subject requests, minimization, security, monitoring, incident
response, and budget controls. AAIS sends no attachment source bytes and stores
no provider prompt/output log, but bounded extracted attachment text may be
sent under the approved runtime contract.

The decision expires on 2026-09-20 and invalidates immediately if DeepSeek
changes its terms, privacy policy, ownership, processing/storage region,
training use, or subprocessor position. It does not approve Qwen, a real minor
cohort, Vercel, Neon Production, Sentry, Resend, LRS, or any cohort-specific
legal basis. AAIS export/delete verifies AAIS-controlled data only and is not
provider-side deletion evidence.

The release privacy receipt is a redacted, signed digest that records review of
the exact processor-register version, Sentry/function-log maximum 30-day
retention, Session Replay disabled, and synthetic learner cleanup. It contains
no contract text, endpoint, secret, prompt, response, learner identity, or
provider body. Its presence does not replace owner/legal review of the source
documents; a pending register row cannot be made green by signing a receipt.
The external release verifier records a digest of its operational privacy
checks in the signed audit artifact, but does not feed that artifact back into
the already-running deployment. Processor-register approval remains a separate
owner/legal gate and is not inferred from the synthetic cleanup check.

## Consent And Minor-User Gate

The login page now requires an explicit acknowledgement before `POST /api/auth/app-session` creates a session. The acknowledgement covers `/terms`, `/privacy`, and the condition that a learner under the local legal age has parent/guardian consent. The API rejects missing acknowledgement with `AAIS_LOGIN_CONSENT_REQUIRED`, sets no session cookie, and records only redacted success metadata for accepted logins.

That code gate is still not a complete legal consent workflow for a school cohort with minors. Before a real cohort starts, the owner must document:

- First cohort institution, age range, region, and whether any learner is a minor.
- Applicable regime and institution policy, such as FERPA, COPPA, GDPR, PIPL, or local education-data rules.
- Whether consent comes from the learner, parent/guardian, institution, or a combined workflow.
- How formal consent is recorded, versioned, withdrawn, and connected to account disablement or learner-data deletion.
- Teacher/admin training language explaining that recommendations are support signals, not final grades or disciplinary decisions.

Until those answers are recorded, AAIS should remain limited to owner/developer testing, synthetic smoke accounts, or explicitly approved non-student testers.
