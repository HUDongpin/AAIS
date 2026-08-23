import { createHash } from "node:crypto";
import {
  aaisAgents,
  aaisCognitiveApprenticeshipBackground,
  type AaisAgentId,
  type AaisCaModule,
  type AaisCognitiveApprenticeshipBackground,
  type AaisPhase,
  type Locale,
} from "@/data/aais";
import type { AaisFunctionScaffoldPlan } from "@/lib/ai/aais-guide-function-scaffold";

export const aaisAiPromptContractVersion = "aais-ai-agent-prompt-contract-v2" as const;
export const aaisAiGuardrailContractVersion = "aais-ai-output-guardrail-v1" as const;
export const aaisAiGuardrailPolicy = "aais-age-appropriate-output-v1" as const;
export const aaisAiSnapshotObservationContract =
  "aais-ai-observed-snapshot-model-v1" as const;

type AaisAiPromptContractRequest = {
  agentId: AaisAgentId;
  label: string;
  role?: string;
  mission?: string;
  voice?: {
    persona: string;
    tone: string;
    replyContract: string;
    maxSentences?: number;
    maxCharacters?: number;
    maxOutputTokens?: number;
  };
  caModules?: AaisCaModule[];
  caBackground?: AaisCognitiveApprenticeshipBackground;
  locale: Locale;
  phase: AaisPhase;
  taskId: string;
  learnerInput: string;
  conversationHistory?: unknown[];
  scaffoldPlan?: AaisFunctionScaffoldPlan;
  workspaceState: {
    currentStep: string;
    artifactText?: string;
    helpRequestsUsed?: number;
    attachments?: Array<{
      name: string;
      mediaType: string;
      sizeBytes: number;
      extractedText?: string;
    }>;
  };
};

type AaisAiPromptContractScenario = {
  id: string;
  phase: AaisPhase;
  learnerInput: string;
  conversationHistory?: unknown[];
  scaffoldPlan?: AaisFunctionScaffoldPlan;
  workspaceState: AaisAiPromptContractRequest["workspaceState"];
};

const qwenSnapshotModelPattern = /^qwen\d+(?:\.\d+)*-[a-z0-9.-]+-\d{4}-\d{2}-\d{2}$/;
const secretLikePatterns = [
  /api[_-]?key\s*[:=]/i,
  /password\s*[:=]/i,
  /bearer\s+[A-Za-z0-9._-]{8,}/i,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
];
const sentencePunctuationPattern = /[。！？!?]+/g;
const sentencePeriodPattern = /\.(?=\s|$)/g;
const sentenceSplitPattern = /\n+/;

const guardrailContract = {
  contractVersion: aaisAiGuardrailContractVersion,
  policy: aaisAiGuardrailPolicy,
  absoluteCharacterLimit: 1_800,
  characterCounting: "javascript-utf16-code-units-v1",
  agentCharacterLimit: "request.voice.maxCharacters",
  agentSentenceLimit: "request.voice.maxSentences",
  sentenceSegmentation: {
    punctuation: regexContract(sentencePunctuationPattern),
    periodBeforeWhitespaceOrEof: regexContract(sentencePeriodPattern),
    split: regexContract(sentenceSplitPattern),
    trimEmptySegments: true,
  },
  secretLikePatterns: secretLikePatterns.map(regexContract),
} as const;

