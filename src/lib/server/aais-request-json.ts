export class AaisRequestBodyError extends Error {
  constructor(
    readonly reason: "invalid" | "too_large",
    readonly status: 400 | 413,
  ) {
    super(reason === "too_large" ? "AAIS request body is too large." : "AAIS request body is invalid.");
    this.name = "AaisRequestBodyError";
  }
}

export async function readAaisBoundedJson(
  request: Request,
  {
    maxBytes,
    allowEmpty = false,
  }: {
    maxBytes: number;
    allowEmpty?: boolean;
  },
): Promise<unknown> {
  if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0) {
    throw new Error("AAIS request body limit is invalid.");
  }
  const declaredLength = request.headers.get("content-length")?.trim();
  if (declaredLength && /^\d+$/.test(declaredLength) && Number(declaredLength) > maxBytes) {
    throw new AaisRequestBodyError("too_large", 413);
  }
  if (!request.body) {
    throw new AaisRequestBodyError("invalid", 400);
  }

  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let totalBytes = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }
      totalBytes += value.byteLength;
      if (totalBytes > maxBytes) {
        await reader.cancel().catch(() => undefined);
        throw new AaisRequestBodyError("too_large", 413);
      }
      chunks.push(value);
    }
  } catch (error) {
    if (error instanceof AaisRequestBodyError) {
      throw error;
    }
    throw new AaisRequestBodyError("invalid", 400);
  } finally {
    reader.releaseLock();
  }

  const bytes = new Uint8Array(totalBytes);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  if (allowEmpty && totalBytes === 0) {
    return undefined;
  }
  try {
    const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    return JSON.parse(text) as unknown;
  } catch (error) {
    if (error instanceof AaisRequestBodyError) {
      throw error;
    }
    throw new AaisRequestBodyError("invalid", 400);
  }
}
