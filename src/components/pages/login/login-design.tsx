import type { ReactNode } from "react";
import Image from "next/image";
import {
  Brain,
  GraduationCap,
  PaperPlaneTilt,
  Student,
} from "@phosphor-icons/react";

export const loginCopy = {
  brandName: "CAAIS",
  brandSubline: "Cognitive Apprenticeship AI System",
  welcome: "欢迎来到 CAAIS：专注 Cognitive Apprenticeship 的智能学习平台",
  accountLogin: "账号密码登录",
  accountLabel: "账号",
  accountPlaceholder: "学生账号",
  passwordLabel: "密码",
  passwordPlaceholder: "请输入密码",
  submit: "立即登录",
  forgotPassword: "忘记密码？",
  backToLogin: "返回登录",
  resetPassword: "重置密码",
  resetEmailLabel: "账号邮箱",
  resetEmailPlaceholder: "请输入账号邮箱",
  resetSubmit: "发送重置邮件",
  resetSuccess: "如果该账号存在，重置邮件将会发送到对应邮箱。",
  setPassword: "设置密码",
  newPasswordLabel: "新密码",
  newPasswordPlaceholder: "至少 10 个字符",
  confirmPasswordLabel: "确认密码",
  confirmPasswordPlaceholder: "再次输入密码",
  setPasswordSubmit: "保存密码",
  setPasswordSuccess: "密码已更新，请使用新密码登录。",
  consentCheckboxLabel: "我确认已阅读并同意用户协议和隐私政策，未成年学习者已取得家长或监护人同意。",
  terms: "用户协议",
  privacy: "隐私政策",
  consentRequiredError: "请先确认用户协议、隐私政策和必要的监护人同意。",
  emptyError: "请输入账号和密码。",
  emailError: "请输入账号邮箱。",
  passwordLengthError: "密码至少需要 10 个字符。",
  passwordMismatchError: "两次输入的密码不一致。",
  invalidError: "账号或密码不匹配，请使用已授权的 CAAIS 账号登录。",
  serverError: "登录服务暂时不可用，请稍后再试。",
  researchLogoutAckWarning: "账号已安全退出，但最终研究事件未获确认。请告知研究人员，且不要将本次实验标记为完成。",
};

export const loginSerifFontFamily =
  '"Anthropic Serif", Georgia, "Times New Roman", "Noto Serif SC", "Songti SC", serif';

export type LoginDeckCard = {
  id: "guided" | "reflective";
  title: string;
  accent: string;
  chips: [string, string, string];
  footer: string;
  assetSrc: string;
  assetAlt: string;
};

export const loginDeckCards: LoginDeckCard[] = [
  {
    id: "guided",
    title: "智能导学",
    accent: "训练阶段",
    chips: ["专家示范视频", "理解测评反馈", "任务说明分发"],
    footer: "从专家建模开始，逐步进入训练任务",
    assetSrc: "/login/uais-student-card-illustration.png",
    assetAlt: "两位学生使用平板电脑和笔记本电脑自主学习",
  },
  {
    id: "reflective",
    title: "实践反思",
    accent: "练习阶段",
    chips: ["行为监测推送", "专家轨迹对比", "元认知支架"],
    footer: "把学习过程、反思文本和最终产出保留下来",
    assetSrc: "/login/uais-teacher-card-illustration.png",
    assetAlt: "学习者在智能系统中整理任务和反馈",
  },
];

export function LoginMobileDesignCarousel({ cards }: { cards: LoginDeckCard[] }) {
  return (
    <div className="-mx-5 mb-8 overflow-x-auto px-5 pb-3 lg:hidden" aria-label="CAAIS login illustration cards">
      <div className="flex w-max snap-x gap-4">
        {cards.map((card) => (
          <div key={card.id} className="w-[376px] shrink-0 snap-center" style={{ aspectRatio: "376 / 520" }}>
            <LoginDesignCard card={card} />
          </div>
        ))}
      </div>
    </div>
  );
}

