import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const temporary = [];
afterAll(() => {
  for (const path of temporary) rmSync(path, { recursive: true, force: true });
});
function run(file, args, options = {}) {
  return spawnSync(file, args, { encoding: "utf8", timeout: 20000, ...options });
}

it("runs the same native decision core against offline fixtures", () => {
  const directory = mkdtempSync(join(tmpdir(), "aais-native-core-"));
  temporary.push(directory);
  const binary = join(directory, "core-test");
  const compilation = run("cc", ["-std=c11", "-Wall", "-Wextra", "-Werror", "-I", "native/launch-check",
    "native/launch-check/check.c", "tests/native/launch-check-core-test.c", "-o", binary]);
  expect(compilation.status, compilation.stderr).toBe(0);
  const result = run(binary, []);
  expect(result.status, result.stderr).toBe(0);
  expect(result.stdout).toContain("AAIS_NATIVE_CORE_CHECKS=75");
});

it("keeps the collector separate from credentials and live authorization", () => {
  const source = readFileSync("native/launch-check/main.c", "utf8");
  expect(source).toContain("sandbox_init(kSBXProfileNoNetwork, SANDBOX_NAMED");
  expect(source).toContain("kSecCSNoNetworkAccess");
  expect(source).toContain("proc_pidinfo");
  expect(source).toContain("SecCodeCheckValidity");
  expect(source).not.toMatch(/\b(?:getenv|read|fgets|scanf|getpass|socket|connect|send|recv|system|popen|execve|posix_spawn)\s*\(/);
  expect(source).not.toMatch(/SecItem|SecKeyCreate|LocalAuthentication|KERN_PROCARGS/);
  expect(source).toContain('authorizesLiveExecution\\\":false');
  const preload = readFileSync("deploy/aliyun/aais-preload-ghcr-image.sh", "utf8");
  expect(preload).toContain("aais_require_audited_owner_launcher || return 1");
  expect(preload).not.toContain("aais-launch-check");
});

describe.skipIf(process.platform !== "darwin")("actual macOS non-sensitive collector", () => {
  let binary;
  beforeAll(() => {
    const build = run("bash", ["scripts/build-aais-launch-check.sh"]);
    expect(build.status, build.stderr).toBe(0);
    binary = /^BINARY=(.+)$/m.exec(build.stdout)?.[1];
    expect(binary).toContain("/output/native-launch-check/build.");
    temporary.push(dirname(binary));
  });

  it("rejects the real test-runner ancestry without reading stdin", () => {
    const result = run(binary, [], { input: "offline-input-sentinel-not-a-credential" });
    expect(result.status, result.stderr).toBe(2);
    const report = JSON.parse(result.stdout);
    expect(report.status).toBe("denied");
    expect(report.authorizesLiveExecution).toBe(false);
    expect(report.humanIntentVerified).toBe(false);
    expect(report.credentialsRead).toBe(false);
    expect(report.networkSandbox).toBe("no-network");
    expect(report.issues).toContain("TTY_NOT_LOCAL_FOREGROUND");
    expect(report.issues).toContain("FORBIDDEN_ANCESTOR");
    expect(report.chain[0].codeValid).toBe(true);
    expect(result.stdout).not.toContain("offline-input-sentinel");
    expect(result.stdout).not.toContain("/Users/");
    expect(report.chain.every((item) => !Object.hasOwn(item, "argv") && !Object.hasOwn(item, "environment"))).toBe(true);
  });

  it("accepts no policy overrides or fixture-file arguments", () => {
    for (const arg of ["--allow", "--fixture", "--output", "--execute"]) {
      const result = run(binary, [arg]);
      expect(result.status).toBe(64);
      expect(JSON.parse(result.stdout).reason).toBe("ARGUMENTS_NOT_ALLOWED");
      expect(result.stdout).not.toContain(arg);
    }
  });

  it("imports no direct credential-input, network or child-execution functions", () => {
    const result = run("nm", ["-u", binary]);
    expect(result.status).toBe(0);
    expect(result.stdout).not.toMatch(/\b_(?:read|fgets|scanf|getpass|getenv|socket|connect|send|recv|system|popen|execve|posix_spawn|SecItemCopyMatching)\s*$/m);
  });

  it("confirms both network policy denials without making a connection", () => {
    const probe = join(dirname(binary), "network-policy-test");
    const compilation = run("/usr/bin/xcrun", ["clang", "-std=c11", "-Wall", "-Wextra", "-Werror",
      "-Wno-deprecated-declarations", "tests/native/launch-check-network-test.c", "-o", probe]);
    expect(compilation.status, compilation.stderr).toBe(0);
    const result = run(probe, []);
    expect(result.status, result.stdout + result.stderr).toBe(0);
    expect(result.stdout).toContain("AAIS_NETWORK_POLICY_DENIALS=2");
  });
});
