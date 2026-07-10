# AAIS Preview Provider Recovery Design

## 1. Purpose and authorization boundary

This design repairs the provider-side Preview E2E path that currently blocks
AAIS dirty-worktree recovery. It creates isolated non-production persistence,
keeps Vercel SSO protection enabled while granting GitHub Actions a narrowly
held automation bypass, seeds database-backed Preview identities, and then
returns control to the existing generation-bound integration and cleanup
process. A separate fail-closed slice may delete the accidental Vercel project
only after its newly discovered bypass resource, exact authority, and reviewed
preflight are bound together.

The owner has authorized the provider revision, creation of an isolated Preview
database, and replacement of the supplied short Preview passwords with
independently generated strong Preview-only credentials. In this thread the
owner then explicitly approved: `书面规范通过，并授权原子删除含已暴露 bypass 的误建项目`.
That expanded authority covers only atomic deletion of exact accidental project
`aais-recovery-compose` (`prj_ABvmKlKMRDeUT6h8Ndq6Lfc7Jvai`) and the resulting
revocation of its one exposed project-owned bypass. It does not authorize a
separate bypass-value operation, deletion of `aais`, billing, or any broader
provider change. Deletion remains gated by exact metadata-only preflight,
fresh specification review, fresh quality/security review, and reviewed
postconditions. This document records authority and design; it does not itself
perform any local code, provider, deployment, pull-request, or cleanup change.

The account identifiers and roles remain exactly:

- `Phoebe` — `student`
- `Bobie` — `teacher`

Their new passwords are never written in this document, source control,
reports, command arguments, or logs. The former short passwords are not reused.

## 2. Authoritative starting evidence

The evidence below is the recorded 2026-07-10 HKT starting state. Provider
state is mutable and must be queried again immediately before every provider
mutation, Preview E2E run, publication decision, and cleanup decision.

- Pull request `#5` is open from `codex/aais-recovery-compose`.
- The sealed generation-1 head and evidence commit is
  `107bc717065b534fb71d009a969217cc573eb885`.
- The generation-1 base snapshot is
  `42e92a483842a2a601ecbdb10794a90c1f3eba1f`.
- GitHub `verify` and the Vercel deployment check pass.
- Preview E2E run `29091442807`, attempt `2`, job `86362100296` fails
  `11/11` tests before AAIS authentication because Vercel SSO intercepts the
  deployment URL.
- The credential precheck passes. The repository contains the four secret
  names `AAIS_E2E_STUDENT_ACCOUNT`, `AAIS_E2E_STUDENT_PASSWORD`,
  `AAIS_E2E_TEACHER_ACCOUNT`, and `AAIS_E2E_TEACHER_PASSWORD`; values remain
  masked.
- The current workflow assigns those four secrets at job scope after only a
  deployment-status predicate, and the current Playwright config uses
  `trace: "on-first-retry"`. Those boundaries are not acceptable once strong
  Preview credentials and an automation bypass exist; the revised trust,
  step-scope, origin, and zero-artifact gates are mandatory before such secrets
  may be used.
- The real Vercel project is `aais`, project ID
  `prj_sKF9lhawVQyjxnv3jLyZvQH95Z1c`.
- Its SSO mode is `all_except_custom_domains`, `protectionBypass` is currently
  absent, and it has zero environment entries targeted to Preview.
  In particular, no same-name project-wide Preview entry currently supplies any
  of the four reviewed AAIS runtime keys.
- The affected Preview deployment is
  `dpl_FChzUziyaFyZ3WbGCTnR3Ea1gUAA`.
- Its corresponding GitHub deployment is `5391084902` and successful deployment
  status is `15329987509`. The GitHub deployment payload is an empty object: it
  contains no Vercel project ID or project name. The status supplies the exact
  Preview target URL and identifies the Vercel GitHub App as creator, but those
  fields alone do not prove the Vercel project ID. Any workflow assertion that
  expects a project field in this GitHub payload is therefore forbidden.
- The accidental project is `aais-recovery-compose`, project ID
  `prj_ABvmKlKMRDeUT6h8Ndq6Lfc7Jvai`. It was created as a diagnostic side
  effect and has an ignored local `.vercel` link in the compose worktree.
- Fresh review found exactly one Protection Bypass for Automation resource on
  that accidental project. A reviewer command exposed its raw value in tool
  output. The value is compromised and must never be repeated, copied, stored,
  hashed, queried through a value-returning endpoint, replayed, or reused. This
  design records count and presence only; it records no bypass identifier.
- The real `aais` project still has zero automation-bypass resources. The
  accidental project has reported zero deployments, domains, environment
  entries, and integration resources, but every count and deletion semantic
  must be re-proved through metadata-only calls before any deletion decision.
- Neon CLI `2.30.1` is available but is not authenticated, and no `NEON_*`
  token variable name is configured in the inspected environment.
- The owner-approved local credential source
  `/Users/dongpinhu/Desktop/AAIS/All API Keys.docx` exists and may be checked by
  the provider implementer for Neon authorization. No claim is made here that
  it has been opened or that it contains a usable Neon credential.
- The provider-design worktree baseline at the sealed head passes install,
  lint, type-check, `50/50` unit/integration test files with `354/354` tests,
  and the production build. Generated `next-env.d.ts` was restored and the
  worktree was clean.
- The root rescue remains exactly 11 modified tracked paths plus untracked
  `migrations/postgres/0008_ai_guide_daily_usage.sql`. Creation of this design
  worktree brought the registered worktree count to 11. Neither root inventory
  nor any existing worktree may be cleaned by this provider slice.

## 3. Non-negotiable invariants

1. Production data, database URLs, provider variables, trial policy, and
   credential fingerprints are never copied into Preview and never changed by
   this slice.
2. The Preview database starts as a brand-new project with no production clone,
   branch, restore, row copy, or shared connection string.
3. Vercel SSO remains enabled in `all_except_custom_domains` mode. Automation
   receives a secret bypass; humans do not receive a less-protected project.
4. Preview uses database-backed identities and sets
   `AAIS_TRIAL_LOGIN_ENABLED=false`. Built-in Bobie/Phoebe roles and production
   trial policy do not change.
   Every sensitive Vercel Preview value is scoped to exact Git branch
   `codex/aais-recovery-compose`; project-wide Preview targeting is forbidden.
5. All raw provider tokens and credential secret values stay in provider
   secret stores or transient process memory/stdin. No secret is passed as a
   command-line argument, stored in a file, included in a shell trace, printed,
   hashed into a report, or committed.
   The recovery-only Vercel metadata token is a sixth repository secret with a
   different trust boundary from the five application/E2E secrets: it may exist
   only in one pre-checkout metadata-attestation step and never in checkout,
   package, Playwright, or application code.
6. The two Preview passwords are independently generated with a CSPRNG, contain
   at least 32 random bytes before encoding, and satisfy the existing seed
   policy. There is no weak-password exception, lowered minimum, manual SQL
   password insertion, or reuse of the former supplied password.
7. Provider resource creation may proceed only when current provider metadata
   proves it is free/no-charge and within an existing quota. Any paid plan,
   card requirement, overage, or uncertain billing state stops for separate
   explicit billing approval.
8. The accidental project's compromised bypass is never reused for `aais`.
   Deletion requires expanded owner authority plus dual-reviewed preflight and
   postcondition evidence. If project deletion cannot be proven to revoke that
   bypass atomically without returning its value, deletion stops for an owner
   dashboard/provider action.
9. Every task uses a dedicated branch/worktree and one implementer at a time.
   No stash, force push, destructive reset, broad `git add .`, forced worktree
   removal, or history rewrite is allowed.
