"use client";

import { useCallback, useEffect, useRef, useState, type ChangeEvent, type FormEvent } from "react";
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
import { clearAaisResearchTelemetryForActor } from "@/lib/client/aais-research-telemetry";
import {
  loginCopyByLocale,
  loginSerifFontFamily,
  type LoginLocale,
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
  const requestedLocale = parseLoginLocale(searchParams.get("lang"));
  const [locale, setLocale] = useState<LoginLocale>(requestedLocale ?? "zh-CN");
  const copy = loginCopyByLocale[locale];
  const researchLogoutAcknowledgementFailed = searchParams.get("researchLogout") === "ack-failed";
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
  const accountInputRef = useRef<HTMLInputElement>(null);
  const resetEmailInputRef = useRef<HTMLInputElement>(null);
  const passwordTokenMode = Boolean(passwordToken) && !passwordTokenConsumed;
  const displayedError = error || (researchLogoutAcknowledgementFailed
    ? copy.researchLogoutAckWarning
    : "");

  useEffect(() => {
    if (requestedLocale) {
      return;
    }
    const savedLocale = parseLoginLocale(window.localStorage.getItem("aais_login_locale"));
    if (!savedLocale || savedLocale === locale) {
      return;
    }
    const frameId = window.requestAnimationFrame(() => setLocale(savedLocale));
    return () => window.cancelAnimationFrame(frameId);
  }, [locale, requestedLocale]);

  const handleLanguageChange = useCallback((event: ChangeEvent<HTMLSelectElement>) => {
    const nextLocale = parseLoginLocale(event.target.value) ?? "zh-CN";
    setLocale(nextLocale);
    setError("");
    setNotice("");
    window.localStorage.setItem("aais_login_locale", nextLocale);

    const url = new URL(window.location.href);
    if (nextLocale === "zh-CN") {
      url.searchParams.delete("lang");
    } else {
      url.searchParams.set("lang", nextLocale);
    }
    window.history.replaceState(window.history.state, "", `${url.pathname}${url.search}${url.hash}`);
  }, []);

  const showAccountLogin = useCallback(() => {
    setResetMode(false);
    setError("");
    setNotice("");
    window.requestAnimationFrame(() => accountInputRef.current?.focus());
  }, []);

  const showPasswordReset = useCallback(() => {
    setResetMode(true);
    setError("");
    setNotice("");
    window.requestAnimationFrame(() => resetEmailInputRef.current?.focus());
  }, []);

  const handleSubmit = useCallback(
    async (event: FormEvent<HTMLFormElement>) => {
      event.preventDefault();
      if (submittingRef.current) {
        return;
      }
      setError("");
      setNotice("");

      if (!account.trim() || !password) {
        setError(copy.emptyError);
        return;
      }
      if (!consentAccepted) {
        setError(copy.consentRequiredError);
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
            ? copy.invalidError
            : getAaisApiErrorMessage(result, copy.serverError));
          return;
        }

        // A successful login establishes a new actor boundary. Discard any
        // visit validation and unsent queue left by an expired/revoked prior
        // session before storing the newly authenticated actor locally.
        clearAaisResearchTelemetryForActor();
        if (result?.appSession?.actor?.id) {
          window.localStorage.setItem("aais_student_id", result.appSession.actor.id);
        }
        if (result?.appSession?.actor?.displayName) {
          window.localStorage.setItem("aais_display_name", result.appSession.actor.displayName);
        }
        router.replace(isSafeLocalRedirectTarget(result?.redirectTarget) ? result.redirectTarget : "/learning");
      } catch {
        setError(copy.serverError);
      } finally {
        submittingRef.current = false;
        setSubmitting(false);
      }
    },
    [account, consentAccepted, copy, password, router],
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
        setError(copy.passwordLengthError);
        return;
      }
      if (newPassword !== confirmPassword) {
        setError(copy.passwordMismatchError);
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
          setError(getAaisApiErrorMessage(result, copy.serverError));
          return;
        }
        setNewPassword("");
        setConfirmPassword("");
        setPasswordTokenConsumed(true);
        setNotice(copy.setPasswordSuccess);
        router.replace("/login");
      } catch {
        setError(copy.serverError);
      } finally {
        submittingRef.current = false;
        setSubmitting(false);
      }
    },
    [confirmPassword, copy, newPassword, passwordToken, router],
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
        setError(copy.emailError);
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
          setError(getAaisApiErrorMessage(result, copy.serverError));
          return;
        }
        setResetEmail("");
        setResetMode(false);
        setNotice(copy.resetSuccess);
      } catch {
        setError(copy.serverError);
      } finally {
        submittingRef.current = false;
        setSubmitting(false);
      }
    },
    [copy, resetEmail],
  );

  return (
    <div
      className="min-h-[100dvh] overflow-hidden bg-[#fbfdff] text-[#151a32]"
      style={{ fontFamily: loginSerifFontFamily }}
      data-trial-login={trialLoginEnabled ? "enabled" : "disabled"}
      data-locale={locale}
      lang={locale}
    >
      <div className="mx-auto grid min-h-[100dvh] w-full max-w-[1760px] grid-cols-1">
        <main
          className="relative mx-auto flex min-h-[100dvh] w-full max-w-[720px] items-center px-5 py-8 sm:px-8"
          aria-labelledby="aais-login-heading"
        >
          <label className="absolute right-5 top-5 inline-flex h-10 items-center rounded-full text-sm font-semibold text-[#202640] transition hover:bg-[#eef4ff] focus-within:ring-2 focus-within:ring-[#1f6feb] sm:right-8 sm:top-8">
            <span className="sr-only">{copy.languageLabel}</span>
            <select
              aria-label={copy.languageLabel}
              value={locale}
              onChange={handleLanguageChange}
              disabled={submitting}
              className="h-10 cursor-pointer appearance-none rounded-full bg-transparent py-0 pl-3 pr-8 font-semibold outline-none disabled:cursor-not-allowed disabled:opacity-60"
            >
              <option value="zh-CN">中文</option>
              <option value="en-US">English</option>
            </select>
            <CaretDown
              size={14}
              weight="bold"
              aria-hidden="true"
              className="pointer-events-none absolute right-3"
            />
          </label>

          <div className="mx-auto w-full max-w-[560px] pt-16 lg:pt-0">
            <div className="mb-10 flex items-center gap-3 lg:hidden">
              <span className="flex size-11 items-center justify-center rounded-2xl bg-[#1f6feb] text-white shadow-[0_14px_34px_rgba(31,111,235,0.24)]">
                <Sparkle size={23} weight="duotone" />
              </span>
              <span>
                <span className="block text-lg font-semibold tracking-normal">{copy.brandName}</span>
                <span className="block text-xs font-medium text-[#647089]">
                  {copy.brandSubline}
                </span>
              </span>
            </div>

            <h1
              id="aais-login-heading"
              className="text-2xl font-black leading-[1.16] tracking-normal text-[#171b35] sm:text-3xl"
            >
              {copy.welcome}
            </h1>

            {passwordTokenMode ? (
              <h2 className="mt-9 inline-flex border-b border-[#1f6feb] pb-2 text-base font-bold text-[#1f6feb]">
                {copy.setPassword}
              </h2>
            ) : (
              <div
                className="mt-9 flex items-end gap-5 border-b border-[#d6e4fb]"
                role="group"
                aria-label={copy.loginModeLabel}
              >
                <button
                  type="button"
                  aria-pressed={!resetMode}
                  aria-controls="aais-account-login-form"
                  onClick={showAccountLogin}
                  className={`border-b-2 pb-2 text-base font-bold outline-none transition focus-visible:ring-2 focus-visible:ring-[#1f6feb] ${
                    resetMode
                      ? "border-transparent text-[#69758d] hover:text-[#1f6feb]"
                      : "border-[#1f6feb] text-[#1f6feb]"
                  }`}
                >
                  {copy.accountLogin}
                </button>
                <button
                  type="button"
                  aria-pressed={resetMode}
                  aria-controls="aais-password-reset-form"
                  onClick={showPasswordReset}
                  className={`border-b-2 pb-2 text-sm font-bold outline-none transition focus-visible:ring-2 focus-visible:ring-[#1f6feb] ${
                    resetMode
                      ? "border-[#1f6feb] text-[#1f6feb]"
                      : "border-transparent text-[#69758d] hover:text-[#1f6feb]"
                  }`}
                >
                  {copy.forgotPassword}
                </button>
              </div>
            )}

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
                    {copy.newPasswordLabel}
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
                      placeholder={copy.newPasswordPlaceholder}
                      type="password"
                    />
                  </span>
                </label>

                <label className="block space-y-2" htmlFor="aais-confirm-password">
                  <span className="text-sm font-semibold text-[#2a314a]">
                    {copy.confirmPasswordLabel}
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
                      placeholder={copy.confirmPasswordPlaceholder}
                      type="password"
                    />
                  </span>
                </label>

                {displayedError ? (
                  <p
                    className="rounded-lg border border-[#f0b7c9] bg-[#fff1f5] px-4 py-3 text-sm font-semibold text-[#a12f56]"
                    role="alert"
                    aria-live="assertive"
                    aria-atomic="true"
                  >
                    {displayedError}
                  </p>
                ) : null}

                <button
                  type="submit"
                  disabled={submitting}
                  className="inline-flex h-14 w-full items-center justify-center rounded-xl bg-[#1f6feb] px-6 text-base font-bold text-white shadow-[0_14px_34px_rgba(31,111,235,0.25)] outline-none transition hover:bg-[#1557c0] active:translate-y-px focus-visible:ring-4 focus-visible:ring-[#1f6feb]/25 disabled:cursor-not-allowed disabled:opacity-70"
                >
                  {submitting ? copy.saving : copy.setPasswordSubmit}
                </button>
              </form>
            ) : resetMode ? (
              <form
                id="aais-password-reset-form"
                onSubmit={handleResetRequest}
                className="mt-7 space-y-5"
                noValidate
                aria-busy={submitting}
              >
                <label className="block space-y-2" htmlFor="aais-reset-email">
                  <span className="text-sm font-semibold text-[#2a314a]">
                    {copy.resetEmailLabel}
                  </span>
                  <span className="relative block">
                    <UserCircle
                      className="pointer-events-none absolute left-4 top-1/2 -translate-y-1/2 text-[#7d8aa3]"
                      size={21}
                      weight="duotone"
                    />
                    <input
                      id="aais-reset-email"
                      ref={resetEmailInputRef}
                      value={resetEmail}
                      onChange={(event) => setResetEmail(event.target.value)}
                      className="h-14 w-full rounded-lg border border-[#c8d9f5] bg-white pl-12 pr-4 text-base font-medium text-[#18213a] outline-none transition placeholder:text-[#8794aa] focus:border-[#1f6feb] focus:ring-4 focus:ring-[#1f6feb]/15"
                      autoComplete="email"
                      placeholder={copy.resetEmailPlaceholder}
                      type="email"
                    />
                  </span>
                </label>

                {displayedError ? (
                  <p
                    className="rounded-lg border border-[#f0b7c9] bg-[#fff1f5] px-4 py-3 text-sm font-semibold text-[#a12f56]"
                    role="alert"
                    aria-live="assertive"
                    aria-atomic="true"
                  >
                    {displayedError}
                  </p>
                ) : null}

                <button
                  type="submit"
                  disabled={submitting}
                  className="inline-flex h-14 w-full items-center justify-center rounded-xl bg-[#1f6feb] px-6 text-base font-bold text-white shadow-[0_14px_34px_rgba(31,111,235,0.25)] outline-none transition hover:bg-[#1557c0] active:translate-y-px focus-visible:ring-4 focus-visible:ring-[#1f6feb]/25 disabled:cursor-not-allowed disabled:opacity-70"
                >
                  {submitting ? copy.sending : copy.resetSubmit}
                </button>

                <button
                  type="button"
                  onClick={showAccountLogin}
                  className="inline-flex h-11 w-full items-center justify-center rounded-lg border border-[#c8d9f5] bg-white px-4 text-sm font-bold text-[#1f6feb] outline-none transition hover:bg-[#eef4ff] focus-visible:ring-2 focus-visible:ring-[#1f6feb]"
                >
                  {copy.backToLogin}
                </button>
              </form>
            ) : (
              <form
                id="aais-account-login-form"
                onSubmit={handleSubmit}
                className="mt-7 space-y-5"
                noValidate
                aria-busy={submitting}
              >
                <label className="block space-y-2" htmlFor="aais-login-account">
                  <span className="text-sm font-semibold text-[#2a314a]">
                    {copy.accountLabel}
                  </span>
                  <span className="relative block">
                    <UserCircle
                      className="pointer-events-none absolute left-4 top-1/2 -translate-y-1/2 text-[#7d8aa3]"
                      size={21}
                      weight="duotone"
                    />
                    <input
                      id="aais-login-account"
                      ref={accountInputRef}
                      value={account}
                      onChange={(event) => setAccount(event.target.value)}
                      className="h-14 w-full rounded-lg border border-[#c8d9f5] bg-white pl-12 pr-4 text-base font-medium text-[#18213a] outline-none transition placeholder:text-[#8794aa] focus:border-[#1f6feb] focus:ring-4 focus:ring-[#1f6feb]/15"
                      autoComplete="username"
                      placeholder={copy.accountPlaceholder}
                    />
                  </span>
                </label>

                <label className="block space-y-2" htmlFor="aais-login-password">
                  <span className="text-sm font-semibold text-[#2a314a]">
                    {copy.passwordLabel}
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
                      placeholder={copy.passwordPlaceholder}
                      type={showPassword ? "text" : "password"}
                    />
                    <button
                      type="button"
                      onClick={() => setShowPassword((current) => !current)}
                      className="absolute right-3 top-1/2 inline-flex size-9 -translate-y-1/2 items-center justify-center rounded-full text-[#6a7892] outline-none transition hover:bg-[#eef4ff] hover:text-[#1f6feb] focus-visible:ring-2 focus-visible:ring-[#1f6feb]"
                      aria-label={showPassword ? copy.hidePassword : copy.showPassword}
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
                      {copy.consentCheckboxLabel}
                    </span>
                  </label>
                  <p className="mt-2 pl-7 text-sm font-medium leading-6 text-[#5d6b84]">
                    <span>{copy.consentBasisPrefix}</span>
                    <a href="/terms" className="font-semibold text-[#1557c0] underline-offset-4 hover:underline">
                      {copy.terms}
                    </a>
                    <span>{copy.consentBasisConnector}</span>
                    <a href="/privacy" className="font-semibold text-[#1557c0] underline-offset-4 hover:underline">
                      {copy.privacy}
                    </a>
                    <span>{copy.consentBasisSuffix}</span>
                  </p>
                </div>

                {displayedError ? (
                  <p
                    className="rounded-lg border border-[#f0b7c9] bg-[#fff1f5] px-4 py-3 text-sm font-semibold text-[#a12f56]"
                    role="alert"
                    aria-live="assertive"
                    aria-atomic="true"
                  >
                    {displayedError}
                  </p>
                ) : null}

                <button
                  type="submit"
                  disabled={submitting}
                  className="inline-flex h-14 w-full items-center justify-center rounded-xl bg-[#1f6feb] px-6 text-base font-bold text-white shadow-[0_14px_34px_rgba(31,111,235,0.25)] outline-none transition hover:bg-[#1557c0] active:translate-y-px focus-visible:ring-4 focus-visible:ring-[#1f6feb]/25 disabled:cursor-not-allowed disabled:opacity-70"
                >
                  {submitting ? copy.signingIn : copy.submit}
                </button>

                <p className="flex flex-wrap items-center gap-x-2 gap-y-1 text-sm text-[#69758d]">
                  <span>{copy.protectedSpaceNotice}</span>
                  <a href="/terms" className="font-semibold text-[#1557c0] underline-offset-4 hover:underline">
                    {copy.terms}
                  </a>
                  <span>{copy.consentBasisConnector.trim()}</span>
                  <a href="/privacy" className="font-semibold text-[#1557c0] underline-offset-4 hover:underline">
                    {copy.privacy}
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

function parseLoginLocale(value: string | null): LoginLocale | null {
  if (value === "zh-CN" || value === "en-US") {
    return value;
  }
  return null;
}
