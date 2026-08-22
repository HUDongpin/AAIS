// @vitest-environment node

import { createHash, generateKeyPairSync, sign } from "node:crypto";
import { readFile } from "node:fs/promises";
import { describe, expect, it, vi } from "vitest";
import type { AaisSessionActor } from "@/lib/server/aais-session";
import {
  AaisResearchConfigurationError,
  encryptAaisResearchIdentity,
  type AaisResearchConfiguration,
} from "@/lib/server/aais-research-contract";
import {
  AaisResearchAuthorizationError,
  AaisResearchEventLimitError,
  AaisResearchVisitInactiveError,
  AaisResearchVisitMismatchError,
  createAaisResearchStore,
  type AaisResearchDatabaseClient,
} from "@/lib/server/aais-research-store";
import { createAaisResearchLrsAbsenceReceiptEnvelope } from "@/lib/server/aais-research-lrs";

const ids = [
  "10000000-0000-4000-8000-000000000001",
  "10000000-0000-4000-8000-000000000002",
  "10000000-0000-4000-8000-000000000003",
  "10000000-0000-4000-8000-000000000004",
  "10000000-0000-4000-8000-000000000005",
];
const receiptKeyId = "provider-ed25519-2026-01";
const receiptKeyPair = generateKeyPairSync("ed25519");
const receiptVerifyingSpki = receiptKeyPair.publicKey
  .export({ format: "der", type: "spki" })
  .toString("base64");

const configuration: AaisResearchConfiguration = {
  enabled: true,
  projectId: "aais",
  studyId: "ca-pilot-2026",
  environment: "research",
  lrsNamespace: "https://www.aais.site/xapi/studies/ca-pilot-2026/research/v1",
  lrsStoreId: "aais-research-test-store",
  appVersion: "0.1.0",
  commitSha: "0123456789abcdef",
  conditions: ["control", "treatment"],
  databaseUrl: "postgres://test:test@localhost/aais_research",
  databaseInstanceId: "aais-research-test-db",
  databaseDriver: "pg",
  rehearsalMode: true,
  participantActorIds: ["student-1"],
  identityEncryptionKey: Buffer.alloc(32, 9),
  identityFingerprintKey: Buffer.alloc(32, 10),
  identityKeyVersion: "v1",
  identityRetentionDays: 90,
  rawTextRetentionDays: 180,
  factRetentionDays: 1825,
  backupRetentionDays: 35,
};

const student: AaisSessionActor = {
  id: "student-1",
  role: "student",
  displayName: "Student One",
};

const researcher: AaisSessionActor = {
  id: "researcher-1",
  role: "researcher",
  displayName: "Researcher One",
};

