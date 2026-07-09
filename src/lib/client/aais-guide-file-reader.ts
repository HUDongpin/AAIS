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
    throw new Error(`文件 ${file.name} 超过 2 MB。`);
  }

  const mediaType = inferGuideAttachmentMediaType(file);
  if (!mediaType) {
    throw new Error(`文件 ${file.name} 暂不支持。`);
  }

  const extractedText =
    mediaType === "application/pdf"
      ? await extractPdfText(file)
      : await file.text();
  const normalizedText = extractedText.trim();
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
  const pdfjs = await import("pdfjs-dist");
  const pdf = await pdfjs.getDocument({
    data: new Uint8Array(await file.arrayBuffer()),
    useWorkerFetch: false,
  }).promise;
  const pages: string[] = [];

  for (let pageNumber = 1; pageNumber <= pdf.numPages; pageNumber += 1) {
    const page = await pdf.getPage(pageNumber);
    const textContent = await page.getTextContent();
    pages.push(
      textContent.items
        .map((item) => ("str" in item ? item.str : ""))
        .filter(Boolean)
        .join(" "),
    );
  }

  return pages.join("\n\n");
}
