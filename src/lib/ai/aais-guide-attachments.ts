export const aaisGuideAttachmentLimits = {
  maxFiles: 3,
  maxFileSizeBytes: 2 * 1024 * 1024,
  maxExtractedTextCharacters: 12_000,
} as const;

export const aaisGuideAttachmentMediaTypes = [
  "text/plain",
  "text/markdown",
  "text/csv",
  "application/pdf",
] as const;

export type AaisGuideAttachmentMediaType = (typeof aaisGuideAttachmentMediaTypes)[number];

export type AaisGuideAttachment = {
  name: string;
  mediaType: AaisGuideAttachmentMediaType;
  sizeBytes: number;
  extractedText: string;
};

export function normalizeAaisGuideAttachments(value: unknown): AaisGuideAttachment[] {
  if (value == null) {
    return [];
  }
  if (!Array.isArray(value)) {
    throw new Error("Guide attachments must be an array.");
  }
  if (value.length > aaisGuideAttachmentLimits.maxFiles) {
    throw new Error(`Guide attachments are limited to ${aaisGuideAttachmentLimits.maxFiles} files.`);
  }

  let remainingCharacters = aaisGuideAttachmentLimits.maxExtractedTextCharacters;
  const normalizedAttachments: AaisGuideAttachment[] = [];

  for (const attachment of value) {
    const normalized = normalizeAaisGuideAttachment(attachment);
    if (remainingCharacters <= 0) {
      break;
    }
    const extractedText = normalized.extractedText.slice(0, remainingCharacters);
    remainingCharacters -= extractedText.length;
    normalizedAttachments.push({
      ...normalized,
      extractedText,
    });
  }

  return normalizedAttachments;
}

export function isAaisGuideAttachmentMediaType(
  value: string,
): value is AaisGuideAttachmentMediaType {
  return aaisGuideAttachmentMediaTypes.includes(value as AaisGuideAttachmentMediaType);
}

function normalizeAaisGuideAttachment(value: unknown): AaisGuideAttachment {
  if (!value || typeof value !== "object") {
    throw new Error("Guide attachment must be an object.");
  }

  const record = value as Record<string, unknown>;
  const name = sanitizeAttachmentName(record.name);
  const mediaType = normalizeAttachmentMediaType(record.mediaType);
  const sizeBytes = normalizeAttachmentSize(record.sizeBytes, name);
  const extractedText = normalizeExtractedText(record.extractedText, name);

  return {
    name,
    mediaType,
    sizeBytes,
    extractedText,
  };
}

function sanitizeAttachmentName(value: unknown) {
  const name = String(value ?? "").trim().replace(/[\\/\u0000-\u001f]+/g, "-");
  if (!name) {
    throw new Error("Guide attachment name is required.");
  }
  return name.slice(0, 160);
}

function normalizeAttachmentMediaType(value: unknown) {
  const mediaType = String(value ?? "").trim().toLowerCase();
  if (!isAaisGuideAttachmentMediaType(mediaType)) {
    throw new Error(`Unsupported guide attachment type: ${mediaType || "unknown"}.`);
  }
  return mediaType;
}

function normalizeAttachmentSize(value: unknown, name: string) {
  const sizeBytes = Number(value);
  if (!Number.isFinite(sizeBytes) || sizeBytes < 0) {
    throw new Error(`Guide attachment ${name} has an invalid size.`);
  }
  if (sizeBytes > aaisGuideAttachmentLimits.maxFileSizeBytes) {
    throw new Error(`Guide attachment ${name} exceeds 2 MB.`);
  }
  return Math.round(sizeBytes);
}

function normalizeExtractedText(value: unknown, name: string) {
  const extractedText = String(value ?? "").trim();
  if (!extractedText) {
    throw new Error(`Guide attachment ${name} has no readable text.`);
  }
  return extractedText;
}
