// All process evidence and targets below are fixtures, not observations.
import { generateKeyPairSync, sign } from "node:crypto";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { canonicalModelRequest, evaluateSyntheticLifecycle, evaluateSyntheticOrigin,
  modelPublicKeyFingerprint, verifySyntheticRequest } from "./helpers/aais-owner-launcher-model.mjs";

function origin() {
  const before = [
    { role: "launcher", pid: 44, ppid: 33, uid: 501, startedAt: 40, identity: "verified-native-launcher" },
    { role: "shell", pid: 33, ppid: 22, uid: 501, startedAt: 30, identity: "verified-native-shell" },
    { role: "terminal", pid: 22, ppid: 1, uid: 501, startedAt: 20, identity: "verified-native-terminal" },
    { role: "launchd", pid: 1, ppid: 0, uid: 0, startedAt: 1, identity: "verified-native-launchd" },
  ];
  return { platform: "darwin", ownerUid: 501, complete: true, stdinTty: true, stdoutTty: true,
    sameControllingTty: true, foreground: true, userPresence: "fresh-verified-by-native-collector",
    before, after: structuredClone(before) };
}

function protocolFixture() {
  // Ephemeral test-only signing keys; never exported, printed, saved or enrolled.
  const { privateKey, publicKey } = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
  const request = { protocol: "AAIS-OWNER-MODEL-1", project: "AAIS",
    operation: "preload-private-ghcr-digest-only", instanceId: "i-offline-fixture",
    hostKeyFingerprint: "1".repeat(64), serverHelperSha256: "2".repeat(64),
    launcherSha256: "3".repeat(64), repository: "ghcr.io/hudongpin/aais",
    releaseSha: "a".repeat(40), imageDigest: `sha256:${"b".repeat(64)}`,
    channelBinding: "4".repeat(64), nonce: "5".repeat(64), issuedAt: 1000, expiresAt: 1060 };
  const context = { publicKey, enrolledKeyFingerprint: modelPublicKeyFingerprint(publicKey),
    expected: { ...request }, expectedNonce: request.nonce, now: 1001, usedNonces: new Set() };
  const envelope = (value = request) => {
    const body = canonicalModelRequest(value);
    return { body, signature: sign("sha256", Buffer.from(body), privateKey).toString("base64") };
  };
  return { request, context, envelope };
}

