# AAIS Research Data Governance

This document is the enforceable operational baseline for the AAIS study described here. It covers exactly 30 participants, and each participant may complete exactly one experiment, represented by one `study_run_id` and one `visit_id`. A protocol or ethics approval may require a shorter retention period or narrower collection scope; the shorter or narrower rule controls. Any extension requires written approval before the original deadline.

This document does not by itself resolve legal basis, consent, processor/DPA, data-region, or institution-specific requirements. The Principal Investigator (PI) must close those gates before issuing a real participant account.

## Non-Negotiable Data Architecture

- Postgres is the sole source of truth for research events. Session JSON, browser state, teacher summaries, application logs, monitoring systems, the LRS, and local `.aais-data` files are derived or operational copies and must never be used as the authoritative research event ledger.
- Research mode must fail closed if Postgres, the research schema, the deployment version, the commit SHA, the study definition, or the required encryption key is unavailable. Local file fallback is not permitted for participant research data.
- The external LRS is a derived destination. Every LRS-eligible research event must originate from an immutable Postgres event row and retain the same deterministic event/statement identity through retries.
- Research events and their LRS outbox rows must be written atomically. A partial session, event, or outbox write is a failed operation and cannot be counted as collected evidence.
- On a deployment with either `AAIS_RESEARCH_MODE=true` or `AAIS_RESEARCH_REQUIRED=true`, the legacy product `aais_events` / `aais_lrs_outbox` mirror, in-memory LRS queue, health write, dead-letter replay, and generic LRS flush are disabled server-side even if old `LRS_*` credentials remain configured. Allowed raw text may still use the restricted learner-session layer, but the same study action must never create a second identifiable product-event or generic-LRS copy.
- AAIS and MAIS must use physically separate LRS stores/tenants and separate endpoint credentials. A namespace or query filter inside one shared external pool is not physical separation.
- AAIS production, AAIS staging, and AAIS research must also use three physically separate LRS stores/tenants and separate endpoint credentials. No environment may fall back to another environment's store.

## Participants, Runs, Visits, And Conditions

- The server generates a cryptographically random, opaque `participant_id`; it must not contain or be derived from a name, email address, account id, enrolment id, or sequence number.
- The study admits exactly 30 participants. Each participant has exactly one `study_run_id` and exactly one `visit_id`, and participates in exactly one experiment. Repeated start requests for the same visit must be idempotent or rejected; they must not create another run.
- One-participation is enforced by `aais_research_identity.aais_research_participation_ledger`, a separately permission-revoked HMAC admission ledger. It stores only the scoped HMAC admission fingerprint, opaque participant/run/visit ids, admission status, AES-GCM key version and nonce reservation, and lifecycle timestamps. It contains no plaintext identity or ciphertext. It survives deletion of the 90-day identity map, so a repeat start still resolves to the original run and a withdrawn admission remains blocked.
- The server admits only authenticated student actor ids listed in the signed `AAIS_RESEARCH_PARTICIPANT_ACTOR_IDS` roster. A valid student session outside that allowlist cannot create a participant or consume one of the 30 places. The formal roster contains exactly 30 unique ids; a smaller list is permitted only in the documented 3–5 participant rehearsal environment.
- Condition assignment is recorded before the first study event and is immutable for that run. Client-supplied participant, run, visit, condition, version, or commit values are never trusted as authority.
- Every experimental record, including the Postgres event, outbox payload, LRS statement, and controlled export row, has `project_id`, `study_id`, `environment`, `participant_id`, `visit_id`, and `schema_version`. Every event also has a stable `event_id`, `study_run_id`, `condition`, application version, commit SHA, per-visit event sequence, client event time, server receive time, outcome, and the fields needed to represent failure, retry, disconnection, reconnection, and AI latency.
- `project_id`, `study_id`, `environment`, and the xAPI namespace are derived by the server from approved deployment/study configuration. They cannot be supplied or overridden by the client. Every AAIS query and export must apply the AAIS namespace filter on the server, even when the request supplies narrower study or participant filters.
- The server receive time is authoritative for receipt. Client time is retained for interaction timing and clock-skew review, but it cannot overwrite the server value.

## Encrypted Identity Map

The identity correspondence is stored only in a dedicated identity-map table, separate from research events, the HMAC participation ledger, and restricted raw text. The table stores `participant_id`, AES-256-GCM ciphertext, a unique nonce/IV, authentication tag, key version, and lifecycle timestamps. It must not store plaintext identity fields or the HMAC admission fingerprint.

`AAIS_RESEARCH_IDENTITY_ENCRYPTION_KEY` is a rotatable 32-byte encryption key and `AAIS_RESEARCH_IDENTITY_FINGERPRINT_KEY` is a separate, stable 32-byte HMAC key used only for admission, one-visit, and withdrawal matching. Both are encoded for the deployment secret manager. Neither key may be stored in Postgres, migration data, source control, logs, monitoring, exported evidence, or an application/database backup. A backup may contain identity-map ciphertext/nonce/tag/key version and the separate ledger's scoped HMAC fingerprint/nonce reservation, but it must not contain either key. Decryption, encryption-key rotation, and access to the stable fingerprint key are restricted to the PI and a written-designated data custodian. The fingerprint key must remain stable through the participation-ledger and withdrawal-tombstone lifetime; rotating it requires a reviewed migration of every live admission fingerprint before collection resumes.

