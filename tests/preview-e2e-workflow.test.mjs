import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const workflow = readFileSync(".github/workflows/preview-e2e.yml", "utf8");

describe("AAIS preview E2E workflow trust gate", () => {
  it("uses deployment_status with read-only Stage-A permissions and no manual dispatch", () => {
    expect(workflow).toContain("on:\n  deployment_status:");
    expect(workflow).not.toContain("workflow_dispatch");
    expect(workflow).toContain("contents: read");
    expect(workflow).toContain("deployments: read");
    expect(workflow).toContain("pull-requests: read");
    expect(workflow).toContain("actions: read");
    expect(workflow).not.toMatch(/permissions:[\s\S]*?write/);
  });

  it("orders secret-free Stage A, pre-checkout Stage B, and exact-SHA Stage C", () => {
    const stageA = stepBlock("Stage A - attest GitHub deployment", "Stage B - attest Vercel deployment");
    const stageB = stepBlock("Stage B - attest Vercel deployment", "Stage C - checkout attested commit");
    const stageC = workflow.slice(workflow.indexOf("- name: Stage C - checkout attested commit"));

    expect(stageA).not.toContain("secrets.");
    expect(stageA).not.toContain("VERCEL_E2E_METADATA_TOKEN");
    expect(stageB).toContain("VERCEL_E2E_METADATA_TOKEN: ${{ secrets.VERCEL_E2E_METADATA_TOKEN }}");
    expect(stageB).toContain("AAIS_PREVIEW_TRUST_METADATA_TOKEN_ABSENT");
    expect(stageB).not.toContain("actions/checkout");
    expect(stageC).toContain("uses: actions/checkout@v4");
    expect(stageC).toContain("ref: ${{ needs.trust-preview.outputs.attested_sha }}");
    expect(stageC).toContain("test \"$(git rev-parse HEAD)\" = \"$ATTESTED_SHA\"");
  });

  it("binds Stage A to Vercel App, default main, PR 5, repository, branch, and SHA", () => {
    const stageA = stepBlock("Stage A - attest GitHub deployment", "Stage B - attest Vercel deployment");

    for (const required of [
      "HUDongpin/AAIS",
      "deployment_status",
      "vercel[bot]",
      "35613825",
      "MDM6Qm90MzU2MTM4MjU=",
      "Bot",
      "PR_NUMBER = 5",
      "codex/aais-recovery-compose",
      "isCrossRepository",
      ".github/workflows/preview-e2e.yml",
      "refs/heads/main",
      "Preview",
      "success",
      ".vercel.app",
    ]) {
      expect(stageA).toContain(required);
    }
    expect(stageA).not.toContain("deployment.payload");
    expect(stageA).toContain("GITHUB_DEPLOYMENT_ID");
    expect(stageA).toContain("GITHUB_DEPLOYMENT_STATUS_ID");
    expect(stageA).toContain("ATTESTED_SHA");
    expect(stageA).toContain("VERCEL_HOSTNAME");
  });

  it("binds the executing workflow SHA to current main and fetches the workflow blob immutably", () => {
    const stageA = stepBlock("Stage A - attest GitHub deployment", "Stage B - attest Vercel deployment");

    expect(stageA).toContain("const executingWorkflowSha = process.env.GITHUB_WORKFLOW_SHA;");
    expect(stageA).toContain("!/^[a-f0-9]{40}$/.test(executingWorkflowSha)");
    expect(stageA).toContain("executingWorkflowSha !== mainRef.object.sha");
    expect(stageA).toContain("ref: executingWorkflowSha");
    expect(stageA).not.toContain("ref: DEFAULT_BRANCH");

    const staleWorkflowGuard = stageA.indexOf("executingWorkflowSha !== mainRef.object.sha");
    const immutableWorkflowFetch = stageA.indexOf("ref: executingWorkflowSha");
    expect(staleWorkflowGuard).toBeGreaterThan(-1);
    expect(immutableWorkflowFetch).toBeGreaterThan(staleWorkflowGuard);
  });

  it("uses only the normalized Stage-A hostname as the Vercel idOrUrl", () => {
    const stageB = stepBlock("Stage B - attest Vercel deployment", "Stage C - checkout attested commit");

    expect(stageB).toContain("https://api.vercel.com/v13/deployments/");
    expect(stageB).toContain("teamId=team_i9xhhYXUeYBOCLcfWBjTqlYG");
    expect(stageB).toContain("encodeURIComponent(process.env.VERCEL_HOSTNAME)");
    expect(stageB).not.toMatch(/encodeURIComponent\(process\.env\.GITHUB_DEPLOYMENT_(?:STATUS_)?ID\)/);
    expect(stageB).toContain("redirect: \"manual\"");
    expect(stageB).toContain("Authorization: `Bearer ${token}`");
  });

  it("allowlists and validates the exact Vercel deployment identity projection", () => {
    const stageB = stepBlock("Stage B - attest Vercel deployment", "Stage C - checkout attested commit");

    for (const allowedPath of [
      "deployment.id",
      "deployment.name",
      "deployment.projectId",
      "deployment.ownerId",
      "deployment.team.id",
      "deployment.team.slug",
      "deployment.readyState",
      "deployment.status",
      "deployment.target",
      "deployment.url",
      "deployment.alias",
      "deployment.gitSource.type",
      "deployment.gitSource.repoId",
      "deployment.gitSource.ref",
      "deployment.gitSource.sha",
      "deployment.meta.githubOrg",
      "deployment.meta.githubRepo",
      "deployment.meta.githubCommitRef",
      "deployment.meta.githubCommitSha",
    ]) {
      expect(stageB).toContain(allowedPath);
    }
    for (const exactIdentity of [
      "prj_sKF9lhawVQyjxnv3jLyZvQH95Z1c",
      "aais",
      "team_i9xhhYXUeYBOCLcfWBjTqlYG",
      "peter-dongpin-hu-s-projects",
      "READY",
      "1294583104",
      "github",
      "HUDongpin",
      "AAIS",
      "codex/aais-recovery-compose",
    ]) {
      expect(stageB).toContain(exactIdentity);
    }
    expect(stageB).toContain("deployment.target !== null");
    expect(stageB).toContain("VERCEL_DEPLOYMENT_ID");
    expect(stageB).toContain("deployment.id === process.env.GITHUB_DEPLOYMENT_ID");
    expect(stageB).toContain("deployment.id === process.env.GITHUB_DEPLOYMENT_STATUS_ID");
    expect(stageB).not.toContain("JSON.stringify(deployment)");
    expect(stageB).not.toContain("console.log(deployment)");
  });

  it("exposes the five application secrets only to the Playwright step", () => {
    const playwright = stepBlock("Run Playwright against attested preview", "Verify no secret-bearing artifacts");
    const names = [
      "AAIS_E2E_STUDENT_ACCOUNT",
      "AAIS_E2E_STUDENT_PASSWORD",
      "AAIS_E2E_TEACHER_ACCOUNT",
      "AAIS_E2E_TEACHER_PASSWORD",
      "VERCEL_AUTOMATION_BYPASS_SECRET",
    ];

    for (const name of names) {
      expect(playwright).toContain(`${name}: \${{ secrets.${name} }}`);
      expect(workflow.match(new RegExp(`secrets\\.${name}`, "g"))).toHaveLength(1);
    }
    expect(playwright).toContain("PLAYWRIGHT_LAST_RUN_OUTPUT_FILE: /dev/null");
    expect(playwright).toContain("npm run e2e");
    expect(playwright).not.toContain("VERCEL_E2E_METADATA_TOKEN");
    expect(workflow).not.toMatch(/^    env:\n(?:^      .+\n)*?^      (?:AAIS_E2E_|VERCEL_AUTOMATION_BYPASS_SECRET)/m);
  });

  it("forbids upload artifacts and inventories retained Playwright output", () => {
    expect(workflow).not.toContain("upload-artifact");
    const inventory = workflow.slice(workflow.indexOf("- name: Verify no secret-bearing artifacts"));
    expect(inventory).toContain("AAIS_PREVIEW_ARTIFACT_FILE_COUNT");
    expect(inventory).toContain("AAIS_PREVIEW_ATTACHMENT_FILE_COUNT");
    expect(inventory).toContain("test \"$artifact_file_count\" -eq 0");
    expect(inventory).toContain("test \"$attachment_file_count\" -eq 0");
  });
});

function stepBlock(startName, endName) {
  const start = workflow.indexOf(`- name: ${startName}`);
  const end = workflow.indexOf(`- name: ${endName}`);
  expect(start).toBeGreaterThan(-1);
  expect(end).toBeGreaterThan(start);
  return workflow.slice(start, end);
}
