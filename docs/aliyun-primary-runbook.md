# AAIS Aliyun Primary / Vercel Writable Warm-Standby Runbook

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
- Database: the existing Neon PostgreSQL 17 database remains the single
  authoritative production target.
- Vercel: a writable warm backup running the same full Git SHA and connecting to
  the same Neon target through its own least-privilege database role. The
  Vercel Static IP add-on is not enabled. `vercel.json` pins the single Function
  region to Singapore `sin1`, matching the current Neon Singapore region rather
  than the project's previously observed Washington `iad1` default.
- Product workers: Aliyun one-minute systemd timers and the two Vercel
  two-minute Cron schedules remain enabled. Every invocation obtains a unique
  queue mutex and fencing generation before it may dispatch. Aliyun additionally
  renews a 180-second primary heartbeat every minute; Vercel remains standby
  while that heartbeat is live. An Aliyun provider/configuration failure
  conditionally removes only its own heartbeat generation. A vanished Aliyun
  worker therefore expires within three minutes and Vercel gets its next chance
  within two more minutes, giving the planned two-to-five-minute worker takeover
  objective when Neon and Vercel remain available.
- Cross-provider identity: Aliyun and Vercel use independent runtime database
  roles and credentials, but the same database target ID, full Git SHA,
  canonical origin, session-signing secret, product-pseudonym secret, and Next
  Server Actions encryption key. Provider-specific release and worker identity
  values remain distinct.
- Server Actions mapping: GitHub environment secret
  `AAIS_NEXT_SERVER_ACTIONS_ENCRYPTION_KEY` feeds Docker BuildKit target
  `NEXT_SERVER_ACTIONS_ENCRYPTION_KEY`; Vercel Production uses variable
  `NEXT_SERVER_ACTIONS_ENCRYPTION_KEY`. The Owner compares only non-sensitive
  fingerprints, never the key value.
- Vercel scheduler credential: one strong `CRON_SECRET` belongs only to Vercel
  Cron and is distinct from both Aliyun worker tokens. Its value is never
  recorded.
- Formal research plane: disabled and fail-closed.
- Existing ECS services and virtual hosts are out of scope and must not be
  restarted, reconfigured, or used as AAIS dependencies.

## Current live boundary

The repository contains the deployable Aliyun runtime, but `aais.site` remains
Vercel production until all provider, Neon migration, candidate, DNS/GTM, and
Owner acceptance gates are separately evidenced. A local build, a GHCR digest,
or an Aliyun candidate does not prove production cutover.

Both runtimes reach Neon over its public service endpoint with TLS hostname
verification. The selected rollout does not have a source-IP allowlist. A
leaked provider-specific database credential could therefore be attempted from
another network until its role is revoked or rotated. Independent roles,
minimum grants, connection limits, secret redaction, monitoring, and restore
evidence reduce this exposure but do not remove it. Neon is also the shared
database single point of failure: GTM can route around an application/ECS
failure, but it cannot make AAIS writable during a Neon outage, Neon account
suspension, or a network failure that prevents both providers reaching Neon.

A current read-only Vercel Production inventory has confirmed that, in addition
to `AAIS_DATABASE_URL`, the Neon integration injects `DATABASE_URL`,
`DATABASE_URL_UNPOOLED`, `POSTGRES_URL`, `POSTGRES_URL_NON_POOLING`,
`POSTGRES_URL_NO_SSL`, `POSTGRES_PRISMA_URL`, and `PG*`/`POSTGRES_*` aliases.
No values were inspected. This is a deployment blocker: before the first new
production guard runs, remove every candidate URL alias from the Production
environment and retain only `AAIS_DATABASE_URL` as the application database
binding. Raw `PG*`/`POSTGRES_*` variables must not be accepted by application
fallback logic. Re-inventory names only after cleanup; never print their values.

## Repository assets

- `Dockerfile` and `.dockerignore`: Node 24 standalone image and secret-safe
  build context.
- `.github/workflows/ghcr-container.yml`: automatic `main` product gates,
  private GHCR publish through the short-lived workflow `GITHUB_TOKEN`, exact
  SHA/digest, SBOM/provenance generation, package-privacy proof, and redacted
  candidate receipt.