The database enforces nonce uniqueness twice: on live identity-map rows and on the longer-lived participation ledger, each over `project_id + study_id + environment + lrs_namespace + key_version + nonce`. A collision fails the entire admission transaction closed. A key version must be retired before its final participation-ledger nonce reservation is purged; it must never be reintroduced after purge. Authentication failure, a reused nonce, a missing/unknown key version, or a fingerprint-key mismatch is a research security incident and produces only a redacted alert.

## Raw Text Collection Boundary

Only these four raw-text classes may be retained, and only after the stated submission or semantic-save boundary:

1. An explicitly submitted AI prompt.
2. A completed AI response returned for that submitted prompt.
3. An artifact snapshot persisted by the existing semantic save path: the 600 ms idle debounce, editor blur, save-and-close, or download. The store keeps the latest snapshot, not a per-change or per-keystroke history.
4. A submitted self-report.

These texts may exist only in the learner-session store or a separately access-controlled restricted raw-text layer. Research event rows, xAPI/LRS statements, application logs, monitoring reports, reconciliation reports, and export audit records must never contain raw text. Research events may contain controlled metadata such as content class, character count, outcome, latency, and a non-reversible restricted-record reference.

Controlled metadata is an allowlist, not a channel for copying browser strings. `link_host` may contain only the category `aais_site` or `external`; the literal hostname is never retained. `mime_type` may contain only `text/plain`, `text/markdown`, `text/csv`, or `application/pdf`. If a browser reports any unknown or non-allowlisted MIME token, AAIS omits `mime_type` from the event instead of forwarding, normalizing, hashing, or logging that token.

Research retention and withdrawal use a restricted erasure operation, not the learner-owned full product deletion. That operation blanks artifact snapshots, self-reports, guide-message text, AI turn content, and AI action text in the learner-session payload while preserving task status, scaffold state, de-identified product events, task-state mirrors, analytics history, and outbox history outside the approved raw-text scope. The research fact and LRS cleanup steps below remain separate, scoped operations; the restricted raw-text erasure must never be implemented by deleting unrelated product history.

Every allowed learner-session raw-text mutation is coordinated with withdrawal through an opaque, visit-scoped write lease. Its five-minute `expires_at` value is observation-only for stale-writer alerts; it does not expire, release, or weaken the safety fence. A session save holds its lease until the product-store write finishes; an AI guide submission holds its lease through the streamed response and final persistence. Beginning withdrawal atomically changes the visit to `withdrawing` before counting unreleased leases. Once that barrier exists, no new raw-text lease, research event, or visit completion is admitted. If an earlier write still owns an unreleased lease, the custodian's withdrawal request returns HTTP `409` with `AAIS_RESEARCH_WITHDRAWAL_PENDING`; the visit remains `withdrawing`, and the custodian retries the same withdrawal only after the writer explicitly releases the lease. A timestamp that has passed requires operator investigation and remains blocking. The 409 never authorizes retrying the participant write or reopening collection. Raw-text erasure and final withdrawal are prohibited until the unreleased-lease count is zero.

AAIS must not collect or retain any of the following for this study:

- individual keystroke or key-up/key-down records;
- unsubmitted drafts or per-change text deltas;
- editor selection, cursor position, clipboard content, or pointer movement;
- attachment file name or attachment body by default;
- raw text embedded in event `detail`, LRS extensions, logs, error messages, traces, screenshots, or operational reports.

An attachment can enter the allowed-text set only through an approved protocol amendment, updated consent language, and a reviewed implementation change. Until all three exist, both the attachment file name and attachment body are excluded.

## Access Control And Export

- Identifiable data and restricted raw text are accessible only to the Principal Investigator (PI) and a written-designated data custodian named in the signed access register.
- A researcher role is limited to the controlled, de-identified, per-event research export, and the authenticated actor id must also appear in the signed `AAIS_RESEARCH_EXPORT_ACTOR_IDS` grant. Assigning the generic role alone is insufficient. It cannot decrypt the identity map or retrieve restricted raw text.
- Teacher and admin roles have no research-data access by default. Product-level teacher/admin authorization does not grant research access, and the teacher cohort-summary export must not be reused for research extraction.
- Developers, support staff, and infrastructure operators receive no routine research-data access. Emergency access requires a written PI authorization, a time limit, and an audited incident or support ticket.
- The institutional access register records every approved identity-map/raw-text access and retention exception with actor, purpose, scope, timestamp, and outcome. The application writes count-only receipts for successful exports, retention runs, withdrawals, and LRS deletions; denied or failed API attempts enter the redacted security log. No audit surface records raw text.

The controlled researcher export reads only from Postgres research event rows, applies study/run/participant/sequence filters server-side, orders deterministically, and excludes identity-map and raw-text fields. Each request must declare one controlled purpose (`approved_analysis`, `reconciliation`, `quality_audit`, or `replication`). Each successful export produces a no-store response plus an audit receipt containing purpose, outcome, filters, row count, schema version, commit SHA, and file checksum. A teacher summary export is not acceptable evidence for this contract.

Legacy product event exports and product/teacher analytics are disabled on the dedicated research deployment. Participant privacy access to their separately controlled learner data is not a substitute for, and cannot be elevated into, a research event export.