10. External mutable state and Git state are separate evidence domains. A Git
   commit never stands in for a live provider re-query.
11. Root cleanup remains exclusively governed by the reviewed dirty-worktree
    closure design and cannot begin until accepted-main equivalence is proven.

## 4. Considered approaches

### 4.1 Recommended: a brand-new isolated Neon Preview project

Create a fresh Neon project named `aais-preview-e2e` and a dedicated database
named `aais_preview`. Use its provider-created default branch; do not derive it
from another AAIS project. Apply the repository migrations in lexical order and
seed only two synthetic Preview users. Point only the Vercel Preview scope for
the recovery branch at this database.

This approach gives the strongest provenance: isolation is established by a
new project ID, initial absence of AAIS schema, and zero production-copy
operations. It also lets the whole database be retired without touching
production. Its cost and lifecycle are explicit provider responsibilities.

### 4.2 Rejected: permissive Preview trial/file runtime

Leaving Preview on file storage or changing its trial behavior would avoid a
database resource, but it would not verify the deployed DB-first authentication
path or a real teacher role. Serverless file state is not an acceptable
durability boundary, and changing Bobie into a teacher trial identity would
contradict the reviewed production fallback contract. This is not an equivalent
test environment.

### 4.3 Rejected: production reuse or reduced deployment protection

Reusing the production database, cloning production rows, pointing Preview at
production URLs, or disabling Vercel SSO would reduce setup work at the cost of
data separation and access control. A production Neon branch is also rejected:
even an empty branch retains production-project coupling and creates an easy
path to accidental copying. These options are outside authorization.

### 4.4 Billing decision

Provider creation begins with a read-only plan/quota/cost probe. A provider
response that does not unambiguously state zero incremental charge is treated
as a billing requirement, not as consent. No alternative provider, trial-plan
upgrade, card enrollment, or reduced-scope substitute is selected implicitly.

### 4.5 Deferred: Vercel Trusted Sources

Vercel Trusted Sources is not used for this recovery. Current repository and
provider evidence does not establish an auditable, least-privilege setup that
binds a GitHub Actions caller to this exact repository, PR, deployment, and
project. Enabling it without that proof would replace one opaque trust boundary
with another. It may be evaluated in a future separately approved design after
its identity, scope, billing, rotation, and revocation semantics are proved; it
is not a fallback in this execution.

## 5. Code design

### 5.1 Optional explicit account identifiers

`scripts/seed-aais-users.mjs` gains an optional `accountId` field per seed
entry. The field uses the same narrow actor-ID grammar as AAIS sessions:
`^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$`. Surrounding whitespace is removed before
validation; an empty or malformed explicit value fails before any database
write.

`migrations/postgres/0009_user_account_id_casefold_unique.sql` adds unique index
`aais_users_id_casefold_unique_idx` on `lower(aais_users.id)`. Migration `0009`
intentionally fails if an existing database contains a case-insensitive
collision; it never chooses a winner or rewrites an ID. The index creation does
not use `IF NOT EXISTS`; an unexpected same-name object also fails instead of
silently accepting a wrong constraint. `tests/postgres-migrations.test.mjs`
proves lexical discovery after `0008`, exact index name/expression/table,
migration-ledger behavior, successful uniqueness enforcement, and rollback/
failure on a pre-existing case-fold collision.

When `accountId` is absent, the existing deterministic ID derived from the
normalized email remains byte-for-byte unchanged. Existing callers therefore
keep their current behavior.

The parser rejects duplicate normalized emails and duplicate account IDs
case-insensitively. The CLI acquires exactly one database client from the pool,
starts one transaction on that client, and runs
`select pg_advisory_xact_lock(hashtextextended('aais-user-seed-v1', 0))` on that
client. On the same client it preflights case-insensitive ID and normalized-
email collisions, writes both users and both enrollments, verifies all
postconditions, and commits. Any validation, collision, write, or postcondition
error rolls back the entire transaction before releasing the client. Calling
`Pool.query` for `BEGIN` and later statements is forbidden because it cannot
guarantee one session.

An idempotent rerun is allowed only when the existing ID/email pair is the same
identity; an ID mapped to another email, an email mapped to another ID, or a
casing-conflicting ID fails closed before writes. The database unique index is
the final concurrent-writer guard even if another code path does not take the
advisory lock. The postcondition query verifies exact ID/email, role, status,
password-record algorithm/presence, and enrollment mapping before commit.

Reports retain count, role, status, enrollment, and opaque report hashes needed
for operational proof, but omit raw account IDs, emails, passwords, password
environment values, database URLs, and rows. Low-entropy account IDs and
passwords are not included even as hashes.

The new tests prove:

- default derived IDs remain unchanged;
- explicit `Phoebe` and `Bobie` IDs are accepted without embedding passwords;
- malformed, empty, and case-insensitive duplicate IDs fail before writes;
- database-side case-insensitive identity collisions fail closed;
- exact identity reruns remain idempotent;
- every statement from lock through postcondition uses one client and one
  transaction, with commit on success and rollback/release on every failure;
- a concurrent second seed cannot pass the transaction-scoped lock/preflight
  window, while the `lower(id)` index rejects non-cooperating collisions;
- reports and CLI summaries contain no raw account ID, email, password, URL, or
  secret value.

### 5.2 Preview credential generation and seed input

`src/app/api/auth/app-session/route.ts` authenticates against
`src/lib/server/aais-users.ts` before considering trial fallback. The database
lookup accepts either `normalized_email` or `lower(id)`, so the explicit IDs
exercise the deployed DB-first path without changing either runtime module.

The provider operator generates independent random student and teacher
passwords in one non-traced coordinator process. That process sends each value
to GitHub secret input via stdin and exposes it only to the seed subprocess
through the ephemeral `passwordEnv` variables
`AAIS_PREVIEW_E2E_STUDENT_SEED_PASSWORD` and
`AAIS_PREVIEW_E2E_TEACHER_SEED_PASSWORD`. It never serializes the values, and
the two transient variable names are not added to Vercel.

The seed payload uses these private, non-routable Preview addresses:

- `phoebe.preview@e2e.aais.invalid`
- `bobie.preview@e2e.aais.invalid`

It supplies explicit `accountId` values `Phoebe` and `Bobie`, active statuses,
roles `student` and `teacher`, and `passwordEnv` references. The `.invalid`
domain prevents accidental mail delivery while satisfying the current email
syntax contract. The database user IDs, not trial accounts, become the signed
session actor IDs. Seeding uses course `cognitive-apprenticeship` and cohort
`preview-e2e`; these are transient seed inputs, not extra Vercel runtime keys.

The existing minimum password strength remains unchanged. Password literals in
seed JSON remain discouraged, and this task uses only `passwordEnv`. Manual SQL
is not a fallback because it would bypass validation, scrypt construction,
enrollment, and redaction guarantees.

### 5.3 Executable three-stage deployment trust gate

GitHub's `deployment_status` workflow is loaded from the default branch, not
from the unmerged deployment SHA. The current default-branch workflow has no
trust gate and exposes four secrets at job scope. This recovery never assumes
an unmerged `workflow_dispatch` definition can repair that fact.

Before any strong application credential or Vercel metadata token is installed,
a dedicated bootstrap branch `codex/aais-preview-trust-bootstrap` is created
from live `main`. Its exact scope is `.github/workflows/preview-e2e.yml` and
`tests/preview-e2e-workflow.test.mjs`. It removes every job-scoped repository
secret and installs the fixed pre-checkout stages below. Before that branch is
pushed, a separately dual-reviewed quarantine step deletes only the four
currently configured weak E2E secret records by exact name through GitHub's
secret API without retrieving or printing values. The owner's authorization to
replace those weak values covers this temporary removal; a missing authorization
or unexpected secret name stops. Thus the old default workflow cannot receive
those values when the bootstrap PR deployment is created.

