import { spawnSync } from "node:child_process";
import { readFileSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const read = (path) => readFileSync(path, "utf8");
const run = (file, args) => spawnSync(file, args, { encoding: "utf8", timeout: 60000 });

it("has no test approval switch, persisted key or credential path in the Owner demo", () => {
  const main = read("native/confirmation-check/main.swift");
  const core = read("native/confirmation-check/ConfirmationCore.swift");
  expect(main.indexOf("guard aais_confirmation_origin_begin()"))
    .toBeLessThan(main.indexOf("let context = LAContext()"));
  expect(main).toContain("CommandLine.arguments.count == 1");
  expect(main.match(/context.evaluatePolicy\(/g)).toHaveLength(1);
  expect(main).toContain("touchIDAuthenticationAllowableReuseDuration = 0");
  expect(main).toContain('localizedFallbackTitle = ""');
  expect(main).toContain(".deviceOwnerAuthenticationWithBiometrics");
  expect(main).not.toMatch(/\.deviceOwnerAuthentication[\s,)]/);
  expect(main.match(/originOK: aais_confirmation_origin_unchanged\(\)/g)).toHaveLength(2);
  expect(core).toContain("kSecAttrIsPermanent as String: false");
  expect(core).toContain("private var key: SecKey?");
  expect(core).toContain("defer { key = nil }");
  expect(core).toContain("AAIS-OFFLINE-CONFIRMATION-TEST-v1");
  for (const code of [main, core]) {
    expect(code).not.toMatch(/SecItem(?:Add|CopyMatching|Update|Delete)|SecKeyCopyExternalRepresentation|URLSession|Process\(|readLine\(|getenv|write\(to/);
  }
  expect(main).toContain('"authorizesLiveExecution": false');
  expect(main).toContain('"productionKeyAccessVerified": false');
  expect(main).toContain('"secureEnclaveVerified": false');
});

it("leaves the ECS receiver disabled and unable to consume demo results", () => {
  const preload = read("deploy/aliyun/aais-preload-ghcr-image.sh");
  const main = preload.slice(preload.indexOf("aais_preload_main() {"));
  expect(main.indexOf("aais_require_audited_owner_launcher || return 1"))
    .toBeLessThan(main.indexOf('source "$deploy_config_file"'));
  expect(preload).not.toMatch(/AAIS-OFFLINE-CONFIRMATION|aais-confirmation-check/);
  const plan = JSON.parse(read("deploy/aliyun/owner-launcher-plan.json"));
  expect(plan.executionEnabled).toBe(false);
  expect(Object.values(plan.requiredBindings).every((value) => value === null)).toBe(true);
});

describe.skipIf(process.platform !== "darwin")("native confirmation prototype", () => {
  let binary;
  beforeAll(() => {
    const build = run("bash", ["scripts/build-aais-confirmation-check.sh"]);
    expect(build.status, build.stderr).toBe(0);
    binary = /^BINARY=(.+)$/m.exec(build.stdout)?.[1];
    expect(binary).toContain("/output/native-confirmation-check/build.");
  }, 60000);
  afterAll(() => { if (binary) rmSync(dirname(binary), { recursive: true, force: true }); });

  it("tests native one-shot signing with ephemeral keys and synthetic decisions only", () => {
    const testBinary = join(dirname(binary), "core-test");
    const build = run("/usr/bin/xcrun", ["swiftc", "-swift-version", "5", "-O",
      "native/confirmation-check/ConfirmationCore.swift", "tests/native/confirmation-check/main.swift",
      "-framework", "Security", "-o", testBinary]);
    expect(build.status, build.stderr).toBe(0);
    const result = run(testBinary, []);
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain("AAIS_NATIVE_CONFIRMATION_ASSERTIONS=61");
    expect(result.stdout).not.toMatch(/BEGIN.*KEY|signature":/);
  }, 60000);

  it("rejects actual automation ancestry before any biometric prompt", () => {
    const result = run(binary, []);
    expect(result.status, result.stderr).toBe(2);
    expect(JSON.parse(result.stdout)).toMatchObject({ status: "origin-or-sandbox-rejected",
      localBiometricConfirmation: false, ephemeralSignatureSelfCheck: false,
      keyPersisted: false, credentialsRead: false, authorizesLiveExecution: false });
    expect(result.stdout).not.toContain("可在系统提示中取消");
  });
  it("rejects command-line approval and execution overrides without echoing them", () => {
    for (const arg of ["--approved", "--self-test", "--execute", "--key", "--fixture"]) {
      const result = run(binary, [arg]);
      expect(result.status).toBe(64);
      expect(JSON.parse(result.stdout).status).toBe("arguments-not-allowed");
      expect(result.stdout).not.toContain(arg);
    }
  });
});
