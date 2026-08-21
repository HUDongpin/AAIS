import { getGuideRequestErrorReceipt } from "@/components/pages/learning/guide-stream";
import type { GuideFailure } from "@/components/pages/learning/learning-page-types";
import { isAaisResearchDisconnectError } from "@/lib/client/aais-research-telemetry";

const guideOperationUuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function createGuideOperationId() {
  const cryptoApi = globalThis.crypto;
  if (!cryptoApi) {
    return null;
  }
  try {
    if (typeof cryptoApi.randomUUID === "function") {
      const candidate = cryptoApi.randomUUID();
      if (guideOperationUuidPattern.test(candidate)) {
        return candidate;
      }
    }
  } catch {
    // Fall through to getRandomValues so a partial Web Crypto implementation
    // never causes a non-UUID operation identifier to reach the API.
  }
  if (typeof cryptoApi.getRandomValues !== "function") {
    return null;
  }
  try {
    const bytes = cryptoApi.getRandomValues(new Uint8Array(16));
    bytes[6] = (bytes[6] & 0x0f) | 0x40;
    bytes[8] = (bytes[8] & 0x3f) | 0x80;
    const hex = Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0"));
    return [
      hex.slice(0, 4).join(""),
      hex.slice(4, 6).join(""),
      hex.slice(6, 8).join(""),
      hex.slice(8, 10).join(""),
      hex.slice(10, 16).join(""),
    ].join("-");
  } catch {
    return null;
  }
}

export function createGuideFailure(error: unknown, operationId: string): GuideFailure {
  const receipt = getGuideRequestErrorReceipt(error);
  const code = receipt?.code;
  const normalizedCode = code?.toUpperCase() ?? "";
  const learnerAction = receipt?.learnerAction;
  let kind: GuideFailure["kind"];
  if (isGuideConnectionError(error)) {
    kind = "connection";
  } else if (
    normalizedCode.includes("OUTPUT_BLOCKED")
    || normalizedCode.includes("GUARDRAIL")
    || normalizedCode.includes("CONTENT_POLICY")
    || learnerAction === "rephrase"
    || learnerAction === "rewrite"
  ) {
    kind = "guardrail";
  } else if (
    normalizedCode.includes("CONFIGURATION")
    || normalizedCode.includes("PROVIDER_REQUIRED")
    || normalizedCode.includes("MODEL_EVALUATION_REQUIRED")
    || normalizedCode.includes("OBSERVED_MODEL_MISMATCH")
    || normalizedCode.includes("LIVE_NOT_READY")
    || learnerAction === "contact-support"
  ) {
    kind = "configuration";
  } else if (
    normalizedCode.includes("CHAIN_EXHAUSTED")
    || normalizedCode.includes("PROVIDER")
    || normalizedCode === "AI_LIVE_UNAVAILABLE"
    || normalizedCode === "AI_LIVE_TIMEOUT"
    || error instanceof Error
  ) {
    kind = "provider_chain";
  } else {
    kind = "unknown";
  }
  const retryable = receipt?.retryable ?? (kind === "provider_chain" || kind === "connection");
  return {
    kind,
    code,
    diagnosticId: receipt?.diagnosticId ?? createLocalGuideSupportCode(operationId),
    retryable,
    learnerAction: learnerAction
      ?? (kind === "guardrail" ? "rephrase" : retryable ? "retry" : "contact-support"),
  };
}

export function isGuideConnectionError(error: unknown) {
  return isGuideBrowserOffline()
    || isAaisResearchDisconnectError(error)
    || (error instanceof Error && error.name === "AaisGuideBrowserOfflineError");
}

export function isGuideBrowserOffline() {
  return typeof navigator !== "undefined" && navigator.onLine === false;
}

function createLocalGuideSupportCode(operationId: string) {
  const opaqueSuffix = operationId.replace(/[^A-Za-z0-9]/g, "").slice(-10).toUpperCase();
  return `LOCAL-${opaqueSuffix || "UNAVAILABLE"}`;
}
