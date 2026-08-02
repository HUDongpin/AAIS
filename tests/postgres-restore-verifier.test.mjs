import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  getAaisRestoreDatabaseConfiguration,
  getAaisResearchRestoreDatabaseConfiguration,
  loadAaisRestoreEnvFile,
  parseAaisEnvFile,
  runAaisPostgresRestoreVerification,
  runAaisResearchPostgresRestoreVerification,
} from "../scripts/verify-postgres-restore.mjs";

let tempDir = "";

afterEach(async () => {
  vi.restoreAllMocks();
  if (tempDir) {
    await rm(tempDir, { force: true, recursive: true });
    tempDir = "";
  }
});

describe("AAIS Postgres restore verifier", () => {
  it("verifies restored-staging schema and rolled-back synthetic insert without leaking secrets", async () => {
    const database = new FakeRestoreDatabase();

    const report = await runAaisPostgresRestoreVerification({
      database,
      targetPurpose: "restored-staging",
      sourceEnv: "AAIS_RESTORE_DATABASE_URL",
      releaseId: "aais-restore-test",
    });

    expect(report).toMatchObject({
      schemaVersion: 1,
      status: "passed",
      targetPurpose: "restored-staging",
      sourceEnv: "AAIS_RESTORE_DATABASE_URL",
      releaseId: "aais-restore-test",
      checks: {
        targetPurpose: {
          status: "passed",
          required: "restored-staging",
        },
        requiredTables: {
          status: "passed",
          present: true,
          missing: [],
        },
        rowCounts: {
          learnerSessions: 12,
          lrsOutbox: 2,
          events: 44,
          learnerTaskState: 9,
          users: 3,
          courses: 1,
          courseTasks: 4,
          enrollments: 0,
        },
        smokeInsert: {
          status: "passed",
          insertAccepted: true,
          rolledBack: true,
          writeMode: "insert-only-rolled-back",
        },
      },
      issues: [],
      redaction: {
        databaseUrl: "omitted",
        learnerPayload: "synthetic-only",
        learnerIdentifiers: "omitted",
        secrets: "redacted",
      },
    });
    expect(database.queries.map((query) => query.sql.trim().toLowerCase())).toEqual([
      expect.stringContaining("to_regclass('public.aais_learner_sessions')"),
      expect.stringContaining("select count(*)::int from aais_learner_sessions"),
      "begin",
      expect.stringContaining("insert into aais_learner_sessions"),
      "rollback",
    ]);
    const serialized = JSON.stringify(report);
    expect(serialized).not.toContain("postgres://owner:secret@example.test/aais");
    expect(serialized).not.toContain("restore-smoke-");
  });

  it("fails closed when the target purpose is not restored-staging", async () => {
    const database = new FakeRestoreDatabase();

    const report = await runAaisPostgresRestoreVerification({
      database,
      targetPurpose: "production",
      sourceEnv: "AAIS_RESTORE_DATABASE_URL",
    });

    expect(report.status).toBe("failed");
    expect(report.issues).toEqual(expect.arrayContaining([
      "AAIS_RESTORE_TARGET_PURPOSE",
      "AAIS_RESTORE_SMOKE_INSERT",
    ]));
    expect(report.checks.targetPurpose.status).toBe("failed");
    expect(report.checks.smokeInsert.status).toBe("skipped");
    expect(database.queries.map((query) => query.sql.trim().toLowerCase())).not.toContain("begin");
  });

  it("reports missing restore schema without attempting a smoke write", async () => {
    const database = new FakeRestoreDatabase({
      missingTables: ["aais_events"],
    });

    const report = await runAaisPostgresRestoreVerification({
      database,
      targetPurpose: "restored-staging",
      sourceEnv: "AAIS_RESTORE_DATABASE_URL",
    });

    expect(report.status).toBe("failed");
    expect(report.issues).toEqual(expect.arrayContaining([
      "AAIS_RESTORE_SCHEMA",
      "AAIS_RESTORE_SMOKE_INSERT",
    ]));
    expect(report.checks.requiredTables.missing).toEqual(["aais_events"]);
    expect(report.checks.smokeInsert.status).toBe("skipped");
    expect(database.queries.map((query) => query.sql.trim().toLowerCase())).not.toContain("begin");
  });

  it("verifies the isolated research restore with production AAD and no external LRS access", async () => {
    const database = new FakeResearchRestoreDatabase();
    const independentKey = Buffer.alloc(32, 7).toString("base64");
    const fetchSpy = vi.spyOn(globalThis, "fetch");

    const report = await runAaisResearchPostgresRestoreVerification({
      database,
      targetPurpose: "restored-staging",
      sourceEnv: "AAIS_RESEARCH_RESTORE_DATABASE_URL",
      releaseId: "aais-research-restore-test",
      identityEncryptionKey: independentKey,
    });

    expect(report).toMatchObject({
      schemaVersion: 1,
      mode: "research",
      status: "passed",
      targetPurpose: "restored-staging",
      sourceEnv: "AAIS_RESEARCH_RESTORE_DATABASE_URL",
      checks: {
        migration0009: {
          status: "passed",
          version: "0009",
          ledgerEntry: true,
          nameMatched: true,
          checksumMatched: true,
        },
        requiredTables: {
          status: "passed",
          present: true,
          missing: [],
        },
        requiredFunctions: {
          status: "passed",
          present: true,
          missing: [],
        },
        identityStructure: {
          status: "passed",
          inspectedRows: 3,
        },
        eventSequence: {
          status: "passed",
          eventCount: 8,
          visitsWithGaps: 0,
          visitsWithNextSequenceMismatch: 0,
        },
        eventOutboxSet: {
          status: "passed",
          eventCount: 8,
          outboxCount: 8,
        },
        withdrawalTombstones: {
          status: "passed",
          coverage: "restored-tombstones-only",
          externalRegisterCompared: false,
          tombstoneCount: 1,
        },
        syntheticFixture: {
          status: "passed",
          transaction: "rolled-back",
          rolledBack: true,
          externalLrsContacted: false,
          identityStructure: { status: "passed" },
          identityDecryption: {
            status: "passed",
            independentKeyProvided: true,
            aadContract: "aais-research-identity:v1",
            evidence: "post-restore-round-trip",
          },
          eventSequence: {
            status: "passed",
            expectedCount: 2,
            observedCount: 2,
          },
          eventOutboxSet: {
            status: "passed",
            eventCount: 2,
            outboxCount: 2,
            differenceCount: 0,
          },
          withdrawalTombstone: {
            status: "passed",
            withdrawalCreated: true,
            postWithdrawalClean: true,
            reenrollmentRejected: true,
          },
        },
      },
      issues: [],
      redaction: {
        databaseUrl: "omitted",
        identityPlaintext: "synthetic-only-omitted",
        identityCiphertext: "omitted",
        identityKey: "omitted",
        externalLrs: "not-contacted",
        secrets: "redacted",
      },
    });
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(database.connectCalls).toBe(1);
    expect(database.releaseCalls).toBe(1);
    expect(database.queries.map((query) => query.sql.trim().toLowerCase())).toEqual(
      expect.arrayContaining([
        "begin",
        "savepoint aais_research_tombstone_check",
        "rollback to savepoint aais_research_tombstone_check",
        "release savepoint aais_research_tombstone_check",
        "rollback",
      ]),
    );
    const restoredSequenceQuery = database.queries.find((query) =>
      query.sql.includes("aais_restore_research_event_sequence"));
    expect(restoredSequenceQuery?.sql).toContain("v.status <> 'withdrawn'");
    expect(restoredSequenceQuery?.sql).toContain("min(e.event_sequence) over");
    const identityStructureQuery = database.queries.find((query) =>
      query.sql.includes("aais_restore_research_identity_structure"));
    expect(identityStructureQuery?.sql).toContain("active_visit.status = 'active'");
    const serialized = JSON.stringify(report);
    expect(serialized).not.toContain(independentKey);
    expect(serialized).not.toContain("Synthetic restore participant");
    expect(serialized).not.toContain("restore-actor-");
  });

  it("passes research restore without a key while marking optional decryption not requested", async () => {
    const report = await runAaisResearchPostgresRestoreVerification({
      database: new FakeResearchRestoreDatabase(),
      targetPurpose: "restored-staging",
      sourceEnv: "AAIS_RESEARCH_RESTORE_DATABASE_URL",
    });

    expect(report.status).toBe("passed");
    expect(report.checks.syntheticFixture.identityDecryption).toMatchObject({
      status: "not_requested",
      independentKeyProvided: false,
      aadContract: "aais-research-identity:v1",
      evidence: "post-restore-round-trip",
    });
  });

  it("fails research restore on identity, sequence, set, or revived-tombstone differences", async () => {
    const report = await runAaisResearchPostgresRestoreVerification({
      database: new FakeResearchRestoreDatabase({
        invalidIv: 1,
        activeVisitsWithoutIdentity: 1,
        visitsWithGaps: 2,
        eventsWithoutOutbox: 1,
        revivedIdentityCount: 1,
      }),
      targetPurpose: "restored-staging",
      sourceEnv: "AAIS_RESEARCH_RESTORE_DATABASE_URL",
    });

    expect(report.status).toBe("failed");
    expect(report.issues).toEqual(expect.arrayContaining([
      "AAIS_RESEARCH_RESTORE_IDENTITY_STRUCTURE",
      "AAIS_RESEARCH_RESTORE_EVENT_SEQUENCE",
      "AAIS_RESEARCH_RESTORE_EVENT_OUTBOX_SET",
      "AAIS_RESEARCH_RESTORE_WITHDRAWAL_TOMBSTONES",
    ]));
    expect(report.checks.identityStructure.invalid.iv).toBe(1);
    expect(report.checks.identityStructure.invalid.activeVisitWithoutIdentity).toBe(1);
    expect(report.checks.eventSequence.visitsWithGaps).toBe(2);
    expect(report.checks.eventOutboxSet.differences.eventsWithoutOutbox).toBe(1);
    expect(report.checks.withdrawalTombstones.revived.identities).toBe(1);
  });

  it("does not require an identity row after a visit has completed", async () => {
    const database = new FakeResearchRestoreDatabase();
    const report = await runAaisResearchPostgresRestoreVerification({
      database,
      targetPurpose: "restored-staging",
      sourceEnv: "AAIS_RESEARCH_RESTORE_DATABASE_URL",
    });

    const identityStructureQuery = database.queries.find((query) =>
      query.sql.includes("aais_restore_research_identity_structure"));
    expect(identityStructureQuery?.sql).toContain("active_visit.status = 'active'");
    expect(identityStructureQuery?.sql).not.toContain(
      "active_participant.status = 'active'",
    );
    expect(report.checks.identityStructure.status).toBe("passed");
  });

  it("fails closed when a 0009 table or function is missing and skips synthetic writes", async () => {
    const database = new FakeResearchRestoreDatabase({
      checksumMatches: false,
      missingTables: ["aais_research_events"],
      missingFunctions: ["aais_research_withdraw"],
    });

    const report = await runAaisResearchPostgresRestoreVerification({
      database,
      targetPurpose: "restored-staging",
      sourceEnv: "AAIS_RESEARCH_RESTORE_DATABASE_URL",
    });

    expect(report.status).toBe("failed");
    expect(report.checks.migration0009).toMatchObject({
      status: "failed",
      checksumMatched: false,
    });
    expect(report.checks.requiredTables.missing).toEqual(["aais_research_events"]);
    expect(report.checks.requiredFunctions.missing).toEqual(["aais_research_withdraw"]);
    expect(report.checks.syntheticFixture).toMatchObject({
      status: "skipped",
      transaction: "not-started",
      externalLrsContacted: false,
    });
    expect(database.queries.map((query) => query.sql.trim().toLowerCase()))
      .not.toContain("begin");
  });

  it("rejects an invalid independent research identity key without echoing it", async () => {
    const invalidKey = "do-not-print-this-key";
    const report = await runAaisResearchPostgresRestoreVerification({
      database: new FakeResearchRestoreDatabase(),
      targetPurpose: "restored-staging",
      sourceEnv: "AAIS_RESEARCH_RESTORE_DATABASE_URL",
      identityEncryptionKey: invalidKey,
    });

    expect(report.status).toBe("failed");
    expect(report.issues).toEqual(expect.arrayContaining([
      "AAIS_RESEARCH_RESTORE_IDENTITY_KEY",
      "AAIS_RESEARCH_RESTORE_IDENTITY_DECRYPTION",
    ]));
    expect(report.checks.syntheticFixture.identityDecryption).toMatchObject({
      status: "failed",
      independentKeyProvided: true,
      reason: "invalid independent restore key",
    });
    expect(JSON.stringify(report)).not.toContain(invalidKey);
  });

  it("fails when the restored create-visit function revives a withdrawn identity", async () => {
    const report = await runAaisResearchPostgresRestoreVerification({
      database: new FakeResearchRestoreDatabase({ rejectReenrollment: false }),
      targetPurpose: "restored-staging",
      sourceEnv: "AAIS_RESEARCH_RESTORE_DATABASE_URL",
    });

    expect(report.status).toBe("failed");
    expect(report.issues).toEqual(expect.arrayContaining([
      "AAIS_RESEARCH_RESTORE_SYNTHETIC_FIXTURE",
      "AAIS_RESEARCH_RESTORE_TOMBSTONE_REENROLLMENT",
    ]));
    expect(report.checks.syntheticFixture.withdrawalTombstone).toMatchObject({
      status: "failed",
      reenrollmentRejected: false,
    });
    expect(report.checks.syntheticFixture.rolledBack).toBe(true);
  });

  it("loads restore-specific env values by name without exposing the URL", async () => {
    tempDir = await mkdtemp(path.join(tmpdir(), "aais-restore-env-"));
    const envFile = path.join(tempDir, ".env.postgres-restore.local");
    await writeFile(envFile, [
      "AAIS_RESTORE_DATABASE_URL='postgres://owner:secret@example.test/aais'",
      "AAIS_RESTORE_TARGET_PURPOSE=restored-staging",
      "AAIS_RELEASE_ID=aais-restore-test",
    ].join("\n"));

    const env = await loadAaisRestoreEnvFile(envFile);

    expect(getAaisRestoreDatabaseConfiguration(env)).toEqual({
      url: "postgres://owner:secret@example.test/aais",
      sourceEnv: "AAIS_RESTORE_DATABASE_URL",
    });
    expect(Object.keys(env)).toEqual([
      "AAIS_RESTORE_DATABASE_URL",
      "AAIS_RESTORE_TARGET_PURPOSE",
      "AAIS_RELEASE_ID",
    ]);
  });

  it("resolves research restore config only from the dedicated restore URL", () => {
    expect(getAaisResearchRestoreDatabaseConfiguration({
      AAIS_DATABASE_URL: "postgres://product:secret@example.test/aais",
      AAIS_RESTORE_DATABASE_URL: "postgres://product-restore:secret@example.test/aais",
      AAIS_RESEARCH_DATABASE_URL: "postgres://live-research:secret@example.test/research",
    })).toBeNull();
    expect(getAaisResearchRestoreDatabaseConfiguration({
      AAIS_RESEARCH_RESTORE_DATABASE_URL:
        "postgres://research-restore:secret@example.test/research_restore",
    })).toEqual({
      url: "postgres://research-restore:secret@example.test/research_restore",
      sourceEnv: "AAIS_RESEARCH_RESTORE_DATABASE_URL",
    });
  });

  it("parses simple env files while ignoring comments and invalid keys", () => {
    expect(parseAaisEnvFile([
      "# comment",
      "export AAIS_RESTORE_TARGET_PURPOSE=restored-staging",
      "AAIS_RELEASE_ID=\"aais-restore-test\"",
      "1_BAD=value",
    ].join("\n"))).toEqual({
      AAIS_RESTORE_TARGET_PURPOSE: "restored-staging",
      AAIS_RELEASE_ID: "aais-restore-test",
    });
  });
});

