#!/usr/bin/env node

import { createHash, createHmac } from "node:crypto";
import {
  chmod,
  mkdir,
  readFile,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "@playwright/test";

export const aaisBrowserResearchEventNames = [
  "workspace_session_load",
  "client_connectivity",
  "account_menu_toggled",
  "learner_data_export",
  "learner_data_delete",
  "account_logout",
  "content_tab_selected",
  "content_item_opened",
  "content_item_back",
  "history_document_opened",
  "panel_resize_completed",
  "guide_quick_start_selected",
  "guide_attachment_picker_opened",
  "guide_attachment_add",
  "guide_attachment_removed",
  "ai_guide_submit",
  "guide_response_link_opened",
  "document_artifact_save",
  "document_title_committed",
  "editor_format_applied",
  "document_save_closed",
  "document_download",
];

const modulePath = import.meta.url.startsWith("file:")
  ? fileURLToPath(import.meta.url)
  : null;
const captureStorageKey = "aais_browser_rehearsal_capture_v1";
const visitStorageKey = "aais_research_visit_v1";
const eventQueueStorageKey = "aais_research_event_queue_v1";
const sessionCookieName = process.env.AAIS_SESSION_COOKIE_NAME?.trim() || "aais_session";
const csrfCookieName = process.env.AAIS_CSRF_COOKIE_NAME?.trim() || "aais_csrf";
const sessionTtlSeconds = 60 * 60 * 2;
const networkIdleQuietWindowMilliseconds = 2_000;
const uuidPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const safeTokenPattern = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const safeStudyPattern = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const syntheticActorPattern = /^Synthetic[A-Za-z0-9._:-]{0,118}$/i;

const p1ExpectedEvents = [
  ["workspace_session_load", "attempted"],
  ["workspace_session_load", "success"],
  ["client_connectivity", "disconnected"],
  ["client_connectivity", "success"],
  ["account_menu_toggled", "success"],
  ["learner_data_export", "attempted"],
  ["learner_data_export", "failure"],
  ["learner_data_export", "attempted"],
  ["learner_data_export", "success"],
  ["account_menu_toggled", "success"],
  ["learner_data_delete", "failure"],
  ["account_menu_toggled", "success"],
  ["content_item_opened", "success"],
  ["content_item_back", "success"],
  ["panel_resize_completed", "success"],
  ["content_tab_selected", "success"],
  ["document_title_committed", "success"],
  ["document_artifact_save", "attempted"],
  ["document_artifact_save", "success"],
  ["editor_format_applied", "success"],
  ["document_artifact_save", "attempted"],
  ["document_download", "attempted"],
  ["document_download", "success"],
  ["document_artifact_save", "success"],
  ["document_save_closed", "success"],
  ["history_document_opened", "success"],
  ["guide_attachment_picker_opened", "success"],
  ["guide_attachment_add", "attempted"],
  ["guide_attachment_add", "success"],
  ["guide_attachment_removed", "success"],
  ["guide_quick_start_selected", "success"],
  ["ai_guide_submit", "attempted"],
  ["ai_guide_submit", "retry"],
  ["ai_guide_submit", "success"],
  ["guide_response_link_opened", "success"],
  ["account_menu_toggled", "success"],
  ["learner_data_delete", "attempted"],
  ["learner_data_delete", "success"],
  ["account_menu_toggled", "success"],
  ["account_logout", "attempted"],
  ["account_logout", "success"],
];

const minimalParticipantExpectedEvents = [
  ["workspace_session_load", "attempted"],
  ["workspace_session_load", "success"],
  ["account_menu_toggled", "success"],
  ["account_logout", "attempted"],
  ["account_logout", "success"],
];

const physicalInteractionContract = {
  P1: [
    "workspace_navigation",
    "browser_connectivity_offline",
    "browser_connectivity_online",
    "account_menu_open_for_export",
    "learner_export_cancel",
    "learner_export_success",
    "account_menu_open_for_delete_cancel",
    "learner_delete_cancel",
    "account_menu_close_after_delete_cancel",
    "content_item_open",
    "content_item_back",
    "content_panel_keyboard_resize",
    "document_editor_tab_select",
    "document_title_edit_and_blur",
    "document_artifact_edit_and_blur",
    "document_bold_format",
    "document_download",
    "document_save_and_close",
    "history_document_open",
    "native_attachment_chooser_and_select",
    "guide_attachment_remove",
    "guide_quick_start_select",
    "guide_response_link_open",
    "account_menu_open_for_delete_confirm",
    "learner_delete_confirm",
    "account_menu_open_for_logout",
    "account_logout",
  ],
  P2: [
    "workspace_navigation",
    "account_menu_open_for_logout",
    "account_logout",
  ],
  P3: [
    "workspace_navigation",
    "account_menu_open_for_logout",
    "account_logout",
  ],
};

if (isDirectInvocation()) {
  main().catch((error) => {
    const message = error instanceof Error
      ? error.message.replace(/[\r\n]+/g, " ").slice(0, 500)
      : "unknown failure";
    process.stderr.write(`AAIS browser rehearsal capture failed: ${message}\n`);
    process.exitCode = 1;
  });
}

async function main() {
  const options = normalizeRunOptions(readCliOptions(process.argv.slice(2)));
  const sessionSecret =
    process.env.AAIS_BROWSER_SESSION_SECRET?.trim()
    || process.env.AAIS_SESSION_SECRET?.trim()
    || "";
  if (sessionSecret.length < 32) {
    throw new Error(
      "AAIS_BROWSER_SESSION_SECRET or AAIS_SESSION_SECRET (32+ characters) is required.",
    );
  }

  await mkdir(options.outputDir, { recursive: false, mode: 0o700 });
  await chmod(options.outputDir, 0o700);

  const manifest = createStrictBrowserManifest({
    declaredAt: new Date().toISOString(),
    environment: options.environment,
    lrsNamespace: options.lrsNamespace,
    lrsStoreId: options.lrsStoreId,
    projectId: options.projectId,
    studyId: options.studyId,
  });
  const manifestPath = path.join(options.outputDir, "action-manifest.json");
  const manifestRaw = await writeJsonEvidence(manifestPath, manifest);
  const manifestSha256 = sha256(manifestRaw);

  const browser = await chromium.launch({
    headless: !options.headed,
    args: [
      "--disable-background-networking",
      "--disable-component-update",
      "--disable-domain-reliability",
      "--disable-features=OptimizationHints,MediaRouter,AutofillServerCommunication",
      "--disable-sync",
      "--metrics-recording-only",
      "--no-default-browser-check",
    ],
  });
  const participantRuns = [];
  try {
    for (let index = 0; index < options.participantActors.length; index += 1) {
      const slot = `P${index + 1}`;
      const run = await runSyntheticParticipant({
        actorId: options.participantActors[index],
        baseUrl: options.baseUrl,
        browser,
        displayName: `Synthetic Participant ${slot}`,
        expectedEvents: manifest.participants[index].expected_events,
        sessionSecret,
        slot,
        timeoutMs: options.timeoutMs,
      });
      participantRuns.push(run);
    }
  } finally {
    await browser.close();
  }

  const retainedManifestRaw = await readFile(manifestPath, "utf8");
  if (sha256(retainedManifestRaw) !== manifestSha256) {
    throw new Error("The predeclared action manifest changed after browser navigation.");
  }

  const validation = validateBrowserCapture({
    manifest,
    participantRuns,
  });
  const generatedAt = new Date().toISOString();
  const browserNetwork = buildBrowserNetworkSummary({
    baseUrl: options.baseUrl,
    environment: options.environment,
    generatedAt,
    lrsNamespace: options.lrsNamespace,
    manifestSha256,
    participantRuns,
    projectId: options.projectId,
    studyId: options.studyId,
  });
  const observedVisits = {
    evidence_schema_version: 1,
    observed_at: generatedAt,
    source: "Playwright localStorage after each authenticated research bootstrap",
    project_id: options.projectId,
    study_id: options.studyId,
    environment: options.environment,
    lrs_namespace: options.lrsNamespace,
    participants: participantRuns.map((run) => ({
      slot: run.slot,
      participant_id: run.visit.participantId,
      study_run_id: run.visit.studyRunId,
      visit_id: run.visit.visitId,
      condition: run.visit.condition,
    })),
  };
  const acknowledgements = participantRuns.flatMap(
    (run) => run.capture.acknowledgements,
  );
  const transport = buildTransportSummary({
    acknowledgements,
    captures: participantRuns.map((run) => run.capture),
    generatedAt,
  });
  const coverage = {
    evidence_schema_version: 1,
    generated_at: generatedAt,
    project_id: options.projectId,
    study_id: options.studyId,
    environment: options.environment,
    lrs_namespace: options.lrsNamespace,
    participant_count: participantRuns.length,
    manifest_sha256: manifestSha256,
    expected_semantic_event_records:
      manifest.counting_contract.expected_semantic_event_records,
    acknowledged_semantic_event_records: acknowledgements.length,
    expected_physical_ui_triggers: manifest.counting_contract.physical_ui_triggers,
    required_event_name_count: aaisBrowserResearchEventNames.length,
    observed_event_name_count: validation.coveredEventNames.length,
    covered_event_names: validation.coveredEventNames,
    event_name_counts: validation.eventNameCounts,
    outcome_counts: validation.outcomeCounts,
    exact_predeclared_manifest_match: validation.exactManifestMatch,
    acknowledgement_count_match: validation.acknowledgementCountMatch,
    physical_ui_contract: physicalInteractionContract,
    persisted_sensitive_fields: [],
    raw_playwright_artifacts_retained: false,
    secrets: "redacted",
  };

  const evidenceFiles = [
    ["observed-visits.json", observedVisits],
    ["transport-summary.json", transport],
    ["coverage-summary.json", coverage],
    ["browser-network-summary.json", browserNetwork],
  ];
  for (const [fileName, value] of evidenceFiles) {
    await writeJsonEvidence(path.join(options.outputDir, fileName), value);
  }
  const checksumNames = [
    "action-manifest.json",
    ...evidenceFiles.map(([fileName]) => fileName),
  ];
  const checksumLines = [];
  for (const fileName of checksumNames) {
    const content = await readFile(path.join(options.outputDir, fileName));
    checksumLines.push(`${sha256(content)}  ${fileName}`);
  }
  const checksumPath = path.join(options.outputDir, "SHA256SUMS");
  await writeFile(checksumPath, `${checksumLines.join("\n")}\n`, {
    flag: "wx",
    mode: 0o600,
  });
  await chmod(checksumPath, 0o600);

  process.stdout.write(`${JSON.stringify({
    status: "pass",
    participant_count: participantRuns.length,
    physical_ui_triggers: manifest.counting_contract.physical_ui_triggers,
    semantic_event_records: acknowledgements.length,
    event_name_coverage: `${validation.coveredEventNames.length}/${aaisBrowserResearchEventNames.length}`,
    browser_network_gate_passed: browserNetwork.browser_network_gate_passed,
    browser_non_local_requests: browserNetwork.non_local_request_count,
    output_dir: options.outputDir,
    raw_request_data_captured: false,
    secrets: "redacted",
  })}\n`);
}

export function createStrictBrowserManifest({
  declaredAt,
  environment,
  lrsNamespace,
  lrsStoreId,
  projectId,
  studyId,
}) {
  const participants = [
    createManifestParticipant("P1", p1ExpectedEvents),
    createManifestParticipant("P2", minimalParticipantExpectedEvents),
    createManifestParticipant("P3", minimalParticipantExpectedEvents),
  ];
  const manifest = {
    evidence_schema_version: 2,
    declared_at: declaredAt,
    declared_before_run: true,
    project_id: projectId,
    study_id: studyId,
    environment,
    lrs_store_id: lrsStoreId,
    lrs_namespace: lrsNamespace,
    participant_count: participants.length,
    counting_contract: {
      physical_ui_triggers: Object.values(physicalInteractionContract)
        .reduce((total, steps) => total + steps.length, 0),
      expected_semantic_event_records: participants
        .reduce((total, participant) => total + participant.expected_events.length, 0),
      note:
        "High-level physical interactions are counted separately from semantic event records. One interaction can intentionally create attempted plus terminal outcome records; browser connectivity transitions are two explicit harness controls.",
    },
    participants,
  };
  return deepFreeze(manifest);
}

export function normalizeRunOptions(input) {
  const baseUrl = new URL(input.baseUrl);
  if (
    !["http:", "https:"].includes(baseUrl.protocol)
    || !["127.0.0.1", "localhost", "::1"].includes(baseUrl.hostname)
    || baseUrl.username
    || baseUrl.password
    || baseUrl.search
    || baseUrl.hash
    || baseUrl.pathname !== "/"
  ) {
    throw new Error(
      "The rehearsal base URL must be a credential-free localhost origin with no path, query, or hash.",
    );
  }
  if (input.projectId !== "aais") {
    throw new Error("AAIS browser rehearsal project_id must be aais.");
  }
  if (!safeStudyPattern.test(input.studyId)) {
    throw new Error("AAIS browser rehearsal study_id is invalid.");
  }
  if (input.environment !== "research") {
    throw new Error("AAIS browser rehearsal environment must be research.");
  }
  if (!safeTokenPattern.test(input.lrsStoreId)) {
    throw new Error("AAIS browser rehearsal lrs_store_id is invalid.");
  }
  const expectedNamespace =
    `https://www.aais.site/xapi/studies/${encodeURIComponent(input.studyId)}/research/v1`;
  if (input.lrsNamespace !== expectedNamespace) {
    throw new Error("AAIS browser rehearsal LRS namespace is not canonical.");
  }
  if (
    !Array.isArray(input.participantActors)
    || input.participantActors.length !== 3
    || new Set(input.participantActors).size !== 3
    || input.participantActors.some((actorId) => !syntheticActorPattern.test(actorId))
  ) {
    throw new Error(
      "Exactly three unique Synthetic-prefixed participant actor IDs are required.",
    );
  }
  const timeoutMs = Number(input.timeoutMs ?? 30_000);
  if (!Number.isInteger(timeoutMs) || timeoutMs < 5_000 || timeoutMs > 120_000) {
    throw new Error("AAIS browser rehearsal timeout must be 5000-120000 ms.");
  }
  return {
    baseUrl: baseUrl.origin,
    environment: input.environment,
    headed: input.headed === true,
    lrsNamespace: input.lrsNamespace,
    lrsStoreId: input.lrsStoreId,
    outputDir: path.resolve(input.outputDir),
    participantActors: [...input.participantActors],
    projectId: input.projectId,
    studyId: input.studyId,
    timeoutMs,
  };
}

export function validateBrowserCapture({ manifest, participantRuns }) {
  if (
    !manifest
    || !Array.isArray(participantRuns)
    || participantRuns.length !== 3
    || participantRuns.length !== manifest.participant_count
  ) {
    throw new Error("AAIS browser capture participant count does not match the manifest.");
  }

  const visits = [];
  const semanticEvents = [];
  const acknowledgements = [];
  let exactManifestMatch = true;
  for (let index = 0; index < participantRuns.length; index += 1) {
    const run = participantRuns[index];
    const expectedParticipant = manifest.participants[index];
    if (
      run.slot !== expectedParticipant.slot
      || !isSafeVisit(run.visit)
      || run.capture.errors.length !== 0
    ) {
      throw new Error("AAIS browser capture contains an invalid participant projection.");
    }
    visits.push(run.visit);
    semanticEvents.push(...run.capture.semanticEvents);
    acknowledgements.push(...run.capture.acknowledgements);
    const actualOrdered = run.capture.semanticEvents.map((event) => [
      event.event_name,
      event.outcome,
    ]);
    const expectedOrdered = expectedParticipant.expected_events.map((event) => [
      event.event_name,
      event.outcome,
    ]);
    if (JSON.stringify(actualOrdered) !== JSON.stringify(expectedOrdered)) {
      exactManifestMatch = false;
    }
    for (let eventIndex = 0; eventIndex < run.capture.semanticEvents.length; eventIndex += 1) {
      const event = run.capture.semanticEvents[eventIndex];
      if (
        event.event_name === "account_logout"
        && event.outcome === "success"
        && eventIndex === run.capture.semanticEvents.length - 1
      ) {
        continue;
      }
      if (event.event_sequence !== eventIndex + 1) {
        exactManifestMatch = false;
      }
    }
  }
  if (!exactManifestMatch) {
    throw new Error("Actual browser event order does not match the frozen manifest.");
  }

  const expectedCount = manifest.counting_contract.expected_semantic_event_records;
  const acknowledgementCountMatch =
    semanticEvents.length === expectedCount
    && acknowledgements.length === expectedCount;
  if (!acknowledgementCountMatch) {
    throw new Error("Browser acknowledgement count does not match the frozen manifest.");
  }
  if (
    new Set(visits.map((visit) => visit.participantId)).size !== visits.length
    || new Set(visits.map((visit) => visit.studyRunId)).size !== visits.length
    || new Set(visits.map((visit) => visit.visitId)).size !== visits.length
  ) {
    throw new Error("Observed participant, study run, and visit UUIDs must be unique.");
  }
  assertStrictAcknowledgements(acknowledgements);
  const acknowledgementKeys = new Set(
    acknowledgements.map((item) => `${item.client_event_id}:${item.visit_id}`),
  );
  const semanticKeys = new Set(
    semanticEvents.map((item) => `${item.client_event_id}:${item.visit_id}`),
  );
  if (
    acknowledgementKeys.size !== acknowledgements.length
    || semanticKeys.size !== semanticEvents.length
    || acknowledgementKeys.size !== semanticKeys.size
    || [...semanticKeys].some((key) => !acknowledgementKeys.has(key))
  ) {
    throw new Error("Browser acknowledgements are not one-to-one with semantic events.");
  }

  const coveredEventNames = [...new Set(
    semanticEvents.map((event) => event.event_name),
  )].sort();
  const expectedCoverage = [...aaisBrowserResearchEventNames].sort();
  if (JSON.stringify(coveredEventNames) !== JSON.stringify(expectedCoverage)) {
    throw new Error("Browser rehearsal did not cover all 22 event_name values.");
  }
  return {
    acknowledgementCountMatch,
    coveredEventNames,
    eventNameCounts: countBy(semanticEvents, "event_name"),
    exactManifestMatch,
    outcomeCounts: countBy(semanticEvents, "outcome"),
  };
}

async function runSyntheticParticipant({
  actorId,
  baseUrl,
  browser,
  displayName,
  expectedEvents,
  sessionSecret,
  slot,
  timeoutMs,
}) {
  const context = await browser.newContext({
    acceptDownloads: false,
    baseURL: baseUrl,
    serviceWorkers: "block",
    viewport: { width: 1440, height: 1000 },
  });
  context.setDefaultTimeout(timeoutMs);
  const networkAudit = installBrowserNetworkAudit(context, baseUrl, slot);
  await context.addInitScript(installSanitizedCaptureAndPicker, {
    captureStorageKey,
    eventQueueStorageKey,
  });
  await seedSyntheticSession({
    actorId,
    baseUrl,
    context,
    displayName,
    sessionSecret,
  });

  if (slot === "P1") {
    const syntheticReferenceUrl = new URL(
      "/__aais-synthetic-reference",
      baseUrl,
    ).href;
    let guideRequestCount = 0;
    await context.route("**/api/learning/ai-guide", async (route) => {
      guideRequestCount += 1;
      if (guideRequestCount === 1) {
        await route.fulfill({
          status: 200,
          contentType: "application/json",
          body: "{}",
        });
        return;
      }
      if (guideRequestCount === 2) {
        await route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({
            message: { text: "Synthetic AAIS guide response." },
            turns: [{
              agentId: "A1",
              label: "导学智能体",
              content:
                `[Synthetic research reference](${syntheticReferenceUrl})`,
              actions: ["guide-flow"],
            }],
            orchestration: {
              graph: {
                graphId: "synthetic-browser-rehearsal",
                topologicalOrder: ["A1"],
              },
              runtime: { timings: { fallback: false } },
            },
          }),
        });
        return;
      }
      await route.fulfill({
        status: 500,
        contentType: "application/json",
        body: JSON.stringify({ error: "unexpected synthetic guide request" }),
      });
    });
    await context.route("**/api/learning/session", async (route) => {
      if (route.request().method() !== "PATCH") {
        await route.continue();
        return;
      }
      const response = await route.fetch();
      await delay(350);
      await route.fulfill({ response });
    });
    await context.route("**/__aais-synthetic-reference", async (route) => {
      await route.fulfill({
        status: 200,
        contentType: "text/html",
        body: "<!doctype html><title>Synthetic AAIS reference</title>",
      });
    });
  }
  await context.routeWebSocket("**/*", async (websocket) => {
    networkAudit.recordWebsocketAttempt(websocket.url());
    await websocket.close({ code: 1008, reason: "controlled-rehearsal-block" });
  });
  await context.route("**/*", async (route) => {
    const classification = classifyBrowserNetworkUrl(
      route.request().url(),
      new URL(baseUrl).origin,
    );
    networkAudit.recordRouteGuard(classification);
    if (!classification.valid || !classification.local) {
      await route.abort("blockedbyclient");
      return;
    }
    await route.fallback();
  });

  const page = await context.newPage();
  let participantResult;
  try {
    await page.goto("/learning", { waitUntil: "domcontentloaded" });
    await page.locator('[data-research-boundary-state="ready"]').waitFor();
    await page.getByTestId("learning-shell").waitFor();
    await waitForCaptureCount(page, 2);
    const visit = await readSanitizedVisit(page);
    await networkAudit.waitForIdle(timeoutMs);

    if (slot === "P1") {
      await driveFullCoverageParticipant({ context, displayName, page });
    } else {
      await driveMinimalParticipant({ displayName, page });
    }
    await waitForCaptureCount(page, expectedEvents.length);
    const capture = await readSanitizedCapture(page);
    await networkAudit.waitForIdle(timeoutMs);
    participantResult = { capture, slot, visit };
  } finally {
    await context.close();
  }
  const browserNetworkAudit = await networkAudit.finalize(timeoutMs);
  return { ...participantResult, browserNetworkAudit };
}

