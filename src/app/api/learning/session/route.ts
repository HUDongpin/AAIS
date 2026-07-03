import { NextResponse } from "next/server";
import {
  getAaisLearningStore,
  isAaisLearningStorageConfigurationError,
} from "@/lib/server/aais-learning-store";
import { isAaisCsrfError, requireAaisCsrf } from "@/lib/server/aais-csrf";
import {
  isAaisAuthError,
  requireAaisSessionActor,
} from "@/lib/server/aais-request-auth";

export async function GET(request: Request) {
  try {
    const actor = requireAaisSessionActor(request);
    const session = await getAaisLearningStore().getOrCreateSession(actor.id);
    return jsonSession(session, actor.role);
  } catch (error) {
    return jsonError(error, 400);
  }
}

export async function PATCH(request: Request) {
  const body = (await request.json().catch(() => null)) as
    | {
        studentId?: string;
        action?: string;
        stageId?: string;
        taskId?: string;
        messageId?: string;
        artifactText?: string;
        selfReport?: string;
        accepted?: boolean;
        reason?: string;
      }
    | null;

  try {
    const store = getAaisLearningStore();
    const actor = requireAaisSessionActor(request);
    const studentId = actor.id;
    requireAaisCsrf(request, studentId);
    if (body?.action === "select-stage") {
      const session = await store.selectStage(studentId, requireString(body.stageId, "stageId"));
      return jsonSession(session, actor.role);
    }
    if (body?.action === "select-task") {
      const session = await store.selectTask(studentId, requireString(body.taskId, "taskId"));
      return jsonSession(session, actor.role);
    }
    if (body?.action === "complete-task") {
      const session = await store.completeTask(studentId, requireString(body.taskId, "taskId"));
      return jsonSession(session, actor.role);
    }
    if (body?.action === "save-artifact") {
      const session = await store.saveArtifact(
        studentId,
        requireString(body.taskId, "taskId"),
        body.artifactText ?? "",
      );
      return jsonSession(session, actor.role);
    }
    if (body?.action === "save-self-report") {
      const session = await store.saveSelfReport(
        studentId,
        requireString(body.taskId, "taskId"),
        body.selfReport ?? "",
      );
      return jsonSession(session, actor.role);
    }
    if (body?.action === "record-ai-acceptance") {
      const session = await store.recordAiAcceptance(
        studentId,
        requireString(body.taskId, "taskId"),
        {
          accepted: body.accepted === true,
          messageId: body.messageId,
          reason: body.reason,
        },
      );
      return jsonSession(session, actor.role);
    }

    return NextResponse.json({ error: "Unsupported AAIS session action." }, { status: 400 });
  } catch (error) {
    return jsonError(error, 400);
  }
}

function jsonSession(
  session: Awaited<ReturnType<ReturnType<typeof getAaisLearningStore>["getOrCreateSession"]>>,
  role: "student" | "teacher" | "admin",
) {
  return NextResponse.json({
    session,
    actor: {
      role,
    },
  });
}

function requireString(value: string | undefined, label: string) {
  if (!value) {
    throw new Error(`${label} is required.`);
  }
  return value;
}

function jsonError(error: unknown, status: number) {
  return NextResponse.json(
    {
      error: error instanceof Error ? error.message : "AAIS session request failed.",
    },
    { status: getErrorStatus(error, status) },
  );
}

function getErrorStatus(error: unknown, fallback: number) {
  if (isAaisAuthError(error)) {
    return 401;
  }
  if (isAaisCsrfError(error)) {
    return 403;
  }
  if (isAaisLearningStorageConfigurationError(error)) {
    return 503;
  }
  return fallback;
}
