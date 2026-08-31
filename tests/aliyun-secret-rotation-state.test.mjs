import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readlinkSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const rotatePath = "deploy/aliyun/aais-rotate-secrets.sh";
const rotate = readFileSync(rotatePath, "utf8");
const temporaryDirectories = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

function temporaryDirectory() {
  const directory = mkdtempSync(join(tmpdir(), "aais-rotation-state-"));
  temporaryDirectories.push(directory);
  return directory;
}

function extractFunction(name) {
  const start = rotate.indexOf(`${name}() {`);
  expect(start, name).toBeGreaterThanOrEqual(0);
  const end = rotate.indexOf("\n}\n", start);
  expect(end, name).toBeGreaterThan(start);
  return rotate.slice(start, end + 3);
}

function runFunction(name, args, prelude = "") {
  const source = `${prelude}\n${extractFunction(name)}\n${name} "$@"`;
  return spawnSync("bash", ["-c", source, "aais-rotation-test", ...args], {
    encoding: "utf8",
  });
}

describe("AAIS secret-rotation durable state machine", () => {
  it.each([
    ["none", "false", "false", "new", "none"],
    ["pending resume", "true", "false", "resume", "pending"],
    ["pending replace", "true", "false", "replace-pending", "pending"],
    ["canonical resume", "false", "true", "resume", "canonical-validating"],
    ["canonical rollback admission", "false", "true", "rollback", "canonical-validating"],
  ])("plans %s", (_label, pending, canonical, mode, expected) => {
    const result = runFunction("aais_plan_marker_startup", [pending, canonical, mode]);

    expect(result.status).toBe(0);
    expect(result.stdout).toBe(`${expected}\n`);
    expect(result.stderr).toBe("");
  });

  it.each([
    ["both markers", "true", "true", "resume"],
    ["canonical with new", "false", "true", "new"],
    ["canonical with replace", "false", "true", "replace-pending"],
    ["invalid presence", "yes", "false", "resume"],
  ])("rejects marker conflict: %s", (_label, pending, canonical, mode) => {
    expect(runFunction("aais_plan_marker_startup", [pending, canonical, mode]).status)
      .not.toBe(0);
  });

  it.each([
    ["active", 0, 0, "true\n"],
    ["inactive", 0, 0, "false\n"],
    ["failed", 0, 1, ""],
    ["activating", 0, 1, ""],
    ["deactivating", 0, 1, ""],
    ["unknown", 0, 1, ""],
    ["", 1, 1, ""],
  ])("classifies systemd timer state %s strictly", (
    observed,
    systemctlStatus,
    expectedStatus,
    expectedOutput,
  ) => {
    const prelude = `
      systemctl() {
        printf 'LoadState=loaded\\nActiveState=%s\\n' '${observed}'
        return ${systemctlStatus}
      }
      ${extractFunction("read_systemd_active_state")}
    `;
    const result = runFunction(
      "read_timer_active_state",
      ["aais-email-outbox.timer"],
      prelude,
    );

    expect(result.status === 0 ? 0 : 1).toBe(expectedStatus);
    expect(result.stdout).toBe(expectedOutput);
  });

  it.each([
    ["active", 0, "true", 0],
    ["inactive", 0, "false", 0],
    ["active", 0, "false", 1],
    ["inactive", 0, "true", 1],
    ["activating", 0, "true", 1],
    ["failed", 0, "false", 1],
    ["unknown", 0, "false", 1],
    ["inactive", 1, "false", 1],
  ])("requires exact timer target: observed=%s target=%s", (
    observed,
    systemctlStatus,
    target,
    expectedStatus,
  ) => {
    const prelude = `
      systemctl() {
        printf 'LoadState=loaded\\nActiveState=%s\\n' '${observed}'
        return ${systemctlStatus}
      }
      ${extractFunction("read_systemd_active_state")}
    `;
    const result = runFunction(
      "require_timer_target_state",
      ["aais-email-outbox.timer", target],
      prelude,
    );

    expect(result.status === 0 ? 0 : 1).toBe(expectedStatus);
  });

  it.each([
    ["not-found", "inactive"],
    ["masked", "inactive"],
    ["error", "active"],
  ])("rejects non-loaded systemd unit: %s", (loadState, activeState) => {
    const prelude = `
      systemctl() {
        printf 'LoadState=%s\\nActiveState=%s\\n' '${loadState}' '${activeState}'
        return 0
      }
    `;
    expect(runFunction(
      "read_systemd_active_state",
      ["aais-email-outbox.timer"],
      prelude,
    ).status).not.toBe(0);
  });

  it("rejects extra or duplicate systemd properties", () => {
    const prelude = `
      systemctl() {
        printf 'LoadState=loaded\\nActiveState=inactive\\nActiveState=active\\n'
        return 0
      }
    `;
    expect(runFunction(
      "read_systemd_active_state",
      ["aais-email-outbox.timer"],
      prelude,
    ).status).not.toBe(0);
  });

  it.each([
    ["not-found inactive", "not-found", "inactive", 0],
    ["unknown active state", "loaded", "unknown", 0],
    ["failed active state", "loaded", "failed", 0],
    ["activating active state", "loaded", "activating", 0],
    ["query error", "loaded", "inactive", 1],
  ])("stops before marker or source mutation for %s", (
    _label,
    loadState,
    activeState,
    systemctlStatus,
  ) => {
    const directory = temporaryDirectory();
    const actionLog = join(directory, "mutations.log");
    const script = `
      systemctl() {
        [[ "$*" == "show --property=LoadState --property=ActiveState aais-email-outbox.timer" ]] || return 97
        printf 'LoadState=%s\\nActiveState=%s\\n' '${loadState}' '${activeState}'
        return ${systemctlStatus}
      }
      write_rotation_phase() { printf 'marker\\n' >> "$action_log"; }
      mutate_source() { printf 'source\\n' >> "$action_log"; }
      action_log="$1"
      ${extractFunction("read_systemd_active_state")}
      ${extractFunction("read_timer_active_state")}
      email_timer_was_active="$(read_timer_active_state aais-email-outbox.timer)" || exit 1
      write_rotation_phase prepared
      mutate_source
    `;
    const result = spawnSync("bash", [
      "-c",
      script,
      "aais-systemd-preflight-test",
      actionLog,
    ], { encoding: "utf8" });

    expect(result.status).not.toBe(0);
    expect(existsSync(actionLog)).toBe(false);
  });

  it.each([
    ["prepared without previous", "prepared", "false", "prepared"],
    ["prepared with previous", "prepared", "true", "prepared"],
    ["previous-saved", "previous-saved", "true", "previous-saved"],
    ["source-promoted", "source-promoted", "true", "previous-saved"],
    ["runtime-published", "runtime-published", "true", "previous-saved"],
  ])("plans safe replacement for %s", (_label, phase, hasPrevious, expected) => {
    const result = runFunction(
      "aais_plan_replace_pending_phase",
      [phase, hasPrevious],
    );

    expect(result.status).toBe(0);
    expect(result.stdout).toBe(`${expected}\n`);
  });

  it.each([
    ["previous-saved missing previous", "previous-saved", "false"],
    ["source-promoted missing previous", "source-promoted", "false"],
    ["runtime-published missing previous", "runtime-published", "false"],
    ["rollback-requested", "rollback-requested", "true"],
    ["container-promoted", "container-promoted", "true"],
    ["failed", "failed", "true"],
  ])("rejects unsafe replacement for %s", (_label, phase, hasPrevious) => {
    expect(runFunction(
      "aais_plan_replace_pending_phase",
      [phase, hasPrevious],
    ).status).not.toBe(0);
  });

  it("rejects a replacement candidate whose bundle equals the active bundle", () => {
    const prelude = `
      validate_recovery_secret_file() { return 0; }
      read_secret_bundle_version() { printf '%s\\n' "$replacement_bundle"; }
      previous_active_bundle=active-bundle
    `;
    const same = spawnSync("bash", [
      "-c",
      `${prelude}\nreplacement_bundle=active-bundle\n${extractFunction("validate_rotation_candidate")}\nvalidate_rotation_candidate ignored`,
    ], { encoding: "utf8" });
    const changed = spawnSync("bash", [
      "-c",
      `${prelude}\nreplacement_bundle=replacement-bundle\n${extractFunction("validate_rotation_candidate")}\nvalidate_rotation_candidate ignored`,
    ], { encoding: "utf8" });

    expect(same.status).not.toBe(0);
    expect(changed.status).toBe(0);
  });

  it("persists timer intent across an atomic pending-to-canonical SIGKILL window", () => {
    const directory = temporaryDirectory();
    const stateDirectory = join(directory, "state");
    const pending = join(stateDirectory, "secret-rotation.pending");
    const canonical = join(stateDirectory, "secret-rotation.canonical-check");
    mkdirSync(stateDirectory);
    const marker = [
      "AAIS_ROTATION_PHASE=container-promoted",
      "AAIS_EMAIL_TIMER_WAS_ACTIVE=true",
      "AAIS_LRS_TIMER_WAS_ACTIVE=false",
      "",
    ].join("\n");
    writeFileSync(pending, marker);

    renameSync(pending, canonical);
    const afterSigkill = readFileSync(canonical, "utf8");
    const recovered = Object.fromEntries(
      afterSigkill.trim().split("\n").map((line) => line.split("=")),
    );

    expect(recovered).toEqual({
      AAIS_ROTATION_PHASE: "container-promoted",
      AAIS_EMAIL_TIMER_WAS_ACTIVE: "true",
      AAIS_LRS_TIMER_WAS_ACTIVE: "false",
    });
    expect(runFunction(
      "aais_plan_marker_startup",
      ["false", "true", "resume"],
    ).stdout).toBe("canonical-validating\n");
  });

  it("keeps canonical-passed resumable after timers or previous cleanup changed", () => {
    const directory = temporaryDirectory();
    const canonical = join(directory, "secret-rotation.canonical-check");
    writeFileSync(canonical, [
      "AAIS_ROTATION_PHASE=canonical-passed",
      "AAIS_EMAIL_TIMER_WAS_ACTIVE=true",
      "AAIS_LRS_TIMER_WAS_ACTIVE=false",
      "",
    ].join("\n"));

    const recovered = Object.fromEntries(
      readFileSync(canonical, "utf8").trim().split("\n")
        .map((line) => line.split("=")),
    );
    expect(recovered.AAIS_ROTATION_PHASE).toBe("canonical-passed");
    expect(recovered.AAIS_EMAIL_TIMER_WAS_ACTIVE).toBe("true");
    expect(recovered.AAIS_LRS_TIMER_WAS_ACTIVE).toBe("false");
    expect(runFunction(
      "aais_plan_marker_startup",
      ["false", "true", "resume"],
    ).status).toBe(0);
    expect(rotate).toContain('canonical_passed="true"');
    expect(rotate).toContain(
      "AAIS optional previous source is invalid in the canonical-passed phase.",
    );
  });

  it("persists late-replacement and rollback intent before source mutation", () => {
    const stopTimers = rotate.indexOf(
      'timers_stopped="true"\n  systemctl stop "$email_timer" "$lrs_timer"',
    );
    const replacementIntent = rotate.indexOf(
      'write_rotation_phase "$replacement_phase"',
    );
    const rollbackMode = rotate.indexOf(
      'elif [[ "$file_rotation_mode" == "rollback" ]]',
    );
    const rollbackIntent = rotate.indexOf(
      "write_rotation_phase rollback-requested",
      rollbackMode,
    );
    const canonicalRollbackIntent = rotate.indexOf(
      "write_canonical_phase rollback-requested",
    );
    const canonicalToPending = rotate.indexOf(
      'mv -Tf -- "$rotation_canonical_check_file" "$rotation_pending_file"',
      canonicalRollbackIntent,
    );
    const rollbackSourceMutation = rotate.indexOf(
      'mv -Tf -- "$local_rollback_candidate" "$local_runtime_source"',
    );

    expect(replacementIntent).toBeLessThan(stopTimers);
    expect(rollbackIntent).toBeLessThan(stopTimers);
    expect(canonicalRollbackIntent).toBeLessThan(canonicalToPending);
    expect(stopTimers).toBeLessThan(rollbackSourceMutation);
    expect(rotate).toContain('if [[ "$rotation_phase" == "rollback-requested" ]]');
    expect(rotate).toContain('rollback_intent="true"');

    const marker = [
      "AAIS_ROTATION_PHASE=rollback-requested",
      "AAIS_EMAIL_TIMER_WAS_ACTIVE=true",
      "AAIS_LRS_TIMER_WAS_ACTIVE=false",
      "",
    ].join("\n");
    const recovered = Object.fromEntries(
      marker.trim().split("\n").map((line) => line.split("=")),
    );
    expect(recovered.AAIS_ROTATION_PHASE).toBe("rollback-requested");
    expect(runFunction(
      "aais_plan_marker_startup",
      ["true", "false", "resume"],
    ).stdout).toBe("pending\n");
  });

  it.each([
    ["rollback-requested", true, false],
    ["canonical-passed", false, true],
  ])("recovers a %s marker when TERM lands before its in-memory flag", (
    phase,
    expectPending,
    expectCanonical,
  ) => {
    const directory = temporaryDirectory();
    const check = join(directory, "secret-rotation.canonical-check");
    const pending = join(directory, "secret-rotation.pending");
    const writeLog = join(directory, "write-phase.log");
    writeFileSync(check, `${phase}\ttrue\tfalse\n`);
    const script = `
      read_rotation_marker() { /bin/cat "$1"; }
      write_rotation_phase() { printf '%s\\n' "$1" >> "$write_log"; return 1; }
      systemctl() { return 0; }
      mv() { /bin/mv "$3" "$4"; }
      rotation_canonical_check_file="$1"
      rotation_pending_file="$2"
      write_log="$3"
      rotation_complete=false
      rotation_pending=true
      canonical_passed=false
      rollback_intent=false
      marker_metadata_valid=true
      marker_conflict=false
      canonical_check_active=true
      timers_stopped=true
      email_timer_was_active=false
      lrs_timer_was_active=false
      email_timer=email.timer
      lrs_timer=lrs.timer
      rotation_phase_candidate=""
      local_previous_candidate="$4"
      local_rollback_candidate="$5"
      ${extractFunction("on_exit")}
      false
      on_exit
    `;
    const result = spawnSync("bash", [
      "-c",
      script,
      "aais-on-exit-test",
      check,
      pending,
      writeLog,
      join(directory, "previous.staging"),
      join(directory, "rollback.staging"),
    ], { encoding: "utf8" });

    expect(result.status).not.toBe(0);
    expect(existsSync(pending)).toBe(expectPending);
    expect(existsSync(check)).toBe(expectCanonical);
    expect(existsSync(writeLog)).toBe(false);
    const retained = readFileSync(expectPending ? pending : check, "utf8");
    expect(retained).toBe(`${phase}\ttrue\tfalse\n`);
  });

  it("preserves both marker byte streams when on_exit sees a conflict", () => {
    const directory = temporaryDirectory();
    const pending = join(directory, "secret-rotation.pending");
    const check = join(directory, "secret-rotation.canonical-check");
    const invalid = join(directory, "secret-rotation.invalid");
    const actionLog = join(directory, "actions.log");
    const pendingBytes = "pending-byte-stream-must-not-change\n";
    const checkBytes = "canonical-byte-stream-must-not-change\n";
    writeFileSync(pending, pendingBytes);
    writeFileSync(check, checkBytes);
    const digest = (value) => createHash("sha256").update(value).digest("hex");
    const script = `
      read_rotation_marker() { printf 'read\\n' >> "$action_log"; return 1; }
      write_rotation_phase() { printf 'write\\n' >> "$action_log"; return 1; }
      mv() { printf 'move\\n' >> "$action_log"; return 1; }
      write_invalid_guard() {
        (umask 077; printf 'AAIS_ROTATION_INVALID=manual-reconciliation-required\\n' > "$rotation_invalid_file")
        chmod 0600 "$rotation_invalid_file"
      }
      systemctl() { return 0; }
      rotation_canonical_check_file="$1"
      rotation_pending_file="$2"
      rotation_invalid_file="$3"
      action_log="$4"
      rotation_complete=false
      rotation_pending=true
      rotation_invalid_present=false
      canonical_passed=false
      rollback_intent=false
      marker_metadata_valid=false
      marker_conflict=true
      canonical_check_active=true
      timers_stopped=true
      email_timer=email.timer
      lrs_timer=lrs.timer
      rotation_phase_candidate=""
      local_previous_candidate="$5"
      local_rollback_candidate="$6"
      ${extractFunction("on_exit")}
      false
      on_exit
    `;
    const result = spawnSync("bash", [
      "-c",
      script,
      "aais-on-exit-conflict-test",
      check,
      pending,
      invalid,
      actionLog,
      join(directory, "previous.staging"),
      join(directory, "rollback.staging"),
    ], { encoding: "utf8" });

    expect(result.status).not.toBe(0);
    expect(digest(readFileSync(pending))).toBe(digest(pendingBytes));
    expect(digest(readFileSync(check))).toBe(digest(checkBytes));
    expect(existsSync(actionLog)).toBe(false);
    expect(readFileSync(invalid, "utf8")).toBe(
      "AAIS_ROTATION_INVALID=manual-reconciliation-required\n",
    );
    expect(lstatSync(invalid).mode & 0o777).toBe(0o600);
    expect(result.stderr).toContain("both marker bytes were preserved");
  });

  it.each(["broken symlink", "directory"])(
    "preserves an invalid canonical marker and arms the guard: %s",
    (markerKind) => {
      const directory = temporaryDirectory();
      const pending = join(directory, "secret-rotation.pending");
      const check = join(directory, "secret-rotation.canonical-check");
      const invalid = join(directory, "secret-rotation.invalid");
      const actionLog = join(directory, "actions.log");
      const evidence = join(check, "evidence");
      const linkTarget = join(directory, "missing-marker-target");
      if (markerKind === "broken symlink") {
        symlinkSync(linkTarget, check);
      } else {
        mkdirSync(check);
        writeFileSync(evidence, "directory-marker-evidence\n");
      }
      const script = `
        read_rotation_marker() { return 1; }
        write_rotation_phase() { printf 'write\\n' >> "$action_log"; return 1; }
        mv() { printf 'move\\n' >> "$action_log"; return 1; }
        write_invalid_guard() {
          (umask 077; printf 'AAIS_ROTATION_INVALID=manual-reconciliation-required\\n' > "$rotation_invalid_file")
          chmod 0600 "$rotation_invalid_file"
        }
        systemctl() { return 0; }
        rotation_canonical_check_file="$1"
        rotation_pending_file="$2"
        rotation_invalid_file="$3"
        action_log="$4"
        rotation_complete=false
        rotation_pending=true
        rotation_invalid_present=false
        canonical_passed=false
        rollback_intent=false
        marker_metadata_valid=true
        marker_conflict=false
        canonical_check_active=true
        timers_stopped=true
        email_timer=email.timer
        lrs_timer=lrs.timer
        rotation_phase_candidate=""
        local_previous_candidate="$5"
        local_rollback_candidate="$6"
        ${extractFunction("on_exit")}
        false
        on_exit
      `;
      const result = spawnSync("bash", [
        "-c",
        script,
        "aais-on-exit-invalid-marker-test",
        check,
        pending,
        invalid,
        actionLog,
        join(directory, "previous.staging"),
        join(directory, "rollback.staging"),
      ], { encoding: "utf8" });

      expect(result.status).not.toBe(0);
      expect(existsSync(actionLog)).toBe(false);
      if (markerKind === "broken symlink") {
        expect(lstatSync(check).isSymbolicLink()).toBe(true);
        expect(readlinkSync(check)).toBe(linkTarget);
      } else {
        expect(lstatSync(check).isDirectory()).toBe(true);
        expect(readFileSync(evidence, "utf8")).toBe("directory-marker-evidence\n");
      }
      expect(readFileSync(invalid, "utf8")).toBe(
        "AAIS_ROTATION_INVALID=manual-reconciliation-required\n",
      );
      expect(lstatSync(invalid).mode & 0o777).toBe(0o600);
      expect(result.stderr).toContain("invalid guard requires manual reconciliation");
    },
  );

  it.each(["chown", "chmod"])(
    "cleans the invalid-guard candidate when %s fails under a conditional call",
    (failedCommand) => {
      const directory = temporaryDirectory();
      const invalid = join(directory, "secret-rotation.invalid");
      const candidate = join(directory, "secret-rotation.invalid.candidate");
      const script = `
        dirname() { printf '/opt/aais/state\\n'; }
        mktemp() { : > "$guard_candidate_path"; printf '%s\\n' "$guard_candidate_path"; }
        chown() { [[ "$failed_command" != "chown" ]]; }
        chmod() { [[ "$failed_command" != "chmod" ]]; }
        validate_invalid_guard() { return 1; }
        rotation_invalid_file="$1"
        guard_candidate_path="$2"
        failed_command="$3"
        ${extractFunction("write_invalid_guard")}
        if write_invalid_guard; then exit 99; fi
      `;
      const result = spawnSync("bash", [
        "-c",
        script,
        "aais-invalid-guard-writer-test",
        invalid,
        candidate,
        failedCommand,
      ], { encoding: "utf8" });

      expect(result.status).toBe(0);
      expect(existsSync(candidate)).toBe(false);
      expect(existsSync(invalid)).toBe(false);
    },
  );

  it.each([
    ["pending", "write_rotation_phase", "prepared", "chown"],
    ["pending", "write_rotation_phase", "prepared", "chmod"],
    ["pending", "write_rotation_phase", "prepared", "mv"],
    ["canonical", "write_canonical_phase", "canonical-passed", "chown"],
    ["canonical", "write_canonical_phase", "canonical-passed", "chmod"],
    ["canonical", "write_canonical_phase", "canonical-passed", "mv"],
  ])("keeps the formal %s marker unchanged when %s fails", (
    markerKind,
    writerFunction,
    phase,
    failedCommand,
  ) => {
    const directory = temporaryDirectory();
    const pending = join(directory, "secret-rotation.pending");
    const canonical = join(directory, "secret-rotation.canonical-check");
    const candidate = join(directory, "secret-rotation.phase.candidate");
    const pendingBytes = "pending-formal-marker\n";
    const canonicalBytes = "canonical-formal-marker\n";
    writeFileSync(pending, pendingBytes);
    writeFileSync(canonical, canonicalBytes);
    const script = `
      mktemp() { : > "$candidate_path"; printf '%s\\n' "$candidate_path"; }
      chown() { [[ "$failed_command" != "chown" ]]; }
      chmod() { [[ "$failed_command" != "chmod" ]]; }
      mv() { [[ "$failed_command" != "mv" ]]; }
      rotation_pending_file="$1"
      rotation_canonical_check_file="$2"
      candidate_path="$3"
      failed_command="$4"
      rotation_phase_candidate=""
      email_timer_was_active=true
      lrs_timer_was_active=false
      rotation_pending=original-pending
      marker_metadata_valid=original-metadata
      marker_conflict=original-conflict
      canonical_check_active=original-canonical
      ${extractFunction("write_rotation_marker")}
      ${extractFunction(writerFunction)}
      ${writerFunction} '${phase}'
      status=$?
      printf '%s\\t%s\\t%s\\t%s\\n' "$rotation_pending" \
        "$marker_metadata_valid" "$marker_conflict" "$canonical_check_active"
      exit "$status"
    `;
    const result = spawnSync("bash", [
      "-c",
      script,
      `aais-${markerKind}-marker-writer-test`,
      pending,
      canonical,
      candidate,
      failedCommand,
    ], { encoding: "utf8" });

    expect(result.status).not.toBe(0);
    expect(result.stdout).toBe(
      "original-pending\toriginal-metadata\toriginal-conflict\toriginal-canonical\n",
    );
    expect(readFileSync(pending, "utf8")).toBe(pendingBytes);
    expect(readFileSync(canonical, "utf8")).toBe(canonicalBytes);
    expect(existsSync(candidate)).toBe(false);
  });

  it("preserves recovery staging when the invalid guard blocks startup", () => {
    const directory = temporaryDirectory();
    const invalid = join(directory, "secret-rotation.invalid");
    const previous = join(directory, "runtime.env.previous.staging");
    const rollback = join(directory, "runtime.env.rollback.staging");
    writeFileSync(invalid, "AAIS_ROTATION_INVALID=manual-reconciliation-required\n");
    writeFileSync(previous, "previous-custody\n");
    writeFileSync(rollback, "rollback-custody\n");
    const previousDigest = createHash("sha256").update(readFileSync(previous)).digest("hex");
    const rollbackDigest = createHash("sha256").update(readFileSync(rollback)).digest("hex");
    const script = `
      systemctl() { return 0; }
      rotation_canonical_check_file="$1"
      rotation_pending_file="$2"
      rotation_invalid_file="$3"
      rotation_complete=false
      rotation_pending=true
      rotation_invalid_present=true
      canonical_passed=false
      rollback_intent=false
      marker_metadata_valid=false
      marker_conflict=false
      canonical_check_active=false
      timers_stopped=true
      email_timer=email.timer
      lrs_timer=lrs.timer
      rotation_phase_candidate=""
      local_previous_candidate="$4"
      local_rollback_candidate="$5"
      ${extractFunction("on_exit")}
      false
      on_exit
    `;
    const result = spawnSync("bash", [
      "-c",
      script,
      "aais-on-exit-invalid-guard-test",
      join(directory, "secret-rotation.canonical-check"),
      join(directory, "secret-rotation.pending"),
      invalid,
      previous,
      rollback,
    ], { encoding: "utf8" });

    expect(result.status).not.toBe(0);
    expect(createHash("sha256").update(readFileSync(previous)).digest("hex"))
      .toBe(previousDigest);
    expect(createHash("sha256").update(readFileSync(rollback)).digest("hex"))
      .toBe(rollbackDigest);
    const startupGuard = rotate.indexOf(
      'if [[ -e "$rotation_invalid_file" || -L "$rotation_invalid_file" ]]',
      rotate.indexOf("trap on_exit EXIT"),
    );
    expect(startupGuard).toBeGreaterThanOrEqual(0);
    expect(rotate.indexOf('rotation_pending="true"', startupGuard))
      .toBeLessThan(rotate.indexOf('systemctl stop "$email_timer"', startupGuard));
  });

  it("orders custody, marker transitions, canonical recovery, timers, and cleanup", () => {
    const writePrepared = rotate.indexOf("write_rotation_phase prepared");
    const timerSnapshot = rotate.indexOf(
      'email_timer_was_active="$(read_timer_active_state',
    );
    const stopTimers = rotate.indexOf(
      'timers_stopped="true"\n  systemctl stop "$email_timer" "$lrs_timer"',
    );
    const savePrevious = rotate.indexOf(
      'cp -- "$local_runtime_source" "$local_previous_candidate"',
    );
    const promoteCandidate = rotate.indexOf(
      'mv -Tf -- "$local_runtime_candidate" "$local_runtime_source"',
      savePrevious,
    );
    const diagnostic = rotate.indexOf(
      "https://www.aais.site:8443/api/system/traffic-readiness",
    );
    const transition = rotate.indexOf(
      'mv -Tf -- "$rotation_pending_file" "$rotation_canonical_check_file"',
    );
    const canonical = rotate.indexOf(
      "https://www.aais.site/api/system/traffic-readiness",
    );
    const canonicalPassed = rotate.lastIndexOf(
      "write_canonical_phase canonical-passed",
    );
    const removeCanonical = rotate.lastIndexOf(
      'rm -f -- "$rotation_canonical_check_file"',
    );
    const startEmail = rotate.lastIndexOf('systemctl start "$email_timer"');
    const cleanupPrevious = rotate.indexOf(
      'rm -f -- "$local_runtime_previous"',
    );
    const prearmComplete = rotate.lastIndexOf('rotation_complete="true"');
    const ignoreSignals = rotate.lastIndexOf("trap '' INT TERM HUP");

    expect(timerSnapshot).toBeLessThan(writePrepared);
    expect(writePrepared).toBeLessThan(stopTimers);
    expect(stopTimers).toBeLessThan(savePrevious);
    expect(savePrevious).toBeLessThan(promoteCandidate);
    expect(diagnostic).toBeLessThan(transition);
    expect(transition).toBeLessThan(canonical);
    expect(canonical).toBeLessThan(canonicalPassed);
    expect(canonicalPassed).toBeLessThan(startEmail);
    expect(startEmail).toBeLessThan(cleanupPrevious);
    expect(cleanupPrevious).toBeLessThan(ignoreSignals);
    expect(ignoreSignals).toBeLessThan(prearmComplete);
    expect(prearmComplete).toBeLessThan(removeCanonical);
    expect(rotate).not.toContain('rm -f -- "$rotation_pending_file"');
    expect(rotate).toContain(
      "systemctl show --property=LoadState --property=ActiveState",
    );
    expect(rotate).not.toContain("systemctl is-active");
    expect(rotate).toContain('email_service_state" == "inactive"');
    expect(rotate).toContain('lrs_service_state" == "inactive"');
    expect(rotate).toContain('email_service_state" == "failed"');
    expect(stopTimers).toBeLessThan(
      rotate.indexOf('require_timer_target_state "$email_timer" false', stopTimers),
    );
    expect(rotate).toContain('canonical_resume="true"');
    expect(rotate).toContain(
      'mv -Tf -- "$rotation_canonical_check_file" "$rotation_pending_file"',
    );
    expect(rotate).toContain(
      "AAIS canonical-passed recovery permits only --resume.",
    );
    expect(rotate).toContain("validate_canonical_resume_binding");
    expect(rotate.indexOf('if [[ "$canonical_resume" == "true" ]]'))
      .toBeLessThan(rotate.indexOf('"$bootstrap_wrapper"\n'));
  });

  it("blocks service dispatch while allowing durable timer intent to recover", () => {
    const servicePaths = [
      "deploy/aliyun/aais-email-outbox.service",
      "deploy/aliyun/aais-lrs-outbox.service",
    ];
    for (const path of servicePaths) {
      const unit = readFileSync(path, "utf8");
      expect(unit, path).toContain(
        "ConditionPathExists=!/opt/aais/state/secret-rotation.pending",
      );
      expect(unit, path).toContain(
        "ConditionPathExists=!/opt/aais/state/secret-rotation.canonical-check",
      );
      expect(unit, path).toContain(
        "ConditionPathExists=!/opt/aais/state/secret-rotation.invalid",
      );
    }
    const timerPaths = [
      "deploy/aliyun/aais-email-outbox.timer",
      "deploy/aliyun/aais-lrs-outbox.timer",
    ];
    for (const path of timerPaths) {
      const unit = readFileSync(path, "utf8");
      expect(unit, path).not.toContain("ConditionPathExists=");
    }
    const worker = readFileSync("deploy/aliyun/aais-worker.sh", "utf8");
    const markerGate = worker.indexOf('|| -e "$rotation_canonical_check_file"');
    const invalidGate = worker.indexOf('|| -e "$rotation_invalid_file"');
    expect(markerGate).toBeGreaterThanOrEqual(0);
    expect(invalidGate).toBeGreaterThan(markerGate);
    expect(markerGate).toBeLessThan(worker.indexOf('if [[ ! -r "$worker_env_file" ]]'));
    expect(markerGate).toBeLessThan(worker.indexOf('token="$(awk'));
    expect(markerGate).toBeLessThan(worker.indexOf("--max-filesize 65536"));
    expect(worker).toContain("--max-filesize 65536");
    expect(worker).toContain("curl --disable --config - --noproxy '*'");

    const nginx = readFileSync("deploy/aliyun/nginx-aais.conf.template", "utf8");
    expect(nginx).toContain("/opt/aais/state/secret-rotation.pending");
    expect(nginx).toContain("/opt/aais/state/secret-rotation.invalid");
    expect(nginx).not.toContain("secret-rotation.canonical-check");
    expect(rotate.match(/curl --disable --noproxy '\*'/g)).toHaveLength(2);
    expect(rotate.match(/--max-filesize 65536/g)).toHaveLength(2);
  });

  it.each([
    ["pending", "secret-rotation.pending"],
    ["canonical", "secret-rotation.canonical-check"],
    ["invalid", "secret-rotation.invalid"],
  ])("the real worker wrapper rejects the %s marker before reading runtime files", (
    _label,
    markerName,
  ) => {
    const directory = temporaryDirectory();
    const marker = join(directory, markerName);
    writeFileSync(marker, "blocked\n");
    const result = spawnSync(
      "bash",
      ["deploy/aliyun/aais-worker.sh", "email"],
      {
        cwd: process.cwd(),
        encoding: "utf8",
        env: {
          ...process.env,
          AAIS_ROTATION_PENDING_FILE: join(directory, "secret-rotation.pending"),
          AAIS_WORKER_ENV_FILE: join(directory, "must-not-be-read.env"),
        },
      },
    );

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain(
      "AAIS worker is blocked by a pending secret rotation.",
    );
    expect(result.stderr).not.toContain("worker environment is unavailable");
  });

  it("invokes loopback curl with config and proxy isolation under a hostile environment", () => {
    const directory = temporaryDirectory();
    const binDirectory = join(directory, "bin");
    const homeDirectory = join(directory, "home");
    const workerEnv = join(directory, "worker.env");
    const activeState = join(directory, "active-deployment.env");
    const curlArgs = join(directory, "curl.args");
    const curlStdin = join(directory, "curl.stdin");
    const curlrcOutput = join(directory, "curlrc-output");
    mkdirSync(binDirectory);
    mkdirSync(homeDirectory);
    writeFileSync(workerEnv, [
      "AAIS_SECRET_BUNDLE_VERSION=bundle-test-1",
      `AAIS_AUTH_EMAIL_OUTBOX_FLUSH_TOKEN=${"t".repeat(40)}`,
      "",
    ].join("\n"));
    writeFileSync(
      activeState,
      "AAIS_ACTIVE_SECRET_BUNDLE_VERSION=bundle-test-1\n",
    );
    writeFileSync(
      join(homeDirectory, ".curlrc"),
      `--output ${curlrcOutput}\n--proxy http://127.0.0.1:9\n`,
    );
    const fakeStat = join(binDirectory, "stat");
    writeFileSync(fakeStat, `#!/bin/sh
set -eu
[ "$1" = "-c" ] && [ "$#" -eq 3 ] || exit 97
if [ "$3" = "$AAIS_TEST_WORKER_ENV" ]; then
  [ "$2" = "%a" ] && printf '440\\n' && exit 0
  [ "$2" = "%u" ] && printf '0\\n' && exit 0
fi
if [ "$3" = "$AAIS_TEST_ACTIVE_STATE" ]; then
  [ "$2" = "%a" ] && printf '644\\n' && exit 0
  [ "$2" = "%u" ] && printf '0\\n' && exit 0
fi
exit 98
`);
    const fakeCurl = join(binDirectory, "curl");
    writeFileSync(fakeCurl, `#!/bin/sh
set -eu
printf '%s\\n' "$@" > "$AAIS_TEST_CURL_ARGS"
/bin/cat > "$AAIS_TEST_CURL_STDIN"
printf '{"status":"processed"}'
`);
    chmodSync(fakeStat, 0o700);
    chmodSync(fakeCurl, 0o700);

    const result = spawnSync(
      "bash",
      ["deploy/aliyun/aais-worker.sh", "email"],
      {
        cwd: process.cwd(),
        encoding: "utf8",
        env: {
          ...process.env,
          PATH: `${binDirectory}:${process.env.PATH}`,
          HOME: homeDirectory,
          HTTPS_PROXY: "http://127.0.0.1:7",
          ALL_PROXY: "http://127.0.0.1:8",
          NO_PROXY: "",
          AAIS_ROTATION_PENDING_FILE: join(directory, "secret-rotation.pending"),
          AAIS_WORKER_ENV_FILE: workerEnv,
          AAIS_STATE_FILE: activeState,
          AAIS_TEST_WORKER_ENV: workerEnv,
          AAIS_TEST_ACTIVE_STATE: activeState,
          AAIS_TEST_CURL_ARGS: curlArgs,
          AAIS_TEST_CURL_STDIN: curlStdin,
        },
      },
    );

    expect(result.status).toBe(0);
    expect(readFileSync(curlArgs, "utf8").split("\n").slice(0, 6)).toEqual([
      "--disable",
      "--config",
      "-",
      "--noproxy",
      "*",
      "--fail-with-body",
    ]);
    expect(readFileSync(curlArgs, "utf8")).toContain(
      "--resolve\nwww.aais.site:443:127.0.0.1\n",
    );
    expect(readFileSync(curlStdin, "utf8")).toContain(
      'header = "Authorization: Bearer ',
    );
    expect(existsSync(curlrcOutput)).toBe(false);
  });
});
