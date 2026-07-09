import { existsSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const coverage = readFileSync("technical-review/AAIS-Critical-High-Regression-Coverage.md", "utf8");

describe("AAIS Critical/High regression coverage audit", () => {
  it("maps locally fixed Critical/High advisory issues to concrete tests", () => {
    [
      "ISS-01 / T-02",
      "ISS-04 / T-08",
      "ISS-05 / T-09",
      "ISS-08 / T-15",
      "ISS-09 / T-18",
      "ISS-15 / T-20",
      "ISS-16",
    ].forEach((issue) => {
      expect(coverage).toContain(issue);
    });

    [
      "tests/auth-route.test.ts",
      "tests/aais-backend-store.test.ts",
      "tests/postgres-migrations.test.mjs",
      "tests/aais-users.test.ts",
      "tests/auth-users-route.test.ts",
      "tests/login-page.test.tsx",
      "tests/admin-users-page.test.tsx",
      "tests/learning-page-architecture.test.ts",
      "tests/learning-components.test.tsx",
      "tests/learning-session-client.test.ts",
      "tests/learning-page.test.tsx",
      "tests/teacher-dashboard-page.test.tsx",
      "tests/privacy-governance-docs.test.ts",
      "tests/aais-privacy-route.test.ts",
      "tests/aais-retention-cleanup.test.mjs",
      "tests/legal-pages.test.tsx",
    ].forEach((testPath) => {
      expect(coverage).toContain(testPath);
      expect(existsSync(testPath)).toBe(true);
    });
  });

  it("keeps owner/provider acceptance criteria outside the local coverage claim", () => {
    [
      "private GitHub remote",
      "real credential rotation",
      "real staging URL",
      "written Neon backup/PITR confirmation",
      "issuing every human an individual production credential",
      "provider/institution privacy evidence",
    ].forEach((externalGate) => {
      expect(coverage).toContain(externalGate);
    });
  });
});
