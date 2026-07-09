import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

describe("AAIS preview E2E workflow", () => {
  it("runs Playwright against successful Vercel preview deployment URLs", () => {
    const workflow = readFileSync(".github/workflows/preview-e2e.yml", "utf8");

    expect(workflow).toContain("deployment_status:");
    expect(workflow).toContain("github.event.deployment_status.state == 'success'");
    expect(workflow).toContain("github.event.deployment.environment == 'Preview'");
    expect(workflow).toContain("startsWith(github.event.deployment_status.target_url, 'https://')");
    expect(workflow).toContain("AAIS_E2E_BASE_URL: ${{ github.event.deployment_status.target_url }}");
    expect(workflow).toContain("AAIS_E2E_STUDENT_ACCOUNT: ${{ secrets.AAIS_E2E_STUDENT_ACCOUNT }}");
    expect(workflow).toContain("AAIS_E2E_STUDENT_PASSWORD: ${{ secrets.AAIS_E2E_STUDENT_PASSWORD }}");
    expect(workflow).toContain("AAIS_E2E_TEACHER_ACCOUNT: ${{ secrets.AAIS_E2E_TEACHER_ACCOUNT }}");
    expect(workflow).toContain("AAIS_E2E_TEACHER_PASSWORD: ${{ secrets.AAIS_E2E_TEACHER_PASSWORD }}");
    expect(workflow).toContain("run: npm run e2e");
  });
});