The bootstrap change receives code and workflow tests, fresh specification and
quality/security review of the exact tip, an exact-head PR review, merge with
head matching, and fresh post-merge dual review. This narrowly scoped temporary
bootstrap PR is the only permitted exception to the one-open-PR rule; it is
merged or closed before PR `#5` advances. Live `main`, the default workflow blob,
and PR `#5` base are then refreshed. PR `#5` must integrate that exact bootstrap
main commit and restart candidate review. An absent, unreviewed, or drifted
default-branch bootstrap is a hard stop before any repository secret is created.

#### Stage A: secret-free GitHub pre-check

The default-branch workflow first runs a secret-free `trust-preview` pre-check
before checkout or package execution. It uses only the GitHub event payload,
GitHub API, and the job's read-only `GITHUB_TOKEN`. Workflow permissions are
limited to `contents: read`, `deployments: read`, `pull-requests: read`, and
`actions: read`; every other permission is none. No repository or provider
secret is available to this stage.

The pre-check fails unless one internally consistent evidence chain proves:

- repository full name is exactly `HUDongpin/AAIS`, event is exactly
  `deployment_status`, and the workflow path/blob is the exact dual-reviewed
  bootstrap blob on current default branch `main`;
- the GitHub deployment and successful status have nonzero exact IDs, belong to
  that repository, and were both created by Vercel bot login `vercel[bot]`, bot
  ID `35613825`, node ID `MDM6Qm90MzU2MTM4MjU=`, and type `Bot`;
- pull request `#5` is open, its base is `main`, its head repository is exactly
  `HUDongpin/AAIS`, `isCrossRepository=false`, and its head ref is exactly
  `codex/aais-recovery-compose`;
- deployment ref/SHA and the current PR head SHA are the same full commit SHA;
- deployment environment and status are exactly `Preview` and `success`;
- deployment payload is accepted as empty and is never used to claim a Vercel
  project identity;
- status target URL and environment URL normalize to the same URL, use HTTPS,
  contain no credentials/query/fragment, and have a hostname ending exactly on
  the `.vercel.app` label boundary.

Stage A emits only `GITHUB_DEPLOYMENT_ID`,
`GITHUB_DEPLOYMENT_STATUS_ID`, the normalized Vercel URL/hostname, the exact PR
head SHA, validated repository/PR/ref, workflow ID/path/blob, and current main
SHA as non-secret in-memory/job outputs. The two GitHub IDs remain GitHub
identifiers and are never used as Vercel `idOrUrl`. Stage A emits no event body
or response body. A default-main tip or workflow-blob change invalidates every
earlier PASS and requires bootstrap re-review before Stage B.

#### Stage B: pre-checkout Vercel project attestation

GitHub's deployment payload cannot prove the Vercel project. A second step in
the same trusted default-branch job therefore receives the separate repository
secret `VERCEL_E2E_METADATA_TOKEN` as step-level environment only. The official
request is exactly `GET https://api.vercel.com/v13/deployments/{idOrUrl}?teamId=team_i9xhhYXUeYBOCLcfWBjTqlYG`, or the byte-equivalent URL-encoded form where
`idOrUrl` is the exact normalized Vercel hostname from Stage A. It is never
`GITHUB_DEPLOYMENT_ID` or `GITHUB_DEPLOYMENT_STATUS_ID`. The bearer token is
read only from that step's environment and placed only in the in-memory
`Authorization` header; it is never a CLI flag, command argument, URL, shell
trace, output, cache, file, log, artifact, checkout, package command,
Playwright process, or application process. Redirects are disabled. Fixed
reviewed code parses the response in memory and prints only a fixed PASS/failure
code. Operator diagnostics use `jq` only to construct the reviewed allowlist;
raw response bodies and headers are never printed or persisted.

The exact allowed response paths are:

- `.id`, `.name`, `.projectId`, `.ownerId`;
- `.team.id`, `.team.slug`;
- `.readyState`, `.status`, `.target`, `.url`, `.alias[]`;
- `.gitSource.type`, `.gitSource.repoId`, `.gitSource.ref`, `.gitSource.sha`;
- `.meta.githubOrg`, `.meta.githubRepo`, `.meta.githubCommitRef`,
  `.meta.githubCommitSha`.

Missing critical paths, additional unreviewed identity/Git/target paths,
differently typed values, or schema drift fail before checkout. A `jq`
diagnostic may emit only this allowlisted projection or a boolean predicate;
it may not emit the original object.

Stage B fails unless one response atomically proves:

- `.projectId=prj_sKF9lhawVQyjxnv3jLyZvQH95Z1c`, `.name=aais`,
  `.ownerId=team_i9xhhYXUeYBOCLcfWBjTqlYG`,
  `.team.id=team_i9xhhYXUeYBOCLcfWBjTqlYG`, and
  `.team.slug=peter-dongpin-hu-s-projects`;
- `.target` is JSON `null`, never string `"preview"`; `.readyState=READY` and
  `.status=READY`; returned `.id` becomes `VERCEL_DEPLOYMENT_ID`; and `.url` or
  an exact `.alias[]` member equals the Stage-A hostname. Production or any
  unexpected non-null target fails;
- `.gitSource.type=github`, `.gitSource.repoId=1294583104`,
  `.gitSource.ref=codex/aais-recovery-compose`, and `.gitSource.sha` equals the
  dynamic Stage-A/current-PR full SHA;
- `.meta.githubOrg=HUDongpin`, `.meta.githubRepo=AAIS`,
  `.meta.githubCommitRef=codex/aais-recovery-compose`, and
  `.meta.githubCommitSha` equals that same dynamic full SHA;
- `GITHUB_DEPLOYMENT_ID`, `GITHUB_DEPLOYMENT_STATUS_ID`, returned
  `VERCEL_DEPLOYMENT_ID`, origin, PR head SHA, and provider observation
  timestamp remain distinct and are combined into one redacted attestation.

Missing or differently named provider fields, API/schema drift, redirects,
multiple deployments for the hostname, non-Preview state, or any mismatch fails
before checkout. The selected official endpoint and exact allowlisted response
schema are pinned in the implementation plan and revalidated live without
printing a response before token creation.

The metadata token is created only after a dual-reviewed provider preflight
proves its exact account/team, read-only deployment-metadata scope, expiry, and
revocation semantics. It must be dedicated, least-privilege, short-lived, and
independently revocable when Vercel supports those controls. If the current API
offers only a broad personal/team token, execution hard-stops for explicit owner
approval of that exact scope and lifetime; no existing general-purpose token is
copied. Token creation and its GitHub secret update use no-output APIs, receive
fresh post-mutation dual review by metadata only, and are separate from the five
application/E2E secrets.

#### Stage C: exact checkout and one secret-bearing test step

Only after Stages A and B pass may a dependent job check out the exact attested
SHA. It proves `HEAD` equals that SHA and normalized `origin` equals
`HUDongpin/AAIS`. Checkout, dependency/browser installation, build preparation,
trust diagnostics, and post-run artifact inventory are secret-free. The five
application/E2E secrets are assigned as step-level environment only to the
single trusted Playwright execution step. They never exist at job scope, in the
metadata-attestation step, setup, caches, package lifecycle preparation, or
artifacts. The metadata token never reaches Stage C.

