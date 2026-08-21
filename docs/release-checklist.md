# AAIS Release Checklist

Use this checklist for staging and production releases.

## Before Merge

- [ ] `npm run ci` passes.
- [ ] `npm run e2e` passes.
- [ ] `npm run hygiene:check` passes with a configured Git remote, clean worktree, and no staged private artifacts.
- [ ] `git diff --check` passes.
- [ ] Dependency audit is clean in CI and Dependabot alerts are reviewed.
- [ ] Database changes have migrations in `migrations/postgres/`.
- [ ] No secrets, cookies, database URLs, or generated private reports are staged.
- [ ] Vercel production deploys are Git-connected to `main`; direct laptop production deploy permissions/tokens are disabled outside the repo.

## Staging

- [ ] Vercel preview or staging deployment is ready.
- [ ] Preview deployment Playwright workflow passed, or a staging `AAIS_E2E_BASE_URL=... npm run e2e` run passed with dedicated smoke accounts.
- [ ] Sentry env vars are present in staging when monitoring changes are being released.
- [ ] Staging Postgres migrations have been applied.
- [ ] Dedicated staging database users are seeded or verified with `npm run db:seed-users`, `/admin/users`, or OIDC mapping; no teacher/admin trial accounts are used.
- [ ] Restored-branch verification passed with `npm run verify:postgres-restore`.
- [ ] Privacy inventory and retention/processor/consent gates in `docs/privacy-data-inventory.md` are reviewed for any release that touches learner data, auth, LRS, monitoring, or providers.
- [ ] `npm run smoke:prod` passes against the staging URL using a dedicated smoke account and retired-demo credential rejection.
- [ ] Before a real cohort pilot, `npm run load:staging -- --approved --target-users 200 --concurrency 200` passes against staging/preview with dedicated student accounts.
- [ ] Any changed learner/dashboard flow was manually checked once.
- [ ] Responsive policy reviewed: login and learner cockpit pass the phone-width E2E smoke; teacher/admin operational routes are checked on tablet/desktop.
- [ ] If monitoring changed, a staging test client error and server/API error appear in Sentry with redacted details.
- [ ] The live-AI release-lock contract and synthetic probe have been rehearsed according to `docs/ai-live-release-runbook.md`; synthetic fixtures are not recorded as provider evaluation evidence.
- [ ] The source AI lock still says `RELEASE_BLOCKED` while any static provider
  evidence, signature, or processor approval is pending. Independently, the
  external promotion gate stays blocked while immutable-deployment binding,
  learner canaries, privacy cleanup, or the signed audit artifact is pending;
  no post-deploy receipt is fed back into same-deployment runtime readiness.

## Production

- [ ] Owner approves the release window.
- [ ] For any real cohort, owner has confirmed cohort age/region/institution, legal basis, retention values, consent flow, and Vercel/Neon/LRS/provider DPA plus data-region evidence.
- [ ] Production migrations, if any, are applied during the release window.
- [ ] Vercel production deployment is ready from the Git-connected `main` flow; `scripts/guard-vercel-production-deploy.mjs` passes in the Vercel build log.
- [ ] Production sets `AAIS_AI_RUNTIME_MODE=live-required`, which maps to the
  internal A1/A2 policy `require-live`; deterministic generation is
  limited to local/development and hidden A3/A4 work, and two-provider
  exhaustion produces an explicit typed learner error.
- [ ] The immutable candidate uses exact Qwen
  `https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions` /
  `qwen3.8-max` primary and enabled DeepSeek
  `https://api.deepseek.com/chat/completions` / `deepseek-v4-flash` secondary;
  both have thinking disabled, timeout 3000–12000 ms, zero retries, and an exact
  observed-revision digest.
- [ ] Qwen and DeepSeek have separate named owners, approved DPAs, processing/
  data-region decisions, data-use/model-training terms, retention/deletion
  terms, and prompt/attachment handling. A pending DeepSeek decision blocks
  promotion; disabling the required secondary is not a workaround.
- [ ] Primary and secondary signed evaluation manifests pass independently and
  match the source lock: canonical manifest digest, Ed25519 key/signature,
  endpoint/runtime/model/revision binding, eval suite/data, A1-A4 prompt
  contracts, CA background, guardrail, both locales, and a current window no
  longer than 30 days. Approval booleans alone are rejected.
- [ ] The bearer-protected full readiness report on the exact immutable staged
  Production URL reports `RELEASE_VERIFIED` and matches the reviewed full Git
  SHA, deployment id, config generation, lock id, and both manifest digests.
- [ ] All eight fixed `/api/system/ai-live-probe` ids pass on that same immutable
  deployment. Each wire response has exactly `status`, `role`,
  `modelFingerprint`, `evalManifestSha256`, `latencyMs`, and `diagnosticId`;
  `live` is emitted only after the requested role, observed model/revision,
  guardrail, and no-fallback contract verify internally.
- [ ] The dedicated empty synthetic learner passes A1/A2 × `zh-CN`/`en-US` ×
  JSON/SSE (eight formal guide requests). Every SSE stream has the exact single
  terminal sequence, every result is live/persisted, and the same operation-id
  replay returns identical content/receipt/budget without another charge.
- [ ] `GET /api/learning/session` proves exactly 16 canary guide messages.
  Owner export, Postgres deletion, and post-delete absence are then verified;
  the redacted signed evidence contains no token, cookie, prompt, provider body,
  model response, page HTML, or learner data.
- [ ] `npm run release:verify-ai-live` runs with every required
  `AAIS_RELEASE_*` immutable-identity, lock/manifest, Deployment Protection
  bypass, protected bearer, learner
  session/CSRF, Vercel attestation, unique audit nonce, and audit-signing input.
  Missing secrets, a non-empty synthetic session, metadata, privacy cleanup, or
  output fail; there is no hook, self-reported receipt, or skip-green path.
- [ ] The external Ed25519-signed release-audit artifact matches the exact
  immutable URL/full SHA/deployment id/config generation, source lock, both
  manifest digests, eight live-canary/replay records, and privacy deletion/
  absence evidence. It is retained for no more than 30 days and is not injected
  into same-deployment runtime readiness.
- [ ] Sentry and hosting/function-log provider settings are verified at a maximum 30-day retention; the redacted settings receipt contains no DSN, token, learner content, prompt, or response.
- [ ] `npm run smoke:prod` passes against `https://www.aais.site`, including retired-demo credential rejection.
- [ ] The candidate is promoted without rebuilding under the staged canary
  thresholds in the runbook; absence of sufficient samples is not success.
- [ ] Rollback target is the exact prior known-good deployment id/full SHA/config generation, not only a branch or alias.

## After Release

- [ ] Check Sentry issues, request errors, and Cron monitor status, or confirm the fallback error-log review.
- [ ] Check LRS outbox health.
- [ ] Record deployment URL, commit SHA, migration versions, and smoke result.
- [ ] Re-run protected readiness, all eight direct-provider probes, ordinary
  learner JSON/SSE canaries, and privacy cleanup through the production alias.
- [ ] Record the release-lock id, signed audit/receipt digests, redacted primary/
  secondary probe receipts, canary receipts, promotion window, and bounded
  post-promotion AI metrics.
- [ ] If rollback was required, re-prove alias-to-deployment binding, protected
  readiness, live probes, normal learner canaries, and privacy cleanup on the
  exact previous artifact; rollback alone is not recovery evidence.
