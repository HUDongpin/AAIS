type AaisApiErrorEnvelope = {
  error?: string | {
    code?: string;
    message?: string;
  } | null;
};

export function getAaisApiErrorMessage(
  body: AaisApiErrorEnvelope | null | undefined,
  fallback: string,
) {
  if (typeof body?.error === "string") {
    return body.error || fallback;
  }
  if (typeof body?.error?.message === "string") {
    return body.error.message || fallback;
  }
  return fallback;
}
