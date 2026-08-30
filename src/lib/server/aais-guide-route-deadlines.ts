import {
  studentRuntimeMaxRetries,
  studentRuntimeMaxTimeoutMs,
} from "@/lib/ai/aais-ai-runtime-config";

const maxGuideLiveProviderCandidates = 2;
const guideRouteFinalizeGuardMs = 10_000;

export const guideProviderMaximumRetryBudgetMs = studentRuntimeMaxTimeoutMs
  * (studentRuntimeMaxRetries + 1)
  * maxGuideLiveProviderCandidates;
export const guideRouteMaximumDeadlineMs = 250_000;
export const guideRouteTotalDeadlineMs = Math.min(
  guideRouteMaximumDeadlineMs,
  guideProviderMaximumRetryBudgetMs + guideRouteFinalizeGuardMs,
);
