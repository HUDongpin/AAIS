import { readFileSync, statSync } from "node:fs";
import { describe, expect, it } from "vitest";

describe("AAIS Aliyun deployment assets", () => {
  it("builds a Node 24 standalone image with a non-root runtime", () => {
    const dockerfile = readFileSync("Dockerfile", "utf8");
    const nextConfig = readFileSync("next.config.ts", "utf8");

    expect(dockerfile).toContain("FROM node:24-bookworm-slim");
    expect(dockerfile).toContain("/app/.next/standalone");
    expect(dockerfile).toContain("USER 10001:10001");
    expect(dockerfile).toContain("/api/system/live");
    expect(dockerfile).toContain("--mount=type=secret,id=NEXT_SERVER_ACTIONS_ENCRYPTION_KEY");
    expect(dockerfile).toContain("AAIS_REQUIRE_STABLE_SERVER_ACTIONS_KEY");
    expect(nextConfig).toContain('output: "standalone"');
    expect(nextConfig).toContain("deploymentId: readAaisBuildDeploymentId()");
    expect(nextConfig).toContain(
      'import { readAaisBuildDeploymentId } from "./src/lib/build/aais-next-deployment-id"',
    );
  });

  it("excludes owner secrets, local data, and evidence from the Docker context", () => {
    const ignore = readFileSync(".dockerignore", "utf8");

    for (const required of [
      ".env.*",
      "All API Keys.docx",
      ".aais-data",
      ".aais-e2e-data",
      "*.docx",
      "*.csv",
      "test-results",
      "technical-review/.codex-work",
    ]) {
      expect(ignore).toContain(required);
    }
  });

  it("binds blue-green containers only to loopback with hard resource limits", () => {
    const deploy = readFileSync("deploy/aliyun/aais-deploy.sh", "utf8");

    expect(deploy).toContain('target_port="3101"');
    expect(deploy).toContain('target_port="3102"');
    expect(deploy).toContain('--publish "127.0.0.1:${target_port}:3000"');
    expect(deploy).toContain("--cpus 1.25");
    expect(deploy).toContain("--memory 1280m");
    expect(deploy).toContain("--pids-limit 256");
    expect(deploy).toContain("--read-only");
    expect(deploy).toContain("--cap-drop ALL");
    expect(deploy).toContain("AAIS capacity gate failed");
    expect(deploy).toContain("flock -n 9");
    expect(deploy).toContain("GetAuthorizationToken");
    expect(deploy).toContain("docker logout");
    expect(deploy).toContain("DOCKER_CONFIG");
    expect(deploy).toContain("/run/aais/docker-config.");
    expect(deploy).toContain("org.opencontainers.image.revision");
    expect(deploy).toContain("image_revision");
    expect(deploy).toContain("candidate_source_receipt");
    expect(deploy).toContain("watchdog_source_receipt");
    expect(deploy).toContain(".gitSha == $gitSha");
    expect(deploy).toContain(".publicEndpointClosed == true");
    expect(deploy).toContain(".postRunWatchdogActive == true");
    expect(deploy).toContain(".publicEndpointReconciled == true");
    expect(deploy).toContain(".acrInstanceId == $acrInstanceId");
    expect(deploy).toContain(".publicLoginServer == $publicLoginServer");
    expect(deploy).toContain(".pushRepository == $pushRepository");
    expect(deploy).toContain("expected_public_push_repository");
    expect(deploy).toContain("AAIS_EXPECTED_MACHINE_ID_SHA256");
    expect(deploy).toContain("AAIS_EXPECTED_NGINX_VHOST_SHA256");
    expect(deploy).toContain("AAIS_EXPECTED_DATABASE_CA_SHA256");
    expect(deploy).toContain("active-deployment.env");
    expect(deploy).toContain("AAIS_ACTIVE_SECRET_BUNDLE_VERSION");
    expect(deploy).toContain("AAIS_ROTATION_PENDING_FILE");
    expect(deploy).toContain("secretBundleVersion");
    expect(deploy).toContain("commit_recovered_active_state");
    expect(deploy).toContain("finalized a verified interrupted Nginx promotion");
    expect(deploy).toContain("nginx_loaded_release_matches");
    expect(deploy).toContain("www.aais.site:8443:127.0.0.1");
    expect(deploy).toContain("dst=/etc/aais/rds-ca.pem,readonly");
    expect(deploy).toContain("deploy configuration must be root-owned with mode 0600");
    expect(deploy).toContain("--resolve www.aais.site:443:127.0.0.1");
    expect(deploy).toContain("pause_worker_timers");
    expect(deploy).toContain("drain_active_connections");
    expect(deploy).toContain("seq 1 330");
    expect(deploy).toContain("container_matches_expected_runtime");
    expect(deploy).toContain("candidate comprehensive readiness is not ready");
    expect(deploy).toContain("automatic rollback could not be verified");
    expect(deploy).toContain("active state and Nginx upstream disagree");
    expect(deploy).toContain("active container is unavailable; entering exact-digest recovery mode");
    expect(deploy).toContain("docker start \"$active_container\"");
    expect(deploy).not.toContain("docker build");
    expect(deploy).not.toContain("latest");
    expect(deploy.indexOf('mv -Tf -- "$candidate_state" "$AAIS_STATE_FILE"'))
      .toBeLessThan(deploy.indexOf('mv -Tf -- "$candidate_receipt" "$receipt_file"'));
  });

  it("keeps SSE unbuffered and overwrites the trusted client IP headers", () => {
    const nginx = readFileSync("deploy/aliyun/nginx-aais.conf.template", "utf8");

    expect(nginx).toContain("proxy_buffering off");
    expect(nginx).toContain("proxy_cache off");
    expect(nginx).toContain("proxy_read_timeout 300s");
    expect(nginx).toContain("client_max_body_size 20m");
    expect(nginx).toContain("proxy_set_header X-Real-IP $remote_addr");
    expect(nginx).toContain("proxy_set_header X-Forwarded-For $remote_addr");
    expect(nginx).not.toContain("$http_x_forwarded_for");
    expect(nginx).toContain("log_format aais_redacted");
    expect(nginx).toContain("uri=$uri");
    const redactedLogFormat = nginx.slice(0, nginx.indexOf("upstream aais_app"));
    expect(redactedLogFormat).not.toContain("$request_uri");
    expect(redactedLogFormat).not.toContain("$args");
    expect(redactedLogFormat).not.toContain("$http_cookie");
    expect(nginx).not.toContain("$http_authorization");
    expect(nginx).toContain("error_log /dev/null crit");
    expect(nginx).toContain("/opt/aais/state/maintenance.enabled");
    expect(nginx).toContain("/opt/aais/state/secret-rotation.pending");
    expect(nginx).toContain("listen 127.0.0.1:8443 ssl");
    expect(nginx).toContain("Retry-After");
  });

  it("uses independent one-minute systemd timers for both outboxes", () => {
    for (const timer of [
      "deploy/aliyun/aais-email-outbox.timer",
      "deploy/aliyun/aais-lrs-outbox.timer",
    ]) {
      expect(readFileSync(timer, "utf8")).toContain("OnCalendar=*-*-* *:*:00");
    }
    const worker = readFileSync("deploy/aliyun/aais-worker.sh", "utf8");
    expect(worker).toContain("curl --config -");
    expect(worker).not.toContain("--header \"Authorization:");
    expect(worker).toContain("--connect-timeout 5");
    expect(worker).toContain("--max-time 90");
    expect(worker).toContain("mode 0440");
    expect(worker).toContain('"status":"standby"');
    for (const service of [
      "deploy/aliyun/aais-email-outbox.service",
      "deploy/aliyun/aais-lrs-outbox.service",
    ]) {
      const unit = readFileSync(service, "utf8");
      expect(unit).toContain("User=aais-worker");
      expect(unit).toContain("TimeoutStartSec=100");
    }
    const vercel = JSON.parse(readFileSync("vercel.json", "utf8"));
    expect(vercel.crons).toEqual([
      {
        path: "/api/learning/lrs/outbox/flush",
        schedule: "*/5 * * * *",
      },
      {
        path: "/api/auth/email-outbox/flush",
        schedule: "*/5 * * * *",
      },
    ]);
  });

  it("does not provision a Vercel login or grant on the private RDS", () => {
    const roles = readFileSync("deploy/aliyun/rds-runtime-roles.sql", "utf8");

    expect(roles).toContain("aais_app_aliyun");
    expect(roles).toContain("aais_migrator");
    expect(roles).toContain("alter role aais_migrator nologin");
    expect(roles).toContain('revoke connect on database :"DBNAME" from aais_migrator');
    expect(roles).toContain("revoke create on schema public from aais_migrator");
    expect(roles).not.toContain("to aais_app_aliyun, aais_migrator");
    expect(roles).not.toContain("grant usage, create on schema public to aais_migrator");
    expect(roles).not.toContain("aais_app_vercel");
    expect(roles).not.toContain("grant select, insert, update, delete on all tables");
    expect(roles).not.toContain("aais_research_");
    const closeMigrator = readFileSync("deploy/aliyun/rds-close-migrator.sql", "utf8");
    expect(closeMigrator).toContain("alter role aais_migrator nologin");
    expect(closeMigrator).toContain("pg_terminate_backend");
    expect(closeMigrator).toContain("migrator_active_sessions");
  });

  it("ships executable root wrappers and a file-backed maintenance freeze", () => {
    for (const file of [
      "deploy/aliyun/aais-deploy.sh",
      "deploy/aliyun/aais-worker.sh",
      "deploy/aliyun/aais-maintenance.sh",
      "deploy/aliyun/aais-secrets-bootstrap.sh",
      "deploy/aliyun/aais-rotate-secrets.sh",
      "deploy/aliyun/aais-acr-ci-endpoint.sh",
    ]) {
      expect(statSync(file).mode & 0o111, file).not.toBe(0);
    }
    const maintenance = readFileSync("deploy/aliyun/aais-maintenance.sh", "utf8");
    expect(maintenance).toContain("/opt/aais/state/maintenance.enabled");
    expect(maintenance).toContain("enable|disable|status");
    const bootstrap = readFileSync("deploy/aliyun/aais-secrets-bootstrap.sh", "utf8");
    expect(bootstrap).toContain('AAIS_SECRET_SOURCE:=file');
    expect(bootstrap).toContain("/etc/aais/secrets/runtime.env");
    expect(bootstrap).not.toContain('local_worker_source=');
    expect(bootstrap).not.toContain("AAIS_LOCAL_SECRET_BUNDLE_VERSION");
    expect(bootstrap).toContain('local_secret_dir_mode" != "700"');
    expect(bootstrap).toContain('local_secret_mode" != "400"');
    expect(bootstrap).toContain('local_secret_links" != "1"');
    expect(bootstrap).toContain("local_source_sha_before");
    expect(bootstrap).toContain('> "$worker_candidate"');
    expect(bootstrap).toContain("kms GetSecretValue");
    expect(bootstrap).toContain("runtimeEnvBase64");
    expect(bootstrap).not.toContain("workerEnvBase64");
    expect(bootstrap).toContain("runtime and worker secret bundles do not match");
    expect(bootstrap).toContain("/run/aais/current");
    expect(bootstrap).toContain("generation_published");
    expect(bootstrap).toContain("AAIS_OPERATION_LOCK_FD");
    expect(bootstrap).toContain("AAIS_PRODUCT_PSEUDONYM_SECRET");
    expect(bootstrap).toContain("AAIS_SECRET_BUNDLE_VERSION");
    expect(bootstrap).toContain("bootstrap configuration must be root-owned with mode 0600");
    expect(bootstrap).not.toMatch(/AccessKey|SecretData.*echo/);
    const unit = readFileSync("deploy/aliyun/aais-secrets-bootstrap.service", "utf8");
    expect(unit).toContain("Before=aais-email-outbox.service aais-lrs-outbox.service");
    expect(unit).not.toContain("Before=docker.service");
    expect(unit).toContain("After=local-fs.target");
    expect(unit).not.toContain("network-online.target");
    expect(unit).toContain("ReadWritePaths=/run/aais");
    const kmsDropIn = readFileSync(
      "deploy/aliyun/aais-secrets-bootstrap-kms.conf.example",
      "utf8",
    );
    expect(kmsDropIn).toContain("network-online.target");
    const rotate = readFileSync("deploy/aliyun/aais-rotate-secrets.sh", "utf8");
    expect(rotate).toContain("systemctl stop");
    expect(rotate).toContain('"$bootstrap_wrapper"');
    expect(rotate).toContain("flock -n 9");
    expect(rotate).toContain("AAIS_OPERATION_LOCK_FD=9");
    expect(rotate).toContain('"$deploy_wrapper" "$image_ref" "$release_sha"');
    expect(rotate).toContain("worker timers remain stopped");
    expect(rotate).toContain("secret-rotation.pending");
    expect(rotate).toContain("runtime.env.candidate");
    expect(rotate).toContain('"--resume"');
    expect(rotate).toContain("active-deployment.env");
    expect(rotate).toContain("write_rotation_phase");
    expect(rotate).toContain("previous-saved");
    expect(rotate).toContain("source-promoted");
    expect(rotate).toContain('"--rollback"');
    expect(rotate).toContain('"--replace-pending"');
    expect(rotate.indexOf('--validate-file "$local_runtime_candidate"'))
      .toBeLessThan(rotate.indexOf("write_rotation_phase prepared"));
    expect(rotate).toContain("www.aais.site:8443:127.0.0.1");
    expect(rotate).toContain("canonical path does not match the promoted release");
    expect(rotate.lastIndexOf('rm -f -- "$rotation_pending_file"'))
      .toBeLessThan(rotate.lastIndexOf('systemctl start "$email_timer"'));
    expect(rotate.indexOf("canonical_probe="))
      .toBeLessThan(rotate.indexOf('rm -f -- "$local_runtime_previous"'));
    for (const service of [
      "deploy/aliyun/aais-email-outbox.service",
      "deploy/aliyun/aais-lrs-outbox.service",
    ]) {
      expect(readFileSync(service, "utf8")).toContain(
        "ConditionPathExists=!/opt/aais/state/secret-rotation.pending",
      );
    }
    const worker = readFileSync("deploy/aliyun/aais-worker.sh", "utf8");
    expect(worker).toContain("active-deployment.env");
    expect(worker).toContain("worker secret bundle does not match the active deployment");
  });

  it("uses pinned actions and OIDC-only temporary ACR credentials", () => {
    const workflow = readFileSync(".github/workflows/aliyun-container.yml", "utf8");
    const endpoint = readFileSync("deploy/aliyun/aais-acr-ci-endpoint.sh", "utf8");
    const buildPolicy = JSON.parse(
      readFileSync("deploy/aliyun/github-build-role-policy.json.example", "utf8"),
    );

    expect(workflow).toContain("id-token: write");
    expect(workflow).toContain("product-gates:");
    expect(workflow).toContain("name: Test without cloud identity");
    expect(workflow).toContain("needs: product-gates");
    expect(workflow).toContain("Run product gates without an OIDC token");
    expect(workflow.match(/id-token: write/g)).toHaveLength(1);
    expect(workflow.indexOf("product-gates:"))
      .toBeLessThan(workflow.indexOf("id-token: write"));
    const productGateJob = workflow.slice(
      workflow.indexOf("  product-gates:"),
      workflow.indexOf("  build-and-push:"),
    );
    expect(productGateJob).not.toContain("id-token");
    expect(productGateJob).not.toContain("aliyun/");
    expect(productGateJob).not.toContain("ACR_");
    expect(workflow).toContain("if: github.ref == 'refs/heads/main'");
    expect(workflow).toContain("runs-on: ubuntu-24.04");
    expect(workflow).not.toContain("self-hosted");
    expect(workflow).not.toContain("aais-aliyun-build");
    expect(workflow).toContain("aliyun/configure-aliyun-credentials-action@1e5248c8d5d93a8781ac344a68e19a43341e79e6");
    expect(workflow).toContain("role-session-expiration: 3600");
    expect(workflow).toContain("timeout-minutes: 45");
    expect(workflow).toContain("timeout-minutes: 25");
    expect(workflow).toContain("aliyun/setup-aliyun-cli-action@09a5f86915bb556e27bf050e9a5e339aeb073df5");
    expect(workflow).toContain("cr GetAuthorizationToken");
    expect(workflow).toContain("--password-stdin");
    expect(workflow).toContain("DOCKER_CONFIG: ${{ runner.temp }}/aais-docker-${{ github.run_id }}");
    expect(workflow).toContain("ALIYUN_ACR_PUBLIC_PUSH_REPOSITORY");
    expect(workflow).toContain("ALIYUN_ACR_VPC_DEPLOYMENT_REPOSITORY");
    expect(workflow).toContain("actions: read");
    expect(workflow).toContain("aliyun-acr-postrun-watchdog.yml");
    expect(workflow).toContain("Write non-secret watchdog handoff");
    expect(workflow).toContain("Preserve watchdog handoff before opening ACR");
    expect(workflow).toContain("aais-acr-watchdog-handoff-${{ github.run_id }}-${{ github.run_attempt }}");
    expect(workflow).toContain("acrInstanceId: $acrInstanceId");
    expect(workflow).toContain("acrApiEndpoint: $acrApiEndpoint");
    expect(workflow).toContain("publicLoginServer: $publicLoginServer");
    expect(workflow).toContain('test "$public_path" = "$vpc_path"');
    expect(workflow).toContain('[[ "$public_path" =~ ^[a-z0-9][a-z0-9._-]*/aais$ ]]');
    expect(workflow).toContain("aais-acr-ci-endpoint.sh open");
    expect(workflow).toContain("aais-acr-ci-endpoint.sh close");
    expect(workflow).toContain("AAIS_ACR_REQUIRE_STATE_ON_CLOSE");
    expect(workflow.indexOf("Require the independent post-run watchdog"))
      .toBeLessThan(workflow.indexOf("Open one-run ACR public push path"));
    expect(workflow.indexOf("Preserve watchdog handoff before opening ACR"))
      .toBeLessThan(workflow.indexOf("Open one-run ACR public push path"));
    expect(workflow).toContain("if: ${{ always() }}");
    expect(workflow).toContain('docker logout "$ACR_PUBLIC_LOGIN_SERVER"');
    expect(workflow.indexOf("aais-acr-ci-endpoint.sh close"))
      .toBeLessThan(workflow.indexOf("Write non-secret candidate receipt"));
    expect(workflow).toContain('test "$(git rev-parse HEAD)" = "${{ github.sha }}"');
    expect(workflow).toContain("AAIS_BUILD_TIMESTAMP=${{ steps.source.outputs.build_timestamp }}");
    expect(workflow).toContain("tags: ${{ vars.ALIYUN_ACR_PUBLIC_PUSH_REPOSITORY }}:${{ github.sha }}");
    expect(workflow).toContain('imageRepository "$ACR_VPC_DEPLOYMENT_REPOSITORY"');
    expect(workflow).toContain("publicEndpointClosed: true");
    expect(workflow).toContain("postRunWatchdogActive: true");
    expect(workflow).toContain("acrInstanceId: $acrInstanceId");
    expect(workflow).toContain("NEXT_SERVER_ACTIONS_ENCRYPTION_KEY=${{ secrets.AAIS_NEXT_SERVER_ACTIONS_ENCRYPTION_KEY }}");
    const buildArguments = workflow.match(/build-args: \|\n((?:\s{12}.+\n)+)/)?.[1] ?? "";
    expect(buildArguments).not.toContain("NEXT_SERVER_ACTIONS_ENCRYPTION_KEY");
    expect(workflow).not.toMatch(/ACCESS_KEY_ID:\s*\$\{\{\s*secrets\./i);
    expect(workflow).not.toMatch(/ACCESS_KEY_SECRET:\s*\$\{\{\s*secrets\./i);
    expect(workflow).not.toContain("@v1");
    expect(workflow).not.toContain("@v3");
    expect(workflow).not.toContain("@v4");
    expect(workflow).not.toContain("@v6");

    expect(endpoint).toContain("CreateInstanceEndpointAclPolicy");
    expect(endpoint).toContain("DeleteInstanceEndpointAclPolicy");
    expect(endpoint).toContain("UpdateInstanceEndpointStatus");
    expect(endpoint).toContain("GetInstanceEndpoint");
    expect(endpoint).toContain("https://api.ipify.org");
    expect(endpoint).toContain("https://checkip.amazonaws.com");
    expect(endpoint).toContain('cidr="${ip_first}/32"');
    expect(endpoint).toContain("ACR public access must be explicitly disabled without a non-default ACL");
    expect(endpoint).toContain("wait_for_default_guard_after_open");
    expect(endpoint).toContain("wait_for_closed_endpoint");
    expect(endpoint).toContain("final_close_fence_sent");
    expect(endpoint).toContain("closed_observations >= 5");
    expect(endpoint).toContain("could not install its final close fence");
    expect(endpoint).toContain("Expected ACR endpoint transaction state is missing.");
    expect(endpoint.indexOf("--Enable true"))
      .toBeLessThan(endpoint.indexOf("CreateInstanceEndpointAclPolicy"));
    expect(endpoint.lastIndexOf("--Enable false"))
      .toBeLessThan(endpoint.lastIndexOf("DeleteInstanceEndpointAclPolicy"));
    expect(endpoint).toContain(".Enable == false");
    expect(endpoint).toContain(".AclEnable == true");
    expect(endpoint).not.toContain(".Enable != true");
    expect(endpoint).not.toContain("0.0.0.0/0");
    expect(endpoint).not.toMatch(/AccessKeyId|AccessKeySecret/);
    expect(buildPolicy.Statement.flatMap((statement) => statement.Action)).toEqual([
      "cr:GetAuthorizationToken",
      "cr:PullRepository",
      "cr:PushRepository",
      "cr:GetInstanceEndpoint",
      "cr:CreateInstanceEndpointAclPolicy",
      "cr:DeleteInstanceEndpointAclPolicy",
      "cr:UpdateInstanceEndpointStatus",
    ]);
    expect(buildPolicy.Statement[1].Resource).toContain(
      "repository/REPLACE_INSTANCE_ID/REPLACE_NAMESPACE/aais",
    );
    expect(buildPolicy.Statement[2].Resource).toContain(
      "instance/REPLACE_INSTANCE_ID",
    );
  });

  it("uses an independent completed-run workflow as the ACR cleanup watchdog", () => {
    const watchdog = readFileSync(
      ".github/workflows/aliyun-acr-postrun-watchdog.yml",
      "utf8",
    );
    const watchdogPolicy = JSON.parse(
      readFileSync("deploy/aliyun/github-watchdog-role-policy.json.example", "utf8"),
    );

    expect(watchdog).toContain('workflows: ["Aliyun container candidate"]');
    expect(watchdog).toContain("types: [completed]");
    expect(watchdog).toContain("head_branch == 'main'");
    expect(watchdog).toContain(
      "head_repository.full_name == github.repository",
    );
    expect(watchdog).toContain("runs-on: ubuntu-24.04");
    expect(watchdog).toContain("environment: aliyun-watchdog");
    expect(watchdog).toContain("ref: ${{ github.event.workflow_run.head_sha }}");
    expect(watchdog).not.toContain("ref: main");
    expect(watchdog).toContain("actions: read");
    expect(watchdog).toContain("Download the pre-open watchdog handoff");
    expect(watchdog).toContain(
      "actions/download-artifact@3e5f45b2cfb9172054b4087a40e8e0b5a5461e7c",
    );
    expect(watchdog).toContain(
      "aais-acr-watchdog-handoff-${{ github.event.workflow_run.id }}-${{ github.event.workflow_run.run_attempt }}",
    );
    expect(watchdog).toContain("run-id: ${{ github.event.workflow_run.id }}");
    expect(watchdog).toContain(".gitSha == $gitSha");
    expect(watchdog).toContain(".candidateRunId == $candidateRunId");
    expect(watchdog).toContain(".candidateRunAttempt == $candidateRunAttempt");
    expect(watchdog).toContain("ACR_INSTANCE_ID=%s");
    expect(watchdog).toContain("ACR_API_ENDPOINT=%s");
    expect(watchdog).toContain("ACR_PUBLIC_LOGIN_SERVER=%s");
    expect(watchdog).not.toContain("vars.ALIYUN_ACR_INSTANCE_ID");
    expect(watchdog).not.toContain("vars.ALIYUN_ACR_API_ENDPOINT");
    expect(watchdog).not.toContain("vars.ALIYUN_ACR_PUBLIC_LOGIN_SERVER");
    expect(watchdog).toContain("AAIS_ACR_TARGET_RUN_ID");
    expect(watchdog).toContain("AAIS_ACR_TARGET_RUN_ATTEMPT");
    expect(watchdog).toContain("aais-acr-ci-endpoint.sh reconcile");
    expect(watchdog).toContain("acr_postrun_cleanup");
    expect(watchdog).toContain("publicEndpointReconciled: true");
    expect(watchdog).toContain("acrInstanceId: $acrInstanceId");
    expect(watchdog).toContain("actions/upload-artifact@ea165f8d65b6e75b540449e92b4886f43607fa02");
    expect(watchdog).toContain(
      "aliyun/configure-aliyun-credentials-action@1e5248c8d5d93a8781ac344a68e19a43341e79e6",
    );
    expect(watchdogPolicy.Statement.flatMap((statement) => statement.Action)).toEqual([
      "cr:GetInstanceEndpoint",
      "cr:DeleteInstanceEndpointAclPolicy",
      "cr:UpdateInstanceEndpointStatus",
    ]);
    expect(watchdogPolicy.Statement.flatMap((statement) => statement.Action)).not.toContain(
      "cr:CreateInstanceEndpointAclPolicy",
    );
    const runbook = readFileSync("docs/aliyun-primary-runbook.md", "utf8");
    expect(runbook).toContain("no required reviewers and no wait timer");
    expect(runbook).toContain("interactive environment approval is forbidden");
    expect(runbook).toContain("holds only `ALIYUN_OIDC_PROVIDER_ARN` and");
    expect(runbook).toContain("has no build secret, ACR binding variable, or");
  });
});
