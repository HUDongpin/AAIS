import { afterEach, describe, expect, it, vi } from "vitest";
import {
  aaisGuideAttachmentLimits,
  normalizeAaisGuideAttachments,
} from "@/lib/ai/aais-guide-attachments";
import { readAaisGuideFileAttachment } from "@/lib/client/aais-guide-file-reader";
import { strToU8, zipSync } from "fflate";

const pdfjsMocks = vi.hoisted(() => ({
  getDocument: vi.fn(),
}));

vi.mock("pdfjs-dist/webpack.mjs", () => ({
  getDocument: pdfjsMocks.getDocument,
}));

describe("AAIS guide file reader", () => {
  afterEach(() => {
    pdfjsMocks.getDocument.mockReset();
  });

  it("accepts CSV source files above the former 2 MB ceiling without reading them in full", async () => {
    const text = vi.fn(async () => "the whole source must not be read");
    const boundedText = `header,row\n${"x".repeat(
      aaisGuideAttachmentLimits.maxExtractedTextCharacters + 100,
    )}`;
    const sliceText = vi.fn(async () => boundedText);
    const slice = vi.fn(() => ({ text: sliceText } as unknown as Blob));
    const file = {
      name: "63完整样本.csv",
      type: "text/csv",
      size: 2 * 1024 * 1024 + 1,
      slice,
      text,
    } as unknown as File;

    const attachment = await readAaisGuideFileAttachment(file);

    expect(attachment).toMatchObject({
      name: "63完整样本.csv",
      mediaType: "text/csv",
      sizeBytes: 2 * 1024 * 1024 + 1,
    });
    expect(attachment.extractedText).toHaveLength(
      aaisGuideAttachmentLimits.maxExtractedTextCharacters,
    );
    expect(slice).toHaveBeenCalledWith(0, aaisGuideAttachmentLimits.maxTextReadBytes);
    expect(sliceText).toHaveBeenCalledOnce();
    expect(text).not.toHaveBeenCalled();
  });

  it("keeps a documented 20 MB source-file safety ceiling on client and server", async () => {
    const file = {
      name: "too-large.csv",
      type: "text/csv",
      size: aaisGuideAttachmentLimits.maxFileSizeBytes + 1,
      slice: vi.fn(),
      text: vi.fn(),
    } as unknown as File;

    await expect(readAaisGuideFileAttachment(file)).rejects.toThrow(
      "文件 too-large.csv 超过 20 MB 上传上限。",
    );
    expect(file.slice).not.toHaveBeenCalled();
    expect(file.text).not.toHaveBeenCalled();
    expect(() => normalizeAaisGuideAttachments([{
      name: "too-large.csv",
      mediaType: "text/csv",
      sizeBytes: aaisGuideAttachmentLimits.maxFileSizeBytes + 1,
      extractedText: "bounded text",
    }])).toThrow("exceeds the 20 MB upload limit");
  });

  it("localizes attachment validation and read failures for the active English locale", async () => {
    const oversizedFile = {
      name: "too-large.csv",
      type: "text/csv",
      size: aaisGuideAttachmentLimits.maxFileSizeBytes + 1,
    } as File;
    await expect(readAaisGuideFileAttachment(oversizedFile, "en-US")).rejects.toThrow(
      "File too-large.csv exceeds the 20 MB upload limit.",
    );

    const unsupportedFile = new File(["data"], "sample.pages", {
      type: "application/octet-stream",
    });
    await expect(readAaisGuideFileAttachment(unsupportedFile, "en-US")).rejects.toThrow(
      "File sample.pages is not a supported file type.",
    );

    const unreadableFile = {
      name: "broken.txt",
      type: "text/plain",
      size: 10,
      text: vi.fn(async () => {
        throw new Error("raw browser failure");
      }),
    } as unknown as File;
    await expect(readAaisGuideFileAttachment(unreadableFile, "en-US")).rejects.toThrow(
      "File broken.txt could not be read.",
    );
  });

  it("loads PDFs through the configured worker entry and stops at the context cap", async () => {
    const destroy = vi.fn(async () => undefined);
    const getTextContent = vi.fn(async () => ({
      items: [{ str: "p".repeat(aaisGuideAttachmentLimits.maxExtractedTextCharacters) }],
    }));
    const getPage = vi.fn(async () => ({ getTextContent }));
    pdfjsMocks.getDocument.mockReturnValue({
      promise: Promise.resolve({ numPages: 5, getPage }),
      destroy,
    });
    const source = new Uint8Array([0x25, 0x50, 0x44, 0x46]).buffer;
    const file = {
      name: "report.pdf",
      type: "application/pdf",
      size: source.byteLength,
      arrayBuffer: vi.fn(async () => source),
    } as unknown as File;

    const attachment = await readAaisGuideFileAttachment(file);

    expect(attachment.extractedText).toHaveLength(
      aaisGuideAttachmentLimits.maxExtractedTextCharacters,
    );
    expect(pdfjsMocks.getDocument).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.any(Uint8Array),
      useWasm: false,
      useWorkerFetch: false,
    }));
    expect(getPage).toHaveBeenCalledTimes(1);
    expect(getTextContent).toHaveBeenCalledOnce();
    expect(destroy).toHaveBeenCalledOnce();
  });

  it("extracts bounded plain text from a DOCX document body", async () => {
    const longBody = "关键结论".repeat(aaisGuideAttachmentLimits.maxExtractedTextCharacters);
    const documentXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
      <w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
        <w:body>
          <w:p><w:r><w:t>第一段</w:t></w:r><w:r><w:tab/><w:t>第二列</w:t></w:r></w:p>
          <w:p><w:r><w:t>${longBody}</w:t></w:r></w:p>
        </w:body>
      </w:document>`;
    const bytes = zipSync({
      "[Content_Types].xml": strToU8("<Types />"),
      "word/document.xml": strToU8(documentXml),
      "word/ignored.xml": strToU8("sensitive text outside the main document body"),
    });
    const file = new File([bytes], "论文.docx", {
      type: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    });

    const attachment = await readAaisGuideFileAttachment(file);

    expect(attachment).toMatchObject({
      name: "论文.docx",
      mediaType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      sizeBytes: bytes.byteLength,
    });
    expect(attachment.extractedText.startsWith("第一段\t第二列\n关键结论")).toBe(true);
    expect(attachment.extractedText).toHaveLength(
      aaisGuideAttachmentLimits.maxExtractedTextCharacters,
    );
    expect(attachment.extractedText).not.toContain("sensitive text outside");
  });

  it("rejects invalid DOCX containers and oversized document XML entries", async () => {
    const invalidFile = new File(["not-a-zip"], "invalid.docx", {
      type: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    });
    await expect(readAaisGuideFileAttachment(invalidFile)).rejects.toThrow(
      "文件 invalid.docx 不是可读取的 DOCX 文档。",
    );

    const oversizedXml = zipSync({
      "word/document.xml": new Uint8Array(
        aaisGuideAttachmentLimits.maxDocxDocumentXmlBytes + 1,
      ),
    });
    const oversizedFile = new File([oversizedXml], "oversized.docx", {
      type: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    });
    await expect(readAaisGuideFileAttachment(oversizedFile)).rejects.toThrow(
      "文件 oversized.docx 的 DOCX 正文内容过大。",
    );

    const entityXml = `<!DOCTYPE w:document [<!ENTITY repeated "unsafe">]>
      <w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
        <w:body><w:p><w:r><w:t>&repeated;</w:t></w:r></w:p></w:body>
      </w:document>`;
    const entityFile = new File([zipSync({
      "word/document.xml": strToU8(entityXml),
    })], "entity.docx", {
      type: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    });
    await expect(readAaisGuideFileAttachment(entityFile)).rejects.toThrow(
      "文件 entity.docx 的 DOCX 正文包含不允许的 XML 声明。",
    );
  });
});
