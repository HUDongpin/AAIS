import {
  getGuideDailyBudgetExceededDetails,
} from "@/components/pages/learning/guide-stream";
import type { LearningCopy } from "@/components/pages/learning/learning-copy";
import type { Locale } from "@/data/aais";

export function getGuideDailyBudgetFailurePresentation(
  error: unknown,
  copy: LearningCopy,
  locale: Locale,
) {
  const budget = getGuideDailyBudgetExceededDetails(error);
  if (!budget) {
    return null;
  }
  return {
    errorKind: "daily_budget_exceeded",
    message: copy.guide.dailyBudgetExceeded(
      budget.limit,
      formatGuideBudgetResetTime(budget.resetsAt, locale),
    ),
  } as const;
}

function formatGuideBudgetResetTime(resetsAt: string | null, locale: Locale) {
  if (!resetsAt) {
    return null;
  }
  const resetDate = new Date(resetsAt);
  if (Number.isNaN(resetDate.getTime())) {
    return null;
  }
  return new Intl.DateTimeFormat(locale, {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(resetDate);
}