async function driveFullCoverageParticipant({ context, displayName, page }) {
  let expectedCount = 2;
  await context.setOffline(true);
  await context.setOffline(false);
  expectedCount = 4;
  await waitForCaptureCount(page, expectedCount);
  await page.locator('[data-research-boundary-state="ready"]').waitFor();

  const accountMenuButton = page.getByLabel(`${displayName} 账户菜单`);
  await accountMenuButton.click();
  await waitForCaptureCount(page, ++expectedCount);

  await page.getByRole("menuitem", { name: "导出学习数据" }).click();
  expectedCount += 2;
  await waitForCaptureCount(page, expectedCount);

  await page.getByRole("menuitem", { name: "导出学习数据" }).click();
  expectedCount += 2;
  await waitForCaptureCount(page, expectedCount);

  await accountMenuButton.click();
  await waitForCaptureCount(page, ++expectedCount);
  page.once("dialog", (dialog) => {
    void dialog.dismiss();
  });
  await page.getByRole("menuitem", { name: "删除学习数据" }).click();
  await waitForCaptureCount(page, ++expectedCount);
  await accountMenuButton.click();
  await waitForCaptureCount(page, ++expectedCount);

  await page.getByRole("button", { name: "平台介绍" }).click();
  await waitForCaptureCount(page, ++expectedCount);
  await page.getByLabel("返回内容展示").click();
  await waitForCaptureCount(page, ++expectedCount);
  await page.getByRole("separator", { name: "调整内容展示区域宽度" })
    .press("ArrowLeft");
  await waitForCaptureCount(page, ++expectedCount);
  await page.getByRole("button", { name: "文档编辑" }).click();
  await waitForCaptureCount(page, ++expectedCount);

  const title = page.getByLabel("文档标题");
  const editor = page.getByRole("textbox", {
    name: "在这里写下任务理解、计划、执行过程或最终产出。",
  });
  await title.fill("Synthetic rehearsal document");
  await editor.click();
  await waitForCaptureCount(page, ++expectedCount);
  await editor.fill("Synthetic browser rehearsal artifact only.");
  await page.getByLabel("向智能导学输入你的想法").click();
  expectedCount += 2;
  await waitForCaptureCount(page, expectedCount);

  await editor.click();
  await page.getByRole("button", { name: "加粗" }).click();
  await waitForCaptureCount(page, ++expectedCount);
  await page.getByRole("button", { name: "下载到本地" }).click();
  expectedCount += 4;
  await waitForCaptureCount(page, expectedCount);
  await page.getByRole("button", { name: "保存并关闭" }).click();
  await waitForCaptureCount(page, ++expectedCount);
  await page.getByRole("button", {
    name: "历史文档文件夹：Synthetic rehearsal document",
  }).click();
  await waitForCaptureCount(page, ++expectedCount);

  const chooserPromise = page.waitForEvent("filechooser");
  await page.getByRole("button", { name: "Upload file" }).click();
  const chooser = await chooserPromise;
  await chooser.setFiles({
    name: "synthetic-aais-upload.txt",
    mimeType: "text/plain",
    buffer: Buffer.from("Synthetic AAIS attachment. No participant text.", "utf8"),
  });
  expectedCount += 3;
  await waitForCaptureCount(page, expectedCount);
  await page.getByRole("button", { name: "移除 synthetic-aais-upload.txt" }).click();
  await waitForCaptureCount(page, ++expectedCount);

  await page.getByRole("button", { name: "明确学习目标" }).click();
  expectedCount += 4;
  await waitForCaptureCount(page, expectedCount);
  const popupPromise = page.waitForEvent("popup");
  await page.getByRole("link", { name: "Synthetic research reference" }).click();
  const popup = await popupPromise;
  await popup.waitForLoadState("domcontentloaded");
  await popup.close();
  await waitForCaptureCount(page, ++expectedCount);

  await accountMenuButton.click();
  await waitForCaptureCount(page, ++expectedCount);
  page.once("dialog", (dialog) => {
    void dialog.accept();
  });
  await page.getByRole("menuitem", { name: "删除学习数据" }).click();
  expectedCount += 2;
  await waitForCaptureCount(page, expectedCount);
  await accountMenuButton.click();
  await waitForCaptureCount(page, ++expectedCount);
  await page.getByRole("menuitem", { name: "退出" }).click();
  expectedCount += 2;
  await page.waitForURL(/\/login(?:\?|$)/);
  await waitForCaptureCount(page, expectedCount);
}

