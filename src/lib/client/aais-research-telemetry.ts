export const aaisResearchEventNames = [
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
] as const;

export type AaisResearchEventName = (typeof aaisResearchEventNames)[number];

export type AaisResearchEventOutcome =
  | "attempted"
  | "success"
  | "failure"
  | "retry"
  | "disconnected";

export type AaisResearchVisit = {
  participantId: string;
  studyRunId: string;
  visitId: string;
  condition: string;
  appVersion: string;
  commitSha: string;
};

export type AaisResearchTelemetryBoundaryState =
  | "initializing"
  | "ready"
  | "offline-or-temporary"
  | "terminal-blocked";

export type AaisResearchTelemetryStartOptions = {
  enabled?: boolean;
  required?: boolean;
  initialVisit?: AaisResearchVisit | null;
  onBoundaryStateChange?: (state: AaisResearchTelemetryBoundaryState) => void;
};

export type AaisResearchEventDetail = Record<
  AaisResearchDetailKey,
  boolean | number | string | undefined
>;

type AaisResearchDetailKey = (typeof allowedDetailKeys)[number];

type AaisResearchEventInput = {
  clientEventId?: string;
  eventName: AaisResearchEventName;
  outcome: AaisResearchEventOutcome;
  clientTime?: string;
  latencyMs?: number;
  detail?: Partial<AaisResearchEventDetail>;
  actorGeneration?: number;
};

type QueuedAaisResearchEvent = {
  visitId?: string;
  clientEventId: string;
  eventName: AaisResearchEventName;
  outcome: AaisResearchEventOutcome;
  clientTime: string;
  aiLatencyMs?: number;
  detail?: Partial<AaisResearchEventDetail>;
};

const visitStorageKey = "aais_research_visit_v1";
const eventQueueStorageKey = "aais_research_event_queue_v1";
const terminalBoundaryStorageKey = "aais_research_terminal_boundary_v1";
const actorBoundaryStorageKey = "aais_research_actor_boundary_v1";
const terminalBoundaryStorageValue = "blocked";
const terminalBoundaryCookieName = "aais_research_terminal_boundary";
const safeMetadataToken = /^[A-Za-z0-9][A-Za-z0-9._:/+\-]{0,127}$/;
const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const allowedOutcomes = new Set<AaisResearchEventOutcome>([
  "attempted",
  "success",
  "failure",
  "retry",
  "disconnected",
]);
const allowedEventNameSet = new Set<string>(aaisResearchEventNames);
const terminalResearchBoundaryCodes = new Set([
  "AAIS_RESEARCH_DISABLED",
  "AAIS_RESEARCH_NOT_CONFIGURED",
  "AAIS_RESEARCH_FORBIDDEN",
  "AAIS_RESEARCH_CAPACITY_REACHED",
  "AAIS_RESEARCH_VISIT_INACTIVE",
  "AAIS_RESEARCH_VISIT_NOT_FOUND",
  "AAIS_RESEARCH_VISIT_MISMATCH",
  "AAIS_AUTH_REQUIRED",
  "AAIS_CSRF_REQUIRED",
  "AAIS_RESEARCH_REQUEST_INVALID",
]);
const initialRetryDelayMs = 500;
const maximumRetryDelayMs = 8_000;
const researchRequestTimeoutMs = 10_000;
const allowedDetailKeys = [
  "operation_id",
  "task_id",
  "trigger",
  "tab_id",
  "content_id",
  "document_id",
  "format_id",
  "value_id",
  "quick_start_id",
  "input_mode",
  "prompt_length",
  "attachment_count",
  "file_count",
  "mime_type",
  "size_bytes",
  "total_size_bytes",
  "error_kind",
  "attempt_number",
  "retry_reason",
  "fallback",
  "agent_count",
  "title_length",
  "artifact_length",
  "previous_characters",
  "current_characters",
  "delta_characters",
  "width_px",
  "delta_px",
  "input_method",
  "download_method",
  "confirmed",
  "pending_save",
  "source",
  "http_status",
  "link_protocol",
  "link_host",
  "target_agent_count",
  "has_attachments",
] as const;
const allowedDetailKeySet = new Set<string>(allowedDetailKeys);

