#!/usr/bin/env node

import {
  createCipheriv,
  createDecipheriv,
  createHash,
  createHmac,
  randomBytes,
  randomUUID,
} from "node:crypto";
import { writeFile } from "node:fs/promises";
import path from "node:path";
import { Pool } from "pg";
import { getAaisResearchMigrationDatabaseConfiguration } from "./run-postgres-migrations.mjs";

const projectId = "aais";
const environment = "research";
const schemaVersion = 1;
const defaultLrsStoreId = "aais-research-synthetic-clean-store";
const syntheticCommitSha = createHash("sha256").update("aais-research-synthetic-rehearsal-v1").digest("hex");
export const aaisResearchSyntheticActionManifest = [
  {
    operationPrefix: "session-load",
    eventName: "workspace_session_load",
    outcome: "success",
    detail: { trigger: "page_mount" },
  },
  {
    operationPrefix: "content-tab",
    eventName: "content_tab_selected",
    outcome: "success",
    detail: { tab_id: "editor", input_method: "pointer" },
  },
  {
    operationPrefix: "artifact-save",
    eventName: "document_artifact_save",
    outcome: "success",
    detail: {
      trigger: "blur",
      previous_characters: 0,
      current_characters: 120,
      delta_characters: 120,
      artifact_length: 120,
    },
  },
  {
    operationPrefix: "ai-guide",
    eventName: "ai_guide_submit",
    outcome: "success",
    latencyMs: 820,
    detail: {
      input_mode: "typed",
      prompt_length: 32,
      attempt_number: 2,
      retry_reason: "stream_protocol_fallback",
      fallback: false,
      has_attachments: false,
    },
  },
  {
    operationPrefix: "connectivity",
    eventName: "client_connectivity",
    outcome: "disconnected",
    detail: { trigger: "browser_offline" },
  },
  {
    operationPrefix: "connectivity",
    eventName: "client_connectivity",
    outcome: "success",
    detail: { trigger: "browser_online" },
  },
  {
    operationPrefix: "document-download",
    eventName: "document_download",
    outcome: "failure",
    detail: { download_method: "browser_download", error_kind: "request_failed" },
  },
];
const actionManifest = aaisResearchSyntheticActionManifest;