## Experimental LRS Boundary

- `https://www.aais.site/xapi/` is the only allowed AAIS namespace prefix. The experiment namespace is derived by the server beneath that prefix from the approved project, study, and environment configuration; the client cannot choose it.
- `https://www.mais.ac/xapi/` is the only allowed MAIS namespace prefix. `mais-mvp.local` and `www.mais.hk` are forbidden namespace authorities and must be rejected rather than normalized or migrated into new statements.
- The AAIS research endpoint must use only `AAIS_RESEARCH_LRS_ENDPOINT`, `AAIS_RESEARCH_LRS_USERNAME`, and `AAIS_RESEARCH_LRS_PASSWORD`. Research delivery must not fall back to `LRS_ENDPOINT`, `LRS_USERNAME`, or `LRS_PASSWORD`.
- The AAIS research store/tenant and credentials are physically separate from AAIS production, AAIS staging, and every MAIS store/tenant. Namespace filtering remains mandatory but is not a substitute for this isolation.
- The statement id is deterministic from the immutable Postgres research `event_id`. Retries reuse the same statement id.
- A `client_event_id` is bound transactionally to one canonical client payload: visit, client time, event name, outcome, AI latency, and canonical JSON `detail`. An exact retry returns the original event and sequence; reusing the id with any different canonical field fails with `AAIS_RESEARCH_EVENT_CONFLICT` and writes no second event or outbox row.
- Research-event outbox rows are one-to-one with LRS-eligible Postgres rows. Research events must not use latest-write-wins coalescing.
- Immediately before every PUT, the outbox worker joins the claimed row back to its same-scope immutable Postgres event and requires an exact match for identifiers, namespace/store scope, condition, schema/application/commit versions, sequence, timestamps, event/outcome/counters/latency, controlled detail, and eligibility. A missing fact or any drift blocks the network request and records `research_lrs_payload_fact_mismatch` for retry/dead-letter handling.
- Statements include the server-derived `project_id`, `study_id`, `environment`, and namespace plus `participant_id`, `visit_id`, `schema_version`, de-identified experiment context, condition, application version, commit SHA, sequence, client time, server receive time, outcome, connectivity/retry state, and AI latency when applicable. They contain no identity correspondence or raw text.
- LRS delivery status never changes the Postgres fact. A failed delivery remains visible in the outbox until successful delivery, approved purge, or withdrawal handling.

### Legacy External Pool

The existing 828 historical AAIS statements have intact content, but they share an external pool with MAIS statements. Treat that pool as a read-only legacy archive. It is not an AAIS-only research store, and shared-pool placement is an isolation defect rather than evidence of content corruption.

No historical archive statement may be replayed into, queried as part of, exported with, or counted toward the new experiment. The new experiment starts with an empty, physically isolated, AAIS-only research store. Reconciliation baselines begin at zero for that store and include only rows whose server-derived project, study, environment, and `https://www.aais.site/xapi/` namespace match the new experiment.

Inventory the legacy archive only with credentials restricted to read-only access to the old mixed pool:

```bash
AAIS_LEGACY_LRS_ENDPOINT=<legacy-mixed-pool-endpoint> \
AAIS_LEGACY_LRS_USERNAME=<read-only-username> \
AAIS_LEGACY_LRS_PASSWORD=<read-only-password> \
npm run lrs:archive-legacy -- --expected-count 828 --stored-through <owner-approved-inclusive-provider-stored-ISO> --output ./aais-legacy-lrs-archive-manifest.json
```

`AAIS_LEGACY_LRS_ENDPOINT`, `AAIS_LEGACY_LRS_USERNAME`, and `AAIS_LEGACY_LRS_PASSWORD` authorize GET-only inventory of the old mixed pool. They must never be used for new statement delivery, outbox flush, deletion, or access to the clean research store. Do not substitute the research, production, staging, or generic LRS credentials.

When the shared pool contains later AAIS rows, `--stored-through` must be the owner-approved inclusive provider `stored` boundary for the historical set. Client-supplied `timestamp` is not an archive boundary. The receipt separately reports the total AAIS pool, post-cutoff count and set digest, and provider-stored range. The data-bearing archive receipt fields are limited to statement ids, per-statement content SHA-256 digests, and counts. Its operational envelope may also contain manifest SHA-256, time-range/classification metadata, and explicit redaction markers; it contains no raw statement body, learner text, or credentials. The command refuses to overwrite an existing receipt. Store the mode-0600 receipt in the restricted study operations register and never commit or stage it.

Archive inventory is complete only when the receipt status is `pass`, `statementCount` and `expectedStatementCount` both strictly equal 828, statement ids are unique, and namespace integrity passes. A `count_mismatch`, including any count other than exactly 828, is not a completed archive; investigate the discrepancy rather than changing the expected count to make the command pass.

The presence of the script, command, documentation, or synthetic tests does not prove that this repository run has actually accessed the external legacy pool. Only an owner-authorized live run with the read-only legacy credentials and its verified 828-statement receipt establishes that evidence.

## Operative Retention Schedule

The four configured clocks (90/180/1825/35 days) and the derived ledger/receipt lifecycles below are operative, not pending:

