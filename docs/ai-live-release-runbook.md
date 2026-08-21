# AAIS Production Live-AI Release Runbook

This runbook governs learner-visible A1/A2 AI delivery. Production is strictly
`require-live`. A1/A2 may return only a verified live Qwen or DeepSeek result,
or an explicit typed error after the two-provider chain is exhausted.
Deterministic generation is permitted only in local/development work and hidden
A3/A4 background processing; it is never a Production A1/A2 response, canary
success, readiness success, or release-gate success.

## Current Evidence Boundary

The source-controlled lock at
`src/data/aais-ai-production-release-lock.json` remains intentionally
`releaseStatus: blocked`. It names exact intended targets, Qwen
`qwen3.8-max` as primary and DeepSeek `deepseek-v4-flash` as secondary. The
DeepSeek secondary now has a current, independently signed formal evaluation
manifest and a dated Owner processor/privacy approval. Its manifest is
`docs/evidence/aais-ai-eval-deepseek-v4-flash-2026-08-21.json`; the detached
public signing receipt is
`docs/evidence/aais-ai-eval-deepseek-v4-flash-signing-receipt-2026-08-21.json`.
Qwen remains pending because the observed DashScope response reported the exact
model but no revision fingerprint under the required runtime contract. The
privacy receipt, learner-canary receipt, and external release-audit receipt are
also still pending.

Therefore the current honest state remains `RELEASE_BLOCKED`. A build, HTTP 200,
Vercel `READY`, `AAIS_AI_EVAL_APPROVED=true`, synthetic fixture, unsigned JSON,
or successful deterministic response cannot change it. Do not fill pending lock
fields with placeholders or copy evidence from an older model/revision.

## Exact Production Runtime Contract

Configure the exact values below on the immutable Production candidate. Any
missing, partial, aliased, or mismatched field blocks the role independently.

| Role | Required contract |
| --- | --- |
| Primary | `AAIS_AI_PROVIDER=qwen`; `AAIS_AI_ENDPOINT=https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions`; `AAIS_AI_MODEL=qwen3.8-max`; `AAIS_AI_THINKING_MODE=disabled`; `AAIS_AI_TIMEOUT_MS` between 3000 and 12000 inclusive; `AAIS_AI_MAX_RETRIES=0`; exact `AAIS_AI_OBSERVED_REVISION_SHA256` |
| Secondary | `AAIS_AI_FALLBACK_ENABLED=true`; `AAIS_AI_FALLBACK_PROVIDER=deepseek`; `AAIS_AI_FALLBACK_ENDPOINT=https://api.deepseek.com/chat/completions`; `AAIS_AI_FALLBACK_MODEL=deepseek-v4-flash`; `AAIS_AI_FALLBACK_THINKING=false` (runtime profile: `disabled`); `AAIS_AI_FALLBACK_TIMEOUT_MS` between 3000 and 12000 inclusive; `AAIS_AI_FALLBACK_MAX_RETRIES=0`; exact `AAIS_AI_FALLBACK_OBSERVED_REVISION_SHA256` |

Production also requires `AAIS_AI_RUNTIME_MODE=live-required`, which maps to
the internal `require-live` delivery policy. Provider API
keys stay only in the approved secret store. The observed-revision values are
SHA-256 digests over the domain-separated exact response
`system_fingerprint`; never store or report the raw fingerprint. A missing
fingerprint, observed-model mismatch, revision mismatch, timeout, authentication
failure, payment failure, invalid response, guardrail block, or route deadline
is a failed live attempt, not permission to render deterministic guidance.

Each provider receives one attempt only (`maxRetries=0`), and the protected
probe has a hard deadline no greater than 30 seconds. Runtime inference uses
thinking disabled, temperature `0.2`, and at most 600 output tokens. Those
values, plus the endpoint fingerprint, must match the signed evaluation
evidence and the source release lock exactly.

## Signed Evaluation Evidence

Primary and secondary evidence are independent. For each role, the operator
must provide all of the following from an approved evaluation run:

- the exact observed model and observed-revision SHA-256;
- endpoint fingerprint, thinking mode, temperature, and maximum-token contract;
- evaluation version, suite digest, and data digest;
- A1, A2, A3, and A4 prompt-contract digests;
- Cognitive Apprenticeship background and guardrail digests;
- complete `zh-CN` and `en-US` coverage for every A1-A4 contract;
- canonical `passedAt` and `expiresAt` timestamps with a current evidence
  window no longer than 30 calendar days;
- an Ed25519 attestation with reviewed key id and a pinned canonical DER SPKI
  verification key;
- the canonical manifest SHA-256.

