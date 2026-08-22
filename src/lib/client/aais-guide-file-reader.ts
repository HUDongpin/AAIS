import {
  aaisGuideAttachmentLimits,
  isAaisGuideAttachmentMediaType,
  type AaisGuideAttachment,
  type AaisGuideAttachmentMediaType,
} from "@/lib/ai/aais-guide-attachments";
import type { Locale } from "@/data/aais";
import { strFromU8, unzipSync } from "fflate";

export const aaisGuideFileAccept =
  ".txt,.md,.csv,.pdf,.docx,text/plain,text/markdown,text/csv,application/pdf,application/vnd.openxmlformats-officedocument.wordprocessingml.document";

export async function readAaisGuideFileAttachment(
  file: File,
  locale: Locale = "zh-CN",
): Promise<AaisGuideAttachment> {
  if (file.size > aaisGuideAttachmentLimits.maxFileSizeBytes) {
    throw createGuideFileError(locale, "tooLarge", file.name);
  }

  const mediaType = inferGuideAttachmentMediaType(file);
  if (!mediaType) {
    throw createGuideFileError(locale, "unsupported", file.name);
  }

  let extractedText: string;
  try {
    extractedText =
      mediaType === "application/pdf"
        ? await extractPdfText(file)
        : mediaType === "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
          ? await extractDocxText(file, locale)
          : await extractTextFile(file);
  } catch (error) {
    if (error instanceof AaisGuideFileReadError) {
      throw error;
    }
    throw createGuideFileError(locale, "unreadable", file.name);
  }
  const normalizedText = extractedText
    .trim()
    .slice(0, aaisGuideAttachmentLimits.maxExtractedTextCharacters);
  if (!normalizedText) {
    throw createGuideFileError(locale, "noText", file.name);
  }

  return {
    name: file.name,
    mediaType,
    sizeBytes: file.size,
    extractedText: normalizedText,
  };
}

async function extractTextFile(file: File) {
  const readableFile = file.size > aaisGuideAttachmentLimits.maxTextReadBytes
    ? file.slice(0, aaisGuideAttachmentLimits.maxTextReadBytes)
    : file;
  return readableFile.text();
}

function inferGuideAttachmentMediaType(file: File): AaisGuideAttachmentMediaType | null {
  const explicitType = file.type.trim().toLowerCase();
  if (isAaisGuideAttachmentMediaType(explicitType)) {
    return explicitType;
  }

  const extension = file.name.toLowerCase().split(".").pop();
  if (extension === "txt") {
    return "text/plain";
  }
  if (extension === "md" || extension === "markdown") {
    return "text/markdown";
  }
  if (extension === "csv") {
    return "text/csv";
  }
  if (extension === "pdf") {
    return "application/pdf";
  }
  if (extension === "docx") {
    return "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
  }
  return null;
}

async function extractDocxText(file: File, locale: Locale) {
  let documentEntryCount = 0;
  let documentEntryTooLarge = false;
  let files: Record<string, Uint8Array>;

  try {
    files = unzipSync(new Uint8Array(await file.arrayBuffer()), {
      filter(entry) {
        if (entry.name !== "word/document.xml") {
          return false;
        }
        documentEntryCount += 1;
        if (
          documentEntryCount > 1
          || entry.originalSize > aaisGuideAttachmentLimits.maxDocxDocumentXmlBytes
        ) {
          documentEntryTooLarge = true;
          return false;
        }
        return true;
      },
    });
  } catch {
    throw createGuideFileError(locale, "invalidDocx", file.name);
  }

  if (documentEntryTooLarge) {
    throw createGuideFileError(locale, "docxBodyTooLarge", file.name);
  }
  const documentXml = files["word/document.xml"];
  if (!documentXml || documentEntryCount !== 1) {
    throw createGuideFileError(locale, "noDocxBody", file.name);
  }
  if (documentXml.byteLength > aaisGuideAttachmentLimits.maxDocxDocumentXmlBytes) {
    throw createGuideFileError(locale, "docxBodyTooLarge", file.name);
  }

  const documentXmlText = strFromU8(documentXml);
  if (/<!\s*(?:DOCTYPE|ENTITY)\b/i.test(documentXmlText)) {
    throw createGuideFileError(locale, "unsafeDocxXml", file.name);
  }
  const xmlDocument = new DOMParser().parseFromString(
    documentXmlText,
    "application/xml",
  );
  if (xmlDocument.getElementsByTagName("parsererror").length) {
    throw createGuideFileError(locale, "invalidDocxXml", file.name);
  }

  const wordNamespace =
    "http://schemas.openxmlformats.org/wordprocessingml/2006/main";
  const paragraphs = Array.from(xmlDocument.getElementsByTagNameNS(wordNamespace, "p"));
  return paragraphs
    .map((paragraph) => extractDocxParagraphText(paragraph, wordNamespace))
    .filter((paragraph) => paragraph.trim().length > 0)
    .join("\n");
}

