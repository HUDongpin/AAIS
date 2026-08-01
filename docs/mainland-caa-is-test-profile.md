# Mainland CAAIS Internal Test Profile

Status: engineering and governance profile for the current CAAIS internal test in mainland China. This profile is not legal advice, an ethics decision, a participant consent record, a provider contract, or proof that an operational control has run.

Legal-source review date: 2026-08-01.

## Scope And Boundary

This lightweight profile applies only when all of the following are true:

- test participants are adults aged 18 or older;
- the activity is low risk and no more intrusive than ordinary product usability testing;
- collection, storage, backup, support access, and analysis remain in mainland China;
- the test does not intentionally collect sensitive personal information;
- free text is limited to the approved submitted or semantically saved classes, and no per-keystroke history, clipboard content, cursor history, pointer trace, or unsubmitted draft is collected;
- random participant identifiers and the separately encrypted identity correspondence are treated as personal information while re-identification remains possible; and
- test evidence is segregated from formal research data and cannot later be relabelled as formal participant evidence.

The lightweight profile consolidates paperwork; it does not waive applicable law or institutional ethics review. A test involving people as research participants or using their personal information must be routed to the responsible institutional ethics body or an eligible review service. A low-risk AI activity may qualify for the simplified review procedure under the current rules, but only the responsible body can record that decision. A repository file or CLI report cannot do so.

## Formal 30-Participant Gate Does Not Change

The formal study still admits exactly 30 approved participants, with one `study_run_id` and one `visit_id` per participant. Its existing research contract, Postgres fact-source rule, controlled per-event export, real provider isolation, formal access grants, participant-facing process, and withdrawal/deletion requirements remain unchanged.

A 3–5-person mainland test is rehearsal or internal-test evidence only. It cannot satisfy, consume, or weaken the formal roster gate, and its data must not be included in the formal study dataset.

Readiness has two deliberately separate meanings:

- Generating the six-piece pack does not make `applicationReady` true. `applicationReady` may be `true` only when a genuinely reachable, isolated test Postgres target, its required migrations, the application data path, and the local technical checks all pass.
- `studyLaunchReady` remains `false` for this profile because local substitutes do not prove provider physical isolation, provider deletion, signed participant/governance actions, or the other formal 30-participant gates.

The combination `applicationReady=true` and `studyLaunchReady=false` is therefore valid and expected for this profile. Internal technical success must never be promoted automatically into formal-study readiness.

## Local Four-Store And Signature Boundary

The mainland test tool may prepare four locally separated test stores, isolated local credentials, an empty baseline, test PUT/GET/delete reconciliation, and internally signed evidence. These controls are valuable for exercising the application and evidence pipeline, but their meaning is strictly limited:

- a local `store_id`, directory, database, container, or emulator is not a provider-created physical store or tenant;
- locally separate credentials do not prove provider-side least privilege;
- a local zero baseline and local PUT/GET/delete drill do not prove the state of an external LRS;
- an internal Ed25519 signature authenticates the bytes signed by the local test authority; it is not a provider signature and does not prove provider-side physical deletion or absence; and
- an absence query proves only the stated query scope and time. It does not, by itself, prove erasure from replicas, caches, backups, or provider operational logs.

Formal `lrs_isolation`, `lrs_zero_baseline`, and `lrs_put_delete` controls require provider-scoped evidence when the formal study uses an external provider. Local drill evidence must be labelled `local_test` and must not be copied into a provider receipt field.

## Lightweight Six-Piece Pack And Formal-Control Crosswalk

The internal test generator writes exactly six pending templates. The formal verifier's 13 controls remain distinct; placing several controls in one lightweight document does not mark any formal receipt complete.

