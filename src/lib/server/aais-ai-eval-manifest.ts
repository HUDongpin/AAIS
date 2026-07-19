import { readFileSync } from "node:fs";
import qwen37MaxEvalManifest from "@/data/aais-ai-eval-qwen3.7-max.json";

export type AaisAiEvalManifestStatus = "not-required" | "verified" | "missing" | "invalid" | "mismatch";

export type AaisAiEvalManifestResult = {
  status: AaisAiEvalManifestStatus;
  issue?: "AAIS_AI_EVAL_MANIFEST";
  evalVersion?: string;
  source?: "configured" | "bundled";
};

type AaisAiEvalManifest = {
  schemaVersion: 1;
  evalVersion: string;
  provider: "openai-compatible";
  model: string;
  status: "passed" | "failed";
  passedAt: string;
  sampleCount: number;
  blockedCount: number;
  redaction: {
    prompts: "summarized";
    secrets: "omitted";
  };
  agentEvidence: {
    contractVersion: "aais-a1-a4-ca-eval-v2";
    requiredAgents: string[];
    coveredAgents: string[];
    requiredCaModules: string[];
    coveredCaModules: string[];
    coverage: Record<string, {
      label: string;
      responsibility: string;
      sampleIds: string[];
      caModules: string[];
      complete: boolean;
    }>;
    caBackgroundIncluded: boolean;
    rawPromptsStored: boolean;
    rawOutputsStored: boolean;
    complete: boolean;
  };
};

const requiredAgentIds = ["A1", "A2", "A3", "A4"];
const requiredCaModules = ["Modelling", "Coaching", "Scaffolding", "Fading", "Articulation", "Reflection"];
const bundledManifests = [qwen37MaxEvalManifest as AaisAiEvalManifest];
const requiredAgentContracts = {
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

export function verifyAaisAiEvalManifest(input: {
  required: boolean;
  evalVersion: string | null;
  provider: "deterministic" | "openai-compatible";
  model: string | null;
}): AaisAiEvalManifestResult {
  if (!input.required) {
    return {
      status: "not-required",
    };
  }
  const configuredManifest = readConfiguredManifest();
  if (isVerifiedManifest(configuredManifest, input, true)) {
    return verifiedManifestResult(configuredManifest, "configured");
  }
  const bundledManifest = bundledManifests.find((manifest) =>
    isVerifiedManifest(manifest, input, false));
  if (bundledManifest) {
    return verifiedManifestResult(bundledManifest, "bundled");
  }
  if (!configuredManifest) {
    return {
      status: "missing",
      issue: "AAIS_AI_EVAL_MANIFEST",
    };
  }
  if (!isValidManifestShape(configuredManifest)) {
    return {
      status: "invalid",
      issue: "AAIS_AI_EVAL_MANIFEST",
    };
  }
  return {
    status: "mismatch",
    issue: "AAIS_AI_EVAL_MANIFEST",
  };
}

function isVerifiedManifest(
  manifest: Partial<AaisAiEvalManifest> | null,
  input: Parameters<typeof verifyAaisAiEvalManifest>[0],
  requireRequestedVersion: boolean,
): manifest is AaisAiEvalManifest {
  return Boolean(
    isValidManifestShape(manifest)
      && (!requireRequestedVersion || manifest.evalVersion === input.evalVersion)
      && manifest.provider === input.provider
      && manifest.model === input.model
      && manifest.status === "passed"
      && manifest.sampleCount > 0
      && manifest.blockedCount === 0
      && manifest.redaction.prompts === "summarized"
      && manifest.redaction.secrets === "omitted"
      && isCompleteAgentEvidence(manifest.agentEvidence),
  );
}

function verifiedManifestResult(
  manifest: AaisAiEvalManifest,
  source: NonNullable<AaisAiEvalManifestResult["source"]>,
): AaisAiEvalManifestResult {
  return {
    status: "verified",
    evalVersion: manifest.evalVersion,
    source,
  };
}

function isCompleteAgentEvidence(value: AaisAiEvalManifest["agentEvidence"]) {
  return Boolean(
    value
      && value.contractVersion === "aais-a1-a4-ca-eval-v2"
      && value.complete === true
      && value.caBackgroundIncluded === true
      && value.rawPromptsStored === false
      && value.rawOutputsStored === false
      && Array.isArray(value.requiredAgents)
      && Array.isArray(value.coveredAgents)
      && Array.isArray(value.requiredCaModules)
      && Array.isArray(value.coveredCaModules)
      && requiredAgentIds.every((agentId) => value.requiredAgents.includes(agentId))
      && requiredAgentIds.every((agentId) => value.coveredAgents.includes(agentId))
      && requiredCaModules.every((module) => value.requiredCaModules.includes(module))
      && requiredCaModules.every((module) => value.coveredCaModules.includes(module))
      && hasCompleteAgentCoverage(value.coverage),
  );
}

function hasCompleteAgentCoverage(value: AaisAiEvalManifest["agentEvidence"]["coverage"]) {
  return Object.entries(requiredAgentContracts).every(([agentId, contract]) => {
    const coverage = value?.[agentId];
    return Boolean(
      coverage
        && coverage.label === contract.label
        && coverage.responsibility === contract.responsibility
        && Array.isArray(coverage.sampleIds)
        && coverage.sampleIds.some(isSafeSampleId)
        && Array.isArray(coverage.caModules)
        && arraysEqual(
          contract.caModules.filter((module) => coverage.caModules.includes(module)),
          contract.caModules,
        )
        && coverage.complete === true,
    );
  });
}

function arraysEqual(left: string[], right: string[]) {
  return left.length === right.length && left.every((item, index) => item === right[index]);
}

function isSafeSampleId(value: unknown) {
  return /^[A-Za-z0-9][A-Za-z0-9._:-]{1,80}$/.test(String(value ?? "").trim());
}

function readConfiguredManifest() {
  const inlineManifest = process.env.AAIS_AI_EVAL_MANIFEST_JSON?.trim();
  if (inlineManifest) {
    return readManifestJson(inlineManifest);
  }
  const manifestPath = process.env.AAIS_AI_EVAL_MANIFEST_PATH?.trim();
  return manifestPath ? readManifestPath(manifestPath) : null;
}

function readManifestJson(value: string) {
  try {
    return JSON.parse(value) as Partial<AaisAiEvalManifest>;
  } catch {
    return null;
  }
}

function readManifestPath(manifestPath: string) {
  try {
    return JSON.parse(readFileSync(manifestPath, "utf8")) as Partial<AaisAiEvalManifest>;
  } catch {
    return null;
  }
}

function isValidManifestShape(value: Partial<AaisAiEvalManifest> | null): value is AaisAiEvalManifest {
  return Boolean(
    value
      && value.schemaVersion === 1
      && typeof value.evalVersion === "string"
      && value.provider === "openai-compatible"
      && typeof value.model === "string"
      && (value.status === "passed" || value.status === "failed")
      && typeof value.passedAt === "string"
      && typeof value.sampleCount === "number"
      && typeof value.blockedCount === "number"
      && value.redaction?.prompts === "summarized"
      && value.redaction?.secrets === "omitted"
      && typeof value.agentEvidence === "object"
      && value.agentEvidence !== null
      && typeof value.agentEvidence.coverage === "object"
      && value.agentEvidence.coverage !== null,
  );
}
