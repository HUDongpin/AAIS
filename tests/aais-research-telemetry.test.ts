import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  admitAaisResearchAction,
  captureAaisResearchActorGeneration,
  clearAaisResearchTelemetryForActor,
  createAaisResearchLogoutContext,
  createAaisResearchOperationId,
  flushAaisResearchTelemetry,
  initializeAaisResearchVisit,
  recordAaisResearchEvent,
  resetAaisResearchTelemetryForTests,
  startAaisResearchTelemetry,
} from "@/lib/client/aais-research-telemetry";

const visitStorageKey = "aais_research_visit_v1";
const queueStorageKey = "aais_research_event_queue_v1";
const terminalStorageKey = "aais_research_terminal_boundary_v1";

beforeEach(() => {
  // Most tests exercise the low-level recorder directly. Production remains
  // opt-in and is covered explicitly by the disabled-boundary regression.
  resetAaisResearchTelemetryForTests({ collectionEnabled: true });
});

afterEach(() => {
  vi.useRealTimers();
  resetAaisResearchTelemetryForTests();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  Object.defineProperty(window.navigator, "onLine", {
    configurable: true,
    value: true,
  });
  document.cookie = "aais_csrf=; Max-Age=0; path=/";
});

describe("AAIS research telemetry client", () => {
  it("keeps non-research work enabled without calling disabled research APIs", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const boundaryStates: string[] = [];

    // Child passive effects run before the parent boundary effect. Reproduce
    // that mount ordering so disabled telemetry must remove the early event.
    resetAaisResearchTelemetryForTests();
    const mountRaceEvent = recordAaisResearchEvent({
      eventName: "workspace_session_load",
      outcome: "attempted",
      detail: {
        operation_id: createAaisResearchOperationId("session-load"),
        trigger: "page_mount",
      },
    });
    expect(mountRaceEvent).toBeNull();
    expect(window.localStorage.getItem(queueStorageKey)).toBeNull();
    window.localStorage.setItem(queueStorageKey, JSON.stringify([{
      clientEventId: "10000000-0000-4000-8000-000000000099",
      eventName: "workspace_session_load",
      outcome: "attempted",
      clientTime: "2026-08-01T10:00:00.000Z",
      detail: {
        operation_id: "session-load-stale",
        trigger: "page_mount",
      },
    }]));

    const stop = startAaisResearchTelemetry({
      enabled: false,
      required: false,
      onBoundaryStateChange: (state) => boundaryStates.push(state),
    });

    expect(admitAaisResearchAction({
      eventName: "content_tab_selected",
      outcome: "success",
      detail: { tab_id: "editor" },
    })).toBe(true);
    expect(recordAaisResearchEvent({
      eventName: "content_item_opened",
      outcome: "success",
      detail: { content_id: "theory" },
    })).toBeNull();
    await flushAaisResearchTelemetry();

    expect(boundaryStates.at(-1)).toBe("ready");
    expect(fetchMock).not.toHaveBeenCalled();
    expect(window.localStorage.getItem(visitStorageKey)).toBeNull();
    expect(window.localStorage.getItem(queueStorageKey)).toBeNull();
    expect(window.localStorage.getItem(terminalStorageKey)).toBeNull();
    stop();
  });

  it("queues only whitelisted metadata offline and retries the stable event online", async () => {
    Object.defineProperty(window.navigator, "onLine", {
      configurable: true,
      value: false,
    });
    document.cookie = "aais_csrf=csrf-research; path=/";
    let eventAttempts = 0;
    const fetchMock = vi.fn(async (input: RequestInfo | URL, _init?: RequestInit) => {
      void _init;
      if (String(input) === "/api/research/visit") {
        return Response.json({
          visit: {
            participantId: "participant-01",
            studyRunId: "study-run-01",
            visitId: "visit-01",
            condition: "condition-a",
            appVersion: "0.1.0",
            commitSha: "abc1234",
            projectId: "server-only-project",
            environment: "server-only-environment",
          },
        });
      }
      eventAttempts += 1;
      return eventAttempts === 1
        ? new Response(null, { status: 503 })
        : new Response(null, { status: 204 });
    });
    vi.stubGlobal("fetch", fetchMock);

    const clientEventId = recordAaisResearchEvent({
      eventName: "ai_guide_submit",
      outcome: "success",
      latencyMs: 321,
      detail: {
        operation_id: createAaisResearchOperationId("ai-guide"),
        prompt_length: 18,
        source: "原始学习文本",
        dynamic_file_name: "private-notes.pdf",
      } as never,
    });

    const offlineQueue = JSON.parse(window.localStorage.getItem(queueStorageKey) ?? "[]");
    expect(offlineQueue).toHaveLength(1);
    expect(clientEventId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
    );
    expect(offlineQueue[0]).toMatchObject({
      clientEventId,
      eventName: "ai_guide_submit",
      outcome: "success",
      aiLatencyMs: 321,
      detail: {
        prompt_length: 18,
      },
    });
    expect(JSON.stringify(offlineQueue)).not.toContain("原始学习文本");
    expect(JSON.stringify(offlineQueue)).not.toContain("private-notes.pdf");

    Object.defineProperty(window.navigator, "onLine", {
      configurable: true,
      value: true,
    });
    await flushAaisResearchTelemetry();

    const retainedQueue = JSON.parse(window.localStorage.getItem(queueStorageKey) ?? "[]");
    expect(retainedQueue[0].clientEventId).toBe(clientEventId);
    expect(eventAttempts).toBe(1);

    await flushAaisResearchTelemetry();

    expect(window.localStorage.getItem(queueStorageKey)).toBeNull();
    const visitRequest = fetchMock.mock.calls.find(([input]) => String(input) === "/api/research/visit");
    expect(visitRequest?.[1]).toMatchObject({
      method: "POST",
      credentials: "same-origin",
      headers: expect.objectContaining({
        "x-aais-csrf": "csrf-research",
      }),
    });
    const storedVisit = JSON.parse(window.localStorage.getItem(visitStorageKey) ?? "null");
    expect(storedVisit).toEqual({
      participantId: "participant-01",
      studyRunId: "study-run-01",
      visitId: "visit-01",
      condition: "condition-a",
      appVersion: "0.1.0",
      commitSha: "abc1234",
    });
    const sentEventCall = fetchMock.mock.calls.findLast(([input]) =>
      String(input) === "/api/research/events"
    );
    const sentBody = JSON.parse(String(sentEventCall?.[1]?.body));
    expect(sentBody).toMatchObject({
      clientEventId,
      expectedVisitId: "visit-01",
      eventName: "ai_guide_submit",
      outcome: "success",
      detail: {
        prompt_length: 18,
      },
    });
    expect(sentBody).not.toHaveProperty("visitId");
    expect(sentBody).not.toHaveProperty("latencyMs");
    expect(sentBody).not.toHaveProperty("projectId");
    expect(sentBody).not.toHaveProperty("studyId");
    expect(sentBody).not.toHaveProperty("environment");
    expect(sentBody).not.toHaveProperty("schemaVersion");
  });

  it("records browser disconnect and resends the queued event after online recovery", async () => {
    const boundaryStates: string[] = [];
    const visit = createVisitFixture("02");
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input) === "/api/research/visit") {
        return Response.json({ visit });
      }
      const event = JSON.parse(String(init?.body));
      return Response.json({
        event: {
          clientEventId: event.clientEventId,
          visitId: event.expectedVisitId,
        },
      }, { status: 201 });
    });
    vi.stubGlobal("fetch", fetchMock);
    const stop = startAaisResearchTelemetry({
      required: true,
      initialVisit: visit,
      onBoundaryStateChange: (state) => boundaryStates.push(state),
    });
    await flushAaisResearchTelemetry();
    expect(boundaryStates.at(-1)).toBe("ready");

    Object.defineProperty(window.navigator, "onLine", {
      configurable: true,
      value: false,
    });
    window.dispatchEvent(new Event("offline"));
    expect(boundaryStates.at(-1)).toBe("offline-or-temporary");
    const disconnectedQueue = JSON.parse(window.localStorage.getItem(queueStorageKey) ?? "[]");
    expect(disconnectedQueue).toEqual([
      expect.objectContaining({
        visitId: "visit-02",
        eventName: "client_connectivity",
        outcome: "disconnected",
      }),
    ]);

    Object.defineProperty(window.navigator, "onLine", {
      configurable: true,
      value: true,
    });
    window.dispatchEvent(new Event("online"));
    await vi.waitFor(() => {
      expect(window.localStorage.getItem(queueStorageKey)).toBeNull();
    });
    expect(boundaryStates.at(-1)).toBe("ready");
    const connectivityBodies = fetchMock.mock.calls
      .filter(([input]) => String(input) === "/api/research/events")
      .map(([, init]) => JSON.parse(String(init?.body)));
    expect(connectivityBodies.map((body) => body.outcome)).toEqual([
      "disconnected",
      "success",
    ]);
    stop();
  });

  it("creates stable final logout ids only for the currently validated visit", async () => {
    const visit = createVisitFixture("logout");
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({ visit })));
    const stop = startAaisResearchTelemetry({
      required: true,
      initialVisit: visit,
    });
    await flushAaisResearchTelemetry();

    const context = createAaisResearchLogoutContext("account-logout-operation");

    expect(context).toMatchObject({
      expectedVisitId: visit.visitId,
      operationId: "account-logout-operation",
      finalClientTime: expect.any(String),
      successClientEventId: expect.stringMatching(
        /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
      ),
      failureClientEventId: expect.stringMatching(
        /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
      ),
    });
    expect(context?.successClientEventId).not.toBe(context?.failureClientEventId);
    stop();
  });

  it("automatically retries a durable event after a temporary Postgres failure without a new UI action", async () => {
    vi.useFakeTimers();
    const boundaryStates: string[] = [];
    const visit = createVisitFixture("retry");
    let eventAttempts = 0;
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input) === "/api/research/visit") {
        return Response.json({ visit });
      }
      eventAttempts += 1;
      const event = JSON.parse(String(init?.body));
      return eventAttempts <= 2
        ? Response.json({
            error: { code: "AAIS_RESEARCH_OPERATION_FAILED" },
          }, { status: 503 })
          : Response.json({
            event: {
              clientEventId: event.clientEventId,
              visitId: event.expectedVisitId,
            },
          }, { status: 201 });
    });
    vi.stubGlobal("fetch", fetchMock);
    const stop = startAaisResearchTelemetry({
      required: true,
      initialVisit: visit,
      onBoundaryStateChange: (state) => boundaryStates.push(state),
    });
    await flushAaisResearchTelemetry();

    const clientEventId = recordAaisResearchEvent({
      eventName: "content_tab_selected",
      outcome: "success",
      detail: { tab_id: "editor" },
    });
    await flushAaisResearchTelemetry();

    expect(eventAttempts).toBe(1);
    expect(boundaryStates.at(-1)).toBe("offline-or-temporary");
    expect(JSON.parse(window.localStorage.getItem(queueStorageKey) ?? "[]")).toEqual([
      expect.objectContaining({ clientEventId }),
    ]);

    await vi.advanceTimersByTimeAsync(500);

    expect(eventAttempts).toBe(2);
    expect(boundaryStates.at(-1)).toBe("offline-or-temporary");
    expect(window.localStorage.getItem(queueStorageKey)).not.toBeNull();

    await vi.advanceTimersByTimeAsync(999);
    expect(eventAttempts).toBe(2);
    await vi.advanceTimersByTimeAsync(1);

    expect(eventAttempts).toBe(3);
    expect(window.localStorage.getItem(queueStorageKey)).toBeNull();
    expect(boundaryStates.at(-1)).toBe("ready");
    stop();
  });

  it("automatically retries visit initialization after a temporary Postgres failure", async () => {
    vi.useFakeTimers();
    const boundaryStates: string[] = [];
    const visit = createVisitFixture("pg");
    let visitAttempts = 0;
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      expect(String(input)).toBe("/api/research/visit");
      visitAttempts += 1;
      return visitAttempts === 1
        ? Response.json({
            error: { code: "AAIS_RESEARCH_OPERATION_FAILED" },
          }, { status: 500 })
        : Response.json({ visit });
    });
    vi.stubGlobal("fetch", fetchMock);
    const stop = startAaisResearchTelemetry({
      required: true,
      initialVisit: null,
      onBoundaryStateChange: (state) => boundaryStates.push(state),
    });
    await flushAaisResearchTelemetry();

    expect(visitAttempts).toBe(1);
    expect(boundaryStates.at(-1)).toBe("offline-or-temporary");

    await vi.advanceTimersByTimeAsync(500);

    expect(visitAttempts).toBe(2);
    expect(boundaryStates.at(-1)).toBe("ready");
    expect(JSON.parse(window.localStorage.getItem(visitStorageKey) ?? "null")).toEqual(visit);
    stop();
  });

  it("times out a hanging visit request and retries it automatically", async () => {
    vi.useFakeTimers();
    const boundaryStates: string[] = [];
    const visit = createVisitFixture("visit-timeout");
    let visitAttempts = 0;
    const fetchMock = vi.fn(async () => {
      visitAttempts += 1;
      return visitAttempts === 1
        ? new Promise<Response>(() => undefined)
        : Response.json({ visit });
    });
    vi.stubGlobal("fetch", fetchMock);
    const stop = startAaisResearchTelemetry({
      required: true,
      initialVisit: null,
      onBoundaryStateChange: (state) => boundaryStates.push(state),
    });

    await vi.advanceTimersByTimeAsync(10_000);
    expect(visitAttempts).toBe(1);
    expect(boundaryStates.at(-1)).toBe("offline-or-temporary");

    await vi.advanceTimersByTimeAsync(500);
    expect(visitAttempts).toBe(2);
    expect(boundaryStates.at(-1)).toBe("ready");
    stop();
  });

  it("times out a hanging event POST, retains it, and retries without another action", async () => {
    vi.useFakeTimers();
    const boundaryStates: string[] = [];
    const visit = createVisitFixture("event-timeout");
    let eventAttempts = 0;
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input) === "/api/research/visit") {
        return Response.json({ visit });
      }
      eventAttempts += 1;
      if (eventAttempts === 1) {
        return new Promise<Response>(() => undefined);
      }
      const event = JSON.parse(String(init?.body));
      return Response.json({
        event: {
          clientEventId: event.clientEventId,
          visitId: event.expectedVisitId,
        },
      }, { status: 201 });
    });
    vi.stubGlobal("fetch", fetchMock);
    const stop = startAaisResearchTelemetry({
      required: true,
      initialVisit: visit,
      onBoundaryStateChange: (state) => boundaryStates.push(state),
    });
    await flushAaisResearchTelemetry();
    const eventId = admitAaisResearchAction({
      eventName: "content_tab_selected",
      outcome: "success",
      detail: { tab_id: "editor" },
    });
    expect(eventId).toBe(true);

    await vi.advanceTimersByTimeAsync(10_000);
    expect(eventAttempts).toBe(1);
    expect(boundaryStates.at(-1)).toBe("offline-or-temporary");
    expect(window.localStorage.getItem(queueStorageKey)).not.toBeNull();

    await vi.advanceTimersByTimeAsync(500);
    expect(eventAttempts).toBe(2);
    expect(window.localStorage.getItem(queueStorageKey)).toBeNull();
    expect(boundaryStates.at(-1)).toBe("ready");
    stop();
  });

  it("immediately blocks after a terminal event authentication response", async () => {
    const boundaryStates: string[] = [];
    const visit = createVisitFixture("event-auth");
    let eventAttempts = 0;
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      if (String(input) === "/api/research/visit") {
        return Response.json({ visit });
      }
      eventAttempts += 1;
      return Response.json({
        error: { code: "AAIS_AUTH_REQUIRED" },
      }, { status: 401 });
    });
    vi.stubGlobal("fetch", fetchMock);
    const stop = startAaisResearchTelemetry({
      required: true,
      initialVisit: visit,
      onBoundaryStateChange: (state) => boundaryStates.push(state),
    });
    await flushAaisResearchTelemetry();

    recordAaisResearchEvent({
      eventName: "content_item_opened",
      outcome: "success",
      detail: { content_id: "theory" },
    });
    await flushAaisResearchTelemetry();

    expect(eventAttempts).toBe(1);
    expect(boundaryStates.at(-1)).toBe("terminal-blocked");
    expect(JSON.parse(window.localStorage.getItem(queueStorageKey) ?? "[]")).toHaveLength(1);
    expect(window.localStorage.getItem(terminalStorageKey)).toBe("blocked");
    stop();
  });

  it("terminally blocks an event queue that has reached the governed research limit", async () => {
    const boundaryStates: string[] = [];
    const visit = createVisitFixture("event-limit");
    let eventAttempts = 0;
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      if (String(input) === "/api/research/visit") {
        return Response.json({ visit });
      }
      eventAttempts += 1;
      return Response.json({
        error: { code: "AAIS_RESEARCH_EVENT_LIMIT_REACHED" },
      }, { status: 429 });
    });
    vi.stubGlobal("fetch", fetchMock);
    const stop = startAaisResearchTelemetry({
      required: true,
      initialVisit: visit,
      onBoundaryStateChange: (state) => boundaryStates.push(state),
    });
    await flushAaisResearchTelemetry();

    recordAaisResearchEvent({
      eventName: "content_item_opened",
      outcome: "success",
      detail: { content_id: "theory" },
    });
    await flushAaisResearchTelemetry();

    expect(eventAttempts).toBe(1);
    expect(boundaryStates.at(-1)).toBe("terminal-blocked");
    expect(JSON.parse(window.localStorage.getItem(queueStorageKey) ?? "[]")).toHaveLength(1);
    expect(window.localStorage.getItem(terminalStorageKey)).toBe("blocked");
    stop();
  });

  it("keeps an ordinary 429 event response temporary and retryable", async () => {
    const boundaryStates: string[] = [];
    const visit = createVisitFixture("generic-rate-limit");
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      if (String(input) === "/api/research/visit") {
        return Response.json({ visit });
      }
      return Response.json({
        error: { code: "AAIS_RATE_LIMITED" },
      }, { status: 429 });
    });
    vi.stubGlobal("fetch", fetchMock);
    const stop = startAaisResearchTelemetry({
      required: true,
      initialVisit: visit,
      onBoundaryStateChange: (state) => boundaryStates.push(state),
    });
    await flushAaisResearchTelemetry();

    recordAaisResearchEvent({
      eventName: "content_item_opened",
      outcome: "success",
      detail: { content_id: "theory" },
    });
    await flushAaisResearchTelemetry();

    expect(boundaryStates.at(-1)).toBe("offline-or-temporary");
    expect(JSON.parse(window.localStorage.getItem(queueStorageKey) ?? "[]")).toHaveLength(1);
    expect(window.localStorage.getItem(terminalStorageKey)).toBeNull();
    stop();
  });

  it("terminally blocks instead of accepting a mismatched Postgres acknowledgement", async () => {
    const boundaryStates: string[] = [];
    const visit = createVisitFixture("bad-ack");
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      if (String(input) === "/api/research/visit") {
        return Response.json({ visit });
      }
      return Response.json({
        event: {
          clientEventId: "different-client-event-id",
          visitId: visit.visitId,
        },
      }, { status: 201 });
    });
    vi.stubGlobal("fetch", fetchMock);
    const stop = startAaisResearchTelemetry({
      required: true,
      initialVisit: visit,
      onBoundaryStateChange: (state) => boundaryStates.push(state),
    });
    await flushAaisResearchTelemetry();

    recordAaisResearchEvent({
      eventName: "content_tab_selected",
      outcome: "success",
      detail: { tab_id: "editor" },
    });
    await flushAaisResearchTelemetry();

    expect(boundaryStates.at(-1)).toBe("terminal-blocked");
    const retainedQueue = window.localStorage.getItem(queueStorageKey);
    expect(JSON.parse(retainedQueue ?? "[]")).toHaveLength(1);
    expect(window.localStorage.getItem(terminalStorageKey)).toBe("blocked");
    stop();

    resetAaisResearchTelemetryForTests({ preserveStorage: true });
    const requestCount = fetchMock.mock.calls.length;
    const remountStates: string[] = [];
    const stopRemount = startAaisResearchTelemetry({
      required: true,
      initialVisit: visit,
      onBoundaryStateChange: (state) => remountStates.push(state),
    });
    await flushAaisResearchTelemetry();
    expect(remountStates.at(-1)).toBe("terminal-blocked");
    expect(fetchMock).toHaveBeenCalledTimes(requestCount);
    expect(window.localStorage.getItem(queueStorageKey)).toBe(retainedQueue);
    stopRemount();
  });

  it("terminally blocks when an acknowledgement belongs to another visit", async () => {
    const boundaryStates: string[] = [];
    const visit = createVisitFixture("ack-visit");
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input) === "/api/research/visit") {
        return Response.json({ visit });
      }
      const event = JSON.parse(String(init?.body));
      return Response.json({
        event: {
          clientEventId: event.clientEventId,
          visitId: "visit-another-actor",
        },
      }, { status: 201 });
    });
    vi.stubGlobal("fetch", fetchMock);
    const stop = startAaisResearchTelemetry({
      required: true,
      initialVisit: visit,
      onBoundaryStateChange: (state) => boundaryStates.push(state),
    });
    await flushAaisResearchTelemetry();

    const eventId = recordAaisResearchEvent({
      eventName: "content_item_opened",
      outcome: "success",
      detail: { content_id: "theory" },
    });
    await flushAaisResearchTelemetry();

    expect(boundaryStates.at(-1)).toBe("terminal-blocked");
    expect(JSON.parse(window.localStorage.getItem(queueStorageKey) ?? "[]")).toEqual([
      expect.objectContaining({ clientEventId: eventId, visitId: visit.visitId }),
    ]);
    stop();
  });

  it("invalidates an old research tab when another tab changes the actor boundary", async () => {
    const boundaryStates: string[] = [];
    const visit = createVisitFixture("cross-tab");
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({ visit })));
    const stop = startAaisResearchTelemetry({
      required: true,
      initialVisit: visit,
      onBoundaryStateChange: (state) => boundaryStates.push(state),
    });
    await flushAaisResearchTelemetry();
    expect(boundaryStates.at(-1)).toBe("ready");

    window.dispatchEvent(new StorageEvent("storage", {
      key: "aais_research_actor_boundary_v1",
      oldValue: "actor-boundary-old",
      newValue: "actor-boundary-new",
    }));

    expect(boundaryStates.at(-1)).toBe("terminal-blocked");
    expect(window.sessionStorage.getItem(terminalStorageKey)).toBe("blocked");
    expect(window.localStorage.getItem(terminalStorageKey)).toBeNull();
    expect(admitAaisResearchAction({
      eventName: "content_tab_selected",
      outcome: "success",
    })).toBe(false);
    stop();
  });

  it.each([
    ["AAIS_RESEARCH_NOT_CONFIGURED", 503],
    ["AAIS_RESEARCH_FORBIDDEN", 403],
    ["AAIS_AUTH_REQUIRED", 401],
    ["AAIS_RESEARCH_VISIT_INACTIVE", 409],
  ])("terminal visit response %s blocks collection across a component remount", async (code, status) => {
    const boundaryStates: string[] = [];
    const fetchMock = vi.fn(async () => Response.json({
      error: { code },
    }, { status }));
    vi.stubGlobal("fetch", fetchMock);
    const options = {
      required: true,
      initialVisit: null,
      onBoundaryStateChange: (state: string) => boundaryStates.push(state),
    } as const;
    const stop = startAaisResearchTelemetry(options);
    await flushAaisResearchTelemetry();

    expect(boundaryStates.at(-1)).toBe("terminal-blocked");
    expect(recordAaisResearchEvent({
      eventName: "content_item_opened",
      outcome: "success",
    })).toBeNull();
    const requestCount = fetchMock.mock.calls.length;
    stop();

    const stopRemount = startAaisResearchTelemetry(options);
    await flushAaisResearchTelemetry();
    expect(boundaryStates.at(-1)).toBe("terminal-blocked");
    expect(fetchMock).toHaveBeenCalledTimes(requestCount);
    stopRemount();
  });

  it("terminally blocks formal research when the durable local queue cannot be written", async () => {
    const boundaryStates: string[] = [];
    const visit = createVisitFixture("storage");
    const fetchMock = vi.fn(async () => Response.json({ visit }));
    vi.stubGlobal("fetch", fetchMock);
    const stop = startAaisResearchTelemetry({
      required: true,
      initialVisit: visit,
      onBoundaryStateChange: (state) => boundaryStates.push(state),
    });
    await flushAaisResearchTelemetry();
    const setItem = vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new DOMException("quota exceeded", "QuotaExceededError");
    });

    const admitted = admitAaisResearchAction({
      eventName: "content_item_opened",
      outcome: "success",
      detail: { content_id: "theory" },
    });

    expect(admitted).toBe(false);
    expect(boundaryStates.at(-1)).toBe("terminal-blocked");
    expect(window.localStorage.getItem(queueStorageKey)).toBeNull();
    setItem.mockRestore();
    stop();
  });

  it("keeps a corrupt queue as evidence and cannot enqueue after terminal blocking", async () => {
    const boundaryStates: string[] = [];
    const visit = createVisitFixture("corrupt");
    window.localStorage.setItem(queueStorageKey, "{corrupt-event-queue");
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({ visit })));

    const stop = startAaisResearchTelemetry({
      required: true,
      initialVisit: visit,
      onBoundaryStateChange: (state) => boundaryStates.push(state),
    });
    const eventId = recordAaisResearchEvent({
      eventName: "content_item_opened",
      outcome: "success",
      detail: { content_id: "theory" },
    });

    expect(eventId).toBeNull();
    expect(boundaryStates.at(-1)).toBe("terminal-blocked");
    expect(window.localStorage.getItem(queueStorageKey)).toBe("{corrupt-event-queue");
    expect(window.localStorage.getItem(terminalStorageKey)).toBe("blocked");
    stop();
  });

  it("clears the old actor visit and queue before a new actor initializes", async () => {
    let actor = "old";
    let acceptEvents = false;
    const sentEvents: Array<Record<string, unknown>> = [];
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input) === "/api/research/visit") {
        return Response.json({
          visit: {
            participantId: `participant-${actor}`,
            studyRunId: `study-run-${actor}`,
            visitId: `visit-${actor}`,
            condition: "condition-a",
            appVersion: "0.1.0",
            commitSha: "abc1234",
          },
        });
      }
      sentEvents.push(JSON.parse(String(init?.body)));
      return new Response(null, { status: acceptEvents ? 204 : 503 });
    });
    vi.stubGlobal("fetch", fetchMock);

    await initializeAaisResearchVisit();
    const oldEventId = recordAaisResearchEvent({
      eventName: "account_menu_toggled",
      outcome: "success",
      detail: { value_id: "open" },
    });
    await flushAaisResearchTelemetry();
    expect(JSON.parse(window.localStorage.getItem(queueStorageKey) ?? "[]")[0]).toMatchObject({
      clientEventId: oldEventId,
      visitId: "visit-old",
    });

    clearAaisResearchTelemetryForActor();
    expect(window.localStorage.getItem(visitStorageKey)).toBeNull();
    expect(window.localStorage.getItem(queueStorageKey)).toBeNull();

    actor = "new";
    acceptEvents = true;
    const stop = startAaisResearchTelemetry();
    await initializeAaisResearchVisit();
    const newEventId = recordAaisResearchEvent({
      eventName: "account_menu_toggled",
      outcome: "success",
      detail: { value_id: "closed" },
    });
    await flushAaisResearchTelemetry();

    await vi.waitFor(() => {
      expect(sentEvents).toContainEqual(expect.objectContaining({
        clientEventId: newEventId,
      }));
    });
    expect(sentEvents.every((event) => !("visitId" in event))).toBe(true);
    expect(newEventId).not.toBe(oldEventId);
    await vi.waitFor(() => {
      expect(window.localStorage.getItem(queueStorageKey)).toBeNull();
    });
    stop();
  });

  it("validates a cached visit with the server and drops a stale actor queue", async () => {
    window.localStorage.setItem(visitStorageKey, JSON.stringify({
      participantId: "participant-old",
      studyRunId: "study-run-old",
      visitId: "visit-old",
      condition: "condition-a",
      appVersion: "0.1.0",
      commitSha: "abc1234",
    }));
    Object.defineProperty(window.navigator, "onLine", {
      configurable: true,
      value: false,
    });
    const oldEventId = recordAaisResearchEvent({
      eventName: "account_menu_toggled",
      outcome: "success",
      detail: { value_id: "open" },
    });
    expect(oldEventId).toBeTruthy();

    const sentEvents: Array<Record<string, unknown>> = [];
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input) === "/api/research/visit") {
        return Response.json({
          visit: {
            participantId: "participant-new",
            studyRunId: "study-run-new",
            visitId: "visit-new",
            condition: "condition-b",
            appVersion: "0.1.0",
            commitSha: "def5678",
          },
        });
      }
      sentEvents.push(JSON.parse(String(init?.body)));
      return new Response(null, { status: 204 });
    });
    vi.stubGlobal("fetch", fetchMock);
    Object.defineProperty(window.navigator, "onLine", {
      configurable: true,
      value: true,
    });

    await initializeAaisResearchVisit();
    await flushAaisResearchTelemetry();
    expect(sentEvents).toEqual([]);
    expect(window.localStorage.getItem(queueStorageKey)).toBeNull();

    const newEventId = recordAaisResearchEvent({
      eventName: "account_menu_toggled",
      outcome: "success",
      detail: { value_id: "closed" },
    });
    await flushAaisResearchTelemetry();
    expect(sentEvents).toEqual([
      expect.objectContaining({ clientEventId: newEventId }),
    ]);
  });

  it("terminally quarantines a formal queue when the validated visit changes", () => {
    const oldVisit = createVisitFixture("old-formal");
    const newVisit = createVisitFixture("new-formal");
    window.localStorage.setItem(visitStorageKey, JSON.stringify(oldVisit));
    Object.defineProperty(window.navigator, "onLine", {
      configurable: true,
      value: false,
    });
    const oldEventId = recordAaisResearchEvent({
      eventName: "account_menu_toggled",
      outcome: "success",
      detail: { value_id: "open" },
    });
    const originalQueue = window.localStorage.getItem(queueStorageKey);
    const boundaryStates: string[] = [];

    const stop = startAaisResearchTelemetry({
      required: true,
      initialVisit: newVisit,
      onBoundaryStateChange: (state) => boundaryStates.push(state),
    });

    expect(boundaryStates.at(-1)).toBe("terminal-blocked");
    expect(window.localStorage.getItem(visitStorageKey)).toBe(JSON.stringify(oldVisit));
    expect(window.localStorage.getItem(queueStorageKey)).toBe(originalQueue);
    expect(JSON.parse(originalQueue ?? "[]")[0]).toMatchObject({
      clientEventId: oldEventId,
      visitId: oldVisit.visitId,
    });
    stop();
  });

  it("creates a UUID v4 client event id without crypto.randomUUID", () => {
    Object.defineProperty(window.navigator, "onLine", {
      configurable: true,
      value: false,
    });
    vi.stubGlobal("crypto", {
      getRandomValues: (bytes: Uint8Array) => {
        bytes.fill(0x11);
        return bytes;
      },
    });

    const clientEventId = recordAaisResearchEvent({
      eventName: "content_tab_selected",
      outcome: "success",
    });

    expect(clientEventId).toBe("11111111-1111-4111-9111-111111111111");
  });

  it("rejects a late async event captured under a cleared actor generation", () => {
    const staleGeneration = captureAaisResearchActorGeneration();
    clearAaisResearchTelemetryForActor();
    const stop = startAaisResearchTelemetry();

    const eventId = recordAaisResearchEvent({
      actorGeneration: staleGeneration,
      eventName: "ai_guide_submit",
      outcome: "success",
      latencyMs: 100,
    });

    expect(eventId).toBeNull();
    expect(window.localStorage.getItem(queueStorageKey)).toBeNull();
    stop();
  });

  it("does not let a stale visit terminal response clear the current actor", async () => {
    const staleVisitResponse = createDeferred<Response>();
    let visitCalls = 0;
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      if (String(input) !== "/api/research/visit") {
        return new Response(null, { status: 204 });
      }
      visitCalls += 1;
      if (visitCalls === 1) {
        return staleVisitResponse.promise;
      }
      return Response.json({
        visit: {
          participantId: "participant-current",
          studyRunId: "study-run-current",
          visitId: "visit-current",
          condition: "condition-b",
          appVersion: "0.1.0",
          commitSha: "def5678",
        },
      });
    });
    vi.stubGlobal("fetch", fetchMock);

    const staleInitialization = initializeAaisResearchVisit();
    await vi.waitFor(() => expect(visitCalls).toBe(1));

    clearAaisResearchTelemetryForActor();
    const stop = startAaisResearchTelemetry();
    await initializeAaisResearchVisit();
    Object.defineProperty(window.navigator, "onLine", {
      configurable: true,
      value: false,
    });
    const currentEventId = recordAaisResearchEvent({
      eventName: "account_menu_toggled",
      outcome: "success",
      detail: { value_id: "open" },
    });

    staleVisitResponse.resolve(Response.json({
      error: { code: "AAIS_RESEARCH_DISABLED" },
    }, { status: 503 }));
    await staleInitialization;

    expect(JSON.parse(window.localStorage.getItem(queueStorageKey) ?? "[]")).toEqual([
      expect.objectContaining({
        clientEventId: currentEventId,
        visitId: "visit-current",
      }),
    ]);
    expect(recordAaisResearchEvent({
      eventName: "content_tab_selected",
      outcome: "success",
    })).toBeTruthy();
    stop();
  });

  it("does not let a stale event terminal response clear the current actor", async () => {
    const staleEventResponse = createDeferred<Response>();
    let actor = "stale";
    let eventCalls = 0;
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      if (String(input) === "/api/research/visit") {
        return Response.json({
          visit: {
            participantId: `participant-${actor}`,
            studyRunId: `study-run-${actor}`,
            visitId: `visit-${actor}`,
            condition: "condition-a",
            appVersion: "0.1.0",
            commitSha: "abc1234",
          },
        });
      }
      eventCalls += 1;
      return staleEventResponse.promise;
    });
    vi.stubGlobal("fetch", fetchMock);

    await initializeAaisResearchVisit();
    recordAaisResearchEvent({
      eventName: "account_menu_toggled",
      outcome: "success",
      detail: { value_id: "open" },
    });
    const staleFlush = flushAaisResearchTelemetry();
    await vi.waitFor(() => expect(eventCalls).toBe(1));

    clearAaisResearchTelemetryForActor();
    actor = "current";
    const stop = startAaisResearchTelemetry();
    await initializeAaisResearchVisit();
    await flushAaisResearchTelemetry();
    Object.defineProperty(window.navigator, "onLine", {
      configurable: true,
      value: false,
    });
    const currentEventId = recordAaisResearchEvent({
      eventName: "account_menu_toggled",
      outcome: "success",
      detail: { value_id: "closed" },
    });

    staleEventResponse.resolve(Response.json({
      error: { code: "AAIS_AUTH_REQUIRED" },
    }, { status: 401 }));
    await staleFlush;

    expect(JSON.parse(window.localStorage.getItem(queueStorageKey) ?? "[]")).toEqual([
      expect.objectContaining({
        clientEventId: currentEventId,
        visitId: "visit-current",
      }),
    ]);
    expect(recordAaisResearchEvent({
      eventName: "content_tab_selected",
      outcome: "success",
    })).toBeTruthy();
    stop();
  });

  it("preserves local events and suspends collection when the server disables research", async () => {
    const fetchMock = vi.fn(async () => Response.json({
      error: { code: "AAIS_RESEARCH_DISABLED" },
    }, { status: 503 }));
    vi.stubGlobal("fetch", fetchMock);

    const queuedId = recordAaisResearchEvent({
      eventName: "workspace_session_load",
      outcome: "success",
    });
    expect(queuedId).toBeTruthy();
    await flushAaisResearchTelemetry();

    expect(JSON.parse(window.localStorage.getItem(queueStorageKey) ?? "[]")).toEqual([
      expect.objectContaining({ clientEventId: queuedId }),
    ]);
    expect(window.localStorage.getItem(visitStorageKey)).toBeNull();
    expect(window.localStorage.getItem(terminalStorageKey)).toBe("blocked");
    expect(recordAaisResearchEvent({
      eventName: "account_menu_toggled",
      outcome: "success",
    })).toBeNull();
  });
});

function createVisitFixture(suffix: string) {
  return {
    participantId: `participant-${suffix}`,
    studyRunId: `study-run-${suffix}`,
    visitId: `visit-${suffix}`,
    condition: "condition-a",
    appVersion: "0.1.0",
    commitSha: "abc1234",
  };
}

function createDeferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((nextResolve, nextReject) => {
    resolve = nextResolve;
    reject = nextReject;
  });
  return { promise, reject, resolve };
}
