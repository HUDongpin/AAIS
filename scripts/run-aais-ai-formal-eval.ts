#!/usr/bin/env -S npx tsx

import { createHash } from "node:crypto";
import {
  closeSync,
  constants as fsConstants,
  fsyncSync,
  openSync,
  readFileSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { pathToFileURL } from "node:url";
import {
  aaisAgents,
  aaisCognitiveApprenticeshipBackground,
  type AaisAgent,
  type AaisAgentId,
  type Locale,
} from "@/data/aais";
import {
  createOpenAiCompatibleAaisProvider,
  type AaisModelRequest,
} from "@/lib/ai/aais-ai-provider";
import {
  getAaisAiEndpointFingerprint,
  getAaisAiObservedSnapshotSha256,
  getAaisAiSourceContractEvidence,
  isAaisImmutableQwenSnapshotModel,
} from "@/lib/ai/aais-ai-source-contract";

const requiredAgentIds = ["A1", "A2", "A3", "A4"] as const;
const requiredLocales = ["zh-CN", "en-US"] as const;
const requiredCaModules = [
  "Modelling",
  "Coaching",
  "Scaffolding",
  "Fading",
  "Articulation",
  "Reflection",
] as const;
const providerTemperature = 0.2;
const providerMaxTokens = 600;
const providerTimeoutMs = 12_000;
const providerMaxRetries = 0;
const evidenceWindowMs = 365 * 24 * 60 * 60 * 1_000;
const safeIdentifierPattern = /^[A-Za-z0-9][A-Za-z0-9._:-]{2,127}$/;

const evidenceContracts = {
  A1: {
    label: "导学智能体",
    responsibility: "frontend-guide-scaffolding",
    caModules: ["Scaffolding", "Fading"],
  },
  A2: {
    label: "专家智能体",
    responsibility: "frontend-expert-modelling-coaching",
    caModules: ["Modelling", "Coaching"],
  },
  A3: {
    label: "监督智能体",
    responsibility: "backend-supervision-a1-signal",
    caModules: ["Scaffolding"],
  },
  A4: {
    label: "反思智能体",
    responsibility: "backend-reflection-articulation",
    caModules: ["Articulation", "Reflection"],
  },
} as const;

const learnerInputs: Record<AaisAgentId, Record<Locale, string>> = {
  A1: {
    "zh-CN": "我刚开始练习，请只给当前最有用的一步，并问一个短问题帮助我继续。",
    "en-US": "I am starting practice. Give only the most useful next step and one short question.",
  },
  A2: {
    "zh-CN": "请紧凑示范一次目标、计划、监控和调整的专家思路，再给一个练习提示。",
    "en-US": "Compactly model goal, plan, monitoring, and adjustment, then give one practice prompt.",
  },
  A3: {
    "zh-CN": "学习者停顿且草稿进度下降。请生成一个给 A1 的低打扰支架信号。",
    "en-US": "The learner paused and draft progress declined. Produce one low-interruption scaffold signal for A1.",
  },
  A4: {
    "zh-CN": "请形成一个简短反思提示，帮助学习者比较自己的过程与专家路径。",
    "en-US": "Produce one concise reflection prompt comparing the learner process with the expert path.",
  },
};

export type AaisFormalEvalInput = {
  model: string;
  endpoint: string;
  apiKey: string;
  evalVersion: string;
  now?: Date;
  fetchImpl?: typeof fetch;
};

export class AaisFormalEvalError extends Error {
  code: string;

  constructor(code: string) {
    super(code);
    this.name = "AaisFormalEvalError";
    this.code = code;
  }
}

export async function runAaisFormalEval(input: AaisFormalEvalInput) {
  validateInput(input);
  const startedAt = input.now ?? new Date();
  if (!Number.isFinite(startedAt.getTime())) fail("AAIS_AI_FORMAL_EVAL_CLOCK_INVALID");
  const sourceEvidence = getAaisAiSourceContractEvidence();
  const samples = createFormalEvalSamples();
  const provider = createOpenAiCompatibleAaisProvider({
    provider: "qwen",
    endpoint: input.endpoint,
    apiKey: input.apiKey,
    model: input.model,
    thinkingMode: "disabled",
    timeoutMs: providerTimeoutMs,
    maxRetries: providerMaxRetries,
    maxTokens: providerMaxTokens,
    requireObservedModel: true,
    fetchImpl: input.fetchImpl,
  });

  const results = await runWithConcurrency(samples, 2, async (sample) => {
    const sampleStartedAt = Date.now();
    let response;
    try {
      response = await provider.generate(sample.request);
    } catch {
      fail("AAIS_AI_FORMAL_EVAL_PROVIDER_SAMPLE_FAILED");
    }
    const observation = response.runtime.observation;
    if (response.runtime.status !== "ok"
      || response.runtime.guardrail.status !== "passed"
      || observation?.model !== "matched"
      || observation.kind !== "exact-provider-model-id"
      || observation.snapshotSha256 !== getAaisAiObservedSnapshotSha256(input.model)) {
      fail("AAIS_AI_FORMAL_EVAL_SAMPLE_CONTRACT_FAILED");
    }
    return {
      id: sample.id,
      agentId: sample.agentId,
      locale: sample.locale,
      status: "passed" as const,
      attempts: response.runtime.attempts,
      observedModel: "matched" as const,
      observedSnapshotSha256: observation.snapshotSha256,
      guardrail: "passed" as const,
      latencyMs: Date.now() - sampleStartedAt,
      output: "omitted" as const,
    };
  });

  const observedSnapshots = [...new Set(
    results.map((result) => result.observedSnapshotSha256),
  )];
  if (observedSnapshots.length !== 1
    || observedSnapshots[0] !== getAaisAiObservedSnapshotSha256(input.model)) {
    fail("AAIS_AI_FORMAL_EVAL_SNAPSHOT_UNSTABLE");
  }

  const passedAt = startedAt.toISOString();
  const expiresAt = new Date(startedAt.getTime() + evidenceWindowMs).toISOString();
  const evalSuiteSha256 = hashCanonical("aais-ai-formal-eval-suite-v2", {
    contractVersion: "aais-ai-formal-eval-suite-v2",
    provider: "openai-compatible",
    providerFamily: "qwen",
    model: input.model,
    runtime: {
      endpointFingerprint: getAaisAiEndpointFingerprint(input.endpoint),
      thinkingMode: "disabled",
      temperature: providerTemperature,
      maxTokens: providerMaxTokens,
      timeoutMs: providerTimeoutMs,
      maxRetries: providerMaxRetries,
    },
    samples: samples.map((sample) => sample.suiteContract),
  });
  const evalDataSha256 = hashCanonical("aais-ai-formal-eval-data-v2", {
    evalVersion: input.evalVersion,
    provider: "openai-compatible",
    providerFamily: "qwen",
    model: input.model,
    results,
  });

  return {
    schemaVersion: 2 as const,
    evalVersion: input.evalVersion,
    provider: "openai-compatible" as const,
    providerFamily: "qwen" as const,
    model: input.model,
    status: "passed" as const,
    passedAt,
    expiresAt,
    sampleCount: results.length,
    blockedCount: 0,
    redaction: {
      prompts: "summarized" as const,
      outputs: "omitted" as const,
      secrets: "omitted" as const,
      rawObservedModel: "omitted" as const,
    },
    agentEvidence: createAgentEvidence(samples),
    releaseEvidence: {
      contractVersion: "aais-ai-eval-release-v2" as const,
      runtimeContract: {
        endpointFingerprint: getAaisAiEndpointFingerprint(input.endpoint),
        thinkingMode: "disabled" as const,
        temperature: providerTemperature as 0.2,
        maxTokens: providerMaxTokens as 600,
        maxRetries: providerMaxRetries as 0,
        requestedSnapshotModel: input.model,
        observationKind: "exact-provider-model-id" as const,
        observedSnapshotSha256: observedSnapshots[0],
      },
      evalSuiteSha256,
      evalDataSha256,
      agentPromptContractSha256: sourceEvidence.agentPromptContractSha256,
      caBackgroundSha256: sourceEvidence.caBackgroundSha256,
      guardrailSha256: sourceEvidence.guardrailSha256,
      localeCoverage: {
        requiredLocales: [...requiredLocales],
        coveredLocales: [...requiredLocales],
        agentLocales: Object.fromEntries(requiredAgentIds.map((agentId) => [
          agentId,
          [...requiredLocales],
        ])),
        complete: true,
      },
    },
    results,
    attestation: {
      algorithm: "ed25519" as const,
      keyId: "",
      signature: "",
    },
  };
}

export function writeAaisFormalEvalManifest(outputPath: string, manifest: unknown) {
  const normalized = String(outputPath ?? "").trim();
  if (!normalized || normalized.includes("\0")) {
    fail("AAIS_AI_FORMAL_EVAL_OUTPUT_PATH_INVALID");
  }
  let descriptor: number | null = null;
  try {
    descriptor = openSync(
      normalized,
      fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_WRONLY,
      0o600,
    );
    writeFileSync(descriptor, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
    fsyncSync(descriptor);
    closeSync(descriptor);
    descriptor = null;
  } catch {
    if (descriptor !== null) {
      try {
        closeSync(descriptor);
      } catch {
        // The descriptor belongs only to this invocation.
      }
      try {
        unlinkSync(normalized);
      } catch {
        // Best effort for a file created only by this invocation.
      }
    }
    fail("AAIS_AI_FORMAL_EVAL_OUTPUT_WRITE_FAILED");
  }
}

function createFormalEvalSamples() {
  return requiredAgentIds.flatMap((agentId) => requiredLocales.map((locale) => {
    const agent = requireAgent(agentId);
    const id = `${agentId.toLowerCase()}-${locale === "zh-CN" ? "zh" : "en"}-snapshot-v2`;
    const voice = agent.voice ? {
      persona: agent.voice.persona[locale],
      tone: agent.voice.tone[locale],
      replyContract: agent.voice.replyContract[locale],
      maxSentences: agent.voice.maxSentences,
      maxCharacters: agent.voice.maxCharacters?.[locale],
      maxOutputTokens: agent.voice.maxOutputTokens,
    } : undefined;
    const request: AaisModelRequest = {
      agentId,
      label: agent.name[locale],
      role: agent.role[locale],
      mission: agent.mission[locale],
      voice,
      caModules: agent.caModules,
      caBackground: aaisCognitiveApprenticeshipBackground,
      locale,
      phase: agentId === "A1" || agentId === "A2" ? "training" : "practice",
      taskId: `formal_eval_${agentId.toLowerCase()}`,
      learnerInput: learnerInputs[agentId][locale],
      workspaceState: {
        currentStep: "formal-provider-evaluation",
        artifactText: "Synthetic evaluation artifact with no learner data.",
        helpRequestsUsed: agentId === "A1" ? 3 : 1,
        attachments: [],
      },
      fallbackText: "Deterministic output is forbidden in this formal evaluation.",
    };
    return {
      id,
      agentId,
      locale,
      request,
      suiteContract: {
        id,
        agentId,
        locale,
        phase: request.phase,
        caModules: [...agent.caModules],
        learnerInputSha256: hashCanonical(
          "aais-ai-formal-eval-input-v2",
          request.learnerInput,
        ),
      },
    };
  }));
}

function createAgentEvidence(samples: ReturnType<typeof createFormalEvalSamples>) {
  return {
    contractVersion: "aais-a1-a4-ca-eval-v2" as const,
    requiredAgents: [...requiredAgentIds],
    coveredAgents: [...requiredAgentIds],
    requiredCaModules: [...requiredCaModules],
    coveredCaModules: [...requiredCaModules],
    coverage: Object.fromEntries(requiredAgentIds.map((agentId) => {
      const contract = evidenceContracts[agentId];
      return [agentId, {
        label: contract.label,
        responsibility: contract.responsibility,
        sampleIds: samples
          .filter((sample) => sample.agentId === agentId)
          .map((sample) => sample.id),
        caModules: [...contract.caModules],
        complete: true,
      }];
    })),
    caBackgroundIncluded: true,
    rawPromptsStored: false,
    rawOutputsStored: false,
    complete: true,
  };
}

function requireAgent(agentId: AaisAgentId): AaisAgent {
  const agent = aaisAgents.find((candidate) => candidate.id === agentId);
  if (!agent) fail("AAIS_AI_FORMAL_EVAL_AGENT_MISSING");
  return agent;
}

async function runWithConcurrency<T, R>(
  values: readonly T[],
  concurrency: number,
  worker: (value: T) => Promise<R>,
) {
  const results = new Array<R>(values.length);
  let cursor = 0;
  await Promise.all(Array.from({ length: Math.min(concurrency, values.length) }, async () => {
    while (cursor < values.length) {
      const index = cursor;
      cursor += 1;
      results[index] = await worker(values[index]);
    }
  }));
  return results;
}

function validateInput(input: AaisFormalEvalInput) {
  if (!isAaisImmutableQwenSnapshotModel(input.model)
    || !safeIdentifierPattern.test(String(input.evalVersion ?? ""))
    || !String(input.endpoint ?? "").trim()
    || !String(input.apiKey ?? "").trim()) {
    fail("AAIS_AI_FORMAL_EVAL_INPUT_INVALID");
  }
  try {
    const endpoint = new URL(input.endpoint);
    if (endpoint.protocol !== "https:"
      || endpoint.hostname !== "dashscope.aliyuncs.com"
      || endpoint.pathname !== "/compatible-mode/v1/chat/completions"
      || endpoint.username
      || endpoint.password
      || endpoint.search
      || endpoint.hash) {
      fail("AAIS_AI_FORMAL_EVAL_ENDPOINT_INVALID");
    }
  } catch (error) {
    if (error instanceof AaisFormalEvalError) throw error;
    fail("AAIS_AI_FORMAL_EVAL_ENDPOINT_INVALID");
  }
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

function readEnvFile(filePath: string) {
  const values = new Map<string, string>();
  for (const rawLine of readFileSync(filePath, "utf8").split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const normalized = line.startsWith("export ")
      ? line.slice("export ".length).trim()
      : line;
    const separator = normalized.indexOf("=");
    if (separator <= 0) continue;
    const key = normalized.slice(0, separator).trim();
    if (!/^[A-Z][A-Z0-9_]{1,127}$/.test(key)) continue;
    let value = normalized.slice(separator + 1).trim();
    if ((value.startsWith("\"") && value.endsWith("\""))
      || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    values.set(key, value);
  }
  return values;
}

function parseArgs(argv: string[]) {
  const args = new Map<string, string>();
  for (let index = 0; index < argv.length; index += 1) {
    const current = argv[index];
    if (!current.startsWith("--")) continue;
    const separator = current.indexOf("=");
    if (separator > 2) {
      args.set(current.slice(2, separator), current.slice(separator + 1));
      continue;
    }
    const value = argv[index + 1];
    if (value === undefined || value.startsWith("--")) {
      fail("AAIS_AI_FORMAL_EVAL_CLI_INVALID");
    }
    args.set(current.slice(2), value);
    index += 1;
  }
  return args;
}

function requiredArg(args: Map<string, string>, name: string) {
  const value = String(args.get(name) ?? "").trim();
  if (!value) fail("AAIS_AI_FORMAL_EVAL_CLI_INVALID");
  return value;
}

function fail(code: string): never {
  throw new AaisFormalEvalError(code);
}

async function main() {
  try {
    const args = parseArgs(process.argv.slice(2));
    const envFile = readEnvFile(requiredArg(args, "env-file"));
    const manifest = await runAaisFormalEval({
      model: requiredArg(args, "model"),
      endpoint: requiredArg(args, "endpoint"),
      apiKey: String(
        envFile.get("AAIS_AI_API_KEY")
        ?? envFile.get("DASHSCOPE_API_KEY")
        ?? envFile.get("QWEN_API_KEY")
        ?? "",
      ),
      evalVersion: requiredArg(args, "eval-version"),
    });
    const outputPath = requiredArg(args, "output");
    writeAaisFormalEvalManifest(outputPath, manifest);
    console.log(JSON.stringify({
      status: "passed",
      provider: manifest.providerFamily,
      model: manifest.model,
      evalVersion: manifest.evalVersion,
      sampleCount: manifest.sampleCount,
      observedSnapshotSha256:
        manifest.releaseEvidence.runtimeContract.observedSnapshotSha256,
      evalSuiteSha256: manifest.releaseEvidence.evalSuiteSha256,
      evalDataSha256: manifest.releaseEvidence.evalDataSha256,
      passedAt: manifest.passedAt,
      expiresAt: manifest.expiresAt,
      outputPath,
      secrets: "redacted",
      prompts: "summarized",
      outputs: "omitted",
    }));
  } catch (error) {
    const code = error instanceof AaisFormalEvalError
      ? error.code
      : "AAIS_AI_FORMAL_EVAL_FAILED";
    console.error(JSON.stringify({ status: "blocked", code, secrets: "redacted" }));
    process.exitCode = 1;
  }
}

const invokedPath = process.argv[1] ? pathToFileURL(process.argv[1]).href : "";
if (import.meta.url === invokedPath) void main();
