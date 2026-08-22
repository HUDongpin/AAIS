export class AaisExternalResponseTooLargeError extends Error {
  constructor(message = "AAIS external response is too large.") {
    super(message);
    this.name = "AaisExternalResponseTooLargeError";
  }
}

export async function readAaisBoundedResponseBytes(
  response: Response,
  maxBytes: number,
  tooLargeMessage = "AAIS external response is too large.",
) {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1) {
    throw new TypeError("AAIS external response byte limit is invalid.");
  }

  const declaredLengthText = response.headers.get("content-length");
  if (declaredLengthText !== null) {
    const declaredLength = Number(declaredLengthText);
    if (Number.isFinite(declaredLength) && declaredLength > maxBytes) {
      await response.body?.cancel().catch(() => undefined);
      throw new AaisExternalResponseTooLargeError(tooLargeMessage);
    }
  }

  if (!response.body) {
    return new Uint8Array();
  }

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let byteLength = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }
      byteLength += value.byteLength;
      if (byteLength > maxBytes) {
        await reader.cancel().catch(() => undefined);
        throw new AaisExternalResponseTooLargeError(tooLargeMessage);
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }

  const bytes = new Uint8Array(byteLength);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

export async function readAaisBoundedResponseJson(
  response: Response,
  maxBytes: number,
  tooLargeMessage = "AAIS external JSON response is too large.",
): Promise<unknown> {
  const bytes = await readAaisBoundedResponseBytes(response, maxBytes, tooLargeMessage);
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new Error("AAIS external JSON response is not valid UTF-8.");
  }
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new Error("AAIS external response is not valid JSON.");
  }
}
