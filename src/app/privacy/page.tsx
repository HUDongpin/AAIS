import type { Metadata } from "next";
import { LegalNoticePage } from "@/components/pages/legal-notice-page";

export const metadata: Metadata = {
  title: "Privacy | CAAIS",
  description: "AAIS privacy and learning-data governance notice.",
};

export const dynamic = "force-dynamic";

export default function Page() {
  return (
    <LegalNoticePage
      eyebrow="Privacy and data governance"
      title="隐私与学习数据说明"
      summary="AAIS 只收集运行 Cognitive Apprenticeship 学习流程所需的数据，并以教师可行动、学习者可追踪、机构可审计为边界。"
      sections={[
        {
          title: "数据范围",
          items: [
            "AAIS 保存学习会话、任务状态、支架请求、反思状态、小张与教授的互动事件、后台监督与反思事件、AI 互动计数和必要的 cohort 聚合字段。",
            "原始 artifact、自我报告和提示词只用于学习会话本身；教师 cohort dashboard 和导出文件使用伪匿名 learner key。",
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
            "已登录学习者可通过 /api/learning/privacy 导出自己的 learner-data JSON；该文件包含个人会话、事件和原始学习文本，因此只返回给当前签名会话本人。",
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
      ]}
    />
  );
}
