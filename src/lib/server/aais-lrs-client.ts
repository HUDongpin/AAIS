import { createHash } from "node:crypto";
import {
  aaisAgents,
  aaisEventDefinitions,
  type AaisEvent,
} from "@/data/aais";

type AaisXapiVerb =
  | "initialized"
  | "generated"
  | "requested"
  | "attempted"
  | "completed"
  | "experienced";

type LrsConfig = {
  endpoint: string;
  username: string;
  password: string;
};

type LrsClientOptions = {
  config?: LrsConfig | null;
  fetchImpl?: typeof fetch;
  maxBatchSize?: number;
};

type AaisLrsDeliveryQueueOptions = LrsClientOptions & {
  autoStart?: boolean;
  maxAttempts?: number;
};

type QueuedAaisLrsBatch = {
  events: AaisEvent[];
  attempts: number;
};

type AaisLrsDeliveryQueueStatus = {
  pendingBatches: number;
  retryBatches: number;
  deadLetterBatches: number;
  inFlight: boolean;
  lastResult: {
    status: "sent" | "skipped" | "not_configured" | "error";
    sent: number;
    httpStatus?: number;
  } | null;
  lastError: {
    status: "error";
    httpStatus?: number;
    message: "redacted";
  } | null;
  secrets: "redacted";
};

type XapiStatement = {
  id: string;
  actor: {
    objectType: "Agent";
    name: string;
    account: {
      homePage: string;
      name: string;
    };
  };
  verb: {
    id: string;
    display: {
      "en-US": string;
    };
  };
  object: {
    id: string;
    objectType: "Activity";
    definition: {
      name: {
        "en-US": string;
      };
      type: string;
    };
  };
  context: {
    contextActivities: {
      parent: Array<{ id: string }>;
      grouping: Array<{ id: string }>;
      category: Array<{ id: string }>;
    };
    extensions: Record<string, unknown>;
  };
  timestamp: string;
};

const xapiVersion = "1.0.3";
const aaisBaseUrl = "https://www.aais.site";
const aaisXapiBase = `${aaisBaseUrl}/xapi`;

const eventVerbMap: Record<string, AaisXapiVerb> = {
  ai_acceptance_recorded: "completed",
  ai_prompt_submitted: "requested",
  ai_response_completed: "generated",
  artifact_edited: "generated",
  artifact_saved: "generated",
  articulation_submitted: "generated",
  coaching_push: "generated",
  expert_model_viewed: "experienced",
  expert_trace_compared: "experienced",
  monitoring_pause_detected: "experienced",
  planning_submitted: "generated",
  recommendation_override_recorded: "completed",
  scaffold_request: "requested",
  scaffold_self_check_started: "attempted",
  self_report_saved: "generated",
  session_created: "initialized",
  session_opened: "experienced",
  stage_selected: "experienced",
  task_completed: "completed",
  task_released: "initialized",
  task_selected: "attempted",
  understanding_check_completed: "completed",
};

const verbIdMap: Record<AaisXapiVerb, string> = {
  attempted: "http://adlnet.gov/expapi/verbs/attempted",
  completed: "http://adlnet.gov/expapi/verbs/completed",
  experienced: "http://adlnet.gov/expapi/verbs/experienced",
  generated: `${aaisXapiBase}/verbs/generated`,
  initialized: "http://adlnet.gov/expapi/verbs/initialized",
  requested: `${aaisXapiBase}/verbs/requested`,
};

export function getLrsConfigurationStatus() {
  const config = readLrsConfig();
  return {
    configured: Boolean(config),
    requiredEnv: ["LRS_ENDPOINT", "LRS_USERNAME", "LRS_PASSWORD"],
  };
}

