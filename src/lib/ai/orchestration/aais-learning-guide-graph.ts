import { Annotation, END, START, StateGraph } from "@langchain/langgraph";
import {
  createConfiguredAaisModelProvider,
  createDeterministicAaisProvider,
  type AaisModelProvider,
  type AaisModelRuntime,
} from "@/lib/ai/aais-ai-provider";
import type { AaisAiRuntimeProfile } from "@/lib/ai/aais-ai-runtime-config";
import {
  aaisAgents,
  aaisCognitiveApprenticeshipBackground,
  type AaisAgentId,
  type AaisPhase,
  type Locale,
} from "@/data/aais";
import {
  aaisGuideTargetAgentIds,
  resolveAaisGuideTargetAgentIds,
  type AaisGuideTargetAgentId,
} from "@/lib/ai/aais-guide-targets";
import {
  normalizeAaisGuideAttachments,
  type AaisGuideAttachment,
} from "@/lib/ai/aais-guide-attachments";

type AaisWorkspaceState = {
  currentStep: string;
  artifactText?: string;
  helpRequestsUsed?: number;
  attachments?: AaisGuideAttachment[];
};

export type AaisGuideTurn = {
  agentId: AaisAgentId;
  label: string;
  content: string;
  actions: string[];
};

type AaisGuideProviderRun = AaisModelRuntime & {
  agentId: AaisAgentId;
};

type AaisGuideAgentTiming = {
  agentId: AaisAgentId;
  visible: boolean;
  elapsedMs: number;
  attempts: number;
  status: AaisModelRuntime["status"];
  fallback: boolean;
  provider: string;
  model: string;
  timeoutReason: string | null;
};

export type AaisGuideInput = {
  locale: Locale;
  studentId: string;
  phase: AaisPhase;
  taskId: string;
  learnerInput: string;
  targetAgentIds?: AaisGuideTargetAgentId[];
  workspaceState: AaisWorkspaceState;
  threadId?: string;
};

type AaisGuideState = AaisGuideInput & {
  turns: AaisGuideTurn[];
  providerRuns: AaisGuideProviderRun[];
};

type AaisGuideAgentRun = {
  agentId: AaisAgentId;
  turns: AaisGuideTurn[];
  providerRuns: AaisGuideProviderRun[];
  timings: AaisGuideAgentTiming[];
};

type AaisGuideOptions = {
  modelProvider?: AaisModelProvider;
};

const redaction = {
  secrets: "omitted",
  localFiles: "omitted",
  assets: "ids-only",
} as const;

const graphId = "learning-ai-guide" as const;
const topologicalOrder: AaisAgentId[] = ["A1", "A2", "A3", "A4"];
const backgroundAgentIds: AaisAgentId[] = ["A3", "A4"];

const AaisGuideGraphState = Annotation.Root({
  input: Annotation<AaisGuideState>,
  activeAgentIds: Annotation<AaisAgentId[]>,
  modelProvider: Annotation<AaisModelProvider>,
  backgroundProvider: Annotation<AaisModelProvider>,
  runs: Annotation<AaisGuideAgentRun[]>({
    reducer: (left, right) => left.concat(right),
    default: () => [],
  }),
});

type AaisGuideGraphStateValue = typeof AaisGuideGraphState.State;

