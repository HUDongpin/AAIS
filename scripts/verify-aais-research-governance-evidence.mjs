#!/usr/bin/env node

import {
  createHash,
  createPublicKey,
  verify,
} from "node:crypto";
import {
  lstat,
  mkdir,
  readFile,
  realpath,
  stat,
  writeFile,
} from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";

const SCHEMA_VERSION = "aais-research-governance-evidence/v1";
const REPORT_SCHEMA_VERSION = "aais-research-governance-verification/v1";
const AAIS_NAMESPACE_PREFIX = "https://www.aais.site/xapi/";
const MANIFEST_MAX_AGE_MS = 36 * 60 * 60 * 1_000;
const DAILY_BACKUP_MAX_AGE_MS = 36 * 60 * 60 * 1_000;
const DESTRUCTION_MAX_AGE_MS = 45 * 24 * 60 * 60 * 1_000;
const MAX_FUTURE_SKEW_MS = 5 * 60 * 1_000;

const receiptDefinitions = [
  ["database_isolation", "AAIS_RESEARCH_DATABASE_ISOLATION_RECEIPT_SHA256"],
  ["lrs_isolation", "AAIS_RESEARCH_LRS_ISOLATION_RECEIPT_SHA256"],
  ["lrs_zero_baseline", "AAIS_RESEARCH_LRS_ZERO_BASELINE_RECEIPT_SHA256"],
  ["lrs_put_delete", "AAIS_RESEARCH_LRS_PUT_DELETE_RECEIPT_SHA256"],
  ["backup_policy", "AAIS_RESEARCH_BACKUP_POLICY_RECEIPT_SHA256"],
  ["restore", "AAIS_RESEARCH_RESTORE_RECEIPT_SHA256"],
  ["legacy_archive", "AAIS_RESEARCH_LEGACY_ARCHIVE_RECEIPT_SHA256"],
  ["access_register", "AAIS_RESEARCH_ACCESS_REGISTER_RECEIPT_SHA256"],
  ["consent_legal_basis", "AAIS_RESEARCH_CONSENT_LEGAL_BASIS_RECEIPT_SHA256"],
  ["dpa", "AAIS_RESEARCH_DPA_RECEIPT_SHA256"],
  ["data_region", "AAIS_RESEARCH_DATA_REGION_RECEIPT_SHA256"],
  ["daily_backup", "AAIS_RESEARCH_DAILY_BACKUP_RECEIPT_SHA256"],
  ["backup_destruction", "AAIS_RESEARCH_BACKUP_DESTRUCTION_RECEIPT_SHA256"],
];

const requiredReceiptKinds = receiptDefinitions.map(([kind]) => kind);
const receiptEnvByKind = new Map(receiptDefinitions);

