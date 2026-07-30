#!/usr/bin/env node

import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { readFile, writeFile, chmod } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { Pool } from "pg";

const execFileAsync = promisify(execFile);
const modulePath = import.meta.url.startsWith("file:")
  ? fileURLToPath(import.meta.url)
  : null;
const repositoryRoot = modulePath
  ? path.resolve(path.dirname(modulePath), "..")
  : process.cwd();
export const aaisBrowserResearchEventNames = Object.freeze([
  "workspace_session_load", "client_connectivity", "account_menu_toggled",
  "learner_data_export", "learner_data_delete", "account_logout",
  "content_tab_selected", "content_item_opened", "content_item_back",
  "history_document_opened", "panel_resize_completed", "guide_quick_start_selected",
  "guide_attachment_picker_opened", "guide_attachment_add", "guide_attachment_removed",
  "ai_guide_submit", "guide_response_link_opened", "document_artifact_save",
  "document_title_committed", "editor_format_applied", "document_save_closed",
  "document_download",
]);
const researchEventNames = new Set(aaisBrowserResearchEventNames);
const researchOutcomes = new Set([
  "attempted", "success", "failure", "retry", "disconnected",
]);

if (isDirectInvocation()) {
  await main();
}

async function main() {
const options = readOptions(process.argv.slice(2));
const researchUrl = process.env.AAIS_RESEARCH_RECONCILIATION_DATABASE_URL?.trim();
const productUrl = process.env.AAIS_PRODUCT_RECONCILIATION_DATABASE_URL?.trim();
if (!researchUrl || !productUrl) {
  throw new Error(
    "AAIS_RESEARCH_RECONCILIATION_DATABASE_URL and "
      + "AAIS_PRODUCT_RECONCILIATION_DATABASE_URL are required.",
  );
}

const manifest = JSON.parse(await readFile(options.manifest, "utf8"));
const observed = JSON.parse(await readFile(options.observedVisits, "utf8"));
const transport = JSON.parse(await readFile(options.transportSummary, "utf8"));
assertManifestShape(manifest, observed);
const transportValidation = validateTransportSummary(transport);
const runtimeBuildAttestation = await readRuntimeBuildAttestation(
  options.runtimeBuildAttestation,
  manifest,
);
const externalLrsAttestation = await readExternalLrsAttestation(
  options.externalLrsAttestation,
  manifest,
);

const scope = [
  manifest.project_id,
  manifest.study_id,
  manifest.environment,
  manifest.lrs_namespace,
];
const research = new Pool({ connectionString: researchUrl, max: 1 });
const product = new Pool({ connectionString: productUrl, max: 1 });

try {
  const [
    eventsResult,
    visitsResult,
    researchCountsResult,
    outboxResult,
    setDifferenceResult,
    invariantResult,
    sequenceResult,
    identityResult,
    ownershipResult,
    productResult,
    lrsCounter,
  ] = await Promise.all([
    research.query(
      `select event_id::text, client_event_id::text, participant_id::text,
              study_run_id::text,
              visit_id::text, event_sequence::integer, event_name, outcome,
              retry_count, disconnect_count, ai_latency_ms, client_time,
              server_received_at, condition, schema_version, app_version,
              commit_sha, detail, lrs_eligible
         from aais_research_events
        where project_id = $1 and study_id = $2 and environment = $3
          and lrs_namespace = $4
        order by visit_id, event_sequence`,
      scope,
    ),
    research.query(
      `select participant_id::text, study_run_id::text, visit_id::text,
              condition, status, started_at
         from aais_research_visits
        where project_id = $1 and study_id = $2 and environment = $3
          and lrs_namespace = $4
        order by started_at`,
      scope,
    ),
    research.query(
      `select
         (select count(*)::integer from aais_research_participants
           where project_id = $1 and study_id = $2 and environment = $3
             and lrs_namespace = $4) as participant_count,
         (select count(*)::integer
            from aais_research_identity.aais_research_identity_map
           where project_id = $1 and study_id = $2 and environment = $3
             and lrs_namespace = $4) as identity_map_count,
         (select count(*)::integer
            from aais_research_identity.aais_research_participation_ledger
           where project_id = $1 and study_id = $2 and environment = $3
             and lrs_namespace = $4) as participation_ledger_count`,
      scope,
    ),
    research.query(
      `select event_id::text, statement_id::text, status, lrs_eligible, payload
         from aais_research_lrs_outbox
        where project_id = $1 and study_id = $2 and environment = $3
          and lrs_namespace = $4
        order by event_id`,
      scope,
    ),
    research.query(
      `select count(*)::integer as difference_count from (
         (select event_id from aais_research_events
           where project_id = $1 and study_id = $2 and environment = $3
             and lrs_namespace = $4 and lrs_eligible = true
          except
          select event_id from aais_research_lrs_outbox
           where project_id = $1 and study_id = $2 and environment = $3
             and lrs_namespace = $4 and lrs_eligible = true)
         union all
         (select event_id from aais_research_lrs_outbox
           where project_id = $1 and study_id = $2 and environment = $3
             and lrs_namespace = $4 and lrs_eligible = true
          except
          select event_id from aais_research_events
           where project_id = $1 and study_id = $2 and environment = $3
             and lrs_namespace = $4 and lrs_eligible = true)
       ) differences`,
      scope,
    ),
    research.query(
      `select
         count(*) filter (where
           participant_id is null or study_run_id is null or visit_id is null
           or project_id <> $1 or study_id <> $2 or environment <> $3
           or lrs_namespace <> $4 or condition = '' or schema_version <> 1
           or app_version = '' or commit_sha !~ '^[0-9A-Fa-f]{7,64}$'
           or event_sequence < 1 or client_time is null
           or server_received_at is null)::integer as required_field_violations,
         count(*) filter (where not aais_research_detail_is_safe(detail))::integer
           as controlled_metadata_violations,
         count(*) filter (where detail ?| array[
           'prompt', 'learner_input', 'artifact_text', 'self_report',
           'message', 'text', 'raw_text'
         ])::integer as forbidden_detail_key_violations,
         count(*) filter (where detail::text like any(array[
           '%请帮我明确这个学习任务的目标%',
           '%请示范一次元认知思考过程%',
           '%我卡住了，想要一个支架提示%'
         ]))::integer as known_raw_text_fixture_occurrences
       from aais_research_events
      where project_id = $1 and study_id = $2 and environment = $3
        and lrs_namespace = $4`,
      scope,
    ),
    research.query(
      `select count(*)::integer as violation_count from (
         select visit_id
           from aais_research_events
          where project_id = $1 and study_id = $2 and environment = $3
            and lrs_namespace = $4
          group by visit_id
         having min(event_sequence) <> 1
             or max(event_sequence) <> count(*)
             or count(distinct event_sequence) <> count(*)
       ) violations`,
      scope,
    ),
    research.query(
      `select count(*) filter (where octet_length(ciphertext) > 0
                                  and octet_length(iv) = 12
                                  and octet_length(authentication_tag) = 16
                                  and key_version <> '')::integer as valid_ciphertext_rows
         from aais_research_identity.aais_research_identity_map
        where project_id = $1 and study_id = $2 and environment = $3
          and lrs_namespace = $4`,
      scope,
    ),
    research.query(
      `select
         (select count(*)::integer
            from aais_research_events e
            left join aais_research_visits v
              on v.visit_id = e.visit_id
             and v.project_id = e.project_id
             and v.study_id = e.study_id
             and v.environment = e.environment
             and v.lrs_namespace = e.lrs_namespace
           where e.project_id = $1 and e.study_id = $2 and e.environment = $3
             and e.lrs_namespace = $4
             and (v.visit_id is null
               or e.participant_id is distinct from v.participant_id
               or e.study_run_id is distinct from v.study_run_id
               or e.condition is distinct from v.condition))
           as event_visit_mismatches,
         (select count(*)::integer
            from aais_research_visits v
            left join aais_research_participants p
              on p.participant_id = v.participant_id
             and p.project_id = v.project_id
             and p.study_id = v.study_id
             and p.environment = v.environment
             and p.lrs_namespace = v.lrs_namespace
           where v.project_id = $1 and v.study_id = $2 and v.environment = $3
             and v.lrs_namespace = $4 and p.participant_id is null)
           as visit_participant_mismatches,
         (select count(*)::integer
            from aais_research_identity.aais_research_identity_map i
            left join aais_research_participants p
              on p.participant_id = i.participant_id
             and p.project_id = i.project_id
             and p.study_id = i.study_id
             and p.environment = i.environment
             and p.lrs_namespace = i.lrs_namespace
           where i.project_id = $1 and i.study_id = $2 and i.environment = $3
             and i.lrs_namespace = $4 and p.participant_id is null)
           as identity_participant_mismatches,
         (select count(*)::integer
            from aais_research_identity.aais_research_participation_ledger a
            left join aais_research_visits v
              on v.visit_id = a.visit_id
             and v.participant_id = a.participant_id
             and v.study_run_id = a.study_run_id
             and v.project_id = a.project_id
             and v.study_id = a.study_id
             and v.environment = a.environment
             and v.lrs_namespace = a.lrs_namespace
            left join aais_research_participants p
              on p.participant_id = a.participant_id
             and p.project_id = a.project_id
             and p.study_id = a.study_id
             and p.environment = a.environment
             and p.lrs_namespace = a.lrs_namespace
           where a.project_id = $1 and a.study_id = $2 and a.environment = $3
             and a.lrs_namespace = $4
             and (v.visit_id is null or p.participant_id is null))
           as ledger_visit_participant_mismatches`,
      scope,
    ),
    product.query(
      `select
         (select count(*)::integer from aais_learner_sessions) as learner_sessions,
         (select count(*)::integer from aais_events) as generic_events,
         (select count(*)::integer from aais_lrs_outbox) as generic_outbox,
         (select count(*)::integer from aais_research_events) as misplaced_research_events,
         (select count(*)::integer from aais_session_revocations) as session_revocations`,
    ),
    readLrsCounter(options.lrsCounterUrl),
  ]);

  const visits = visitsResult.rows;
  const events = eventsResult.rows;
  const outbox = outboxResult.rows;
  const observedBySlot = new Map(observed.participants.map((item) => [item.slot, item]));
  const expectedOrderedEvents = manifest.participants.flatMap((participant) => {
    const visit = observedBySlot.get(participant.slot);
    return participant.expected_events.map((event) => ({
      slot: participant.slot,
      visit_id: visit.visit_id,
      sequence: event.sequence,
      event_name: event.event_name,
      outcome: event.outcome,
    }));
  });
  const slotByVisit = new Map(
    observed.participants.map((item) => [item.visit_id, item.slot]),
  );
  const actualOrderedEvents = events
    .map((event) => ({
      slot: slotByVisit.get(event.visit_id) ?? "unknown",
      visit_id: event.visit_id,
      sequence: event.event_sequence,
      event_name: event.event_name,
      outcome: event.outcome,
    }))
    .sort(compareManifestEvent);
  const exactManifestMatch = JSON.stringify(actualOrderedEvents)
    === JSON.stringify([...expectedOrderedEvents].sort(compareManifestEvent));
  const visitIdentityMatch = observed.participants.every((item) =>
    visits.some((visit) =>
      visit.participant_id === item.participant_id
        && visit.study_run_id === item.study_run_id
        && visit.visit_id === item.visit_id
        && visit.condition === item.condition));
  const researchCounts = researchCountsResult.rows[0];
  const invariants = invariantResult.rows[0];
  const productCounts = productResult.rows[0];
  const expectedCount = manifest.counting_contract.expected_semantic_event_records;
  const eligibleCount = events.filter((event) => event.lrs_eligible).length;
  const pendingOutboxCount = outbox.filter((row) => row.status === "pending").length;
  const setDifference = setDifferenceResult.rows[0].difference_count;
  const ownership = ownershipResult.rows[0];
  const outboxPayload = compareOutboxPayloads(outbox, events, {
    projectId: manifest.project_id,
    studyId: manifest.study_id,
    environment: manifest.environment,
    lrsNamespace: manifest.lrs_namespace,
    lrsStoreId: manifest.lrs_store_id,
  });
  const transportIdentity = compareTransportAcknowledgements(
    transportValidation.acknowledgements,
    events,
  );
  const equality = exactManifestMatch
    && transportValidation.acknowledgementCount === expectedCount
    && expectedCount === events.length
    && events.length === eligibleCount
    && eligibleCount === outbox.length
    && setDifference === 0;
  const eventNames = countBy(events, "event_name");
  const outcomes = countBy(events, "outcome");
  const conditions = countBy(visits, "condition");
  const startedTimes = visits.map((visit) => new Date(visit.started_at).toISOString());
  const receivedTimes = events.map((event) => new Date(event.server_received_at).toISOString());
  const contractCoverage = evaluateContractCoverage(events);
  const requiredOutcomeCoverageGate = Boolean(outcomes.success)
    && Boolean(outcomes.failure)
    && Boolean(outcomes.retry)
    && Boolean(outcomes.disconnected);
  const aiLatencyCoverageGate = events.some((event) => event.ai_latency_ms !== null);
  const connectivityRecoveryGate = hasOrderedConnectivityRecovery(events);
  const coverageGate = contractCoverage.complete
    && requiredOutcomeCoverageGate
    && aiLatencyCoverageGate
    && connectivityRecoveryGate;
  const participantGate = manifest.participant_count >= 3
    && manifest.participant_count <= 5
    && researchCounts.participant_count === manifest.participant_count
    && researchCounts.identity_map_count === manifest.participant_count
    && researchCounts.participation_ledger_count === manifest.participant_count
    && visits.length === manifest.participant_count
    && new Set(visits.map((row) => row.participant_id)).size === manifest.participant_count
    && new Set(visits.map((row) => row.study_run_id)).size === manifest.participant_count
    && new Set(visits.map((row) => row.visit_id)).size === manifest.participant_count
    && visitIdentityMatch
    && identityResult.rows[0].valid_ciphertext_rows === manifest.participant_count;
  const ownershipGate = ownership.event_visit_mismatches === 0
    && ownership.visit_participant_mismatches === 0
    && ownership.identity_participant_mismatches === 0
    && ownership.ledger_visit_participant_mismatches === 0;
  const invariantGate = invariants.required_field_violations === 0
    && invariants.controlled_metadata_violations === 0
    && invariants.forbidden_detail_key_violations === 0
    && invariants.known_raw_text_fixture_occurrences === 0
    && sequenceResult.rows[0].violation_count === 0;
  const outboxGate = pendingOutboxCount === expectedCount
    && outbox.every((row) => row.lrs_eligible && row.status === "pending")
    && outboxPayload.verified;
  const coreDataGate = equality
    && participantGate
    && ownershipGate
    && invariantGate
    && outboxGate
    && coverageGate
    && transportValidation.aggregateGatePassed;
  const productSessionExpectation = calculatePostDeleteSessionExpectation(
    events,
    manifest.participant_count,
  );
  const physicalIsolationGate = productCounts.learner_sessions
      === productSessionExpectation.expectedProductSessions
    && productCounts.session_revocations === manifest.participant_count
    && productCounts.generic_events === 0
    && productCounts.generic_outbox === 0
    && productCounts.misplaced_research_events === 0
    && lrsCounter.generic === 0
    && lrsCounter.research === 0;
  const sourceProvenance = await readSourceProvenance(uniqueValue(events, "commit_sha"));
  const runtimeBuildGate = validateRuntimeBuildAttestationForRun(
    runtimeBuildAttestation,
    {
      applicationMode: options.applicationMode,
      commitSha: uniqueValue(events, "commit_sha"),
    },
  );
  const externalLrsContactGate = validateExternalLrsAttestationForRun(
    externalLrsAttestation,
    { startedTimes, receivedTimes },
  );
  const fullBrowserEvidenceGate = coreDataGate
    && physicalIsolationGate
    && transportIdentity.verified
    && sourceProvenance.sourceReproducibleFromCommit
    && runtimeBuildGate.verified
    && externalLrsContactGate.verified
    && externalLrsContactGate.externalLrsContacted === false
    && options.applicationMode === "production-build";
  const evidenceStatus = fullBrowserEvidenceGate ? "pass" : "limited-pass";

  const report = {
    evidence_schema_version: 3,
    evidence_status: evidenceStatus,
    generated_at: new Date().toISOString(),
    mode: "synthetic-research-browser-rehearsal",
    application_mode: options.applicationMode,
    project_id: manifest.project_id,
    study_id: manifest.study_id,
    environment: manifest.environment,
    lrs_namespace: manifest.lrs_namespace,
    lrs_store_id: manifest.lrs_store_id,
    app_version: uniqueValue(events, "app_version"),
    commit_sha: uniqueValue(events, "commit_sha"),
    schema_version: Number(uniqueValue(events, "schema_version")),
    participants: {
      expected: manifest.participant_count,
      postgres: researchCounts.participant_count,
      identity_map: researchCounts.identity_map_count,
      participation_ledger: researchCounts.participation_ledger_count,
      visits: visits.length,
      distinct_participant_ids: new Set(visits.map((row) => row.participant_id)).size,
      distinct_study_run_ids: new Set(visits.map((row) => row.study_run_id)).size,
      distinct_visit_ids: new Set(visits.map((row) => row.visit_id)).size,
      visit_identity_match: visitIdentityMatch,
      valid_ciphertext_rows: identityResult.rows[0].valid_ciphertext_rows,
      condition_distribution: conditions,
    },
    reconciliation: {
      predeclared_scenario_triggers: manifest.counting_contract.physical_ui_triggers,
      predeclared_expected_semantic_records: expectedCount,
      sanitized_transport_event_acknowledgements:
        transport.transport_event_acknowledgements,
      exact_ordered_manifest_match: exactManifestMatch,
      postgres_event_count: events.length,
      lrs_eligible_event_count: eligibleCount,
      lrs_outbox_count: outbox.length,
      lrs_outbox_pending_count: pendingOutboxCount,
      event_outbox_set_difference: setDifference,
      equality,
      participant_gate_passed: participantGate,
      ownership_gate_passed: ownershipGate,
      controlled_metadata_and_sequence_gate_passed: invariantGate,
      pending_outbox_gate_passed: outboxGate,
      outbox_payload_exact_match_verified: outboxPayload.verified,
      outbox_payload_mismatch_count: outboxPayload.mismatchCount,
      complete_contract_event_type_coverage_gate_passed:
        contractCoverage.complete,
      required_outcome_coverage_gate_passed: requiredOutcomeCoverageGate,
      ai_latency_coverage_gate_passed: aiLatencyCoverageGate,
      connectivity_recovery_gate_passed: connectivityRecoveryGate,
      aggregate_transport_gate_passed: transportValidation.aggregateGatePassed,
      transport_per_route_count_gate_passed:
        transportValidation.perRouteCountGatePassed,
      transport_event_identity_binding_verified: transportIdentity.verified,
      transport_event_identity_set_difference: transportIdentity.differenceCount,
      core_data_gate_passed: coreDataGate,
      full_browser_evidence_gate_passed: fullBrowserEvidenceGate,
      counting_note: manifest.counting_contract.note,
    },
    transport: {
      research_event_post_attempts: transport.research_event_post_attempts,
      research_event_post_201: transport.research_event_post_201,
      logout_delete_attempts: transport.logout_delete_attempts,
      logout_delete_200: transport.logout_delete_200,
      transport_event_acknowledgements: transport.transport_event_acknowledgements,
      event_identity_acknowledgements_retained:
        transportValidation.acknowledgements !== null,
      event_identity_binding_verified: transportIdentity.verified,
      event_identity_set_difference: transportIdentity.differenceCount,
      per_route_count_gate_passed: transportValidation.perRouteCountGatePassed,
      acknowledgement_route_counts: transportValidation.routeCounts,
      source_trace_recomputation_available:
        transport.source_trace_recomputation_available === true,
      raw_trace_retained: transport.source_trace_retained,
      raw_playwright_internal_artifacts_retained:
        transport.raw_playwright_internal_artifacts_retained,
    },
    event_names: eventNames,
    outcomes,
    coverage: {
      observed_event_types: contractCoverage.observedEventTypes,
      covered_contract_event_types: contractCoverage.coveredContractEventTypes,
      contract_event_types_total: contractCoverage.contractEventTypesTotal,
      coverage_fraction:
        `${contractCoverage.coveredContractEventTypes}/${contractCoverage.contractEventTypesTotal}`,
      complete_contract_ui_browser_coverage: contractCoverage.complete,
      missing_contract_event_names: contractCoverage.missingEventNames,
      unexpected_event_names: contractCoverage.unexpectedEventNames,
      evidence_basis:
        "Predeclared ordered manifest, sanitized HTTP acknowledgements, Postgres events, and LRS-eligible outbox rows.",
      success: Boolean(outcomes.success),
      failure: Boolean(outcomes.failure),
      retry: Boolean(outcomes.retry),
      disconnect: Boolean(outcomes.disconnected),
      ai_latency: aiLatencyCoverageGate,
      ai_latency_event_count: events.filter((event) => event.ai_latency_ms !== null).length,
      connectivity_disconnected_then_success_recorded:
        connectivityRecoveryGate,
      visit_bound_logout_aggregate_count_matches_participants:
        transport.logout_delete_200 === manifest.participant_count,
      visit_bound_logout_identity_acknowledgement_verified:
        transportIdentity.logoutVerified,
    },
    invariants: {
      controlled_metadata_validation_scope: "structural-only",
      required_field_violations: invariants.required_field_violations,
      controlled_metadata_violations: invariants.controlled_metadata_violations,
      forbidden_detail_key_violations: invariants.forbidden_detail_key_violations,
      known_raw_text_fixture_occurrences:
        invariants.known_raw_text_fixture_occurrences,
      sequence_violation_visits: sequenceResult.rows[0].violation_count,
      observed_visit_identity_mismatches: visitIdentityMatch ? 0 : 1,
      event_visit_ownership_mismatches: ownership.event_visit_mismatches,
      visit_participant_scope_mismatches: ownership.visit_participant_mismatches,
      identity_participant_scope_mismatches:
        ownership.identity_participant_mismatches,
      ledger_visit_participant_scope_mismatches:
        ownership.ledger_visit_participant_mismatches,
    },
    physical_isolation_rehearsal: {
      product_postgres_learner_sessions: productCounts.learner_sessions,
      observed_successful_learner_data_delete_visits:
        productSessionExpectation.observedSuccessfulDeletionVisits,
      expected_product_post_delete_learner_sessions:
        productSessionExpectation.expectedProductSessions,
      product_post_delete_learner_session_count_matches:
        productCounts.learner_sessions
          === productSessionExpectation.expectedProductSessions,
      product_postgres_session_revocations: productCounts.session_revocations,
      product_postgres_generic_events: productCounts.generic_events,
      product_postgres_generic_lrs_outbox: productCounts.generic_outbox,
      product_postgres_misplaced_research_events: productCounts.misplaced_research_events,
      configured_generic_lrs_mock_requests: lrsCounter.generic,
      configured_research_lrs_mock_requests: lrsCounter.research,
      external_lrs_contact_status: externalLrsContactGate.status,
      external_lrs_contacted: externalLrsContactGate.externalLrsContacted,
      external_lrs_attestation_sha256: externalLrsContactGate.attestationSha256,
      external_lrs_capture_method: externalLrsContactGate.captureMethod,
      external_lrs_capture_scope: externalLrsContactGate.captureScope,
      external_lrs_target_origins_sha256:
        externalLrsContactGate.targetOriginsSha256,
      local_mock_contacted: lrsCounter.generic + lrsCounter.research > 0,
      passed: physicalIsolationGate,
    },
    source_provenance: {
      git_head: sourceProvenance.gitHead,
      event_commit_sha_matches_head: sourceProvenance.eventCommitMatchesHead,
      working_tree_clean: sourceProvenance.workingTreeClean,
      working_tree_status_sha256: sourceProvenance.workingTreeStatusSha256,
      working_tree_status_entry_count: sourceProvenance.workingTreeStatusEntryCount,
      source_reproducible_from_commit: sourceProvenance.sourceReproducibleFromCommit,
      tested_workspace_snapshot_retained: false,
    },
    runtime_build_attestation: {
      status: runtimeBuildGate.status,
      verified: runtimeBuildGate.verified,
      attestation_sha256: runtimeBuildGate.attestationSha256,
      runtime_build_id: runtimeBuildGate.runtimeBuildId,
      runtime_bundle_sha256: runtimeBuildGate.runtimeBundleSha256,
      runtime_bundle_scope: runtimeBuildGate.runtimeBundleScope,
      runtime_bundle_algorithm: runtimeBuildGate.runtimeBundleAlgorithm,
      runtime_bundle_entry_count: runtimeBuildGate.runtimeBundleEntryCount,
    },
    time_window_utc: {
      first_visit_started_at: startedTimes.sort()[0] ?? null,
      last_visit_started_at: startedTimes.sort().at(-1) ?? null,
      first_event_received_at: receivedTimes.sort()[0] ?? null,
      last_event_received_at: receivedTimes.sort().at(-1) ?? null,
    },
    formal_external_launch_evidence_verified: false,
    limitations: [
      ...(transportIdentity.verified
        ? []
        : [transportValidation.acknowledgements === null
            ? "The sanitized transport artifact does not retain per-acknowledgement route, method, status, client_event_id, and visit_id values, so aggregate HTTP acknowledgements cannot be rebound to individual Postgres events."
            : "The retained transport acknowledgements do not exactly match the expected route, method, status, visit, and client event semantics."]),
      ...(sourceProvenance.sourceReproducibleFromCommit
        ? []
        : ["The tested workspace is not reproducible from the recorded commit alone; this artifact is local implementation evidence, not release provenance."]),
      ...(options.applicationMode === "production-build"
        ? []
        : ["The browser used a local development build rather than an attested production build."]),
      ...(runtimeBuildGate.verified
        ? []
        : ["No scope- and commit-bound runtime build attestation was verified for the browser run."]),
      ...(externalLrsContactGate.verified
        ? []
        : ["External LRS network contact is not verified because no complete, scope-bound network attestation covered the event window."]),
      "Controlled-metadata validation enforces keys, primitive types, and token syntax; it does not prove the semantic origin of every client-supplied token value.",
      ...(externalLrsContactGate.verified
        ? [externalLrsContactGate.externalLrsContacted
            ? "The retained network attestation observed external LRS contact during the rehearsal window."
            : "The retained network attestation observed no external LRS contact during the rehearsal window; provider isolation and deletion remain external gates."]
        : ["No clean-store provider isolation, zero-baseline, delivery, or physical-deletion receipt was verified; external LRS contact remains not_verified without a retained network attestation."]),
    ],
    secrets: "redacted",
  };

  if (!coreDataGate || !physicalIsolationGate) {
    throw new Error("AAIS browser rehearsal reconciliation failed closed.");
  }
  await writeEvidenceFile(options.output, report);
  process.stdout.write(JSON.stringify({
    status: evidenceStatus,
    coreDataGate,
    transportIdentityBinding: transportIdentity.verified,
    outboxPayloadBinding: outboxPayload.verified,
    sourceReproducibleFromCommit: sourceProvenance.sourceReproducibleFromCommit,
    runtimeBuildAttestation: runtimeBuildGate.status,
    externalLrsContactAttestation: externalLrsContactGate.status,
    expected: expectedCount,
    postgres: events.length,
    lrsEligible: eligibleCount,
    outbox: outbox.length,
    genericLrsRequests: lrsCounter.generic,
    researchLrsRequests: lrsCounter.research,
    secrets: "redacted",
  }) + "\n");
} finally {
  await Promise.all([research.end(), product.end()]);
}
}