export async function rehearseAaisResearch(input) {
  const participantCount = normalizeParticipantCount(input.participantCount);
  const now = input.now ?? new Date();
  const studyId = input.studyId ?? createSyntheticStudyId(now);
  const lrsNamespace = `https://www.aais.site/xapi/studies/${studyId}/research/v1`;
  const identityKey = input.identityKey ?? randomBytes(32);
  const fingerprintKey = input.fingerprintKey ?? randomBytes(32);
  const identityKeyVersion = input.identityKeyVersion ?? "v1";
  const scopedLrsStoreId = input.lrsStoreId ?? defaultLrsStoreId;
  const identityAad = createIdentityAad({ studyId, lrsNamespace });
  const expectedEvents = [];
  const participants = [];
  const syntheticActorIds = [];

  await input.database.query("begin");
  try {
    for (let participantIndex = 0; participantIndex < participantCount; participantIndex += 1) {
      const participantId = randomUUID();
      const studyRunId = randomUUID();
      const visitId = randomUUID();
      const actorId = `synthetic-${participantIndex + 1}`;
      syntheticActorIds.push(actorId);
      const syntheticIdentity = JSON.stringify({
        actorId,
        displayName: `Synthetic Participant ${participantIndex + 1}`,
      });
      const encrypted = encryptSyntheticIdentity(syntheticIdentity, identityKey, identityAad);
      const identityFingerprint = createHmac("sha256", fingerprintKey)
        .update(`aais-research-identity-fingerprint:v1:${actorId}`)
        .digest("hex");
      const visitResult = await input.database.query(
        `select * from aais_research_create_visit(
          $1, $2, $3, $4, $5::uuid, $6::uuid, $7::uuid, $8,
          $9::bytea, $10::bytea, $11::bytea, $12, $13::text[], 30,
          $14::timestamptz, $15::timestamptz
        )`,
        [
          projectId,
          studyId,
          environment,
          lrsNamespace,
          participantId,
          studyRunId,
          visitId,
          identityFingerprint,
          encrypted.ciphertext,
          encrypted.iv,
          encrypted.authenticationTag,
          identityKeyVersion,
          ["control", "treatment"],
          addDays(now, 90),
          addDays(now, 1825),
        ],
      );
      const visit = visitResult.rows[0];
      if (!visit || visit.created !== true) {
        throw new Error("AAIS synthetic research visit was not created.");
      }

      const participantExpectedEvents = [];
      for (let actionIndex = 0; actionIndex < actionManifest.length; actionIndex += 1) {
        const action = actionManifest[actionIndex];
        const eventId = randomUUID();
        const clientEventId = randomUUID();
        const operationId = `${action.operationPrefix}-${randomUUID()}`;
        const detail = { operation_id: operationId, ...action.detail };
        const eventTime = new Date(now.getTime() + participantIndex * 60_000 + actionIndex * 1000);
        const result = await input.database.query(
          `select * from aais_research_record_event(
            $1, $2, $3, $4, $5, $6::uuid, $7::uuid, $8::uuid, $9, $10, $11,
            $12::timestamptz, $13::timestamptz, $14, $15, $16,
            $17::jsonb, $18::timestamptz
          )`,
          [
            projectId,
            studyId,
            environment,
            lrsNamespace,
            scopedLrsStoreId,
            visitId,
            eventId,
            clientEventId,
            schemaVersion,
            "0.1.0-synthetic",
            syntheticCommitSha,
            eventTime,
            eventTime,
            action.eventName,
            action.outcome,
            action.latencyMs ?? null,
            JSON.stringify(detail),
            addDays(now, 1825),
          ],
        );
        if (!result.rows[0]?.created) {
          throw new Error("AAIS synthetic research event was not created.");
        }
        const expected = {
          eventId,
          participantId,
          studyRunId,
          visitId,
          eventSequence: actionIndex + 1,
          eventName: action.eventName,
          outcome: action.outcome,
        };
        expectedEvents.push(expected);
        participantExpectedEvents.push(expected);
      }
      participants.push({
        participantId,
        studyRunId,
        visitId,
        condition: visit.condition,
        expectedEventCount: participantExpectedEvents.length,
      });
    }

    const eventResult = await input.database.query(
        `select event_id, participant_id, study_run_id, visit_id, event_sequence,
                event_name, outcome, retry_count, disconnect_count, ai_latency_ms
           from aais_research_events
          where project_id = 'aais'
            and study_id = $1
            and environment = 'research'
            and lrs_namespace = $2
          order by participant_id, visit_id, event_sequence`,
        [studyId, lrsNamespace],
      );
    const outboxResult = await input.database.query(
        `select event_id, statement_id, status, lrs_eligible
           from aais_research_lrs_outbox
          where project_id = 'aais'
            and study_id = $1
            and environment = 'research'
            and lrs_namespace = $2
            and lrs_eligible = true
          order by event_id`,
        [studyId, lrsNamespace],
      );
    const identityResult = await input.database.query(
        `select ciphertext, iv, authentication_tag, key_version
           from aais_research_identity.aais_research_identity_map
          where project_id = 'aais'
            and study_id = $1
            and environment = 'research'
            and lrs_namespace = $2`,
        [studyId, lrsNamespace],
      );
    const decryptedActorIds = identityResult.rows.map((row) => {
      if (String(row.key_version) !== identityKeyVersion) {
        throw new Error("AAIS synthetic identity key version does not match.");
      }
      const decrypted = decryptSyntheticIdentity({
        ciphertext: row.ciphertext,
        iv: row.iv,
        authenticationTag: row.authentication_tag,
        key: identityKey,
        aad: identityAad,
      });
      return String(JSON.parse(decrypted).actorId ?? "");
    }).sort();
    const identityEncryptionVerified = JSON.stringify(decryptedActorIds)
      === JSON.stringify([...syntheticActorIds].sort());

    const reconciliation = reconcileAaisResearchSets({
      expectedEventIds: expectedEvents.map((event) => event.eventId),
      postgresEventIds: eventResult.rows.map((row) => String(row.event_id)),
      lrsEligibleEventIds: outboxResult.rows.map((row) => String(row.event_id)),
      lrsStatementIds: outboxResult.rows.map((row) => String(row.statement_id)),
    });
    const sequenceContinuity = verifySequenceContinuity(eventResult.rows);
    const status = reconciliation.status === "pass"
      && sequenceContinuity.status === "pass"
      && identityResult.rows.length === participantCount
      && identityEncryptionVerified
      ? "pass"
      : "fail";

    const report = {
      schemaVersion: 1,
      status,
      dryRun: input.commit !== true,
      generatedAt: now.toISOString(),
      scope: {
        projectId,
        studyId,
        environment,
        lrsNamespace,
        lrsStoreId: scopedLrsStoreId,
      },
      participants: {
        expected: participantCount,
        encryptedIdentityRows: identityResult.rows.length,
        visits: participants,
      },
      operations: {
        perParticipant: actionManifest.length,
        actualSemanticOperations: expectedEvents.length,
        postgresEvents: eventResult.rows.length,
        shouldEnterLrs: outboxResult.rows.length,
        mockLrsStatements: outboxResult.rows.length,
      },
      coverage: {
        success: expectedEvents.some((event) => event.outcome === "success"),
        failure: expectedEvents.some((event) => event.outcome === "failure"),
        retry: eventResult.rows.some((row) => Number(row.retry_count) > 0),
        disconnection: eventResult.rows.some((row) => Number(row.disconnect_count) > 0),
        reconnection: expectedEvents.some((event) =>
          event.eventName === "client_connectivity" && event.outcome === "success"),
        aiLatency: eventResult.rows.some((row) => Number(row.ai_latency_ms) > 0),
      },
      reconciliation,
      sequenceContinuity,
      privacy: {
        plaintextIdentity: "omitted",
        productionAadDecryptionVerified: identityEncryptionVerified,
        independentFingerprintKey: true,
        rawLearnerText: "omitted",
        credentials: "omitted",
      },
      secrets: "redacted",
    };

    if (status !== "pass") {
      throw new AaisResearchRehearsalMismatchError(report);
    }
    await input.database.query(input.commit === true ? "commit" : "rollback");
    return report;
  } catch (error) {
    await input.database.query("rollback").catch(() => undefined);
    throw error;
  }
}