async function driveMinimalParticipant({ displayName, page }) {
  const accountMenuButton = page.getByLabel(`${displayName} 账户菜单`);
  await accountMenuButton.click();
  await waitForCaptureCount(page, 3);
  await page.getByRole("menuitem", { name: "退出" }).click();
  await page.waitForURL(/\/login(?:\?|$)/);
  await waitForCaptureCount(page, 5);
}

function installSanitizedCaptureAndPicker({
  captureStorageKey: storageKey,
  eventQueueStorageKey: queueKey,
}) {
  const emptyState = () => ({
    acknowledgements: [],
    semanticEvents: [],
    errors: [],
    researchEventPostAttempts: 0,
    researchEventPost201: 0,
    researchEventPostNon201: 0,
    logoutDeleteAttempts: 0,
    logoutDelete200: 0,
  });
  const readState = () => {
    try {
      const value = JSON.parse(window.sessionStorage.getItem(storageKey) || "null");
      return value && typeof value === "object" ? value : emptyState();
    } catch {
      return emptyState();
    }
  };
  const writeState = (state) => {
    window.sessionStorage.setItem(storageKey, JSON.stringify(state));
  };
  if (!window.sessionStorage.getItem(storageKey)) {
    writeState(emptyState());
  }

  let savePickerCalls = 0;
  Object.defineProperty(window, "showSaveFilePicker", {
    configurable: true,
    value: async () => {
      savePickerCalls += 1;
      if (savePickerCalls === 1) {
        throw new DOMException("Synthetic user cancellation.", "AbortError");
      }
      return {
        createWritable: async () => ({
          write: async () => undefined,
          close: async () => undefined,
        }),
      };
    },
  });

  const originalFetch = window.fetch.bind(window);
  window.fetch = async (input, init) => {
    const inputUrl = typeof input === "string"
      ? input
      : input instanceof URL
        ? input.href
        : input.url;
    const url = new URL(inputUrl, window.location.href);
    const inputMethod = typeof input === "object"
      && !(input instanceof URL)
      && "method" in input
      ? input.method
      : undefined;
    const method = String(init?.method || inputMethod || "GET").toUpperCase();
    const isResearchEvent = url.pathname === "/api/research/events" && method === "POST";
    const isLogout = url.pathname === "/api/auth/app-session" && method === "DELETE";
    if (isResearchEvent || isLogout) {
      const state = readState();
      if (isResearchEvent) {
        state.researchEventPostAttempts += 1;
      } else {
        state.logoutDeleteAttempts += 1;
      }
      writeState(state);
    }

    let response;
    try {
      response = await originalFetch(input, init);
    } catch (error) {
      if (isResearchEvent) {
        const state = readState();
        state.researchEventPostNon201 += 1;
        state.errors.push("research_event_transport_failure");
        writeState(state);
      } else if (isLogout) {
        const state = readState();
        state.errors.push("logout_transport_failure");
        writeState(state);
      }
      throw error;
    }
    if (!isResearchEvent && !isLogout) {
      return response;
    }

    const body = await response.clone().json().catch(() => null);
    const state = readState();
    if (isResearchEvent) {
      if (response.status !== 201) {
        state.researchEventPostNon201 += 1;
        state.errors.push("research_event_non_201");
        writeState(state);
        return response;
      }
      const clientEventId = body?.event?.clientEventId;
      const visitId = body?.event?.visitId;
      const eventSequence = body?.event?.eventSequence;
      let queue = [];
      try {
        const candidate = JSON.parse(window.localStorage.getItem(queueKey) || "[]");
        queue = Array.isArray(candidate) ? candidate : [];
      } catch {
        state.errors.push("research_event_queue_unreadable");
      }
      const queuedEvent = queue.find((event) =>
        event && event.clientEventId === clientEventId);
      if (
        typeof clientEventId !== "string"
        || typeof visitId !== "string"
        || !Number.isInteger(eventSequence)
        || !queuedEvent
        || typeof queuedEvent.eventName !== "string"
        || typeof queuedEvent.outcome !== "string"
      ) {
        state.errors.push("research_event_ack_projection_invalid");
        writeState(state);
        return response;
      }
      state.researchEventPost201 += 1;
      state.acknowledgements.push({
        route: "/api/research/events",
        method: "POST",
        status: 201,
        client_event_id: clientEventId,
        visit_id: visitId,
      });
      state.semanticEvents.push({
        client_event_id: clientEventId,
        visit_id: visitId,
        event_sequence: eventSequence,
        event_name: queuedEvent.eventName,
        outcome: queuedEvent.outcome,
      });
      writeState(state);
      return response;
    }

    if (response.status !== 200) {
      state.errors.push("logout_non_200");
      writeState(state);
      return response;
    }
    const clientEventId = body?.researchLogout?.clientEventId;
    const visitId = body?.researchLogout?.visitId;
    if (typeof clientEventId !== "string" || typeof visitId !== "string") {
      state.errors.push("logout_ack_projection_invalid");
      writeState(state);
      return response;
    }
    state.logoutDelete200 += 1;
    state.acknowledgements.push({
      route: "/api/auth/app-session",
      method: "DELETE",
      status: 200,
      client_event_id: clientEventId,
      visit_id: visitId,
    });
    state.semanticEvents.push({
      client_event_id: clientEventId,
      visit_id: visitId,
      event_sequence: null,
      event_name: "account_logout",
      outcome: "success",
    });
    writeState(state);
    return response;
  };
}

