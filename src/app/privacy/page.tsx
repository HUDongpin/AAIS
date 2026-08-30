import type { Metadata } from "next";
import { cookies } from "next/headers";
import { LegalNoticePage } from "@/components/pages/legal-notice-page";
import {
  aaisLocaleCookieName,
  defaultAaisLocale,
  parseAaisLocale,
} from "@/lib/aais-locale";

export const metadata: Metadata = {
  title: "Privacy | CAAIS",
  description: "AAIS privacy and learning-data governance notice.",
};

export const dynamic = "force-dynamic";

type PrivacyPageProps = {
  searchParams?: Promise<{ lang?: string | string[] }>;
};

export default async function Page({ searchParams }: PrivacyPageProps) {
  const params = await searchParams;
  const requestedLocale = parseAaisLocale(
    typeof params?.lang === "string" ? params.lang : undefined,
  );
  const cookieStore = await cookies();
  const locale = requestedLocale
    ?? parseAaisLocale(cookieStore.get(aaisLocaleCookieName)?.value)
    ?? defaultAaisLocale;
  const copy = privacyCopy[locale];
  return (
    <LegalNoticePage
      backHref={createLegalLoginHref(locale, requestedLocale !== null)}
      backLabel={copy.backLabel}
      eyebrow={copy.eyebrow}
      locale={locale}
      title={copy.title}
      summary={copy.summary}
      sections={copy.sections}
    />
  );
}

