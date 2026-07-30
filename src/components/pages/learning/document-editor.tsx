import {
  useEffect,
  useRef,
  useState,
  type MouseEvent as ReactMouseEvent,
} from "react";
import { anthropicLearningFontFamily } from "@/components/pages/learning/learning-page-constants";
import {
  admitAaisResearchAction,
  createAaisResearchOperationId,
} from "@/lib/client/aais-research-telemetry";
import {
  toEditableHtml,
} from "@/components/pages/learning/document-markdown";
import type {
  DocumentFontFamily,
  DocumentFontSize,
  DocumentHeadingTag,
  DocumentListTag,
} from "@/components/pages/learning/learning-page-types";

const documentFontFamilyStyles: Record<DocumentFontFamily, string> = {
  system:
    'ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif',
  serif: anthropicLearningFontFamily,
  mono: '"SFMono-Regular", Consolas, "Liberation Mono", monospace',
};

const documentFontSizeOptions: DocumentFontSize[] = ["17", "20", "24", "28"];

export function DocumentEditor({
  artifactText,
  documentTitle,
  onArtifactChange,
  onArtifactBlur,
  onDocumentTitleChange,
}: {
  artifactText: string;
  documentTitle: string;
  onArtifactChange: (value: string) => void;
  onArtifactBlur: () => void;
  onDocumentTitleChange: (value: string) => void;
}) {
  const editorRef = useRef<HTMLDivElement | null>(null);
  const editorSelectionRef = useRef<Range | null>(null);
  const titleAtFocusRef = useRef(documentTitle);
  const [fontFamily, setFontFamily] = useState<DocumentFontFamily>("serif");
  const [fontSize, setFontSize] = useState<DocumentFontSize>("17");
  const [editorEmpty, setEditorEmpty] = useState(!artifactText.trim());

  useEffect(() => {
    const editor = editorRef.current;
    if (!editor) {
      return;
    }
    const nextHtml = toEditableHtml(artifactText);
    if (editor.innerHTML !== nextHtml) {
      editor.innerHTML = nextHtml;
    }
    setEditorEmpty(!editor.textContent?.trim());
  }, [artifactText]);

  function syncEditorValue() {
    const editor = editorRef.current;
    if (!editor) {
      return;
    }
    setEditorEmpty(!editor.textContent?.trim());
    onArtifactChange(editor.innerHTML);
  }

  function focusEditor() {
    editorRef.current?.focus();
  }

  function getEditorRange() {
    const editor = editorRef.current;
    const selection = window.getSelection();
    if (!editor || !selection || selection.rangeCount === 0) {
      return null;
    }
    const range = selection.getRangeAt(0);
    if (!editor.contains(range.commonAncestorContainer) && range.commonAncestorContainer !== editor) {
      return null;
    }
    return range;
  }

  function saveEditorSelection() {
    const range = getEditorRange();
    if (range) {
      editorSelectionRef.current = range.cloneRange();
    }
  }

  function restoreEditorSelection() {
    const editor = editorRef.current;
    if (!editor) {
      return;
    }
    editor.focus();
    const selection = window.getSelection();
    const savedRange = editorSelectionRef.current;
    if (!selection || !savedRange) {
      return;
    }
    try {
      selection.removeAllRanges();
      selection.addRange(savedRange);
    } catch {
      editorSelectionRef.current = null;
    }
  }

  function keepEditorSelection(event: ReactMouseEvent<HTMLButtonElement>) {
    event.preventDefault();
    saveEditorSelection();
  }

  function runEditorCommand(command: string, value?: string) {
    restoreEditorSelection();
    if (typeof document.execCommand === "function") {
      document.execCommand(command, false, value);
    }
    syncEditorValue();
    saveEditorSelection();
  }

  function runTrackedEditorCommand(formatId: string, command: string) {
    if (!admitEditorFormat(formatId)) {
      return;
    }
    runEditorCommand(command);
  }

  function runHeadingCommand(tagName: DocumentHeadingTag) {
    if (!admitEditorFormat("heading", tagName)) {
      return;
    }
    const editor = editorRef.current;
    restoreEditorSelection();
    const previousHtml = editor?.innerHTML;
    const commandValue = `<${tagName}>`;
    const commandApplied =
      typeof document.execCommand === "function" &&
      document.execCommand("formatBlock", false, commandValue);

    if (!commandApplied || editor?.innerHTML === previousHtml) {
      applyHeadingFallback(tagName);
    }
    syncEditorValue();
    saveEditorSelection();
  }

  function runListCommand(command: "insertUnorderedList" | "insertOrderedList", tagName: DocumentListTag) {
    if (!admitEditorFormat("list", tagName === "ul" ? "unordered" : "ordered")) {
      return;
    }
    const editor = editorRef.current;
    restoreEditorSelection();
    const previousHtml = editor?.innerHTML;
    const commandApplied =
      typeof document.execCommand === "function" &&
      document.execCommand(command, false);

    if (!commandApplied || editor?.innerHTML === previousHtml) {
      applyListFallback(tagName);
    }
    syncEditorValue();
    saveEditorSelection();
  }

  function applyHeadingFallback(tagName: DocumentHeadingTag) {
    const editor = editorRef.current;
    if (!editor) {
      return;
    }
    const range = getEditorRange() ?? editorSelectionRef.current;
    const targetBlock = range ? findEditableBlock(range.startContainer, editor) : null;
    const heading = document.createElement(tagName);

    if (targetBlock) {
      heading.innerHTML = targetBlock.innerHTML || "<br>";
      targetBlock.replaceWith(heading);
      placeCaretAtEnd(heading);
      return;
    }

    while (editor.firstChild) {
      heading.appendChild(editor.firstChild);
    }
    if (!heading.childNodes.length) {
      heading.appendChild(document.createElement("br"));
    }
    editor.appendChild(heading);
    placeCaretAtEnd(heading);
  }

  function applyListFallback(tagName: DocumentListTag) {
    const editor = editorRef.current;
    if (!editor) {
      return;
    }
    const range = getEditorRange() ?? editorSelectionRef.current;
    const targetBlock = range ? findEditableBlock(range.startContainer, editor) : null;
    const list = document.createElement(tagName);
    const listItem = document.createElement("li");

    if (targetBlock) {
      listItem.innerHTML = targetBlock.innerHTML || "<br>";
      list.appendChild(listItem);
      targetBlock.replaceWith(list);
      placeCaretAtEnd(listItem);
      return;
    }

    while (editor.firstChild) {
      listItem.appendChild(editor.firstChild);
    }
    if (!listItem.childNodes.length) {
      listItem.appendChild(document.createElement("br"));
    }
    list.appendChild(listItem);
    editor.appendChild(list);
    placeCaretAtEnd(listItem);
  }

  function setEditorFontFamily(nextFontFamily: DocumentFontFamily) {
    if (!admitEditorFormat("font_family", nextFontFamily)) {
      return;
    }
    setFontFamily(nextFontFamily);
    const cssFontFamily = documentFontFamilyStyles[nextFontFamily];
    runEditorCommand("fontName", cssFontFamily);
  }

  function setEditorFontSize(nextFontSize: DocumentFontSize) {
    if (!admitEditorFormat("font_size", nextFontSize)) {
      return;
    }
    setFontSize(nextFontSize);
    focusEditor();
    syncEditorValue();
  }

  function admitEditorFormat(formatId: string, valueId?: string) {
    return admitAaisResearchAction({
      eventName: "editor_format_applied",
      outcome: "success",
      detail: {
        operation_id: createAaisResearchOperationId("editor-format"),
        format_id: formatId,
        ...(valueId ? { value_id: valueId } : {}),
      },
    });
  }

  const toolbarButtonClass =
    "inline-flex h-10 min-w-10 items-center justify-center px-3 text-base outline-none transition hover:bg-white focus-visible:ring-2 focus-visible:ring-[#536de8]";
  const editorFontStyle = {
    fontFamily: documentFontFamilyStyles[fontFamily],
    fontSize: `${fontSize}px`,
  };

  return (
    <section className="px-3 py-4">
      <input
        aria-label="文档标题"
        value={documentTitle}
        onFocus={(event) => {
          titleAtFocusRef.current = event.currentTarget.value;
        }}
        onChange={(event) => onDocumentTitleChange(event.target.value)}
        onBlur={(event) => {
          if (event.currentTarget.value === titleAtFocusRef.current) {
            return;
          }
          admitAaisResearchAction({
            eventName: "document_title_committed",
            outcome: "success",
            detail: {
              operation_id: createAaisResearchOperationId("document-title"),
              trigger: "blur",
              title_length: event.currentTarget.value.trim().length,
            },
          });
        }}
        placeholder="输入标题..."
        className="h-12 w-full rounded-md border border-[#e7e7e7] px-4 text-[17px] text-[#333333] outline-none placeholder:text-[#b5b5b5] focus:border-[#536de8]"
      />
      <div className="mt-3 rounded-lg border border-[#e7e7e7] bg-[#f8f8f8] p-3 text-base text-[#5a5a5a]">
        <div className="flex flex-wrap items-center gap-3">
          <select
            aria-label="字体"
            value={fontFamily}
            onChange={(event) => setEditorFontFamily(event.target.value as DocumentFontFamily)}
            className="h-10 rounded-md border border-[#dddddd] bg-white px-3 text-base outline-none focus-visible:ring-2 focus-visible:ring-[#536de8]"
          >
            <option value="system">默认</option>
            <option value="serif">衬线</option>
            <option value="mono">等宽</option>
          </select>
          <select
            aria-label="字号"
            value={fontSize}
            onChange={(event) => setEditorFontSize(event.target.value as DocumentFontSize)}
            className="h-10 rounded-md border border-[#dddddd] bg-white px-3 text-base outline-none focus-visible:ring-2 focus-visible:ring-[#536de8]"
          >
            {documentFontSizeOptions.map((size) => (
              <option key={size} value={size}>
                {size}px
              </option>
            ))}
          </select>
          <EditorButton label="加粗" className={`${toolbarButtonClass} font-bold`} onMouseDown={keepEditorSelection} onClick={() => runTrackedEditorCommand("bold", "bold")}>B</EditorButton>
          <EditorButton label="斜体" className={`${toolbarButtonClass} italic`} onMouseDown={keepEditorSelection} onClick={() => runTrackedEditorCommand("italic", "italic")}>I</EditorButton>
          <EditorButton label="下划线" className={`${toolbarButtonClass} underline`} onMouseDown={keepEditorSelection} onClick={() => runTrackedEditorCommand("underline", "underline")}>U</EditorButton>
          <EditorButton label="左对齐" className={toolbarButtonClass} onMouseDown={keepEditorSelection} onClick={() => runTrackedEditorCommand("align_left", "justifyLeft")}>L</EditorButton>
          <EditorButton label="居中" className={toolbarButtonClass} onMouseDown={keepEditorSelection} onClick={() => runTrackedEditorCommand("align_center", "justifyCenter")}>C</EditorButton>
          <EditorButton label="右对齐" className={toolbarButtonClass} onMouseDown={keepEditorSelection} onClick={() => runTrackedEditorCommand("align_right", "justifyRight")}>R</EditorButton>
        </div>
        <div className="mt-3 flex flex-wrap items-center gap-3">
          <EditorButton label="项目符号" className={toolbarButtonClass} onMouseDown={keepEditorSelection} onClick={() => runListCommand("insertUnorderedList", "ul")}>=</EditorButton>
          <EditorButton label="编号列表" className={toolbarButtonClass} onMouseDown={keepEditorSelection} onClick={() => runListCommand("insertOrderedList", "ol")}>#</EditorButton>
          <EditorButton label="一级标题" className={`${toolbarButtonClass} font-semibold`} onMouseDown={keepEditorSelection} onClick={() => runHeadingCommand("h1")}>H1</EditorButton>
          <EditorButton label="二级标题" className={`${toolbarButtonClass} font-semibold`} onMouseDown={keepEditorSelection} onClick={() => runHeadingCommand("h2")}>H2</EditorButton>
          <EditorButton label="三级标题" className={`${toolbarButtonClass} font-semibold`} onMouseDown={keepEditorSelection} onClick={() => runHeadingCommand("h3")}>H3</EditorButton>
        </div>
      </div>
      <div className="relative mt-3">
        {editorEmpty ? (
          <span className="pointer-events-none absolute left-4 top-4 text-[17px] leading-7 text-[#b5b5b5]">
            在这里开始记录...
          </span>
        ) : null}
        <div
          ref={editorRef}
          aria-label="在这里写下任务理解、计划、执行过程或最终产出。"
          aria-multiline="true"
          role="textbox"
          contentEditable
          suppressContentEditableWarning
          onInput={() => {
            syncEditorValue();
            saveEditorSelection();
          }}
          onKeyUp={saveEditorSelection}
          onMouseUp={saveEditorSelection}
          onBlur={onArtifactBlur}
          style={editorFontStyle}
          className="min-h-[404px] w-full resize-none overflow-y-auto rounded-lg border border-[#e5e5e5] bg-white p-4 leading-7 text-[#333333] outline-none focus:border-[#536de8]"
        />
      </div>
    </section>
  );
}

