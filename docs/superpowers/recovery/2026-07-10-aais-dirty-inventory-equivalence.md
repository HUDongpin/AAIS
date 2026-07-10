# AAIS Dirty Inventory Equivalence Evidence

schema_version=2
evidence_generation=1
previous_evidence_generation=0
previous_evidence_tip=NONE
accepted_main_binding_tag=aais-recovery-accepted-main-20260710-1
acceptance_checkout_path=NONE
publication_head_branch=codex/aais-recovery-compose
publication_repo_path=/Users/dongpinhu/Desktop/AAIS/.worktrees/aais-recovery-compose
snapshot_path=/Users/dongpinhu/Desktop/AAIS-dirty-worktree-backups/20260710-145253-worktree-recovery-refresh
snapshot_mode=drwx------
snapshot_root_head=2fd93838281581a6996f6f7a8a6bca0d8d95e420
snapshot_recorded_origin_main=42e92a483842a2a601ecbdb10794a90c1f3eba1f
snapshot_root_tracked_vs_head_sha256=e3c385c8c57ddf582dad07fd9596476e13a3dcd231c1fef4b93979865d2e3211
snapshot_root_tracked_vs_recorded_main_sha256=bfc1c311ae90c8369d8feaa1bcbe69802b392cd5c7b259dddb23f8b6f8219b6c
snapshot_bobie_main_fix2_sha256=57b7f506362620e1c8f21eca9e15ec38482a70a957bcd975052f672e2a92ec74
snapshot_bobie_prod_fix_sha256=fe3bfd7c9d6709660033a1856bd549daec929da14f0aa230a7a4542716663460
snapshot_bobie_main_deploy_sha256=e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855
snapshot_migration_sha256=5460251a5560635b4b39229b22b360465ccfbb40b60c1812b3df4d9252ca98ce
bobie_commit_vs_base_sha256=892d373fe7a71ebf0a216e126511501ec0642c198c14fea12e679b3079a98603
session_source_tip=5e803c669b955abba8a3f6c1c665c5543875a21a
locked_source_tip=735011b3e002f6be46ff34f4a13c70834a69cfeb
daily_source_tip=ad2d5a05114b9f19297fcae4a232cc434c8b2f35
lrs_source_tip=33af4c30100f4c0ea02b765709eb83123e7b10ff
bobie_source_tip=1d97d16998e95a92ebecb3a69a2ad14c9e0a566c
reviewed_live_main_sha=42e92a483842a2a601ecbdb10794a90c1f3eba1f
root_tracked_vs_head_sha256=e3c385c8c57ddf582dad07fd9596476e13a3dcd231c1fef4b93979865d2e3211
root_vs_reviewed_live_main_sha256=bfc1c311ae90c8369d8feaa1bcbe69802b392cd5c7b259dddb23f8b6f8219b6c
compose_vs_reviewed_live_main_sha256=dd720af414067b43865a181ee0754a6063ea553a0e8c0de6c42b347d530fa4ee
reviewed_docs_tag=aais-recovery-docs-reviewed-20260710
reviewed_docs_tag_object=ca5ec2796e7d8fbda475b04d4fc01c53394fd0d7
reviewed_docs_tip=4b2ac001e23b6156b9203a0b3b66daccb7e3c9b7
reviewed_docs_tree=e7041948f5e33608099653a104e6a93c6940c383
policy_tip=6712be4bed6ce7a3023b6a44c141f817ae2d8102
compose_tip_before_evidence=b1dce0d401c41f3ff2607093e9404f4ec7a8ac62
gate_capture_dir=/tmp/aais-recovery-gates-b1dce0d401c41f3ff2607093e9404f4ec7a8ac62
final_head_binding_tag=aais-recovery-final-head-20260710-1
focused_file_count=8
focused_total_tests=147
focused_passed_tests=147
focused_failed_tests=0
full_total_tests=354
full_passed_tests=354
full_failed_tests=0
e2e_expected_tests=11
e2e_unexpected_tests=0
ci_status=PASS
build_status=PASS
hygiene_status=PASS
diff_check_status=PASS
clean_tree_status=PASS
production_trial_policy_status=PASS
rescued_behavior_status=PASS
secret_values_status=OMITTED