Configure the primary manifest with
`AAIS_AI_EVAL_MANIFEST_PATH` (or the controlled inline JSON mechanism),
`AAIS_AI_EVAL_MANIFEST_SHA256`, `AAIS_AI_EVAL_SIGNING_KEY_ID`, and
`AAIS_AI_EVAL_VERIFYING_KEY_SPKI`. Use the corresponding
`AAIS_AI_FALLBACK_EVAL_*` variables for DeepSeek. The compatibility switches
`AAIS_AI_EVAL_APPROVED` and `AAIS_AI_FALLBACK_EVAL_APPROVED` must be true only
after review, but they cannot bypass digest, signature, freshness, locale,
agent-contract, runtime, model, or revision verification.

An expired manifest has fixed status `expired` and blocks its role. Re-run and
re-sign the exact evaluation; do not extend a timestamp or reuse an attestation.

Use the repository signer only after the reviewed unsigned manifest contains
the complete evidence above. The private key is an operator input and must not
be placed in Vercel, the repository, the unsigned manifest, shell history, or
the receipt:

```bash
npm run release:evaluate-ai -- \
  --provider <qwen-or-deepseek> \
  --model <exact-model> \
  --endpoint <approved-endpoint> \
  --env-file <mode-0600-provider-env> \
  --eval-version <unique-eval-version> \
  --output <new-mode-0600-unsigned-manifest>

AAIS_AI_MANIFEST_INPUT_PATH=<reviewed-unsigned-json> \
AAIS_AI_MANIFEST_OUTPUT_PATH=<new-signed-json> \
AAIS_AI_MANIFEST_RECEIPT_PATH=<new-signing-receipt-json> \
AAIS_AI_MANIFEST_EXPECTED_PROVIDER=<qwen-or-deepseek> \
AAIS_AI_MANIFEST_EXPECTED_MODEL=<exact-observed-model> \
AAIS_AI_MANIFEST_EXPECTED_REVISION_SHA256=<exact-observed-revision-digest> \
AAIS_AI_MANIFEST_SIGNING_KEY_ID=<reviewed-key-id> \
AAIS_AI_MANIFEST_SIGNING_KEY_PKCS8=<base64-der-pkcs8-ed25519-key> \
npm run release:sign-ai-manifest
```

The command requires distinct A1-A4 sample ids for both locales, all source
digests, exact provider/model/revision binding, zero blocked cases, and a live
evidence window no longer than 30 days. It derives the canonical manifest
digest and public SPKI evidence, self-verifies the Ed25519 signature, omits the
private key and model content, and creates both output files with exclusive
write semantics. Any incomplete evidence, wrong key type, stale window,
pre-existing attestation, or existing output path blocks signing. Run the
signed manifest through protected readiness before it can be approved.

The formal evaluator sends exactly eight fixed synthetic samples covering A1–A4
in `zh-CN` and `en-US`, with two requests in flight at most, one provider
attempt per sample, thinking disabled, temperature `0.2`, configured maximum
600 output tokens, and a 12-second per-sample deadline. It emits no prompt,
output, credential, or raw revision. It fails without creating an output when
the exact reported model mismatches, the revision is absent or unstable, any
guardrail blocks, or any sample fails.

## Processor And Privacy Prerequisites

Qwen/DashScope and DeepSeek are separate processors and need separate written
entries in `docs/privacy-data-inventory.md`. For each, record the accountable
owner, DPA/data-processing terms, data-use/model-training terms, processing and
storage region, retention/deletion behavior, subprocessor terms, prompt and
attachment handling, incident contact, and budget controls.

DeepSeek is the mandatory Production secondary. If its named owner, DPA, or
processing/data-region decision is pending, Production promotion is blocked;
disabling fallback is not an acceptable workaround. The same fail-closed rule
applies to unresolved Qwen governance.

Before promotion, verify Sentry and hosting/function-log provider consoles are
configured for no more than 30 calendar days of retention, Session Replay is
disabled, and diagnostics contain no learner identity, prompt, attachment text,
response text, provider body, endpoint, cookie, authorization header, or
credential. Preserve only a redacted settings/privacy receipt digest. An env
value that says `30` is configuration intent, not provider-console evidence.

## Required Static Gate

Retrieve the bearer-protected full `/api/system/readiness` report from the exact
immutable staged Production URL. The public route exposes only overall status
and is insufficient for release diagnosis. Require on the same deployment:

- exact immutable URL, Vercel deployment id, full 40-character reviewed Git
  SHA, and config generation;
- `AAIS_AI_RUNTIME_MODE=live-required` and both exact runtime contracts above;
- independently verified primary and secondary signed manifests;
- both provider evidence projections matching the source-controlled lock;
- current processor/privacy approvals and the redacted privacy receipt;
- source lock and runtime gate state `RELEASE_VERIFIED`;
- no unrelated application/readiness issue.

If the source lock is still pending, a manifest/signature is missing or stale,
or a processor approval remains pending, stop with `RELEASE_BLOCKED`. Do not run
the traffic promotion as a way to discover whether the static gate was real.

