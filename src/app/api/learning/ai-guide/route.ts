import { NextResponse } from "next/server";
import {
  runAaisLearningGuideGraph,
  type AaisGuideInput,
} from "@/lib/ai/orchestration/aais-learning-guide-graph";
import {
  getAaisLearningStore,
  isAaisLearningStorageConfigurationError,
  isAaisSessionWriteConflictError,
} from "@/lib/server/aais-learning-store";
import { isAaisCsrfError, requireAaisCsrf } from "@/lib/server/aais-csrf";
import { isAaisAuthError, requireAaisSessionActor } from "@/lib/server/aais-request-auth";
import {
  normalizeAaisGuideTargetAgentIds,
  resolveAaisGuideTargetAgentIds,
} from "@/lib/ai/aais-guide-targets";
import { normalizeAaisGuideAttachments } from "@/lib/ai/aais-guide-attachments";
import {
  AaisApiRouteError,
  createAaisApiErrorBody,
  createAaisApiErrorResponse,
  isAaisApiRouteError,
} from "@/lib/server/aais-api-error";
import { recordAaisAuditEvent } from "@/lib/server/aais-audit-log";
import {
  AaisResearchConfigurationError,
  AaisResearchDisabledError,
  isAaisResearchModeEnabled,
  requiresAaisResearchDataPlaneIsolation,
} from "@/lib/server/aais-research-contract";
import { getAaisResearchErrorResponseInput } from "@/lib/server/aais-research-api";
import {
  acquireAaisResearchRawTextWriteLeaseIfRequired,
  type AaisResearchRawTextWriteLease,
} from "@/lib/server/aais-research-raw-text";
import {
  AaisResearchAuthorizationError,
  AaisResearchVisitInactiveError,
  AaisResearchVisitNotFoundError,
} from "@/lib/server/aais-research-store";
import type { AaisPhase, Locale } from "@/data/aais";

type AaisGuideRequestBody = {
  locale?: Locale;
  studentId?: string;
  phase?: AaisPhase;
  taskId?: string;
  learnerInput?: string;
  targetAgentIds?: string[];
  workspaceState?: {
    currentStep?: string;
    artifactText?: string;
    helpRequestsUsed?: number;
    attachments?: unknown;
  };
} | null;

const defaultDailyGuideLimit = 40;
const maxDailyGuideLimit = 200;

export async function POST(request: Request) {
  const body = (await request.json().catch(() => null)) as AaisGuideRequestBody;

  if (!body?.learnerInput?.trim()) {
    return createAaisApiErrorResponse({
      code: "AAIS_GUIDE_INPUT_REQUIRED",
      message: "learnerInput is required",
      status: 400,
    });
  }

  try {
    const actor = await requireAaisSessionActor(request);
    const studentId = actor.id;
    requireAaisCsrf(request, studentId);
    const researchIsolationRequired = requiresAaisResearchDataPlaneIsolation();
    if (researchIsolationRequired && !isAaisResearchModeEnabled()) {
      throw new AaisApiRouteError({
        code: "AAIS_RESEARCH_MODE_REQUIRED",
        message: "AAIS research collection is required but not enabled.",
        status: 503,
      });
    }
    const store = getAaisLearningStore();
    const targetAgentIds = normalizeAaisGuideTargetAgentIds(
      body.targetAgentIds,
      body.learnerInput,
    );
    const attachments = normalizeGuideAttachments(body.workspaceState?.attachments);
    if (researchIsolationRequired && attachments.length) {
      throw new AaisApiRouteError({
        code: "AAIS_RESEARCH_ATTACHMENT_PROHIBITED",
        message: "Attachments are disabled for this research study.",
        status: 400,
      });
    }
    let rawTextWriteLease = await acquireAaisResearchRawTextWriteLeaseIfRequired(actor);
    try {
      const budget = await reserveDailyGuideBudget(studentId, store);
      const session = await store.getOrCreateSession(studentId);
      const input: AaisGuideInput = {
        locale: body.locale === "en-US" ? "en-US" : "zh-CN",
        studentId,
        phase: body.phase === "practice" ? "practice" : "training",
        taskId: body.taskId ?? "training_task_1",
        learnerInput: body.learnerInput,
        conversationHistory: session.guideMessages.map((message) => ({
          kind: message.kind,
          text: message.text,
        })),
        ...(targetAgentIds ? { targetAgentIds } : {}),
        workspaceState: {
          currentStep: body.workspaceState?.currentStep ?? "smart-guide",
          artifactText: body.workspaceState?.artifactText,
          helpRequestsUsed: body.workspaceState?.helpRequestsUsed,
          ...(attachments.length ? { attachments } : {}),
        },
      };

      if (isGuideStreamRequest(request)) {
        const response = createGuideStreamResponse({
          input,
          store,
          question: body.learnerInput,
          budget,
          rawTextWriteLease,
        });
        rawTextWriteLease = null;
        return response;
      }

      const result = await runAaisLearningGuideGraph(input);
      await store.appendGuideExchange({
        studentId,
        phase: body.phase === "practice" ? "practice" : "training",
        taskId: body.taskId ?? "training_task_1",
        question: body.learnerInput,
        answer: result.messageText,
        turns: result.visibleTurns,
        orchestration: {
          graphId: result.graph.graphId,
          topologicalOrder: result.graph.topologicalOrder,
          threadId: result.runtime.threadId,
        },
      });
      recordGuideBudgetAudit({
        studentId,
        event: "ai.guide.budget.used",
        outcome: "success",
        budget,
      });

      return NextResponse.json({
        ...createGuideJsonBody(result),
        budget,
      });
    } finally {
      await rawTextWriteLease?.release();
    }
  } catch (error) {
    return createAaisApiErrorResponse(getErrorResponseInput(error));
  }
}