export async function verifyAaisResearchGovernanceEvidence(options) {
  const issueCodes = [];
  const now = options.now ?? new Date();
  const nowMs = now.getTime();
  if (!Number.isFinite(nowMs)) {
    throw new Error("invalid_now");
  }

  const rootPath = resolve(options.registerRoot);
  const root = await inspectRestrictedDirectory(rootPath, "register_root", issueCodes);
  const manifestInspection = await inspectRestrictedFile({
    root,
    candidatePath: resolve(options.manifestPath),
    label: "manifest",
    issueCodes,
  });
  const signatureInspection = await inspectRestrictedFile({
    root,
    candidatePath: resolve(options.signaturePath),
    label: "manifest_signature",
    issueCodes,
  });
  const keyInspection = await inspectRestrictedFile({
    root,
    candidatePath: resolve(options.verifyingKeySpkiPath),
    label: "verifying_key",
    issueCodes,
  });

  let manifestBytes = Buffer.alloc(0);
  let signatureBytes = Buffer.alloc(0);
  let publicKeyBytes = Buffer.alloc(0);
  if (manifestInspection.safe) {
    manifestBytes = await readFile(manifestInspection.path);
  }
  if (signatureInspection.safe) {
    signatureBytes = await readFile(signatureInspection.path);
  }
  if (keyInspection.safe) {
    publicKeyBytes = await readFile(keyInspection.path);
  }

  const manifestSha256 = sha256(manifestBytes);
  const signatureSha256 = sha256(signatureBytes);
  const manifestSignatureVerified = verifyManifestSignature({
    manifestBytes,
    signatureBytes,
    publicKeyBytes,
    issueCodes,
  });

  let manifest = null;
  try {
    manifest = JSON.parse(manifestBytes.toString("utf8"));
  } catch {
    issueCodes.push("manifest_json_invalid");
  }

  const scope = readScope(manifest, issueCodes);
  const signingKeyIdMatches = Boolean(
    manifest
      && typeof manifest.signing_key_id === "string"
      && manifest.signing_key_id === options.keyId
      && isSafeIdentifier(options.keyId),
  );
  if (!signingKeyIdMatches) {
    issueCodes.push("signing_key_id_invalid");
  }

  const manifestGeneratedAt = readIsoTimestamp(
    manifest?.generated_at,
    "manifest_generated_at",
    issueCodes,
  );
  const manifestValidUntil = readIsoTimestamp(
    manifest?.valid_until,
    "manifest_valid_until",
    issueCodes,
  );
  const manifestFresh = Boolean(
    manifestGeneratedAt
      && isRecentPast(manifestGeneratedAt.getTime(), nowMs, MANIFEST_MAX_AGE_MS),
  );
  if (!manifestFresh) {
    issueCodes.push("manifest_stale");
  }
  const manifestCurrent = Boolean(
    manifestGeneratedAt
      && manifestValidUntil
      && manifestValidUntil.getTime() > nowMs
      && manifestValidUntil.getTime() > manifestGeneratedAt.getTime(),
  );
  if (!manifestCurrent) {
    issueCodes.push("manifest_expired");
  }

  const receiptEntries = Array.isArray(manifest?.receipts)
    ? manifest.receipts
    : [];
  if (!Array.isArray(manifest?.receipts)) {
    issueCodes.push("receipts_invalid");
  }
  const receivedKinds = receiptEntries
    .map((entry) => entry?.kind)
    .filter((kind) => typeof kind === "string");
  if (
    receiptEntries.length !== requiredReceiptKinds.length
    || new Set(receivedKinds).size !== requiredReceiptKinds.length
    || requiredReceiptKinds.some((kind) => !receivedKinds.includes(kind))
    || receivedKinds.some((kind) => !requiredReceiptKinds.includes(kind))
  ) {
    issueCodes.push("receipt_kind_set_invalid");
  }

  const receiptResults = [];
  for (const kind of requiredReceiptKinds) {
    const matching = receiptEntries.filter((entry) => entry?.kind === kind);
    receiptResults.push(await inspectReceipt({
      root,
      entry: matching.length === 1 ? matching[0] : null,
      kind,
      nowMs,
      manifestValidUntil,
      issueCodes,
    }));
  }

  const digests = receiptResults.map((entry) => entry.sha256);
  const distinctReceiptDigests = digests.every(isSha256)
    && new Set(digests).size === requiredReceiptKinds.length;
  if (!distinctReceiptDigests) {
    issueCodes.push("receipt_digests_not_distinct");
  }

  const dailyBackup = receiptResults.find((entry) => entry.kind === "daily_backup");
  const backupDestruction = receiptResults.find(
    (entry) => entry.kind === "backup_destruction",
  );
  const allReceiptsVerified = receiptResults.every((entry) => entry.verified);
  const status = issueCodes.length === 0
    && manifestSignatureVerified
    && signingKeyIdMatches
    && manifestFresh
    && manifestCurrent
    && distinctReceiptDigests
    && allReceiptsVerified
      ? "pass"
      : "blocked";

  const report = {
    schema_version: REPORT_SCHEMA_VERSION,
    status,
    verified_at: now.toISOString(),
    valid_until: manifestValidUntil?.toISOString() ?? null,
    scope,
    manifest: {
      sha256: manifestSha256,
      signature_sha256: signatureSha256,
      signature_verified: manifestSignatureVerified,
      signing_key_id_matches: signingKeyIdMatches,
      fresh: manifestFresh,
      current: manifestCurrent,
    },
    receipts: receiptResults.map((entry) => ({
      kind: entry.kind,
      sha256: entry.sha256,
      present: entry.present,
      regular_file: entry.regularFile,
      restricted_permissions: entry.restrictedPermissions,
      hash_matches: entry.hashMatches,
      declared_signed: entry.declaredSigned,
      current: entry.current,
      verified: entry.verified,
    })),
    receipt_count: receiptResults.length,
    distinct_receipt_digests: distinctReceiptDigests,
    all_receipts_verified: allReceiptsVerified,
    freshness: {
      manifest_within_36_hours: manifestFresh,
      manifest_valid_until_future: manifestCurrent,
      daily_backup_within_36_hours: dailyBackup?.fresh ?? false,
      backup_destruction_within_45_days: backupDestruction?.fresh ?? false,
      backup_destruction_retention_days_35:
        backupDestruction?.retentionDaysValid ?? false,
      backup_destruction_coverage_at_least_35_days:
        backupDestruction?.coverageValid ?? false,
    },
    launch_environment: status === "pass"
      ? Object.fromEntries([
          ...receiptResults.map((entry) => [
            receiptEnvByKind.get(entry.kind),
            entry.sha256,
          ]),
          [
            "AAIS_RESEARCH_GOVERNANCE_MANIFEST_VERIFIED_AT",
            now.toISOString(),
          ],
          [
            "AAIS_RESEARCH_GOVERNANCE_MANIFEST_VALID_UNTIL",
            manifestValidUntil?.toISOString() ?? null,
          ],
          [
            "AAIS_RESEARCH_DAILY_BACKUP_COMPLETED_AT",
            dailyBackup?.completedAt ?? null,
          ],
          [
            "AAIS_RESEARCH_BACKUP_DESTRUCTION_OBSERVED_AT",
            backupDestruction?.observedAt ?? null,
          ],
        ])
      : null,
    issue_codes: [...new Set(issueCodes)].sort(),
    redaction: {
      source_paths_included: false,
      source_contents_included: false,
      identities_included: false,
      credentials_included: false,
    },
  };

  const outputPath = resolve(options.outputPath);
  await writeRestrictedReport({
    root,
    outputPath,
    report,
    issueCodes,
  });
  const reportBytes = await readFile(outputPath);
  return {
    report,
    outputSha256: sha256(reportBytes),
  };
}