type GuideFileErrorKind =
  | "tooLarge"
  | "unsupported"
  | "unreadable"
  | "noText"
  | "invalidDocx"
  | "docxBodyTooLarge"
  | "noDocxBody"
  | "unsafeDocxXml"
  | "invalidDocxXml";

class AaisGuideFileReadError extends Error {}

function createGuideFileError(
  locale: Locale,
  kind: GuideFileErrorKind,
  fileName: string,
) {
  const sizeLimit = aaisGuideAttachmentLimits.maxFileSizeMiB;
  const messages: Record<GuideFileErrorKind, string> = locale === "en-US"
    ? {
        tooLarge: `File ${fileName} exceeds the ${sizeLimit} MB upload limit.`,
        unsupported: `File ${fileName} is not a supported file type.`,
        unreadable: `File ${fileName} could not be read.`,
        noText: `File ${fileName} contains no readable text.`,
        invalidDocx: `File ${fileName} is not a readable DOCX document.`,
        docxBodyTooLarge: `The DOCX document body in ${fileName} is too large.`,
        noDocxBody: `File ${fileName} has no readable DOCX document body.`,
        unsafeDocxXml: `The DOCX document body in ${fileName} contains a disallowed XML declaration.`,
        invalidDocxXml: `The DOCX document body in ${fileName} is not valid XML.`,
      }
    : {
        tooLarge: `文件 ${fileName} 超过 ${sizeLimit} MB 上传上限。`,
        unsupported: `文件 ${fileName} 暂不支持。`,
        unreadable: `文件 ${fileName} 未能读取。`,
        noText: `文件 ${fileName} 没有可读取文本。`,
        invalidDocx: `文件 ${fileName} 不是可读取的 DOCX 文档。`,
        docxBodyTooLarge: `文件 ${fileName} 的 DOCX 正文内容过大。`,
        noDocxBody: `文件 ${fileName} 没有可读取的 DOCX 正文。`,
        unsafeDocxXml: `文件 ${fileName} 的 DOCX 正文包含不允许的 XML 声明。`,
        invalidDocxXml: `文件 ${fileName} 的 DOCX 正文格式无效。`,
      };
  return new AaisGuideFileReadError(messages[kind]);
}

function extractDocxParagraphText(paragraph: Element, wordNamespace: string) {
  let text = "";
  const walker = paragraph.ownerDocument.createTreeWalker(
    paragraph,
    NodeFilter.SHOW_ELEMENT,
  );
  let node = walker.nextNode();
  while (node) {
    const element = node as Element;
    if (element.namespaceURI === wordNamespace) {
      if (element.localName === "t") {
        text += element.textContent ?? "";
      } else if (element.localName === "tab") {
        text += "\t";
      } else if (element.localName === "br" || element.localName === "cr") {
        text += "\n";
      }
    }
    node = walker.nextNode();
  }
  return text;
}

async function extractPdfText(file: File) {
  // PDF.js' bundler entry creates the module worker that its generic entry
  // deliberately leaves unconfigured.
  const pdfjs = await import("pdfjs-dist/webpack.mjs") as typeof import("pdfjs-dist");
  const loadingTask = pdfjs.getDocument({
    data: new Uint8Array(await file.arrayBuffer()),
    useWasm: false,
    useWorkerFetch: false,
  });

  try {
    const pdf = await loadingTask.promise;
    let extractedText = "";
    const pageLimit = Math.min(pdf.numPages, aaisGuideAttachmentLimits.maxPdfPagesToScan);

    for (let pageNumber = 1; pageNumber <= pageLimit; pageNumber += 1) {
      const page = await pdf.getPage(pageNumber);
      const textContent = await page.getTextContent();
      const pageText = textContent.items
        .map((item) => ("str" in item ? item.str : ""))
        .filter(Boolean)
        .join(" ")
        .trim();
      if (!pageText) {
        continue;
      }

      const separator = extractedText ? "\n\n" : "";
      const remainingCharacters =
        aaisGuideAttachmentLimits.maxExtractedTextCharacters
        - extractedText.length
        - separator.length;
      if (remainingCharacters <= 0) {
        break;
      }
      extractedText += separator + pageText.slice(0, remainingCharacters);
      if (extractedText.length >= aaisGuideAttachmentLimits.maxExtractedTextCharacters) {
        break;
      }
    }

    return extractedText;
  } finally {
    await loadingTask.destroy();
  }
}