export async function runAaisLearningGuideGraph(
  input: AaisGuideInput,
  options: AaisGuideOptions = {},
) {
  const boundedInput: AaisGuideInput = {
    ...input,
    workspaceState: normalizeAaisGuideWorkspaceState(input.workspaceState),
  };
  const modelProvider = options.modelProvider ?? createConfiguredAaisModelProvider();
  const backgroundProvider = createDeterministicAaisProvider();
  const targetAgentIds = resolveAaisGuideTargetAgentIds(boundedInput.targetAgentIds);
  const visibleAgentIds = topologicalOrder.filter((agentId): agentId is AaisGuideTargetAgentId =>
    targetAgentIds.includes(agentId as AaisGuideTargetAgentId),
  );
  const threadId = boundedInput.threadId ?? createThreadId(boundedInput);
  const graphInput: AaisGuideState = {
    ...boundedInput,
    turns: [],
    providerRuns: [],
  };
  const startedAt = nowMs();
  const langGraph = createAaisLearningGuideLangGraph();
  const graphOutput = await langGraph.invoke({
    input: graphInput,
    activeAgentIds: [
      ...visibleAgentIds,
      ...backgroundAgentIds,
    ],
    modelProvider,
    backgroundProvider,
  });
  const totalMs = Math.round(nowMs() - startedAt);
  const allRuns = sortAgentRuns(graphOutput.runs);
  const turns = allRuns.flatMap((run) => run.turns);
  const providerRuns = allRuns.flatMap((run) => run.providerRuns);
  const agentTimings = allRuns.flatMap((run) => run.timings);
  const visibleTurns = turns.filter((turn) =>
    targetAgentIds.includes(turn.agentId as AaisGuideTargetAgentId),
  );
  const backgroundTurns = turns.filter((turn) =>
    !aaisGuideTargetAgentIds.includes(turn.agentId as AaisGuideTargetAgentId),
  );
  const runtimeEvents = allRuns.map((run) => ({
    type: "node-update" as const,
    graphId,
    threadId,
    nodeId: run.agentId,
    redaction,
  }));

  return {
    status: "ok" as const,
    graph: {
      runtime: "langgraph" as const,
      graphId,
      topologicalOrder,
    },
    turns,
    visibleTurns,
    backgroundTurns,
    messageText: formatMessage(boundedInput.locale, visibleTurns),
    runtime: {
      engine: "aais-langgraph-runtime" as const,
      status: "completed" as const,
      threadId,
      eventCount: runtimeEvents.length,
      redaction,
      modelProvider: summarizeProviderRuns(providerRuns),
      timings: summarizeTimings(totalMs, agentTimings),
      ai: summarizeAiRuntimeProfile(providerRuns),
    },
    trace: {
      handoffs: [
        { fromNodeId: "A1", toNodeId: "A2", reason: "ca-flow-to-expert-modelling" },
        { fromNodeId: "A2", toNodeId: "A3", reason: "practice-behavior-data" },
        { fromNodeId: "A3", toNodeId: "A1", reason: "scaffold-signal" },
        { fromNodeId: "A4", toNodeId: "A1", reason: "reflection-report-feedback" },
      ],
      memory: {
        mode: "thread-checkpoint" as const,
        threadId,
        store: "InMemoryStore",
      },
    },
    runtimeEvents,
  };
}

function createAaisLearningGuideLangGraph() {
  return new StateGraph(AaisGuideGraphState)
    .addNode("A1", (state: AaisGuideGraphStateValue) => runAaisGuideAgentNode("A1", state))
    .addNode("A2", (state: AaisGuideGraphStateValue) => runAaisGuideAgentNode("A2", state))
    .addNode("A3", (state: AaisGuideGraphStateValue) => runAaisGuideAgentNode("A3", state))
    .addNode("A4", (state: AaisGuideGraphStateValue) => runAaisGuideAgentNode("A4", state))
    .addConditionalEdges(START, (state: AaisGuideGraphStateValue) => state.activeAgentIds, {
      A1: "A1",
      A2: "A2",
      A3: "A3",
      A4: "A4",
    })
    .addEdge("A1", END)
    .addEdge("A2", END)
    .addEdge("A3", END)
    .addEdge("A4", END)
    .compile({
      name: graphId,
    });
}

async function runAaisGuideAgentNode(
  agentId: AaisAgentId,
  state: AaisGuideGraphStateValue,
) {
  const modelProvider = backgroundAgentIds.includes(agentId)
    ? state.backgroundProvider
    : state.modelProvider;

  return {
    runs: [
      await createAgentTurn(
        agentId,
        state.input,
        modelProvider,
        !backgroundAgentIds.includes(agentId),
      ),
    ],
  };
}