async function seedSyntheticSession({
  actorId,
  baseUrl,
  context,
  displayName,
  sessionSecret,
}) {
  const actor = { id: actorId, role: "student", displayName };
  const csrfToken = createCsrfToken(actorId, sessionSecret);
  const secure = new URL(baseUrl).protocol === "https:";
  await context.addCookies([
    {
      name: sessionCookieName,
      value: createSessionToken(actor, sessionSecret),
      url: baseUrl,
      httpOnly: true,
      sameSite: "Lax",
      secure,
    },
    {
      name: csrfCookieName,
      value: csrfToken,
      url: baseUrl,
      sameSite: "Lax",
      secure,
    },
    {
      name: "aais_student_id",
      value: actorId,
      url: baseUrl,
      sameSite: "Lax",
      secure,
    },
    {
      name: "aais_display_name",
      value: displayName,
      url: baseUrl,
      sameSite: "Lax",
      secure,
    },
  ]);
  await context.addInitScript(({ syntheticActorId, syntheticDisplayName }) => {
    window.localStorage.setItem("aais_student_id", syntheticActorId);
    window.localStorage.setItem("aais_display_name", syntheticDisplayName);
  }, {
    syntheticActorId: actorId,
    syntheticDisplayName: displayName,
  });
}

function createSessionToken(actor, secret) {
  const issuedAt = Math.floor(Date.now() / 1000);
  return signPayload({
    v: 1,
    actor,
    iat: issuedAt,
    exp: issuedAt + sessionTtlSeconds,
  }, secret);
}

