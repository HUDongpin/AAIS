import type { ReactNode } from "react";
import type { AaisGuideAttachment } from "@/lib/ai/aais-guide-attachments";
import {
  localizeAaisGuideAgentReferences,
  localizeAaisGuideTargetMentions,
} from "@/lib/ai/aais-guide-targets";
import type { Locale } from "@/data/aais";
import {
  admitAaisResearchAction,
  createAaisResearchOperationId,
} from "@/lib/client/aais-research-telemetry";
import {
  visibleGuideAgentIds,
} from "@/components/pages/learning/learning-page-constants";
import {
  getGuideAgentLabel,
  getLearningCopy,
} from "@/components/pages/learning/learning-copy";
import { MathText } from "@/components/pages/learning/math-text";
import type {
  GuideClientAttachment,
  GuideMessage,
  GuideTurn,
} from "@/components/pages/learning/learning-page-types";

type GuideAgentAvatarVariant = "guide" | "expert";

type SafeMarkdownBlock =
  | {
      type: "paragraph";
      lines: string[];
    }
  | {
      type: "ordered-list" | "unordered-list";
      items: string[];
    };

const guideAgentPresentation: Record<
  string,
  {
    label: string;
    avatarVariant: GuideAgentAvatarVariant;
    avatarClassName: string;
    bubbleClassName: string;
  }
> = {
  A1: {
    label: "小张",
    avatarVariant: "guide",
    avatarClassName:
      "border-[#d8e0ca] bg-[#f5f8ef] text-[#4c5b32] shadow-[0_4px_12px_rgba(76,91,50,0.12)]",
    bubbleClassName: "border-[#dfe7d2] bg-white",
  },
  A2: {
    label: "教授",
    avatarVariant: "expert",
    avatarClassName:
      "border-[#d7e3f6] bg-[#f4f8fd] text-[#1f4f86] shadow-[0_4px_12px_rgba(31,79,134,0.14)]",
    bubbleClassName: "border-[#dedaff] bg-[#fbfaff]",
  },
};

export function toGuideAttachmentPayload(attachment: GuideClientAttachment): AaisGuideAttachment {
  return {
    name: attachment.name,
    mediaType: attachment.mediaType,
    sizeBytes: attachment.sizeBytes,
    extractedText: attachment.extractedText,
  };
}

export function formatGuideAttachmentSize(sizeBytes: number) {
  if (sizeBytes < 1024) {
    return `${sizeBytes} B`;
  }
  if (sizeBytes < 1024 * 1024) {
    return `${(sizeBytes / 1024).toFixed(1)} KB`;
  }
  return `${(sizeBytes / (1024 * 1024)).toFixed(1)} MB`;
}

export function GuideBubble({
  locale = "zh-CN",
  message,
}: {
  locale?: Locale;
  message: GuideMessage;
}) {
  const copy = getLearningCopy(locale);
  const assistant = message.kind === "assistant";
  const visibleMessageText = assistant
    ? localizeAaisGuideAgentReferences(message.text, locale)
    : localizeAaisGuideTargetMentions(message.text, locale);
  const visibleTurns = getVisibleGuideTurns(message.turns);
  if (assistant && visibleTurns.length) {
    return (
      <div className="space-y-3">
        {message.runtime?.fallback ? (
          <p className="inline-flex rounded-full border border-[#f2d6a2] bg-[#fff8ed] px-3 py-1 text-xs font-bold text-[#8a5a12]">
            {copy.guide.offlineScaffold}
          </p>
        ) : null}
        {visibleTurns.map((turn) => (
          <AgentTurnBubble key={`${message.id}-${turn.agentId}`} locale={locale} turn={turn} />
        ))}
      </div>
    );
  }

  return (
    <div className={assistant ? "flex items-start gap-3" : "flex justify-end"}>
      {assistant ? (
        <AgentAvatar agentId="A1" label={getGuideAgentLabel(locale, "A1")} locale={locale} />
      ) : null}
      <div
        className={[
          "rounded-[18px] px-5 py-4 text-[17px] leading-8 shadow-[0_6px_18px_rgba(17,24,39,0.05)]",
          assistant
            ? "max-w-[760px] border border-[#e3e6ef] bg-white text-[#30343b]"
            : "max-w-[640px] bg-[#536de8] text-white",
        ].join(" ")}
      >
        {assistant ? (
          <p className="mb-2 text-sm font-medium text-[#9aa0ad]">{copy.guide.assistant}</p>
        ) : null}
        {assistant && message.runtime?.fallback ? (
          <p className="mb-2 inline-flex rounded-full border border-[#f2d6a2] bg-[#fff8ed] px-3 py-1 text-xs font-bold text-[#8a5a12]">
            {copy.guide.offlineScaffold}
          </p>
        ) : null}
        <SafeMarkdownText text={visibleMessageText} />
      </div>
    </div>
  );
}