function readOptions(args) {
  const values = new Map();
  for (let index = 0; index < args.length; index += 2) {
    values.set(args[index], args[index + 1]);
  }
  const required = [
    "--manifest",
    "--observed-visits",
    "--transport-summary",
    "--output",
    "--application-mode",
  ];
  for (const name of required) {
    if (!values.get(name)) {
      throw new Error(`Missing required option ${name}.`);
    }
  }
  const applicationMode = values.get("--application-mode");
  if (!["local-development-build", "production-build"].includes(applicationMode)) {
    throw new Error(
      "--application-mode must be local-development-build or production-build.",
    );
  }
  return {
    manifest: path.resolve(values.get("--manifest")),
    observedVisits: path.resolve(values.get("--observed-visits")),
    transportSummary: path.resolve(values.get("--transport-summary")),
    output: path.resolve(values.get("--output")),
    applicationMode,
    lrsCounterUrl: values.get("--lrs-counter-url") ?? "http://127.0.0.1:33219/count",
    runtimeBuildAttestation: values.get("--runtime-build-attestation")
      ? path.resolve(values.get("--runtime-build-attestation"))
      : null,
    externalLrsAttestation: values.get("--external-lrs-attestation")
      ? path.resolve(values.get("--external-lrs-attestation"))
      : null,
  };
}