async function createAgentTurn(
  agentId: AaisAgentId,
  state: AaisGuideState,
  modelProvider: AaisModelProvider,
  visible: boolean,
) {
  const startedAt = nowMs();
  const agent = aaisAgents.find((candidate) => candidate.id === agentId) ?? aaisAgents[0];
  const fallbackText = createAgentContent(agentId, state);
  const response = await modelProvider.generate({
    agentId,
    label: agent.name[state.locale],
    role: agent.role[state.locale],
    mission: agent.mission[state.locale],
    caModules: agent.caModules,
    caBackground: aaisCognitiveApprenticeshipBackground,
    locale: state.locale,
    phase: state.phase,
    taskId: state.taskId,
    learnerInput: state.learnerInput,
    workspaceState: state.workspaceState,
    fallbackText,
  }).catch(() => ({
    text: fallbackText,
    runtime: {
      provider: "unavailable",
      model: "fallback-template",
      attempts: 1,
      status: "fallback" as const,
      guardrail: {
        policy: "aais-age-appropriate-output-v1" as const,
        status: "not-applicable" as const,
        reasons: ["provider-unavailable"],
      },
      redaction: {
        secrets: "omitted" as const,
        prompt: "summarized" as const,
      },
    },
  }));
  const elapsedMs = Math.round(nowMs() - startedAt);
  const providerRun = {
    agentId,
    ...response.runtime,
  };
  return {
    agentId,
    turns: [
      {
        agentId,
        label: agent.name[state.locale],
        content: response.text,
        actions: createAgentActions(agentId, state.phase),
      },
    ],
    providerRuns: [providerRun],
    timings: [
      {
        agentId,
        visible,
        elapsedMs,
        attempts: response.runtime.attempts,
        status: response.runtime.status,
        fallback: response.runtime.status === "fallback",
        provider: response.runtime.provider,
        model: response.runtime.model,
        timeoutReason: findTimeoutReason(response.runtime.guardrail.reasons),
      },
    ],
  };
}

function summarizeProviderRuns(providerRuns: AaisGuideProviderRun[]) {
  const providers = [...new Set(providerRuns.map((run) => run.provider))];
  return {
    provider: providers.length === 1 ? providers[0] ?? "unknown" : "mixed",
    generatedTurns: providerRuns.length,
    fallbackTurns: providerRuns.filter((run) => run.status === "fallback").length,
    attempts: providerRuns.reduce((total, run) => total + run.attempts, 0),
    redaction: {
      secrets: "omitted" as const,
      prompt: "summarized" as const,
    },
  };
}

function summarizeTimings(totalMs: number, timings: AaisGuideAgentTiming[]) {
  const visibleTimings = timings.filter((timing) => timing.visible);
  const timeoutReason = findTimeoutReason(timings.flatMap((timing) =>
    timing.timeoutReason ? [timing.timeoutReason] : [],
  ));
  return {
    totalMs,
    visibleMs: visibleTimings.length
      ? Math.max(...visibleTimings.map((timing) => timing.elapsedMs))
      : 0,
    attempts: timings.reduce((total, timing) => total + timing.attempts, 0),
    fallback: timings.some((timing) => timing.fallback),
    timeoutReason,
    agents: timings,
  };
}

function summarizeAiRuntimeProfile(providerRuns: AaisGuideProviderRun[]): AaisAiRuntimeProfile | null {
  return providerRuns.find((run) => run.runtimeProfile?.mode === "live")?.runtimeProfile
    ?? providerRuns.find((run) => run.runtimeProfile)?.runtimeProfile
    ?? null;
}

function findTimeoutReason(reasons: string[]) {
  return reasons.find((reason) => reason === "abort-timeout" || reason === "connect-timeout") ?? null;
}

function sortAgentRuns<T extends { agentId: AaisAgentId }>(runs: T[]) {
  return [...runs].sort(
    (left, right) => topologicalOrder.indexOf(left.agentId) - topologicalOrder.indexOf(right.agentId),
  );
}

function nowMs() {
  return typeof performance !== "undefined" ? performance.now() : Date.now();
}