| Data class | Maximum default retention | Start and required action |
| --- | --- | --- |
| Encrypted participant identity map | 90 calendar days | Delete the ciphertext correspondence no later than 90 calendar days after the identity-map row is created. This conservative clock starts before any later dataset lock. |
| Allowed restricted raw text | 180 calendar days | Delete no later than 180 calendar days after that participant's visit completion. |
| De-identified Postgres research events and external LRS statements | 1825 calendar days | Delete each event and its external statement no later than 1825 calendar days after the event's server receipt. This conservative per-event clock starts before any later dataset lock. |
| Restricted HMAC participation/admission ledger | 1825 calendar days | Retain through identity-map deletion to enforce one participation and withdrawal. Purge at the participant fact deadline only after raw text and local events are absent and any withdrawal's physical-LRS deletion is confirmed. Retire the associated encryption-key version before purging its last nonce reservation. |
| Operational receipts | 1825 calendar days, with LRS deletion receipts retained at least 35 days after request | Export audits include schema version and commit SHA. Export/retention/LRS deletion/archived-legacy receipts have explicit `retention_due_at`; purge only scoped due rows. An LRS deletion receipt must be `confirmed` and detached from any live withdrawal before purge; an uncompleted legacy inventory is never auto-purged. |
| Online encrypted backups | 35 calendar days | Maintain a rolling maximum of 35 calendar days; expired backup generations must be destroyed automatically. |

If the approved protocol, consent, law, institution, or participant withdrawal requires a shorter period, the shorter period controls. Extending any deadline requires prior written PI approval and any required ethics/institution approval; the approval, reason, data classes, and revised deletion date are recorded in the access register.

The PI or written-designated data custodian records visit completion through `POST /api/research/visit/complete`; the server fixes the 180-day raw-text deadline and rejects completion of a withdrawn or unknown run. A scheduler calls only `POST /api/research/retention?limit=100` with the dedicated `AAIS_RESEARCH_RETENTION_TOKEN`. The worker deletes due product raw text before deleting the encrypted identity mapping, preserves the restricted HMAC admission/nonce reservation through its fact deadline, creates `reason='retention'` physical-LRS deletion requests before deleting due Postgres events, safely purges due operational receipts, and writes a count-only `aais_research_retention_runs` receipt with its own deadline. A `blocked` receipt means an active visit has crossed its identity deadline: pause collection and treat it as a research-data incident. After each run, the separate LRS deletion worker must drain and verify the queued physical deletions. These application controls do not prove backup rotation; the provider's 35-day policy and destruction/restore receipts remain required external evidence.

## Backup And Restore

- Create an encrypted Postgres backup every day. Online generations are retained for at most 35 calendar days.
- Do not place `AAIS_RESEARCH_IDENTITY_ENCRYPTION_KEY`, `AAIS_RESEARCH_IDENTITY_FINGERPRINT_KEY`, LRS credentials, database credentials, session secrets, or export files in a backup.
- Rehearse a restore to an isolated non-production target every quarter. The restored target must have outbound LRS delivery disabled and access limited to the PI and written-designated data custodian.
- Each quarterly rehearsal verifies required tables and functions, both nonce-uniqueness constraints, participation-ledger coverage, encrypted identity-map readability with an independently supplied key, one-participation after identity deletion, withdrawal by `study_run_id` after identity deletion, event-sequence continuity, event/outbox one-to-one membership, and aggregate counts.
- Reapply the withdrawal tombstone ledger before anyone can query a restored backup. A restored participant who has withdrawn must remain inaccessible and must be re-deleted before the restore can pass.
- Preserve a redacted restore receipt with backup generation, start/end time, schema and migration versions, counts, set-difference result, tombstones applied, and approver. Do not preserve row payloads or secrets.

## Synthetic Research Rehearsal SOP

After the research migrations have been applied to an isolated Postgres target, run the fixed rehearsal before participant 1:

```bash
npm run study:rehearse -- --participants 4 --output ./aais-research-rehearsal.json
```

`--participants` accepts only 3, 4, or 5 and defaults to 4. The command runs exactly seven metadata-only semantic operations per synthetic participant in one real Postgres transaction. It creates the encrypted identity-map, run, visit, event, and outbox records, then verifies that actual semantic operations = Postgres research events = LRS-eligible outbox events = mock LRS statement ids. Both counts and exact event-id sets must match, and every visit must have continuous event sequence values beginning at 1. Coverage must pass for success, failure, retry, disconnection, reconnection, and measured AI latency.

The default is a dry rehearsal that rolls back the transaction after reconciliation. Persistent rehearsal data is permitted only with written approval and both guards:

```bash
AAIS_RESEARCH_REHEARSAL_APPROVED=true \
AAIS_RESEARCH_ENVIRONMENT=research \
npm run study:rehearse -- --participants 4 --commit --output ./aais-research-rehearsal.json
```

Store the mode-0600 report in the restricted study operations register; it must omit plaintext identity, raw learner text, and credentials. In `--commit` mode the command requires the deployment's research encryption key, separate fingerprint key, key version, and LRS store id; it encrypts with the same scope-bound AAD as production and verifies decryption before commit. This command exercises a fixed UI-semantic manifest but does not drive a browser, so retain separate browser evidence that each named operation is wired to the actual UI. It uses mock LRS statement ids and does not perform actual external LRS delivery. Launch of the clean AAIS-only research store remains blocked until an external provider receipt proves physical store/tenant and credential isolation, a zero-statement baseline, successful delivery reconciliation, and the physical-deletion workflow.

