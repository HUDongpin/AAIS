import { Annotation, END, InMemoryStore, MemorySaver, START, StateGraph } from "@langchain/langgraph";
import {
  createConfiguredAaisModelProvider,
  type AaisModelProvider,
  type AaisModelRuntime,
} from "@/lib/ai/aais-ai-provider";
import {
  aaisAgents,
  type AaisAgentId,
  type AaisPhase,
  type Locale,
} from "@/data/aais";

type AaisWorkspaceState = {
  currentStep: string;
  artifactText?: string;
  helpRequestsUsed?: number;
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

export type AaisGuideInput = {
  locale: Locale;
  studentId: string;
  phase: AaisPhase;
  taskId: string;
  learnerInput: string;
  workspaceState: AaisWorkspaceState;
  threadId?: string;
};

type AaisGuideState = AaisGuideInput & {
  turns: AaisGuideTurn[];
  providerRuns: AaisGuideProviderRun[];
};

type AaisGuideOptions = {
  modelProvider?: AaisModelProvider;
};

const redaction = {
  secrets: "omitted",
  localFiles: "omitted",
  assets: "ids-only",
} as const;

const GuideState = Annotation.Root({
  locale: Annotation<Locale>(),
  studentId: Annotation<string>(),
  phase: Annotation<AaisPhase>(),
  taskId: Annotation<string>(),
  learnerInput: Annotation<string>(),
  workspaceState: Annotation<AaisWorkspaceState>(),
  threadId: Annotation<string | undefined>(),
  turns: Annotation<AaisGuideTurn[]>({
    reducer: (left, right) => left.concat(right),
    default: () => [],
  }),
  providerRuns: Annotation<AaisGuideProviderRun[]>({
    reducer: (left, right) => left.concat(right),
    default: () => [],
  }),
});

const graphId = "learning-ai-guide" as const;
const topologicalOrder: AaisAgentId[] = ["A1", "A2", "A3", "A4"];

export async function runAaisLearningGuideGraph(
  input: AaisGuideInput,
  options: AaisGuideOptions = {},
) {
  const modelProvider = options.modelProvider ?? createConfiguredAaisModelProvider();
  const checkpointer = new MemorySaver();
  const store = new InMemoryStore();
  const graph = new StateGraph(GuideState)
    .addNode("A1", (state) => createAgentTurn("A1", state, modelProvider))
    .addNode("A2", (state) => createAgentTurn("A2", state, modelProvider))
    .addNode("A3", (state) => createAgentTurn("A3", state, modelProvider))
    .addNode("A4", (state) => createAgentTurn("A4", state, modelProvider))
    .addEdge(START, "A1")
    .addEdge("A1", "A2")
    .addEdge("A2", "A3")
    .addEdge("A3", "A4")
    .addEdge("A4", END)
    .compile({
      checkpointer,
      store,
    });
  const threadId = input.threadId ?? createThreadId(input);
  const graphInput: AaisGuideState = {
    ...input,
    turns: [],
    providerRuns: [],
  };
  const runtimeEvents: Array<{
    type: "node-update";
    graphId: typeof graphId;
    threadId: string;
    nodeId: AaisAgentId;
    redaction: typeof redaction;
  }> = [];
  const stream = await graph.stream(graphInput, {
    configurable: {
      thread_id: threadId,
    },
    streamMode: "updates",
  });

  for await (const chunk of stream) {
    if (!chunk || typeof chunk !== "object") {
      continue;
    }
    for (const nodeId of Object.keys(chunk)) {
      if (topologicalOrder.includes(nodeId as AaisAgentId)) {
        runtimeEvents.push({
          type: "node-update",
          graphId,
          threadId,
          nodeId: nodeId as AaisAgentId,
          redaction,
        });
      }
    }
  }

  const state = await graph.getState({
    configurable: {
      thread_id: threadId,
    },
  });
  const values = state.values as AaisGuideState;

  return {
    status: "ok" as const,
    graph: {
      runtime: "langgraph" as const,
      graphId,
      topologicalOrder,
    },
    turns: values.turns,
    messageText: formatMessage(input.locale, values.turns),
    runtime: {
      engine: "aais-langgraph-runtime" as const,
      status: "completed" as const,
      threadId,
      eventCount: runtimeEvents.length,
      redaction,
      modelProvider: summarizeProviderRuns(values.providerRuns),
    },
    trace: {
      handoffs: [
        { fromNodeId: "A1", toNodeId: "A2", reason: "task-released" },
        { fromNodeId: "A2", toNodeId: "A3", reason: "behavior-data-packaged" },
        { fromNodeId: "A3", toNodeId: "A4", reason: "practice-scaffold-check" },
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

async function createAgentTurn(
  agentId: AaisAgentId,
  state: typeof GuideState.State,
  modelProvider: AaisModelProvider,
) {
  const agent = aaisAgents.find((candidate) => candidate.id === agentId) ?? aaisAgents[0];
  const fallbackText = createAgentContent(agentId, state);
  const response = await modelProvider.generate({
    agentId,
    label: agent.name[state.locale],
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
  return {
    turns: [
      {
        agentId,
        label: agent.name[state.locale],
        content: response.text,
        actions: createAgentActions(agentId, state.phase),
      },
    ],
    providerRuns: [
      {
        agentId,
        ...response.runtime,
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

function createAgentContent(agentId: AaisAgentId, state: typeof GuideState.State) {
  const input = state.learnerInput.trim() || "学生尚未输入。";
  const helpCount = state.workspaceState.helpRequestsUsed ?? 0;

  if (agentId === "A1") {
    return `导学智能体：我会围绕 ${state.taskId} 明确目标、示范专家思路，并把下一步任务拆清楚。你刚才说：${input}`;
  }
  if (agentId === "A2") {
    return `监督智能体：我记录当前步骤 ${state.workspaceState.currentStep}，关注停顿、删改和 AI 采纳，稍后把行为线索共享给 A3。`;
  }
  if (agentId === "A3") {
    return "反思智能体：请把你的任务理解、计划、执行偏差和完成前评分写出来，我会并排展示学生与专家思维轨迹。";
  }

  if (state.phase === "practice") {
    return helpCount >= 4
      ? "支架智能体：这是第 5 次及以后求助。请先说明你卡在哪里，我再给出对应的元认知工具。"
      : "支架智能体：练习阶段可提供阶段检查表、思维句子开头、对比案例和暂停提示。";
  }
  return "支架智能体：A4 只在练习阶段开放；训练阶段先跟随 A1-A3 完成示范、监控和反思。";
}

function createAgentActions(agentId: AaisAgentId, phase: AaisPhase) {
  if (agentId === "A4" && phase === "training") {
    return ["defer"];
  }
  if (agentId === "A2") {
    return ["monitor", "package-data"];
  }
  if (agentId === "A3") {
    return ["articulate", "compare"];
  }
  return ["respond"];
}

function formatMessage(locale: Locale, turns: AaisGuideTurn[]) {
  const title =
    locale === "zh-CN"
      ? "LangGraph 多智能体导学已完成："
      : "LangGraph multi-agent guide completed:";
  return [title, ...turns.map((turn, index) => `${index + 1}. ${turn.label}: ${turn.content}`)].join(
    "\n",
  );
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
