import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
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
const OWNER = "HUDongpin";
const REPO = "AAIS";
const REPOSITORY = `${OWNER}/${REPO}`;
const DEFAULT_BRANCH = "main";
const RECOVERY_BRANCH = "codex/aais-recovery-compose";
const WORKFLOW_ID = 309746229;
const WORKFLOW_PATH = ".github/workflows/preview-e2e.yml";
const WORKFLOW_LOCATION = `${REPOSITORY}/${WORKFLOW_PATH}`;
const STOP = "AAIS_PREVIEW_CONTEXT_DIAGNOSTIC_STOP";
const PRIVATE_MARKER = "private-diagnostic-marker-must-not-leak";
const FIELD_ORDER = [
  "WORKFLOW_REF",
  "WORKFLOW_SHA",
  "GITHUB_SHA",
  "DEPLOYMENT_REF",
  "WORKFLOW_BLOBS",
  "RUN_BINDING",
  "API_FACTS",
];

describe("AAIS preview E2E fixed-classification diagnostic bootstrap", () => {
  it("uses only deployment_status and the four read-only permissions", () => {
    expect(workflow).toContain("on:\n  deployment_status:");
    expect(workflow).not.toContain("workflow_dispatch");
    expect(workflow).toMatch(
      /permissions:\n  contents: read\n  deployments: read\n  pull-requests: read\n  actions: read\n/,
    );
    expect(workflow).not.toMatch(/permissions:[\s\S]*?write/);
  });

  it("removes trust job outputs and statically disables Stage B and preview E2E", () => {
    const trustJob = workflow.slice(
      workflow.indexOf("  trust-preview:"),
      workflow.indexOf("\n  preview-e2e:"),
    );
    expect(trustJob).not.toMatch(/^    outputs:/m);
    expect(stageBBlock()).toContain(
      "- name: Stage B - attest Vercel deployment\n        if: ${{ false }}",
    );
    expect(workflow).toContain("  preview-e2e:\n    if: ${{ false }}");
  });

  it("keeps the complete Stage-B run body byte-for-byte equal to base e038", () => {
    expect(createHash("sha256").update(stageBRunBody()).digest("hex")).toBe(
      "957440a0cb03630f83d40695a73ec9933ade96f240bda62c153f59b9b97c2403",
    );
  });

  it("limits Stage A to runner-owned inputs and ten read-only GitHub fact groups", () => {
    const stageA = stageABlock();
    const envNames = [
      ...stageA.matchAll(/process\.env\.([A-Z][A-Z0-9_]*)/g),
    ].map((match) => match[1]);
    expect([...new Set(envNames)].sort()).toEqual([
      "GITHUB_RUN_ID",
      "GITHUB_SHA",
      "GITHUB_WORKFLOW_REF",
      "GITHUB_WORKFLOW_SHA",
    ]);

    for (const call of [
      "github.rest.repos.get(",
      "github.rest.git.getRef(",
      "github.rest.actions.getWorkflow(",
      "github.rest.pulls.get(",
      "github.rest.actions.getWorkflowRun(",
      "github.rest.repos.getDeployment(",
      "github.rest.repos.getDeploymentStatus(",
      "github.rest.repos.getContent(",
    ]) {
      expect(stageA).toContain(call);
    }
    expect(stageA).toContain("context.eventName");
    expect(stageA).toContain("context.repo.owner");
    expect(stageA).toContain("context.repo.repo");
    expect(stageA).toContain("context.runId");
    expect(stageA).toContain("context.payload.deployment");
    expect(stageA).toContain("context.payload.deployment_status");
    expect(stageA).not.toMatch(
      /github\.rest\.[A-Za-z]+\.(?:create|update|delete|merge|dispatch|rerun|cancel|approve|upload|set)[A-Za-z]*\(/,
    );
    expect(stageA).not.toContain("github.graphql");
  });

  it("has no Stage-A secret, external I/O, output, dump, or variable error channel", () => {
    const stageA = stageABlock();
    for (const forbidden of [
      "secrets.",
      "VERCEL_E2E_METADATA_TOKEN",
      "actions/checkout",
      "fetch(",
      "axios",
      "npm ",
      "npx ",
      "GITHUB_OUTPUT",
      "core.setOutput",
      "core.setFailed",
      "console.error",
      "console.warn",
      "console.dir",
      "JSON.stringify",
      "Object.keys(process.env)",
      "Object.entries(process.env)",
      "GITHUB_CONTEXT",
      "toJson(context)",
    ]) {
      expect(stageA).not.toContain(forbidden);
    }
    expect(stageA.match(/console\.log\(/g)).toHaveLength(1);
    expect(stageA).toContain(STOP);
    expect(stageA).not.toContain("AAIS_PREVIEW_TRUST_GITHUB_PASS");
  });

  it("emits the one permitted line in exact field order and then only the fixed stop", async () => {
    const result = await runDiagnostic();

    expectFixedStop(result);
    expect(result.logs).toHaveLength(1);
    expect(result.logs[0]).toBe(
      "AAIS_PREVIEW_CONTEXT_DIAG WORKFLOW_REF=MAIN_BRANCH WORKFLOW_SHA=OTHER_SHA "
      + "GITHUB_SHA=PR_HEAD DEPLOYMENT_REF=RECOVERY_BRANCH WORKFLOW_BLOBS=ALL_DIFFERENT "
      + "RUN_BINDING=EXACT API_FACTS=COMPLETE",
    );
    expect(Object.keys(parseDiagnostic(result.logs[0]))).toEqual(FIELD_ORDER);
  });

  it.each([
    ["INVALID", (state) => { state.env.GITHUB_WORKFLOW_REF = `${WORKFLOW_LOCATION}@`; }],
    ["OTHER_REPOSITORY_OR_PATH", (state) => {
      state.env.GITHUB_WORKFLOW_REF = `Elsewhere/AAIS/${WORKFLOW_PATH}@refs/heads/main`;
    }],
    ["MAIN_BRANCH", () => {}],
    ["RECOVERY_BRANCH", (state) => {
      state.env.GITHUB_WORKFLOW_REF = `${WORKFLOW_LOCATION}@refs/heads/${RECOVERY_BRANCH}`;
    }],
    ["MAIN_AND_PR_HEAD_SHA_LITERAL", (state) => {
      state.responses.pr.head.sha = state.responses.main.object.sha;
      state.responses.run.head_sha = state.responses.main.object.sha;
      state.responses.deployment.sha = state.responses.main.object.sha;
      state.env.GITHUB_WORKFLOW_REF = `${WORKFLOW_LOCATION}@${state.responses.main.object.sha}`;
    }],
    ["MAIN_SHA_LITERAL", (state) => {
      state.env.GITHUB_WORKFLOW_REF = `${WORKFLOW_LOCATION}@${state.responses.main.object.sha}`;
    }],
    ["PR_HEAD_SHA_LITERAL", (state) => {
      state.env.GITHUB_WORKFLOW_REF = `${WORKFLOW_LOCATION}@${state.responses.pr.head.sha}`;
    }],
    ["REFERENCE_FACTS_UNAVAILABLE", (state) => {
      state.errors.main = new Error(PRIVATE_MARKER);
      state.env.GITHUB_WORKFLOW_REF = `${WORKFLOW_LOCATION}@${"d".repeat(40)}`;
    }],
    ["OTHER_SHA_LITERAL", (state) => {
      state.env.GITHUB_WORKFLOW_REF = `${WORKFLOW_LOCATION}@${"d".repeat(40)}`;
    }],
    ["SAME_REPO_PATH_OTHER_REF", (state) => {
      state.env.GITHUB_WORKFLOW_REF = `${WORKFLOW_LOCATION}@refs/heads/feature`;
    }],
  ])("classifies WORKFLOW_REF=%s", async (expected, mutate) => {
    const result = await runDiagnostic(mutate);
    expectFixedStop(result);
    expect(parseDiagnostic(result.logs[0]).WORKFLOW_REF).toBe(expected);
  });

  it("keeps printable whitespace in an exact-location suffix as a safe other ref", async () => {
    const result = await runDiagnostic((state) => {
      state.env.GITHUB_WORKFLOW_REF = `${WORKFLOW_LOCATION}@refs/heads/feature branch`;
    });
    expectFixedStop(result);
    expect(parseDiagnostic(result.logs[0]).WORKFLOW_REF).toBe("SAME_REPO_PATH_OTHER_REF");
  });

  it.each([
    ["missing @", `${WORKFLOW_LOCATION}refs/heads/main`],
    ["two @", `${WORKFLOW_LOCATION}@refs/heads@main`],
    ["control", `${WORKFLOW_LOCATION}@refs/heads/main\n${PRIVATE_MARKER}`],
    ["over 512 code units", `${WORKFLOW_LOCATION}@${"x".repeat(513)}`],
    [
      "empty location component",
      `Elsewhere/AAIS/.github//workflows/preview-e2e.yml@refs/heads/main`,
    ],
    [
      "trailing location slash",
      `Elsewhere/AAIS/.github/workflows/@refs/heads/main`,
    ],
  ])("rejects WORKFLOW_REF common-syntax case %s without disclosure", async (_name, value) => {
    const result = await runDiagnostic((state) => {
      state.env.GITHUB_WORKFLOW_REF = value;
    });
    expectFixedStop(result);
    expect(parseDiagnostic(result.logs[0]).WORKFLOW_REF).toBe("INVALID");
    expect(observable(result)).not.toContain(PRIVATE_MARKER);
  });

  for (const field of ["GITHUB_WORKFLOW_SHA", "GITHUB_SHA"]) {
    const diagnosticField = field === "GITHUB_WORKFLOW_SHA" ? "WORKFLOW_SHA" : "GITHUB_SHA";
    it.each([
      ["INVALID", (state) => { state.env[field] = "A".repeat(40); }],
      ["REFERENCE_FACTS_UNAVAILABLE", (state) => {
        state.errors.main = new Error(PRIVATE_MARKER);
        state.env[field] = "d".repeat(40);
      }],
      ["MAIN_AND_PR_HEAD", (state) => {
        state.responses.pr.head.sha = state.responses.main.object.sha;
        state.responses.run.head_sha = state.responses.main.object.sha;
        state.responses.deployment.sha = state.responses.main.object.sha;
        state.env[field] = state.responses.main.object.sha;
      }],
      ["MAIN_TIP", (state) => { state.env[field] = state.responses.main.object.sha; }],
      ["PR_HEAD", (state) => { state.env[field] = state.responses.pr.head.sha; }],
      ["OTHER_SHA", (state) => { state.env[field] = "d".repeat(40); }],
    ])(`classifies ${diagnosticField}=%s`, async (expected, mutate) => {
      const result = await runDiagnostic(mutate);
      expectFixedStop(result);
      expect(parseDiagnostic(result.logs[0])[diagnosticField]).toBe(expected);
    });
  }

  it.each([
    ["INVALID", (state) => { state.responses.deployment.ref = ""; }],
    ["REFERENCE_FACTS_UNAVAILABLE", (state) => {
      state.errors.main = new Error(PRIVATE_MARKER);
      state.responses.deployment.ref = "d".repeat(40);
    }],
    ["MAIN_AND_PR_HEAD_SHA", (state) => {
      state.responses.pr.head.sha = state.responses.main.object.sha;
      state.responses.run.head_sha = state.responses.main.object.sha;
      state.responses.deployment.sha = state.responses.main.object.sha;
      state.responses.deployment.ref = state.responses.main.object.sha;
    }],
    ["PR_HEAD_SHA", (state) => {
      state.responses.deployment.ref = state.responses.pr.head.sha;
    }],
    ["MAIN_TIP_SHA", (state) => {
      state.responses.deployment.ref = state.responses.main.object.sha;
    }],
    ["OTHER_SHA", (state) => { state.responses.deployment.ref = "d".repeat(40); }],
    ["RECOVERY_BRANCH", () => {}],
    ["MAIN_BRANCH", (state) => { state.responses.deployment.ref = DEFAULT_BRANCH; }],
    ["OTHER_REF", (state) => { state.responses.deployment.ref = "feature/diagnostic"; }],
  ])("classifies DEPLOYMENT_REF=%s", async (expected, mutate) => {
    const result = await runDiagnostic(mutate);
    expectFixedStop(result);
    expect(parseDiagnostic(result.logs[0]).DEPLOYMENT_REF).toBe(expected);
  });

  it.each([
    ["ALL_EQUAL", ["same", "same", "same"]],
    ["SOURCE_MAIN_ONLY", ["same", "same", "pr"]],
    ["SOURCE_PR_ONLY", ["same", "main", "same"]],
    ["MAIN_PR_ONLY", ["source", "same", "same"]],
    ["ALL_DIFFERENT", ["source", "main", "pr"]],
  ])("classifies WORKFLOW_BLOBS=%s using blob SHA plus exact bytes", async (expected, labels) => {
    const identities = {
      same: ["1".repeat(40), Buffer.from("same workflow")],
      source: ["2".repeat(40), Buffer.from("source workflow")],
      main: ["3".repeat(40), Buffer.from("main workflow")],
      pr: ["4".repeat(40), Buffer.from("pr workflow")],
    };
    const result = await runDiagnostic((state) => {
      ["sourceFile", "mainFile", "prFile"].forEach((group, index) => {
        const [sha, bytes] = identities[labels[index]];
        state.responses[group] = workflowFile(sha, bytes);
      });
    });
    expectFixedStop(result);
    expect(parseDiagnostic(result.logs[0]).WORKFLOW_BLOBS).toBe(expected);
  });

  it.each([
    ["short single-line terminal LF", Buffer.from("short workflow")],
    ["exact 60-column terminal LF", Buffer.alloc(45, 0x61)],
    ["60-column wrapping without terminal LF", Buffer.alloc(100, 0x62)],
    ["60-column wrapping with terminal LF", Buffer.alloc(100, 0x63)],
  ])("accepts canonical GitHub base64 form: %s", async (name, bytes) => {
    const terminalLf = name !== "60-column wrapping without terminal LF";
    const sha = "1".repeat(40);
    const result = await runDiagnostic((state) => {
      state.responses.sourceFile = workflowFile(
        sha,
        bytes,
        githubBase64(bytes, { terminalLf }),
      );
      state.responses.mainFile = workflowFile(sha, bytes);
      state.responses.prFile = workflowFile(sha, bytes);
    });
    expectFixedStop(result);
    expect(parseDiagnostic(result.logs[0]).WORKFLOW_BLOBS).toBe("ALL_EQUAL");
    expect(parseDiagnostic(result.logs[0]).API_FACTS).toBe("COMPLETE");
  });

  it.each([
    ["arbitrary 56-column wrapping", (compact) => wrapBase64(compact, 56, true)],
    ["CRLF wrapping", (compact) => wrapBase64(compact, 60, true).replaceAll("\n", "\r\n")],
    ["embedded space", (compact) => `${compact.slice(0, 60)} ${compact.slice(60)}`],
    ["embedded tab", (compact) => `${compact.slice(0, 60)}\t${compact.slice(60)}`],
    ["internal LF away from a 60-column boundary", (compact) => {
      return `${compact.slice(0, 20)}\n${compact.slice(20)}`;
    }],
    ["overlong single line with terminal LF", (compact) => `${compact}\n`],
    ["blank LF data line", (compact) => wrapBase64(compact, 60, true).replace("\n", "\n\n")],
  ])("rejects noncanonical GitHub base64 form: %s", async (_name, mutateContent) => {
    const bytes = Buffer.alloc(100, 0x64);
    const result = await runDiagnostic((state) => {
      state.responses.sourceFile = workflowFile(
        "1".repeat(40),
        bytes,
        mutateContent(bytes.toString("base64")),
      );
    });
    expectFixedStop(result);
    expect(parseDiagnostic(result.logs[0]).WORKFLOW_BLOBS).toBe("UNAVAILABLE");
    expect(parseDiagnostic(result.logs[0]).API_FACTS).toBe("PARTIAL");
  });

  it.each([
    ["same bytes with different blob SHA", (state) => {
      const bytes = Buffer.from("identical bytes");
      state.responses.sourceFile = workflowFile("1".repeat(40), bytes);
      state.responses.mainFile = workflowFile("2".repeat(40), bytes);
    }],
    ["same blob SHA with different bytes", (state) => {
      state.responses.sourceFile = workflowFile("1".repeat(40), Buffer.from("one"));
      state.responses.mainFile = workflowFile("1".repeat(40), Buffer.from("two"));
    }],
  ])("requires both workflow-file identity dimensions: %s", async (_name, mutate) => {
    const result = await runDiagnostic(mutate);
    expectFixedStop(result);
    expect(parseDiagnostic(result.logs[0]).WORKFLOW_BLOBS).toBe("ALL_DIFFERENT");
  });

  it.each([
    ["array instead of one file", (_file, state) => { state.responses.sourceFile = []; }],
    ["non-file type", (file) => { file.type = "dir"; }],
    ["wrong path", (file) => { file.path = `${WORKFLOW_PATH}.private`; }],
    ["uppercase blob SHA", (file) => { file.sha = "A".repeat(40); }],
    ["negative size", (file) => { file.size = -1; }],
    ["unsafe-integer size", (file) => { file.size = Number.MAX_SAFE_INTEGER + 1; }],
    ["string size", (file) => { file.size = "15"; }],
    ["wrong encoding", (file) => { file.encoding = "utf-8"; }],
    ["noncanonical base64", (file) => { file.content = "YQ"; file.size = 1; }],
    ["invalid base64", (file) => { file.content = "%%%%"; file.size = 0; }],
    ["decoded-size mismatch", (file) => { file.size += 1; }],
  ])("makes WORKFLOW_BLOBS unavailable for %s", async (_name, mutate) => {
    const result = await runDiagnostic((state) => {
      mutate(state.responses.sourceFile, state);
    });
    expectFixedStop(result);
    expect(parseDiagnostic(result.logs[0]).WORKFLOW_BLOBS).toBe("UNAVAILABLE");
  });

  it.each([
    ["run ID differs", (state) => { state.responses.run.id += 1; }],
    ["runner run ID differs", (state) => { state.env.GITHUB_RUN_ID = "778"; }],
    ["event differs", (state) => { state.responses.run.event = "push"; }],
    ["workflow ID differs", (state) => { state.responses.run.workflow_id += 1; }],
    ["workflow path differs", (state) => { state.responses.run.path = `${WORKFLOW_PATH}.other`; }],
    ["repository differs", (state) => { state.responses.run.repository.full_name = "Elsewhere/AAIS"; }],
    ["head branch differs", (state) => { state.responses.run.head_branch = "feature"; }],
    ["head SHA differs", (state) => { state.responses.run.head_sha = "d".repeat(40); }],
    ["actor differs", (state) => { state.responses.run.actor = otherActor(); }],
    ["triggering actor differs", (state) => { state.responses.run.triggering_actor = otherActor(); }],
  ])("classifies complete RUN_BINDING mismatch: %s", async (_name, mutate) => {
    const result = await runDiagnostic(mutate);
    expectFixedStop(result);
    expect(parseDiagnostic(result.logs[0]).RUN_BINDING).toBe("MISMATCH");
  });

  it.each([
    ["run API error", (state) => { state.errors.run = new Error(PRIVATE_MARKER); }],
    ["invalid context run ID", (state) => { state.context.runId = "777"; }],
    ["invalid runner run ID", (state) => { state.env.GITHUB_RUN_ID = "0777"; }],
    ["string response run ID", (state) => { state.responses.run.id = "777"; }],
    ["string response workflow ID", (state) => { state.responses.run.workflow_id = "309746229"; }],
    ["incomplete actor", (state) => { delete state.responses.run.actor.node_id; }],
    ["incomplete triggering actor", (state) => {
      delete state.responses.run.triggering_actor.node_id;
    }],
    ["unavailable PR head", (state) => { state.errors.pr = new Error(PRIVATE_MARKER); }],
  ])("classifies RUN_BINDING unavailable: %s", async (_name, mutate) => {
    const result = await runDiagnostic(mutate);
    expectFixedStop(result);
    expect(parseDiagnostic(result.logs[0]).RUN_BINDING).toBe("UNAVAILABLE");
    expect(observable(result)).not.toContain(PRIVATE_MARKER);
  });

  it("calls the ten read-only API groups with fixed repository and immutable refs", async () => {
    const result = await runDiagnostic();
    expectFixedStop(result);
    expect(result.mocks.repository).toHaveBeenCalledWith({ owner: OWNER, repo: REPO });
    expect(result.mocks.main).toHaveBeenCalledWith({
      owner: OWNER,
      repo: REPO,
      ref: `heads/${DEFAULT_BRANCH}`,
    });
    expect(result.mocks.workflow).toHaveBeenCalledWith({
      owner: OWNER,
      repo: REPO,
      workflow_id: WORKFLOW_ID,
    });
    expect(result.mocks.pr).toHaveBeenCalledWith({
      owner: OWNER,
      repo: REPO,
      pull_number: 5,
    });
    expect(result.mocks.run).toHaveBeenCalledWith({
      owner: OWNER,
      repo: REPO,
      run_id: 777,
    });
    expect(result.mocks.deployment).toHaveBeenCalledWith({
      owner: OWNER,
      repo: REPO,
      deployment_id: 101,
    });
    expect(result.mocks.deploymentStatus).toHaveBeenCalledWith({
      owner: OWNER,
      repo: REPO,
      deployment_id: 101,
      status_id: 202,
    });
    expect(result.mocks.getContent).toHaveBeenCalledTimes(3);
    expect(result.mocks.getContent.mock.calls.map(([args]) => args)).toEqual([
      { owner: OWNER, repo: REPO, path: WORKFLOW_PATH, ref: "c".repeat(40) },
      { owner: OWNER, repo: REPO, path: WORKFLOW_PATH, ref: "b".repeat(40) },
      { owner: OWNER, repo: REPO, path: WORKFLOW_PATH, ref: "a".repeat(40) },
    ]);
  });

  it.each([
    "repository",
    "main",
    "workflow",
    "pr",
    "run",
    "deployment",
    "deploymentStatus",
    "sourceFile",
    "mainFile",
    "prFile",
  ])("catches %s API errors as fixed partial facts without disclosure", async (group) => {
    const result = await runDiagnostic((state) => {
      state.errors[group] = new Error(`${PRIVATE_MARKER}-${group}`);
    });
    expectFixedStop(result);
    expect(parseDiagnostic(result.logs[0]).API_FACTS).toBe("PARTIAL");
    expect(observable(result)).not.toContain(PRIVATE_MARKER);
  });

  it.each([
    ["repository", (state) => { state.responses.repository = { full_name: REPOSITORY }; }],
    ["main", (state) => { state.responses.main.object.sha = "B".repeat(40); }],
    ["workflow", (state) => { state.responses.workflow.id = "309746229"; }],
    ["PR", (state) => { state.responses.pr.number = "5"; }],
    ["run", (state) => { delete state.responses.run.repository.full_name; }],
    ["deployment", (state) => { state.responses.deployment.id = "101"; }],
    ["deployment status", (state) => { state.responses.deploymentStatus.id = "202"; }],
  ])("marks malformed %s API shape partial", async (_name, mutate) => {
    const result = await runDiagnostic(mutate);
    expectFixedStop(result);
    expect(parseDiagnostic(result.logs[0]).API_FACTS).toBe("PARTIAL");
  });

  it.each([
    ["deployment creator", (state) => { delete state.responses.deployment.creator.node_id; }],
    ["deployment-status creator", (state) => {
      delete state.responses.deploymentStatus.creator.node_id;
    }],
  ])("requires a complete usable %s actor before its API group counts", async (_name, mutate) => {
    const result = await runDiagnostic(mutate);
    expectFixedStop(result);
    expect(parseDiagnostic(result.logs[0]).API_FACTS).toBe("PARTIAL");
  });

  it("counts complete non-Vercel deployment creators as usable API facts", async () => {
    const result = await runDiagnostic((state) => {
      state.responses.deployment.creator = otherActor();
      state.responses.deploymentStatus.creator = otherActor();
    });
    expectFixedStop(result);
    expect(parseDiagnostic(result.logs[0]).API_FACTS).toBe("COMPLETE");
  });

  it("reports API_FACTS unavailable only when none of the ten groups is usable", async () => {
    const result = await runDiagnostic((state) => {
      for (const group of [
        "repository",
        "main",
        "workflow",
        "pr",
        "run",
        "deployment",
        "deploymentStatus",
        "sourceFile",
        "mainFile",
        "prFile",
      ]) {
        state.errors[group] = new Error(`${PRIVATE_MARKER}-${group}`);
      }
    });
    expectFixedStop(result);
    expect(parseDiagnostic(result.logs[0]).API_FACTS).toBe("UNAVAILABLE");
    expect(observable(result)).not.toContain(PRIVATE_MARKER);
  });

  it("never discloses private extras from any otherwise usable API response", async () => {
    const result = await runDiagnostic((state) => {
      for (const response of Object.values(state.responses)) {
        if (response && typeof response === "object" && !Array.isArray(response)) {
          response.private = PRIVATE_MARKER;
        }
      }
      state.env.GITHUB_WORKFLOW_REF = `${WORKFLOW_LOCATION}@refs/heads/${PRIVATE_MARKER}`;
      state.responses.deployment.ref = `feature/${PRIVATE_MARKER}`;
    });
    expectFixedStop(result);
    expect(observable(result)).not.toContain(PRIVATE_MARKER);
  });
});

describe("disabled Stage-B schema and projection remain unchanged", () => {
  it("uses only the normalized Stage-A hostname as the Vercel idOrUrl", () => {
    const stageB = stageBBlock();

    expect(stageB).toContain("https://api.vercel.com/v13/deployments/");
    expect(stageB).toContain("teamId=team_i9xhhYXUeYBOCLcfWBjTqlYG");
    expect(stageB).toContain("encodeURIComponent(process.env.VERCEL_HOSTNAME)");
    expect(stageB).not.toMatch(/encodeURIComponent\(process\.env\.GITHUB_DEPLOYMENT_(?:STATUS_)?ID\)/);
    expect(stageB).toContain("redirect: \"manual\"");
    expect(stageB).toContain("Authorization: `Bearer ${token}`");
  });

  it("allowlists and validates the exact Vercel deployment identity projection", () => {
    const stageB = stageBBlock();

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
      RECOVERY_BRANCH,
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

  it("projects reviewed Vercel fields while ignoring and never printing raw response extras", () => {
    const deployment = validVercelDeployment();
    deployment.createdAt = 1_752_000_000_000;
    deployment.creator = { uid: "official-like-creator-marker", username: "vercel-bot" };
    deployment.project = { id: "prj_contradictory_raw_project", name: "official-like-project-marker" };
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
    ["contradictory reviewed project ID", (deployment) => {
      deployment.projectId = "prj_contradictory";
    }],
    ["contradictory reviewed Git SHA", (deployment) => {
      deployment.gitSource.sha = "b".repeat(40);
    }],
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

function stageABlock() {
  const start = workflow.indexOf("- name: Stage A - ");
  const end = workflow.indexOf("- name: Stage B - attest Vercel deployment");
  expect(start).toBeGreaterThan(-1);
  expect(end).toBeGreaterThan(start);
  return workflow.slice(start, end);
}

function stageBBlock() {
  const start = workflow.indexOf("- name: Stage B - attest Vercel deployment");
  const end = workflow.indexOf("- name: Stage C - checkout attested commit");
  expect(start).toBeGreaterThan(-1);
  expect(end).toBeGreaterThan(start);
  return workflow.slice(start, end);
}

function stageBRunBody() {
  const stageBStart = workflow.indexOf("- name: Stage B - attest Vercel deployment");
  const marker = "        run: |\n";
  const start = workflow.indexOf(marker, stageBStart) + marker.length;
  const end = workflow.indexOf("\n\n  preview-e2e:", start);
  expect(stageBStart).toBeGreaterThan(-1);
  expect(start).toBeGreaterThan(marker.length - 1);
  expect(end).toBeGreaterThan(start);
  return workflow.slice(start, end);
}

function stageAScript() {
  const stageA = stageABlock();
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

async function runDiagnostic(mutate = () => {}) {
  const state = validDiagnosticState();
  mutate(state);
  const mocks = {};
  const makeCall = (group) => vi.fn(async () => {
    if (Object.prototype.hasOwnProperty.call(state.errors, group)) {
      throw state.errors[group];
    }
    return { data: state.responses[group] };
  });
  for (const group of [
    "repository",
    "main",
    "workflow",
    "pr",
    "run",
    "deployment",
    "deploymentStatus",
  ]) {
    mocks[group] = makeCall(group);
  }
  mocks.getContent = vi.fn(async (args) => {
    const group = fileGroupForRef(state, args?.ref);
    if (Object.prototype.hasOwnProperty.call(state.errors, group)) {
      throw state.errors[group];
    }
    return { data: state.responses[group] };
  });
  const github = {
    rest: {
      actions: {
        getWorkflow: mocks.workflow,
        getWorkflowRun: mocks.run,
      },
      git: { getRef: mocks.main },
      pulls: { get: mocks.pr },
      repos: {
        get: mocks.repository,
        getContent: mocks.getContent,
        getDeployment: mocks.deployment,
        getDeploymentStatus: mocks.deploymentStatus,
      },
    },
  };
  const logs = [];
  const errors = [];
  const outputs = [];
  const consoleStub = {
    log: vi.fn((value) => logs.push(value)),
    error: vi.fn((value) => errors.push(value)),
    warn: vi.fn((value) => errors.push(value)),
    dir: vi.fn((value) => errors.push(value)),
  };
  const core = {
    error: vi.fn((value) => errors.push(value)),
    setFailed: vi.fn((value) => errors.push(value)),
    setOutput: vi.fn((name, value) => outputs.push([name, value])),
    warning: vi.fn((value) => errors.push(value)),
  };
  const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
  const execute = new AsyncFunction(
    "context",
    "github",
    "core",
    "process",
    "console",
    stageAScript(),
  );
  let thrown;
  try {
    await execute(state.context, github, core, { env: state.env }, consoleStub);
  } catch (error) {
    thrown = error;
  }
  return { errors, logs, mocks, outputs, state, thrown };
}

function fileGroupForRef(state, ref) {
  if (ref === state.env.GITHUB_WORKFLOW_SHA) return "sourceFile";
  if (ref === state.responses.main?.object?.sha) return "mainFile";
  if (ref === state.responses.pr?.head?.sha) return "prFile";
  return "sourceFile";
}

function validDiagnosticState() {
  const prSha = "a".repeat(40);
  const mainSha = "b".repeat(40);
  const sourceSha = "c".repeat(40);
  const actor = vercelActor();
  return {
    context: {
      eventName: "deployment_status",
      repo: { owner: OWNER, repo: REPO },
      runId: 777,
      payload: {
        deployment: { id: 101 },
        deployment_status: { id: 202 },
      },
    },
    env: {
      GITHUB_WORKFLOW_REF: `${WORKFLOW_LOCATION}@refs/heads/main`,
      GITHUB_WORKFLOW_SHA: sourceSha,
      GITHUB_SHA: prSha,
      GITHUB_RUN_ID: "777",
    },
    errors: {},
    responses: {
      repository: { full_name: REPOSITORY, default_branch: DEFAULT_BRANCH },
      main: {
        ref: `refs/heads/${DEFAULT_BRANCH}`,
        object: { type: "commit", sha: mainSha },
      },
      workflow: { id: WORKFLOW_ID, path: WORKFLOW_PATH, state: "active" },
      pr: {
        number: 5,
        state: "open",
        base: { ref: DEFAULT_BRANCH, repo: { full_name: REPOSITORY } },
        head: { ref: RECOVERY_BRANCH, sha: prSha, repo: { full_name: REPOSITORY } },
      },
      run: {
        id: 777,
        event: "deployment_status",
        workflow_id: WORKFLOW_ID,
        path: WORKFLOW_PATH,
        repository: { full_name: REPOSITORY },
        head_branch: RECOVERY_BRANCH,
        head_sha: prSha,
        actor: { ...actor },
        triggering_actor: { ...actor },
      },
      deployment: {
        id: 101,
        ref: RECOVERY_BRANCH,
        sha: prSha,
        creator: { ...actor },
      },
      deploymentStatus: {
        id: 202,
        state: "success",
        creator: { ...actor },
      },
      sourceFile: workflowFile("d".repeat(40), Buffer.from("source workflow")),
      mainFile: workflowFile("e".repeat(40), Buffer.from("main workflow")),
      prFile: workflowFile("f".repeat(40), Buffer.from("pr workflow")),
    },
  };
}

function workflowFile(sha, bytes, content = bytes.toString("base64")) {
  return {
    type: "file",
    path: WORKFLOW_PATH,
    sha,
    size: bytes.length,
    encoding: "base64",
    content,
  };
}

function githubBase64(bytes, { terminalLf }) {
  return wrapBase64(bytes.toString("base64"), 60, terminalLf);
}

function wrapBase64(compact, width, terminalLf) {
  const lines = [];
  for (let offset = 0; offset < compact.length; offset += width) {
    lines.push(compact.slice(offset, offset + width));
  }
  return `${lines.join("\n")}${terminalLf ? "\n" : ""}`;
}

function vercelActor() {
  return {
    login: "vercel[bot]",
    id: 35613825,
    node_id: "MDM6Qm90MzU2MTM4MjU=",
    type: "Bot",
  };
}

function otherActor() {
  return {
    login: "other[bot]",
    id: 42,
    node_id: "OTHER_NODE_ID",
    type: "Bot",
  };
}

function parseDiagnostic(line) {
  expect(typeof line).toBe("string");
  const prefix = "AAIS_PREVIEW_CONTEXT_DIAG ";
  expect(line.startsWith(prefix)).toBe(true);
  return Object.fromEntries(
    line.slice(prefix.length).split(" ").map((pair) => pair.split("=")),
  );
}

function expectFixedStop(result) {
  expect(result.thrown).toBeInstanceOf(Error);
  expect(result.thrown?.message).toBe(STOP);
  expect(result.logs).toHaveLength(1);
  expect(result.errors).toEqual([]);
  expect(result.outputs).toEqual([]);
}

function observable(result) {
  return [
    ...result.logs,
    ...result.errors,
    ...result.outputs.flat(),
    result.thrown?.message,
  ].join("\n");
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
      ref: RECOVERY_BRANCH,
      sha: "a".repeat(40),
    },
    meta: {
      githubOrg: OWNER,
      githubRepo: REPO,
      githubCommitRef: RECOVERY_BRANCH,
      githubCommitSha: "a".repeat(40),
    },
  };
}

function runStageB(deployment) {
  const stageB = stageBBlock();
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