| Generated template | Minimum internal-test content | Formal control crosswalk | What the template does not prove |
| --- | --- | --- | --- |
| 1. `01-test-scope-and-ethics-review.md` | Adult/low-risk/mainland boundary; test purpose; research-use exclusion; simplified ethics-review application; responsible-body decision field fixed at `PENDING` | Context for `consent_legal_basis`; `legacy_archive` is explicitly outside this new test run | Ethics approval, a waiver, or any decision by a responsible ethics body |
| 2. `02-participant-notice.md` | Processor contact; purpose; data classes; recipients; TTLs; rights; withdrawal channel; acknowledgement field fixed at `PENDING` | `consent_legal_basis` | That notice was delivered or that a tester, participant, or guardian consented |
| 3. `03-data-inventory-and-retention.md` | Field/purpose map; raw-text exclusions; Postgres/local-store locations; `7/7/30/1` TTLs; deletion trigger; mainland-only assumption | `data_region`, `backup_policy` | Provider region, actual retention execution, backup existence, or deletion |
| 4. `04-access-vendor-register-and-processor-terms.md` | Intended roles; least-access design; vendor status; purpose, term, data classes, safeguards, return/delete, and no unauthorized onward processing | `access_register`, `dpa`, `data_region` | Signed appointments, an executed DPA, provider acceptance, region confirmation, or actual access events |
| 5. `05-security-incident-backup-restore.md` | Encryption and secrets; access control; pause/notify/escalate steps; optional backup controls; bounded restore procedure and result fields fixed at `PENDING` | `database_isolation`, `lrs_isolation`, `backup_policy`, `restore`, `daily_backup` | Provider physical isolation, an incident-free period, or that a backup or restore occurred |
| 6. `06-withdrawal-deletion-closeout.md` | Stop collection; scoped local deletion; credential revocation; before/after counts; tombstone/expiry and closeout fields fixed at `PENDING` | `lrs_put_delete`, `backup_destruction` | Provider deletion/absence, backup destruction, withdrawal completion, or formal case closure |

The local LRS drill evidence is a separate, automatically generated execution ledger and is not one of the six templates. It may record bounded `local_test` facts such as local store creation, zero counts, exact PUT/GET/delete sets, hashes, and command outcome. It can support only the declared local drill scope for `lrs_isolation`, `lrs_zero_baseline`, and `lrs_put_delete`; it says nothing about Postgres `database_isolation`, is not provider evidence, and does not alter the historical `legacy_archive` control.

The 13 formal controls are:

1. `database_isolation`
2. `lrs_isolation`
3. `lrs_zero_baseline`
4. `lrs_put_delete`
5. `backup_policy`
6. `restore`
7. `legacy_archive`
8. `access_register`
9. `consent_legal_basis`
10. `dpa`
11. `data_region`
12. `daily_backup`
13. `backup_destruction`

For internal testing, a template or declared configuration is reported as `draft`, `planned`, or `local_test`; only an observed operation with a bounded scope can be reported as `executed`. Formal controls remain `unverified` unless their authoritative evidence passes the formal verifier.

## Test TTLs

The local four-store drill uses these maximum live test-data TTL defaults, measured from the local store's server receipt time:

| Local test-store profile | Default TTL |
| --- | ---: |
| AAIS production simulation | 7 calendar days |
| AAIS staging simulation | 7 calendar days |
| AAIS research simulation | 30 calendar days |
| MAIS test simulation | 1 calendar day |

These `7/7/30/1` values are project test defaults, not fixed legal retention periods. A shorter protocol, consent, ethics, security, or operational requirement controls. Extending a TTL requires a documented purpose and approval appropriate to the test; this profile alone is not approval.

The existing 35-day backup rotation is also a project control, not a fixed statutory period. The Personal Information Protection Law instead requires retention for the shortest period necessary to achieve the purpose. Study content and identity data must not be retained merely because a security-log rule uses a longer period. Conversely, deleting test content does not authorize deletion of the relevant network-security logs that the current Cybersecurity Law requires to be kept separately for at least six months.

## Switch Conditions

Stop using this lightweight profile and switch to the applicable stronger workflow before continuing when any of the following becomes true.

### Minor participant

- Any participant is under 18: pause admission and obtain institution-specific minor-participant and ethics instructions.
- Any participant is under 14: treat the person's information as sensitive personal information; require guardian consent and a dedicated minor personal-information rule before collection.
- Do not collect exact birth dates merely to prove adulthood when a less intrusive age-eligibility record is sufficient.

### Cross-border data or access

- Any personal information, raw text, identifier, backup, telemetry, provider support access, or remote administration can leave mainland China.
- The provider's data region or support-access location is unknown.
- A random identifier remains personal information when AAIS or another party can reconnect it to an individual; pseudonymisation alone does not remove the cross-border question.

Before resuming, determine the actual transfer path and complete the required notice, separate consent, personal-information protection impact assessment, recipient safeguards, and any applicable filing, standard-contract, certification, or security-assessment route. A small participant count does not by itself waive the underlying notice, consent, assessment, and security duties.

### Formal participant or research use

- A person is recruited as one of the formal 30 participants.
- The data will contribute to the formal analysis, publication, thesis, evaluation, or study conclusions.
- The activity changes from internal product testing to a human-participant research procedure.

