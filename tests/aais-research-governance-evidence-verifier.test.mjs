// @vitest-environment node

import {
  createHash,
  generateKeyPairSync,
  sign,
} from "node:crypto";
import {
  chmod,
  lstat,
  mkdtemp,
  mkdir,
  readFile,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { verifyAaisResearchGovernanceEvidence } from "../scripts/verify-aais-research-governance-evidence.mjs";

const now = new Date("2026-07-30T12:00:00.000Z");
const receiptKinds = [
  "database_isolation",
  "lrs_isolation",
  "lrs_zero_baseline",
  "lrs_put_delete",
  "backup_policy",
  "restore",
  "legacy_archive",
  "access_register",
  "consent_legal_basis",
  "dpa",
  "data_region",
  "daily_backup",
  "backup_destruction",
];

const tempRoots = [];

afterEach(async () => {
  const { rm } = await import("node:fs/promises");
  await Promise.all(tempRoots.splice(0).map((path) =>
    rm(path, { recursive: true, force: true })));
});

describe("AAIS restricted governance evidence verifier", () => {
  it("verifies a signed, current, permission-restricted manifest without emitting source paths or contents", async () => {
    const fixture = await createFixture();
    const outputPath = join(fixture.root, "reports", "verified.json");

    const result = await verifyAaisResearchGovernanceEvidence({
      ...fixture.options,
      outputPath,
      now,
    });

    expect(result.report).toMatchObject({
      status: "pass",
      receipt_count: 13,
      distinct_receipt_digests: true,
      all_receipts_verified: true,
      manifest: {
        signature_verified: true,
        signing_key_id_matches: true,
        fresh: true,
        current: true,
      },
      freshness: {
        manifest_within_36_hours: true,
        daily_backup_within_36_hours: true,
        backup_destruction_within_45_days: true,
        backup_destruction_retention_days_35: true,
        backup_destruction_coverage_at_least_35_days: true,
      },
      redaction: {
        source_paths_included: false,
        source_contents_included: false,
        identities_included: false,
        credentials_included: false,
      },
      issue_codes: [],
    });
    expect(result.outputSha256).toMatch(/^[0-9a-f]{64}$/);
    expect(Object.keys(result.report.launch_environment)).toEqual(
      expect.arrayContaining([
        "AAIS_RESEARCH_ACCESS_REGISTER_RECEIPT_SHA256",
        "AAIS_RESEARCH_CONSENT_LEGAL_BASIS_RECEIPT_SHA256",
        "AAIS_RESEARCH_DPA_RECEIPT_SHA256",
        "AAIS_RESEARCH_DATA_REGION_RECEIPT_SHA256",
        "AAIS_RESEARCH_DAILY_BACKUP_RECEIPT_SHA256",
        "AAIS_RESEARCH_BACKUP_DESTRUCTION_RECEIPT_SHA256",
        "AAIS_RESEARCH_GOVERNANCE_MANIFEST_VERIFIED_AT",
        "AAIS_RESEARCH_GOVERNANCE_MANIFEST_VALID_UNTIL",
        "AAIS_RESEARCH_DAILY_BACKUP_COMPLETED_AT",
        "AAIS_RESEARCH_BACKUP_DESTRUCTION_OBSERVED_AT",
      ]),
    );

    const serialized = await readFile(outputPath, "utf8");
    expect(serialized).not.toContain(fixture.root);
    expect(serialized).not.toContain("SYNTHETIC-PRIVATE-CONTENT");
    expect(serialized).not.toContain(".receipt");
    expect((await lstat(outputPath)).mode & 0o777).toBe(0o600);
  });

  it("fails closed when two controls reuse one receipt digest", async () => {
    const fixture = await createFixture({
      mutateManifest(manifest) {
        manifest.receipts[1].sha256 = manifest.receipts[0].sha256;
        manifest.receipts[1].file = manifest.receipts[0].file;
      },
    });

    const result = await verifyAaisResearchGovernanceEvidence({
      ...fixture.options,
      outputPath: join(fixture.root, "reports", "duplicate.json"),
      now,
    });

    expect(result.report.status).toBe("blocked");
    expect(result.report.distinct_receipt_digests).toBe(false);
    expect(result.report.launch_environment).toBeNull();
    expect(result.report.issue_codes).toContain("receipt_digests_not_distinct");
  });

  it("fails closed when daily backup or 35-day destruction evidence is stale", async () => {
    const fixture = await createFixture({
      mutateManifest(manifest) {
        const daily = manifest.receipts.find((entry) => entry.kind === "daily_backup");
        const destruction = manifest.receipts.find(
          (entry) => entry.kind === "backup_destruction",
        );
        daily.completed_at = "2026-07-28T22:59:59.000Z";
        destruction.observed_at = "2026-06-14T11:59:59.000Z";
      },
    });

    const result = await verifyAaisResearchGovernanceEvidence({
      ...fixture.options,
      outputPath: join(fixture.root, "reports", "stale.json"),
      now,
    });

    expect(result.report.status).toBe("blocked");
    expect(result.report.freshness).toMatchObject({
      daily_backup_within_36_hours: false,
      backup_destruction_within_45_days: false,
    });
    expect(result.report.issue_codes).toEqual(expect.arrayContaining([
      "receipt_daily_backup_stale",
      "receipt_backup_destruction_stale",
    ]));
  });

  it("rejects a source artifact with group/world access", async () => {
    const fixture = await createFixture();
    await chmod(fixture.receiptPaths.get("access_register"), 0o644);

    const result = await verifyAaisResearchGovernanceEvidence({
      ...fixture.options,
      outputPath: join(fixture.root, "reports", "permissions.json"),
      now,
    });

    expect(result.report.status).toBe("blocked");
    expect(result.report.issue_codes).toContain(
      "receipt_access_register_permissions_not_restricted",
    );
    expect(
      result.report.receipts.find((entry) => entry.kind === "access_register"),
    ).toMatchObject({
      restricted_permissions: false,
      verified: false,
    });
  });

  it("rejects a symlinked receipt and a modified detached signature", async () => {
    const fixture = await createFixture();
    const source = fixture.receiptPaths.get("dpa");
    const link = join(fixture.root, "receipts", "dpa-link.receipt");
    await symlink(source, link);
    const manifest = JSON.parse(await readFile(fixture.options.manifestPath, "utf8"));
    manifest.receipts.find((entry) => entry.kind === "dpa").file =
      "receipts/dpa-link.receipt";
    await rewriteSignedManifest(fixture, manifest);
    const signature = await readFile(fixture.options.signaturePath);
    signature[0] ^= 0xff;
    await writeFile(fixture.options.signaturePath, signature, { mode: 0o600 });

    const result = await verifyAaisResearchGovernanceEvidence({
      ...fixture.options,
      outputPath: join(fixture.root, "reports", "tampered.json"),
      now,
    });

    expect(result.report.status).toBe("blocked");
    expect(result.report.manifest.signature_verified).toBe(false);
    expect(result.report.issue_codes).toEqual(expect.arrayContaining([
      "manifest_signature_invalid",
      "receipt_dpa_symlink_forbidden",
    ]));
  });
});

async function createFixture(options = {}) {
  const root = await mkdtemp(join(tmpdir(), "aais-governance-"));
  tempRoots.push(root);
  await chmod(root, 0o700);
  const receiptsDirectory = join(root, "receipts");
  await mkdir(receiptsDirectory, { mode: 0o700 });
  const receiptPaths = new Map();
  const receipts = [];

  for (const [index, kind] of receiptKinds.entries()) {
    const file = `receipts/${kind}.receipt`;
    const path = join(root, file);
    const bytes = Buffer.from(
      `SYNTHETIC-PRIVATE-CONTENT-${kind}-${index}\n`,
      "utf8",
    );
    await writeFile(path, bytes, { mode: 0o600 });
    receiptPaths.set(kind, path);
    receipts.push({
      kind,
      file,
      sha256: sha256(bytes),
      declared_signed: true,
      effective_at: "2026-07-01T00:00:00.000Z",
      expires_at: "2026-08-30T00:00:00.000Z",
      ...(kind === "backup_policy" || kind === "backup_destruction"
        ? { retention_days: 35 }
        : {}),
      ...(kind === "daily_backup"
        ? { completed_at: "2026-07-30T00:00:00.000Z" }
        : {}),
      ...(kind === "backup_destruction"
        ? {
            observed_at: "2026-07-23T12:00:00.000Z",
            coverage_start_at: "2026-06-18T12:00:00.000Z",
            coverage_end_at: "2026-07-23T12:00:00.000Z",
          }
        : {}),
    });
  }

  const keyPair = generateKeyPairSync("ed25519");
  const publicKeyBytes = keyPair.publicKey.export({ format: "der", type: "spki" });
  const verifyingKeySpkiPath = join(root, "governance-verifying-key.der");
  await writeFile(verifyingKeySpkiPath, publicKeyBytes, { mode: 0o600 });
  const manifest = {
    schema_version: "aais-research-governance-evidence/v1",
    project_id: "aais",
    study_id: "ca-pilot-2026",
    environment: "research",
    lrs_namespace:
      "https://www.aais.site/xapi/studies/ca-pilot-2026/research/v1",
    lrs_store_id: "aais-research-clean-store",
    generated_at: "2026-07-30T11:00:00.000Z",
    valid_until: "2026-08-29T00:00:00.000Z",
    signing_key_id: "institution-governance-2026-01",
    receipts,
  };
  options.mutateManifest?.(manifest);
  const manifestPath = join(root, "manifest.json");
  const signaturePath = join(root, "manifest.sig");
  const fixture = {
    root,
    keyPair,
    receiptPaths,
    options: {
      registerRoot: root,
      manifestPath,
      signaturePath,
      verifyingKeySpkiPath,
      keyId: "institution-governance-2026-01",
    },
  };
  await rewriteSignedManifest(fixture, manifest);
  return fixture;
}

async function rewriteSignedManifest(fixture, manifest) {
  const manifestBytes = Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`);
  const signature = sign(null, manifestBytes, fixture.keyPair.privateKey);
  await writeFile(fixture.options.manifestPath, manifestBytes, { mode: 0o600 });
  await writeFile(fixture.options.signaturePath, signature, { mode: 0o600 });
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}