let visitRequest: Promise<AaisResearchVisit | null> | null = null;
let flushRequest: Promise<void> | null = null;
let memoryVisit: AaisResearchVisit | null = null;
let memoryQueue: QueuedAaisResearchEvent[] = [];
let actorGeneration = 0;
let validatedVisitId: string | null = null;
let telemetrySuspended = false;
let terminalBlocked = false;
let researchBoundaryRequired = false;
let boundaryState: AaisResearchTelemetryBoundaryState = "initializing";
let retryAttempt = 0;
let retryTimer: number | null = null;
const activeRequestControllers = new Set<AbortController>();
const boundaryListeners = new Set<
  (state: AaisResearchTelemetryBoundaryState) => void
>();

export function createAaisResearchOperationId(prefix = "operation") {
  const randomId = createUuid() ?? `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 14)}`;
  return `${prefix}-${randomId}`;
}

export type AaisResearchLogoutContext = {
  expectedVisitId: string;
  failureClientEventId: string;
  finalClientTime: string;
  operationId: string;
  successClientEventId: string;
};

export function createAaisResearchLogoutContext(
  operationId: string,
): AaisResearchLogoutContext | null {
  if (!researchBoundaryRequired) {
    return null;
  }
  const visit = readStoredVisit();
  const successClientEventId = createUuid();
  const failureClientEventId = createUuid();
  if (
    boundaryState !== "ready"
    || terminalBlocked
    || telemetrySuspended
    || !visit
    || validatedVisitId !== visit.visitId
    || !successClientEventId
    || !failureClientEventId
  ) {
    blockAaisResearchTelemetryForActor();
    return null;
  }
  return {
    expectedVisitId: visit.visitId,
    failureClientEventId,
    finalClientTime: new Date().toISOString(),
    operationId,
    successClientEventId,
  };
}

export function admitAaisResearchAction(input: AaisResearchEventInput) {
  if (!researchBoundaryRequired) {
    recordAaisResearchEvent(input);
    return true;
  }
  if (
    boundaryState !== "ready"
    || terminalBlocked
    || telemetrySuspended
    || !isClientOnline()
  ) {
    return false;
  }
  return recordAaisResearchEvent(input) !== null;
}

export function recordAaisResearchEvent(input: AaisResearchEventInput) {
  if (
    typeof window === "undefined"
    || telemetrySuspended
    || (input.actorGeneration !== undefined && input.actorGeneration !== actorGeneration)
  ) {
    return null;
  }
  const clientEventId = input.clientEventId ?? createUuid();
  if (!clientEventId) {
    return null;
  }
  const event = normalizeQueuedEvent({
    visitId: readStoredVisit()?.visitId,
    clientEventId,
    eventName: input.eventName,
    outcome: input.outcome,
    clientTime: normalizeClientTime(input.clientTime),
    ...(input.eventName === "ai_guide_submit" && input.latencyMs !== undefined
      ? { aiLatencyMs: normalizeLatency(input.latencyMs) }
      : {}),
    detail: sanitizeDetail(input.detail),
  });
  if (!event) {
    return null;
  }
  const requestGeneration = actorGeneration;
  const queue = readQueue();
  if (
    telemetrySuspended
    || terminalBlocked
    || requestGeneration !== actorGeneration
    || !writeQueue([...queue, event])
  ) {
    return null;
  }
  void flushAaisResearchTelemetry();
  return event.clientEventId;
}

