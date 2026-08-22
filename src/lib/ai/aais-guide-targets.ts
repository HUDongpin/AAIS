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

/** Select exactly one visible responder; A2 is opt-in through a supported @ mention. */
export function selectAaisGuideReplyAgentIds(text: string): AaisGuideTargetAgentId[] {
  const mentionedTargetIds = parseAaisGuideTargetAgentIds(text);
  return [mentionedTargetIds.includes("A2") ? "A2" : "A1"];
}

function resolveAaisGuideTargetMention(match: RegExpExecArray) {
  if (match[2]) {
    return `A${match[2]}` as AaisGuideTargetAgentId;
  }

  return aaisGuideTargetHandleAliases[match[1].toLowerCase().replace(/\s+/g, " ")];
}
