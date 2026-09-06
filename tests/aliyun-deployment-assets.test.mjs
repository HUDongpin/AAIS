import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { describe, expect, it } from "vitest";

describe("AAIS Aliyun deployment assets", () => {
  it("parses every secret bootstrap awk program with the system awk", () => {
    const source = readFileSync("deploy/aliyun/aais-secrets-bootstrap.sh", "utf8");
    const programs = [...source.matchAll(/\bawk\b[^'\n]*'([\s\S]*?)'/g)];
    expect(programs.length).toBeGreaterThan(0);
    for (const [, program] of programs) {
      const result = spawnSync("awk", [program], { input: "", encoding: "utf8" });
      expect(result.error).toBeUndefined();
      expect(result.stderr).toBe("");
      expect([0, 1]).toContain(result.status);
    }
  });

  it("pins one protected jq-free JSON helper before mutation or credential input", () => {
    const helperBytes = readFileSync("deploy/aliyun/aais-json-v1.py");
    const helperHash = createHash("sha256").update(helperBytes).digest("hex");
    const scripts = [
      "deploy/aliyun/aais-preload-ghcr-image.sh",
      "deploy/aliyun/aais-deploy.sh",
      "deploy/aliyun/aais-rotate-secrets.sh",
    ];

    for (const path of scripts) {
      const source = readFileSync(path, "utf8");
      const guardCall = source.lastIndexOf("aais_require_json_helper");
      expect(source, path).toContain(
        'readonly AAIS_JSON_HELPER_PATH="/opt/aais/libexec/aais-json-v1.py"',
      );
      expect(source, path).toContain(
        `readonly AAIS_JSON_HELPER_SHA256="${helperHash}"`,
      );
      expect(source, path).toContain(
        "/usr/bin/env -i LC_ALL=C LANG=C HOME=/ TZ=UTC",
      );
      expect(source, path).toContain("/usr/bin/python3 -I -S -B");
      expect(source, path).toContain("! -x /usr/bin/python3");
      expect(source, path).toContain('-L "$AAIS_JSON_HELPER_PATH"');
      if (path.endsWith("aais-preload-ghcr-image.sh")) {
        expect(source, path).toContain('"$helper_owner" != "0"');
        expect(source, path).toContain('"$helper_mode" != "500"');
        expect(source, path).toContain('"$helper_links" != "1"');
      } else {
        expect(source, path).toContain(
          'stat -c \'%u\' "$AAIS_JSON_HELPER_PATH"',
        );
        expect(source, path).toContain(
          'stat -c \'%a\' "$AAIS_JSON_HELPER_PATH"',
        );
        expect(source, path).toContain(
          'stat -c \'%h\' "$AAIS_JSON_HELPER_PATH"',
        );
      }
      expect(source, path).toContain("self-test");
      expect(source, path).not.toMatch(/\bjq\b/);
      expect(source, path).not.toContain("${AAIS_JSON_HELPER_PATH:-");
      expect(guardCall, path).toBeGreaterThan(-1);
      expect(guardCall, path).toBeLessThan(source.indexOf("install -d"));
    }

    const preload = readFileSync("deploy/aliyun/aais-preload-ghcr-image.sh", "utf8");
    const deploy = readFileSync("deploy/aliyun/aais-deploy.sh", "utf8");
    const rotate = readFileSync("deploy/aliyun/aais-rotate-secrets.sh", "utf8");
    expect(preload.lastIndexOf("aais_require_json_helper"))
      .toBeLessThan(preload.lastIndexOf("aais_require_owner_tty"));
    expect(deploy.lastIndexOf("aais_require_json_helper"))
      .toBeLessThan(deploy.indexOf('exec 9>"$AAIS_OPERATION_LOCK_FILE"'));
    expect(rotate.lastIndexOf("aais_require_json_helper"))
      .toBeLessThan(rotate.indexOf('exec 9>"$operation_lock_file"'));
    expect(rotate.lastIndexOf("aais_require_json_helper"))
      .toBeLessThan(rotate.indexOf("systemctl stop"));

    const preloadCandidateGate = preload.indexOf(
      'candidate_metadata="$(aais_validate_ghcr_candidate_receipt',
    );
    const preloadExistingGate = preload.indexOf(
      'aais_validate_ghcr_preloaded_receipt "$preloaded_receipt"',
    );
    for (const mutation of [
      preload.lastIndexOf("aais_require_owner_tty"),
      preload.indexOf("docker login ghcr.io"),
      preload.indexOf('docker pull "$image_ref"'),
    ]) {
      expect(preloadCandidateGate).toBeLessThan(mutation);
      expect(preloadExistingGate).toBeLessThan(mutation);
    }
    expect(preload).toContain('rm -f -- "$aais_preload_receipt_candidate"');

    const deployCandidateGate = deploy.indexOf(
      'candidate_metadata="$(aais_run_json_helper candidate-metadata',
    );
    const deployPreloadedGate = deploy.indexOf(
      "aais_run_json_helper validate-preloaded",
    );
    for (const mutation of [
      deploy.indexOf("docker network create aais-net"),
      deploy.indexOf('docker rm -f "$target_container"'),
      deploy.indexOf("\npause_worker_timers\n"),
      deploy.indexOf('"$AAIS_NGINX_BINARY" -s reload'),
    ]) {
      expect(deployCandidateGate).toBeLessThan(mutation);
      expect(deployPreloadedGate).toBeLessThan(mutation);
    }
    const candidateStart = deploy.indexOf("docker run --detach");
    const runtimeGates = [
      deploy.indexOf('aais_json_validate_live "$release_sha"', candidateStart),
      deploy.indexOf('aais_json_validate_traffic_ready "$release_sha"', candidateStart),
      deploy.indexOf("aais_json_validate_public_ready", candidateStart),
    ];
    for (const gate of runtimeGates) {
      expect(gate).toBeGreaterThan(candidateStart);
      expect(gate).toBeLessThan(deploy.indexOf("\npause_worker_timers\n"));
    }
    expect(deploy.match(/--max-filesize 65536/g)?.length).toBeGreaterThanOrEqual(10);
    expect(deploy).not.toMatch(
      /(?:live|traffic|full_readiness|nginx)_report="\$\(curl/,
    );
    expect(rotate.match(/--max-filesize 65536/g)).toHaveLength(2);
    expect(rotate).not.toMatch(/(?:diagnostic|canonical)_probe="\$\(curl/);
    const deploymentWrite = deploy.indexOf("write-deployment");
    const deploymentRoundTrip = deploy.indexOf("validate-deployment");
    expect(deploymentWrite).toBeGreaterThan(candidateStart);
    expect(deploymentWrite).toBeLessThan(deploymentRoundTrip);
    expect(deploymentRoundTrip).toBeLessThan(deploy.indexOf("\npause_worker_timers\n"));
    expect(deploy).not.toContain("printf '{\"schemaVersion\":1");
  });

  it("builds a Node 24 standalone image with a non-root runtime", () => {
    const dockerfile = readFileSync("Dockerfile", "utf8");
    const nextConfig = readFileSync("next.config.ts", "utf8");

    expect(dockerfile).toContain("FROM node:24-bookworm-slim AS dependencies");
    expect(dockerfile).toContain(
      "FROM gcr.io/distroless/nodejs24-debian13@sha256:774b7d020b24214835769e24c3544835526cd0288f0b094eae48e8b2c2429a79 AS runtime",
    );
    expect(dockerfile).toContain("/app/.next/standalone");
    expect(dockerfile).toContain("RUN mkdir -p public .aais-runtime-cache");
    expect(dockerfile).toContain(
      "COPY --from=builder --chown=10001:10001 /app/.aais-runtime-cache ./.next/cache",
    );
    expect(dockerfile).toContain("USER 10001:10001");
    expect(dockerfile).toContain('CMD ["/nodejs/bin/node", "-e"');
    expect(dockerfile).toContain('CMD ["server.js"]');
    expect(dockerfile).not.toContain("groupadd");
    expect(dockerfile).not.toContain("useradd");
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
      "*.pdf",
      "*.xlsx",
      "test-results",
      "tests",
      "technical-review",
      "docs/evidence",
      "docs/figures",
    ]) {
      expect(ignore).toContain(required);
    }
  });

  it("binds blue-green containers only to loopback with hard resource limits", () => {
    const deploy = readFileSync("deploy/aliyun/aais-deploy.sh", "utf8");

    expect(deploy).toContain('target_port="3111"');
    expect(deploy).toContain('target_port="3112"');
    expect(deploy).toContain('--publish "127.0.0.1:${target_port}:3000"');
    expect(deploy).toContain("--cpus 1.25");
    expect(deploy).toContain("--memory 1280m");
    expect(deploy).toContain("--pids-limit 256");
    expect(deploy).toContain("--read-only");
    expect(deploy).toContain(
      "--tmpfs /tmp:rw,noexec,nosuid,size=64m,mode=1777,uid=10001,gid=10001",
    );
    expect(deploy).toContain(
      "--tmpfs /app/.next/cache:rw,noexec,nosuid,size=256m,mode=0700,uid=10001,gid=10001",
    );
    expect(deploy).toContain("--cap-drop ALL");
    expect(deploy).toContain("AAIS capacity gate failed");
    expect(deploy).toContain("flock -n 9");
    expect(deploy).not.toContain("GetAuthorizationToken");
    expect(deploy).not.toContain("docker login");
    expect(deploy).not.toContain("docker logout");
    expect(deploy).not.toContain("DOCKER_CONFIG");
    expect(deploy).toContain("org.opencontainers.image.revision");
    expect(deploy).toContain("image_revision");
    expect(deploy).toContain("candidate_source_receipt");
    expect(deploy).toContain("AAIS_IMAGE_SOURCE is required");
    expect(deploy).toContain("AAIS_IMAGE_SOURCE must be ghcr-preloaded");
    expect(deploy).toContain('AAIS_GHCR_REPOSITORY');
    expect(deploy).toContain('preloaded_source_receipt');
    expect(deploy).toContain("candidate-metadata");
    expect(deploy).toContain("validate-preloaded");
    expect(deploy).toContain("validate-live");
    expect(deploy).toContain("validate-traffic-ready");
    expect(deploy).toContain("validate-public-ready");
    expect(deploy).toContain("write-deployment");
    expect(deploy).toContain("validate-deployment");
    expect(deploy).toContain('image_repo_digest_matches');
    expect(deploy).toContain('local image RepoDigest or OCI revision');
    expect(deploy).not.toMatch(/\bjq\b/);
    expect(deploy).not.toMatch(/\*['"]status|status['"]\*/);
    expect(deploy).not.toMatch(/\*.*releaseId|releaseId.*\*/);
    expect(deploy).toContain(
      'readonly AAIS_JSON_HELPER_PATH="/opt/aais/libexec/aais-json-v1.py"',
    );
    expect(deploy).toMatch(
      /readonly AAIS_JSON_HELPER_SHA256="[a-f0-9]{64}"/,
    );
    expect(deploy).toContain(
      "/usr/bin/python3 -I -S -B \"$AAIS_JSON_HELPER_PATH\"",
    );
    expect(deploy).not.toMatch(/\bACR\b|acrInstanceId|publicLoginServer|pushRepository/);
    expect(deploy).toContain("AAIS_EXPECTED_MACHINE_ID_SHA256");
    expect(deploy).toContain("AAIS_EXPECTED_NGINX_VHOST_SHA256");
    expect(deploy).toContain("active-deployment.env");
    expect(deploy).toContain("AAIS_ACTIVE_SECRET_BUNDLE_VERSION");
    expect(deploy).toContain("AAIS_ROTATION_PENDING_FILE");
    expect(readFileSync("deploy/aliyun/aais-json-v1.py", "utf8"))
      .toContain('"secretBundleVersion"');
    expect(deploy).toContain("commit_recovered_active_state");
    expect(deploy).toContain("finalized a verified interrupted Nginx promotion");
    expect(deploy).toContain("nginx_loaded_release_matches");
    expect(deploy).toContain("www.aais.site:8443:127.0.0.1");
    expect(deploy).not.toContain("sslrootcert");
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
    expect(nginx).toContain("/opt/aais/state/secret-rotation.invalid");
    expect(nginx).not.toContain("secret-rotation.canonical-check");
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
    expect(worker).toContain("curl --disable --config - --noproxy '*'");
    expect(worker).not.toContain("--header \"Authorization:");
    expect(worker).toContain("--connect-timeout 5");
    expect(worker).toContain("--max-time 90");
    expect(worker).toContain("--max-filesize 65536");
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
    expect(vercel.regions).toBeUndefined();
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

  it("uses separate least-privilege runtime roles for the shared Neon database", () => {
    const roles = readFileSync("deploy/aliyun/neon-runtime-roles.sql", "utf8");
    const openMigrator = readFileSync(
      "deploy/aliyun/neon-open-migrator.sql",
      "utf8",
    );
    const closeMigrator = readFileSync(
      "deploy/aliyun/neon-close-migrator.sql",
      "utf8",
    );
    const lockdown = readFileSync(
      "deploy/aliyun/neon-lockdown-public.sql",
      "utf8",
    );

    expect(roles).toContain("aais_app_aliyun");
    expect(roles).toContain("aais_app_vercel");
    expect(roles).toContain("aais_migrator");
    expect(roles).toContain("connection limit 10");
    expect(roles).toContain("connection limit 20");
    expect(roles).toContain("connection limit 5");
    expect(roles.match(/nosuperuser nocreatedb nocreaterole noinherit/g))
      .toHaveLength(6);
    expect(roles.match(/noreplication nobypassrls/g)).toHaveLength(6);
    expect(roles).toContain("from pg_auth_members membership");
    expect(roles).toContain("AAIS runtime roles must not belong to another role");
    expect(roles).toContain(
      'grant connect on database :"DBNAME" to aais_app_aliyun, aais_app_vercel',
    );
    expect(roles).toContain(
      "revoke all privileges on schema public\n  from aais_app_aliyun, aais_app_vercel, aais_migrator",
    );
    expect(roles).toContain(
      "to aais_app_aliyun, aais_app_vercel",
    );
    expect(roles).not.toContain("grant select, insert, update, delete on all tables");
    expect(roles).not.toContain("aais_research_");
    expect(roles).not.toMatch(/alter role[^;]*password/i);
    expect(roles).not.toContain('revoke connect, temporary on database :"DBNAME" from public');

    expect(openMigrator).toContain("create role aais_migrator nologin");
    expect(openMigrator).toContain("alter role aais_migrator login");
    expect(openMigrator).toContain("noreplication nobypassrls");
    expect(openMigrator).toContain("from pg_auth_members membership");
    expect(openMigrator).toContain("grant usage, create on schema public");
    expect(openMigrator).toContain("grant all privileges on all tables");
    expect(openMigrator).not.toMatch(/alter role[^;]*password/i);

    expect(closeMigrator).toContain("alter role aais_migrator nologin");
    expect(closeMigrator).toContain("alter role aais_migrator password null");
    expect(closeMigrator).toContain("noreplication nobypassrls");
    expect(closeMigrator).toContain(
      'revoke connect, temporary on database :"DBNAME" from aais_migrator',
    );
    expect(closeMigrator).toContain(
      "revoke all privileges on schema public from aais_migrator",
    );
    expect(closeMigrator).toContain("pg_terminate_backend");
    expect(closeMigrator).toContain("migrator_active_sessions");
    expect(closeMigrator.indexOf("pg_terminate_backend")).toBeLessThan(
      closeMigrator.indexOf('revoke connect, temporary on database :"DBNAME"'),
    );
    expect(lockdown).toContain(
      'revoke connect, temporary on database :"DBNAME" from public',
    );
    expect(lockdown).toContain("revoke create on schema public from public");
    expect(lockdown).toContain("revoke execute on all functions in schema public from public");
    expect(lockdown).toContain("public_database_access_revoked");
    expect(lockdown).toContain("public_schema_create_revoked");
    expect(lockdown).toContain("public_function_execute_revoked");
  });

  it("ships the self-managed empty-database role and socket contract", () => {
    const roles = readFileSync("deploy/aliyun/postgres-runtime-roles.sql", "utf8");
    const openMigrator = readFileSync(
      "deploy/aliyun/postgres-open-migrator.sql",
      "utf8",
    );
    const closeMigrator = readFileSync(
      "deploy/aliyun/postgres-close-migrator.sql",
      "utf8",
    );
    const runtime = readFileSync("deploy/aliyun/aais-runtime.env.example", "utf8");
    const deploy = readFileSync("deploy/aliyun/aais-deploy.sh", "utf8");
    const tmpfiles = readFileSync(
      "deploy/aliyun/aais-postgresql-socket.tmpfiles",
      "utf8",
    );
    const preflight = readFileSync(
      "deploy/aliyun/postgres-empty-preflight.sql",
      "utf8",
    );
    const preflightWrapper = readFileSync(
      "deploy/aliyun/aais-postgres-preflight.sh",
      "utf8",
    );

    expect(roles).toContain("aais_app_aliyun");
    expect(roles).toContain("aais_migrator");
    expect(roles).not.toContain("aais_app_vercel");
    expect(roles).toContain("connection limit 10");
    expect(roles).toContain("connection limit 5");
    expect(roles).toContain("from pg_auth_members membership");
    expect(roles).toContain("AAIS runtime roles must not belong to another role");
    expect(roles).toContain("public.aais_runtime_identity");
    expect(roles).not.toMatch(/alter role[^;]*password/i);
    expect(openMigrator).toContain("grant usage, create on schema public");
    expect(openMigrator).toContain('grant connect, create, temporary on database :"DBNAME" to aais_migrator');
    expect(closeMigrator).toContain('revoke connect, create, temporary on database :"DBNAME" from aais_migrator');
    expect(closeMigrator).toContain("alter role aais_migrator nologin");
    expect(closeMigrator).toContain("migrator_active_sessions");
    expect(runtime).toContain("AAIS_DATABASE_PROVIDER=aliyun-postgres");
    expect(runtime).toContain("AAIS_DATABASE_TRANSPORT=unix");
    expect(runtime).toContain("%2Frun%2Faais%2Fpostgresql");
    expect(deploy).toContain("/run/aais/postgresql:/run/aais/postgresql:ro");
    expect(deploy).toContain("self-managed PostgreSQL socket directory is invalid");
    expect(tmpfiles).toContain("/run/aais/postgresql 0770 postgres aais-runtime");
    expect(tmpfiles).toContain("numeric GID 10001");
    expect(tmpfiles).toContain("a+ /run/aais - - - - u:postgres:--x");
    expect(readFileSync("deploy/aliyun/aais-secrets-bootstrap.service", "utf8"))
      .toContain("After=local-fs.target systemd-tmpfiles-setup.service");
    expect(preflight).toContain("current_setting('server_version_num')::integer >= 170000");
    expect(preflight).toContain("current_setting('listen_addresses') = ''");
    expect(preflight).toContain("aais_runtime_identity");
    expect(preflight).toContain("aais_app_aliyun");
    expect(preflight).toContain("application_tables_empty");
    expect(preflight).toContain("raise exception 'AAIS empty database baseline failed");
    expect(preflightWrapper).toContain("runuser -u postgres");
    expect(preflightWrapper).toContain("PGHOST=\"$socket_dir\"");
    expect(preflightWrapper).toContain("psql --no-password");
    expect(preflightWrapper).not.toMatch(/PGPASSWORD|password=|AccessKey|SecretData/);
  });

  it("ships no RDS, ACR, or KMS fallback operation assets", () => {
    for (const directory of [".github/workflows", "deploy/aliyun", "tests"]) {
      expect(
        readdirSync(directory).filter((file) => /(?:^|[-_.])(rds|acr|kms)(?:[-_.]|$)/i.test(file)),
        directory,
      ).toEqual([]);
    }
    const topologyContract = [
      "README.md",
      "OPERATIONS.md",
      "ARCHITECTURE.md",
      "docs/aliyun-primary-runbook.md",
    ].map((file) => readFileSync(file, "utf8")).join("\n");
    expect(topologyContract).not.toMatch(
      /(?:rds|acr|kms).{0,80}(?:fallback|manual-only|price-gated|operation asset)/i,
    );
    expect(topologyContract).not.toMatch(
      /(?:aliyun-container|aais-acr|rds-(?:preflight|runtime|open|close)|kms\.conf)/i,
    );
    expect(topologyContract).toContain("Private GHCR is the sole registry path");
    expect(topologyContract).toContain(
      "existing Neon PostgreSQL 17 database remains the single",
    );
  });

  it("retains the worker lease fencing and database target identity gates", () => {
    const leaseMigration = readFileSync(
      "migrations/postgres/0028_runtime_worker_leases.sql",
      "utf8",
    );
    const identityMigration = readFileSync(
      "migrations/postgres/0029_runtime_database_identity.sql",
      "utf8",
    );
    const targetBinding = readFileSync(
      "deploy/aliyun/database-target-identity.sql",
      "utf8",
    );
    const learningStore = readFileSync(
      "src/lib/server/aais-learning-store.ts",
      "utf8",
    );

    expect(leaseMigration).toContain("public.aais_runtime_leases");
    expect(leaseMigration).toContain("generation bigint not null default 1");
    expect(leaseMigration).toContain("expires_at timestamptz not null");
    expect(identityMigration).toContain("public.aais_runtime_identity");
    expect(identityMigration).not.toMatch(/insert\s+into/i);
    expect(targetBinding).toContain(":'TARGET_ID'");
    expect(targetBinding).toContain("on conflict (singleton) do update");
    expect(learningStore).toContain("where version = '0029'");
    expect(learningStore).toContain(
      "has_table_privilege(current_user, 'public.aais_runtime_leases', 'INSERT')",
    );
  });

  it("ships executable root wrappers and a file-backed maintenance freeze", () => {
    for (const file of [
      "deploy/aliyun/aais-deploy.sh",
      "deploy/aliyun/aais-worker.sh",
      "deploy/aliyun/aais-maintenance.sh",
      "deploy/aliyun/aais-secrets-bootstrap.sh",
      "deploy/aliyun/aais-rotate-secrets.sh",
      "deploy/aliyun/aais-preload-ghcr-image.sh",
    ]) {
      expect(statSync(file).mode & 0o111, file).not.toBe(0);
    }
    expect(statSync("deploy/aliyun/aais-json-v1.py").mode & 0o111).not.toBe(0);
    for (const secretScript of [
      "deploy/aliyun/aais-worker.sh",
      "deploy/aliyun/aais-secrets-bootstrap.sh",
      "deploy/aliyun/aais-rotate-secrets.sh",
    ]) {
      expect(readFileSync(secretScript, "utf8").split("\n").slice(0, 3))
        .toEqual(["#!/usr/bin/env bash", "set -Eeuo pipefail", "set +x"]);
    }
    const jsonHelper = readFileSync("deploy/aliyun/aais-json-v1.py", "utf8");
    expect(jsonHelper).toContain("MAX_JSON_BYTES = 64 * 1024");
    expect(jsonHelper).toContain("object_pairs_hook=unique_object");
    expect(jsonHelper).toContain("parse_constant=reject_constant");
    expect(jsonHelper).toContain("os.O_NOFOLLOW");
    expect(jsonHelper).toContain("allow_nan=False");
    expect(jsonHelper).toContain("DEPLOYMENT_KEYS");
    expect(jsonHelper).toContain('argv[1] == "write-deployment"');
    expect(jsonHelper).toContain('argv[1] == "validate-deployment"');
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
    expect(bootstrap).not.toMatch(/\bKMS\b|AAIS_KMS_|kms GetSecretValue|runtimeEnvBase64/);
    expect(bootstrap).not.toContain("workerEnvBase64");
    expect(bootstrap).toContain("runtime and worker secret bundles do not match");
    expect(bootstrap).toContain("/run/aais/current");
    expect(bootstrap).toContain("generation_published");
    expect(bootstrap).toContain("AAIS_OPERATION_LOCK_FD");
    expect(bootstrap).toContain("AAIS_PRODUCT_PSEUDONYM_SECRET");
    expect(bootstrap).toContain('values["AAIS_DATABASE_DRIVER"] != "pg"');
    expect(bootstrap).toContain('database_provider != "neon" && database_provider != "aliyun-postgres"');
    expect(bootstrap).toContain('database_transport != "unix"');
    expect(bootstrap).toContain("host=%2Frun%2Faais%2Fpostgresql");
    expect(bootstrap).toContain('values["AAIS_DATABASE_POOL_MAX"] != "5"');
    expect(bootstrap).toContain('values["AAIS_RESEARCH_REQUIRED"] != "false"');
    expect(bootstrap).toContain("database_sslrootcert_count != 0");
    expect(bootstrap).toContain('values["NODE_TLS_REJECT_UNAUTHORIZED"] == "0"');
    expect(bootstrap).toContain("aais_app_aliyun");
    expect(bootstrap).toContain("AAIS_SECRET_BUNDLE_VERSION");
    expect(bootstrap).toContain("bootstrap configuration must be root-owned with mode 0600");
    expect(bootstrap).not.toMatch(/AccessKey|SecretData|AAIS_ALIYUN_CLI/);
    const bootstrapConfig = readFileSync(
      "deploy/aliyun/aais-secrets-bootstrap.env.example",
      "utf8",
    );
    expect(bootstrapConfig).toContain("AAIS_SECRET_SOURCE=file");
    expect(bootstrapConfig).not.toMatch(/\bKMS\b|AAIS_KMS_|AAIS_ALIYUN_CLI/);
    const unit = readFileSync("deploy/aliyun/aais-secrets-bootstrap.service", "utf8");
    expect(unit).toContain("Before=aais-email-outbox.service aais-lrs-outbox.service");
    expect(unit).not.toContain("Before=docker.service");
    expect(unit).toContain("After=local-fs.target");
    expect(unit).not.toContain("network-online.target");
    expect(unit).toContain("ReadWritePaths=/run/aais");
    const rotate = readFileSync("deploy/aliyun/aais-rotate-secrets.sh", "utf8");
    expect(rotate).not.toMatch(/\bKMS\b|AAIS_KMS_/);
    expect(rotate).toContain("systemctl stop");
    expect(rotate).not.toMatch(/\bjq\b/);
    expect(rotate).toContain("validate-traffic-ready");
    expect(rotate.indexOf("aais_require_json_helper"))
      .toBeLessThan(rotate.indexOf("systemctl stop"));
    expect(rotate).toContain(
      'readonly AAIS_JSON_HELPER_PATH="/opt/aais/libexec/aais-json-v1.py"',
    );
    expect(rotate).toContain(
      "/usr/bin/python3 -I -S -B \"$AAIS_JSON_HELPER_PATH\"",
    );
    expect(rotate).toContain('"$bootstrap_wrapper"');
    expect(rotate).toContain("flock -n 9");
    expect(rotate).toContain("AAIS_OPERATION_LOCK_FD=9");
    expect(rotate).toContain('"$deploy_wrapper" "$image_ref" "$release_sha"');
    expect(rotate).toContain("worker timers remain stopped");
    expect(rotate).toContain("secret-rotation.pending");
    expect(rotate).toContain("secret-rotation.canonical-check");
    expect(rotate).toContain("AAIS_EMAIL_TIMER_WAS_ACTIVE");
    expect(rotate).toContain("AAIS_LRS_TIMER_WAS_ACTIVE");
    expect(rotate).toContain("canonical-passed");
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
    expect(rotate).not.toContain('rm -f -- "$rotation_pending_file"');
    expect(rotate.indexOf(
      'mv -Tf -- "$rotation_pending_file" "$rotation_canonical_check_file"',
    )).toBeLessThan(
      rotate.indexOf("https://www.aais.site/api/system/traffic-readiness"),
    );
    expect(rotate.lastIndexOf("write_canonical_phase canonical-passed"))
      .toBeLessThan(rotate.lastIndexOf('systemctl start "$email_timer"'));
    expect(rotate.lastIndexOf('rm -f -- "$local_runtime_previous"'))
      .toBeLessThan(rotate.lastIndexOf('rm -f -- "$rotation_canonical_check_file"'));
    expect(rotate.indexOf("https://www.aais.site/api/system/traffic-readiness"))
      .toBeLessThan(rotate.indexOf('rm -f -- "$local_runtime_previous"'));
    for (const service of [
      "deploy/aliyun/aais-email-outbox.service",
      "deploy/aliyun/aais-lrs-outbox.service",
    ]) {
      expect(readFileSync(service, "utf8")).toContain(
        "ConditionPathExists=!/opt/aais/state/secret-rotation.pending",
      );
      expect(readFileSync(service, "utf8")).toContain(
        "ConditionPathExists=!/opt/aais/state/secret-rotation.canonical-check",
      );
      expect(readFileSync(service, "utf8")).toContain(
        "ConditionPathExists=!/opt/aais/state/secret-rotation.invalid",
      );
    }
    for (const timer of [
      "deploy/aliyun/aais-email-outbox.timer",
      "deploy/aliyun/aais-lrs-outbox.timer",
    ]) {
      expect(readFileSync(timer, "utf8")).not.toContain("ConditionPathExists=");
    }
    const worker = readFileSync("deploy/aliyun/aais-worker.sh", "utf8");
    expect(worker).toContain("active-deployment.env");
    expect(worker).toContain("secret-rotation.canonical-check");
    expect(worker).toContain("secret-rotation.invalid");
    expect(worker).toContain("worker secret bundle does not match the active deployment");
  });

  it("publishes a private exact-SHA GHCR candidate with least privilege", () => {
    const workflow = readFileSync(".github/workflows/ghcr-container.yml", "utf8");
    const triggerBlock = workflow.slice(
      workflow.indexOf("on:"),
      workflow.indexOf("permissions:"),
    );
    const productGateJob = workflow.slice(
      workflow.indexOf("  product-gates:"),
      workflow.indexOf("  publish-private-image:"),
    );
    const publishJob = workflow.slice(workflow.indexOf("  publish-private-image:"));

    expect(triggerBlock).not.toContain("push:");
    expect(triggerBlock).toContain("workflow_dispatch:");
    expect(triggerBlock).toContain("expected_sha:");
    for (const job of [productGateJob, publishJob]) {
      expect(job).toContain("github.ref == 'refs/heads/codex/aais-aliyun-postgres-empty'");
      expect(job).toContain("node scripts/verify-aais-ghcr-source.mjs");
      expect(job).toContain("persist-credentials: false");
    }
    expect(workflow).toContain("permissions: {}");
    expect(productGateJob).toContain("contents: read");
    expect(productGateJob).not.toContain("packages: write");
    expect(productGateJob).not.toContain("id-token: write");
    expect(productGateJob).not.toContain("environment:");
    expect(productGateJob).not.toContain("ghcr.io");
    expect(publishJob).toContain("contents: read");
    expect(publishJob).toContain("packages: write");
    expect(publishJob).toContain("attestations: write");
    expect(publishJob).toContain("id-token: write");
    expect(publishJob).toContain("environment: aliyun-production");
    expect(publishJob).toContain("ghcr.io/hudongpin/aais");
    expect(publishJob).toContain("password: ${{ github.token }}");
    expect(publishJob).toContain("packageVisibility: \"private\"");
    expect(publishJob).toContain('.visibility == "private"');
    expect(publishJob).toContain("provenance: mode=max");
    expect(publishJob).toContain("sbom: true");
    expect(publishJob).toContain("push-to-registry: true");
    expect(publishJob).toContain("ghcr-candidate-receipt.json");
    expect(publishJob).toContain("AAIS_REQUIRE_STABLE_SERVER_ACTIONS_KEY=true");
    expect(publishJob).toContain(
      "NEXT_SERVER_ACTIONS_ENCRYPTION_KEY=${{ secrets.AAIS_NEXT_SERVER_ACTIONS_ENCRYPTION_KEY }}",
    );
    expect(publishJob).toContain("Remove workflow registry credentials");
    expect(publishJob).not.toContain("configure-aliyun-credentials");
    expect(publishJob).not.toMatch(/ACCESS_KEY_ID|ACCESS_KEY_SECRET/);
    expect(workflow).not.toContain("@v3");
    expect(workflow).not.toContain("@v4");
    expect(workflow).not.toContain("@v6");
  });

});
