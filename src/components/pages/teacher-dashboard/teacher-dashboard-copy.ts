import type { AaisLearnerRecommendation } from "@/components/pages/teacher-dashboard/teacher-dashboard-support";
import type { Locale } from "@/data/aais";

const zhCnTeacherDashboardCopy = {
  hero: {
    eyebrow: "Cohort learning analytics",
    heading: "教师看板",
    description: "聚合训练完成、支架依赖、后台监督与教授 coaching 信号、AI 互动和反思证据，帮助教师快速定位需要跟进的学习者。",
  },
  loading: "正在加载 cohort analytics...",
  analyticsForbidden: "教师或管理员登录后可查看 cohort dashboard。",
  analyticsFailed: "AAIS cohort analytics request failed.",
  recommendationsForbidden: "当前账户无权读取推荐跟进。",
  recommendationsUnavailable: "推荐跟进暂时不可用，请稍后刷新重试。",
  recommendationsInvalid: "推荐跟进响应无效，请稍后刷新重试。",
  recommendationsNetwork: "推荐跟进暂时不可用，请检查网络后刷新重试。",
  filters: {
    phase: "Phase",
    agent: "Agent",
    event: "Event",
    all: "全部",
    platform: "Platform",
    guide: "小张",
    professor: "教授",
    professorCoaching: "教授 coaching",
  },
  controls: {
    refresh: "刷新",
    refreshing: "刷新中",
    csvBusy: "CSV 生成中",
    jsonBusy: "JSON 生成中",
    previous: "上一页",
    next: "下一页",
  },
  export: {
    csvStarting: "CSV 正在生成...",
    jsonStarting: "JSON 正在生成...",
    csvDone: "CSV 已生成",
    jsonDone: "JSON 已生成",
    failed: "Cohort export failed.",
  },
  metrics: {
    learners: "学习者",
    trainingCompleted: "完成训练",
    practiceCompleted: "练习完成数",
    scaffoldRequests: "支架请求",
    coachingSignals: "监督/教授信号",
    aiInteractions: "AI 互动",
    aiAcceptance: "AI 采纳",
  },
  queue: {
    heading: "学习者风险队列",
    description: "优先显示训练未完成、反思证据不足或监督/教授信号较多的学习者。",
    learner: "Learner",
    training: "Training",
    practice: "Practice",
    scaffold: "Scaffold",
    professor: "教授",
    ai: "AI",
    reflection: "Reflection",
    action: "Action",
    completed: "完成",
    incomplete: "未完成",
    notStarted: "未开始",
    requestsSuffix: "次",
    acceptedPrefix: "采纳",
    empty: "暂无 cohort 学习记录。",
  },
  recommendations: {
    heading: "推荐跟进",
    itemSuffix: "条",
    pausedBadge: "已暂停",
    unavailableBadge: "不可用",
    loadingBadge: "加载中",
    loading: "正在加载规则推荐...",
    unavailableLabel: "推荐跟进不可用",
    paused: "规则推荐已暂停。",
    empty: "暂无需要立即跟进的规则建议。",
    recording: "记录中...",
    markHandled: "标记已处理",
    recordingStatus: "正在记录推荐处理...",
    recordedStatus: "推荐处理已记录",
    overrideFailed: "AAIS recommendation override failed.",
  },
  risk: {
    heading: "风险分层",
    high: "高风险",
    medium: "中风险",
    low: "低风险",
  },
  dataBoundary: {
    heading: "数据边界",
    actorMode: "Actor mode",
    rawPromptStorage: "Raw prompt storage",
    minimumNecessaryFields: "Minimum necessary fields",
    joinKeys: "Join keys",
  },
} as const;

type WidenStrings<T> = {
  [Key in keyof T]: T[Key] extends string ? string : WidenStrings<T[Key]>;
};

export type TeacherDashboardCopy = WidenStrings<typeof zhCnTeacherDashboardCopy>;

