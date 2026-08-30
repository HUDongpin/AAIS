import { execFileSync, spawnSync } from "node:child_process";
import {
  chmodSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const script = join(process.cwd(), "deploy/aliyun/aais-acr-ci-endpoint.sh");
const temporaryDirectories = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

function createHarness(initialEndpoint) {
  const directory = mkdtempSync(join(tmpdir(), "aais-acr-endpoint-"));
  temporaryDirectories.push(directory);
  const endpointState = join(directory, "endpoint.json");
  const transactionState = join(directory, "aais-acr-endpoint-123-1");
  const mockAliyun = join(directory, "aliyun");
  const mockCurl = join(directory, "curl");
  const mockSleep = join(directory, "sleep");
  const delayedEnableMarker = join(directory, "delayed-enable-fired");

  writeFileSync(endpointState, `${JSON.stringify(initialEndpoint)}\n`, { mode: 0o600 });
  writeFileSync(
    mockCurl,
    `#!/usr/bin/env bash
set -euo pipefail
printf '8.8.8.8\\n'
`,
    { mode: 0o755 },
  );
  writeFileSync(mockSleep, "#!/usr/bin/env bash\nexit 0\n", { mode: 0o755 });
  writeFileSync(
    mockAliyun,
    `#!/usr/bin/env bash
set -euo pipefail
action="\${2:-}"
state="\${MOCK_ACR_STATE:?}"
update_state() {
  local expression="\$1"
  shift
  local candidate="\${state}.candidate"
  jq "\$@" "\$expression" "\$state" > "\$candidate"
  mv -f -- "\$candidate" "\$state"
}
argument() {
  local name="\$1"
  shift
  while (( \$# > 0 )); do
    if [[ "\$1" == "\$name" ]]; then
      printf '%s' "\${2:-}"
      return 0
    fi
    shift
  done
  return 1
}
case "\$action" in
  GetInstanceEndpoint)
    response="\$(cat "\$state")"
    if [[ "\${MOCK_DELAY_ENABLE_AFTER_FIRST_CLOSED_GET:-}" == "true" \
      && ! -e "\${MOCK_ACR_DELAYED_ENABLE_MARKER:?}" ]] \
      && jq -e '.Enable == false' <<<"\$response" >/dev/null; then
      printf '%s\n' "\$response"
      : > "\$MOCK_ACR_DELAYED_ENABLE_MARKER"
      update_state '
        .Enable = true
        | .AclEntries = (
            if ([.AclEntries[]?.Entry] | index("127.0.0.1/32")) == null
            then [{Entry: "127.0.0.1/32", Comment: "system default"}] + (.AclEntries // [])
            else .AclEntries
            end
          )
      '
    else
      printf '%s\n' "\$response"
    fi
    ;;
  CreateInstanceEndpointAclPolicy)
    entry="\$(argument --Entry "\$@")"
    comment="\$(argument --Comment "\$@")"
    update_state '.AclEntries = (.AclEntries // []) + [{Entry: \$entry, Comment: \$comment}]' \
      --arg entry "\$entry" --arg comment "\$comment"
    printf '{"Code":"success","IsSuccess":true}\\n'
    ;;
  UpdateInstanceEndpointStatus)
    enabled="\$(argument --Enable "\$@")"
    if [[ "\$enabled" == "false" && "\${MOCK_DISABLE_MODE:-}" == "fail" ]]; then
      exit 1
    fi
    if [[ "\$enabled" == "false" && "\${MOCK_DISABLE_MODE:-}" == "omit" ]]; then
      update_state 'del(.Enable)'
    elif [[ "\$enabled" == "true" ]]; then
      update_state '
        .Enable = true
        | .AclEntries = (
            if ([.AclEntries[]?.Entry] | index("127.0.0.1/32")) == null
            then [{Entry: "127.0.0.1/32", Comment: "system default"}] + (.AclEntries // [])
            else .AclEntries
            end
          )
      '
    else
      update_state '.Enable = false'
    fi
    printf '{"Code":"success","IsSuccess":true}\\n'
    ;;
  DeleteInstanceEndpointAclPolicy)
    if [[ "\${MOCK_DELETE_FAIL:-}" == "true" ]]; then
      exit 1
    fi
    entry="\$(argument --Entry "\$@")"
    update_state '.AclEntries = [(.AclEntries // [])[] | select(.Entry != \$entry)]' \
      --arg entry "\$entry"
    printf '{"Code":"success","IsSuccess":true}\\n'
    ;;
  *)
    exit 64
    ;;
esac
`,
    { mode: 0o755 },
  );
  chmodSync(mockAliyun, 0o755);
  chmodSync(mockCurl, 0o755);
  chmodSync(mockSleep, 0o755);

  return {
    directory,
    endpointState,
    transactionState,
    environment: {
      ...process.env,
      PATH: `${directory}:${process.env.PATH}`,
      RUNNER_TEMP: directory,
      MOCK_ACR_STATE: endpointState,
      MOCK_ACR_DELAYED_ENABLE_MARKER: delayedEnableMarker,
      AAIS_ALIYUN_CLI: mockAliyun,
      AAIS_ACR_ENDPOINT_STATE_FILE: transactionState,
      ACR_API_ENDPOINT: "cr.cn-hongkong.aliyuncs.com",
      ACR_INSTANCE_ID: "cri-aais-test",
      ACR_PUBLIC_LOGIN_SERVER: "aais-registry.cn-hongkong.cr.aliyuncs.com",
      GITHUB_RUN_ID: "123",
      GITHUB_RUN_ATTEMPT: "1",
    },
  };
}

describe("temporary ACR CI endpoint", () => {
  const closedEndpoint = {
    Code: "success",
    IsSuccess: true,
    Enable: false,
    AclEnable: true,
    Domains: [{ Domain: "aais-registry.cn-hongkong.cr.aliyuncs.com" }],
    AclEntries: [],
  };

  it("opens one exact /32 and returns closed without the runner ACL", () => {
    const harness = createHarness(closedEndpoint);

    execFileSync(script, ["open"], { env: harness.environment });
    const opened = JSON.parse(readFileSync(harness.endpointState, "utf8"));
    expect(opened.Enable).toBe(true);
    expect(opened.AclEntries).toHaveLength(2);
    expect(opened.AclEntries).toContainEqual({
      Entry: "127.0.0.1/32",
      Comment: "system default",
    });
    expect(opened.AclEntries).toContainEqual({
      Entry: "8.8.8.8/32",
      Comment: expect.stringMatching(/^aais-gh-123-1-[0-9]{10}$/),
    });

    execFileSync(script, ["close"], { env: harness.environment });
    const closed = JSON.parse(readFileSync(harness.endpointState, "utf8"));
    expect(closed.Enable).toBe(false);
    expect(closed.AclEntries).toEqual([
      { Entry: "127.0.0.1/32", Comment: "system default" },
    ]);
    expect(() => readFileSync(harness.transactionState)).toThrow();
  });

  it("fails before mutation when public access is not closed without non-default ACLs", () => {
    const harness = createHarness({
      ...closedEndpoint,
      Enable: true,
      AclEntries: [{ Entry: "8.8.4.4/32", Comment: "unrelated" }],
    });

    const result = spawnSync(script, ["open"], {
      env: harness.environment,
      encoding: "utf8",
    });
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain(
      "ACR public access must be explicitly disabled without a non-default ACL before this job.",
    );
    const unchanged = JSON.parse(readFileSync(harness.endpointState, "utf8"));
    expect(unchanged.Enable).toBe(true);
    expect(unchanged.AclEntries).toHaveLength(1);
    expect(() => readFileSync(harness.transactionState)).toThrow();
  });

  it("disables and recovers its ACL but blocks the receipt when state is missing", () => {
    const expiry = Math.floor(Date.now() / 1000) + 2700;
    const harness = createHarness({
      ...closedEndpoint,
      Enable: true,
      AclEntries: [
        { Entry: "127.0.0.1/32", Comment: "system default" },
        { Entry: "8.8.8.8/32", Comment: `aais-gh-123-1-${expiry}` },
      ],
    });
    const result = spawnSync(script, ["close"], {
      env: {
        ...harness.environment,
        AAIS_ACR_REQUIRE_STATE_ON_CLOSE: "true",
      },
      encoding: "utf8",
    });

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain(
      "Expected ACR endpoint transaction state is missing.",
    );
    const closed = JSON.parse(readFileSync(harness.endpointState, "utf8"));
    expect(closed.Enable).toBe(false);
    expect(closed.AclEntries).toEqual([
      { Entry: "127.0.0.1/32", Comment: "system default" },
    ]);
  });

  it("never deletes ACLs when endpoint disable cannot be proven", () => {
    const harness = createHarness(closedEndpoint);
    execFileSync(script, ["open"], { env: harness.environment });

    const result = spawnSync(script, ["close"], {
      env: { ...harness.environment, MOCK_DISABLE_MODE: "fail" },
      encoding: "utf8",
    });
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain(
      "Failed to disable the temporary ACR public endpoint.",
    );
    const unchanged = JSON.parse(readFileSync(harness.endpointState, "utf8"));
    expect(unchanged.Enable).toBe(true);
    expect(unchanged.AclEntries).toHaveLength(2);
    expect(readFileSync(harness.transactionState, "utf8")).toContain("CIDR=8.8.8.8/32");
  });

  it("does not treat a missing Enable field as closed", () => {
    const harness = createHarness(closedEndpoint);
    execFileSync(script, ["open"], { env: harness.environment });

    const result = spawnSync(script, ["close"], {
      env: { ...harness.environment, MOCK_DISABLE_MODE: "omit" },
      encoding: "utf8",
    });
    expect(result.status).not.toBe(0);
    const unknown = JSON.parse(readFileSync(harness.endpointState, "utf8"));
    expect(unknown.Enable).toBeUndefined();
    expect(unknown.AclEntries).toHaveLength(2);
    expect(readFileSync(harness.transactionState, "utf8")).toContain("CIDR=8.8.8.8/32");
  });

  it("does not accept an open endpoint when ACL enforcement is disabled", () => {
    const harness = createHarness({ ...closedEndpoint, AclEnable: false });
    const result = spawnSync(script, ["open"], {
      env: harness.environment,
      encoding: "utf8",
    });

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain(
      "ACR did not install its deny-all default guard after opening.",
    );
  });

  it("independently reconciles the exact completed workflow run", () => {
    const harness = createHarness(closedEndpoint);
    execFileSync(script, ["open"], { env: harness.environment });

    execFileSync(script, ["reconcile"], {
      env: {
        ...harness.environment,
        AAIS_ACR_TARGET_RUN_ID: "123",
        AAIS_ACR_TARGET_RUN_ATTEMPT: "1",
      },
    });
    const endpoint = JSON.parse(readFileSync(harness.endpointState, "utf8"));
    expect(endpoint.Enable).toBe(false);
    expect(endpoint.AclEntries).toEqual([
      { Entry: "127.0.0.1/32", Comment: "system default" },
    ]);
  });

  it("does not interrupt a different run when its own ACL is already absent", () => {
    const expiry = Math.floor(Date.now() / 1000) + 2700;
    const harness = createHarness({
      ...closedEndpoint,
      Enable: true,
      AclEntries: [
        { Entry: "127.0.0.1/32", Comment: "system default" },
        { Entry: "8.8.8.8/32", Comment: `aais-gh-999-1-${expiry}` },
      ],
    });

    execFileSync(script, ["reconcile"], {
      env: {
        ...harness.environment,
        AAIS_ACR_TARGET_RUN_ID: "123",
        AAIS_ACR_TARGET_RUN_ATTEMPT: "1",
      },
    });
    const endpoint = JSON.parse(readFileSync(harness.endpointState, "utf8"));
    expect(endpoint.Enable).toBe(true);
    expect(endpoint.AclEntries).toHaveLength(2);
  });

  it("closes the enable-before-create cancellation window", () => {
    const harness = createHarness({
      ...closedEndpoint,
      Enable: true,
      AclEntries: [
        { Entry: "127.0.0.1/32", Comment: "system default" },
      ],
    });

    execFileSync(script, ["reconcile"], {
      env: {
        ...harness.environment,
        AAIS_ACR_TARGET_RUN_ID: "123",
        AAIS_ACR_TARGET_RUN_ATTEMPT: "1",
      },
    });
    const endpoint = JSON.parse(readFileSync(harness.endpointState, "utf8"));
    expect(endpoint.Enable).toBe(false);
    expect(endpoint.AclEntries).toHaveLength(1);
  });

  it("fences an enable request that becomes visible after the first closed read", () => {
    const harness = createHarness(closedEndpoint);

    execFileSync(script, ["reconcile"], {
      env: {
        ...harness.environment,
        AAIS_ACR_TARGET_RUN_ID: "123",
        AAIS_ACR_TARGET_RUN_ATTEMPT: "1",
        MOCK_DELAY_ENABLE_AFTER_FIRST_CLOSED_GET: "true",
      },
    });
    const endpoint = JSON.parse(readFileSync(harness.endpointState, "utf8"));
    expect(endpoint.Enable).toBe(false);
    expect(endpoint.AclEntries).toEqual([
      { Entry: "127.0.0.1/32", Comment: "system default" },
    ]);
  });

  it("disables an unsafe overlapping run instead of trusting its comment", () => {
    const expiry = Math.floor(Date.now() / 1000) + 2700;
    const harness = createHarness({
      ...closedEndpoint,
      Enable: true,
      AclEntries: [
        { Entry: "127.0.0.1/32", Comment: "system default" },
        { Entry: "0.0.0.0/0", Comment: `aais-gh-999-1-${expiry}` },
      ],
    });

    const result = spawnSync(script, ["reconcile"], {
      env: {
        ...harness.environment,
        AAIS_ACR_TARGET_RUN_ID: "123",
        AAIS_ACR_TARGET_RUN_ATTEMPT: "1",
      },
      encoding: "utf8",
    });
    expect(result.status).not.toBe(0);
    const endpoint = JSON.parse(readFileSync(harness.endpointState, "utf8"));
    expect(endpoint.Enable).toBe(false);
  });

  it("disables an overlapping run whose claimed expiry is unbounded", () => {
    const expiry = Math.floor(Date.now() / 1000) + 86400;
    const harness = createHarness({
      ...closedEndpoint,
      Enable: true,
      AclEntries: [
        { Entry: "127.0.0.1/32", Comment: "system default" },
        { Entry: "8.8.8.8/32", Comment: `aais-gh-999-1-${expiry}` },
      ],
    });

    const result = spawnSync(script, ["reconcile"], {
      env: {
        ...harness.environment,
        AAIS_ACR_TARGET_RUN_ID: "123",
        AAIS_ACR_TARGET_RUN_ATTEMPT: "1",
      },
      encoding: "utf8",
    });
    expect(result.status).not.toBe(0);
    const endpoint = JSON.parse(readFileSync(harness.endpointState, "utf8"));
    expect(endpoint.Enable).toBe(false);
  });
});
