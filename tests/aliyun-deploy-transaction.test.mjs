import { execFileSync, spawnSync } from "node:child_process";
import { readFileSync, statSync } from "node:fs";
import { describe, expect, it } from "vitest";

const deployPath = "deploy/aliyun/aais-deploy.sh";
const faultHarnessPath = "tests/aliyun-deploy-transaction-faults.sh";
const TEST_IMAGE_ID = "be23f54a88d34e8824c741b19b91064094f92c1c97b194144bfc8b50d67258e2";

describe("AAIS deploy transaction recovery", () => {
  it("pre-arms each catchable-signal rollback before an atomic publish", () => {
    const deploy = readFileSync(deployPath, "utf8");
    const publishStart = deploy.indexOf("\npause_worker_timers\n");
    const upstreamAttempt = deploy.indexOf(
      'upstream_publish_attempted="true"',
      publishStart,
    );
    const upstreamMove = deploy.indexOf(
      'mv -Tf -- "$candidate_upstream" "$AAIS_UPSTREAM_FILE"',
      publishStart,
    );
    const nginxTest = deploy.indexOf(
      '"$AAIS_NGINX_BINARY" -t >/dev/null',
      upstreamMove,
    );
    const reloadAttempt = deploy.indexOf(
      'nginx_reload_attempted="true"',
      nginxTest,
    );
    const nginxReload = deploy.indexOf(
      '"$AAIS_NGINX_BINARY" -s reload >/dev/null',
      reloadAttempt,
    );
    const stateAttempt = deploy.indexOf(
      'state_commit_attempted="true"',
      nginxReload,
    );
    const stateMove = deploy.indexOf(
      'mv -Tf -- "$candidate_state" "$AAIS_STATE_FILE"',
      stateAttempt,
    );
    const receiptAttempt = deploy.indexOf(
      'receipt_publish_attempted="true"',
      stateMove,
    );
    const receiptMove = deploy.indexOf(
      'mv -Tf -- "$candidate_receipt" "$receipt_file"',
      receiptAttempt,
    );

    for (const offset of [
      publishStart,
      upstreamAttempt,
      upstreamMove,
      nginxTest,
      reloadAttempt,
      nginxReload,
      stateAttempt,
      stateMove,
      receiptAttempt,
      receiptMove,
    ]) {
      expect(offset).toBeGreaterThan(-1);
    }
    expect(upstreamAttempt).toBeLessThan(upstreamMove);
    expect(upstreamMove).toBeLessThan(nginxTest);
    expect(nginxTest).toBeLessThan(reloadAttempt);
    expect(reloadAttempt).toBeLessThan(nginxReload);
    expect(stateAttempt).toBeLessThan(stateMove);
    expect(receiptAttempt).toBeLessThan(receiptMove);
    expect(
      deploy.indexOf("trap '' INT TERM HUP", receiptAttempt),
    ).toBeLessThan(receiptMove);
    expect(receiptMove).toBeLessThan(deploy.indexOf("trap - EXIT", receiptMove));
    expect(deploy).not.toMatch(/nginx_switched|state_committed|receipt_committed/);
  });

  it("publishes upstream and receipt candidates from their destination directories", () => {
    const deploy = readFileSync(deployPath, "utf8");

    expect(deploy).toContain(
      'candidate_upstream="$(mktemp "$(dirname "$AAIS_UPSTREAM_FILE")/.aais-upstream.candidate.XXXXXX")"',
    );
    expect(deploy).toContain(
      'candidate_receipt="$(mktemp "${AAIS_RECEIPT_DIR}/.aais-deployment-receipt.candidate.XXXXXX")"',
    );
    expect(deploy).toContain("restore_previous_upstream_file() {");
    expect(deploy).toContain(
      'install -o root -g root -m 0644 "$previous_upstream" "$candidate_upstream"',
    );
    expect(deploy.match(
      /mv -Tf -- "\$candidate_upstream" "\$AAIS_UPSTREAM_FILE"/g,
    )).toHaveLength(2);
    expect(deploy).toContain("trap '' INT TERM HUP");
    expect(deploy).toContain("restore_previous_bootstrap_path() {");
  });

  it("fences abandoned rotation markers before container or Nginx mutation", () => {
    const deploy = readFileSync(deployPath, "utf8");
    const rotationFence = deploy.indexOf(
      "AAIS secret rotation state requires the verified inherited operation lock.",
    );
    const canonicalFence = deploy.indexOf(
      "AAIS deployment is fenced during the canonical secret check.",
    );
    const invalidFence = deploy.indexOf(
      "AAIS deployment is fenced by an invalid secret rotation state.",
    );
    const firstRecoveryReload = deploy.indexOf(
      '"$AAIS_NGINX_BINARY" -s reload >/dev/null',
    );
    const firstContainerMutation = deploy.indexOf("docker network create aais-net");

    expect(deploy).toContain("AAIS_ROTATION_CANONICAL_CHECK_FILE");
    expect(deploy).toContain(
      'AAIS_ROTATION_INVALID_FILE:=$(dirname "$AAIS_STATE_FILE")/secret-rotation.invalid',
    );
    expect(deploy).toContain('-L "$AAIS_ROTATION_INVALID_FILE"');
    expect(deploy).toContain('rotation_lock_inherited="true"');
    expect(rotationFence).toBeGreaterThan(-1);
    expect(canonicalFence).toBeGreaterThan(-1);
    expect(invalidFence).toBeGreaterThan(-1);
    expect(rotationFence).toBeLessThan(firstRecoveryReload);
    expect(rotationFence).toBeLessThan(firstContainerMutation);
    expect(canonicalFence).toBeLessThan(firstRecoveryReload);
    expect(canonicalFence).toBeLessThan(firstContainerMutation);
    expect(invalidFence).toBeLessThan(firstRecoveryReload);
    expect(invalidFence).toBeLessThan(firstContainerMutation);
  });

  it("protects every receipt directory before receipt metadata or JSON reads", () => {
    const deploy = readFileSync(deployPath, "utf8");
    const directoryGuard = deploy.indexOf(
      'require_protected_receipt_directory "$AAIS_CANDIDATE_RECEIPT_DIR"',
    );
    const candidateReceiptStat = deploy.indexOf("candidate_receipt_mode=");
    const candidateReceiptJson = deploy.indexOf(
      "aais_run_json_helper candidate-metadata",
    );

    expect(deploy).toContain("require_protected_receipt_directory() {");
    expect(deploy).toContain('canonical" != "$directory"');
    expect(deploy).toContain('owner" != "0"');
    expect(deploy).toContain('mode" != "755"');
    expect(deploy).toContain('-L "$directory"');
    expect(deploy).toContain('identity_after" != "$identity_before"');
    expect(deploy).toContain(
      'require_protected_receipt_directory "$AAIS_PRELOADED_RECEIPT_DIR"',
    );
    expect(deploy).toContain(
      'require_protected_receipt_directory "$AAIS_RECEIPT_DIR"',
    );
    expect(directoryGuard).toBeGreaterThan(-1);
    expect(directoryGuard).toBeLessThan(candidateReceiptStat);
    expect(directoryGuard).toBeLessThan(candidateReceiptJson);
  });

  it("takes strict timer snapshots before every deployment mutation", () => {
    const deploy = readFileSync(deployPath, "utf8");
    const emailSnapshot = deploy.indexOf(
      'email_timer_snapshot="$(read_systemd_active_state "$email_timer")"',
    );
    const lrsSnapshot = deploy.indexOf(
      'lrs_timer_snapshot="$(read_systemd_active_state "$lrs_timer")"',
    );
    const firstRecoveryReload = deploy.indexOf(
      '"$AAIS_NGINX_BINARY" -s reload >/dev/null',
    );
    const firstContainerMutation = deploy.indexOf("docker network create aais-net");
    const firstTimerStop = deploy.indexOf('systemctl stop "$email_timer"');

    expect(deploy).toContain(
      "systemctl show --property=LoadState --property=ActiveState",
    );
    expect(deploy).not.toContain("systemctl is-active");
    expect(emailSnapshot).toBeGreaterThan(-1);
    expect(lrsSnapshot).toBeGreaterThan(emailSnapshot);
    for (const mutation of [firstRecoveryReload, firstContainerMutation, firstTimerStop]) {
      expect(mutation).toBeGreaterThan(lrsSnapshot);
    }
    expect(deploy).toContain('email_timer_snapshot" != "active"');
    expect(deploy).toContain('email_timer_snapshot" != "inactive"');
    expect(deploy).toContain("active|activating|deactivating|reloading");
    expect(deploy).toContain(
      'email_state" == "inactive" && "$lrs_state" == "inactive"',
    );
    expect(deploy).toContain(
      'email_state" == "$email_timer_snapshot"',
    );
    expect(deploy).toContain('load_state" != "loaded"');
    expect(deploy).toContain('line_count" -ne 2');
    expect(deploy).toContain("duplicate state fields");
    expect(deploy).toContain("unexpected state fields");
  });

  it("disables curl config and every proxy before all loopback probes", () => {
    const deploy = readFileSync(deployPath, "utf8");
    const curlCalls = deploy
      .split("\n")
      .filter((line) => /\bcurl --/.test(line));

    expect(curlCalls.length).toBeGreaterThanOrEqual(10);
    for (const call of curlCalls) {
      expect(call).toContain("curl --disable --noproxy '*'");
      expect(call).toContain("--max-filesize 65536");
    }
    expect(deploy).not.toMatch(/\bcurl --(?!disable --noproxy '\*')/);
  });

  it("fails closed when the established-connection query fails", () => {
    const deploy = readFileSync(deployPath, "utf8");

    expect(deploy).toContain('connection_state="$(ss -Htn state established');
    expect(deploy).toContain('print(found ? "true" : "false")');
    expect(deploy).toContain("active connection state query failed");
    expect(deploy).toContain("active connection state query returned invalid output");
    expect(deploy).not.toContain("if ! ss -Htn state established");
  });

  it("keeps a runnable original-wrapper TERM fault harness", () => {
    expect(statSync(faultHarnessPath).mode & 0o111).not.toBe(0);
    const harness = readFileSync(faultHarnessPath, "utf8");
    expect(harness).toContain("--network none");
    expect(harness).toContain("--pull never");
    expect(harness).toContain(
      `readonly TEST_IMAGE_ID="${TEST_IMAGE_ID}"`,
    );
    expect(harness).toContain('readonly TEST_IMAGE="node@sha256:${TEST_IMAGE_ID}"');
    expect(harness).toContain("AAIS_DEPLOY_FAULT_CONTAINER=1");
    expect(harness).toContain("/.dockerenv");
    expect(harness).toContain("findmnt -n -o OPTIONS");
    expect(harness).toContain("/aais-test/aais-deploy.sh");
    expect(harness).not.toContain('${repo_root}:/repo');
    expect(harness.match(/--volume /g)).toHaveLength(3);
    expect(harness.indexOf("refuse_unsafe_inside")).toBeLessThan(
      harness.indexOf('rm -rf -- /opt/aais "$TEST_ROOT"'),
    );
    for (const faultCase of [
      "after-upstream-publish",
      "after-nginx-reload",
      "after-state-publish",
      "after-receipt-publish",
      "first-after-upstream-publish",
      "first-after-nginx-reload",
      "fail-upstream-publish",
      "fail-nginx-reload",
      "canonical-marker-fence",
      "invalid-marker-fence",
      "pending-without-inherited-fence",
      "timer-query-error",
      "timer-state-unknown",
      "timer-state-failed",
      "timer-load-not-found",
      "candidate-receipt-dir-mode-fence",
      "preloaded-receipt-dir-symlink-fence",
      "receipt-dir-owner-fence",
      "after-state-publish-email-active-lrs-inactive",
      "after-state-publish-email-inactive-lrs-active",
      "ss-query-error-at-drain",
    ]) {
      expect(harness).toContain(faultCase);
    }
  });

  it("refuses a direct --inside invocation before destructive fixture setup", () => {
    const result = spawnSync(faultHarnessPath, ["--inside"], {
      encoding: "utf8",
      env: {
        ...process.env,
        AAIS_DEPLOY_FAULT_CONTAINER: "",
        AAIS_DEPLOY_FAULT_IMAGE_ID: "",
      },
    });

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain(
      "Refusing to run the destructive fault fixture outside its dedicated container.",
    );
  });

  it("disables xtrace before deployment configuration or fixture mutation", () => {
    const deploy = readFileSync(deployPath, "utf8");
    const harness = readFileSync(faultHarnessPath, "utf8");

    expect(deploy.indexOf("set +x")).toBeLessThan(
      deploy.indexOf('source "$deploy_config_file"'),
    );
    const harnessOuterDispatch = harness.indexOf(
      'if [[ "${1:-}" != "--inside" ]]',
    );
    expect(harness.indexOf("set +x")).toBeLessThan(
      harnessOuterDispatch,
    );
  });

  it.runIf(process.env.AAIS_RUN_ALIYUN_DEPLOY_FAULTS === "1")(
    "runs the isolated original-wrapper fault matrix when explicitly enabled",
    () => {
      execFileSync(faultHarnessPath, [], { stdio: "inherit" });
    },
    120_000,
  );
});
