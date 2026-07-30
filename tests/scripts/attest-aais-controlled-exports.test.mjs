import { createHash, createHmac } from "node:crypto";
import {
  chmod,
  mkdtemp,
  mkdir,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  attestAaisControlledExports,
  writeRestrictedJson,
} from "../../scripts/attest-aais-controlled-exports.mjs";

const expectedCommit = "a".repeat(40);
const studyId = "controlled-export-test";
const namespace = `https://www.aais.site/xapi/studies/${studyId}/research/v1`;
const actor = "SyntheticResearchExportAttester";
const sessionSecret = "s".repeat(48);
const fingerprintKey = Buffer.alloc(32, 7);
const fingerprintKeyBase64 = fingerprintKey.toString("base64");
const actorFingerprint = createHmac("sha256", fingerprintKey)
  .update(`aais-research-identity-fingerprint:v1:${actor}`)
  .digest("hex");
const fixedNow = new Date("2026-07-30T10:03:00.000Z");

describe("AAIS controlled researcher export attester", () => {
  it("binds three HTTP exports field-for-field to a least-privilege Postgres snapshot", async () => {
    const fixture = await createFixture();
    try {
      const fetchCalls = [];
      const receipt = await attestAaisControlledExports({
        ...fixture.input,
        database: createDatabase(fixture),
        env: createEnv(),
        fetchImpl: createFetch(fixture, fetchCalls),
        now: () => fixedNow,
      });

      expect(fetchCalls).toHaveLength(3);
      expect(fetchCalls.every((call) =>
        call.method === "GET"
          && call.redirect === "error"
          && call.hasExactCsrfHeader
          && call.hasLegacyCsrfHeader === false
          && call.hasSessionCookie
          && call.hasCsrfCookie
          && call.hasAbortSignal)).toBe(true);
      expect(receipt).toMatchObject({
        status: "pass",
        participant_export_count: 3,
        expected_event_count: 3,
        exported_event_count: 3,
        postgres_event_count: 3,
        postgres_field_match_count: 3,
        export_audit_row_count: 3,
        database_transaction_read_only: true,
        database_repeatable_read_snapshot: true,
        database_role_no_elevated_attributes: true,
        database_role_memberships_absent: true,
        database_schema_create_privileges_absent: true,
        research_relation_write_privileges_absent: true,
        identity_schema_access_absent: true,
        audit_actor_fingerprint_verified: true,
        audit_window_verified: true,
        raw_export_bodies_retained: false,
        participant_identifiers_retained: false,
        study_run_ids_retained: false,
        visit_ids_retained: false,
        raw_text_retained: false,
      });
      expect(receipt.observed_visits_sha256).toBe(sha256(fixture.observedRaw));
      const retained = JSON.stringify(receipt);
      for (const participant of fixture.observed.participants) {
        expect(retained).not.toContain(participant.participant_id);
        expect(retained).not.toContain(participant.study_run_id);
        expect(retained).not.toContain(participant.visit_id);
      }
      expect(retained).not.toContain(actorFingerprint);
      expect(retained).not.toContain(sessionSecret);
      expect(retained).not.toContain(fingerprintKeyBase64);
    } finally {
      await fixture.cleanup();
    }
  });

  it("fails before export when the reconciliation credential is writable or privileged", async () => {
    const fixture = await createFixture();
    let fetchCount = 0;
    try {
      await expect(attestAaisControlledExports({
        ...fixture.input,
        database: createDatabase(fixture, { transactionReadOnly: "off" }),
        env: createEnv(),
        fetchImpl: async () => {
          fetchCount += 1;
          throw new Error("must not fetch");
        },
        now: () => fixedNow,
      })).rejects.toThrow("not least privilege");
      expect(fetchCount).toBe(0);

      await expect(attestAaisControlledExports({
        ...fixture.input,
        database: createDatabase(fixture, { roleSuperuser: true }),
        env: createEnv(),
        fetchImpl: createFetch(fixture),
        now: () => fixedNow,
      })).rejects.toThrow("not least privilege");
    } finally {
      await fixture.cleanup();
    }
  });

  it("rejects stale audit rows and any field-level Postgres/body mismatch", async () => {
    const fixture = await createFixture();
    try {
      await expect(attestAaisControlledExports({
        ...fixture.input,
        database: createDatabase(fixture, {
          auditCreatedAt: "2026-07-29T10:03:00.000Z",
        }),
        env: createEnv(),
        fetchImpl: createFetch(fixture),
        now: () => fixedNow,
      })).rejects.toThrow("Postgres reconciliation failed closed");

      await expect(attestAaisControlledExports({
        ...fixture.input,
        database: createDatabase(fixture, { mutateEventOutcome: true }),
        env: createEnv(),
        fetchImpl: createFetch(fixture),
        now: () => fixedNow,
      })).rejects.toThrow("Postgres reconciliation failed closed");
    } finally {
      await fixture.cleanup();
    }
  });

  it("rejects a wrong response SHA and masks malformed body content", async () => {
    const fixture = await createFixture();
    try {
      await expect(attestAaisControlledExports({
        ...fixture.input,
        database: createDatabase(fixture),
        env: createEnv(),
        fetchImpl: createFetch(fixture, [], { wrongSha: true }),
        now: () => fixedNow,
      })).rejects.toThrow("response metadata failed closed");

      const privateText = "private learner answer must never reach an error";
      const malformedFetch = createFetch(fixture, [], { malformedBody: privateText });
      let message = "";
      try {
        await attestAaisControlledExports({
          ...fixture.input,
          database: createDatabase(fixture),
          env: createEnv(),
          fetchImpl: malformedFetch,
          now: () => fixedNow,
        });
      } catch (error) {
        message = String(error?.message ?? error);
      }
      expect(message).toBe("AAIS controlled export response body JSON is invalid.");
      expect(message).not.toContain(privateText);
    } finally {
      await fixture.cleanup();
    }
  });

  it("caps response bytes and writes evidence exclusively at 0600 under a 0700 directory", async () => {
    const fixture = await createFixture();
    const outputRoot = await mkdtemp(path.join(os.tmpdir(), "aais-export-output-"));
    try {
      const oversized = new Response("{}", {
        status: 200,
        headers: { "content-length": String(8 * 1024 * 1024 + 1) },
      });
      await expect(attestAaisControlledExports({
        ...fixture.input,
        database: createDatabase(fixture),
        env: createEnv(),
        fetchImpl: async () => oversized,
        now: () => fixedNow,
      })).rejects.toThrow("response size is invalid");

      const evidenceDirectory = path.join(outputRoot, "restricted");
      const output = path.join(evidenceDirectory, "receipt.json");
      await writeRestrictedJson(output, { status: "pass" });
      expect((await stat(evidenceDirectory)).mode & 0o777).toBe(0o700);
      expect((await stat(output)).mode & 0o777).toBe(0o600);
      await expect(writeRestrictedJson(output, { status: "pass" }))
        .rejects.toMatchObject({ code: "EEXIST" });

      const targetDirectory = path.join(outputRoot, "target");
      const linkedDirectory = path.join(outputRoot, "linked");
      await mkdir(targetDirectory);
      await symlink(targetDirectory, linkedDirectory);
      await expect(writeRestrictedJson(
        path.join(linkedDirectory, "blocked.json"),
        { status: "pass" },
      )).rejects.toThrow("evidence directory is invalid");
    } finally {
      await fixture.cleanup();
      await chmod(outputRoot, 0o700).catch(() => undefined);
      await rm(outputRoot, { recursive: true, force: true });
    }
  });
});

