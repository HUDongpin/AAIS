# AAIS Aliyun Primary / Vercel Cold-Standby Runbook

This runbook implements the provider-neutral application and release controls
for an Aliyun Hong Kong primary on the existing shared ECS. It does not itself
authorize a billable purchase, read an Owner credential, migrate production
data, or change production DNS.

## Frozen topology

- Canonical origin: `https://www.aais.site`.
- Aliyun compute: the existing Alibaba Cloud Linux 3 ECS, using only
  `127.0.0.1:3101` and `127.0.0.1:3102` for AAIS. It is the only application
  server in this rollout: no build-runner ECS, replacement ECS, or second
  application instance is purchased.
- Database: one Hong Kong RDS PostgreSQL High-availability Edition instance.
- Vercel: same Git SHA application build, with no direct production RDS access
  and no product cron schedule in the final deployed topology. The portability
  commit deliberately retains the two existing schedules until the Aliyun
  candidate and disabled replacement timers are evidenced.
- Product workers: only Aliyun systemd timers wake in the deployed topology.
  The RDS `aais_runtime_leases` fencing generation remains mandatory so a
  future explicitly promoted worker cannot overlap a stale invocation.
- Formal research plane: disabled and fail-closed.
- Existing ECS services and virtual hosts are out of scope and must not be
  restarted, reconfigured, or used as AAIS dependencies.

## Current live boundary

The repository contains the deployable Aliyun runtime, but `aais.site` remains
Vercel production until all provider, database, migration, domain, and Owner
acceptance gates are separately evidenced. A local build, an ACR digest, or an
Aliyun candidate does not prove production cutover.

## Repository assets

- `Dockerfile` and `.dockerignore`: Node 24 standalone image and secret-safe
  build context.
- `.github/workflows/aliyun-container.yml`: exact-SHA CI, OIDC/STS, temporary
  `/32` ACR public push path, temporary ACR login, immutable image digest,
  SBOM/provenance, and candidate receipt.
- `deploy/aliyun/aais-acr-ci-endpoint.sh`: fail-closed opening and cleanup of
  the one-run ACR public endpoint used by the GitHub-hosted builder.
- `.github/workflows/aliyun-acr-postrun-watchdog.yml`: an independent
  completed-run cleanup that is still triggered when the build runner exits or
  the candidate workflow is cancelled.
- `deploy/aliyun/github-build-role-policy.json.example`: repository- and
  instance-scoped permissions for that OIDC build role.
- `deploy/aliyun/github-watchdog-role-policy.json.example`: instance-scoped
  endpoint read/update/delete permissions for the independent cleanup workflow.
- `deploy/aliyun/aais-deploy.sh`: capacity-gated blue/green promotion using only
  the configured ACR repository and a `sha256:` digest.
- `deploy/aliyun/nginx-aais.conf.template`: isolated AAIS vhost with streaming
  controls and trusted proxy-header overwrite.
- `deploy/aliyun/aais-worker.sh` plus systemd units: one-minute local worker
  wakeups with tokens supplied through a root-only runtime file.
- `deploy/aliyun/aais-maintenance.sh`: root-owned file-backed maintenance/write
  freeze consumed by only the AAIS Nginx vhost.
- `deploy/aliyun/rds-preflight.sql`: non-secret source/target compatibility
  inventory.
- `deploy/aliyun/database-target-identity.sql`: binds the non-secret database
  identity required by traffic readiness.
- `deploy/aliyun/rds-runtime-roles.sql`: fixed connection budgets and minimum
  runtime grants. It deliberately contains no passwords.
- `deploy/aliyun/rds-open-migrator.sql` and `rds-close-migrator.sql`: open the
  schema owner only inside the migration window, then set `NOLOGIN`, revoke
  connect/create, terminate its backends, and prove zero sessions.

## Hard stop gates

Stop before any billable provider action, production RDS creation, or migration
when any of these is true:

- `AAIS_DATABASE_URL` and a fallback production URL differ.
- The source PostgreSQL major version, encoding, collation, extensions, or
  migration ledger is unknown.
- Aliyun and Vercel cannot be assigned distinct temporary roles on the current
  source database, or the Vercel role cannot be revoked independently before
  the final dump.
