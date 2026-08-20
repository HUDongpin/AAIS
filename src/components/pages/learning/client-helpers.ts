import { guideRequestTimeoutMs } from "@/components/pages/learning/learning-page-constants";

export type PendingArtifactSave = {
  activeDocumentId: string | null;
  documentTitle: string;
  mutationId: string;
  expectedArtifactRevision: number | null;
  revisionLocked: boolean;
  retryCount: number;
  revision: number;
  taskId: string;
  value: string;
};

export type ArtifactDraftJournal = {
  activeDocumentId?: string | null;
  mutationId?: string;
  expectedArtifactRevision?: number;
  revision: number;
  taskId: string;
  title: string;
  value: string;
};

export function getArtifactDraftJournalKey(studentId: string) {
  return `aais_artifact_draft_v1:${studentId}`;
}

export function readArtifactDraftJournal(studentId: string): ArtifactDraftJournal | null {
  try {
    const raw = window.sessionStorage.getItem(getArtifactDraftJournalKey(studentId));
    if (!raw) return null;
    const value = JSON.parse(raw) as Partial<ArtifactDraftJournal>;
    return typeof value.taskId === "string"
      && typeof value.value === "string"
      && typeof value.title === "string"
      && typeof value.revision === "number"
      && (
        value.expectedArtifactRevision === undefined
        || (
          Number.isSafeInteger(value.expectedArtifactRevision)
          && Number(value.expectedArtifactRevision) >= 0
        )
      )
      && (
        value.mutationId === undefined
        || (
          typeof value.mutationId === "string"
          && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(value.mutationId)
        )
      )
      && (
        value.activeDocumentId === undefined
        || value.activeDocumentId === null
        || typeof value.activeDocumentId === "string"
      )
      ? value as ArtifactDraftJournal
      : null;
  } catch {
    return null;
  }
}

export function writeArtifactDraftJournal(studentId: string, journal: ArtifactDraftJournal) {
  try {
    window.sessionStorage.setItem(
      getArtifactDraftJournalKey(studentId),
      JSON.stringify(journal),
    );
  } catch {
    // A full or unavailable sessionStorage must never block editing.
  }
}

export function clearArtifactDraftJournal(studentId: string) {
  try {
    window.sessionStorage.removeItem(getArtifactDraftJournalKey(studentId));
  } catch {
    // Best-effort cleanup only.
  }
}

export function isRetryableArtifactSaveError(error: unknown) {
  const status = typeof error === "object" && error !== null && "status" in error
    ? Number((error as { status?: unknown }).status)
    : null;
  return status === null
    || !Number.isFinite(status)
    || status === 408
    || status === 429
    || status >= 500;
}

export function createArtifactSaveEventDetail({
  operationId,
  pending,
  previousCharacters,
  trigger,
}: {
  operationId: string;
  pending: PendingArtifactSave;
  previousCharacters: number;
  trigger: string;
}) {
  return {
    operation_id: operationId,
    task_id: pending.taskId,
    trigger,
    previous_characters: previousCharacters,
    current_characters: pending.value.length,
    delta_characters: pending.value.length - previousCharacters,
    artifact_length: pending.value.length,
  };
}

export function clientNowMs() {
  return typeof performance !== "undefined" ? performance.now() : Date.now();
}

export function isUserCancelledFilePicker(error: unknown) {
  return error instanceof Error && error.name === "AbortError";
}

export async function fetchGuideRequest(
  init: RequestInit,
  options: { stream?: boolean; signal?: AbortSignal } = {},
) {
  const headerTimeoutController = new AbortController();
  const timeout = setTimeout(() => headerTimeoutController.abort(), guideRequestTimeoutMs);
  const signals = [init.signal, options.signal, headerTimeoutController.signal]
    .filter((signal): signal is AbortSignal => Boolean(signal));
  const signal = signals.length === 1 ? signals[0] : AbortSignal.any(signals);
  try {
    return await fetch("/api/learning/ai-guide", {
      ...init,
      headers: {
        ...(options.stream ? { accept: "text/event-stream" } : {}),
        ...init.headers,
      },
      signal,
    });
  } finally {
    clearTimeout(timeout);
  }
}

export function getAaisCsrfHeader(): Record<string, string> {
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
