#!/usr/bin/env node

import { createHash, createHmac } from "node:crypto";
import { chmod, lstat, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Pool } from "pg";

const modulePath = import.meta.url.startsWith("file:")
  ? fileURLToPath(import.meta.url)
  : null;
const uuidPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const sessionTtlSeconds = 60 * 60;
const maximumExportBytes = 8 * 1024 * 1024;
const requestTimeoutMilliseconds = 30_000;
const auditClockToleranceMilliseconds = 5_000;
const researchEventNames = new Set([
  "workspace_session_load",
  "client_connectivity",
  "account_menu_toggled",
  "learner_data_export",
  "learner_data_delete",
  "account_logout",
  "content_tab_selected",
  "content_item_opened",
  "content_item_back",
  "history_document_opened",
  "panel_resize_completed",
  "guide_quick_start_selected",
  "guide_attachment_picker_opened",
  "guide_attachment_add",
  "guide_attachment_removed",
  "ai_guide_submit",
  "guide_response_link_opened",
  "document_artifact_save",
  "document_title_committed",
  "editor_format_applied",
  "document_save_closed",
  "document_download",
]);
const researchOutcomes = new Set([
  "attempted", "success", "failure", "retry", "disconnected",
]);
const researchDetailKeys = new Set([
  "operation_id", "task_id", "trigger", "tab_id", "content_id",
  "document_id", "format_id", "value_id", "quick_start_id", "input_mode",
  "prompt_length", "attachment_count", "file_count", "mime_type",
  "size_bytes", "total_size_bytes", "error_kind", "attempt_number",
  "retry_reason", "fallback", "agent_count", "title_length",
  "artifact_length", "previous_characters", "current_characters",
  "delta_characters", "width_px", "delta_px", "input_method",
  "download_method", "confirmed", "pending_save", "source", "http_status",
  "link_protocol", "link_host", "target_agent_count", "has_attachments",
]);

if (isDirectInvocation()) {
  await runDirectInvocation().catch(() => {
    process.stderr.write("AAIS controlled export attestation failed closed.\n");
    process.exitCode = 1;
  });
}

async function runDirectInvocation() {
  const options = readOptions(process.argv.slice(2));
  const databaseUrl = process.env
    .AAIS_RESEARCH_EXPORT_RECONCILIATION_DATABASE_URL?.trim();
  if (!databaseUrl) {
    throw new Error(
      "AAIS_RESEARCH_EXPORT_RECONCILIATION_DATABASE_URL is required.",
    );
  }
  const pool = new Pool({ connectionString: databaseUrl, max: 1 });
  let database;
  try {
    database = await pool.connect();
    const receipt = await attestAaisControlledExports({
      ...options,
      database,
      env: process.env,
      fetchImpl: fetch,
    });
    await writeRestrictedJson(options.output, receipt);
    process.stdout.write(`${JSON.stringify({
      status: receipt.status,
      participant_exports: receipt.participant_export_count,
      exported_events: receipt.exported_event_count,
      audit_rows: receipt.export_audit_row_count,
      output: options.output,
      raw_export_bodies_retained: false,
      secrets: "redacted",
    })}\n`);
  } finally {
    database?.release();
    await pool.end();
  }
}