### Browser Rehearsal v4 Evidence Contract

Before the first browser action, freeze the v4 action manifest. After each authenticated research bootstrap, obtain only the opaque observed visit record from Playwright localStorage. Reduce the browser transport capture to the strict acknowledgement metadata below and delete the raw trace. All listed objects use exact key allowlists; extra fields, including `actor_id`, account names, or any request/response content, invalidate the artifact.

- The manifest root contains exactly `evidence_schema_version`, `declared_at`, `declared_before_run`, `project_id`, `study_id`, `environment`, `lrs_namespace`, `lrs_store_id`, `participant_count`, `counting_contract`, and `participants`. Its evidence schema is at least 2 and `declared_before_run` is `true`. The immutable `lrs_store_id` is required even when delivery is disabled because reconciliation binds it to every outbox payload. `counting_contract` contains exactly `physical_ui_triggers`, `expected_semantic_event_records`, and `note`. Each participant contains exactly `slot`, `physical_ui_triggers`, and `expected_events`; each ordered expected event contains exactly `event_name`, `outcome`, and one-based `sequence`.
- The observed-visits root contains exactly `evidence_schema_version`, `observed_at`, `source`, `project_id`, `study_id`, `environment`, `lrs_namespace`, and `participants`. `source` must be the literal `Playwright localStorage after each authenticated research bootstrap`. Each observed participant contains exactly `slot`, `participant_id`, `study_run_id`, `visit_id`, and `condition`. The three ids are UUIDs and are unique across the 3–5 participant slots.
- Every sanitized transport acknowledgement contains exactly `route`, `method`, `status`, `client_event_id`, and `visit_id`. An ordinary semantic event is acknowledged only by `/api/research/events`, `POST`, `201`; a successful `account_logout` is acknowledged only by `/api/auth/app-session`, `DELETE`, `200`. Reconciliation binds each complete tuple to one exact Postgres event and rejects aggregate-only evidence, route swaps, duplicates, missing acknowledgements, and extras.

Run the reconciler with the two independent provenance inputs:

```bash
npm run study:reconcile-browser -- \
  --manifest <manifest.json> \
  --observed-visits <observed-visits.json> \
  --transport-summary <transport-summary.json> \
  --output <browser-reconciliation.json> \
  --application-mode production-build \
  --lrs-counter-url <local-counter-url> \
  --runtime-build-attestation <runtime-build-attestation.json> \
  --external-lrs-attestation <external-lrs-attestation.json>
```

The runtime-build attestation binds a production runtime build id and bundle SHA-256 to the same project/study/environment/namespace and the commit recorded in the events. The external-LRS attestation is a complete, checksummed, sanitized network capture whose time window begins no later than the first visit start and ends no earlier than the final server-received event; full pass also requires `observed_external_lrs_requests=0`. If either argument is omitted, its gate remains `not_verified` and the maximum result is `limited-pass`, even when the count, set, sequence, transport, Postgres, and outbox gates all pass. A commit/build mismatch, a nonzero observed external request count, an incomplete capture, or a capture-window mismatch likewise cannot produce `pass`.

A zero local mock counter proves only that the endpoints configured to use that counter received no requests. It cannot independently prove that the application or host made no external network contact. The browser-run contact gate requires the complete external-LRS network attestation; even a verified zero-contact capture is not a substitute for the provider's physical-isolation, zero-baseline, delivery, and physical-deletion receipts.

Logout success is established only by the exact visit- and client-event-bound `DELETE /api/auth/app-session` 200 acknowledgement. If the server revokes the session and the browser clears local authentication state but that final acknowledgement is absent or cannot be rebound, AAIS exposes a logout ACK gap. This is a fail-evident incident, not inferred success: the logout event and the participant evidence are not marked complete, and aggregate counters, cookie absence, or a redirect must not be used to manufacture the missing acknowledgement.

## Withdrawal And External LRS Deletion SOP

