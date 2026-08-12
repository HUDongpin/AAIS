import { createElement, type ReactNode } from "react";
import { MathText } from "@/components/pages/learning/math-text";
import {
  admitAaisResearchAction,
  createAaisResearchOperationId,
} from "@/lib/client/aais-research-telemetry";

type SafeMarkdownBlock =
  | {
      type: "heading";
      level: 1 | 2 | 3 | 4 | 5 | 6;
      content: string;
    }
  | {
      type: "paragraph";
      lines: string[];
    }
  | {
      type: "ordered-list" | "unordered-list";
      items: string[];
    }
  | {
      type: "blockquote";
      lines: string[];
    };

export function SafeMarkdownText({ text }: { text: string }) {
  const blocks = parseSafeMarkdownBlocks(text);

  return (
    <>
      {blocks.map((block, blockIndex) => {
        const spacingClassName = blockIndex > 0 ? "mt-2" : "";
        if (block.type === "heading") {
          const headingClassName = [
            "font-semibold leading-snug",
            block.level === 1
              ? "text-[1.35em]"
              : block.level === 2
                ? "text-[1.2em]"
                : "text-[1.08em]",
            spacingClassName,
          ]
            .filter(Boolean)
            .join(" ");
          return createElement(
            `h${block.level}`,
            {
              className: headingClassName,
              key: `heading-${blockIndex}`,
            },
            renderSafeMarkdownInline(block.content, `heading-${blockIndex}`),
          );
        }
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

        if (block.type === "blockquote") {
          return (
            <blockquote
              key={`blockquote-${blockIndex}`}
              className={[
                "border-l-4 border-[#cfd8ec] pl-4 text-[#59657a]",
                "whitespace-pre-line",
                spacingClassName,
              ].filter(Boolean).join(" ")}
            >
              {renderSafeMarkdownInline(block.lines.join("\n"), `blockquote-${blockIndex}`)}
            </blockquote>
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
    const heading = line.match(/^\s*(#{1,6})\s+(.+?)\s*$/);
    const blockquoteLine = parseSafeMarkdownBlockquoteLine(line);

    if (!line.trim()) {
      flushParagraph();
      lineIndex += 1;
      continue;
    }

    if (heading) {
      flushParagraph();
      blocks.push({
        type: "heading",
        level: heading[1].length as 1 | 2 | 3 | 4 | 5 | 6,
        content: heading[2],
      });
      lineIndex += 1;
      continue;
    }

    if (blockquoteLine !== null) {
      const lines: string[] = [];
      flushParagraph();

      while (lineIndex < normalizedLines.length) {
        const nextLine = parseSafeMarkdownBlockquoteLine(normalizedLines[lineIndex] ?? "");
        if (nextLine === null) {
          break;
        }

        lines.push(nextLine);
        lineIndex += 1;
      }

      blocks.push({
        type: "blockquote",
        lines,
      });
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

function parseSafeMarkdownBlockquoteLine(line: string) {
  const match = line.match(/^\s*>\s?(.*)$/);
  return match ? match[1] : null;
}

function renderSafeMarkdownInline(text: string, keyPrefix: string): ReactNode[] {
  const nodes: ReactNode[] = [];
  const inlinePattern = /`([^`\n]+)`|\$\$([\s\S]+?)\$\$|\\\[([\s\S]+?)\\\]|\\\(([\s\S]+?)\\\)|(?<!\\)\$([^\s$](?:[^$\n]*?[^\s$])?)\$|\*\*([\s\S]+?)\*\*|__([\s\S]+?)__|(?<![\\*])\*([^*\n]+?)\*(?!\*)|\[([^\]\n]+)\]\(([^)\s]+)\)/g;
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
      emphasisAsterisk,
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
    } else if (emphasisAsterisk !== undefined) {
      nodes.push(
        <em key={key}>
          {renderSafeMarkdownInline(emphasisAsterisk, key)}
        </em>,
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
