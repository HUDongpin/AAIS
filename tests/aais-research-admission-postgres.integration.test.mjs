import { createHash, randomUUID } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { Pool } from "pg";
import { createAaisResearchStore } from "@/lib/server/aais-research-store";

const databaseUrl = process.env.AAIS_RESEARCH_INTEGRATION_DATABASE_URL?.trim();
const integration = describe.skipIf(!databaseUrl);

integration("AAIS research admission integrity on real Postgres", () => {
  let pool;

  beforeAll(() => {
    pool = new Pool({ connectionString: databaseUrl, max: 1 });
  });

  afterAll(async () => {
    await pool?.end();
  });

  it("rejects PII-shaped controlled metadata in Postgres", async () => {
    const result = await pool.query(
      `select
         aais_research_detail_is_safe($1::jsonb) as pii_source_is_safe,
         aais_research_detail_is_safe($2::jsonb) as invalid_operation_is_safe,
         aais_research_detail_is_safe($3::jsonb) as controlled_detail_is_safe`,
      [
        JSON.stringify({ source: "MySSN123-45-6789" }),
        JSON.stringify({ operation_id: "MySSN123-45-6789" }),
        JSON.stringify({
          operation_id: "ai-guide-10000000-0000-4000-8000-000000000010",
          source: "ai_response",
          link_protocol: "https:",
          link_host: "external",
        }),
      ],
    );

    expect(result.rows[0]).toEqual({
      pii_source_is_safe: false,
      invalid_operation_is_safe: false,
      controlled_detail_is_safe: true,
    });
  });

  it("keeps an expired but unreleased raw-text writer fenced behind withdrawal", async () => {
    const client = await pool.connect();
    const studyId = `raw-write-barrier-${randomUUID()}`;
    const scope = [
      "aais",
      studyId,
      "research",
      `https://www.aais.site/xapi/studies/${studyId}/research/v1`,
    ];
    const participantId = randomUUID();
    const studyRunId = randomUUID();
    const visitId = randomUUID();
    const admissionFingerprint = "9".repeat(64);
    const leaseId = randomUUID();
    const withdrawalRequestedAt = new Date();
    const acquiredAt = new Date(withdrawalRequestedAt.getTime() - 10 * 60_000);
    const expiresAt = new Date(acquiredAt.getTime() + 5 * 60_000);

    try {
      await client.query("begin");
      await createVisit(client, {
        scope,
        participantId,
        studyRunId,
        visitId,
        admissionFingerprint,
        iv: Buffer.alloc(12, 12),
        identityRetentionDueAt: new Date(Date.now() + 90 * 86_400_000),
        factRetentionDueAt: new Date(Date.now() + 1825 * 86_400_000),
      });
      const lease = await client.query(
        `select * from aais_research_acquire_raw_write_lease(
          $1, $2, $3, $4, $5, $6::uuid, $7::timestamptz, $8::timestamptz
        )`,
        [...scope, admissionFingerprint, leaseId, acquiredAt, expiresAt],
      );
      expect(lease.rows[0]).toMatchObject({ lease_id: leaseId, visit_id: visitId });

      const barrier = await client.query(
        `select * from aais_research_begin_withdrawal(
          $1, $2, $3, $4, $5::uuid, $6::timestamptz
        )`,
        [...scope, studyRunId, withdrawalRequestedAt],
      );
      expect(barrier.rows[0]).toMatchObject({
        status: "withdrawing",
        active_raw_write_lease_count: 1,
      });

      await client.query("savepoint expired_lease_withdrawal");
      let expiredLeaseWithdrawalError;
      try {
        await client.query(
          `select * from aais_research_withdraw(
            $1, $2, $3, $4, $5::uuid, $6::uuid, $7, true, 'postgres', $8::timestamptz
          )`,
          [
            ...scope,
            studyRunId,
            randomUUID(),
            "8".repeat(64),
            withdrawalRequestedAt,
          ],
        );
      } catch (error) {
        expiredLeaseWithdrawalError = error;
      }
      await client.query("rollback to savepoint expired_lease_withdrawal");
      await client.query("release savepoint expired_lease_withdrawal");
      expect(String(expiredLeaseWithdrawalError?.message ?? "")).toContain(
        "research withdrawal has active raw-text write lease",
      );

      await client.query("savepoint post_barrier_write");
      let postBarrierWriteError;
      try {
        await client.query(
          `select * from aais_research_acquire_raw_write_lease(
            $1, $2, $3, $4, $5, $6::uuid, $7::timestamptz, $8::timestamptz
          )`,
          [...scope, admissionFingerprint, randomUUID(), acquiredAt, expiresAt],
        );
      } catch (error) {
        postBarrierWriteError = error;
      }
      await client.query("rollback to savepoint post_barrier_write");
      await client.query("release savepoint post_barrier_write");
      expect(String(postBarrierWriteError?.message ?? "")).toContain(
        "research visit is not active",
      );

      await client.query(
        "delete from aais_research_raw_write_leases where lease_id = $1",
        [leaseId],
      );
      const drained = await client.query(
        `select * from aais_research_begin_withdrawal(
          $1, $2, $3, $4, $5::uuid, $6::timestamptz
        )`,
        [...scope, studyRunId, withdrawalRequestedAt],
      );
      expect(drained.rows[0]).toMatchObject({
        status: "withdrawing",
        active_raw_write_lease_count: 0,
      });
    } finally {
      await client.query("rollback").catch(() => undefined);
      client.release();
    }
  });

  it("preserves one-participation and nonce reservations after identity deletion", async () => {
    const client = await pool.connect();
    const studyId = `admission-integrity-${randomUUID()}`;
    const scope = [
      "aais",
      studyId,
      "research",
      `https://www.aais.site/xapi/studies/${studyId}/research/v1`,
    ];
    const participantId = randomUUID();
    const studyRunId = randomUUID();
    const visitId = randomUUID();
    const admissionFingerprint = "a".repeat(64);
    const iv = Buffer.alloc(12, 7);
    const identityRetentionDueAt = new Date(Date.now() + 90 * 86_400_000);
    const factRetentionDueAt = new Date(Date.now() + 1825 * 86_400_000);

    try {
      await client.query("begin");
      const created = await createVisit(client, {
        scope,
        participantId,
        studyRunId,
        visitId,
        admissionFingerprint,
        iv,
        identityRetentionDueAt,
        factRetentionDueAt,
      });
      expect(created.rows[0]).toMatchObject({
        participant_id: participantId,
        study_run_id: studyRunId,
        visit_id: visitId,
        created: true,
      });

      await client.query(
        `update aais_research_visits
         set status = 'completed', ended_at = now(), raw_text_deleted_at = now(),
           raw_text_storage = 'postgres'
         where visit_id = $1`,
        [visitId],
      );
      await client.query(
        `delete from aais_research_identity.aais_research_identity_map
         where participant_id = $1`,
        [participantId],
      );

      const repeated = await createVisit(client, {
        scope,
        participantId: randomUUID(),
        studyRunId: randomUUID(),
        visitId: randomUUID(),
        admissionFingerprint,
        iv: Buffer.alloc(12, 8),
        identityRetentionDueAt,
        factRetentionDueAt,
      });
      expect(repeated.rows[0]).toMatchObject({
        participant_id: participantId,
        study_run_id: studyRunId,
        visit_id: visitId,
        visit_status: "completed",
        created: false,
      });

      await client.query("savepoint nonce_collision");
      let nonceCollision;
      try {
        await createVisit(client, {
          scope,
          participantId: randomUUID(),
          studyRunId: randomUUID(),
          visitId: randomUUID(),
          admissionFingerprint: "b".repeat(64),
          iv,
          identityRetentionDueAt,
          factRetentionDueAt,
        });
      } catch (error) {
        nonceCollision = error;
      }
      await client.query("rollback to savepoint nonce_collision");
      await client.query("release savepoint nonce_collision");
      expect(String(nonceCollision?.message ?? "")).toContain(
        "research identity nonce collision",
      );

      const withdrawalBarrier = await client.query(
        `select * from aais_research_begin_withdrawal(
          $1, $2, $3, $4, $5::uuid, now()
        )`,
        scope.concat(studyRunId),
      );
      expect(withdrawalBarrier.rows[0]).toMatchObject({
        status: "withdrawing",
        active_raw_write_lease_count: 0,
      });

      const withdrawal = await client.query(
        `select * from aais_research_withdraw(
          $1, $2, $3, $4, $5::uuid, $6::uuid, $7, true, 'postgres', now()
        )`,
        [...scope, studyRunId, randomUUID(), "c".repeat(64)],
      );
      expect(withdrawal.rows[0]).toMatchObject({
        participant_id: participantId,
        visit_id: visitId,
        identity_deleted: true,
        restricted_raw_text_deleted: true,
        created: true,
      });
      const admission = await client.query(
        `select status, admission_fingerprint
         from aais_research_identity.aais_research_participation_ledger
         where visit_id = $1`,
        [visitId],
      );
      expect(admission.rows[0]).toEqual({
        status: "withdrawn",
        admission_fingerprint: admissionFingerprint,
      });

      await client.query("savepoint withdrawn_reentry");
      let withdrawnReentry;
      try {
        await createVisit(client, {
          scope,
          participantId: randomUUID(),
          studyRunId: randomUUID(),
          visitId: randomUUID(),
          admissionFingerprint,
          iv: Buffer.alloc(12, 9),
          identityRetentionDueAt,
          factRetentionDueAt,
        });
      } catch (error) {
        withdrawnReentry = error;
      }
      await client.query("rollback to savepoint withdrawn_reentry");
      await client.query("release savepoint withdrawn_reentry");
      expect(String(withdrawnReentry?.message ?? "")).toContain(
        "research participant withdrawn",
      );
    } finally {
      await client.query("rollback").catch(() => undefined);
      client.release();
    }
  });

  it("purges the bounded admission fact and only safe due operational receipts", async () => {
    const client = await pool.connect();
    const studyId = `retention-integrity-${randomUUID()}`;
    const scope = [
      "aais",
      studyId,
      "research",
      `https://www.aais.site/xapi/studies/${studyId}/research/v1`,
    ];
    const participantId = randomUUID();
    const studyRunId = randomUUID();
    const visitId = randomUUID();
    const dueAt = new Date(Date.now() - 86_400_000);

    try {
      await client.query("begin");
      await createVisit(client, {
        scope,
        participantId,
        studyRunId,
        visitId,
        admissionFingerprint: "d".repeat(64),
        iv: Buffer.alloc(12, 10),
        identityRetentionDueAt: dueAt,
        factRetentionDueAt: dueAt,
      });
      await client.query(
        `update aais_research_visits
         set status = 'completed', ended_at = now(), raw_text_deleted_at = now(),
           raw_text_storage = 'postgres'
         where visit_id = $1`,
        [visitId],
      );
      await client.query(
        `delete from aais_research_identity.aais_research_identity_map
         where participant_id = $1`,
        [participantId],
      );
      await client.query(
        `insert into aais_research_export_audit (
          export_audit_id, project_id, study_id, environment, lrs_namespace,
          actor_fingerprint, purpose, outcome, filters, export_format,
          schema_version, commit_sha, row_count, file_sha256, retention_due_at
        ) values ($1, $2, $3, $4, $5, $6, 'quality_audit', 'success', '{}',
          'json', 1, '0000000', 0, $7, $8)`,
        [randomUUID(), ...scope, "e".repeat(64), "f".repeat(64), dueAt],
      );
      await client.query(
        `insert into aais_research_retention_runs (
          retention_run_id, project_id, study_id, environment, lrs_namespace,
          cutoff_at, raw_text_deleted_count, identity_deleted_count,
          participation_ledger_deleted_count, withdrawal_deleted_count,
          local_event_deleted_count, lrs_deletion_request_count,
          visit_deleted_count, participant_deleted_count,
          export_audit_deleted_count, retention_receipt_deleted_count,
          lrs_deletion_receipt_deleted_count, legacy_archive_receipt_deleted_count,
          blocked_active_visit_count, status, retention_due_at
        ) values ($1, $2, $3, $4, $5, now(), 0, 0, 0, 0, 0, 0, 0, 0,
          0, 0, 0, 0, 0, 'success', $6)`,
        [randomUUID(), ...scope, dueAt],
      );
      await client.query(
        `insert into aais_research_lrs_deletions (
          deletion_id, reason, event_id, statement_id, project_id, study_id,
          environment, lrs_namespace, lrs_store_id, status, receipt_sha256,
          provider_absence_confirmed_at, provider_receipt_key_id,
          provider_receipt_signature,
          confirmed_at, retention_due_at
        ) values ($1, 'retention', $2, $2, $3, $4, $5, $6,
          'integration-store', 'confirmed', $7, now(), $8, $9, now(), $10)`,
        [
          randomUUID(),
          randomUUID(),
          ...scope,
          "2".repeat(64),
          "provider-integration-key-v1",
          "A".repeat(86),
          dueAt,
        ],
      );
      await client.query(
        `insert into aais_research_legacy_archives (
          legacy_archive_id, project_id, study_id, environment, lrs_namespace,
          statement_count, source_pool, status, archived_at, manifest_sha256,
          note, retention_due_at
        ) values ($1, $2, $3, $4, $5, 0, 'integration-archive', 'archived',
          now(), $6, 'synthetic integration receipt', $7)`,
        [randomUUID(), ...scope, "1".repeat(64), dueAt],
      );

      const retained = await client.query(
        `select * from aais_research_apply_fact_retention(
          $1, $2, $3, $4, 'integration-store', now(), 100
        )`,
        scope,
      );
      expect(retained.rows[0]).toMatchObject({
        local_event_deleted_count: 0,
        lrs_deletion_request_count: 0,
        participation_ledger_deleted_count: 1,
        withdrawal_deleted_count: 0,
        visit_deleted_count: 1,
        participant_deleted_count: 1,
        export_audit_deleted_count: 1,
        retention_receipt_deleted_count: 1,
        lrs_deletion_receipt_deleted_count: 1,
        legacy_archive_receipt_deleted_count: 1,
      });
    } finally {
      await client.query("rollback").catch(() => undefined);
      client.release();
    }
  });

  it("binds a client event id to one canonical payload", async () => {
    const client = await pool.connect();
    const studyId = `event-idempotency-${randomUUID()}`;
    const scope = [
      "aais",
      studyId,
      "research",
      `https://www.aais.site/xapi/studies/${studyId}/research/v1`,
    ];
    const visitId = randomUUID();
    const clientEventId = randomUUID();

    try {
      await client.query("begin");
      await createVisit(client, {
        scope,
        participantId: randomUUID(),
        studyRunId: randomUUID(),
        visitId,
        admissionFingerprint: "3".repeat(64),
        iv: Buffer.alloc(12, 11),
        identityRetentionDueAt: new Date(Date.now() + 90 * 86_400_000),
        factRetentionDueAt: new Date(Date.now() + 1825 * 86_400_000),
      });

      const original = await recordEvent(client, {
        scope,
        visitId,
        clientEventId,
        outcome: "success",
        detail: {
          operation_id: "artifact-save-10000000-0000-4000-8000-000000000010",
          artifact_length: 12,
        },
      });
      expect(original.rows[0]).toMatchObject({
        recorded_event_id: clientEventId,
        recorded_event_sequence: "1",
        created: true,
      });

      const exactRetry = await recordEvent(client, {
        scope,
        visitId,
        clientEventId,
        outcome: "success",
        detail: {
          artifact_length: 12,
          operation_id: "artifact-save-10000000-0000-4000-8000-000000000010",
        },
      });
      expect(exactRetry.rows[0]).toMatchObject({
        recorded_event_id: clientEventId,
        recorded_event_sequence: "1",
        created: false,
      });

      await client.query("savepoint changed_payload");
      let conflict;
      try {
        await recordEvent(client, {
          scope,
          visitId,
          clientEventId,
          outcome: "failure",
          detail: {
            operation_id: "artifact-save-10000000-0000-4000-8000-000000000010",
            artifact_length: 12,
          },
        });
      } catch (error) {
        conflict = error;
      }
      await client.query("rollback to savepoint changed_payload");
      await client.query("release savepoint changed_payload");
      expect(String(conflict?.message ?? "")).toContain(
        "research event idempotency conflict",
      );
    } finally {
      await client.query("rollback").catch(() => undefined);
      client.release();
    }
  });

  it("executes the runtime outbox fact binding against real Postgres", async () => {
    const client = await pool.connect();
    const studyId = `outbox-fact-binding-${randomUUID()}`;
    const actor = {
      id: "synthetic-outbox-student",
      role: "student",
      displayName: "Synthetic Outbox Student",
    };
    const configuration = {
      enabled: true,
      projectId: "aais",
      studyId,
      environment: "research",
      lrsNamespace: `https://www.aais.site/xapi/studies/${studyId}/research/v1`,
      lrsStoreId: "integration-outbox-store",
      appVersion: "integration-v1",
      commitSha: "0123456789abcdef",
      conditions: ["control", "treatment"],
      databaseUrl,
      databaseInstanceId: "integration-outbox-db",
      databaseDriver: "pg",
      rehearsalMode: true,
      participantActorIds: [actor.id],
      identityEncryptionKey: Buffer.alloc(32, 21),
      identityFingerprintKey: Buffer.alloc(32, 22),
      identityKeyVersion: "integration-v1",
      identityRetentionDays: 90,
      rawTextRetentionDays: 180,
      factRetentionDays: 1825,
      backupRetentionDays: 35,
    };
    const fetchImpl = vi.fn(async () => new Response("", { status: 200 }));
    const store = createAaisResearchStore({
      configuration,
      database: client,
      fetchImpl,
      env: {
        AAIS_RESEARCH_REHEARSAL_MODE: "true",
        AAIS_RESEARCH_LRS_ENDPOINT: "https://aais-research.example/xapi/statements",
        AAIS_RESEARCH_LRS_USERNAME: "integration-writer",
        AAIS_RESEARCH_LRS_PASSWORD: "synthetic-only",
        AAIS_RESEARCH_LRS_STORE_ID: configuration.lrsStoreId,
      },
    });

    try {
      await client.query("begin");
      const visit = await store.getOrCreateVisit(actor);
      const firstEventId = randomUUID();
      await store.recordEvent(actor, {
        clientEventId: firstEventId,
        clientTime: new Date().toISOString(),
        expectedVisitId: visit.visitId,
        eventName: "document_artifact_save",
        outcome: "success",
        detail: {
          operation_id: `artifact-save-${firstEventId}`,
          artifact_length: 12,
        },
      });

      const firstFlush = await store.flushLrsOutbox(1);
      const firstOutbox = await client.query(
        `select status, last_error, payload
         from aais_research_lrs_outbox
         where event_id = $1::uuid`,
        [firstEventId],
      );
      expect({ firstFlush, firstOutbox: firstOutbox.rows[0] }).toEqual({
        firstFlush: {
          selected: 1,
          sent: 1,
          retried: 0,
          deadLetter: 0,
          stoppedReason: "limit",
          hasMore: true,
        },
        firstOutbox: expect.objectContaining({
          status: "sent",
          last_error: null,
        }),
      });
      expect(fetchImpl).toHaveBeenCalledTimes(1);

      const secondEventId = randomUUID();
      await store.recordEvent(actor, {
        clientEventId: secondEventId,
        clientTime: new Date().toISOString(),
        expectedVisitId: visit.visitId,
        eventName: "document_artifact_save",
        outcome: "success",
        detail: {
          operation_id: `artifact-save-${secondEventId}`,
          artifact_length: 13,
        },
      });
      await client.query(
        `update aais_research_lrs_outbox
         set payload = jsonb_set(payload, '{condition}', to_jsonb($2::text), false)
         where event_id = $1::uuid`,
        [secondEventId, "tampered-condition"],
      );

      await expect(store.flushLrsOutbox(1)).resolves.toEqual({
        selected: 1,
        sent: 0,
        retried: 1,
        deadLetter: 0,
        stoppedReason: "limit",
        hasMore: true,
      });
      expect(fetchImpl).toHaveBeenCalledTimes(1);
      const rejected = await client.query(
        `select status, last_error
         from aais_research_lrs_outbox
         where event_id = $1::uuid`,
        [secondEventId],
      );
      expect(rejected.rows[0]).toEqual({
        status: "retry",
        last_error: "research_lrs_payload_fact_mismatch",
      });
    } finally {
      await client.query("rollback").catch(() => undefined);
      client.release();
    }
  });

  it("admits exactly 30 participants and rejects participant 31 in real Postgres", async () => {
    const client = await pool.connect();
    const studyId = `capacity-boundary-${randomUUID()}`;
    const scope = [
      "aais",
      studyId,
      "research",
      `https://www.aais.site/xapi/studies/${studyId}/research/v1`,
    ];
    const identityRetentionDueAt = new Date(Date.now() + 90 * 86_400_000);
    const factRetentionDueAt = new Date(Date.now() + 1825 * 86_400_000);

    try {
      await client.query("begin");
      const participantIds = [];
      for (let index = 0; index < 30; index += 1) {
        const iv = Buffer.alloc(12);
        iv.writeUInt32BE(index + 1, 8);
        const result = await createVisit(client, {
          scope,
          participantId: randomUUID(),
          studyRunId: randomUUID(),
          visitId: randomUUID(),
          admissionFingerprint: createHash("sha256")
            .update(`synthetic-capacity-${index}`)
            .digest("hex"),
          iv,
          identityRetentionDueAt,
          factRetentionDueAt,
        });
        participantIds.push(result.rows[0].participant_id);
      }
      expect(new Set(participantIds).size).toBe(30);

      const overflowIv = Buffer.alloc(12);
      overflowIv.writeUInt32BE(31, 8);
      await client.query("savepoint participant_31");
      let capacityError;
      try {
        await createVisit(client, {
          scope,
          participantId: randomUUID(),
          studyRunId: randomUUID(),
          visitId: randomUUID(),
          admissionFingerprint: createHash("sha256")
            .update("synthetic-capacity-30")
            .digest("hex"),
          iv: overflowIv,
          identityRetentionDueAt,
          factRetentionDueAt,
        });
      } catch (error) {
        capacityError = error;
      }
      await client.query("rollback to savepoint participant_31");
      await client.query("release savepoint participant_31");
      expect(String(capacityError?.message ?? "")).toContain(
        "research participant capacity reached",
      );

      const counts = await client.query(
        `select count(*)::integer as count
         from aais_research_visits
         where project_id = $1
           and study_id = $2
           and environment = $3
           and lrs_namespace = $4`,
        scope,
      );
      expect(counts.rows[0]).toEqual({ count: 30 });

      const receiptOutput = process.env.AAIS_RESEARCH_INTEGRATION_CAPACITY_RECEIPT_OUTPUT?.trim();
      if (receiptOutput) {
        await writeFile(receiptOutput, `${JSON.stringify({
          evidenceType: "synthetic-real-postgres-capacity-boundary",
          status: "pass",
          transactionMode: "rolled-back",
          sourceOfTruth: "postgres",
          projectId: "aais",
          environment: "research",
          admittedParticipantCount: counts.rows[0].count,
          uniqueParticipantIdsVerified: new Set(participantIds).size === 30,
          participant31Attempted: true,
          participant31Rejected: Boolean(capacityError),
          capacityErrorClass: "research_participant_capacity_reached",
          participantIdentifiers: "omitted",
          identityCiphertext: "omitted",
          credentials: "omitted",
          secrets: "redacted",
        }, null, 2)}\n`, { mode: 0o600, flag: "wx" });
      }
    } finally {
      await client.query("rollback").catch(() => undefined);
      client.release();
    }
  });

  it("exports scoped events and retains a hash-bound audit receipt in real Postgres", async () => {
    const client = await pool.connect();
    const studyId = `controlled-export-${randomUUID()}`;
    const actor = {
      id: "synthetic-export-student",
      role: "student",
      displayName: "Synthetic Export Student",
    };
    const researcher = {
      id: "synthetic-export-researcher",
      role: "researcher",
      displayName: "Synthetic Export Researcher",
    };
    const configuration = {
      enabled: true,
      projectId: "aais",
      studyId,
      environment: "research",
      lrsNamespace: `https://www.aais.site/xapi/studies/${studyId}/research/v1`,
      lrsStoreId: "integration-export-store",
      appVersion: "integration-v1",
      commitSha: "0123456789abcdef",
      conditions: ["control", "treatment"],
      databaseUrl,
      databaseInstanceId: "integration-export-db",
      databaseDriver: "pg",
      rehearsalMode: true,
      participantActorIds: [actor.id],
      identityEncryptionKey: Buffer.alloc(32, 31),
      identityFingerprintKey: Buffer.alloc(32, 32),
      identityKeyVersion: "integration-v1",
      identityRetentionDays: 90,
      rawTextRetentionDays: 180,
      factRetentionDays: 1825,
      backupRetentionDays: 35,
    };
    const store = createAaisResearchStore({
      configuration,
      database: client,
      env: {
        AAIS_RESEARCH_EXPORT_ENABLED: "true",
        AAIS_RESEARCH_EXPORT_ACTOR_IDS: researcher.id,
      },
    });
    let receipt;

    try {
      await client.query("begin");
      const visit = await store.getOrCreateVisit(actor);
      const clientEventId = randomUUID();
      await store.recordEvent(actor, {
        clientEventId,
        clientTime: new Date().toISOString(),
        expectedVisitId: visit.visitId,
        eventName: "document_artifact_save",
        outcome: "success",
        detail: {
          operation_id: `artifact-save-${clientEventId}`,
          artifact_length: 17,
        },
      });

      const exported = await store.exportEvents({
        actor: researcher,
        studyRunId: visit.studyRunId,
        format: "json",
        purpose: "quality_audit",
      });
      const parsed = JSON.parse(exported.body);
      expect(parsed).toMatchObject({
        schemaVersion: 1,
        exportScope: "research-events",
        projectId: "aais",
        studyId,
        environment: "research",
        lrsNamespace: configuration.lrsNamespace,
        studyRunId: visit.studyRunId,
      });
      expect(parsed.events).toHaveLength(1);
      expect(parsed.events[0]).toMatchObject({
        eventId: clientEventId,
        participantId: visit.participantId,
        studyRunId: visit.studyRunId,
        visitId: visit.visitId,
        projectId: "aais",
        studyId,
        environment: "research",
        lrsNamespace: configuration.lrsNamespace,
        schemaVersion: 1,
        lrsEligible: true,
      });
      const bodySha256 = createHash("sha256").update(exported.body).digest("hex");
      expect(exported).toMatchObject({ rowCount: 1, fileSha256: bodySha256 });

      const audit = await client.query(
        `select purpose, outcome, filters, export_format, row_count,
           file_sha256, schema_version, commit_sha
         from aais_research_export_audit
         where project_id = $1
           and study_id = $2
           and environment = $3
           and lrs_namespace = $4
           and file_sha256 = $5`,
        [
          configuration.projectId,
          configuration.studyId,
          configuration.environment,
          configuration.lrsNamespace,
          bodySha256,
        ],
      );
      expect(audit.rows).toHaveLength(1);
      expect(audit.rows[0]).toMatchObject({
        purpose: "quality_audit",
        outcome: "success",
        export_format: "json",
        row_count: 1,
        file_sha256: bodySha256,
        schema_version: 1,
        commit_sha: configuration.commitSha,
      });
      expect(audit.rows[0].filters).toEqual({
        studyRunId: visit.studyRunId,
        limit: 10_000,
      });
      receipt = {
        schemaVersion: 1,
        status: "pass",
        evidenceType: "synthetic-real-postgres-controlled-export",
        transactionMode: "rolled-back",
        sourceOfTruth: "postgres",
        projectId: "aais",
        environment: "research",
        exportedEventCount: 1,
        exportAuditRowCount: audit.rows.length,
        exportBodySha256: bodySha256,
        exactScopedFieldsVerified: true,
        serverScope: ["project_id", "study_id", "environment", "lrs_namespace", "study_run_id"],
        rawEventContent: "omitted",
        participantIdentifiers: "omitted",
        credentials: "omitted",
        secrets: "redacted",
      };
    } finally {
      await client.query("rollback").catch(() => undefined);
      client.release();
    }

    const receiptOutput = process.env.AAIS_RESEARCH_INTEGRATION_EXPORT_RECEIPT_OUTPUT?.trim();
    if (receipt && receiptOutput) {
      await writeFile(receiptOutput, `${JSON.stringify(receipt, null, 2)}\n`, {
        mode: 0o600,
        flag: "wx",
      });
    }
  });
});