class FakeRestoreDatabase {
  constructor(input = {}) {
    this.missingTables = new Set(input.missingTables ?? []);
    this.queries = [];
  }

  async query(sql, params = []) {
    this.queries.push({ sql, params });
    const normalized = sql.trim().toLowerCase();
    if (normalized.startsWith("select") && normalized.includes("to_regclass")) {
      return {
        rows: [
          Object.fromEntries([
            "aais_learner_sessions",
            "aais_lrs_outbox",
            "aais_login_rate_limits",
            "aais_events",
            "aais_learner_task_state",
            "aais_users",
            "aais_user_auth_tokens",
            "aais_session_revocations",
            "aais_courses",
            "aais_course_tasks",
            "aais_enrollments",
          ].map((table) => [table, this.missingTables.has(table) ? null : table])),
        ],
      };
    }
    if (normalized.startsWith("select") && normalized.includes("count(*)::int")) {
      return {
        rows: [{
          learner_sessions: 12,
          lrs_outbox: 2,
          events: 44,
          learner_task_state: 9,
          users: 3,
          courses: 1,
          course_tasks: 4,
          enrollments: 0,
        }],
      };
    }
    if (normalized.startsWith("insert into aais_learner_sessions")) {
      return {
        rows: [{ student_id: params[0] }],
      };
    }
    return { rows: [] };
  }
}