- Hong Kong RDS cannot provide the same compatible major version.
- RDS would require a public endpoint or any Vercel dynamic-IP allowlist.
- The ECS has less than 3 GiB available memory or 50 GiB available disk before
  candidate deployment.
- Any existing ECS website baseline is already failing.
- The Docker image is not addressed as the configured ACR repository plus an
  immutable digest.
- A production secret would enter Git, Docker build args, workflow logs,
  command arguments, chat, or a release receipt.
- The current estimate and metered items for the existing ECS snapshot
  (storage and retention), ACR Enterprise (instance, storage, and transfer), RDS
  (instance, storage, PITR, log/WAL, backup, cross-region backup, transfer, and
  temporary restore instance), and GitHub Actions (minutes, cache, artifact
  storage, and overages) have not been displayed to and approved by the Owner.
  No second ECS is part of this rollout. A paid KMS instance is also excluded by
  default and requires separate price approval.
- The ACR Enterprise instance is shared with another workload, its public
  endpoint cannot be enabled/disabled through the restricted build role, the
  runner cannot be limited to one verified public IPv4 `/32`, or cleanup cannot
  prove the endpoint disabled and its temporary ACL removed.
- The independent post-run watchdog workflow is not active on default-branch
  `main`, its `aliyun-watchdog` environment has a required reviewer or wait
  timer, its OIDC trust/role is unavailable, or its completed-run cleanup has
  not been tested against the same dedicated ACR instance.
- The ECS system disk and snapshots that can contain Docker runtime metadata or
  `/etc/aais/secrets` do not have verified at-rest encryption.
- `/run/aais` cannot be reconstructed from the audited root-only local secret
  source after an ECS reboot, or the bootstrap/rotation drill has not passed.

## Phase A: source and existing-host baseline

1. Record the exact source Git SHA and verify a clean reviewed worktree.
2. Capture redacted ECS capacity, running containers/services, current Nginx
   vhosts, and Docker health.
3. Record status, TLS, response time, and 5xx baselines for the existing 3dENA,
   CAIS, and EduExpressAI domains.
4. After the console displays the snapshot storage estimate and retention rule
   and the Owner explicitly approves them, create and verify one ECS system-disk
   snapshot before installing AAIS assets. This pre-secret snapshot may follow
   the approved retention policy. Every
   later snapshot that contains Docker runtime metadata or
   `/etc/aais/secrets/runtime.env` is a secret-bearing backup: restrict access
   and sharing, keep the shortest justified retention, and never copy it to an
   uncontrolled account or region.
5. Inventory the exact current source database roles. Create a distinct,
   least-privilege temporary `aais_source_aliyun` role for the Aliyun candidate;
   never reuse the Vercel integration role. Prove that the Vercel role can be
   revoked independently before the final dump.
6. Run `rds-preflight.sql` against the current authoritative PostgreSQL through
   an Owner-controlled hidden credential prompt. Store only the redacted
   version/extension/ledger report.
7. Inventory every current DNS record before any nameserver change.

## Phase B: provider bootstrap without production traffic

1. After explicit price approval, create one ACR **Enterprise** instance and
   repository in `cn-hongkong`; Personal Edition is not an interchangeable
   fallback because it has no production SLA or required OpenAPI path. Record
   the instance ID plus its API, VPC login, and any public login endpoints.
   Keep public access disabled.
2. Create a GitHub OIDC provider and restrict the role trust to the AAIS
   repository, `main`, and the `aliyun-production` GitHub environment.
3. Configure only non-secret GitHub environment variables:
   `ALIYUN_OIDC_PROVIDER_ARN`, `ALIYUN_BUILD_ROLE_ARN`,
   `ALIYUN_ACR_INSTANCE_ID`, `ALIYUN_ACR_API_ENDPOINT`,
   `ALIYUN_ACR_PUBLIC_LOGIN_SERVER`, `ALIYUN_ACR_PUBLIC_PUSH_REPOSITORY`,
   `ALIYUN_ACR_VPC_LOGIN_SERVER`, and
   `ALIYUN_ACR_VPC_DEPLOYMENT_REPOSITORY`. The public and VPC repository paths
   after their login servers must be identical. The `aliyun-watchdog` GitHub
   environment holds only `ALIYUN_OIDC_PROVIDER_ARN` and
   `ALIYUN_WATCHDOG_ROLE_ARN`; it has no build secret, ACR binding variable, or
   repository push permission. Before any ACR mutation, the candidate uploads
   an exact run-ID/attempt/SHA handoff containing the non-secret ACR instance,
   API endpoint, and public login server. The completed-run workflow downloads
   and validates that exact artifact, so a second environment cannot silently
   point cleanup at a different registry. Both receipts record the three ACR
   bindings, and the ECS deploy wrapper compares them with each other and with
   root-owned `deploy.env`.
   Configure `AAIS_NEXT_SERVER_ACTIONS_ENCRYPTION_KEY` separately as a protected
   GitHub environment secret and the matching Vercel value as an Owner-only
   build secret. It is passed to Docker through a BuildKit secret mount, never
   a build argument. Both builds use the full Git SHA as the AAIS release ID and
   provenance value; Vercel keeps its provider-owned `NEXT_DEPLOYMENT_ID`.
