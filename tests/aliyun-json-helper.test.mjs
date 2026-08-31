import { spawnSync } from "node:child_process";
import {
  chmodSync,
  linkSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const helper = resolve("deploy/aliyun/aais-json-v1.py");
const python = "/usr/bin/python3";
const releaseSha = "a".repeat(40);
const digest = `sha256:${"b".repeat(64)}`;
const repository = "ghcr.io/hudongpin/aais";
const bundle = "bundle-20260831.v1";
const containerId = "c".repeat(12);
const upstreamSha = "d".repeat(64);
const vhostSha = "e".repeat(64);
const deployedAt = "2026-08-31T04:05:06Z";
const genericError = "AAIS JSON validation failed.\n";
const temporaryDirectories = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

function temporaryDirectory() {
  const directory = mkdtempSync(join(tmpdir(), "aais-json-helper-"));
  temporaryDirectories.push(directory);
  return directory;
}

function run(args, { input } = {}) {
  return spawnSync(
    "/usr/bin/env",
    [
      "-i",
      "LC_ALL=C",
      "LANG=C",
      "HOME=/",
      "TZ=UTC",
      python,
      "-I",
      "-S",
      "-B",
      helper,
      ...args,
    ],
    { encoding: "utf8", input },
  );
}

function candidate(overrides = {}) {
  return {
    schemaVersion: 1,
    provider: "github",
    stage: "ghcr_candidate",
    gitSha: releaseSha,
    imageRepository: repository,
    imageTag: `${repository}:${releaseSha}`,
    imageDigest: digest,
    githubRunId: "123456",
    githubRunAttempt: "2",
    packageVisibility: "private",
    sbomGenerated: true,
    provenanceGenerated: true,
    provenanceAttestationId: "attestation-123:v1",
    secrets: "redacted",
    ...overrides,
  };
}

function preloaded(overrides = {}) {
  return {
    schemaVersion: 1,
    provider: "github",
    stage: "ghcr_preloaded",
    gitSha: releaseSha,
    imageRepository: repository,
    imageDigest: digest,
    localRepoDigest: `${repository}@${digest}`,
    imageRevision: releaseSha,
    candidateRunId: "123456",
    candidateRunAttempt: "2",
    pulledAt: "2026-08-31T03:04:05Z",
    credentialsCleaned: true,
    secrets: "redacted",
    ...overrides,
  };
}

function deployment(overrides = {}) {
  return {
    schemaVersion: 1,
    provider: "aliyun",
    imageSource: "ghcr-preloaded",
    gitSha: releaseSha,
    imageDigest: digest,
    secretBundleVersion: bundle,
    container: "aais-blue",
    containerId,
    color: "blue",
    port: 3101,
    nginxUpstreamSha256: upstreamSha,
    nginxVhostSha256: vhostSha,
    deployedAt,
    secrets: "redacted",
    ...overrides,
  };
}

function writeJson(value, raw, mode = 0o644) {
  const path = join(temporaryDirectory(), "receipt.json");
  writeFileSync(path, raw ?? `${JSON.stringify(value)}\n`, { mode });
  chmodSync(path, mode);
  return path;
}

function runFileSafetyProbe(path, scenario, swapPath = "-") {
  const probe = String.raw`
import importlib.util
import os
import sys

helper_path, receipt_path, scenario, swap_path = sys.argv[1:]
spec = importlib.util.spec_from_file_location("aais_json_v1", helper_path)
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)
real_lstat = module.os.lstat
real_fstat = module.os.fstat
real_open = module.os.open
real_read = module.os.read

class StatProxy(object):
    def __init__(self, value, uid=None, mode=None):
        self.st_mode = value.st_mode if mode is None else mode
        self.st_nlink = value.st_nlink
        self.st_size = value.st_size
        self.st_dev = value.st_dev
        self.st_ino = value.st_ino
        self.st_uid = value.st_uid if uid is None else uid

if scenario == "owner-lstat":
    module.os.lstat = lambda value: StatProxy(
        real_lstat(value), uid=module.os.geteuid() + 1)
elif scenario in ("owner-opened", "owner-after"):
    calls = [0]
    def synthetic_fstat(descriptor):
        calls[0] += 1
        value = real_fstat(descriptor)
        selected = ((scenario == "owner-opened" and calls[0] == 1)
                    or (scenario == "owner-after" and calls[0] == 2))
        return StatProxy(value, uid=module.os.geteuid() + 1) if selected else value
    module.os.fstat = synthetic_fstat
elif scenario == "inode-swap":
    def swapped_open(value, flags):
        module.os.replace(swap_path, value)
        return real_open(value, flags)
    module.os.open = swapped_open
elif scenario == "mode-after":
    changed = [False]
    def changing_read(descriptor, size):
        value = real_read(descriptor, size)
        if not changed[0]:
            module.os.chmod(receipt_path, 0o666)
            changed[0] = True
        return value
    module.os.read = changing_read

try:
    module.read_file_json(receipt_path)
except module.ValidationError:
    sys.exit(0)
except BaseException:
    sys.exit(2)
sys.exit(9)
`;
  return spawnSync(
    python,
    ["-I", "-S", "-B", "-c", probe, helper, path, scenario, swapPath],
    { encoding: "utf8" },
  );
}

function candidateResult(value, options = {}) {
  const path = options.path ?? writeJson(value);
  return run([
    "candidate-metadata",
    path,
    options.sha ?? releaseSha,
    options.expectedDigest ?? digest,
  ]);
}

function expectGenericFailure(result, canaries = []) {
  expect(result.status).not.toBe(0);
  expect(result.stdout).toBe("");
  expect(result.stderr).toBe(genericError);
  for (const canary of canaries) {
    expect(result.stderr).not.toContain(canary);
  }
}

describe("AAIS strict ECS JSON helper", () => {
  it("requires isolated CPython 3.6+ with site and bytecode disabled", () => {
    expect(run(["self-test"])).toMatchObject({ status: 0, stdout: "", stderr: "" });

    const withoutFlags = spawnSync(python, [helper, "self-test"], {
      encoding: "utf8",
    });
    expectGenericFailure(withoutFlags);
  });

  it("accepts and extracts one exact candidate object", () => {
    const path = writeJson(candidate());
    const derived = run(["candidate-metadata", path, releaseSha, "-"]);
    const pinned = run(["candidate-metadata", path, releaseSha, digest]);

    expect(derived).toMatchObject({
      status: 0,
      stdout: `${digest}\t123456\t2\n`,
      stderr: "",
    });
    expect(pinned).toMatchObject({
      status: 0,
      stdout: `${digest}\t123456\t2\n`,
      stderr: "",
    });
  });

  it.each([0o600, 0o644])("accepts protected receipt mode 0%o", (mode) => {
    const path = writeJson(candidate(), undefined, mode);
    expect(candidateResult(candidate(), { path })).toMatchObject({
      status: 0,
      stdout: `${digest}\t123456\t2\n`,
      stderr: "",
    });
  });

  it.each([0o400, 0o604, 0o640, 0o660, 0o664, 0o666])(
    "rejects receipt mode 0%o",
    (mode) => {
      const path = writeJson(candidate(), undefined, mode);
      expectGenericFailure(candidateResult(candidate(), { path }));
    },
  );

  it.each(["owner-lstat", "owner-opened", "owner-after"])(
    "rejects a synthetic non-euid owner at %s",
    (scenario) => {
      const path = writeJson(candidate());
      expect(runFileSafetyProbe(path, scenario)).toMatchObject({
        status: 0,
        stdout: "",
        stderr: "",
      });
    },
  );

  it("rejects inode replacement between lstat and the protected open", () => {
    const path = writeJson(candidate());
    const swapPath = `${path}.replacement`;
    writeFileSync(swapPath, `${JSON.stringify(candidate())}\n`, { mode: 0o644 });
    chmodSync(swapPath, 0o644);

    expect(runFileSafetyProbe(path, "inode-swap", swapPath)).toMatchObject({
      status: 0,
      stdout: "",
      stderr: "",
    });
  });

  it("rejects a mode change after the descriptor is opened", () => {
    const path = writeJson(candidate());
    expect(runFileSafetyProbe(path, "mode-after")).toMatchObject({
      status: 0,
      stdout: "",
      stderr: "",
    });
  });

  it("validates and canonically writes exact preloaded receipts", () => {
    const path = writeJson(preloaded());
    expect(run([
      "validate-preloaded",
      path,
      releaseSha,
      digest,
      "123456",
      "2",
    ])).toMatchObject({ status: 0, stdout: "", stderr: "" });

    const written = run([
      "write-preloaded",
      releaseSha,
      digest,
      "123456",
      "2",
      "2026-08-31T03:04:05Z",
    ]);
    expect(written.status).toBe(0);
    expect(written.stderr).toBe("");
    expect(written.stdout.endsWith("\n")).toBe(true);
    expect(written.stdout.trim().split("\n")).toHaveLength(1);
    const parsed = JSON.parse(written.stdout);
    const sorted = Object.fromEntries(
      Object.entries(parsed).sort(([left], [right]) => left.localeCompare(right)),
    );
    expect(written.stdout).toBe(`${JSON.stringify(sorted)}\n`);
    expect(parsed).toEqual(preloaded());
    const roundTripPath = writeJson(null, written.stdout);
    expect(run([
      "validate-preloaded",
      roundTripPath,
      releaseSha,
      digest,
      "123456",
      "2",
    ]).status).toBe(0);
  });

  it("validates exact live, traffic-ready, and public-ready responses", () => {
    const live = JSON.stringify({
      status: "live",
      releaseId: releaseSha,
      provider: "aliyun",
    });
    const traffic = JSON.stringify({
      status: "ready",
      releaseId: releaseSha,
      provider: "aliyun",
      deployment: "valid",
      database: "ok",
      schema: "current",
    });
    const publicReady = JSON.stringify({ status: "ready" });

    expect(run(["validate-live", releaseSha], { input: live }).status).toBe(0);
    expect(run(["validate-traffic-ready", releaseSha], { input: traffic }).status).toBe(0);
    expect(run(["validate-public-ready"], { input: publicReady }).status).toBe(0);
  });

  it.each([
    ["blue", "3101", "aais-blue", 3101],
    ["green", "3102", "aais-green", 3102],
  ])("canonically writes and validates one exact %s deployment receipt", (
    color,
    portText,
    container,
    port,
  ) => {
    const written = run([
      "write-deployment",
      releaseSha,
      digest,
      bundle,
      color,
      portText,
      containerId,
      upstreamSha,
      vhostSha,
      deployedAt,
    ]);

    expect(written.status).toBe(0);
    expect(written.stderr).toBe("");
    expect(written.stdout.trim().split("\n")).toHaveLength(1);
    const parsed = JSON.parse(written.stdout);
    expect(parsed).toEqual(deployment({ color, port, container }));
    expect(typeof parsed.port).toBe("number");
    const sorted = Object.fromEntries(
      Object.entries(parsed).sort(([left], [right]) => left.localeCompare(right)),
    );
    expect(written.stdout).toBe(`${JSON.stringify(sorted)}\n`);
    const path = writeJson(null, written.stdout);
    expect(run([
      "validate-deployment",
      path,
      releaseSha,
      digest,
      bundle,
      color,
      portText,
      containerId,
      upstreamSha,
      vhostSha,
      deployedAt,
    ])).toMatchObject({ status: 0, stdout: "", stderr: "" });
  });

  it.each([
    ["mismatched color and port", ["blue", "3102", containerId, upstreamSha, vhostSha, deployedAt]],
    ["uppercase container id", ["blue", "3101", "C".repeat(12), upstreamSha, vhostSha, deployedAt]],
    ["short container id", ["blue", "3101", "c".repeat(11), upstreamSha, vhostSha, deployedAt]],
    ["wrong upstream SHA", ["blue", "3101", containerId, "d".repeat(63), vhostSha, deployedAt]],
    ["wrong vhost SHA", ["blue", "3101", containerId, upstreamSha, "E".repeat(64), deployedAt]],
    ["invalid timestamp", ["blue", "3101", containerId, upstreamSha, vhostSha, "2026-02-30T00:00:00Z"]],
  ])("rejects deployment writer with %s", (_label, values) => {
    expectGenericFailure(run([
      "write-deployment",
      releaseSha,
      digest,
      bundle,
      ...values,
    ]));
  });

  it.each([
    ["missing key", () => {
      const value = deployment();
      delete value.secrets;
      return value;
    }],
    ["extra key", () => deployment({ extra: "rejected" })],
    ["boolean port", () => deployment({ port: true })],
    ["string port", () => deployment({ port: "3101" })],
    ["wrong container", () => deployment({ container: "aais-green" })],
  ])("rejects deployment receipt with %s", (_label, createValue) => {
    const path = writeJson(createValue());
    expectGenericFailure(run([
      "validate-deployment",
      path,
      releaseSha,
      digest,
      bundle,
      "blue",
      "3101",
      containerId,
      upstreamSha,
      vhostSha,
      deployedAt,
    ]));
  });

  it.each([
    ["missing key", () => {
      const value = candidate();
      delete value.secrets;
      return candidateResult(value);
    }],
    ["extra key", () => candidateResult(candidate({ unexpected: "value" }))],
    ["type confusion", () => candidateResult(candidate({ githubRunId: 123456 }))],
    ["true equals one confusion", () => candidateResult(candidate({ schemaVersion: true }))],
    ["wrong SHA", () => candidateResult(candidate(), { sha: "c".repeat(40) })],
    ["uppercase SHA", () => candidateResult(candidate({ gitSha: "A".repeat(40) }))],
    ["wrong digest", () => candidateResult(candidate(), {
      expectedDigest: `sha256:${"c".repeat(64)}`,
    })],
    ["wrong run id", () => candidateResult(candidate({ githubRunId: "run-123" }))],
    ["wrong attestation", () => candidateResult(candidate({
      provenanceAttestationId: "attestation/123",
    }))],
    ["Unicode confusable", () => candidateResult(candidate({ provider: "githуb" }))],
    ["lone surrogate", () => candidateResult(candidate({
      provenanceAttestationId: "attestation-\ud800",
    }))],
  ])("rejects candidate %s", (_label, createResult) => {
    expectGenericFailure(createResult());
  });

  it.each([
    ["literal duplicate", () => {
      const raw = JSON.stringify(candidate()).replace(
        `"gitSha":"${releaseSha}"`,
        `"gitSha":"${releaseSha}","gitSha":"${releaseSha}"`,
      );
      return candidateResult(candidate(), { path: writeJson(null, raw) });
    }],
    ["decoded escaped duplicate", () => {
      const raw = JSON.stringify(candidate()).replace(
        `"gitSha":"${releaseSha}"`,
        `"gitSha":"${releaseSha}","git\\u0053ha":"${releaseSha}"`,
      );
      return candidateResult(candidate(), { path: writeJson(null, raw) });
    }],
    ["multiple roots", () => candidateResult(candidate(), {
      path: writeJson(null, `${JSON.stringify(candidate())}\n{}`),
    })],
    ["trailing token", () => candidateResult(candidate(), {
      path: writeJson(null, `${JSON.stringify(candidate())} trailing`),
    })],
    ["NaN", () => candidateResult(candidate(), {
      path: writeJson(null, JSON.stringify(candidate()).replace("\"schemaVersion\":1", "\"schemaVersion\":NaN")),
    })],
    ["Infinity", () => candidateResult(candidate(), {
      path: writeJson(null, JSON.stringify(candidate()).replace("\"schemaVersion\":1", "\"schemaVersion\":Infinity")),
    })],
    ["negative Infinity", () => candidateResult(candidate(), {
      path: writeJson(null, JSON.stringify(candidate()).replace("\"schemaVersion\":1", "\"schemaVersion\":-Infinity")),
    })],
  ])("rejects non-single strict JSON with %s", (_label, createResult) => {
    expectGenericFailure(createResult());
  });

  it("rejects invalid UTF-8, a UTF-8 BOM, oversize input, and multiple hard links", () => {
    const invalidUtf8 = writeJson(null, Buffer.from([0xff, 0xfe, 0xfd]));
    const bom = writeJson(null, Buffer.concat([
      Buffer.from([0xef, 0xbb, 0xbf]),
      Buffer.from(JSON.stringify(candidate())),
    ]));
    const oversize = writeJson(null, `${JSON.stringify(candidate())}${" ".repeat(65537)}`);
    const linked = writeJson(candidate());
    linkSync(linked, `${linked}.second-link`);
    const symlinkTarget = writeJson(candidate());
    const symlink = `${symlinkTarget}.symlink`;
    symlinkSync(symlinkTarget, symlink);

    for (const path of [invalidUtf8, bom, oversize, linked, symlink]) {
      expectGenericFailure(candidateResult(candidate(), { path }));
    }
  });

  it.each([
    ["wrong SHA", { gitSha: "c".repeat(40) }],
    ["wrong digest", { imageDigest: `sha256:${"c".repeat(64)}` }],
    ["wrong run", { candidateRunAttempt: "999" }],
    ["invalid timestamp", { pulledAt: "2026-02-30T00:00:00Z" }],
    ["noncanonical timestamp", { pulledAt: "2026-08-31T03:04:05+00:00" }],
  ])("rejects preloaded receipt with %s", (_label, override) => {
    const path = writeJson(preloaded(override));
    expectGenericFailure(run([
      "validate-preloaded",
      path,
      releaseSha,
      digest,
      "123456",
      "2",
    ]));
  });

  it.each([
    ["a missing key", () => {
      const value = preloaded();
      delete value.secrets;
      return value;
    }],
    ["an extra key", () => preloaded({ extra: "rejected" })],
    ["boolean schemaVersion", () => preloaded({ schemaVersion: true })],
    ["numeric credentialsCleaned", () => preloaded({ credentialsCleaned: 1 })],
    ["numeric run id", () => preloaded({ candidateRunId: 123456 })],
  ])("rejects preloaded receipt with %s", (_label, createValue) => {
    const path = writeJson(createValue());
    expectGenericFailure(run([
      "validate-preloaded",
      path,
      releaseSha,
      digest,
      "123456",
      "2",
    ]));
  });

  it("rejects extra, mistyped, and mismatched readiness fields", () => {
    const invalidInputs = [
      [["validate-live", releaseSha], {
        status: "live",
        releaseId: releaseSha,
        provider: "aliyun",
        extra: true,
      }],
      [["validate-live", releaseSha], {
        status: "live",
        releaseId: true,
        provider: "aliyun",
      }],
      [["validate-traffic-ready", releaseSha], {
        status: "ready",
        releaseId: releaseSha,
        provider: "aliyun",
        deployment: "valid",
        database: "unavailable",
        schema: "current",
      }],
      [["validate-public-ready"], { status: "ready", provider: "aliyun" }],
      [["validate-public-ready"], {
        status: "not_ready",
        message: `spoof {\"status\":\"ready\",\"releaseId\":\"${releaseSha}\"}`,
      }],
    ];
    for (const [args, value] of invalidInputs) {
      expectGenericFailure(run(args, { input: JSON.stringify(value) }));
    }
  });

  it.each([
    ["empty input", ""],
    ["multiple roots", '{"status":"ready"}{}'],
    ["trailing input", '{"status":"ready"} trailing'],
    ["literal duplicate", '{"status":"ready","status":"ready"}'],
    ["escaped duplicate", '{"status":"ready","st\\u0061tus":"ready"}'],
    ["NaN", '{"status":NaN}'],
    ["Infinity", '{"status":Infinity}'],
    ["negative Infinity", '{"status":-Infinity}'],
    ["non-object", '[{"status":"ready"}]'],
    ["UTF-8 BOM", `\ufeff${JSON.stringify({ status: "ready" })}`],
    ["oversize", `${" ".repeat(65537)}${JSON.stringify({ status: "ready" })}`],
  ])("rejects runtime stdin with %s", (_label, input) => {
    expectGenericFailure(run(["validate-public-ready"], { input }));
  });

  it("never echoes a secret canary, rejected path, or rejected value", () => {
    const secret = "AAIS_SECRET_CANARY_DO_NOT_ECHO_49317";
    const path = writeJson(candidate({ provenanceAttestationId: `${secret}/invalid` }));
    const result = run(["candidate-metadata", path, releaseSha, digest]);

    expectGenericFailure(result, [secret, path, releaseSha, digest]);
    expect(readFileSync(path, "utf8")).toContain(secret);
  });
});
