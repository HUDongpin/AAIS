import {
  mkdtemp,
  readFile,
  rm,
  stat,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  aaisBrowserResearchEventNames,
  assertManifestShape,
  compareOutboxPayloads,
  compareTransportAcknowledgements,
  evaluateContractCoverage,
  validateExternalLrsAttestationForRun,
  validateRuntimeBuildAttestationForRun,
  validateTransportSummary,
  writeEvidenceFile,
} from "../../scripts/reconcile-aais-browser-rehearsal.mjs";

const scope = {
  projectId: "aais",
  studyId: "browser-reconcile-test",
  environment: "research",
  lrsNamespace:
    "https://www.aais.site/xapi/studies/browser-reconcile-test/research/v1",
  lrsStoreId: "aais-research-clean-store",
};

describe("AAIS browser rehearsal reconciliation boundaries", () => {
  it("binds every acknowledgement to the expected route, method, status, visit, and event", () => {
    const events = [
      createEvent({
        eventId: "10000000-0000-4000-8000-000000000001",
        clientEventId: "20000000-0000-4000-8000-000000000001",
        eventName: "content_item_opened",
        outcome: "success",
        sequence: 1,
      }),
      createEvent({
        eventId: "10000000-0000-4000-8000-000000000002",
        clientEventId: "20000000-0000-4000-8000-000000000002",
        eventName: "account_logout",
        outcome: "success",
        sequence: 2,
      }),
    ];
    const transport = createTransport([
      acknowledgementFor(events[0]),
      acknowledgementFor(events[1]),
    ]);

    const validated = validateTransportSummary(transport);

    expect(validated).toMatchObject({
      aggregateGatePassed: true,
      perRouteCountGatePassed: true,
      routeCounts: {
        research_event_post_201: 1,
        logout_delete_200: 1,
      },
    });
    expect(compareTransportAcknowledgements(validated.acknowledgements, events))
      .toEqual({ verified: true, differenceCount: 0, logoutVerified: true });
  });

  it("rejects a route swap even when aggregate and per-route counts still match", () => {
    const ordinary = createEvent({
      eventId: "10000000-0000-4000-8000-000000000011",
      clientEventId: "20000000-0000-4000-8000-000000000011",
      eventName: "content_item_opened",
      outcome: "success",
      sequence: 1,
    });
    const logout = createEvent({
      eventId: "10000000-0000-4000-8000-000000000012",
      clientEventId: "20000000-0000-4000-8000-000000000012",
      eventName: "account_logout",
      outcome: "success",
      sequence: 2,
    });
    const transport = createTransport([
      { ...acknowledgementFor(ordinary), route: "/api/auth/app-session", method: "DELETE", status: 200 },
      { ...acknowledgementFor(logout), route: "/api/research/events", method: "POST", status: 201 },
    ]);
    const validated = validateTransportSummary(transport);

    expect(validated.aggregateGatePassed).toBe(true);
    expect(validated.perRouteCountGatePassed).toBe(true);
    expect(compareTransportAcknowledgements(validated.acknowledgements, [ordinary, logout]))
      .toMatchObject({ verified: false, logoutVerified: false });
  });

  it("fails the aggregate gate when acknowledgement route counts contradict the trace totals", () => {
    const events = [
      createEvent({
        eventId: "10000000-0000-4000-8000-000000000021",
        clientEventId: "20000000-0000-4000-8000-000000000021",
        eventName: "content_item_opened",
        outcome: "success",
        sequence: 1,
      }),
      createEvent({
        eventId: "10000000-0000-4000-8000-000000000022",
        clientEventId: "20000000-0000-4000-8000-000000000022",
        eventName: "content_item_opened",
        outcome: "success",
        sequence: 2,
      }),
    ];
    const transport = createTransport(events.map(acknowledgementFor));

    const validated = validateTransportSummary({
      ...transport,
      research_event_post_attempts: 1,
      research_event_post_201: 1,
      logout_delete_attempts: 1,
      logout_delete_200: 1,
    });

    expect(validated.perRouteCountGatePassed).toBe(false);
    expect(validated.aggregateGatePassed).toBe(false);
  });

  it("requires an exact statement id and exact outbox payload projection", () => {
    const event = createEvent({
      eventId: "10000000-0000-4000-8000-000000000031",
      clientEventId: "20000000-0000-4000-8000-000000000031",
      eventName: "ai_guide_submit",
      outcome: "success",
      sequence: 1,
    });
    const matching = createOutboxRow(event);

    expect(compareOutboxPayloads([matching], [event], scope)).toEqual({
      verified: true,
      mismatchCount: 0,
    });
    expect(compareOutboxPayloads([{
      ...matching,
      payload: { ...matching.payload, participantId: "30000000-0000-4000-8000-000000000099" },
    }], [event], scope)).toEqual({ verified: false, mismatchCount: 1 });
    expect(compareOutboxPayloads([{
      ...matching,
      statement_id: "30000000-0000-4000-8000-000000000098",
    }], [event], scope)).toEqual({ verified: false, mismatchCount: 1 });
    expect(compareOutboxPayloads([{
      ...matching,
      payload: { ...matching.payload, rawText: "private learner answer" },
    }], [event], scope)).toEqual({ verified: false, mismatchCount: 1 });
  });

  it("rejects identity-bearing or non-canonical manifest artifacts", () => {
    const { manifest, observed } = createManifestPair();
    expect(() => assertManifestShape(manifest, observed)).not.toThrow();

    const identityBearing = structuredClone(observed);
    identityBearing.participants[0].actor_id = "Synthetic1";
    expect(() => assertManifestShape(manifest, identityBearing))
      .toThrow("observed visit identities are invalid");

    const nonCanonical = structuredClone(manifest);
    nonCanonical.lrs_namespace = "https://www.aais.site/xapi/wrong/research/v1";
    const matchingObserved = { ...observed, lrs_namespace: nonCanonical.lrs_namespace };
    expect(() => assertManifestShape(nonCanonical, matchingObserved))
      .toThrow("namespace is not canonical");
  });

  it("requires and reports exact 22-of-22 event-type coverage", () => {
    const completeEvents = aaisBrowserResearchEventNames.map((eventName) => ({
      event_name: eventName,
    }));
    expect(evaluateContractCoverage(completeEvents)).toEqual({
      observedEventTypes: 22,
      coveredContractEventTypes: 22,
      contractEventTypesTotal: 22,
      missingEventNames: [],
      unexpectedEventNames: [],
      complete: true,
    });

    const missingOne = completeEvents.slice(0, -1);
    expect(evaluateContractCoverage(missingOne)).toMatchObject({
      observedEventTypes: 21,
      coveredContractEventTypes: 21,
      contractEventTypesTotal: 22,
      missingEventNames: ["document_download"],
      unexpectedEventNames: [],
      complete: false,
    });

    const { manifest, observed } = createManifestPair();
    manifest.participants[0].expected_events =
      manifest.participants[0].expected_events.filter(
        (event) => event.event_name !== "document_download",
      );
    manifest.participants[0].expected_events.forEach((event, index) => {
      event.sequence = index + 1;
    });
    manifest.counting_contract.expected_semantic_event_records -= 1;
    expect(() => assertManifestShape(manifest, observed))
      .toThrow("does not cover the complete 22-event contract");
  });

  it("creates evidence once with mode 0600 and refuses overwrite", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "aais-reconcile-evidence-"));
    const output = path.join(directory, "report.json");
    try {
      await writeEvidenceFile(output, { evidence_status: "pass" });
      expect((await stat(output)).mode & 0o777).toBe(0o600);
      expect(JSON.parse(await readFile(output, "utf8")))
        .toEqual({ evidence_status: "pass" });
      await expect(writeEvidenceFile(output, { evidence_status: "tampered" }))
        .rejects.toMatchObject({ code: "EEXIST" });
      expect(JSON.parse(await readFile(output, "utf8")))
        .toEqual({ evidence_status: "pass" });
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("does not claim nonexistent screenshots or obsolete 7-of-22 coverage", async () => {
    const source = await readFile(
      path.join(process.cwd(), "scripts/reconcile-aais-browser-rehearsal.mjs"),
      "utf8",
    );
    expect(source).not.toContain("failclosed-offline.png");
    expect(source).not.toContain("fourth-participant-ready.png");
    expect(source).not.toContain("7 of 22 event names");
    expect(source).toContain("coverage_fraction:");
  });

  it("keeps runtime-build and external-network provenance not_verified when absent", () => {
    expect(validateRuntimeBuildAttestationForRun(null, {
      applicationMode: "production-build",
      commitSha: "1234567890abcdef1234567890abcdef12345678",
    })).toMatchObject({ status: "not_verified", verified: false });
    expect(validateExternalLrsAttestationForRun(null, {
      startedTimes: ["2026-07-30T10:00:00.000Z"],
      receivedTimes: ["2026-07-30T10:00:01.000Z"],
    })).toMatchObject({
      status: "not_verified",
      verified: false,
      externalLrsContacted: null,
    });
  });

  it("keeps all ownership joins and payload binding in the fail-closed gate", async () => {
    const source = await readFile(
      path.join(process.cwd(), "scripts/reconcile-aais-browser-rehearsal.mjs"),
      "utf8",
    );
    for (const invariant of [
      "event_visit_mismatches",
      "visit_participant_mismatches",
      "identity_participant_mismatches",
      "ledger_visit_participant_mismatches",
      "outboxPayload.verified",
      "runtimeBuildGate.verified",
      "externalLrsContactGate.verified",
    ]) {
      expect(source).toContain(invariant);
    }
  });
});