export async function attestAaisControlledExports(input) {
  const baseUrl = normalizeBaseUrl(input.baseUrl);
  const expectedCommit = requireCommit(input.expectedCommit);
  const researcherActor = requireSyntheticActor(input.researcherActor);
  const sessionSecret = input.env?.AAIS_SESSION_SECRET?.trim() || "";
  if (sessionSecret.length < 32) {
    throw new Error("AAIS controlled export attester requires a 32+ character session secret.");
  }
  const fingerprintKey = readFingerprintKey(
    input.env?.AAIS_RESEARCH_IDENTITY_FINGERPRINT_KEY,
  );
  if (!input.database?.query || typeof input.fetchImpl !== "function") {
    throw new Error("AAIS controlled export attester dependencies are invalid.");
  }

  const manifestRaw = await readFile(input.manifest, "utf8");
  const observedRaw = await readFile(input.observedVisits, "utf8");
  const runtimeRaw = await readFile(input.runtimeBuildAttestation, "utf8");
  const manifest = parseJson(manifestRaw, "manifest");
  const observed = parseJson(observedRaw, "observed visits");
  const runtime = parseJson(runtimeRaw, "runtime attestation");
  const scope = validateInputs({
    expectedCommit,
    manifest,
    observed,
    runtime,
  });
  const runtimeAttestationSha256 = sha256(runtimeRaw);
  const manifestSha256 = sha256(manifestRaw);
  const observedVisitsSha256 = sha256(observedRaw);
  const attestationStartedAt = readNow(input.now);
  if (attestationStartedAt < new Date(observed.observed_at)) {
    throw new Error("AAIS controlled export began before browser evidence completed.");
  }

  const actor = {
    id: researcherActor,
    role: "researcher",
    displayName: "Synthetic Research Export Attester",
  };
  const sessionCookieName = "aais_session";
  const csrfCookieName = "aais_csrf";
  const issuedAt = Math.floor(attestationStartedAt.getTime() / 1000);
  const sessionToken = createSessionToken(actor, sessionSecret, issuedAt);
  const csrfToken = createCsrfToken(actor.id, sessionSecret, issuedAt);
  const actorFingerprint = createHmac("sha256", fingerprintKey)
    .update(`aais-research-identity-fingerprint:v1:${actor.id}`)
    .digest("hex");
  const cookie = `${sessionCookieName}=${sessionToken}; ${csrfCookieName}=${csrfToken}`;
  const expectedBySlot = new Map(manifest.participants.map((participant) => [
    participant.slot,
    participant,
  ]));
  const exports = [];

  await assertLeastPrivilegeReadOnlyConnection(input.database);

  for (const participant of [...observed.participants].sort(compareSlot)) {
    const expectedParticipant = expectedBySlot.get(participant.slot);
    const requestStartedAt = readNow(input.now);
    const url = new URL("/api/research/events/export", baseUrl);
    url.searchParams.set("studyRunId", participant.study_run_id);
    url.searchParams.set("format", "json");
    url.searchParams.set("purpose", "reconciliation");
    url.searchParams.set("limit", "10000");
    const response = await input.fetchImpl(url, {
      method: "GET",
      redirect: "error",
      signal: AbortSignal.timeout(requestTimeoutMilliseconds),
      headers: {
        cookie,
        "x-aais-csrf": csrfToken,
      },
    });
    const responseBody = await readCappedResponseBody(response);
    const responseReceivedAt = readNow(input.now);
    const body = responseBody.text;
    const rowCount = Number(response.headers.get("x-aais-research-row-count"));
    const responseSha256 = response.headers.get(
      "x-aais-research-file-sha256",
    )?.trim() ?? "";
    const computedSha256 = sha256(responseBody.bytes);
    const contentType = response.headers.get("content-type")?.toLowerCase() ?? "";
    const contentDisposition = response.headers.get("content-disposition") ?? "";
    if (response.status !== 200
      || !Number.isInteger(rowCount)
      || rowCount !== expectedParticipant?.expected_events.length
      || !/^[a-f0-9]{64}$/.test(responseSha256)
      || responseSha256 !== computedSha256
      || !contentType.startsWith("application/json")
      || contentDisposition
        !== `attachment; filename="aais-research-${participant.study_run_id}.json"`
      || response.headers.get("cache-control") !== "no-store") {
      throw new Error("AAIS controlled export response metadata failed closed.");
    }
    const parsedBody = parseJson(body, "response body");
    validateExportBody(parsedBody, {
      expectedCommit,
      expectedEvents: expectedParticipant.expected_events,
      participant,
      requestStartedAt,
      responseReceivedAt,
      scope,
    });
    exports.push({
      slot: participant.slot,
      row_count: rowCount,
      file_sha256: responseSha256,
      studyRunId: participant.study_run_id,
      events: parsedBody.events,
      requestStartedAt,
      responseReceivedAt,
    });
  }

  const studyRunIds = exports.map((item) => item.studyRunId);
  const fileSha256Values = exports.map((item) => item.file_sha256);
  let audit;
  let eventRows;
  let transactionOpen = false;
  try {
    await input.database.query(
      "begin transaction isolation level repeatable read read only",
    );
    transactionOpen = true;
    const transactionMode = await input.database.query("show transaction_read_only");
    if (transactionMode.rows?.[0]?.transaction_read_only !== "on") {
      throw new Error("AAIS controlled export snapshot is not read-only.");
    }
    audit = await input.database.query(
      `select file_sha256, row_count::integer, schema_version::integer, commit_sha,
              actor_fingerprint, purpose, outcome, export_format,
              filters->>'studyRunId' as study_run_id,
              (filters->>'limit')::integer as export_limit,
              jsonb_object_length(filters) as filter_key_count,
              created_at, retention_due_at
         from aais_research_export_audit
        where project_id = $1 and study_id = $2 and environment = $3
          and lrs_namespace = $4 and file_sha256 = any($5::text[])
          and actor_fingerprint = $6
        order by file_sha256`,
      [...scope, fileSha256Values, actorFingerprint],
    );
    eventRows = await input.database.query(
      `select event_id::text, participant_id::text, study_run_id::text,
              visit_id::text, project_id, study_id, environment, lrs_namespace,
              condition, schema_version::integer, app_version, commit_sha,
              event_sequence::integer, client_time, server_received_at,
              event_name, outcome, retry_count::integer,
              disconnect_count::integer, ai_latency_ms::integer, detail,
              lrs_eligible, aais_research_detail_is_safe(detail) as detail_safe
         from aais_research_events
        where project_id = $1 and study_id = $2 and environment = $3
          and lrs_namespace = $4 and study_run_id = any($5::uuid[])
        order by study_run_id, event_sequence`,
      [...scope, studyRunIds],
    );
    validateDatabaseReconciliation({
      actorFingerprint,
      auditRows: audit.rows,
      eventRows: eventRows.rows,
      expectedCommit,
      exports,
    });
    await input.database.query("commit");
    transactionOpen = false;
  } catch {
    if (transactionOpen) {
      await input.database.query("rollback").catch(() => undefined);
    }
    throw new Error("AAIS controlled export Postgres reconciliation failed closed.");
  }

  const safeExports = exports
    .map(({ slot, row_count, file_sha256 }) => ({ slot, row_count, file_sha256 }))
    .sort(compareSlot);
  const exportedEventCount = safeExports.reduce(
    (sum, item) => sum + item.row_count,
    0,
  );
  const expectedEventCount = manifest.counting_contract
    .expected_semantic_event_records;
  if (exportedEventCount !== expectedEventCount
    || eventRows.rows.length !== expectedEventCount) {
    throw new Error("AAIS controlled export total does not match the manifest.");
  }
  const attestationCompletedAt = readNow(input.now);
  return {
    evidence_schema_version: 1,
    evidence_type: "aais-synthetic-browser-controlled-postgres-export",
    status: "pass",
    captured_at: attestationCompletedAt.toISOString(),
    attestation_started_at: attestationStartedAt.toISOString(),
    attestation_completed_at: attestationCompletedAt.toISOString(),
    project_id: manifest.project_id,
    study_id: manifest.study_id,
    environment: manifest.environment,
    lrs_namespace: manifest.lrs_namespace,
    declared_lrs_store_id: manifest.lrs_store_id,
    commit_sha: expectedCommit,
    manifest_sha256: manifestSha256,
    observed_visits_sha256: observedVisitsSha256,
    runtime_attestation_sha256: runtimeAttestationSha256,
    runtime_build_id: runtime.runtime_build_id,
    runtime_bundle_sha256: runtime.runtime_bundle_sha256,
    source_of_truth: "postgres",
    export_purpose: "reconciliation",
    export_format: "json",
    participant_export_count: safeExports.length,
    expected_event_count: expectedEventCount,
    exported_event_count: exportedEventCount,
    postgres_event_count: eventRows.rows.length,
    postgres_field_match_count: eventRows.rows.length,
    export_audit_row_count: audit.rows.length,
    http_200_response_count: safeExports.length,
    response_body_sha256_verified_count: safeExports.length,
    database_transaction_read_only: true,
    database_repeatable_read_snapshot: true,
    database_role_no_elevated_attributes: true,
    database_role_memberships_absent: true,
    database_schema_create_privileges_absent: true,
    research_relation_write_privileges_absent: true,
    identity_schema_access_absent: true,
    audit_actor_fingerprint_verified: true,
    audit_window_verified: true,
    server_scope: [
      "project_id", "study_id", "environment", "lrs_namespace", "study_run_id",
    ],
    exports: safeExports,
    raw_export_bodies_retained: false,
    participant_identifiers_retained: false,
    study_run_ids_retained: false,
    visit_ids_retained: false,
    request_headers_retained: false,
    cookies_retained: false,
    credentials_retained: false,
    raw_text_retained: false,
    secrets: "redacted",
  };
}