async function inspectReceipt({
  root,
  entry,
  kind,
  nowMs,
  manifestValidUntil,
  issueCodes,
}) {
  const result = {
    kind,
    sha256: "",
    present: false,
    regularFile: false,
    restrictedPermissions: false,
    hashMatches: false,
    declaredSigned: false,
    current: false,
    verified: false,
    fresh: kind !== "daily_backup" && kind !== "backup_destruction",
    retentionDaysValid: kind !== "backup_policy" && kind !== "backup_destruction",
    coverageValid: kind !== "backup_destruction",
    completedAt: null,
    observedAt: null,
  };
  if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
    issueCodes.push(`receipt_${kind}_missing`);
    return result;
  }

  const declaredSha = typeof entry.sha256 === "string"
    ? entry.sha256.trim().toLowerCase()
    : "";
  result.sha256 = declaredSha;
  if (!isSha256(declaredSha)) {
    issueCodes.push(`receipt_${kind}_sha256_invalid`);
  }
  result.declaredSigned = entry.declared_signed === true;
  if (!result.declaredSigned) {
    issueCodes.push(`receipt_${kind}_signed_declaration_missing`);
  }

  const effectiveAt = readIsoTimestamp(
    entry.effective_at,
    `receipt_${kind}_effective_at`,
    issueCodes,
  );
  const expiresAt = readIsoTimestamp(
    entry.expires_at,
    `receipt_${kind}_expires_at`,
    issueCodes,
  );
  result.current = Boolean(
    effectiveAt
      && expiresAt
      && effectiveAt.getTime() <= nowMs + MAX_FUTURE_SKEW_MS
      && expiresAt.getTime() > nowMs
      && expiresAt.getTime() > effectiveAt.getTime()
      && (!manifestValidUntil
        || manifestValidUntil.getTime() <= expiresAt.getTime()),
  );
  if (!result.current) {
    issueCodes.push(`receipt_${kind}_not_current`);
  }

  if (kind === "backup_policy" || kind === "backup_destruction") {
    result.retentionDaysValid = entry.retention_days === 35;
    if (!result.retentionDaysValid) {
      issueCodes.push(`receipt_${kind}_retention_days_invalid`);
    }
  }

  if (kind === "daily_backup") {
    const completedAt = readIsoTimestamp(
      entry.completed_at,
      "receipt_daily_backup_completed_at",
      issueCodes,
    );
    result.completedAt = completedAt?.toISOString() ?? null;
    result.fresh = Boolean(
      completedAt
        && isRecentPast(completedAt.getTime(), nowMs, DAILY_BACKUP_MAX_AGE_MS),
    );
    if (!result.fresh) {
      issueCodes.push("receipt_daily_backup_stale");
    }
  }

  if (kind === "backup_destruction") {
    const observedAt = readIsoTimestamp(
      entry.observed_at,
      "receipt_backup_destruction_observed_at",
      issueCodes,
    );
    const coverageStartAt = readIsoTimestamp(
      entry.coverage_start_at,
      "receipt_backup_destruction_coverage_start_at",
      issueCodes,
    );
    const coverageEndAt = readIsoTimestamp(
      entry.coverage_end_at,
      "receipt_backup_destruction_coverage_end_at",
      issueCodes,
    );
    result.observedAt = observedAt?.toISOString() ?? null;
    result.fresh = Boolean(
      observedAt
        && isRecentPast(observedAt.getTime(), nowMs, DESTRUCTION_MAX_AGE_MS),
    );
    result.coverageValid = Boolean(
      observedAt
        && coverageStartAt
        && coverageEndAt
        && coverageEndAt.getTime() >= coverageStartAt.getTime()
          + 35 * 24 * 60 * 60 * 1_000
        && coverageEndAt.getTime() <= observedAt.getTime() + MAX_FUTURE_SKEW_MS,
    );
    if (!result.fresh) {
      issueCodes.push("receipt_backup_destruction_stale");
    }
    if (!result.coverageValid) {
      issueCodes.push("receipt_backup_destruction_coverage_invalid");
    }
  }

  if (
    typeof entry.file !== "string"
    || isAbsolute(entry.file)
    || entry.file.trim() !== entry.file
    || entry.file.length === 0
    || entry.file.split(/[\\/]/).includes("..")
  ) {
    issueCodes.push(`receipt_${kind}_path_invalid`);
    return result;
  }

  const inspection = await inspectRestrictedFile({
    root,
    candidatePath: resolve(root.path, entry.file),
    label: `receipt_${kind}`,
    issueCodes,
  });
  result.present = inspection.exists;
  result.regularFile = inspection.regularFile;
  result.restrictedPermissions = inspection.restrictedPermissions;
  if (inspection.safe) {
    const sourceBytes = await readFile(inspection.path);
    result.hashMatches = sha256(sourceBytes) === declaredSha;
    if (!result.hashMatches) {
      issueCodes.push(`receipt_${kind}_hash_mismatch`);
    }
  }
  result.verified = inspection.safe
    && result.hashMatches
    && result.declaredSigned
    && result.current
    && result.fresh
    && result.retentionDaysValid
    && result.coverageValid;
  return result;
}

