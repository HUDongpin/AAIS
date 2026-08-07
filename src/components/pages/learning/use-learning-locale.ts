import { useEffect } from "react";
import { applyAaisLocaleToDocument, defaultAaisLocale } from "@/lib/aais-locale";
import type { Locale } from "@/data/aais";

export function useLearningLocale(initialLocale: Locale = defaultAaisLocale) {
  useEffect(() => {
    applyAaisLocaleToDocument(initialLocale);
  }, [initialLocale]);

  // The login page writes the preference into a same-site cookie before the
  // server transition. Rendering from that request value avoids a Chinese
  // first paint followed by an English client-side correction.
  return initialLocale;
}
