"use client";

import { useCallback, useState, type FormEvent, type ReactNode } from "react";
import Image from "next/image";
import { useRouter } from "next/navigation";
import {
  Brain,
  CaretDown,
  CheckCircle,
  Eye,
  EyeSlash,
  GraduationCap,
  LockKey,
  PaperPlaneTilt,
  Sparkle,
  Student,
  UserCircle,
} from "@phosphor-icons/react";

const loginCopy = {
  brandName: "AAIS",
  brandSubline: "Apprenticeship AI system",
  welcome: "欢迎来到 AAIS：专注 Cognitive Apprenticeship 的智能学习平台",
  accountLogin: "账号密码登录",
  ssoLogin: "使用机构 SSO 登录",
  accountLabel: "账号",
  accountPlaceholder: "学生账号",
  passwordLabel: "密码",
  passwordPlaceholder: "请输入密码",
  submit: "立即登录",
  consent: "我已阅读并同意",
  terms: "用户协议",
  privacy: "隐私政策",
  emptyError: "请输入账号和密码。",
  invalidError: "账号或密码不匹配，请使用已授权的 AAIS 账号登录。",
  serverError: "登录服务暂时不可用，请稍后再试。",
};

type LoginDeckCard = {
  id: "guided" | "reflective";
  title: string;
  accent: string;
  chips: [string, string, string];
  footer: string;
  assetSrc: string;
  assetAlt: string;
};

type LoginPageProps = {
  trialLoginEnabled?: boolean;
};

