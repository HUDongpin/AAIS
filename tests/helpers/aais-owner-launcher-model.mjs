// TEST MODEL ONLY. No process inspection, TTY, credentials, filesystem or network.
// Synthetic evidence can NEVER authorize a real launcher or remote operation.
import { createHash, verify } from "node:crypto";

const accepted = () => ({ status: "MODEL_ACCEPTED", authorizesLiveExecution: false });
const deny = () => { throw new Error("OWNER_MODEL_REJECTED"); };
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const hex = (value, length) => typeof value === "string" && new RegExp(`^[a-f0-9]{${length}}$`).test(value);

export function evaluateSyntheticOrigin(evidence) {
  if (!evidence || evidence.platform !== "darwin" || !Number.isSafeInteger(evidence.ownerUid)
    || evidence.ownerUid <= 0 || evidence.complete !== true
    || evidence.stdinTty !== true || evidence.stdoutTty !== true
    || evidence.sameControllingTty !== true || evidence.foreground !== true
    || evidence.userPresence !== "fresh-verified-by-native-collector"
    || !Array.isArray(evidence.before) || !same(evidence.before, evidence.after)) deny();
  const chain = evidence.before;
  const roles = chain.map((item) => item.role).join(",");
  if (!["launcher,shell,terminal,launchd", "launcher,shell,login,terminal,launchd"].includes(roles)) deny();
  const ids = new Set();
  for (let index = 0; index < chain.length; index += 1) {
    const item = chain[index];
    if (!Number.isSafeInteger(item.pid) || item.pid < 1 || ids.has(item.pid)
      || !Number.isSafeInteger(item.startedAt) || item.startedAt < 1
      || item.identity !== `verified-native-${item.role}`
      || item.uid !== (item.role === "launchd" ? 0 : evidence.ownerUid)) deny();
    ids.add(item.pid);
    if (index + 1 < chain.length) {
      const parent = chain[index + 1];
      if (item.ppid !== parent.pid || item.startedAt < parent.startedAt) deny();
    } else if (item.pid !== 1 || item.ppid !== 0) deny();
  }
  return accepted();
}

const requestKeys = ["protocol", "project", "operation", "instanceId", "hostKeyFingerprint",
  "serverHelperSha256", "launcherSha256", "repository", "releaseSha", "imageDigest",
  "channelBinding", "nonce", "issuedAt", "expiresAt"];
const bindingKeys = ["instanceId", "hostKeyFingerprint", "serverHelperSha256", "launcherSha256",
  "repository", "releaseSha", "imageDigest", "channelBinding"];

export function canonicalModelRequest(request) {
  if (!request || !same(Object.keys(request).sort(), [...requestKeys].sort())) deny();
  if (request.protocol !== "AAIS-OWNER-MODEL-1" || request.project !== "AAIS"
    || request.operation !== "preload-private-ghcr-digest-only"
    || request.repository !== "ghcr.io/hudongpin/aais"
    || typeof request.instanceId !== "string" || !/^i-[a-z0-9-]{1,80}$/.test(request.instanceId)
    || !hex(request.hostKeyFingerprint, 64) || !hex(request.serverHelperSha256, 64)
    || !hex(request.launcherSha256, 64) || !hex(request.channelBinding, 64)
    || !hex(request.releaseSha, 40) || !hex(request.nonce, 64)
    || typeof request.imageDigest !== "string" || !/^sha256:[a-f0-9]{64}$/.test(request.imageDigest)
    || !Number.isSafeInteger(request.issuedAt) || request.issuedAt < 0
    || !Number.isSafeInteger(request.expiresAt) || request.expiresAt <= request.issuedAt
    || request.expiresAt - request.issuedAt > 60) deny();
  return JSON.stringify(Object.fromEntries(requestKeys.map((key) => [key, request[key]])));
}

export function modelPublicKeyFingerprint(key) {
  return createHash("sha256").update(key.export({ type: "spki", format: "der" })).digest("hex");
}

export function verifySyntheticRequest({ body, signature }, context) {
  if (typeof body !== "string" || Buffer.byteLength(body, "utf8") > 4096
    || typeof signature !== "string" || signature.length > 128) deny();
  let request;
  try { request = JSON.parse(body); } catch { deny(); }
  // Enforce one canonical encoding: duplicate keys and unknown fields fail.
  if (canonicalModelRequest(request) !== body) deny();
  if (!Number.isSafeInteger(context.now) || request.issuedAt > context.now
    || request.expiresAt <= context.now || !hex(context.expectedNonce, 64)
    || request.nonce !== context.expectedNonce || context.usedNonces.has(request.nonce)) deny();
  for (const key of bindingKeys) {
    if (request[key] !== context.expected[key]) deny();
  }
  if (context.publicKey.asymmetricKeyType !== "ec"
    || context.publicKey.asymmetricKeyDetails?.namedCurve !== "prime256v1"
    || modelPublicKeyFingerprint(context.publicKey) !== context.enrolledKeyFingerprint) deny();
  const bytes = Buffer.from(signature, "base64");
  if (bytes.toString("base64") !== signature
    || !verify("sha256", Buffer.from(body, "utf8"), context.publicKey, bytes)) deny();
  // Models a single atomic claim. This Set is NOT a durable server replay store.
  context.usedNonces.add(request.nonce);
  return accepted();
}

export function evaluateSyntheticLifecycle(events) {
  const sequence = ["local_verified", "host_pinned", "challenge_received", "request_authorized",
    "prompt_opened", "credential_submitted", "digest_verified", "cleanup_verified", "receipt_emitted"];
  if (!Array.isArray(events)) deny();
  let index = 0;
  let aborted = false;
  let cleaned = false;
  for (const event of events) {
    if (index === sequence.length || cleaned) deny();
    if (["cancel", "timeout", "disconnect", "failure"].includes(event) && !aborted) {
      aborted = true;
    } else if (aborted) {
      if (event !== "cleanup_verified") deny();
      cleaned = true;
    } else if (event !== sequence[index]) {
      deny();
    } else {
      index += 1;
    }
  }
  if (aborted && cleaned) return { status: "MODEL_ABORTED_CLEAN", authorizesLiveExecution: false };
  if (index !== sequence.length) deny();
  return accepted();
}
