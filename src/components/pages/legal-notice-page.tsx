import Link from "next/link";
import type { Locale } from "@/data/aais";

type LegalNoticeSection = {
  title: string;
  items: readonly string[];
};

type LegalNoticePageProps = {
  backHref: string;
  backLabel: string;
  eyebrow: string;
  locale: Locale;
  title: string;
  summary: string;
  sections: readonly LegalNoticeSection[];
};

export function LegalNoticePage({
  backHref,
  backLabel,
  eyebrow,
  locale,
  title,
  summary,
  sections,
}: LegalNoticePageProps) {
  return (
    <main
      className="min-h-[100dvh] bg-[var(--background)] px-4 py-8 text-[var(--foreground)] sm:px-6 lg:px-8"
      lang={locale}
    >
      <div className="mx-auto grid w-full max-w-5xl gap-5">
        <nav className="flex flex-wrap items-center justify-between gap-3 text-sm font-bold">
          <Link
            href={backHref}
            className="rounded-lg border border-[#d8e6fb] bg-white px-3 py-2 text-[#1f6feb] outline-none transition hover:border-[#1f6feb] focus-visible:ring-2 focus-visible:ring-[#1f6feb]"
          >
            {backLabel}
          </Link>
          <span className="rounded-full border border-[#d8e6fb] bg-[#f8fbff] px-3 py-1 text-[#4f5873]">
            AAIS
          </span>
        </nav>

        <section className="rounded-2xl border border-[#dfe7f6] bg-white p-6 shadow-[0_18px_44px_rgba(46,58,91,0.08)] sm:p-8">
          <p className="text-sm font-bold text-[#1f6feb]">{eyebrow}</p>
          <h1 className="mt-2 text-3xl font-black tracking-normal text-[#171b35] sm:text-4xl">{title}</h1>
          <p className="mt-4 max-w-3xl text-base leading-7 text-[#59657a]">{summary}</p>
        </section>

        <section className="grid gap-4">
          {sections.map((section) => (
            <article
              key={section.title}
              className="rounded-2xl border border-[#dfe7f6] bg-white p-5 shadow-[0_12px_32px_rgba(46,58,91,0.06)]"
            >
              <h2 className="text-lg font-black text-[#171b35]">{section.title}</h2>
              <ul className="mt-3 grid gap-2 text-sm leading-6 text-[#4f5873]">
                {section.items.map((item) => (
                  <li key={item} className="rounded-lg border border-[#e8eef8] bg-[#fbfdff] px-3 py-2">
                    {item}
                  </li>
                ))}
              </ul>
            </article>
          ))}
        </section>
      </div>
    </main>
  );
}