4. Use the pinned GitHub-hosted `ubuntu-24.04` runner; never build on the shared
   production ECS. Product gates run in a separate job whose permissions omit
   `id-token: write`; package lifecycle scripts and tests therefore cannot mint
   the Aliyun workload token. Only after that job passes does the publish job
   receive OIDC permission and exchange it for a one-hour STS session scoped to
   the one AAIS ACR repository and dedicated ACR instance. The publish job is
   capped at 45 minutes and the image step at 25 minutes, so endpoint cleanup
   retains a credential/time margin. The workflow verifies
   the runner's public IPv4 through two independent HTTPS observations and
   requires them to agree. It enables the public endpoint, waits for ACR's
   automatic deny-all `127.0.0.1/32` guard with ACL enforcement on, then adds
   only the runner `/32` and pushes by full-SHA tag.
   Before obtaining cloud credentials or opening ACR, it uploads the redacted
   watchdog handoff under an artifact name bound to the current GitHub run ID
   and attempt. Failure to preserve that handoff is a pre-mutation hard stop.
   It must not allow the complete GitHub Actions address ranges or any broad
   CIDR. An `if: always()` cleanup logs Docker out, proves the endpoint exactly
   disabled before deleting that `/32`, and queries ACR until closure without
   the runner ACL is proven. It never deletes the default guard while the
   endpoint is open.
   The candidate receipt is generated only after cleanup succeeds. The build
   role may not operate ECS, RDS, RAM, DNS, OSS, or another repository. Do not
   merge or run the lease-aware production workflow before Phase C's database
   gate. Instantiate `github-build-role-policy.json.example` only with the
   approved region, account, dedicated instance, and AAIS namespace values;
   never attach a broad Container Registry administrator policy.
5. Attach a least-privilege ECS RAM role only for ACR temporary authorization,
   the one-repository VPC pull, and logging. Do not grant the shared ECS endpoint
   update, ACL create/delete, or repository push permissions. Install the pinned
   Alibaba Cloud CLI and
   configure its `aais-ecs-role` profile to use `EcsRamRole`; the deploy wrapper
   obtains a short-lived ACR token, logs Docker in only for the pull, then logs
   out. Every operation uses a root-only `DOCKER_CONFIG` below `/run/aais`, so
   it cannot overwrite or remove another service's root Docker credentials.
   Test a deployment after token expiry and after ECS reboot. Do not create a
   human AccessKey or permanent registry password.
6. Create a separate OIDC watchdog role from
   `github-watchdog-role-policy.json.example`, with no token, pull, push, create
   ACL, ECS, RDS, RAM, or DNS permission. Activate
   `aliyun-acr-postrun-watchdog.yml` on default-branch `main`. Configure the
   `aliyun-watchdog` environment with no required reviewers and no wait timer;
   restrict its deployment branch to `main`. Cleanup must start automatically,
   so an interactive environment approval is forbidden. The candidate workflow
   queries the GitHub Actions API and refuses to open ACR unless this independent
   workflow is active. The post-run job checks out the exact triggering `main`
   SHA, downloads only the exact pre-open handoff artifact from that run, and
   validates its SHA, run ID, attempt, instance, API endpoint, and public server
   before exchanging OIDC.
   Scope the watchdog role resource itself to that one dedicated ACR instance.
   Test successful, failed, cancelled, and runner-loss candidate runs, and
   record the completed-event-to-cleanup-start delay. The completed-run event
   must disable ACR before deleting only the exact `run_id/run_attempt` ACL, and
   a disable failure must leave the ACL intact. This adds one short
   GitHub-hosted cleanup job per image build, not another ECS; its Actions usage
   remains inside the cost gate.
   ACR exposes enable and disable through the same Update action, so RAM cannot
   make that action literally close-only. Compensate by restricting OIDC trust
   to this exact repository, workflow, `main`, and `aliyun-watchdog` environment,
   protecting changes to the workflow file through branch/CODEOWNERS review
   without adding a runtime approval or wait, and alerting in ActionTrail on any
   watchdog-role call with `Enable=true`.
