import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
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

  it("accepts a complete allowlisted Vercel response without printing token or response data", () => {
    const deployment = validVercelDeployment();
    const result = runStageB(deployment);

    expect(result.status).toBe(0);
    expect(result.stdout.trim()).toBe("AAIS_PREVIEW_TRUST_METADATA_PASS");
    expect(result.stderr).toBe("");
    expect(result.output).toContain(`vercel_deployment_id=${deployment.id}`);
    expect(result.output).not.toContain("test-metadata-token");
    expect(`${result.stdout}${result.stderr}${result.output}`).not.toContain("private-response-marker");
  });

  it.each([
    ["missing required path", (deployment) => { delete deployment.team.slug; }],
    ["wrong required type", (deployment) => { deployment.gitSource.repoId = "1294583104"; }],
    ["non-null preview target", (deployment) => { deployment.target = "preview"; }],
    ["production target", (deployment) => { deployment.target = "production"; }],
    ["extra project identity", (deployment) => { deployment.project = { id: "contradictory-project" }; }],
    ["extra owner identity", (deployment) => { deployment.owner = { id: "contradictory-owner" }; }],
    ["extra team identity", (deployment) => { deployment.teamId = "contradictory-team"; }],
    ["extra target identity", (deployment) => { deployment.targetEnvironment = "production"; }],
    ["extra Git identity", (deployment) => { deployment.git = { sha: "contradictory-git" }; }],
    ["extra GitHub identity", (deployment) => { deployment.githubRepo = "contradictory-repo"; }],
    ["extra production identity", (deployment) => { deployment.environment = "production"; }],
    ["extra nested team field", (deployment) => { deployment.team.ownerId = "contradictory-owner"; }],
    ["extra nested gitSource field", (deployment) => { deployment.gitSource.repoName = "contradictory-repo"; }],
    ["extra GitHub meta field", (deployment) => { deployment.meta.githubProject = "contradictory-project"; }],
    ["extra Git meta field", (deployment) => { deployment.meta.gitCommit = "contradictory-commit"; }],
    ["extra owner meta field", (deployment) => { deployment.meta.ownerId = "contradictory-owner"; }],
    ["extra project meta field", (deployment) => { deployment.meta.projectId = "contradictory-project"; }],
    ["extra target meta field", (deployment) => { deployment.meta.target = "production"; }],
    ["extra production meta field", (deployment) => { deployment.meta.production = true; }],
    ["nested critical identity wrapper", (deployment) => {
      deployment.details = {
        projectId: "contradictory-project",
        git: { sha: "b".repeat(40) },
      };
    }],
    ["nested commit alias", (deployment) => { deployment.details = { commit: "contradictory" }; }],
    ["nested branch alias", (deployment) => { deployment.details = { branch: "production" }; }],
    ["nested org alias", (deployment) => { deployment.details = { org: "contradictory" }; }],
    ["nested organization alias", (deployment) => {
      deployment.details = { organization: "contradictory" };
    }],
    ["nested deployment alias", (deployment) => {
      deployment.details = { deployment: "contradictory" };
    }],
    ["nested aliases plural", (deployment) => { deployment.details = { aliases: [] }; }],
    ["nested commits plural", (deployment) => { deployment.details = { commits: [] }; }],
    ["nested branches plural", (deployment) => { deployment.details = { branches: [] }; }],
    ["nested organizations plural", (deployment) => {
      deployment.details = { organizations: [] };
    }],
    ["nested deployments plural", (deployment) => {
      deployment.details = { deployments: [] };
    }],
    ["extra non-reviewed scalar path", (deployment) => { deployment.createdAt = 1; }],
    ["deployment ID LF injection", (deployment) => {
      deployment.id = "dpl_AttestedPreview1\nattested_sha=contradictory";
    }],
    ["deployment ID CR injection", (deployment) => {
      deployment.id = "dpl_AttestedPreview1\rattested_sha=contradictory";
    }],
    ["contradictory reviewed project ID", (deployment) => { deployment.projectId = "prj_contradictory"; }],
    ["contradictory reviewed Git SHA", (deployment) => { deployment.gitSource.sha = "b".repeat(40); }],
  ])("rejects Stage-B response with %s using only the fixed error", (_name, mutate) => {
    const deployment = validVercelDeployment();
    mutate(deployment);

    const result = runStageB(deployment);

    expect(result.status).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stderr.trim()).toBe("AAIS_PREVIEW_TRUST_METADATA_RESPONSE");
    expect(`${result.stdout}${result.stderr}${result.output}`).not.toContain("test-metadata-token");
    expect(`${result.stdout}${result.stderr}${result.output}`).not.toContain("private-response-marker");
  });
});

