import { describe, expect, it } from "vitest";
import { sanitizeEditorHtml } from "@/components/pages/learning/document-markdown";

describe("document editor HTML sanitization", () => {
  it("removes CSP-blocked style attributes while preserving safe alignment", () => {
    const sanitized = sanitizeEditorHtml(
      '<p style="color:red" align="center" onclick="alert(1)">Safe text</p>'
      + '<p align="expression(alert(1))">Other text</p>',
    );

    expect(sanitized).toContain('<p align="center">Safe text</p>');
    expect(sanitized).toContain("<p>Other text</p>");
    expect(sanitized).not.toContain("style=");
    expect(sanitized).not.toContain("onclick=");
    expect(sanitized).not.toContain("expression");
  });
});
