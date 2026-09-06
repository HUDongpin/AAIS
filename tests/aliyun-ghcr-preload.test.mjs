import { spawnSync } from "node:child_process";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const helper = join(
  process.cwd(),
  "deploy/aliyun/aais-preload-ghcr-image.sh",
);
const releaseSha = "a".repeat(40);
const imageDigest = `sha256:${"b".repeat(64)}`;
const repository = "ghcr.io/hudongpin/aais";
const temporaryDirectories = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

function temporaryDirectory() {
  const directory = mkdtempSync(join(tmpdir(), "aais-ghcr-preload-"));
  temporaryDirectories.push(directory);
  return directory;
}

function runFunction(body, args = []) {
  return spawnSync(
    "bash",
    ["-c", `source "$1"\n${body}`, "aais-ghcr-test", helper, ...args],
    { encoding: "utf8" },
  );
}

function candidateReceipt(overrides = {}) {
  return {
    schemaVersion: 1,
    provider: "github",
    stage: "ghcr_candidate",
    gitSha: releaseSha,
    imageRepository: repository,
    imageTag: `${repository}:${releaseSha}`,
    imageDigest,
    githubRunId: "123",
    githubRunAttempt: "1",
    packageVisibility: "private",
    sbomGenerated: true,
    provenanceGenerated: true,
    provenanceAttestationId: "attestation-123",
    secrets: "redacted",
    ...overrides,
  };
}

function preloadedReceipt(overrides = {}) {
  return {
    schemaVersion: 1,
    provider: "github",
    stage: "ghcr_preloaded",
    gitSha: releaseSha,
    imageRepository: repository,
    imageDigest,
    localRepoDigest: `${repository}@${imageDigest}`,
    imageRevision: releaseSha,
    candidateRunId: "123",
    candidateRunAttempt: "1",
    pulledAt: "2026-08-31T00:00:00Z",
    credentialsCleaned: true,
    secrets: "redacted",
    ...overrides,
  };
}

