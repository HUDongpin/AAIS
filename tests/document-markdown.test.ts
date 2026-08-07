import { describe, expect, it } from "vitest";
import {
  mergeHistoryDocument,
  sanitizeEditorHtml,
} from "@/components/pages/learning/document-markdown";
import type { SavedLearningDocument } from "@/components/pages/learning/learning-page-types";

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

  it("preserves bounded pasted images while removing unsafe image sources", () => {
    const sanitized = sanitizeEditorHtml(
      '<p>截图</p><img src="data:image/png;base64,AAAA" alt="测试截图" onload="alert(1)">'
      + '<img src="javascript:alert(1)" alt="危险图片">',
    );

    expect(sanitized).toContain('src="data:image/png;base64,AAAA"');
    expect(sanitized).toContain('alt="测试截图"');
    expect(sanitized).not.toContain("onload");
    expect(sanitized).not.toContain("javascript:");
  });

  it("updates the active history document instead of creating a renamed duplicate", () => {
    const original: SavedLearningDocument = {
      id: "history-1",
      taskId: "training_task_1",
      title: "学习计划",
      html: "<p>原内容</p>",
      markdown: "原内容\n",
      savedAt: new Date("2026-08-07T00:00:00.000Z"),
    };
    const renamed: SavedLearningDocument = {
      ...original,
      id: "new-generated-id",
      taskId: "another-task",
      title: "最终学习计划",
      savedAt: new Date("2026-08-07T01:00:00.000Z"),
    };

    expect(mergeHistoryDocument([original], renamed, original.id)).toEqual([
      expect.objectContaining({
        id: original.id,
        taskId: original.taskId,
        title: "最终学习计划",
        savedAt: renamed.savedAt,
      }),
    ]);
  });
});
