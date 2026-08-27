import { createHash, randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import type { AaisSessionActor } from "@/lib/server/aais-session";
import {
  AAIS_RESEARCH_MAX_PARTICIPANTS,
  AAIS_RESEARCH_SCHEMA_VERSION,
  AaisResearchConfigurationError,
  AaisResearchValidationError,
  createAaisResearchActorFingerprint,
  decryptAaisResearchIdentity,
  encryptAaisResearchIdentity,
  getAaisResearchConfiguration,
  parseAaisResearchEventInput,
  requireUuid,
  type AaisResearchConfiguration,
  type AaisResearchEventInput,
} from "@/lib/server/aais-research-contract";
import { getAaisLearningStore } from "@/lib/server/aais-learning-store";
import {
  createAaisNeonQueryClient,
  createAaisPostgresPool,
} from "@/lib/server/aais-postgres-pool";
import {
  AAIS_RESEARCH_LRS_REQUEST_TIMEOUT_MS,
  deleteAaisResearchStatement,
  getAaisResearchLrsConfiguration,
  sendAaisResearchStatement,
  type AaisResearchLrsConfiguration,
  type AaisResearchOutboxPayload,
} from "@/lib/server/aais-research-lrs";
import { assertAaisResearchCollectionLaunchGate } from "@/lib/server/aais-research-launch";

const aaisResearchLrsLeaseDurationMs = 120_000;
const aaisResearchLrsLeaseGuardMs = 5_000;
const aaisResearchWorkerDefaultLimit = 10;
const aaisResearchWorkerMaxLimit = 25;
const aaisResearchWorkerMaxRuntimeMs = 20_000;
const aaisResearchWorkerFinalizeGuardMs = 1_000;

export type AaisResearchDatabaseClient = {
  query(sql: string, params?: unknown[]): Promise<{ rows: Array<Record<string, unknown>> }>;
  end?(): Promise<void>;
};

export class AaisResearchAuthorizationError extends Error {
  constructor(message = "AAIS research operation is not authorized.") {
    super(message);
    this.name = "AaisResearchAuthorizationError";
  }
}

export class AaisResearchVisitNotFoundError extends Error {
  constructor() {
    super("AAIS research visit was not found.");
    this.name = "AaisResearchVisitNotFoundError";
  }
}

export class AaisResearchVisitMismatchError extends Error {
  constructor() {
    super("AAIS research event does not match the authenticated actor visit.");
    this.name = "AaisResearchVisitMismatchError";
  }
}

export class AaisResearchEventConflictError extends Error {
  constructor() {
    super("AAIS research client event id is already bound to a different payload.");
    this.name = "AaisResearchEventConflictError";
  }
}

export class AaisResearchEventLimitError extends Error {
  constructor() {
    super("AAIS research visit event limit has been reached.");
    this.name = "AaisResearchEventLimitError";
  }
}

export class AaisResearchVisitInactiveError extends Error {
  constructor() {
    super("AAIS research visit is no longer active.");
    this.name = "AaisResearchVisitInactiveError";
  }
}

export class AaisResearchWithdrawalPendingError extends Error {
  constructor() {
    super("AAIS research withdrawal is waiting for an in-flight raw-text write to finish.");
    this.name = "AaisResearchWithdrawalPendingError";
  }
}

export class AaisResearchCapacityError extends Error {
  constructor() {
    super("AAIS research participant capacity has been reached.");
    this.name = "AaisResearchCapacityError";
  }
}

export class AaisResearchExportDisabledError extends Error {
  constructor() {
    super("AAIS research event export is disabled.");
    this.name = "AaisResearchExportDisabledError";
  }
}

export type AaisResearchVisit = {
  participantId: string;
  studyRunId: string;
  visitId: string;
  condition: string;
  status: string;
  appVersion: string;
  commitSha: string;
  created: boolean;
};

export type AaisRecordedResearchEvent = {
  eventId: string;
  clientEventId: string;
  participantId: string;
  studyRunId: string;
  visitId: string;
  condition: string;
  eventSequence: number;
  serverReceivedAt: string;
  retryCount: number;
  disconnectCount: number;
  lrsEligible: true;
  created: boolean;
};

type CreateStoreInput = {
  configuration?: AaisResearchConfiguration;
  database?: AaisResearchDatabaseClient;
  env?: Record<string, string | undefined>;
  now?: () => Date;
  randomUuid?: () => string;
  fetchImpl?: typeof fetch;
  deleteLearnerRawData?: (actorId: string) => Promise<{
    storageMode: "postgres" | "file";
  }>;
  enforceCollectionLaunchGate?: boolean;
};

type VisitLookup = {
  participantId: string;
  studyRunId: string;
  visitId: string;
  condition: string;
  status: string;
};

type ExportFormat = "json" | "csv";
type ExportPurpose = "approved_analysis" | "reconciliation" | "quality_audit" | "replication";

export function createAaisResearchStore(input: CreateStoreInput = {}) {
  const runtimeEnv = input.env ?? process.env;
  const configuration = input.configuration ?? getAaisResearchConfiguration(runtimeEnv);
  const database = input.database ?? createResearchDatabaseClient(configuration);
  const now = input.now ?? (() => new Date());
  const createUuid = input.randomUuid ?? randomUUID;
  const deleteLearnerRawData = input.deleteLearnerRawData
    ?? (async (actorId: string) => getAaisLearningStore().deleteRestrictedResearchRawText(actorId));
  const enforceCollectionLaunchGate = input.enforceCollectionLaunchGate ?? false;

  return {
    configuration: sanitizeConfiguration(configuration),

    async acquireRawTextWriteLease(actor: AaisSessionActor) {
      if (enforceCollectionLaunchGate) {
        assertAaisResearchCollectionLaunchGate(runtimeEnv);
      }
      requireActorRole(actor, ["student"]);
      const acquiredAt = now();
      // This timestamp is for stale-lease alerting only. SQL never treats it as
      // authority to ignore a writer; only releaseRawTextWriteLease clears it.
      const expiresAt = new Date(acquiredAt.getTime() + 5 * 60_000);
      const leaseId = createUuid();
      const actorFingerprint = createAaisResearchActorFingerprint(
        actor.id,
        configuration.identityFingerprintKey,
      );
      try {
        const result = await database.query(
          `select * from aais_research_acquire_raw_write_lease(
            $1, $2, $3, $4, $5, $6::uuid, $7::timestamptz, $8::timestamptz
          )`,
          scopeParams(configuration, [
            actorFingerprint,
            leaseId,
            acquiredAt.toISOString(),
            expiresAt.toISOString(),
          ]),
        );
        const row = requireRow(result.rows[0], "raw-text write lease");
        return {
          leaseId: readString(row, "lease_id"),
          visitId: readString(row, "visit_id"),
          expiresAt: readDateString(row, "expires_at"),
        };
      } catch (error) {
        const message = getDatabaseErrorMessage(error);
        if (message.includes("visit is not active")) {
          throw new AaisResearchVisitInactiveError();
        }
        if (message.includes("visit not found")) {
          throw new AaisResearchVisitNotFoundError();
        }
        throw error;
      }
    },

    async releaseRawTextWriteLease(leaseIdValue: string) {
      const leaseId = requireUuid(leaseIdValue, "raw-text write lease id");
      const result = await database.query(
        `delete from aais_research_raw_write_leases
        where project_id = $1
          and study_id = $2
          and environment = $3
          and lrs_namespace = $4
          and lease_id = $5::uuid
        returning lease_id`,
        scopeParams(configuration, [leaseId]),
      );
      return result.rows.length === 1;
    },

    async getOrCreateVisit(actor: AaisSessionActor): Promise<AaisResearchVisit> {
      if (enforceCollectionLaunchGate) {
        assertAaisResearchCollectionLaunchGate(runtimeEnv);
      }
      requireActorRole(actor, ["student"]);
      if (!configuration.participantActorIds.includes(actor.id)) {
        throw new AaisResearchAuthorizationError(
          "AAIS research participant is not on the approved roster.",
        );
      }
      const encryptedIdentity = encryptAaisResearchIdentity({ actor, configuration });
      const createdAt = now();
      const participantId = createUuid();
      const studyRunId = createUuid();
      const visitId = createUuid();
      try {
        const result = await database.query(
          `select * from aais_research_create_visit(
            $1, $2, $3, $4, $5::uuid, $6::uuid, $7::uuid, $8, $9::bytea,
            $10::bytea, $11::bytea, $12, $13::text[], $14, $15::timestamptz,
            $16::timestamptz
          )`,
          [
            configuration.projectId,
            configuration.studyId,
            configuration.environment,
            configuration.lrsNamespace,
            participantId,
            studyRunId,
            visitId,
            encryptedIdentity.fingerprint,
            encryptedIdentity.ciphertext,
            encryptedIdentity.iv,
            encryptedIdentity.authenticationTag,
            encryptedIdentity.keyVersion,
            configuration.conditions,
            AAIS_RESEARCH_MAX_PARTICIPANTS,
            addDays(createdAt, configuration.identityRetentionDays).toISOString(),
            addDays(createdAt, configuration.factRetentionDays).toISOString(),
          ],
        );
        const row = requireRow(result.rows[0], "research visit");
        const status = readString(row, "visit_status");
        if (status !== "active") {
          throw new AaisResearchVisitInactiveError();
        }
        return {
          participantId: readString(row, "participant_id"),
          studyRunId: readString(row, "study_run_id"),
          visitId: readString(row, "visit_id"),
          condition: readString(row, "condition"),
          status,
          appVersion: configuration.appVersion,
          commitSha: configuration.commitSha,
          created: readBoolean(row, "created"),
        };
      } catch (error) {
        const message = getDatabaseErrorMessage(error);
        if (message.includes("participant withdrawn")
          || message.includes("withdrawal in progress")) {
          throw new AaisResearchVisitInactiveError();
        }
        if (message.includes("participant capacity")) {
          throw new AaisResearchCapacityError();
        }
        if (message.includes("research identity nonce collision")
          || message.includes("aais_research_identity_scope_key_iv_unique")
          || message.includes("aais_research_participation_scope_key_iv_unique")) {
          throw new AaisResearchConfigurationError(
            "AAIS research identity nonce collision; admission failed closed.",
          );
        }
        throw error;
      }
    },

    async recordEvent(
      actor: AaisSessionActor,
      rawInput: unknown,
    ): Promise<AaisRecordedResearchEvent> {
      if (enforceCollectionLaunchGate) {
        assertAaisResearchCollectionLaunchGate(runtimeEnv);
      }
      requireActorRole(actor, ["student"]);
      const event = parseAaisResearchEventInput(rawInput, createUuid);
      const visit = await findVisitForActor(database, configuration, actor.id);
      if (!visit) {
        throw new AaisResearchVisitNotFoundError();
      }
      if (event.expectedVisitId !== visit.visitId) {
        throw new AaisResearchVisitMismatchError();
      }
      if (visit.status !== "active") {
        throw new AaisResearchVisitInactiveError();
      }
      const serverReceivedAt = now();
      try {
        const result = await database.query(
          `select * from aais_research_record_event(
            $1, $2, $3, $4, $5, $6::uuid, $7::uuid, $8::uuid, $9, $10, $11,
            $12::timestamptz, $13::timestamptz, $14, $15, $16, $17::jsonb,
            $18::timestamptz
          )`,
          [
            configuration.projectId,
            configuration.studyId,
            configuration.environment,
            configuration.lrsNamespace,
            configuration.lrsStoreId,
            visit.visitId,
            event.clientEventId,
            event.clientEventId,
            AAIS_RESEARCH_SCHEMA_VERSION,
            configuration.appVersion,
            configuration.commitSha,
            event.clientTime,
            serverReceivedAt.toISOString(),
            event.eventName,
            event.outcome,
            event.aiLatencyMs,
            JSON.stringify(event.detail),
            addDays(serverReceivedAt, configuration.factRetentionDays).toISOString(),
          ],
        );
        const row = requireRow(result.rows[0], "research event");
        return {
          eventId: readString(row, "recorded_event_id"),
          clientEventId: event.clientEventId,
          participantId: visit.participantId,
          studyRunId: visit.studyRunId,
          visitId: visit.visitId,
          condition: visit.condition,
          eventSequence: readInteger(row, "recorded_event_sequence"),
          serverReceivedAt: serverReceivedAt.toISOString(),
          retryCount: event.retryCount,
          disconnectCount: event.disconnectCount,
          lrsEligible: true,
          created: readBoolean(row, "created"),
        };
      } catch (error) {
        const message = getDatabaseErrorMessage(error);
        if (message.includes("research event idempotency conflict")) {
          throw new AaisResearchEventConflictError();
        }
        if (message.includes("research visit event limit reached")) {
          throw new AaisResearchEventLimitError();
        }
        if (message.includes("visit is not active")) {
          throw new AaisResearchVisitInactiveError();
        }
        if (message.includes("visit not found")) {
          throw new AaisResearchVisitNotFoundError();
        }
        throw error;
      }
    },

    async exportEvents(inputValue: {
      actor: AaisSessionActor;
      studyRunId: string;
      format: ExportFormat;
      purpose: ExportPurpose;
      limit?: number;
    }) {
      requireApprovedResearchExporter(inputValue.actor, runtimeEnv);
      if (runtimeEnv.AAIS_RESEARCH_EXPORT_ENABLED?.trim().toLowerCase() !== "true") {
        throw new AaisResearchExportDisabledError();
      }
      const studyRunId = requireUuid(inputValue.studyRunId, "study run id");
      const limit = normalizeLimit(inputValue.limit, 10_000);
      const format = inputValue.format === "json" ? "json" : "csv";
      const purpose = requireExportPurpose(inputValue.purpose);
      let result: { rows: Array<Record<string, unknown>> };
      try {
        result = await database.query(
          `select * from public.aais_research_export_events(
            $1, $2, $3, $4, $5::uuid, $6::integer
          )`,
          [
            configuration.projectId,
            configuration.studyId,
            configuration.environment,
            configuration.lrsNamespace,
            studyRunId,
            limit,
          ],
        );
      } catch (error) {
        const message = getDatabaseErrorMessage(error);
        if (message.includes("research study run not found")) {
          throw new AaisResearchVisitNotFoundError();
        }
        if (message.includes("research study run is not exportable")) {
          throw new AaisResearchVisitInactiveError();
        }
        if (["42P01", "42703", "42883"].includes(getDatabaseErrorCode(error))) {
          throw new AaisResearchConfigurationError(
            "AAIS research withdrawal-safe export function is unavailable.",
          );
        }
        throw error;
      }
      const events = result.rows.map(normalizeExportEvent);
      const generatedAt = now().toISOString();
      const body = format === "json"
        ? JSON.stringify({
            schemaVersion: 1,
            exportScope: "research-events",
            generatedAt,
            projectId: configuration.projectId,
            studyId: configuration.studyId,
            environment: configuration.environment,
            lrsNamespace: configuration.lrsNamespace,
            studyRunId,
            events,
          }, null, 2)
        : createResearchEventsCsv(events);
      const fileSha256 = createHash("sha256").update(body).digest("hex");
      const actorFingerprint = createAaisResearchActorFingerprint(
        inputValue.actor.id,
        configuration.identityFingerprintKey,
      );
      await database.query(
        `insert into aais_research_export_audit (
          export_audit_id, project_id, study_id, environment, lrs_namespace,
          actor_fingerprint, purpose, outcome, filters, export_format, row_count,
          file_sha256, schema_version, commit_sha, retention_due_at
        ) values (
          $1::uuid, $2, $3, $4, $5, $6, $7, 'success', $8::jsonb, $9, $10,
          $11, $12, $13, $14::timestamptz
        )`,
        [
          createUuid(),
          configuration.projectId,
          configuration.studyId,
          configuration.environment,
          configuration.lrsNamespace,
          actorFingerprint,
          purpose,
          JSON.stringify({ studyRunId, limit }),
          format,
          events.length,
          fileSha256,
          AAIS_RESEARCH_SCHEMA_VERSION,
          configuration.commitSha,
          addDays(new Date(generatedAt), configuration.factRetentionDays).toISOString(),
        ],
      );
      return {
        body,
        contentType: format === "json" ? "application/json; charset=utf-8" : "text/csv; charset=utf-8",
        fileName: `aais-research-${studyRunId}.${format}`,
        rowCount: events.length,
        fileSha256,
      };
    },

    async withdrawStudyRun(inputValue: {
      actor: AaisSessionActor;
      studyRunId: string;
    }) {
      requirePrivilegedResearcher(inputValue.actor, runtimeEnv);
      const studyRunId = requireUuid(inputValue.studyRunId, "study run id");
      const requestedAt = now();
      const actorFingerprint = createAaisResearchActorFingerprint(
        inputValue.actor.id,
        configuration.identityFingerprintKey,
      );
      try {
        const barrierResult = await database.query(
          `select * from aais_research_begin_withdrawal(
            $1, $2, $3, $4, $5::uuid, $6::timestamptz
          )`,
          scopeParams(configuration, [studyRunId, requestedAt.toISOString()]),
        );
        const barrierRow = requireRow(barrierResult.rows[0], "withdrawal write barrier");
        if (readInteger(barrierRow, "active_raw_write_lease_count") > 0) {
          throw new AaisResearchWithdrawalPendingError();
        }
        const identityResult = await database.query(
          `select i.ciphertext, i.iv, i.authentication_tag, i.key_version,
            i.participant_id as identity_participant_id,
            v.raw_text_deleted_at, v.raw_text_storage,
            w.withdrawal_id as existing_withdrawal_id
          from aais_research_visits v
          join aais_research_identity.aais_research_participation_ledger a
            on a.participant_id = v.participant_id
            and a.visit_id = v.visit_id
            and a.study_run_id = v.study_run_id
            and a.project_id = v.project_id
            and a.study_id = v.study_id
            and a.environment = v.environment
            and a.lrs_namespace = v.lrs_namespace
          left join aais_research_identity.aais_research_identity_map i
            on i.participant_id = v.participant_id
            and i.project_id = v.project_id
            and i.study_id = v.study_id
            and i.environment = v.environment
            and i.lrs_namespace = v.lrs_namespace
          left join aais_research_withdrawals w
            on w.visit_id = v.visit_id
            and w.project_id = v.project_id
            and w.study_id = v.study_id
            and w.environment = v.environment
            and w.lrs_namespace = v.lrs_namespace
          where v.project_id = $1
            and v.study_id = $2
            and v.environment = $3
            and v.lrs_namespace = $4
            and v.study_run_id = $5::uuid`,
          scopeParams(configuration, [studyRunId]),
        );
        const identityRow = identityResult.rows[0];
        if (!identityRow) {
          throw new AaisResearchVisitNotFoundError();
        }
        let rawTextStorage = readOptionalRawTextStorage(identityRow, "raw_text_storage")
          ?? "postgres";
        if (!identityRow.existing_withdrawal_id) {
          if (identityRow.identity_participant_id) {
            if (readString(identityRow, "key_version") !== configuration.identityKeyVersion) {
              throw new AaisResearchConfigurationError(
                "AAIS research identity key version is not available for withdrawal.",
              );
            }
            const identity = decryptAaisResearchIdentity({
              ciphertext: readBuffer(identityRow, "ciphertext"),
              iv: readBuffer(identityRow, "iv"),
              authenticationTag: readBuffer(identityRow, "authentication_tag"),
              configuration,
            });
            const rawDeletion = await deleteLearnerRawData(identity.actorId);
            rawTextStorage = rawDeletion.storageMode;
          } else if (!identityRow.raw_text_deleted_at) {
            throw new AaisResearchConfigurationError(
              "AAIS research identity expired before restricted raw-text deletion evidence.",
            );
          }
        }
        const result = await database.query(
          `select * from aais_research_withdraw(
            $1, $2, $3, $4, $5::uuid, $6::uuid, $7, $8, $9, $10::timestamptz
          )`,
          [
            configuration.projectId,
            configuration.studyId,
            configuration.environment,
            configuration.lrsNamespace,
            studyRunId,
            createUuid(),
            actorFingerprint,
            true,
            rawTextStorage,
            requestedAt.toISOString(),
          ],
        );
        const row = requireRow(result.rows[0], "research withdrawal");
        return {
          withdrawalId: readString(row, "withdrawal_id"),
          participantId: readString(row, "participant_id"),
          visitId: readString(row, "visit_id"),
          studyRunId,
          localEventCount: readInteger(row, "local_event_count"),
          deletionRequestCount: readInteger(row, "deletion_request_count"),
          identityDeleted: readBoolean(row, "identity_deleted"),
          restrictedRawTextDeleted: readBoolean(row, "restricted_raw_text_deleted"),
          created: readBoolean(row, "created"),
          withdrawnAt: requestedAt.toISOString(),
        };
      } catch (error) {
        if (getDatabaseErrorMessage(error).includes("study run not found")) {
          throw new AaisResearchVisitNotFoundError();
        }
        throw error;
      }
    },

    async completeStudyRun(inputValue: {
      actor: AaisSessionActor;
      studyRunId: string;
    }) {
      requirePrivilegedResearcher(inputValue.actor, runtimeEnv);
      const studyRunId = requireUuid(inputValue.studyRunId, "study run id");
      const completedAt = now();
      const rawTextRetentionDueAt = addDays(
        completedAt,
        configuration.rawTextRetentionDays,
      );
      try {
        const result = await database.query(
          `select * from aais_research_complete_visit(
            $1, $2, $3, $4, $5::uuid, $6::timestamptz, $7::timestamptz
          )`,
          scopeParams(configuration, [
            studyRunId,
            completedAt.toISOString(),
            rawTextRetentionDueAt.toISOString(),
          ]),
        );
        const row = requireRow(result.rows[0], "research visit completion");
        return {
          visitId: readString(row, "visit_id"),
          participantId: readString(row, "participant_id"),
          studyRunId: readString(row, "study_run_id"),
          status: readString(row, "status"),
          endedAt: readDateString(row, "ended_at"),
          rawTextRetentionDueAt: readDateString(row, "raw_text_retention_due_at"),
          completed: readBoolean(row, "completed"),
        };
      } catch (error) {
        const message = getDatabaseErrorMessage(error);
        if (message.includes("study run not found")) {
          throw new AaisResearchVisitNotFoundError();
        }
        if (message.includes("participant withdrawn")
          || message.includes("withdrawal in progress")) {
          throw new AaisResearchVisitInactiveError();
        }
        throw error;
      }
    },

    async runRetention(limitValue?: number) {
      const limit = normalizeAaisResearchWorkerLimit(limitValue);
      const cutoffAt = now();
      const workerDeadlineAt = cutoffAt.getTime() + aaisResearchWorkerMaxRuntimeMs;
      const hasFinalizeHeadroom = () =>
        workerDeadlineAt - now().getTime() > aaisResearchWorkerFinalizeGuardMs;
      let stoppedReason: "empty" | "limit" | "runtime_budget" | null = null;

      // Read this gate before doing any deletion so a partial count receipt can
      // still report the governance-blocking state without starting new work
      // after the invocation budget has been exhausted.
      const activeOverdueResult = await database.query(
        `select count(*)::integer as count,
          (
            select count(*)::integer
            from aais_research_raw_write_leases stale_lease
            where stale_lease.project_id = $1
              and stale_lease.study_id = $2
              and stale_lease.environment = $3
              and stale_lease.lrs_namespace = $4
              and stale_lease.expires_at <= $5::timestamptz
          ) as stale_raw_text_write_lease_count
        from aais_research_visits v
        join aais_research_identity.aais_research_identity_map i
          on i.participant_id = v.participant_id
          and i.project_id = v.project_id
          and i.study_id = v.study_id
          and i.environment = v.environment
          and i.lrs_namespace = v.lrs_namespace
        where v.project_id = $1
          and v.study_id = $2
          and v.environment = $3
          and v.lrs_namespace = $4
          and v.status = 'active'
          and i.retention_due_at <= $5::timestamptz`,
        scopeParams(configuration, [cutoffAt.toISOString()]),
      );
      const blockedActiveVisitCount = readInteger(
        requireRow(activeOverdueResult.rows[0], "research retention active count"),
        "count",
      );
      const staleRawTextWriteLeaseCount = readInteger(
        requireRow(activeOverdueResult.rows[0], "research retention active count"),
        "stale_raw_text_write_lease_count",
      );
      if (!hasFinalizeHeadroom()) {
        stoppedReason = "runtime_budget";
      }

      let rawCandidateRows: Array<Record<string, unknown>> = [];
      if (!stoppedReason) {
        const rawCandidates = await database.query(
          `select v.visit_id, v.participant_id, i.ciphertext, i.iv,
            i.authentication_tag, i.key_version
          from aais_research_visits v
          join aais_research_identity.aais_research_identity_map i
            on i.participant_id = v.participant_id
            and i.project_id = v.project_id
            and i.study_id = v.study_id
            and i.environment = v.environment
            and i.lrs_namespace = v.lrs_namespace
          where v.project_id = $1
            and v.study_id = $2
            and v.environment = $3
            and v.lrs_namespace = $4
            and v.status = 'completed'
            and v.raw_text_deleted_at is null
            and v.raw_text_retention_due_at is not null
            and least(v.raw_text_retention_due_at, i.retention_due_at) <= $5::timestamptz
            and not exists (
              select 1
              from aais_research_raw_write_leases l
              where l.project_id = v.project_id
                and l.study_id = v.study_id
                and l.environment = v.environment
                and l.lrs_namespace = v.lrs_namespace
                and l.visit_id = v.visit_id
            )
          order by least(v.raw_text_retention_due_at, i.retention_due_at), v.visit_id
          limit $6`,
          scopeParams(configuration, [cutoffAt.toISOString(), limit]),
        );
        rawCandidateRows = rawCandidates.rows;
        if (!hasFinalizeHeadroom()) {
          stoppedReason = "runtime_budget";
        }
      }

      let rawTextDeletedCount = 0;
      for (const row of stoppedReason ? [] : rawCandidateRows) {
        if (!hasFinalizeHeadroom()) {
          stoppedReason = "runtime_budget";
          break;
        }
        if (readString(row, "key_version") !== configuration.identityKeyVersion) {
          throw new AaisResearchConfigurationError(
            "AAIS research identity key version is not available for retention.",
          );
        }
        const identity = decryptAaisResearchIdentity({
          ciphertext: readBuffer(row, "ciphertext"),
          iv: readBuffer(row, "iv"),
          authenticationTag: readBuffer(row, "authentication_tag"),
          configuration,
        });
        const rawDeletion = await deleteLearnerRawData(identity.actorId);
        const updateResult = await database.query(
          `update aais_research_visits
          set raw_text_deleted_at = $6::timestamptz, raw_text_storage = $7
          where project_id = $1
            and study_id = $2
            and environment = $3
            and lrs_namespace = $4
            and visit_id = $5::uuid
            and status = 'completed'
            and raw_text_deleted_at is null
          returning visit_id`,
          scopeParams(configuration, [
            readString(row, "visit_id"),
            cutoffAt.toISOString(),
            rawDeletion.storageMode,
          ]),
        );
        rawTextDeletedCount += updateResult.rows.length;
        if (!hasFinalizeHeadroom()) {
          stoppedReason = "runtime_budget";
          break;
        }
      }

      let identityDeletedCount = 0;
      if (!stoppedReason && hasFinalizeHeadroom()) {
        const identityResult = await database.query(
          `with due as (
            select i.participant_id
            from aais_research_identity.aais_research_identity_map i
            join aais_research_visits v
              on v.participant_id = i.participant_id
              and v.project_id = i.project_id
              and v.study_id = i.study_id
              and v.environment = i.environment
              and v.lrs_namespace = i.lrs_namespace
            where i.project_id = $1
              and i.study_id = $2
              and i.environment = $3
              and i.lrs_namespace = $4
              and i.retention_due_at <= $5::timestamptz
              and v.status = 'completed'
              and v.raw_text_deleted_at is not null
            order by i.retention_due_at, i.participant_id
            for update of i skip locked
            limit $6
          )
          delete from aais_research_identity.aais_research_identity_map i
          using due
          where i.participant_id = due.participant_id
          returning i.participant_id`,
          scopeParams(configuration, [cutoffAt.toISOString(), limit]),
        );
        identityDeletedCount = identityResult.rows.length;
        if (!hasFinalizeHeadroom()) {
          stoppedReason = "runtime_budget";
        }
      } else if (!stoppedReason) {
        stoppedReason = "runtime_budget";
      }

      const factCounts = {
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
      };
      if (!stoppedReason && hasFinalizeHeadroom()) {
        const factResult = await database.query(
          `select * from aais_research_apply_fact_retention(
            $1, $2, $3, $4, $5, $6::timestamptz, $7::integer
          )`,
          scopeParams(configuration, [
            configuration.lrsStoreId,
            cutoffAt.toISOString(),
            limit,
          ]),
        );
        const factRow = requireRow(factResult.rows[0], "research fact retention");
        factCounts.localEventDeletedCount = readInteger(
          factRow,
          "local_event_deleted_count",
        );
        factCounts.lrsDeletionRequestCount = readInteger(
          factRow,
          "lrs_deletion_request_count",
        );
        factCounts.participationLedgerDeletedCount = readInteger(
          factRow,
          "participation_ledger_deleted_count",
        );
        factCounts.withdrawalDeletedCount = readInteger(
          factRow,
          "withdrawal_deleted_count",
        );
        factCounts.visitDeletedCount = readInteger(factRow, "visit_deleted_count");
        factCounts.participantDeletedCount = readInteger(
          factRow,
          "participant_deleted_count",
        );
        factCounts.exportAuditDeletedCount = readInteger(
          factRow,
          "export_audit_deleted_count",
        );
        factCounts.retentionReceiptDeletedCount = readInteger(
          factRow,
          "retention_receipt_deleted_count",
        );
        factCounts.lrsDeletionReceiptDeletedCount = readInteger(
          factRow,
          "lrs_deletion_receipt_deleted_count",
        );
        factCounts.legacyArchiveReceiptDeletedCount = readInteger(
          factRow,
          "legacy_archive_receipt_deleted_count",
        );
        if (!hasFinalizeHeadroom()) {
          stoppedReason = "runtime_budget";
        }
      } else if (!stoppedReason) {
        stoppedReason = "runtime_budget";
      }

      if (!stoppedReason) {
        stoppedReason = rawCandidateRows.length >= limit
          || identityDeletedCount >= limit
          || factCounts.localEventDeletedCount >= limit
          ? "limit"
          : "empty";
      }
      const result = {
        cutoffAt: cutoffAt.toISOString(),
        rawTextDeletedCount,
        identityDeletedCount,
        ...factCounts,
        blockedActiveVisitCount,
        staleRawTextWriteLeaseCount,
        status: blockedActiveVisitCount > 0 || staleRawTextWriteLeaseCount > 0
          ? "blocked" as const
          : "success" as const,
        stoppedReason,
        hasMore: stoppedReason !== "empty",
      };
      await database.query(
        `insert into aais_research_retention_runs (
          retention_run_id, project_id, study_id, environment, lrs_namespace,
          cutoff_at, raw_text_deleted_count, identity_deleted_count,
          participation_ledger_deleted_count, withdrawal_deleted_count,
          local_event_deleted_count, lrs_deletion_request_count,
          visit_deleted_count, participant_deleted_count,
          export_audit_deleted_count, retention_receipt_deleted_count,
          lrs_deletion_receipt_deleted_count, legacy_archive_receipt_deleted_count,
          blocked_active_visit_count, stale_raw_text_write_lease_count,
          status, created_at, retention_due_at
        ) values (
          $5::uuid, $1, $2, $3, $4, $6::timestamptz, $7, $8, $9, $10,
          $11, $12, $13, $14, $15, $16, $17, $18, $19, $20,
          $21, $6::timestamptz, $22::timestamptz
        )`,
        scopeParams(configuration, [
          createUuid(),
          result.cutoffAt,
          result.rawTextDeletedCount,
          result.identityDeletedCount,
          result.participationLedgerDeletedCount,
          result.withdrawalDeletedCount,
          result.localEventDeletedCount,
          result.lrsDeletionRequestCount,
          result.visitDeletedCount,
          result.participantDeletedCount,
          result.exportAuditDeletedCount,
          result.retentionReceiptDeletedCount,
          result.lrsDeletionReceiptDeletedCount,
          result.legacyArchiveReceiptDeletedCount,
          result.blockedActiveVisitCount,
          result.staleRawTextWriteLeaseCount,
          result.status,
          addDays(cutoffAt, configuration.factRetentionDays).toISOString(),
        ]),
      );
      return result;
    },

    async reconcileStudyRun(studyRunIds?: string[]) {
      const normalizedIds = studyRunIds?.map((id) => requireUuid(id, "study run id")) ?? null;
      const eventsResult = await database.query(
        `select event_id, study_run_id, lrs_eligible
        from aais_research_events
        where project_id = $1
          and study_id = $2
          and environment = $3
          and lrs_namespace = $4
          and ($5::uuid[] is null or study_run_id = any($5::uuid[]))
        order by study_run_id, visit_id, event_sequence`,
        [
          configuration.projectId,
          configuration.studyId,
          configuration.environment,
          configuration.lrsNamespace,
          normalizedIds,
        ],
      );
      const outboxResult = await database.query(
        `select o.event_id, o.statement_id, o.status, o.lrs_eligible
        from aais_research_lrs_outbox o
        join aais_research_events e
          on e.event_id = o.event_id
          and e.project_id = o.project_id
          and e.study_id = o.study_id
          and e.environment = o.environment
          and e.lrs_namespace = o.lrs_namespace
        where o.project_id = $1
          and o.study_id = $2
          and o.environment = $3
          and o.lrs_namespace = $4
          and e.project_id = $1
          and e.study_id = $2
          and e.environment = $3
          and e.lrs_namespace = $4
          and ($5::uuid[] is null or e.study_run_id = any($5::uuid[]))
        order by e.study_run_id, e.visit_id, e.event_sequence`,
        [
          configuration.projectId,
          configuration.studyId,
          configuration.environment,
          configuration.lrsNamespace,
          normalizedIds,
        ],
      );
      const eventIds = eventsResult.rows.map((row) => readString(row, "event_id"));
      const lrsEligibleEventIds = eventsResult.rows
        .filter((row) => readBoolean(row, "lrs_eligible"))
        .map((row) => readString(row, "event_id"));
      const outboxEventIds = outboxResult.rows.map((row) => readString(row, "event_id"));
      const statementIds = outboxResult.rows.map((row) => readString(row, "statement_id"));
      const missingOutboxEventIds = difference(eventIds, outboxEventIds);
      const extraOutboxEventIds = difference(outboxEventIds, eventIds);
      const mismatchedStatementIds = outboxResult.rows
        .filter((row) => readString(row, "event_id") !== readString(row, "statement_id"))
        .map((row) => readString(row, "statement_id"));
      return {
        studyRunIds: normalizedIds,
        eventIds,
        lrsEligibleEventIds,
        outboxEventIds,
        statementIds,
        missingOutboxEventIds,
        extraOutboxEventIds,
        mismatchedStatementIds,
        counts: {
          postgresEvents: eventIds.length,
          lrsEligibleEvents: lrsEligibleEventIds.length,
          outboxFacts: outboxEventIds.length,
          sent: outboxResult.rows.filter((row) => readString(row, "status") === "sent").length,
          pending: outboxResult.rows.filter((row) => ["pending", "retry"].includes(readString(row, "status"))).length,
          deadLetter: outboxResult.rows.filter((row) => readString(row, "status") === "dead_letter").length,
        },
        exactOneToOne: missingOutboxEventIds.length === 0
          && extraOutboxEventIds.length === 0
          && mismatchedStatementIds.length === 0
          && eventIds.length === outboxEventIds.length,
      };
    },

    async flushLrsOutbox(limitValue?: number) {
      const limit = normalizeAaisResearchWorkerLimit(limitValue);
      const lrsConfiguration = getAaisResearchWorkerLrsConfiguration(
        runtimeEnv,
        configuration.lrsStoreId,
      );
      const workerDeadlineAt = now().getTime() + aaisResearchWorkerMaxRuntimeMs;
      const processedIds: string[] = [];
      let selected = 0;
      let sent = 0;
      let retried = 0;
      let deadLetter = 0;
      let stoppedReason: "empty" | "limit" | "runtime_budget" = "limit";
      while (selected < limit) {
        if (workerDeadlineAt - now().getTime() <= aaisResearchWorkerFinalizeGuardMs) {
          stoppedReason = "runtime_budget";
          break;
        }
        const claimId = createUuid();
        const claimStartedAt = now().getTime();
        const claimResult = await database.query(
          `with candidate as (
            select outbox_id, event_id, project_id, study_id, environment, lrs_namespace
            from aais_research_lrs_outbox o
            where o.project_id = $1
              and o.study_id = $2
              and o.environment = $3
              and o.lrs_namespace = $4
              and o.lrs_eligible = true
              and not (o.outbox_id = any($5::uuid[]))
              and (
                o.status = 'pending'
                or (
                  o.status = 'retry'
                  and o.updated_at <= now() - (
                    least(300, power(2, least(o.attempts, 8))::integer)
                    * interval '1 second'
                  )
                )
                or (o.status = 'sending' and o.lease_expires_at <= now())
              )
            order by o.created_at, o.outbox_id
            for update skip locked
            limit 1
          )
          update aais_research_lrs_outbox o
          set status = 'sending', delivery_claim_id = $6::uuid,
            lease_expires_at = now() + interval '2 minutes', updated_at = now()
          from candidate c
          left join aais_research_events e
            on e.event_id = c.event_id
            and e.project_id = c.project_id
            and e.study_id = c.study_id
            and e.environment = c.environment
            and e.lrs_namespace = c.lrs_namespace
          where o.outbox_id = c.outbox_id
          returning
            o.outbox_id, o.event_id, o.statement_id, o.payload, o.attempts,
            o.project_id as outbox_project_id,
            o.study_id as outbox_study_id,
            o.environment as outbox_environment,
            o.lrs_namespace as outbox_lrs_namespace,
            o.lrs_eligible as outbox_lrs_eligible,
            e.event_id as fact_event_id,
            e.client_event_id as fact_client_event_id,
            e.participant_id as fact_participant_id,
            e.study_run_id as fact_study_run_id,
            e.visit_id as fact_visit_id,
            e.project_id as fact_project_id,
            e.study_id as fact_study_id,
            e.environment as fact_environment,
            e.lrs_namespace as fact_lrs_namespace,
            e.condition as fact_condition,
            e.schema_version as fact_schema_version,
            e.app_version as fact_app_version,
            e.commit_sha as fact_commit_sha,
            e.event_sequence as fact_event_sequence,
            e.client_time as fact_client_time,
            e.server_received_at as fact_server_received_at,
            e.event_name as fact_event_name,
            e.outcome as fact_outcome,
            e.retry_count as fact_retry_count,
            e.disconnect_count as fact_disconnect_count,
            e.ai_latency_ms as fact_ai_latency_ms,
            e.detail as fact_detail,
            e.lrs_eligible as fact_lrs_eligible`,
          scopeParams(configuration, [processedIds, claimId]),
        );
        const row = claimResult.rows[0];
        if (!row) {
          stoppedReason = "empty";
          break;
        }
        const outboxId = readString(row, "outbox_id");
        processedIds.push(outboxId);
        selected += 1;
        const timeoutMs = getClaimRequestTimeoutMs(
          claimStartedAt,
          now().getTime(),
          workerDeadlineAt,
        );
        if (timeoutMs === null) {
          const released = await releaseExpiredOutboxClaim(
            database,
            configuration,
            outboxId,
            claimId,
          );
          if (released) {
            retried += 1;
          }
          continue;
        }
        let delivery: { ok: boolean; httpStatus: number | null };
        let deliveryError = "research_lrs_http_error";
        let payload: AaisResearchOutboxPayload | null = null;
        try {
          payload = readOutboxPayload(row.payload, {
            configuration,
            eventId: readString(row, "event_id"),
            statementId: readString(row, "statement_id"),
            claimedRow: row,
          });
        } catch {
          deliveryError = "research_lrs_payload_fact_mismatch";
        }
        if (!payload) {
          delivery = { ok: false, httpStatus: null };
        } else {
          try {
            delivery = await sendAaisResearchStatement({
              payload,
              configuration: lrsConfiguration,
              env: runtimeEnv,
              fetchImpl: input.fetchImpl,
              timeoutMs,
            });
          } catch (error) {
            if (error instanceof AaisResearchConfigurationError) {
              await releaseExpiredOutboxClaim(
                database,
                configuration,
                outboxId,
                claimId,
              );
              throw error;
            }
            delivery = { ok: false, httpStatus: null };
          }
        }
        if (delivery.ok) {
          const updateResult = await database.query(
            `update aais_research_lrs_outbox
            set status = 'sent', attempts = attempts + 1, last_http_status = $7,
              last_error = null, sent_at = now(), updated_at = now(),
              delivery_claim_id = null, lease_expires_at = null
            where project_id = $1
              and study_id = $2
              and environment = $3
              and lrs_namespace = $4
              and outbox_id = $5::uuid
              and delivery_claim_id = $6::uuid
              and lrs_eligible = true
              and status = 'sending'
            returning outbox_id`,
            scopeParams(configuration, [outboxId, claimId, delivery.httpStatus]),
          );
          if (updateResult.rows.length > 0) {
            sent += 1;
          }
        } else {
          const nextStatus = !payload
            || isKnownPermanentAaisResearchLrsStatus(delivery.httpStatus)
            ? "dead_letter"
            : "retry";
          if (nextStatus === "dead_letter" && payload) {
            deliveryError = "research_lrs_permanent_http_error";
          }
          const updateResult = await database.query(
            `update aais_research_lrs_outbox
            set status = $7, attempts = attempts + 1, last_http_status = $8,
              last_error = $9, updated_at = now(),
              delivery_claim_id = null, lease_expires_at = null
            where project_id = $1
              and study_id = $2
              and environment = $3
              and lrs_namespace = $4
              and outbox_id = $5::uuid
              and delivery_claim_id = $6::uuid
              and lrs_eligible = true
              and status = 'sending'
            returning outbox_id`,
            scopeParams(configuration, [
              outboxId,
              claimId,
              nextStatus,
              delivery.httpStatus,
              deliveryError,
            ]),
          );
          if (updateResult.rows.length > 0) {
            if (nextStatus === "dead_letter") {
              deadLetter += 1;
            } else {
              retried += 1;
            }
          }
        }
      }
      return {
        selected,
        sent,
        retried,
        deadLetter,
        stoppedReason,
        hasMore: stoppedReason !== "empty",
      };
    },

    async flushLrsDeletions(limitValue?: number) {
      const limit = normalizeAaisResearchWorkerLimit(limitValue);
      const lrsConfiguration = getAaisResearchWorkerLrsConfiguration(
        runtimeEnv,
        configuration.lrsStoreId,
      );
      const workerDeadlineAt = now().getTime() + aaisResearchWorkerMaxRuntimeMs;
      const processedIds: string[] = [];
      let selected = 0;
      let confirmed = 0;
      let retried = 0;
      let deadLetter = 0;
      let stoppedReason: "empty" | "limit" | "runtime_budget" = "limit";
      while (selected < limit) {
        if (workerDeadlineAt - now().getTime() <= aaisResearchWorkerFinalizeGuardMs) {
          stoppedReason = "runtime_budget";
          break;
        }
        const claimId = createUuid();
        const claimStartedAt = now().getTime();
        const claimResult = await database.query(
          `with candidate as (
            select deletion_id
            from aais_research_lrs_deletions
            where project_id = $1
              and study_id = $2
              and environment = $3
              and lrs_namespace = $4
              and lrs_store_id = $5
              and not (deletion_id = any($6::uuid[]))
              and (
                status in ('pending', 'retry')
                or (status = 'deleting' and lease_expires_at <= now())
              )
              and not_before <= now()
            order by created_at, deletion_id
            for update skip locked
            limit 1
          )
          update aais_research_lrs_deletions d
          set status = 'deleting', deletion_claim_id = $7::uuid,
            lease_expires_at = now() + interval '2 minutes', updated_at = now()
          from candidate c
          where d.deletion_id = c.deletion_id
          returning d.deletion_id, d.statement_id, d.lrs_store_id, d.attempts`,
          scopeParams(configuration, [configuration.lrsStoreId, processedIds, claimId]),
        );
        const row = claimResult.rows[0];
        if (!row) {
          stoppedReason = "empty";
          break;
        }
        const deletionId = readString(row, "deletion_id");
        processedIds.push(deletionId);
        selected += 1;
        const timeoutMs = getClaimRequestTimeoutMs(
          claimStartedAt,
          now().getTime(),
          workerDeadlineAt,
        );
        if (timeoutMs === null) {
          const released = await releaseExpiredDeletionClaim(
            database,
            configuration,
            deletionId,
            claimId,
          );
          if (released) {
            retried += 1;
          }
          continue;
        }
        let delivery: {
          ok: boolean;
          httpStatus: number | null;
          receiptSha256: string | null;
          absenceConfirmation: {
            confirmedAt: string;
            receiptKeyId: string;
            receiptSignature: string;
          } | null;
        };
        let payloadInvalid = false;
        let statementId = "";
        let expectedStoreId = "";
        try {
          statementId = requireUuid(
            readString(row, "statement_id"),
            "research LRS deletion statement id",
          );
          expectedStoreId = readString(row, "lrs_store_id");
          if (expectedStoreId !== configuration.lrsStoreId) {
            throw new AaisResearchConfigurationError(
              "AAIS research LRS deletion row has an invalid store id.",
            );
          }
        } catch {
          payloadInvalid = true;
        }
        if (payloadInvalid) {
          delivery = {
            ok: false,
            httpStatus: null,
            receiptSha256: null,
            absenceConfirmation: null,
          };
        } else {
          try {
            delivery = await deleteAaisResearchStatement({
              statementId,
              expectedStoreId,
              configuration: lrsConfiguration,
              env: runtimeEnv,
              fetchImpl: input.fetchImpl,
              timeoutMs,
            });
          } catch (error) {
            if (error instanceof AaisResearchConfigurationError) {
              await releaseExpiredDeletionClaim(
                database,
                configuration,
                deletionId,
                claimId,
              );
              throw error;
            }
            delivery = {
              ok: false,
              httpStatus: null,
              receiptSha256: null,
              absenceConfirmation: null,
            };
          }
        }
        if (delivery.absenceConfirmation) {
          const updateResult = await database.query(
            `update aais_research_lrs_deletions
            set status = 'confirmed', attempts = attempts + 1, last_http_status = $8,
              receipt_sha256 = $9,
              provider_absence_confirmed_at = $10::timestamptz,
              provider_receipt_key_id = $11,
              provider_receipt_signature = $12,
              last_error = null, confirmed_at = now(),
              updated_at = now(), deletion_claim_id = null, lease_expires_at = null
            where project_id = $1
              and study_id = $2
              and environment = $3
              and lrs_namespace = $4
              and lrs_store_id = $5
              and deletion_id = $6::uuid
              and deletion_claim_id = $7::uuid
              and status = 'deleting'
            returning deletion_id`,
            scopeParams(configuration, [
              configuration.lrsStoreId,
              deletionId,
              claimId,
              delivery.httpStatus,
              delivery.receiptSha256,
              delivery.absenceConfirmation.confirmedAt,
              delivery.absenceConfirmation.receiptKeyId,
              delivery.absenceConfirmation.receiptSignature,
            ]),
          );
          if (updateResult.rows.length > 0) {
            confirmed += 1;
          }
        } else {
          const awaitingProviderConfirmation = delivery.ok || delivery.httpStatus === 404;
          const nextStatus = awaitingProviderConfirmation
            ? "retry"
            : payloadInvalid || isKnownPermanentAaisResearchLrsStatus(delivery.httpStatus)
              ? "dead_letter"
              : "retry";
          const retryBackoffSeconds = getAaisResearchLrsRetryBackoffSeconds(
            readInteger(row, "attempts") + 1,
          );
          const updateResult = await database.query(
            `update aais_research_lrs_deletions
            set status = $8, attempts = attempts + 1, last_http_status = $9,
              receipt_sha256 = $10,
              last_error = case when $11::boolean
                then 'research_lrs_absence_confirmation_pending'
                when $12::boolean then 'research_lrs_delete_payload_invalid'
                when $8 = 'dead_letter' then 'research_lrs_delete_permanent_http_error'
                else 'research_lrs_delete_http_error'
              end,
              provider_absence_confirmed_at = null, provider_receipt_key_id = null,
              provider_receipt_signature = null,
              not_before = case when $8 = 'retry'
                then greatest(not_before, now() + ($13::integer * interval '1 second'))
                else not_before
              end,
              updated_at = now(), deletion_claim_id = null, lease_expires_at = null
            where project_id = $1
              and study_id = $2
              and environment = $3
              and lrs_namespace = $4
              and lrs_store_id = $5
              and deletion_id = $6::uuid
              and deletion_claim_id = $7::uuid
              and status = 'deleting'
            returning deletion_id`,
            scopeParams(configuration, [
              configuration.lrsStoreId,
              deletionId,
              claimId,
              nextStatus,
              delivery.httpStatus,
              delivery.receiptSha256,
              awaitingProviderConfirmation,
              payloadInvalid,
              retryBackoffSeconds,
            ]),
          );
          if (updateResult.rows.length > 0) {
            if (nextStatus === "dead_letter") {
              deadLetter += 1;
            } else {
              retried += 1;
            }
          }
        }
      }
      return {
        selected,
        confirmed,
        retried,
        deadLetter,
        stoppedReason,
        hasMore: stoppedReason !== "empty",
      };
    },

    async requeueLrsOutboxDeadLetters(limitValue?: number) {
      const limit = normalizeAaisResearchWorkerLimit(limitValue);
      getAaisResearchWorkerLrsConfiguration(runtimeEnv, configuration.lrsStoreId);
      const workerDeadlineAt = now().getTime() + aaisResearchWorkerMaxRuntimeMs;
      const processedIds: string[] = [];
      let selected = 0;
      let requeued = 0;
      let rejected = 0;
      let stoppedReason: "empty" | "limit" | "runtime_budget" = "limit";
      while (selected < limit) {
        if (workerDeadlineAt - now().getTime() <= aaisResearchWorkerFinalizeGuardMs) {
          stoppedReason = "runtime_budget";
          break;
        }
        const claimId = createUuid();
        const claimResult = await database.query(
          `with candidate as (
            select outbox_id, event_id, project_id, study_id, environment, lrs_namespace
            from aais_research_lrs_outbox o
            where o.project_id = $1
              and o.study_id = $2
              and o.environment = $3
              and o.lrs_namespace = $4
              and o.lrs_eligible = true
              and o.status = 'dead_letter'
              and not (o.outbox_id = any($5::uuid[]))
            order by o.created_at, o.outbox_id
            for update skip locked
            limit 1
          )
          update aais_research_lrs_outbox o
          set status = 'sending', delivery_claim_id = $6::uuid,
            lease_expires_at = now() + interval '2 minutes', updated_at = now()
          from candidate c
          left join aais_research_events e
            on e.event_id = c.event_id
            and e.project_id = c.project_id
            and e.study_id = c.study_id
            and e.environment = c.environment
            and e.lrs_namespace = c.lrs_namespace
          where o.outbox_id = c.outbox_id
          returning
            o.outbox_id, o.event_id, o.statement_id, o.payload, o.attempts,
            o.project_id as outbox_project_id,
            o.study_id as outbox_study_id,
            o.environment as outbox_environment,
            o.lrs_namespace as outbox_lrs_namespace,
            o.lrs_eligible as outbox_lrs_eligible,
            e.event_id as fact_event_id,
            e.client_event_id as fact_client_event_id,
            e.participant_id as fact_participant_id,
            e.study_run_id as fact_study_run_id,
            e.visit_id as fact_visit_id,
            e.project_id as fact_project_id,
            e.study_id as fact_study_id,
            e.environment as fact_environment,
            e.lrs_namespace as fact_lrs_namespace,
            e.condition as fact_condition,
            e.schema_version as fact_schema_version,
            e.app_version as fact_app_version,
            e.commit_sha as fact_commit_sha,
            e.event_sequence as fact_event_sequence,
            e.client_time as fact_client_time,
            e.server_received_at as fact_server_received_at,
            e.event_name as fact_event_name,
            e.outcome as fact_outcome,
            e.retry_count as fact_retry_count,
            e.disconnect_count as fact_disconnect_count,
            e.ai_latency_ms as fact_ai_latency_ms,
            e.detail as fact_detail,
            e.lrs_eligible as fact_lrs_eligible`,
          scopeParams(configuration, [processedIds, claimId]),
        );
        const row = claimResult.rows[0];
        if (!row) {
          stoppedReason = "empty";
          break;
        }
        const outboxId = requireUuid(readString(row, "outbox_id"), "research LRS outbox id");
        processedIds.push(outboxId);
        selected += 1;
        let payloadValid = true;
        try {
          readOutboxPayload(row.payload, {
            configuration,
            eventId: readString(row, "event_id"),
            statementId: readString(row, "statement_id"),
            claimedRow: row,
          });
        } catch {
          payloadValid = false;
        }
        const updateResult = payloadValid
          ? await database.query(
            `update aais_research_lrs_outbox
            set status = 'retry', attempts = 0, last_http_status = null,
              last_error = 'research_lrs_dead_letter_requeued', updated_at = now(),
              delivery_claim_id = null, lease_expires_at = null
            where project_id = $1
              and study_id = $2
              and environment = $3
              and lrs_namespace = $4
              and outbox_id = $5::uuid
              and delivery_claim_id = $6::uuid
              and lrs_eligible = true
              and status = 'sending'
            returning outbox_id`,
            scopeParams(configuration, [outboxId, claimId]),
          )
          : await database.query(
            `update aais_research_lrs_outbox
            set status = 'dead_letter',
              last_error = $7, updated_at = now(),
              delivery_claim_id = null, lease_expires_at = null
            where project_id = $1
              and study_id = $2
              and environment = $3
              and lrs_namespace = $4
              and outbox_id = $5::uuid
              and delivery_claim_id = $6::uuid
              and lrs_eligible = true
              and status = 'sending'
            returning outbox_id`,
            scopeParams(configuration, [
              outboxId,
              claimId,
              "research_lrs_payload_fact_mismatch",
            ]),
          );
        if (updateResult.rows.length > 0) {
          if (payloadValid) {
            requeued += 1;
          } else {
            rejected += 1;
          }
        }
      }
      return {
        selected,
        requeued,
        rejected,
        stoppedReason,
        hasMore: stoppedReason !== "empty",
      };
    },

    async requeueLrsDeletionDeadLetters(limitValue?: number) {
      const limit = normalizeAaisResearchWorkerLimit(limitValue);
      getAaisResearchWorkerLrsConfiguration(runtimeEnv, configuration.lrsStoreId);
      const workerDeadlineAt = now().getTime() + aaisResearchWorkerMaxRuntimeMs;
      const processedIds: string[] = [];
      let selected = 0;
      let requeued = 0;
      let rejected = 0;
      let stoppedReason: "empty" | "limit" | "runtime_budget" = "limit";
      while (selected < limit) {
        if (workerDeadlineAt - now().getTime() <= aaisResearchWorkerFinalizeGuardMs) {
          stoppedReason = "runtime_budget";
          break;
        }
        const claimId = createUuid();
        const claimResult = await database.query(
          `with candidate as (
            select deletion_id
            from aais_research_lrs_deletions
            where project_id = $1
              and study_id = $2
              and environment = $3
              and lrs_namespace = $4
              and lrs_store_id = $5
              and status = 'dead_letter'
              and not (deletion_id = any($6::uuid[]))
            order by created_at, deletion_id
            for update skip locked
            limit 1
          )
          update aais_research_lrs_deletions d
          set status = 'deleting', deletion_claim_id = $7::uuid,
            lease_expires_at = now() + interval '2 minutes', updated_at = now()
          from candidate c
          where d.deletion_id = c.deletion_id
          returning d.deletion_id, d.statement_id, d.lrs_store_id, d.attempts`,
          scopeParams(configuration, [configuration.lrsStoreId, processedIds, claimId]),
        );
        const row = claimResult.rows[0];
        if (!row) {
          stoppedReason = "empty";
          break;
        }
        const deletionId = requireUuid(
          readString(row, "deletion_id"),
          "research LRS deletion id",
        );
        processedIds.push(deletionId);
        selected += 1;
        let payloadValid = true;
        try {
          requireUuid(
            readString(row, "statement_id"),
            "research LRS deletion statement id",
          );
          if (readString(row, "lrs_store_id") !== configuration.lrsStoreId) {
            throw new AaisResearchConfigurationError(
              "AAIS research LRS deletion row has an invalid store id.",
            );
          }
        } catch {
          payloadValid = false;
        }
        const updateResult = payloadValid
          ? await database.query(
            `update aais_research_lrs_deletions
            set status = 'retry', attempts = 0, last_http_status = null,
              receipt_sha256 = null,
              provider_absence_confirmed_at = null, provider_receipt_key_id = null,
              provider_receipt_signature = null,
              last_error = 'research_lrs_dead_letter_requeued', not_before = now(),
              updated_at = now(), deletion_claim_id = null, lease_expires_at = null
            where project_id = $1
              and study_id = $2
              and environment = $3
              and lrs_namespace = $4
              and lrs_store_id = $5
              and deletion_id = $6::uuid
              and deletion_claim_id = $7::uuid
              and status = 'deleting'
            returning deletion_id`,
            scopeParams(configuration, [configuration.lrsStoreId, deletionId, claimId]),
          )
          : await database.query(
            `update aais_research_lrs_deletions
            set status = 'dead_letter',
              last_error = $8, updated_at = now(),
              deletion_claim_id = null, lease_expires_at = null
            where project_id = $1
              and study_id = $2
              and environment = $3
              and lrs_namespace = $4
              and lrs_store_id = $5
              and deletion_id = $6::uuid
              and deletion_claim_id = $7::uuid
              and status = 'deleting'
            returning deletion_id`,
            scopeParams(configuration, [
              configuration.lrsStoreId,
              deletionId,
              claimId,
              "research_lrs_delete_payload_invalid",
            ]),
          );
        if (updateResult.rows.length > 0) {
          if (payloadValid) {
            requeued += 1;
          } else {
            rejected += 1;
          }
        }
      }
      return {
        selected,
        requeued,
        rejected,
        stoppedReason,
        hasMore: stoppedReason !== "empty",
      };
    },
  };
}

let cachedStore: ReturnType<typeof createAaisResearchStore> | null = null;
let cachedStoreKey = "";

export function getAaisResearchStore() {
  const configuration = getAaisResearchConfiguration();
  const key = [
    configuration.databaseUrl,
    configuration.studyId,
    configuration.environment,
    configuration.lrsNamespace,
    configuration.lrsStoreId,
    configuration.databaseInstanceId,
    configuration.commitSha,
    configuration.rehearsalMode ? "rehearsal" : "formal",
    configuration.participantActorIds.join(","),
    configuration.identityKeyVersion,
    createHash("sha256").update(configuration.identityEncryptionKey).digest("hex"),
    createHash("sha256").update(configuration.identityFingerprintKey).digest("hex"),
    configuration.identityRetentionDays,
    configuration.rawTextRetentionDays,
    configuration.factRetentionDays,
    configuration.backupRetentionDays,
  ].join("\u0000");
  if (!cachedStore || cachedStoreKey !== key) {
    cachedStore = createAaisResearchStore({
      configuration,
      enforceCollectionLaunchGate: true,
    });
    cachedStoreKey = key;
  }
  return cachedStore;
}

async function findVisitForActor(
  database: AaisResearchDatabaseClient,
  configuration: AaisResearchConfiguration,
  actorId: string,
): Promise<VisitLookup | null> {
  const fingerprint = createAaisResearchActorFingerprint(
    actorId,
    configuration.identityFingerprintKey,
  );
  const result = await database.query(
    `select v.participant_id, v.study_run_id, v.visit_id, v.condition, v.status
    from aais_research_identity.aais_research_participation_ledger a
    join aais_research_visits v
      on v.participant_id = a.participant_id
      and v.visit_id = a.visit_id
      and v.study_run_id = a.study_run_id
      and v.project_id = a.project_id
      and v.study_id = a.study_id
      and v.environment = a.environment
      and v.lrs_namespace = a.lrs_namespace
    where a.project_id = $1
      and a.study_id = $2
      and a.environment = $3
      and a.lrs_namespace = $4
      and v.project_id = $1
      and v.study_id = $2
      and v.environment = $3
      and v.lrs_namespace = $4
      and a.admission_fingerprint = $5`,
    scopeParams(configuration, [fingerprint]),
  );
  if (!result.rows[0]) {
    return null;
  }
  return {
    participantId: readString(result.rows[0], "participant_id"),
    studyRunId: readString(result.rows[0], "study_run_id"),
    visitId: readString(result.rows[0], "visit_id"),
    condition: readString(result.rows[0], "condition"),
    status: readString(result.rows[0], "status"),
  };
}

function createResearchDatabaseClient(
  configuration: AaisResearchConfiguration,
): AaisResearchDatabaseClient {
  if (configuration.databaseDriver === "neon-serverless") {
    return createAaisNeonQueryClient(configuration.databaseUrl);
  }
  return createAaisPostgresPool(configuration.databaseUrl) as AaisResearchDatabaseClient;
}

function requireActorRole(
  actor: AaisSessionActor,
  roles: AaisSessionActor["role"][],
) {
  if (!roles.includes(actor.role)) {
    throw new AaisResearchAuthorizationError();
  }
}

function requirePrivilegedResearcher(
  actor: AaisSessionActor,
  env: Record<string, string | undefined>,
) {
  requireActorRole(actor, ["researcher"]);
  const allowed = new Set([
    ...readActorIdAllowlist(env.AAIS_RESEARCH_PI_ACTOR_IDS),
    ...readActorIdAllowlist(env.AAIS_RESEARCH_DATA_CUSTODIAN_ACTOR_IDS),
  ]);
  if (!allowed.has(actor.id)) {
    throw new AaisResearchAuthorizationError(
      "AAIS research withdrawal requires PI or data-custodian authorization.",
    );
  }
}

function requireApprovedResearchExporter(
  actor: AaisSessionActor,
  env: Record<string, string | undefined>,
) {
  requireActorRole(actor, ["researcher"]);
  const allowed = new Set(readActorIdAllowlist(env.AAIS_RESEARCH_EXPORT_ACTOR_IDS));
  if (!allowed.has(actor.id)) {
    throw new AaisResearchAuthorizationError(
      "AAIS research export requires a signed actor grant.",
    );
  }
}

function readActorIdAllowlist(value: string | undefined) {
  return (value ?? "")
    .split(",")
    .map((item) => item.trim())
    .filter((item) => /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(item));
}

function scopeParams(configuration: AaisResearchConfiguration, extra: unknown[] = []) {
  return [
    configuration.projectId,
    configuration.studyId,
    configuration.environment,
    configuration.lrsNamespace,
    ...extra,
  ];
}

function sanitizeConfiguration(configuration: AaisResearchConfiguration) {
  return {
    enabled: true as const,
    projectId: configuration.projectId,
    studyId: configuration.studyId,
    environment: configuration.environment,
    lrsNamespace: configuration.lrsNamespace,
    lrsStoreId: configuration.lrsStoreId,
    appVersion: configuration.appVersion,
    commitSha: configuration.commitSha,
    conditions: [...configuration.conditions],
    maxParticipants: AAIS_RESEARCH_MAX_PARTICIPANTS,
    participantRosterSize: configuration.participantActorIds.length,
    rehearsalMode: configuration.rehearsalMode,
    databaseInstanceId: configuration.databaseInstanceId,
    identityRetentionDays: configuration.identityRetentionDays,
    rawTextRetentionDays: configuration.rawTextRetentionDays,
    factRetentionDays: configuration.factRetentionDays,
    backupRetentionDays: configuration.backupRetentionDays,
    storage: "postgres" as const,
    sourceOfTruth: "postgres" as const,
    secrets: "redacted" as const,
  };
}

function addDays(value: Date, days: number) {
  return new Date(value.getTime() + days * 24 * 60 * 60 * 1000);
}

function normalizeLimit(value: number | undefined, fallback: number) {
  if (value === undefined) {
    return fallback;
  }
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new AaisResearchValidationError("AAIS research limit is invalid.");
  }
  return Math.min(value, 10_000);
}

