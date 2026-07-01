"use client";

import { useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import {
  ArrowRight,
  BookOpen,
  Brain,
  ChartLineUp,
  CheckCircle,
  DownloadSimple,
  Eye,
  FileText,
  PaperPlaneTilt,
  Robot,
  Sparkle,
  Target,
  WarningCircle,
} from "@phosphor-icons/react";
import { Header } from "@/components/layout/header";
import {
  aaisAgents,
  aaisLearningProgram,
  articulationPrompts,
  createAaisEvent,
  scaffoldTools,
  type AaisEvent,
  type AaisAgentId,
  type AaisPhase,
} from "@/data/aais";

type StageId =
  | "home"
  | "guide"
  | "assessment"
  | "training"
  | "reflection"
  | "practice"
  | "comparison"
  | "complete";

type GuideMessage = {
  id: string;
  kind: "user" | "assistant";
  text: string;
  turns?: GuideTurn[];
  trace?: {
    graphId?: string;
    topologicalOrder?: string[];
  };
};

type GuideTurn = {
  agentId: AaisAgentId;
  label: string;
  content: string;
  actions: string[];
};

type ScaffoldPanel = {
  taskId: string;
  mode: "tool-list" | "self-check";
  requestCount: number;
  tool: {
    id: string;
    label: string;
    body: string;
  };
  time?: string;
};

type AaisClientTaskRecord = {
  taskId: string;
  phase: AaisPhase;
  status: "locked" | "available" | "active" | "completed";
  artifactText: string;
  selfReport: string;
  scaffoldRequests: number;
  scaffoldHistory: Array<{
    toolId: string;
    mode: "tool-list" | "self-check";
    time: string;
  }>;
};

type AaisClientSession = {
  studentId: string;
  activeStage: string;
  activeTaskId: string;
  tasks: AaisClientTaskRecord[];
  guideMessages: Array<
    GuideMessage & {
      orchestration?: {
        graphId?: string;
        topologicalOrder?: string[];
        threadId?: string;
      };
    }
  >;
  events: AaisEvent[];
};

const stageItems: Array<{
  id: StageId;
  label: string;
  title: string;
  summary: string;
}> = [
  {
    id: "home",
    label: "学习首页",
    title: "你好，同学，欢迎使用 AAIS",
    summary: "左侧展示学习资源与任务，右侧由智能导学发起 Cognitive Apprenticeship 流程。",
  },
  {
    id: "guide",
    label: "智能导学",
    title: "专家示范与目标说明",
    summary: "先观看短视频式示范，理解元认知知识、专家困惑与修正过程。",
  },
  {
    id: "assessment",
    label: "测评",
    title: "理解测评与反馈",
    summary: "A1 在示范后弹出 3-5 题，评分共享给 A2，错误项回到相关片段。",
  },
  {
    id: "training",
    label: "训练任务",
    title: "有人带着做一个中等难度案例",
    summary: "A1 引导任务要求，A2 监测行为，A3 在关键节点收集 articulation。",
  },
  {
    id: "reflection",
    label: "训练反思",
    title: "把刚刚的元认知过程说清楚",
    summary: "A3 汇总学生文本与行为线索，促成任务后自评。",
  },
  {
    id: "practice",
    label: "挑战练习",
    title: "练习阶段",
    summary: "三个任务按易、中、难顺序锁定；A4 可被学生主动呼叫但有次数规则。",
  },
  {
    id: "comparison",
    label: "专家比对",
    title: "学生思维轨迹 vs 专家思维轨迹",
    summary: "每个任务后，A3 并排呈现差异，让学生写下一次迁移策略。",
  },
  {
    id: "complete",
    label: "学习完成",
    title: "学习完成，过程已归档",
    summary: "学习过程、行为事件、对话和产出可导出为 JSON/CSV，用于后续分析。",
  },
];

const artifactSaveDebounceMs = 600;

export function LearningPage() {
  const [studentId] = useState(() => getInitialStudentId());
  const [activeStage, setActiveStage] = useState<StageId>("home");
  const [activeTaskId, setActiveTaskId] = useState("training_task_1");
  const [artifactText, setArtifactText] = useState("");
  const [selfReport, setSelfReport] = useState("");
  const [guideDraft, setGuideDraft] = useState("");
  const [guideMessages, setGuideMessages] = useState<GuideMessage[]>([
    {
      id: "assistant-welcome",
      kind: "assistant",
      text:
        "你好，同学，欢迎使用 AAIS。我可以协助你完成智能导学、实践探究和学习反思。请点击左侧的智能导学开始。",
    },
  ]);
  const [guideBusy, setGuideBusy] = useState(false);
  const [guideError, setGuideError] = useState("");
  const [recordedGuideDecisions, setRecordedGuideDecisions] = useState<Record<string, boolean>>({});
  const [helpRequests, setHelpRequests] = useState<Record<string, number>>({});
  const [taskRecords, setTaskRecords] = useState<AaisClientTaskRecord[]>(() => createInitialClientTasks());
  const [activeScaffoldToolId, setActiveScaffoldToolId] = useState(scaffoldTools[0].id);
  const [latestScaffold, setLatestScaffold] = useState<ScaffoldPanel | null>(null);
  const artifactSaveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pendingArtifactSaveRef = useRef<{
    taskId: string;
    value: string;
  } | null>(null);
  const [, setEvents] = useState<AaisEvent[]>(() => [
    createAaisEvent({
      studentId,
      phase: "training",
      task: "training_task_1",
      agent: "A1",
      event: "session_opened",
      detail: {
        source: "local",
      },
    }),
  ]);
  const [backendError, setBackendError] = useState("");
  const activeTask = useMemo(() => {
    const tasks = [
      ...aaisLearningProgram.training.tasks,
      ...aaisLearningProgram.practice.tasks,
    ];
    return tasks.find((task) => task.id === activeTaskId) ?? tasks[0];
  }, [activeTaskId]);
  const taskRecordById = useMemo(
    () => new Map(taskRecords.map((task) => [task.taskId, task])),
    [taskRecords],
  );
  const activeTaskRecord = taskRecordById.get(activeTaskId);
  const activeStageItem = stageItems.find((stage) => stage.id === activeStage) ?? stageItems[0];
  const activePhase: AaisPhase = activeStage === "practice" || activeTask.phase === "practice"
    ? "practice"
    : "training";
  const currentHelpCount = activeTaskRecord?.scaffoldRequests ?? helpRequests[activeTaskId] ?? 0;
  const activeScaffoldTool =
    scaffoldTools.find((tool) => tool.id === activeScaffoldToolId) ?? scaffoldTools[0];
  const persistedScaffold = useMemo<ScaffoldPanel | null>(() => {
    const history = activeTaskRecord?.scaffoldHistory ?? [];
    const last = history[history.length - 1];
    if (!last) {
      return null;
    }
    const tool = scaffoldTools.find((candidate) => candidate.id === last.toolId) ?? scaffoldTools[0];
    return {
      taskId: activeTaskId,
      mode: last.mode,
      requestCount: activeTaskRecord?.scaffoldRequests ?? history.length,
      tool,
      time: last.time,
    };
  }, [activeTaskId, activeTaskRecord]);
  const visibleScaffold =
    latestScaffold?.taskId === activeTaskId ? latestScaffold : persistedScaffold;
  const latestStudentTrace = createStudentTrace(artifactText, selfReport, currentHelpCount);

  useEffect(() => {
    let cancelled = false;

    async function loadSession() {
      try {
        const response = await fetch("/api/learning/session");
        const body = (await response.json()) as {
          session?: AaisClientSession;
          error?: string;
        };
        if (!response.ok || !body.session) {
          throw new Error(body.error ?? "AAIS session load failed.");
        }
        if (!cancelled) {
          applySession(body.session);
          setBackendError("");
        }
      } catch {
        if (!cancelled) {
          setBackendError("学习记录服务暂时不可用，本页会保留当前输入但不会完成持久化。");
        }
      }
    }

    void loadSession();

    return () => {
      cancelled = true;
    };
  }, [studentId]);

  useEffect(() => () => {
    if (artifactSaveTimerRef.current) {
      clearTimeout(artifactSaveTimerRef.current);
    }
  }, []);

  function applySession(session: AaisClientSession) {
    setActiveStage(isStageId(session.activeStage) ? session.activeStage : "home");
    setActiveTaskId(session.activeTaskId || "training_task_1");
    const sessionTasks = session.tasks?.length ? session.tasks : createInitialClientTasks();
    setTaskRecords(sessionTasks);
    const selectedTask =
      sessionTasks.find((task) => task.taskId === session.activeTaskId) ?? sessionTasks[0];
    setArtifactText(selectedTask?.artifactText ?? "");
    setSelfReport(selectedTask?.selfReport ?? "");
    setHelpRequests(
      Object.fromEntries(sessionTasks.map((task) => [task.taskId, task.scaffoldRequests])),
    );
    setEvents(session.events ?? []);
    if (session.guideMessages?.length) {
      setGuideMessages(
        session.guideMessages.map((message) => ({
          id: message.id,
          kind: message.kind,
          text: message.text,
          ...(message.turns?.length ? { turns: message.turns } : {}),
          trace: message.trace ?? (message.orchestration
            ? {
                graphId: message.orchestration.graphId,
                topologicalOrder: message.orchestration.topologicalOrder,
              }
            : undefined),
        })),
      );
    }
  }

  async function patchSession(body: Record<string, unknown>) {
    const response = await fetch("/api/learning/session", {
      method: "PATCH",
      headers: {
        "content-type": "application/json",
        ...getAaisCsrfHeader(),
      },
      body: JSON.stringify({
        ...body,
      }),
    });
    const payload = (await response.json()) as {
      session?: AaisClientSession;
      error?: string;
    };
    if (!response.ok || !payload.session) {
      throw new Error(payload.error ?? "AAIS session update failed.");
    }
    applySession(payload.session);
    setBackendError("");
    return payload.session;
  }

  function pushEvent(event: AaisEvent) {
    setEvents((current) => [...current, event]);
  }

  function flushPendingArtifactSave() {
    const pending = pendingArtifactSaveRef.current;
    pendingArtifactSaveRef.current = null;
    if (artifactSaveTimerRef.current) {
      clearTimeout(artifactSaveTimerRef.current);
      artifactSaveTimerRef.current = null;
    }
    if (!pending) {
      return;
    }
    void patchSession({
      action: "save-artifact",
      taskId: pending.taskId,
      artifactText: pending.value,
    }).catch(() => setBackendError("任务过程记录未能保存到后端。"));
  }

  function scheduleArtifactSave(taskId: string, value: string) {
    pendingArtifactSaveRef.current = {
      taskId,
      value,
    };
    if (artifactSaveTimerRef.current) {
      clearTimeout(artifactSaveTimerRef.current);
    }
    artifactSaveTimerRef.current = setTimeout(flushPendingArtifactSave, artifactSaveDebounceMs);
  }

  function selectStage(stageId: StageId) {
    setActiveStage(stageId);
    void patchSession({
      action: "select-stage",
      stageId,
    }).catch(() => setBackendError("阶段切换未能保存到后端。"));
    pushEvent(
      createAaisEvent({
        studentId,
        phase: stageId === "practice" || stageId === "comparison" ? "practice" : "training",
        task: activeTaskId,
        agent: "platform",
        event: "stage_selected",
        detail: {
          stageId,
        },
      }),
    );
  }

  function recordArtifact(value: string) {
    setArtifactText(value);
    scheduleArtifactSave(activeTaskId, value);
    pushEvent(
      createAaisEvent({
        studentId,
        phase: activePhase,
        task: activeTaskId,
        agent: "A2",
        event: "artifact_edited",
        detail: {
          characters: value.length,
        },
      }),
    );
  }

  function recordSelfReport(value: string) {
    setSelfReport(value);
    void patchSession({
      action: "save-self-report",
      taskId: activeTaskId,
      selfReport: value,
    }).catch(() => setBackendError("自评报告未能保存到后端。"));
  }

  async function selectTask(taskId: string) {
    const record = taskRecordById.get(taskId);
    if (record?.status === "locked") {
      setBackendError("该练习任务仍被顺序锁定，请先完成前一个任务。");
      return;
    }
    try {
      await patchSession({
        action: "select-task",
        taskId,
      });
    } catch {
      setBackendError("任务切换未能保存到后端。");
    }
  }

  async function completeCurrentTask() {
    try {
      await patchSession({
        action: "complete-task",
        taskId: activeTaskId,
      });
    } catch {
      setBackendError("任务完成状态未能保存到后端。");
    }
  }

  async function sendGuideMessage(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const question = guideDraft.trim();
    if (!question) {
      setGuideError("请输入你的想法后再发送。");
      return;
    }

    const assistantId = `assistant-${Date.now()}`;
    setGuideMessages((current) => [
      ...current,
      {
        id: `user-${Date.now()}`,
        kind: "user",
        text: question,
      },
      {
        id: assistantId,
        kind: "assistant",
        text: "AAIS 已收到，多智能体链路正在处理。",
      },
    ]);
    setGuideDraft("");
    setGuideError("");
    setGuideBusy(true);
    pushEvent(
      createAaisEvent({
        studentId,
        phase: activePhase,
        task: activeTaskId,
        agent: "A2",
        event: "ai_prompt_submitted",
        detail: {
          prompt: question,
        },
      }),
    );

    try {
      const response = await fetch("/api/learning/ai-guide", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          ...getAaisCsrfHeader(),
        },
        body: JSON.stringify({
          locale: "zh-CN",
          phase: activePhase,
          taskId: activeTaskId,
          learnerInput: question,
          workspaceState: {
            currentStep: activeStage,
            artifactText,
            helpRequestsUsed: currentHelpCount,
          },
        }),
      });
      const body = (await response.json()) as {
        message?: {
          text?: string;
        };
        turns?: GuideTurn[];
        orchestration?: {
          graph?: {
            graphId?: string;
            topologicalOrder?: string[];
          };
        };
        error?: string;
      };
      if (!response.ok || (!body.message?.text && !body.turns?.length)) {
        throw new Error(body.error ?? "AAIS guide failed");
      }

      const structuredTurns = body.turns?.length ? body.turns : undefined;
      setGuideMessages((current) =>
        current.map((message) =>
          message.id === assistantId
            ? {
                ...message,
                text: structuredTurns ? "AAIS 已完成多智能体导学。" : body.message?.text ?? "",
                ...(structuredTurns ? { turns: structuredTurns } : {}),
                trace: {
                  graphId: body.orchestration?.graph?.graphId,
                  topologicalOrder: body.orchestration?.graph?.topologicalOrder,
                },
              }
            : message,
        ),
      );
    } catch {
      setGuideMessages((current) =>
        current.map((message) =>
          message.id === assistantId
            ? {
                ...message,
                text: "智能服务暂时不可用，已保留你的问题。请稍后重试。",
              }
            : message,
        ),
      );
      setGuideError("智能服务暂时不可用，已保留你的问题。");
    } finally {
      setGuideBusy(false);
    }
  }

  async function requestScaffold() {
    try {
      const response = await fetch("/api/learning/scaffold", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          ...getAaisCsrfHeader(),
        },
        body: JSON.stringify({
          taskId: activeTaskId,
          toolId: activeScaffoldToolId,
        }),
      });
      const body = (await response.json()) as {
        mode?: "tool-list" | "self-check";
        requestCount?: number;
        tool?: {
          id: string;
          label: string;
          body: string;
        };
        session?: AaisClientSession;
        error?: string;
      };
      if (!response.ok || !body.session || !body.mode || !body.requestCount || !body.tool) {
        throw new Error(body.error ?? "AAIS scaffold request failed.");
      }
      applySession(body.session);
      setLatestScaffold({
        taskId: activeTaskId,
        mode: body.mode,
        requestCount: body.requestCount,
        tool: body.tool,
      });
      setBackendError("");
    } catch {
      const nextCount = currentHelpCount + 1;
      setHelpRequests((current) => ({
        ...current,
        [activeTaskId]: nextCount,
      }));
      setLatestScaffold({
        taskId: activeTaskId,
        mode: nextCount >= 5 ? "self-check" : "tool-list",
        requestCount: nextCount,
        tool: activeScaffoldTool,
      });
      setBackendError("支架请求未能保存到后端。");
      pushEvent(
        createAaisEvent({
          studentId,
          phase: "practice",
          task: activeTaskId,
          agent: "A4",
          event: "scaffold_request",
          detail: {
            request_count: nextCount,
            mode: nextCount >= 5 ? "self-check" : "tool-list",
          },
        }),
      );
    }
  }

  async function recordAiAcceptance(messageId: string, accepted: boolean) {
    setRecordedGuideDecisions((current) => ({
      ...current,
      [messageId]: accepted,
    }));
    try {
      await patchSession({
        action: "record-ai-acceptance",
        taskId: activeTaskId,
        messageId,
        accepted,
        reason: accepted ? "accepted_guidance" : "rejected_guidance",
      });
      setBackendError("");
    } catch {
      setBackendError("AI 采纳记录未能保存到后端。");
    }
  }

  async function downloadBackendExport(format: "json" | "csv") {
    try {
      const response = await fetch(`/api/learning/export?format=${format}`);
      if (!response.ok) {
        throw new Error("AAIS export failed.");
      }
      const text = await response.text();
      const fileName =
        parseAttachmentFileName(response.headers.get("content-disposition")) ??
        `aais-${studentId}-events.${format}`;
      downloadText(fileName, text, format === "csv" ? "text/csv;charset=utf-8" : "application/json;charset=utf-8");
      setBackendError("");
    } catch {
      setBackendError("学习过程导出未能从后端生成。");
    }
  }

  return (
    <div className="min-h-[100dvh] bg-[var(--background)] text-[var(--foreground)]">
      <Header />
      <main
        data-testid="learning-shell"
        className="grid w-full max-w-none gap-5 px-3 py-6 sm:px-4 lg:grid-cols-[minmax(0,1fr)_420px] lg:px-5 2xl:px-6"
      >
        <section className="min-w-0">
          <div className="rounded-2xl border border-[#dfe7f6] bg-white shadow-[0_18px_44px_rgba(46,58,91,0.08)]">
            <div className="border-b border-[#e9ecf4] px-5 py-4 sm:px-6">
                <div className="flex flex-wrap items-center justify-between gap-4">
                <div>
                  <p className="text-sm font-semibold text-[#1f6feb]">Apprenticeship AI system</p>
                  <h1 className="mt-1 text-3xl font-black tracking-normal text-[#171b35]">
                    我的学习
                  </h1>
                </div>
                <div className="flex items-center gap-2 rounded-full border border-[#d8e6fb] bg-[#f8fbff] px-4 py-2 text-sm font-semibold text-[#3f4b69]">
                  <CheckCircle size={18} weight="duotone" className="text-[#1f6feb]" />
                  研究记录全量采集
                </div>
                {backendError ? (
                  <p className="mt-3 rounded-lg border border-[#f0b7c9] bg-[#fff1f5] px-4 py-3 text-sm font-semibold text-[#a12f56]">
                    {backendError}
                  </p>
                ) : null}
              </div>
            </div>

            <div className="grid gap-5 p-5 sm:p-6 xl:grid-cols-[260px_minmax(0,1fr)]">
              <aside className="rounded-xl border border-[#e1e8f5] bg-[#f8fbff] p-3">
                <div className="grid gap-2">
                  {stageItems.map((stage) => {
                    const active = activeStage === stage.id;
                    return (
                      <button
                        key={stage.id}
                        type="button"
                        onClick={() => selectStage(stage.id)}
                        aria-pressed={active}
                        className={[
                          "flex min-h-11 items-center justify-between rounded-lg border px-3 py-2 text-left text-sm font-semibold outline-none transition focus-visible:ring-2 focus-visible:ring-[#1f6feb]",
                          active
                            ? "border-[#1f6feb] bg-[#1f6feb] text-white shadow-[0_10px_20px_rgba(31,111,235,0.18)]"
                            : "border-transparent bg-white text-[#4a536d] hover:border-[#bfdbfe] hover:text-[#1f6feb]",
                        ].join(" ")}
                      >
                        <span>{stage.label}</span>
                        {active ? <ArrowRight size={16} weight="bold" /> : null}
                      </button>
                    );
                  })}
                </div>
              </aside>

              <div className="min-w-0 space-y-5">
                <HeroWorkspace stage={activeStageItem} />

                <div className="grid gap-4 lg:grid-cols-2">
                  <section className="rounded-xl border border-[#e1e8f5] bg-[#fbfdff] p-4">
                    <div className="flex items-center gap-2 text-sm font-bold text-[#1f6feb]">
                      <BookOpen size={18} weight="duotone" />
                      训练阶段
                    </div>
                    <h2 className="mt-2 text-lg font-bold text-[#222842]">
                      {aaisLearningProgram.training.tasks[0].title["zh-CN"]}
                    </h2>
                    <p className="mt-2 text-sm leading-6 text-[#5d657d]">
                      {aaisLearningProgram.training.tasks[0].brief["zh-CN"]}
                    </p>
                  </section>

                  <section className="rounded-xl border border-[#e1e8f5] bg-[#fbfdff] p-4">
                    <div className="flex items-center gap-2 text-sm font-bold text-[#1f6feb]">
                      <Target size={18} weight="duotone" />
                      练习阶段
                    </div>
                    <div className="mt-3 grid gap-2">
                      {aaisLearningProgram.practice.tasks.map((task) => {
                        const locked = taskRecordById.get(task.id)?.status === "locked";
                        return (
                          <button
                            key={task.id}
                            type="button"
                            onClick={() => void selectTask(task.id)}
                            disabled={locked}
                            className={[
                              "flex items-center justify-between rounded-lg border px-3 py-2 text-left text-sm font-semibold outline-none transition focus-visible:ring-2 focus-visible:ring-[#1f6feb]",
                              activeTaskId === task.id
                                ? "border-[#1f6feb] bg-[#eef6ff] text-[#1f6feb]"
                                : "border-[#e2e8f3] bg-white text-[#4f5670] hover:border-[#bfdbfe]",
                              locked ? "cursor-not-allowed opacity-55" : "",
                            ].join(" ")}
                          >
                            <span>{task.title["zh-CN"]}</span>
                            {locked ? <span className="text-xs text-[#7b8399]">顺序锁定</span> : null}
                          </button>
                        );
                      })}
                    </div>
                  </section>
                </div>

                <section className="rounded-xl border border-[#e1e8f5] bg-white p-4">
                  <div className="flex flex-wrap items-center justify-between gap-3">
                    <div>
                      <h2 className="text-lg font-bold text-[#222842]">当前任务工作区</h2>
                      <p className="mt-1 text-sm text-[#68708a]">{activeTask.brief["zh-CN"]}</p>
                    </div>
                    {activeTask.phase === "practice" ? (
                      <button
                        type="button"
                        onClick={() => void requestScaffold()}
                        className="inline-flex h-10 items-center gap-2 rounded-lg bg-[#1f6feb] px-4 text-sm font-bold text-white shadow-[0_10px_20px_rgba(31,111,235,0.18)] outline-none transition hover:bg-[#1557c0] active:translate-y-px focus-visible:ring-2 focus-visible:ring-[#1f6feb]"
                      >
                        <Sparkle size={17} weight="duotone" />
                        获取帮助
                      </button>
                    ) : null}
                    <button
                      type="button"
                      onClick={() => void completeCurrentTask()}
                      className="inline-flex h-10 items-center gap-2 rounded-lg border border-[#cfe0f5] bg-white px-4 text-sm font-bold text-[#1f6feb] outline-none transition hover:border-[#1f6feb] focus-visible:ring-2 focus-visible:ring-[#1f6feb]"
                    >
                      <CheckCircle size={17} weight="duotone" />
                      完成当前任务
                    </button>
                  </div>

                  <textarea
                    aria-label="在这里写下任务理解、计划、执行过程或最终产出。"
                    value={artifactText}
                    onChange={(event) => recordArtifact(event.target.value)}
                    onBlur={flushPendingArtifactSave}
                    className="mt-4 min-h-40 w-full resize-y rounded-xl border border-[#dfe7f6] bg-[#fbfdff] p-4 text-sm leading-6 text-[#303650] outline-none placeholder:text-[#8d96aa] focus:border-[#1f6feb] focus:ring-4 focus:ring-[#1f6feb]/10"
                    placeholder="在这里写下任务理解、计划、执行过程或最终产出。"
                  />

                  {activeTask.phase === "practice" && visibleScaffold ? (
                    <div
                      className="mt-4 rounded-xl border border-[#cfe0f5] bg-[#f8fbff] p-4"
                      aria-live="polite"
                    >
                      <div className="flex flex-wrap items-center justify-between gap-2">
                        <p className="text-sm font-black text-[#1f6feb]">A4 本次支架</p>
                        <p className="text-xs font-semibold text-[#68708a]">
                          已记录第 {visibleScaffold.requestCount} 次求助
                        </p>
                      </div>
                      {visibleScaffold.mode === "self-check" ? (
                        <p className="mt-3 rounded-lg border border-[#dfe7f6] bg-white px-3 py-2 text-sm font-semibold leading-6 text-[#303650]">
                          先说卡点：你卡在哪里？哪方面不清楚？说明后再使用下面的工具继续推进。
                        </p>
                      ) : null}
                      <div className="mt-3 rounded-lg border border-[#dfe7f6] bg-white p-4">
                        <h3 className="text-sm font-bold text-[#1f6feb]">{visibleScaffold.tool.label}</h3>
                        <p className="mt-2 text-sm leading-6 text-[#3f4b69]">{visibleScaffold.tool.body}</p>
                      </div>
                    </div>
                  ) : null}

                  <div className="mt-4 grid gap-3 md:grid-cols-2">
                    {articulationPrompts.map((prompt, index) => (
                      <div key={prompt} className="rounded-lg border border-[#e4eaf5] bg-[#f8fbff] p-3">
                        <p className="text-xs font-bold text-[#1f6feb]">Articulation {index + 1}</p>
                        <p className="mt-1 text-sm leading-6 text-[#4f5873]">{prompt}</p>
                      </div>
                    ))}
                  </div>
                </section>

                {activeTask.phase === "practice" ? (
                  <section className="rounded-xl border border-[#d7e5fb] bg-[#f8fbff] p-4">
                    <div className="flex items-start justify-between gap-3">
                      <div>
                        <h2 className="text-lg font-bold text-[#222842]">A4 元认知工具包</h2>
                        <p className="mt-1 text-sm leading-6 text-[#68708a]">
                          当前任务已求助 {currentHelpCount} 次。前 4 次直接选工具，第 5 次后先自述卡点。
                        </p>
                      </div>
                      <WarningCircle size={21} weight="duotone" className="shrink-0 text-[#1f6feb]" />
                    </div>
                    {currentHelpCount >= 5 ? (
                      <div className="mt-4 rounded-lg border border-[#cfe0f5] bg-white p-4 text-sm font-semibold leading-6 text-[#303650]">
                        这是第 5 次及以后求助。先告诉我：你卡在哪里？哪方面不清楚？
                      </div>
                    ) : (
                      <div className="mt-4 grid gap-3 md:grid-cols-[220px_minmax(0,1fr)]">
                        <div className="grid gap-2">
                          {scaffoldTools.map((tool) => (
                            <button
                              key={tool.id}
                              type="button"
                              onClick={() => setActiveScaffoldToolId(tool.id)}
                              className={[
                                "rounded-lg border px-3 py-2 text-left text-sm font-semibold outline-none transition focus-visible:ring-2 focus-visible:ring-[#1f6feb]",
                                activeScaffoldToolId === tool.id
                                  ? "border-[#1f6feb] bg-[#1f6feb] text-white"
                                  : "border-[#dfe7f6] bg-white text-[#4f5873] hover:border-[#bfdbfe]",
                              ].join(" ")}
                            >
                              {tool.label}
                            </button>
                          ))}
                        </div>
                        <div className="rounded-lg border border-[#dfe7f6] bg-white p-4">
                          <h3 className="text-sm font-bold text-[#1f6feb]">{activeScaffoldTool.label}</h3>
                          <p className="mt-2 text-sm leading-6 text-[#3f4b69]">{activeScaffoldTool.body}</p>
                        </div>
                      </div>
                    )}
                  </section>
                ) : null}

                <section className="grid gap-4 lg:grid-cols-2">
                  <div className="rounded-xl border border-[#e1e8f5] bg-white p-4">
                    <div className="flex items-center gap-2 text-sm font-bold text-[#1f6feb]">
                      <ChartLineUp size={18} weight="duotone" />
                      学生思维轨迹
                    </div>
                    <ul className="mt-3 space-y-2 text-sm leading-6 text-[#4f5873]">
                      {latestStudentTrace.map((item) => (
                        <li key={item} className="flex gap-2">
                          <CheckCircle size={16} weight="duotone" className="mt-1 shrink-0 text-[#1f6feb]" />
                          <span>{item}</span>
                        </li>
                      ))}
                    </ul>
                  </div>

                  <div className="rounded-xl border border-[#e1e8f5] bg-white p-4">
                    <div className="flex items-center gap-2 text-sm font-bold text-[#1f6feb]">
                      <Eye size={18} weight="duotone" />
                      专家思维轨迹
                    </div>
                    <ul className="mt-3 space-y-2 text-sm leading-6 text-[#4f5873]">
                      {activeTask.expertTrace.map((item) => (
                        <li key={item["zh-CN"]} className="flex gap-2">
                          <CheckCircle size={16} weight="duotone" className="mt-1 shrink-0 text-[#1f6feb]" />
                          <span>{item["zh-CN"]}</span>
                        </li>
                      ))}
                    </ul>
                  </div>
                </section>

                <section className="rounded-xl border border-[#e1e8f5] bg-white p-4">
                  <h2 className="text-lg font-bold text-[#222842]">自评报告</h2>
                  <p className="mt-1 text-sm text-[#68708a]">
                    对比专家的思维，你有哪些不同？下次做类似任务，你会怎么做？
                  </p>
                  <textarea
                    value={selfReport}
                    onChange={(event) => recordSelfReport(event.target.value)}
                    className="mt-4 min-h-28 w-full resize-y rounded-xl border border-[#dfe7f6] bg-[#fbfdff] p-4 text-sm leading-6 text-[#303650] outline-none placeholder:text-[#8d96aa] focus:border-[#1f6feb] focus:ring-4 focus:ring-[#1f6feb]/10"
                    placeholder="写下你的自评报告。"
                  />
                  <div className="mt-4 flex flex-wrap gap-2">
                    <button
                      type="button"
                      onClick={() => void downloadBackendExport("json")}
                      className="inline-flex h-10 items-center gap-2 rounded-lg border border-[#cfe0f5] bg-white px-4 text-sm font-bold text-[#1f6feb] outline-none transition hover:border-[#1f6feb] focus-visible:ring-2 focus-visible:ring-[#1f6feb]"
                    >
                      <DownloadSimple size={17} weight="duotone" />
                      导出 JSON
                    </button>
                    <button
                      type="button"
                      onClick={() => void downloadBackendExport("csv")}
                      className="inline-flex h-10 items-center gap-2 rounded-lg border border-[#cfe0f5] bg-white px-4 text-sm font-bold text-[#1f6feb] outline-none transition hover:border-[#1f6feb] focus-visible:ring-2 focus-visible:ring-[#1f6feb]"
                    >
                      <FileText size={17} weight="duotone" />
                      导出 CSV
                    </button>
                  </div>
                </section>
              </div>
            </div>
          </div>
        </section>

        <aside className="min-w-0">
          <section className="overflow-hidden rounded-2xl border border-[#e2e6f0] bg-white shadow-[0_18px_44px_rgba(46,58,91,0.08)] lg:sticky lg:top-24 lg:h-[calc(100dvh-7.5rem)]">
            <div className="grid h-full grid-rows-[auto_minmax(0,1fr)_auto]">
              <div className="border-b border-[#e9ecf4] p-4">
                <div className="flex items-center gap-3">
                  <span className="grid size-11 shrink-0 place-items-center rounded-full bg-[#dbeafe] text-[#1f6feb]">
                    <Robot size={23} weight="duotone" />
                  </span>
                  <div>
                    <h2 className="text-lg font-black text-[#171b35]">AAIS 智能导学</h2>
                    <p className="mt-1 text-xs font-medium text-[#68708a]">
                      LangGraph: A1 → A2 → A3 → A4
                    </p>
                  </div>
                </div>
              </div>

              <div className="min-h-0 overflow-y-auto p-4">
                <div className="grid gap-3">
                  {aaisAgents.map((agent) => (
                    <article key={agent.id} className="rounded-xl border border-[#e1e8f5] bg-[#fbfdff] p-3">
                      <div className="flex items-start gap-3">
                        <span className="grid size-8 shrink-0 place-items-center rounded-lg bg-[#eef6ff] text-xs font-black text-[#1f6feb]">
                          {agent.id}
                        </span>
                        <div>
                          <h3 className="text-sm font-bold text-[#303650]">{agent.name["zh-CN"]}</h3>
                          <p className="mt-1 text-xs leading-5 text-[#68708a]">{agent.mission["zh-CN"]}</p>
                        </div>
                      </div>
                    </article>
                  ))}
                </div>

                <div className="mt-4 space-y-3" aria-live="polite">
                  {guideMessages.map((message) => (
                    <div
                      key={message.id}
                      className={[
                        "max-w-[92%] rounded-2xl px-4 py-3 text-sm leading-6",
                        message.kind === "user"
                          ? "ml-auto bg-[#1f6feb] text-white"
                          : "bg-[#f0f1f7] text-[#303650]",
                      ].join(" ")}
                    >
                      {message.kind === "assistant" && message.turns?.length ? (
                        <div className="space-y-2">
                          <p className="font-bold text-[#1f6feb]">AAIS 已完成多智能体导学</p>
                          {message.turns.map((turn) => (
                            <article
                              key={`${message.id}-${turn.agentId}`}
                              className="rounded-xl border border-[#dbe5f5] bg-white p-3"
                            >
                              <div className="flex items-center gap-2">
                                <span className="grid size-7 shrink-0 place-items-center rounded-lg bg-[#eef6ff] text-xs font-black text-[#1f6feb]">
                                  {turn.agentId}
                                </span>
                                <h3 className="text-sm font-bold text-[#303650]">{turn.label}</h3>
                              </div>
                              <p className="mt-2 whitespace-pre-line text-sm leading-6 text-[#3f4b69]">
                                {turn.content}
                              </p>
                              {turn.actions.length ? (
                                <div className="mt-2 flex flex-wrap gap-1.5">
                                  {turn.actions.map((action) => (
                                    <span
                                      key={`${turn.agentId}-${action}`}
                                      className="rounded-full border border-[#dfe7f6] bg-[#f8fbff] px-2 py-0.5 text-[11px] font-semibold text-[#68708a]"
                                    >
                                      {action}
                                    </span>
                                  ))}
                                </div>
                              ) : null}
                            </article>
                          ))}
                        </div>
                      ) : (
                        <p className="whitespace-pre-line">{message.text}</p>
                      )}
                      {message.trace?.graphId ? (
                        <div className="mt-3 rounded-lg border border-[#dbe5f5] bg-white/80 p-3 text-xs leading-5 text-[#51607e]">
                          <p className="font-bold text-[#1f6feb]">LangGraph trace</p>
                          <p>graphId: {message.trace.graphId}</p>
                          <p>nodes: {message.trace.topologicalOrder?.join(" → ")}</p>
                        </div>
                      ) : null}
                      {message.kind === "assistant" && message.id !== "assistant-welcome" ? (
                        <div className="mt-3 flex flex-wrap gap-2">
                          <button
                            type="button"
                            onClick={() => void recordAiAcceptance(message.id, true)}
                            disabled={recordedGuideDecisions[message.id] !== undefined}
                            className="inline-flex h-8 items-center gap-1.5 rounded-lg border border-[#cfe0f5] bg-white px-3 text-xs font-bold text-[#1f6feb] outline-none transition hover:border-[#1f6feb] disabled:cursor-not-allowed disabled:opacity-60 focus-visible:ring-2 focus-visible:ring-[#1f6feb]"
                          >
                            <CheckCircle size={14} weight="duotone" />
                            采纳
                          </button>
                          <button
                            type="button"
                            onClick={() => void recordAiAcceptance(message.id, false)}
                            disabled={recordedGuideDecisions[message.id] !== undefined}
                            className="inline-flex h-8 items-center gap-1.5 rounded-lg border border-[#f0d5b4] bg-white px-3 text-xs font-bold text-[#8a5a12] outline-none transition hover:border-[#c8872d] disabled:cursor-not-allowed disabled:opacity-60 focus-visible:ring-2 focus-visible:ring-[#c8872d]"
                          >
                            <WarningCircle size={14} weight="duotone" />
                            暂不采纳
                          </button>
                        </div>
                      ) : null}
                    </div>
                  ))}
                </div>
              </div>

              <form onSubmit={sendGuideMessage} className="border-t border-[#e9ecf4] bg-[#fbfdff] p-4">
                <div className="rounded-xl border border-[#dfe4ef] bg-white p-3 shadow-[0_8px_18px_rgba(46,58,91,0.05)]">
                  <div className="flex items-center gap-2">
                    <input
                      aria-label="向智能导学输入你的想法"
                      value={guideDraft}
                      onChange={(event) => {
                        setGuideDraft(event.target.value);
                        setGuideError("");
                      }}
                      placeholder="输入你的想法"
                      className="h-10 min-w-0 flex-1 rounded-lg bg-[#fafbff] px-3 text-sm text-[#303650] outline-none placeholder:text-[#a4aabd] focus:ring-2 focus:ring-[#1f6feb]"
                    />
                    <button
                      type="submit"
                      disabled={guideBusy}
                      className="grid size-10 place-items-center rounded-full bg-[#1f6feb] text-white outline-none transition hover:bg-[#1759c8] active:translate-y-px focus-visible:ring-2 focus-visible:ring-[#1f6feb] focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-70"
                      aria-label="发送"
                    >
                      <PaperPlaneTilt size={18} weight="fill" />
                    </button>
                  </div>
                  {guideError ? (
                    <p className="mt-2 text-xs font-medium text-[var(--danger)]">{guideError}</p>
                  ) : null}
                </div>
              </form>
            </div>
          </section>
        </aside>
      </main>
    </div>
  );
}