export function startAaisResearchTelemetry(
  options: AaisResearchTelemetryStartOptions = {},
) {
  if (typeof window === "undefined") {
    return () => undefined;
  }
  researchBoundaryRequired = options.required === true;
  if (options.onBoundaryStateChange) {
    boundaryListeners.add(options.onBoundaryStateChange);
  }
  if (options.enabled === false) {
    terminalBlocked = false;
    clearTelemetryActorState({ preserveDurableEvidence: true });
    setBoundaryState("ready");
    return () => {
      if (options.onBoundaryStateChange) {
        boundaryListeners.delete(options.onBoundaryStateChange);
      }
    };
  }
  if (researchBoundaryRequired && hasPersistedTerminalBoundary()) {
    terminalBlocked = true;
    telemetrySuspended = true;
  }
  if (terminalBlocked) {
    setBoundaryState("terminal-blocked");
    return () => {
      if (options.onBoundaryStateChange) {
        boundaryListeners.delete(options.onBoundaryStateChange);
      }
    };
  }
  telemetrySuspended = false;
  setBoundaryState(researchBoundaryRequired ? "initializing" : "ready");

  const initialVisit = normalizeVisit(options.initialVisit);
  if (initialVisit) {
    acceptValidatedVisit(initialVisit);
  }

  const handleOnline = () => {
    if (telemetrySuspended) {
      return;
    }
    if (researchBoundaryRequired) {
      setBoundaryState("offline-or-temporary");
    }
    recordAaisResearchEvent({
      eventName: "client_connectivity",
      outcome: "success",
      detail: {
        operation_id: createAaisResearchOperationId("connectivity"),
        trigger: "browser_online",
      },
    });
    void flushAaisResearchTelemetry();
  };
  const handleOffline = () => {
    cancelRetryTimer();
    if (researchBoundaryRequired && !telemetrySuspended) {
      setBoundaryState("offline-or-temporary");
    }
    recordAaisResearchEvent({
      eventName: "client_connectivity",
      outcome: "disconnected",
      detail: {
        operation_id: createAaisResearchOperationId("connectivity"),
        trigger: "browser_offline",
      },
    });
  };
  const handleActorBoundaryChange = (event: StorageEvent) => {
    if (
      researchBoundaryRequired
      && event.key === actorBoundaryStorageKey
      && event.newValue !== event.oldValue
    ) {
      blockAaisResearchTelemetryForCrossTabActorChange();
    }
  };

  window.addEventListener("online", handleOnline);
  window.addEventListener("offline", handleOffline);
  window.addEventListener("storage", handleActorBoundaryChange);
  if (isClientOnline()) {
    void flushAaisResearchTelemetry();
  } else {
    handleOffline();
  }

  return () => {
    window.removeEventListener("online", handleOnline);
    window.removeEventListener("offline", handleOffline);
    window.removeEventListener("storage", handleActorBoundaryChange);
    if (options.onBoundaryStateChange) {
      boundaryListeners.delete(options.onBoundaryStateChange);
    }
    cancelRetryTimer();
  };
}

export function captureAaisResearchActorGeneration() {
  return actorGeneration;
}

export function getAaisResearchTelemetryPendingCount() {
  return typeof window === "undefined" ? memoryQueue.length : readQueue().length;
}

export async function initializeAaisResearchVisit() {
  if (telemetrySuspended) {
    return null;
  }
  const existing = readStoredVisit();
  if (existing && validatedVisitId === existing.visitId) {
    return existing;
  }
  if (typeof window === "undefined" || !isClientOnline()) {
    if (researchBoundaryRequired && !telemetrySuspended) {
      setBoundaryState("offline-or-temporary");
    }
    return null;
  }
  if (visitRequest) {
    return visitRequest;
  }
  const requestGeneration = actorGeneration;

  const request = (async () => {
    try {
      const response = await fetchResearchRequest("/api/research/visit", {
        method: "POST",
        credentials: "same-origin",
        headers: {
          "content-type": "application/json",
          ...getAaisCsrfHeader(),
        },
        body: "{}",
      });
      const body = (await response.json().catch(() => null)) as {
        visit?: unknown;
        error?: { code?: unknown };
      } | null;
      if (telemetrySuspended || requestGeneration !== actorGeneration) {
        return null;
      }
      if (!response.ok && isTerminalResearchBoundary(body, response.status)) {
        blockAaisResearchTelemetryForActor();
        return null;
      }
      const visit = response.ok ? normalizeVisit(body?.visit) : null;
      if (!visit || telemetrySuspended || requestGeneration !== actorGeneration) {
        if (
          response.ok
          && researchBoundaryRequired
          && !telemetrySuspended
          && requestGeneration === actorGeneration
        ) {
          blockAaisResearchTelemetryForActor();
        } else {
          markTemporaryFailure();
        }
        return null;
      }
      if (!acceptValidatedVisit(visit, existing)) {
        return null;
      }
      return visit;
    } catch {
      if (!telemetrySuspended && requestGeneration === actorGeneration) {
        markTemporaryFailure();
      }
      return null;
    }
  })();
  visitRequest = request;
  try {
    return await request;
  } finally {
    if (visitRequest === request) {
      visitRequest = null;
    }
  }
}