function verifyManifestSignature({
  manifestBytes,
  signatureBytes,
  publicKeyBytes,
  issueCodes,
}) {
  try {
    if (signatureBytes.length !== 64) {
      issueCodes.push("manifest_signature_invalid");
      return false;
    }
    const publicKey = createPublicKey({
      key: publicKeyBytes,
      format: "der",
      type: "spki",
    });
    const canonical = publicKey.export({ format: "der", type: "spki" });
    if (
      publicKey.asymmetricKeyType !== "ed25519"
      || !Buffer.from(canonical).equals(publicKeyBytes)
    ) {
      issueCodes.push("manifest_verifying_key_invalid");
      return false;
    }
    const verified = verify(null, manifestBytes, publicKey, signatureBytes);
    if (!verified) {
      issueCodes.push("manifest_signature_invalid");
    }
    return verified;
  } catch {
    issueCodes.push("manifest_verifying_key_invalid");
    return false;
  }
}

function readScope(manifest, issueCodes) {
  const projectId = typeof manifest?.project_id === "string"
    ? manifest.project_id
    : "";
  const studyId = typeof manifest?.study_id === "string"
    ? manifest.study_id
    : "";
  const environment = typeof manifest?.environment === "string"
    ? manifest.environment
    : "";
  const lrsNamespace = typeof manifest?.lrs_namespace === "string"
    ? manifest.lrs_namespace
    : "";
  const lrsStoreId = typeof manifest?.lrs_store_id === "string"
    ? manifest.lrs_store_id
    : "";
  let namespaceValid = false;
  try {
    const parsed = new URL(lrsNamespace);
    const expectedNamespace =
      `${AAIS_NAMESPACE_PREFIX}studies/${encodeURIComponent(studyId)}/research/v1`;
    namespaceValid = lrsNamespace === expectedNamespace
      && parsed.origin === "https://www.aais.site"
      && !parsed.username
      && !parsed.password
      && !parsed.search
      && !parsed.hash;
  } catch {
    namespaceValid = false;
  }
  const valid = manifest?.schema_version === SCHEMA_VERSION
    && projectId === "aais"
    && isSafeIdentifier(studyId)
    && environment === "research"
    && namespaceValid
    && isSafeIdentifier(lrsStoreId);
  if (!valid) {
    issueCodes.push("manifest_scope_invalid");
  }
  return {
    project_id: valid ? projectId : null,
    study_id: valid ? studyId : null,
    environment: valid ? environment : null,
    lrs_namespace: valid ? lrsNamespace : null,
    lrs_store_id: valid ? lrsStoreId : null,
    valid,
  };
}