7. Install repository scripts under `/opt/aais/bin` as root-owned mode `0755`,
   create the dedicated `aais-worker` system user/group, and install root-owned
   config under `/etc/aais` with mode `0600`. The no-KMS default has exactly one
   persistent secret source: regular, non-symlink, single-link
   `/etc/aais/secrets/runtime.env`, root-owned mode `0400` inside a root-owned
   `0700` directory. It contains a unique, non-sensitive
   `AAIS_SECRET_BUNDLE_VERSION`; the bootstrap derives worker.env from the same
   in-memory snapshot rather than persisting a second source. The Owner creates
   the initial file only through an independent hidden-input process; Codex
   never reads its values. It contains only `KEY=VALUE` records, with no blank
   lines or comments; `aais-runtime.env.example` is a reference, not a file to
   copy directly. An audited boot unit reconstructs
   `/run/aais/current/runtime.env` (`0400`) and
   `/run/aais/current/worker.env` (`root:aais-worker`, `0440`) in one immutable
   generation, then atomically replace the `current` symlink before either AAIS
   timer. It must not gate the
   shared Docker daemon or delay unrelated containers. Existing AAIS containers
   may restart with their already-bound environment, while the bootstrap makes
   the next exact-digest deployment and workers recoverable. Logs may contain
   only a secret version/fingerprint, never a value.
   Optional KMS retrieval remains implemented but disabled. It may be selected
   only after the Owner separately approves its current base, key, secret, and
   QPS charges; its JSON data uses non-secret `bundleVersion` plus base64 field
   `runtimeEnvBase64`. Install the provided KMS systemd network drop-in only in
   that explicitly approved mode. Never place either source's secret
   values in a command argument, receipt, screenshot, or chat. Enable
   `aais-secrets-bootstrap.service`, then
   prove one real reboot and one bundle rotation before production traffic.
   For local-source rotation, the Owner writes the complete new source as
   `/etc/aais/secrets/runtime.env.candidate`, root-owned mode `0400`, with a new
   bundle version, and never truncates or edits the active source in place.
   Invoke `aais-rotate-secrets.sh /etc/aais/secrets/runtime.env.candidate`; it
   stops/drains both timers, writes the durable
   `/opt/aais/state/secret-rotation.pending` marker, preserves a protected
   previous source, atomically replaces the source on the same filesystem,
   refreshes the bundle, recreates the inactive color from the active exact
   digest, atomically records color/port/release/image/bundle in
   `/opt/aais/state/active-deployment.env`, promotes it, verifies
   the canonical TLS path, removes the marker, and only then restarts timers.
   The marker records `prepared`, `previous-saved`, `source-promoted`,
   `runtime-published`, or `container-promoted`, so a power loss can resume from
   a proven phase. If rotation fails, the marker survives reboot, Nginx remains
   in maintenance, and both workers fail closed. After correcting a transient
   cause, use `aais-rotate-secrets.sh --resume`; use `--rollback` to restore the
   protected previous source, or `--replace-pending` plus the exact candidate
   path to replace a rejected pending source. Bootstrap, rotation, and deploy
   use the same operation lock; the runtime file, derived worker file, and
   bootstrap receipt switch as one generation. Before deleting the previous
   source or restarting workers, rotation verifies the exact release first
   through the loopback Nginx diagnostic and then through the canonical path
   after removing the pending marker; any failure atomically restores a
   `failed` marker.
   Restarting only the bootstrap service is forbidden because it would give the
   worker wrapper tokens that the old container does not authorize.