export function normalizeAaisResearchWorkerLimit(value?: number) {
  if (value === undefined) {
    return aaisResearchWorkerDefaultLimit;
  }
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new AaisResearchValidationError("AAIS research worker limit is invalid.");
  }
  return Math.min(value, aaisResearchWorkerMaxLimit);
}

function getAaisResearchWorkerLrsConfiguration(
  env: Record<string, string | undefined>,
  expectedStoreId: string,
): AaisResearchLrsConfiguration {
  const lrsConfiguration = getAaisResearchLrsConfiguration(env);
  if (lrsConfiguration.storeId !== expectedStoreId) {
    throw new AaisResearchConfigurationError(
      "AAIS research LRS store id does not match the research database scope.",
    );
  }
  return lrsConfiguration;
}

function isKnownPermanentAaisResearchLrsStatus(status: number | null) {
  return status === 400
    || status === 409
    || status === 413
    || status === 415
    || status === 422;
}

function getAaisResearchLrsRetryBackoffSeconds(attempts: number) {
  const exponent = Math.min(Math.max(attempts, 0), 8);
  return Math.min(300, 2 ** exponent);
}

function requireExportPurpose(value: string): ExportPurpose {
  if (["approved_analysis", "reconciliation", "quality_audit", "replication"].includes(value)) {
    return value as ExportPurpose;
  }
  throw new AaisResearchValidationError("AAIS research export purpose is invalid.");
}

