import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

function dependabotGroupBlock(source, groupName) {
  const marker = `      ${groupName}:`;
  const start = source.indexOf(marker);
  if (start < 0) {
    return "";
  }

  const remainder = source.slice(start + marker.length);
  const nextGroup = /\n {6}\S/.exec(remainder);
  const end = nextGroup
    ? start + marker.length + nextGroup.index
    : source.length;
  return source.slice(start, end);
}

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
  });

  it("groups only minor and patch dependency updates", () => {
    const dependabot = readFileSync(".github/dependabot.yml", "utf8");

    for (const groupName of [
      "next-toolchain",
      "react-runtime",
      "production-safe",
      "development-safe",
    ]) {
      const group = dependabotGroupBlock(dependabot, groupName);
      expect(group, `${groupName} group`).toContain("update-types:");
      expect(group, `${groupName} group`).toContain("- minor");
      expect(group, `${groupName} group`).toContain("- patch");
      expect(group, `${groupName} group`).not.toContain("- major");
    }

    expect(dependabot).not.toContain("production-dependencies:");
    expect(dependabot).not.toContain("development-dependencies:");
  });

  it("holds incompatible toolchain major updates for manual migration", () => {
    const dependabot = readFileSync(".github/dependabot.yml", "utf8");

    for (const dependencyName of ["typescript", "eslint", "@types/node"]) {
      const escapedName = dependencyName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      expect(dependabot).toMatch(
        new RegExp(
          `dependency-name: ["']?${escapedName}["']?[\\s\\S]{0,160}`
            + "version-update:semver-major",
        ),
      );
    }
  });
});
