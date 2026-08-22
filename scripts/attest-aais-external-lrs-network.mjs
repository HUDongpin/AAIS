#!/usr/bin/env node

import { createHash, randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { resolve4, resolve6 } from "node:dns/promises";
import {
  chmod,
  mkdir,
  readFile,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { isIP } from "node:net";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const modulePath = import.meta.url.startsWith("file:")
  ? fileURLToPath(import.meta.url)
  : null;
const payloadCapture = "not-retained-tcpdump-summary-only";

if (isDirectInvocation()) {
  const options = readOptions(process.argv.slice(2));
  const result = await runAaisExternalLrsNetworkCapture(options);
  process.stdout.write(`${JSON.stringify({
    status: result.status,
    reason: result.reason ?? null,
    capture_method: result.captureMethod ?? null,
    output: result.status === "verified" ? options.output : options.blockedOutput ?? null,
    secrets: "not-read",
  })}\n`);
  if (result.status === "blocked") {
    process.exitCode = 1;
  }
}

export async function runAaisExternalLrsNetworkCapture(input) {
  const cwd = path.resolve(input.cwd ?? process.cwd());
  const scope = validateScope(input);
  const origins = normalizeTargetOrigins(input.targetOrigins, scope.lrsNamespace);
  const targetOriginsSha256 = hashCanonicalList(origins);
  const now = input.now ?? (() => new Date());
  const probeCapture = input.probeCapture ?? (
    input.appContainer ? probeDockerNetworkCapture : probeOsPacketCapture
  );
  const capability = await probeCapture({
    platform: input.platform ?? process.platform,
    captureFactory: input.captureFactory,
    appContainer: input.appContainer,
    captureImage: input.captureImage,
  });

  if (!capability.available) {
    return writeBlockedResult({
      cwd,
      blockedOutput: input.blockedOutput,
      scope,
      now,
      reason: capability.reason ?? "packet_capture_capability_unavailable",
      capability,
      targetOriginCount: origins.length,
      targetOriginsSha256,
    });
  }
  if (input.probeOnly) {
    return {
      status: "capability_available",
      captureMethod: capability.captureMethod,
      reason: null,
    };
  }

  const output = path.resolve(cwd, requireText(input.output, "output"));
  const captureOutput = path.resolve(
    cwd,
    requireText(input.captureOutput, "capture-output"),
  );
  if (output === captureOutput || path.dirname(output) !== path.dirname(captureOutput)) {
    throw new Error(
      "AAIS network attestation and sanitized capture must be distinct files in one directory.",
    );
  }
  const command = Array.isArray(input.command) ? input.command.map(String) : [];
  if (command.length < 1 || command.some((part) => !part)) {
    throw new Error("AAIS network attestation requires a bounded command after --.");
  }

  const resolveHost = input.resolveHost ?? resolveTargetHost;
  const addressesBefore = await resolveOrigins(origins, resolveHost);
  if (addressesBefore.length < 1) {
    return writeBlockedResult({
      cwd,
      blockedOutput: input.blockedOutput,
      scope,
      now,
      reason: "declared_lrs_origins_did_not_resolve",
      capability,
      targetOriginCount: origins.length,
      targetOriginsSha256,
    });
  }

  const captureFactory = input.captureFactory ?? startTcpdumpCapture;
  let capture;
  try {
    capture = await captureFactory({
      captureMethod: capability.captureMethod,
      captureInterface: capability.captureInterface,
      captureSubject: capability.captureSubject,
      captureSubjectSha256: capability.captureSubjectSha256,
      captureImageId: capability.captureImageId,
      appContainer: input.appContainer,
      captureImage: input.captureImage,
      captureAllEgress: capability.captureAllEgress,
      addresses: addressesBefore,
      now,
    });
  } catch {
    return writeBlockedResult({
      cwd,
      blockedOutput: input.blockedOutput,
      scope,
      now,
      reason: "packet_capture_could_not_start",
      capability,
      targetOriginCount: origins.length,
      targetOriginsSha256,
    });
  }

  const runCommand = input.runCommand ?? runBoundedCommand;
  let commandResult;
  try {
    commandResult = await runCommand(command, { cwd });
  } catch {
    commandResult = { exitCode: null, signal: "runner_error" };
  }
  if (!commandResult) {
    commandResult = { exitCode: null, signal: "runner_error" };
  }
  let captureResult;
  try {
    captureResult = await capture.stop();
  } catch {
    return writeBlockedResult({
      cwd,
      blockedOutput: input.blockedOutput,
      scope,
      now,
      reason: "packet_capture_could_not_stop_cleanly",
      capability,
      targetOriginCount: origins.length,
      targetOriginsSha256,
    });
  }
  const addressesAfter = await resolveOrigins(origins, resolveHost).catch(() => []);
  const stableResolution = equalStringLists(addressesBefore, addressesAfter);
  const addressSetSha256 = hashCanonicalList(addressesBefore);

  const blockReason = determineBlockReason({
    commandResult,
    captureResult,
    stableResolution,
  });
  if (blockReason) {
    return writeBlockedResult({
      cwd,
      blockedOutput: input.blockedOutput,
      scope,
      now,
      reason: blockReason,
      capability,
      targetOriginCount: origins.length,
      targetOriginsSha256,
      observedTargetPackets: captureResult.observedTargetPackets,
    });
  }

  const sanitizedCapture = {
    evidence_schema_version: 2,
    artifact_type: "aais-external-lrs-sanitized-network-capture",
    project_id: scope.projectId,
    study_id: scope.studyId,
    environment: scope.environment,
    lrs_namespace: scope.lrsNamespace,
    capture_started_at: captureResult.captureStartedAt,
    capture_ended_at: captureResult.captureEndedAt,
    capture_method: capability.captureMethod,
    capture_scope: capability.captureScope,
    capture_subject: capability.captureSubject,
    capture_subject_sha256: capability.captureSubjectSha256,
    capture_image_id: capability.captureImageId,
    capture_complete: true,
    target_origin_count: origins.length,
    target_origins_sha256: targetOriginsSha256,
    resolved_target_address_count: addressesBefore.length,
    resolved_target_addresses_sha256: addressSetSha256,
    packets_captured: captureResult.packetsCaptured,
    packets_received_by_filter: captureResult.packetsReceivedByFilter,
    packets_dropped_by_kernel: 0,
    observed_packet_summaries: captureResult.observedPacketSummaries,
    packet_parse_error_count: 0,
    observed_target_packets: 0,
    observed_public_egress_packets: 0,
    observed_internal_egress_packets: captureResult.observedInternalEgressPackets,
    observed_external_lrs_requests: 0,
    command_exit_code: 0,
    raw_capture_retained: false,
    payload_capture: payloadCapture,
  };
  await writeRestrictedJson(captureOutput, sanitizedCapture);
  const sanitizedCaptureBytes = await readFile(captureOutput);
  const sanitizedCaptureSha256 = createHash("sha256")
    .update(sanitizedCaptureBytes)
    .digest("hex");
  const attestation = {
    evidence_schema_version: 2,
    attestation_type: "aais-external-lrs-network",
    project_id: scope.projectId,
    study_id: scope.studyId,
    environment: scope.environment,
    lrs_namespace: scope.lrsNamespace,
    capture_started_at: captureResult.captureStartedAt,
    capture_ended_at: captureResult.captureEndedAt,
    capture_method: capability.captureMethod,
    capture_scope: capability.captureScope,
    capture_subject: capability.captureSubject,
    capture_subject_sha256: capability.captureSubjectSha256,
    capture_image_id: capability.captureImageId,
    capture_complete: true,
    target_origin_count: origins.length,
    target_origins_sha256: targetOriginsSha256,
    resolved_target_address_count: addressesBefore.length,
    resolved_target_addresses_sha256: addressSetSha256,
    packets_captured: captureResult.packetsCaptured,
    packets_received_by_filter: captureResult.packetsReceivedByFilter,
    packets_dropped_by_kernel: 0,
    observed_packet_summaries: captureResult.observedPacketSummaries,
    packet_parse_error_count: 0,
    observed_target_packets: 0,
    observed_public_egress_packets: 0,
    observed_internal_egress_packets: captureResult.observedInternalEgressPackets,
    observed_external_lrs_requests: 0,
    command_exit_code: 0,
    raw_capture_retained: false,
    payload_capture: payloadCapture,
    sanitized_capture_path: path.basename(captureOutput),
    sanitized_capture_sha256: sanitizedCaptureSha256,
  };
  await writeRestrictedJson(output, attestation);
  return {
    status: "verified",
    captureMethod: capability.captureMethod,
    reason: null,
    attestation,
  };
}

export async function probeOsPacketCapture(input = {}) {
  const platform = input.platform ?? process.platform;
  const selected = captureMethodForPlatform(platform);
  if (!selected) {
    return {
      available: false,
      reason: "unsupported_os_packet_capture",
      captureMethod: null,
      captureInterface: null,
      captureScope: null,
      captureSubject: null,
      captureSubjectSha256: null,
      captureImageId: null,
      captureAllEgress: false,
    };
  }
  const captureFactory = input.captureFactory ?? startTcpdumpCapture;
  try {
    const capture = await captureFactory({
      ...selected,
      addresses: ["192.0.2.1", "2001:db8::1"],
      now: () => new Date(),
    });
    await capture.stop();
    return {
      available: true,
      reason: null,
      ...selected,
    };
  } catch {
    return {
      available: false,
      reason: "packet_capture_privilege_unavailable",
      ...selected,
    };
  }
}

export async function probeDockerNetworkCapture(input = {}) {
  const appContainer = String(input.appContainer ?? "").trim();
  const captureImage = String(input.captureImage ?? "").trim();
  if (!appContainer || !/^[A-Za-z0-9_.-]{1,128}$/.test(appContainer)
    || !/^[^\s@]+@sha256:[0-9a-f]{64}$/.test(captureImage)) {
    return {
      available: false,
      reason: "docker_capture_requires_container_and_digest_pinned_image",
      captureMethod: "docker-network-namespace-tcpdump-summary-v1",
      captureInterface: "any",
      captureScope: "all-egress-tcp-udp-app-network-namespace",
      captureSubject: "docker-app-network-namespace",
      captureSubjectSha256: null,
      captureImageId: null,
      captureAllEgress: true,
    };
  }
  let container;
  let image;
  try {
    const [containerResult, imageResult] = await Promise.all([
      execFileAsync("docker", ["inspect", appContainer], {
        encoding: "utf8",
        maxBuffer: 1024 * 1024,
      }),
      execFileAsync("docker", ["image", "inspect", captureImage], {
        encoding: "utf8",
        maxBuffer: 1024 * 1024,
      }),
    ]);
    container = JSON.parse(containerResult.stdout)[0];
    image = JSON.parse(imageResult.stdout)[0];
  } catch {
    return {
      available: false,
      reason: "docker_capture_subject_or_pinned_image_unavailable",
      captureMethod: "docker-network-namespace-tcpdump-summary-v1",
      captureInterface: "any",
      captureScope: "all-egress-tcp-udp-app-network-namespace",
      captureSubject: "docker-app-network-namespace",
      captureSubjectSha256: null,
      captureImageId: null,
      captureAllEgress: true,
    };
  }
  const containerId = String(container?.Id ?? "");
  const imageId = String(image?.Id ?? "");
  if (container?.State?.Running !== true
    || !/^[0-9a-f]{64}$/.test(containerId)
    || !/^sha256:[0-9a-f]{64}$/.test(imageId)) {
    return {
      available: false,
      reason: "docker_capture_subject_not_running_or_image_unverified",
      captureMethod: "docker-network-namespace-tcpdump-summary-v1",
      captureInterface: "any",
      captureScope: "all-egress-tcp-udp-app-network-namespace",
      captureSubject: "docker-app-network-namespace",
      captureSubjectSha256: null,
      captureImageId: null,
      captureAllEgress: true,
    };
  }
  const selected = {
    captureMethod: "docker-network-namespace-tcpdump-summary-v1",
    captureInterface: "any",
    captureScope: "all-egress-tcp-udp-app-network-namespace",
    captureSubject: "docker-app-network-namespace",
    captureSubjectSha256: createHash("sha256").update(containerId).digest("hex"),
    captureImageId: imageId,
    captureAllEgress: true,
  };
  const captureFactory = input.captureFactory ?? startTcpdumpCapture;
  try {
    const capture = await captureFactory({
      ...selected,
      appContainer,
      captureImage,
      addresses: ["192.0.2.1", "2001:db8::1"],
      now: () => new Date(),
      probeOnly: true,
    });
    await capture.stop();
    return {
      available: true,
      reason: null,
      ...selected,
    };
  } catch {
    return {
      available: false,
      reason: "docker_network_capture_capability_unavailable",
      ...selected,
    };
  }
}

export function normalizeTargetOrigins(values, lrsNamespace) {
  if (!Array.isArray(values) || values.length < 1) {
    throw new Error("AAIS network attestation requires at least one target origin.");
  }
  const origins = [...new Set(values.map((value) => {
    let parsed;
    try {
      parsed = new URL(String(value));
    } catch {
      throw new Error("AAIS network attestation target origin is invalid.");
    }
    if (!["https:", "http:"].includes(parsed.protocol)
      || parsed.username || parsed.password || parsed.search || parsed.hash
      || (parsed.pathname !== "/" && parsed.pathname !== "")) {
      throw new Error(
        "AAIS network targets must be credential-free HTTP(S) origins without paths.",
      );
    }
    return parsed.origin;
  }))].sort(compareText);
  const canonicalOrigin = new URL(lrsNamespace).origin;
  if (!origins.includes(canonicalOrigin)) {
    throw new Error("AAIS network targets must include the canonical LRS origin.");
  }
  return origins;
}

function determineBlockReason(input) {
  if (input.commandResult.exitCode !== 0 || input.commandResult.signal !== null) {
    return "bounded_command_did_not_exit_cleanly";
  }
  if (!input.stableResolution) {
    return "declared_lrs_origin_resolution_changed_during_capture";
  }
  if (input.captureResult.captureExitCode !== 0
    || input.captureResult.captureSignal !== null) {
    return "packet_capture_did_not_exit_cleanly";
  }
  if (!Number.isInteger(input.captureResult.packetsCaptured)
    || !Number.isInteger(input.captureResult.packetsReceivedByFilter)
    || !Number.isInteger(input.captureResult.packetsDroppedByKernel)
    || !Number.isInteger(input.captureResult.observedPacketSummaries)
    || !Number.isInteger(input.captureResult.packetParseErrorCount)
    || !Number.isInteger(input.captureResult.observedTargetPackets)
    || !Number.isInteger(input.captureResult.observedPublicEgressPackets)
    || !Number.isInteger(input.captureResult.observedInternalEgressPackets)) {
    return "packet_capture_statistics_missing";
  }
  if (input.captureResult.packetsDroppedByKernel !== 0) {
    return "packet_capture_kernel_drop_detected";
  }
  if (input.captureResult.packetParseErrorCount !== 0
    || input.captureResult.observedPacketSummaries
      !== input.captureResult.observedPublicEgressPackets
        + input.captureResult.observedInternalEgressPackets) {
    return "packet_capture_summary_parse_incomplete";
  }
  if (input.captureResult.observedTargetPackets !== 0
    || input.captureResult.observedPublicEgressPackets !== 0) {
    return "target_contact_observed_request_count_not_inferable_without_payload";
  }
  return null;
}

async function startTcpdumpCapture(input) {
  const targetAddresses = new Set(input.addresses.map(normalizeIpLiteral));
  const filter = input.captureAllEgress
    ? "tcp or udp"
    : [...targetAddresses].map((address) => `host ${address}`).join(" or ");
  let executable;
  let args;
  let sidecarName = null;
  if (input.captureMethod === "docker-network-namespace-tcpdump-summary-v1") {
    sidecarName = `aais-netcap-${randomUUID()}`;
    executable = "docker";
    args = [
      "run", "--rm", "--name", sidecarName,
      "--network", `container:${input.appContainer}`,
      "--cap-add", "NET_RAW",
      "--cap-add", "NET_ADMIN",
      "--entrypoint", "/usr/bin/tcpdump",
      input.captureImage,
      "-i", "any", "-Q", "out",
      "-n", "-q", "-l", "-s", "96", "--immediate-mode",
      filter,
    ];
  } else {
    executable = process.platform === "win32" ? null : "/usr/sbin/tcpdump";
    args = [
      "-i", input.captureInterface,
      "-n", "-q", "-l", "-s", "96", "--immediate-mode",
      filter,
    ];
  }
  if (!executable) {
    throw new Error("packet capture unavailable");
  }
  const child = spawn(executable, args, {
    env: {
      PATH: process.env.PATH ?? "/usr/bin:/bin:/usr/sbin:/sbin",
      LANG: "C",
      LC_ALL: "C",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stderr = "";
  let stdoutRemainder = "";
  let observedTargetPackets = 0;
  let observedPacketSummaries = 0;
  let observedPublicEgressPackets = 0;
  let observedInternalEgressPackets = 0;
  let packetParseErrorCount = 0;
  let ready = false;
  let closed = false;
  let closeResult = null;
  let readyResolve;
  let readyReject;
  const readyPromise = new Promise((resolve, reject) => {
    readyResolve = resolve;
    readyReject = reject;
  });
  const closePromise = new Promise((resolve) => {
    child.once("close", (code, signal) => {
      closed = true;
      closeResult = { code, signal };
      if (!ready) {
        readyReject(new Error("packet capture unavailable"));
      }
      resolve(closeResult);
    });
  });
  child.once("error", () => {
    if (!ready) {
      readyReject(new Error("packet capture unavailable"));
    }
  });
  child.stdout.on("data", (chunk) => {
    stdoutRemainder += chunk.toString("utf8");
    const lines = stdoutRemainder.split(/\r?\n/);
    stdoutRemainder = lines.pop() ?? "";
    for (const line of lines) {
      processPacketSummary(line);
    }
  });
  child.stderr.on("data", (chunk) => {
    if (stderr.length < 64 * 1024) {
      stderr += chunk.toString("utf8").slice(0, 64 * 1024 - stderr.length);
    }
    if (!ready && /listening on /i.test(stderr)) {
      ready = true;
      readyResolve();
    }
  });

  const timeout = setTimeout(() => {
    if (!ready && !closed) {
      child.kill("SIGTERM");
      readyReject(new Error("packet capture readiness timeout"));
    }
  }, 5_000);
  try {
    await readyPromise;
  } finally {
    clearTimeout(timeout);
  }
  const captureStartedAt = input.now().toISOString();

  return {
    async stop() {
      if (!closed) {
        if (sidecarName) {
          await execFileAsync(
            "docker",
            ["kill", "--signal=SIGINT", sidecarName],
            { encoding: "utf8", maxBuffer: 1024 * 1024 },
          ).catch(() => undefined);
        } else {
          child.kill("SIGINT");
        }
      }
      const forced = setTimeout(() => {
        if (!closed) {
          child.kill("SIGKILL");
        }
      }, 5_000);
      await closePromise;
      clearTimeout(forced);
      if (stdoutRemainder.trim()) {
        processPacketSummary(stdoutRemainder);
      }
      return {
        captureStartedAt,
        captureEndedAt: input.now().toISOString(),
        captureExitCode: closeResult?.code,
        captureSignal: closeResult?.signal,
        packetsCaptured: parsePacketStatistic(stderr, "packets captured"),
        packetsReceivedByFilter:
          parsePacketStatistic(stderr, "packets received by filter"),
        packetsDroppedByKernel:
          parsePacketStatistic(stderr, "packets dropped by kernel"),
        observedTargetPackets,
        observedPacketSummaries,
        observedPublicEgressPackets,
        observedInternalEgressPackets,
        packetParseErrorCount,
      };
    },
  };

  function processPacketSummary(line) {
    if (!line.trim()) {
      return;
    }
    observedPacketSummaries += 1;
    const destination = parseTcpdumpDestination(line);
    if (!destination) {
      packetParseErrorCount += 1;
      return;
    }
    if (targetAddresses.has(destination)) {
      observedTargetPackets += 1;
    }
    if (isPublicIpAddress(destination)) {
      observedPublicEgressPackets += 1;
    } else {
      observedInternalEgressPackets += 1;
    }
  }
}

export function parseTcpdumpDestination(line) {
  const match = /(?:^|\s)IP6?\s+\S+\s+>\s+(\S+):/.exec(String(line));
  if (!match) {
    return null;
  }
  const endpoint = match[1];
  const separator = endpoint.lastIndexOf(".");
  if (separator < 1 || !/^\d+$/.test(endpoint.slice(separator + 1))) {
    return null;
  }
  const address = endpoint.slice(0, separator).toLowerCase();
  return isIP(address) ? address : null;
}

export function isPublicIpAddress(value) {
  const address = String(value).toLowerCase();
  const family = isIP(address);
  if (family === 4) {
    const octets = address.split(".").map(Number);
    return !(octets[0] === 10
      || octets[0] === 127
      || (octets[0] === 169 && octets[1] === 254)
      || (octets[0] === 172 && octets[1] >= 16 && octets[1] <= 31)
      || (octets[0] === 192 && octets[1] === 168)
      || (octets[0] === 100 && octets[1] >= 64 && octets[1] <= 127)
      || octets[0] === 0
      || octets[0] >= 224);
  }
  if (family === 6) {
    return !(address === "::"
      || address === "::1"
      || address.startsWith("fc")
      || address.startsWith("fd")
      || /^fe[89ab]/.test(address)
      || address.startsWith("ff"));
  }
  return false;
}

function runBoundedCommand(command, options) {
  return new Promise((resolve) => {
    const child = spawn(command[0], command.slice(1), {
      cwd: options.cwd,
      env: process.env,
      stdio: "ignore",
    });
    child.once("error", () => {
      resolve({ exitCode: null, signal: "spawn_error" });
    });
    child.once("close", (exitCode, signal) => {
      resolve({ exitCode, signal });
    });
  });
}

async function resolveOrigins(origins, resolveHost) {
  const addresses = [];
  for (const origin of origins) {
    const hostname = new URL(origin).hostname;
    const values = await resolveHost(hostname);
    addresses.push(...values);
  }
  return [...new Set(addresses.map(normalizeIpLiteral))].sort(compareText);
}

async function resolveTargetHost(hostname) {
  const [ipv4, ipv6] = await Promise.all([
    resolve4(hostname).catch(() => []),
    resolve6(hostname).catch(() => []),
  ]);
  return [...ipv4, ...ipv6];
}

function normalizeIpLiteral(value) {
  const text = String(value ?? "").trim().toLowerCase();
  if (!/^[0-9a-f:.]+$/.test(text) || (!text.includes(".") && !text.includes(":"))) {
    throw new Error("AAIS network target resolution returned an invalid IP address.");
  }
  return text;
}

function captureMethodForPlatform(platform) {
  if (platform === "darwin") {
    return {
      captureMethod: "darwin-pktap-all-tcpdump-summary-v1",
      captureInterface: "pktap,all",
      captureScope: "all-interfaces-declared-lrs-origins",
      captureSubject: "host-all-interfaces",
      captureSubjectSha256: createHash("sha256")
        .update("host-all-interfaces")
        .digest("hex"),
      captureImageId: null,
      captureAllEgress: false,
    };
  }
  if (platform === "linux") {
    return {
      captureMethod: "linux-any-tcpdump-summary-v1",
      captureInterface: "any",
      captureScope: "all-interfaces-declared-lrs-origins",
      captureSubject: "host-all-interfaces",
      captureSubjectSha256: createHash("sha256")
        .update("host-all-interfaces")
        .digest("hex"),
      captureImageId: null,
      captureAllEgress: false,
    };
  }
  return null;
}

function parsePacketStatistic(stderr, label) {
  const match = new RegExp(`(?:^|\\n)(\\d+) ${label}(?:\\n|$)`, "m").exec(stderr);
  return match ? Number(match[1]) : null;
}

function validateScope(input) {
  const projectId = requireText(input.projectId, "project-id");
  const studyId = requireText(input.studyId, "study-id");
  const environment = requireText(input.environment, "environment");
  const lrsNamespace = requireText(input.lrsNamespace, "lrs-namespace");
  if (projectId !== "aais"
    || !/^[A-Za-z0-9._-]{1,128}$/.test(studyId)
    || !["production", "staging", "research"].includes(environment)) {
    throw new Error("AAIS network attestation scope is invalid.");
  }
  const expectedNamespace = `https://www.aais.site/xapi/studies/${encodeURIComponent(
    studyId,
  )}/${environment}/v1`;
  if (lrsNamespace !== expectedNamespace) {
    throw new Error("AAIS network attestation namespace is not canonical.");
  }
  return { projectId, studyId, environment, lrsNamespace };
}

async function writeBlockedResult(input) {
  const capability = input.capability ?? {};
  const report = {
    evidence_schema_version: 1,
    artifact_type: "aais-external-lrs-network-capture-blocked",
    checked_at: input.now().toISOString(),
    status: "blocked",
    reason: input.reason,
    project_id: input.scope.projectId,
    study_id: input.scope.studyId,
    environment: input.scope.environment,
    lrs_namespace: input.scope.lrsNamespace,
    capture_method: capability.captureMethod ?? null,
    capture_scope: capability.captureScope ?? null,
    capture_subject: capability.captureSubject ?? null,
    capture_subject_sha256: capability.captureSubjectSha256 ?? null,
    capture_image_id: capability.captureImageId ?? null,
    target_origin_count: input.targetOriginCount,
    target_origins_sha256: input.targetOriginsSha256,
    observed_target_packets: Number.isInteger(input.observedTargetPackets)
      ? input.observedTargetPackets
      : null,
    raw_capture_retained: false,
    payload_capture: payloadCapture,
    credentials: "not-read",
    headers: "not-captured",
    cookies: "not-captured",
    learner_text: "not-captured",
  };
  if (input.blockedOutput) {
    await writeRestrictedJson(path.resolve(input.cwd, input.blockedOutput), report);
  }
  return {
    status: "blocked",
    reason: input.reason,
    captureMethod: capability.captureMethod ?? null,
    report,
  };
}

async function writeRestrictedJson(filePath, value) {
  const directory = path.dirname(filePath);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await chmod(directory, 0o700);
  await writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, {
    flag: "wx",
    mode: 0o600,
  });
  await chmod(filePath, 0o600);
}

function hashCanonicalList(values) {
  return createHash("sha256")
    .update(`${values.map(String).sort(compareText).join("\n")}\n`)
    .digest("hex");
}

function equalStringLists(left, right) {
  return left.length === right.length
    && left.every((value, index) => value === right[index]);
}

function compareText(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

function readOptions(args) {
  const separator = args.indexOf("--");
  const optionArgs = separator === -1 ? args : args.slice(0, separator);
  const command = separator === -1 ? [] : args.slice(separator + 1);
  const values = new Map();
  const targetOrigins = [];
  let probeOnly = false;
  for (let index = 0; index < optionArgs.length; index += 1) {
    const name = optionArgs[index];
    if (name === "--probe") {
      probeOnly = true;
      continue;
    }
    const value = optionArgs[index + 1];
    if (!name?.startsWith("--") || value === undefined) {
      throw new Error("AAIS network attestation options are invalid.");
    }
    if (name === "--target-origin") {
      targetOrigins.push(value);
    } else if (values.has(name)) {
      throw new Error("AAIS network attestation options cannot be repeated.");
    } else {
      values.set(name, value);
    }
    index += 1;
  }
  const allowed = new Set([
    "--output",
    "--capture-output",
    "--blocked-output",
    "--app-container",
    "--capture-image",
    "--project-id",
    "--study-id",
    "--environment",
    "--lrs-namespace",
  ]);
  if ([...values.keys()].some((name) => !allowed.has(name))) {
    throw new Error("AAIS network attestation received an unknown option.");
  }
  return {
    output: values.get("--output"),
    captureOutput: values.get("--capture-output"),
    blockedOutput: values.get("--blocked-output"),
    appContainer: values.get("--app-container"),
    captureImage: values.get("--capture-image"),
    projectId: requireText(values.get("--project-id"), "project-id"),
    studyId: requireText(values.get("--study-id"), "study-id"),
    environment: requireText(values.get("--environment"), "environment"),
    lrsNamespace: requireText(values.get("--lrs-namespace"), "lrs-namespace"),
    targetOrigins,
    probeOnly,
    command,
  };
}

function requireText(value, name) {
  const text = String(value ?? "").trim();
  if (!text) {
    throw new Error(`AAIS network attestation requires ${name}.`);
  }
  return text;
}

function isDirectInvocation() {
  return Boolean(modulePath && process.argv[1])
    && path.resolve(process.argv[1]) === modulePath;
}
