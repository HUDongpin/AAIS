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
});