function createVisit(client, input) {
  return client.query(
    `select * from aais_research_create_visit(
      $1, $2, $3, $4, $5::uuid, $6::uuid, $7::uuid, $8, $9::bytea,
      $10::bytea, $11::bytea, 'integration-v1', $12::text[], 30,
      $13::timestamptz, $14::timestamptz
    )`,
    [
      ...input.scope,
      input.participantId,
      input.studyRunId,
      input.visitId,
      input.admissionFingerprint,
      Buffer.from("synthetic-ciphertext"),
      input.iv,
      Buffer.alloc(16, 4),
      ["control", "treatment"],
      input.identityRetentionDueAt,
      input.factRetentionDueAt,
    ],
  );
}

function recordEvent(client, input) {
  const now = new Date();
  return client.query(
    `select * from aais_research_record_event(
      $1, $2, $3, $4, 'integration-store', $5::uuid, $6::uuid, $6::uuid,
      1, 'integration-v1', '0123456789abcdef', $7::timestamptz,
      $8::timestamptz, 'document_artifact_save', $9, null, $10::jsonb,
      $11::timestamptz
    )`,
    [
      ...input.scope,
      input.visitId,
      input.clientEventId,
      "2026-07-30T10:00:00.000Z",
      now,
      input.outcome,
      JSON.stringify(input.detail),
      new Date(now.getTime() + 1825 * 86_400_000),
    ],
  );
}