7. Record `/etc/machine-id` and the main BaoTa Nginx configuration SHA-256 in
   `/etc/aais/deploy.env`. Pre-create the stable bootstrap upstream file as
   `server 127.0.0.1:3101;`, add only the AAIS vhost/include, and run the BaoTa
   Nginx config test before its shared/global reload. This reload is a shared
   control-plane operation, so pre/post smoke every existing vhost.
   The vhost also binds a diagnostic TLS server only on `127.0.0.1:8443`; it
   traverses the effective AAIS upstream without the public maintenance gate.
   Never expose that port in an ECS security rule. Deployment uses it to prove
   the loaded release before reconciling an interrupted promotion.
   The AAIS access format records `$uri` but no query string, Cookie,
   Authorization, Referer, User-Agent, or body; the vhost disables Nginx error
   logging because its fixed format can append the full request line. Prove the
   effective config does not inherit another AAIS access/error log before an
   OIDC callback is tested; use application/SLS monitoring for diagnostics.
8. Install and validate both Aliyun timer units, but leave them disabled. Do
   not set the Vercel scheduler-handoff variable yet and do not invoke the new
   Aliyun worker endpoints while the old lease-unaware Vercel deployment is
   active. The portability commit keeps both existing Vercel schedules, so it
   can reach `main` and produce the exact-SHA lease-aware Vercel and ACR builds
   without prematurely stopping production workers.

## Phase C: candidate verification

1. From the reviewed exact portability commit, but **before merging it to
   `main`**, use the existing migration runner in an approved additive schema
   window to apply and verify migrations
   `0028_runtime_worker_leases` and `0029_runtime_database_identity` on the
   current authoritative source database. Bind a distinct non-secret target ID
   with `database-target-identity.sql` and set the same value in
   `AAIS_DATABASE_TARGET_ID`.
   Do this before deploying either lease-aware runtime; do not start Aliyun
   workers yet. Only after those checks pass, set the non-secret Vercel
   Production evidence variable `AAIS_RUNTIME_LEASE_SCHEMA_CONFIRMED=true`.
   The production guard blocks the first lease-aware `main` build without it.
2. Merge the reviewed portability commit to `main`. Let Git-connected Vercel
   and the Aliyun container workflow build the same full SHA while the two
   existing Vercel schedules remain configured. Accept only a candidate receipt
   whose Git SHA and digest match ACR, whose `imageRepository` is the VPC
   repository, whose `publicEndpointClosed` value is `true`, and which records
   the active post-run watchdog workflow ID. Wait for that independent
   completed-run watchdog job to succeed, then confirm ACR public access is
   disabled and the run `/32` is absent. Deliver the candidate receipt as
   `/opt/aais/candidates/<full-sha>.json` and the independent cleanup receipt as
   `/opt/aais/candidates/<full-sha>.watchdog.json`, both root-owned mode `0644`;
   the deploy wrapper requires their Git SHA, run ID, run attempt, ACR instance,
   API endpoint, and public login server to match the pre-open handoff and its
   local configuration.
3. Deploy only by exact digest:

```bash
sudo /opt/aais/bin/aais-deploy.sh \
  ENTERPRISE_VPC_LOGIN_SERVER/NAMESPACE/aais@sha256:DIGEST \
  FULL_40_CHARACTER_GIT_SHA
```

The wrapper refuses non-matching repositories, tags, insufficient capacity,
image-revision/Git-SHA mismatches, host/Nginx fingerprint mismatches, unsafe
runtime-secret file permissions, failed liveness, failed traffic readiness, or
an invalid Nginx configuration. It obtains a temporary ACR token through the
ECS RAM role, serializes deployments with `flock`, drains worker services,
tests the real Nginx/TLS path, and writes a redacted receipt. It never builds
source on the ECS.

For an application rollback, read the previous verified receipt and rerun this
same wrapper with its `gitSha` and image digest. The wrapper recreates the
inactive color with the **current** `/run/aais/current/runtime.env` and therefore keeps
the current authoritative database and target identity. Never use
`docker start aais-blue|aais-green` as a rollback: a stopped container may
contain a pre-migration database binding. Multiple operations for the same SHA
receive distinct receipts, so an exact-SHA rollback is supported.

4. Verify `origin-hk.aais.site` before production DNS:

- `/api/system/live` returns the expected provider and release.
- `/api/system/traffic-readiness` returns database/schema ready.
- `/api/system/readiness` returns comprehensive application ready, including
  session, pseudonym, authentication delivery, AI, research fail-closed, and
  operator-secret invariants; provider outages remain warnings in traffic mode.