- `deploy/aliyun/aais-preload-ghcr-image.sh`: Owner-only real-TTY hidden PAT
  input, exact-digest pull, local `RepoDigest`/OCI revision checks, complete
  temporary Docker credential cleanup, and redacted preload receipt.
- `deploy/aliyun/aais-deploy.sh`: capacity-gated blue/green promotion using the
  preloaded private GHCR digest by default. It requires candidate and preload
  receipts before touching a container.
- `.github/workflows/ghcr-container.yml` and
  `deploy/aliyun/aais-preload-ghcr-image.sh`: the only image publication and
  preload path.
- `deploy/aliyun/nginx-aais.conf.template`: isolated AAIS vhost with streaming
  controls and trusted proxy-header overwrite.
- `deploy/aliyun/aais-worker.sh` plus systemd units: one-minute local worker
  wakeups with tokens supplied through a root-only runtime file.
- `deploy/aliyun/aais-maintenance.sh`: root-owned file-backed maintenance/write
  freeze consumed by only the AAIS Nginx vhost.
- `deploy/aliyun/database-target-identity.sql`: binds the non-secret database
  identity required by traffic readiness.
- `deploy/aliyun/neon-runtime-roles.sql`: independent Aliyun/Vercel connection
  budgets and minimum runtime grants. It deliberately contains no passwords.
- `deploy/aliyun/neon-open-migrator.sql` and `neon-close-migrator.sql`: open the
  migrator only inside an approved additive migration window, then set
  `NOLOGIN`, revoke elevated privileges, terminate its backends, and prove zero
  sessions.
- `deploy/aliyun/neon-lockdown-public.sql`: removes database/schema/function
  defaults only after both dedicated runtime roles are live, so role creation
  cannot disconnect the current Vercel deployment.

## Hard stop gates

Stop before any billable provider action, production migration, or DNS/GTM
change when any of these is true:

- `AAIS_DATABASE_URL` and a fallback production URL differ.
- Vercel Production still contains any application-visible candidate database
  URL alias, including the currently confirmed Neon-integration
  `DATABASE_URL*`, `POSTGRES_URL*`, `POSTGRES_PRISMA_URL`, or raw
  `PG*`/`POSTGRES_*` set. Do not deploy a new guard while this is true; the
  provider configuration must expose only `AAIS_DATABASE_URL` to the
  application runtime.
- The side effects of disconnecting the managed Neon integration are unknown,
  or the action would revoke/rotate the live legacy credential before the new
  dedicated-role Vercel deployment is verified. Alias-only cleanup may proceed
  only after a read-only provider check proves that credential remains usable;
  otherwise enter maintenance/write freeze or stop for a redesigned two-stage
  transition.
- Vercel Production retains static `AAIS_RELEASE_ID` or
  `AAIS_DEPLOYMENT_GIT_COMMIT_SHA`, does not set
  `AAIS_DEPLOYMENT_PROVIDER=vercel`, does not use pool max 2 and the bound target
  ID, or does not set both `AAIS_RESEARCH_MODE=false` and
  `AAIS_RESEARCH_REQUIRED=false`.
- The Server Actions fingerprints differ across the mapped GitHub/Docker/Vercel
  inputs, or the key value would enter evidence, logs, chat, or screenshots.
- Vercel Production `CRON_SECRET` is missing/weak, is not exclusive to Vercel
  Cron, equals either Aliyun worker token, or would be recorded.
- The source PostgreSQL major version, encoding, collation, extensions, or
  migration ledger is unknown.
- Aliyun and Vercel cannot be assigned distinct least-privilege runtime roles on
  the existing Neon database, each with an independently revocable credential
  and bounded connections.
- Any runtime or migrator role has role membership, `REPLICATION`,
  `BYPASSRLS`, superuser, database-create, or role-create capability. Do not
  auto-revoke an unexpected membership; inventory its owner and stop.
- Migrations `0028_runtime_worker_leases` and
  `0029_runtime_database_identity` are not verified in the authoritative Neon
  ledger, or `AAIS_DATABASE_TARGET_ID` does not match the one bound row.
- Either provider cannot reach the exact Neon hostname with TLS
  `verify-full`, or either URL relaxes certificate verification.
- The effective Vercel deployment does not report Function region `sin1`, or
  the ECS-to-Neon and Vercel-to-Neon latency checks fail the candidate budget.
