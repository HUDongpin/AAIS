import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

describe("AAIS root accessibility affordances", () => {
  it("provides a keyboard skip link to the shared content target", () => {
    const layout = readFileSync("src/app/layout.tsx", "utf8");
    const globalCss = readFileSync("src/app/globals.css", "utf8");

    expect(layout).toContain('href="#aais-main-content"');
    expect(layout).toContain('id="aais-main-content"');
    expect(layout).toContain("跳到主要内容");
    expect(globalCss).toContain(".aais-skip-link");
    expect(globalCss).toContain(".aais-skip-link:focus");
    expect(globalCss).toContain("translateY(0)");
  });
});