- AI SSE remains unbuffered for 250 seconds and client disconnect propagates.
- Login, save, reload, logout revocation, email, product LRS, and role isolation
  pass.
- A 10-user/60-minute soak stays within the 1.25 CPU/1.25 GiB container limits.
- The host keeps at least 2 GiB available memory and all existing sites remain
  within 10% of baseline p95 with no new 5xx.

If the host gate fails, roll back AAIS and keep Vercel as the live site. Do not
stop or resize unrelated workloads to force co-hosting, and do not purchase or
provision a second ECS without a new, explicit Owner decision.

5. After the lease-aware Vercel build and Aliyun candidate are both ready,
   confirm both Aliyun timers are still disabled and record the prepared
   handoff. Create a separately reviewed transition commit whose only runtime
   scheduling change is removal of the two entries from `vercel.json`. Set the
   Vercel Production variable
   `AAIS_ALIYUN_PRIMARY_SCHEDULERS_CONFIRMED=true` and let Git-connected `main`
   publish that cron-free Vercel deployment. The production deploy guard reads
   `vercel.json` itself as a two-state control: before handoff it requires both
   exact schedules, and after handoff it requires both to remain absent. A
   partial removal or later reintroduction is rejected.
6. Confirm the active Vercel Production deployment has no product cron
   schedules and that the previous schedules can no longer invoke workers.
   Only then enable both Aliyun timers and record their first successful runs.
   A short queueing gap is acceptable; overlap with the old lease-unaware
   Vercel deployment is forbidden.
7. Configure ACR retention and a host-side, label/digest-specific image cleanup
   that preserves the active image, the stopped previous container image, and
   one explicitly recorded recovery digest. Never use an unscoped
   `docker system prune` on the shared ECS.

## Phase D: RDS rehearsal and Aliyun compute cutover

1. Provision Hong Kong RDS HA, 2 vCPU/4 GiB, 50 GiB encrypted storage, in the
   ECS VPC. Use the same compatible PostgreSQL major version. Before purchase,
   require free space for source data plus indexes, restore/WAL/temp headroom,
   and growth; if 50 GiB does not meet that measured margin, increase it.
2. Give ECS the private endpoint. Keep the RDS public endpoint disabled. Vercel
   is not an approved database client in this no-Static-IP-add-on topology;
   normal Pro usage and overages remain governed by the existing Vercel plan.
   Enable RDS SSL, download the provider server CA through the Owner-controlled
   console, store it root-owned under `/etc/aais/tls/`, and pin its SHA-256 in
   `deploy.env`. Mount it read-only as `/etc/aais/rds-ca.pem`; the URL must use
   the certificate hostname plus exactly one `sslmode=verify-full` and one
   `sslrootcert=/etc/aais/rds-ca.pem`. Add only the ECS private address/security
   group to the RDS private whitelist and preserve evidence that the public
   endpoint is absent. A CA, hostname, whitelist, security-group, or checksum
   mismatch is a traffic-readiness hard stop.
3. Before any production write, enable and record RDS automatic data backups,
   log/WAL backups, 30-day PITR, deletion protection, storage/connection alerts,
   and the explicitly approved cross-region-backup policy/cost. Only after a
   separate Owner approval of its displayed hourly/storage estimate, restore an
   RDS backup to a temporary RDS instance and run application and
   migration-ledger verification; delete that instance immediately after the
   evidence is complete. A logical dump alone is not the DR rehearsal.
4. Restore a custom-format logical dump with `--no-owner --no-acl` into a
   rehearsal database.
5. Apply all migrations, including `0028` and `0029`, bind a rehearsal-only
   database target ID, apply the explicit runtime-role allowlist, then run the
   restore verifier, dry-run backfill, counts, constraints, and sampled hashes.
6. Time the complete dump, transfer, restore, migrations, permission audit,
   target-identity bind, verification, and rollback preparation. It must finish
   within 90 minutes, leaving at least 30 minutes of the two-hour window.
7. Copy every DNS RRset to AliDNS, including A/AAAA/CNAME/MX/TXT/CAA/SRV,
   wildcard and verification records. Freeze and verify registrar DNSSEC/DS
   state; an unmatched DS record is a hard stop. Lower controllable TTLs before
   the change.
   Move nameservers while `www` still serves Vercel and observe at least 24
   hours. This DNS-authority move must not also change application traffic.