function getClaimRequestTimeoutMs(
  claimStartedAt: number,
  currentTime: number,
  workerDeadlineAt: number,
) {
  const remainingMs = aaisResearchLrsLeaseDurationMs - (currentTime - claimStartedAt);
  const workerRemainingMs = workerDeadlineAt - currentTime;
  const timeoutMs = Math.min(
    AAIS_RESEARCH_LRS_REQUEST_TIMEOUT_MS,
    remainingMs - aaisResearchLrsLeaseGuardMs,
    workerRemainingMs - aaisResearchWorkerFinalizeGuardMs,
  );
  return timeoutMs >= 1 ? Math.floor(timeoutMs) : null;
}

async function releaseExpiredOutboxClaim(
  database: AaisResearchDatabaseClient,
  configuration: AaisResearchConfiguration,
  outboxId: string,
  claimId: string,
) {
  const result = await database.query(
    `update aais_research_lrs_outbox
    set status = 'retry', delivery_claim_id = null, lease_expires_at = null,
      last_error = 'research_lrs_claim_expired_before_send', updated_at = now()
    where project_id = $1
      and study_id = $2
      and environment = $3
      and lrs_namespace = $4
      and outbox_id = $5::uuid
      and delivery_claim_id = $6::uuid
      and status = 'sending'
    returning outbox_id`,
    scopeParams(configuration, [outboxId, claimId]),
  );
  return result.rows.length > 0;
}