export async function flushAaisResearchTelemetry() {
  if (typeof window === "undefined" || telemetrySuspended) {
    return;
  }
  if (!isClientOnline()) {
    if (researchBoundaryRequired) {
      setBoundaryState("offline-or-temporary");
    }
    return;
  }
  if (flushRequest) {
    return flushRequest;
  }
  cancelRetryTimer();

  const requestGeneration = actorGeneration;
  const request = (async () => {
    const visit = await initializeAaisResearchVisit();
    if (!visit || telemetrySuspended || requestGeneration !== actorGeneration) {
      if (!telemetrySuspended && requestGeneration === actorGeneration) {
        markTemporaryFailure();
      }
      return;
    }
    if (!attachVisitToQueuedEvents(visit.visitId)) {
      return;
    }

    while (
      isClientOnline()
      && !telemetrySuspended
      && requestGeneration === actorGeneration
    ) {
      const event = readQueue()[0];
      if (!event) {
        markBoundaryReady();
        return;
      }
      if (!event.visitId || event.visitId !== visit.visitId) {
        markTemporaryFailure();
        return;
      }
      try {
        const response = await fetchResearchRequest("/api/research/events", {
          method: "POST",
          credentials: "same-origin",
          headers: {
            "content-type": "application/json",
            ...getAaisCsrfHeader(),
          },
          body: JSON.stringify(toServerEventInput(event)),
        });
        if (!response.ok) {
          const body = (await response.json().catch(() => null)) as {
            error?: { code?: unknown };
          } | null;
          if (
            !telemetrySuspended
            && requestGeneration === actorGeneration
            && isTerminalResearchBoundary(body, response.status)
          ) {
            blockAaisResearchTelemetryForActor();
          } else if (!telemetrySuspended && requestGeneration === actorGeneration) {
            markTemporaryFailure();
          }
          return;
        }
        if (researchBoundaryRequired) {
          const acknowledgement = (await response.json().catch(() => null)) as {
            event?: { clientEventId?: unknown; visitId?: unknown };
          } | null;
          if (
            acknowledgement?.event?.clientEventId !== event.clientEventId
            || acknowledgement.event.visitId !== visit.visitId
          ) {
            if (!telemetrySuspended && requestGeneration === actorGeneration) {
              blockAaisResearchTelemetryForActor();
            }
            return;
          }
        }
        if (telemetrySuspended || requestGeneration !== actorGeneration) {
          return;
        }
        if (!removeQueuedEvent(event.clientEventId)) {
          return;
        }
      } catch {
        if (!telemetrySuspended && requestGeneration === actorGeneration) {
          markTemporaryFailure();
        }
        return;
      }
    }
    if (!telemetrySuspended && requestGeneration === actorGeneration) {
      setBoundaryState("offline-or-temporary");
    }
  })();
  flushRequest = request;
  try {
    await request;
  } finally {
    if (flushRequest === request) {
      flushRequest = null;
      if (
        !telemetrySuspended
        && isClientOnline()
        && retryTimer === null
        && readQueue().length > 0
      ) {
        void Promise.resolve().then(() => flushAaisResearchTelemetry());
      }
    }
  }
}

export function clearAaisResearchTelemetryForActor() {
  terminalBlocked = false;
  clearTelemetryActorState({ preserveDurableEvidence: false });
  broadcastActorBoundaryChange();
  setBoundaryState(researchBoundaryRequired ? "initializing" : "ready");
}

function blockAaisResearchTelemetryForActor() {
  terminalBlocked = true;
  clearTelemetryActorState({ preserveDurableEvidence: true });
  persistTerminalBoundary();
  setBoundaryState("terminal-blocked");
}

