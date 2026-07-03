#!/usr/bin/env node

import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

const redaction = {
  prompts: "summarized",
  secrets: "omitted",
};

const guardrailPolicy = "aais-age-appropriate-output-v1";
const agentEvidenceContractVersion = "aais-a1-a4-ca-eval-v2";
const requiredAgentCoverage = {
  A1: {
    label: "导学智能体",
    caModules: ["Scaffolding", "Fading"],
    responsibility: "frontend-guide-scaffolding",
  },
  A2: {
    label: "专家智能体",
    caModules: ["Modelling", "Coaching"],
    responsibility: "frontend-expert-modelling-coaching",
  },
  A3: {
    label: "监督智能体",
    caModules: ["Scaffolding"],
    responsibility: "backend-supervision-a1-signal",
  },
  A4: {
    label: "反思智能体",
    caModules: ["Articulation", "Reflection"],
    responsibility: "backend-reflection-articulation",
  },
};
const requiredCaModules = ["Modelling", "Coaching", "Scaffolding", "Fading", "Articulation", "Reflection"];
const aaisAiEvalCaBackground = {
  framework: "Cognitive Apprenticeship",
  sequence: ["Modelling", "Coaching", "Scaffolding", "Articulation", "Reflection"],
  principles: [
    "modelling",
    "coaching",
    "scaffolding",
    "fading",
    "articulation",
    "reflection",
  ],
};

const defaultSamples = [
  {
    id: "a1-guide-training",
    agentId: "A1",
    label: "导学智能体",
    phase: "training",
    taskId: "training_task_1",
    caModules: ["Scaffolding", "Fading"],
    responsibility: "frontend-guide-scaffolding",
    interactionMode: "direct-student-dialogue",
    learnerInput: "我刚开始任务，请用简洁步骤帮助我理解专家示范。",
    fallbackText: "请先观察专家示范，再用自己的话说出关键步骤。",
  },
  {
    id: "a2-expert-modelling-coaching",
    agentId: "A2",
    label: "专家智能体",
    phase: "training",
    taskId: "training_task_1",
    caModules: ["Modelling", "Coaching"],
    responsibility: "frontend-expert-modelling-coaching",
    interactionMode: "direct-student-dialogue",
    learnerInput: "请用 @专家智能体 展示一次元认知解题过程，再给我一个练习提示。",
    fallbackText: "专家会先展示目标、计划、监控和调整，再用一个问题引导你练习。",
  },
  {
    id: "a3-supervision-a1-signal",
    agentId: "A3",
    label: "监督智能体",
    phase: "practice",
    taskId: "practice_task_1",
    caModules: ["Scaffolding"],
    responsibility: "backend-supervision-a1-signal",
    interactionMode: "backend-to-a1-signal",
    learnerInput: "学习者长时间停顿且 artifact 字数下降，请生成给 A1 的低打扰支架信号。",
    fallbackText: "向 A1 发送低打扰信号：先确认目标，再请学习者指出已完成一步和卡住一步。",
  },
  {
    id: "a4-articulation-reflection",
    agentId: "A4",
    label: "反思智能体",
    phase: "practice",
    taskId: "practice_task_1",
    caModules: ["Articulation", "Reflection"],
    responsibility: "backend-reflection-articulation",
    interactionMode: "backend-to-a1-reflection",
    learnerInput: "请帮我比较自己的过程和专家路径。",
    fallbackText: "用两句话写出相同点，再写出一个下一步改进。",
  },
];