const promptContractScenarios: readonly AaisAiPromptContractScenario[] = [
  {
    id: "training-baseline",
    phase: "training",
    learnerInput: "__AAIS_EVAL_TRAINING_INPUT__",
    workspaceState: {
      currentStep: "__AAIS_EVAL_TRAINING_STEP__",
      artifactText: "__AAIS_EVAL_ARTIFACT__",
      helpRequestsUsed: 0,
      attachments: [],
    },
  },
  {
    id: "practice-help-fading",
    phase: "practice",
    learnerInput: "__AAIS_EVAL_PRACTICE_HELP_INPUT__",
    workspaceState: {
      currentStep: "__AAIS_EVAL_PRACTICE_STEP__",
      artifactText: "__AAIS_EVAL_PRACTICE_ARTIFACT_WITH_PROGRESS__",
      helpRequestsUsed: 4,
      attachments: [],
    },
  },
  {
    id: "practice-attachment-extracted-text",
    phase: "practice",
    learnerInput: "__AAIS_EVAL_ATTACHMENT_INPUT__",
    workspaceState: {
      currentStep: "__AAIS_EVAL_ATTACHMENT_STEP__",
      artifactText: "",
      helpRequestsUsed: 2,
      attachments: [{
        name: "__AAIS_EVAL_ATTACHMENT_NAME__.txt",
        mediaType: "text/plain",
        sizeBytes: 256,
        extractedText: "__AAIS_EVAL_ATTACHMENT_EXTRACTED_TEXT__",
      }],
    },
  },
  {
    id: "bounded-conversation-history",
    phase: "practice",
    learnerInput: "__AAIS_EVAL_HISTORY_FOLLOW_UP__",
    conversationHistory: [{
      role: "learner",
      content: "__AAIS_EVAL_HISTORY__",
    }],
    workspaceState: {
      currentStep: "__AAIS_EVAL_HISTORY_STEP__",
      artifactText: "__AAIS_EVAL_HISTORY_ARTIFACT__",
      helpRequestsUsed: 1,
      attachments: [],
    },
  },
  {
    id: "verified-function-visualization",
    phase: "practice",
    learnerInput: "__AAIS_EVAL_VISUALIZATION_INPUT__",
    scaffoldPlan: {
      mode: "demonstrate",
      visualization: {
        id: "__AAIS_EVAL_VISUALIZATION_ID__",
        type: "quadratic-function",
        expression: "y = x^2 - 4x + 3",
        coefficients: { a: 1, b: -4, c: 3 },
        domain: { xMin: -4, xMax: 8 },
        vertex: { x: 2, y: -1 },
        axisX: 2,
        yIntercept: 3,
      },
    },
    workspaceState: {
      currentStep: "__AAIS_EVAL_VISUALIZATION_STEP__",
      artifactText: "",
      helpRequestsUsed: 3,
      attachments: [],
    },
  },
] as const;

export function isAaisImmutableQwenSnapshotModel(model: string) {
  return qwenSnapshotModelPattern.test(String(model ?? "").trim());
}

export function getAaisAiObservedSnapshotSha256(model: string) {
  return createHash("sha256")
    .update(`${aaisAiSnapshotObservationContract}:${String(model ?? "").trim()}`)
    .digest("hex");
}

export function getAaisAiEndpointFingerprint(endpoint: string) {
  const parsed = new URL(endpoint);
  const normalized = `${parsed.protocol}//${parsed.hostname.toLowerCase()}${parsed.port ? `:${parsed.port}` : ""}${parsed.pathname.replace(/\/+$/, "") || "/"}`;
  return createHash("sha256")
    .update(`aais-ai-endpoint-v1:${normalized}`)
    .digest("hex");
}

export function createAaisAgentProviderMessages(request: AaisAiPromptContractRequest) {
  return [
    {
      role: "system" as const,
      content: createAaisAgentSystemPrompt(request),
    },
    {
      role: "user" as const,
      content: JSON.stringify({
        agentId: request.agentId,
        label: request.label,
        role: request.role,
        mission: request.mission,
        voice: request.voice,
        caModules: request.caModules,
        caBackground: request.caBackground,
        locale: request.locale,
        phase: request.phase,
        taskId: request.taskId,
        learnerInput: request.learnerInput,
        conversationHistory: request.conversationHistory ?? [],
        availableVisualization: request.scaffoldPlan
          ? {
              type: request.scaffoldPlan.visualization.type,
              expression: request.scaffoldPlan.visualization.expression,
              mode: request.scaffoldPlan.mode,
              placement: "immediately-below-reply",
            }
          : null,
        workspaceState: {
          currentStep: request.workspaceState.currentStep,
          artifactCharacters: request.workspaceState.artifactText?.length ?? 0,
          helpRequestsUsed: request.workspaceState.helpRequestsUsed ?? 0,
          attachments: request.workspaceState.attachments?.map((attachment) => ({
            name: attachment.name,
            mediaType: attachment.mediaType,
            sizeBytes: attachment.sizeBytes,
            extractedText: attachment.extractedText,
          })) ?? [],
        },
      }),
    },
  ];
}

