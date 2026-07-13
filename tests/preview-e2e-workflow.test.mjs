import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";

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

  it("binds Stage A to Vercel App and a unique open same-repository PR for the deployment SHA", () => {
    const stageA = stepBlock("Stage A - attest GitHub deployment", "Stage B - attest Vercel deployment");

    for (const required of [
      "HUDongpin/AAIS",
      "deployment_status",
      "vercel[bot]",
      "35613825",
      "MDM6Qm90MzU2MTM4MjU=",
      "Bot",
      "github.paginate",
      "listPullRequestsAssociatedWithCommit",
      "github.rest.pulls.get",
      "pullRequest.base?.ref",
      "pullRequest.head.ref",
      "pullRequest.head?.sha",
      "pullRequest.head?.repo?.full_name",
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
    expect(stageA).not.toContain("PR_NUMBER = 5");
    expect(stageA).not.toContain("codex/aais-recovery-compose");
    expect(stageA).not.toContain("pullRequest(number: 5)");
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

  it("executes Stage A from current main while attesting the distinct candidate SHA", async () => {
    const result = await runStageA();

    expect(result.workflowRef).toBe(
      "HUDongpin/AAIS/.github/workflows/preview-e2e.yml@refs/heads/main",
    );
    expect(result.workflowSha).toBe(result.mainSha);
    expect(result.candidateSha).not.toBe(result.mainSha);
    expect(result.outputs.attested_sha).toBe(result.candidateSha);
    expect(result.outputs.main_sha).toBe(result.mainSha);
    expect(result.outputs.workflow_blob).toBe(result.workflowBlob);
    expect(result.outputs.pull_number).toBe("18");
    expect(result.outputs.ref).toBe("codex/aais-dependency-governance");
    expect(result.logs).toEqual(["AAIS_PREVIEW_TRUST_GITHUB_PASS"]);
  });

  it("resolves the pull request from the attested commit instead of a fixed PR number", async () => {
    const result = await runStageA({
      branchName: "dependabot/npm_and_yarn/production-safe",
      prNumber: 27,
    });

    expect(result.paginate).toHaveBeenCalledWith(
      result.listAssociatedPullRequests,
      {
        owner: "HUDongpin",
        repo: "AAIS",
        commit_sha: result.candidateSha,
        per_page: 100,
      },
    );
    expect(result.getPull).toHaveBeenCalledWith({
      owner: "HUDongpin",
      repo: "AAIS",
      pull_number: 27,
    });
    expect(result.outputs.pull_number).toBe("27");
    expect(result.outputs.ref).toBe("dependabot/npm_and_yarn/production-safe");
  });

  it("accepts GitHub deployment refs expressed as either the candidate SHA or head branch", async () => {
    const shaRef = await runStageA({ deploymentRefMode: "sha" });
    const branchRef = await runStageA({ deploymentRefMode: "branch" });

    expect(shaRef.deploymentRef).toBe(shaRef.candidateSha);
    expect(branchRef.deploymentRef).toBe("codex/aais-dependency-governance");
    expect(shaRef.outputs.ref).toBe("codex/aais-dependency-governance");
    expect(branchRef.outputs.ref).toBe("codex/aais-dependency-governance");
  });

  it("rejects a deployment SHA without exactly one matching open pull request", async () => {
    await expect(runStageA({ associatedPullNumbers: [] }))
      .rejects.toThrowError(/^AAIS_PREVIEW_TRUST_GITHUB$/);
    await expect(runStageA({ associatedPullNumbers: [18, 19] }))
      .rejects.toThrowError(/^AAIS_PREVIEW_TRUST_GITHUB$/);
  });

  it("rejects ambiguity found after the first associated-PR page", async () => {
    const associatedPullNumbers = Array.from({ length: 31 }, (_, index) => 18 + index);

    await expect(runStageA({
      associatedPullNumbers,
      matchingPullNumbers: [18, 48],
    })).rejects.toThrowError(/^AAIS_PREVIEW_TRUST_GITHUB$/);
  });

  it("uses a branch-form deployment ref to disambiguate PRs sharing the same SHA", async () => {
    const result = await runStageA({
      associatedPullNumbers: [18, 19],
      branchName: "codex/aais-dependency-governance",
      deploymentRefMode: "branch",
      pullBranches: new Map([
        [18, "codex/aais-dependency-governance"],
        [19, "codex/other-branch-with-shared-sha"],
      ]),
    });

    expect(result.outputs.pull_number).toBe("18");
    expect(result.outputs.ref).toBe("codex/aais-dependency-governance");
  });

  it("fetches the workflow by immutable executing/main SHA rather than a mutable branch", async () => {
    const result = await runStageA();

    expect(result.getContent).toHaveBeenCalledTimes(1);
    expect(result.getContent).toHaveBeenCalledWith({
      owner: "HUDongpin",
      repo: "AAIS",
      path: ".github/workflows/preview-e2e.yml",
      ref: result.mainSha,
    });
    const [{ ref }] = result.getContent.mock.calls[0];
    expect(ref).toBe(result.workflowSha);
    expect(ref).not.toBe("main");
    expect(ref).not.toBe("refs/heads/main");
    expect(ref).not.toBe(result.candidateSha);
  });

  it("rejects the candidate head as the executing workflow SHA with the fixed error", async () => {
    await expect(runStageA({ workflowSha: "candidate" }))
      .rejects.toThrowError(/^AAIS_PREVIEW_TRUST_GITHUB$/);
  });

  it("rejects a stale executing workflow SHA with the fixed error", async () => {
    await expect(runStageA({ workflowSha: "d".repeat(40) }))
      .rejects.toThrowError(/^AAIS_PREVIEW_TRUST_GITHUB$/);
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
      "ATTESTED_REF",
    ]) {
      expect(stageB).toContain(exactIdentity);
    }
    expect(stageB).toContain("deployment.target !== null");
    expect(stageB).toContain("VERCEL_DEPLOYMENT_ID");
    expect(stageB).toContain("deployment.id === process.env.GITHUB_DEPLOYMENT_ID");
    expect(stageB).toContain("deployment.id === process.env.GITHUB_DEPLOYMENT_STATUS_ID");
    expect(stageB).toContain("deployment.gitSource.ref !== process.env.ATTESTED_REF");
    expect(stageB).toContain("deployment.meta.githubCommitRef !== process.env.ATTESTED_REF");
    expect(stageB).not.toContain("codex/aais-recovery-compose");
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

  it("projects reviewed Vercel fields while ignoring and never printing raw response extras", () => {
    const deployment = validVercelDeployment();
    deployment.createdAt = 1_752_000_000_000;
    deployment.creator = {
      uid: "official-like-creator-marker",
      username: "vercel-bot",
    };
    deployment.project = {
      id: "prj_contradictory_raw_project",
      name: "official-like-project-marker",
    };
    deployment.owner = { id: "team_contradictory_raw_owner" };
    deployment.environment = "production";
    deployment.team.name = "official-like-team-marker";
    deployment.team.avatar = "official-like-avatar-marker";
    deployment.gitSource.prId = 999;
    deployment.gitSource.repoName = "official-like-repo-marker";
    deployment.meta.builds = [{ id: "official-like-build-marker" }];
    deployment.meta.githubCommitAuthorName = "official-like-author-marker";
    deployment.meta.target = "production";
    deployment.details = {
      commit: "contradictory-raw-commit",
      branch: "contradictory-raw-branch",
      projectId: "prj_contradictory_raw_details",
    };
    const result = runStageB(deployment);

    expect(result.status).toBe(0);
    expect(result.stdout.trim()).toBe("AAIS_PREVIEW_TRUST_METADATA_PASS");
    expect(result.stderr).toBe("");
    expect(result.output).toContain(`vercel_deployment_id=${deployment.id}`);
    expect(result.output).not.toContain("test-metadata-token");
    const observableOutput = `${result.stdout}${result.stderr}${result.output}`;
    for (const rawMarker of [
      "private-response-marker",
      "official-like-creator-marker",
      "official-like-project-marker",
      "official-like-team-marker",
      "official-like-avatar-marker",
      "official-like-repo-marker",
      "official-like-build-marker",
      "official-like-author-marker",
      "contradictory-raw-commit",
      "contradictory-raw-branch",
      "prj_contradictory_raw_details",
      "production",
    ]) {
      expect(observableOutput).not.toContain(rawMarker);
    }
  });

  it.each([
    ["missing required path", (deployment) => { delete deployment.team.slug; }],
    ["wrong required type", (deployment) => { deployment.gitSource.repoId = "1294583104"; }],
    ["non-null preview target", (deployment) => { deployment.target = "preview"; }],
    ["production target", (deployment) => { deployment.target = "production"; }],
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

function validVercelDeployment(branchName = "codex/aais-dependency-governance") {
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
      ref: branchName,
      sha: "a".repeat(40),
    },
    meta: {
      githubOrg: "HUDongpin",
      githubRepo: "AAIS",
      githubCommitRef: branchName,
      githubCommitSha: "a".repeat(40),
    },
  };
}

async function runStageA({
  associatedPullNumbers,
  branchName = "codex/aais-dependency-governance",
  deploymentRefMode = "sha",
  matchingPullNumbers,
  prNumber = 18,
  pullBranches = new Map(),
  workflowSha = "main",
} = {}) {
  const candidateSha = "a".repeat(40);
  const deploymentRef = deploymentRefMode === "branch" ? branchName : candidateSha;
  const mainSha = "b".repeat(40);
  const workflowBlob = "c".repeat(40);
  const workflowRef =
    "HUDongpin/AAIS/.github/workflows/preview-e2e.yml@refs/heads/main";
  const executingWorkflowSha = workflowSha === "main"
    ? mainSha
    : workflowSha === "candidate"
      ? candidateSha
      : workflowSha;
  const actor = {
    login: "vercel[bot]",
    id: 35613825,
    node_id: "MDM6Qm90MzU2MTM4MjU=",
    type: "Bot",
  };
  const outputs = {};
  const logs = [];
  const getContent = vi.fn(async () => ({
    data: {
      type: "file",
      sha: workflowBlob,
    },
  }));
  const candidatePullNumbers = associatedPullNumbers ?? [prNumber];
  const firstPagePullNumbers = candidatePullNumbers.slice(0, 30);
  const matchingNumbers = matchingPullNumbers ?? candidatePullNumbers;
  const listAssociatedPullRequests = vi.fn(async () => ({
    data: firstPagePullNumbers.map((number) => ({ number })),
  }));
  const getPull = vi.fn(async ({ pull_number }) => ({
    data: {
      number: pull_number,
      state: "open",
      base: { ref: "main" },
      head: {
        ref: pullBranches.get(pull_number) ?? branchName,
        sha: matchingNumbers.includes(pull_number) ? candidateSha : "d".repeat(40),
        repo: { full_name: "HUDongpin/AAIS" },
      },
    },
  }));
  const paginate = vi.fn(async () =>
    candidatePullNumbers.map((number) => ({ number })));
  const github = {
    paginate,
    rest: {
      actions: {
        getWorkflow: vi.fn(async () => ({
          data: {
            id: 309746229,
            path: ".github/workflows/preview-e2e.yml",
            state: "active",
          },
        })),
      },
      git: {
        getRef: vi.fn(async () => ({ data: { object: { sha: mainSha } } })),
      },
      pulls: {
        get: getPull,
      },
      repos: {
        get: vi.fn(async () => ({
          data: { full_name: "HUDongpin/AAIS", default_branch: "main" },
        })),
        getContent,
        getDeployment: vi.fn(async () => ({
          data: {
            id: 101,
            ref: deploymentRef,
            sha: candidateSha,
            environment: "Preview",
            creator: actor,
          },
        })),
        getDeploymentStatus: vi.fn(async () => ({
          data: {
            id: 202,
            state: "success",
            creator: actor,
            target_url: "https://preview.example.vercel.app",
            environment_url: "https://preview.example.vercel.app",
          },
        })),
        listPullRequestsAssociatedWithCommit: listAssociatedPullRequests,
      },
    },
  };
  const context = {
    eventName: "deployment_status",
    repo: { owner: "HUDongpin", repo: "AAIS" },
    payload: {
      deployment: { id: 101 },
      deployment_status: { id: 202 },
    },
  };
  const core = {
    setOutput: vi.fn((name, value) => {
      outputs[name] = value;
    }),
  };
  const processStub = {
    env: {
      GITHUB_WORKFLOW_REF: workflowRef,
      GITHUB_WORKFLOW_SHA: executingWorkflowSha,
    },
  };
  const consoleStub = { log: vi.fn((value) => logs.push(value)) };
  const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
  const execute = new AsyncFunction(
    "context",
    "github",
    "core",
    "process",
    "console",
    stageAScript(),
  );
  await execute(context, github, core, processStub, consoleStub);
  return {
    candidateSha,
    deploymentRef,
    getContent,
    getPull,
    listAssociatedPullRequests,
    logs,
    mainSha,
    outputs,
    paginate,
    workflowBlob,
    workflowRef,
    workflowSha: executingWorkflowSha,
  };
}

function stageAScript() {
  const stageA = stepBlock("Stage A - attest GitHub deployment", "Stage B - attest Vercel deployment");
  const marker = "script: |\n";
  const start = stageA.indexOf(marker);
  expect(start).toBeGreaterThan(-1);
  return stageA
    .slice(start + marker.length)
    .split("\n")
    .map((line) => line.replace(/^ {12}/, ""))
    .join("\n")
    .trimEnd();
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
        ATTESTED_REF: "codex/aais-dependency-governance",
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
