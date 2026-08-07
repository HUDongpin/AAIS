import type { Locale } from "@/data/aais";

export const aaisLocaleCookieName = "aais_locale";
export const aaisLocaleStorageKey = "aais_login_locale";
export const aaisSkipLinkId = "aais-skip-link";
export const defaultAaisLocale: Locale = "zh-CN";

export function parseAaisLocale(value: string | null | undefined): Locale | null {
  return value === "zh-CN" || value === "en-US" ? value : null;
}

export function saveAaisLocalePreference(locale: Locale) {
  if (typeof window === "undefined") {
    return;
  }
  try {
    window.localStorage.setItem(aaisLocaleStorageKey, locale);
  } catch {
    // The cookie below still preserves the selected UI language across the
    // authenticated server transition when local storage is unavailable.
  }
  document.cookie = `${aaisLocaleCookieName}=${encodeURIComponent(locale)}; Max-Age=31536000; Path=/; SameSite=Lax`;
}

export function applyAaisLocaleToDocument(locale: Locale) {
  if (typeof document === "undefined") {
    return;
  }
  document.documentElement.lang = locale;
  const skipLink = document.getElementById(aaisSkipLinkId);
  if (skipLink) {
    skipLink.textContent = locale === "en-US" ? "Skip to main content" : "跳到主要内容";
  }
}