Before collection, switch to the formal roster and study configuration, obtain the responsible ethics decision and participant-facing records, close the formal governance gates, and use provider-scoped evidence where the formal design requires it. Internal-test data cannot be grandfathered into the formal dataset.

## Evidence Integrity And Prohibited Claims

Generated files may provide drafts, templates, configuration declarations, local test results, and unsigned signature slots. Unless supported by independently verified source evidence, they must not state or imply any of the following:

- ethics approval was granted;
- a participant or guardian signed or accepted consent;
- an access or custodian appointment was signed;
- a DPA or other provider agreement was executed;
- a provider confirmed a data region, physical tenant, least-privilege credential, deletion, or absence;
- a backup, restore, destruction, withdrawal, or participant notification occurred; or
- an internally generated Ed25519 signature is a provider receipt.

Do not pre-date evidence. Do not sign on behalf of a participant, ethics body, institution, custodian, or provider. When an operation later occurs, preserve its actual timestamp, actor or authority, exact scope, result, and source artifact rather than editing a draft into an apparently historical receipt.

## Exact CLI Interfaces

Prepare a five-person internal mainland test pack in a restricted directory:

```bash
npm run study:prepare-mainland-test -- \
  --participants 5 \
  --output output/restricted-study-operations/<run-id>
```

Run the four-store LRS drill using a non-committed secret file and write the sanitized result into the restricted evidence directory:

```bash
npm run study:run-mainland-test-lrs -- \
  --env-file output/restricted-study-operations/<run-id>/secrets.env \
  --output output/restricted-study-operations/<run-id>/lrs-drill-evidence.json
```

Replace `<run-id>` with one new, explicit directory name. Inside this repository the generator accepts only a new child of the ignored `output/restricted-study-operations/` tree; a restricted directory outside the repository is also allowed. It rejects other in-repository targets so `secrets.env` cannot be placed accidentally in a tracked path.

The generated environment deliberately overrides inherited live AI/provider, Sentry, worker-schedule, token, and formal-receipt values with disabled or empty fail-closed settings. If the application is started with this pack, load it into a fresh child process and export empty assignments as well as populated ones; do not merge selected lines into a long-lived provider shell. Keep the restricted directory access-limited, keep `secrets.env` outside source control and evidence outputs, and never print credentials into logs or receipts. Command success proves only the scope declared in the generated report.

## Official Primary Sources

The following current official sources define the legal and ethics boundaries summarized above:

- [中华人民共和国个人信息保护法](https://www.cac.gov.cn/2021-08/20/c_1631050028355286.htm): legality, necessity, transparency, consent, shortest necessary retention, entrusted processing, sensitive information, minor information, individual rights, security measures, impact assessment, and incident response.
- [网络数据安全管理条例](https://www.cac.gov.cn/2024-09/30/c_1729384452307680.htm): encryption, backup, access control, incident handling, entrusted-processing records, notice, consent, and rights handling; effective since 2025-01-01.
- [中华人民共和国数据安全法](https://www.cac.gov.cn/2021-06/11/c_1624994566919140.htm): data classification, full-lifecycle security management, risk monitoring, and incident response.
- [中华人民共和国网络安全法（2025年修正）](https://www.cac.gov.cn/2025-12/29/c_1768735112911946.htm): current text effective since 2026-01-01, including internal security responsibility, network logs, data classification, backup/encryption, and emergency response.
- [科技伦理审查办法（试行）](https://www.most.gov.cn/xxgk/xinxifenlei/fdzdgknr/fgzc/gfxwj/gfxwj2023/202310/t20231008_188309.html): covers technology activities using people as test, survey, or observation subjects or using personal-information data.
- [人工智能科技伦理审查与服务办法（试行）](https://kjs.moa.gov.cn/gzdt/202605/t20260514_6484163.htm): current AI-specific review framework; Articles 19–20 allow a simplified procedure for qualifying low-risk activities.
- [促进和规范数据跨境流动规定](https://www.gov.cn/gongbao/2024/issue_11366/202405/content_6954192.html?xxgkhide=1): cross-border thresholds do not displace the underlying notice, separate-consent, impact-assessment, and security duties.
- [未成年人网络保护条例](https://www.cac.gov.cn/2023-10/24/c_1699806932316206.htm): additional requirements when a network product or service processes minor personal information.

This source list supports engineering governance decisions. The institution's responsible ethics body and, where needed, qualified PRC counsel remain the authorities for the actual test protocol and participant-facing decision.
