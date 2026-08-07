import {
  defaultTaskId,
  documentDownloadContentType,
} from "@/components/pages/learning/learning-page-constants";
import { getLearningCopy } from "@/components/pages/learning/learning-copy";
import type { SavedLearningDocument } from "@/components/pages/learning/learning-page-types";
import type { Locale } from "@/data/aais";

type MarkdownFileHandle = {
  createWritable: () => Promise<{
    write: (data: Blob) => Promise<void> | void;
    close: () => Promise<void> | void;
  }>;
};

type WindowWithSaveFilePicker = Window & {
  showSaveFilePicker?: (options: {
    suggestedName: string;
    types: Array<{
      description: string;
      accept: Record<string, string[]>;
    }>;
  }) => Promise<MarkdownFileHandle>;
};

export function createHistoryDocument({
  taskId,
  title,
  html,
  locale = "zh-CN",
}: {
  taskId: string;
  title: string;
  html: string;
  locale?: Locale;
}): SavedLearningDocument {
  const markdown = createLearningDocumentMarkdown(html);
  const savedAt = new Date();
  return {
    id: `${taskId || defaultTaskId}-${savedAt.getTime()}`,
    taskId: taskId || defaultTaskId,
    title: normalizeDocumentTitle(title, markdown, locale),
    html,
    markdown,
    savedAt,
  };
}

export function mergeHistoryDocument(
  documents: SavedLearningDocument[],
  savedDocument: SavedLearningDocument,
  activeDocumentId: string | null,
) {
  const activeDocument = activeDocumentId
    ? documents.find((document) => document.id === activeDocumentId)
    : null;
  if (!activeDocument) {
    return [savedDocument, ...documents];
  }
  return documents.map((document) =>
    document.id === activeDocument.id
      ? {
          ...savedDocument,
          id: activeDocument.id,
          taskId: activeDocument.taskId,
        }
      : document,
  );
}

export function formatHistoryDocumentTime(savedAt: Date, locale: Locale = "zh-CN") {
  const elapsedMs = Date.now() - savedAt.getTime();
  if (elapsedMs < 60_000) {
    return getLearningCopy(locale).document.justSaved;
  }
  return savedAt.toLocaleString(locale === "en-US" ? "en-US" : "zh-Hans-CN", {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });
}

export function createLearningDocumentMarkdown(artifactText: string) {
  const source = artifactText.trim();
  if (!source) {
    return "";
  }
  const markdown = containsHtmlTag(source)
    ? htmlToMarkdown(sanitizeEditorHtml(source))
    : decodeHtmlEntities(source);
  return `${normalizeMarkdown(markdown)}\n`;
}

export async function saveMarkdownDocumentToLocal({
  fileName,
  markdown,
}: {
  fileName: string;
  markdown: string;
}) {
  const blob = new Blob([markdown], { type: documentDownloadContentType });
  const saveFilePicker =
    typeof window === "undefined"
      ? undefined
      : (window as WindowWithSaveFilePicker).showSaveFilePicker;

  if (saveFilePicker) {
    const fileHandle = await saveFilePicker({
      suggestedName: fileName,
      types: [
        {
          description: "Markdown document",
          accept: {
            "text/markdown": [".md"],
          },
        },
      ],
    });
    const writable = await fileHandle.createWritable();
    await writable.write(blob);
    await writable.close();
    return;
  }

  downloadBlob(fileName, blob);
}

export async function saveJsonDocumentToLocal({
  fileName,
  data,
}: {
  fileName: string;
  data: unknown;
}) {
  const blob = new Blob([`${JSON.stringify(data, null, 2)}\n`], {
    type: "application/json;charset=utf-8",
  });
  const saveFilePicker =
    typeof window === "undefined"
      ? undefined
      : (window as WindowWithSaveFilePicker).showSaveFilePicker;

  if (saveFilePicker) {
    const fileHandle = await saveFilePicker({
      suggestedName: fileName,
      types: [
        {
          description: "JSON document",
          accept: {
            "application/json": [".json"],
          },
        },
      ],
    });
    const writable = await fileHandle.createWritable();
    await writable.write(blob);
    await writable.close();
    return;
  }

  downloadBlob(fileName, blob);
}

export function createLearningDocumentFileName(taskId: string) {
  return `aais-${sanitizeFileName(taskId || defaultTaskId)}-document.md`;
}

export function createLearnerDataFileName(studentId: string) {
  return `aais-${sanitizeFileName(studentId)}-learner-data.json`;
}

export function toEditableHtml(value: string) {
  if (!value) {
    return "";
  }
  if (containsHtmlTag(value)) {
    return sanitizeEditorHtml(value);
  }
  return escapeHtml(value).replace(/\n/g, "<br>");
}