The temporary recovery gate's literal PR/ref allowlist is removed before the
generation-2 final seal. A separately reviewed cleanup commit converts Stage A
to a generic fail-closed same-repository owning-PR rule while retaining exact
repository, Vercel App, Stage-B project, origin, and checkout checks. The final
sealed deployment must use that generic code and dynamically prove its owning PR
is `#5`. After final accepted-main and provider proofs, a separately dual-reviewed
provider cleanup revokes the metadata token and deletes only
`VERCEL_E2E_METADATA_TOKEN` by exact name. With that secret absent, the retained
generic workflow fails closed before checkout/Playwright; later Preview E2E
requires a newly approved, scoped token rather than reuse of the recovery token.

### 5.4 Origin-scoped in-memory Preview bypass

The final Playwright step in `.github/workflows/preview-e2e.yml` receives
`VERCEL_AUTOMATION_BYPASS_SECRET` and the four account/password values from
GitHub Actions secrets. It fails before the Playwright command unless all five
application/E2E secret names resolve to non-empty values. The workflow does not
print them. `VERCEL_E2E_METADATA_TOKEN` is not one of these five and is absent
from this job and step.

A new `tests/e2e/aais-e2e-fixtures.ts` extends the Playwright fixture used by
every one of the seven spec files and all 11 tests. In external Preview mode,
its automatic bootstrap parses the exact AAIS base origin, requires HTTPS and a
hostname whose label boundary ends exactly in `.vercel.app`, and uses the
browser-context-associated API request client for one request to the exact
same-origin `/login` URL with these headers:

- `x-vercel-protection-bypass`
- `x-vercel-set-bypass-cookie: true`

The request does not follow a cross-origin redirect. The fixture validates a
successful AAIS response URL/status and presence of the Vercel bypass cookie in
that same browser context without printing its name/value or response body.
Browser navigations then use only the in-memory, origin-scoped cookie. The
fixture never persists `storageState`, and no bypass header is configured in
global `use`, `extraHTTPHeaders`, page navigation, arbitrary subresource, or
cross-origin request.

The bypass value comes only from `VERCEL_AUTOMATION_BYPASS_SECRET`. External
mode fails closed with a fixed redacted error code when the URL, response,
cookie, or bypass secret is missing/invalid; caught provider/network errors are
not interpolated. Local E2E skips the bootstrap and continues to start its local
server. Because the deployed tests share exactly two database identities,
external mode uses one Playwright worker to avoid cross-test mutation and
rate-limit races; local parallel behavior is unchanged.

An executable negative regression uses a fake context/request recorder to
prove the two headers are sent once only to the exact trusted origin, never to a
lookalike suffix, HTTP URL, redirect target, subresource, or cross-origin URL.
All seven specs import `test`/`expect` from the custom fixture. A direct import
from base `@playwright/test` in a spec fails the regression gate.

### 5.5 Secret-bearing artifact prohibition

External Preview mode sets trace, video, screenshot, network HAR, HTML report,
offline output, and persisted storage state to off/absent, including on retry
and failure. It uses only the console list reporter, `preserveOutput: "never"`,
and zero attachments. The fixture never calls `testInfo.attach`, never writes a
cookie jar, and throws only fixed redacted errors. Workflow upload-artifact
steps are forbidden for the trusted Playwright execution.

Local E2E may retain its current developer trace behavior because it receives
no provider/credential secrets. Regression tests evaluate both config branches
and fail if external mode enables trace, screenshot, video, HAR, HTML/blob/JUnit
output, storage-state persistence, output retention, or attachments. A
post-run fail-closed filesystem inventory proves the Playwright/test-result
artifact-file and attachment counts are both zero before the workflow reports
success; an empty runner-created directory is not treated as evidence.

The workflow/config regression tests prove the event filter, secret-free Stage
A, exact Vercel App identity, empty-payload handling, pre-checkout Stage-B token
scope and fixed redacted output, exact checkout, separation of the metadata
token from the five-secret Playwright step, origin-scoped bootstrap, HTTPS host
guard, negative cross-origin behavior, external artifact prohibition, local
header absence, and unchanged E2E invocation. No header value, API response, or
credential appears in test snapshots or failure output.

### 5.6 Exact tracked implementation scope

The code task may change exactly these paths:

1. `scripts/seed-aais-users.mjs`
2. `tests/aais-user-seed.test.mjs`
3. `migrations/postgres/0009_user_account_id_casefold_unique.sql`
4. `tests/postgres-migrations.test.mjs`
5. `playwright.config.ts`
6. `.github/workflows/preview-e2e.yml`
7. `tests/preview-e2e-workflow.test.mjs`
8. `tests/preview-e2e-bypass.test.ts`
9. `tests/e2e/aais-e2e-fixtures.ts`
10. `tests/e2e/ai-guide.spec.ts`
11. `tests/e2e/core-accessibility.spec.ts`
12. `tests/e2e/dashboard-access.spec.ts`
13. `tests/e2e/learning-persistence.spec.ts`
14. `tests/e2e/login-failure.spec.ts`
15. `tests/e2e/login-learning.spec.ts`
16. `tests/e2e/mobile-learning.spec.ts`
17. `OPERATIONS.md`

Provider setup records a separate tracked artifact at:

`docs/superpowers/recovery/2026-07-10-aais-preview-provider-evidence.md`

Generation-2 integration later updates the existing canonical recovery artifact:

`docs/superpowers/recovery/2026-07-10-aais-dirty-inventory-equivalence.md`

Any need to change an auth route, built-in trial account, migration, application
page, unrelated runtime module, production document, or additional workflow
stops for design revision. Generated provider files, `.env*`, `.vercel`, seed
reports, database reports, Playwright traces, and credentials remain ignored
and uncommitted.

## 6. Isolated Neon design

### 6.1 Authentication and creation

The implementation may inspect the approved local credential DOCX for a Neon
credential without displaying, copying, or summarizing it. If no usable
credential exists, the task stops. A provider token may enter only a process
that can accept it through memory/stdin; if the Neon CLI requires exposure in a
command argument, shell history, file, or log, the operator uses a minimal API
client with an in-memory authorization header instead.

Before creation, read-only metadata must prove the account, plan, region
choices, project quota, and zero incremental charge. Creation then yields a new
project ID distinct from every production or previously recorded AAIS project.
The selected region and provider-generated role/branch IDs are recorded as
non-secret metadata. No import, restore, branch-from-existing, logical
replication, data transfer, or production connection occurs.

### 6.2 Migration and seed

The fresh database is first checked for absence of the AAIS migration ledger
and user tables. All repository migrations `0001` through `0009` are applied by
`npm run db:migrate` using only a transient `AAIS_DATABASE_URL`. Migration
checksums must match the repository ledger, and migrations `0008` and `0009`
must be present. The lower-ID unique index is queried by metadata and exercised
inside a rolled-back collision probe before seeding.

`npm run db:seed-users` then seeds the two approved identities using
`passwordEnv`. Count-only verification requires:

- nine migration-ledger rows with repository-matching versions/checksums;
- exactly two AAIS user rows created by this seed;
- one active student and one active teacher, with no admin;
- two active enrollments in the explicitly named Preview cohort;
- exact case-insensitive login lookup for both account identifiers;
- no raw account, email, password, password record, database URL, or learner
  row in any report.

The implementation also performs two redacted DB-first authentication probes
against the deployed app. They assert only success, actor role, and expected
redirect; response cookies and bodies are not retained. A failed role,
trial-fallback result, or database connectivity error blocks E2E and merge.

### 6.3 Lifecycle

The Neon project contains synthetic Preview E2E data only. It is retained after
this recovery as dedicated Preview test infrastructure, never as a pilot or
production store. Its evidence records creation time, owner, purpose, review
date no later than 30 days after creation, and deletion procedure.