function validateInputs({ expectedCommit, manifest, observed, runtime }) {
  const manifestKeys = [
    "counting_contract", "declared_at", "declared_before_run", "environment",
    "evidence_schema_version", "lrs_namespace", "lrs_store_id", "participant_count",
    "participants", "project_id", "study_id",
  ];
  const countingKeys = [
    "expected_semantic_event_records", "note", "physical_ui_triggers",
  ];
  const manifestParticipantKeys = ["expected_events", "physical_ui_triggers", "slot"];
  const expectedEventKeys = ["event_name", "outcome", "sequence"];
  const observedKeys = [
    "environment", "evidence_schema_version", "lrs_namespace", "observed_at",
    "participants", "project_id", "source", "study_id",
  ];
  const observedParticipantKeys = [
    "condition", "participant_id", "slot", "study_run_id", "visit_id",
  ];
  const runtimeKeys = [
    "application_mode", "attestation_type", "captured_at", "commit_sha",
    "environment", "evidence_schema_version", "lrs_namespace", "project_id",
    "runtime_build_id", "runtime_bundle_algorithm", "runtime_bundle_entry_count",
    "runtime_bundle_scope", "runtime_bundle_sha256", "study_id",
  ];
  if (!isPlainObject(manifest)
    || !hasExactKeys(manifest, manifestKeys)
    || manifest.evidence_schema_version !== 2
    || manifest.declared_before_run !== true
    || !isIsoDate(manifest.declared_at)
    || !Array.isArray(manifest.participants)
    || manifest.participant_count !== 3
    || !isPlainObject(manifest.counting_contract)
    || !hasExactKeys(manifest.counting_contract, countingKeys)
    || !Number.isInteger(manifest.counting_contract.expected_semantic_event_records)
    || !Number.isInteger(manifest.counting_contract.physical_ui_triggers)
    || typeof manifest.counting_contract.note !== "string"
    || !isPlainObject(observed)
    || !hasExactKeys(observed, observedKeys)
    || observed.evidence_schema_version !== 1
    || !isIsoDate(observed.observed_at)
    || observed.source
      !== "Playwright localStorage after each authenticated research bootstrap"
    || !Array.isArray(observed.participants)
    || observed.participants.length !== 3
    || !isPlainObject(runtime)
    || !hasExactKeys(runtime, runtimeKeys)
    || runtime.evidence_schema_version !== 2
    || runtime.attestation_type !== "aais-runtime-build"
    || runtime.application_mode !== "production-build"
    || !isIsoDate(runtime.captured_at)
    || runtime.commit_sha !== expectedCommit
    || runtime.runtime_bundle_scope !== "next-production-runtime-v1"
    || runtime.runtime_bundle_algorithm !== "sha256-canonical-file-manifest-v1"
    || !Number.isInteger(runtime.runtime_bundle_entry_count)
    || runtime.runtime_bundle_entry_count < 1
    || !/^[a-f0-9]{64}$/.test(runtime.runtime_bundle_sha256)
    || !/^[A-Za-z0-9._-]{1,128}$/.test(runtime.runtime_build_id)) {
    throw new Error("AAIS controlled export evidence inputs are invalid.");
  }
  const scope = [
    manifest.project_id,
    manifest.study_id,
    manifest.environment,
    manifest.lrs_namespace,
  ];
  if (scope[0] !== "aais"
    || !/^[A-Za-z0-9._-]{1,128}$/.test(scope[1])
    || scope[2] !== "research"
    || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(manifest.lrs_store_id)
    || scope[3] !== `https://www.aais.site/xapi/studies/${encodeURIComponent(
      scope[1],
    )}/research/v1`
    || [observed, runtime].some((item) =>
      item.project_id !== scope[0]
        || item.study_id !== scope[1]
        || item.environment !== scope[2]
        || item.lrs_namespace !== scope[3])) {
    throw new Error("AAIS controlled export scope does not match.");
  }
  const manifestSlots = manifest.participants.map((item) => item.slot).sort();
  const observedSlots = observed.participants.map((item) => item.slot).sort();
  const expectedEventCount = manifest.participants.reduce(
    (sum, item) => sum + (Array.isArray(item.expected_events) ? item.expected_events.length : 0),
    0,
  );
  const expectedPhysicalTriggerCount = manifest.participants.reduce(
    (sum, item) => sum + (Number.isInteger(item.physical_ui_triggers)
      ? item.physical_ui_triggers
      : 0),
    0,
  );
  if (JSON.stringify(manifestSlots) !== JSON.stringify(["P1", "P2", "P3"])
    || JSON.stringify(observedSlots) !== JSON.stringify(manifestSlots)
    || expectedEventCount !== manifest.counting_contract.expected_semantic_event_records
    || expectedPhysicalTriggerCount !== manifest.counting_contract.physical_ui_triggers
    || manifest.participants.some((item) =>
      !isPlainObject(item)
        || !hasExactKeys(item, manifestParticipantKeys)
        || !Number.isInteger(item.physical_ui_triggers)
        || item.physical_ui_triggers < 1
        || !Array.isArray(item.expected_events)
        || item.expected_events.length < 1
        || item.expected_events.some((event, index) =>
          !isPlainObject(event)
            || !hasExactKeys(event, expectedEventKeys)
            || event.sequence !== index + 1
            || !researchEventNames.has(event.event_name)
            || !researchOutcomes.has(event.outcome)))
    || observed.participants.some((item) =>
      !isPlainObject(item)
        || !hasExactKeys(item, observedParticipantKeys)
        || !uuidPattern.test(item.study_run_id)
        || !uuidPattern.test(item.participant_id)
        || !uuidPattern.test(item.visit_id)
        || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(item.condition))
    || new Set(observed.participants.map((item) => item.study_run_id)).size !== 3
    || new Set(observed.participants.map((item) => item.participant_id)).size !== 3
    || new Set(observed.participants.map((item) => item.visit_id)).size !== 3
    || new Date(runtime.captured_at) > new Date(manifest.declared_at)
    || new Date(manifest.declared_at) > new Date(observed.observed_at)) {
    throw new Error("AAIS controlled export participant projection is invalid.");
  }
  return scope;
}