const enUsTeacherDashboardCopy: TeacherDashboardCopy = {
  hero: {
    eyebrow: "Cohort learning analytics",
    heading: "Teacher dashboard",
    description: "Review training completion, scaffold reliance, supervision and Professor coaching signals, AI interactions, and reflection evidence to identify learners who need follow-up.",
  },
  loading: "Loading cohort analytics...",
  analyticsForbidden: "Sign in as a teacher or administrator to view the cohort dashboard.",
  analyticsFailed: "The cohort analytics could not be loaded.",
  recommendationsForbidden: "This account cannot view follow-up recommendations.",
  recommendationsUnavailable: "Follow-up recommendations are temporarily unavailable. Refresh and try again.",
  recommendationsInvalid: "The follow-up recommendation response was invalid. Refresh and try again.",
  recommendationsNetwork: "Follow-up recommendations are temporarily unavailable. Check your connection and try again.",
  filters: {
    phase: "Phase",
    agent: "Agent",
    event: "Event",
    all: "All",
    platform: "Platform",
    guide: "Guide Zhang",
    professor: "Professor",
    professorCoaching: "Professor coaching",
  },
  controls: {
    refresh: "Refresh",
    refreshing: "Refreshing",
    csvBusy: "Generating CSV",
    jsonBusy: "Generating JSON",
    previous: "Previous",
    next: "Next",
  },
  export: {
    csvStarting: "Generating CSV...",
    jsonStarting: "Generating JSON...",
    csvDone: "CSV generated",
    jsonDone: "JSON generated",
    failed: "The cohort export could not be generated.",
  },
  metrics: {
    learners: "Learners",
    trainingCompleted: "Training completed",
    practiceCompleted: "Practice tasks completed",
    scaffoldRequests: "Scaffold requests",
    coachingSignals: "Supervision / Professor signals",
    aiInteractions: "AI interactions",
    aiAcceptance: "AI acceptances",
  },
  queue: {
    heading: "Learner risk queue",
    description: "Learners with incomplete training, missing reflection evidence, or more supervision and Professor signals appear first.",
    learner: "Learner",
    training: "Training",
    practice: "Practice",
    scaffold: "Scaffold",
    professor: "Professor",
    ai: "AI",
    reflection: "Reflection",
    action: "Action",
    completed: "Completed",
    incomplete: "Incomplete",
    notStarted: "Not started",
    requestsSuffix: "requests",
    acceptedPrefix: "Accepted",
    empty: "No cohort learning records match these filters.",
  },
  recommendations: {
    heading: "Recommended follow-up",
    itemSuffix: "items",
    pausedBadge: "Paused",
    unavailableBadge: "Unavailable",
    loadingBadge: "Loading",
    loading: "Loading rule-based recommendations...",
    unavailableLabel: "Follow-up recommendations unavailable",
    paused: "Rule-based recommendations are paused.",
    empty: "No rule-based recommendations need immediate follow-up.",
    recording: "Recording...",
    markHandled: "Mark as handled",
    recordingStatus: "Recording the recommendation decision...",
    recordedStatus: "Recommendation decision recorded",
    overrideFailed: "The recommendation decision could not be recorded.",
  },
  risk: {
    heading: "Risk bands",
    high: "High risk",
    medium: "Medium risk",
    low: "Low risk",
  },
  dataBoundary: {
    heading: "Data boundary",
    actorMode: "Actor mode",
    rawPromptStorage: "Raw prompt storage",
    minimumNecessaryFields: "Minimum necessary fields",
    joinKeys: "Join keys",
  },
};

const teacherDashboardCopyByLocale: Record<Locale, TeacherDashboardCopy> = {
  "zh-CN": zhCnTeacherDashboardCopy,
  "en-US": enUsTeacherDashboardCopy,
};

const englishRecommendationByRuleId: Record<string, { reason: string; title: string }> = {
  complete_training: {
    title: "Complete the training task",
    reason: "The training task is incomplete. Complete the foundational workflow before the expert demonstration.",
  },
  complete_reflection: {
    title: "Complete reflection evidence",
    reason: "Self-report or expert-path comparison evidence is missing. Ask the learner to explain their process.",
  },
  respond_to_coaching: {
    title: "Follow up on Professor coaching",
    reason: "Supervision and Professor coaching signals are present, but no subsequent AI interaction or acceptance decision is recorded.",
  },
  fade_scaffold: {
    title: "Reduce scaffold reliance",
    reason: "Scaffold requests reached the self-check threshold. Fade direct support and ask the learner to justify their decisions.",
  },
  advance_practice: {
    title: "Advance to the next practice task",
    reason: "Training and reflection evidence are stable. Continue to the next practice task with light monitoring.",
  },
};

export function getTeacherDashboardCopy(locale: Locale) {
  return teacherDashboardCopyByLocale[locale];
}

export function getTeacherRecommendationPresentation(
  recommendation: AaisLearnerRecommendation,
  locale: Locale,
) {
  if (locale === "zh-CN") {
    return {
      title: recommendation.title,
      reason: recommendation.reasons[0] ?? "需跟进学习进展。",
    };
  }
  return englishRecommendationByRuleId[recommendation.ruleId] ?? {
    title: "Learner follow-up",
    reason: "Review this learner's progress and decide on the next support step.",
  };
}