const privacyCopy = {
  "zh-CN": {
    backLabel: "返回登录",
    eyebrow: "隐私与数据治理",
    title: "隐私与学习数据说明",
    summary: "AAIS 只收集运行 Cognitive Apprenticeship 学习流程所需的数据，并以教师可行动、学习者可追踪、机构可审计为边界。",
    sections: [
        {
          title: "数据范围",
          items: [
            "AAIS 保存学习会话、任务状态、支架请求、反思状态、小张与教授的互动事件、后台监督与反思事件、AI 互动计数和必要的 cohort 聚合字段。",
            "原始 artifact、自我报告和提示词只用于学习会话本身；教师 cohort dashboard 和导出文件使用伪匿名 learner key。",
            "支持的附件在浏览器中读取；AAIS 不保存附件原始文件或抽取正文，只在导学成功后保存经清理的文件名、类型、大小和已读取状态。启用 live AI 时，受长度限制的抽取文本会发送给所选 AI provider。",
            "LRS/xAPI 记录使用事件语言、伪匿名 actor、确定性 statement id 和最小必要 detail 字段。",
          ],
        },
        {
          title: "访问控制",
          items: [
            "登录前需要明确确认用户协议、隐私政策，以及未成年学习者已取得家长或监护人同意；未确认时 AAIS 不会签发 session cookie。",
            "学习者只能访问自己的学习会话和个人 analytics。",
            "教师和管理员 cohort analytics 需要签名会话；企业部署应通过 OIDC SSO 和机构角色映射授权。",
            "Trial login 可在最终 SSO-only 模式下关闭，生产证据会要求 trial 表单和 trial API 不再签发 session cookie。",
          ],
        },
        {
          title: "导出与集成",
          items: [
            "Cohort CSV/JSON 导出只包含伪匿名 learner key、风险分层、行动原因、计数和安全 join keys。",
            "CSV 字段会进行 spreadsheet-safe escaping，避免公式形态的值在表格或 BI 工具中执行。",
            "AAIS 不把 provider secret、cookie、token、数据库 URL、原始提示词或原始 learner text 写入运维报告或 smoke check 输出。",
          ],
        },
        {
          title: "个人数据导出与删除",
          items: [
            "已登录学习者可通过 /api/learning/privacy 导出自己的 learner-data JSON；该文件包含个人会话、事件、原始学习文本和成功附件回执元数据，因此只返回给当前签名会话本人。",
            "学习者可向 /api/learning/privacy 发起带 CSRF token 的 DELETE 请求删除自己的学习会话、事件、任务状态和 LRS outbox 记录。",
            "删除学习数据不会自动删除登录账号；账号停用、邀请、密码重置和机构身份生命周期由管理员或机构 SSO 流程另行处理。",
          ],
        },
        {
          title: "真实 cohort 前置条件",
          items: [
            "正式学生 cohort 上线前，项目负责人需要确认学习者年龄段、地区、机构政策、保留期限、同意流程以及是否包含未成年人。",
            "若涉及 FERPA、COPPA、GDPR、PIPL 或本地教育数据规则，AAIS 应先取得机构或监护人/学习者同意路径，再发放真实账号。",
            "Vercel、Neon、LRS、邮件、监控和 AI provider 的 DPA、数据地区与日志保留条款需要在正式 cohort 前完成书面确认。",
          ],
        },
      ],
  },
  "en-US": {
    backLabel: "Back to sign in",
    eyebrow: "Privacy and data governance",
    title: "Privacy and learning-data notice",
    summary: "AAIS collects only the data needed to operate its Cognitive Apprenticeship learning flow, with boundaries that keep teacher action practical, learner activity traceable, and institutional use auditable.",
    sections: [
      {
        title: "Data we process",
        items: [
          "AAIS stores learning sessions, task state, scaffold requests, reflection state, interaction events involving Xiao Zhang and Professor, backend supervision and reflection events, AI interaction counts, and the minimum cohort aggregation fields required by the service.",
          "Raw artifacts, self-reports, and prompts are used within the learner's session. Teacher cohort dashboards and exports use pseudonymous learner keys.",
          "Supported attachments are read in the browser. AAIS does not retain the original file or extracted text; after successful guidance it stores only a sanitized filename, type, size, and read status. When live AI is enabled, length-limited extracted text is sent to the selected AI provider.",
          "LRS/xAPI records use the event language, a pseudonymous actor, a deterministic statement ID, and only the necessary detail fields.",
        ],
      },
      {
        title: "Access controls",
        items: [
          "Before sign-in, users must explicitly acknowledge the Terms of Use and Privacy Policy and confirm parent or guardian consent for a learner who is a minor. AAIS does not issue a session cookie without that acknowledgement.",
          "Learners can access only their own learning session and personal analytics.",
          "Teacher and administrator cohort analytics require a signed session. Enterprise deployments should authorize access through OIDC SSO and institutional role mapping.",
          "Trial sign-in can be disabled for a final SSO-only deployment. Production evidence must then confirm that neither the trial form nor the trial API issues a session cookie.",
        ],
      },
      {
        title: "Exports and integrations",
        items: [
          "Cohort CSV and JSON exports contain only pseudonymous learner keys, risk levels, action reasons, counts, and safe join keys.",
          "CSV fields use spreadsheet-safe escaping so formula-shaped values cannot execute in spreadsheet or BI tools.",
          "AAIS does not place provider secrets, cookies, tokens, database URLs, raw prompts, or raw learner text in operations reports or smoke-check output.",
        ],
      },
      {
        title: "Personal data export and deletion",
        items: [
          "A signed-in learner can export their learner-data JSON through /api/learning/privacy. Because the file includes the learner's session, events, raw learning text, and successful attachment-receipt metadata, it is returned only to that signed-in learner.",
          "A learner can send a DELETE request with a CSRF token to /api/learning/privacy to remove their learning session, events, task state, and LRS outbox records.",
          "Deleting learning data does not delete the sign-in account. Account suspension, invitations, password resets, and institutional identity lifecycle are managed separately by an administrator or institutional SSO process.",
        ],
      },
      {
        title: "Requirements before a real cohort",
        items: [
          "Before a real student cohort begins, the project owner must confirm learner age range, location, institutional policy, retention period, consent flow, and whether minors are included.",
          "Where FERPA, COPPA, GDPR, PIPL, or local education-data rules apply, AAIS must establish the appropriate institutional, parent or guardian, and learner consent path before issuing real accounts.",
          "DPAs, data locations, and log-retention terms for Vercel, Neon, the LRS, email, monitoring, and AI providers must be confirmed in writing before a real cohort begins.",
        ],
      },
    ],
  },
} as const;

function createLegalLoginHref(
  locale: "zh-CN" | "en-US",
  hasExplicitLocale: boolean,
) {
  if (locale === "en-US") {
    return "/login?lang=en-US";
  }
  return hasExplicitLocale ? "/login?lang=zh-CN" : "/login";
}
