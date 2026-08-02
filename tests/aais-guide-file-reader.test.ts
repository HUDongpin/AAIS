import { afterEach, describe, expect, it, vi } from "vitest";
import {
  aaisGuideAttachmentLimits,
  normalizeAaisGuideAttachments,
} from "@/lib/ai/aais-guide-attachments";
import { readAaisGuideFileAttachment } from "@/lib/client/aais-guide-file-reader";

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
});