## Protected Synthetic Live Probes

`POST /api/system/ai-live-probe` accepts only the dedicated
`AAIS_AI_LIVE_PROBE_BEARER_TOKEN` and exactly one fixed `syntheticId`. It does
not authenticate a learner, reserve or consume learner quota, create a learner
session, persist prompt/output, or return raw model output.

Run all eight ids against the same immutable candidate:

- `aais-live-primary-a1-zh-v1`
- `aais-live-primary-a1-en-v1`
- `aais-live-primary-a2-zh-v1`
- `aais-live-primary-a2-en-v1`
- `aais-live-secondary-a1-zh-v1`
- `aais-live-secondary-a1-en-v1`
- `aais-live-secondary-a2-zh-v1`
- `aais-live-secondary-a2-en-v1`

Supply the token through the approved secret channel; never paste it into a
report, shell history, screenshot, issue, or CI artifact. The HTTP response has
an exact minimal schema only: `status`, `role`, `modelFingerprint`,
`evalManifestSha256`, `latencyMs`, and `diagnosticId`. A `live` result is emitted
only after the requested role, observed model, observed revision, output
guardrail, and single-attempt contract verify internally. Deployment id, full
Git SHA, config generation, lock id, and expanded fixed-taxonomy diagnostics
come from protected readiness and the internal diagnostic sink, not the probe
wire. Any extra response field, 4xx/5xx, latency over 30 seconds, missing
observation, role substitution, mismatch, fallback, or guardrail block fails
the gate.

These probes prove direct provider delivery under fixed synthetic inputs. They
do not prove learner authentication, quota, persistence, JSON delivery, SSE
stream completion, UI state, or deletion.

## Normal Learner JSON, SSE, And Privacy Canaries

Using a dedicated synthetic learner on the immutable candidate, exercise the
ordinary authenticated `/api/learning/ai-guide` path eight times: A1/A2 ×
`zh-CN`/`en-US` × JSON/SSE. Each JSON response must contain exactly the selected
visible agent and a persisted live receipt. Each SSE response must contain one
acknowledgement, one selected-agent start, one or more deltas, one agent-done,
one delivery, and exactly one final `done`, with no error/fallback/extra terminal.

The verifier first requires `GET /api/learning/privacy` to prove that the
dedicated synthetic account has no learner data, then creates the session via
`POST /api/learning/session`. Every operation id is derived from the full SHA,
deployment id, config generation, canary id, and unique audit nonce. It replays
the same operation id once and requires identical content, delivery receipt,
and budget state, proving `charged-once`. It then checks exactly 16 persisted
guide messages through `GET /api/learning/session`, verifies the owner privacy
export, deletes the learner data through `DELETE /api/learning/privacy`, and
verifies post-delete absence. The signed artifact stores only safe enums,
synthetic operation ids, correlations, and digests—not credentials, cookies,
prompts, model responses, page HTML, or learner data.

## Executable External Release Gate

After the exact immutable candidate exists, run:

```bash
npm run release:verify-ai-live
```

The command is an external, after-deployment promotion gate. It requires every
input below; a missing, empty, malformed, unreachable, expired, or mismatched
value fails the command. There is no optional hook and no skip-green mode.

| Purpose | Required workflow variables |
| --- | --- |
| Immutable identity | `AAIS_RELEASE_IMMUTABLE_URL`, `AAIS_RELEASE_DEPLOYMENT_ID`, `AAIS_RELEASE_GIT_COMMIT_SHA`, `AAIS_RELEASE_CONFIG_GENERATION` |
| Reviewed AI evidence | `AAIS_RELEASE_EXPECTED_LOCK_ID`, `AAIS_RELEASE_PRIMARY_MANIFEST_SHA256`, `AAIS_RELEASE_SECONDARY_MANIFEST_SHA256` |
| Protected candidate access and system checks | `AAIS_RELEASE_VERCEL_PROTECTION_BYPASS_SECRET`, `AAIS_RELEASE_READINESS_BEARER_TOKEN`, `AAIS_RELEASE_LIVE_PROBE_BEARER_TOKEN`; all three must be strong and distinct |
| Formal learner authentication | `AAIS_RELEASE_LEARNER_SESSION_COOKIE`, `AAIS_RELEASE_LEARNER_CSRF_TOKEN`, and `AAIS_RELEASE_SYNTHETIC_ACTOR_FINGERPRINT_SHA256` for one dedicated empty, explicitly allowlisted synthetic student account |
| Vercel attestation | `AAIS_RELEASE_VERCEL_API_TOKEN`, `AAIS_RELEASE_VERCEL_TEAM_ID`, `AAIS_RELEASE_VERCEL_PROJECT_ID` |
| Signed audit output | `AAIS_RELEASE_AUDIT_SIGNING_KEY_ID`, `AAIS_RELEASE_AUDIT_SIGNING_KEY_PKCS8`, unique `AAIS_RELEASE_AUDIT_NONCE`, `AAIS_RELEASE_AUDIT_RECEIPT_PATH` |