export function buildAaisXapiStatement(event: AaisEvent): XapiStatement {
  const verb = requireMappedVerb(event.event);
  const eventDefinition = aaisEventDefinitions[event.event];
  const agentContract = getAgentContract(event.agent);
  const actorName = createPseudonymousLearnerId(event.student_id);
  const sessionKey = createPseudonymousSessionId(event.session_id);
  const integration = getAaisEnterpriseIntegrationMetadata();
  return {
    id: createDeterministicStatementId(event),
    actor: {
      objectType: "Agent",
      name: actorName,
      account: {
        homePage: aaisBaseUrl,
        name: actorName,
      },
    },
    verb: {
      id: verbIdMap[verb],
      display: {
        "en-US": verb,
      },
    },
    object: {
      id: `${aaisXapiBase}/activities/${encodePath(event.phase)}/${encodePath(event.task)}/${encodePath(event.event)}`,
      objectType: "Activity",
      definition: {
        name: {
          "en-US": `AAIS ${event.event}`,
        },
        type: `${aaisXapiBase}/activities/learning-event`,
      },
    },
    context: {
      contextActivities: {
        parent: [
          {
            id: `${aaisXapiBase}/tasks/${encodePath(event.task)}`,
          },
        ],
        grouping: [
          {
            id: `${aaisXapiBase}/courses/${encodePath(integration.courseId)}`,
          },
        ],
        category: [
          {
            id: `${aaisXapiBase}/agents/${encodePath(event.agent)}`,
          },
        ],
      },
      extensions: {
        [`${aaisXapiBase}/extensions/aais-agent`]: event.agent,
        ...(agentContract
          ? {
              [`${aaisXapiBase}/extensions/aais-agent-family`]: eventDefinition.family,
              [`${aaisXapiBase}/extensions/aais-agent-role`]: agentContract.role["en-US"],
              [`${aaisXapiBase}/extensions/aais-agent-ca-modules`]: agentContract.caModules,
              [`${aaisXapiBase}/extensions/aais-agent-phase-scope`]: agentContract.phaseScope,
            }
          : {}),
        [`${aaisXapiBase}/extensions/aais-event`]: event.event,
        [`${aaisXapiBase}/extensions/aais-event-family`]: eventDefinition.family,
        [`${aaisXapiBase}/extensions/aais-evidence-kind`]: eventDefinition.evidenceKind,
        [`${aaisXapiBase}/extensions/aais-phase`]: event.phase,
        [`${aaisXapiBase}/extensions/aais-task`]: event.task,
        [`${aaisXapiBase}/extensions/aais-session-id`]: sessionKey,
        [`${aaisXapiBase}/extensions/aais-detail`]: sanitizeLrsDetail(event.detail),
        [`${aaisXapiBase}/extensions/aais-cohort`]: integration.cohort,
        [`${aaisXapiBase}/extensions/aais-role`]: integration.role,
        [`${aaisXapiBase}/extensions/aais-course-id`]: integration.courseId,
      },
    },
    timestamp: event.time,
  };
}

function getAgentContract(agentId: AaisEvent["agent"]) {
  if (agentId === "platform") {
    return null;
  }
  return aaisAgents.find((agent) => agent.id === agentId) ?? null;
}

export async function sendAaisEventsToLrs(
  events: AaisEvent[],
  options: LrsClientOptions = {},
) {
  const config = options.config ?? readLrsConfig();
  if (!config) {
    return {
      status: "not_configured" as const,
      sent: 0,
    };
  }
  if (!events.length) {
    return {
      status: "skipped" as const,
      sent: 0,
    };
  }

  let sent = 0;
  let lastHttpStatus: number | undefined;
  for (const batch of chunkEvents(events, options.maxBatchSize ?? 50)) {
    const response = await (options.fetchImpl ?? fetch)(getStatementsUrl(config.endpoint), {
      method: "POST",
      headers: createLrsHeaders(config),
      body: JSON.stringify(batch.map(buildAaisXapiStatement)),
    });
    lastHttpStatus = response.status;
    if (!response.ok) {
      return {
        status: "error" as const,
        sent,
        httpStatus: response.status,
      };
    }
    sent += batch.length;
  }

  return {
    status: "sent" as const,
    sent,
    httpStatus: lastHttpStatus,
  };
}