export function LoginDesignDeck({ cards }: { cards: LoginDeckCard[] }) {
  return (
    <div className="relative w-full max-w-[930px]" style={{ aspectRatio: "766 / 520" }}>
      <div className="grid h-full grid-cols-2 gap-[14px]">
        {cards.map((card) => (
          <LoginDesignCard key={card.id} card={card} />
        ))}
      </div>
    </div>
  );
}

function LoginDesignCard({ card }: { card: LoginDeckCard }) {
  const guided = card.id === "guided";
  const FooterIcon = guided ? GraduationCap : Brain;

  return (
    <article className="relative flex h-full flex-col overflow-hidden rounded-[14px] border border-[#d8e6fb] bg-gradient-to-b from-white via-[#fbfdff] to-[#f2f7ff] px-[18px] pb-[16px] pt-[18px] shadow-[0_14px_42px_rgba(42,82,148,0.12)] 2xl:px-[20px] 2xl:pb-[18px] 2xl:pt-[20px]">
      <div className="absolute inset-0 bg-[radial-gradient(circle_at_50%_42%,rgba(31,111,235,0.08),transparent_42%)]" />
      <div className="relative z-20 text-center">
        <h2 className="text-[20px] font-black leading-[1.05] text-[#65728c] 2xl:text-[24px]">
          {card.title}
          <span className="ml-1 text-[#1f6feb]">{card.accent}</span>
        </h2>
      </div>

      <div className="relative z-20 mt-6 grid min-h-0 flex-1 grid-rows-[minmax(0,1fr)_auto] gap-3 2xl:mt-7 2xl:gap-4">
        <div className="relative overflow-hidden rounded-[10px] border border-[#dfebfb] bg-[#f7fbff] shadow-[inset_0_1px_0_rgba(255,255,255,0.82)]">
          <Image
            src={card.assetSrc}
            alt={card.assetAlt}
            fill
            sizes="300px"
            priority
            unoptimized
            className="object-contain object-center"
          />
        </div>

        <div className="relative z-30 grid grid-cols-1 gap-2 2xl:gap-3">
          {card.chips.map((chip, index) => (
            <FeatureChip
              key={chip}
              icon={
                index === 0 ? (
                  <GraduationCap size={22} weight="duotone" />
                ) : index === 1 ? (
                  <Student size={22} weight="duotone" />
                ) : (
                  <PaperPlaneTilt size={22} weight="duotone" />
                )
              }
            >
              {chip}
            </FeatureChip>
          ))}
        </div>
      </div>

      <div className="relative z-30 mt-5 flex min-h-[58px] items-center justify-center gap-3 rounded-[8px] border border-[#d6e4fb] bg-[#edf5ff] px-4 py-3 text-center text-[13px] font-bold leading-[1.25] text-[#384967] shadow-[inset_0_1px_0_rgba(255,255,255,0.8)] 2xl:mt-6 2xl:min-h-[64px] 2xl:gap-4 2xl:text-[15px]">
        <FooterIcon size={28} weight="duotone" className="shrink-0 text-[#1f6feb]" aria-hidden="true" />
        <span className="min-w-0">{card.footer}</span>
      </div>
    </article>
  );
}

function FeatureChip({
  children,
  icon,
}: {
  children: string;
  icon: ReactNode;
}) {
  return (
    <div className="flex min-h-[54px] w-full items-center gap-3 rounded-[8px] border border-[#d9e7fb] bg-white/95 px-4 py-3 text-[13px] font-black leading-[1.18] text-[#26304b] shadow-[0_12px_26px_rgba(42,82,148,0.12)] backdrop-blur 2xl:min-h-[60px] 2xl:text-[15px]">
      <span className="grid size-7 shrink-0 place-items-center text-[#1f6feb] 2xl:size-8">
        {icon}
      </span>
      <span className="min-w-0 flex-1 leading-[1.18]">{children}</span>
    </div>
  );
}