function blockAaisResearchTelemetryForCrossTabActorChange() {
  terminalBlocked = true;
  clearTelemetryActorState({ preserveDurableEvidence: true });
  try {
    window.sessionStorage.setItem(
      terminalBoundaryStorageKey,
      terminalBoundaryStorageValue,
    );
  } catch {
    // The in-memory lock still blocks this tab until it is explicitly exited.
  }
  setBoundaryState("terminal-blocked");
}

function broadcastActorBoundaryChange() {
  try {
    const marker = createUuid()
      ?? `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 14)}`;
    window.localStorage.setItem(actorBoundaryStorageKey, marker);
  } catch {
    // Formal research already requires working durable localStorage. Event
    // requests are additionally bound to their expected visit server-side.
  }
}

function clearTelemetryActorState({
  preserveDurableEvidence,
}: {
  preserveDurableEvidence: boolean;
}) {
  actorGeneration += 1;
  telemetrySuspended = true;
  cancelRetryTimer();
  abortActiveRequests();
  retryAttempt = 0;
  visitRequest = null;
  flushRequest = null;
  validatedVisitId = null;
  if (preserveDurableEvidence) {
    return;
  }
  memoryVisit = null;
  memoryQueue = [];
  try {
    window.localStorage.removeItem(visitStorageKey);
    window.localStorage.removeItem(eventQueueStorageKey);
    window.localStorage.removeItem(terminalBoundaryStorageKey);
  } catch {
    // Memory state has already been cleared for storage-restricted clients.
  }
  try {
    window.sessionStorage.removeItem(terminalBoundaryStorageKey);
  } catch {
    // The actor-scoped in-memory lock has already been cleared explicitly.
  }
  try {
    document.cookie = `${terminalBoundaryCookieName}=; Max-Age=0; Path=/; SameSite=Lax`;
  } catch {
    // The actor-scoped in-memory state is still cleared explicitly.
  }
}

async function fetchResearchRequest(input: RequestInfo | URL, init: RequestInit) {
  const controller = new AbortController();
  activeRequestControllers.add(controller);
  const aborted = new Promise<never>((_resolve, reject) => {
    controller.signal.addEventListener("abort", () => {
      reject(createAbortError());
    }, { once: true });
  });
  const timeoutId = window.setTimeout(() => {
    controller.abort();
  }, researchRequestTimeoutMs);
  try {
    return await Promise.race([
      fetch(input, { ...init, signal: controller.signal }),
      aborted,
    ]);
  } finally {
    window.clearTimeout(timeoutId);
    activeRequestControllers.delete(controller);
  }
}

function createAbortError() {
  try {
    return new DOMException("AAIS research request timed out.", "AbortError");
  } catch {
    const error = new Error("AAIS research request timed out.");
    error.name = "AbortError";
    return error;
  }
}

function abortActiveRequests() {
  for (const controller of activeRequestControllers) {
    controller.abort();
  }
  activeRequestControllers.clear();
}

function persistTerminalBoundary() {
  try {
    window.localStorage.setItem(
      terminalBoundaryStorageKey,
      terminalBoundaryStorageValue,
    );
  } catch {
    // The session-scoped copy below still prevents a same-tab refresh bypass.
  }
  try {
    window.sessionStorage.setItem(
      terminalBoundaryStorageKey,
      terminalBoundaryStorageValue,
    );
  } catch {
    // The current runtime remains synchronously terminal-blocked.
  }
  try {
    document.cookie = `${terminalBoundaryCookieName}=blocked; Path=/; SameSite=Lax`;
  } catch {
    // Storage locks above and the runtime lock remain active.
  }
}

function hasPersistedTerminalBoundary() {
  try {
    const value = window.localStorage.getItem(terminalBoundaryStorageKey);
    if (value !== null) {
      return true;
    }
  } catch {
    return true;
  }
  try {
    if (window.sessionStorage.getItem(terminalBoundaryStorageKey) !== null) {
      return true;
    }
  } catch {
    return true;
  }
  try {
    return document.cookie.split(";").some(
      (cookie) => cookie.trim() === `${terminalBoundaryCookieName}=blocked`,
    );
  } catch {
    return true;
  }
}

function isTerminalResearchBoundary(value: unknown, status?: number) {
  const code = (value as { error?: { code?: unknown } } | null)?.error?.code;
  if (typeof code === "string" && terminalResearchBoundaryCodes.has(code)) {
    return true;
  }
  return typeof status === "number"
    && status >= 400
    && status < 500
    && status !== 408
    && status !== 425
    && status !== 429;
}