export function LoginPage({ trialLoginEnabled = true }: LoginPageProps) {
  const router = useRouter();
  const [account, setAccount] = useState("");
  const [password, setPassword] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [error, setError] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const oidcStartHref = getOidcStartHref();

  const cards: LoginDeckCard[] = [
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

  const handleSubmit = useCallback(
    async (event: FormEvent<HTMLFormElement>) => {
      event.preventDefault();
      setError("");

      if (!account.trim() || !password) {
        setError(loginCopy.emptyError);
        return;
      }

      setSubmitting(true);
      try {
        const response = await fetch("/api/auth/app-session", {
          method: "POST",
          credentials: "same-origin",
          headers: {
            "content-type": "application/json",
          },
          body: JSON.stringify({
            account,
            password,
            from: new URLSearchParams(window.location.search).get("from"),
          }),
        });
        const result = (await response.json().catch(() => null)) as {
          error?: string;
          redirectTarget?: string;
          appSession?: {
            actor?: {
              id?: string;
              displayName?: string;
            };
          };
        } | null;

        if (!response.ok) {
          setError(response.status === 401 ? loginCopy.invalidError : (result?.error ?? loginCopy.serverError));
          return;
        }

        if (result?.appSession?.actor?.id) {
          window.localStorage.setItem("aais_student_id", result.appSession.actor.id);
        }
        if (result?.appSession?.actor?.displayName) {
          window.localStorage.setItem("aais_display_name", result.appSession.actor.displayName);
        }
        router.replace(isSafeLocalRedirectTarget(result?.redirectTarget) ? result.redirectTarget : "/learning");
      } catch {
        setError(loginCopy.serverError);
      } finally {
        setSubmitting(false);
      }
    },
    [account, password, router],
  );

  return (
    <div className="min-h-[100dvh] overflow-hidden bg-[#fbfdff] text-[#151a32]">
      <div className="mx-auto grid min-h-[100dvh] w-full max-w-[1760px] grid-cols-1 lg:grid-cols-[1.18fr_0.82fr]">
        <section className="relative hidden min-h-[100dvh] items-center px-10 py-10 lg:flex">
          <div className="absolute left-10 top-8 flex items-center gap-3 xl:left-16">
            <span className="flex size-11 items-center justify-center rounded-2xl bg-[#1f6feb] text-white shadow-[0_14px_34px_rgba(31,111,235,0.24)]">
              <Sparkle size={23} weight="duotone" />
            </span>
            <span>
              <span className="block text-lg font-semibold tracking-normal">{loginCopy.brandName}</span>
              <span className="block text-xs font-medium text-[#647089]">
                {loginCopy.brandSubline}
              </span>
            </span>
          </div>

          <div className="relative mx-auto w-full max-w-[930px]">
            <LoginDesignDeck cards={cards} />
          </div>
        </section>

        <main className="relative flex min-h-[100dvh] items-center px-5 py-8 sm:px-8 lg:px-10 xl:px-16">
          <button
            type="button"
            className="absolute right-5 top-5 inline-flex h-10 items-center gap-1 rounded-full px-3 text-sm font-semibold text-[#202640] outline-none transition hover:bg-[#eef4ff] active:translate-y-px focus-visible:ring-2 focus-visible:ring-[#1f6feb] sm:right-8 sm:top-8"
            aria-label="语言"
          >
            中文
            <CaretDown size={14} weight="bold" />
          </button>

          <div className="mx-auto w-full max-w-[560px] pt-16 lg:pt-0">
            <div className="mb-10 flex items-center gap-3 lg:hidden">
              <span className="flex size-11 items-center justify-center rounded-2xl bg-[#1f6feb] text-white shadow-[0_14px_34px_rgba(31,111,235,0.24)]">
                <Sparkle size={23} weight="duotone" />
              </span>
              <span>
                <span className="block text-lg font-semibold tracking-normal">AAIS 学习端</span>
                <span className="block text-xs font-medium text-[#647089]">Learning studio</span>
              </span>
            </div>

            <LoginMobileDesignCarousel cards={cards} />

            <h1 className="text-4xl font-black leading-[1.16] tracking-normal text-[#171b35] sm:text-5xl">
              {loginCopy.welcome}
            </h1>

            {trialLoginEnabled ? (
              <div className="mt-9 inline-flex border-b border-[#1f6feb] pb-2 text-base font-bold text-[#1f6feb]">
                {loginCopy.accountLogin}
              </div>
            ) : null}

            <a
              href={oidcStartHref}
              className="mt-5 inline-flex h-12 w-full items-center justify-center rounded-xl border border-[#c8d9f5] bg-white px-5 text-base font-bold text-[#1f6feb] outline-none transition hover:border-[#1f6feb] hover:bg-[#eef4ff] focus-visible:ring-4 focus-visible:ring-[#1f6feb]/20"
            >
              {loginCopy.ssoLogin}
            </a>

            {trialLoginEnabled ? (
              <form onSubmit={handleSubmit} className="mt-7 space-y-5" noValidate>
                <label className="block space-y-2" htmlFor="aais-login-account">
                  <span className="text-sm font-semibold text-[#2a314a]">
                    {loginCopy.accountLabel}
                  </span>
                  <span className="relative block">
                    <UserCircle
                      className="pointer-events-none absolute left-4 top-1/2 -translate-y-1/2 text-[#7d8aa3]"
                      size={21}
                      weight="duotone"
                    />
                    <input
                      id="aais-login-account"
                      value={account}
                      onChange={(event) => setAccount(event.target.value)}
                      className="h-14 w-full rounded-lg border border-[#c8d9f5] bg-white pl-12 pr-4 text-base font-medium text-[#18213a] outline-none transition placeholder:text-[#8794aa] focus:border-[#1f6feb] focus:ring-4 focus:ring-[#1f6feb]/15"
                      autoComplete="username"
                      placeholder={loginCopy.accountPlaceholder}
                    />
                  </span>
                </label>

                <label className="block space-y-2" htmlFor="aais-login-password">
                  <span className="text-sm font-semibold text-[#2a314a]">
                    {loginCopy.passwordLabel}
                  </span>
                  <span className="relative block">
                    <LockKey
                      className="pointer-events-none absolute left-4 top-1/2 -translate-y-1/2 text-[#7d8aa3]"
                      size={21}
                      weight="regular"
                    />
                    <input
                      id="aais-login-password"
                      value={password}
                      onChange={(event) => setPassword(event.target.value)}
                      className="h-14 w-full rounded-lg border border-[#c8d9f5] bg-white pl-12 pr-12 text-base font-medium text-[#18213a] outline-none transition placeholder:text-[#8794aa] focus:border-[#1f6feb] focus:ring-4 focus:ring-[#1f6feb]/15"
                      autoComplete="current-password"
                      placeholder={loginCopy.passwordPlaceholder}
                      type={showPassword ? "text" : "password"}
                    />
                    <button
                      type="button"
                      onClick={() => setShowPassword((current) => !current)}
                      className="absolute right-3 top-1/2 inline-flex size-9 -translate-y-1/2 items-center justify-center rounded-full text-[#6a7892] outline-none transition hover:bg-[#eef4ff] hover:text-[#1f6feb] focus-visible:ring-2 focus-visible:ring-[#1f6feb]"
                      aria-label={showPassword ? "隐藏密码" : "显示密码"}
                    >
                      {showPassword ? (
                        <EyeSlash size={20} weight="duotone" />
                      ) : (
                        <Eye size={20} weight="duotone" />
                      )}
                    </button>
                  </span>
                </label>

                {error ? (
                  <p className="rounded-lg border border-[#f0b7c9] bg-[#fff1f5] px-4 py-3 text-sm font-semibold text-[#a12f56]">
                    {error}
                  </p>
                ) : null}

                <button
                  type="submit"
                  disabled={submitting}
                  className="inline-flex h-14 w-full items-center justify-center rounded-xl bg-[#1f6feb] px-6 text-base font-bold text-white shadow-[0_14px_34px_rgba(31,111,235,0.25)] outline-none transition hover:bg-[#1557c0] active:translate-y-px focus-visible:ring-4 focus-visible:ring-[#1f6feb]/25 disabled:cursor-not-allowed disabled:opacity-70"
                >
                  {submitting ? "登录中..." : loginCopy.submit}
                </button>

                <p className="flex flex-wrap items-center gap-x-2 gap-y-1 text-sm text-[#69758d]">
                  <CheckCircle size={17} weight="duotone" className="text-[#1f6feb]" />
                  <span>{loginCopy.consent}</span>
                  <a href="/terms" className="font-semibold text-[#1f6feb] underline-offset-4 hover:underline">
                    {loginCopy.terms}
                  </a>
                  <span>和</span>
                  <a href="/privacy" className="font-semibold text-[#1f6feb] underline-offset-4 hover:underline">
                    {loginCopy.privacy}
                  </a>
                </p>
              </form>
            ) : null}
          </div>
        </main>
      </div>
    </div>
  );
}

function isSafeLocalRedirectTarget(value: string | undefined): value is string {
  return Boolean(value?.startsWith("/") && !value.startsWith("//"));
}

function getOidcStartHref() {
  if (typeof window === "undefined") {
    return "/api/auth/oidc/start?from=%2Flearning";
  }
  const from = new URLSearchParams(window.location.search).get("from");
  const safeFrom = from && isSafeLocalRedirectTarget(from) ? from : "/learning";
  return `/api/auth/oidc/start?from=${encodeURIComponent(safeFrom)}`;
}

function LoginMobileDesignCarousel({ cards }: { cards: LoginDeckCard[] }) {
  return (
    <div className="-mx-5 mb-8 overflow-x-auto px-5 pb-3 lg:hidden" aria-label="AAIS login illustration cards">
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

function LoginDesignDeck({ cards }: { cards: LoginDeckCard[] }) {
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