The verifier confirms Vercel's immutable deployment id, project/team, full Git
SHA, and config generation; fetches bearer-protected readiness; runs all eight
fixed provider probes; executes all eight formal learner canaries plus their
same-operation replays; verifies session persistence, owner export, Postgres
deletion, and absence; and writes an Ed25519-signed redacted audit artifact. It
must not print or persist bearer
tokens, API keys, the private signing key, cookies, prompts, provider bodies,
model responses, learner data, or full canary response bodies.

Every request to the immutable candidate origin carries the dedicated Vercel
Deployment Protection bypass header, including readiness, probes, formal
session/guide calls, export, deletion, and absence checks. The Vercel API call
does not receive that header. The bypass secret is mandatory, distinct from the
readiness/probe credentials, and excluded from logs and the signed receipt.
Before sending any learner prompt or issuing `DELETE /api/learning/privacy`, the
verifier hashes the authenticated session/export actor claim with the fixed
`aais-ai-release-synthetic-actor-v1` domain and compares it with the required
allowlisted fingerprint. A wrong or missing actor blocks the gate without a
guide request or deletion; neither the actor id nor its configured fingerprint
is written to the audit receipt.

The signed audit artifact is retained for no more than 30 calendar days. It is
external release evidence only. Because it is produced after the immutable
deployment is running, it must never be injected into that deployment or used
as a same-deployment runtime-readiness dependency. It also cannot convert a
pending source lock, unsigned/expired manifest, or pending processor approval
into `RELEASE_VERIFIED`.

The receipt embeds the public Ed25519 SPKI and its SHA-256 digest, so an auditor
can verify the signature from the downloaded artifact without access to the
signer. The current public audit-key record is
`docs/evidence/aais-ai-production-audit-key-2026-08-21.json`; the matching
private key exists only as a secret in the protected
`production-ai-release` GitHub Environment.

## Staged Promotion And Canary

1. Record the immutable candidate deployment id/full SHA/config generation and
   exact previous known-good deployment id/full SHA/config generation.
2. Keep the production alias off the candidate until protected readiness, both
   manifests, eight probes, learner JSON/SSE canaries, privacy cleanup, and the
   external signed release-audit command all verify for that immutable
   deployment.
3. If controlled rolling traffic is available, use
   `0% -> 5% -> 25% -> 100%`. Hold 5% for at least 30 minutes and 100 completed
   live turns; hold 25% for at least 60 minutes and 500 completed live turns.
   With lower traffic, extend the window—absence of samples is not success.
4. During the first 100 turns, any secondary-provider failover,
   learner-visible deterministic result, wrong model/revision/eval fingerprint,
   or privacy breach stops the rollout.
   Thereafter stop when a five-minute window has provider/stream errors above
   1% with at least 20 requests, three consecutive failures, or p95 latency
   above both the approved limit and twice the known-good baseline for two
   consecutive windows.
5. Promote the exact verified artifact without rebuilding. Re-run protected
   readiness, all eight direct-provider probes, learner JSON/SSE canaries, and
   privacy cleanup through the production alias; observe for at least 30
   minutes.

## Monitoring And 30-Day Retention

Permitted AI diagnostics are low-cardinality and redacted: deployment/full SHA,
config generation, provider role, A1/A2, locale, model/revision match status,
manifest digest, outcome/reason enum, at most two provider-attempt summaries,
attempt count, latency bucket, and random correlation id. They must never
contain learner identity, prompt, attachment text, response text, provider body,
endpoint, cookie, authorization header, credential, or free-form exception.

Configure Sentry event retention and hosting/function-log retention to a
maximum of 30 calendar days. A shorter legal, institution, incident-response,
or provider rule takes precedence. Alert immediately on configuration,
evaluation, observed-model/revision, signature, or privacy mismatch. Treat a
monitoring gap as unknown/blocking, not green.

## Rollback

Rollback points production domains to the exact previous known-good Vercel
deployment without rebuilding. Verify alias-to-deployment binding, protected
readiness, all eight direct-provider probes, normal JSON/SSE learner canaries,
and privacy cleanup again. Record candidate and rollback deployment ids, full SHAs, config
generations, lock ids, signed audit/receipt digests, probe results, timestamps, and
the bounded telemetry window.

An external credential revocation, payment problem, processor suspension, or
provider outage may affect both deployments. In that case rollback is not
recovery evidence: repair the external condition, create a new immutable
candidate, and repeat every gate. Application rollback does not undo a schema
migration, so database changes must remain expand/contract compatible.