/** @deprecated Clear the whole actor-scoped telemetry state instead. */
export const clearAaisResearchVisit = clearAaisResearchTelemetryForActor;

export function classifyAaisResearchClientError(error: unknown) {
  if (typeof navigator !== "undefined" && navigator.onLine === false) {
    return "offline";
  }
  const candidate = error as { name?: unknown; message?: unknown };
  if (candidate?.name === "AbortError") {
    return "timeout";
  }
  if (candidate?.name === "AaisGuideStreamDisconnectedError") {
    return "stream_disconnected";
  }
  if (candidate?.name === "TypeError") {
    return "network";
  }
  return "request_failed";
}

export function isAaisResearchDisconnectError(error: unknown) {
  const kind = classifyAaisResearchClientError(error);
  return kind === "offline" || kind === "network" || kind === "stream_disconnected";
}

export function resetAaisResearchTelemetryForTests(options: {
  preserveStorage?: boolean;
} = {}) {
  actorGeneration += 1;
  telemetrySuspended = false;
  terminalBlocked = false;
  researchBoundaryRequired = false;
  boundaryState = "initializing";
  boundaryListeners.clear();
  cancelRetryTimer();
  abortActiveRequests();
  retryAttempt = 0;
  visitRequest = null;
  flushRequest = null;
  memoryVisit = null;
  memoryQueue = [];
  validatedVisitId = null;
  if (typeof window !== "undefined" && options.preserveStorage !== true) {
    try {
      window.localStorage.removeItem(visitStorageKey);
      window.localStorage.removeItem(eventQueueStorageKey);
      window.localStorage.removeItem(terminalBoundaryStorageKey);
      window.localStorage.removeItem(actorBoundaryStorageKey);
    } catch {
      // Test reset remains best effort in storage-restricted environments.
    }
    try {
      window.sessionStorage.removeItem(terminalBoundaryStorageKey);
    } catch {
      // Test reset remains best effort in storage-restricted environments.
    }
    try {
      document.cookie = `${terminalBoundaryCookieName}=; Max-Age=0; Path=/; SameSite=Lax`;
    } catch {
      // Test reset remains best effort in storage-restricted environments.
    }
  }
}

function acceptValidatedVisit(
  visit: AaisResearchVisit,
  existing = readStoredVisit(),
) {
  if (terminalBlocked) {
    return false;
  }
  if (existing && existing.visitId !== visit.visitId) {
    if (researchBoundaryRequired) {
      blockAaisResearchTelemetryForActor();
      return false;
    }
    if (!writeQueue([])) {
      return false;
    }
  }
  if (!writeStoredVisit(visit)) {
    return false;
  }
  validatedVisitId = visit.visitId;
  return attachVisitToQueuedEvents(visit.visitId);
}

function markBoundaryReady() {
  if (telemetrySuspended || !isClientOnline()) {
    return;
  }
  cancelRetryTimer();
  retryAttempt = 0;
  setBoundaryState("ready");
}

function markTemporaryFailure() {
  if (telemetrySuspended) {
    return;
  }
  setBoundaryState("offline-or-temporary");
  if (!isClientOnline() || retryTimer || typeof window === "undefined") {
    return;
  }
  const delay = Math.min(
    initialRetryDelayMs * (2 ** retryAttempt),
    maximumRetryDelayMs,
  );
  retryAttempt += 1;
  retryTimer = window.setTimeout(() => {
    retryTimer = null;
    void flushAaisResearchTelemetry();
  }, delay);
}

function cancelRetryTimer() {
  if (retryTimer !== null && typeof window !== "undefined") {
    window.clearTimeout(retryTimer);
  }
  retryTimer = null;
}

function setBoundaryState(nextState: AaisResearchTelemetryBoundaryState) {
  boundaryState = nextState;
  for (const listener of boundaryListeners) {
    listener(boundaryState);
  }
}