- The Owner has not explicitly accepted the residual risk of using Neon's
  public endpoint without a source-IP allowlist and the shared-database
  availability boundary.
- The ECS has less than 3 GiB available memory or 50 GiB available disk before
  candidate deployment.
- Any existing ECS website baseline is already failing.
- `AAIS_IMAGE_SOURCE` is not exactly `ghcr-preloaded`, the configured repository
  is not exactly `ghcr.io/hudongpin/aais`, or the image is not addressed by an
  immutable `sha256:` digest.
- The GHCR package cannot be proven private, the automatic `main` workflow did
  not produce the exact-SHA candidate receipt, or the root-owned candidate and
  preload receipts do not agree on GitHub run/attempt, repository, SHA and
  digest.
- The preloaded local image lacks the exact expected `RepoDigest` or its
  `org.opencontainers.image.revision` label is not the full Git SHA.
- A GHCR PAT would be stored, passed in an argument/environment variable,
  handled outside an independently opened real TTY, entered/read by Codex or
  Computer Use, granted more than the required package-read authority, or left
  unrevoked after the preload attempt.
- A release receipt claims that the ECS cryptographically verified the GitHub
  provenance attestation. The current host verifies receipt bindings,
  `RepoDigest`, and OCI revision only.
- A production secret would enter Git, Docker build args, workflow logs,
  command arguments, chat, or a release receipt.
- The current estimate and metered items for the existing ECS snapshot
  (storage and retention), AliDNS/GTM, Neon/Vercel plan overages, and GitHub
  Actions/Packages usage have not been displayed to and approved by the Owner.
  Private GHCR is selected specifically to avoid a new fixed registry
  subscription; future pricing or quota changes must reopen this gate. No new
  server, database service, image registry, static-egress add-on, or network
  secret backend is used or purchased for this topology. Adding one requires a
  separately reviewed architecture change; none is an operator fallback.
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
5. Inventory the exact current Neon database roles without recording
   credentials. Do not run `neon-runtime-roles.sql` yet: its explicit allowlist
   references the tables created by migrations `0028` and `0029`. Do not reuse
   the current Vercel integration credential on ECS.
6. Record only a redacted Neon report proving PostgreSQL 17, encoding,
   collation, extensions, database size, migration ledger, current plan,
   backup/PITR window, region, and public endpoint hostname. Record that no
   source-IP allowlist protects this rollout; never record the URL, username, or
   password.
7. Inventory every current DNS record before any nameserver change. The current
   public baseline uses Vercel nameservers and includes Resend DKIM plus the
   `send` subdomain's SPF/MX records and CAA policy; preserve these alongside
   apex/www and verification records. Record exact values only in the protected
   DNS migration evidence. Do not paste the DKIM public-key body into source,
   chat, screenshots, or this runbook.

## Phase B: provider bootstrap without production traffic

1. Activate `.github/workflows/ghcr-container.yml` on default-branch `main` and
   prove the exact package is private and attached to `hudongpin/aais`. The
   product-gates job has only repository read permission; only the later publish
   job receives `packages: write`, `attestations: write`, and `id-token: write`.
   It uses the run-scoped `GITHUB_TOKEN`, never a PAT, to push the full-SHA tag
   and immutable digest. Configure GitHub environment secret
   `AAIS_NEXT_SERVER_ACTIONS_ENCRYPTION_KEY`; the workflow maps it to Docker
   BuildKit target `NEXT_SERVER_ACTIONS_ENCRYPTION_KEY`, never a build argument.
   Configure the same strong value in Vercel Production variable
   `NEXT_SERVER_ACTIONS_ENCRYPTION_KEY`. The Owner compares only non-sensitive
   fingerprints from both providers; neither the value nor a reversible
   representation enters evidence. Preserve
   the workflow's package-privacy check, SBOM/provenance generation, and
   redacted candidate receipt. Generation and an attestation ID in the receipt
   do not mean the ECS cryptographically verified that attestation.
2. Install `aais-preload-ghcr-image.sh` and `aais-deploy.sh` under
   `/opt/aais/bin` as root-owned executables. Create root-owned
   `/opt/aais/candidates` and `/opt/aais/preloaded` without symlinks. Set these
   non-secret controls in `/etc/aais/deploy.env`:
   `AAIS_IMAGE_SOURCE=ghcr-preloaded`,
   `AAIS_GHCR_REPOSITORY=ghcr.io/hudongpin/aais`, the Owner's non-secret
   `AAIS_GHCR_USERNAME`, and
   `AAIS_PRELOADED_RECEIPT_DIR=/opt/aais/preloaded`. Do not place a PAT or
   Docker auth document in this file, the runtime bundle, or persistent storage.