export function assertManifestShape(manifest, observed) {
  const manifestKeys = [
    "counting_contract", "declared_at", "declared_before_run",
    "environment", "evidence_schema_version", "lrs_namespace", "lrs_store_id",
    "participant_count", "participants", "project_id", "study_id",
  ];
  const observedKeys = [
    "environment", "evidence_schema_version", "lrs_namespace", "observed_at",
    "participants", "project_id", "source", "study_id",
  ];
  if (!isPlainObject(manifest) || !hasExactKeys(manifest, manifestKeys)
    || !isPlainObject(observed) || !hasExactKeys(observed, observedKeys)
    || !Array.isArray(manifest.participants)
    || !Array.isArray(observed.participants)
    || manifest.participants.length !== manifest.participant_count
    || observed.participants.length !== manifest.participant_count) {
    throw new Error("AAIS browser rehearsal manifest is invalid.");
  }
  if (!Number.isInteger(manifest.evidence_schema_version)
    || manifest.evidence_schema_version < 2
    || !Number.isInteger(observed.evidence_schema_version)
    || observed.evidence_schema_version < 1
    || manifest.declared_before_run !== true
    || !isIsoDate(manifest.declared_at)
    || !isIsoDate(observed.observed_at)
    || manifest.project_id !== "aais"
    || !isScopedToken(manifest.study_id, 128)
    || !["production", "staging", "research"].includes(manifest.environment)
    || !isStoreToken(manifest.lrs_store_id, 128)
    || observed.project_id !== manifest.project_id
    || observed.study_id !== manifest.study_id
    || observed.environment !== manifest.environment
    || observed.lrs_namespace !== manifest.lrs_namespace
    || observed.source !== "Playwright localStorage after each authenticated research bootstrap") {
    throw new Error("AAIS browser rehearsal scope metadata is invalid.");
  }
  const expectedNamespace = `https://www.aais.site/xapi/studies/${encodeURIComponent(
    manifest.study_id,
  )}/${manifest.environment}/v1`;
  if (manifest.lrs_namespace !== expectedNamespace) {
    throw new Error("AAIS browser rehearsal namespace is not canonical for its scope.");
  }
  if (!Number.isInteger(manifest.participant_count)
    || manifest.participant_count < 3
    || manifest.participant_count > 5
    || !isPlainObject(manifest.counting_contract)
    || !hasExactKeys(manifest.counting_contract, [
      "expected_semantic_event_records", "note", "physical_ui_triggers",
    ])
    || !Number.isInteger(manifest.counting_contract.physical_ui_triggers)
    || manifest.counting_contract.physical_ui_triggers < 1
    || !Number.isInteger(manifest.counting_contract.expected_semantic_event_records)
    || manifest.counting_contract.expected_semantic_event_records < 1
    || typeof manifest.counting_contract.note !== "string"
    || manifest.counting_contract.note.length < 1
    || manifest.counting_contract.note.length > 512) {
    throw new Error("AAIS browser rehearsal counting contract is invalid.");
  }
  for (const participant of manifest.participants) {
    if (!isPlainObject(participant)
      || !hasExactKeys(participant, ["expected_events", "physical_ui_triggers", "slot"])
      || !/^P[1-5]$/.test(participant.slot)
      || !Number.isInteger(participant.physical_ui_triggers)
      || participant.physical_ui_triggers < 1
      || !Array.isArray(participant.expected_events)
      || participant.expected_events.length < 1
      || participant.expected_events.some((event, index) =>
        !isPlainObject(event)
          || !hasExactKeys(event, ["event_name", "outcome", "sequence"])
          || event.sequence !== index + 1
          || !researchEventNames.has(event.event_name)
          || !researchOutcomes.has(event.outcome))) {
      throw new Error("AAIS browser rehearsal ordered event manifest is invalid.");
    }
  }
  for (const participant of observed.participants) {
    if (!isPlainObject(participant)
      || !hasExactKeys(participant, [
        "condition", "participant_id", "slot", "study_run_id", "visit_id",
      ])
      || !/^P[1-5]$/.test(participant.slot)
      || !isUuid(participant.participant_id)
      || !isUuid(participant.study_run_id)
      || !isUuid(participant.visit_id)
      || !isScopedToken(participant.condition, 64)) {
      throw new Error("AAIS browser rehearsal observed visit identities are invalid.");
    }
  }
  const slots = manifest.participants.map((item) => item.slot);
  const observedSlots = observed.participants.map((item) => item.slot);
  if (new Set(slots).size !== slots.length
    || JSON.stringify(slots) !== JSON.stringify(observedSlots)) {
    throw new Error("AAIS browser rehearsal participant slots do not match.");
  }
  const declaredTriggerCount = manifest.participants.reduce(
    (total, participant) => total + participant.physical_ui_triggers,
    0,
  );
  const declaredEventCount = manifest.participants.reduce(
    (total, participant) => total + participant.expected_events.length,
    0,
  );
  const declaredCoverage = evaluateContractCoverage(
    manifest.participants.flatMap((participant) => participant.expected_events),
  );
  if (declaredTriggerCount !== manifest.counting_contract.physical_ui_triggers
    || declaredEventCount
      !== manifest.counting_contract.expected_semantic_event_records) {
    throw new Error("AAIS browser rehearsal manifest totals do not reconcile.");
  }
  if (!declaredCoverage.complete) {
    throw new Error(
      "AAIS browser rehearsal manifest does not cover the complete 22-event contract.",
    );
  }
  if (new Set(observed.participants.map((item) => item.participant_id)).size
      !== manifest.participant_count
    || new Set(observed.participants.map((item) => item.study_run_id)).size
      !== manifest.participant_count
    || new Set(observed.participants.map((item) => item.visit_id)).size
      !== manifest.participant_count) {
    throw new Error("AAIS browser rehearsal observed visit identities are not unique.");
  }
}

