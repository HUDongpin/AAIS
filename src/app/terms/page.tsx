import type { Metadata } from "next";
import { LegalNoticePage } from "@/components/pages/legal-notice-page";

export const metadata: Metadata = {
  title: "Terms | CAAIS",
  description: "AAIS use terms and responsible-use notice.",
};

export const dynamic = "force-dynamic";

export default function Page() {
  return (
    <LegalNoticePage
      eyebrow="Responsible use"
      title="使用条款"
      summary="AAIS 是面向 Cognitive Apprenticeship 的学习支持系统。使用者应把它作为学习过程、教师判断和机构治理的辅助，而不是替代责任主体。"
      sections={[
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
      ]}
    />
  );
}
