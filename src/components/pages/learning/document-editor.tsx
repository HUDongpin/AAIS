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
import { getLearningCopy } from "@/components/pages/learning/learning-copy";
import {
  applyAlignmentFallback,
  applyHeadingFallback,
  applyInlineFallback,
  applyListFallback,
  initialEditorFormatState,
  queryEditorCommandState,
  readEditorFormatState,
  type EditorAlignment,
  type EditorFormatState,
  type EditorInlineTag,
} from "@/components/pages/learning/document-editor-dom";
import type {
  DocumentFontFamily,
  DocumentFontSize,
  DocumentHeadingTag,
  DocumentListTag,
} from "@/components/pages/learning/learning-page-types";
import type { Locale } from "@/data/aais";

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
  locale = "zh-CN",
  onArtifactChange,
  onArtifactBlur,
  onDocumentTitleChange,
}: {
  artifactText: string;
  documentTitle: string;
  locale?: Locale;
  onArtifactChange: (value: string) => void;
  onArtifactBlur: () => void;
  onDocumentTitleChange: (value: string) => void;
}) {
  const copy = getLearningCopy(locale);
  const editorRef = useRef<HTMLDivElement | null>(null);
  const editorSelectionRef = useRef<Range | null>(null);
  const editorComposingRef = useRef(false);
  const titleAtFocusRef = useRef(documentTitle);
  const [fontFamily, setFontFamily] = useState<DocumentFontFamily>("serif");
  const [fontSize, setFontSize] = useState<DocumentFontSize>("17");
  const [editorEmpty, setEditorEmpty] = useState(!artifactText.trim());
  const [formatState, setFormatState] = useState<EditorFormatState>(initialEditorFormatState);

  useEffect(() => {
    const editor = editorRef.current;
    if (!editor) {
      return;
    }
    if (editorComposingRef.current) {
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
    const editor = editorRef.current;
    const range = getEditorRange();
    if (editor && range) {
      editorSelectionRef.current = range.cloneRange();
      setFormatState(readEditorFormatState(range, editor));
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

  function runInlineCommand(formatId: string, command: string, tagName: EditorInlineTag) {
    if (!admitEditorFormat(formatId)) {
      return;
    }
    const editor = editorRef.current;
    restoreEditorSelection();
    const previousHtml = editor?.innerHTML;
    const commandApplied =
      typeof document.execCommand === "function" &&
      document.execCommand(command, false, undefined);

    if (
      !commandApplied
      || (editor?.innerHTML === previousHtml && queryEditorCommandState(command) !== true)
    ) {
      applyInlineFallback(
        editor,
        getEditorRange() ?? editorSelectionRef.current,
        tagName,
      );
    }
    syncEditorValue();
    saveEditorSelection();
  }

  function runAlignmentCommand(
    formatId: string,
    alignment: EditorAlignment,
  ) {
    if (!admitEditorFormat(formatId)) {
      return;
    }
    const editor = editorRef.current;
    restoreEditorSelection();
    applyAlignmentFallback(
      editor,
      getEditorRange() ?? editorSelectionRef.current,
      alignment,
    );
    syncEditorValue();
    saveEditorSelection();
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
      applyHeadingFallback(
        editor,
        getEditorRange() ?? editorSelectionRef.current,
        tagName,
      );
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
      applyListFallback(
        editor,
        getEditorRange() ?? editorSelectionRef.current,
        tagName,
      );
    }
    syncEditorValue();
    saveEditorSelection();
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
    "inline-flex h-10 min-w-10 items-center justify-center px-3 text-base outline-none transition hover:bg-white aria-pressed:bg-[#e8ecff] aria-pressed:text-[#324fd6] focus-visible:ring-2 focus-visible:ring-[#536de8]";
  return (
    <section className="px-3 py-4">
      <input
        aria-label={copy.editor.titleLabel}
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
        placeholder={copy.editor.titlePlaceholder}
        className="h-12 w-full rounded-md border border-[#e7e7e7] px-4 text-[17px] text-[#333333] outline-none placeholder:text-[#b5b5b5] focus:border-[#536de8]"
      />
      <div
        className="mt-3 rounded-lg border border-[#e7e7e7] bg-[#f8f8f8] p-3 text-base text-[#5a5a5a]"
        role="toolbar"
        aria-label={copy.editor.toolbarLabel}
      >
        <div className="flex flex-wrap items-center gap-3">
          <select
            aria-label={copy.editor.fontLabel}
            value={fontFamily}
            onChange={(event) => setEditorFontFamily(event.target.value as DocumentFontFamily)}
            className="h-10 rounded-md border border-[#dddddd] bg-white px-3 text-base outline-none focus-visible:ring-2 focus-visible:ring-[#536de8]"
          >
            <option value="system">{copy.editor.fontFamilies.system}</option>
            <option value="serif">{copy.editor.fontFamilies.serif}</option>
            <option value="mono">{copy.editor.fontFamilies.mono}</option>
          </select>
          <select
            aria-label={copy.editor.sizeLabel}
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
          <EditorButton label={copy.editor.bold} pressed={formatState.bold} className={`${toolbarButtonClass} font-bold`} onMouseDown={keepEditorSelection} onClick={() => runInlineCommand("bold", "bold", "strong")}>B</EditorButton>
          <EditorButton label={copy.editor.italic} pressed={formatState.italic} className={`${toolbarButtonClass} italic`} onMouseDown={keepEditorSelection} onClick={() => runInlineCommand("italic", "italic", "em")}>I</EditorButton>
          <EditorButton label={copy.editor.underline} pressed={formatState.underline} className={`${toolbarButtonClass} underline`} onMouseDown={keepEditorSelection} onClick={() => runInlineCommand("underline", "underline", "u")}>U</EditorButton>
          <EditorButton label={copy.editor.alignLeft} pressed={formatState.alignment === "left"} className={toolbarButtonClass} onMouseDown={keepEditorSelection} onClick={() => runAlignmentCommand("align_left", "left")}>L</EditorButton>
          <EditorButton label={copy.editor.alignCenter} pressed={formatState.alignment === "center"} className={toolbarButtonClass} onMouseDown={keepEditorSelection} onClick={() => runAlignmentCommand("align_center", "center")}>C</EditorButton>
          <EditorButton label={copy.editor.alignRight} pressed={formatState.alignment === "right"} className={toolbarButtonClass} onMouseDown={keepEditorSelection} onClick={() => runAlignmentCommand("align_right", "right")}>R</EditorButton>
        </div>
        <div className="mt-3 flex flex-wrap items-center gap-3">
          <EditorButton label={copy.editor.bulletList} pressed={formatState.list === "ul"} className={toolbarButtonClass} onMouseDown={keepEditorSelection} onClick={() => runListCommand("insertUnorderedList", "ul")}>=</EditorButton>
          <EditorButton label={copy.editor.numberedList} pressed={formatState.list === "ol"} className={toolbarButtonClass} onMouseDown={keepEditorSelection} onClick={() => runListCommand("insertOrderedList", "ol")}>#</EditorButton>
          <EditorButton label={copy.editor.heading1} pressed={formatState.heading === "h1"} className={`${toolbarButtonClass} font-semibold`} onMouseDown={keepEditorSelection} onClick={() => runHeadingCommand("h1")}>H1</EditorButton>
          <EditorButton label={copy.editor.heading2} pressed={formatState.heading === "h2"} className={`${toolbarButtonClass} font-semibold`} onMouseDown={keepEditorSelection} onClick={() => runHeadingCommand("h2")}>H2</EditorButton>
          <EditorButton label={copy.editor.heading3} pressed={formatState.heading === "h3"} className={`${toolbarButtonClass} font-semibold`} onMouseDown={keepEditorSelection} onClick={() => runHeadingCommand("h3")}>H3</EditorButton>
        </div>
      </div>
      <div className="relative mt-3">
        {editorEmpty ? (
          <span className="pointer-events-none absolute left-4 top-4 text-[17px] leading-7 text-[#b5b5b5]">
            {copy.editor.emptyPrompt}
          </span>
        ) : null}
        <div
          ref={editorRef}
          aria-label={copy.editor.inputLabel}
          aria-multiline="true"
          role="textbox"
          contentEditable
          suppressContentEditableWarning
          onInput={() => {
            syncEditorValue();
            if (!editorComposingRef.current) {
              saveEditorSelection();
            }
          }}
          onCompositionStart={() => {
            editorComposingRef.current = true;
          }}
          onCompositionEnd={() => {
            editorComposingRef.current = false;
            syncEditorValue();
            saveEditorSelection();
          }}
          onFocus={saveEditorSelection}
          onKeyUp={() => {
            if (!editorComposingRef.current) {
              saveEditorSelection();
            }
          }}
          onMouseUp={saveEditorSelection}
          onBlur={onArtifactBlur}
          data-font-family={fontFamily}
          data-font-size={fontSize}
          className="aais-document-editor min-h-[404px] w-full resize-none overflow-y-auto rounded-lg border border-[#e5e5e5] bg-white p-4 leading-7 text-[#333333] outline-none focus:border-[#536de8]"
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
  pressed,
}: {
  children: string;
  className: string;
  label: string;
  onClick: () => void;
  onMouseDown: (event: ReactMouseEvent<HTMLButtonElement>) => void;
  pressed: boolean;
}) {
  return (
    <button
      type="button"
      onMouseDown={onMouseDown}
      onClick={onClick}
      className={className}
      aria-label={label}
      aria-pressed={pressed}
    >
      {children}
    </button>
  );
}
