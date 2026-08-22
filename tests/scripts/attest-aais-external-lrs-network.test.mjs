import { createHash } from "node:crypto";
import {
  access,
  mkdir,
  mkdtemp,
  readFile,
  stat,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  isPublicIpAddress,
  normalizeTargetOrigins,
  parseTcpdumpDestination,
  runAaisExternalLrsNetworkCapture,
} from "../../scripts/attest-aais-external-lrs-network.mjs";
import {
  readExternalLrsAttestation,
  validateExternalLrsAttestationForRun,
} from "../../scripts/reconcile-aais-browser-rehearsal.mjs";

const scope = {
  projectId: "aais",
  studyId: "network-attestation-test",
  environment: "research",
  lrsNamespace:
    "https://www.aais.site/xapi/studies/network-attestation-test/research/v1",
};
const manifestScope = {
  project_id: scope.projectId,
  study_id: scope.studyId,
  environment: scope.environment,
  lrs_namespace: scope.lrsNamespace,
};
const captureSubjectSha256 = "1".repeat(64);
const captureImageId = `sha256:${"2".repeat(64)}`;

describe("AAIS sanitized external-LRS network attestation", () => {
  it("creates a strict zero-contact attestation from complete Docker namespace metadata", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "aais-network-attestation-"));
    const times = [
      "2026-07-30T10:00:00.000Z",
      "2026-07-30T10:00:10.000Z",
      "2026-07-30T10:00:11.000Z",
    ];
    const result = await runAaisExternalLrsNetworkCapture({
      cwd: root,
      output: "evidence/network-attestation.json",
      captureOutput: "evidence/network-sanitized.json",
      blockedOutput: "evidence/network-blocked.json",
      ...scope,
      targetOrigins: ["https://www.aais.site"],
      appContainer: "aais-app",
      captureImage: `capture@example.invalid@sha256:${"3".repeat(64)}`,
      command: ["synthetic-browser-driver"],
      probeCapture: async () => createDockerCapability(),
      captureFactory: async () => createCapture({
        captureStartedAt: times[0],
        captureEndedAt: times[1],
        packetsCaptured: 2,
        packetsReceivedByFilter: 2,
        observedPacketSummaries: 2,
        observedInternalEgressPackets: 2,
      }),
      runCommand: async () => ({ exitCode: 0, signal: null }),
      resolveHost: async () => ["203.0.113.10"],
      now: createClock(times),
    });

    expect(result).toMatchObject({
      status: "verified",
      captureMethod: "docker-network-namespace-tcpdump-summary-v1",
    });
    const attestationPath = path.join(root, "evidence/network-attestation.json");
    const capturePath = path.join(root, "evidence/network-sanitized.json");
    expect((await stat(path.dirname(attestationPath))).mode & 0o777).toBe(0o700);
    expect((await stat(attestationPath)).mode & 0o777).toBe(0o600);
    expect((await stat(capturePath)).mode & 0o777).toBe(0o600);

    const read = await readExternalLrsAttestation(
      attestationPath,
      manifestScope,
    );
    expect(read).toMatchObject({
      evidence_schema_version: 2,
      capture_complete: true,
      observed_external_lrs_requests: 0,
      observed_public_egress_packets: 0,
      observed_target_packets: 0,
      packet_parse_error_count: 0,
      packets_dropped_by_kernel: 0,
      raw_capture_retained: false,
    });
    expect(validateExternalLrsAttestationForRun(read, {
      startedTimes: ["2026-07-30T10:00:01.000Z"],
      receivedTimes: ["2026-07-30T10:00:09.000Z"],
    })).toMatchObject({
      status: "verified",
      verified: true,
      externalLrsContacted: false,
    });
  });

  it("fails if an evidence filename already exists instead of overwriting it", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "aais-network-exclusive-"));
    await mkdir(path.join(root, "evidence"), { mode: 0o700 });
    await writeFile(path.join(root, "evidence/network-sanitized.json"), "retained\n", {
      mode: 0o600,
    });

    await expect(runAaisExternalLrsNetworkCapture(createSuccessfulInput(root)))
      .rejects.toMatchObject({ code: "EEXIST" });
    expect(await readFile(
      path.join(root, "evidence/network-sanitized.json"),
      "utf8",
    )).toBe("retained\n");
  });

  it("stays blocked for public/target traffic, packet loss, parse gaps, or command failure", async () => {
    for (const [reason, override] of [
      [
        "target_contact_observed_request_count_not_inferable_without_payload",
        {
          packetsCaptured: 1,
          packetsReceivedByFilter: 1,
          observedPacketSummaries: 1,
          observedPublicEgressPackets: 1,
          observedTargetPackets: 1,
        },
      ],
      ["packet_capture_kernel_drop_detected", { packetsDroppedByKernel: 1 }],
      [
        "packet_capture_summary_parse_incomplete",
        {
          packetsCaptured: 1,
          packetsReceivedByFilter: 1,
          observedPacketSummaries: 1,
          packetParseErrorCount: 1,
        },
      ],
    ]) {
      const root = await mkdtemp(path.join(os.tmpdir(), "aais-network-blocked-"));
      const result = await runAaisExternalLrsNetworkCapture({
        ...createSuccessfulInput(root),
        captureFactory: async () => createCapture(override),
      });
      expect(result).toMatchObject({ status: "blocked", reason });
      await expect(access(path.join(root, "evidence/network-attestation.json")))
        .rejects.toThrow();
      const report = JSON.parse(await readFile(
        path.join(root, "evidence/network-blocked.json"),
        "utf8",
      ));
      expect(report).toMatchObject({
        status: "blocked",
        raw_capture_retained: false,
        credentials: "not-read",
        headers: "not-captured",
        cookies: "not-captured",
        learner_text: "not-captured",
      });
    }

    const commandRoot = await mkdtemp(
      path.join(os.tmpdir(), "aais-network-command-blocked-"),
    );
    const commandResult = await runAaisExternalLrsNetworkCapture({
      ...createSuccessfulInput(commandRoot),
      runCommand: async () => ({ exitCode: 2, signal: null }),
    });
    expect(commandResult).toMatchObject({
      status: "blocked",
      reason: "bounded_command_did_not_exit_cleanly",
    });
  });

  it("writes only blocked capability evidence when OS capture privilege is absent", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "aais-network-no-cap-"));
    const result = await runAaisExternalLrsNetworkCapture({
      cwd: root,
      blockedOutput: "evidence/no-capability.json",
      ...scope,
      targetOrigins: ["https://www.aais.site"],
      probeOnly: true,
      probeCapture: async () => ({
        available: false,
        reason: "packet_capture_privilege_unavailable",
        captureMethod: "darwin-pktap-all-tcpdump-summary-v1",
        captureScope: "all-interfaces-declared-lrs-origins",
        captureSubject: "host-all-interfaces",
        captureSubjectSha256,
        captureImageId: null,
      }),
    });

    expect(result).toMatchObject({
      status: "blocked",
      reason: "packet_capture_privilege_unavailable",
    });
    const report = JSON.parse(await readFile(
      path.join(root, "evidence/no-capability.json"),
      "utf8",
    ));
    expect(report.capture_complete).toBeUndefined();
    expect(report).toMatchObject({
      artifact_type: "aais-external-lrs-network-capture-blocked",
      status: "blocked",
    });
  });

  it("rejects capture-content drift and path traversal even with a matching checksum", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "aais-network-tamper-"));
    await runAaisExternalLrsNetworkCapture(createSuccessfulInput(root));
    const evidenceDirectory = path.join(root, "evidence");
    const originalAttestation = JSON.parse(await readFile(
      path.join(evidenceDirectory, "network-attestation.json"),
      "utf8",
    ));
    const capture = JSON.parse(await readFile(
      path.join(evidenceDirectory, "network-sanitized.json"),
      "utf8",
    ));
    const tamperedCapture = {
      ...capture,
      leaked_header: "must be rejected",
    };
    const tamperedBytes = `${JSON.stringify(tamperedCapture, null, 2)}\n`;
    await writeFile(
      path.join(evidenceDirectory, "tampered-capture.json"),
      tamperedBytes,
      { mode: 0o600 },
    );
    const tamperedAttestation = {
      ...originalAttestation,
      sanitized_capture_path: "tampered-capture.json",
      sanitized_capture_sha256: createHash("sha256")
        .update(tamperedBytes)
        .digest("hex"),
    };
    await writeFile(
      path.join(evidenceDirectory, "tampered-attestation.json"),
      `${JSON.stringify(tamperedAttestation, null, 2)}\n`,
      { mode: 0o600 },
    );
    await expect(readExternalLrsAttestation(
      path.join(evidenceDirectory, "tampered-attestation.json"),
      manifestScope,
    )).rejects.toThrow("sanitized capture does not match");

    const traversal = {
      ...originalAttestation,
      sanitized_capture_path: "../network-sanitized.json",
    };
    await writeFile(
      path.join(evidenceDirectory, "traversal-attestation.json"),
      `${JSON.stringify(traversal, null, 2)}\n`,
      { mode: 0o600 },
    );
    await expect(readExternalLrsAttestation(
      path.join(evidenceDirectory, "traversal-attestation.json"),
      manifestScope,
    )).rejects.toThrow("network attestation is invalid");
  });

  it("accepts only credential-free origins and parses public/private packet metadata", () => {
    expect(normalizeTargetOrigins(
      ["https://www.aais.site", "https://www.mais.ac"],
      scope.lrsNamespace,
    )).toEqual(["https://www.aais.site", "https://www.mais.ac"]);
    for (const invalid of [
      "https://user:password@www.aais.site",
      "https://www.aais.site/xapi",
      "https://www.aais.site?token=secret",
    ]) {
      expect(() => normalizeTargetOrigins([invalid], scope.lrsNamespace))
        .toThrow("credential-free");
    }
    expect(parseTcpdumpDestination(
      "1750000000.000 eth0 Out IP 172.20.0.2.52314 > 172.20.0.3.5432: tcp 0",
    )).toBe("172.20.0.3");
    expect(parseTcpdumpDestination(
      "1750000000.000 eth0 Out IP6 fd00::2.443 > 2001:db8::1.443: tcp 0",
    )).toBe("2001:db8::1");
    expect(parseTcpdumpDestination("unparseable payload")).toBeNull();
    expect(isPublicIpAddress("8.8.8.8")).toBe(true);
    expect(isPublicIpAddress("172.20.0.3")).toBe(false);
    expect(isPublicIpAddress("fd00::2")).toBe(false);
    expect(isPublicIpAddress("2001:4860:4860::8888")).toBe(true);
  });
});

