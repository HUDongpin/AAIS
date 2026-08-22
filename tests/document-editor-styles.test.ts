import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

describe("document editor rich text styles", () => {
  const globalCss = readFileSync(join(process.cwd(), "src/app/globals.css"), "utf8");

  it("restores a distinct visual hierarchy for H1, H2, and H3", () => {
    expect(globalCss).toMatch(
      /\.aais-document-editor h1\s*\{[\s\S]*?font-size:\s*clamp\(1\.75rem, 1\.75em, 2\.75rem\);[\s\S]*?font-weight:\s*700;[\s\S]*?line-height:\s*1\.2;/,
    );
    expect(globalCss).toMatch(
      /\.aais-document-editor h2\s*\{[\s\S]*?font-size:\s*clamp\(1\.4rem, 1\.45em, 2\.25rem\);[\s\S]*?font-weight:\s*700;[\s\S]*?line-height:\s*1\.25;/,
    );
    expect(globalCss).toMatch(
      /\.aais-document-editor h3\s*\{[\s\S]*?font-size:\s*clamp\(1\.15rem, 1\.2em, 1\.75rem\);[\s\S]*?font-weight:\s*650;[\s\S]*?line-height:\s*1\.3;/,
    );
  });

  it("keeps heading spacing inside the editor without adding a blank first or last edge", () => {
    expect(globalCss).toMatch(
      /\.aais-document-editor :where\(h1, h2, h3\):first-child\s*\{[\s\S]*?margin-block-start:\s*0;/,
    );
    expect(globalCss).toMatch(
      /\.aais-document-editor :where\(h1, h2, h3\):last-child\s*\{[\s\S]*?margin-block-end:\s*0;/,
    );
  });

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