describe("AAIS Owner launcher non-sensitive design model", () => {
  it("accepts a complete synthetic native chain only as model evidence", () => {
    expect(evaluateSyntheticOrigin(origin())).toEqual({ status: "MODEL_ACCEPTED", authorizesLiveExecution: false });
  });
  it.each(["codex", "chatgpt", "electron", "vscode", "cursor", "node", "npm", "npx", "tsx", "deno", "bun", "sshd"])
    ("rejects a %s origin even with a TTY", (role) => {
      const sample = origin();
      sample.before[1].role = role;
      sample.after = structuredClone(sample.before);
      expect(() => evaluateSyntheticOrigin(sample)).toThrow("OWNER_MODEL_REJECTED");
    });
  it.each([
    { platform: "linux" }, { ownerUid: 0 }, { complete: false }, { stdinTty: false },
    { stdoutTty: false }, { sameControllingTty: false }, { foreground: false },
    { userPresence: "approved=true" },
  ])("rejects missing or untrusted local evidence %j", (override) => {
    expect(() => evaluateSyntheticOrigin({ ...origin(), ...override })).toThrow();
  });
  it.each(["changed_snapshot", "changed_uid", "pid_reuse", "broken_parent", "forged_identity", "bad_time"])
    ("rejects process evidence fault: %s", (fault) => {
      const sample = origin();
      if (fault === "changed_uid") sample.before[1].uid = 502;
      if (fault === "pid_reuse") sample.before[1].pid = sample.before[0].pid;
      if (fault === "broken_parent") sample.before[0].ppid = 999;
      if (fault === "forged_identity") sample.before[2].identity = "Terminal.app-name-only";
      if (fault === "bad_time") sample.before[0].startedAt = 1;
      if (fault !== "changed_snapshot") sample.after = structuredClone(sample.before);
      else sample.after[1].startedAt += 1;
      expect(() => evaluateSyntheticOrigin(sample)).toThrow();
    });

  it("verifies a real test-key signature without authorizing live execution", () => {
    const fixture = protocolFixture();
    expect(verifySyntheticRequest(fixture.envelope(), fixture.context))
      .toEqual({ status: "MODEL_ACCEPTED", authorizesLiveExecution: false });
  });
  it.each(["instanceId", "hostKeyFingerprint", "serverHelperSha256", "launcherSha256", "releaseSha", "imageDigest", "channelBinding"])
    ("rejects a correctly signed request for the wrong %s", (key) => {
      const { request, context, envelope } = protocolFixture();
      const value = key === "instanceId" ? "i-other-fixture" : key === "imageDigest"
        ? `sha256:${"c".repeat(64)}` : "c".repeat(key === "releaseSha" ? 40 : 64);
      expect(() => verifySyntheticRequest(envelope({ ...request, [key]: value }), context)).toThrow();
    });
  it.each([999, 1060, 1061, NaN])("rejects stale/future/invalid time %s", (now) => {
    const fixture = protocolFixture();
    fixture.context.now = now;
    expect(() => verifySyntheticRequest(fixture.envelope(), fixture.context)).toThrow();
  });
  it("rejects replay and a nonce from another challenge", () => {
    const fixture = protocolFixture();
    const envelope = fixture.envelope();
    verifySyntheticRequest(envelope, fixture.context);
    expect(() => verifySyntheticRequest(envelope, fixture.context)).toThrow();
    const other = protocolFixture();
    other.context.expectedNonce = "f".repeat(64);
    expect(() => verifySyntheticRequest(other.envelope(), other.context)).toThrow();
  });
  it("rejects payload tampering, wrong signing keys and missing trust enrollment", () => {
    const fixture = protocolFixture();
    const wire = fixture.envelope();
    expect(() => verifySyntheticRequest({ ...wire, body: wire.body.replace("1000", "1001") }, fixture.context)).toThrow();
    const outsider = protocolFixture();
    expect(() => verifySyntheticRequest(outsider.envelope(), fixture.context)).toThrow();
    fixture.context.enrolledKeyFingerprint = null;
    expect(() => verifySyntheticRequest(wire, fixture.context)).toThrow();
    expect(fixture.context.usedNonces.size).toBe(0);
  });
  it("rejects another signing algorithm even when its fingerprint is enrolled in the fixture", () => {
    const fixture = protocolFixture();
    const { privateKey, publicKey } = generateKeyPairSync("ec", { namedCurve: "secp384r1" });
    fixture.context.publicKey = publicKey;
    fixture.context.enrolledKeyFingerprint = modelPublicKeyFingerprint(publicKey);
    const body = canonicalModelRequest(fixture.request);
    const signature = sign("sha256", Buffer.from(body), privateKey).toString("base64");
    expect(() => verifySyntheticRequest({ body, signature }, fixture.context)).toThrow();
  });
  it("rejects duplicate keys, unknown fields, oversized input and alternate encodings", () => {
    const fixture = protocolFixture();
    const envelope = fixture.envelope();
    for (const body of ["{", " "+envelope.body, envelope.body.replace('{', '{"project":"AAIS",'),
      JSON.stringify({ ...fixture.request, approved: true }), "x".repeat(4097)]) {
      expect(() => verifySyntheticRequest({ ...envelope, body }, fixture.context)).toThrow();
    }
    expect(() => verifySyntheticRequest({ ...envelope, signature: envelope.signature+"\n" }, fixture.context)).toThrow();
    for (const override of [{ project: "Sufeiya" }, { operation: "deploy-container" },
      { repository: "ghcr.io/other/aais" }, { imageDigest: "latest" }, { expiresAt: 2000 }]) {
      expect(() => canonicalModelRequest({ ...fixture.request, ...override })).toThrow();
    }
  });

  const sequence = ["local_verified", "host_pinned", "challenge_received", "request_authorized",
    "prompt_opened", "credential_submitted", "digest_verified", "cleanup_verified", "receipt_emitted"];
  it("requires cleanup and exact digest verification before a synthetic receipt", () => {
    expect(evaluateSyntheticLifecycle(sequence).authorizesLiveExecution).toBe(false);
    for (const missing of ["local_verified", "host_pinned", "request_authorized", "digest_verified", "cleanup_verified"]) {
      expect(() => evaluateSyntheticLifecycle(sequence.filter((event) => event !== missing))).toThrow();
    }
  });
  it.each(["cancel", "timeout", "disconnect", "failure"])("handles %s without retry or success receipt", (event) => {
    for (let offset = 0; offset < sequence.length; offset += 1) {
      const prefix = sequence.slice(0, offset);
      expect(evaluateSyntheticLifecycle([...prefix, event, "cleanup_verified"]).status).toBe("MODEL_ABORTED_CLEAN");
      expect(() => evaluateSyntheticLifecycle([...prefix, event])).toThrow();
      expect(() => evaluateSyntheticLifecycle([...prefix, event, "cleanup_failed"])).toThrow();
      expect(() => evaluateSyntheticLifecycle([...prefix, event, "cleanup_verified", "receipt_emitted"])).toThrow();
      expect(() => evaluateSyntheticLifecycle([...prefix, event, "retry"])).toThrow();
    }
  });
  it("keeps all model evidence disconnected from the credential entry point", () => {
    const plan = JSON.parse(readFileSync("deploy/aliyun/owner-launcher-plan.json", "utf8"));
    expect(plan.executionEnabled).toBe(false);
    expect(Object.values(plan.requiredBindings).every((value) => value === null)).toBe(true);
    const source = readFileSync("deploy/aliyun/aais-preload-ghcr-image.sh", "utf8");
    expect(source).toContain("aais_require_audited_owner_launcher || return 1");
    expect(source).toContain("BLOCKED_AAIS_AUDITED_OWNER_LAUNCHER_BINDING_MISSING");
    expect(source).not.toContain("aais-owner-launcher-model");
    expect(readFileSync(".dockerignore", "utf8").split("\n")).toContain("tests");
    const model = readFileSync("tests/helpers/aais-owner-launcher-model.mjs", "utf8");
    expect(model).not.toMatch(/node:(?:fs|child_process|net|http|https|tls)|\b(?:fetch|eval)\s*\(|process\./);
  });
});