1. Timestamp the withdrawal request and open a restricted deletion record. Resolve the opaque participant/run/visit through the restricted participation ledger by `study_run_id`; the database withdrawal must not depend on an identity-map row still existing. If the identity row still exists, only the PI or written-designated data custodian may decrypt it to delete product raw text. If it has already expired, withdrawal may proceed only when the visit already records raw-text deletion evidence.
2. Within 1 business day, stop new collection by beginning withdrawal. The database first changes the visit to `withdrawing`; this barrier immediately rejects new raw-text leases, research events, completion, and queued client events. Revoke the study visit and do not reopen it to finish a participant operation.
3. If an already-admitted raw-text mutation still has an unreleased lease, the withdrawal call returns HTTP `409` with `AAIS_RESEARCH_WITHDRAWAL_PENDING`. Keep the `withdrawing` barrier in place and retry only the custodian's same withdrawal request after the writer explicitly releases the lease. An elapsed `expires_at` is an alert for operator investigation, never authority to ignore or delete the lease. Do not retry or accept the participant write. Within 7 calendar days, remove the participant's restricted raw text, Postgres research events, identity-map row, and pending/retry/dead-letter outbox rows, but only when the unreleased-lease count is zero. Mark the opaque participant/run/visit and restricted HMAC admission row withdrawn. The HMAC tombstone contains no plaintext identity, ciphertext, or raw text and remains only through its bounded fact/confirmed-deletion lifecycle. Record count-only before/after evidence.
4. Within the same 7 calendar days, submit a physical deletion request for every statement id generated for the participant, including pending/retry/dead-letter rows whose remote delivery state may be uncertain, and retain the LRS/operator deletion receipt. The outbox worker claims one row immediately before each PUT with a two-minute lease and bounds every client request to 30 seconds. Withdrawal locks the participant's outbox rows against new claims, cancels them, and delays DELETE until after every known lease; the deletion worker also leases one row at a time. These controls prevent another AAIS worker from starting a known PUT, but a client timeout does not prove that a provider has stopped processing an earlier request. Do not close on the first 404. Wait through the provider's documented maximum in-flight settlement window, query the exact statement id, repeat physical DELETE if it appears, and retain a final provider-signed absence receipt. The worker moves a deletion to `confirmed` only when an authenticated provider response supplies four evidence headers: `x-aais-lrs-absence-confirmed-at` as an exact ISO timestamp, `x-aais-lrs-absence-receipt-sha256` matching the received response bytes, `x-aais-lrs-absence-receipt-key-id` matching the pinned key id, and `x-aais-lrs-absence-receipt-signature` as an unpadded base64url Ed25519 signature. AAIS verifies the signature in-process against the pinned canonical DER SPKI over this exact compact UTF-8 JSON property order: `{"schema":"https://www.aais.site/xapi/receipts/absence/v1","store_id":"<store id>","statement_id":"<statement id>","confirmed_at":"<exact ISO timestamp>","receipt_sha256":"<lowercase SHA-256 of response bytes>","key_id":"<pinned key id>"}`. This binds the store, statement, confirmation time, received receipt bytes, and key id. An ordinary 2xx/404, missing key, malformed envelope data, wrong key id, or failed signature remains `retry` with `research_lrs_absence_confirmation_pending`, regardless of attempt count. The application stores the digest, timestamp, verified key id, and signature. If the provider cannot state the settlement window or issue verifiable evidence, the deletion remains open and formal collection stays blocked. An xAPI void statement does not satisfy physical deletion and never closes the case.
5. Add a non-identifying withdrawal tombstone to the restore exclusion ledger. Apply it to every restore until all affected online backups have disappeared through the 35-day rolling backup cycle.
6. Close the withdrawal only when scoped Postgres event and outbox queries return zero, the external LRS physical-deletion receipt is attached, the HMAC tombstone demonstrably rejects a new visit, collection is disabled, and the backup tombstone expiry is scheduled. The close record contains no plaintext identity or raw text.

## Incident Escalation

The following are research-data incidents: raw text in an event/LRS/log/export audit; plaintext identity in Postgres; encryption-key exposure; AES-GCM nonce reuse or loss of a live nonce reservation; a visit without its HMAC admission row; unauthorized access or export; event/outbox count or set mismatch; sequence duplication/gap; events accepted after withdrawal; raw-text erasure attempted while a write lease is live; a logout ACK gap; missed retention deletion; or an unverified LRS deletion. A logout ACK gap remains fail-evident and cannot be relabelled as success merely because the session, cookie, or browser state was cleared.

On detection, pause affected collection and LRS delivery, preserve redacted audit evidence, and notify the PI and data custodian immediately. The PI assigns severity and required institution/ethics/participant/provider notifications. Rotate compromised keys or credentials, remove exposed data, reconcile the affected event sets, document root cause and corrective action, and resume collection only after written PI approval.

## Required Runtime Configuration

The following values are configured in the deployment secret/configuration system, not committed files:

- `AAIS_RESEARCH_DATABASE_URL`: dedicated research Postgres fact-store connection; research mode has no product-database or file fallback. Apply migrations with `npm run db:migrate:research`.
- `AAIS_RESEARCH_DATABASE_INSTANCE_ID`: immutable operations-register identifier for the physically separate research Postgres instance. Runtime rejects a URL or instance id matching configured AAIS product/production/staging or MAIS database targets; the infrastructure receipt remains authoritative proof.
- `AAIS_RESEARCH_REQUIRED=true`: deployment-purpose sentinel; keeps `/learning` terminal-blocked and the legacy product event/LRS/analytics/export data plane disabled if the collection switch is accidentally missing or false.
- `AAIS_RESEARCH_MODE=true`: activates the fail-closed research contract.
- `AAIS_RESEARCH_PROJECT_ID`: approved immutable AAIS project identifier used to derive each record's `project_id`.
- `AAIS_RESEARCH_STUDY_ID`: approved immutable study identifier used to derive each record's `study_id`.
- `AAIS_RESEARCH_ENVIRONMENT`: approved `research` environment identifier; it must not resolve to production or staging.
- `AAIS_RESEARCH_REHEARSAL_APPROVED=true`: permits the rehearsal's explicit `--commit` mode only after written approval and only when `AAIS_RESEARCH_ENVIRONMENT=research`; omit it for the default rollback run.
- `AAIS_RESEARCH_REHEARSAL_MODE=true`: permits a 3–5 id synthetic browser roster only together with `AAIS_RESEARCH_REHEARSAL_APPROVED=true` in the research environment. When false or omitted, runtime requires exactly 30 roster ids.
- `AAIS_RESEARCH_LRS_NAMESPACE`: optional assertion of the exact namespace computed by the server from study and environment beneath `https://www.aais.site/xapi/`. If omitted, the server derives it; a configured mismatch fails closed. It is never a client override.
- `AAIS_RESEARCH_LRS_STORE_ID`: immutable provider/operations-register id for the clean environment-specific tenant/store; queued rows retain this id so credential drift cannot close deletion against a different store.
- `AAIS_RESEARCH_LRS_RECEIPT_VERIFYING_KEY_ID` and `AAIS_RESEARCH_LRS_RECEIPT_VERIFYING_KEY_SPKI`: pinned provider key id and canonical base64-encoded DER Ed25519 SPKI used by the server to verify physical-absence receipts. Both are mandatory for formal collection. An approved rehearsal may omit them, but then no deletion can become `confirmed`.
- `AAIS_RESEARCH_IDENTITY_ENCRYPTION_KEY`: base64-encoded 32-byte AES-256-GCM key kept outside Postgres and backups.
- `AAIS_RESEARCH_IDENTITY_FINGERPRINT_KEY`: separate stable base64-encoded 32-byte HMAC key kept outside Postgres and backups; it must not silently rotate during the study or withdrawal-tombstone lifetime.
- `AAIS_RESEARCH_PARTICIPANT_ACTOR_IDS`: comma-separated signed participant roster. Formal collection requires exactly 30 unique authenticated student actor ids; browser rehearsal uses only its approved 3–5 synthetic ids.
- `AAIS_RESEARCH_PI_ACTOR_IDS`: authenticated actor ids for the named PI access grant.
- `AAIS_RESEARCH_DATA_CUSTODIAN_ACTOR_IDS`: authenticated actor ids with written custodian appointments.
- `AAIS_RESEARCH_EXPORT_ACTOR_IDS`: authenticated researcher actor ids named in the signed export-access grant; the `researcher` role by itself never authorizes an export.
- `AAIS_RESEARCH_EXPORT_ENABLED=true`: enabled only after access and export audit checks pass.
- `AAIS_RESEARCH_LRS_ENDPOINT`, `AAIS_RESEARCH_LRS_USERNAME`, and `AAIS_RESEARCH_LRS_PASSWORD`: credentials for the physically isolated AAIS-only research store. Generic `LRS_ENDPOINT`, `LRS_USERNAME`, and `LRS_PASSWORD` are forbidden fallbacks in research mode.
- `AAIS_RESEARCH_LRS_OUTBOX_FLUSH_TOKEN`: dedicated bearer used only by the research outbox/deletion worker; it must not reuse product or MAIS operations tokens.
- `AAIS_RESEARCH_RETENTION_TOKEN`: separate least-privilege bearer used only by the scheduled retention worker; browser sessions and researcher/admin roles cannot substitute for it.
- `AAIS_RESEARCH_LRS_EVENT_FLUSH_SCHEDULE_ID`, `AAIS_RESEARCH_LRS_DELETION_SCHEDULE_ID`, and `AAIS_RESEARCH_RETENTION_SCHEDULE_ID`: three distinct external scheduler configuration ids. Each job calls its documented `POST` route; no state-changing GET cron is accepted.
- `AAIS_RESEARCH_DATABASE_ISOLATION_RECEIPT_SHA256`, `AAIS_RESEARCH_LRS_ISOLATION_RECEIPT_SHA256`, `AAIS_RESEARCH_LRS_ZERO_BASELINE_RECEIPT_SHA256`, `AAIS_RESEARCH_LRS_PUT_DELETE_RECEIPT_SHA256`, `AAIS_RESEARCH_BACKUP_POLICY_RECEIPT_SHA256`, `AAIS_RESEARCH_RESTORE_RECEIPT_SHA256`, and `AAIS_RESEARCH_LEGACY_ARCHIVE_RECEIPT_SHA256`: seven independent SHA-256 digests of redacted, signed infrastructure and provider evidence files held in the restricted operations register.
- `AAIS_RESEARCH_ACCESS_REGISTER_RECEIPT_SHA256`, `AAIS_RESEARCH_CONSENT_LEGAL_BASIS_RECEIPT_SHA256`, `AAIS_RESEARCH_DPA_RECEIPT_SHA256`, and `AAIS_RESEARCH_DATA_REGION_RECEIPT_SHA256`: four independent SHA-256 digests for the current signed access/custodian register, approved consent and legal-basis workflow, executed processor agreements, and provider data-region evidence.
- `AAIS_RESEARCH_DAILY_BACKUP_RECEIPT_SHA256` and `AAIS_RESEARCH_BACKUP_DESTRUCTION_RECEIPT_SHA256`: independent digests for the most recent successful encrypted daily backup and the rolling 35-day destruction evidence. A backup policy statement is not operational backup or destruction evidence.
- `AAIS_RESEARCH_GOVERNANCE_MANIFEST_RECEIPT_SHA256`: digest of the sanitized, successful output from `npm run study:verify-governance-evidence`; it binds the thirteen source-receipt digests to one signed, scope-specific restricted manifest without exposing source paths or contents.
- `AAIS_RESEARCH_GOVERNANCE_MANIFEST_VERIFIED_AT`, `AAIS_RESEARCH_GOVERNANCE_MANIFEST_VALID_UNTIL`, `AAIS_RESEARCH_DAILY_BACKUP_COMPLETED_AT`, and `AAIS_RESEARCH_BACKUP_DESTRUCTION_OBSERVED_AT`: exact UTC timestamps copied only from a successful verifier report. Runtime requires manifest verification and daily-backup completion no more than 36 hours old, a still-current manifest, and 35-day destruction evidence no more than 45 days old.