## Root Rescue Inventory

BEGIN_ROOT_INVENTORY
 M src/app/api/learning/ai-guide/route.ts
 M src/app/api/learning/scaffold/route.ts
 M src/lib/server/aais-learning-store.ts
 M src/lib/server/aais-lrs-client.ts
 M src/lib/server/aais-trial-accounts.ts
 M tests/aais-api-routes.test.ts
 M tests/aais-backend-store.test.ts
 M tests/aais-lrs-client.test.ts
 M tests/aais-session-revocations.test.ts
 M tests/auth-route.test.ts
 M tests/postgres-migrations.test.mjs
?? migrations/postgres/0008_ai_guide_daily_usage.sql
END_ROOT_INVENTORY

## Worktree Classifications

BEGIN_WORKTREE_CLASSIFICATIONS
/Users/dongpinhu/Desktop/AAIS|root-rescue|dirty-11-tracked-plus-1-untracked-root-private-untouched
/Users/dongpinhu/Desktop/AAIS/.worktrees/aais-daily-guide-budget|reviewed-source|tracked-untracked-clean-ignored-separate
/Users/dongpinhu/Desktop/AAIS/.worktrees/aais-locked-task-guard|reviewed-source|tracked-untracked-clean-ignored-separate
/Users/dongpinhu/Desktop/AAIS/.worktrees/aais-lrs-outbox-hardening|reviewed-source|tracked-untracked-clean-ignored-separate
/Users/dongpinhu/Desktop/AAIS/.worktrees/aais-recovery-compose|integration-owner|tracked-untracked-clean-ignored-separate
/Users/dongpinhu/Desktop/AAIS/.worktrees/aais-session-revocation-test|reviewed-source|tracked-untracked-clean-ignored-separate
/Users/dongpinhu/Desktop/AAIS/.worktrees/aais-worktree-recovery-design|reviewed-docs|tracked-untracked-clean-ignored-separate
/private/tmp/aais-bobie-main-deploy-20260710|accepted-duplicate|tracked-untracked-clean-ignored-separate
/private/tmp/aais-bobie-main-fix2-20260710|reviewed-source|tracked-untracked-clean-ignored-separate
/private/tmp/aais-bobie-prod-fix-20260710|accepted-duplicate|dirty-three-proven-files-private-archive-required
END_WORKTREE_CLASSIFICATIONS

## Intentional Deviations

BEGIN_DEVIATIONS
bobie|source behavior comes from 1d97d16; final auth coverage strengthens the root copy
daily|adds readiness and privacy paths and stricter durable database behavior
locked|preserves locked-task mutation rejection across shared store and route files
lrs|replaces batch-wide failure handling with per-row response validation
live-main|integrated when required and pinned by reviewed_live_main_sha
policy|reconciles learner fallback, disable, unique learner, teacher denial, admin denial, and retired credential behavior
session|root copy matched recorded main; reviewed deterministic source remains a non-first merge parent
shared-files|resolved by preserving all independently reviewed behaviors and rerunning focused plus full gates
END_DEVIATIONS

## Focused Test Files

BEGIN_FOCUSED_FILES
tests/aais-api-routes.test.ts
tests/aais-backend-store.test.ts
tests/aais-lrs-client.test.ts
tests/aais-session-revocations.test.ts
tests/auth-route.test.ts
tests/postgres-migrations.test.mjs
tests/readiness-route.test.ts
tests/smoke-prod.test.mjs
END_FOCUSED_FILES

## Conclusion

All refreshed root inventory paths were inspected against compose. The five reviewed source commits remain explicit merge parents; the policy reconciliation is separately committed; machine-readable focused, full, E2E, CI/build, hygiene, diff, and clean-tree gates passed. No rescued behavior was lost, and secret values were omitted.