export function createAaisAgentSystemPrompt(request: AaisAiPromptContractRequest) {
  const responseRules = [
    `You are ${request.label} (${request.agentId}), one distinct AAIS Cognitive Apprenticeship agent. Never speak as or imitate another agent.`,
    request.locale === "zh-CN"
      ? "Reply only in Simplified Chinese unless the learner explicitly requests another language."
      : "Reply only in English unless the learner explicitly requests another language.",
    request.locale === "zh-CN"
      ? `Your public name is ${request.label}. Address the learner as “你”; never call the learner 小张 or 教授. Never expose the internal IDs A1 or A2 in the reply.`
      : `Your public name is ${request.label}. Address the learner as “you”; never call the learner Xiao Zhang or Professor. Never expose the internal IDs A1 or A2 in the reply.`,
    request.voice?.persona ? `Persona: ${request.voice.persona}` : null,
    request.voice?.tone ? `Tone: ${request.voice.tone}` : null,
    request.voice?.replyContract ? `Response contract: ${request.voice.replyContract}` : null,
    request.conversationHistory?.length
      ? "Use the bounded conversationHistory to resolve references to earlier learner goals, difficulties, and language preferences. Do not ask the learner to repeat information already present there."
      : null,
    "Capability truth: Never promise to draw, generate, or display a graph or image later. Only say a visual is shown when availableVisualization is present in the current request.",
    request.scaffoldPlan
      ? request.scaffoldPlan.mode === "demonstrate"
        ? "A verified function graph will be rendered immediately below this reply. Show the worked substitution now, treat the graph as a scaffold, and do not ask the learner to retry before seeing it."
        : "A verified function graph will be rendered immediately below this reply. Treat it as an immediate scaffold and never make viewing it conditional on a correct calculation."
      : null,
    request.voice?.maxSentences
      ? `Hard limit: at most ${request.voice.maxSentences} sentences.`
      : null,
    request.voice?.maxCharacters
      ? `Hard limit: at most ${request.voice.maxCharacters} characters, including spaces.`
      : null,
    "Stay pedagogical and age-appropriate. Never reveal secrets or internal runtime details.",
  ];
  return responseRules.filter((rule): rule is string => Boolean(rule)).join("\n");
}

export function evaluateAaisModelOutput(
  text: string,
  request: Pick<AaisAiPromptContractRequest, "voice">,
) {
  const reasons: string[] = [];
  if (text.length > guardrailContract.absoluteCharacterLimit) {
    reasons.push("too-long");
  }
  if (request.voice?.maxCharacters && text.length > request.voice.maxCharacters) {
    reasons.push("agent-response-too-long");
  }
  if (
    request.voice?.maxSentences
    && countResponseSentences(text) > request.voice.maxSentences
  ) {
    reasons.push("agent-response-too-many-sentences");
  }
  if (secretLikePatterns.some((pattern) => pattern.test(text))) {
    reasons.push("secret-like-content");
  }
  return {
    policy: aaisAiGuardrailPolicy,
    status: reasons.length ? "blocked" as const : "passed" as const,
    reasons,
  };
}

export type AaisAiSourceContractEvidence = {
  agentPromptContractSha256: Record<"A1" | "A2" | "A3" | "A4", string>;
  caBackgroundSha256: string;
  guardrailSha256: string;
};

