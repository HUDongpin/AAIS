import type { Metadata } from "next";
import { cookies } from "next/headers";
import { LegalNoticePage } from "@/components/pages/legal-notice-page";
import {
  aaisLocaleCookieName,
  defaultAaisLocale,
  parseAaisLocale,
} from "@/lib/aais-locale";

export const metadata: Metadata = {
  title: "Terms | CAAIS",
  description: "AAIS use terms and responsible-use notice.",
};

export const dynamic = "force-dynamic";

type TermsPageProps = {
  searchParams?: Promise<{ lang?: string | string[] }>;
};

export default async function Page({ searchParams }: TermsPageProps) {
  const params = await searchParams;
  const requestedLocale = parseAaisLocale(
    typeof params?.lang === "string" ? params.lang : undefined,
  );
  const cookieStore = await cookies();
  const locale = requestedLocale
    ?? parseAaisLocale(cookieStore.get(aaisLocaleCookieName)?.value)
    ?? defaultAaisLocale;
  const copy = termsCopy[locale];
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

const termsCopy = {
  "zh-CN": {
    backLabel: "返回登录",
    eyebrow: "负责任使用",
    title: "使用条款",
    summary: "AAIS 是面向 Cognitive Apprenticeship 的学习支持系统。使用者应把它作为学习过程、教师判断和机构治理的辅助，而不是替代责任主体。",
    sections: [
        {
          title: "学习使用边界",
          items: [
            "小张和教授分别提供学习支架与专家示范，后台机制支持监督和反思；系统输出不应被视为最终成绩、纪律处分或高风险决策的唯一依据。",
            "学习者应提交自己的理解、计划、反思和产出，不应把 AI 回复直接当作自己的完整答案。",
            "教师 dashboard 用于发现需要跟进的学习信号，实际教学判断仍应结合课堂、作业和机构政策。",
          ],
        },
        {
          title: "账号与授权",
          items: [
            "生产环境应使用机构 SSO、OIDC role mapping 和签名 session 保护学习与 cohort 数据。",
            "教师和管理员账号只能访问其授权范围内的 cohort analytics 和导出文件。",
            "不得共享账号、cookie、CSRF token、OIDC callback evidence 或任何 provider/API/database secret。",
          ],
        },
        {
          title: "运维与证据",
          items: [
            "正式发布前应通过产品 CI、Playwright E2E、数据库迁移检查、部署 smoke check 和人工 release checklist。",
            "运维记录只应保存状态、变量名、哈希、布尔证明和 redacted 指标，不保存真实 secret 或 transient login material。",
            "外部 LMS、HRIS、BI 集成应使用受控导出和安全 join keys；AAIS 不应成为机构身份或人事数据的源系统。",
          ],
        },
      ],
  },
  "en-US": {
    backLabel: "Back to sign in",
    eyebrow: "Responsible use",
    title: "Terms of Use",
    summary: "AAIS is a learning-support system for Cognitive Apprenticeship. It supports the learning process, teacher judgment, and institutional governance; it does not replace the people and institutions responsible for those decisions.",
    sections: [
      {
        title: "Boundaries for learning use",
        items: [
          "Xiao Zhang provides learning scaffolds and Professor provides expert modelling, while backend mechanisms support supervision and reflection. System output must not be the sole basis for final grades, disciplinary action, or other high-risk decisions.",
          "Learners should submit their own understanding, plans, reflections, and work products. They must not present an AI response as their own complete answer.",
          "The teacher dashboard helps identify learning signals that may require follow-up. Teaching decisions must also consider classroom evidence, assignments, and institutional policy.",
        ],
      },
      {
        title: "Accounts and authorization",
        items: [
          "Production environments should protect learning and cohort data through institutional SSO, OIDC role mapping, and signed sessions.",
          "Teacher and administrator accounts may access only the cohort analytics and exports within their authorized scope.",
          "Users must not share accounts, cookies, CSRF tokens, OIDC callback evidence, or any provider, API, or database secret.",
        ],
      },
      {
        title: "Operations and evidence",
        items: [
          "Before production release, the service should pass product CI, Playwright end-to-end tests, database migration checks, deployment smoke checks, and the human release checklist.",
          "Operations records should contain only status, variable names, hashes, Boolean evidence, and redacted metrics; they must not contain real secrets or transient sign-in material.",
          "External LMS, HRIS, and BI integrations should use controlled exports and safe join keys. AAIS must not become the source system for institutional identity or human-resources data.",
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