async function releaseExpiredDeletionClaim(
  database: AaisResearchDatabaseClient,
  configuration: AaisResearchConfiguration,
  deletionId: string,
  claimId: string,
) {
  const result = await database.query(
    `update aais_research_lrs_deletions
    set status = 'retry', deletion_claim_id = null, lease_expires_at = null,
      last_error = 'research_lrs_delete_claim_expired_before_send', updated_at = now()
    where project_id = $1
      and study_id = $2
      and environment = $3
      and lrs_namespace = $4
      and lrs_store_id = $5
      and deletion_id = $6::uuid
      and deletion_claim_id = $7::uuid
      and status = 'deleting'
    returning deletion_id`,
    scopeParams(configuration, [configuration.lrsStoreId, deletionId, claimId]),
  );
  return result.rows.length > 0;
}

function readOutboxPayload(
  value: unknown,
  expected: {
    configuration: AaisResearchConfiguration;
    eventId: string;
    statementId: string;
    claimedRow: Record<string, unknown>;
  },
): AaisResearchOutboxPayload {
  let parsed = value;
  if (typeof parsed === "string") {
    parsed = JSON.parse(parsed) as unknown;
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new AaisResearchConfigurationError("AAIS research outbox payload is invalid.");
  }
  const record = parsed as Record<string, unknown>;
  const exactKeys = [
    "eventId", "participantId", "studyRunId", "visitId", "projectId", "studyId",
    "environment", "lrsNamespace", "lrsStoreId", "condition", "schemaVersion",
    "appVersion", "commitSha", "eventSequence", "clientTime", "serverReceivedAt",
    "eventName", "outcome", "retryCount", "disconnectCount", "aiLatencyMs", "detail",
    "lrsEligible",
  ];
  if (
    Object.keys(record).length !== exactKeys.length
    || exactKeys.some((key) => !Object.prototype.hasOwnProperty.call(record, key))
  ) {
    throw new AaisResearchConfigurationError("AAIS research outbox payload shape is invalid.");
  }

  let normalizedEvent: AaisResearchEventInput;
  try {
    normalizedEvent = parseAaisResearchEventInput({
      clientEventId: record.eventId,
      clientTime: record.clientTime,
      expectedVisitId: record.visitId,
      eventName: record.eventName,
      outcome: record.outcome,
      aiLatencyMs: record.aiLatencyMs,
      detail: record.detail,
    });
  } catch {
    throw new AaisResearchConfigurationError("AAIS research outbox payload is invalid.");
  }

  const configuration = expected.configuration;
  const fact = readClaimedResearchEventFact(expected.claimedRow, configuration);
  const serverReceivedAt = normalizeUnknownDateString(record.serverReceivedAt);
  if (
    record.eventId !== expected.eventId
    || record.eventId !== expected.statementId
    || record.eventId !== fact.eventId
    || normalizedEvent.clientEventId !== fact.eventId
    || record.participantId !== fact.participantId
    || record.studyRunId !== fact.studyRunId
    || normalizedEvent.expectedVisitId !== fact.visitId
    || record.projectId !== fact.projectId
    || record.studyId !== fact.studyId
    || record.environment !== fact.environment
    || record.lrsNamespace !== fact.lrsNamespace
    || record.lrsStoreId !== configuration.lrsStoreId
    || record.condition !== fact.condition
    || record.schemaVersion !== fact.schemaVersion
    || record.appVersion !== fact.appVersion
    || record.commitSha !== fact.commitSha
    || record.eventSequence !== fact.eventSequence
    || normalizedEvent.clientTime !== fact.clientTime
    || serverReceivedAt !== fact.serverReceivedAt
    || normalizedEvent.eventName !== fact.eventName
    || normalizedEvent.outcome !== fact.outcome
    || record.retryCount !== fact.retryCount
    || normalizedEvent.retryCount !== fact.retryCount
    || record.disconnectCount !== fact.disconnectCount
    || normalizedEvent.disconnectCount !== fact.disconnectCount
    || normalizedEvent.aiLatencyMs !== fact.aiLatencyMs
    || !isDeepStrictEqual(normalizedEvent.detail, fact.detail)
    || record.lrsEligible !== fact.lrsEligible
  ) {
    throw new AaisResearchConfigurationError(
      "AAIS research outbox payload does not match its immutable Postgres event fact.",
    );
  }
  return fact;
}