export async function runAaisAiEvaluation(input = {}) {
  const envValues = await readEnvFile(input.envFilePath);
  const endpoint = requireValue(
    input.endpoint ?? envValues.get("AAIS_AI_ENDPOINT") ?? process.env.AAIS_AI_ENDPOINT,
    "AAIS_AI_ENDPOINT",
  );
  const apiKey = requireValue(
    input.apiKey ?? envValues.get("AAIS_AI_API_KEY") ?? process.env.AAIS_AI_API_KEY,
    "AAIS_AI_API_KEY",
  );
  const model = requireValue(
    input.model ?? envValues.get("AAIS_AI_MODEL") ?? process.env.AAIS_AI_MODEL,
    "AAIS_AI_MODEL",
  );
  const evalVersion = requireValue(
    input.evalVersion ?? envValues.get("AAIS_AI_EVAL_VERSION") ?? process.env.AAIS_AI_EVAL_VERSION,
    "AAIS_AI_EVAL_VERSION",
  );
  const samples = input.samples?.length ? input.samples : defaultSamples;
  const fetchImpl = input.fetchImpl ?? fetch;
  const evaluatedAt = (input.now ?? new Date()).toISOString();
  const releaseId = readReleaseId(input.releaseId ?? envValues.get("AAIS_RELEASE_ID") ?? process.env.AAIS_RELEASE_ID);
  const thinkingMode = input.thinkingMode
    ?? readThinkingMode(envValues.get("AAIS_AI_THINKING_MODE") ?? process.env.AAIS_AI_THINKING_MODE);
  const timeoutMs = input.timeoutMs
    ?? readPositiveInteger(envValues.get("AAIS_AI_TIMEOUT_MS") ?? process.env.AAIS_AI_TIMEOUT_MS, 8000);
  const results = [];
  const agentEvidence = buildAgentEvidenceCoverage(samples);

  for (const sample of samples) {
    results.push(await evaluateSample({
      endpoint,
      apiKey,
      model,
      thinkingMode,
      sample,
      fetchImpl,
      timeoutMs,
    }));
  }

  const blockedCount = results.filter((result) => result.status !== "passed").length;
  const manifest = {
    schemaVersion: 1,
    evalVersion,
    provider: "openai-compatible",
    model,
    status: blockedCount === 0 && agentEvidence.complete ? "passed" : "failed",
    passedAt: evaluatedAt,
    ...(releaseId ? { release: { id: releaseId } } : {}),
    sampleCount: samples.length,
    blockedCount,
    guardrailPolicy,
    sampleIds: samples.map((sample) => sample.id),
    agentEvidence,
    results,
    redaction,
  };

  const outputPath = input.outputPath ?? process.env.AAIS_AI_EVAL_MANIFEST_PATH;
  if (outputPath) {
    await mkdir(path.dirname(outputPath), { recursive: true });
    await writeFile(outputPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
  }

  const envJsonOutputPath = input.envJsonOutputPath;
  if (envJsonOutputPath) {
    await mkdir(path.dirname(envJsonOutputPath), { recursive: true });
    await writeFile(envJsonOutputPath, `${JSON.stringify(manifest)}\n`, "utf8");
  }

  return manifest;
}

async function evaluateSample({ endpoint, apiKey, model, thinkingMode, sample, fetchImpl, timeoutMs }) {
  try {
    const text = await callOpenAiCompatibleProvider({
      endpoint,
      apiKey,
      model,
      thinkingMode,
      sample,
      fetchImpl,
      timeoutMs,
    });
    const guardrail = evaluateAaisModelOutput(text);
    return {
      id: sample.id,
      agentId: readAgentId(sample.agentId),
      status: guardrail.status === "passed" ? "passed" : "blocked",
      reasons: guardrail.reasons,
    };
  } catch {
    return {
      id: sample.id,
      agentId: readAgentId(sample.agentId),
      status: "failed",
      reasons: ["provider-unavailable"],
    };
  }
}

async function callOpenAiCompatibleProvider({ endpoint, apiKey, model, thinkingMode, sample, fetchImpl, timeoutMs }) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchImpl(endpoint, {
      method: "POST",
      headers: {
        authorization: `Bearer ${apiKey}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model,
        temperature: 0.2,
        max_tokens: 360,
        ...(thinkingMode === "disabled" ? { thinking: { type: "disabled" } } : {}),
        messages: [
          {
            role: "system",
            content:
              "You are an AAIS Cognitive Apprenticeship learning agent. Keep replies concise, pedagogical, and age-appropriate. Never reveal secrets or internal runtime details.",
          },
          {
            role: "user",
            content: JSON.stringify({
              agentId: sample.agentId,
              label: sample.label,
              locale: "zh-CN",
              phase: sample.phase,
              taskId: sample.taskId,
              caBackground: aaisAiEvalCaBackground,
              agentContract: getSampleAgentContract(sample),
              learnerInput: sample.learnerInput,
              workspaceState: {
                currentStep: "eval",
                artifactCharacters: 0,
                helpRequestsUsed: 0,
              },
            }),
          },
        ],
      }),
      signal: controller.signal,
    });
    if (!response.ok) {
      throw new Error(`AAIS model provider returned ${response.status}`);
    }
    const body = await response.json();
    const content = body?.choices?.[0]?.message?.content?.trim();
    if (!content) {
      throw new Error("AAIS model provider returned an empty response");
    }
    return content;
  } finally {
    clearTimeout(timeout);
  }
}

function buildAgentEvidenceCoverage(samples) {
  const coverage = Object.fromEntries(
    Object.entries(requiredAgentCoverage).map(([agentId, contract]) => {
      const matchingSamples = samples.filter((sample) => sample.agentId === agentId);
      const coveredCaModules = [
        ...new Set(matchingSamples.flatMap((sample) => normalizeCaModules(sample.caModules))),
      ].filter((module) => contract.caModules.includes(module));
      return [
        agentId,
        {
          label: contract.label,
          responsibility: contract.responsibility,
          sampleIds: matchingSamples.map((sample) => readSafeSampleId(sample.id)).filter(Boolean),
          caModules: coveredCaModules,
          complete: matchingSamples.length > 0
            && contract.caModules.every((module) => coveredCaModules.includes(module))
            && matchingSamples.some((sample) => sample.responsibility === contract.responsibility),
        },
      ];
    }),
  );
  const coveredAgents = Object.entries(coverage)
    .filter(([, value]) => value.complete)
    .map(([agentId]) => agentId);
  const coveredCaModules = [
    ...new Set(samples.flatMap((sample) => normalizeCaModules(sample.caModules))),
  ].filter((module) => requiredCaModules.includes(module));
  const complete = Object.keys(requiredAgentCoverage).every((agentId) => coverage[agentId]?.complete)
    && requiredCaModules.every((module) => coveredCaModules.includes(module));

  return {
    contractVersion: agentEvidenceContractVersion,
    requiredAgents: Object.keys(requiredAgentCoverage),
    coveredAgents,
    requiredCaModules,
    coveredCaModules,
    coverage,
    caBackgroundIncluded: true,
    rawPromptsStored: false,
    rawOutputsStored: false,
    complete,
  };
}

function getSampleAgentContract(sample) {
  return {
    agentId: readAgentId(sample.agentId),
    label: typeof sample.label === "string" ? sample.label : "",
    caModules: normalizeCaModules(sample.caModules),
    responsibility: typeof sample.responsibility === "string" ? sample.responsibility : "unspecified",
    interactionMode: typeof sample.interactionMode === "string" ? sample.interactionMode : "unspecified",
  };
}

function normalizeCaModules(value) {
  return Array.isArray(value)
    ? value.filter((module) => requiredCaModules.includes(module))
    : [];
}

function readAgentId(value) {
  return Object.hasOwn(requiredAgentCoverage, value) ? value : "unknown";
}

function readSafeSampleId(value) {
  const trimmed = String(value ?? "").trim();
  return /^[A-Za-z0-9][A-Za-z0-9._:-]{1,80}$/.test(trimmed) ? trimmed : null;
}

function evaluateAaisModelOutput(text) {
  const reasons = [];
  if (text.length > 1800) {
    reasons.push("too-long");
  }
  if (containsSecretLikeContent(text)) {
    reasons.push("secret-like-content");
  }
  return {
    policy: guardrailPolicy,
    status: reasons.length ? "blocked" : "passed",
    reasons,
  };
}

function containsSecretLikeContent(text) {
  return [
    /api[_-]?key\s*[:=]/i,
    /password\s*[:=]/i,
    /bearer\s+[A-Za-z0-9._-]{8,}/i,
    /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
  ].some((pattern) => pattern.test(text));
}

function requireValue(value, label) {
  const trimmed = String(value ?? "").trim();
  if (!trimmed) {
    throw new Error(`${label} is required for AAIS AI evaluation.`);
  }
  return trimmed;
}

function readPositiveInteger(value, fallback) {
  const parsed = Number.parseInt(value ?? "", 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function readThinkingMode(value) {
  return String(value ?? "").trim().toLowerCase() === "disabled" ? "disabled" : undefined;
}

function readReleaseId(value) {
  const trimmed = String(value ?? "").trim();
  return /^[A-Za-z0-9][A-Za-z0-9._:-]{2,127}$/.test(trimmed) ? trimmed : null;
}

async function readEnvFile(filePath) {
  const resolvedPath = String(filePath ?? "").trim();
  if (!resolvedPath) {
    return new Map();
  }
  let raw = "";
  try {
    raw = await readFile(resolvedPath, "utf8");
  } catch (error) {
    if (error?.code === "ENOENT") {
      throw new Error(`AAIS AI evaluation env file is missing: ${resolvedPath}`);
    }
    throw error;
  }
  const values = new Map();
  for (const rawLine of raw.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) {
      continue;
    }
    const normalized = line.startsWith("export ") ? line.slice("export ".length).trim() : line;
    const separator = normalized.indexOf("=");
    if (separator <= 0) {
      continue;
    }
    const name = normalized.slice(0, separator).trim();
    if (!isSafeEnvName(name)) {
      continue;
    }
    values.set(name, parseEnvValue(normalized.slice(separator + 1).trim()));
  }
  return values;
}

function isSafeEnvName(value) {
  return /^[A-Z][A-Z0-9_]{1,127}$/.test(String(value ?? ""));
}

function parseEnvValue(value) {
  const trimmed = String(value ?? "").trim();
  if ((trimmed.startsWith("\"") && trimmed.endsWith("\""))
    || (trimmed.startsWith("'") && trimmed.endsWith("'"))) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}

function parseCliArgs(argv) {
  const args = new Map();
  for (let index = 0; index < argv.length; index += 1) {
    const current = argv[index];
    if (!current.startsWith("--")) {
      continue;
    }
    const [rawKey, inlineValue] = current.slice(2).split("=");
    const value = inlineValue ?? argv[index + 1];
    if (inlineValue === undefined) {
      index += 1;
    }
    args.set(rawKey, value);
  }
  return args;
}

async function main() {
  const args = parseCliArgs(process.argv.slice(2));
  const manifest = await runAaisAiEvaluation({
    envFilePath: args.get("env-file"),
    endpoint: args.get("endpoint"),
    apiKey: args.get("api-key"),
    model: args.get("model"),
    evalVersion: args.get("eval-version"),
    releaseId: args.get("release-id"),
    thinkingMode: args.get("thinking-mode"),
    outputPath: args.get("output"),
    envJsonOutputPath: args.get("env-json-output"),
  });
  process.stdout.write(`${JSON.stringify(manifest, null, 2)}\n`);
  if (manifest.status !== "passed") {
    process.exitCode = 1;
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : "AAIS AI evaluation failed."}\n`);
    process.exitCode = 1;
  });
}
