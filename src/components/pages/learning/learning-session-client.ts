import { getAaisApiErrorMessage } from "@/lib/client/aais-api-error";
import { getAaisCsrfHeader } from "@/components/pages/learning/client-helpers";
import type { AaisClientSession } from "@/components/pages/learning/learning-page-types";

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

export async function deleteAaisAppSession(fetchImpl: typeof fetch = fetch) {
  await fetchImpl("/api/auth/app-session", {
    method: "DELETE",
    credentials: "same-origin",
  });
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