async function inspectRestrictedDirectory(path, label, issueCodes) {
  try {
    const linkMetadata = await lstat(path);
    const metadata = await stat(path);
    const canonicalPath = await realpath(path);
    const safe = !linkMetadata.isSymbolicLink()
      && metadata.isDirectory()
      && (metadata.mode & 0o077) === 0;
    if (!safe) {
      issueCodes.push(`${label}_unsafe`);
    }
    return { path: canonicalPath, requestedPath: resolve(path), safe };
  } catch {
    issueCodes.push(`${label}_missing`);
    return { path, requestedPath: resolve(path), safe: false };
  }
}

async function inspectRestrictedFile({
  root,
  candidatePath,
  label,
  issueCodes,
}) {
  const normalizedCandidatePath = normalizePathWithinRoot(root, candidatePath);
  const result = {
    path: normalizedCandidatePath ?? candidatePath,
    exists: false,
    regularFile: false,
    restrictedPermissions: false,
    safe: false,
  };
  if (!root.safe || !normalizedCandidatePath) {
    issueCodes.push(`${label}_outside_register`);
    return result;
  }
  try {
    const linkMetadata = await lstat(normalizedCandidatePath);
    if (linkMetadata.isSymbolicLink()) {
      issueCodes.push(`${label}_symlink_forbidden`);
      return result;
    }
    const canonicalPath = await realpath(normalizedCandidatePath);
    if (!isWithinRoot(root.path, canonicalPath)) {
      issueCodes.push(`${label}_outside_register`);
      return result;
    }
    const metadata = await stat(canonicalPath);
    result.path = canonicalPath;
    result.exists = true;
    result.regularFile = metadata.isFile();
    result.restrictedPermissions = (metadata.mode & 0o077) === 0;
    result.safe = result.regularFile
      && result.restrictedPermissions
      && metadata.size > 0;
    if (!result.regularFile) {
      issueCodes.push(`${label}_not_regular_file`);
    }
    if (!result.restrictedPermissions) {
      issueCodes.push(`${label}_permissions_not_restricted`);
    }
    if (metadata.size <= 0) {
      issueCodes.push(`${label}_empty`);
    }
  } catch {
    issueCodes.push(`${label}_missing`);
  }
  return result;
}