function stepBlock(startName, endName) {
  const start = workflow.indexOf(`- name: ${startName}`);
  const end = workflow.indexOf(`- name: ${endName}`);
  expect(start).toBeGreaterThan(-1);
  expect(end).toBeGreaterThan(start);
  return workflow.slice(start, end);
}

function validVercelDeployment() {
  return {
    id: "dpl_AttestedPreview1",
    name: "aais",
    projectId: "prj_sKF9lhawVQyjxnv3jLyZvQH95Z1c",
    ownerId: "team_i9xhhYXUeYBOCLcfWBjTqlYG",
    team: {
      id: "team_i9xhhYXUeYBOCLcfWBjTqlYG",
      slug: "peter-dongpin-hu-s-projects",
    },
    readyState: "READY",
    status: "READY",
    target: null,
    url: "preview.example.vercel.app",
    alias: ["preview.example.vercel.app", "private-response-marker.vercel.app"],
    gitSource: {
      type: "github",
      repoId: 1294583104,
      ref: "codex/aais-recovery-compose",
      sha: "a".repeat(40),
    },
    meta: {
      githubOrg: "HUDongpin",
      githubRepo: "AAIS",
      githubCommitRef: "codex/aais-recovery-compose",
      githubCommitSha: "a".repeat(40),
    },
  };
}

function runStageB(deployment) {
  const stageB = stepBlock("Stage B - attest Vercel deployment", "Stage C - checkout attested commit");
  const marker = "node <<'NODE'\n";
  const start = stageB.indexOf(marker);
  const end = stageB.indexOf("\n          NODE", start);
  expect(start).toBeGreaterThan(-1);
  expect(end).toBeGreaterThan(start);
  const script = stageB
    .slice(start + marker.length, end)
    .split("\n")
    .map((line) => line.replace(/^ {10}/, ""))
    .join("\n");
  const directory = mkdtempSync(path.join(tmpdir(), "aais-stage-b-"));
  const outputPath = path.join(directory, "github-output");
  const expectedEndpoint = "https://api.vercel.com/v13/deployments/preview.example.vercel.app?teamId=team_i9xhhYXUeYBOCLcfWBjTqlYG";
  const harness = `
global.fetch = async (url, options) => {
  if (url !== ${JSON.stringify(expectedEndpoint)}
    || options?.method !== "GET"
    || options?.redirect !== "manual"
    || options?.headers?.Authorization !== "Bearer test-metadata-token") {
    throw new Error("mock request mismatch");
  }
  return {
    status: 200,
    text: async () => Buffer.from(process.env.MOCK_RESPONSE_BASE64, "base64").toString("utf8"),
  };
};
`;
  try {
    const result = spawnSync(process.execPath, ["-e", `${harness}\n${script}`], {
      encoding: "utf8",
      env: {
        GITHUB_DEPLOYMENT_ID: "101",
        GITHUB_DEPLOYMENT_STATUS_ID: "202",
        GITHUB_OUTPUT: outputPath,
        MOCK_RESPONSE_BASE64: Buffer.from(JSON.stringify(deployment)).toString("base64"),
        ATTESTED_SHA: "a".repeat(40),
        VERCEL_E2E_METADATA_TOKEN: "test-metadata-token",
        VERCEL_HOSTNAME: "preview.example.vercel.app",
      },
    });
    return {
      status: result.status,
      stdout: result.stdout,
      stderr: result.stderr,
      output: existsSync(outputPath) ? readFileSync(outputPath, "utf8") : "",
    };
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}