describe("AAIS private GHCR preload helper", () => {
  it("closes credential entry until the exact audited Owner launcher is bound", () => {
    const source = readFileSync(helper, "utf8");
    const main = source.slice(source.indexOf("aais_preload_main() {"));
    expect(main.indexOf("aais_require_audited_owner_launcher || return 1"))
      .toBeLessThan(main.indexOf('source "$deploy_config_file"'));
    expect(main.indexOf("aais_require_audited_owner_launcher || return 1"))
      .toBeLessThan(main.indexOf("read -r -s ghcr_token"));
    // Only this inert refusal function is exercised, not the launcher/main.
    const result = runFunction("aais_require_audited_owner_launcher");
    expect(result.status).toBe(1);
    expect(result.stderr.trim()).toBe("BLOCKED_AAIS_AUDITED_OWNER_LAUNCHER_BINDING_MISSING");
    expect(result.stdout).toBe("");
  });

  it("accepts the token only through hidden controlling-TTY input", () => {
    const source = readFileSync(helper, "utf8");
    const bootstrap = readFileSync(
      "deploy/aliyun/aais-secrets-bootstrap.sh",
      "utf8",
    );

    expect(source).toContain("set +x");
    expect(source).toContain("read -r -s ghcr_token < /dev/tty");
    expect(source).toContain("--password-stdin");
    expect(source).toContain("ghcr-docker-config.XXXXXX");
    expect(source).toContain("chmod 0700");
    expect(source).toContain('local runtime_parent="/run/aais"');
    expect(source).toContain(
      'install -d -o root -g aais-worker -m 0750 "$runtime_parent"',
    );
    expect(bootstrap).toContain(
      "install -d -o root -g aais-worker -m 0750 /run/aais /run/aais/generations",
    );
    expect(source).not.toContain(
      'install -d -o root -g root -m 0700 "$runtime_parent"',
    );
    expect(source).not.toContain(
      'install -d -o root -g root -m 0755 "$runtime_parent"',
    );
    expect(source).toContain(
      'aais_preload_credential_parent="${runtime_parent}/ghcr-credentials"',
    );
    expect(source).toContain(
      'install -d -o root -g root -m 0700 "$aais_preload_credential_parent"',
    );
    expect(source).toContain("aais_cleanup_ghcr_credentials");
    expect(source).toContain("write-preloaded");
    expect(source).toContain("validate-preloaded");
    expect(source).toContain(
      'readonly AAIS_JSON_HELPER_PATH="/opt/aais/libexec/aais-json-v1.py"',
    );
    expect(source).toContain(
      "/usr/bin/python3 -I -S -B \"$helper_path\"",
    );
    expect(source).not.toMatch(/\bjq\b/);
    expect(source).toContain(
      "Usage: aais-preload-ghcr-image.sh <full-40-character-git-sha>",
    );
    expect(source).not.toMatch(/GH_TOKEN|GITHUB_TOKEN|CR_PAT|AAIS_GHCR_TOKEN/);
    expect(source).not.toContain('echo "$ghcr_token"');
    expect(source).not.toContain("--username HUDongpin");
    expect(source).toContain('--username "$AAIS_GHCR_USERNAME"');
    expect(source.lastIndexOf("aais_require_owner_tty"))
      .toBeLessThan(source.lastIndexOf("read -r -s ghcr_token"));
  });

  it("rejects an invalid configured GHCR username", () => {
    const result = runFunction('aais_validate_ghcr_username "$2"', [
      "bad_name",
    ]);

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("AAIS GHCR username is invalid.");
  });

  it("fails closed without an interactive controlling TTY", () => {
    const result = runFunction("aais_require_owner_tty");

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain(
      "AAIS GHCR preload requires an interactive controlling TTY.",
    );
  });

  it("rejects a receipt with the wrong file permissions", () => {
    const directory = temporaryDirectory();
    const receipt = join(directory, "candidate.json");
    writeFileSync(receipt, `${JSON.stringify(candidateReceipt())}\n`, {
      mode: 0o600,
    });
    chmodSync(receipt, 0o600);
    const result = runFunction(
      'aais_require_protected_file "$2" 644 "test receipt" "$3"',
      [receipt, String(process.getuid())],
    );

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("mode 0644");
  });

  it("requires canonical non-symlink receipt directories with exact mode 0755", () => {
    const directory = temporaryDirectory();
    const receipts = join(directory, "receipts");
    const link = join(directory, "receipts-link");
    mkdirSync(receipts, { mode: 0o755 });
    chmodSync(receipts, 0o755);
    symlinkSync(receipts, link);
    const canonicalReceipts = realpathSync(receipts);

    const valid = runFunction(
      'aais_require_protected_directory "$2" 755 "test directory" "$3"',
      [canonicalReceipts, String(process.getuid())],
    );
    expect(valid.status).toBe(0);
    const wrongOwner = runFunction(
      'aais_require_protected_directory "$2" 755 "test directory" "$3"',
      [canonicalReceipts, String(process.getuid() + 1)],
    );
    expect(wrongOwner.status).not.toBe(0);

    for (const rejected of [`${canonicalReceipts}/.`, link]) {
      const result = runFunction(
        'aais_require_protected_directory "$2" 755 "test directory" "$3"',
        [rejected, String(process.getuid())],
      );
      expect(result.status, rejected).not.toBe(0);
    }

    for (const mode of [0o775, 0o757, 0o777]) {
      chmodSync(receipts, mode);
      const result = runFunction(
        'aais_require_protected_directory "$2" 755 "test directory" "$3"',
        [canonicalReceipts, String(process.getuid())],
      );
      expect(result.status, mode.toString(8)).not.toBe(0);
    }
  });

  it("rejects candidate and preload receipt mismatches", () => {
    const directory = temporaryDirectory();
    const candidate = join(directory, "candidate.json");
    const preloaded = join(directory, "preloaded.json");
    writeFileSync(candidate, `${JSON.stringify(candidateReceipt())}\n`);
    writeFileSync(preloaded, `${JSON.stringify(preloadedReceipt())}\n`);

    const validCandidate = runFunction(
      'aais_validate_ghcr_candidate_receipt "$2" "$3" "$4" "$5"',
      [candidate, releaseSha, imageDigest, join(process.cwd(), "deploy/aliyun/aais-json-v1.py")],
    );
    expect(validCandidate.status).toBe(0);
    expect(validCandidate.stdout).toBe(`${imageDigest}\t123\t1\n`);

    const wrongCandidateDigest = runFunction(
      'aais_validate_ghcr_candidate_receipt "$2" "$3" "$4" "$5"',
      [
        candidate,
        releaseSha,
        `sha256:${"c".repeat(64)}`,
        join(process.cwd(), "deploy/aliyun/aais-json-v1.py"),
      ],
    );
    expect(wrongCandidateDigest.status).not.toBe(0);

    const wrongCandidateRun = runFunction(
      'aais_validate_ghcr_preloaded_receipt "$2" "$3" "$4" "$5" "$6" "$7"',
      [
        preloaded,
        releaseSha,
        imageDigest,
        "999",
        "1",
        join(process.cwd(), "deploy/aliyun/aais-json-v1.py"),
      ],
    );
    expect(wrongCandidateRun.status).not.toBe(0);
  });

  it("validates an existing preload before any TTY, login, or pull", () => {
    const source = readFileSync(helper, "utf8");
    const candidateDirectoryValidation = source.indexOf(
      'aais_require_protected_directory "$AAIS_CANDIDATE_RECEIPT_DIR" 755',
    );
    const preloadedDirectoryValidation = source.indexOf(
      'aais_require_protected_directory "$AAIS_PRELOADED_RECEIPT_DIR" 755',
    );
    const candidateReceiptValidation = source.indexOf(
      'candidate_metadata="$(aais_validate_ghcr_candidate_receipt',
    );
    const existingReceiptValidation = source.indexOf(
      'aais_validate_ghcr_preloaded_receipt "$preloaded_receipt"',
    );

    expect(candidateDirectoryValidation).toBeGreaterThan(-1);
    expect(preloadedDirectoryValidation).toBeGreaterThan(-1);
    expect(candidateDirectoryValidation).toBeLessThan(candidateReceiptValidation);
    expect(preloadedDirectoryValidation).toBeLessThan(candidateReceiptValidation);
    expect(existingReceiptValidation).toBeGreaterThan(-1);
    expect(existingReceiptValidation).toBeLessThan(
      source.lastIndexOf("aais_require_owner_tty"),
    );
    expect(existingReceiptValidation).toBeLessThan(source.indexOf("docker login ghcr.io"));
    expect(existingReceiptValidation).toBeLessThan(source.indexOf('docker pull "$image_ref"'));
    expect(source).toContain("aais_preload_receipt_candidate");
    expect(source.indexOf("write-preloaded")).toBeLessThan(
      source.lastIndexOf('mv -Tf -- "$aais_preload_receipt_candidate"'),
    );
    expect(source.lastIndexOf("validate-preloaded")).toBeLessThan(
      source.lastIndexOf('mv -Tf -- "$aais_preload_receipt_candidate"'),
    );
    expect(source).toContain(
      '"$AAIS_CANDIDATE_RECEIPT_DIR" != "/opt/aais/candidates"',
    );
    expect(source).toContain(
      '"$AAIS_PRELOADED_RECEIPT_DIR" != "/opt/aais/preloaded"',
    );
    expect(source).not.toContain(
      'install -d -o root -g root -m 0755 "$AAIS_PRELOADED_RECEIPT_DIR"',
    );
  });

  it("rejects a local RepoDigest mismatch even when the revision matches", () => {
    const wrongRepoDigest = `${repository}@sha256:${"c".repeat(64)}`;
    const expectedRepoDigest = `${repository}@${imageDigest}`;
    const result = runFunction(
      'aais_validate_local_image_provenance "$2" "$3" "$4" "$5"',
      [wrongRepoDigest, releaseSha, expectedRepoDigest, releaseSha],
    );

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("local image digest or OCI revision");
  });

  it("logs out, deletes the isolated Docker config, and unsets its binding", () => {
    const directory = temporaryDirectory();
    const configDirectory = join(directory, "ghcr-docker-config.test");
    const logoutLog = join(directory, "docker.log");
    mkdirSync(configDirectory, { mode: 0o700 });
    writeFileSync(
      join(configDirectory, "config.json"),
      '{"auths":{"ghcr.io":{"auth":"must-be-removed"}}}\n',
      { mode: 0o600 },
    );
    const result = runFunction(
      `logout_log="$4"
       docker() { printf '%s\\n' "$*" >> "$logout_log"; }
       export DOCKER_CONFIG="$2"
       aais_cleanup_ghcr_credentials "$2" "$3" ghcr.io
       [[ ! -e "$2" && -z "\${DOCKER_CONFIG+x}" ]]`,
      [configDirectory, directory, logoutLog],
    );

    expect(result.status).toBe(0);
    expect(readFileSync(logoutLog, "utf8")).toBe("logout ghcr.io\n");
    expect(() => readFileSync(join(configDirectory, "config.json"))).toThrow();
  });

  it("fails closed but still deletes credentials when Docker logout fails", () => {
    const directory = temporaryDirectory();
    const configDirectory = join(directory, "ghcr-docker-config.failed-logout");
    mkdirSync(configDirectory, { mode: 0o700 });
    writeFileSync(join(configDirectory, "config.json"), "credential\n", {
      mode: 0o600,
    });
    const result = runFunction(
      `docker() { return 1; }
       export DOCKER_CONFIG="$2"
       cleanup_status=0
       aais_cleanup_ghcr_credentials "$2" "$3" ghcr.io || cleanup_status=$?
       [[ "$cleanup_status" -ne 0 && ! -e "$2" && -z "\${DOCKER_CONFIG+x}" ]]`,
      [configDirectory, directory],
    );

    expect(result.status).toBe(0);
    expect(() => readFileSync(join(configDirectory, "config.json"))).toThrow();
  });
});
