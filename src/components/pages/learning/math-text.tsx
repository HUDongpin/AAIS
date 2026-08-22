import katex from "katex";

export function MathText({
  displayMode = false,
  tex,
}: {
  displayMode?: boolean;
  tex: string;
}) {
  let html: string | null = null;
  try {
    html = katex.renderToString(tex, {
      displayMode,
      // KaTeX's HTML output relies on element-level style attributes for its
      // layout. AAIS deliberately blocks style attributes in its CSP, so use
      // semantic MathML that current browsers lay out natively.
      output: "mathml",
      // KaTeX is allowed to render mathematics only. It must never turn
      // untrusted guide output into executable or arbitrary HTML.
      trust: false,
      // Throw and retain the source below for malformed input rather than
      // using KaTeX's error-HTML fallback.
      throwOnError: true,
    });
  } catch {
    // Keep the original source visible when the expression is malformed.
  }

  if (html === null) {
    return (
      <span data-katex="invalid" data-testid="math-invalid">
        {displayMode ? `$$${tex}$$` : `$${tex}$`}
      </span>
    );
  }

  return (
    <span
      className={displayMode ? "my-2 block overflow-x-auto py-1 text-center" : "inline-block"}
      data-katex={displayMode ? "display" : "inline"}
      data-testid={displayMode ? "math-display" : "math-inline"}
      dangerouslySetInnerHTML={{ __html: html }}
    />
  );
}