async function createFixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), "aais-export-attester-"));
  const manifest = {
    evidence_schema_version: 2,
    declared_at: "2026-07-30T10:01:00.000Z",
    declared_before_run: true,
    project_id: "aais",
    study_id: studyId,
    environment: "research",
    lrs_store_id: "aais-research-controlled-export-test",
    lrs_namespace: namespace,
    participant_count: 3,
    counting_contract: {
      physical_ui_triggers: 3,
      expected_semantic_event_records: 3,
      note: "One controlled event per synthetic participant.",
    },
    participants: [1, 2, 3].map((number) => ({
      slot: `P${number}`,
      physical_ui_triggers: 1,
      expected_events: [{
        sequence: 1,
        event_name: "workspace_session_load",
        outcome: "success",
      }],
    })),
  };
  const observed = {
    evidence_schema_version: 1,
    observed_at: "2026-07-30T10:02:00.000Z",
    source: "Playwright localStorage after each authenticated research bootstrap",
    project_id: "aais",
    study_id: studyId,
    environment: "research",
    lrs_namespace: namespace,
    participants: [1, 2, 3].map((number) => ({
      slot: `P${number}`,
      participant_id: uuidFor(number, 1),
      study_run_id: uuidFor(number, 2),
      visit_id: uuidFor(number, 3),
      condition: `condition_${number}`,
    })),
  };
  const runtime = {
    evidence_schema_version: 2,
    attestation_type: "aais-runtime-build",
    captured_at: "2026-07-30T10:00:00.000Z",
    application_mode: "production-build",
    project_id: "aais",
    study_id: studyId,
    environment: "research",
    lrs_namespace: namespace,
    commit_sha: expectedCommit,
    runtime_build_id: "runtime-test-build",
    runtime_bundle_scope: "next-production-runtime-v1",
    runtime_bundle_algorithm: "sha256-canonical-file-manifest-v1",
    runtime_bundle_entry_count: 10,
    runtime_bundle_sha256: "b".repeat(64),
  };
  const manifestRaw = `${JSON.stringify(manifest, null, 2)}\n`;
  const observedRaw = `${JSON.stringify(observed, null, 2)}\n`;
  const runtimeRaw = `${JSON.stringify(runtime, null, 2)}\n`;
  const manifestPath = path.join(root, "manifest.json");
  const observedPath = path.join(root, "observed.json");
  const runtimePath = path.join(root, "runtime.json");
  await Promise.all([
    writeFile(manifestPath, manifestRaw),
    writeFile(observedPath, observedRaw),
    writeFile(runtimePath, runtimeRaw),
  ]);
  const exportRecords = observed.participants.map((participant, index) => {
    const event = createExportEvent(participant, index + 1);
    const bodyValue = {
      schemaVersion: 1,
      exportScope: "research-events",
      generatedAt: fixedNow.toISOString(),
      projectId: "aais",
      studyId,
      environment: "research",
      lrsNamespace: namespace,
      studyRunId: participant.study_run_id,
      events: [event],
    };
    const body = JSON.stringify(bodyValue, null, 2);
    return { participant, event, body, sha256: sha256(body) };
  });
  return {
    cleanup: () => rm(root, { recursive: true, force: true }),
    exportRecords,
    input: {
      baseUrl: "http://127.0.0.1:3219",
      manifest: manifestPath,
      observedVisits: observedPath,
      runtimeBuildAttestation: runtimePath,
      expectedCommit,
      researcherActor: actor,
    },
    manifest,
    manifestRaw,
    observed,
    observedRaw,
    runtime,
    runtimeRaw,
  };
}

