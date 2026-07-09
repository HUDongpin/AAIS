import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const readme = readFileSync("README.md", "utf8");

describe("AAIS README contract", () => {
  it("stays as a one-page onboarding map instead of a runbook", () => {
    const nonBlankLines = readme
      .split(/\r?\n/)
      .filter((line) => line.trim()).length;

    expect(nonBlankLines).toBeLessThanOrEqual(70);
    expect(readme).toContain("Run Locally");
    expect(readme).toContain("Verify");
    expect(readme).toContain("Deploy");
    expect(readme).toContain("Docs");
  });

  it("keeps pointers to the detailed operational documents", () => {
    [
      "ARCHITECTURE.md",
      "OPERATIONS.md",
      "CONTRIBUTING.md",
      "docs/release-checklist.md",
      "docs/privacy-data-inventory.md",
    ].forEach((expected) => {
      expect(readme).toContain(expected);
    });
  });
});