export function sanitizeEditorHtml(value: string) {
  if (typeof document === "undefined") {
    return value;
  }
  const template = document.createElement("template");
  template.innerHTML = value;
  template.content.querySelectorAll("script, style").forEach((element) => element.remove());
  template.content.querySelectorAll("*").forEach((element) => {
    Array.from(element.attributes).forEach((attribute) => {
      const attributeName = attribute.name.toLowerCase();
      if (attributeName.startsWith("on") || attributeName === "style") {
        element.removeAttribute(attribute.name);
        return;
      }
      if (
        attributeName === "align"
        && !["left", "center", "right"].includes(attribute.value.toLowerCase())
      ) {
        element.removeAttribute(attribute.name);
      }
    });
  });
  return template.innerHTML;
}

function escapeHtml(value: string) {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function normalizeDocumentTitle(title: string, markdown: string, locale: Locale) {
  const explicitTitle = title.trim();
  if (explicitTitle) {
    return explicitTitle;
  }
  const firstMarkdownHeading = markdown.match(/^#{1,6}\s+(.+)$/m)?.[1]?.trim();
  if (firstMarkdownHeading) {
    return firstMarkdownHeading;
  }
  const firstContentLine = markdown.split("\n").find((line) => line.trim())?.trim();
  return firstContentLine?.slice(0, 24) || getLearningCopy(locale).document.untitled;
}

function sanitizeFileName(value: string) {
  return value.trim().replace(/[^\w.-]+/g, "_").replace(/^_+|_+$/g, "") || defaultTaskId;
}

function downloadBlob(fileName: string, blob: Blob) {
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = fileName;
  document.body.appendChild(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
}

function htmlToMarkdown(html: string) {
  if (typeof document === "undefined") {
    return stripHtmlTags(html);
  }
  const template = document.createElement("template");
  template.innerHTML = html;
  return renderMarkdownNodes(template.content.childNodes);
}

function renderMarkdownNodes(nodes: ArrayLike<ChildNode>) {
  return Array.from(nodes).map(renderMarkdownNode).join("");
}

function renderMarkdownNode(node: ChildNode): string {
  if (node.nodeType === Node.TEXT_NODE) {
    return node.textContent ?? "";
  }
  if (node.nodeType !== Node.ELEMENT_NODE) {
    return "";
  }

  const element = node as HTMLElement;
  const tagName = element.tagName.toLowerCase();

  switch (tagName) {
    case "br":
      return "\n";
    case "h1":
    case "h2":
    case "h3":
    case "h4":
    case "h5":
    case "h6": {
      const level = Number(tagName.slice(1));
      return `\n\n${"#".repeat(level)} ${renderInlineMarkdown(element)}\n\n`;
    }
    case "p":
    case "div":
      return `\n\n${renderMarkdownNodes(element.childNodes)}\n\n`;
    case "ul":
      return renderMarkdownList(element, false);
    case "ol":
      return renderMarkdownList(element, true);
    case "strong":
    case "b":
      return wrapMarkdownInline("**", renderMarkdownNodes(element.childNodes));
    case "em":
    case "i":
      return wrapMarkdownInline("*", renderMarkdownNodes(element.childNodes));
    case "code":
      return `\`${(element.textContent ?? "").replace(/`/g, "\\`")}\``;
    case "pre":
      return `\n\n\`\`\`\n${element.textContent?.trimEnd() ?? ""}\n\`\`\`\n\n`;
    case "a": {
      const href = element.getAttribute("href");
      const label = renderInlineMarkdown(element) || href;
      return href && label ? `[${label}](${href})` : label ?? "";
    }
    default:
      return renderMarkdownNodes(element.childNodes);
  }
}

function renderInlineMarkdown(element: HTMLElement) {
  return normalizeInlineMarkdown(renderMarkdownNodes(element.childNodes));
}

function renderMarkdownList(element: HTMLElement, ordered: boolean) {
  const listItems = Array.from(element.children).filter(
    (child): child is HTMLElement => child.tagName.toLowerCase() === "li",
  );
  if (!listItems.length) {
    return renderMarkdownNodes(element.childNodes);
  }
  const lines = listItems.map((item, index) => {
    const marker = ordered ? `${index + 1}.` : "-";
    const content = normalizeMarkdown(renderMarkdownNodes(item.childNodes)).replace(/\n/g, "\n  ");
    return `${marker} ${content}`;
  });
  return `\n\n${lines.join("\n")}\n\n`;
}

function wrapMarkdownInline(marker: string, value: string) {
  const content = normalizeInlineMarkdown(value);
  return content ? `${marker}${content}${marker}` : "";
}

function normalizeMarkdown(value: string) {
  return value
    .replace(/\u00a0/g, " ")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function normalizeInlineMarkdown(value: string) {
  return value.replace(/\s+/g, " ").trim();
}

function decodeHtmlEntities(value: string) {
  if (typeof document === "undefined") {
    return value;
  }
  const textarea = document.createElement("textarea");
  textarea.innerHTML = value;
  return textarea.value;
}

function stripHtmlTags(value: string) {
  return value.replace(/<br\s*\/?>/gi, "\n").replace(/<[^>]+>/g, "");
}

function containsHtmlTag(value: string) {
  return /<\/?[a-z][\s\S]*>/i.test(value);
}
