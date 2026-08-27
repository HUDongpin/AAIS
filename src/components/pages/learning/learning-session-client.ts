import { getAaisApiErrorMessage } from "@/lib/client/aais-api-error";
import { getAaisCsrfHeader } from "@/components/pages/learning/client-helpers";
import type {
  AaisClientScaffoldEvidenceSnapshot,
  AaisClientScaffoldFadingReason,
  AaisClientSession,
} from "@/components/pages/learning/learning-page-types";
import type { AaisResearchLogoutContext } from "@/lib/client/aais-research-telemetry";

type LearningSessionResponseBody = {
  session?: AaisClientSession;
  error?: string | {
    code?: string;
    message?: string;
    details?: {
      taskId?: unknown;
      completionMissing?: unknown;
    };
  };
};

export type AaisLearningScaffoldResult = {
  session: AaisClientSession;
  mode: "tool-list" | "self-check";
  requestCount: number;
  tool: {
    id: string;
    label: string;
    body: string;
  };
  level?: 1 | 2 | 3 | 4;
  intensity?: string;
  remainingDirectAssists?: number;
  fading?: boolean;
  fadingReason?: AaisClientScaffoldFadingReason;
  evidenceSnapshot?: AaisClientScaffoldEvidenceSnapshot;
};

type LearnerPrivacyResponseBody = {
  error?: string | {
    code?: string;
    message?: string;
  };
  [key: string]: unknown;
};

type AaisAppSessionDeleteResult = {
  researchAcknowledged: boolean;
  sessionAbsent: boolean;
  sessionRevoked: boolean;
};

export type LearningSessionPatchBody = Record<string, unknown>;

export async function fetchLearningSession(
  fetchImpl: typeof fetch = fetch,
  options: { signal?: AbortSignal } = {},
) {
  const response = options.signal
    ? await fetchImpl("/api/learning/session", { method: "GET", signal: options.signal })
    : await fetchImpl("/api/learning/session");
  if (response.status === 404) {
    options.signal?.throwIfAborted();
    const initialized = await fetchImpl("/api/learning/session", {
      method: "POST",
      headers: getAaisCsrfHeader(),
      ...(options.signal ? { signal: options.signal } : {}),
    });
    return readLearningSessionResponse(initialized, "AAIS session initialization failed.");
  }
  return readLearningSessionResponse(response, "AAIS session load failed.");
}

export async function patchLearningSession(
  body: LearningSessionPatchBody,
  fetchImpl: typeof fetch = fetch,
) {
  const response = await fetchImpl("/api/learning/session", {
    method: "PATCH",
    headers: {
      "content-type": "application/json",
      ...getAaisCsrfHeader(),
    },
    body: JSON.stringify(body),
  });
  return readLearningSessionResponse(response, "AAIS session update failed.");
}

export async function requestLearningScaffold(
  input: {
    dataGeneration: number;
    mutationId: string;
    taskId: string;
    toolId: string;
  },
  fetchImpl: typeof fetch = fetch,
): Promise<AaisLearningScaffoldResult> {
  const response = await fetchImpl("/api/learning/scaffold", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...getAaisCsrfHeader(),
    },
    body: JSON.stringify(input),
  });
  const body = (await response.json()) as Partial<AaisLearningScaffoldResult> & {
    error?: string | { code?: string; message?: string };
  };
  if (
    !response.ok
    || !body.session
    || !Number.isSafeInteger(body.requestCount)
    || (body.mode !== "tool-list" && body.mode !== "self-check")
    || !body.tool
    || typeof body.tool.id !== "string"
    || typeof body.tool.label !== "string"
    || typeof body.tool.body !== "string"
  ) {
    throw Object.assign(
      new Error(getAaisApiErrorMessage(body, "AAIS scaffold request failed.")),
      { status: response.status },
    );
  }
  return body as AaisLearningScaffoldResult;
}

const aaisLearningKeepaliveBodyLimitBytes = 60 * 1024;

export function patchLearningSessionKeepalive(
  body: LearningSessionPatchBody,
  fetchImpl: typeof fetch = fetch,
) {
  const serializedBody = JSON.stringify(body);
  if (new TextEncoder().encode(serializedBody).byteLength > aaisLearningKeepaliveBodyLimitBytes) {
    return false;
  }
  try {
    void fetchImpl("/api/learning/session", {
      method: "PATCH",
      credentials: "same-origin",
      headers: {
        "content-type": "application/json",
        ...getAaisCsrfHeader(),
      },
      body: serializedBody,
      keepalive: true,
    }).catch(() => undefined);
    return true;
  } catch {
    return false;
  }
}