function EditorButton({
  children,
  className,
  label,
  onClick,
  onMouseDown,
}: {
  children: string;
  className: string;
  label: string;
  onClick: () => void;
  onMouseDown: (event: ReactMouseEvent<HTMLButtonElement>) => void;
}) {
  return (
    <button
      type="button"
      onMouseDown={onMouseDown}
      onClick={onClick}
      className={className}
      aria-label={label}
    >
      {children}
    </button>
  );
}

function findEditableBlock(node: Node, editor: HTMLElement) {
  const blockTags = new Set([
    "BLOCKQUOTE",
    "DIV",
    "H1",
    "H2",
    "H3",
    "H4",
    "H5",
    "H6",
    "LI",
    "P",
    "PRE",
  ]);
  let current =
    node.nodeType === Node.ELEMENT_NODE
      ? (node as HTMLElement)
      : node.parentElement;

  while (current && current !== editor) {
    if (blockTags.has(current.tagName)) {
      return current;
    }
    current = current.parentElement;
  }
  return null;
}

function placeCaretAtEnd(element: HTMLElement) {
  const selection = window.getSelection();
  if (!selection) {
    return;
  }
  const range = document.createRange();
  range.selectNodeContents(element);
  range.collapse(false);
  selection.removeAllRanges();
  selection.addRange(range);
}