function AgentTurnBubble({ locale, turn }: { locale: Locale; turn: GuideTurn }) {
  const presentation = getAgentPresentation(turn, locale);
  return (
    <div className="flex items-start gap-3">
      <AgentAvatar agentId={turn.agentId} label={presentation.label} locale={locale} />
      <article
        className={[
          "max-w-[760px] rounded-[18px] px-5 py-4 text-[17px] leading-8 text-[#30343b] shadow-[0_6px_18px_rgba(17,24,39,0.05)]",
          presentation.bubbleClassName,
        ].join(" ")}
      >
        <p className="mb-2 text-sm font-semibold text-[#59657a]">
          {presentation.label}
        </p>
        <SafeMarkdownText text={localizeAaisGuideAgentReferences(turn.content, locale)} />
      </article>
    </div>
  );
}

function SafeMarkdownText({ text }: { text: string }) {
  const blocks = parseSafeMarkdownBlocks(text);

  return (
    <>
      {blocks.map((block, blockIndex) => {
        const spacingClassName = blockIndex > 0 ? "mt-2" : "";
        if (block.type === "paragraph") {
          return (
            <p
              key={`paragraph-${blockIndex}`}
              className={["whitespace-pre-line", spacingClassName].filter(Boolean).join(" ")}
            >
              {renderSafeMarkdownInline(block.lines.join("\n"), `paragraph-${blockIndex}`)}
            </p>
          );
        }

        const ListTag = block.type === "ordered-list" ? "ol" : "ul";
        const listClassName = [
          block.type === "ordered-list" ? "list-decimal" : "list-disc",
          "space-y-1 pl-6",
          spacingClassName,
        ]
          .filter(Boolean)
          .join(" ");

        return (
          <ListTag key={`${block.type}-${blockIndex}`} className={listClassName}>
            {block.items.map((item, itemIndex) => (
              <li key={`${block.type}-${blockIndex}-${itemIndex}`}>
                {renderSafeMarkdownInline(item, `${block.type}-${blockIndex}-${itemIndex}`)}
              </li>
            ))}
          </ListTag>
        );
      })}
    </>
  );
}

function parseSafeMarkdownBlocks(text: string): SafeMarkdownBlock[] {
  const normalizedLines = text.replace(/\r\n?/g, "\n").split("\n");
  const blocks: SafeMarkdownBlock[] = [];
  let paragraphLines: string[] = [];
  let lineIndex = 0;

  function flushParagraph() {
    if (!paragraphLines.some((line) => line.trim())) {
      paragraphLines = [];
      return;
    }

    blocks.push({
      type: "paragraph",
      lines: paragraphLines,
    });
    paragraphLines = [];
  }

  while (lineIndex < normalizedLines.length) {
    const line = normalizedLines[lineIndex] ?? "";
    const listItem = parseSafeMarkdownListItem(line);

    if (!line.trim()) {
      flushParagraph();
      lineIndex += 1;
      continue;
    }

    if (listItem) {
      const items: string[] = [];
      flushParagraph();

      while (lineIndex < normalizedLines.length) {
        const nextItem = parseSafeMarkdownListItem(normalizedLines[lineIndex] ?? "");
        if (!nextItem || nextItem.type !== listItem.type) {
          break;
        }

        items.push(nextItem.content);
        lineIndex += 1;
      }

      blocks.push({
        type: listItem.type,
        items,
      });
      continue;
    }

    paragraphLines.push(line);
    lineIndex += 1;
  }

  flushParagraph();

  return blocks;
}