function createExportEvent(participant, number) {
  return {
    eventId: uuidFor(number, 4),
    participantId: participant.participant_id,
    studyRunId: participant.study_run_id,
    visitId: participant.visit_id,
    projectId: "aais",
    studyId,
    environment: "research",
    lrsNamespace: namespace,
    condition: participant.condition,
    schemaVersion: 1,
    appVersion: "test-1",
    commitSha: expectedCommit,
    eventSequence: 1,
    clientTime: "2026-07-30T10:01:30.000Z",
    serverReceivedAt: "2026-07-30T10:01:31.000Z",
    eventName: "workspace_session_load",
    outcome: "success",
    retryCount: 0,
    disconnectCount: 0,
    aiLatencyMs: null,
    detail: { trigger: "page_mount" },
    lrsEligible: true,
  };
}

function createEnv() {
  return {
    AAIS_SESSION_SECRET: sessionSecret,
    AAIS_RESEARCH_IDENTITY_FINGERPRINT_KEY: fingerprintKeyBase64,
  };
}

function createFetch(fixture, calls = [], options = {}) {
  let callIndex = 0;
  return async (url, init) => {
    const record = fixture.exportRecords[callIndex];
    callIndex += 1;
    const parsed = new URL(url);
    expect(parsed.pathname).toBe("/api/research/events/export");
    expect(parsed.searchParams.get("studyRunId")).toBe(record.participant.study_run_id);
    const csrf = init.headers["x-aais-csrf"];
    calls.push({
      method: init.method,
      redirect: init.redirect,
      hasExactCsrfHeader: typeof csrf === "string" && csrf.length > 20,
      hasLegacyCsrfHeader: Object.hasOwn(init.headers, "x-aais-csrf-token"),
      hasSessionCookie: init.headers.cookie.includes("aais_session="),
      hasCsrfCookie: init.headers.cookie.includes(`aais_csrf=${csrf}`),
      hasAbortSignal: init.signal instanceof AbortSignal,
    });
    const body = options.malformedBody ?? record.body;
    const responseSha = options.wrongSha ? "f".repeat(64) : sha256(body);
    return new Response(body, {
      status: 200,
      headers: {
        "cache-control": "no-store",
        "content-type": "application/json; charset=utf-8",
        "content-disposition":
          `attachment; filename="aais-research-${record.participant.study_run_id}.json"`,
        "x-aais-research-row-count": "1",
        "x-aais-research-file-sha256": responseSha,
      },
    });
  };
}

