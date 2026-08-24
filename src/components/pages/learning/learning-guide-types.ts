import type {
  GuideMessage,
  GuideQuickStart,
} from "@/components/pages/learning/learning-page-types";
import type { Locale } from "@/data/aais";

export type UseLearningGuideInput = {
  activeTaskId: string;
  activeTaskPhase?: "training" | "practice";
  artifactText: string;
  displayName: string;
  isGuideSubmissionBlocked?: () => boolean;
  waitForLearnerDataGeneration: () => number | Promise<number>;
  locale: Locale;
  persistedGuideMessages?: GuideMessage[];
  studentId: string;
};

export type GuideSubmissionOptions = {
  source?: "typed" | "quick_start";
  quickStartId?: GuideQuickStart["id"];
};