function validateExportBody(value, input) {
  const rootKeys = [
    "environment", "events", "exportScope", "generatedAt", "lrsNamespace",
    "projectId", "schemaVersion", "studyId", "studyRunId",
  ];
  const eventKeys = [
    "aiLatencyMs", "appVersion", "clientTime", "commitSha", "condition",
    "detail", "disconnectCount", "environment", "eventId", "eventName",
    "eventSequence", "lrsEligible", "lrsNamespace", "outcome", "participantId",
    "projectId", "retryCount", "schemaVersion", "serverReceivedAt", "studyId",
    "studyRunId", "visitId",
  ];
  const eventIds = new Set();
  if (!isPlainObject(value)
    || !hasExactKeys(value, rootKeys)
    || value.schemaVersion !== 1
    || value.exportScope !== "research-events"
    || value.projectId !== input.scope[0]
    || value.studyId !== input.scope[1]
    || value.environment !== input.scope[2]
    || value.lrsNamespace !== input.scope[3]
    || value.studyRunId !== input.participant.study_run_id
    || !isIsoDate(value.generatedAt)
    || !isDateInsideAuditWindow(
      value.generatedAt,
      input.requestStartedAt,
      input.responseReceivedAt,
    )
    || !Array.isArray(value.events)
    || value.events.length !== input.expectedEvents.length
    || value.events.some((event, index) => {
      const expected = input.expectedEvents[index];
      const invalid = !isPlainObject(event)
        || !hasExactKeys(event, eventKeys)
        || !uuidPattern.test(event.eventId)
        || eventIds.has(event.eventId)
        || event.participantId !== input.participant.participant_id
        || event.studyRunId !== input.participant.study_run_id
        || event.visitId !== input.participant.visit_id
        || event.projectId !== input.scope[0]
        || event.studyId !== input.scope[1]
        || event.environment !== input.scope[2]
        || event.lrsNamespace !== input.scope[3]
        || event.condition !== input.participant.condition
        || event.schemaVersion !== 1
        || !/^[A-Za-z0-9][A-Za-z0-9._+-]{0,127}$/.test(event.appVersion)
        || event.commitSha !== input.expectedCommit
        || !isIsoDate(event.clientTime)
        || !isIsoDate(event.serverReceivedAt)
        || event.eventName !== expected.event_name
        || event.outcome !== expected.outcome
        || !isNonnegativeSafeInteger(event.retryCount)
        || !isNonnegativeSafeInteger(event.disconnectCount)
        || event.aiLatencyMs !== null && !isNonnegativeSafeInteger(event.aiLatencyMs)
        || !isSafeResearchDetail(event.detail)
        || event.lrsEligible !== true
        || event.eventSequence !== expected.sequence;
      if (!invalid) eventIds.add(event.eventId);
      return invalid;
    })) {
    throw new Error("AAIS controlled export body failed scope validation.");
  }
}