function createDatabase(fixture, options = {}) {
  const auditCreatedAt = options.auditCreatedAt ?? fixedNow.toISOString();
  const auditRows = fixture.exportRecords.map((record) => ({
    file_sha256: record.sha256,
    row_count: 1,
    schema_version: 1,
    commit_sha: expectedCommit,
    actor_fingerprint: actorFingerprint,
    purpose: "reconciliation",
    outcome: "success",
    export_format: "json",
    study_run_id: record.participant.study_run_id,
    export_limit: 10_000,
    filter_key_count: 2,
    created_at: auditCreatedAt,
    retention_due_at: "2027-07-30T10:03:00.000Z",
  }));
  const eventRows = fixture.exportRecords.map(({ event }, index) => ({
    event_id: event.eventId,
    participant_id: event.participantId,
    study_run_id: event.studyRunId,
    visit_id: event.visitId,
    project_id: event.projectId,
    study_id: event.studyId,
    environment: event.environment,
    lrs_namespace: event.lrsNamespace,
    condition: event.condition,
    schema_version: event.schemaVersion,
    app_version: event.appVersion,
    commit_sha: event.commitSha,
    event_sequence: event.eventSequence,
    client_time: new Date(event.clientTime),
    server_received_at: new Date(event.serverReceivedAt),
    event_name: event.eventName,
    outcome: options.mutateEventOutcome && index === 0 ? "failure" : event.outcome,
    retry_count: event.retryCount,
    disconnect_count: event.disconnectCount,
    ai_latency_ms: event.aiLatencyMs,
    detail: event.detail,
    lrs_eligible: event.lrsEligible,
    detail_safe: true,
  }));
  let transactionOpen = false;
  return {
    async query(sql, params) {
      const normalized = String(sql).trim().toLowerCase();
      if (normalized === "show transaction_read_only") {
        return { rows: [{
          transaction_read_only: options.transactionReadOnly ?? "on",
        }] };
      }
      if (normalized.includes("from pg_roles")) {
        return { rows: [{
          rolsuper: options.roleSuperuser ?? false,
          rolcreaterole: false,
          rolcreatedb: false,
          rolreplication: false,
          rolbypassrls: false,
          database_create: false,
          public_schema_create: false,
          identity_schema_create: false,
          identity_schema_usage: false,
          has_role_membership: false,
          has_relation_write: false,
          has_sequence_write: false,
        }] };
      }
      if (normalized.startsWith("begin transaction")) {
        transactionOpen = true;
        return { rows: [] };
      }
      if (normalized.includes("from aais_research_export_audit")) {
        expect(transactionOpen).toBe(true);
        expect(params.at(-1)).toBe(actorFingerprint);
        return { rows: auditRows };
      }
      if (normalized.includes("from aais_research_events")) {
        expect(transactionOpen).toBe(true);
        return { rows: eventRows };
      }
      if (normalized === "commit" || normalized === "rollback") {
        transactionOpen = false;
        return { rows: [] };
      }
      throw new Error("Unexpected database query in controlled export test.");
    },
  };
}

function uuidFor(participant, field) {
  return `${String(participant).padStart(8, "0")}-0000-4000-8000-${String(field)
    .padStart(12, "0")}`;
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}