function createCsrfToken(actorId, secret) {
  const issuedAt = Math.floor(Date.now() / 1000);
  return signPayload({
    v: 1,
    sub: actorId,
    iat: issuedAt,
    exp: issuedAt + sessionTtlSeconds,
  }, secret);
}

function signPayload(payload, secret) {
  const encoded = Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
  const signature = createHmac("sha256", secret)
    .update(encoded)
    .digest("base64url");
  return `${encoded}.${signature}`;
}

async function readSanitizedVisit(page) {
  const visit = await page.evaluate((key) => {
    const raw = window.localStorage.getItem(key);
    if (!raw) {
      return null;
    }
    const value = JSON.parse(raw);
    return {
      participantId: value.participantId,
      studyRunId: value.studyRunId,
      visitId: value.visitId,
      condition: value.condition,
    };
  }, visitStorageKey);
  if (!isSafeVisit(visit)) {
    throw new Error("AAIS research visit projection is unavailable or invalid.");
  }
  return visit;
}

async function readSanitizedCapture(page) {
  const capture = await page.evaluate((key) => {
    const value = JSON.parse(window.sessionStorage.getItem(key) || "null");
    return {
      acknowledgements: value?.acknowledgements ?? [],
      semanticEvents: value?.semanticEvents ?? [],
      errors: value?.errors ?? [],
      researchEventPostAttempts: value?.researchEventPostAttempts ?? 0,
      researchEventPost201: value?.researchEventPost201 ?? 0,
      researchEventPostNon201: value?.researchEventPostNon201 ?? 0,
      logoutDeleteAttempts: value?.logoutDeleteAttempts ?? 0,
      logoutDelete200: value?.logoutDelete200 ?? 0,
    };
  }, captureStorageKey);
  if (
    !capture
    || !Array.isArray(capture.acknowledgements)
    || !Array.isArray(capture.semanticEvents)
    || !Array.isArray(capture.errors)
  ) {
    throw new Error("AAIS browser capture projection is invalid.");
  }
  return capture;
}

async function waitForCaptureCount(page, count) {
  await page.waitForFunction(
    ({ key, expected }) => {
      try {
        const value = JSON.parse(window.sessionStorage.getItem(key) || "null");
        return Array.isArray(value?.semanticEvents)
          && value.semanticEvents.length >= expected;
      } catch {
        return false;
      }
    },
    { key: captureStorageKey, expected: count },
  );
}

function buildTransportSummary({ acknowledgements, captures, generatedAt }) {
  const researchEventPostAttempts = captures.reduce(
    (total, capture) => total + capture.researchEventPostAttempts,
    0,
  );
  const researchEventPost201 = captures.reduce(
    (total, capture) => total + capture.researchEventPost201,
    0,
  );
  const researchEventPostNon201 = captures.reduce(
    (total, capture) => total + capture.researchEventPostNon201,
    0,
  );
  const logoutDeleteAttempts = captures.reduce(
    (total, capture) => total + capture.logoutDeleteAttempts,
    0,
  );
  const logoutDelete200 = captures.reduce(
    (total, capture) => total + capture.logoutDelete200,
    0,
  );
  if (
    researchEventPostAttempts !== researchEventPost201 + researchEventPostNon201
    || researchEventPostNon201 !== 0
    || logoutDeleteAttempts !== logoutDelete200
    || acknowledgements.length !== researchEventPost201 + logoutDelete200
  ) {
    throw new Error("AAIS browser transport acknowledgement arithmetic failed.");
  }
  return {
    evidence_schema_version: 3,
    generated_at: generatedAt,
    source:
      "Sanitized in-page response acknowledgements matched to the local event queue before queue removal; request bodies, headers, cookies, credentials, names, and raw text were not read or retained.",
    source_trace_retained: false,
    source_trace_recomputation_available: false,
    raw_playwright_internal_artifacts_retained: false,
    research_event_post_attempts: researchEventPostAttempts,
    research_event_post_201: researchEventPost201,
    research_event_post_non_201: researchEventPostNon201,
    logout_delete_attempts: logoutDeleteAttempts,
    logout_delete_200: logoutDelete200,
    transport_event_acknowledgements: acknowledgements.length,
    acknowledgements,
  };
}