export function validateTransportSummary(transport) {
  const integerFields = [
    "research_event_post_attempts",
    "research_event_post_201",
    "research_event_post_non_201",
    "logout_delete_attempts",
    "logout_delete_200",
    "transport_event_acknowledgements",
  ];
  if (!transport || typeof transport !== "object" || Array.isArray(transport)
    || integerFields.some((field) => !Number.isInteger(transport[field])
      || transport[field] < 0)) {
    throw new Error("AAIS browser rehearsal transport summary is invalid.");
  }
  const acknowledgementCount = transport.transport_event_acknowledgements;
  const aggregateArithmeticPassed = transport.research_event_post_attempts
      === transport.research_event_post_201 + transport.research_event_post_non_201
    && transport.research_event_post_non_201 === 0
    && transport.logout_delete_attempts === transport.logout_delete_200
    && acknowledgementCount
      === transport.research_event_post_201 + transport.logout_delete_200;
  let acknowledgements = null;
  let routeCounts = null;
  let perRouteCountGatePassed = false;
  if (transport.acknowledgements !== undefined) {
    if (!Array.isArray(transport.acknowledgements)
      || transport.acknowledgements.length !== acknowledgementCount) {
      throw new Error("AAIS browser rehearsal acknowledgement list is invalid.");
    }
    acknowledgements = transport.acknowledgements.map((item) => {
      const allowedKeys = ["client_event_id", "method", "route", "status", "visit_id"];
      if (!item || typeof item !== "object" || Array.isArray(item)
        || !hasExactKeys(item, allowedKeys)
        || !isUuid(item.client_event_id)
        || !isUuid(item.visit_id)
        || !Number.isInteger(item.status)
        || !(
          item.route === "/api/research/events"
            && item.method === "POST"
            && item.status === 201
        )
          && !(
            item.route === "/api/auth/app-session"
              && item.method === "DELETE"
              && item.status === 200
          )) {
        throw new Error("AAIS browser rehearsal acknowledgement metadata is invalid.");
      }
      return item;
    });
    routeCounts = {
      research_event_post_201: acknowledgements.filter((item) =>
        item.route === "/api/research/events"
          && item.method === "POST"
          && item.status === 201).length,
      logout_delete_200: acknowledgements.filter((item) =>
        item.route === "/api/auth/app-session"
          && item.method === "DELETE"
          && item.status === 200).length,
    };
    perRouteCountGatePassed = routeCounts.research_event_post_201
        === transport.research_event_post_201
      && routeCounts.logout_delete_200 === transport.logout_delete_200
      && routeCounts.research_event_post_201 + routeCounts.logout_delete_200
        === acknowledgementCount;
  }
  return {
    acknowledgementCount,
    acknowledgements,
    aggregateGatePassed: aggregateArithmeticPassed
      && (acknowledgements === null || perRouteCountGatePassed),
    perRouteCountGatePassed,
    routeCounts,
  };
}