function normalizeGuideAttachments(value: unknown) {
  try {
    return normalizeAaisGuideAttachments(value);
  } catch {
    throw new AaisApiRouteError({
      code: "AAIS_GUIDE_ATTACHMENT_INVALID",
      message: "AAIS guide attachment is invalid.",
      status: 400,
    });
  }
}

function getErrorResponseInput(error: unknown) {
  if (isAaisApiRouteError(error)) {
    return {
      code: error.code,
      message: error.message,
      status: error.status,
    };
  }
  if (isAaisAuthError(error)) {
    return {
      code: "AAIS_AUTH_REQUIRED",
      message: "AAIS authentication is required.",
      status: 401,
    };
  }
  if (isAaisCsrfError(error)) {
    return {
      code: "AAIS_CSRF_REQUIRED",
      message: "AAIS CSRF token is required.",
      status: 403,
    };
  }
  if (
    error instanceof AaisResearchAuthorizationError
    || error instanceof AaisResearchVisitInactiveError
    || error instanceof AaisResearchVisitNotFoundError
    || error instanceof AaisResearchConfigurationError
    || error instanceof AaisResearchDisabledError
  ) {
    return getAaisResearchErrorResponseInput(error, "/api/learning/ai-guide");
  }
  if (isAaisLearningStorageConfigurationError(error)) {
    return {
      code: "AAIS_STORAGE_NOT_CONFIGURED",
      message: "AAIS production learner storage requires Postgres configuration.",
      status: 503,
    };
  }
  if (isAaisSessionWriteConflictError(error)) {
    return {
      code: "AAIS_SESSION_WRITE_CONFLICT",
      message: "AAIS learner session write conflict.",
      status: 409,
    };
  }
  if (error instanceof AaisGuideDailyBudgetError) {
    return {
      code: "AAIS_GUIDE_DAILY_BUDGET_EXCEEDED",
      message: "AAIS daily guide request budget has been reached.",
      status: 429,
      extra: {
        budget: error.budget,
        secrets: "redacted",
      },
    };
  }
  return {
    code: "AAIS_GUIDE_REQUEST_FAILED",
    message: "AAIS guide request failed.",
    status: 400,
    cause: error,
    route: "/api/learning/ai-guide",
  };
}

function createGuideJsonBody(result: Awaited<ReturnType<typeof runAaisLearningGuideGraph>>) {
  return {
    message: {
      text: result.messageText,
    },
    turns: result.visibleTurns,
    backgroundTurns: result.backgroundTurns,
    orchestration: {
      graph: result.graph,
      runtime: result.runtime,
      trace: result.trace,
    },
  };
}

function isGuideStreamRequest(request: Request) {
  const acceptsStream = request.headers.get("accept")?.includes("text/event-stream") ?? false;
  const streamParam = new URL(request.url).searchParams.get("stream") === "1";
  return acceptsStream || streamParam;
}

