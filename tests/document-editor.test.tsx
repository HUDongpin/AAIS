import { fireEvent, render, screen } from "@testing-library/react";
import { useState } from "react";
import { describe, expect, it, vi } from "vitest";
import { DocumentEditor } from "@/components/pages/learning/document-editor";

vi.mock("@/lib/client/aais-research-telemetry", () => ({
  admitAaisResearchAction: vi.fn(() => true),
  createAaisResearchOperationId: vi.fn(() => "editor-operation"),
}));

describe("DocumentEditor", () => {
  it("keeps every value across repeated controlled-input rerenders", () => {
    function ControlledEditor() {
      const [artifactText, setArtifactText] = useState("");
      return (
        <DocumentEditor
          artifactText={artifactText}
          documentTitle=""
          onArtifactBlur={() => undefined}
          onArtifactChange={setArtifactText}
          onDocumentTitleChange={() => undefined}
        />
      );
    }

    render(<ControlledEditor />);
    const editor = screen.getByRole("textbox", {
      name: "在这里写下任务理解、计划、执行过程或最终产出。",
    });

    for (let iteration = 1; iteration <= 30; iteration += 1) {
      const nextHtml = `<p>第 ${iteration} 轮中文输入 · English · ✅</p>`;
      fireEvent.focus(editor);
      if (iteration % 3 === 0) {
        fireEvent.compositionStart(editor);
      }
      editor.innerHTML = nextHtml;
      fireEvent.input(editor);
      if (iteration % 3 === 0) {
        fireEvent.compositionEnd(editor);
      }
      expect(editor.innerHTML).toBe(nextHtml);
    }
  });

  it("keeps the active IME composition intact while an external value changes", () => {
    const onArtifactChange = vi.fn();
    const props = {
      documentTitle: "",
      onArtifactBlur: vi.fn(),
      onArtifactChange,
      onDocumentTitleChange: vi.fn(),
    };
    const { rerender } = render(<DocumentEditor {...props} artifactText="" />);
    const editor = screen.getByRole("textbox", {
      name: "在这里写下任务理解、计划、执行过程或最终产出。",
    });

    fireEvent.compositionStart(editor);
    editor.innerHTML = "正在组合中文";
    fireEvent.input(editor);
    rerender(<DocumentEditor {...props} artifactText="较旧的外部内容" />);

    expect(editor.textContent).toBe("正在组合中文");

    editor.innerHTML = "中文输入已完成";
    fireEvent.compositionEnd(editor);
    expect(onArtifactChange).toHaveBeenLastCalledWith("中文输入已完成");

    rerender(<DocumentEditor {...props} artifactText="明确的新外部内容" />);
    expect(editor.textContent).toBe("明确的新外部内容");
  });

  it("shows localized labels and tooltips while preserving accessible button names", () => {
    render(
      <DocumentEditor
        artifactText=""
        documentTitle=""
        onArtifactBlur={() => undefined}
        onArtifactChange={() => undefined}
        onDocumentTitleChange={() => undefined}
      />,
    );

    ["项目符号", "编号列表", "一级标题", "二级标题", "三级标题"].forEach((label) => {
      const button = screen.getByRole("button", { name: label });
      expect(button.textContent).toContain(label);
      expect(button.getAttribute("aria-label")).toBe(label);
      expect(button.getAttribute("title")).toBe(label);
      expect(button.className).toContain("min-h-11");
      expect(button.className).toContain("min-w-11");
      expect(button.querySelector('[aria-hidden="true"]')).toBeTruthy();
    });

    ["加粗", "斜体", "下划线", "左对齐", "居中", "右对齐"].forEach((label) => {
      const button = screen.getByRole("button", { name: label });
      expect(button.getAttribute("aria-label")).toBe(label);
      expect(button.getAttribute("title")).toBe(label);
    });
  });

  it("keeps the first empty list button visibly pressed when Chromium leaves the caret on the editor root", () => {
    const onArtifactChange = vi.fn();
    render(
      <DocumentEditor
        artifactText=""
        documentTitle=""
        onArtifactBlur={() => undefined}
        onArtifactChange={onArtifactChange}
        onDocumentTitleChange={() => undefined}
      />,
    );

    const editor = screen.getByRole("textbox", {
      name: "在这里写下任务理解、计划、执行过程或最终产出。",
    });
    const range = document.createRange();
    range.selectNodeContents(editor);
    range.collapse(true);
    window.getSelection()?.removeAllRanges();
    window.getSelection()?.addRange(range);
    fireEvent.focus(editor);
    fireEvent.mouseUp(editor);

    Object.defineProperty(document, "execCommand", {
      configurable: true,
      value: vi.fn((command: string) => {
        if (command === "insertUnorderedList") {
          editor.innerHTML = "<ul><li><br></li></ul>";
          return true;
        }
        return false;
      }),
    });

    fireEvent.click(screen.getByRole("button", { name: "项目符号" }));

    expect(editor.innerHTML).toBe("<ul><li><br></li></ul>");
    expect(onArtifactChange).toHaveBeenLastCalledWith("<ul><li><br></li></ul>");
    expect(screen.getByRole("button", { name: "项目符号" }).getAttribute("aria-pressed")).toBe("true");
  });
});