export function createAaisLrsDeliveryQueue(options: AaisLrsDeliveryQueueOptions = {}) {
  const pending: QueuedAaisLrsBatch[] = [];
  const retry: QueuedAaisLrsBatch[] = [];
  const deadLetter: QueuedAaisLrsBatch[] = [];
  const maxAttempts = options.maxAttempts ?? 3;
  const autoStart = options.autoStart ?? true;
  let inFlight = false;
  let scheduled = false;
  let lastResult: AaisLrsDeliveryQueueStatus["lastResult"] = null;
  let lastError: AaisLrsDeliveryQueueStatus["lastError"] = null;

  function enqueue(events: AaisEvent[]) {
    if (!events.length) {
      return getStatus();
    }
    pending.push({
      events,
      attempts: 0,
    });
    if (autoStart) {
      scheduleFlush();
    }
    return getStatus();
  }

  async function flush() {
    if (inFlight) {
      return getStatus();
    }
    inFlight = true;
    const batches = [
      ...pending.splice(0),
      ...retry.splice(0),
    ];

    try {
      for (const batch of batches) {
        try {
          const result = await sendAaisEventsToLrs(batch.events, {
            config: options.config,
            fetchImpl: options.fetchImpl,
            maxBatchSize: options.maxBatchSize,
          });
          lastResult = {
            status: result.status,
            sent: result.sent,
            ...("httpStatus" in result && result.httpStatus ? { httpStatus: result.httpStatus } : {}),
          };
          if (result.status === "error") {
            retryOrDeadLetter(batch, result.httpStatus);
          }
        } catch {
          retryOrDeadLetter(batch);
        }
      }
    } finally {
      inFlight = false;
    }

    if (autoStart && (pending.length || retry.length)) {
      scheduleFlush(250);
    }
    return getStatus();
  }

  function retryOrDeadLetter(batch: QueuedAaisLrsBatch, httpStatus?: number) {
    batch.attempts += 1;
    lastError = {
      status: "error",
      ...(httpStatus ? { httpStatus } : {}),
      message: "redacted",
    };
    if (batch.attempts >= maxAttempts) {
      deadLetter.push(batch);
      return;
    }
    retry.push(batch);
  }

  function scheduleFlush(delayMs = 0) {
    if (scheduled) {
      return;
    }
    scheduled = true;
    setTimeout(() => {
      scheduled = false;
      void flush();
    }, delayMs);
  }

  function getStatus(): AaisLrsDeliveryQueueStatus {
    return {
      pendingBatches: pending.length,
      retryBatches: retry.length,
      deadLetterBatches: deadLetter.length,
      inFlight,
      lastResult,
      lastError,
      secrets: "redacted",
    };
  }

  return {
    enqueue,
    flush,
    getStatus,
  };
}

const defaultAaisLrsDeliveryQueue = createAaisLrsDeliveryQueue();

export function enqueueAaisLrsEvents(events: AaisEvent[]) {
  return defaultAaisLrsDeliveryQueue.enqueue(events);
}

export function flushAaisLrsDeliveryQueue() {
  return defaultAaisLrsDeliveryQueue.flush();
}

export function getAaisLrsDeliveryQueueStatus() {
  return defaultAaisLrsDeliveryQueue.getStatus();
}

export async function probeAaisLrsConnection(options: LrsClientOptions = {}) {
  const config = options.config ?? readLrsConfig();
  if (!config) {
    return {
      status: "not_configured" as const,
      configured: false,
    };
  }
  const url = new URL(getStatementsUrl(config.endpoint));
  url.searchParams.set("limit", "1");
  url.searchParams.set("activity", `${aaisXapiBase}/courses/cognitive-apprenticeship`);
  url.searchParams.set("related_activities", "true");

  const response = await (options.fetchImpl ?? fetch)(url, {
    method: "GET",
    headers: createLrsHeaders(config),
  });

  return {
    status: response.ok ? "connected" as const : "error" as const,
    configured: true,
    httpStatus: response.status,
  };
}