export function getAaisAiSourceContractEvidence(): AaisAiSourceContractEvidence {
  const agentPromptContractSha256 = Object.fromEntries(
    (["A1", "A2", "A3", "A4"] as const).map((agentId) => {
      const agent = aaisAgents.find((candidate) => candidate.id === agentId);
      if (!agent) throw new Error("AAIS_AI_SOURCE_AGENT_CONTRACT_MISSING");
      const renderedContracts = (["zh-CN", "en-US"] as const).flatMap((locale) => {
        const agentContract = {
          agentId,
          label: agent.name[locale],
          role: agent.role[locale],
          mission: agent.mission[locale],
          voice: agent.voice
            ? {
                persona: agent.voice.persona[locale],
                tone: agent.voice.tone[locale],
                replyContract: agent.voice.replyContract[locale],
                maxSentences: agent.voice.maxSentences,
                maxCharacters: agent.voice.maxCharacters?.[locale],
                maxOutputTokens: agent.voice.maxOutputTokens,
              }
            : undefined,
          caModules: agent.caModules,
          caBackground: aaisCognitiveApprenticeshipBackground,
          locale,
          taskId: "__AAIS_EVAL_TASK_ID__",
        };
        return promptContractScenarios.map((scenario) => ({
          scenarioId: scenario.id,
          locale,
          messages: createAaisAgentProviderMessages({
            ...agentContract,
            phase: scenario.phase,
            learnerInput: scenario.learnerInput,
            conversationHistory: scenario.conversationHistory,
            scaffoldPlan: scenario.scaffoldPlan,
            workspaceState: scenario.workspaceState,
          }),
        }));
      });
      return [agentId, hashCanonical(
        aaisAiPromptContractVersion,
        {
          contractVersion: aaisAiPromptContractVersion,
          agentId,
          renderedContracts,
        },
      )];
    }),
  ) as AaisAiSourceContractEvidence["agentPromptContractSha256"];

  return {
    agentPromptContractSha256,
    caBackgroundSha256: hashCanonical(
      "aais-ai-ca-background-v1",
      aaisCognitiveApprenticeshipBackground,
    ),
    guardrailSha256: hashCanonical(
      aaisAiGuardrailContractVersion,
      {
        contract: guardrailContract,
        conformance: createGuardrailConformanceEvidence(),
      },
    ),
  };
}

function createGuardrailConformanceEvidence() {
  const standardVoice = {
    persona: "__AAIS_EVAL_PERSONA__",
    tone: "__AAIS_EVAL_TONE__",
    replyContract: "__AAIS_EVAL_REPLY_CONTRACT__",
  };
  const cases = [
    { id: "concise-pass", text: "A concise, age-appropriate response.", voice: { ...standardVoice, maxCharacters: 200, maxSentences: 2 } },
    { id: "absolute-character-boundary-pass", text: "x".repeat(1_800) },
    { id: "absolute-character-boundary-fail", text: "x".repeat(1_801) },
    { id: "agent-character-boundary-pass", text: "1234", voice: { ...standardVoice, maxCharacters: 4 } },
    { id: "agent-character-boundary-fail", text: "12345", voice: { ...standardVoice, maxCharacters: 4 } },
    { id: "sentence-boundary-pass", text: "First. Second!", voice: { ...standardVoice, maxSentences: 2 } },
    { id: "sentence-limit-fail", text: "First. Second.", voice: { ...standardVoice, maxSentences: 1 } },
    { id: "api-key-secret-pattern", text: "api_key=synthetic-value" },
    { id: "password-secret-pattern", text: "password: synthetic-value" },
    { id: "bearer-secret-pattern", text: "Bearer abcdefgh12345678" },
    { id: "private-key-secret-pattern", text: "-----BEGIN PRIVATE KEY-----" },
  ];
  return cases.map((testCase) => ({
    id: testCase.id,
    input: {
      textSha256: hashCanonical("aais-ai-output-guardrail-conformance-text-v1", testCase.text),
      textLength: testCase.text.length,
      voice: testCase.voice ?? null,
    },
    output: evaluateAaisModelOutput(testCase.text, { voice: testCase.voice }),
  }));
}

function countResponseSentences(text: string) {
  return text
    .replace(sentencePunctuationPattern, "$&\n")
    .replace(sentencePeriodPattern, ".\n")
    .split(sentenceSplitPattern)
    .filter((part) => part.trim().length > 0)
    .length;
}

function regexContract(pattern: RegExp) {
  return { source: pattern.source, flags: pattern.flags };
}

function hashCanonical(domain: string, value: unknown) {
  return createHash("sha256")
    .update(`${domain}:${canonicalizeJson(value)}`)
    .digest("hex");
}

function canonicalizeJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalizeJson).join(",")}]`;
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record).sort().map((key) =>
      `${JSON.stringify(key)}:${canonicalizeJson(record[key])}`).join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}