describe("AAIS research Postgres store", () => {
  it("blocks runtime visit creation before any SQL when formal launch evidence is incomplete", async () => {
    const database = new ScriptedDatabase([]);
    const store = createAaisResearchStore({
      configuration,
      database,
      enforceCollectionLaunchGate: true,
      env: {
        AAIS_RESEARCH_MODE: "true",
        AAIS_RESEARCH_REHEARSAL_MODE: "false",
      },
    });

    await expect(store.getOrCreateVisit(student)).rejects.toThrow(
      "formal research collection is blocked",
    );
    expect(database.calls).toHaveLength(0);
  });

  it("creates random scoped visit ids without writing plaintext identity", async () => {
    const database = new ScriptedDatabase([
      {
        participant_id: ids[0],
        study_run_id: ids[1],
        visit_id: ids[2],
        condition: "control",
        visit_status: "active",
        created: true,
      },
    ]);
    let cursor = 0;
    const store = createAaisResearchStore({
      configuration,
      database,
      randomUuid: () => ids[cursor++]!,
      now: () => new Date("2026-07-30T10:00:00.000Z"),
      env: { AAIS_RESEARCH_EXPORT_ENABLED: "true" },
    });

    const visit = await store.getOrCreateVisit(student);

    expect(visit).toEqual({
      participantId: ids[0],
      studyRunId: ids[1],
      visitId: ids[2],
      condition: "control",
      status: "active",
      appVersion: "0.1.0",
      commitSha: "0123456789abcdef",
      created: true,
    });
    expect(database.calls[0]?.sql).toContain("aais_research_create_visit");
    expect(database.calls[0]?.params).toContain(30);
    expect(database.calls[0]?.params).not.toContain("student-1");
    expect(database.calls[0]?.params).not.toContain("Student One");
    expect(database.calls[0]?.params.some((value) => Buffer.isBuffer(value))).toBe(true);
  });

  it("maps a withdrawn-identity tombstone to an inactive visit", async () => {
    const database = new ScriptedDatabase([
      new Error("research participant withdrawn"),
    ]);
    const store = createAaisResearchStore({
      configuration,
      database,
      randomUuid: () => ids[0],
      now: () => new Date("2026-07-30T10:00:00.000Z"),
    });

    await expect(store.getOrCreateVisit(student)).rejects.toThrow(
      AaisResearchVisitInactiveError,
    );
  });

  it("fails closed when Postgres reports a scoped AES-GCM nonce collision", async () => {
    const database = new ScriptedDatabase([
      new Error("research identity nonce collision"),
    ]);
    const store = createAaisResearchStore({
      configuration,
      database,
      randomUuid: () => ids[0],
      now: () => new Date("2026-07-30T10:00:00.000Z"),
    });

    await expect(store.getOrCreateVisit(student)).rejects.toThrow(
      "identity nonce collision; admission failed closed",
    );
    expect(database.calls).toHaveLength(1);
  });

  it("denies an authenticated student who is not on the signed participant roster", async () => {
    const database = new ScriptedDatabase([]);
    const store = createAaisResearchStore({ configuration, database });

    await expect(store.getOrCreateVisit({
      id: "student-not-enrolled",
      role: "student",
      displayName: "Not Enrolled",
    })).rejects.toThrow(AaisResearchAuthorizationError);
    expect(database.calls).toHaveLength(0);
  });

  it("derives visit metadata and counters on the server and records one atomic event", async () => {
    const database = new ScriptedDatabase([
      {
        participant_id: ids[0],
        study_run_id: ids[1],
        visit_id: ids[2],
        condition: "treatment",
        status: "active",
      },
      {
        recorded_event_id: ids[3],
        recorded_event_sequence: "7",
        recorded_lrs_eligible: true,
        created: true,
      },
    ]);
    const store = createAaisResearchStore({
      configuration,
      database,
      randomUuid: () => ids[3],
      now: () => new Date("2026-07-30T10:00:00.100Z"),
      env: { AAIS_RESEARCH_EXPORT_ENABLED: "true" },
    });

    const event = await store.recordEvent(student, {
      clientEventId: ids[3],
      clientTime: "2026-07-30T10:00:00.000Z",
      expectedVisitId: ids[2],
      eventName: "ai_guide_submit",
      outcome: "disconnected",
      aiLatencyMs: 420,
      detail: { attempt_number: 3, prompt_length: 40 },
    });

    expect(event).toMatchObject({
      eventId: ids[3],
      participantId: ids[0],
      studyRunId: ids[1],
      visitId: ids[2],
      condition: "treatment",
      eventSequence: 7,
      retryCount: 2,
      disconnectCount: 1,
      lrsEligible: true,
    });
    expect(database.calls[0]?.sql).toContain(
      "aais_research_identity.aais_research_participation_ledger",
    );
    expect(database.calls[1]?.sql).toContain("aais_research_record_event");
    expect(database.calls[1]?.params).toEqual(expect.arrayContaining([
      "aais",
      "ca-pilot-2026",
      "research",
      configuration.lrsNamespace,
      configuration.lrsStoreId,
      "0.1.0",
      "0123456789abcdef",
    ]));
  });

  it("maps the per-visit research event cap before any additional event is persisted", async () => {
    const database = new ScriptedDatabase([
      {
        participant_id: ids[0],
        study_run_id: ids[1],
        visit_id: ids[2],
        condition: "treatment",
        status: "active",
      },
      new Error("research visit event limit reached"),
    ]);
    const store = createAaisResearchStore({
      configuration,
      database,
      now: () => new Date("2026-07-30T10:00:00.100Z"),
    });

    await expect(store.recordEvent(student, {
      clientEventId: ids[3],
      clientTime: "2026-07-30T10:00:00.000Z",
      expectedVisitId: ids[2],
      eventName: "content_tab_selected",
      outcome: "success",
      detail: { tab_id: "editor" },
    })).rejects.toThrow(AaisResearchEventLimitError);

    expect(database.calls).toHaveLength(2);
    expect(database.calls[1]?.sql).toContain("aais_research_record_event");
  });

  it("rejects an event bound to another visit before event SQL", async () => {
    const database = new ScriptedDatabase([{
      participant_id: ids[0],
      study_run_id: ids[1],
      visit_id: ids[2],
      condition: "control",
      status: "active",
    }]);
    const store = createAaisResearchStore({ configuration, database });

    await expect(store.recordEvent(student, {
      clientEventId: ids[3],
      clientTime: "2026-07-30T10:00:00.000Z",
      expectedVisitId: ids[4],
      eventName: "content_tab_selected",
      outcome: "success",
      detail: { tab_id: "editor" },
    })).rejects.toThrow(AaisResearchVisitMismatchError);

    expect(database.calls).toHaveLength(1);
    expect(database.calls[0]?.sql).toContain(
      "aais_research_identity.aais_research_participation_ledger",
    );
  });

  it("allows only researcher export and persists a scoped checksum audit", async () => {
    const eventRow = createEventRow();
    const database = new ScriptedDatabase([[eventRow], []]);
    const store = createAaisResearchStore({
      configuration,
      database,
      randomUuid: () => ids[4],
      now: () => new Date("2026-07-30T10:01:00.000Z"),
      env: {
        AAIS_RESEARCH_EXPORT_ENABLED: "true",
        AAIS_RESEARCH_EXPORT_ACTOR_IDS: "researcher-1",
      },
    });

    await expect(store.exportEvents({
      actor: student,
      studyRunId: ids[1],
      format: "json",
      purpose: "approved_analysis",
    })).rejects.toThrow(AaisResearchAuthorizationError);
    await expect(store.exportEvents({
      actor: { ...researcher, id: "researcher-without-grant" },
      studyRunId: ids[1],
      format: "json",
      purpose: "approved_analysis",
    })).rejects.toThrow(AaisResearchAuthorizationError);
    const exported = await store.exportEvents({
      actor: researcher,
      studyRunId: ids[1],
      format: "json",
      purpose: "approved_analysis",
    });

    expect(exported.rowCount).toBe(1);
    expect(exported.fileSha256).toMatch(/^[0-9a-f]{64}$/);
    expect(exported.body).not.toContain("Student One");
    expect(database.calls[0]?.sql).toContain("public.aais_research_export_events");
    expect(database.calls[0]?.params).toEqual([
      configuration.projectId,
      configuration.studyId,
      configuration.environment,
      configuration.lrsNamespace,
      ids[1],
      10_000,
    ]);
    expect(database.calls[1]?.sql).toContain("aais_research_export_audit");
    expect(database.calls[1]?.params).toContain(exported.fileSha256);
    expect(database.calls[1]?.params).toContain("approved_analysis");
    expect(database.calls[1]?.params).toContain(1);
    expect(database.calls[1]?.params).toContain(configuration.commitSha);
  });

  it("rejects a controlled export after the withdrawal barrier closes without writing success audit", async () => {
    const database = new ScriptedDatabase([
      new Error("research study run is not exportable"),
    ]);
    const store = createAaisResearchStore({
      configuration,
      database,
      env: {
        AAIS_RESEARCH_EXPORT_ENABLED: "true",
        AAIS_RESEARCH_EXPORT_ACTOR_IDS: "researcher-1",
      },
    });

    await expect(store.exportEvents({
      actor: researcher,
      studyRunId: ids[1],
      format: "json",
      purpose: "approved_analysis",
    })).rejects.toThrow(AaisResearchVisitInactiveError);

    expect(database.calls).toHaveLength(1);
    expect(database.calls[0]?.sql).toContain("public.aais_research_export_events");
    expect(database.calls.some((call) => call.sql.includes("aais_research_export_audit")))
      .toBe(false);
  });

  it("fails controlled export closed as configuration unavailable when migration 0022 is missing", async () => {
    const missingFunction = Object.assign(
      new Error("function public.aais_research_export_events does not exist"),
      { code: "42883" },
    );
    const database = new ScriptedDatabase([missingFunction]);
    const store = createAaisResearchStore({
      configuration,
      database,
      env: {
        AAIS_RESEARCH_EXPORT_ENABLED: "true",
        AAIS_RESEARCH_EXPORT_ACTOR_IDS: "researcher-1",
      },
    });

    await expect(store.exportEvents({
      actor: researcher,
      studyRunId: ids[1],
      format: "json",
      purpose: "approved_analysis",
    })).rejects.toThrow(AaisResearchConfigurationError);
    expect(database.calls).toHaveLength(1);
  });

  it("keeps export closed while restricted raw-text deletion is still in progress", async () => {
    const encryptedIdentity = encryptAaisResearchIdentity({
      actor: student,
      configuration,
      randomBytesImpl: () => Buffer.alloc(12, 6),
    });
    const calls: Array<{ sql: string; params: unknown[] }> = [];
    let visitStatus = "active";
    const database: AaisResearchDatabaseClient = {
      async query(sql, params = []) {
        calls.push({ sql, params });
        if (sql.includes("aais_research_begin_withdrawal")) {
          visitStatus = "withdrawing";
          return { rows: [{
            visit_id: ids[2],
            participant_id: ids[0],
            status: visitStatus,
            active_raw_write_lease_count: 0,
          }] };
        }
        if (sql.includes("aais_research_identity.aais_research_participation_ledger")) {
          return { rows: [{
            ciphertext: encryptedIdentity.ciphertext,
            iv: encryptedIdentity.iv,
            authentication_tag: encryptedIdentity.authenticationTag,
            key_version: encryptedIdentity.keyVersion,
            identity_participant_id: ids[0],
            raw_text_deleted_at: null,
            raw_text_storage: null,
            existing_withdrawal_id: null,
          }] };
        }
        if (sql.includes("aais_research_export_events")) {
          if (visitStatus !== "active" && visitStatus !== "completed") {
            throw new Error("research study run is not exportable");
          }
          return { rows: [createEventRow()] };
        }
        if (sql.includes("aais_research_withdraw(")) {
          visitStatus = "withdrawn";
          return { rows: [{
            withdrawal_id: ids[4],
            participant_id: ids[0],
            visit_id: ids[2],
            local_event_count: 1,
            deletion_request_count: 1,
            identity_deleted: true,
            restricted_raw_text_deleted: true,
            created: true,
          }] };
        }
        if (sql.includes("aais_research_export_audit")) {
          return { rows: [] };
        }
        throw new Error(`Unexpected research SQL: ${sql}`);
      },
    };
    let markDeletionStarted: (() => void) | undefined;
    const deletionStarted = new Promise<void>((resolve) => {
      markDeletionStarted = resolve;
    });
    let finishDeletion: ((value: { storageMode: "postgres" }) => void) | undefined;
    const deleteLearnerRawData = vi.fn(() => {
      markDeletionStarted?.();
      return new Promise<{ storageMode: "postgres" }>((resolve) => {
        finishDeletion = resolve;
      });
    });
    const store = createAaisResearchStore({
      configuration,
      database,
      deleteLearnerRawData,
      randomUuid: () => ids[4],
      now: () => new Date("2026-07-30T10:02:00.000Z"),
      env: {
        AAIS_RESEARCH_PI_ACTOR_IDS: "researcher-1",
        AAIS_RESEARCH_EXPORT_ENABLED: "true",
        AAIS_RESEARCH_EXPORT_ACTOR_IDS: "researcher-1",
      },
    });

    const withdrawal = store.withdrawStudyRun({
      actor: researcher,
      studyRunId: ids[1],
    });
    await deletionStarted;

    await expect(store.exportEvents({
      actor: researcher,
      studyRunId: ids[1],
      format: "json",
      purpose: "approved_analysis",
    })).rejects.toThrow(AaisResearchVisitInactiveError);
    expect(calls.some((call) => call.sql.includes("aais_research_export_audit")))
      .toBe(false);

    finishDeletion?.({ storageMode: "postgres" });
    await expect(withdrawal).resolves.toMatchObject({
      studyRunId: ids[1],
      restrictedRawTextDeleted: true,
    });
  });

  it("fails closed for withdrawal unless the researcher is an approved PI or custodian", async () => {
    const deniedDatabase = new ScriptedDatabase([]);
    const deniedStore = createAaisResearchStore({
      configuration,
      database: deniedDatabase,
      env: { AAIS_RESEARCH_EXPORT_ENABLED: "true" },
    });
    await expect(deniedStore.withdrawStudyRun({
      actor: researcher,
      studyRunId: ids[1],
    })).rejects.toThrow(AaisResearchAuthorizationError);
    expect(deniedDatabase.calls).toHaveLength(0);

    const encryptedIdentity = encryptAaisResearchIdentity({
      actor: student,
      configuration,
      randomBytesImpl: () => Buffer.alloc(12, 4),
    });
    const allowedDatabase = new ScriptedDatabase([
      {
        visit_id: ids[2],
        participant_id: ids[0],
        status: "withdrawing",
        active_raw_write_lease_count: 0,
      },
      {
        ciphertext: encryptedIdentity.ciphertext,
        iv: encryptedIdentity.iv,
        authentication_tag: encryptedIdentity.authenticationTag,
        key_version: encryptedIdentity.keyVersion,
        identity_participant_id: ids[0],
        raw_text_deleted_at: null,
        raw_text_storage: null,
        existing_withdrawal_id: null,
      },
      {
        withdrawal_id: ids[4],
        participant_id: ids[0],
        visit_id: ids[2],
        local_event_count: 4,
        deletion_request_count: 4,
        identity_deleted: true,
        restricted_raw_text_deleted: true,
        created: true,
      },
    ]);
    const deleteLearnerRawData = vi.fn(async () => ({ storageMode: "postgres" as const }));
    const allowedStore = createAaisResearchStore({
      configuration,
      database: allowedDatabase,
      randomUuid: () => ids[4],
      now: () => new Date("2026-07-30T10:02:00.000Z"),
      deleteLearnerRawData,
      env: {
        AAIS_RESEARCH_PI_ACTOR_IDS: "researcher-1",
        AAIS_RESEARCH_EXPORT_ENABLED: "true",
      },
    });
    const withdrawal = await allowedStore.withdrawStudyRun({
      actor: researcher,
      studyRunId: ids[1],
    });

    expect(withdrawal).toMatchObject({
      withdrawalId: ids[4],
      studyRunId: ids[1],
      localEventCount: 4,
      deletionRequestCount: 4,
      identityDeleted: true,
      restrictedRawTextDeleted: true,
    });
    expect(deleteLearnerRawData).toHaveBeenCalledWith("student-1");
    expect(allowedDatabase.calls[0]?.sql).toContain("aais_research_begin_withdrawal");
    expect(allowedDatabase.calls[2]?.sql).toContain("aais_research_withdraw");
    expect(allowedDatabase.calls[2]?.params).toEqual(expect.arrayContaining([
      "aais",
      "ca-pilot-2026",
      "research",
      configuration.lrsNamespace,
    ]));
  });

  it("withdraws by study run after the 90-day identity ciphertext is already absent", async () => {
    const database = new ScriptedDatabase([
      {
        visit_id: ids[2],
        participant_id: ids[0],
        status: "withdrawing",
        active_raw_write_lease_count: 0,
      },
      {
        ciphertext: null,
        iv: null,
        authentication_tag: null,
        key_version: null,
        identity_participant_id: null,
        raw_text_deleted_at: "2026-10-28T10:00:00.000Z",
        raw_text_storage: "postgres",
        existing_withdrawal_id: null,
      },
      {
        withdrawal_id: ids[4],
        participant_id: ids[0],
        visit_id: ids[2],
        local_event_count: 4,
        deletion_request_count: 4,
        identity_deleted: true,
        restricted_raw_text_deleted: true,
        created: true,
      },
    ]);
    const deleteLearnerRawData = vi.fn(async () => ({ storageMode: "postgres" as const }));
    const store = createAaisResearchStore({
      configuration,
      database,
      randomUuid: () => ids[4],
      now: () => new Date("2026-10-29T10:00:00.000Z"),
      deleteLearnerRawData,
      env: { AAIS_RESEARCH_PI_ACTOR_IDS: "researcher-1" },
    });

    await expect(store.withdrawStudyRun({
      actor: researcher,
      studyRunId: ids[1],
    })).resolves.toMatchObject({
      studyRunId: ids[1],
      identityDeleted: true,
      restrictedRawTextDeleted: true,
      created: true,
    });
    expect(database.calls[1]?.sql).toContain(
      "aais_research_identity.aais_research_participation_ledger",
    );
    expect(database.calls[2]?.sql).toContain("aais_research_withdraw");
    expect(deleteLearnerRawData).not.toHaveBeenCalled();
  });

  it("closes the withdrawal write barrier before deletion and waits for a live raw-text lease", async () => {
    const database = new ScriptedDatabase([{
      visit_id: ids[2],
      participant_id: ids[0],
      status: "withdrawing",
      active_raw_write_lease_count: 1,
    }]);
    const deleteLearnerRawData = vi.fn();
    const store = createAaisResearchStore({
      configuration,
      database,
      deleteLearnerRawData,
      now: () => new Date("2026-07-30T10:02:00.000Z"),
      env: { AAIS_RESEARCH_PI_ACTOR_IDS: "researcher-1" },
    });

    await expect(store.withdrawStudyRun({
      actor: researcher,
      studyRunId: ids[1],
    })).rejects.toThrow("waiting for an in-flight raw-text write");
    expect(database.calls).toHaveLength(1);
    expect(database.calls[0]?.sql).toContain("aais_research_begin_withdrawal");
    expect(deleteLearnerRawData).not.toHaveBeenCalled();
  });

  it("acquires and releases a visit-bound raw-text write lease", async () => {
    const database = new ScriptedDatabase([
      {
        lease_id: ids[4],
        visit_id: ids[2],
        expires_at: "2026-07-30T10:05:00.000Z",
      },
      [{ lease_id: ids[4] }],
    ]);
    const store = createAaisResearchStore({
      configuration,
      database,
      randomUuid: () => ids[4],
      now: () => new Date("2026-07-30T10:00:00.000Z"),
    });

    await expect(store.acquireRawTextWriteLease(student)).resolves.toEqual({
      leaseId: ids[4],
      visitId: ids[2],
      expiresAt: "2026-07-30T10:05:00.000Z",
    });
    await expect(store.releaseRawTextWriteLease(ids[4])).resolves.toBe(true);
    expect(database.calls[0]?.sql).toContain("aais_research_acquire_raw_write_lease");
    expect(database.calls[0]?.params).not.toContain(student.id);
    expect(database.calls[1]?.sql).toContain("delete from aais_research_raw_write_leases");
  });

  it("atomically claims outbox rows and completes only its own live lease", async () => {
    const payload = createOutboxPayload();
    const database = new ScriptedDatabase([
      [createClaimedOutboxRow(payload)],
      [{ outbox_id: ids[4] }],
    ]);
    const fetchImpl = vi.fn(async () => new Response("", { status: 200 }));
    const store = createAaisResearchStore({
      configuration,
      database,
      randomUuid: () => ids[0],
      fetchImpl,
      env: {
        AAIS_RESEARCH_LRS_ENDPOINT: "https://aais-research.example/xapi/statements",
        AAIS_RESEARCH_LRS_USERNAME: "research-writer",
        AAIS_RESEARCH_LRS_PASSWORD: "test-only",
        AAIS_RESEARCH_LRS_STORE_ID: configuration.lrsStoreId,
        AAIS_RESEARCH_LRS_RECEIPT_VERIFYING_KEY_ID: receiptKeyId,
        AAIS_RESEARCH_LRS_RECEIPT_VERIFYING_KEY_SPKI: receiptVerifyingSpki,
      },
    });

    await expect(store.flushLrsOutbox(10)).resolves.toEqual({
      selected: 1,
      sent: 1,
      retried: 0,
      deadLetter: 0,
      stoppedReason: "empty",
      hasMore: false,
    });
    expect(database.calls[0]?.sql).toContain("for update skip locked");
    expect(database.calls[0]?.sql).toContain("left join aais_research_events e");
    expect(database.calls[0]?.sql).toContain("e.participant_id as fact_participant_id");
    expect(database.calls[0]?.sql).toContain("e.detail as fact_detail");
    expect(database.calls[0]?.sql).toContain("status = 'sending'");
    expect(database.calls[0]?.sql).toContain("lease_expires_at = now() + interval '2 minutes'");
    expect(database.calls[1]?.sql).toContain("and delivery_claim_id = $6::uuid");
    expect(database.calls[1]?.sql).toContain("and status = 'sending'");
    expect(database.calls[1]?.params).toContain(ids[0]);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it.each(["events", "deletions", "requeue-events", "requeue-deletions"] as const)(
    "parses the safe LRS configuration once before claiming %s work",
    async (action) => {
      const database = new ScriptedDatabase([]);
      const store = createAaisResearchStore({
        configuration,
        database,
        env: {},
      });

      const operation = action === "events"
        ? store.flushLrsOutbox(1)
        : action === "deletions"
          ? store.flushLrsDeletions(1)
          : action === "requeue-events"
            ? store.requeueLrsOutboxDeadLetters(1)
            : store.requeueLrsDeletionDeadLetters(1);
      await expect(operation).rejects.toBeInstanceOf(AaisResearchConfigurationError);
      expect(database.calls).toHaveLength(0);
    },
  );

  it.each([
    { failure: "transport", status: null },
    { failure: "HTTP 408", status: 408 },
    { failure: "HTTP 429", status: 429 },
    { failure: "HTTP 503", status: 503 },
  ])("keeps a fifth-attempt $failure delivery retryable with persisted backoff", async ({ status }) => {
    const database = new ScriptedDatabase([
      [createClaimedOutboxRow(createOutboxPayload(), 4)],
      [{ outbox_id: ids[4] }],
    ]);
    const store = createAaisResearchStore({
      configuration,
      database,
      randomUuid: () => ids[0],
      fetchImpl: status === null
        ? async () => { throw new Error("simulated transport failure"); }
        : async () => new Response("unavailable", { status }),
      env: createResearchLrsEnv(),
    });

    await expect(store.flushLrsOutbox(1)).resolves.toEqual({
      selected: 1,
      sent: 0,
      retried: 1,
      deadLetter: 0,
      stoppedReason: "limit",
      hasMore: true,
    });
    expect(database.calls[0]?.sql).toContain("o.status = 'retry'");
    expect(database.calls[0]?.sql).toContain("o.updated_at <= now()");
    expect(database.calls[1]?.params).toContain("retry");
    expect(database.calls[1]?.params).not.toContain("dead_letter");
  });

  it("dead-letters a provider-rejected immutable event payload without retrying it", async () => {
    const database = new ScriptedDatabase([
      [createClaimedOutboxRow()],
      [{ outbox_id: ids[4] }],
    ]);
    const fetchImpl = vi.fn(async () => new Response("invalid statement", { status: 422 }));
    const store = createAaisResearchStore({
      configuration,
      database,
      randomUuid: () => ids[0],
      fetchImpl,
      env: createResearchLrsEnv(),
    });

    await expect(store.flushLrsOutbox(1)).resolves.toMatchObject({
      selected: 1,
      sent: 0,
      retried: 0,
      deadLetter: 1,
    });
    expect(fetchImpl).toHaveBeenCalledOnce();
    expect(database.calls[1]?.params).toEqual(expect.arrayContaining([
      "dead_letter",
      422,
      "research_lrs_permanent_http_error",
    ]));
  });

  it("stops a worker invocation at its wall-clock budget before claiming another row", async () => {
    const payload = createOutboxPayload();
    const database = new ScriptedDatabase([
      [createClaimedOutboxRow(payload)],
      [{ outbox_id: ids[4] }],
    ]);
    let workerNow = Date.parse("2026-07-30T10:00:00.000Z");
    const fetchImpl = vi.fn(async () => {
      workerNow += 19_500;
      return new Response("", { status: 200 });
    });
    const store = createAaisResearchStore({
      configuration,
      database,
      now: () => new Date(workerNow),
      randomUuid: () => ids[0],
      fetchImpl,
      env: createResearchLrsEnv(),
    });

    await expect(store.flushLrsOutbox(25)).resolves.toEqual({
      selected: 1,
      sent: 1,
      retried: 0,
      deadLetter: 0,
      stoppedReason: "runtime_budget",
      hasMore: true,
    });
    expect(database.calls).toHaveLength(2);
    expect(fetchImpl).toHaveBeenCalledOnce();
  });

  it("never contacts the LRS when a claimed outbox payload drifts from its immutable scope", async () => {
    const payload = {
      ...createOutboxPayload(),
      lrsStoreId: "wrong-store",
    };
    const database = new ScriptedDatabase([
      [createClaimedOutboxRow(payload)],
      [{ outbox_id: ids[4] }],
    ]);
    const fetchImpl = vi.fn();
    const store = createAaisResearchStore({
      configuration,
      database,
      randomUuid: () => ids[0],
      fetchImpl,
      env: createResearchLrsEnv(),
    });

    await expect(store.flushLrsOutbox(1)).resolves.toEqual({
      selected: 1,
      sent: 0,
      retried: 0,
      deadLetter: 1,
      stoppedReason: "limit",
      hasMore: true,
    });
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(database.calls[1]?.sql).toContain("last_error = $9");
    expect(database.calls[1]?.params).toContain("research_lrs_payload_fact_mismatch");
  });

  it.each(getOutboxPayloadFactDriftCases())(
    "fails closed before fetch when claimed outbox %s drifts from the event fact",
    async (_field, mutate) => {
      const payload: Record<string, unknown> = structuredClone(createOutboxPayload());
      mutate(payload);
      const database = new ScriptedDatabase([
        [createClaimedOutboxRow(payload)],
        [{ outbox_id: ids[4] }],
      ]);
      const fetchImpl = vi.fn();
      const store = createAaisResearchStore({
        configuration,
        database,
        randomUuid: () => ids[0],
        fetchImpl,
        env: createResearchLrsEnv(),
      });

      await expect(store.flushLrsOutbox(1)).resolves.toEqual({
        selected: 1,
        sent: 0,
        retried: 0,
        deadLetter: 1,
        stoppedReason: "limit",
        hasMore: true,
      });
      expect(fetchImpl).not.toHaveBeenCalled();
      expect(database.calls[1]?.params).toContain("research_lrs_payload_fact_mismatch");
    },
  );

  it("fails closed before fetch when the claimed outbox has no matching event fact", async () => {
    const claimedRow: Record<string, unknown> = createClaimedOutboxRow();
    claimedRow.fact_event_id = null;
    const database = new ScriptedDatabase([
      [claimedRow],
      [{ outbox_id: ids[4] }],
    ]);
    const fetchImpl = vi.fn();
    const store = createAaisResearchStore({
      configuration,
      database,
      randomUuid: () => ids[0],
      fetchImpl,
      env: createResearchLrsEnv(),
    });

    await expect(store.flushLrsOutbox(1)).resolves.toMatchObject({
      selected: 1,
      sent: 0,
      retried: 0,
      deadLetter: 1,
    });
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(database.calls[1]?.params).toContain("research_lrs_payload_fact_mismatch");
  });

  it.each([200, 404])(
    "keeps LRS deletion status retryable after an unattested HTTP %s response",
    async (status) => {
      const database = new ScriptedDatabase([
        [{
          deletion_id: ids[4],
          statement_id: ids[3],
          lrs_store_id: configuration.lrsStoreId,
          attempts: 0,
        }],
        [{ deletion_id: ids[4] }],
        [],
      ]);
      const store = createAaisResearchStore({
        configuration,
        database,
        randomUuid: () => ids[0],
        fetchImpl: async () => new Response(status === 200 ? "ordinary-receipt" : "not-found", {
          status,
        }),
        env: createResearchLrsEnv(),
      });

      await expect(store.flushLrsDeletions(1)).resolves.toEqual({
        selected: 1,
        confirmed: 0,
        retried: 1,
        deadLetter: 0,
        stoppedReason: "limit",
        hasMore: true,
      });
      expect(database.calls[1]?.sql).toContain("research_lrs_absence_confirmation_pending");
      expect(database.calls[1]?.params).toContain("retry");
    },
  );

  it.each([
    { failure: "transport", status: null },
    { failure: "HTTP 408", status: 408 },
    { failure: "HTTP 429", status: 429 },
    { failure: "HTTP 503", status: 503 },
  ])("keeps a fifth-attempt deletion $failure retryable with backoff", async ({ status }) => {
    const database = new ScriptedDatabase([
      [{
        deletion_id: ids[4],
        statement_id: ids[3],
        lrs_store_id: configuration.lrsStoreId,
        attempts: 4,
      }],
      [{ deletion_id: ids[4] }],
    ]);
    const store = createAaisResearchStore({
      configuration,
      database,
      randomUuid: () => ids[0],
      fetchImpl: status === null
        ? async () => { throw new Error("simulated transport failure"); }
        : async () => new Response("unavailable", { status }),
      env: createResearchLrsEnv(),
    });

    await expect(store.flushLrsDeletions(1)).resolves.toEqual({
      selected: 1,
      confirmed: 0,
      retried: 1,
      deadLetter: 0,
      stoppedReason: "limit",
      hasMore: true,
    });
    expect(database.calls[1]?.sql).toContain("then greatest(not_before");
    expect(database.calls[1]?.params).toContain("retry");
    expect(database.calls[1]?.params).not.toContain("dead_letter");
  });

  it("requeues an event dead letter only after revalidating its immutable event fact", async () => {
    const database = new ScriptedDatabase([
      [createClaimedOutboxRow()],
      [{ outbox_id: ids[4] }],
    ]);
    const store = createAaisResearchStore({
      configuration,
      database,
      randomUuid: () => ids[0],
      env: createResearchLrsEnv(),
    });

    await expect(store.requeueLrsOutboxDeadLetters(1)).resolves.toEqual({
      selected: 1,
      requeued: 1,
      rejected: 0,
      stoppedReason: "limit",
      hasMore: true,
    });
    expect(database.calls[0]?.sql).toContain("o.status = 'dead_letter'");
    expect(database.calls[0]?.sql).toContain("left join aais_research_events e");
    expect(database.calls[1]?.sql).toContain("set status = 'retry', attempts = 0");
  });

  it("keeps a poisoned event dead letter quarantined during bounded requeue", async () => {
    const payload = { ...createOutboxPayload(), studyId: "tampered-study" };
    const database = new ScriptedDatabase([
      [createClaimedOutboxRow(payload)],
      [{ outbox_id: ids[4] }],
    ]);
    const store = createAaisResearchStore({
      configuration,
      database,
      randomUuid: () => ids[0],
      env: createResearchLrsEnv(),
    });

    await expect(store.requeueLrsOutboxDeadLetters(1)).resolves.toEqual({
      selected: 1,
      requeued: 0,
      rejected: 1,
      stoppedReason: "limit",
      hasMore: true,
    });
    expect(database.calls[1]?.sql).toContain("set status = 'dead_letter'");
    expect(database.calls[1]?.params).toContain("research_lrs_payload_fact_mismatch");
  });

  it("requeues a scoped deletion dead letter without contacting the provider", async () => {
    const database = new ScriptedDatabase([
      [{
        deletion_id: ids[4],
        statement_id: ids[3],
        lrs_store_id: configuration.lrsStoreId,
        attempts: 5,
      }],
      [{ deletion_id: ids[4] }],
    ]);
    const fetchImpl = vi.fn();
    const store = createAaisResearchStore({
      configuration,
      database,
      randomUuid: () => ids[0],
      fetchImpl,
      env: createResearchLrsEnv(),
    });

    await expect(store.requeueLrsDeletionDeadLetters(1)).resolves.toEqual({
      selected: 1,
      requeued: 1,
      rejected: 0,
      stoppedReason: "limit",
      hasMore: true,
    });
    expect(database.calls[0]?.sql).toContain("status = 'dead_letter'");
    expect(database.calls[1]?.sql).toContain("set status = 'retry', attempts = 0");
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("confirms an LRS deletion only with matched provider settlement evidence", async () => {
    const receipt = "provider-signed-final-absence-receipt";
    const receiptSha256 = createHash("sha256").update(receipt).digest("hex");
    const confirmedAt = "2026-07-30T10:30:00.000Z";
    const receiptSignature = sign(
      null,
      createAaisResearchLrsAbsenceReceiptEnvelope({
        storeId: configuration.lrsStoreId,
        statementId: ids[3],
        confirmedAt,
        receiptSha256,
        keyId: receiptKeyId,
      }),
      receiptKeyPair.privateKey,
    ).toString("base64url");
    const database = new ScriptedDatabase([
      [{
        deletion_id: ids[4],
        statement_id: ids[3],
        lrs_store_id: configuration.lrsStoreId,
        attempts: 1,
      }],
      [{ deletion_id: ids[4] }],
    ]);
    const store = createAaisResearchStore({
      configuration,
      database,
      randomUuid: () => ids[0],
      fetchImpl: async () => new Response(receipt, {
        status: 200,
        headers: {
          "x-aais-lrs-absence-confirmed-at": confirmedAt,
          "x-aais-lrs-absence-receipt-sha256": receiptSha256,
          "x-aais-lrs-absence-receipt-key-id": receiptKeyId,
          "x-aais-lrs-absence-receipt-signature": receiptSignature,
        },
      }),
      env: createResearchLrsEnv(),
    });

    await expect(store.flushLrsDeletions(1)).resolves.toEqual({
      selected: 1,
      confirmed: 1,
      retried: 0,
      deadLetter: 0,
      stoppedReason: "limit",
      hasMore: true,
    });
    expect(database.calls[1]?.sql).toContain("provider_absence_confirmed_at = $10::timestamptz");
    expect(database.calls[1]?.sql).toContain("provider_receipt_key_id = $11");
    expect(database.calls[1]?.sql).toContain("provider_receipt_signature = $12");
    expect(database.calls[1]?.params).toEqual(expect.arrayContaining([
      receiptSha256,
      confirmedAt,
      receiptKeyId,
      receiptSignature,
    ]));
  });

  it("records visit completion and executes due raw-text, identity, fact, and LRS retention", async () => {
    const completedAt = new Date("2026-07-30T10:03:00.000Z");
    const completionDatabase = new ScriptedDatabase([{
      visit_id: ids[2],
      participant_id: ids[0],
      study_run_id: ids[1],
      status: "completed",
      ended_at: completedAt.toISOString(),
      raw_text_retention_due_at: "2027-01-26T10:03:00.000Z",
      completed: true,
    }]);
    const completionStore = createAaisResearchStore({
      configuration,
      database: completionDatabase,
      now: () => completedAt,
      env: { AAIS_RESEARCH_PI_ACTOR_IDS: "researcher-1" },
    });

    await expect(completionStore.completeStudyRun({
      actor: researcher,
      studyRunId: ids[1],
    })).resolves.toMatchObject({
      visitId: ids[2],
      status: "completed",
      completed: true,
      rawTextRetentionDueAt: "2027-01-26T10:03:00.000Z",
    });
    expect(completionDatabase.calls[0]?.sql).toContain("aais_research_complete_visit");

    const encryptedIdentity = encryptAaisResearchIdentity({
      actor: student,
      configuration,
      randomBytesImpl: () => Buffer.alloc(12, 6),
    });
    const retentionDatabase = new ScriptedDatabase([
      { count: 0, stale_raw_text_write_lease_count: 0 },
      [{
        visit_id: ids[2],
        participant_id: ids[0],
        ciphertext: encryptedIdentity.ciphertext,
        iv: encryptedIdentity.iv,
        authentication_tag: encryptedIdentity.authenticationTag,
        key_version: encryptedIdentity.keyVersion,
      }],
      [{ visit_id: ids[2] }],
      [{ participant_id: ids[0] }],
      {
        local_event_deleted_count: 7,
        lrs_deletion_request_count: 7,
        participation_ledger_deleted_count: 1,
        withdrawal_deleted_count: 0,
        visit_deleted_count: 1,
        participant_deleted_count: 1,
        export_audit_deleted_count: 2,
        retention_receipt_deleted_count: 1,
        lrs_deletion_receipt_deleted_count: 3,
        legacy_archive_receipt_deleted_count: 0,
      },
      [],
    ]);
    const deleteLearnerRawData = vi.fn(async () => ({ storageMode: "postgres" as const }));
    const retentionStore = createAaisResearchStore({
      configuration,
      database: retentionDatabase,
      now: () => completedAt,
      randomUuid: () => ids[4],
      deleteLearnerRawData,
    });

    await expect(retentionStore.runRetention(25)).resolves.toEqual({
      cutoffAt: completedAt.toISOString(),
      rawTextDeletedCount: 1,
      identityDeletedCount: 1,
      localEventDeletedCount: 7,
      lrsDeletionRequestCount: 7,
      participationLedgerDeletedCount: 1,
      withdrawalDeletedCount: 0,
      visitDeletedCount: 1,
      participantDeletedCount: 1,
      exportAuditDeletedCount: 2,
      retentionReceiptDeletedCount: 1,
      lrsDeletionReceiptDeletedCount: 3,
      legacyArchiveReceiptDeletedCount: 0,
      blockedActiveVisitCount: 0,
      staleRawTextWriteLeaseCount: 0,
      status: "success",
      stoppedReason: "empty",
      hasMore: false,
    });
    expect(deleteLearnerRawData).toHaveBeenCalledWith("student-1");
    expect(retentionDatabase.calls[1]?.sql).toContain(
      "from aais_research_raw_write_leases l",
    );
    expect(retentionDatabase.calls[1]?.sql).toContain("and l.visit_id = v.visit_id");
    expect(retentionDatabase.calls[4]?.sql).toContain("aais_research_apply_fact_retention");
    expect(retentionDatabase.calls[5]?.sql).toContain("aais_research_retention_runs");
  });

  it("records a stale raw-text write lease as blocked without reclaiming it", async () => {
    const retentionDatabase = new ScriptedDatabase([
      { count: 0, stale_raw_text_write_lease_count: 1 },
      [],
      [],
      {
        local_event_deleted_count: 0,
        lrs_deletion_request_count: 0,
        participation_ledger_deleted_count: 0,
        withdrawal_deleted_count: 0,
        visit_deleted_count: 0,
        participant_deleted_count: 0,
        export_audit_deleted_count: 0,
        retention_receipt_deleted_count: 0,
        lrs_deletion_receipt_deleted_count: 0,
        legacy_archive_receipt_deleted_count: 0,
      },
      [],
    ]);
    const retentionStore = createAaisResearchStore({
      configuration,
      database: retentionDatabase,
      now: () => new Date("2026-07-30T10:00:00.000Z"),
      randomUuid: () => ids[4],
    });

    await expect(retentionStore.runRetention()).resolves.toMatchObject({
      blockedActiveVisitCount: 0,
      staleRawTextWriteLeaseCount: 1,
      status: "blocked",
    });
    expect(retentionDatabase.calls[0]?.sql).toContain(
      "stale_lease.expires_at <= $5::timestamptz",
    );
    expect(retentionDatabase.calls[4]?.sql).toContain(
      "stale_raw_text_write_lease_count",
    );
    expect(retentionDatabase.calls[4]?.params[19]).toBe(1);
    expect(retentionDatabase.calls[4]?.params[20]).toBe("blocked");
    expect(retentionDatabase.calls.map((call) => call.sql).join("\n")).not.toMatch(
      /delete\s+from\s+aais_research_raw_write_leases/i,
    );
  });

  it("stops retention at its invocation budget and records only completed counts", async () => {
    const encryptedIdentity = encryptAaisResearchIdentity({
      actor: student,
      configuration,
      randomBytesImpl: () => Buffer.alloc(12, 7),
    });
    const rawCandidates = Array.from({ length: 100 }, (_, index) => ({
      visit_id: `20000000-0000-4000-8000-${String(index + 1).padStart(12, "0")}`,
      participant_id: ids[0],
      ciphertext: encryptedIdentity.ciphertext,
      iv: encryptedIdentity.iv,
      authentication_tag: encryptedIdentity.authenticationTag,
      key_version: encryptedIdentity.keyVersion,
    }));
    const retentionDatabase = new ScriptedDatabase([
      { count: 0, stale_raw_text_write_lease_count: 0 },
      rawCandidates,
      [{ visit_id: rawCandidates[0]?.visit_id }],
      [],
    ]);
    let workerNow = Date.parse("2026-07-30T10:00:00.000Z");
    const deleteLearnerRawData = vi.fn(async () => {
      workerNow += 19_500;
      return { storageMode: "postgres" as const };
    });
    const retentionStore = createAaisResearchStore({
      configuration,
      database: retentionDatabase,
      now: () => new Date(workerNow),
      randomUuid: () => ids[4],
      deleteLearnerRawData,
    });

    await expect(retentionStore.runRetention(25)).resolves.toEqual({
      cutoffAt: "2026-07-30T10:00:00.000Z",
      rawTextDeletedCount: 1,
      identityDeletedCount: 0,
      localEventDeletedCount: 0,
      lrsDeletionRequestCount: 0,
      participationLedgerDeletedCount: 0,
      withdrawalDeletedCount: 0,
      visitDeletedCount: 0,
      participantDeletedCount: 0,
      exportAuditDeletedCount: 0,
      retentionReceiptDeletedCount: 0,
      lrsDeletionReceiptDeletedCount: 0,
      legacyArchiveReceiptDeletedCount: 0,
      blockedActiveVisitCount: 0,
      staleRawTextWriteLeaseCount: 0,
      status: "success",
      stoppedReason: "runtime_budget",
      hasMore: true,
    });
    expect(deleteLearnerRawData).toHaveBeenCalledOnce();
    expect(deleteLearnerRawData).toHaveBeenCalledWith("student-1");
    expect(retentionDatabase.calls).toHaveLength(4);
    expect(retentionDatabase.calls[3]?.sql).toContain("aais_research_retention_runs");
    expect(retentionDatabase.calls[3]?.params[6]).toBe(1);
    expect(retentionDatabase.calls.some((call) =>
      call.sql.includes("aais_research_apply_fact_retention")
    )).toBe(false);
  });

  it("returns an empty resumable state when no retention class reaches its limit", async () => {
    const retentionDatabase = new ScriptedDatabase([
      { count: 0, stale_raw_text_write_lease_count: 0 },
      [],
      [],
      {
        local_event_deleted_count: 0,
        lrs_deletion_request_count: 0,
        participation_ledger_deleted_count: 0,
        withdrawal_deleted_count: 0,
        visit_deleted_count: 0,
        participant_deleted_count: 0,
        export_audit_deleted_count: 0,
        retention_receipt_deleted_count: 0,
        lrs_deletion_receipt_deleted_count: 0,
        legacy_archive_receipt_deleted_count: 0,
      },
      [],
    ]);
    const retentionStore = createAaisResearchStore({
      configuration,
      database: retentionDatabase,
      now: () => new Date("2026-07-30T10:00:00.000Z"),
      randomUuid: () => ids[4],
    });

    await expect(retentionStore.runRetention()).resolves.toMatchObject({
      rawTextDeletedCount: 0,
      identityDeletedCount: 0,
      stoppedReason: "empty",
      hasMore: false,
    });
    expect(retentionDatabase.calls[1]?.params.at(-1)).toBe(10);
  });

  it("reports a bounded retention page as resumable when a class reaches the limit", async () => {
    const identityRows = Array.from({ length: 25 }, (_, index) => ({
      participant_id: `30000000-0000-4000-8000-${String(index + 1).padStart(12, "0")}`,
    }));
    const retentionDatabase = new ScriptedDatabase([
      { count: 0, stale_raw_text_write_lease_count: 0 },
      [],
      identityRows,
      {
        local_event_deleted_count: 0,
        lrs_deletion_request_count: 0,
        participation_ledger_deleted_count: 0,
        withdrawal_deleted_count: 0,
        visit_deleted_count: 0,
        participant_deleted_count: 0,
        export_audit_deleted_count: 0,
        retention_receipt_deleted_count: 0,
        lrs_deletion_receipt_deleted_count: 0,
        legacy_archive_receipt_deleted_count: 0,
      },
      [],
    ]);
    const retentionStore = createAaisResearchStore({
      configuration,
      database: retentionDatabase,
      now: () => new Date("2026-07-30T10:00:00.000Z"),
      randomUuid: () => ids[4],
    });

    await expect(retentionStore.runRetention(10_000)).resolves.toMatchObject({
      identityDeletedCount: 25,
      stoppedReason: "limit",
      hasMore: true,
    });
    expect(retentionDatabase.calls[1]?.params.at(-1)).toBe(25);
  });

  it("declares isolated tables, atomic functions, and an executable retention queue", async () => {
    const migration = await readFile(
      new URL("../migrations/postgres/0009_aais_research_study.sql", import.meta.url),
      "utf8",
    );
    for (const table of [
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
    ]) {
      expect(migration).toContain(`create table if not exists ${table}`);
    }
    expect(migration).toContain("create or replace function aais_research_create_visit");
    expect(migration).toContain("create or replace function aais_research_record_event");
    expect(migration).toContain("create or replace function aais_research_withdraw");
    expect(migration).toContain("create or replace function aais_research_complete_visit");
    expect(migration).toContain("create or replace function aais_research_acquire_raw_write_lease");
    expect(migration).toContain("create or replace function aais_research_begin_withdrawal");
    expect(migration).toContain("research withdrawal write barrier is not closed");
    const acquireLeaseFunction = migration.slice(
      migration.indexOf("create or replace function aais_research_acquire_raw_write_lease"),
      migration.indexOf("create or replace function aais_research_record_event"),
    );
    const beginWithdrawalFunction = migration.slice(
      migration.indexOf("create or replace function aais_research_begin_withdrawal"),
      migration.indexOf("create or replace function aais_research_withdraw"),
    );
    const withdrawalFunction = migration.slice(
      migration.indexOf("create or replace function aais_research_withdraw"),
    );
    expect(acquireLeaseFunction).not.toContain("delete from aais_research_raw_write_leases");
    expect(beginWithdrawalFunction).not.toContain("delete from aais_research_raw_write_leases");
    expect(beginWithdrawalFunction).not.toContain("l.expires_at > p_requested_at");
    expect(withdrawalFunction).not.toContain("delete from aais_research_raw_write_leases");
    expect(withdrawalFunction).not.toContain("l.expires_at > p_requested_at");
    expect(migration).toContain("expires_at is an operational stale-lease signal only");
    expect(migration).toContain("create or replace function aais_research_apply_fact_retention");
    expect(migration).toContain("and a.admission_fingerprint = p_admission_fingerprint");
    expect(migration).toContain("raise exception 'research identity nonce collision'");
    expect(migration).toContain("aais_research_participation_scope_key_iv_unique");
    expect(migration).toContain("raise exception 'research participant withdrawn'");
    expect(migration).toContain("withdrawal_id uuid references aais_research_withdrawals");
    expect(migration).toContain("reason text not null check (reason in ('withdrawal', 'retention'))");
    expect(migration).toContain("not_before timestamptz not null default now()");
    expect(migration).toContain("status in ('pending', 'retry', 'sending', 'sent', 'dead_letter', 'cancelled')");
    expect(migration).toContain("delivery_claim_id uuid");
    expect(migration).toContain("lease_expires_at timestamptz");
    expect(migration).toContain("status in ('pending', 'retry', 'deleting', 'confirmed', 'dead_letter')");
    expect(migration).toContain("deletion_claim_id uuid");
    expect(migration).toContain("provider_absence_confirmed_at timestamptz");
    expect(migration).toContain("provider_receipt_key_id text");
    expect(migration).toContain("provider_receipt_signature text");
    expect(migration).toContain("coalesce(max(o.lease_expires_at) filter (where o.status = 'sending'), coordination_now)");
    expect(migration).toContain("not_before = greatest(aais_research_lrs_deletions.not_before, excluded.not_before)");
    expect(migration).toContain("perform o.outbox_id");
    expect(migration).toContain("for update;");
    expect(migration).toContain(
      "text_value !~ '^[A-Za-z0-9][A-Za-z0-9._:/+-]{0,127}$'",
    );
    expect(migration).toContain("when 'operation_id' then");
    expect(migration).toContain("when 'source' then");
    expect(migration).toContain("if text_value <> 'ai_response'");
    expect(migration).toContain("when 'link_host' then");
    expect(migration).toContain("numeric_value > 9007199254740991");
    expect(migration).not.toContain("and o.status = 'sent'");
    expect(migration).toContain("derived_lrs_eligible := true");
    expect(migration).toContain("raise exception 'research event idempotency conflict'");
    expect(migration).toContain("if participant_count >= 30");
    expect(migration).toContain("'inventory_declared'");
  });
});

class ScriptedDatabase implements AaisResearchDatabaseClient {
  readonly calls: Array<{ sql: string; params: unknown[] }> = [];
  private cursor = 0;

  constructor(private readonly results: Array<Error | Record<string, unknown> | Record<string, unknown>[]>) {}

  async query(sql: string, params: unknown[] = []) {
    this.calls.push({ sql, params });
    const current = this.results[this.cursor++] ?? [];
    if (current instanceof Error) {
      throw current;
    }
    return { rows: Array.isArray(current) ? current : [current] };
  }
}

function createEventRow() {
  return {
    event_id: ids[3],
    participant_id: ids[0],
    study_run_id: ids[1],
    visit_id: ids[2],
    project_id: "aais",
    study_id: "ca-pilot-2026",
    environment: "research",
    lrs_namespace: configuration.lrsNamespace,
    condition: "control",
    schema_version: 1,
    app_version: "0.1.0",
    commit_sha: "0123456789abcdef",
    event_sequence: "1",
    client_time: "2026-07-30T10:00:00.000Z",
    server_received_at: "2026-07-30T10:00:00.100Z",
    event_name: "document_artifact_save",
    outcome: "success",
    retry_count: 0,
    disconnect_count: 0,
    ai_latency_ms: null,
    detail: { artifact_length: 12 },
    lrs_eligible: true,
  };
}

function createOutboxPayload() {
  return {
    eventId: ids[3],
    participantId: ids[0],
    studyRunId: ids[1],
    visitId: ids[2],
    projectId: "aais" as const,
    studyId: configuration.studyId,
    environment: "research" as const,
    lrsNamespace: configuration.lrsNamespace,
    lrsStoreId: configuration.lrsStoreId,
    condition: "control",
    schemaVersion: 1 as const,
    appVersion: configuration.appVersion,
    commitSha: configuration.commitSha,
    eventSequence: 1,
    clientTime: "2026-07-30T10:00:00.000Z",
    serverReceivedAt: "2026-07-30T10:00:00.100Z",
    eventName: "document_artifact_save",
    outcome: "success" as const,
    retryCount: 0,
    disconnectCount: 0,
    aiLatencyMs: null,
    detail: { artifact_length: 12 },
    lrsEligible: true as const,
  };
}

function createClaimedOutboxRow(
  payload: Record<string, unknown> = createOutboxPayload(),
  attempts = 0,
) {
  const fact = createEventRow();
  return {
    outbox_id: ids[4],
    event_id: fact.event_id,
    statement_id: fact.event_id,
    payload,
    attempts,
    outbox_project_id: fact.project_id,
    outbox_study_id: fact.study_id,
    outbox_environment: fact.environment,
    outbox_lrs_namespace: fact.lrs_namespace,
    outbox_lrs_eligible: fact.lrs_eligible,
    fact_event_id: fact.event_id,
    fact_client_event_id: fact.event_id,
    fact_participant_id: fact.participant_id,
    fact_study_run_id: fact.study_run_id,
    fact_visit_id: fact.visit_id,
    fact_project_id: fact.project_id,
    fact_study_id: fact.study_id,
    fact_environment: fact.environment,
    fact_lrs_namespace: fact.lrs_namespace,
    fact_condition: fact.condition,
    fact_schema_version: fact.schema_version,
    fact_app_version: fact.app_version,
    fact_commit_sha: fact.commit_sha,
    fact_event_sequence: fact.event_sequence,
    fact_client_time: fact.client_time,
    fact_server_received_at: fact.server_received_at,
    fact_event_name: fact.event_name,
    fact_outcome: fact.outcome,
    fact_retry_count: fact.retry_count,
    fact_disconnect_count: fact.disconnect_count,
    fact_ai_latency_ms: fact.ai_latency_ms,
    fact_detail: fact.detail,
    fact_lrs_eligible: fact.lrs_eligible,
  };
}

function getOutboxPayloadFactDriftCases(): Array<[
  string,
  (payload: Record<string, unknown>) => void,
]> {
  return [
  ["eventId", (payload) => { payload.eventId = "20000000-0000-4000-8000-000000000001"; }],
  ["participantId", (payload) => { payload.participantId = "20000000-0000-4000-8000-000000000002"; }],
  ["studyRunId", (payload) => { payload.studyRunId = "20000000-0000-4000-8000-000000000003"; }],
  ["visitId", (payload) => { payload.visitId = "20000000-0000-4000-8000-000000000004"; }],
  ["projectId", (payload) => { payload.projectId = "mais"; }],
  ["studyId", (payload) => { payload.studyId = "other-study"; }],
  ["environment", (payload) => { payload.environment = "staging"; }],
  ["lrsNamespace", (payload) => {
    payload.lrsNamespace = "https://www.aais.site/xapi/studies/other-study/research/v1";
  }],
  ["lrsStoreId", (payload) => { payload.lrsStoreId = "other-store"; }],
  ["condition", (payload) => { payload.condition = "treatment"; }],
  ["schemaVersion", (payload) => { payload.schemaVersion = 2; }],
  ["appVersion", (payload) => { payload.appVersion = "0.1.1"; }],
  ["commitSha", (payload) => { payload.commitSha = "fedcba9876543210"; }],
  ["eventSequence", (payload) => { payload.eventSequence = 2; }],
  ["clientTime", (payload) => { payload.clientTime = "2026-07-30T10:00:01.000Z"; }],
  ["serverReceivedAt", (payload) => {
    payload.serverReceivedAt = "2026-07-30T10:00:01.100Z";
  }],
  ["eventName", (payload) => { payload.eventName = "content_tab_selected"; }],
  ["outcome", (payload) => { payload.outcome = "failure"; }],
  ["retryCount", (payload) => { payload.retryCount = 1; }],
  ["disconnectCount", (payload) => { payload.disconnectCount = 1; }],
  ["aiLatencyMs", (payload) => { payload.aiLatencyMs = 25; }],
  ["detail", (payload) => { payload.detail = { artifact_length: 13 }; }],
    ["lrsEligible", (payload) => { payload.lrsEligible = false; }],
  ];
}

function createResearchLrsEnv() {
  return {
    AAIS_RESEARCH_LRS_ENDPOINT: "https://aais-research.example/xapi/statements",
    AAIS_RESEARCH_LRS_USERNAME: "research-writer",
    AAIS_RESEARCH_LRS_PASSWORD: "test-only",
    AAIS_RESEARCH_LRS_STORE_ID: configuration.lrsStoreId,
    AAIS_RESEARCH_LRS_RECEIPT_VERIFYING_KEY_ID: receiptKeyId,
    AAIS_RESEARCH_LRS_RECEIPT_VERIFYING_KEY_SPKI: receiptVerifyingSpki,
  };
}
