import {
  aaisGuideAttachmentLimits,
  isAaisGuideAttachmentMediaType,
  type AaisGuideAttachment,
  type AaisGuideAttachmentMediaType,
} from "@/lib/ai/aais-guide-attachments";

export const aaisGuideFileAccept =
  ".txt,.md,.csv,.pdf,text/plain,text/markdown,text/csv,application/pdf";

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
  return null;
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