function readClaimedResearchEventFact(
  row: Record<string, unknown>,
  configuration: AaisResearchConfiguration,
): AaisResearchOutboxPayload {
  const eventId = requireUuid(readString(row, "fact_event_id"), "event fact id");
  const clientEventId = requireUuid(
    readString(row, "fact_client_event_id"),
    "event fact client event id",
  );
  const participantId = requireUuid(
    readString(row, "fact_participant_id"),
    "event fact participant id",
  );
  const studyRunId = requireUuid(
    readString(row, "fact_study_run_id"),
    "event fact study run id",
  );
  const visitId = requireUuid(readString(row, "fact_visit_id"), "event fact visit id");
  const projectId = readString(row, "fact_project_id");
  const studyId = readString(row, "fact_study_id");
  const environment = readString(row, "fact_environment");
  const lrsNamespace = readString(row, "fact_lrs_namespace");
  const condition = readString(row, "fact_condition");
  const schemaVersion = readInteger(row, "fact_schema_version");
  const appVersion = readString(row, "fact_app_version");
  const commitSha = readString(row, "fact_commit_sha");
  const eventSequence = readInteger(row, "fact_event_sequence");
  const clientTime = readDateString(row, "fact_client_time");
  const serverReceivedAt = readDateString(row, "fact_server_received_at");
  const eventName = readString(row, "fact_event_name");
  const outcome = readString(row, "fact_outcome");
  const retryCount = readInteger(row, "fact_retry_count");
  const disconnectCount = readInteger(row, "fact_disconnect_count");
  const aiLatencyMs = readNullableInteger(row, "fact_ai_latency_ms");
  const detail = normalizeJsonObject(row.fact_detail);
  const lrsEligible = readBoolean(row, "fact_lrs_eligible");

  let normalizedEvent: AaisResearchEventInput;
  try {
    normalizedEvent = parseAaisResearchEventInput({
      clientEventId,
      clientTime,
      expectedVisitId: visitId,
      eventName,
      outcome,
      aiLatencyMs,
      detail,
    });
  } catch {
    throw new AaisResearchConfigurationError(
      "AAIS research Postgres event fact is invalid.",
    );
  }

  if (
    eventId !== clientEventId
    || projectId !== configuration.projectId
    || studyId !== configuration.studyId
    || environment !== configuration.environment
    || lrsNamespace !== configuration.lrsNamespace
    || !configuration.conditions.includes(condition)
    || schemaVersion !== AAIS_RESEARCH_SCHEMA_VERSION
    || appVersion !== configuration.appVersion
    || commitSha !== configuration.commitSha
    || eventSequence < 1
    || retryCount !== normalizedEvent.retryCount
    || disconnectCount !== normalizedEvent.disconnectCount
    || lrsEligible !== true
    || readString(row, "outbox_project_id") !== configuration.projectId
    || readString(row, "outbox_study_id") !== configuration.studyId
    || readString(row, "outbox_environment") !== configuration.environment
    || readString(row, "outbox_lrs_namespace") !== configuration.lrsNamespace
    || readBoolean(row, "outbox_lrs_eligible") !== true
  ) {
    throw new AaisResearchConfigurationError(
      "AAIS research claimed outbox row does not match its immutable Postgres event fact.",
    );
  }

  return {
    eventId,
    participantId,
    studyRunId,
    visitId,
    projectId: configuration.projectId,
    studyId,
    environment: configuration.environment,
    lrsNamespace,
    lrsStoreId: configuration.lrsStoreId,
    condition,
    schemaVersion: AAIS_RESEARCH_SCHEMA_VERSION,
    appVersion,
    commitSha,
    eventSequence,
    clientTime,
    serverReceivedAt,
    eventName: normalizedEvent.eventName,
    outcome: normalizedEvent.outcome,
    retryCount,
    disconnectCount,
    aiLatencyMs: normalizedEvent.aiLatencyMs,
    detail: normalizedEvent.detail,
    lrsEligible: true,
  };
}