export async function deleteAaisAppSession(
  researchLogout: AaisResearchLogoutContext | null = null,
  fetchImpl: typeof fetch = fetch,
) {
  const response = await fetchImpl("/api/auth/app-session", {
    method: "DELETE",
    credentials: "same-origin",
    headers: researchLogout
      ? {
          "content-type": "application/json",
          ...getAaisCsrfHeader(),
        }
      : {
          ...getAaisCsrfHeader(),
        },
    ...(researchLogout ? { body: JSON.stringify({ researchLogout }) } : {}),
  });
  const body = (await response.json().catch(() => null)) as {
    researchLogout?: {
      clientEventId?: unknown;
      visitId?: unknown;
    };
    researchLogoutAcknowledged?: unknown;
    sessionAbsent?: unknown;
    sessionRevoked?: unknown;
  } | null;
  const sessionAbsent = body?.sessionAbsent === true;
  const sessionRevoked = body?.sessionRevoked === true;
  const sessionTerminated = sessionRevoked || sessionAbsent;
  if (!response.ok) {
    if (sessionTerminated) {
      return {
        researchAcknowledged: false,
        sessionAbsent,
        sessionRevoked,
      } satisfies AaisAppSessionDeleteResult;
    }
    throw new Error("AAIS logout failed.");
  }
  if (researchLogout) {
    const researchAcknowledged = body?.sessionRevoked === true
      && body.researchLogout?.clientEventId === researchLogout.successClientEventId
      && body.researchLogout.visitId === researchLogout.expectedVisitId;
    return {
      researchAcknowledged,
      sessionAbsent,
      sessionRevoked,
    } satisfies AaisAppSessionDeleteResult;
  }
  return {
    researchAcknowledged: false,
    sessionAbsent,
    sessionRevoked,
  } satisfies AaisAppSessionDeleteResult;
}

export async function fetchLearnerPrivacyData(fetchImpl: typeof fetch = fetch) {
  const response = await fetchImpl("/api/learning/privacy");
  return readLearnerPrivacyResponse(response, "AAIS learner data export failed.");
}

export async function deleteLearnerPrivacyData(
  dataGeneration: number,
  fetchImpl: typeof fetch = fetch,
) {
  const response = await fetchImpl("/api/learning/privacy", {
    method: "DELETE",
    headers: {
      "content-type": "application/json",
      ...getAaisCsrfHeader(),
    },
    body: JSON.stringify({ dataGeneration }),
  });
  const body = await readLearnerPrivacyResponse(
    response,
    "AAIS learner data deletion failed.",
  );
  const nextGeneration = (body.deletion as { nextGeneration?: unknown } | undefined)?.nextGeneration;
  if (!Number.isSafeInteger(nextGeneration) || Number(nextGeneration) < 1) {
    throw new Error("AAIS learner data deletion did not return a generation.");
  }
  return {
    ...body,
    deletion: {
      ...(body.deletion as Record<string, unknown>),
      nextGeneration: Number(nextGeneration),
    },
  };
}

async function readLearningSessionResponse(response: Response, fallbackMessage: string) {
  const body = (await response.json()) as LearningSessionResponseBody;
  if (!response.ok || !body.session) {
    const errorCode = typeof body.error === "object" && body.error
      && typeof body.error.code === "string"
      ? body.error.code
      : undefined;
    const details = typeof body.error === "object" && body.error
      ? body.error.details
      : undefined;
    const completionMissing = Array.isArray(details?.completionMissing)
      ? details.completionMissing.filter((value): value is string => typeof value === "string")
      : undefined;
    throw Object.assign(new Error(getAaisApiErrorMessage(body, fallbackMessage)), {
      ...(errorCode ? { code: errorCode } : {}),
      ...(typeof details?.taskId === "string" ? { taskId: details.taskId } : {}),
      ...(completionMissing ? { completionMissing } : {}),
      status: response.status,
    });
  }
  return body.session;
}

export function isAaisTextRevisionConflictClientError(error: unknown) {
  const code = error && typeof error === "object" && "code" in error
    ? (error as { code?: unknown }).code
    : null;
  return code === "AAIS_ARTIFACT_REVISION_CONFLICT"
    || code === "AAIS_SELF_REPORT_REVISION_CONFLICT"
    || code === "AAIS_PILOT_EVIDENCE_REVISION_CONFLICT";
}

async function readLearnerPrivacyResponse(response: Response, fallbackMessage: string) {
  const body = (await response.json()) as LearnerPrivacyResponseBody;
  if (!response.ok) {
    throw new Error(getAaisApiErrorMessage(body, fallbackMessage));
  }
  return body;
}
