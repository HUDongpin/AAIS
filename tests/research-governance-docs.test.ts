import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const governance = readFileSync("docs/research-data-governance.md", "utf8");
const privacyInventory = readFileSync("docs/privacy-data-inventory.md", "utf8");
const operations = readFileSync("OPERATIONS.md", "utf8");
const readme = readFileSync("README.md", "utf8");
const envExample = readFileSync(".env.example", "utf8");

function expectAll(document: string, expectedValues: string[]) {
  expectedValues.forEach((expected) => {
    expect(document).toContain(expected);
  });
}

describe("AAIS research data governance documentation", () => {
  it("fixes the study scope and Postgres source-of-truth boundary", () => {
    expectAll(governance, [
      "exactly 30 participants",
      "exactly one `study_run_id` and exactly one `visit_id`",
      "Postgres is the sole source of truth for research events",
      "Local file fallback is not permitted for participant research data",
      "Research events and their LRS outbox rows must be written atomically",
      "actual semantic operations = Postgres research events = LRS-eligible outbox events = mock LRS statement ids",
      "Both counts and exact event-id sets must match",
      "`--participants` accepts only 3, 4, or 5 and defaults to 4",
    ]);
  });

  it("locks the synthetic Postgres reconciliation rehearsal and its evidence boundary", () => {
    expectAll(governance, [
      "Synthetic Research Rehearsal SOP",
      "npm run study:rehearse -- --participants 4 --output ./aais-research-rehearsal.json",
      "`--participants` accepts only 3, 4, or 5 and defaults to 4",
      "exactly seven metadata-only semantic operations per synthetic participant",
      "continuous event sequence values beginning at 1",
      "`AAIS_RESEARCH_REHEARSAL_APPROVED=true`",
      "does not drive a browser",
      "does not perform actual external LRS delivery",
      "external provider receipt proves physical store/tenant and credential isolation",
    ]);
    expectAll(operations, [
      "Synthetic participant reconciliation SOP",
      "exactly seven semantic operations per synthetic participant",
      "actual semantic operations = Postgres research events = LRS-eligible outbox events = mock LRS statement ids",
      "The default run rolls back after reconciliation",
      "AAIS_RESEARCH_REHEARSAL_APPROVED=true",
      "does not perform actual external LRS delivery",
      "external provider receipt proves physical store/tenant and credential isolation",
    ]);
    expectAll(readme, [
      "npm run study:rehearse -- --participants 4 --output ./aais-research-rehearsal.json",
      "rolls back by default",
      "AAIS_RESEARCH_REHEARSAL_APPROVED=true",
      "does not perform actual external LRS delivery",
      "Clean-store launch still requires an external provider receipt",
    ]);
    expectAll(envExample, [
      "# AAIS_RESEARCH_MODE=true",
      "# AAIS_RESEARCH_ENVIRONMENT=research",
      "# AAIS_RESEARCH_REHEARSAL_APPROVED=false",
    ]);
  });

  it("requires server-derived experimental dimensions on every record and query", () => {
    expectAll(governance, [
      "`project_id`, `study_id`, `environment`, `participant_id`, `visit_id`, and `schema_version`",
      "`project_id`, `study_id`, `environment`, and the xAPI namespace are derived by the server",
      "They cannot be supplied or overridden by the client",
      "Every AAIS query and export must apply the AAIS namespace filter on the server",
    ]);
  });

  it("physically isolates AAIS, MAIS, and each AAIS environment in the LRS", () => {
    expectAll(governance, [
      "AAIS and MAIS must use physically separate LRS stores/tenants and separate endpoint credentials",
      "AAIS production, AAIS staging, and AAIS research must also use three physically separate LRS stores/tenants",
      "`https://www.aais.site/xapi/` is the only allowed AAIS namespace prefix",
      "`https://www.mais.ac/xapi/` is the only allowed MAIS namespace prefix",
      "`mais-mvp.local` and `www.mais.hk` are forbidden namespace authorities",
      "`AAIS_RESEARCH_LRS_ENDPOINT`, `AAIS_RESEARCH_LRS_USERNAME`, and `AAIS_RESEARCH_LRS_PASSWORD`",
      "Research delivery must not fall back to `LRS_ENDPOINT`, `LRS_USERNAME`, or `LRS_PASSWORD`",
      "the legacy product `aais_events` / `aais_lrs_outbox` mirror",
      "disabled server-side even if old `LRS_*` credentials remain configured",
    ]);
  });

  it("keeps the mixed 828-statement pool as legacy archive outside the new study", () => {
    expectAll(governance, [
      "The existing 828 historical AAIS statements have intact content",
      "read-only legacy archive",
      "No historical archive statement may be replayed into, queried as part of, exported with, or counted toward the new experiment",
      "empty, physically isolated, AAIS-only research store",
      "Reconciliation baselines begin at zero for that store",
    ]);
  });

  it("documents the read-only legacy archive command without claiming live access", () => {
    expectAll(governance, [
      "`AAIS_LEGACY_LRS_ENDPOINT`, `AAIS_LEGACY_LRS_USERNAME`, and `AAIS_LEGACY_LRS_PASSWORD`",
      "authorize GET-only inventory of the old mixed pool",
      "They must never be used for new statement delivery",
      "npm run lrs:archive-legacy -- --expected-count 828",
      "data-bearing archive receipt fields are limited to statement ids, per-statement content SHA-256 digests, and counts",
      "contains no raw statement body",
      "both strictly equal 828",
      "A `count_mismatch`",
      "does not prove that this repository run has actually accessed the external legacy pool",
    ]);
    expectAll(operations, [
      "Legacy archive inventory SOP",
      "read-only credentials for the old mixed AAIS/MAIS pool",
      "npm run lrs:archive-legacy -- --expected-count 828",
      "any count other than 828 means the archive is incomplete",
      "data-bearing receipt fields are limited to statement ids, per-statement content SHA-256 digests, and counts",
      "They do not mean this task has actually accessed the external legacy pool",
    ]);
    expectAll(readme, [
      "npm run lrs:archive-legacy -- --expected-count 828",
      "read-only `AAIS_LEGACY_LRS_ENDPOINT`, `AAIS_LEGACY_LRS_USERNAME`, and `AAIS_LEGACY_LRS_PASSWORD`",
      "must equal exactly 828",
      "does not mean the external pool has actually been accessed",
    ]);
  });

  it("requires a separately encrypted identity map whose key is outside data and backups", () => {
    expectAll(governance, [
      "cryptographically random, opaque `participant_id`",
      "dedicated identity-map table",
      "AES-256-GCM ciphertext",
      "unique nonce/IV",
      "authentication tag",
      "key version",
      "`AAIS_RESEARCH_IDENTITY_ENCRYPTION_KEY`",
      "`AAIS_RESEARCH_IDENTITY_FINGERPRINT_KEY`",
      "`AAIS_RESEARCH_PARTICIPANT_ACTOR_IDS`",
      "Neither key may be stored in Postgres",
      "it must not contain either key",
      "rotating it requires a reviewed migration",
      "aais_research_identity.aais_research_participation_ledger",
      "It survives deletion of the 90-day identity map",
      "A collision fails the entire admission transaction closed",
    ]);
  });

  it("locks the raw-text allowlist and explicitly prohibits keystroke-style collection", () => {
    expectAll(governance, [
      "An explicitly submitted AI prompt",
      "A completed AI response returned for that submitted prompt",
      "An artifact snapshot persisted by the existing semantic save path",
      "not a per-change or per-keystroke history",
      "A submitted self-report",
      "Research event rows, xAPI/LRS statements, application logs, monitoring reports, reconciliation reports, and export audit records must never contain raw text",
      "individual keystroke",
      "unsubmitted drafts",
      "editor selection",
      "cursor position",
      "clipboard content",
      "pointer movement",
      "attachment file name",
      "attachment body",
    ]);
  });

  it("limits identifiable access and keeps the researcher export separate from teacher/admin export", () => {
    expectAll(governance, [
      "Principal Investigator (PI)",
      "written-designated data custodian",
      "A researcher role is limited to the controlled, de-identified, per-event research export",
      "Teacher and admin roles have no research-data access by default",
      "the teacher cohort-summary export must not be reused for research extraction",
      "The controlled researcher export reads only from Postgres research event rows",
      "excludes identity-map and raw-text fields",
      "Legacy product event exports and product/teacher analytics are disabled",
    ]);
  });

  it("locks the operative retention, backup, restore, and shorter-rule values", () => {
    expectAll(governance, [
      "The four configured clocks (90/180/1825/35 days) and the derived ledger/receipt lifecycles below are operative, not pending",
      "90 calendar days after the identity-map row is created",
      "180 calendar days after that participant's visit completion",
      "1825 calendar days after the event's server receipt",
      "rolling maximum of 35 calendar days",
      "the shorter period controls",
      "Extending any deadline requires prior written PI approval",
      "Create an encrypted Postgres backup every day",
      "Rehearse a restore to an isolated non-production target every quarter",
      "event/outbox one-to-one membership",
      "Reapply the withdrawal tombstone ledger",
      "Operational receipts",
      "explicit `retention_due_at`",
    ]);
  });

  it("requires physical LRS deletion and the 1/7/35-day withdrawal controls", () => {
    expectAll(governance, [
      "Within 1 business day, stop new collection",
      "Within 7 calendar days, remove",
      "restricted HMAC admission row withdrawn",
      "submit a physical deletion request for every statement id generated for the participant",
      "pending/retry/dead-letter rows whose remote delivery state may be uncertain",
      "An xAPI void statement does not satisfy physical deletion",
      "35-day rolling backup cycle",
      "external LRS physical-deletion receipt",
      "pause affected collection and LRS delivery",
      "notify the PI and data custodian immediately",
    ]);
  });

  it("documents every required research runtime setting", () => {
    expectAll(governance, [
      "`AAIS_RESEARCH_DATABASE_URL`",
      "`AAIS_RESEARCH_DATABASE_INSTANCE_ID`",
      "`AAIS_RESEARCH_MODE=true`",
      "`AAIS_RESEARCH_PROJECT_ID`",
      "`AAIS_RESEARCH_STUDY_ID`",
      "`AAIS_RESEARCH_ENVIRONMENT`",
      "`AAIS_RESEARCH_REHEARSAL_MODE=true`",
      "`AAIS_RESEARCH_IDENTITY_ENCRYPTION_KEY`",
      "`AAIS_RESEARCH_IDENTITY_FINGERPRINT_KEY`",
      "`AAIS_RESEARCH_PARTICIPANT_ACTOR_IDS`",
      "`AAIS_RESEARCH_PI_ACTOR_IDS`",
      "`AAIS_RESEARCH_DATA_CUSTODIAN_ACTOR_IDS`",
      "`AAIS_RESEARCH_EXPORT_ENABLED=true`",
      "`AAIS_RESEARCH_LRS_NAMESPACE`",
      "`AAIS_RESEARCH_LRS_STORE_ID`",
      "`AAIS_RESEARCH_LRS_ENDPOINT`",
      "`AAIS_RESEARCH_LRS_USERNAME`",
      "`AAIS_RESEARCH_LRS_PASSWORD`",
      "`AAIS_RESEARCH_LRS_RECEIPT_VERIFYING_KEY_ID`",
      "`AAIS_RESEARCH_LRS_RECEIPT_VERIFYING_KEY_SPKI`",
      "`AAIS_RESEARCH_LRS_OUTBOX_FLUSH_TOKEN`",
      "`AAIS_RESEARCH_RETENTION_TOKEN`",
      "`AAIS_APP_VERSION`",
      "`VERCEL_GIT_COMMIT_SHA`",
      "`AAIS_COMMIT_SHA`",
      "`AAIS_RESEARCH_IDENTITY_RETENTION_DAYS=90`",
      "`AAIS_RESEARCH_RAW_TEXT_RETENTION_DAYS=180`",
      "`AAIS_RESEARCH_EVENT_RETENTION_DAYS=1825`",
      "`AAIS_RESEARCH_BACKUP_RETENTION_DAYS=35`",
      "`AAIS_RESEARCH_ACCESS_REGISTER_RECEIPT_SHA256`",
      "`AAIS_RESEARCH_CONSENT_LEGAL_BASIS_RECEIPT_SHA256`",
      "`AAIS_RESEARCH_DPA_RECEIPT_SHA256`",
      "`AAIS_RESEARCH_DATA_REGION_RECEIPT_SHA256`",
      "`AAIS_RESEARCH_DAILY_BACKUP_RECEIPT_SHA256`",
      "`AAIS_RESEARCH_BACKUP_DESTRUCTION_RECEIPT_SHA256`",
      "`AAIS_RESEARCH_GOVERNANCE_MANIFEST_RECEIPT_SHA256`",
      "`AAIS_RESEARCH_GOVERNANCE_MANIFEST_VERIFIED_AT`",
      "`AAIS_RESEARCH_GOVERNANCE_MANIFEST_VALID_UNTIL`",
      "`AAIS_RESEARCH_DAILY_BACKUP_COMPLETED_AT`",
      "`AAIS_RESEARCH_BACKUP_DESTRUCTION_OBSERVED_AT`",
    ]);
  });

  it("requires a signed restricted governance manifest and fresh operational backup evidence", () => {
    expectAll(governance, [
      "all fourteen pairwise-distinct evidence digests",
      "npm run study:verify-governance-evidence",
      "exact thirteen-category source manifest",
      "detached Ed25519 signature",
      "daily backup completed within 36 hours",
      "35-day destruction evidence observed within 45 days",
      "contains no source path, document content, identity, or credential",
      "it is not a legal opinion",
    ]);
    expectAll(operations, [
      "Restricted governance-evidence manifest",
      "aais-research-governance-evidence/v1",
      "`access_register`",
      "`consent_legal_basis`",
      "`dpa`",
      "`data_region`",
      "`daily_backup`",
      "`backup_destruction`",
      "The verifier does not parse or print source-document content",
      "Never configure those variables from a `blocked` report",
    ]);
    expectAll(envExample, [
      "# AAIS_RESEARCH_ACCESS_REGISTER_RECEIPT_SHA256=<64-lowercase-hex>",
      "# AAIS_RESEARCH_CONSENT_LEGAL_BASIS_RECEIPT_SHA256=<64-lowercase-hex>",
      "# AAIS_RESEARCH_DPA_RECEIPT_SHA256=<64-lowercase-hex>",
      "# AAIS_RESEARCH_DATA_REGION_RECEIPT_SHA256=<64-lowercase-hex>",
      "# AAIS_RESEARCH_DAILY_BACKUP_RECEIPT_SHA256=<64-lowercase-hex>",
      "# AAIS_RESEARCH_BACKUP_DESTRUCTION_RECEIPT_SHA256=<64-lowercase-hex>",
      "# AAIS_RESEARCH_GOVERNANCE_MANIFEST_RECEIPT_SHA256=<64-lowercase-hex>",
    ]);
  });

  it("uses only the explicit true value when research mode is enabled", () => {
    const documentedModeValues = [governance, privacyInventory, operations, readme, envExample]
      .flatMap((document) =>
        [...document.matchAll(/AAIS_RESEARCH_MODE=([A-Za-z0-9_-]+)/g)]
          .map((match) => match[1])
      );

    expect(documentedModeValues.length).toBeGreaterThan(0);
    expect(new Set(documentedModeValues)).toEqual(new Set(["true"]));
  });

  it("links and restates the contract from the privacy inventory, runbook, and README", () => {
    [privacyInventory, operations, readme].forEach((document) => {
      expect(document).toContain("docs/research-data-governance.md");
    });
    expectAll(privacyInventory, [
      "30-participant research study",
      "90 calendar days",
      "180 calendar days",
      "1825 calendar days",
      "35 calendar days",
      "operative and are not pending",
      "An xAPI void statement is not physical deletion",
      "828 intact historical AAIS statements",
      "https://www.aais.site/xapi/",
    ]);
    expectAll(operations, [
      "Postgres is the sole source of truth for research events",
      "Within 1 business day",
      "Within 7 calendar days",
      "35-day rolling backup cycle",
      "An xAPI void statement is not physical deletion",
      "AAIS and MAIS use physically separate LRS stores/tenants and credentials",
      "Every AAIS query/export must add the AAIS namespace filter server-side",
    ]);
    expectAll(readme, [
      "30 participants and one visit each",
      "90/180/1825/35-day retention schedule",
      "Research mode must fail closed",
      "mixed 828-statement AAIS/MAIS pool is a legacy archive",
    ]);
  });
});