function createSuccessfulInput(root) {
  return {
    cwd: root,
    output: "evidence/network-attestation.json",
    captureOutput: "evidence/network-sanitized.json",
    blockedOutput: "evidence/network-blocked.json",
    ...scope,
    targetOrigins: ["https://www.aais.site"],
    appContainer: "aais-app",
    captureImage: `capture@example.invalid@sha256:${"3".repeat(64)}`,
    command: ["synthetic-browser-driver"],
    probeCapture: async () => createDockerCapability(),
    captureFactory: async () => createCapture(),
    runCommand: async () => ({ exitCode: 0, signal: null }),
    resolveHost: async () => ["203.0.113.10"],
    now: createClock([
      "2026-07-30T10:00:00.000Z",
      "2026-07-30T10:00:10.000Z",
      "2026-07-30T10:00:11.000Z",
    ]),
  };
}

function createDockerCapability() {
  return {
    available: true,
    reason: null,
    captureMethod: "docker-network-namespace-tcpdump-summary-v1",
    captureInterface: "any",
    captureScope: "all-egress-tcp-udp-app-network-namespace",
    captureSubject: "docker-app-network-namespace",
    captureSubjectSha256,
    captureImageId,
    captureAllEgress: true,
  };
}

function createCapture(overrides = {}) {
  return {
    stop: async () => ({
      captureStartedAt: "2026-07-30T10:00:00.000Z",
      captureEndedAt: "2026-07-30T10:00:10.000Z",
      captureExitCode: 0,
      captureSignal: null,
      packetsCaptured: 0,
      packetsReceivedByFilter: 0,
      packetsDroppedByKernel: 0,
      observedPacketSummaries: 0,
      packetParseErrorCount: 0,
      observedTargetPackets: 0,
      observedPublicEgressPackets: 0,
      observedInternalEgressPackets: 0,
      ...overrides,
    }),
  };
}

function createClock(values) {
  let index = 0;
  return () => new Date(values[Math.min(index++, values.length - 1)]);
}
