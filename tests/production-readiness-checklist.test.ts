import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const checklist = readFileSync("technical-review/AAIS-Production-Readiness-Checklist.md", "utf8");

describe("AAIS production-readiness checklist", () => {
  it("marks only proven items while keeping remaining live/provider gates unchecked", () => {
    [
      "Built-in demo credentials",
      "Durable login rate limiting verified across serverless invocations",
      "Readiness/diagnostics endpoints require auth beyond bare status",
      "Dependency audit",
      "Migration tool in place; zero runtime DDL",
      "Concurrent-write safety proven by a test",
      "Per-user data export and deletion implemented and tested",
      "Environment variables documented in `.env.example`",
      "README <= 1 page",
      "ARCHITECTURE.md with the real diagram",
      "A regression test exists for every Critical/High issue fixed locally",
      "Loading and error states on every async action",
      "AI fallback/template responses visibly labeled",
      "Stated mobile policy",
    ].forEach((label) => {
      expect(normalize(checklist)).toContain(normalize(`- [x] ${label}`));
    });

    [
      "All API keys/passwords rotated",
      "Individual accounts for every human",
      "Deploys only from Git",
      "Staging environment with seeded data",
      "Sentry receiving client + server errors",
      "Uptime check on `/login`",
      "Keyboard + screen-reader pass on the 3 core screens",
    ].forEach((label) => {
      expect(normalize(checklist)).toContain(normalize(`- [ ] ${label}`));
    });
  });

  it("keeps evidence pointers and the real-cohort gate visible", () => {
    [
      "tests/readiness-route.test.ts",
      "tests/postgres-migrations.test.mjs",
      "tests/aais-backend-store.test.ts",
      "tests/aais-privacy-route.test.ts",
      "tests/documentation-readme.test.ts",
      "tests/documentation-architecture.test.ts",
      "tests/e2e/ai-guide.spec.ts",
      "tests/login-page.test.tsx",
      "tests/learning-components.test.tsx",
      "tests/learning-page.test.tsx",
      "tests/teacher-dashboard-page.test.tsx",
      "tests/admin-users-page.test.tsx",
      "technical-review/AAIS-Critical-High-Regression-Coverage.md",
      "technical-review/AAIS-Async-Action-Audit.md",
      "full client async-action audit",
      "tests/responsive-policy-docs.test.ts",
      "tests/e2e/core-accessibility.spec.ts",
      "browser contrast proof",
      "manual screen-reader spot check pending",
      "aais-postgres-migrations-production-20260709.json",
      "AAIS_LOGIN_RATE_LIMITED",
      "retry-after: 900",
      "aais-dependency-audit-20260709.json",
      "0 high and 0 critical vulnerabilities",
      "no real student cohort onboards",
      "Neon/LRS DPAs",
    ].forEach((expected) => {
      expect(checklist).toContain(expected);
    });
  });
});

function normalize(value: string) {
  return value.replace(/≤/g, "<=").replace(/\s+/g, " ");
}