Retirement is ordered: disable the Preview workflow or its branch scope, remove
the exact branch-scoped Vercel Preview environment record IDs, prove that no
same-name project-wide Preview entry exists, revoke the automation bypass,
remove the corresponding GitHub secrets, verify no deployment depends on the
database, and only then delete the exact Neon project ID. Deletion requires a
fresh owner decision because it affects newly created infrastructure. No
production project may appear in the retirement set.

The dedicated Vercel metadata token is not retained for that 90-day lifecycle.
It is revoked and its GitHub secret deleted immediately after the recovery's
accepted-main proof, before root closure. Later metadata access requires a new
preflight, owner decision where scope is broad, and newly created token.

Password and bypass rotation is due no later than 90 days after creation and
immediately after any suspected exposure. Rotation creates new independent
values, updates provider/database and GitHub stores without logging, runs the
full Preview E2E suite, and revokes the old values. Session-secret rotation is
independent and intentionally invalidates Preview sessions.

## 7. Vercel Preview design

### 7.1 Real-project targeting and environment

Every Vercel mutation requires both the exact name `aais` and exact ID
`prj_sKF9lhawVQyjxnv3jLyZvQH95Z1c`. A name-only match, an ID-only match, or a
local `.vercel` link is insufficient. The provider operator records the real
project's pre-change SSO mode, Preview environment metadata, production
environment metadata fingerprint, Git integration, deployment ID, and project
ID without retrieving secret values.

Only these runtime values are added to Vercel, and every record must have target
`preview` plus exact `gitBranch=codex/aais-recovery-compose`:

- `AAIS_DATABASE_URL` — the new isolated Neon connection;
- `AAIS_DATABASE_PROVIDER=neon`;
- `AAIS_SESSION_SECRET` — a new independent value containing at least 32
  CSPRNG bytes before encoding;
- `AAIS_TRIAL_LOGIN_ENABLED=false`.

No production value is copied. No live AI, LRS, email, OIDC, monitoring, or
production trial variable is added. Absence of live AI provider variables keeps
the deterministic guide behavior. Vercel/Neon integration auto-injection is
not used because it could add unreviewed keys or project coupling.

Branch scoping is mandatory for every sensitive Preview value: database URL or
provider-required connection components, database-provider setting, session
secret, trial flag, and any seed/transient input if a later reviewed provider
API unexpectedly requires storage. This design keeps seed inputs transient and
does not store them in Vercel. Before mutation, metadata must prove the current
Vercel API supports exact `gitBranch` scoping on real project `aais` and that no
same-name project-wide Preview record exists for any reviewed key or component.
Unsupported scoping, ambiguous metadata, or an existing same-name project-wide
entry hard-stops for new owner authorization and design review; this
specification provides neither a project-wide fallback nor a dedicated-project
alternative.

Removal later uses only the exact branch-scoped environment record IDs created
by this task, never name-wide deletion. Post-removal metadata must prove those
IDs absent and prove that none of their key names leaked into a project-wide
Preview entry, production, development, or another Git branch.

Only after the reviewed candidate is integrated, pushed, Git-deployed, and its
provider preflight has passed may environment records change. Then trigger a
fresh deployment of that exact reviewed candidate SHA through the existing
Git-based Preview path. A local production deploy is forbidden. The new
deployment must identify the real project, intended Git branch/SHA, isolated
Preview environment, and exact candidate workflow source before tests run.

### 7.2 Protection Bypass for Automation

Create Vercel Protection Bypass for Automation on the real `aais` project and
store the raw bypass value only in Vercel and the GitHub Actions secret
`VERCEL_AUTOMATION_BYPASS_SECRET`. Keep SSO mode exactly
`all_except_custom_domains`; the bypass does not become a URL parameter, source
constant, workflow literal, artifact, or evidence hash.

The first guarded request must return the AAIS app rather than the Vercel SSO
page and set the bypass cookie. Evidence records only that bypass metadata is
present, its type, count, creation/rotation timestamps, GitHub secret name, and
test status. It records no bypass value, value hash, resource identifier, or
cookie value.

Unexpected use of the newly created real-project bypass, leakage of its value,
loss of SSO mode, or a header sent to a non-Vercel host triggers immediate
revocation and blocks publication. The operator then rotates the Vercel value
and GitHub secret together and reruns all 11 Preview tests. This rotation rule
does not authorize interacting with the compromised accidental-project bypass;
section 8 governs that resource.

### 7.3 GitHub E2E secrets

The four legacy weak account/password secret records are first quarantined as
specified in section 5.3. After the default-main bootstrap and both trust stages
are reviewed, the two account secrets are safely recreated with the approved
account identifiers and the two password secrets receive the new independent
strong values. The fifth application/E2E secret is the Vercel automation bypass.
GitHub metadata is verified by name and update time only.

`VERCEL_E2E_METADATA_TOKEN` is a sixth, recovery-only secret. It is provisioned
in its own provider-credential slice after bootstrap and provider preflight,
before any application/E2E secret is recreated. Its sole consumer is the fixed
pre-checkout Stage-B metadata request. It is never counted as an application
credential or exposed to Stage C. After accepted-main and final provider proof,
its provider token is revoked first, its exact GitHub secret record is deleted
second, and metadata proves both absences. Fresh specification and
quality/security reviews are required before and after that cleanup.

Because GitHub does not reveal prior secret values, strong application-secret
replacement is deliberately ordered after Stage B passes for the exact
candidate and the isolated users exist, but before the trusted Playwright step.
The old short passwords are never restored. If setup fails after replacement,
the new database-aligned application secrets remain while diagnosis continues;
if the isolated database is explicitly retired, the five exact application/E2E
secrets are deleted rather than rolled back to unknown or weak values. Metadata-
token cleanup remains independent and mandatory after recovery or immediately
after any suspected token exposure.

## 8. Accidental formerly nonempty project deletion

The project `aais-recovery-compose`, exact project ID
`prj_ABvmKlKMRDeUT6h8Ndq6Lfc7Jvai`, currently has one compromised Automation
Bypass resource. The prior empty-project authorization was invalidated, and the
owner has now supplied the exact expanded authority quoted in section 1. That
authority names atomic deletion of the accidental project and the revocation
effect on its exposed bypass; it authorizes nothing broader. Execution must
bind this thread authority to the exact project and reviewed live preflight.

### 8.1 Metadata-only dual-reviewed preflight

The deletion-preflight implementer may call only metadata endpoints that return
counts/presence and cannot return the bypass value. It must prove:

- exact name, ID, team/owner, and local-link ownership match together;
- the ID differs from real project `aais` ID
  `prj_sKF9lhawVQyjxnv3jLyZvQH95Z1c`;
- deployment, domain/alias, environment-variable, integration-resource, cron,
  Git-link, shared-resource, and active-operation counts are zero;
- automation-bypass count is exactly one and presence is `true`, without a
  resource identifier, value, or hash;
- the provider's documented/current project-deletion operation revokes every
  project-owned bypass atomically and does not require or return the bypass
  value;
- real `aais` had starting bypass count zero; if its independently generated
  reviewed bypass has since been created by section 10, its current count is
  exactly one. In either state the exact pre-deletion count is captured and
  `aais` is not in the deletion request or ownership graph;
- expanded owner authorization has been received after disclosure of these
  facts.

Any missing endpoint, value-bearing response shape, ambiguous count, duplicate
name, unexpected owner, nonzero resource outside the one bypass, absent
authority, or uncertain atomic-revocation semantic is a hard stop. If safe API
or CLI semantics cannot be proven without revealing the value, the only
allowed next action is an explicitly authorized Vercel dashboard/provider
operation. The compromised value is never tested, replayed, or supplied as a
CLI argument.

