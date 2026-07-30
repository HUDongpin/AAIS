import { readFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  aaisBrowserResearchEventNames,
  buildBrowserNetworkSummary,
  classifyBrowserNetworkUrl,
  createStrictBrowserManifest,
  normalizeRunOptions,
  validateBrowserCapture,
} from "../../scripts/capture-aais-browser-rehearsal.mjs";

const scope = {
  projectId: "aais",
  studyId: "browser-full-coverage-test",
  environment: "research",
  lrsStoreId: "aais-research-browser-clean-store",
  lrsNamespace:
    "https://www.aais.site/xapi/studies/browser-full-coverage-test/research/v1",
};

describe("AAIS 22-event actual-UI browser capture harness", () => {
  it("freezes a 3-participant, 33-trigger, 51-record manifest covering all 22 event names", () => {
    const manifest = createManifest();
    const expectedCoverage = new Set(
      manifest.participants.flatMap((participant) =>
        participant.expected_events.map((event) => event.event_name)),
    );

    expect(Object.isFrozen(manifest)).toBe(true);
    expect(Object.isFrozen(manifest.participants[0].expected_events)).toBe(true);
    expect(manifest).toMatchObject({
      declared_before_run: true,
      participant_count: 3,
      counting_contract: {
        physical_ui_triggers: 33,
        expected_semantic_event_records: 51,
      },
    });
    expect([...expectedCoverage].sort()).toEqual(
      [...aaisBrowserResearchEventNames].sort(),
    );
    expect(manifest.participants[0].expected_events).toHaveLength(41);
    expect(manifest.participants[1].expected_events).toHaveLength(5);
    expect(manifest.participants[2].expected_events).toHaveLength(5);
  });

  it("requires a localhost research origin, canonical AAIS namespace, and exactly three synthetic actors", () => {
    expect(() => normalizeRunOptions({
      baseUrl: "http://127.0.0.1:3219",
      outputDir: "output/playwright/unit",
      participantActors: ["SyntheticP1", "SyntheticP2", "SyntheticP3"],
      timeoutMs: "30000",
      ...scope,
    })).not.toThrow();

    expect(() => normalizeRunOptions({
      baseUrl: "https://www.aais.site",
      outputDir: "output/playwright/unit",
      participantActors: ["SyntheticP1", "SyntheticP2", "SyntheticP3"],
      ...scope,
    })).toThrow("localhost origin");
    expect(() => normalizeRunOptions({
      baseUrl: "http://127.0.0.1:3219",
      outputDir: "output/playwright/unit",
      participantActors: ["SyntheticP1", "SyntheticP2"],
      ...scope,
    })).toThrow("Exactly three");
    expect(() => normalizeRunOptions({
      baseUrl: "http://127.0.0.1:3219",
      outputDir: "output/playwright/unit",
      participantActors: ["RealStudent1", "SyntheticP2", "SyntheticP3"],
      ...scope,
    })).toThrow("Synthetic-prefixed");
  });

  it("accepts only exact manifest order, 51 strict acknowledgements, and 22/22 coverage", () => {
    const manifest = createManifest();
    const participantRuns = createParticipantRuns(manifest);
    const result = validateBrowserCapture({ manifest, participantRuns });

    expect(result).toMatchObject({
      acknowledgementCountMatch: true,
      exactManifestMatch: true,
    });
    expect(result.coveredEventNames).toHaveLength(22);
    expect(result.eventNameCounts.workspace_session_load).toBe(6);
    expect(result.eventNameCounts.account_logout).toBe(6);
    expect(result.outcomeCounts).toEqual({
      attempted: 14,
      disconnected: 1,
      failure: 2,
      retry: 1,
      success: 33,
    });

    const wrongOrder = structuredClone(participantRuns);
    [
      wrongOrder[0].capture.semanticEvents[12],
      wrongOrder[0].capture.semanticEvents[13],
    ] = [
      wrongOrder[0].capture.semanticEvents[13],
      wrongOrder[0].capture.semanticEvents[12],
    ];
    expect(() => validateBrowserCapture({
      manifest,
      participantRuns: wrongOrder,
    })).toThrow("event order");
  });

  it("fails closed when an acknowledgement has extra fields or coverage is incomplete", () => {
    const manifest = createManifest();
    const extraField = createParticipantRuns(manifest);
    extraField[0].capture.acknowledgements[0].request_body = "forbidden";
    expect(() => validateBrowserCapture({
      manifest,
      participantRuns: extraField,
    })).toThrow("non-sanitized acknowledgement");

    const missingCoverage = createParticipantRuns(manifest);
    const linkIndex = missingCoverage[0].capture.semanticEvents.findIndex(
      (event) => event.event_name === "guide_response_link_opened",
    );
    missingCoverage[0].capture.semanticEvents[linkIndex].event_name =
      "guide_quick_start_selected";
    expect(() => validateBrowserCapture({
      manifest,
      participantRuns: missingCoverage,
    })).toThrow("event order");
  });

  it("does not use Playwright request-body, header, trace, screenshot, or storage-state capture APIs", async () => {
    const source = await readFile(
      path.join(process.cwd(), "scripts/capture-aais-browser-rehearsal.mjs"),
      "utf8",
    );
    for (const forbiddenApi of [
      ".postData(",
      ".postDataJSON(",
      ".allHeaders(",
      ".headersArray(",
      ".storageState(",
      ".tracing.",
      ".screenshot(",
      "recordVideo",
    ]) {
      expect(source).not.toContain(forbiddenApi);
    }
    expect(source).toContain("acceptDownloads: false");
    expect(source).toContain('popup.waitForLoadState("domcontentloaded")');
    expect(source).toContain('serviceWorkers: "block"');
    expect(source).toContain('context.routeWebSocket("**/*"');
    expect(source).toContain("await route.fallback()");
    expect(source.indexOf('context.route("**/__aais-synthetic-reference"'))
      .toBeLessThan(source.lastIndexOf('context.route("**/*"'));
    expect(source).toContain("persisted_sensitive_fields: []");
  });

  it("classifies exact-origin browser traffic without retaining URLs", () => {
    const origin = "http://127.0.0.1:3219";
    expect(classifyBrowserNetworkUrl(`${origin}/learning?synthetic=1`, origin))
      .toMatchObject({ local: true, valid: true });
    expect(classifyBrowserNetworkUrl("ws://127.0.0.1:3219/socket", origin))
      .toMatchObject({ local: true, valid: true });
    expect(classifyBrowserNetworkUrl("http://localhost:3219/learning", origin))
      .toMatchObject({ local: false, valid: true });
    expect(classifyBrowserNetworkUrl("http://127.0.0.1:3220/learning", origin))
      .toMatchObject({ local: false, valid: true });
    expect(classifyBrowserNetworkUrl("https://127.0.0.1:3219/learning", origin))
      .toMatchObject({ local: false, valid: true });
    expect(classifyBrowserNetworkUrl(
      "http://user:password@127.0.0.1:3219/learning",
      origin,
    )).toMatchObject({ local: false, valid: false });
  });

  it("builds a three-context, lifecycle-complete, same-origin network audit", () => {
    const baseUrl = "http://127.0.0.1:3219";
    const participantRuns = createParticipantRuns(createManifest()).map((run, index) => ({
      ...run,
      browserNetworkAudit: createSafeNetworkAudit(`P${index + 1}`),
    }));
    const summary = buildBrowserNetworkSummary({
      baseUrl,
      generatedAt: "2026-07-30T15:00:10.000Z",
      manifestSha256: "a".repeat(64),
      participantRuns,
      ...scope,
    });

    expect(summary).toMatchObject({
      participant_context_count: 3,
      context_gate_pass_count: 3,
      total_request_count: 3,
      local_request_count: 3,
      non_local_request_count: 0,
      route_guard_request_count: 3,
      route_guard_coverage_match: true,
      websocket_count: 0,
      service_worker_count: 0,
      download_count: 0,
      browser_network_gate_passed: true,
      raw_request_urls_retained: false,
      request_headers_retained: false,
      request_bodies_retained: false,
    });
    expect(summary.request_records).toHaveLength(3);
    expect(JSON.stringify(summary)).not.toContain("/learning");

    participantRuns[0].browserNetworkAudit.nonLocalRequestCount = 1;
    participantRuns[0].browserNetworkAudit.networkGatePassed = false;
    expect(() => buildBrowserNetworkSummary({
      baseUrl,
      generatedAt: "2026-07-30T15:00:10.000Z",
      manifestSha256: "a".repeat(64),
      participantRuns,
      ...scope,
    })).toThrow(/failed closed \(P1: .*non_local=1/);

    const failedScript = createParticipantRuns(createManifest()).map((run, index) => ({
      ...run,
      browserNetworkAudit: createSafeNetworkAudit(`P${index + 1}`),
    }));
    failedScript[0].browserNetworkAudit.requestRecords[0].response_status = 404;
    failedScript[0].browserNetworkAudit.networkGatePassed = false;
    expect(() => buildBrowserNetworkSummary({
      baseUrl,
      generatedAt: "2026-07-30T15:00:10.000Z",
      manifestSha256: "a".repeat(64),
      participantRuns: failedScript,
      ...scope,
    })).toThrow(/non_success=.*response_status.*404/);

    const unexpectedDownload = createParticipantRuns(createManifest()).map((run, index) => ({
      ...run,
      browserNetworkAudit: createSafeNetworkAudit(`P${index + 1}`),
    }));
    unexpectedDownload[0].browserNetworkAudit.downloadCount = 1;
    unexpectedDownload[0].browserNetworkAudit.networkGatePassed = false;
    expect(() => buildBrowserNetworkSummary({
      baseUrl,
      generatedAt: "2026-07-30T15:00:10.000Z",
      manifestSha256: "a".repeat(64),
      participantRuns: unexpectedDownload,
      ...scope,
    })).toThrow(/download=1/);
  });
});

function createManifest() {
  return createStrictBrowserManifest({
    declaredAt: "2026-07-30T15:00:00.000Z",
    ...scope,
  });
}

function createParticipantRuns(manifest) {
  return manifest.participants.map((participant, participantIndex) => {
    const visitNumber = participantIndex + 1;
    const visit = {
      participantId: uuidFor(visitNumber, 1),
      studyRunId: uuidFor(visitNumber, 2),
      visitId: uuidFor(visitNumber, 3),
      condition: participantIndex % 2 === 0 ? "control" : "treatment",
    };
    const semanticEvents = participant.expected_events.map((event, eventIndex) => ({
      client_event_id: uuidFor(visitNumber, eventIndex + 10),
      visit_id: visit.visitId,
      event_sequence:
        event.event_name === "account_logout"
          && event.outcome === "success"
          ? null
          : event.sequence,
      event_name: event.event_name,
      outcome: event.outcome,
    }));
    return {
      slot: participant.slot,
      visit,
      capture: {
        acknowledgements: semanticEvents.map((event) => ({
          route:
            event.event_name === "account_logout" && event.outcome === "success"
              ? "/api/auth/app-session"
              : "/api/research/events",
          method:
            event.event_name === "account_logout" && event.outcome === "success"
              ? "DELETE"
              : "POST",
          status:
            event.event_name === "account_logout" && event.outcome === "success"
              ? 200
              : 201,
          client_event_id: event.client_event_id,
          visit_id: event.visit_id,
        })),
        semanticEvents,
        errors: [],
        researchEventPostAttempts: semanticEvents.length - 1,
        researchEventPost201: semanticEvents.length - 1,
        researchEventPostNon201: 0,
        logoutDeleteAttempts: 1,
        logoutDelete200: 1,
      },
    };
  });
}

function uuidFor(participantNumber, value) {
  return `${participantNumber.toString(16).padStart(8, "0")}-0000-4000-8000-${value
    .toString(16)
    .padStart(12, "0")}`;
}

function createSafeNetworkAudit(slot) {
  return {
    captureStartedAt: "2026-07-30T15:00:00.000Z",
    captureEndedAt: "2026-07-30T15:00:09.000Z",
    downloadCount: 0,
    inFlightRequestCount: 0,
    invalidMethodCount: 0,
    invalidRequestUrlCount: 0,
    invalidWebsocketUrlCount: 0,
    localRequestCount: 1,
    localWebsocketCount: 0,
    networkGatePassed: true,
    nonLocalRequestCount: 0,
    nonLocalWebsocketCount: 0,
    observerErrorCount: 0,
    requestCount: 1,
    requestFailedCount: 0,
    requestFinishedCount: 1,
    requestRecords: [{
      context_slot: slot,
      context_request_sequence: 1,
      method: "GET",
      resource_type: "document",
      destination_class: "same_origin",
      terminal_outcome: "finished",
      response_status: 200,
    }],
    routeGuardInvalidRequestCount: 0,
    routeGuardLocalRequestCount: 1,
    routeGuardNonLocalRequestCount: 0,
    routeGuardRequestCount: 1,
    resourceTypeCounts: { document: 1 },
    serviceWorkerCount: 0,
    websocketCount: 0,
  };
}
