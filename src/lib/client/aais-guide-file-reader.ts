import {
  aaisGuideAttachmentLimits,
  isAaisGuideAttachmentMediaType,
  type AaisGuideAttachment,
  type AaisGuideAttachmentMediaType,
} from "@/lib/ai/aais-guide-attachments";
import { strFromU8, unzipSync } from "fflate";

export const aaisGuideFileAccept =
  ".txt,.md,.csv,.pdf,.docx,text/plain,text/markdown,text/csv,application/pdf,application/vnd.openxmlformats-officedocument.wordprocessingml.document";

export async function readAaisGuideFileAttachment(file: File): Promise<AaisGuideAttachment> {
  if (file.size > aaisGuideAttachmentLimits.maxFileSizeBytes) {
    throw new Error(
      `文件 ${file.name} 超过 ${aaisGuideAttachmentLimits.maxFileSizeMiB} MB 上传上限。`,
    );
  }

  const mediaType = inferGuideAttachmentMediaType(file);
  if (!mediaType) {
    throw new Error(`文件 ${file.name} 暂不支持。`);
  }

  const extractedText =
    mediaType === "application/pdf"
      ? await extractPdfText(file)
      : mediaType === "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
        ? await extractDocxText(file)
      : await extractTextFile(file);
  const normalizedText = extractedText
    .trim()
    .slice(0, aaisGuideAttachmentLimits.maxExtractedTextCharacters);
  if (!normalizedText) {
    throw new Error(`文件 ${file.name} 没有可读取文本。`);
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

async function extractDocxText(file: File) {
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
    throw new Error(`文件 ${file.name} 不是可读取的 DOCX 文档。`);
  }

  if (documentEntryTooLarge) {
    throw new Error(`文件 ${file.name} 的 DOCX 正文内容过大。`);
  }
  const documentXml = files["word/document.xml"];
  if (!documentXml || documentEntryCount !== 1) {
    throw new Error(`文件 ${file.name} 没有可读取的 DOCX 正文。`);
  }
  if (documentXml.byteLength > aaisGuideAttachmentLimits.maxDocxDocumentXmlBytes) {
    throw new Error(`文件 ${file.name} 的 DOCX 正文内容过大。`);
  }

  const documentXmlText = strFromU8(documentXml);
  if (/<!\s*(?:DOCTYPE|ENTITY)\b/i.test(documentXmlText)) {
    throw new Error(`文件 ${file.name} 的 DOCX 正文包含不允许的 XML 声明。`);
  }
  const xmlDocument = new DOMParser().parseFromString(
    documentXmlText,
    "application/xml",
  );
  if (xmlDocument.getElementsByTagName("parsererror").length) {
    throw new Error(`文件 ${file.name} 的 DOCX 正文格式无效。`);
  }

  const wordNamespace =
    "http://schemas.openxmlformats.org/wordprocessingml/2006/main";
  const paragraphs = Array.from(xmlDocument.getElementsByTagNameNS(wordNamespace, "p"));
  return paragraphs
    .map((paragraph) => extractDocxParagraphText(paragraph, wordNamespace))
    .filter((paragraph) => paragraph.trim().length > 0)
    .join("\n");
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