export function compareTransportAcknowledgements(acknowledgements, events) {
  if (!acknowledgements) {
    return { verified: false, differenceCount: null, logoutVerified: false };
  }
  const acknowledgementKeys = acknowledgements.map(acknowledgementKey);
  const expectedAcknowledgements = events.map((event) => ({
    client_event_id: event.client_event_id,
    visit_id: event.visit_id,
    ...(event.event_name === "account_logout" && event.outcome === "success"
      ? { route: "/api/auth/app-session", method: "DELETE", status: 200 }
      : { route: "/api/research/events", method: "POST", status: 201 }),
  }));
  const eventKeys = expectedAcknowledgements.map(acknowledgementKey);
  const acknowledgementSet = new Set(acknowledgementKeys);
  const eventSet = new Set(eventKeys);
  const differenceCount = [
    ...eventKeys.filter((value) => !acknowledgementSet.has(value)),
    ...acknowledgementKeys.filter((value) => !eventSet.has(value)),
  ].length;
  const verified = acknowledgementKeys.length === acknowledgementSet.size
      && eventKeys.length === eventSet.size
      && acknowledgementKeys.length === eventKeys.length
      && differenceCount === 0;
  const expectedLogoutKeys = expectedAcknowledgements
    .filter((item) => item.route === "/api/auth/app-session")
    .map(acknowledgementKey);
  return {
    verified,
    differenceCount,
    logoutVerified: verified
      && expectedLogoutKeys.length > 0
      && expectedLogoutKeys.every((key) => acknowledgementSet.has(key)),
  };
}

