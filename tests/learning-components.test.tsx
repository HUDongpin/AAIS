import { createRef } from "react";
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { ContentSidePanel } from "@/components/pages/learning/content-side-panel";
import { DocumentEditor } from "@/components/pages/learning/document-editor";
import { GuidePanel } from "@/components/pages/learning/guide-panel";
import { LearningTopBar } from "@/components/pages/learning/learning-top-bar";
import type {
  AaisClientTaskRecord,
  ContentItemId,
  ContentTab,
  SavedLearningDocument,
} from "@/components/pages/learning/learning-page-types";

describe("learning page components", () => {
  it("scrolls a newly appended user message into the visible transcript", () => {
    const scrollIntoView = vi.fn();
    const originalScrollIntoView = HTMLElement.prototype.scrollIntoView;
    Object.defineProperty(HTMLElement.prototype, "scrollIntoView", {
      configurable: true,
      value: scrollIntoView,
    });

    const renderGuidePanel = (guideMessages: React.ComponentProps<typeof GuidePanel>["guideMessages"]) => (
      <GuidePanel
        addGuideFiles={vi.fn()}
        backendError=""
        guideAttachmentBusy={false}
        guideAttachmentError=""
        guideAttachments={[]}
        guideBusy={false}
        guideDraft=""
        guideError=""
        guideFileInputRef={createRef<HTMLInputElement>()}
        guideMessages={guideMessages}
        hasGuideSubmission={false}
        onRemoveAttachment={vi.fn()}
        sendGuideMessage={vi.fn()}
        setGuideDraft={vi.fn()}
        setGuideError={vi.fn()}
      />
    );

    try {
      const assistantMessage = {
        id: "assistant-1",
        kind: "assistant" as const,
        text: "先说说你的想法。",
      };
      const { rerender } = render(renderGuidePanel([assistantMessage]));

      rerender(renderGuidePanel([
        assistantMessage,
        {
          id: "user-2",
          kind: "user",
          text: "不知道",
        },
        {
          id: "assistant-3",
          kind: "assistant",
          text: "正在思考...",
        },
      ]));

      const userMessage = screen.getByText("不知道").closest("[data-guide-message-id]");
      expect(scrollIntoView).toHaveBeenCalledTimes(1);
      expect(scrollIntoView.mock.contexts[0]).toBe(userMessage);
      expect(scrollIntoView).toHaveBeenCalledWith({
        block: "nearest",
        inline: "nearest",
      });
    } finally {
      if (originalScrollIntoView) {
        Object.defineProperty(HTMLElement.prototype, "scrollIntoView", {
          configurable: true,
          value: originalScrollIntoView,
        });
      } else {
        delete (HTMLElement.prototype as Partial<HTMLElement>).scrollIntoView;
      }
    }
  });

  it.each([
    {
      agentId: "A1",
      agentLabel: "小张",
      content: "咱们继续练抛物线，x=1时y变大了，曲线是更陡还是更平？",
    },
    {
      agentId: "A2",
      agentLabel: "教授",
      content: "请比较系数变化前后的图像，再说明你的判断。",
    },
  ])("keeps $agentLabel's newly rendered and growing reply visible", ({
    agentId,
    agentLabel,
    content,
  }) => {
    const scrollIntoView = vi.fn();
    const originalScrollIntoView = HTMLElement.prototype.scrollIntoView;
    Object.defineProperty(HTMLElement.prototype, "scrollIntoView", {
      configurable: true,
      value: scrollIntoView,
    });

    const renderGuidePanel = (agentContent?: string) => (
      <GuidePanel
        addGuideFiles={vi.fn()}
        backendError=""
        guideAttachmentBusy={false}
        guideAttachmentError=""
        guideAttachments={[]}
        guideBusy={Boolean(agentContent)}
        guideDraft=""
        guideError=""
        guideFileInputRef={createRef<HTMLInputElement>()}
        guideMessages={[
          {
            id: "assistant-1",
            kind: "assistant",
            text: "先说说你的想法。",
          },
          {
            id: "user-2",
            kind: "user",
            text: "你好",
          },
          ...(agentContent
            ? [{
                id: "assistant-3",
                kind: "assistant" as const,
                text: "回复生成中",
                turns: [{
                  agentId,
                  label: agentLabel,
                  content: agentContent,
                  actions: [],
                }],
              }]
            : []),
        ]}
        hasGuideSubmission={false}
        onRemoveAttachment={vi.fn()}
        sendGuideMessage={vi.fn()}
        setGuideDraft={vi.fn()}
        setGuideError={vi.fn()}
      />
    );

    try {
      const { rerender } = render(renderGuidePanel());

      rerender(renderGuidePanel(content));

      const messageEnd = document.querySelector('[data-guide-message-end="assistant-3"]');
      expect(scrollIntoView).toHaveBeenCalledTimes(1);
      expect(scrollIntoView.mock.contexts[0]).toBe(messageEnd);
      expect(scrollIntoView).toHaveBeenLastCalledWith({
        block: "end",
        inline: "nearest",
      });

      scrollIntoView.mockClear();
      rerender(renderGuidePanel(`${content} 请说说理由。`));

      expect(scrollIntoView).toHaveBeenCalledTimes(1);
      expect(scrollIntoView.mock.contexts[0]).toBe(messageEnd);
      expect(scrollIntoView).toHaveBeenLastCalledWith({
        block: "end",
        inline: "nearest",
      });
    } finally {
      if (originalScrollIntoView) {
        Object.defineProperty(HTMLElement.prototype, "scrollIntoView", {
          configurable: true,
          value: originalScrollIntoView,
        });
      } else {
        delete (HTMLElement.prototype as Partial<HTMLElement>).scrollIntoView;
      }
    }
  });

  it("renders a persistent, accessible attachment receipt inside a user message", () => {
    render(
      <GuidePanel
        addGuideFiles={vi.fn()}
        backendError=""
        guideAttachmentBusy={false}
        guideAttachmentError=""
        guideAttachments={[]}
        guideBusy={false}
        guideDraft=""
        guideError=""
        guideFileInputRef={createRef<HTMLInputElement>()}
        guideMessages={[{
          id: "user-with-docx",
          kind: "user",
          text: "请概括附件",
          attachments: [{
            name: "论文.docx",
            mediaType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
            sizeBytes: 2_048,
            status: "read",
          }],
        }]}
        hasGuideSubmission={false}
        onRemoveAttachment={vi.fn()}
        sendGuideMessage={vi.fn()}
        setGuideDraft={vi.fn()}
        setGuideError={vi.fn()}
      />,
    );

    expect(screen.getByRole("list", { name: "此消息已发送的文件" })).toBeTruthy();
    expect(screen.getByLabelText("附件 论文.docx，Word 文档，2.0 KB，上传成功并已读取")).toBeTruthy();
  });

  it("keeps LearningTopBar account privacy actions and logout wired", () => {
    const onDeleteLearnerData = vi.fn();
    const onExportLearnerData = vi.fn();
    const onLogout = vi.fn();

    const renderTopBar = (privacyBusy: boolean) => (
      <LearningTopBar
        accountMenuOpen
        displayName="Bobie"
        loggingOut={false}
        privacyBusy={privacyBusy}
        onDeleteLearnerData={onDeleteLearnerData}
        onExportLearnerData={onExportLearnerData}
        onLogout={onLogout}
        onToggleAccountMenu={vi.fn()}
      />
    );
    const { rerender } = render(renderTopBar(false));

    fireEvent.click(screen.getByRole("menuitem", { name: "导出学习数据" }));
    rerender(renderTopBar(true));
    rerender(renderTopBar(false));
    fireEvent.click(screen.getByRole("menuitem", { name: "删除学习数据" }));
    rerender(renderTopBar(true));
    rerender(renderTopBar(false));
    fireEvent.click(screen.getByRole("menuitem", { name: "退出" }));

    expect(onExportLearnerData).toHaveBeenCalledTimes(1);
    expect(onDeleteLearnerData).toHaveBeenCalledTimes(1);
    expect(onLogout).toHaveBeenCalledTimes(1);
  });

  it("marks the account menu busy and disables every account action while an operation runs", () => {
    render(
      <LearningTopBar
        accountMenuOpen
        displayName="Bobie"
        loggingOut={false}
        privacyBusy
        onDeleteLearnerData={vi.fn()}
        onExportLearnerData={vi.fn()}
        onLogout={vi.fn()}
        onToggleAccountMenu={vi.fn()}
      />,
    );

    expect(screen.getByRole("menu", { name: "Bobie 账户信息" }).getAttribute("aria-busy")).toBe("true");
    expect((screen.getByRole("menuitem", { name: "导出学习数据" }) as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByRole("menuitem", { name: "删除学习数据" }) as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByRole("menuitem", { name: "退出" }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("keeps GuidePanel draft input and attachment removal wired without temporary quick starts", () => {
    const onRemoveAttachment = vi.fn();
    const setGuideDraft = vi.fn();
    const setGuideError = vi.fn();
    const sendGuideMessage = vi.fn((event: React.FormEvent<HTMLFormElement>) => {
      event.preventDefault();
    });

    render(
      <GuidePanel
        addGuideFiles={vi.fn()}
        backendError=""
        guideAttachmentBusy={false}
        guideAttachmentError=""
        guideAttachments={[
          {
            id: "attachment-1",
            name: "notes.pdf",
            mediaType: "application/pdf",
            sizeBytes: 2048,
            extractedText: "核心内容",
          },
        ]}
        guideBusy={false}
        guideDraft=""
        guideError=""
        guideFileInputRef={createRef<HTMLInputElement>()}
        guideMessages={[
          {
            id: "assistant-1",
            kind: "assistant",
            text: "你好",
          },
        ]}
        hasGuideSubmission
        onRemoveAttachment={onRemoveAttachment}
        sendGuideMessage={sendGuideMessage}
        setGuideDraft={setGuideDraft}
        setGuideError={setGuideError}
      />,
    );

    expect(screen.queryByRole("button", { name: "明确学习目标" })).toBeNull();
    expect(screen.queryByRole("button", { name: "开始示范" })).toBeNull();
    expect(screen.queryByRole("button", { name: "我卡住了，给我支架" })).toBeNull();
    expect(screen.queryByRole("button", { name: "整理反思记录" })).toBeNull();
    const hiddenFileInput = screen.getByLabelText("选择上传文件") as HTMLInputElement;
    expect(hiddenFileInput.tabIndex).toBe(-1);
    expect(hiddenFileInput.getAttribute("aria-hidden")).toBe("true");
    fireEvent.change(screen.getByLabelText("向智能导学输入你的想法"), {
      target: {
        value: "请帮我整理下一步",
      },
    });
    fireEvent.click(screen.getByRole("button", { name: "移除 notes.pdf" }));
    fireEvent.submit(screen.getByLabelText("向智能导学输入你的想法").closest("form") as HTMLFormElement);

    expect(setGuideDraft).toHaveBeenCalledWith("请帮我整理下一步");
    expect(setGuideError).toHaveBeenCalledWith("");
    expect(onRemoveAttachment).toHaveBeenCalledWith("attachment-1");
    expect(sendGuideMessage).toHaveBeenCalledTimes(1);
  });

  it("moves a function-graph learning choice into the composer and focuses it", () => {
    const setGuideDraft = vi.fn();
    const setGuideError = vi.fn();
    render(
      <GuidePanel
        addGuideFiles={vi.fn()}
        backendError=""
        guideAttachmentBusy={false}
        guideAttachmentError=""
        guideAttachments={[]}
        guideBusy={false}
        guideDraft=""
        guideError=""
        guideFileInputRef={createRef<HTMLInputElement>()}
        guideMessages={[{
          id: "assistant-graph",
          kind: "assistant",
          text: "done",
          turns: [{
            agentId: "A1",
            label: "小张",
            content: "当然，先看图。",
            actions: ["show-function-graph"],
            visualizations: [{
              id: "quadratic-2-3-4",
              type: "quadratic-function",
              expression: "y = 2x² + 3x + 4",
              coefficients: { a: 2, b: 3, c: 4 },
              domain: { xMin: -5, xMax: 4 },
              vertex: { x: -0.75, y: 2.875 },
              axisX: -0.75,
              yIntercept: 4,
            }],
          }],
        }]}
        hasGuideSubmission={false}
        onRemoveAttachment={vi.fn()}
        sendGuideMessage={vi.fn()}
        setGuideDraft={setGuideDraft}
        setGuideError={setGuideError}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "示范代入" }));

    expect(setGuideDraft).toHaveBeenCalledWith(
      "请示范把 x = -3/4 代入 y = 2x² + 3x + 4。",
    );
    expect(setGuideError).toHaveBeenCalledWith("");
    expect(document.activeElement).toBe(screen.getByLabelText("向智能导学输入你的想法"));
  });

  it("keeps AI guide busy controls and errors without the redundant visible status", () => {
    render(
      <GuidePanel
        addGuideFiles={vi.fn()}
        backendError="学习记录服务暂时不可用。"
        guideAttachmentBusy={false}
        guideAttachmentError="文件未能读取。"
        guideAttachments={[
          {
            id: "attachment-1",
            name: "notes.pdf",
            mediaType: "application/pdf",
            sizeBytes: 2048,
            extractedText: "核心内容",
          },
        ]}
        guideBusy
        guideDraft="请帮我整理下一步"
        guideError="智能服务暂时不可用。"
        guideFileInputRef={createRef<HTMLInputElement>()}
        guideMessages={[]}
        hasGuideSubmission
        onRemoveAttachment={vi.fn()}
        sendGuideMessage={vi.fn()}
        setGuideDraft={vi.fn()}
        setGuideError={vi.fn()}
      />,
    );

    expect(screen.queryByText("智能导学处理中...")).toBeNull();
    expect(screen.queryByRole("status")).toBeNull();
    expect(
      screen.getByLabelText("向智能导学输入你的想法").closest("section")?.getAttribute("aria-busy"),
    ).toBe("true");
    expect(screen.getAllByRole("alert").map((alert) => alert.textContent)).toEqual([
      "文件未能读取。",
      "智能服务暂时不可用。",
      "学习记录服务暂时不可用。",
    ]);
    expect(screen.queryByRole("button", { name: "明确学习目标" })).toBeNull();
    expect((screen.getByRole("button", { name: "上传文件" }) as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByRole("button", { name: "发送" }) as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByRole("button", { name: "移除 notes.pdf" }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("announces guide attachment reading and blocks composer actions while files load", () => {
    render(
      <GuidePanel
        addGuideFiles={vi.fn()}
        backendError=""
        guideAttachmentBusy
        guideAttachmentError=""
        guideAttachments={[]}
        guideBusy={false}
        guideDraft="请结合上传材料"
        guideError=""
        guideFileInputRef={createRef<HTMLInputElement>()}
        guideMessages={[]}
        hasGuideSubmission
        onRemoveAttachment={vi.fn()}
        sendGuideMessage={vi.fn()}
        setGuideDraft={vi.fn()}
        setGuideError={vi.fn()}
      />,
    );

    const status = screen.getByRole("status");
    expect(status.textContent).toBe("文件正在读取...");
    expect(status.getAttribute("aria-live")).toBe("polite");
    expect(status.getAttribute("aria-atomic")).toBe("true");
    expect(status.closest("section")?.getAttribute("aria-busy")).toBe("true");
    expect((screen.getByRole("button", { name: "上传文件" }) as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByRole("button", { name: "发送" }) as HTMLButtonElement).disabled).toBe(true);
    expect(screen.queryByRole("button", { name: "明确学习目标" })).toBeNull();
  });

  it("keeps ContentSidePanel display menu and history document callbacks isolated", () => {
    const onOpenContent = vi.fn();
    const onOpenDocument = vi.fn();
    const historyDocument = createSavedDocument();
    const { rerender } = render(
      <ContentSidePanel
        {...createContentSidePanelProps({
          historyDocuments: [historyDocument],
          onOpenContent,
          onOpenDocument,
        })}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: /任务卡片/ }));
    expect(onOpenContent).toHaveBeenCalledWith("theory");

    rerender(
      <ContentSidePanel
        {...createContentSidePanelProps({
          activeContentId: "history",
          historyDocuments: [historyDocument],
          onOpenContent,
          onOpenDocument,
        })}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "历史文档文件夹：学习记录" }));
    expect(onOpenDocument).toHaveBeenCalledWith(historyDocument);
  });

  it("renders server-backed task cards as a sequential locked flow", () => {
    const onCompleteTask = vi.fn();
    const onSelectTask = vi.fn();
    const initialTasks = createTaskCardRecords([
      "active",
      "locked",
      "locked",
      "locked",
    ]);
    const { rerender } = render(
      <ContentSidePanel
        {...createContentSidePanelProps({
          activeContentId: "theory",
          activeTaskId: "training_task_1",
          onCompleteTask,
          onSelectTask,
          tasks: initialTasks,
        })}
      />,
    );

    expect(document.querySelector('[data-task-card="training_task_1"]')?.getAttribute("data-task-status"))
      .toBe("active");
    expect(document.querySelector('[data-task-card="practice_task_1"]')?.getAttribute("data-task-status"))
      .toBe("locked");
    expect((screen.getByRole("button", {
      name: "L1 挑战：复述与计划，已锁定",
    }) as HTMLButtonElement).disabled).toBe(true);

    fireEvent.click(screen.getByRole("button", {
      name: "完成任务：专家示范后的案例训练",
    }));
    expect(onCompleteTask).toHaveBeenCalledWith("training_task_1");
    expect(onSelectTask).not.toHaveBeenCalled();

    rerender(
      <ContentSidePanel
        {...createContentSidePanelProps({
          activeContentId: "theory",
          activeTaskId: "training_task_1",
          onCompleteTask,
          onSelectTask,
          tasks: createTaskCardRecords([
            "completed",
            "available",
            "locked",
            "locked",
          ]),
        })}
      />,
    );

    expect(document.querySelector('[data-task-card="training_task_1"]')?.getAttribute("data-task-status"))
      .toBe("completed");
    expect(document.querySelector('[data-task-card="practice_task_1"]')?.getAttribute("data-task-status"))
      .toBe("available");
    fireEvent.click(screen.getByRole("button", {
      name: "进入任务：L1 挑战：复述与计划",
    }));
    expect(onSelectTask).toHaveBeenCalledWith("practice_task_1");
    expect(screen.getByText("已完成 1/4 个任务")).toBeTruthy();
  });

  it("disables content and history entry points while document navigation is locked", () => {
    const onOpenContent = vi.fn();
    const onOpenDocument = vi.fn();
    const historyDocument = createSavedDocument();
    const { rerender } = render(
      <ContentSidePanel
        {...createContentSidePanelProps({
          documentNavigationLocked: true,
          historyDocuments: [historyDocument],
          onOpenContent,
          onOpenDocument,
        })}
      />,
    );

    const historyEntry = screen.getByRole("button", { name: "历史文档" }) as HTMLButtonElement;
    expect(historyEntry.disabled).toBe(true);
    fireEvent.click(historyEntry);
    expect(onOpenContent).not.toHaveBeenCalled();

    rerender(
      <ContentSidePanel
        {...createContentSidePanelProps({
          activeContentId: "history",
          documentNavigationLocked: true,
          historyDocuments: [historyDocument],
          onOpenContent,
          onOpenDocument,
        })}
      />,
    );

    const historyFolder = screen.getByRole("button", {
      name: "历史文档文件夹：学习记录",
    }) as HTMLButtonElement;
    expect(historyFolder.disabled).toBe(true);
    fireEvent.click(historyFolder);
    expect(onOpenDocument).not.toHaveBeenCalled();
    expect((screen.getByRole("button", { name: "返回内容展示" }) as HTMLButtonElement).disabled)
      .toBe(true);
  });

  it("keeps DocumentEditor title, rich text, and blur persistence callbacks wired", () => {
    const onArtifactChange = vi.fn();
    const onArtifactBlur = vi.fn();
    const onDocumentTitleChange = vi.fn();

    render(
      <DocumentEditor
        artifactText="<p>旧记录</p>"
        documentTitle="初稿"
        onArtifactChange={onArtifactChange}
        onArtifactBlur={onArtifactBlur}
        onDocumentTitleChange={onDocumentTitleChange}
      />,
    );

    fireEvent.change(screen.getByLabelText("文档标题"), {
      target: {
        value: "学习计划",
      },
    });
    const editor = screen.getByRole("textbox", {
      name: "在这里写下任务理解、计划、执行过程或最终产出。",
    });
    editor.innerHTML = "<h1>学习计划</h1><p>新记录</p>";
    fireEvent.input(editor);
    fireEvent.blur(editor);

    expect(onDocumentTitleChange).toHaveBeenCalledWith("学习计划");
    expect(onArtifactChange).toHaveBeenCalledWith("<h1>学习计划</h1><p>新记录</p>");
    expect(onArtifactBlur).toHaveBeenCalledTimes(1);
  });

  it("sanitizes active pasted HTML before it reaches autosave state", () => {
    const onArtifactChange = vi.fn();
    render(
      <DocumentEditor
        artifactText=""
        documentTitle=""
        onArtifactChange={onArtifactChange}
        onArtifactBlur={vi.fn()}
        onDocumentTitleChange={vi.fn()}
      />,
    );
    const editor = screen.getByRole("textbox", {
      name: "在这里写下任务理解、计划、执行过程或最终产出。",
    });
    editor.innerHTML = '<p onclick="alert(1)">学习记录</p>'
      + '<iframe src="https://attacker.example.test/frame"></iframe>'
      + '<a href="https://attacker.example.test/collect">外部链接</a>';

    fireEvent.input(editor);

    expect(onArtifactChange).toHaveBeenLastCalledWith("<p>学习记录</p>外部链接");
    expect(editor.innerHTML).toBe("<p>学习记录</p>外部链接");
    expect(editor.innerHTML).not.toContain("attacker.example.test");
  });
});

function createContentSidePanelProps(overrides: Partial<{
  activeContentId: ContentItemId | null;
  activeTaskId: string;
  activeTab: ContentTab;
  artifactSaveBusy: boolean;
  artifactSaveError: string;
  artifactSaveStatus: string;
  artifactText: string;
  documentDownloadBusy: boolean;
  documentDownloadError: string;
  documentDownloadStatus: string;
  documentTitle: string;
  documentNavigationLocked: boolean;
  flushPendingArtifactSave: () => void;
  historyDocuments: SavedLearningDocument[];
  onDocumentTitleChange: (value: string) => void;
  onDownloadDocument: () => void;
  onBackContent: () => void;
  onCompleteTask: (taskId: string) => void;
  onOpenContent: (id: ContentItemId) => void;
  onOpenDocument: (document: SavedLearningDocument) => void;
  onRecordArtifact: (value: string) => void;
  onSaveAndCloseDocument: () => void;
  onSelectTask: (taskId: string) => void;
  selectContentTab: (nextTab: ContentTab) => void;
  taskActionBusy: boolean;
  taskActionError: string;
  tasks: AaisClientTaskRecord[];
}> = {}) {
  return {
    activeContentId: null,
    activeTaskId: "training_task_1",
    activeTab: "display" as ContentTab,
    artifactSaveBusy: false,
    artifactSaveError: "",
    artifactSaveStatus: "",
    artifactText: "",
    documentDownloadBusy: false,
    documentDownloadError: "",
    documentDownloadStatus: "",
    documentTitle: "",
    documentNavigationLocked: false,
    flushPendingArtifactSave: vi.fn(),
    historyDocuments: [],
    onDocumentTitleChange: vi.fn(),
    onDownloadDocument: vi.fn(),
    onBackContent: vi.fn(),
    onCompleteTask: vi.fn(),
    onOpenContent: vi.fn(),
    onOpenDocument: vi.fn(),
    onRecordArtifact: vi.fn(),
    onSaveAndCloseDocument: vi.fn(),
    onSelectTask: vi.fn(),
    selectContentTab: vi.fn(),
    taskActionBusy: false,
    taskActionError: "",
    tasks: [],
    ...overrides,
  };
}

function createTaskCardRecords(
  statuses: NonNullable<AaisClientTaskRecord["status"]>[],
): AaisClientTaskRecord[] {
  return [
    "training_task_1",
    "practice_task_1",
    "practice_task_2",
    "practice_task_3",
  ].map((taskId, index) => ({
    taskId,
    phase: index === 0 ? "training" : "practice",
    status: statuses[index],
    artifactText: "",
    artifactRevision: 0,
    selfReportRevision: 0,
  }));
}

function createSavedDocument(): SavedLearningDocument {
  return {
    id: "doc-1",
    taskId: "training_task_1",
    title: "学习记录",
    html: "<p>记录</p>",
    markdown: "记录",
    savedAt: new Date("2026-07-08T08:00:00.000Z"),
  };
}
