import { NextResponse } from "next/server";
import {
  getAaisLearningStore,
  isAaisLearningStorageConfigurationError,
} from "@/lib/server/aais-learning-store";
import { isAaisCsrfError, requireAaisCsrf } from "@/lib/server/aais-csrf";
import { isAaisAuthError, resolveAaisStudentId } from "@/lib/server/aais-request-auth";

export async function POST(request: Request) {
  const body = (await request.json().catch(() => null)) as
    | {
        studentId?: string;
        taskId?: string;
        toolId?: string;
      }
    | null;

  try {
    const studentId = resolveAaisStudentId(request);
    requireAaisCsrf(request, studentId);
    const result = await getAaisLearningStore().requestScaffold(
      studentId,
      requireString(body?.taskId, "taskId"),
      body?.toolId ?? "stage-checklist",
    );
    return NextResponse.json(result);
  } catch (error) {
    return NextResponse.json(
      {
        error: error instanceof Error ? error.message : "AAIS scaffold request failed.",
      },
      { status: getErrorStatus(error) },
    );
  }
}

function requireString(value: string | undefined, label: string) {
  if (!value) {
    throw new Error(`${label} is required.`);
  }
  return value;
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
