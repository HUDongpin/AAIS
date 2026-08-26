import { createRef, StrictMode, useState } from "react";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { ContentSidePanel } from "@/components/pages/learning/content-side-panel";
import { DocumentEditor } from "@/components/pages/learning/document-editor";
import { GuidePanel } from "@/components/pages/learning/guide-panel";
import { useHydratePersistedGuideMessages } from "@/components/pages/learning/guide-message-persistence";
import { LearningTopBar } from "@/components/pages/learning/learning-top-bar";
import { createPilotLearningActions } from "@/components/pages/learning/pilot-learning-actions";
import {
  PilotExpertModel,
  PilotFlowOverview,
  PilotSummaryCard,
  PilotTaskExperience,
  type PilotLearningActions,
} from "@/components/pages/learning/pilot-learning-loop";
import type {
  AaisClientTaskRecord,
  ContentItemId,
  ContentTab,
  GuideMessage,
  SavedLearningDocument,
} from "@/components/pages/learning/learning-page-types";
import { getCaasiPilotTaskDefinition } from "@/data/aais-course-packages";

function GuideHydrationHarness({
  initial = [],
  persisted,
}: {
  initial?: GuideMessage[];
  persisted: GuideMessage[];
}) {
  const [messages, setMessages] = useState<GuideMessage[]>(initial);
  useHydratePersistedGuideMessages(persisted, setMessages);
  return <output data-testid="hydrated-guide-ids">{messages.map((message) => message.id).join(",")}</output>;
}