const researchTableNames = [
  "aais_research_participants",
  "aais_research_identity.aais_research_identity_map",
  "aais_research_identity.aais_research_participation_ledger",
  "aais_research_visits",
  "aais_research_raw_write_leases",
  "aais_research_events",
  "aais_research_lrs_outbox",
  "aais_research_export_audit",
  "aais_research_withdrawals",
  "aais_research_lrs_deletions",
  "aais_research_retention_runs",
  "aais_research_legacy_archives",
];

const researchConstraintNames = [
  "aais_research_identity_scope_key_iv_unique",
  "aais_research_participation_scope_fingerprint_unique",
  "aais_research_participation_scope_run_unique",
  "aais_research_participation_scope_visit_unique",
  "aais_research_participation_scope_key_iv_unique",
];

const researchColumnNames = [
  ["aais_research_export_audit", "schema_version"],
  ["aais_research_export_audit", "commit_sha"],
  ["aais_research_export_audit", "retention_due_at"],
  ["aais_research_retention_runs", "retention_due_at"],
  ["aais_research_lrs_deletions", "retention_due_at"],
  ["aais_research_lrs_deletions", "receipt_sha256"],
  ["aais_research_lrs_deletions", "provider_absence_confirmed_at"],
  ["aais_research_lrs_deletions", "provider_receipt_key_id"],
  ["aais_research_lrs_deletions", "provider_receipt_signature"],
  ["aais_research_legacy_archives", "retention_due_at"],
  ["aais_research_participation_ledger", "admission_fingerprint"],
  ["aais_research_participation_ledger", "identity_key_version"],
  ["aais_research_participation_ledger", "identity_iv"],
];