function createEvent({ eventId, clientEventId, eventName, outcome, sequence }) {
  return {
    event_id: eventId,
    client_event_id: clientEventId,
    participant_id: "30000000-0000-4000-8000-000000000001",
    study_run_id: "40000000-0000-4000-8000-000000000001",
    visit_id: "50000000-0000-4000-8000-000000000001",
    event_sequence: sequence,
    event_name: eventName,
    outcome,
    retry_count: 0,
    disconnect_count: 0,
    ai_latency_ms: eventName === "ai_guide_submit" ? 125 : null,
    client_time: new Date(`2026-07-30T10:00:0${sequence}.000Z`),
    server_received_at: new Date(`2026-07-30T10:00:1${sequence}.000Z`),
    condition: "control",
    schema_version: 1,
    app_version: "0.1.0-test",
    commit_sha: "1234567890abcdef1234567890abcdef12345678",
    detail: { operation_id: `operation-${sequence}` },
    lrs_eligible: true,
  };
}

function acknowledgementFor(event) {
  return {
    client_event_id: event.client_event_id,
    visit_id: event.visit_id,
    ...(event.event_name === "account_logout" && event.outcome === "success"
      ? { route: "/api/auth/app-session", method: "DELETE", status: 200 }
      : { route: "/api/research/events", method: "POST", status: 201 }),
  };
}