A fresh specification reviewer first checks the exact contract and authority;
then a fresh quality/security reviewer independently re-queries count-only
metadata and provider deletion semantics. Neither reviewer executes deletion.

### 8.2 Owner-only local-link preimage

Before external deletion, archive the matching ignored `.vercel` link bytes in
an owner-only external preimage without printing contents. Verify mode, archive
integrity, and hash, and prove in memory that the link names the accidental ID,
not `aais`. No other `.vercel` directory is touched. The archive records no
bypass data.

### 8.3 Exact project deletion and postconditions

After dual-reviewed preflight and expanded authority, delete the entire
accidental project by exact project ID. The command/request contains only
project/team identifiers and confirmation; it never includes the bypass value.
Whole-project deletion is the atomic revocation mechanism. Deleting or rotating
the bypass separately is forbidden because doing so would require touching a
compromised value-bearing surface and would weaken the one-operation proof.

Postconditions require exact-ID lookup to return provider not-found and project
enumeration to contain neither exact ID nor name. Metadata must continue to show
real `aais` at its exact ID, SSO unchanged, its exact pre-deletion bypass count
unchanged (zero before real setup or one after the reviewed independent setup),
and no relation to the deleted project. Provider semantics plus project absence
prove the deleted project-scoped token cannot authorize real `aais`; the
compromised value is never replayed to demonstrate this. The matching local
link is then absent.

A fresh specification reviewer and then a fresh quality/security reviewer
independently verify postconditions and redaction. If project absence or
project-scope isolation cannot be proven, publication stops and the owner uses
Vercel support/dashboard. Deletion is irreversible; recreation would be a new
empty project and is not automatic.

## 9. Evidence contract

The provider evidence document is a structured key/value manifest plus bounded
narrative sections. It records external observations with RFC 3339 timestamps
in `Asia/Hong_Kong`, the observing actor/task, exact commands or API operation
names, status, rollback owner, and next rotation/lifecycle date.

It includes, without secret values:

- PR number, branch, sealed generation-1 SHA, base SHA,
  `GITHUB_DEPLOYMENT_ID`, `GITHUB_DEPLOYMENT_STATUS_ID`,
  `VERCEL_DEPLOYMENT_ID`, run ID, and job ID as distinct fields;
- real and accidental Vercel project names/IDs;
- pre/post SSO mode and real/accidental protection-bypass counts/presence/type,
  with no bypass resource identifier;
- Preview environment key/component names, record IDs, types, exact
  `gitBranch=codex/aais-recovery-compose`/`preview` scopes, configured booleans,
  and pre/post proof that same-name project-wide Preview records are absent;
- a redacted metadata-only fingerprint proving production environment records
  did not change;
- GitHub legacy-secret quarantine names/absence timestamps; five
  application/E2E secret names and update timestamps at runtime; metadata-token
  secret creation/update timestamp and final provider-revocation/GitHub-absence
  status, never values;
- new Neon project/branch/database/region IDs, zero-charge proof status, and
  isolation assertions;
- migration version/count/checksum status through `0009`, lower-ID uniqueness,
  one-client transaction/advisory-lock status, and count-only
  user/role/enrollment results;
- implementation-plan, code, legacy-secret quarantine, default-main bootstrap,
  integration-candidate, remote binding, provider-preflight, metadata-token
  mutation/cleanup, provider mutation, deletion preflight/postcondition,
  generation seal, publication/merge, closure, and final-global reviewer SHAs
  with exact reviewed Git tips or external observation timestamps;
- bootstrap PR/merge/main SHA, default workflow ID/path/blob, Stage-A repository/
  Vercel-App/PR/ref/GitHub-deployment/status/origin results, Stage-B Vercel
  project/team/deployment/Git-source attestation, and separation of the one
  metadata-token step from the five-secret Playwright step;
- accidental-project pre-delete zero counts plus exactly-one-bypass count,
  expanded-authorization status, atomic-revocation semantic, and post-delete
  absence/real-project-isolation result;
- origin-scoped bypass-to-app probe, DB-first role probes, deployment,
  unit/full gates, Preview E2E result statuses, and external secret-bearing
  artifact count exactly zero;
- lifecycle, rotation, revocation, and rollback ownership.

Secret values, connection strings, passwords, cookies, session tokens, bypass
values or resource identifiers, Vercel metadata-token values/fingerprints,
authorization headers, private emails, raw account IDs, password/bypass hashes,
API response bodies, and database rows are excluded. A low-entropy secret or
identifier is not made safe merely by hashing. The compromised accidental bypass is recorded
only as `count=1`, `presence=true`, and `compromised=true`.

Provider evidence is refreshed live before publication. A stale committed
manifest may describe history but cannot authorize a current mutation or merge.

## 10. Subagent-driven execution order

Implementation is intentionally sequential. No code deployment or provider
mutation may occur from the isolated code branch. The executable order is:

1. Commit this design, obtain a fresh specification review and then a fresh
   quality/security review, obtain owner approval of the written specification,
   and write a separate implementation plan. The plan itself receives fresh
   specification and quality/security reviews before execution.
2. Create a new provider implementation worktree/branch at sealed head
   `107bc717065b534fb71d009a969217cc573eb885` and bring in only the exact
   reviewed documentation tip through normal Git history.
3. A fresh code implementer uses TDD for the exact section 5.6 scope, including
   migration `0009`, transaction/concurrency behavior, trust gate, origin-scoped
   fixture, and artifact prohibition. A fresh spec reviewer then a fresh
   quality/security reviewer must pass the exact code tip.
4. A fresh legacy-secret-quarantine implementer proves the four current weak
   GitHub secret names and the owner's replacement authority without reading a
   value. Fresh preflight spec and quality/security reviewers pass that exact
   metadata state; the implementer deletes only those four records through the
   no-output secret API; fresh post-mutation spec and quality/security reviewers
   independently prove their absence. Any state drift restarts both reviews.
5. A fresh bootstrap implementer creates the exact two-path default-main slice
   in section 5.3 from live `main`. Fresh code spec and quality/security
   reviewers pass its exact tip and gates. It is pushed as the sole temporary
   bootstrap PR, receives fresh remote/head spec and quality/security review,
   merges with exact-head matching, and receives fresh post-merge dual review of
   server history and the default workflow blob. The temporary PR is then
   closed/absent before continuing; no unmerged workflow dispatch is trusted.
6. A fresh integration implementer merges both the reviewed provider code tip
   and refreshed live main containing the exact bootstrap merge into
   `codex/aais-recovery-compose` locally without rewriting commits, reconciles
   conflicts, runs all local gates, and produces a generation-2 candidate.
   Fresh integration spec and quality/security reviewers validate the exact
   candidate SHA, tree, parentage, scope, and gates.
7. Push that exact reviewed candidate to the existing PR branch; the owner has
   already approved this push. Re-query PR `#5` to prove its head equals the
   candidate and wait for a successful Git-created Vercel Preview deployment.
   No branch-scoped environment is created before this branch/deployment exists.
   Fresh remote-binding spec and quality/security reviewers prove the pushed
   SHA, updated base, PR tuple, GitHub deployment/status, exact reviewed default-
   main workflow source, and Stage-A result before provider preflight.
8. A fresh provider-preflight implementer performs metadata-only Neon
   plan/quota/cost/region checks, checks only whether an approved Neon credential
   is usable, captures Vercel/GitHub/production fingerprints, validates the
   official Vercel deployment-metadata endpoint/allowlisted schema, and proves
   the available metadata-token scope/lifetime/revocation model. It also proves
   real `aais` supports exact branch-scoped Preview environment records and that
   every reviewed key/component has no same-name project-wide Preview record.
   It writes no secret. Fresh preflight spec and quality/security reviewers
   independently re-query and pass the exact Git/provider state. Missing Neon
   authorization, uncertain zero charge, stale candidate/bootstrap, unsafe
   workflow source, or a broad metadata token without expanded owner approval is
   a hard stop.