export function reconcileAaisResearchSets(input) {
  const expected = new Set(input.expectedEventIds);
  const postgres = new Set(input.postgresEventIds);
  const lrsEligible = new Set(input.lrsEligibleEventIds);
  const statements = new Set(input.lrsStatementIds);
  const differences = {
    missingFromPostgres: difference(expected, postgres),
    unexpectedInPostgres: difference(postgres, expected),
    missingFromLrsEligible: difference(expected, lrsEligible),
    unexpectedInLrsEligible: difference(lrsEligible, expected),
    missingStatementIds: difference(expected, statements),
    unexpectedStatementIds: difference(statements, expected),
  };
  return {
    status: Object.values(differences).every((values) => values.length === 0) ? "pass" : "fail",
    counts: {
      actualSemanticOperations: input.expectedEventIds.length,
      postgresEvents: input.postgresEventIds.length,
      shouldEnterLrs: input.lrsEligibleEventIds.length,
      mockLrsStatements: input.lrsStatementIds.length,
    },
    differences,
  };
}

function verifySequenceContinuity(rows) {
  const sequencesByVisit = new Map();
  rows.forEach((row) => {
    const visitId = String(row.visit_id);
    const sequences = sequencesByVisit.get(visitId) ?? [];
    sequences.push(Number(row.event_sequence));
    sequencesByVisit.set(visitId, sequences);
  });
  const failures = [];
  for (const [visitId, sequences] of sequencesByVisit.entries()) {
    const sorted = sequences.sort((left, right) => left - right);
    const expected = sorted.map((_, index) => index + 1);
    if (sorted.some((value, index) => value !== expected[index])) {
      failures.push({ visitId, observed: sorted, expected });
    }
  }
  return {
    status: failures.length ? "fail" : "pass",
    failures,
  };
}

function difference(left, right) {
  return [...left].filter((value) => !right.has(value)).sort();
}

function encryptSyntheticIdentity(plaintext, key, aad) {
  if (!Buffer.isBuffer(key) || key.length !== 32) {
    throw new Error("AAIS synthetic identity key must be 32 bytes.");
  }
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  cipher.setAAD(aad);
  const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  return {
    ciphertext,
    iv,
    authenticationTag: cipher.getAuthTag(),
  };
}

function decryptSyntheticIdentity({ ciphertext, iv, authenticationTag, key, aad }) {
  const decipher = createDecipheriv("aes-256-gcm", key, iv);
  decipher.setAAD(aad);
  decipher.setAuthTag(authenticationTag);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString("utf8");
}

function createIdentityAad({ studyId, lrsNamespace }) {
  return Buffer.from([
    "aais-research-identity:v1",
    projectId,
    studyId,
    environment,
    lrsNamespace,
  ].join("\0"), "utf8");
}

function readBase64Key(value, label) {
  if (!value?.trim()) {
    throw new Error(`AAIS research rehearsal ${label} is required for --commit.`);
  }
  const decoded = Buffer.from(value.trim(), "base64");
  if (decoded.length !== 32 || decoded.toString("base64") !== value.trim()) {
    throw new Error(`AAIS research rehearsal ${label} must be a 32-byte base64 key.`);
  }
  return decoded;
}

