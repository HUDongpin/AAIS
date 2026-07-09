"use client";

import { useCallback, useRef, useState, type FormEvent } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import {
  CaretDown,
  Eye,
  EyeSlash,
  LockKey,
  Sparkle,
  UserCircle,
} from "@phosphor-icons/react";
import { getAaisApiErrorMessage } from "@/lib/client/aais-api-error";
import {
  LoginDesignDeck,
  LoginMobileDesignCarousel,
  loginCopy,
  loginDeckCards,
  loginSerifFontFamily,
} from "@/components/pages/login/login-design";

type LoginPageProps = {
  trialLoginEnabled?: boolean;
};

export function LoginPage({ trialLoginEnabled = true }: LoginPageProps) {
  const router = useRouter();
  const searchParams = useSearchParams();
  const inviteToken = searchParams.get("invite_token")?.trim() ?? "";
  const resetToken = searchParams.get("reset_token")?.trim() ?? "";
  const passwordToken = inviteToken || resetToken;
  const [account, setAccount] = useState("");
  const [password, setPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [consentAccepted, setConsentAccepted] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [resetMode, setResetMode] = useState(false);
  const [resetEmail, setResetEmail] = useState("");
  const [passwordTokenConsumed, setPasswordTokenConsumed] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const submittingRef = useRef(false);
  const passwordTokenMode = Boolean(passwordToken) && !passwordTokenConsumed;

  const handleSubmit = useCallback(
    async (event: FormEvent<HTMLFormElement>) => {
      event.preventDefault();
      if (submittingRef.current) {
        return;
      }
      setError("");
      setNotice("");

      if (!account.trim() || !password) {
        setError(loginCopy.emptyError);
        return;
      }
      if (!consentAccepted) {
        setError(loginCopy.consentRequiredError);
        return;
      }

      submittingRef.current = true;
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
            consentAccepted,
            from: new URLSearchParams(window.location.search).get("from"),
          }),
        });
        const result = (await response.json().catch(() => null)) as {
          error?: string | {
            code?: string;
            message?: string;
          };
          redirectTarget?: string;
          appSession?: {
            actor?: {
              id?: string;
              displayName?: string;
            };
          };
        } | null;

        if (!response.ok) {
          setError(response.status === 401
            ? loginCopy.invalidError
            : getAaisApiErrorMessage(result, loginCopy.serverError));
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
        submittingRef.current = false;
        setSubmitting(false);
      }
    },
    [account, consentAccepted, password, router],
  );

  const handleSetPassword = useCallback(
    async (event: FormEvent<HTMLFormElement>) => {
      event.preventDefault();
      if (submittingRef.current) {
        return;
      }
      setError("");
      setNotice("");

      if (newPassword.length < 10) {
        setError(loginCopy.passwordLengthError);
        return;
      }
      if (newPassword !== confirmPassword) {
        setError(loginCopy.passwordMismatchError);
        return;
      }

      submittingRef.current = true;
      setSubmitting(true);
      try {
        const response = await fetch("/api/auth/password", {
          method: "POST",
          credentials: "same-origin",
          headers: {
            "content-type": "application/json",
          },
          body: JSON.stringify({
            action: "set-password",
            token: passwordToken,
            password: newPassword,
          }),
        });
        const result = await response.json().catch(() => null);
        if (!response.ok) {
          setError(getAaisApiErrorMessage(result, loginCopy.serverError));
          return;
        }
        setNewPassword("");
        setConfirmPassword("");
        setPasswordTokenConsumed(true);
        setNotice(loginCopy.setPasswordSuccess);
        router.replace("/login");
      } catch {
        setError(loginCopy.serverError);
      } finally {
        submittingRef.current = false;
        setSubmitting(false);
      }
    },
    [confirmPassword, newPassword, passwordToken, router],
  );

  const handleResetRequest = useCallback(
    async (event: FormEvent<HTMLFormElement>) => {
      event.preventDefault();
      if (submittingRef.current) {
        return;
      }
      setError("");
      setNotice("");

      if (!resetEmail.trim()) {
        setError(loginCopy.emailError);
        return;
      }

      submittingRef.current = true;
      setSubmitting(true);
      try {
        const response = await fetch("/api/auth/password", {
          method: "POST",
          credentials: "same-origin",
          headers: {
            "content-type": "application/json",
          },
          body: JSON.stringify({
            action: "request-reset",
            email: resetEmail,
          }),
        });
        const result = await response.json().catch(() => null);
        if (!response.ok) {
          setError(getAaisApiErrorMessage(result, loginCopy.serverError));
          return;
        }
        setResetEmail("");
        setResetMode(false);
        setNotice(loginCopy.resetSuccess);
      } catch {
        setError(loginCopy.serverError);
      } finally {
        submittingRef.current = false;
        setSubmitting(false);
      }
    },
    [resetEmail],
  );

  return (
    <div
      className="min-h-[100dvh] overflow-hidden bg-[#fbfdff] text-[#151a32]"
      style={{ fontFamily: loginSerifFontFamily }}
      data-trial-login={trialLoginEnabled ? "enabled" : "disabled"}
    >
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
            <LoginDesignDeck cards={loginDeckCards} />
          </div>
        </section>

        <main
          className="relative flex min-h-[100dvh] items-center px-5 py-8 sm:px-8 lg:px-10 xl:px-16"
          aria-labelledby="aais-login-heading"
        >
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
                <span className="block text-lg font-semibold tracking-normal">{loginCopy.brandName}</span>
                <span className="block text-xs font-medium text-[#647089]">
                  {loginCopy.brandSubline}
                </span>
              </span>
            </div>

            <LoginMobileDesignCarousel cards={loginDeckCards} />

            <h1
              id="aais-login-heading"
              className="text-2xl font-black leading-[1.16] tracking-normal text-[#171b35] sm:text-3xl"
            >
              {loginCopy.welcome}
            </h1>

            <div className="mt-9 inline-flex border-b border-[#1f6feb] pb-2 text-base font-bold text-[#1f6feb]">
              {passwordTokenMode
                ? loginCopy.setPassword
                : resetMode
                  ? loginCopy.resetPassword
                  : loginCopy.accountLogin}
            </div>

            {notice ? (
              <p
                className="mt-5 rounded-lg border border-[#9bd8b2] bg-[#ecfff3] px-4 py-3 text-sm font-semibold text-[#166534]"
                role="status"
                aria-live="polite"
                aria-atomic="true"
              >
                {notice}
              </p>
            ) : null}

            {passwordTokenMode ? (
              <form onSubmit={handleSetPassword} className="mt-7 space-y-5" noValidate aria-busy={submitting}>
                <label className="block space-y-2" htmlFor="aais-new-password">
                  <span className="text-sm font-semibold text-[#2a314a]">
                    {loginCopy.newPasswordLabel}
                  </span>
                  <span className="relative block">
                    <LockKey
                      className="pointer-events-none absolute left-4 top-1/2 -translate-y-1/2 text-[#7d8aa3]"
                      size={21}
                      weight="regular"
                    />
                    <input
                      id="aais-new-password"
                      value={newPassword}
                      onChange={(event) => setNewPassword(event.target.value)}
                      className="h-14 w-full rounded-lg border border-[#c8d9f5] bg-white pl-12 pr-4 text-base font-medium text-[#18213a] outline-none transition placeholder:text-[#8794aa] focus:border-[#1f6feb] focus:ring-4 focus:ring-[#1f6feb]/15"
                      autoComplete="new-password"
                      placeholder={loginCopy.newPasswordPlaceholder}
                      type="password"
                    />
                  </span>
                </label>

                <label className="block space-y-2" htmlFor="aais-confirm-password">
                  <span className="text-sm font-semibold text-[#2a314a]">
                    {loginCopy.confirmPasswordLabel}
                  </span>
                  <span className="relative block">
                    <LockKey
                      className="pointer-events-none absolute left-4 top-1/2 -translate-y-1/2 text-[#7d8aa3]"
                      size={21}
                      weight="regular"
                    />
                    <input
                      id="aais-confirm-password"
                      value={confirmPassword}
                      onChange={(event) => setConfirmPassword(event.target.value)}
                      className="h-14 w-full rounded-lg border border-[#c8d9f5] bg-white pl-12 pr-4 text-base font-medium text-[#18213a] outline-none transition placeholder:text-[#8794aa] focus:border-[#1f6feb] focus:ring-4 focus:ring-[#1f6feb]/15"
                      autoComplete="new-password"
                      placeholder={loginCopy.confirmPasswordPlaceholder}
                      type="password"
                    />
                  </span>
                </label>

                {error ? (
                  <p
                    className="rounded-lg border border-[#f0b7c9] bg-[#fff1f5] px-4 py-3 text-sm font-semibold text-[#a12f56]"
                    role="alert"
                    aria-live="assertive"
                    aria-atomic="true"
                  >
                    {error}
                  </p>
                ) : null}

                <button
                  type="submit"
                  disabled={submitting}
                  className="inline-flex h-14 w-full items-center justify-center rounded-xl bg-[#1f6feb] px-6 text-base font-bold text-white shadow-[0_14px_34px_rgba(31,111,235,0.25)] outline-none transition hover:bg-[#1557c0] active:translate-y-px focus-visible:ring-4 focus-visible:ring-[#1f6feb]/25 disabled:cursor-not-allowed disabled:opacity-70"
                >
                  {submitting ? "保存中..." : loginCopy.setPasswordSubmit}
                </button>
              </form>
            ) : resetMode ? (
              <form onSubmit={handleResetRequest} className="mt-7 space-y-5" noValidate aria-busy={submitting}>
                <label className="block space-y-2" htmlFor="aais-reset-email">
                  <span className="text-sm font-semibold text-[#2a314a]">
                    {loginCopy.resetEmailLabel}
                  </span>
                  <span className="relative block">
                    <UserCircle
                      className="pointer-events-none absolute left-4 top-1/2 -translate-y-1/2 text-[#7d8aa3]"
                      size={21}
                      weight="duotone"
                    />
                    <input
                      id="aais-reset-email"
                      value={resetEmail}
                      onChange={(event) => setResetEmail(event.target.value)}
                      className="h-14 w-full rounded-lg border border-[#c8d9f5] bg-white pl-12 pr-4 text-base font-medium text-[#18213a] outline-none transition placeholder:text-[#8794aa] focus:border-[#1f6feb] focus:ring-4 focus:ring-[#1f6feb]/15"
                      autoComplete="email"
                      placeholder={loginCopy.resetEmailPlaceholder}
                      type="email"
                    />
                  </span>
                </label>

                {error ? (
                  <p
                    className="rounded-lg border border-[#f0b7c9] bg-[#fff1f5] px-4 py-3 text-sm font-semibold text-[#a12f56]"
                    role="alert"
                    aria-live="assertive"
                    aria-atomic="true"
                  >
                    {error}
                  </p>
                ) : null}

                <button
                  type="submit"
                  disabled={submitting}
                  className="inline-flex h-14 w-full items-center justify-center rounded-xl bg-[#1f6feb] px-6 text-base font-bold text-white shadow-[0_14px_34px_rgba(31,111,235,0.25)] outline-none transition hover:bg-[#1557c0] active:translate-y-px focus-visible:ring-4 focus-visible:ring-[#1f6feb]/25 disabled:cursor-not-allowed disabled:opacity-70"
                >
                  {submitting ? "发送中..." : loginCopy.resetSubmit}
                </button>

                <button
                  type="button"
                  onClick={() => {
                    setResetMode(false);
                    setError("");
                    setNotice("");
                  }}
                  className="inline-flex h-11 w-full items-center justify-center rounded-lg border border-[#c8d9f5] bg-white px-4 text-sm font-bold text-[#1f6feb] outline-none transition hover:bg-[#eef4ff] focus-visible:ring-2 focus-visible:ring-[#1f6feb]"
                >
                  {loginCopy.backToLogin}
                </button>
              </form>
            ) : (
              <form onSubmit={handleSubmit} className="mt-7 space-y-5" noValidate aria-busy={submitting}>
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

                <div className="rounded-lg border border-[#d6e4fb] bg-[#f7fbff] px-4 py-3">
                  <label htmlFor="aais-login-consent" className="flex items-start gap-3">
                    <input
                      id="aais-login-consent"
                      type="checkbox"
                      checked={consentAccepted}
                      required
                      onChange={(event) => setConsentAccepted(event.target.checked)}
                      className="mt-1 size-4 shrink-0 rounded border-[#aebfda] text-[#1f6feb] outline-none focus-visible:ring-2 focus-visible:ring-[#1f6feb]"
                    />
                    <span className="text-sm font-semibold leading-6 text-[#2a314a]">
                      {loginCopy.consentCheckboxLabel}
                    </span>
                  </label>
                  <p className="mt-2 pl-7 text-sm font-medium leading-6 text-[#5d6b84]">
                    <a href="/terms" className="font-semibold text-[#1557c0] underline-offset-4 hover:underline">
                      {loginCopy.terms}
                    </a>
                    <span> 和 </span>
                    <a href="/privacy" className="font-semibold text-[#1557c0] underline-offset-4 hover:underline">
                      {loginCopy.privacy}
                    </a>
                    <span> 将作为本次登录确认的依据。</span>
                  </p>
                </div>

                {error ? (
                  <p
                    className="rounded-lg border border-[#f0b7c9] bg-[#fff1f5] px-4 py-3 text-sm font-semibold text-[#a12f56]"
                    role="alert"
                    aria-live="assertive"
                    aria-atomic="true"
                  >
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

                <button
                  type="button"
                  onClick={() => {
                    setResetMode(true);
                    setError("");
                    setNotice("");
                  }}
                  className="inline-flex h-11 w-full items-center justify-center rounded-lg border border-[#c8d9f5] bg-white px-4 text-sm font-bold text-[#1f6feb] outline-none transition hover:bg-[#eef4ff] focus-visible:ring-2 focus-visible:ring-[#1f6feb]"
                >
                  {loginCopy.forgotPassword}
                </button>

                <p className="flex flex-wrap items-center gap-x-2 gap-y-1 text-sm text-[#69758d]">
                  <span>继续登录即使用当前账号进入受保护的学习空间。</span>
                  <a href="/terms" className="font-semibold text-[#1557c0] underline-offset-4 hover:underline">
                    {loginCopy.terms}
                  </a>
                  <span>和</span>
                  <a href="/privacy" className="font-semibold text-[#1557c0] underline-offset-4 hover:underline">
                    {loginCopy.privacy}
                  </a>
                </p>
              </form>
            )}
          </div>
        </main>
      </div>
    </div>
  );
}

function isSafeLocalRedirectTarget(value: string | undefined): value is string {
  return Boolean(value?.startsWith("/") && !value.startsWith("//"));
}