9. A fresh metadata-token implementer creates one dedicated scoped, short-lived
   token and sets only `VERCEL_E2E_METADATA_TOKEN` through no-output APIs. Fresh
   provider-credential spec and quality/security reviewers prove metadata-only
   postconditions. The reviewed default-main workflow then runs Stages A and B
   against the exact candidate deployment with no checkout or app secret;
   fresh runtime-trust spec and quality/security reviewers verify the exact
   GitHub/Vercel attestation. Any tip or external-state change invalidates both
   reviews and blocks the next mutation.
10. A fresh external-provider execution implementer creates the empty isolated
   Neon project/database, applies migrations through `0009`, atomically seeds
   both users, configures only the reviewed Vercel Preview records on real
   `aais` with exact `gitBranch=codex/aais-recovery-compose`, creates a new
   independent real-project automation bypass, and safely
   creates the five application/E2E GitHub secrets. It verifies all count-only
   and redacted postconditions. Fresh provider-mutation spec and quality/security
   reviewers independently re-query the live post-state before it is accepted.
11. A fresh accidental-deletion-preflight implementer performs section 8.1 and
   local preimage preparation. Fresh spec and quality/security reviewers must
   pass exact live counts, atomic-revocation semantics, redaction, and expanded
   owner authority. If the exact thread authority cannot be bound to this
   project/revocation effect, execution stops here.
12. A different fresh deletion-execution implementer deletes the entire exact
   accidental project in one operation and records postconditions. Fresh
   post-deletion spec and quality/security reviewers independently prove
   absence, real-project isolation, and local-link handling.
13. Redeploy the exact reviewed candidate through the Git Preview path. Stage A
    must bind GitHub/Vercel-App/default-workflow/PR/branch/repository/URL/SHA;
    Stage B must bind exact Vercel project/team/deployment/Git source; and Stage
    C must bind checkout remote/HEAD before the five-secret Playwright step.
    Run deployed DB-first probes and Preview E2E; require `11` expected and `0`
    unexpected, zero secret-bearing artifacts, and provider post-state unchanged.
    Fresh runtime spec and quality/security reviewers independently verify the
    candidate deployment, run, artifact inventory, and live provider state.
14. A fresh trust-gate cleanup implementer removes the recovery-only literal
    PR/ref allowlist and installs the generic same-repository rule described in
    section 5.3. Fresh spec and quality/security reviewers pass that cleanup so
    the temporary policy cannot reach main.
15. A fresh evidence implementer regenerates the structured recovery artifact
    as generation `2`, preserving generation `1`, and creates the proposed final
    seal/tag binding without publishing mutable acceptance claims. Fresh
    evidence spec and quality/security reviewers validate every Git/external
    field, predecessor relation, redaction, and gate capture.
16. Push the exact reviewed final sealed head to the same PR, produce a fresh Git
    Preview deployment of that exact SHA, and rerun trust, provider post-state,
    focused/full CI/build/hygiene/diff, DB-first, zero-artifact, and `11/0` E2E
    gates. No candidate result is accepted for a later final head. Fresh
    final-check spec and quality/security reviewers verify the exact sealed SHA,
    deployment, run, artifacts, provider state, and gate captures before
    publication review begins.
17. A fresh publication implementer prepares exact PR-head/base/check/tag/merge
    proof. Fresh publication spec and quality/security reviewers approve the
    immutable input before merge. Merge uses `--match-head-commit`; fresh
    post-merge spec and quality/security reviewers independently prove server
    parents/tree/OID and accepted-main binding.
18. A fresh metadata-token-cleanup implementer first obtains fresh spec and
    quality/security approval of exact accepted-main/provider state, revokes the
    dedicated token at Vercel, then deletes only
    `VERCEL_E2E_METADATA_TOKEN` at GitHub. Fresh post-cleanup spec and
    quality/security reviewers independently prove both absences, unchanged five
    application secrets/real-project state, and fail-closed workflow behavior.
    The committed evidence records the cleanup contract; timestamped live
    postconditions remain immutable provider/GitHub review evidence and do not
    cause an unreviewed post-merge source commit.
19. A fresh closure implementer resumes the existing owner-only archives, root
    11+1, and all-worktree closure contract, adding every provider/design
    worktree to live inventory. Fresh closure spec and quality/security reviewers
    pass the preflight before destructive actions and the postconditions after.
20. A fresh final-global reviewer pair performs specification review followed by
    quality/security review of the entire result: code, providers, deletion,
    bootstrap, credential quarantine/cleanup, Git history, accepted main, root,
    archives, and every worktree.

For every slice above, findings return to the same slice implementer and both
reviews restart from specification review. A later quality review never reuses
an earlier spec PASS after the tip or external state changes. Preflight
reviewers are read-only and never execute the irreversible mutation they
approve. No two implementers run in parallel, and review tasks do not silently
repair state.

## 11. Generation-2 publication binding

Generation-2 evidence must prove from Git that its predecessor generation is
exactly `1`, predecessor sealed head is exactly
`107bc717065b534fb71d009a969217cc573eb885`, and the new history contains the
reviewed provider commits, including intentional migration `0009`, without
moving the generation-1 tag. The exact new final tag is
`aais-recovery-final-head-20260710-2`; the post-merge binding is
`aais-recovery-accepted-main-20260710-2`. Evidence records the new provider tip,
provider evidence tip, trust-cleanup tip, pre-evidence compose tip, live main,
gate captures, and exact tag objects/peeled commits/trees. Neither tag is pushed
before its immutable input and evidence have passed both reviews, and the
accepted-main tag is not created before exact server merge proof.

The existing PR is reused for generation `2`. The only second-PR exception is
the exact two-path default-main bootstrap in section 5.3; it is sequentially
reviewed, merged/closed, and proved absent before PR `#5` advances. No other
second open PR is allowed. Immediately before the final merge, fetch live main
and re-query provider state. The merge uses the exact checked PR head and
`--match-head-commit`. Server result proof remains the existing two-parent/tree-
equality contract. Provider success does not weaken any rescue-inventory,
private-archive, no-writer, root-cleanup, or worktree-closure gate.

## 12. Acceptance criteria

The provider recovery is acceptable only when all of these are proven:

1. The design, implementation plan, and every execution/review slice in section
   10 have current sequential specification and quality/security PASS evidence.
2. The code slice changes only the 17 paths named in section 5.6; provider and
   generation evidence change only their two separately named artifacts during
   assigned phases. The bootstrap commit changes only paths 6 and 7 with exact
   reviewed content later contained in the 17-path integration; it adds no
   eighteenth path. Design/plan artifacts remain separately scoped commits.
3. Migration `0009` enforces case-insensitive uniqueness on `lower(id)`, fails
   on an existing collision, and has migration-ledger/rollback regression
   coverage.
4. Optional `accountId` parsing preserves default generated IDs and rejects
   case-insensitive payload collisions. One acquired client, one transaction,
   a transaction-scoped advisory lock, preflight, all user/enrollment writes,
   postconditions, commit/rollback, and the database unique index prove atomic
   concurrency behavior. No `Pool.query` pseudo-transaction remains.
5. Two independently generated strong credentials are used through
   `passwordEnv`; no weak exception, manual SQL, raw credential, or secret hash
   exists, and reports omit raw accounts/emails/passwords.
6. The Neon project is new, isolated, zero-charge, non-production, migrated
   through `0009`, and contains exactly the required synthetic identity/role and
   enrollment counts. A missing Neon credential or ambiguous cost stopped
   before creation rather than selecting a fallback.
