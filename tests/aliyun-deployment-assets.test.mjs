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
    expect(deploy).toContain(".gitSha == $gitSha");
    expect(deploy).toContain("AAIS_EXPECTED_MACHINE_ID_SHA256");
    expect(deploy).toContain("AAIS_EXPECTED_NGINX_VHOST_SHA256");
    expect(deploy).toContain("AAIS_EXPECTED_DATABASE_CA_SHA256");
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
    ]) {
      expect(statSync(file).mode & 0o111, file).not.toBe(0);
    }
    const maintenance = readFileSync("deploy/aliyun/aais-maintenance.sh", "utf8");
    expect(maintenance).toContain("/opt/aais/state/maintenance.enabled");
    expect(maintenance).toContain("enable|disable|status");
    const bootstrap = readFileSync("deploy/aliyun/aais-secrets-bootstrap.sh", "utf8");
    expect(bootstrap).toContain("kms GetSecretValue");
    expect(bootstrap).toContain("runtimeEnvBase64");
    expect(bootstrap).toContain("workerEnvBase64");
    expect(bootstrap).toContain("runtime and worker secret bundles do not match");
    expect(bootstrap).toContain("/run/aais/current");
    expect(bootstrap).toContain("generation_published");
    expect(bootstrap).toContain("AAIS_OPERATION_LOCK_FD");
    expect(bootstrap).toContain("AAIS_PRODUCT_PSEUDONYM_SECRET");
    expect(bootstrap).toContain("bootstrap configuration must be root-owned with mode 0600");
    expect(bootstrap).not.toMatch(/AccessKey|SecretData.*echo/);
    const unit = readFileSync("deploy/aliyun/aais-secrets-bootstrap.service", "utf8");
    expect(unit).toContain("Before=aais-email-outbox.service aais-lrs-outbox.service");
    expect(unit).not.toContain("Before=docker.service");
    expect(unit).toContain("ReadWritePaths=/run/aais");
    const rotate = readFileSync("deploy/aliyun/aais-rotate-secrets.sh", "utf8");
    expect(rotate).toContain("systemctl stop");
    expect(rotate).toContain('"$bootstrap_wrapper"');
    expect(rotate).toContain("flock -n 9");
    expect(rotate).toContain("AAIS_OPERATION_LOCK_FD=9");
    expect(rotate).toContain('"$deploy_wrapper" "$image_ref" "$release_sha"');
    expect(rotate).toContain("worker timers remain stopped");
  });

  it("uses pinned actions and OIDC-only temporary ACR credentials", () => {
    const workflow = readFileSync(".github/workflows/aliyun-container.yml", "utf8");

    expect(workflow).toContain("id-token: write");
    expect(workflow).toContain("if: github.ref == 'refs/heads/main'");
    expect(workflow).toContain("runs-on: [self-hosted, linux, x64, aais-aliyun-build]");
    expect(workflow).toContain("aliyun/configure-aliyun-credentials-action@1e5248c8d5d93a8781ac344a68e19a43341e79e6");
    expect(workflow).toContain("aliyun/setup-aliyun-cli-action@09a5f86915bb556e27bf050e9a5e339aeb073df5");
    expect(workflow).toContain("cr GetAuthorizationToken");
    expect(workflow).toContain("--password-stdin");
    expect(workflow).toContain("DOCKER_CONFIG: ${{ runner.temp }}/aais-docker-${{ github.run_id }}");
    expect(workflow).toContain("if: ${{ always() }}");
    expect(workflow).toContain('docker logout "$ACR_LOGIN_SERVER"');
    expect(workflow).toContain('test "$(git rev-parse HEAD)" = "${{ github.sha }}"');
    expect(workflow).toContain("AAIS_BUILD_TIMESTAMP=${{ steps.source.outputs.build_timestamp }}");
    expect(workflow).toContain("tags: ${{ vars.ALIYUN_ACR_REPOSITORY }}:${{ github.sha }}");
    expect(workflow).toContain("NEXT_SERVER_ACTIONS_ENCRYPTION_KEY=${{ secrets.AAIS_NEXT_SERVER_ACTIONS_ENCRYPTION_KEY }}");
    const buildArguments = workflow.match(/build-args: \|\n((?:\s{12}.+\n)+)/)?.[1] ?? "";
    expect(buildArguments).not.toContain("NEXT_SERVER_ACTIONS_ENCRYPTION_KEY");
    expect(workflow).not.toMatch(/ACCESS_KEY_ID:\s*\$\{\{\s*secrets\./i);
    expect(workflow).not.toMatch(/ACCESS_KEY_SECRET:\s*\$\{\{\s*secrets\./i);
    expect(workflow).not.toContain("@v1");
    expect(workflow).not.toContain("@v3");
    expect(workflow).not.toContain("@v4");
    expect(workflow).not.toContain("@v6");
  });
});