3. Private GHCR is the sole registry path. A normal `main` push builds only the
   private GHCR candidate; there is no alternate registry path.
4. Install the remaining repository scripts under `/opt/aais/bin` as root-owned mode `0755`,
   create the dedicated `aais-worker` system user/group, and install root-owned
   config under `/etc/aais` with mode `0600`. The runtime has exactly one
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
   only a secret version/fingerprint, never a value. No network secret backend
   or alternate source is supported. Never place the local source's secret
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
5. Record `/etc/machine-id` and the main BaoTa Nginx configuration SHA-256 in
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
6. Install and validate both Aliyun timer units, but leave them disabled. Do
   not invoke the new Aliyun worker endpoints while the old lease-unaware Vercel
   deployment is active. The portability commit keeps both existing Vercel
   schedules permanently; they become the warm-standby wakeups after the
   lease-aware same-SHA build is deployed. There is no Aliyun-only scheduler
   handoff variable in this topology.

## Phase C: Neon transition, private image preload, and candidate verification

1. From the reviewed exact portability commit, but **before merging it to
   `main`**, restore the current Neon backup or PITR point to a separate
   rehearsal branch. If the plan charges for branch compute, storage, restore,
   or egress, show the current complete estimate and obtain Owner approval
   first. Apply migrations `0028` and `0029`, then bind a rehearsal-only target
   ID. Run the migration ledger/checksum verifier, dry-run backfill,
   table/index/constraint checks, aggregate counts, sampled hashes, and a
   rolled-back synthetic write. Record actual restore/verification duration,
   plan, Singapore `sin1` region, backup/PITR window, and support constraints
   without recording a URL or credential. Production migration cannot start
   until this exact order passes.
2. Open the bounded production migrator only for the approved additive-schema
   window. The Owner sets its temporary password through a hidden `psql` prompt
   and places the direct, unpooled URL only in an ignored local env file. Apply
   and verify `0028_runtime_worker_leases` and
   `0029_runtime_database_identity`, then bind the single production target ID.
   Through the Owner-controlled administrative session, run
   `neon-runtime-roles.sql` to create `aais_app_aliyun` and
   `aais_app_vercel`, apply their explicit allowlist, and set their distinct
   passwords only through hidden prompts. Require zero `pg_auth_members` rows
   for all three roles and prove `rolreplication=false` and
   `rolbypassrls=false`. Run `neon-close-migrator.sql`; require
   `NOLOGIN`, a cleared password, revoked elevated access, terminated backends,
   zero migrator sessions, and no schema-creation privilege for either runtime
   role. Do not run `neon-lockdown-public.sql` yet because the active Vercel
   deployment may still depend on legacy defaults or credentials.