function validateDatabaseReconciliation({
  actorFingerprint,
  auditRows,
  eventRows,
  expectedCommit,
  exports,
}) {
  const exportByHash = new Map(exports.map((item) => [item.file_sha256, item]));
  if (!Array.isArray(auditRows)
    || auditRows.length !== exports.length
    || new Set(auditRows.map((row) => row.file_sha256)).size !== exports.length
    || auditRows.some((row) => {
      const expected = exportByHash.get(row.file_sha256);
      return !expected
        || row.study_run_id !== expected.studyRunId
        || row.row_count !== expected.row_count
        || row.schema_version !== 1
        || row.commit_sha !== expectedCommit
        || row.actor_fingerprint !== actorFingerprint
        || row.purpose !== "reconciliation"
        || row.outcome !== "success"
        || row.export_format !== "json"
        || row.export_limit !== 10_000
        || row.filter_key_count !== 2
        || !isDateInsideAuditWindow(
          row.created_at,
          expected.requestStartedAt,
          expected.responseReceivedAt,
        )
        || !isAfter(row.retention_due_at, row.created_at);
    })
    || !Array.isArray(eventRows)
    || eventRows.length !== exports.reduce((sum, item) => sum + item.row_count, 0)) {
    throw new Error("AAIS controlled export audit did not reconcile with Postgres.");
  }
  for (const item of exports) {
    const matchingRows = eventRows.filter((row) => row.study_run_id === item.studyRunId);
    const normalizedRows = matchingRows.map(normalizePostgresEvent);
    if (matchingRows.some((row) => row.detail_safe !== true)
      || normalizedRows.some((row) => row === null)
      || stableJson(normalizedRows) !== stableJson(item.events)) {
      throw new Error("AAIS controlled export body does not match Postgres rows.");
    }
  }
}

