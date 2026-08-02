import { getAaisApiErrorMessage } from "@/lib/client/aais-api-error";
import { getAaisCsrfHeader } from "@/components/pages/learning/client-helpers";
import type { AaisClientSession } from "@/components/pages/learning/learning-page-types";
import type { AaisResearchLogoutContext } from "@/lib/client/aais-research-telemetry";

type LearningSessionResponseBody = {
  session?: AaisClientSession;
  error?: string | {
    code?: string;
    message?: string;
  };
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
  sessionRevoked: boolean;
};

export type LearningSessionPatchBody = Record<string, unknown>;

export async function fetchLearningSession(fetchImpl: typeof fetch = fetch) {
  const response = await fetchImpl("/api/learning/session");
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
    sessionRevoked?: unknown;
  } | null;
  if (!response.ok) {
    if (body?.sessionRevoked === true) {
      return {
        researchAcknowledged: false,
        sessionRevoked: true,
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
      sessionRevoked: body?.sessionRevoked === true,
    } satisfies AaisAppSessionDeleteResult;
  }
  return {
    researchAcknowledged: false,
    sessionRevoked: body?.sessionRevoked !== false,
  } satisfies AaisAppSessionDeleteResult;
}

export async function fetchLearnerPrivacyData(fetchImpl: typeof fetch = fetch) {
  const response = await fetchImpl("/api/learning/privacy");
  return readLearnerPrivacyResponse(response, "AAIS learner data export failed.");
}

export async function deleteLearnerPrivacyData(fetchImpl: typeof fetch = fetch) {
  const response = await fetchImpl("/api/learning/privacy", {
    method: "DELETE",
    headers: {
      ...getAaisCsrfHeader(),
    },
  });
  return readLearnerPrivacyResponse(response, "AAIS learner data deletion failed.");
}

async function readLearningSessionResponse(response: Response, fallbackMessage: string) {
  const body = (await response.json()) as LearningSessionResponseBody;
  if (!response.ok || !body.session) {
    throw new Error(getAaisApiErrorMessage(body, fallbackMessage));
  }
  return body.session;
}

async function readLearnerPrivacyResponse(response: Response, fallbackMessage: string) {
  const body = (await response.json()) as LearnerPrivacyResponseBody;
  if (!response.ok) {
    throw new Error(getAaisApiErrorMessage(body, fallbackMessage));
  }
  return body;
}
