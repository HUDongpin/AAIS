import type {
  DocumentHeadingTag,
  DocumentListTag,
} from "@/components/pages/learning/learning-page-types";

export type EditorAlignment = "left" | "center" | "right";
export type EditorInlineTag = "strong" | "em" | "u";
export type EditorFormatState = {
  alignment: EditorAlignment;
  bold: boolean;
  heading: DocumentHeadingTag | null;
  italic: boolean;
  list: DocumentListTag | null;
  underline: boolean;
};

export const initialEditorFormatState: EditorFormatState = {
  alignment: "left",
  bold: false,
  heading: null,
  italic: false,
  list: null,
  underline: false,
};

const editableBlockTags = new Set([
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

const inlineTags: Record<EditorInlineTag, Set<string>> = {
  strong: new Set(["B", "STRONG"]),
  em: new Set(["EM", "I"]),
  u: new Set(["U"]),
};

export function applyHeadingFallback(
  editor: HTMLElement | null | undefined,
  range: Range | null,
  tagName: DocumentHeadingTag,
) {
  if (!editor) {
    return;
  }
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

export function applyInlineFallback(
  editor: HTMLElement | null | undefined,
  range: Range | null,
  tagName: EditorInlineTag,
) {
  if (!editor || !range || range.collapsed) {
    return;
  }
  const activeInline = findInlineAncestor(range.startContainer, editor, tagName);
  if (activeInline && activeInline.contains(range.endContainer)) {
    removeInlineFormattingFromRange(activeInline, range);
    return;
  }

  const wrapper = document.createElement(tagName);
  try {
    range.surroundContents(wrapper);
  } catch {
    wrapper.appendChild(range.extractContents());
    range.insertNode(wrapper);
  }
  selectElementContents(wrapper);
}

export function applyAlignmentFallback(
  editor: HTMLElement | null | undefined,
  range: Range | null,
  alignment: EditorAlignment,
) {
  if (!editor) {
    return;
  }
  const targetBlocks = getSelectedEditableBlocks(editor, range);
  if (targetBlocks.length) {
    targetBlocks.forEach((block) => {
      block.style.textAlign = alignment;
    });
    return;
  }

  const paragraph = document.createElement("p");
  paragraph.style.textAlign = alignment;
  while (editor.firstChild) {
    paragraph.appendChild(editor.firstChild);
  }
  if (!paragraph.childNodes.length) {
    paragraph.appendChild(document.createElement("br"));
  }
  editor.appendChild(paragraph);
  placeCaretAtEnd(paragraph);
}

export function applyListFallback(
  editor: HTMLElement | null | undefined,
  range: Range | null,
  tagName: DocumentListTag,
) {
  if (!editor) {
    return;
  }
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

export function readEditorFormatState(range: Range, editor: HTMLElement): EditorFormatState {
  const ancestors = getEditorAncestors(range.startContainer, editor);
  const headingElement = ancestors.find((element) =>
    ["H1", "H2", "H3"].includes(element.tagName)
  );
  const listElement = ancestors.find((element) =>
    ["UL", "OL"].includes(element.tagName)
  );
  const block = findEditableBlock(range.startContainer, editor);
  const blockAlignment = block?.style.textAlign || block?.getAttribute("align") || "";
  const alignment = queryEditorCommandState("justifyCenter") === true
    ? "center"
    : queryEditorCommandState("justifyRight") === true
      ? "right"
      : blockAlignment === "center" || blockAlignment === "right"
        ? blockAlignment
        : "left";

  return {
    alignment,
    bold: queryEditorCommandState("bold") === true || ancestors.some((element) => (
      ["B", "STRONG"].includes(element.tagName)
      || element.style.fontWeight === "bold"
      || Number(element.style.fontWeight) >= 600
    )),
    heading: headingElement
      ? headingElement.tagName.toLowerCase() as DocumentHeadingTag
      : null,
    italic: queryEditorCommandState("italic") === true || ancestors.some((element) => (
      ["EM", "I"].includes(element.tagName) || element.style.fontStyle === "italic"
    )),
    list: listElement
      ? listElement.tagName.toLowerCase() as DocumentListTag
      : null,
    underline: queryEditorCommandState("underline") === true || ancestors.some((element) => (
      element.tagName === "U" || element.style.textDecoration.includes("underline")
    )),
  };
}

export function queryEditorCommandState(command: string) {
  if (typeof document.queryCommandState !== "function") {
    return null;
  }
  try {
    return document.queryCommandState(command);
  } catch {
    return null;
  }
}

function findEditableBlock(node: Node, editor: HTMLElement) {
  let current = node.nodeType === Node.ELEMENT_NODE
    ? (node as HTMLElement)
    : node.parentElement;
  while (current && current !== editor) {
    if (editableBlockTags.has(current.tagName)) {
      return current;
    }
    current = current.parentElement;
  }
  return null;
}

function findInlineAncestor(
  node: Node,
  editor: HTMLElement,
  tagName: EditorInlineTag,
) {
  let current = node.nodeType === Node.ELEMENT_NODE
    ? (node as HTMLElement)
    : node.parentElement;
  while (current && current !== editor) {
    if (inlineTags[tagName].has(current.tagName)) {
      return current;
    }
    current = current.parentElement;
  }
  return null;
}

function getEditorAncestors(node: Node, editor: HTMLElement) {
  const ancestors: HTMLElement[] = [];
  let current = node.nodeType === Node.ELEMENT_NODE
    ? (node as HTMLElement)
    : node.parentElement;
  while (current && current !== editor) {
    ancestors.push(current);
    current = current.parentElement;
  }
  return ancestors;
}

function getSelectedEditableBlocks(editor: HTMLElement, range: Range | null) {
  if (!range) {
    return [];
  }
  if (range.collapsed) {
    const block = findEditableBlock(range.startContainer, editor);
    return block ? [block] : [];
  }
  return Array.from(editor.querySelectorAll<HTMLElement>(
    "blockquote, div, h1, h2, h3, h4, h5, h6, li, p, pre",
  )).filter((block) => {
    try {
      return range.intersectsNode(block);
    } catch {
      return false;
    }
  });
}

function removeInlineFormattingFromRange(element: HTMLElement, range: Range) {
  const parent = element.parentNode;
  if (!parent || range.collapsed) {
    return;
  }

  const beforeRange = document.createRange();
  beforeRange.selectNodeContents(element);
  beforeRange.setEnd(range.startContainer, range.startOffset);
  const afterRange = document.createRange();
  afterRange.selectNodeContents(element);
  afterRange.setStart(range.endContainer, range.endOffset);

  const beforeContent = beforeRange.cloneContents();
  const selectedContent = range.cloneContents();
  const afterContent = afterRange.cloneContents();
  const selectedNodes = Array.from(selectedContent.childNodes);

  if (beforeContent.hasChildNodes()) {
    const beforeWrapper = element.cloneNode(false) as HTMLElement;
    beforeWrapper.appendChild(beforeContent);
    parent.insertBefore(beforeWrapper, element);
  }
  selectedNodes.forEach((node) => {
    parent.insertBefore(node, element);
  });
  if (afterContent.hasChildNodes()) {
    const afterWrapper = element.cloneNode(false) as HTMLElement;
    afterWrapper.appendChild(afterContent);
    parent.insertBefore(afterWrapper, element);
  }
  element.remove();
  selectNodes(selectedNodes);
}

function selectElementContents(element: HTMLElement) {
  const selection = window.getSelection();
  if (!selection) {
    return;
  }
  const range = document.createRange();
  range.selectNodeContents(element);
  selection.removeAllRanges();
  selection.addRange(range);
}

function selectNodes(nodes: Node[]) {
  const selection = window.getSelection();
  const firstNode = nodes[0];
  const lastNode = nodes.at(-1);
  if (!selection || !firstNode || !lastNode) {
    return;
  }
  const range = document.createRange();
  range.setStartBefore(firstNode);
  range.setEndAfter(lastNode);
  selection.removeAllRanges();
  selection.addRange(range);
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