function createGuideStreamResponse(input: {
  input: Parameters<typeof runAaisLearningGuideGraph>[0];
  store: ReturnType<typeof getAaisLearningStore>;
  question: string;
  budget: AaisGuideDailyBudget;
  rawTextWriteLease: AaisResearchRawTextWriteLease | null;
}) {
  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    async start(controller) {
      const send = (event: string, data: Record<string, unknown>) => {
        controller.enqueue(encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`));
      };
      try {
        const targetAgentIds = resolveAaisGuideTargetAgentIds(input.input.targetAgentIds);
        send("ack", {
          status: "accepted",
          graphId: "learning-ai-guide",
          budget: input.budget,
        });
        for (const agentId of targetAgentIds) {
          send("agent_start", { agentId });
        }

        const result = await runAaisLearningGuideGraph(input.input);
        await input.store.appendGuideExchange({
          studentId: input.input.studentId,
          phase: input.input.phase,
          taskId: input.input.taskId,
          question: input.question,
          answer: result.messageText,
          turns: result.visibleTurns,
          orchestration: {
            graphId: result.graph.graphId,
            topologicalOrder: result.graph.topologicalOrder,
            threadId: result.runtime.threadId,
          },
        });
        recordGuideBudgetAudit({
          studentId: input.input.studentId,
          event: "ai.guide.budget.used",
          outcome: "success",
          budget: input.budget,
        });

        for (const turn of result.visibleTurns) {
          send("agent_delta", {
            agentId: turn.agentId,
            content: turn.content,
          });
          send("agent_done", {
            agentId: turn.agentId,
            status: result.runtime.timings.agents.find((agent) => agent.agentId === turn.agentId)?.status,
          });
        }
        if (result.runtime.timings.fallback) {
          send("fallback", {
            timeoutReason: result.runtime.timings.timeoutReason,
          });
        }
        send("background_done", {
          agents: result.backgroundTurns.map((turn) => turn.agentId),
        });
      } catch {
        send("error", {
          ...createAaisApiErrorBody(
            "AAIS_GUIDE_STREAM_FAILED",
            "AAIS guide stream failed.",
          ),
        });
      } finally {
        try {
          await input.rawTextWriteLease?.release();
        } catch {
          send("error", {
            ...createAaisApiErrorBody(
              "AAIS_RESEARCH_RAW_TEXT_LEASE_RELEASE_FAILED",
              "AAIS research write coordination failed.",
            ),
          });
        }
        controller.close();
      }
    },
  });

  return new Response(stream, {
    status: 200,
    headers: {
      "content-type": "text/event-stream;charset=utf-8",
      "cache-control": "no-store",
      connection: "keep-alive",
    },
  });
}

type AaisGuideDailyBudget = {
  limit: number;
  used: number;
  remaining: number;
  resetsAt: string;
};

class AaisGuideDailyBudgetError extends Error {
  constructor(readonly budget: AaisGuideDailyBudget) {
    super("AAIS daily guide request budget has been reached.");
    this.name = "AaisGuideDailyBudgetError";
  }
}

async function reserveDailyGuideBudget(
  studentId: string,
  store: ReturnType<typeof getAaisLearningStore>,
): Promise<AaisGuideDailyBudget> {
  const limit = readDailyGuideLimit();
  const reservation = await store.reserveDailyGuideRequest({ studentId, limit });
  const budget: AaisGuideDailyBudget = {
    limit: reservation.limit,
    used: reservation.used,
    remaining: reservation.remaining,
    resetsAt: reservation.resetsAt,
  };
  if (reservation.status === "exhausted") {
    recordGuideBudgetAudit({
      studentId,
      event: "ai.guide.budget.exceeded",
      outcome: "failure",
      budget,
    });
    throw new AaisGuideDailyBudgetError(budget);
  }
  return budget;
}

function readDailyGuideLimit() {
  const configured = Number(process.env.AAIS_AI_DAILY_GUIDE_LIMIT);
  if (!Number.isFinite(configured) || configured <= 0) {
    return defaultDailyGuideLimit;
  }
  return Math.min(maxDailyGuideLimit, Math.floor(configured));
}

function recordGuideBudgetAudit(input: {
  studentId: string;
  event: "ai.guide.budget.used" | "ai.guide.budget.exceeded";
  outcome: "success" | "failure";
  budget: AaisGuideDailyBudget;
}) {
  recordAaisAuditEvent({
    event: input.event,
    actorId: input.studentId,
    outcome: input.outcome,
    metadata: {
      limit: input.budget.limit,
      used: input.budget.used,
      remaining: input.budget.remaining,
      resetsAt: input.budget.resetsAt,
    },
  });
}
