import { readFileSync } from "node:fs";

export type AaisAiEvalManifestStatus = "not-required" | "verified" | "missing" | "invalid" | "mismatch";

export type AaisAiEvalManifestResult = {
  status: AaisAiEvalManifestStatus;
  issue?: "AAIS_AI_EVAL_MANIFEST";
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
  const manifest = readConfiguredManifest();
  if (!manifest) {
    return {
      status: "missing",
      issue: "AAIS_AI_EVAL_MANIFEST",
    };
  }
  if (!isValidManifestShape(manifest)) {
    return {
      status: "invalid",
      issue: "AAIS_AI_EVAL_MANIFEST",
    };
  }
  if (
    manifest.evalVersion !== input.evalVersion
    || manifest.provider !== input.provider
    || manifest.model !== input.model
    || manifest.status !== "passed"
    || manifest.sampleCount <= 0
    || manifest.blockedCount !== 0
    || manifest.redaction.prompts !== "summarized"
    || manifest.redaction.secrets !== "omitted"
  ) {
    return {
      status: "mismatch",
      issue: "AAIS_AI_EVAL_MANIFEST",
    };
  }
  return {
    status: "verified",
  };
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
      && value.redaction?.secrets === "omitted",
  );
}