function attachVisitToQueuedEvents(visitId: string) {
  const queue = readQueue();
  if (telemetrySuspended || terminalBlocked) {
    return false;
  }
  if (
    researchBoundaryRequired
    && queue.some((event) => event.visitId && event.visitId !== visitId)
  ) {
    blockAaisResearchTelemetryForActor();
    return false;
  }
  return writeQueue(
    queue
      .filter((event) => !event.visitId || event.visitId === visitId)
      .map((event) => event.visitId ? event : { ...event, visitId }),
  );
}

function removeQueuedEvent(clientEventId: string) {
  const queue = readQueue();
  if (telemetrySuspended || terminalBlocked) {
    return false;
  }
  return writeQueue(queue.filter((event) => event.clientEventId !== clientEventId));
}

function readStoredVisit() {
  try {
    const raw = window.localStorage.getItem(visitStorageKey);
    if (raw === null) {
      return memoryVisit;
    }
    const parsed = JSON.parse(raw);
    const visit = normalizeVisit(parsed);
    if (visit) {
      memoryVisit = visit;
      return visit;
    }
  } catch {
    // Formal research mode handles this as a terminal durable-storage failure below.
  }
  if (researchBoundaryRequired) {
    blockAaisResearchTelemetryForActor();
    return null;
  }
  return memoryVisit;
}

function writeStoredVisit(visit: AaisResearchVisit) {
  try {
    const serialized = JSON.stringify(visit);
    window.localStorage.setItem(visitStorageKey, serialized);
    if (
      researchBoundaryRequired
      && window.localStorage.getItem(visitStorageKey) !== serialized
    ) {
      throw new Error("AAIS research visit storage did not round-trip.");
    }
    memoryVisit = visit;
    return true;
  } catch {
    if (researchBoundaryRequired) {
      blockAaisResearchTelemetryForActor();
      return false;
    }
    memoryVisit = visit;
    return true;
  }
}

function readQueue() {
  try {
    const raw = window.localStorage.getItem(eventQueueStorageKey);
    if (raw === null) {
      if (researchBoundaryRequired && memoryQueue.length) {
        blockAaisResearchTelemetryForActor();
        return [];
      }
      return memoryQueue;
    }
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) {
      if (researchBoundaryRequired) {
        blockAaisResearchTelemetryForActor();
        return [];
      }
      return memoryQueue;
    }
    const queue = parsed
      .map(normalizeQueuedEvent)
      .filter((event): event is QueuedAaisResearchEvent => Boolean(event));
    if (researchBoundaryRequired && queue.length !== parsed.length) {
      blockAaisResearchTelemetryForActor();
      return [];
    }
    memoryQueue = queue;
    return queue;
  } catch {
    if (researchBoundaryRequired) {
      blockAaisResearchTelemetryForActor();
      return [];
    }
    return memoryQueue;
  }
}

function writeQueue(queue: QueuedAaisResearchEvent[]) {
  try {
    if (queue.length) {
      const serialized = JSON.stringify(queue);
      window.localStorage.setItem(eventQueueStorageKey, serialized);
      if (
        researchBoundaryRequired
        && window.localStorage.getItem(eventQueueStorageKey) !== serialized
      ) {
        throw new Error("AAIS research event queue did not round-trip.");
      }
    } else {
      window.localStorage.removeItem(eventQueueStorageKey);
      if (
        researchBoundaryRequired
        && window.localStorage.getItem(eventQueueStorageKey) !== null
      ) {
        throw new Error("AAIS research event queue could not be cleared.");
      }
    }
    memoryQueue = queue;
    return true;
  } catch {
    if (researchBoundaryRequired) {
      blockAaisResearchTelemetryForActor();
      return false;
    }
    memoryQueue = queue;
    return true;
  }
}