function normalizeExportEvent(row: Record<string, unknown>) {
  return {
    eventId: readString(row, "event_id"),
    participantId: readString(row, "participant_id"),
    studyRunId: readString(row, "study_run_id"),
    visitId: readString(row, "visit_id"),
    projectId: readString(row, "project_id"),
    studyId: readString(row, "study_id"),
    environment: readString(row, "environment"),
    lrsNamespace: readString(row, "lrs_namespace"),
    condition: readString(row, "condition"),
    schemaVersion: readInteger(row, "schema_version"),
    appVersion: readString(row, "app_version"),
    commitSha: readString(row, "commit_sha"),
    eventSequence: readInteger(row, "event_sequence"),
    clientTime: readDateString(row, "client_time"),
    serverReceivedAt: readDateString(row, "server_received_at"),
    eventName: readString(row, "event_name"),
    outcome: readString(row, "outcome"),
    retryCount: readInteger(row, "retry_count"),
    disconnectCount: readInteger(row, "disconnect_count"),
    aiLatencyMs: row.ai_latency_ms === null ? null : readInteger(row, "ai_latency_ms"),
    detail: normalizeJsonObject(row.detail),
    lrsEligible: readBoolean(row, "lrs_eligible"),
  };
}

function createResearchEventsCsv(events: ReturnType<typeof normalizeExportEvent>[]) {
  const headers = [
    "event_id", "participant_id", "study_run_id", "visit_id", "project_id",
    "study_id", "environment", "lrs_namespace", "condition", "schema_version",
    "app_version", "commit_sha", "event_sequence", "client_time",
    "server_received_at", "event_name", "outcome", "retry_count",
    "disconnect_count", "ai_latency_ms", "detail", "lrs_eligible",
  ];
  const rows = events.map((event) => [
    event.eventId,
    event.participantId,
    event.studyRunId,
    event.visitId,
    event.projectId,
    event.studyId,
    event.environment,
    event.lrsNamespace,
    event.condition,
    event.schemaVersion,
    event.appVersion,
    event.commitSha,
    event.eventSequence,
    event.clientTime,
    event.serverReceivedAt,
    event.eventName,
    event.outcome,
    event.retryCount,
    event.disconnectCount,
    event.aiLatencyMs ?? "",
    JSON.stringify(event.detail),
    event.lrsEligible,
  ].map(escapeCsvField).join(","));
  return `${headers.join(",")}\n${rows.join("\n")}${rows.length ? "\n" : ""}`;
}