function createTransport(acknowledgements) {
  const researchCount = acknowledgements.filter((item) =>
    item.route === "/api/research/events").length;
  const logoutCount = acknowledgements.length - researchCount;
  return {
    research_event_post_attempts: researchCount,
    research_event_post_201: researchCount,
    research_event_post_non_201: 0,
    logout_delete_attempts: logoutCount,
    logout_delete_200: logoutCount,
    transport_event_acknowledgements: acknowledgements.length,
    acknowledgements,
  };
}

function createOutboxRow(event) {
  return {
    event_id: event.event_id,
    statement_id: event.event_id,
    status: "pending",
    lrs_eligible: true,
    payload: {
      eventId: event.event_id,
      participantId: event.participant_id,
      studyRunId: event.study_run_id,
      visitId: event.visit_id,
      projectId: scope.projectId,
      studyId: scope.studyId,
      environment: scope.environment,
      lrsNamespace: scope.lrsNamespace,
      lrsStoreId: scope.lrsStoreId,
      condition: event.condition,
      schemaVersion: event.schema_version,
      appVersion: event.app_version,
      commitSha: event.commit_sha,
      eventSequence: event.event_sequence,
      clientTime: event.client_time.toISOString(),
      serverReceivedAt: event.server_received_at.toISOString(),
      eventName: event.event_name,
      outcome: event.outcome,
      retryCount: event.retry_count,
      disconnectCount: event.disconnect_count,
      aiLatencyMs: event.ai_latency_ms,
      detail: event.detail,
      lrsEligible: event.lrs_eligible,
    },
  };
}

function createManifestPair() {
  const participants = ["P1", "P2", "P3"].map((slot, participantIndex) => ({
    slot,
    physical_ui_triggers: 1,
    expected_events: (participantIndex === 0
      ? aaisBrowserResearchEventNames
      : ["workspace_session_load"]).map((eventName, eventIndex) => ({
        sequence: eventIndex + 1,
        event_name: eventName,
        outcome: "success",
      })),
  }));
  const expectedEventCount = participants.reduce(
    (total, participant) => total + participant.expected_events.length,
    0,
  );
  return {
    manifest: {
      evidence_schema_version: 2,
      declared_at: "2026-07-30T09:59:00Z",
      declared_before_run: true,
      project_id: "aais",
      study_id: scope.studyId,
      environment: scope.environment,
      lrs_namespace: scope.lrsNamespace,
      lrs_store_id: scope.lrsStoreId,
      participant_count: 3,
      counting_contract: {
        physical_ui_triggers: 3,
        expected_semantic_event_records: expectedEventCount,
        note: "The fixture predeclares complete contract coverage.",
      },
      participants,
    },
    observed: {
      evidence_schema_version: 1,
      observed_at: "2026-07-30T10:10:00Z",
      source: "Playwright localStorage after each authenticated research bootstrap",
      project_id: "aais",
      study_id: scope.studyId,
      environment: scope.environment,
      lrs_namespace: scope.lrsNamespace,
      participants: participants.map((participant, index) => ({
        slot: participant.slot,
        participant_id: `0000000${index + 1}-0000-4000-8000-000000000001`,
        study_run_id: `0000000${index + 1}-0000-4000-8000-000000000002`,
        visit_id: `0000000${index + 1}-0000-4000-8000-000000000003`,
        condition: index % 2 === 0 ? "control" : "treatment",
      })),
    },
  };
}