function normalizeQueuedEvent(value: unknown): QueuedAaisResearchEvent | null {
  if (!value || typeof value !== "object") {
    return null;
  }
  const candidate = value as Record<string, unknown>;
  if (
    !isUuid(candidate.clientEventId)
    || !allowedEventNameSet.has(String(candidate.eventName))
    || !allowedOutcomes.has(candidate.outcome as AaisResearchEventOutcome)
    || !isIsoTime(candidate.clientTime)
  ) {
    return null;
  }
  const aiLatencyMs = candidate.aiLatencyMs === undefined
    ? undefined
    : normalizeLatency(candidate.aiLatencyMs);
  return {
    ...(isSafeMetadataToken(candidate.visitId) ? { visitId: candidate.visitId } : {}),
    clientEventId: candidate.clientEventId,
    eventName: candidate.eventName as AaisResearchEventName,
    outcome: candidate.outcome as AaisResearchEventOutcome,
    clientTime: candidate.clientTime as string,
    ...(candidate.eventName === "ai_guide_submit" && aiLatencyMs !== undefined
      ? { aiLatencyMs }
      : {}),
    ...(candidate.detail && typeof candidate.detail === "object"
      ? { detail: sanitizeDetail(candidate.detail as Partial<AaisResearchEventDetail>) }
      : {}),
  };
}

function toServerEventInput(event: QueuedAaisResearchEvent) {
  const { visitId, ...serverInput } = event;
  return {
    ...serverInput,
    expectedVisitId: visitId,
  };
}

function normalizeVisit(value: unknown): AaisResearchVisit | null {
  if (!value || typeof value !== "object") {
    return null;
  }
  const candidate = value as Record<string, unknown>;
  const keys = [
    "participantId",
    "studyRunId",
    "visitId",
    "condition",
    "appVersion",
    "commitSha",
  ] as const;
  if (!keys.every((key) => isSafeMetadataToken(candidate[key]))) {
    return null;
  }
  return {
    participantId: candidate.participantId as string,
    studyRunId: candidate.studyRunId as string,
    visitId: candidate.visitId as string,
    condition: candidate.condition as string,
    appVersion: candidate.appVersion as string,
    commitSha: candidate.commitSha as string,
  };
}

function sanitizeDetail(detail?: Partial<AaisResearchEventDetail>) {
  if (!detail) {
    return undefined;
  }
  const sanitized: Partial<AaisResearchEventDetail> = {};
  for (const [key, value] of Object.entries(detail)) {
    if (!allowedDetailKeySet.has(key) || value === undefined) {
      continue;
    }
    if (typeof value === "boolean") {
      sanitized[key as AaisResearchDetailKey] = value;
    } else if (typeof value === "number" && Number.isFinite(value)) {
      sanitized[key as AaisResearchDetailKey] = Math.round(value);
    } else if (typeof value === "string" && isSafeMetadataToken(value)) {
      sanitized[key as AaisResearchDetailKey] = value;
    }
  }
  return Object.keys(sanitized).length ? sanitized : undefined;
}

function normalizeClientTime(value?: string) {
  return value && isIsoTime(value) ? value : new Date().toISOString();
}

function normalizeLatency(value: unknown) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric) || numeric < 0) {
    return 0;
  }
  return Math.min(Math.round(numeric), 86_400_000);
}

function isIsoTime(value: unknown): value is string {
  return typeof value === "string"
    && Number.isFinite(Date.parse(value))
    && new Date(value).toISOString() === value;
}

function isSafeMetadataToken(value: unknown): value is string {
  return typeof value === "string" && safeMetadataToken.test(value);
}

function isClientOnline() {
  return typeof navigator === "undefined" || navigator.onLine !== false;
}

function createUuid() {
  if (typeof crypto === "undefined") {
    return null;
  }
  if (typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  if (typeof crypto.getRandomValues !== "function") {
    return null;
  }
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0"));
  return [
    hex.slice(0, 4).join(""),
    hex.slice(4, 6).join(""),
    hex.slice(6, 8).join(""),
    hex.slice(8, 10).join(""),
    hex.slice(10, 16).join(""),
  ].join("-");
}

function isUuid(value: unknown): value is string {
  return typeof value === "string" && uuidPattern.test(value);
}

function getAaisCsrfHeader(): Record<string, string> {
  const token = readClientCookie("aais_csrf");
  return token ? { "x-aais-csrf": token } : {};
}

function readClientCookie(name: string) {
  try {
    const cookie = document.cookie
      .split(";")
      .map((part) => part.trim())
      .find((part) => part.startsWith(`${name}=`));
    return cookie ? decodeURIComponent(cookie.slice(name.length + 1)) : null;
  } catch {
    return null;
  }
}