export async function writeRestrictedJson(filePath, value) {
  const output = path.resolve(filePath);
  await mkdir(path.dirname(output), { recursive: true, mode: 0o700 });
  const directoryStat = await lstat(path.dirname(output));
  if (!directoryStat.isDirectory()
    || directoryStat.isSymbolicLink()
    || (directoryStat.mode & 0o077) !== 0) {
    throw new Error("AAIS controlled export evidence directory is invalid.");
  }
  await writeFile(output, `${JSON.stringify(value, null, 2)}\n`, {
    flag: "wx",
    mode: 0o600,
  });
  await chmod(output, 0o600);
}

function createSessionToken(actor, secret, issuedAt) {
  return signPayload({
    v: 1,
    actor,
    iat: issuedAt,
    exp: issuedAt + sessionTtlSeconds,
  }, secret);
}

function createCsrfToken(actorId, secret, issuedAt) {
  return signPayload({
    v: 1,
    sub: actorId,
    iat: issuedAt,
    exp: issuedAt + sessionTtlSeconds,
  }, secret);
}

function signPayload(payload, secret) {
  const encoded = Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
  const signature = createHmac("sha256", secret).update(encoded).digest("base64url");
  return `${encoded}.${signature}`;
}

function normalizeBaseUrl(value) {
  const url = new URL(String(value));
  if (!["http:", "https:"].includes(url.protocol)
    || !["127.0.0.1", "localhost", "::1"].includes(url.hostname)
    || url.username
    || url.password
    || url.pathname !== "/"
    || url.search
    || url.hash) {
    throw new Error("AAIS controlled export base URL must be a localhost origin.");
  }
  return url.origin;
}