describe("learning page components", () => {
  const canonicalPersistedGuideExchange: GuideMessage[] = [
    {
      id: "user-77777777-7777-4777-8777-777777777777",
      kind: "user",
      text: "服务端问题",
    },
    {
      id: "assistant-88888888-8888-4888-8888-888888888888",
      kind: "assistant",
      text: "服务端回答",
    },
  ];

  it("hydrates a persisted canonical exchange from empty reload state under Strict Mode", async () => {
    const { rerender } = render(
      <StrictMode>
        <GuideHydrationHarness persisted={[]} />
      </StrictMode>,
    );

    rerender(
      <StrictMode>
        <GuideHydrationHarness persisted={canonicalPersistedGuideExchange} />
      </StrictMode>,
    );

    await waitFor(() => expect(screen.getByTestId("hydrated-guide-ids").textContent).toBe(
      "user-77777777-7777-4777-8777-777777777777,assistant-88888888-8888-4888-8888-888888888888",
    ));
  });

  it("does not duplicate a persisted canonical exchange after local rekeying", async () => {
    const { rerender } = render(
      <StrictMode>
        <GuideHydrationHarness
          initial={canonicalPersistedGuideExchange}
          persisted={[]}
        />
      </StrictMode>,
    );

    rerender(
      <StrictMode>
        <GuideHydrationHarness
          initial={canonicalPersistedGuideExchange}
          persisted={canonicalPersistedGuideExchange}
        />
      </StrictMode>,
    );

    await waitFor(() => expect(screen.getByTestId("hydrated-guide-ids").textContent).toBe(
      "user-77777777-7777-4777-8777-777777777777,assistant-88888888-8888-4888-8888-888888888888",
    ));
  });

  it("keeps a newly appended user message and immediately completed reply visible", () => {
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
      const agentMessageEnd = document.querySelector('[data-guide-message-end="assistant-3"]');
      expect(scrollIntoView).toHaveBeenCalledTimes(2);
      expect(scrollIntoView.mock.contexts[0]).toBe(userMessage);
      expect(scrollIntoView.mock.contexts[1]).toBe(agentMessageEnd);
      expect(scrollIntoView).toHaveBeenNthCalledWith(1, {
        block: "nearest",
        inline: "nearest",
      });
      expect(scrollIntoView).toHaveBeenNthCalledWith(2, {
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
    const guideInput = screen.getByLabelText("向智能导学输入你的想法") as HTMLInputElement;
    expect(guideInput.closest('[aria-busy="true"]')).toBeTruthy();
    expect(guideInput.closest("section")?.hasAttribute("aria-busy")).toBe(false);
    expect(guideInput.disabled).toBe(true);
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

  it("shows the transient thinking bubble only for the latest blank A2 reply", () => {
    const renderGuidePanel = (
      pendingGuideAgentId: "A1" | "A2" | null,
      guideBusy: boolean,
    ) => (
      <GuidePanel
        addGuideFiles={vi.fn()}
        backendError=""
        guideAttachmentBusy={false}
        guideAttachmentError=""
        guideAttachments={[]}
        guideBusy={guideBusy}
        guideDraft=""
        guideError=""
        guideFileInputRef={createRef<HTMLInputElement>()}
        guideMessages={[
          {
            id: "user-professor",
            kind: "user",
            text: "@教授 请检查下一步",
          },
          {
            id: "assistant-professor",
            kind: "assistant",
            text: "",
          },
        ]}
        hasGuideSubmission={false}
        onRemoveAttachment={vi.fn()}
        pendingGuideAgentId={pendingGuideAgentId}
        sendGuideMessage={vi.fn()}
        setGuideDraft={vi.fn()}
        setGuideError={vi.fn()}
      />
    );
    const { rerender } = render(renderGuidePanel("A2", true));

    const statusText = screen.getByText("教授正在思考");
    const pendingMessage = statusText.closest('[data-guide-message-id="assistant-professor"]');
    expect(pendingMessage).toBeTruthy();
    expect(statusText.closest('[aria-live="polite"]')).toBeTruthy();
    expect(screen.getByRole("img", { name: "教授大学教育风格头像" })).toBeTruthy();
    expect(document.querySelectorAll('[data-guide-thinking-agent="A2"]')).toHaveLength(1);
    expect(screen.queryByText("智能导学处理中...")).toBeNull();

    rerender(renderGuidePanel("A1", true));
    expect(screen.queryByText("教授正在思考")).toBeNull();

    rerender(renderGuidePanel("A2", false));
    expect(screen.queryByText("教授正在思考")).toBeNull();
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
    const guideInput = screen.getByLabelText("向智能导学输入你的想法") as HTMLInputElement;
    expect(guideInput.closest('[aria-busy="true"]')).toBeTruthy();
    expect(status.closest("section")?.hasAttribute("aria-busy")).toBe(false);
    expect(guideInput.disabled).toBe(true);
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
      name: "社交媒体与大学生心理健康课程论文大纲，已锁定",
    }) as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByText(
      "我想写一篇关于社交媒体对大学生心理健康影响的课程论文，请帮我写一个大纲，要有引言、文献综述、分析和结论。",
    )).toBeTruthy();
    expect(screen.getByText("练习1")).toBeTruthy();
    expect(screen.getByText("练习2")).toBeTruthy();
    expect(screen.getByText("练习3")).toBeTruthy();
    expect(screen.getByText(
      "先导实验阶段，任务3暂不开放，完成任务2后，会自动进入任务4",
    ).getAttribute("data-task-card-note")).toBe("practice_task_2");
    expect(document.querySelector('[data-task-card="practice_task_2"]')?.getAttribute(
      "data-task-availability",
    )).toBe("pilot-closed");
    expect((screen.getByRole("button", {
      name: "L2 挑战：执行与监控，暂不开放",
    }) as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByText(
      "产出一份结构完整、内容合理、可操作性强的《大学生GenAI学习使用指南》设计稿（不少于800字）。",
    )).toBeTruthy();

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
      name: "进入任务：社交媒体与大学生心理健康课程论文大纲",
    }));
    expect(onSelectTask).toHaveBeenCalledWith("practice_task_1");
    expect(screen.getByText("已完成 1/3 个开放任务")).toBeTruthy();
  });

  it("shows the seven-stage pilot flow and keeps completed modelling visible after task transition", () => {
    const actions = createPilotActions();
    render(
      <PilotFlowOverview
        actions={actions}
        locale="zh-CN"
        tasks={[
          createPilotTaskRecord({
            taskId: "training_task_1",
            phase: "training",
            status: "completed",
            milestones: [
              createMilestone("launch_import", "completed"),
              createMilestone("modeling", "completed"),
            ],
          }),
          createPilotTaskRecord({
            taskId: "practice_task_1",
            status: "active",
            activeMilestone: "coaching_scaffolding",
          }),
        ]}
      />,
    );

    expect(document.querySelectorAll("[data-pilot-milestone]")).toHaveLength(7);
    expect(document.querySelector('[data-pilot-milestone="modeling"]')?.getAttribute("data-milestone-status"))
      .toBe("completed");
    expect(screen.getByText("课程内容仍待教师审核；当前仅用于受控先导验证。")).toBeTruthy();
    expect((screen.getByRole("button", { name: "启动说明已确认" }) as HTMLButtonElement).disabled)
      .toBe(true);
  });

  it("renders the Professor's localized think-aloud model from the course package", async () => {
    const actions = createPilotActions();
    render(
      <PilotExpertModel
        actions={actions}
        locale="zh-CN"
        task={createPilotTaskRecord({
          taskId: "training_task_1",
          phase: "training",
          activeMilestone: "modeling",
        })}
      />,
    );

    expect(screen.getByText("20 分钟 · 100 分", { exact: false })).toBeTruthy();
    expect(screen.getByText("完整提示词示范")).toBeTruthy();
    expect(screen.getByRole("heading", { name: /圆的面积/ })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "我已阅读并比较专家示范" }));
    await waitFor(() => {
      expect(actions.onRecordStageEvidence).toHaveBeenCalledWith({
        evidenceKind: "expert_model_reviewed",
        stageId: "modeling",
        taskId: "training_task_1",
      });
    });
  });

  it("saves Task 2 structured evidence in AI-free mode without fabricating AI acceptance", async () => {
    const courseTask = getCaasiPilotTaskDefinition("practice_task_1");
    expect(courseTask).toBeTruthy();
    const actions = createPilotActions();
    render(
      <PilotTaskExperience
        actions={actions}
        artifactText=""
        courseTask={courseTask!}
        latestAssistantMessageId={null}
        locale="zh-CN"
        task={createPilotTaskRecord({
          taskId: "practice_task_1",
          completionMissing: courseTask!.completionRequirements.map((requirement) => requirement.id),
          scaffoldState: {
            currentLevel: 1,
            intensity: "prompt-question",
            fading: false,
            remainingDirectAssists: 4,
          },
        })}
      />,
    );

    expect(screen.getByText("练习1")).toBeTruthy();
    expect(screen.getByText("练习2")).toBeTruthy();
    expect(screen.getByText("练习3")).toBeTruthy();
    fireEvent.click(screen.getByLabelText("不使用实时 GenAI"));
    expect(await screen.findByText("AI 使用选择已保存。")).toBeTruthy();
    expect(actions.onSaveAiUseMode).toHaveBeenCalledWith({
      aiUseMode: "ai-free",
      taskId: "practice_task_1",
    });
    fireEvent.change(screen.getByLabelText(/指出原提示词的不足并说明理由/), {
      target: { value: "对象、范围和证据标准不明确。" },
    });
    fireEvent.change(screen.getByLabelText(/提交清晰、具体、完整的修改版提示词/), {
      target: { value: "请按明确对象、范围与证据要求生成论文大纲。" },
    });
    fireEvent.change(screen.getByLabelText(/生成内容并评价其是否符合任务要求/), {
      target: { value: "结构覆盖要求，但证据来源仍需补充。" },
    });
    fireEvent.change(screen.getByLabelText(/说明本任务中使用的规划、监控和评价方法/), {
      target: { value: "先列约束，生成后逐项核对，再修订缺失项。" },
    });
    fireEvent.click(screen.getByRole("button", { name: "保存学习证据" }));

    await waitFor(() => {
      expect(actions.onSavePilotEvidence).toHaveBeenCalledWith({
        taskId: "practice_task_1",
        pilotEvidence: expect.objectContaining({
          aiUseMode: "ai-free",
          outputEvaluation: "ai_free",
          diagnosisText: "对象、范围和证据标准不明确。",
          revisedPromptText: "请按明确对象、范围与证据要求生成论文大纲。",
          outputEvaluationText: "结构覆盖要求，但证据来源仍需补充。",
          articulationText: "先列约束，生成后逐项核对，再修订缺失项。",
        }),
      });
    });
    expect(actions.onRecordAiAcceptance).not.toHaveBeenCalled();
  });

  it("retains a failed AI-free choice draft and retries the same explicit action", async () => {
    const courseTask = getCaasiPilotTaskDefinition("practice_task_1")!;
    const onSaveAiUseMode = vi.fn()
      .mockRejectedValueOnce(new Error("mode save failed"))
      .mockResolvedValueOnce(undefined);
    const actions = createPilotActions({ onSaveAiUseMode });
    render(
      <PilotTaskExperience
        actions={actions}
        artifactText=""
        courseTask={courseTask}
        latestAssistantMessageId={null}
        locale="zh-CN"
        task={createPilotTaskRecord({
          taskId: "practice_task_1",
          pilotEvidence: { aiUseMode: "ai-supported" },
        })}
      />,
    );

    const aiFree = screen.getByLabelText("不使用实时 GenAI") as HTMLInputElement;
    fireEvent.click(aiFree);
    expect(await screen.findByText(/未能保存 AI 使用选择/)).toBeTruthy();
    expect(aiFree.checked).toBe(true);
    expect((screen.getByRole("button", { name: "保存学习证据" }) as HTMLButtonElement).disabled)
      .toBe(true);

    fireEvent.click(screen.getByRole("button", { name: "重试保存 AI 使用选择" }));
    expect(await screen.findByText("AI 使用选择已保存。")).toBeTruthy();
    expect(onSaveAiUseMode).toHaveBeenNthCalledWith(1, {
      aiUseMode: "ai-free",
      taskId: "practice_task_1",
    });
    expect(onSaveAiUseMode).toHaveBeenNthCalledWith(2, {
      aiUseMode: "ai-free",
      taskId: "practice_task_1",
    });
    expect(aiFree.checked).toBe(true);
    expect((screen.getByRole("button", { name: "保存学习证据" }) as HTMLButtonElement).disabled)
      .toBe(false);
  });

  it("maps the immediate AI-use choice to a fenced pilot-evidence patch", async () => {
    const patchSession = vi.fn(async () => undefined);
    const actions = createPilotLearningActions({
      patchSession,
      requestScaffold: vi.fn(async () => {
        throw new Error("unexpected scaffold request");
      }),
    });

    await actions.onSaveAiUseMode({
      aiUseMode: "ai-free",
      taskId: "practice_task_1",
    });
    expect(patchSession).toHaveBeenCalledWith({
      action: "save-pilot-evidence",
      pilotEvidence: { aiUseMode: "ai-free" },
      taskId: "practice_task_1",
    });
  });

  it("records a learner's reason when rejecting a current-task AI suggestion", async () => {
    const courseTask = getCaasiPilotTaskDefinition("practice_task_1")!;
    const actions = createPilotActions();
    render(
      <PilotTaskExperience
        actions={actions}
        artifactText=""
        courseTask={courseTask}
        latestAssistantMessageId="assistant-task-2"
        locale="zh-CN"
        task={createPilotTaskRecord({
          taskId: "practice_task_1",
          pilotEvidence: {
            aiUseMode: "ai-supported",
            diagnosisText: "原提示词的任务范围不足",
            revisedPromptText: "修改后的完整提示词内容",
            outputEvaluationText: "引用依据不足，需要修订。",
            articulationText: "按量规逐项比较并修订",
          },
        })}
      />,
    );

    fireEvent.click(screen.getByLabelText("不采纳或要求修订，并说明依据"));
    fireEvent.click(screen.getByRole("button", { name: "保存学习证据" }));
    await waitFor(() => {
      expect(actions.onRecordAiAcceptance).toHaveBeenCalledWith({
        accepted: false,
        messageId: "assistant-task-2",
        reason: "引用依据不足，需要修订。",
        taskId: "practice_task_1",
      });
    });
  });

  it("does not offer a failed temporary assistant bubble as an AI acceptance target", () => {
    render(
      <ContentSidePanel
        {...createContentSidePanelProps({
          activeContentId: "theory",
          activeTaskId: "practice_task_1",
          guideMessages: [{
            id: "assistant-2",
            kind: "assistant",
            text: "智能服务暂时不可用，已保留你的问题。请稍后重试。",
            taskId: "practice_task_1",
            phase: "practice",
          }],
          tasks: createTaskCardRecords(["completed", "active", "locked", "locked"]),
        })}
      />,
    );

    fireEvent.click(screen.getByLabelText("使用 GenAI 辅助"));

    expect(screen.getByText("先在左侧与小张或教授交流，得到当前任务的 AI 回复后再记录采纳决定。")).toBeTruthy();
  });

  it("keeps task entry available while server-derived missing evidence disables only completion", () => {
    render(
      <ContentSidePanel
        {...createContentSidePanelProps({
          activeContentId: "theory",
          activeTaskId: "practice_task_1",
          tasks: [
            createPilotTaskRecord({ taskId: "training_task_1", phase: "training", status: "completed" }),
            createPilotTaskRecord({
              taskId: "practice_task_1",
              status: "active",
              completionMissing: ["diagnose_original_prompt"],
            }),
            createPilotTaskRecord({ taskId: "practice_task_2", status: "locked" }),
            createPilotTaskRecord({ taskId: "practice_task_3", status: "locked" }),
          ],
        })}
      />,
    );

    expect((screen.getByRole("button", {
      name: "继续任务：社交媒体与大学生心理健康课程论文大纲",
    }) as HTMLButtonElement).disabled).toBe(false);
    expect((screen.getByRole("button", {
      name: "完成任务：社交媒体与大学生心理健康课程论文大纲",
    }) as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByText("指出原提示词的不足并说明理由", { selector: "li" })).toBeTruthy();
    expect(screen.getByRole("button", { name: /L2 挑战.*暂不开放/ })).toBeTruthy();
  });

  it("shows scaffold level and remaining direct assists returned by the real scaffold action", async () => {
    const courseTask = getCaasiPilotTaskDefinition("practice_task_1")!;
    const actions = createPilotActions({
      onRequestScaffold: vi.fn(async () => ({
        fading: false,
        intensity: "evaluation-cue",
        level: 3 as const,
        mode: "tool-list" as const,
        remainingDirectAssists: 2,
        requestCount: 2,
        session: createPilotClientSession(),
        tool: {
          id: "pause-prompt",
          label: "暂停提示",
          body: "先指出你现在卡在哪一步。",
        },
      })),
    });
    render(
      <PilotTaskExperience
        actions={actions}
        artifactText=""
        courseTask={courseTask}
        latestAssistantMessageId={null}
        locale="zh-CN"
        task={createPilotTaskRecord({ taskId: "practice_task_1" })}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "获取下一步支架（L1）" }));
    expect(await screen.findByText("支架等级 L3")).toBeTruthy();
    expect(screen.getByText("还可直接求助 2 次")).toBeTruthy();
    expect(screen.getByText("先指出你现在卡在哪一步。")).toBeTruthy();
  });

  it("switches the next action to self-check immediately after delivering direct L4", async () => {
    const courseTask = getCaasiPilotTaskDefinition("practice_task_1")!;
    const actions = createPilotActions({
      onRequestScaffold: vi.fn(async () => ({
        fading: false,
        intensity: "worked-model",
        level: 4 as const,
        mode: "tool-list" as const,
        remainingDirectAssists: 0,
        requestCount: 4,
        session: createPilotClientSession(),
        tool: {
          id: "contrast-case",
          label: "短示范对照",
          body: "这是刚交付的第四层直接支架。",
        },
      })),
    });
    render(
      <PilotTaskExperience
        actions={actions}
        artifactText=""
        courseTask={courseTask}
        latestAssistantMessageId={null}
        locale="zh-CN"
        task={createPilotTaskRecord({
          taskId: "practice_task_1",
          scaffoldRequests: 3,
          scaffoldState: {
            currentLevel: 3,
            intensity: "evaluation-cue",
            fading: false,
            remainingDirectAssists: 1,
          },
        })}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "获取下一步支架（L4）" }));
    expect(await screen.findByText("这是刚交付的第四层直接支架。")).toBeTruthy();
    expect(screen.getByText("支架等级 L4")).toBeTruthy();
    expect(screen.getByText(/直接支架已用完/)).toBeTruthy();
    expect(screen.getByRole("button", { name: "进入自检式帮助" })).toBeTruthy();
    expect(screen.queryByText("还可直接求助 0 次")).toBeNull();
    expect(screen.queryByRole("button", { name: "获取下一步支架（L4）" })).toBeNull();
  });

  it("explains evidence-aware fading without claiming mastery or consuming direct assists", async () => {
    const courseTask = getCaasiPilotTaskDefinition("practice_task_1")!;
    const earlySnapshot = {
      schemaVersion: 1 as const,
      structuredFieldsCompleted: 1,
      artifactVisibleCharacterBucket: "under_8" as const,
      completedMilestones: 0,
      rawTextIncluded: false as const,
    };
    const actions = createPilotActions({
      onRequestScaffold: vi.fn(async () => ({
        fading: true,
        fadingReason: "evidence_improved" as const,
        evidenceSnapshot: earlySnapshot,
        intensity: "prompt-question",
        level: 1 as const,
        mode: "self-check" as const,
        remainingDirectAssists: 3,
        requestCount: 2,
        session: createPilotClientSession(),
        tool: {
          id: "stage-checklist",
          label: "独立自检",
          body: "先写下目标、下一步和一个检查标准。",
        },
      })),
    });
    const baselineTask = createPilotTaskRecord({
      taskId: "practice_task_1",
      scaffoldRequests: 1,
      scaffoldState: {
        currentLevel: 1,
        intensity: "prompt-question",
        fading: false,
        remainingDirectAssists: 3,
      },
      scaffoldHistory: [{
        toolId: "stage-checklist",
        mode: "tool-list",
        time: "2026-08-25T00:00:00.000Z",
        level: 1,
        fading: false,
        remainingDirectAssists: 3,
      }],
    });
    const view = render(
      <PilotTaskExperience
        actions={actions}
        artifactText=""
        courseTask={courseTask}
        latestAssistantMessageId={null}
        locale="zh-CN"
        task={baselineTask}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "获取下一步支架（L2）" }));
    expect(await screen.findByText(/证据已有明显进展/)).toBeTruthy();
    expect(screen.getByText(/这不表示已经掌握/)).toBeTruthy();
    expect(screen.getByText(/仍保留 3 次直接辅助/)).toBeTruthy();
    expect(screen.queryByText(/直接支架已用完/)).toBeNull();
    expect(screen.queryByText(/支架等级 L/)).toBeNull();
    expect(screen.getByRole("button", {
      name: "继续直接求助（L2，剩余 3 次）",
    })).toBeTruthy();

    view.rerender(
      <PilotTaskExperience
        actions={actions}
        artifactText=""
        courseTask={courseTask}
        latestAssistantMessageId={null}
        locale="zh-CN"
        task={createPilotTaskRecord({
          ...baselineTask,
          scaffoldRequests: 3,
          scaffoldState: {
            currentLevel: 3,
            intensity: "evaluation-cue",
            fading: false,
            remainingDirectAssists: 1,
          },
        })}
      />,
    );
    expect(screen.getByText("还可直接求助 1 次")).toBeTruthy();
    expect(screen.queryByText(/仍保留 3 次直接辅助/)).toBeNull();
    view.unmount();

    render(
      <PilotTaskExperience
        actions={createPilotActions()}
        artifactText=""
        courseTask={courseTask}
        latestAssistantMessageId={null}
        locale="zh-CN"
        task={createPilotTaskRecord({
          ...baselineTask,
          scaffoldRequests: 2,
          scaffoldState: {
            currentLevel: 1,
            intensity: "prompt-question",
            fading: true,
            remainingDirectAssists: 3,
          },
          scaffoldHistory: [
            ...(baselineTask.scaffoldHistory ?? []),
            {
              toolId: "stage-checklist",
              mode: "self-check",
              time: "2026-08-25T00:01:00.000Z",
              level: 1,
              fading: true,
              fadingReason: "evidence_improved",
              remainingDirectAssists: 3,
              evidenceSnapshot: earlySnapshot,
            },
          ],
        })}
      />,
    );
    expect(screen.getByText(/证据已有明显进展/)).toBeTruthy();
    expect(screen.getByRole("button", {
      name: "继续直接求助（L2，剩余 3 次）",
    })).toBeTruthy();
  });

  it("drops a capped manual scaffold result when A1 authoritatively exhausts direct assists", async () => {
    const courseTask = getCaasiPilotTaskDefinition("practice_task_1")!;
    const staleToolBody = "旧的证据感知自检卡片。";
    const actions = createPilotActions({
      onRequestScaffold: vi.fn(async () => ({
        fading: true,
        fadingReason: "evidence_improved" as const,
        intensity: "prompt-question",
        level: 1 as const,
        mode: "self-check" as const,
        remainingDirectAssists: 3,
        requestCount: 4,
        session: createPilotClientSession(),
        tool: {
          id: "stage-checklist",
          label: "独立自检",
          body: staleToolBody,
        },
      })),
    });
    const evidenceAwareTask = createPilotTaskRecord({
      taskId: "practice_task_1",
      scaffoldRequests: 3,
      scaffoldState: {
        currentLevel: 1,
        intensity: "prompt-question",
        fading: true,
        remainingDirectAssists: 3,
      },
      scaffoldHistory: [{
        toolId: "stage-checklist",
        mode: "self-check",
        time: "2026-08-25T00:02:00.000Z",
        level: 1,
        fading: true,
        fadingReason: "evidence_improved",
        remainingDirectAssists: 3,
      }],
    });
    const view = render(
      <PilotTaskExperience
        actions={actions}
        artifactText=""
        courseTask={courseTask}
        latestAssistantMessageId={null}
        locale="zh-CN"
        task={evidenceAwareTask}
      />,
    );

    fireEvent.click(screen.getByRole("button", {
      name: "继续直接求助（L2，剩余 3 次）",
    }));
    expect(await screen.findByText(staleToolBody)).toBeTruthy();

    view.rerender(
      <PilotTaskExperience
        actions={actions}
        artifactText=""
        courseTask={courseTask}
        latestAssistantMessageId={null}
        locale="zh-CN"
        task={createPilotTaskRecord({
          ...evidenceAwareTask,
          scaffoldRequests: 4,
          scaffoldState: {
            currentLevel: 1,
            intensity: "prompt-question",
            fading: true,
            remainingDirectAssists: 0,
          },
        })}
      />,
    );

    expect(screen.getByText(/直接支架已用完/)).toBeTruthy();
    expect(screen.getByRole("button", { name: "进入自检式帮助" })).toBeTruthy();
    expect(screen.queryByText(staleToolBody)).toBeNull();
    expect(screen.queryByText(/仍保留 3 次直接辅助/)).toBeNull();
  });

  it("offers an explicit Task 4 incomplete exit and never presents it as evidence-complete", async () => {
    const courseTask = getCaasiPilotTaskDefinition("practice_task_3")!;
    const actions = createPilotActions();
    const task = createPilotTaskRecord({
      taskId: "practice_task_3",
      completionMissing: ["reflect_after_task_four"],
      pilotEvidence: {
        aiUseMode: "ai-free",
        planningText: "先确定目标、范围和结构，再分配写作步骤。",
        monitoringText: "每一节完成后检查边界、证据和篇幅。",
        evaluationText: "按准确性、相关性和可执行性逐项评价。",
        outputEvaluationText: "识别生成建议中的过度概括并人工修订。",
        articulationText: "我先规划，再监控，最后按量规评价和修订。",
        articulationOutcome: "submitted",
      },
      reflectionReport: createReflectionReport(),
    });
    const { unmount } = render(
      <PilotTaskExperience
        actions={actions}
        artifactText={"指南正文".repeat(200)}
        courseTask={courseTask}
        latestAssistantMessageId={null}
        locale="zh-CN"
        task={task}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "结束但标记未完成" }));
    expect(screen.getByText(/不会把它算作达成学习目标/)).toBeTruthy();
    fireEvent.change(screen.getByLabelText("如愿意，可说明为什么暂不完成反思"), {
      target: { value: "今天先结束，之后继续反思。" },
    });
    fireEvent.click(screen.getByRole("button", { name: "确认结束并标记未完成" }));
    await waitFor(() => {
      expect(actions.onEndIncomplete).toHaveBeenCalledWith({
        outcome: "reflection",
        pilotEvidence: expect.objectContaining({
          articulationText: "我先规划，再监控，最后按量规评价和修订。",
          planningText: "先确定目标、范围和结构，再分配写作步骤。",
        }),
        reason: "今天先结束，之后继续反思。",
        taskId: "practice_task_3",
      });
    });

    unmount();
    render(
      <PilotSummaryCard
        actions={actions}
        locale="zh-CN"
        task={{ ...task, status: "completed", completionOutcome: "ended_incomplete" }}
      />,
    );
    expect(screen.getByText("本轮已结束，但学习目标未完成")).toBeTruthy();
    expect(screen.queryByRole("button", { name: /确认总结/ })).toBeNull();
  });

  it("preserves the Task 2 articulation draft while confirming or cancelling an incomplete exit", async () => {
    const courseTask = getCaasiPilotTaskDefinition("practice_task_1")!;
    const actions = createPilotActions();
    render(
      <PilotTaskExperience
        actions={actions}
        artifactText=""
        courseTask={courseTask}
        latestAssistantMessageId={null}
        locale="zh-CN"
        task={createPilotTaskRecord({
          taskId: "practice_task_1",
          completionMissing: ["articulate_task_two_process"],
          pilotEvidence: {
            diagnosisText: "原提示词缺少对象、范围和评价标准。",
            revisedPromptText: "请按对象、范围、结构和评价标准生成课程论文大纲。",
            outputEvaluationText: "结构基本可用，但证据边界仍需继续核查。",
          },
        })}
      />,
    );

    const articulation = screen.getByLabelText(
      /说明本任务中使用的规划、监控和评价方法/,
    ) as HTMLTextAreaElement;
    fireEvent.change(articulation, { target: { value: "这段表达草稿必须保留。" } });
    fireEvent.click(screen.getByRole("button", { name: "结束但标记未完成" }));
    fireEvent.change(screen.getByLabelText(/为什么暂不完成本任务的学习表达/), {
      target: { value: "现在先进入开放任务。" },
    });
    fireEvent.click(screen.getByRole("button", { name: "继续完成任务" }));
    expect(articulation.value).toBe("这段表达草稿必须保留。");
    expect(actions.onEndIncomplete).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "结束但标记未完成" }));
    fireEvent.click(screen.getByRole("button", { name: "确认结束并标记未完成" }));
    await waitFor(() => {
      expect(actions.onEndIncomplete).toHaveBeenCalledWith({
        outcome: "articulation",
        pilotEvidence: {
          articulationText: "这段表达草稿必须保留。",
          diagnosisText: "原提示词缺少对象、范围和评价标准。",
          outputEvaluationText: "结构基本可用，但证据边界仍需继续核查。",
          revisedPromptText: "请按对象、范围、结构和评价标准生成课程论文大纲。",
        },
        reason: "现在先进入开放任务。",
        taskId: "practice_task_1",
      });
    });
  });

  it("blocks an incomplete exit before all non-refusal evidence is server-complete", () => {
    const actions = createPilotActions();
    render(
      <PilotTaskExperience
        actions={actions}
        artifactText=""
        courseTask={getCaasiPilotTaskDefinition("practice_task_1")!}
        latestAssistantMessageId={null}
        locale="zh-CN"
        task={createPilotTaskRecord({
          taskId: "practice_task_1",
          completionMissing: ["diagnose_original_prompt", "articulate_task_two_process"],
        })}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "结束但标记未完成" }));
    expect(screen.getByText(/还不能确认未完整结束/)).toBeTruthy();
    expect(screen.getAllByText("指出原提示词的不足并说明理由", { selector: "li" }))
      .toHaveLength(2);
    const confirm = screen.getByRole("button", { name: "确认结束并标记未完成" }) as HTMLButtonElement;
    expect(confirm.disabled).toBe(true);
    fireEvent.click(confirm);
    expect(actions.onEndIncomplete).not.toHaveBeenCalled();
  });

  it("retains the Task 2 draft and never completes when the declined-evidence save fails", async () => {
    const patchSession = vi.fn(async () => {
      throw new Error("declined evidence save failed");
    });
    const actions = createPilotLearningActions({
      patchSession,
      requestScaffold: vi.fn(async () => {
        throw new Error("unexpected scaffold request");
      }),
    });
    render(
      <PilotTaskExperience
        actions={actions}
        artifactText=""
        courseTask={getCaasiPilotTaskDefinition("practice_task_1")!}
        latestAssistantMessageId={null}
        locale="zh-CN"
        task={createPilotTaskRecord({
          taskId: "practice_task_1",
          completionMissing: ["articulate_task_two_process"],
          pilotEvidence: {
            diagnosisText: "原提示词缺少对象、范围和评价标准。",
            revisedPromptText: "请按对象、范围、结构和评价标准生成课程论文大纲。",
            outputEvaluationText: "结构基本可用，但证据边界仍需继续核查。",
          },
        })}
      />,
    );
    const articulation = screen.getByLabelText(
      /说明本任务中使用的规划、监控和评价方法/,
    ) as HTMLTextAreaElement;
    fireEvent.change(articulation, { target: { value: "失败后仍要保留的表达草稿。" } });
    fireEvent.click(screen.getByRole("button", { name: "结束但标记未完成" }));
    fireEvent.click(screen.getByRole("button", { name: "确认结束并标记未完成" }));

    expect(await screen.findByText("declined evidence save failed")).toBeTruthy();
    expect(articulation.value).toBe("失败后仍要保留的表达草稿。");
    expect(patchSession).toHaveBeenCalledTimes(1);
    expect(patchSession).toHaveBeenCalledWith(expect.objectContaining({
      action: "save-pilot-evidence",
      taskId: "practice_task_1",
      pilotEvidence: expect.objectContaining({
        articulationOutcome: "declined",
        articulationText: "失败后仍要保留的表达草稿。",
      }),
    }));
    expect(patchSession).not.toHaveBeenCalledWith(expect.objectContaining({
      action: "complete-task",
    }));
  });

  it("records summary acknowledgement atomically through the summary milestone action", async () => {
    const actions = createPilotActions({
      onSavePilotEvidence: vi.fn(async () => {
        throw new Error("legacy first write must not run");
      }),
      onRecordStageEvidence: vi.fn(async () => undefined),
    });
    const task = createPilotTaskRecord({
      taskId: "practice_task_3",
      status: "completed",
      completionOutcome: "evidence_complete",
      milestones: [
        createMilestone("reflection", "completed"),
        createMilestone("summary_completion", "open"),
      ],
      pilotEvidence: { summaryAcknowledged: false },
    });
    const view = render(<PilotSummaryCard actions={actions} locale="zh-CN" task={task} />);

    fireEvent.click(screen.getByRole("button", { name: "确认总结并结束本轮" }));
    await waitFor(() => expect(actions.onRecordStageEvidence).toHaveBeenCalledWith({
      taskId: "practice_task_3",
      stageId: "summary_completion",
      evidenceKind: "summary_acknowledged",
    }));
    expect(actions.onSavePilotEvidence).not.toHaveBeenCalled();

    view.rerender(
      <PilotSummaryCard
        actions={actions}
        locale="zh-CN"
        task={{
          ...task,
          pilotEvidence: { summaryAcknowledged: true },
          milestones: [
            createMilestone("reflection", "completed"),
            createMilestone("summary_completion", "completed"),
          ],
        }}
      />,
    );
    expect((screen.getByRole("button", { name: "本轮总结已确认" }) as HTMLButtonElement).disabled)
      .toBe(true);
  });

  it("unlocks Reflection only after rendering the background expert-process report", () => {
    const courseTask = getCaasiPilotTaskDefinition("practice_task_3")!;
    const actions = createPilotActions();
    const task = createPilotTaskRecord({
      taskId: "practice_task_3",
      pilotEvidence: {
        aiUseMode: "ai-free",
        planningText: "先确定受众、目标和章节。",
        monitoringText: "逐段检查边界与可操作性。",
        evaluationText: "按任务目标逐项评价。",
        outputEvaluationText: "识别了输出中的过度概括。",
        articulationText: "最困难的是把原则转化为操作建议。",
      },
    });
    const view = render(
      <PilotTaskExperience
        actions={actions}
        artifactText={"指南正文".repeat(200)}
        courseTask={courseTask}
        latestAssistantMessageId={null}
        locale="zh-CN"
        task={task}
      />,
    );

    expect(screen.getByRole("button", { name: "保存前置证据并生成对照报告" })).toBeTruthy();
    expect(screen.queryByLabelText(/比较专家过程并写出下一次改进策略/)).toBeNull();
    expect(screen.queryByLabelText("与专家过程比较")).toBeNull();

    view.rerender(
      <PilotTaskExperience
        actions={actions}
        artifactText={"指南正文".repeat(200)}
        courseTask={courseTask}
        latestAssistantMessageId={null}
        locale="zh-CN"
        task={{
          ...task,
          reflectionReport: {} as NonNullable<AaisClientTaskRecord["reflectionReport"]>,
        }}
      />,
    );
    expect(screen.queryByLabelText(/比较专家过程并写出下一次改进策略/)).toBeNull();

    view.rerender(
      <PilotTaskExperience
        actions={actions}
        artifactText={"指南正文".repeat(200)}
        courseTask={courseTask}
        latestAssistantMessageId={null}
        locale="zh-CN"
        task={{ ...task, reflectionReport: createReflectionReport() }}
      />,
    );

    expect(screen.getByText("后台生成的反思对照报告")).toBeTruthy();
    expect(screen.getByRole("heading", { name: "专家过程对照" })).toBeTruthy();
    expect(document.querySelectorAll("[data-expert-step-id]")).toHaveLength(5);
    expect(document.querySelector('[data-expert-step-id="monitor_generation"]')
      ?.getAttribute("data-evidence-status")).toBe("evidence-missing");
    expect(screen.getByLabelText(/比较专家过程并写出下一次改进策略/)).toBeTruthy();
    expect(screen.getByLabelText(/与专家过程比较/)).toBeTruthy();
    expect(screen.queryByText("LEARNER PRIVATE RAW TEXT")).toBeNull();
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
  guideMessages: GuideMessage[];
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
    guideMessages: [],
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

function createPilotActions(
  overrides: Partial<PilotLearningActions> = {},
): PilotLearningActions {
  return {
    onEndIncomplete: vi.fn(async () => undefined),
    onRecordAiAcceptance: vi.fn(async () => undefined),
    onRecordStageEvidence: vi.fn(async () => undefined),
    onRequestScaffold: vi.fn(async () => {
      throw new Error("Unexpected scaffold request");
    }),
    onSaveAiUseMode: vi.fn(async () => undefined),
    onSavePilotEvidence: vi.fn(async () => undefined),
    ...overrides,
  };
}

function createPilotTaskRecord(
  overrides: Partial<AaisClientTaskRecord> & Pick<AaisClientTaskRecord, "taskId">,
): AaisClientTaskRecord {
  return {
    phase: "practice",
    status: "active",
    artifactText: "",
    artifactRevision: 0,
    selfReport: "",
    selfReportRevision: 0,
    pilotEvidenceRevision: 0,
    scaffoldRequests: 0,
    scaffoldHistory: [],
    pilotEvidence: {},
    completionMissing: [],
    completionOutcome: "in_progress",
    ...overrides,
  };
}

function createMilestone(
  id: NonNullable<AaisClientTaskRecord["milestones"]>[number]["id"],
  status: NonNullable<AaisClientTaskRecord["milestones"]>[number]["status"],
) {
  return { id, status };
}

function createPilotClientSession() {
  return {
    dataGeneration: 1,
    studentId: "S001",
    activeTaskId: "practice_task_1",
    tasks: [],
    guideMessages: [],
  };
}

function createReflectionReport(): NonNullable<AaisClientTaskRecord["reflectionReport"]> {
  const expertStepIds = [
    "analyze_task",
    "set_learning_goals",
    "draft_prompt",
    "monitor_generation",
    "evaluate_and_revise",
  ] as const;
  return {
    version: "aais-a4-reflection-report-v1",
    basis: "deterministic-field-presence",
    expertModelId: "circle-area-classroom-assessment",
    expertStepIds: [...expertStepIds],
    evidenceSummary: {
      artifactCharacters: 900,
      structuredFieldCharacters: {
        planningText: 12,
        monitoringText: 11,
        evaluationText: 10,
        articulationText: 18,
      },
      rawTextIncluded: false,
    },
    comparisons: expertStepIds.map((expertStepId) => ({
      expertStepId,
      evidenceFields: expertStepId === "monitor_generation"
        ? []
        : [expertStepId === "draft_prompt" ? "artifactText" : "planningText"],
      status: expertStepId === "monitor_generation"
        ? "evidence-missing" as const
        : "evidence-recorded" as const,
      recommendedAction: expertStepId === "monitor_generation"
        ? "下一次增加生成过程检查点。"
        : "继续保留对应证据。",
    })),
    learnerVisibleTurn: false,
  };
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