function parseSafeMarkdownListItem(line: string) {
  const orderedMatch = line.match(/^\s*\d+\.\s+(.+)$/);
  if (orderedMatch) {
    return {
      type: "ordered-list" as const,
      content: orderedMatch[1],
    };
  }

  const unorderedMatch = line.match(/^\s*[-*]\s+(.+)$/);
  if (unorderedMatch) {
    return {
      type: "unordered-list" as const,
      content: unorderedMatch[1],
    };
  }

  return null;
}

function renderSafeMarkdownInline(text: string, keyPrefix: string): ReactNode[] {
  const nodes: ReactNode[] = [];
  const inlinePattern = /`([^`\n]+)`|\$\$([\s\S]+?)\$\$|\\\[([\s\S]+?)\\\]|\\\(([\s\S]+?)\\\)|(?<!\\)\$([^\s$](?:[^$\n]*?[^\s$])?)\$|\*\*([\s\S]+?)\*\*|__([\s\S]+?)__|\[([^\]\n]+)\]\(([^)\s]+)\)/g;
  let lastIndex = 0;
  let match: RegExpExecArray | null;

  while ((match = inlinePattern.exec(text)) !== null) {
    if (match.index > lastIndex) {
      nodes.push(text.slice(lastIndex, match.index));
    }

    const [
      token,
      code,
      displayDollar,
      displayBracket,
      inlineParentheses,
      inlineDollar,
      strongAsterisk,
      strongUnderscore,
      linkLabel,
      linkHref,
    ] = match;
    const key = `${keyPrefix}-${match.index}`;

    if (code !== undefined) {
      nodes.push(
        <code key={key} className="rounded bg-black/5 px-1 py-0.5 font-mono text-[0.92em]">
          {code}
        </code>,
      );
    } else if (displayDollar !== undefined || displayBracket !== undefined) {
      nodes.push(
        <MathText key={key} displayMode tex={displayDollar ?? displayBracket ?? ""} />,
      );
    } else if (inlineParentheses !== undefined || inlineDollar !== undefined) {
      nodes.push(
        <MathText key={key} tex={inlineParentheses ?? inlineDollar ?? ""} />,
      );
    } else if (strongAsterisk !== undefined || strongUnderscore !== undefined) {
      const strongText = strongAsterisk ?? strongUnderscore ?? "";
      nodes.push(
        <strong key={key} className="font-semibold">
          {renderSafeMarkdownInline(strongText, key)}
        </strong>,
      );
    } else if (linkLabel !== undefined && linkHref !== undefined) {
      const safeHref = getSafeMarkdownHref(linkHref);
      if (safeHref) {
        nodes.push(
          <a
            key={key}
            className="font-medium underline decoration-current/40 underline-offset-4"
            href={safeHref}
            onClick={(event) => {
              const parsedUrl = new URL(safeHref);
              if (!admitAaisResearchAction({
                eventName: "guide_response_link_opened",
                outcome: "success",
                detail: {
                  operation_id: createAaisResearchOperationId("guide-link"),
                  source: "ai_response",
                  link_protocol: parsedUrl.protocol,
                  ...(parsedUrl.hostname
                    ? {
                        link_host: parsedUrl.hostname === "aais.site"
                          || parsedUrl.hostname.endsWith(".aais.site")
                          ? "aais_site"
                          : "external",
                      }
                    : {}),
                },
              })) {
                event.preventDefault();
              }
            }}
            rel="noreferrer"
            target="_blank"
          >
            {renderSafeMarkdownInline(linkLabel, key)}
          </a>,
        );
      } else {
        nodes.push(token);
      }
    } else {
      nodes.push(token);
    }

    lastIndex = match.index + token.length;
  }

  if (lastIndex < text.length) {
    nodes.push(text.slice(lastIndex));
  }

  return nodes;
}

function getSafeMarkdownHref(href: string) {
  try {
    const parsedUrl = new URL(href);
    if (["http:", "https:", "mailto:"].includes(parsedUrl.protocol)) {
      return href;
    }
  } catch {
    return null;
  }

  return null;
}

function AgentAvatar({
  agentId,
  label,
  locale,
}: {
  agentId: string;
  label: string;
  locale: Locale;
}) {
  const presentation = guideAgentPresentation[agentId] ?? guideAgentPresentation.A1;
  const avatarLabel = getLearningCopy(locale).guide.avatar(agentId, label);
  return (
    <span
      aria-label={avatarLabel}
      role="img"
      title={avatarLabel}
      className={[
        "mt-1 grid size-10 shrink-0 place-items-center overflow-hidden rounded-full border",
        presentation.avatarClassName,
      ].join(" ")}
    >
      <AgentAvatarGraphic variant={presentation.avatarVariant} />
    </span>
  );
}

function AgentAvatarGraphic({ variant }: { variant: GuideAgentAvatarVariant }) {
  if (variant === "expert") {
    return (
      <svg aria-hidden="true" className="size-8" focusable="false" viewBox="0 0 40 40">
        <path d="M6.5 15.2c2.7-7 10.6-10.5 17.9-8.9 5.5 1.2 8.7 5.1 9.3 10.1.8 6.5-4.5 13.5-12.8 14.9-8.5 1.5-16.4-4.5-14.4-16.1Z" data-avatar-part="watercolor-wash" fill="#d9e8f7" fillOpacity={0.72} />
        <path d="M8.8 10.7h7.7m-7.7 3.3h5.6m-5.6 3.3h7.1m14.2 1.3v-5.8m-3.6 5.8v-3.9m-3.6 3.9v-7.6" data-avatar-part="research-chart" fill="none" stroke="#8ab1d8" strokeLinecap="round" strokeWidth="1" />
        <path d="M12.7 17.1c.3-5.7 4-8.9 8.2-8.9 4.6 0 7.7 3.4 8 8.9l-2.1 4.8H14.7l-2-4.8Z" data-avatar-part="hair" fill="#8a562b" />
        <circle cx="20.6" cy="19.8" data-avatar-part="face" fill="#ffe2bd" r="9" stroke="#9f7448" strokeWidth="1.1" />
        <path d="M12.8 16.8c1.8-5.1 5.2-7.2 8.8-6.8 3.4.4 5.8 2.8 6.9 7.1-4-1.4-8.2-1.7-15.7-.3Z" fill="#a46b36" />
        <path d="M14.9 19.2h4.2v2.7h-4.2v-2.7Zm6.2 0h4.2v2.7h-4.2v-2.7Zm-2 .9h2" data-avatar-part="expert-glasses" fill="none" stroke="#36506f" strokeLinecap="round" strokeLinejoin="round" strokeWidth="1.25" />
        <path d="M17.7 25.9c1.6 1.1 3.8 1.1 5.6 0" fill="none" stroke="#8a3a28" strokeLinecap="round" strokeWidth="1.15" />
        <path d="M12.1 33.7c.9-4.5 4.6-7 8.4-7 4.2 0 7.5 2.8 8.3 7H12.1Z" data-avatar-part="expert-blazer" fill="#1f4f86" stroke="#173a66" strokeLinejoin="round" strokeWidth="1" />
        <path d="m17.5 27.3 3.1 3.4 3-3.4" fill="#fff7e8" stroke="#d9caa8" strokeLinejoin="round" strokeWidth=".9" />
        <path d="M28.2 12.5 33.6 7" data-avatar-part="lecture-pointer" fill="none" stroke="#3d3d3d" strokeLinecap="round" strokeWidth="1.35" />
        <path d="M27.7 31.2h5.2l.8-5.4h-5.2l-.8 5.4Z" data-avatar-part="lecture-tablet" fill="#3f5164" stroke="#263746" strokeLinejoin="round" strokeWidth=".8" />
      </svg>
    );
  }

  return (
    <svg aria-hidden="true" className="size-8" focusable="false" viewBox="0 0 40 40">
      <path d="M7.3 15.7c2.7-7.1 10.2-10.6 17.4-9.1 6.8 1.5 10.1 7.9 7.5 14.7-2.5 6.7-10.3 10.7-17.7 9-6.5-1.5-9.8-7.9-7.2-14.6Z" data-avatar-part="watercolor-wash" fill="#dfead0" fillOpacity={0.76} />
      <circle cx="20" cy="17.8" data-avatar-part="face" fill="#ffe5c8" r="8.6" stroke="#6d7448" strokeWidth="1.05" />
      <path d="M12.2 15.9c1-5.2 5.2-7.3 9.5-6.6 3.2.5 5.3 2.7 6 6.5-4.6-1.6-8.8-1.8-15.5.1Z" data-avatar-part="hair" fill="#4f5833" />
      <circle cx="16.8" cy="18.9" data-avatar-part="eye" fill="#2f3c23" r="1" />
      <circle cx="23.2" cy="18.9" data-avatar-part="eye" fill="#2f3c23" r="1" />
      <path d="M17.4 23c1.6 1.1 3.6 1.1 5.2 0" fill="none" stroke="#7c3f20" strokeLinecap="round" strokeWidth="1.15" />
      <path d="M11.5 33.8c.9-4.6 4.5-7.4 8.6-7.4 4 0 7.2 2.8 8.2 7.4H11.5Z" data-avatar-part="advisor-blazer" fill="#657744" stroke="#46532f" strokeLinejoin="round" strokeWidth="1" />
      <path d="m16.7 27.2 3.2 3.3 3.1-3.3" fill="#fff9ec" stroke="#d8ceb2" strokeLinejoin="round" strokeWidth=".9" />
      <path d="M10.2 25.4c2.5-.7 5.3-.3 8 1.3v7.2c-2.5-1.5-5.2-2-8-1.4v-7.1Zm19.6 0c-2.5-.7-5.3-.3-8 1.3v7.2c2.5-1.5 5.2-2 8-1.4v-7.1Z" data-avatar-part="advisor-book" fill="#fffaf0" stroke="#55623a" strokeLinejoin="round" strokeWidth="1" />
      <path d="M18.2 26.7c.8.5 1.4.9 1.8 1.4.4-.5 1-.9 1.8-1.4" fill="none" stroke="#87965f" strokeLinecap="round" strokeWidth=".9" />
    </svg>
  );
}

export function getVisibleGuideTurns(turns?: GuideTurn[]) {
  return turns?.filter((turn) =>
    visibleGuideAgentIds.includes(turn.agentId as (typeof visibleGuideAgentIds)[number]),
  ) ?? [];
}

function getAgentPresentation(turn: GuideTurn, locale: Locale) {
  const canonicalVisibleLabel = visibleGuideAgentIds.includes(
    turn.agentId as (typeof visibleGuideAgentIds)[number],
  )
    ? getGuideAgentLabel(locale, turn.agentId)
    : null;
  return {
    ...(guideAgentPresentation[turn.agentId] ?? guideAgentPresentation.A1),
    label: canonicalVisibleLabel || turn.label || getGuideAgentLabel(locale, turn.agentId),
  };
}
