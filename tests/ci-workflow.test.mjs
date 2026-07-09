import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

describe("AAIS CI workflow", () => {
  it("runs source hygiene, dependency audit, product CI, and Playwright E2E", () => {
    const workflow = readFileSync(".github/workflows/ci.yml", "utf8");

    expect(workflow).toContain("pull_request:");
    expect(workflow).toContain("branches:");
    expect(workflow).toContain("- main");
    expect(workflow).toContain("run: npm audit --audit-level=high");
    expect(workflow).toContain("run: npm run hygiene:check");
    expect(workflow).toContain("run: npm run ci");
    expect(workflow).toContain("run: npm run e2e");
  });

  it("keeps Dependabot watching npm and GitHub Actions weekly", () => {
    const dependabot = readFileSync(".github/dependabot.yml", "utf8");

    expect(dependabot).toContain("package-ecosystem: npm");
    expect(dependabot).toContain("package-ecosystem: github-actions");
    expect(dependabot).toContain("interval: weekly");
    expect(dependabot).toContain("timezone: Asia/Hong_Kong");
    expect(dependabot).toContain("production-dependencies:");
    expect(dependabot).toContain("development-dependencies:");
  });
});