3. Prepare the next Vercel Production environment before merging. First inspect
   the managed Neon integration's disconnect/remove behavior read-only without
   changing provider state. Before step 5 verifies the replacement deployment,
   no disconnect action may revoke, rotate, disable, or delete the credential
   still used by the live or recorded immutable deployments. If the provider
   supports removing only injected aliases while preserving that credential,
   record the non-secret result and use that path. If alias removal is coupled
   to credential mutation, either enter a bounded maintenance mode with a
   complete write freeze for the transition or **stop** and redesign a two-stage
   cutover; never test the side effect by disconnecting live production first.

   Delete every `DATABASE_URL*`, `POSTGRES_URL*`, `POSTGRES_PRISMA_URL`, raw
   `PG*`/`POSTGRES_*`, static `AAIS_RELEASE_ID`, and static
   `AAIS_DEPLOYMENT_GIT_COMMIT_SHA`. Retain only a manually controlled
   `AAIS_DATABASE_URL` using `aais_app_vercel` and exactly one
   `sslmode=verify-full`. Set `AAIS_DEPLOYMENT_PROVIDER=vercel`,
   `AAIS_DATABASE_DRIVER=pg`, `AAIS_DATABASE_PROVIDER=neon`,
   `AAIS_DATABASE_POOL_MAX=2`, the production `AAIS_DATABASE_TARGET_ID`,
   `AAIS_RUNTIME_LEASE_SCHEMA_CONFIRMED=true`, `AAIS_RESEARCH_MODE=false`, and
   `AAIS_RESEARCH_REQUIRED=false`. Configure a Vercel-Cron-only `CRON_SECRET`
   that is 32–512 bytes, has no whitespace or placeholder value, contains at
   least eight distinct characters, and is distinct from both Aliyun
   `AAIS_LRS_OUTBOX_FLUSH_TOKEN` and
   `AAIS_AUTH_EMAIL_OUTBOX_FLUSH_TOKEN`; never record any of their values.
   Configure Vercel `NEXT_SERVER_ACTIONS_ENCRYPTION_KEY` to match the GitHub
   environment → Docker BuildKit mapping from Phase B, comparing only a
   non-sensitive fingerprint. Configure the ECS root-only runtime source with
   `aais_app_aliyun`, the same hostname/target/shared secrets/origin,
   `AAIS_DATABASE_DRIVER=pg`, `AAIS_DATABASE_PROVIDER=neon`, and pool max 5.
   Preserve only non-sensitive Neon project identity/target/key fingerprints as
   evidence; the Vercel project no longer has to remain linked to the managed
   `aais-neon` integration. Confirm Vercel will run in `sin1`.
4. Merge the reviewed commit to `main`. Require Git-connected Vercel and
   `.github/workflows/ghcr-container.yml` to build the same full SHA while both
   two-minute Vercel product schedules remain present. Accept the GHCR candidate
   only when the package remains private and
   its redacted receipt records provider `github`, stage `ghcr_candidate`, the
   exact repository/SHA/tag/digest, GitHub run ID/attempt, SBOM generation,
   provenance generation, and a non-empty attestation ID. Transfer only that
   receipt to `/opt/aais/candidates/<full-sha>.json` as root-owned mode `0644`.
   A recorded attestation ID is not an ECS cryptographic verification.
5. Verify the new Vercel deployment before touching legacy credentials. Require
   the exact system-derived SHA, absence of both static release variables,
   `sin1`, provider `vercel`, pool max 2, both research sentinels `false`, the
   production target ID, database role `aais_app_vercel`, both Cron schedules,
   strong/distinct Vercel-only `CRON_SECRET`, matching Server Actions key
   fingerprint, traffic readiness, login, save/read, logout revocation, and
   email/LRS worker lease behavior. Require zero database URL aliases. Record
   only the canonical `AAIS_DATABASE_URL` target fingerprint, Neon project
   identity, role, booleans, and key fingerprint; do not expose a URL,
   credential, worker token, Cron secret, or encryption-key value.
6. Inventory every credential and database role retained by the current and
   recorded immutable Vercel deployments, including prior
   `AAIS_DATABASE_URL` values and managed-integration credentials. Use only
   non-sensitive fingerprints. For a dedicated legacy runtime role that owns no
   database/schema/object and serves no other workload, revoke its DML,
   sequence, function and CONNECT privileges, set `NOLOGIN`, clear/rotate its
   password, terminate every backend, and prove zero sessions. If any legacy
   role is a database/object owner or is shared with another workload, **stop**:
   do not set `NOLOGIN`, rotate, revoke, terminate, or guess. First obtain an
   explicit ownership-transfer or consumer-migration plan. After safe dedicated
   roles are retired, prove the old immutable deployment URLs cannot read or
   write while the new Vercel deployment still passes all checks. Removing
   environment-variable names alone is not credential retirement.
7. Only after step 6 closes, run `neon-lockdown-public.sql` through the
   Owner-controlled administrative session. Require all three reported
   `*_revoked` checks to be true. Re-test the live Vercel role and use an
   Owner-controlled, rolled-back permission check to prove
   `aais_app_aliyun` still has its exact runtime allowlist; full ECS application
   verification follows after deployment.
8. Confirm `/etc/aais/deploy.env` selects `ghcr-preloaded` and that the exact
   candidate receipt is installed. The Owner creates a short-lived PAT with
   only `read:packages`, independently opens a real controlling TTY on the ECS,
   and runs:

```bash
sudo /opt/aais/bin/aais-preload-ghcr-image.sh \
  FULL_40_CHARACTER_GIT_SHA
```

   Only the Owner enters the PAT at the hidden `/dev/tty` prompt. The helper
   validates the candidate, pulls its exact digest, requires the local
   `RepoDigest` and OCI revision to match, logs out, removes its temporary
   Docker credential directory, and writes the root-owned preload receipt only
   after cleanup. The Owner immediately revokes the PAT whether the command
   succeeds or fails. Codex/automation receives only redacted completion and
   receipt evidence. This step does not cryptographically verify the GitHub
   attestation on ECS.
9. After the preload receipt proves `credentialsCleaned=true`, Codex or another
   non-credential automation runs the exact digest from the candidate receipt:

```bash
sudo /opt/aais/bin/aais-deploy.sh \
  ghcr.io/hudongpin/aais@sha256:DIGEST \
  FULL_40_CHARACTER_GIT_SHA
```

   The wrapper refuses receipt mismatches, a missing local `RepoDigest`, an OCI
   revision/SHA mismatch, tags, insufficient capacity, host/Nginx fingerprint
   drift, unsafe runtime-secret permissions, failed liveness/readiness, or an
   invalid Nginx configuration. It performs no registry login or pull in
   `ghcr-preloaded` mode, serializes with `flock`, drains workers, tests the real
   Nginx/TLS path, and writes a redacted deployment receipt. Verify
   `origin-hk.aais.site`: live/traffic/comprehensive readiness, AI SSE for 250
   seconds and disconnect propagation, login/save/reload/logout, email/product
   LRS, role isolation, and shared-session behavior. Run the 10-user/60-minute
   soak; require the container limits, at least 2 GiB host memory, no new 5xx,
   and no more than 10% p95 regression on existing sites.
10. Confirm the Vercel deployment still has both exact Cron schedules and its
    worker endpoints acquire the Neon lease. Enable both Aliyun timers, trigger
    both providers, and prove exactly one current holder/generation dispatches
    each queue while the other returns standby. Preserve the active image, the
    stopped previous image, and one recorded recovery digest with their
    candidate/preload receipts; never run an unscoped `docker system prune`.

For rollback, keep the current Neon target and secret bundle. If the previous
verified GHCR digest and both receipts remain local, rerun the same wrapper by
that digest/SHA. If the image is not local, the Owner must repeat the real-TTY
preload with a new short-lived PAT before automation can roll back. Never use
`docker start aais-blue|aais-green`; a stopped container may carry an obsolete
runtime binding. If any capacity or coexistence gate fails, keep Vercel live and
do not resize unrelated services or buy a second ECS without a new Owner
decision.

## Phase D: cross-provider Neon parity

1. After the in-place production migration and both same-SHA candidates are
   available, verify bidirectional parity against the one Neon target:
   create a bounded test record through Aliyun and read it through Vercel, then
   create a separate bounded test record through Vercel and read it through
   Aliyun. Reconcile and remove only those identified test fixtures through the
   approved application path.
2. Prove an authenticated session created on one provider remains valid on the
   other, logout revocation is immediately shared, both traffic-readiness
   reports expose the same non-secret target ID and full SHA, and neither
   runtime can use the other provider's database credential.
3. Exercise both product workers concurrently and require exactly one current
   lease holder/generation, no duplicate email, no duplicate xAPI statement,
   and a clean takeover after a stopped holder. Prove Aliyun renews its distinct
   primary heartbeat during healthy empty and successful runs, Vercel returns
   standby while it is live, and an Aliyun worker failure removes only the
   matching heartbeat generation. The design bound is 180 seconds of heartbeat
   lifetime plus at most two minutes to the next Vercel Cron, or about two to
   five minutes; actual observed time must be recorded.

## Phase E: DNS authority and Aliyun compute cutover

1. Copy every DNS RRset to AliDNS, including A/AAAA/CNAME/MX/TXT/CAA/SRV,
   wildcard, email, and verification records. Reconcile the protected inventory
   against the current Vercel nameserver authority, Resend DKIM, the `send`
   subdomain SPF/MX records, and CAA before proceeding. Keep the DKIM public-key
   body in protected DNS evidence rather than source or chat. Freeze and verify
   registrar DNSSEC/DS state; an unmatched DS record is a hard stop. Lower
   controllable TTLs before the change.