export function compareOutboxPayloads(outboxRows, events, scope) {
  const eventsById = new Map(events.map((event) => [event.event_id, event]));
  let mismatchCount = 0;
  for (const row of outboxRows) {
    const event = eventsById.get(row.event_id);
    if (!event
      || row.statement_id !== row.event_id
      || !outboxPayloadMatchesEvent(row.payload, event, scope)) {
      mismatchCount += 1;
    }
  }
  const outboxIds = new Set(outboxRows.map((row) => row.event_id));
  mismatchCount += events.filter((event) => !outboxIds.has(event.event_id)).length;
  return {
    verified: mismatchCount === 0 && outboxRows.length === events.length,
    mismatchCount,
  };
}

export function evaluateContractCoverage(events) {
  if (!Array.isArray(events)) {
    throw new Error("AAIS browser rehearsal coverage input is invalid.");
  }
  const observedNames = [...new Set(events.map((event) => event?.event_name))]
    .filter((eventName) => typeof eventName === "string")
    .sort();
  const contractNames = [...researchEventNames].sort();
  const observedSet = new Set(observedNames);
  const missingEventNames = contractNames.filter((name) => !observedSet.has(name));
  const unexpectedEventNames = observedNames.filter(
    (name) => !researchEventNames.has(name),
  );
  const coveredContractEventTypes = contractNames.length - missingEventNames.length;
  return {
    observedEventTypes: observedNames.length,
    coveredContractEventTypes,
    contractEventTypesTotal: contractNames.length,
    missingEventNames,
    unexpectedEventNames,
    complete: missingEventNames.length === 0 && unexpectedEventNames.length === 0,
  };
}

export function calculatePostDeleteSessionExpectation(events, participantCount) {
  if (!Array.isArray(events)
    || !Number.isInteger(participantCount)
    || participantCount < 0) {
    throw new Error("AAIS product session expectation input is invalid.");
  }
  const successfulDeletionVisitIds = new Set(
    events
      .filter((event) =>
        event?.event_name === "learner_data_delete"
          && event?.outcome === "success")
      .map((event) => event.visit_id),
  );
  if ([...successfulDeletionVisitIds].some((visitId) => !isUuid(visitId))
    || successfulDeletionVisitIds.size > participantCount) {
    throw new Error(
      "AAIS successful learner-data deletion visits are invalid.",
    );
  }
  return {
    observedSuccessfulDeletionVisits: successfulDeletionVisitIds.size,
    expectedProductSessions: participantCount - successfulDeletionVisitIds.size,
  };
}

export async function writeEvidenceFile(filePath, value) {
  await writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, {
    flag: "wx",
    mode: 0o600,
  });
  await chmod(filePath, 0o600);
}

function outboxPayloadMatchesEvent(payload, event, scope) {
  const expectedKeys = [
    "aiLatencyMs", "appVersion", "clientTime", "commitSha", "condition",
    "detail", "disconnectCount", "environment", "eventId", "eventName",
    "eventSequence", "lrsEligible", "lrsNamespace", "lrsStoreId", "outcome",
    "participantId", "projectId", "retryCount", "schemaVersion",
    "serverReceivedAt", "studyId", "studyRunId", "visitId",
  ];
  return isPlainObject(payload)
    && hasExactKeys(payload, expectedKeys)
    && payload.eventId === event.event_id
    && payload.participantId === event.participant_id
    && payload.studyRunId === event.study_run_id
    && payload.visitId === event.visit_id
    && payload.projectId === scope.projectId
    && payload.studyId === scope.studyId
    && payload.environment === scope.environment
    && payload.lrsNamespace === scope.lrsNamespace
    && payload.lrsStoreId === scope.lrsStoreId
    && payload.condition === event.condition
    && payload.schemaVersion === event.schema_version
    && payload.appVersion === event.app_version
    && payload.commitSha === event.commit_sha
    && payload.eventSequence === event.event_sequence
    && normalizeInstant(payload.clientTime) === normalizeInstant(event.client_time)
    && normalizeInstant(payload.serverReceivedAt)
      === normalizeInstant(event.server_received_at)
    && payload.eventName === event.event_name
    && payload.outcome === event.outcome
    && payload.retryCount === event.retry_count
    && payload.disconnectCount === event.disconnect_count
    && payload.aiLatencyMs === event.ai_latency_ms
    && stableJson(payload.detail) === stableJson(event.detail)
    && payload.lrsEligible === event.lrs_eligible;
}