function createManifestParticipant(slot, events) {
  return {
    slot,
    physical_ui_triggers: physicalInteractionContract[slot].length,
    expected_events: events.map(([eventName, outcome], index) => ({
      sequence: index + 1,
      event_name: eventName,
      outcome,
    })),
  };
}

function assertStrictAcknowledgements(acknowledgements) {
  for (const item of acknowledgements) {
    const keys = Object.keys(item).sort().join("|");
    if (
      keys !== [
        "client_event_id",
        "method",
        "route",
        "status",
        "visit_id",
      ].sort().join("|")
      || !uuidPattern.test(item.client_event_id)
      || !uuidPattern.test(item.visit_id)
      || !(
        item.route === "/api/research/events"
          && item.method === "POST"
          && item.status === 201
      )
      && !(
        item.route === "/api/auth/app-session"
          && item.method === "DELETE"
          && item.status === 200
      )
    ) {
      throw new Error("AAIS browser capture contains a non-sanitized acknowledgement.");
    }
  }
}

function isSafeVisit(value) {
  return Boolean(value)
    && uuidPattern.test(value.participantId)
    && uuidPattern.test(value.studyRunId)
    && uuidPattern.test(value.visitId)
    && typeof value.condition === "string"
    && /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(value.condition)
    && Object.keys(value).sort().join("|")
      === ["condition", "participantId", "studyRunId", "visitId"].sort().join("|");
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

export function classifyBrowserNetworkUrl(value, allowedOrigin) {
  let parsed;
  let allowed;
  try {
    parsed = new URL(String(value));
    allowed = new URL(String(allowedOrigin));
  } catch {
    return { externalOriginSha256: null, local: false, valid: false };
  }
  if (!["http:", "https:", "ws:", "wss:"].includes(parsed.protocol)
    || !["http:", "https:"].includes(allowed.protocol)
    || parsed.username
    || parsed.password
    || allowed.username
    || allowed.password) {
    return { externalOriginSha256: null, local: false, valid: false };
  }
  const normalizedProtocol = parsed.protocol === "ws:"
    ? "http:"
    : parsed.protocol === "wss:"
      ? "https:"
      : parsed.protocol;
  const normalizedOrigin = `${normalizedProtocol}//${parsed.host}`;
  const local = normalizedOrigin === allowed.origin;
  return {
    externalOriginSha256: local ? null : sha256(normalizedOrigin),
    local,
    valid: true,
  };
}

function installBrowserNetworkAudit(context, baseUrl, slot) {
  const allowedOrigin = new URL(baseUrl).origin;
  const inFlight = new Set();
  const recordByRequest = new WeakMap();
  const requestRecords = [];
  const resourceTypeCounts = new Map();
  const allowedMethods = new Set([
    "DELETE", "GET", "HEAD", "OPTIONS", "PATCH", "POST", "PUT",
  ]);
  let requestCount = 0;
  let localRequestCount = 0;
  let nonLocalRequestCount = 0;
  let invalidRequestUrlCount = 0;
  let invalidMethodCount = 0;
  let requestFinishedCount = 0;
  let requestFailedCount = 0;
  let websocketCount = 0;
  let localWebsocketCount = 0;
  let nonLocalWebsocketCount = 0;
  let invalidWebsocketUrlCount = 0;
  let serviceWorkerCount = 0;
  let downloadCount = 0;
  let observerErrorCount = 0;
  let routeGuardRequestCount = 0;
  let routeGuardLocalRequestCount = 0;
  let routeGuardNonLocalRequestCount = 0;
  let routeGuardInvalidRequestCount = 0;
  let finalized = false;
  let lastNetworkActivityAt = Date.now();
  const captureStartedAt = new Date().toISOString();

  context.on("request", (request) => {
    lastNetworkActivityAt = Date.now();
    requestCount += 1;
    inFlight.add(request);
    const resourceType = String(request.resourceType() || "other").toLowerCase();
    const safeResourceType = /^[a-z][a-z-]{0,31}$/.test(resourceType)
      ? resourceType
      : "invalid";
    const rawMethod = String(request.method() || "").toUpperCase();
    const method = allowedMethods.has(rawMethod) ? rawMethod : "UNEXPECTED";
    if (method === "UNEXPECTED") invalidMethodCount += 1;
    const classification = classifyBrowserNetworkUrl(request.url(), allowedOrigin);
    const destinationClass = classification.valid
      ? classification.local ? "same_origin" : "non_local"
      : "invalid";
    const record = {
      context_slot: slot,
      context_request_sequence: requestCount,
      method,
      resource_type: safeResourceType,
      destination_class: destinationClass,
      terminal_outcome: null,
      response_status: null,
    };
    requestRecords.push(record);
    recordByRequest.set(request, record);
    resourceTypeCounts.set(
      safeResourceType,
      (resourceTypeCounts.get(safeResourceType) ?? 0) + 1,
    );
    recordClassification(classification, {
      invalid: () => { invalidRequestUrlCount += 1; },
      local: () => { localRequestCount += 1; },
      nonLocal: () => { nonLocalRequestCount += 1; },
    });
  });
  context.on("response", (response) => {
    lastNetworkActivityAt = Date.now();
    const record = recordByRequest.get(response.request());
    const status = response.status();
    if (!record || !Number.isInteger(status) || status < 100 || status > 599) {
      observerErrorCount += 1;
      return;
    }
    record.response_status = status;
  });
  const finishRequest = (request, outcome) => {
    lastNetworkActivityAt = Date.now();
    const record = recordByRequest.get(request);
    if (!record || record.terminal_outcome !== null) {
      observerErrorCount += 1;
    } else {
      record.terminal_outcome = outcome;
    }
    inFlight.delete(request);
  };
  context.on("requestfinished", (request) => {
    requestFinishedCount += 1;
    finishRequest(request, "finished");
  });
  context.on("requestfailed", (request) => {
    requestFailedCount += 1;
    finishRequest(request, "failed");
  });
  context.on("serviceworker", () => {
    lastNetworkActivityAt = Date.now();
    serviceWorkerCount += 1;
  });
  context.on("download", () => {
    lastNetworkActivityAt = Date.now();
    downloadCount += 1;
  });

  const waitForIdle = async (timeoutMs) => {
    const boundedTimeout = Math.min(
      Math.max(Number(timeoutMs) || 5_000, 5_000),
      120_000,
    );
    const deadline = Date.now() + boundedTimeout;
    while (Date.now() < deadline) {
      if (hasStableBrowserNetworkIdle({
        inFlightCount: inFlight.size,
        lastNetworkActivityAt,
        now: Date.now(),
      })) {
        return;
      }
      await delay(50);
    }
    throw new Error("AAIS browser network audit did not reach a stable idle window.");
  };

  return {
    recordRouteGuard(classification) {
      routeGuardRequestCount += 1;
      recordClassification(classification, {
        invalid: () => { routeGuardInvalidRequestCount += 1; },
        local: () => { routeGuardLocalRequestCount += 1; },
        nonLocal: () => { routeGuardNonLocalRequestCount += 1; },
      });
    },
    recordWebsocketAttempt(url) {
      lastNetworkActivityAt = Date.now();
      websocketCount += 1;
      recordClassification(classifyBrowserNetworkUrl(url, allowedOrigin), {
        invalid: () => { invalidWebsocketUrlCount += 1; },
        local: () => { localWebsocketCount += 1; },
        nonLocal: () => { nonLocalWebsocketCount += 1; },
      });
    },
    waitForIdle,
    async finalize(timeoutMs) {
      if (finalized) {
        throw new Error("AAIS browser network audit cannot be finalized twice.");
      }
      finalized = true;
      await waitForIdle(timeoutMs);
      const captureEndedAt = new Date().toISOString();
      const networkGatePassed = requestCount > 0
        && requestCount === requestRecords.length
        && requestCount === localRequestCount
        && nonLocalRequestCount === 0
        && invalidRequestUrlCount === 0
        && invalidMethodCount === 0
        && requestFinishedCount + requestFailedCount === requestCount
        && requestFailedCount === 0
        && requestRecords.every((record) =>
          record.terminal_outcome === "finished"
            && Number.isInteger(record.response_status)
            && record.response_status >= 100
            && record.response_status < 400)
        && inFlight.size === 0
        && routeGuardRequestCount === requestCount
        && routeGuardLocalRequestCount === requestCount
        && routeGuardNonLocalRequestCount === 0
        && routeGuardInvalidRequestCount === 0
        && websocketCount === 0
        && localWebsocketCount === 0
        && nonLocalWebsocketCount === 0
        && invalidWebsocketUrlCount === 0
        && serviceWorkerCount === 0
        && downloadCount === 0
        && observerErrorCount === 0;
      return {
        captureStartedAt,
        captureEndedAt,
        downloadCount,
        inFlightRequestCount: inFlight.size,
        invalidMethodCount,
        invalidRequestUrlCount,
        invalidWebsocketUrlCount,
        localRequestCount,
        localWebsocketCount,
        networkGatePassed,
        nonLocalRequestCount,
        nonLocalWebsocketCount,
        observerErrorCount,
        requestCount,
        requestFailedCount,
        requestFinishedCount,
        requestRecords: requestRecords.map((record) => ({ ...record })),
        routeGuardInvalidRequestCount,
        routeGuardLocalRequestCount,
        routeGuardNonLocalRequestCount,
        routeGuardRequestCount,
        resourceTypeCounts: Object.fromEntries(
          [...resourceTypeCounts.entries()].sort(([left], [right]) =>
            left.localeCompare(right)),
        ),
        serviceWorkerCount,
        websocketCount,
      };
    },
  };
}

export function hasStableBrowserNetworkIdle({
  inFlightCount,
  lastNetworkActivityAt,
  now,
}) {
  return inFlightCount === 0
    && Number.isFinite(lastNetworkActivityAt)
    && Number.isFinite(now)
    && now >= lastNetworkActivityAt
    && now - lastNetworkActivityAt >= networkIdleQuietWindowMilliseconds;
}

function recordClassification(classification, handlers) {
  if (!classification.valid) {
    handlers.invalid();
  } else if (classification.local) {
    handlers.local();
  } else {
    handlers.nonLocal(classification.externalOriginSha256);
  }
}

export function buildBrowserNetworkSummary({
  baseUrl,
  environment,
  generatedAt,
  lrsNamespace,
  manifestSha256,
  participantRuns,
  projectId,
  studyId,
}) {
  const audits = participantRuns.map((run) => run.browserNetworkAudit);
  if (audits.length !== 3 || audits.some((audit) => !audit)) {
    throw new Error("AAIS browser network audit must cover all three contexts.");
  }
  if (!isIsoDate(generatedAt)
    || !/^[a-f0-9]{64}$/.test(manifestSha256)
    || new URL(baseUrl).origin !== baseUrl) {
    throw new Error("AAIS browser network audit scope is invalid.");
  }
  const numericFields = [
    "requestCount", "localRequestCount", "nonLocalRequestCount",
    "invalidRequestUrlCount", "invalidMethodCount", "requestFinishedCount",
    "requestFailedCount", "downloadCount", "observerErrorCount",
    "routeGuardRequestCount", "routeGuardLocalRequestCount",
    "routeGuardNonLocalRequestCount", "routeGuardInvalidRequestCount",
    "inFlightRequestCount", "websocketCount", "localWebsocketCount",
    "nonLocalWebsocketCount", "invalidWebsocketUrlCount", "serviceWorkerCount",
  ];
  const recordKeys = [
    "context_slot", "context_request_sequence", "method", "resource_type",
    "destination_class", "terminal_outcome", "response_status",
  ].sort().join("|");
  const allowedMethods = new Set([
    "DELETE", "GET", "HEAD", "OPTIONS", "PATCH", "POST", "PUT",
  ]);
  for (let index = 0; index < audits.length; index += 1) {
    const audit = audits[index];
    const expectedSlot = `P${index + 1}`;
    const recordShapeIsSafe = Array.isArray(audit.requestRecords)
      && audit.requestRecords.length === audit.requestCount
      && audit.requestRecords.every((record, recordIndex) =>
        record
          && Object.keys(record).sort().join("|") === recordKeys
          && record.context_slot === expectedSlot
          && record.context_request_sequence === recordIndex + 1
          && allowedMethods.has(record.method)
          && /^[a-z][a-z-]{0,31}$/.test(record.resource_type)
          && record.destination_class === "same_origin"
          && record.terminal_outcome === "finished"
          && Number.isInteger(record.response_status)
          && record.response_status >= 100
          && record.response_status < 400);
    const resourceTypeTotal = audit.resourceTypeCounts
      && typeof audit.resourceTypeCounts === "object"
      ? Object.values(audit.resourceTypeCounts).reduce(
        (sum, count) => sum + (Number.isInteger(count) ? count : 0),
        0,
      )
      : -1;
    if (!audit.networkGatePassed
      || numericFields.some((field) => !Number.isInteger(audit[field]) || audit[field] < 0)
      || !isIsoDate(audit.captureStartedAt)
      || !isIsoDate(audit.captureEndedAt)
      || new Date(audit.captureEndedAt) < new Date(audit.captureStartedAt)
      || !recordShapeIsSafe
      || resourceTypeTotal !== audit.requestCount
      || audit.requestCount < 1
      || audit.requestCount !== audit.localRequestCount
      || audit.nonLocalRequestCount !== 0
      || audit.invalidRequestUrlCount !== 0
      || audit.invalidMethodCount !== 0
      || audit.requestFinishedCount + audit.requestFailedCount !== audit.requestCount
      || audit.requestFailedCount !== 0
      || audit.inFlightRequestCount !== 0
      || audit.routeGuardRequestCount !== audit.requestCount
      || audit.routeGuardLocalRequestCount !== audit.requestCount
      || audit.routeGuardNonLocalRequestCount !== 0
      || audit.routeGuardInvalidRequestCount !== 0
      || audit.websocketCount !== 0
      || audit.localWebsocketCount !== 0
      || audit.nonLocalWebsocketCount !== 0
      || audit.invalidWebsocketUrlCount !== 0
      || audit.serviceWorkerCount !== 0
      || audit.downloadCount !== 0
      || audit.observerErrorCount !== 0) {
      throw new Error(
        `AAIS browser network audit failed closed (${expectedSlot}: ${[
          `context_gate=${audit.networkGatePassed === true}`,
          `record_shape=${recordShapeIsSafe}`,
          `requests=${safeAuditCount(audit.requestCount)}`,
          `local=${safeAuditCount(audit.localRequestCount)}`,
          `non_local=${safeAuditCount(audit.nonLocalRequestCount)}`,
          `finished=${safeAuditCount(audit.requestFinishedCount)}`,
          `failed=${safeAuditCount(audit.requestFailedCount)}`,
          `in_flight=${safeAuditCount(audit.inFlightRequestCount)}`,
          `route_guard=${safeAuditCount(audit.routeGuardRequestCount)}`,
          `websocket=${safeAuditCount(audit.websocketCount)}`,
          `service_worker=${safeAuditCount(audit.serviceWorkerCount)}`,
          `download=${safeAuditCount(audit.downloadCount)}`,
          `observer_error=${safeAuditCount(audit.observerErrorCount)}`,
          `non_success=${JSON.stringify(audit.requestRecords
            .filter((record) => record.terminal_outcome !== "finished"
              || !Number.isInteger(record.response_status)
              || record.response_status < 100
              || record.response_status >= 400)
            .map((record) => ({
              sequence: record.context_request_sequence,
              method: record.method,
              resource_type: record.resource_type,
              terminal_outcome: record.terminal_outcome,
              response_status: record.response_status,
            })))}`,
        ].join(", ")}).`,
      );
    }
  }
  const total = (field) => audits.reduce((sum, audit) => sum + audit[field], 0);
  const resourceTypeCounts = {};
  const requestRecords = [];
  for (const audit of audits) {
    for (const [resourceType, count] of Object.entries(audit.resourceTypeCounts)) {
      if (!/^[a-z][a-z-]{0,31}$/.test(resourceType)
        || !Number.isInteger(count)
        || count < 0) {
        throw new Error("AAIS browser network resource classification is invalid.");
      }
      resourceTypeCounts[resourceType] = (resourceTypeCounts[resourceType] ?? 0) + count;
    }
    for (const record of audit.requestRecords) {
      requestRecords.push({
        sequence: requestRecords.length + 1,
        ...record,
      });
    }
  }
  return {
    evidence_schema_version: 1,
    artifact_type: "aais-browser-context-network-audit",
    generated_at: generatedAt,
    capture_started_at: audits.map((audit) => audit.captureStartedAt).sort()[0],
    capture_ended_at: audits.map((audit) => audit.captureEndedAt).sort().at(-1),
    capture_scope:
      "playwright-observable-http(s)-requests-and-routed-websocket-attempts-in-three-isolated-contexts",
    source:
      "Playwright BrowserContext request, response, requestfinished, requestfailed, page, route, and routed-WebSocket lifecycle with service workers blocked; every non-local HTTP(S) route is aborted before egress.",
    project_id: projectId,
    study_id: studyId,
    environment,
    lrs_namespace: lrsNamespace,
    manifest_sha256: manifestSha256,
    browser_engine: "chromium",
    http_policy: "exact-base-origin-only-route-guard",
    websocket_policy: "all-websocket-attempts-blocked-zero-expected",
    participant_context_count: audits.length,
    context_gate_pass_count: audits.filter((audit) => audit.networkGatePassed).length,
    service_worker_policy: "blocked",
    service_worker_count: total("serviceWorkerCount"),
    total_request_count: total("requestCount"),
    local_request_count: total("localRequestCount"),
    non_local_request_count: total("nonLocalRequestCount"),
    invalid_request_url_count: total("invalidRequestUrlCount"),
    invalid_method_count: total("invalidMethodCount"),
    request_finished_count: total("requestFinishedCount"),
    request_failed_count: total("requestFailedCount"),
    in_flight_request_count: total("inFlightRequestCount"),
    route_guard_request_count: total("routeGuardRequestCount"),
    route_guard_local_request_count: total("routeGuardLocalRequestCount"),
    route_guard_non_local_request_count: total("routeGuardNonLocalRequestCount"),
    route_guard_invalid_request_count: total("routeGuardInvalidRequestCount"),
    route_guard_coverage_match:
      total("routeGuardRequestCount") === total("requestCount"),
    websocket_count: total("websocketCount"),
    local_websocket_count: total("localWebsocketCount"),
    non_local_websocket_count: total("nonLocalWebsocketCount"),
    invalid_websocket_url_count: total("invalidWebsocketUrlCount"),
    download_count: total("downloadCount"),
    download_policy: "forbidden",
    observer_error_count: total("observerErrorCount"),
    request_resource_type_counts: Object.fromEntries(
      Object.entries(resourceTypeCounts).sort(([left], [right]) =>
        left.localeCompare(right)),
    ),
    request_records: requestRecords,
    local_origin_sha256: sha256(new URL(baseUrl).origin),
    external_origin_hash_count: 0,
    browser_network_gate_passed: true,
    raw_request_urls_retained: false,
    request_headers_retained: false,
    request_bodies_retained: false,
    response_bodies_retained: false,
    websocket_frames_retained: false,
    download_files_retained: false,
    cookies_retained: false,
    raw_playwright_artifacts_retained: false,
    secrets: "redacted",
  };
}

function safeAuditCount(value) {
  return Number.isInteger(value) && value >= 0 ? value : -1;
}

function isIsoDate(value) {
  return typeof value === "string"
    && !Number.isNaN(new Date(value).getTime())
    && new Date(value).toISOString() === value;
}

function readCliOptions(args) {
  const values = new Map();
  let headed = false;
  for (let index = 0; index < args.length; index += 1) {
    const name = args[index];
    if (name === "--headed") {
      headed = true;
      continue;
    }
    if (!name?.startsWith("--") || !args[index + 1]?.length) {
      throw new Error("AAIS browser rehearsal command-line options are invalid.");
    }
    values.set(name, args[index + 1]);
    index += 1;
  }
  const required = [
    "--base-url",
    "--output-dir",
    "--project-id",
    "--study-id",
    "--environment",
    "--lrs-store-id",
    "--lrs-namespace",
    "--participant-actors",
  ];
  for (const name of required) {
    if (!values.has(name)) {
      throw new Error(`Missing required option ${name}.`);
    }
  }
  return {
    baseUrl: values.get("--base-url"),
    outputDir: values.get("--output-dir"),
    projectId: values.get("--project-id"),
    studyId: values.get("--study-id"),
    environment: values.get("--environment"),
    lrsStoreId: values.get("--lrs-store-id"),
    lrsNamespace: values.get("--lrs-namespace"),
    participantActors: values.get("--participant-actors")
      .split(",")
      .map((value) => value.trim())
      .filter(Boolean),
    timeoutMs: values.get("--timeout-ms") ?? "30000",
    headed,
  };
}

async function writeJsonEvidence(filePath, value) {
  const content = `${JSON.stringify(value, null, 2)}\n`;
  await writeFile(filePath, content, { flag: "wx", mode: 0o600 });
  await chmod(filePath, 0o600);
  return content;
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function deepFreeze(value) {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) {
    return value;
  }
  for (const child of Object.values(value)) {
    deepFreeze(child);
  }
  return Object.freeze(value);
}

function delay(milliseconds) {
  return new Promise((resolve) => {
    setTimeout(resolve, milliseconds);
  });
}

function isDirectInvocation() {
  return Boolean(modulePath && process.argv[1])
    && path.resolve(process.argv[1]) === modulePath;
}