function addDays(date, days) {
  return new Date(date.getTime() + days * 24 * 60 * 60 * 1000);
}

function createSyntheticStudyId(now) {
  return `aais-ca-pilot-synthetic-${now.toISOString().replace(/[^0-9]/g, "").slice(0, 14)}`;
}

function normalizeParticipantCount(value) {
  const parsed = Number(value ?? 4);
  if (!Number.isInteger(parsed) || parsed < 3 || parsed > 5) {
    throw new Error("AAIS research rehearsal requires 3 to 5 synthetic participants.");
  }
  return parsed;
}

function parseArgs(argv) {
  const options = {
    participantCount: 4,
    commit: false,
    output: path.resolve("aais-research-rehearsal.json"),
    help: false,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--help" || arg === "-h") {
      options.help = true;
    } else if (arg === "--participants") {
      options.participantCount = normalizeParticipantCount(argv[++index]);
    } else if (arg === "--commit") {
      options.commit = true;
    } else if (arg === "--output") {
      options.output = path.resolve(String(argv[++index] ?? ""));
    } else {
      throw new Error(`Unknown AAIS research rehearsal argument: ${arg}`);
    }
  }
  if (!options.output) {
    throw new Error("AAIS research rehearsal output path is required.");
  }
  return options;
}

function printHelp() {
  process.stdout.write([
    "Usage: npm run study:rehearse -- [--participants 3|4|5] [--commit] [--output report.json]",
    "",
    "Runs the fixed metadata-only action manifest against migrated Postgres and verifies:",
    "  actual semantic operations = Postgres events = LRS-eligible outbox = mock statement ids",
    "",
    "Default mode rolls back after reconciliation. --commit is allowed only with",
    "AAIS_RESEARCH_REHEARSAL_APPROVED=true and AAIS_RESEARCH_ENVIRONMENT=research.",
    "",
  ].join("\n"));
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    printHelp();
    return;
  }
  if (options.commit && process.env.AAIS_RESEARCH_REHEARSAL_APPROVED !== "true") {
    throw new Error("AAIS research rehearsal commit requires AAIS_RESEARCH_REHEARSAL_APPROVED=true.");
  }
  if (options.commit && process.env.AAIS_RESEARCH_ENVIRONMENT !== "research") {
    throw new Error("AAIS research rehearsal commit is restricted to the research environment.");
  }
  const config = getAaisResearchMigrationDatabaseConfiguration();
  if (!config) {
    throw new Error("AAIS research rehearsal requires AAIS_RESEARCH_DATABASE_URL.");
  }
  const pool = new Pool({ connectionString: config.url });
  const client = await pool.connect();
  try {
    const report = await rehearseAaisResearch({
      database: client,
      participantCount: options.participantCount,
      commit: options.commit,
      ...(options.commit
        ? {
            identityKey: readBase64Key(
              process.env.AAIS_RESEARCH_IDENTITY_ENCRYPTION_KEY,
              "identity encryption key",
            ),
            fingerprintKey: readBase64Key(
              process.env.AAIS_RESEARCH_IDENTITY_FINGERPRINT_KEY,
              "identity fingerprint key",
            ),
            identityKeyVersion: process.env.AAIS_RESEARCH_IDENTITY_KEY_VERSION?.trim() || "v1",
            lrsStoreId: process.env.AAIS_RESEARCH_LRS_STORE_ID?.trim()
              || (() => { throw new Error("AAIS research rehearsal LRS store id is required for --commit."); })(),
          }
        : {}),
    });
    await writeFile(options.output, `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 });
    process.stdout.write(`${JSON.stringify({
      status: report.status,
      dryRun: report.dryRun,
      participants: report.participants.expected,
      operations: report.operations,
      reconciliation: report.reconciliation.status,
      output: options.output,
      sourceEnv: config.sourceEnv,
      secrets: "redacted",
    })}\n`);
  } finally {
    client.release();
    await pool.end();
  }
}

class AaisResearchRehearsalMismatchError extends Error {
  constructor(report) {
    super("AAIS research rehearsal reconciliation failed.");
    this.report = report;
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error) => {
    const output = error instanceof AaisResearchRehearsalMismatchError
      ? { status: "fail", reconciliation: error.report.reconciliation, secrets: "redacted" }
      : { status: "error", message: error instanceof Error ? error.message : "AAIS research rehearsal failed.", secrets: "redacted" };
    process.stderr.write(`${JSON.stringify(output)}\n`);
    process.exitCode = 1;
  });
}