export async function sendAaisLrsHealthStatement(
  studentId: string,
  options: LrsClientOptions = {},
) {
  return sendAaisEventsToLrs(
    [
      {
        student_id: studentId,
        session_id: `session-lrs-health-${createHash("sha256").update(studentId).digest("hex").slice(0, 12)}`,
        phase: "training",
        task: "lrs_health_check",
        agent: "platform",
        event: "session_created",
        time: new Date().toISOString(),
        detail: {
          source: "lrs_health",
          smoke: true,
        },
      },
    ],
    options,
  );
}

function readLrsConfig(): LrsConfig | null {
  const endpoint = process.env.LRS_ENDPOINT?.trim();
  const username = process.env.LRS_USERNAME?.trim();
  const password = process.env.LRS_PASSWORD?.trim();
  if (!endpoint || !username || !password) {
    return null;
  }
  return {
    endpoint,
    username,
    password,
  };
}

function getStatementsUrl(endpoint: string) {
  const normalized = endpoint.trim().replace(/\/+$/, "");
  if (normalized.endsWith("/statements")) {
    return normalized;
  }
  return `${normalized}/statements`;
}

function createLrsHeaders(config: LrsConfig) {
  return {
    authorization: `Basic ${Buffer.from(`${config.username}:${config.password}`).toString("base64")}`,
    "content-type": "application/json",
    "x-experience-api-version": xapiVersion,
  };
}

function getAaisEnterpriseIntegrationMetadata() {
  return {
    cohort: process.env.AAIS_LRS_COHORT_ID?.trim() || "default",
    role: process.env.AAIS_LRS_ROLE?.trim() || "learner",
    courseId: process.env.AAIS_LRS_COURSE_ID?.trim() || "cognitive-apprenticeship",
  };
}

function requireMappedVerb(eventName: string) {
  const verb = eventVerbMap[eventName];
  if (!verb) {
    throw new Error(`AAIS event ${eventName} has no xAPI verb mapping.`);
  }
  return verb;
}

function createDeterministicStatementId(event: AaisEvent) {
  const digest = createHash("sha256")
    .update(JSON.stringify([event.student_id, event.session_id, event.phase, event.task, event.agent, event.event, event.time]))
    .digest("hex");
  return [
    digest.slice(0, 8),
    digest.slice(8, 12),
    `4${digest.slice(13, 16)}`,
    `8${digest.slice(17, 20)}`,
    digest.slice(20, 32),
  ].join("-");
}

function encodePath(value: string) {
  return encodeURIComponent(value).replaceAll("%2F", "/");
}

function createPseudonymousLearnerId(studentId: string) {
  const digest = createHash("sha256")
    .update(`aais-learner:${studentId}`)
    .digest("hex")
    .slice(0, 16);
  return `aais-learner-${digest}`;
}

function createPseudonymousSessionId(sessionId: string) {
  const digest = createHash("sha256")
    .update(`aais-lrs-session:${sessionId}`)
    .digest("hex")
    .slice(0, 12);
  return `session-${digest}`;
}

function sanitizeLrsDetail(detail: Record<string, unknown>) {
  return Object.fromEntries(
    Object.entries(detail).map(([key, value]) => [
      key,
      shouldRedactDetailValue(key, value) ? "[redacted]" : sanitizeNestedDetail(value),
    ]),
  );
}

function sanitizeNestedDetail(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(sanitizeNestedDetail);
  }
  if (!value || typeof value !== "object") {
    return value;
  }
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>).map(([key, nested]) => [
      key,
      shouldRedactDetailValue(key, nested) ? "[redacted]" : sanitizeNestedDetail(nested),
    ]),
  );
}

function shouldRedactDetailValue(key: string, value: unknown) {
  return typeof value === "string"
    && /prompt|question|answer|artifact|self.?report|password|secret|token|cookie|code/i.test(key);
}

function chunkEvents(events: AaisEvent[], size: number) {
  const chunks: AaisEvent[][] = [];
  for (let index = 0; index < events.length; index += size) {
    chunks.push(events.slice(index, index + size));
  }
  return chunks;
}