function createAgentContent(agentId: AaisAgentId, state: AaisGuideState) {
  const input = state.learnerInput.trim() || "学生尚未输入。";
  const helpCount = state.workspaceState.helpRequestsUsed ?? 0;
  const attachmentSummary = formatAttachmentSummary(state.workspaceState.attachments);

  if (agentId === "A1") {
    return `导学智能体：我会围绕 ${state.taskId} 串联 CA 学习流程，并管理本任务的 4 次直接辅助机会。若辅助机会用完，我会先与你对话确认卡点，再给一定程度的协助，体现 fading。${attachmentSummary}你刚才说：${input}`;
  }
  if (agentId === "A2") {
    return createA2ContextualFallback(state, input);
  }
  if (agentId === "A3") {
    return `监督智能体：我在后端收集当前步骤 ${state.workspaceState.currentStep} 的任务行为数据，识别需要支架的信号，并向 A1 发出信号，由 A1 给出 scaffolds。`;
  }

  return helpCount >= 4
    ? "反思智能体：我会整理你多次求助后的元认知过程记录和报告，反馈给你后提出反思性提问，并与专家过程进行对比评估。"
    : "反思智能体：请把解决问题时的目标理解、计划、调整和依据用文字表达出来，我会形成 articulation 记录，并通过反思性提问支持后续 reflection。";
}

function createA2ContextualFallback(state: AaisGuideState, learnerInput: string) {
  const topic = summarizeLearnerTopic(learnerInput);
  const calculusFocus = /微积分|calculus/i.test(learnerInput);
  if (calculusFocus) {
    return [
      "专家智能体（本地支架模式）：live AI 暂时未返回，我先用本地支架帮你推进。",
      "针对大学微积分，先抓住“概念—图像—例题—复盘”四步：先把极限、导数、积分分别用一句话解释清楚，再画函数图像理解变化率和面积，接着做少量典型题检验概念，最后把错题归类到定义不清、计算不熟或建模不准。",
      "按 Modelling/Coaching 的节奏，你下一步可以先选一个概念，比如极限，用自己的话写出它解决什么问题；如果需要专家示范，可以继续用 @A2 追问。",
    ].join("\n");
  }
  return [
    "专家智能体（本地支架模式）：live AI 暂时未返回，我先用本地支架回应你的问题。",
    `你刚才关注的是：${topic}`,
    `我会按 Modelling/Coaching 的方式处理：先示范专家会如何拆解这个问题，再给你一个练习提示。先写下“目标是什么、我已知什么、我下一步要验证什么”三句话，然后用 @A2 继续让我针对其中一步示范。当前任务是 ${state.taskId}。`,
  ].join("\n");
}

function summarizeLearnerTopic(input: string) {
  const cleaned = input
    .replace(/@A\s*[12]/gi, "")
    .replace(/@\S+/g, "")
    .replace(/\s+/g, " ")
    .trim();
  if (!cleaned) {
    return "这个学习任务";
  }
  return cleaned.length > 80 ? `${cleaned.slice(0, 80)}...` : cleaned;
}

function createAgentActions(agentId: AaisAgentId, phase: AaisPhase) {
  void phase;
  if (agentId === "A1") {
    return ["guide-flow", "scaffold"];
  }
  if (agentId === "A2") {
    return ["model", "coach", "mention-expert"];
  }
  if (agentId === "A3") {
    return ["monitor", "signal-a1"];
  }
  return ["articulate", "reflect", "compare"];
}

function formatMessage(locale: Locale, turns: AaisGuideTurn[]) {
  const title =
    locale === "zh-CN"
      ? "AAIS 智能体已回复："
      : "AAIS agents replied:";
  return [title, ...turns.map((turn, index) => `${index + 1}. ${turn.label}: ${turn.content}`)].join(
    "\n",
  );
}

function normalizeAaisGuideWorkspaceState(workspaceState: AaisWorkspaceState) {
  const attachments = normalizeAaisGuideAttachments(workspaceState.attachments);
  return {
    ...workspaceState,
    ...(attachments.length ? { attachments } : { attachments: undefined }),
  };
}

function formatAttachmentSummary(attachments?: AaisGuideAttachment[]) {
  if (!attachments?.length) {
    return "";
  }
  const names = attachments.map((attachment) => attachment.name).join("、");
  return `我也会参考你上传的文件：${names}。`;
}

function createThreadId(input: AaisGuideInput) {
  return `aais-${hashSeed(
    [input.studentId, input.phase, input.taskId, input.learnerInput].join("|"),
  )}`;
}

function hashSeed(seed: string) {
  let hash = 0;
  for (const character of seed) {
    hash = (hash * 31 + character.charCodeAt(0)) >>> 0;
  }
  return hash.toString(36);
}