function HeroWorkspace({
  stage,
}: {
  stage: {
    title: string;
    summary: string;
  };
}) {
  return (
    <section className="overflow-hidden rounded-xl border border-[#d7e5fb] bg-[#f8fbff]">
      <div className="grid gap-4 p-4 2xl:grid-cols-[minmax(0,1fr)_320px]">
        <div className="flex min-h-[260px] items-center justify-center rounded-xl bg-[#4478c9] px-6 py-10 text-center text-white shadow-[inset_0_1px_0_rgba(255,255,255,0.2)]">
          <div>
            <p className="text-sm font-bold text-white/80">AAIS Cognitive Apprenticeship</p>
            <h2 className="mt-3 text-3xl font-black leading-tight tracking-normal">{stage.title}</h2>
            <p className="mx-auto mt-4 max-w-[560px] text-base leading-7 text-white/90">{stage.summary}</p>
          </div>
        </div>
        <div className="rounded-xl border border-[#dfe7f6] bg-white p-4">
          <div className="flex items-start gap-3">
            <span className="grid size-10 shrink-0 place-items-center rounded-full bg-[#dbeafe] text-[#1f6feb]">
              <Brain size={22} weight="duotone" />
            </span>
            <div className="rounded-2xl bg-[#f0f1f7] px-4 py-3 text-sm leading-6 text-[#303650]">
              首先，我们通过一个短视频了解元认知知识和应用。观看中，你可以随时暂停，把重要信息告诉我，我会帮你放进个人资源库。
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}

function createStudentTrace(artifactText: string, selfReport: string, helpCount: number) {
  return [
    artifactText.trim()
      ? `任务理解阶段：你已经留下 ${artifactText.trim().length} 个字符的过程记录。`
      : "任务理解阶段：还没有写下任务要求和不确定点。",
    helpCount > 0
      ? `支架使用：本任务已经主动求助 ${helpCount} 次。`
      : "支架使用：本任务暂未主动求助。",
    selfReport.trim()
      ? `反思阶段：你已经开始撰写自评报告。`
      : "反思阶段：请完成专家对比后的自评报告。",
  ];
}

function isStageId(value: string): value is StageId {
  return stageItems.some((stage) => stage.id === value);
}

function getInitialStudentId() {
  if (typeof window === "undefined") {
    return "S001";
  }
  try {
    const storedStudentId = window.localStorage.getItem("aais_student_id");
    if (storedStudentId) {
      return storedStudentId;
    }
  } catch {
    // Cookie fallback still works when storage is unavailable.
  }
  return readClientCookie("aais_student_id") || "S001";
}

function readClientCookie(name: string) {
  try {
    const cookie = document.cookie
      .split(";")
      .map((part) => part.trim())
      .find((part) => part.startsWith(`${name}=`));
    return cookie ? decodeURIComponent(cookie.slice(name.length + 1)) : null;
  } catch {
    return null;
  }
}

function getAaisCsrfHeader(): Record<string, string> {
  const token = readClientCookie("aais_csrf");
  return token ? { "x-aais-csrf": token } : {};
}

function createInitialClientTasks(): AaisClientTaskRecord[] {
  return [
    ...aaisLearningProgram.training.tasks.map((task) => ({
      taskId: task.id,
      phase: task.phase,
      status: "active" as const,
      artifactText: "",
      selfReport: "",
      scaffoldRequests: 0,
      scaffoldHistory: [],
    })),
    ...aaisLearningProgram.practice.tasks.map((task) => ({
      taskId: task.id,
      phase: task.phase,
      status: "locked" as const,
      artifactText: "",
      selfReport: "",
      scaffoldRequests: 0,
      scaffoldHistory: [],
    })),
  ];
}

function parseAttachmentFileName(contentDisposition: string | null) {
  if (!contentDisposition) {
    return null;
  }
  const match = contentDisposition.match(/filename="?([^";]+)"?/i);
  return match?.[1] ?? null;
}

function downloadText(fileName: string, text: string, mimeType = "text/plain;charset=utf-8") {
  const blob = new Blob([text], { type: mimeType });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = fileName;
  anchor.click();
  URL.revokeObjectURL(url);
}