const researchFunctionNames = [
  "aais_research_detail_is_safe",
  "aais_research_apply_fact_retention",
  "aais_research_create_visit",
  "aais_research_record_event",
  "aais_research_acquire_raw_write_lease",
  "aais_research_begin_withdrawal",
  "aais_research_complete_visit",
  "aais_research_withdraw",
];

class FakeResearchRestoreDatabase {
  constructor(input = {}) {
    this.input = input;
    this.missingTables = new Set(input.missingTables ?? []);
    this.missingFunctions = new Set(input.missingFunctions ?? []);
    this.missingConstraints = new Set(input.missingConstraints ?? []);
    this.missingColumns = new Set(input.missingColumns ?? []);
    this.queries = [];
    this.connectCalls = 0;
    this.releaseCalls = 0;
    this.createVisitCalls = 0;
    this.recordEventCalls = 0;
    this.syntheticIdentity = null;
    this.syntheticVisit = null;
  }

  async connect() {
    this.connectCalls += 1;
    return {
      query: this.query.bind(this),
      release: () => {
        this.releaseCalls += 1;
      },
    };
  }

  async query(sql, params = []) {
    this.queries.push({ sql, params });
    const normalized = sql.trim().toLowerCase();

    if (normalized.includes("aais_restore_research_migration_ledger")) {
      return {
        rows: [{
          migration_ledger: this.input.missingMigrationLedger
            ? null
            : "aais_schema_migrations",
        }],
      };
    }
    if (normalized.includes("aais_restore_research_migration_0009")) {
      return this.input.missingMigration0009
        ? { rows: [] }
        : {
            rows: [{
              name: this.input.migrationName ?? "aais_research_study",
              checksum_matches: this.input.checksumMatches ?? true,
            }],
          };
    }
    if (normalized.includes("aais_restore_research_tables")) {
      return {
        rows: [Object.fromEntries(researchTableNames.map((table, index) => [
          `research_table_${index}`,
          this.missingTables.has(table) ? null : table,
        ]))],
      };
    }
    if (normalized.includes("aais_restore_research_functions")) {
      return {
        rows: [Object.fromEntries(researchFunctionNames.map((functionName, index) => [
          `research_function_${index}`,
          this.missingFunctions.has(functionName) ? null : functionName,
        ]))],
      };
    }
    if (normalized.includes("aais_restore_research_constraints")) {
      return {
        rows: researchConstraintNames
          .filter((name) => !this.missingConstraints.has(name))
          .map((conname) => ({ conname })),
      };
    }
    if (normalized.includes("aais_restore_research_columns")) {
      return {
        rows: researchColumnNames
          .filter(([table, column]) => !this.missingColumns.has(`${table}.${column}`))
          .map(([table_name, column_name]) => ({
            table_schema: table_name === "aais_research_participation_ledger"
              ? "aais_research_identity"
              : "public",
            table_name,
            column_name,
          })),
      };
    }
    if (normalized.includes("aais_restore_research_row_counts")) {
      return {
        rows: [{
          participants: 4,
          identity_maps: 3,
          participation_ledgers: 4,
          visits: 4,
          raw_write_leases: 0,
          events: 8,
          lrs_outbox: 8,
          export_audits: 1,
          withdrawals: 1,
          lrs_deletions: 2,
          retention_runs: 1,
          legacy_archives: 1,
        }],
      };
    }
    if (normalized.includes("aais_restore_research_identity_structure")) {
      return {
        rows: [{
          inspected_rows: 3,
          invalid_ciphertext: this.input.invalidCiphertext ?? 0,
          invalid_iv: this.input.invalidIv ?? 0,
          invalid_authentication_tag: this.input.invalidAuthenticationTag ?? 0,
          invalid_key_version: this.input.invalidKeyVersion ?? 0,
          invalid_admission_fingerprint: this.input.invalidIdentityFingerprint ?? 0,
          invalid_participant_scope: this.input.invalidParticipantScope ?? 0,
          invalid_participation_scope: this.input.invalidParticipationScope ?? 0,
          visits_without_participation: this.input.visitsWithoutParticipation ?? 0,
          identity_nonce_collisions: this.input.identityNonceCollisions ?? 0,
          participation_nonce_collisions:
            this.input.participationNonceCollisions ?? 0,
          active_visits_without_identity:
            this.input.activeVisitsWithoutIdentity ?? 0,
        }],
      };
    }
    if (normalized.includes("aais_restore_research_event_sequence")) {
      return {
        rows: [{
          event_count: 8,
          visits_with_gaps: this.input.visitsWithGaps ?? 0,
          visits_with_next_sequence_mismatch:
            this.input.visitsWithNextSequenceMismatch ?? 0,
        }],
      };
    }
    if (normalized.includes("aais_restore_research_event_outbox_set")) {
      return {
        rows: [{
          event_count: 8,
          outbox_count: this.input.outboxCount ?? 8,
          events_without_outbox: this.input.eventsWithoutOutbox ?? 0,
          outbox_without_events: this.input.outboxWithoutEvents ?? 0,
          statement_id_mismatches: this.input.statementIdMismatches ?? 0,
          scope_or_eligibility_mismatches:
            this.input.scopeOrEligibilityMismatches ?? 0,
        }],
      };
    }
    if (normalized.includes("aais_restore_research_withdrawal_tombstones")) {
      return {
        rows: [{
          tombstone_count: 1,
          invalid_tombstone_count: this.input.invalidTombstoneCount ?? 0,
          revived_identity_count: this.input.revivedIdentityCount ?? 0,
          revived_event_count: this.input.revivedEventCount ?? 0,
          revived_visit_count: this.input.revivedVisitCount ?? 0,
          revived_participant_count: this.input.revivedParticipantCount ?? 0,
          invalid_admission_count: this.input.invalidAdmissionCount ?? 0,
        }],
      };
    }
    if (normalized.includes("aais_restore_research_synthetic_create_visit")) {
      this.createVisitCalls += 1;
      if (this.createVisitCalls === 2) {
        return {
          rows: [{
            participant_id: this.syntheticVisit.participant_id,
            study_run_id: this.syntheticVisit.study_run_id,
            visit_id: this.syntheticVisit.visit_id,
            visit_status: "completed",
            created: false,
          }],
        };
      }
      if (this.createVisitCalls === 3) {
        throw new Error("research identity nonce collision");
      }
      if (this.createVisitCalls > 3 && this.input.rejectReenrollment !== false) {
        throw new Error("research participant withdrawn");
      }
      this.syntheticIdentity = {
        ciphertext: params[8],
        iv: params[9],
        authentication_tag: params[10],
        key_version: params[11],
      };
      this.syntheticVisit ??= {
        participant_id: params[4],
        study_run_id: params[5],
        visit_id: params[6],
      };
      return { rows: [{ ...this.syntheticVisit, created: true }] };
    }
    if (normalized.includes("aais_restore_research_synthetic_identity")) {
      return { rows: this.syntheticIdentity ? [this.syntheticIdentity] : [] };
    }
    if (normalized.includes("aais_restore_research_synthetic_record_event")) {
      this.recordEventCalls += 1;
      return {
        rows: [{
          created: true,
          recorded_lrs_eligible: true,
          recorded_event_sequence: String(this.recordEventCalls),
        }],
      };
    }
    if (normalized.includes("aais_restore_research_synthetic_event_outbox_set")) {
      return {
        rows: [{
          event_sequences: ["1", "2"],
          event_count: 2,
          outbox_count: 2,
          difference_count: 0,
        }],
      };
    }
    if (normalized.includes("aais_restore_research_synthetic_withdraw")) {
      return {
        rows: [{
          created: true,
          identity_deleted: true,
          restricted_raw_text_deleted: true,
          local_event_count: 2,
          deletion_request_count: 2,
        }],
      };
    }
    if (normalized.includes("aais_restore_research_synthetic_begin_withdrawal")) {
      return {
        rows: [{
          status: "withdrawing",
          active_raw_write_lease_count: 0,
        }],
      };
    }
    if (normalized.includes("aais_restore_research_synthetic_post_withdrawal")) {
      return {
        rows: [{
          identity_count: 0,
          event_count: 0,
          outbox_count: 0,
          tombstone_count: 1,
          admission_tombstone_count: 1,
        }],
      };
    }
    return { rows: [] };
  }
}
