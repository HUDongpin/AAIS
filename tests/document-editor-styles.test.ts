import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

describe("document editor list styles", () => {
  const globalCss = readFileSync(join(process.cwd(), "src/app/globals.css"), "utf8");

  it("restores visible markers and indentation for runtime unordered and ordered lists", () => {
    expect(globalCss).toMatch(
      /\.aais-document-editor :where\(ul, ol\)\s*\{[\s\S]*?display:\s*block;[\s\S]*?padding-inline-start:\s*1\.75rem;[\s\S]*?list-style-position:\s*outside;/,
    );
    expect(globalCss).toMatch(
      /\.aais-document-editor ul\s*\{[\s\S]*?list-style-type:\s*disc;/,
    );
    expect(globalCss).toMatch(
      /\.aais-document-editor ol\s*\{[\s\S]*?list-style-type:\s*decimal;/,
    );
    expect(globalCss).toMatch(
      /\.aais-document-editor li\s*\{[\s\S]*?display:\s*list-item;/,
    );
  });

  it("gives nested list levels distinct markers and compact indentation", () => {
    expect(globalCss).toMatch(
      /\.aais-document-editor :where\(ul, ol\) :where\(ul, ol\)\s*\{[\s\S]*?padding-inline-start:\s*1\.5rem;/,
    );
    expect(globalCss).toMatch(/list-style-type:\s*circle;/);
    expect(globalCss).toMatch(/list-style-type:\s*square;/);
    expect(globalCss).toMatch(/list-style-type:\s*lower-alpha;/);
    expect(globalCss).toMatch(/list-style-type:\s*lower-roman;/);
  });
});