All fourteen configured receipt digests must be valid and pairwise distinct. A placeholder, URL, script, copied digest, unsigned manifest, stale report, or receipt declaration without its restricted source artifact is not evidence. The verifier hashes source bytes but neither parses nor emits document content. Its success proves file integrity, scope, manifest signature, required metadata, restricted permissions, and time-window checks; it does not independently validate the legal sufficiency of consent/DPA terms or an embedded institution/provider signature.
- `AAIS_APP_VERSION`: human-readable application version recorded on every event.
- `VERCEL_GIT_COMMIT_SHA`, with `AAIS_COMMIT_SHA` only as an approved non-Vercel fallback: immutable commit recorded on every event.
- `AAIS_RESEARCH_IDENTITY_RETENTION_DAYS=90`.
- `AAIS_RESEARCH_RAW_TEXT_RETENTION_DAYS=180`.
- `AAIS_RESEARCH_EVENT_RETENTION_DAYS=1825`.
- `AAIS_RESEARCH_BACKUP_RETENTION_DAYS=35`.
- `AAIS_LEGACY_LRS_ENDPOINT`, `AAIS_LEGACY_LRS_USERNAME`, and `AAIS_LEGACY_LRS_PASSWORD`: read-only credentials for the old mixed-pool inventory command only; never new delivery credentials.

Retention configuration may be lower to implement a shorter approved rule. A value above the defaults must fail closed unless a current written exception is registered.

Formal `getOrCreateVisit` and event ingestion enforce this launch gate at runtime, not only in a checklist: approved PI/custodian/export grants, enabled controlled export, distinct strong worker credentials, three distinct POST schedules, dedicated LRS configuration, all fourteen pairwise-distinct evidence digests, and current governance/backup timestamps must be present. The readiness report exposes `applicationReady` separately from `studyLaunchReady`; only the latter authorizes a 30-person formal run. An explicitly approved 3–5 synthetic rehearsal uses the rehearsal gate and cannot silently become a formal roster.

The restricted-manifest procedure is `npm run study:verify-governance-evidence` and is specified in `OPERATIONS.md`. It requires an exact thirteen-category source manifest, an exact-byte detached Ed25519 signature, a pinned canonical DER SPKI/key id, mode-0700 register root, mode-0600 regular source files, unique verified SHA-256 values, current control windows, a daily backup completed within 36 hours, and 35-day destruction evidence observed within 45 days over at least a 35-day coverage window. Its sanitized report contains no source path, document content, identity, or credential. A verifier `pass` establishes manifest signature, byte identity, scope, permissions, declared-signature status, and freshness only; it is not a legal opinion and does not independently validate embedded signatures or provider/institution claims.

## Run Gate And Acceptance Evidence

Before participant 1 begins, the PI and data custodian must verify:

- the signed protocol, consent workflow, 30-participant roster boundary, one-visit rule, condition assignment manifest, and access register;
- Postgres-only research storage, AES-256-GCM identity-map encryption, secret separation, migrations, and fail-closed readiness;
- required `project_id`, `study_id`, `environment`, `participant_id`, `visit_id`, and `schema_version` fields, with project/study/environment/namespace derived by the server and enforced on every query/export;
- application version and commit SHA propagation on every event;
- the fixed `https://www.aais.site/xapi/` namespace, physical separation of AAIS/MAIS and production/staging/research stores, research-only credentials with no generic fallback, and a provider-proven physical statement deletion workflow;
- the 828-statement mixed external pool recorded as a legacy archive and excluded from the empty-store baseline and every new-experiment count;
- daily encrypted backup, 35-day rotation, and a successful isolated quarterly-style restore rehearsal;
- a 3-5 synthetic-participant report proving actual semantic operations = Postgres research events = LRS-eligible outbox events = mock LRS statement ids by both count and exact event-id set, plus separate actual-UI browser evidence;
- an external provider receipt proving the clean AAIS-only store's physical isolation, zero baseline, successful delivery reconciliation, and physical-deletion workflow; the synthetic report is not a substitute;
- researcher export authorization, stable ordering, de-identification, audit receipt, and denial for student, teacher, admin, and unapproved actors;
- success, failure, retry, disconnection/reconnection, and AI-latency event coverage; and
- withdrawal rehearsal proving the 1-business-day, 7-calendar-day, and 35-day controls.

Evidence artifacts must be redacted and stored in the restricted study operations register. Required artifacts are the access approval, configuration/readiness receipt, migration receipt, synthetic reconciliation report, LRS hard-deletion rehearsal receipt, backup/restore receipt, export audit receipt, and withdrawal rehearsal receipt. No evidence artifact may contain credentials, identity correspondence, or raw learner text.