export async function readRuntimeBuildAttestation(filePath, manifest) {
  if (!filePath) {
    return null;
  }
  const raw = await readFile(filePath, "utf8");
  const value = JSON.parse(raw);
  const keys = [
    "application_mode", "attestation_type", "captured_at", "commit_sha",
    "environment", "evidence_schema_version", "lrs_namespace", "project_id",
    "runtime_build_id", "runtime_bundle_algorithm", "runtime_bundle_entry_count",
    "runtime_bundle_scope", "runtime_bundle_sha256", "study_id",
  ];
  if (!isPlainObject(value) || !hasExactKeys(value, keys)
    || value.attestation_type !== "aais-runtime-build"
    || value.evidence_schema_version !== 2
    || value.application_mode !== "production-build"
    || !isIsoDate(value.captured_at)
    || !/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(value.commit_sha)
    || !isAsciiToken(value.runtime_build_id, 128)
    || value.runtime_bundle_scope !== "next-production-runtime-v1"
    || value.runtime_bundle_algorithm
      !== "sha256-canonical-file-manifest-v1"
    || !Number.isInteger(value.runtime_bundle_entry_count)
    || value.runtime_bundle_entry_count < 1
    || !/^[0-9a-f]{64}$/.test(value.runtime_bundle_sha256)
    || !attestationScopeMatches(value, manifest)) {
    throw new Error("AAIS runtime build attestation is invalid.");
  }
  return {
    ...value,
    attestationSha256: createHash("sha256").update(raw).digest("hex"),
  };
}

export async function readExternalLrsAttestation(filePath, manifest) {
  if (!filePath) {
    return null;
  }
  const raw = await readFile(filePath, "utf8");
  const value = JSON.parse(raw);
  const keys = [
    "attestation_type", "capture_complete", "capture_ended_at",
    "capture_image_id", "capture_method", "capture_scope",
    "capture_started_at", "capture_subject", "capture_subject_sha256",
    "command_exit_code", "environment", "evidence_schema_version",
    "lrs_namespace", "observed_external_lrs_requests",
    "observed_internal_egress_packets", "observed_packet_summaries",
    "observed_public_egress_packets", "observed_target_packets",
    "packet_parse_error_count", "packets_captured",
    "packets_dropped_by_kernel", "packets_received_by_filter",
    "payload_capture", "project_id", "raw_capture_retained",
    "resolved_target_address_count", "resolved_target_addresses_sha256",
    "sanitized_capture_path", "sanitized_capture_sha256", "study_id",
    "target_origin_count", "target_origins_sha256",
  ];
  if (!isPlainObject(value) || !hasExactKeys(value, keys)
    || value.attestation_type !== "aais-external-lrs-network"
    || value.evidence_schema_version !== 2
    || value.capture_complete !== true
    || !isIsoDate(value.capture_started_at)
    || !isIsoDate(value.capture_ended_at)
    || new Date(value.capture_started_at).getTime()
      > new Date(value.capture_ended_at).getTime()
    || !networkCaptureMetadataIsValid(value)
    || !isSafeArtifactBasename(value.sanitized_capture_path)
    || !/^[0-9a-f]{64}$/.test(value.sanitized_capture_sha256)
    || !attestationScopeMatches(value, manifest)) {
    throw new Error("AAIS external LRS network attestation is invalid.");
  }
  const capturePath = path.resolve(path.dirname(filePath), value.sanitized_capture_path);
  const capture = await readFile(capturePath);
  const captureSha256 = createHash("sha256").update(capture).digest("hex");
  if (captureSha256 !== value.sanitized_capture_sha256) {
    throw new Error("AAIS external LRS network capture checksum does not match.");
  }
  let captureValue;
  try {
    captureValue = JSON.parse(capture.toString("utf8"));
  } catch {
    throw new Error("AAIS external LRS sanitized capture is invalid.");
  }
  const captureKeys = keys
    .filter((key) => ![
      "attestation_type",
      "sanitized_capture_path",
      "sanitized_capture_sha256",
    ].includes(key))
    .concat("artifact_type");
  if (!isPlainObject(captureValue)
    || !hasExactKeys(captureValue, captureKeys)
    || captureValue.artifact_type
      !== "aais-external-lrs-sanitized-network-capture"
    || captureKeys.some((key) =>
      key !== "artifact_type" && captureValue[key] !== value[key])) {
    throw new Error(
      "AAIS external LRS sanitized capture does not match its attestation.",
    );
  }
  return {
    ...value,
    attestationSha256: createHash("sha256").update(raw).digest("hex"),
  };
}

function networkCaptureMetadataIsValid(value) {
  const dockerMethod = value.capture_method
    === "docker-network-namespace-tcpdump-summary-v1";
  const hostMethod = [
    "darwin-pktap-all-tcpdump-summary-v1",
    "linux-any-tcpdump-summary-v1",
  ].includes(value.capture_method);
  const methodScopeValid = (
    dockerMethod
      && value.capture_scope === "all-egress-tcp-udp-app-network-namespace"
      && value.capture_subject === "docker-app-network-namespace"
      && /^sha256:[0-9a-f]{64}$/.test(value.capture_image_id)
  ) || (
    hostMethod
      && value.capture_scope === "all-interfaces-declared-lrs-origins"
      && value.capture_subject === "host-all-interfaces"
      && value.capture_image_id === null
  );
  const numericKeys = [
    "target_origin_count", "resolved_target_address_count", "packets_captured",
    "packets_received_by_filter", "packets_dropped_by_kernel",
    "observed_packet_summaries", "packet_parse_error_count",
    "observed_target_packets", "observed_public_egress_packets",
    "observed_internal_egress_packets", "observed_external_lrs_requests",
    "command_exit_code",
  ];
  return methodScopeValid
    && /^[0-9a-f]{64}$/.test(value.capture_subject_sha256)
    && /^[0-9a-f]{64}$/.test(value.target_origins_sha256)
    && /^[0-9a-f]{64}$/.test(value.resolved_target_addresses_sha256)
    && numericKeys.every((key) =>
      Number.isInteger(value[key]) && value[key] >= 0)
    && value.target_origin_count >= 1
    && value.resolved_target_address_count >= 1
    && value.packets_dropped_by_kernel === 0
    && value.packet_parse_error_count === 0
    && value.observed_target_packets === 0
    && value.observed_public_egress_packets === 0
    && value.observed_external_lrs_requests === 0
    && value.command_exit_code === 0
    && value.packets_captured === value.observed_packet_summaries
    && value.observed_packet_summaries
      === value.observed_public_egress_packets
        + value.observed_internal_egress_packets
    && value.raw_capture_retained === false
    && value.payload_capture === "not-retained-tcpdump-summary-only";
}

