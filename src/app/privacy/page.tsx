import type { Metadata } from "next";
import { LegalNoticePage } from "@/components/pages/legal-notice-page";

export const metadata: Metadata = {
  title: "Privacy | AAIS",
  description: "AAIS privacy and learning-data governance notice.",
};

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
            "AAIS 保存学习会话、任务状态、支架请求、反思状态、A1-A4 事件、AI 互动计数和必要的 cohort 聚合字段。",
            "原始 artifact、自我报告和提示词只用于学习会话本身；教师 cohort dashboard 和导出文件使用伪匿名 learner key。",
            "LRS/xAPI 记录使用事件语言、伪匿名 actor、确定性 statement id 和最小必要 detail 字段。",
          ],
        },
        {
          title: "访问控制",
          items: [
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
            "AAIS 不把 provider secret、cookie、token、数据库 URL、原始提示词或原始 learner text 写入 release evidence。",
          ],
        },
      ]}
    />
  );
}