2. Move nameservers while `www.aais.site` still serves Vercel and observe at
   least 24 hours. This DNS-authority move must not also change application
   traffic. Re-query every copied record from multiple resolvers before moving
   application traffic.
3. Issue and verify auto-renewing TLS certificates whose SANs cover
   `aais.site`, `www.aais.site`, and `origin-hk.aais.site`, with 30/14/7-day
   alerts. Point `origin-hk.aais.site` to the verified Aliyun candidate and
   complete direct functional, streaming, security-header, and capacity
   acceptance. Keep `backup.aais.site` on the same-SHA Vercel deployment and
   return `noindex` there.
4. Create GTM only after its current complete price is shown and explicitly
   approved. Its primary pool is the Aliyun origin and its standby pool is the
   same-SHA Vercel deployment. Use HTTPS
   `/api/system/traffic-readiness`, SNI/Host `www.aais.site`, a fixed
   `status=ready` assertion, multiple probe locations, and three consecutive
   failures before failover. Validate the complete health-check and DNS
   propagation path against the ten-minute application-failover objective.
5. Point `www.aais.site` to the GTM access domain. Keep the apex as a 308 to
   `https://www.aais.site`; if GTM cannot serve the apex, retain the Vercel apex
   redirect. Do not change the canonical application origin on either runtime.
6. After Owner real-browser acceptance, record Aliyun as primary. Recovery of
   Aliyun health does not automatically move traffic back: keep Vercel active
   until the container, exact SHA, Neon target identity, worker leases, existing
   vhosts, and real user flows pass a manual recovery review.

## Phase F: stabilized warm backup and recovery

1. Monitor both providers' `/api/system/traffic-readiness`, GTM pool state,
   Neon availability/connections/storage/backup status, queue age, lease holder,
   release SHA drift, 5xx, TLS expiry, and the existing ECS host/vhosts.
2. For an Aliyun AAIS container or compute-path failure while Neon is healthy,
   GTM targets Vercel takeover within ten minutes. Because both providers use
   the same Neon target, this application-failover case has no database copy or
   dual-write step and targets RPO 0. Provider scheduling and DNS observations,
   not the configuration alone, are the acceptance evidence.
3. Recovery on the existing ECS is to restart or recreate only the AAIS
   blue/green container from the recorded digest, revalidate it through
   `origin-hk.aais.site`, and manually return the GTM primary pool after Owner
   acceptance. Never stop the whole shared ECS or modify another vhost.
4. If Neon is unavailable, both Aliyun and Vercel enter the same database
   failure boundary. Do not route repeatedly, claim writable warm failover, or
   point either runtime at a stale branch. Enter maintenance, preserve evidence,
   restore service with Neon/provider support or an approved verified restore,
   and require a new cutover plan before changing the authoritative target ID.
5. Loss of the entire ECS has Vercel application capacity but no second Aliyun
   server in this rollout. Do not purchase replacement compute without a new,
   explicit Owner decision.

## Failure drill and evidence

Never stop the whole shared ECS for a drill. Stop only the AAIS container and
prove GTM routes the canonical host to the writable same-SHA Vercel warm backup
within ten minutes while Neon remains healthy. Verify an existing session, a new
login, an application write/read, and lease takeover without duplicate email or
xAPI delivery. Restore the Aliyun container without automatic failback, verify
blue/green recreation and all existing vhosts, then return traffic manually.
Do not create a replacement ECS candidate as part of this drill. Separately
exercise a Neon restore branch; do not call the application drill a database
disaster-recovery test.

The final receipt set must separately contain source SHA, the private GHCR
candidate run/digest, the matching Owner preload receipt with credentials
cleaned, local `RepoDigest`/OCI revision evidence, Vercel warm deployment/SHA,
ECS container/resource limits, both independent Neon role identities, all
legacy-credential retirement results, the non-secret database target ID,
migration ledger and backup/PITR restore evidence, Nginx checksum, GTM
primary/standby health, DNS state, real-domain route matrix, existing-site
regression, functional/streaming/outbox results, worker and application failover
timing, manual failback, and Owner acceptance. Record GitHub's generated
attestation ID separately and state that ECS cryptographic verification was not
performed. It must also record the accepted Neon public-endpoint/no-IP-allowlist
residual risk and shared-database single-point boundary.
