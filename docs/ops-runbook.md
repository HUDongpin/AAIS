# AAIS Ops Runbook

The previous enterprise evidence runbook has been archived with the legacy tooling under `tools/release-legacy/`.

Use the active operations docs instead:

- `OPERATIONS.md` for local setup, deploy, migration, rollback, restore, and monitoring notes.
- `docs/release-checklist.md` for the one-page release checklist.
- `docs/ai-live-release-runbook.md` for live-only AI release-lock, canary,
  monitoring, retention, and rollback gates.
- `README.md` for the supported command surface.

Supported operational commands:

```bash
npm run ci
npm run e2e
npm run db:migrate
npm run smoke:prod
npm run release:verify-ai-live
```

## Production AI Boundary

The checked-in Qwen `qwen3.8-max` / DeepSeek `deepseek-v4-flash` release lock
is pending, so the current Production AI state is `RELEASE_BLOCKED`. Keep it
blocked until both exact live contracts, observed revisions, independently
signed/current evaluation manifests, and separate processor owner/DPA/data-
region approvals are complete. `AAIS_AI_EVAL_APPROVED=true` does not override a
missing digest, signature, freshness, locale, prompt/CA/guardrail hash, model,
revision, or runtime match.

Production A1/A2 is live-only; deterministic generation is limited to local/
development and hidden A3/A4 background work. Before promotion, the exact
immutable deployment must pass protected full readiness, all eight provider
probes, eight authenticated learner JSON/SSE canaries and their replays,
synthetic-session persistence plus privacy deletion/absence, and
`npm run release:verify-ai-live`. The external workflow binds the
immutable URL, full SHA, deployment id, config generation, source lock, both
manifest digests, operation-id derivation nonce, safe canary evidence, and
privacy evidence in a signed audit artifact. Missing secrets, a non-empty
synthetic session, persistence, or privacy cleanup fails without a skip; no
custom hook/self-report is accepted. The audit artifact
is retained for at most 30 days and is not a same-deployment runtime-readiness
input. Sentry and hosting/function logs must likewise be redacted and retained
for no more than 30 days. Follow the staged canary and exact-artifact rollback sequence in
`docs/ai-live-release-runbook.md`; neither a green build nor rollback alone is
delivery/recovery proof.