function isSafeArtifactBasename(value) {
  return typeof value === "string"
    && /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(value)
    && path.basename(value) === value;
}

export function validateRuntimeBuildAttestationForRun(attestation, run) {
  if (!attestation) {
    return {
      status: "not_verified",
      verified: false,
      attestationSha256: null,
      runtimeBuildId: null,
      runtimeBundleSha256: null,
      runtimeBundleScope: null,
      runtimeBundleAlgorithm: null,
      runtimeBundleEntryCount: null,
    };
  }
  const verified = run.applicationMode === "production-build"
    && attestation.commit_sha === run.commitSha;
  return {
    status: verified ? "verified" : "mismatch",
    verified,
    attestationSha256: attestation.attestationSha256,
    runtimeBuildId: attestation.runtime_build_id,
    runtimeBundleSha256: attestation.runtime_bundle_sha256,
    runtimeBundleScope: attestation.runtime_bundle_scope,
    runtimeBundleAlgorithm: attestation.runtime_bundle_algorithm,
    runtimeBundleEntryCount: attestation.runtime_bundle_entry_count,
  };
}

export function validateExternalLrsAttestationForRun(attestation, timeWindow) {
  if (!attestation) {
    return {
      status: "not_verified",
      verified: false,
      externalLrsContacted: null,
      attestationSha256: null,
      captureMethod: null,
      captureScope: null,
      targetOriginsSha256: null,
    };
  }
  const eventTimes = [...timeWindow.startedTimes, ...timeWindow.receivedTimes]
    .map((value) => new Date(value).getTime());
  const firstEventTime = Math.min(...eventTimes);
  const lastEventTime = Math.max(...eventTimes);
  const verified = eventTimes.length > 0
    && new Date(attestation.capture_started_at).getTime() <= firstEventTime
    && new Date(attestation.capture_ended_at).getTime() >= lastEventTime;
  return {
    status: verified ? "verified" : "window_mismatch",
    verified,
    externalLrsContacted: verified
      ? attestation.observed_external_lrs_requests > 0
      : null,
    attestationSha256: attestation.attestationSha256,
    captureMethod: attestation.capture_method,
    captureScope: attestation.capture_scope,
    targetOriginsSha256: attestation.target_origins_sha256,
  };
}

function attestationScopeMatches(value, manifest) {
  return value.project_id === manifest.project_id
    && value.study_id === manifest.study_id
    && value.environment === manifest.environment
    && value.lrs_namespace === manifest.lrs_namespace;
}

async function readSourceProvenance(eventCommitSha) {
  try {
    const [{ stdout: headOutput }, { stdout: statusOutput }] = await Promise.all([
      execFileAsync("git", ["rev-parse", "HEAD"], { cwd: repositoryRoot }),
      execFileAsync("git", ["status", "--porcelain", "--untracked-files=all"], {
        cwd: repositoryRoot,
      }),
    ]);
    const gitHead = headOutput.trim();
    const status = statusOutput.trim();
    const workingTreeClean = status.length === 0;
    const eventCommitMatchesHead = eventCommitSha === gitHead;
    return {
      gitHead,
      eventCommitMatchesHead,
      workingTreeClean,
      workingTreeStatusSha256: createHash("sha256").update(status).digest("hex"),
      workingTreeStatusEntryCount: status ? status.split("\n").length : 0,
      sourceReproducibleFromCommit: eventCommitMatchesHead && workingTreeClean,
    };
  } catch {
    return {
      gitHead: null,
      eventCommitMatchesHead: false,
      workingTreeClean: false,
      workingTreeStatusSha256: null,
      workingTreeStatusEntryCount: null,
      sourceReproducibleFromCommit: false,
    };
  }
}

function isUuid(value) {
  return typeof value === "string"
    && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
      .test(value);
}

async function readLrsCounter(url) {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error("AAIS local LRS counter is unavailable.");
  }
  const value = await response.json();
  if (!Number.isInteger(value.generic) || !Number.isInteger(value.research)) {
    throw new Error("AAIS local LRS counter returned invalid data.");
  }
  return value;
}

function compareManifestEvent(left, right) {
  return left.slot.localeCompare(right.slot) || left.sequence - right.sequence;
}

function countBy(rows, key) {
  return Object.fromEntries(
    [...rows.reduce((counts, row) => {
      const value = String(row[key]);
      counts.set(value, (counts.get(value) ?? 0) + 1);
      return counts;
    }, new Map()).entries()].sort(([left], [right]) => left.localeCompare(right)),
  );
}

function uniqueValue(rows, key) {
  const values = [...new Set(rows.map((row) => row[key]))];
  if (values.length !== 1) {
    throw new Error(`AAIS browser rehearsal ${key} is not unique.`);
  }
  return values[0];
}

function hasOrderedConnectivityRecovery(events) {
  const byVisit = new Map();
  for (const event of events) {
    const current = byVisit.get(event.visit_id) ?? [];
    current.push(event);
    byVisit.set(event.visit_id, current);
  }
  return [...byVisit.values()].some((visitEvents) => {
    const disconnected = visitEvents.find((event) =>
      event.event_name === "client_connectivity" && event.outcome === "disconnected");
    return disconnected && visitEvents.some((event) =>
      event.event_name === "client_connectivity"
        && event.outcome === "success"
        && event.event_sequence > disconnected.event_sequence);
  });
}

function isDirectInvocation() {
  return Boolean(modulePath && process.argv[1])
    && path.resolve(process.argv[1]) === modulePath;
}

function acknowledgementKey(item) {
  return [
    item.route,
    item.method,
    item.status,
    item.visit_id,
    item.client_event_id,
  ].join(":");
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function hasExactKeys(value, keys) {
  return isPlainObject(value)
    && Object.keys(value).sort().join("|") === [...keys].sort().join("|");
}

function isAsciiToken(value, maxLength) {
  return typeof value === "string"
    && value.length > 0
    && value.length <= maxLength
    && /^[A-Za-z0-9][A-Za-z0-9._:/+-]*$/.test(value);
}

function isScopedToken(value, maxLength) {
  return typeof value === "string"
    && value.length > 0
    && value.length <= maxLength
    && /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(value);
}

function isStoreToken(value, maxLength) {
  return typeof value === "string"
    && value.length > 0
    && value.length <= maxLength
    && /^[A-Za-z0-9][A-Za-z0-9._:-]*$/.test(value);
}

function isIsoDate(value) {
  return typeof value === "string"
    && Number.isFinite(new Date(value).getTime())
    && /T.*(?:Z|[+-][0-9]{2}:[0-9]{2})$/.test(value);
}

function normalizeInstant(value) {
  const date = value instanceof Date ? value : new Date(value);
  return Number.isFinite(date.getTime()) ? date.toISOString() : null;
}

function stableJson(value) {
  return JSON.stringify(sortJsonValue(value));
}

function sortJsonValue(value) {
  if (Array.isArray(value)) {
    return value.map(sortJsonValue);
  }
  if (isPlainObject(value)) {
    return Object.fromEntries(
      Object.keys(value).sort().map((key) => [key, sortJsonValue(value[key])]),
    );
  }
  return value;
}