function escapeCsvField(value: unknown) {
  const text = String(value ?? "");
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

function normalizeJsonObject(value: unknown): Record<string, unknown> {
  if (typeof value === "string") {
    const parsed = JSON.parse(value) as unknown;
    return normalizeJsonObject(parsed);
  }
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function difference(left: string[], right: string[]) {
  const rightSet = new Set(right);
  return left.filter((value) => !rightSet.has(value));
}

function requireRow(value: Record<string, unknown> | undefined, label: string) {
  if (!value) {
    throw new AaisResearchConfigurationError(`AAIS ${label} transaction returned no row.`);
  }
  return value;
}

function readString(row: Record<string, unknown>, key: string) {
  const value = row[key];
  if (typeof value !== "string") {
    throw new AaisResearchConfigurationError(`AAIS research database field ${key} is invalid.`);
  }
  return value;
}

function readInteger(row: Record<string, unknown>, key: string) {
  const value = row[key];
  const parsed = typeof value === "number" ? value : Number(value);
  if (!Number.isSafeInteger(parsed)) {
    throw new AaisResearchConfigurationError(`AAIS research database field ${key} is invalid.`);
  }
  return parsed;
}

function readNullableInteger(row: Record<string, unknown>, key: string) {
  return row[key] === null ? null : readInteger(row, key);
}

function readBoolean(row: Record<string, unknown>, key: string) {
  const value = row[key];
  if (value !== true && value !== false) {
    throw new AaisResearchConfigurationError(`AAIS research database field ${key} is invalid.`);
  }
  return value;
}

function readBuffer(row: Record<string, unknown>, key: string) {
  const value = row[key];
  if (Buffer.isBuffer(value)) {
    return value;
  }
  if (value instanceof Uint8Array) {
    return Buffer.from(value);
  }
  throw new AaisResearchConfigurationError(`AAIS research database field ${key} is invalid.`);
}

function readOptionalRawTextStorage(
  row: Record<string, unknown>,
  key: string,
): "postgres" | "file" | null {
  const value = row[key];
  if (value === null || value === undefined) {
    return null;
  }
  if (value === "postgres" || value === "file") {
    return value;
  }
  throw new AaisResearchConfigurationError(
    `AAIS research database field ${key} is invalid.`,
  );
}

function readDateString(row: Record<string, unknown>, key: string) {
  const value = row[key];
  if (value instanceof Date) {
    return value.toISOString();
  }
  if (typeof value === "string" && Number.isFinite(Date.parse(value))) {
    return new Date(value).toISOString();
  }
  throw new AaisResearchConfigurationError(`AAIS research database field ${key} is invalid.`);
}

function normalizeUnknownDateString(value: unknown) {
  if (typeof value !== "string" || !Number.isFinite(Date.parse(value))) {
    return null;
  }
  return new Date(value).toISOString();
}

function getDatabaseErrorMessage(error: unknown) {
  return error instanceof Error ? error.message.toLowerCase() : "";
}

function getDatabaseErrorCode(error: unknown) {
  if (!error || typeof error !== "object" || !("code" in error)) {
    return "";
  }
  return typeof error.code === "string" ? error.code : "";
}
