export const aaisGuideTargetAgentIds = ["A1", "A2"] as const;

export type AaisGuideTargetAgentId = (typeof aaisGuideTargetAgentIds)[number];

const aaisGuideTargetHandleAliases: Record<string, AaisGuideTargetAgentId> = {
  小张: "A1",
  "xiao zhang": "A1",
  导学智能体: "A1",
  教授: "A2",
  professor: "A2",
  专家智能体: "A2",
};

export function parseAaisGuideTargetAgentIds(text: string) {
  const targetIds: AaisGuideTargetAgentId[] = [];
  const mentionPattern = /@(A\s*([12])(?!\d)|Xiao\s+Zhang\b|小张|教授|Professor\b|导学智能体|专家智能体)/gi;
  let match: RegExpExecArray | null;

  while ((match = mentionPattern.exec(text)) !== null) {
    const targetId = resolveAaisGuideTargetMention(match);
    if (!targetIds.includes(targetId)) {
      targetIds.push(targetId);
    }
  }

  return targetIds;
}

export function localizeAaisGuideAgentReferences(
  text: string,
  locale: "zh-CN" | "en-US",
) {
  const a1Name = locale === "zh-CN" ? "小张" : "Xiao Zhang";
  const a2Name = locale === "zh-CN" ? "教授" : "Professor";
  const localizedText = text
    .replace(/(?:A1\s*(?:小张|Xiao Zhang)|(?:小张|Xiao Zhang)\s*[（(]?\s*A1\s*[）)]?)/gi, a1Name)
    .replace(/(?:A2\s*(?:教授|Professor)|(?:教授|Professor)\s*[（(]?\s*A2\s*[）)]?)/gi, a2Name)
    .replace(/\bA1\b/gi, a1Name)
    .replace(/\bA2\b/gi, a2Name);
  return locale === "zh-CN"
    ? localizedText.replace(/(小张|教授)\s+(?=[\u3400-\u9fff])/g, "$1")
    : localizedText;
}

export function localizeAaisGuideTargetMentions(
  text: string,
  locale: "zh-CN" | "en-US",
) {
  const a1Handle = locale === "zh-CN" ? "@小张" : "@Xiao Zhang";
  const a2Handle = locale === "zh-CN" ? "@教授" : "@Professor";
  return text
    .replace(/@A\s*1\b/gi, a1Handle)
    .replace(/@A\s*2\b/gi, a2Handle);
}

export function normalizeAaisGuideTargetAgentIds(
  targetAgentIds?: readonly string[] | null,
  fallbackText = "",
) {
  const explicitTargetIds = coerceTargetAgentIds(targetAgentIds);
  if (explicitTargetIds.length) {
    return explicitTargetIds;
  }

  const mentionedTargetIds = parseAaisGuideTargetAgentIds(fallbackText);
  return mentionedTargetIds.length ? mentionedTargetIds : undefined;
}

export function resolveAaisGuideTargetAgentIds(targetAgentIds?: readonly string[] | null) {
  const resolvedTargetIds = coerceTargetAgentIds(targetAgentIds);
  return resolvedTargetIds.length ? resolvedTargetIds : [...aaisGuideTargetAgentIds];
}

function coerceTargetAgentIds(targetAgentIds?: readonly string[] | null) {
  const coercedTargetIds: AaisGuideTargetAgentId[] = [];
  if (!targetAgentIds?.length) {
    return coercedTargetIds;
  }

  for (const targetAgentId of targetAgentIds) {
    const normalizedTargetId = targetAgentId.toUpperCase().replace(/\s+/g, "");
    if (
      isAaisGuideTargetAgentId(normalizedTargetId) &&
      !coercedTargetIds.includes(normalizedTargetId)
    ) {
      coercedTargetIds.push(normalizedTargetId);
    }
  }

  return coercedTargetIds;
}

function isAaisGuideTargetAgentId(value: string): value is AaisGuideTargetAgentId {
  return aaisGuideTargetAgentIds.includes(value as AaisGuideTargetAgentId);
}

function resolveAaisGuideTargetMention(match: RegExpExecArray) {
  if (match[2]) {
    return `A${match[2]}` as AaisGuideTargetAgentId;
  }

  return aaisGuideTargetHandleAliases[match[1].toLowerCase().replace(/\s+/g, " ")];
}
