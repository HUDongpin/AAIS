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
  localizeAaisGuideAgentReferences,
  selectAaisGuideReplyAgentIds,
  type AaisGuideTargetAgentId,
} from "@/lib/ai/aais-guide-targets";
import {
  normalizeAaisGuideAttachments,
  type AaisGuideAttachment,
} from "@/lib/ai/aais-guide-attachments";
import {
  createAaisFunctionScaffoldPlan,
  createAaisFunctionScaffoldResponse,
  createAaisUnsupportedFunctionGraphResponse,
  hasAaisGraphIntent,
  isAaisFunctionGraphRequest,
  type AaisFunctionScaffoldPlan,
  type AaisGuideVisualization,
} from "@/lib/ai/aais-guide-function-scaffold";

type AaisWorkspaceState = {
  currentStep: string;
  artifactText?: string;
  helpRequestsUsed?: number;
  attachments?: AaisGuideAttachment[];
};

export type AaisGuideConversationMessage = {
  kind: "user" | "assistant";
  text: string;
};

export type AaisGuideTurn = {
  agentId: AaisAgentId;
  label: string;
  content: string;
  actions: string[];
  visualizations?: AaisGuideVisualization[];
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
  conversationHistory?: AaisGuideConversationMessage[];
  targetAgentIds?: AaisGuideTargetAgentId[];
  workspaceState: AaisWorkspaceState;
  threadId?: string;
  scaffoldPlan?: AaisFunctionScaffoldPlan;
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
  signal?: AbortSignal;
};

const redaction = {
  secrets: "omitted",
  localFiles: "omitted",
  assets: "ids-only",
} as const;

const graphId = "learning-ai-guide" as const;
const topologicalOrder: AaisAgentId[] = ["A1", "A2", "A3", "A4"];
const backgroundAgentIds: AaisAgentId[] = ["A3", "A4"];
const maxConversationMessages = 10;
const maxConversationMessageCharacters = 1_200;
const maxConversationCharacters = 6_000;

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
  options.signal?.throwIfAborted();
  const conversationHistory = normalizeConversationHistory(input.conversationHistory);
  const responseLocale = resolveGuideResponseLocale(
    input.locale,
    input.learnerInput,
    conversationHistory,
  );
  const scaffoldPlan = createAaisFunctionScaffoldPlan({
    learnerInput: input.learnerInput,
    conversationHistory,
  });
  const unsupportedGraphRequest = !scaffoldPlan && (
    isAaisFunctionGraphRequest(input.learnerInput)
    || (
      hasAaisGraphIntent(input.learnerInput)
      && conversationHistory
        .filter((message) => message.kind === "user")
        .slice(-6)
        .some((message) => isAaisFunctionGraphRequest(message.text))
    )
  );
  const boundedInput: AaisGuideInput = {
    ...input,
    locale: responseLocale,
    targetAgentIds: selectAaisGuideReplyAgentIds(input.learnerInput),
    ...(conversationHistory.length ? { conversationHistory } : { conversationHistory: undefined }),
    workspaceState: normalizeAaisGuideWorkspaceState(input.workspaceState),
    ...(scaffoldPlan ? { scaffoldPlan } : { scaffoldPlan: undefined }),
  };
  const modelProvider = options.modelProvider ?? createConfiguredAaisModelProvider();
  const backgroundProvider = createDeterministicAaisProvider();
  const targetAgentIds = boundedInput.targetAgentIds ?? ["A1"];
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
  }, options.signal ? { signal: options.signal } : undefined);
  options.signal?.throwIfAborted();
  const totalMs = Math.round(nowMs() - startedAt);
  const allRuns = sortAgentRuns(graphOutput.runs);
  const turns = applyAaisFunctionScaffold(
    allRuns.flatMap((run) => run.turns),
    boundedInput.scaffoldPlan,
    unsupportedGraphRequest,
    targetAgentIds,
    boundedInput.locale,
  );
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
    .addNode("A1", (state: AaisGuideGraphStateValue, runtime) =>
      runAaisGuideAgentNode("A1", state, runtime.signal))
    .addNode("A2", (state: AaisGuideGraphStateValue, runtime) =>
      runAaisGuideAgentNode("A2", state, runtime.signal))
    .addNode("A3", (state: AaisGuideGraphStateValue, runtime) =>
      runAaisGuideAgentNode("A3", state, runtime.signal))
    .addNode("A4", (state: AaisGuideGraphStateValue, runtime) =>
      runAaisGuideAgentNode("A4", state, runtime.signal))
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
  signal?: AbortSignal,
) {
  signal?.throwIfAborted();
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
        signal,
      ),
    ],
  };
}