function requireCommit(value) {
  const commit = String(value ?? "").trim();
  if (!/^[a-f0-9]{40}$/.test(commit)) {
    throw new Error("AAIS controlled export attester requires a full Git SHA.");
  }
  return commit;
}

function requireSyntheticActor(value) {
  const actor = String(value ?? "").trim();
  if (!/^Synthetic[A-Za-z0-9._:-]{0,118}$/.test(actor)) {
    throw new Error("AAIS controlled export actor must be synthetic.");
  }
  return actor;
}

function readOptions(args) {
  const values = new Map();
  for (let index = 0; index < args.length; index += 2) {
    const name = args[index];
    const value = args[index + 1];
    if (!name?.startsWith("--") || !value || values.has(name)) {
      throw new Error("AAIS controlled export options are invalid.");
    }
    values.set(name, value);
  }
  const required = [
    "--base-url", "--manifest", "--observed-visits",
    "--runtime-build-attestation", "--expected-commit", "--researcher-actor",
    "--output",
  ];
  if ([...values.keys()].some((name) => !required.includes(name))) {
    throw new Error("AAIS controlled export received an unknown option.");
  }
  for (const name of required) {
    if (!values.get(name)) throw new Error(`Missing required option ${name}.`);
  }
  return {
    baseUrl: values.get("--base-url"),
    manifest: path.resolve(values.get("--manifest")),
    observedVisits: path.resolve(values.get("--observed-visits")),
    runtimeBuildAttestation: path.resolve(values.get("--runtime-build-attestation")),
    expectedCommit: values.get("--expected-commit"),
    researcherActor: values.get("--researcher-actor"),
    output: path.resolve(values.get("--output")),
  };
}

