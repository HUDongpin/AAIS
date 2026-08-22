import { existsSync, readFileSync } from "node:fs";
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

  it("aligns local, GitHub, package, and Vercel-compatible runtime contracts on Node 24", () => {
    const ci = readFileSync(".github/workflows/ci.yml", "utf8");
    const preview = readFileSync(".github/workflows/preview-e2e.yml", "utf8");
    const packageJson = JSON.parse(readFileSync("package.json", "utf8"));
    const nvmrc = existsSync(".nvmrc") ? readFileSync(".nvmrc", "utf8").trim() : "";
    const npmrc = existsSync(".npmrc") ? readFileSync(".npmrc", "utf8") : "";

    expect(ci).toContain("uses: actions/checkout@v7");
    expect(ci).toContain("uses: actions/setup-node@v7");
    expect(ci).toContain("node-version: 24");
    expect(ci).not.toContain("node-version: 20");
    expect(preview).toContain("uses: actions/github-script@v9");
    expect(preview).toContain("uses: actions/checkout@v7");
    expect(preview).toContain("uses: actions/setup-node@v7");
    expect(preview).toContain("node-version: 24");
    expect(preview).not.toContain("node-version: 20");
    expect(packageJson.engines?.node).toBe("24.x");
    expect(packageJson.devDependencies?.["@types/node"]).toMatch(/^\^24\./);
    expect(nvmrc).toBe("24");
    expect(npmrc).toContain("strict-peer-deps=true");
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