async function createAgentTurn(
  agentId: AaisAgentId,
  state: AaisGuideState,
  modelProvider: AaisModelProvider,
  visible: boolean,
  signal?: AbortSignal,
) {
  signal?.throwIfAborted();
  const startedAt = nowMs();
  const agent = aaisAgents.find((candidate) => candidate.id === agentId) ?? aaisAgents[0];
  const fallbackText = createAgentContent(agentId, state);
  let response;
  try {
    response = await modelProvider.generate({
      agentId,
      label: agent.name[state.locale],
      role: agent.role[state.locale],
      mission: agent.mission[state.locale],
      voice: agent.voice
        ? {
            persona: agent.voice.persona[state.locale],
            tone: agent.voice.tone[state.locale],
            replyContract: agent.voice.replyContract[state.locale],
            maxSentences: agent.voice.maxSentences,
            maxCharacters: agent.voice.maxCharacters?.[state.locale],
            maxOutputTokens: agent.voice.maxOutputTokens,
          }
        : undefined,
      caModules: agent.caModules,
      caBackground: aaisCognitiveApprenticeshipBackground,
      locale: state.locale,
      phase: state.phase,
      taskId: state.taskId,
      learnerInput: state.learnerInput,
      conversationHistory: state.conversationHistory,
      workspaceState: state.workspaceState,
      scaffoldPlan: state.scaffoldPlan,
      fallbackText,
      signal,
    });
  } catch {
    signal?.throwIfAborted();
    response = {
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
    };
  }
  signal?.throwIfAborted();
  const elapsedMs = Math.round(nowMs() - startedAt);
  const learnerVisibleText = visible
    ? localizeAaisGuideAgentReferences(response.text, state.locale)
    : response.text;
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
        content: learnerVisibleText,
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
    fallback: visibleTimings.some((timing) => timing.fallback),
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
  const english = state.locale === "en-US";
  const input = state.learnerInput.trim() || (english ? "The learner has not entered a response yet." : "学生尚未输入。");
  const helpCount = state.workspaceState.helpRequestsUsed ?? 0;

  if (english) {
    if (agentId === "A1") {
      return createA1ConciseFallback(state);
    }
    if (agentId === "A2") {
      return createA2ContextualFallback(state, input);
    }
    if (agentId === "A3") {
      return `Supervision Agent: I am collecting task-behavior signals for the current step, ${state.workspaceState.currentStep}, and will signal A1 when a scaffold may be useful. A1 remains responsible for responding to you.`;
    }
    return helpCount >= 4
      ? "Reflection Agent: I will organize the metacognitive process record from your repeated help requests, return it to you, and invite comparison with an expert process."
      : "Reflection Agent: Put your goal understanding, plan, adjustments, and reasons into words. I will form an articulation record and use reflective questions to support the next reflection.";
  }

  if (agentId === "A1") {
    return createA1ConciseFallback(state);
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

function createA1ConciseFallback(state: AaisGuideState) {
  const english = state.locale === "en-US";
  const helpCount = Math.max(0, state.workspaceState.helpRequestsUsed ?? 0);
  const remaining = Math.max(0, 4 - helpCount);
  const priorLearnerFocus = findPriorLearnerFocus(state.conversationHistory);
  const attachmentReference = createA1AttachmentReference(
    state.workspaceState.attachments,
    state.locale,
  );

  if (priorLearnerFocus && refersToPriorContext(state.learnerInput)) {
    return english
      ? `You previously identified this focus: ${priorLearnerFocus}. Let us work on its smallest verifiable next step.`
      : `你刚才说的卡点是：${priorLearnerFocus}。我们先推进其中最小、可验证的一步。`;
  }

  if (remaining === 0) {
    return english
      ? "The 4 direct assists are used. Tell me where you are stuck; I will give one small next-step hint."
      : "4 次直接辅助已用完。说说你卡在哪一步，我只给一个小提示。";
  }

  if (attachmentReference) {
    return english
      ? `I will use ${attachmentReference}; ${remaining} direct assists remain. Tell me the one step where you are stuck.`
      : `我会参考 ${attachmentReference}，还可直接求助 ${remaining} 次。先说你卡在哪一步。`;
  }

  return english
    ? `${remaining} direct assists remain. Tell me where you are stuck; I will help with only the next step.`
    : `还可直接求助 ${remaining} 次。先说你卡在哪一步，我只帮你推进下一步。`;
}

function createA2ContextualFallback(state: AaisGuideState, learnerInput: string) {
  const english = state.locale === "en-US";
  const topic = summarizeLearnerTopic(learnerInput, state.locale);
  const calculusFocus = /微积分|calculus/i.test(learnerInput);
  if (calculusFocus) {
    if (english) {
      return [
        "Professor (local scaffold mode): the live AI has not returned, so I will help you move forward with a local scaffold.",
        "For university calculus, begin with four moves: concept, graph, worked example, and review. Explain limits, derivatives, and integrals in one sentence each; use a function graph to connect rate of change and area; solve a few representative problems; then sort errors into definition, calculation, or modelling gaps.",
        "Following the Modelling/Coaching rhythm, choose one concept such as a limit and explain what problem it solves in your own words. Mention @Professor again if you would like an expert model for one step.",
      ].join("\n");
    }
    return [
      "教授（本地支架模式）：live AI 暂时未返回，我先用本地支架帮你推进。",
      "针对大学微积分，先抓住“概念—图像—例题—复盘”四步：先把极限、导数、积分分别用一句话解释清楚，再画函数图像理解变化率和面积，接着做少量典型题检验概念，最后把错题归类到定义不清、计算不熟或建模不准。",
      "按 Modelling/Coaching 的节奏，你下一步可以先选一个概念，比如极限，用自己的话写出它解决什么问题；如果需要专家示范，可以继续用 @教授 追问。",
    ].join("\n");
  }
  if (english) {
    return [
      "Professor (local scaffold mode): the live AI has not returned, so I will respond with a local scaffold.",
      `You are focusing on: ${topic}`,
      `I will use a Modelling/Coaching approach: first show how an expert would unpack the problem, then give you one practice prompt. Write three sentences: “What is my goal?”, “What do I know?”, and “What do I need to verify next?” Then mention @Professor so I can model one of those steps. Your current task is ${state.taskId}.`,
    ].join("\n");
  }
  return [
    "教授（本地支架模式）：live AI 暂时未返回，我先用本地支架回应你的问题。",
    `你刚才关注的是：${topic}`,
    `我会按 Modelling/Coaching 的方式处理：先示范专家会如何拆解这个问题，再给你一个练习提示。先写下“目标是什么、我已知什么、我下一步要验证什么”三句话，然后用 @教授 继续让我针对其中一步示范。当前任务是 ${state.taskId}。`,
  ].join("\n");
}

function summarizeLearnerTopic(input: string, locale: Locale) {
  const cleaned = input
    .replace(/@A\s*[12]/gi, "")
    .replace(/@\S+/g, "")
    .replace(/\s+/g, " ")
    .trim();
  if (!cleaned) {
    return locale === "en-US" ? "this learning task" : "这个学习任务";
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

function applyAaisFunctionScaffold(
  turns: AaisGuideTurn[],
  plan: AaisFunctionScaffoldPlan | undefined,
  unsupportedGraphRequest: boolean,
  targetAgentIds: AaisGuideTargetAgentId[],
  locale: Locale,
) {
  if (!plan && !unsupportedGraphRequest) {
    return turns;
  }
  const targetAgentId = targetAgentIds[0];
  let applied = false;
  return turns.map((turn) => {
    if (applied || turn.agentId !== targetAgentId) {
      return turn;
    }
    applied = true;
    return {
      ...turn,
      content: plan
        ? createAaisFunctionScaffoldResponse(plan, locale)
        : createAaisUnsupportedFunctionGraphResponse(locale),
      actions: [...new Set([
        ...turn.actions,
        ...(plan ? ["show-function-graph"] : ["function-graph-unavailable"]),
        ...(plan?.mode === "demonstrate" ? ["worked-example"] : []),
      ])],
      ...(plan ? { visualizations: [plan.visualization] } : { visualizations: undefined }),
    };
  });
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

function createA1AttachmentReference(
  attachments: AaisGuideAttachment[] | undefined,
  locale: Locale,
) {
  if (!attachments?.length) {
    return "";
  }
  const firstName = attachments[0]?.name.replace(/\s+/g, " ").trim().slice(0, 48) || "";
  if (!firstName) {
    return locale === "en-US" ? "the uploaded material" : "已上传的材料";
  }
  if (attachments.length === 1) {
    return firstName;
  }
  return locale === "en-US"
    ? `${firstName} and ${attachments.length - 1} more file(s)`
    : `${firstName} 等 ${attachments.length} 个文件`;
}

function createThreadId(input: AaisGuideInput) {
  return `aais-${hashSeed(
    [input.studentId, input.phase, input.taskId].join("|"),
  )}`;
}

function normalizeConversationHistory(
  history: AaisGuideConversationMessage[] | undefined,
) {
  const recent = (history ?? [])
    .filter((message): message is AaisGuideConversationMessage =>
      (message?.kind === "user" || message?.kind === "assistant")
      && typeof message.text === "string"
      && Boolean(message.text.trim()),
    )
    .slice(-maxConversationMessages);
  const normalized: AaisGuideConversationMessage[] = [];
  let remainingCharacters = maxConversationCharacters;

  for (let index = recent.length - 1; index >= 0 && remainingCharacters > 0; index -= 1) {
    const message = recent[index];
    const text = message.text.trim().slice(0, maxConversationMessageCharacters);
    const boundedText = text.slice(0, remainingCharacters);
    if (boundedText) {
      normalized.unshift({
        kind: message.kind,
        text: boundedText,
      });
      remainingCharacters -= boundedText.length;
    }
  }
  return normalized;
}

function resolveGuideResponseLocale(
  defaultLocale: Locale,
  learnerInput: string,
  history: AaisGuideConversationMessage[],
) {
  const candidates = [
    learnerInput,
    ...history
      .filter((message) => message.kind === "user")
      .map((message) => message.text)
      .reverse(),
  ];
  for (const candidate of candidates) {
    const preference = detectLanguagePreference(candidate);
    if (preference) {
      return preference;
    }
  }
  return defaultLocale;
}

function detectLanguagePreference(value: string): Locale | null {
  const englishPatterns = [
    /\b(?:answer|reply|respond|speak|continue|write|use)\b[\s\S]{0,64}\b(?:in\s+|with\s+|using\s+)?english\b/i,
    /\benglish(?:\s+only)?\b[\s\S]{0,48}\b(?:answers?|replies|responses?|questions?|from now on)\b/i,
    /(?:请|以后|接下来|全部|所有|一直|改用|切换|使用|用).{0,18}(?:英文|英语)(?:回答|回复|交流|作答)?/,
  ];
  if (englishPatterns.some((pattern) => pattern.test(value))) {
    return "en-US";
  }
  const chinesePatterns = [
    /\b(?:answer|reply|respond|speak|continue|write|use)\b[\s\S]{0,64}\b(?:in\s+|with\s+|using\s+)?(?:chinese|mandarin)\b/i,
    /(?:请|以后|接下来|全部|所有|一直|改用|切换|使用|用).{0,18}(?:中文|汉语)(?:回答|回复|交流|作答)?/,
  ];
  return chinesePatterns.some((pattern) => pattern.test(value)) ? "zh-CN" : null;
}

function findPriorLearnerFocus(history: AaisGuideConversationMessage[] | undefined) {
  const priorUserMessage = [...(history ?? [])]
    .reverse()
    .find((message) => message.kind === "user" && !detectLanguagePreference(message.text));
  if (!priorUserMessage) {
    return "";
  }
  return priorUserMessage.text
    .replace(/@A\s*[12]/gi, "")
    .replace(/@(?:小张|教授|Professor)/gi, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 64);
}

function refersToPriorContext(value: string) {
  return /刚才|之前|前面|上面|说过|提过|earlier|before|previous|already (?:said|mentioned)/i.test(value);
}

function hashSeed(seed: string) {
  let hash = 0;
  for (const character of seed) {
    hash = (hash * 31 + character.charCodeAt(0)) >>> 0;
  }
  return hash.toString(36);
}