function compareSlot(left, right) {
  return left.slot.localeCompare(right.slot);
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

async function assertLeastPrivilegeReadOnlyConnection(database) {
  const transactionMode = await database.query("show transaction_read_only");
  const privilege = await database.query(
    `select r.rolsuper, r.rolcreaterole, r.rolcreatedb, r.rolreplication,
            r.rolbypassrls,
            has_database_privilege(current_user, current_database(), 'CREATE')
              as database_create,
            has_schema_privilege(current_user, 'public', 'CREATE')
              as public_schema_create,
            has_schema_privilege(current_user, 'aais_research_identity', 'CREATE')
              as identity_schema_create,
            has_schema_privilege(current_user, 'aais_research_identity', 'USAGE')
              as identity_schema_usage,
            exists (
              select 1 from pg_auth_members memberships
               where memberships.member = r.oid
            ) as has_role_membership,
            exists (
              select 1
                from pg_class relations
                join pg_namespace schemas on schemas.oid = relations.relnamespace
               where schemas.nspname in ('public', 'aais_research_identity')
                 and relations.relkind in ('r', 'p')
                 and has_table_privilege(
                   current_user, relations.oid,
                   'INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER'
                 )
            ) as has_relation_write,
            exists (
              select 1
                from pg_class sequences
                join pg_namespace schemas on schemas.oid = sequences.relnamespace
               where schemas.nspname in ('public', 'aais_research_identity')
                 and sequences.relkind = 'S'
                 and has_sequence_privilege(current_user, sequences.oid, 'USAGE,UPDATE')
            ) as has_sequence_write
       from pg_roles r
      where r.rolname = current_user`,
  );
  const row = privilege.rows?.[0];
  if (transactionMode.rows?.[0]?.transaction_read_only !== "on"
    || privilege.rows?.length !== 1
    || row.rolsuper !== false
    || row.rolcreaterole !== false
    || row.rolcreatedb !== false
    || row.rolreplication !== false
    || row.rolbypassrls !== false
    || row.database_create !== false
    || row.public_schema_create !== false
    || row.identity_schema_create !== false
    || row.identity_schema_usage !== false
    || row.has_role_membership !== false
    || row.has_relation_write !== false
    || row.has_sequence_write !== false) {
    throw new Error("AAIS controlled export reconciliation credential is not least privilege.");
  }
}

async function readCappedResponseBody(response) {
  const declaredLength = response.headers.get("content-length");
  if (declaredLength !== null
    && (!/^\d+$/.test(declaredLength)
      || Number(declaredLength) > maximumExportBytes)) {
    throw new Error("AAIS controlled export response size is invalid.");
  }
  if (!response.body) {
    return { bytes: Buffer.alloc(0), text: "" };
  }
  const reader = response.body.getReader();
  const chunks = [];
  let length = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      const chunk = Buffer.from(value);
      length += chunk.byteLength;
      if (length > maximumExportBytes) {
        await reader.cancel();
        throw new Error("AAIS controlled export response exceeded the byte limit.");
      }
      chunks.push(chunk);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = Buffer.concat(chunks, length);
  return { bytes, text: bytes.toString("utf8") };
}

function readFingerprintKey(value) {
  const encoded = String(value ?? "").trim();
  const key = Buffer.from(encoded, "base64");
  const canonical = key.toString("base64").replace(/=+$/, "");
  if (key.byteLength !== 32 || canonical !== encoded.replace(/=+$/, "")) {
    throw new Error("AAIS controlled export fingerprint key is invalid.");
  }
  return key;
}

function parseJson(value, label) {
  try {
    return JSON.parse(value);
  } catch {
    throw new Error(`AAIS controlled export ${label} JSON is invalid.`);
  }
}

function readNow(now) {
  const value = now?.() ?? new Date();
  const date = value instanceof Date ? new Date(value.getTime()) : new Date(value);
  if (Number.isNaN(date.getTime())) {
    throw new Error("AAIS controlled export clock is invalid.");
  }
  return date;
}

function normalizePostgresEvent(row) {
  if (!isPlainObject(row)) return null;
  const clientTime = normalizeDate(row.client_time);
  const serverReceivedAt = normalizeDate(row.server_received_at);
  if (!clientTime || !serverReceivedAt || !isPlainObject(row.detail)) return null;
  return {
    eventId: row.event_id,
    participantId: row.participant_id,
    studyRunId: row.study_run_id,
    visitId: row.visit_id,
    projectId: row.project_id,
    studyId: row.study_id,
    environment: row.environment,
    lrsNamespace: row.lrs_namespace,
    condition: row.condition,
    schemaVersion: row.schema_version,
    appVersion: row.app_version,
    commitSha: row.commit_sha,
    eventSequence: row.event_sequence,
    clientTime,
    serverReceivedAt,
    eventName: row.event_name,
    outcome: row.outcome,
    retryCount: row.retry_count,
    disconnectCount: row.disconnect_count,
    aiLatencyMs: row.ai_latency_ms,
    detail: row.detail,
    lrsEligible: row.lrs_eligible,
  };
}

function normalizeDate(value) {
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function isDateInsideAuditWindow(value, startedAt, receivedAt) {
  const timestamp = new Date(value).getTime();
  return Number.isFinite(timestamp)
    && timestamp >= startedAt.getTime() - auditClockToleranceMilliseconds
    && timestamp <= receivedAt.getTime() + auditClockToleranceMilliseconds;
}

function isAfter(left, right) {
  const leftTime = new Date(left).getTime();
  const rightTime = new Date(right).getTime();
  return Number.isFinite(leftTime) && Number.isFinite(rightTime) && leftTime > rightTime;
}

function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (isPlainObject(value)) {
    return `{${Object.keys(value).sort().map((key) =>
      `${JSON.stringify(key)}:${stableJson(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function isIsoDate(value) {
  return typeof value === "string"
    && !Number.isNaN(new Date(value).getTime())
    && new Date(value).toISOString() === value;
}

function isNonnegativeSafeInteger(value) {
  return Number.isSafeInteger(value) && value >= 0;
}

function isSafeResearchDetail(value) {
  return isPlainObject(value) && Object.entries(value).every(([key, item]) =>
    researchDetailKeys.has(key)
      && (item === null
        || typeof item === "boolean"
        || Number.isSafeInteger(item)
        || typeof item === "string"
          && item.length <= 128
          && /^[A-Za-z0-9][A-Za-z0-9._:/+-]{0,127}$/.test(item)));
}

function hasExactKeys(value, keys) {
  return isPlainObject(value)
    && Object.keys(value).sort().join("|") === [...keys].sort().join("|");
}

function isDirectInvocation() {
  return Boolean(modulePath && process.argv[1])
    && path.resolve(process.argv[1]) === modulePath;
}
