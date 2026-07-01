import { NextResponse } from "next/server";
import { runAaisLearningGuideGraph } from "@/lib/ai/orchestration/aais-learning-guide-graph";
import {
  getAaisLearningStore,
  isAaisLearningStorageConfigurationError,
} from "@/lib/server/aais-learning-store";
import { isAaisCsrfError, requireAaisCsrf } from "@/lib/server/aais-csrf";
import { isAaisAuthError, resolveAaisStudentId } from "@/lib/server/aais-request-auth";
import type { AaisPhase, Locale } from "@/data/aais";

export async function POST(request: Request) {
  const body = (await request.json().catch(() => null)) as {
    locale?: Locale;
    studentId?: string;
    phase?: AaisPhase;
    taskId?: string;
    learnerInput?: string;
    workspaceState?: {
      currentStep?: string;
      artifactText?: string;
      helpRequestsUsed?: number;
    };
  } | null;

  if (!body?.learnerInput?.trim()) {
    return NextResponse.json({ error: "learnerInput is required" }, { status: 400 });
  }

  try {
    const studentId = resolveAaisStudentId(request);
    requireAaisCsrf(request, studentId);
    const store = getAaisLearningStore();
    const result = await runAaisLearningGuideGraph({
      locale: body.locale === "en-US" ? "en-US" : "zh-CN",
      studentId,
      phase: body.phase === "practice" ? "practice" : "training",
      taskId: body.taskId ?? "training_task_1",
      learnerInput: body.learnerInput,
      workspaceState: {
        currentStep: body.workspaceState?.currentStep ?? "smart-guide",
        artifactText: body.workspaceState?.artifactText,
        helpRequestsUsed: body.workspaceState?.helpRequestsUsed,
      },
    });
    await store.appendGuideExchange({
      studentId,
      phase: body.phase === "practice" ? "practice" : "training",
      taskId: body.taskId ?? "training_task_1",
      question: body.learnerInput,
      answer: result.messageText,
      turns: result.turns,
      orchestration: {
        graphId: result.graph.graphId,
        topologicalOrder: result.graph.topologicalOrder,
        threadId: result.runtime.threadId,
      },
    });

    return NextResponse.json({
      message: {
        text: result.messageText,
      },
      turns: result.turns,
      orchestration: {
        graph: result.graph,
        runtime: result.runtime,
        trace: result.trace,
      },
    });
  } catch (error) {
    return NextResponse.json(
      {
        error: error instanceof Error ? error.message : "AAIS guide request failed.",
      },
      { status: getErrorStatus(error) },
    );
  }
}

function getErrorStatus(error: unknown) {
  if (isAaisAuthError(error)) {
    return 401;
  }
  if (isAaisCsrfError(error)) {
    return 403;
  }
  if (isAaisLearningStorageConfigurationError(error)) {
    return 503;
  }
  return 400;
}