async function writeRestrictedReport({
  root,
  outputPath,
  report,
  issueCodes,
}) {
  const normalizedOutputPath = normalizePathWithinRoot(root, outputPath);
  if (!root.safe || !normalizedOutputPath) {
    throw new Error("output_outside_register");
  }
  const parentPath = dirname(normalizedOutputPath);
  await mkdir(parentPath, { recursive: true, mode: 0o700 });
  const parent = await inspectRestrictedDirectory(
    parentPath,
    "output_directory",
    issueCodes,
  );
  if (!parent.safe) {
    throw new Error("output_directory_unsafe");
  }
  try {
    const existing = await lstat(normalizedOutputPath);
    if (existing) {
      throw new Error("output_exists");
    }
  } catch (error) {
    if (error?.code !== "ENOENT") {
      throw error;
    }
  }
  await writeFile(
    normalizedOutputPath,
    `${JSON.stringify(report, null, 2)}\n`,
    { mode: 0o600, flag: "wx" },
  );
}

function readIsoTimestamp(value, label, issueCodes) {
  if (
    typeof value !== "string"
    || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.test(value)
  ) {
    issueCodes.push(`${label}_invalid`);
    return null;
  }
  const parsed = new Date(value);
  if (!Number.isFinite(parsed.getTime())) {
    issueCodes.push(`${label}_invalid`);
    return null;
  }
  const canonical = parsed.toISOString();
  if (
    value !== canonical
    && value !== canonical.replace(".000Z", "Z")
  ) {
    issueCodes.push(`${label}_invalid`);
    return null;
  }
  return parsed;
}

function isRecentPast(timestampMs, nowMs, maxAgeMs) {
  return timestampMs <= nowMs + MAX_FUTURE_SKEW_MS
    && timestampMs >= nowMs - maxAgeMs;
}

function isWithinRoot(root, candidate) {
  const pathFromRoot = relative(root, candidate);
  return pathFromRoot === ""
    || (!pathFromRoot.startsWith(`..${sep}`)
      && pathFromRoot !== ".."
      && !isAbsolute(pathFromRoot));
}

function normalizePathWithinRoot(root, candidate) {
  const absoluteCandidate = resolve(candidate);
  if (isWithinRoot(root.path, absoluteCandidate)) {
    return absoluteCandidate;
  }
  if (
    root.requestedPath
    && isWithinRoot(root.requestedPath, absoluteCandidate)
  ) {
    return resolve(
      root.path,
      relative(root.requestedPath, absoluteCandidate),
    );
  }
  return null;
}

function isSafeIdentifier(value) {
  return typeof value === "string"
    && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(value);
}

function isSha256(value) {
  return typeof value === "string" && /^[0-9a-f]{64}$/.test(value);
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function parseArguments(argv) {
  const values = {};
  for (let index = 0; index < argv.length; index += 2) {
    const name = argv[index];
    const value = argv[index + 1];
    if (!name?.startsWith("--") || value === undefined) {
      throw new Error("invalid_arguments");
    }
    values[name.slice(2)] = value;
  }
  const required = [
    "register-root",
    "manifest",
    "signature",
    "verifying-key-spki",
    "key-id",
    "output",
  ];
  if (required.some((name) => !values[name])) {
    throw new Error("missing_arguments");
  }
  return {
    registerRoot: values["register-root"],
    manifestPath: values.manifest,
    signaturePath: values.signature,
    verifyingKeySpkiPath: values["verifying-key-spki"],
    keyId: values["key-id"],
    outputPath: values.output,
    now: values.now ? new Date(values.now) : new Date(),
  };
}

async function main() {
  try {
    const result = await verifyAaisResearchGovernanceEvidence(
      parseArguments(process.argv.slice(2)),
    );
    process.stdout.write(`${JSON.stringify({
      status: result.report.status,
      output_sha256: result.outputSha256,
      receipt_count: result.report.receipt_count,
      distinct_receipt_digests: result.report.distinct_receipt_digests,
      issue_codes: result.report.issue_codes,
    })}\n`);
    if (result.report.status !== "pass") {
      process.exitCode = 1;
    }
  } catch (error) {
    const safeCodes = new Set([
      "invalid_arguments",
      "missing_arguments",
      "invalid_now",
      "output_outside_register",
      "output_directory_unsafe",
      "output_exists",
    ]);
    const candidateCode = error instanceof Error ? error.message : "";
    process.stderr.write(`${JSON.stringify({
      status: "blocked",
      code: safeCodes.has(candidateCode) ? candidateCode : "verification_failed",
    })}\n`);
    process.exitCode = 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}