7. Only the real `aais` project receives the four Preview runtime variables;
   every sensitive key/component record has target `preview` and exact
   `gitBranch=codex/aais-recovery-compose`. Pre/post metadata proves there is no
   same-name project-wide Preview, production, development, or other-branch
   leakage, and production environment metadata is unchanged. Unsupported
   branch scoping stopped rather than selecting another project or broader
   target.
8. SSO remains `all_except_custom_domains`; a newly generated real-project
   Automation Bypass is present; the in-memory same-origin bootstrap reaches
   AAIS and sets the context cookie without exposing any value or sending a
   bypass header cross-origin.
9. Stage A proves exact default-main workflow blob, repository, Vercel App
   identity, open same-repository PR `#5`, head/base ref and SHA, GitHub
   deployment/status/environment/URL, and no fork without a repository secret.
   Stage B uses only its step-scoped metadata token to prove exact Vercel
   project/team/deployment/Git source. Stage C proves checkout remote/HEAD; all
   five application/E2E secrets are scoped only to the trusted Playwright step,
   and the metadata token is absent.
10. External Preview E2E creates no trace, video, screenshot, HAR, HTML/blob/
    JUnit report, storage state, attachment, or retained output; post-run secret-
    bearing artifact count is exactly zero. Local E2E behavior remains covered.
11. The four weak legacy secret records were dual-reviewed and quarantined
    before bootstrap. All five strong application/E2E secret names later exist
    with current update timestamps, values remain masked, and deployed DB-first
    probes return `student` for the student account and `teacher` for the teacher
    account. The sixth metadata-token secret existed only for its reviewed
    pre-checkout step and is provider-revoked and GitHub-absent after recovery.
12. Expanded owner authorization explicitly covers deletion of the formerly
    nonempty accidental exact project and revocation of its one compromised
    bypass. Dual-reviewed metadata proves all other resource counts zero,
    deletion semantics revoke project-owned bypasses atomically, exact-ID
    deletion succeeds without handling the bypass value, post-delete lookups
    prove absence, real `aais` retains its exact reviewed pre-deletion bypass
    count and SSO mode, and only the matching local link is removed after
    owner-only preservation.
13. Focused tests, full `npm run ci` including production build,
    `npm run e2e`, strict `npm run hygiene:check`, and `git diff --check` pass on
    both the reviewed candidate where required and final generation-2 tree.
14. Candidate Preview E2E reports `11` expected and `0` unexpected before the
    seal; the exact sealed generation-2 head is freshly redeployed and again
    reports `11` expected, `0` unexpected, and zero secret-bearing artifacts.
15. The recovery-only PR/ref trust allowlist is absent from the final sealed
    tree; the generic same-repository gate dynamically proves PR `#5` for this
    deployment. With the recovery metadata token deleted, it fails closed before
    checkout; a later same-repository PR must provision a newly approved scoped
    metadata token rather than inherit recovery authority.
16. No production environment fingerprint, production database, built-in trial
    role, production trial policy, root rescue byte, or unaccepted worktree is
    changed.
17. Generation `1` evidence/tag remains immutable; generation `2` has its own
    final-head and accepted-main bindings; PR/merge/root cleanup follows the
    already-reviewed exact-main contract.
18. The temporary bootstrap PR was exact-scope, dual-reviewed before and after
    merge, and absent before PR `#5` advanced. Its reviewed default-main workflow
    source is in generation-2 ancestry and no hidden bootstrap branch or open PR
    remains.
19. Final-global dual review proves accepted main, provider state, metadata-token
    revocation/deletion, deleted accidental project, root cleanliness, archive
    integrity, and closure of every registered worktree without force or loss.

Any unexpected provider mutation, billing ambiguity, missing credential,
isolation doubt, secret exposure, scope drift, E2E mismatch, or external-state
drift stops before merge and root cleanup.

## 13. Rollback and failure behavior

- Code failure: leave the reviewed commits isolated, do not merge them, and
  return findings to the same implementer.
- Migration `0009` collision: roll back the migration transaction, record only
  count/status, and stop for data-owner remediation. Never auto-rename or delete
  an existing ID.
- Legacy-secret quarantine or bootstrap failure: do not restore the weak values.
  Leave PR `#5` open and root untouched; repair the exact two-path bootstrap in
  its dedicated branch, restart both reviews, and do not create any new secret.
- Stage-A or workflow-source mismatch: do not enter Stage B, expose no provider
  or application secret, run no checkout/package code, and return to bootstrap
  review. Stage-B metadata/schema/project mismatch: expose none of the five app
  secrets, run no checkout/package code, revoke/delete the dedicated metadata
  token if its scope or handling is suspect, and restart provider preflight.
- Metadata-token exposure or cleanup failure: revoke the exact dedicated token,
  delete its exact GitHub secret record when safe, retain fixed redacted
  metadata only, and stop. Never substitute an existing broad token. If
  provider revocation or GitHub absence cannot be proved, final closure stops
  for an owner/provider action.
- Neon creation or migration failure: stop using the database, preserve only
  redacted metadata, and do not point Vercel at it. Deleting the new project
  requires confirmation under its lifecycle rule.
- Vercel environment failure: remove only exact branch-scoped Preview record IDs
  created by this task after proving `gitBranch` and target. If branch scoping is
  unsupported or a same-name project-wide Preview record exists, create nothing,
  delete nothing, and stop for new owner/design review. Never delete by broad
  name or substitute project-wide Preview or a dedicated project.
- New real-project bypass failure or exposure: revoke it immediately,
  remove/rotate the GitHub bypass secret, keep SSO enabled, and stop Preview E2E
  until a reviewed replacement is installed.
- Secret-bearing Preview artifact: quarantine access to the runner output
  without opening or copying it, revoke/rotate all potentially captured
  passwords and the new real-project bypass, delete the artifact by exact run/
  artifact ID, and repeat review plus E2E with artifact count zero.
- Credential mismatch: do not restore the former short values. Regenerate two
  independent strong values, reseed through `passwordEnv`, update the exact
  GitHub secrets, and rerun role probes and E2E.
- Deployment or E2E failure: keep PR `#5` open, root 11+1 untouched, and every
  recovery worktree preserved. Provider checks may continue; merge and cleanup
  may not.
- Accidental-project ambiguity or failure to bind the recorded expanded
  authorization: do not delete or separately rotate anything. Record
  count-only metadata and return for an owner dashboard/provider decision.
  Never query, replay, or pass the compromised value.
- Unexpected production change: stop all mutations, revoke Preview bypass if
  needed, preserve redacted evidence, and restore only exact provider records
  changed by this task after a reviewed rollback decision.

Rollback is scoped and evidence-driven; it never uses a production copy as a
shortcut and never broadens deletion authority.

## 14. Ownership and non-goals

- S12 owns database-auth and seed semantics.
- S11 owns test coverage, deployed role proof, and the `11/0` E2E gate.
- S22 owns Neon/Vercel/GitHub provider mutations, billing checks, deployment,
  bootstrap publication, metadata-token lifecycle, and rollback.
- S10 owns operational documentation and redacted evidence structure.
- The existing recovery integration owner retains generation binding, PR merge,
  private archives, root cleanup, and worktree closure.

This slice does not redesign authentication, create human Preview users, alter
production credentials, add live AI/LRS/email/monitoring providers, disable SSO,
copy production data, weaken password policy, create paid infrastructure,
enable Vercel Trusted Sources, reuse a broad provider token without new owner
approval, change unrelated code, merge PR `#5`, clean root, or remove any
recovery worktree.