8. Issue/verify auto-renewing TLS certificates whose SANs cover `aais.site`,
   `www.aais.site`, and `origin-hk.aais.site`, with 30/14/7-day alerts. Deploy
   the verified Aliyun candidate while both providers still use
   the current authoritative database. Point `origin-hk.aais.site` to it and
   complete direct functional and capacity acceptance.
9. Point `www.aais.site` to the Aliyun origin while the database remains
   unchanged. Keep the apex as a 308 to `www`, observe Aliyun compute for at
   least 24 hours, and retain DNS rollback to Vercel during this window. This
   is the compute cutover and is separate from database migration.

## Phase E: two-hour RDS migration with Aliyun already primary

1. Confirm `www.aais.site` is still healthy on Aliyun, that Aliyun uses the
   distinct temporary source role, and freeze DNS changes.
2. In the approved two-hour window, put the canonical Aliyun site in
   maintenance with `sudo /opt/aais/bin/aais-maintenance.sh enable`; prove the
   public route returns 503/no-store, stop both Aliyun timers, and wait until
   both oneshot services, database write transactions, provider dispatches,
   claims, and `uncertain` attempts are drained or explicitly reconciled.
3. At the source database, set the distinct Vercel role `NOLOGIN`, revoke its
   database `CONNECT` and all DML/sequence/function privileges, and terminate
   every backend owned by that role. Prove the role has zero active sessions,
   zero write privileges, and zero in-flight transactions before the final
   dump; then verify the active and recorded immutable Vercel deployment URLs
   cannot write. Password rotation may be an additional measure but never
   substitutes for database-level revocation and backend termination. Removing
   a Vercel project variable alone is also insufficient because older
   deployments may retain their runtime binding.
4. Revoke write authority for the temporary Aliyun source role, wait for all
   source writes and active write sessions to reach zero, then take the final
   consistent dump. Restore with `--no-owner --no-acl` under the
   `aais_migrator` role so restored objects have a migration-capable owner,
   bind the RDS-specific target ID, apply the explicit runtime-role allowlist,
   and complete every count/hash/constraint/permission verifier.
5. Bind only Aliyun to the private RDS endpoint, run direct and canonical
   read/write tests, verify the old source still rejects both old roles, then
   resume Aliyun workers and run `aais-maintenance.sh disable` last.
6. Run `rds-close-migrator.sql` as the RDS administrative identity and require
   `migrator_active_sessions=0`; rotate/disable its password through an
   Owner-only hidden prompt. The migrator remains `NOLOGIN` with no CONNECT or
   schema CREATE outside a future approved migration window.
7. Retain Vercel only as the same-SHA cold application build, with its source
   role still revoked and no RDS role or endpoint. Keep the old database
   read-only for 14 days; never dual-write.

Before the first RDS production write, rollback may restore the old binding.
After the first RDS write, application rollback keeps RDS authoritative; a
simple DNS/database flip to the stale source is forbidden.

## Phase F: stabilized DNS and recovery

1. Monitor `/api/system/traffic-readiness` from multiple locations, but do not
   configure automatic Vercel failover because Vercel cannot reach RDS.
2. Recovery on the existing ECS is manual: restart or recreate only the AAIS
   blue/green container from the recorded digest. Loss of the entire ECS has no
   pre-purchased replacement compute in this rollout and therefore no promised
   one-to-four-hour compute recovery target; it stops for a new Owner decision.

## Failure drill and evidence

Never stop the whole shared ECS for a drill. Stop only the AAIS container and
prove blue/green recreation and rollback on the existing ECS without affecting
another vhost. Do not create a replacement candidate as part of this drill.
Vercel may prove that the same SHA still builds and serves database-free public
assets, but it must not be reported as writable failover. The one-to-four-hour
target applies only to an AAIS container failure while the existing ECS and RDS
remain available.

The final receipt set must separately contain source SHA, ACR digest, Vercel
cold-build deployment/SHA, ECS container/resource limits, migration ledger and backup ID,
Nginx checksum, DNS state, real-domain route matrix, existing-site regression,
functional/streaming/outbox results, failover timing, and Owner acceptance.
