export const aaisGuideTargetAgentIds = ["A1", "A2"] as const;

export type AaisGuideTargetAgentId = (typeof aaisGuideTargetAgentIds)[number];

const aaisGuideTargetHandleAliases: Record<string, AaisGuideTargetAgentId> = {
  导学智能体: "A1",
  专家智能体: "A2",
};

export function parseAaisGuideTargetAgentIds(text: string) {
  const targetIds: AaisGuideTargetAgentId[] = [];
  const mentionPattern = /@(A\s*([12])(?!\d)|导学智能体|专家智能体)/gi;
  let match: RegExpExecArray | null;

  while ((match = mentionPattern.exec(text)) !== null) {
    const targetId = resolveAaisGuideTargetMention(match);
    if (!targetIds.includes(targetId)) {
      targetIds.push(targetId);
    }
  }

  return targetIds;
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

  return aaisGuideTargetHandleAliases[match[1]];
}
