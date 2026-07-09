#!/usr/bin/env node

import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

const defaultReleaseCheckReportPath = "output/aais-enterprise-release-check-latest.json";
const defaultHandoffReportPath = "output/aais-enterprise-handoff-latest.json";
const defaultOutputPath = "output/aais-enterprise-readiness-audit-latest.json";
const defaultMarkdownOutputPath = "output/aais-enterprise-readiness-audit-latest.md";
const businessGapDefinitions = [
  {
    id: "production-oidc-env-config",
    label: "Production OIDC environment and config",
    description: "Vercel production must have the required OIDC names and the deployed app must expose a working OIDC start route.",
    controlIds: ["vercel-production-env", "oidc-start"],
    appliesTo: (context) => context.ssoOnlyGate,
  },
  {
    id: "real-oidc-callback",
    label: "Real OIDC callback smoke",
    description: "A real IdP callback handoff must be verified with redacted callback evidence before SSO cutover.",
    controlIds: ["oidc-callback-handoff"],
    appliesTo: (context) => context.ssoOnlyGate,
  },
  {
    id: "sso-only-cutover",
    label: "SSO-only runtime cutover",
    description: "Trial login stays available until real OIDC callback and teacher/admin access are proven, then SSO-only runtime can be enabled.",
    controlIds: ["sso-only-mode"],
    appliesTo: (context) => context.ssoOnlyGate,
  },
  {
    id: "neon-restore-rehearsal",
    label: "Restored Neon rehearsal",
    description: "A restored staging Neon database must pass table presence and write/read/delete smoke checks without matching production sources.",
    controlIds: ["neon-restore-rehearsal"],
  },
  {
    id: "teacher-cohort-analytics",
    label: "Teacher cohort analytics",
    description: "Teacher/admin cohort analytics and export evidence must be proven from the same current auth-mode session.",
    controlIds: ["cohort-analytics"],
  },
  {
    id: "a1-a4-agent-evidence",
    label: "A1-A4 agent evidence",
    description: "Deployed readiness must prove A1 scaffolding, A2 expert coaching, A3 supervision signals, A4 articulation/reflection, AI acceptance, and raw-text exclusion.",
    controlIds: ["agent-evidence", "live-ai-eval"],
  },
  {
    id: "current-release-consistency",
    label: "Current release consistency",
    description: "The refreshed release evidence must come from the current source provenance, deployment identity, and final enterprise gate.",
    controlIds: ["release-consistency"],
  },
];

export async function auditAaisEnterpriseReadiness(input = {}) {
  const generatedAt = (input.now ?? new Date()).toISOString();
  const releaseCheckReportPath = input.releaseCheckReportPath ?? defaultReleaseCheckReportPath;
  const handoffReportPath = input.handoffReportPath ?? defaultHandoffReportPath;
  const outputPath = input.outputPath ?? process.env.AAIS_ENTERPRISE_AUDIT_REPORT_PATH ?? defaultOutputPath;
  const markdownOutputPath = input.markdownOutputPath
    ?? process.env.AAIS_ENTERPRISE_AUDIT_MARKDOWN_PATH
    ?? defaultMarkdownOutputPath;
  const gapEvidenceReportPath = input.gapEvidenceReportPath ?? process.env.AAIS_ENTERPRISE_GAP_REPORT_PATH;
  const releaseCheck = await readJsonIfExists(releaseCheckReportPath);
  const handoff = await readJsonIfExists(handoffReportPath);
  const gapEvidence = gapEvidenceReportPath ? await readJsonIfExists(gapEvidenceReportPath) : { value: null };
  const requiredControls = buildRequiredControls(releaseCheck.value, handoff.value, gapEvidence.value);
  const passed = requiredControls.filter((control) => control.status === "passed").length;
  const actionRequired = requiredControls.length - passed;
  const businessGaps = buildBusinessGapGroups(requiredControls);
  const businessGapsPassed = businessGaps.filter((gap) => gap.status === "passed").length;
  const report = {
    schemaVersion: 1,
    status: actionRequired === 0 ? "ready" : "action-required",
    generatedAt,
    sourceReports: {
      releaseCheck: releaseCheckReportPath,
      handoff: handoffReportPath,
      ...(gapEvidenceReportPath ? { gapEvidence: gapEvidenceReportPath } : {}),
    },
    gate: {
      status: normalizeStatus(releaseCheck.value?.status),
      checkedAt: readIsoTimestamp(releaseCheck.value?.checkedAt),
    },
    summary: {
      total: requiredControls.length,
      passed,
      actionRequired,
    },
    businessGapSummary: {
      total: businessGaps.length,
      passed: businessGapsPassed,
      actionRequired: businessGaps.length - businessGapsPassed,
    },
    businessGaps,
    requiredControls,
    redaction: {
      secrets: "omitted",
      values: "not-read",
    },
  };

  if (outputPath) {
    await writeTextFile(outputPath, `${JSON.stringify(report, null, 2)}\n`);
  }
  if (markdownOutputPath) {
    await writeTextFile(markdownOutputPath, renderMarkdown(report));
  }

  return report;
}

function buildRequiredControls(releaseCheck, handoff, gapEvidence) {
  const artifacts = releaseCheck?.artifacts ?? {};
  const vercelEnv = artifacts.vercelEnv ?? {};
  const enterprise = artifacts.enterprise ?? {};
  const requiredChecks = enterprise.requiredChecks ?? {};
  const readiness = enterprise.readiness ?? {};
  const vercelDeployment = artifacts.vercelDeployment ?? {};
  const aiEval = artifacts.aiEval ?? {};
  const postgresRestore = artifacts.postgresRestore ?? {};
  const vercelConfig = artifacts.vercelConfig ?? {};
  const handoffActionIds = new Set(
    Array.isArray(handoff?.externalActions)
      ? handoff.externalActions
        .map((action) => readSafeActionId(action?.id))
        .filter(Boolean)
      : [],
  );
  const missingEnv = getSafeEnvNames(vercelEnv.missing);
  const authMode = readAuthMode(vercelEnv.authMode ?? vercelEnv.target?.authMode, missingEnv);
  const ssoOnlyGate = authMode === "sso-only";
  const gapPreflight = getGapPreflightStatus(gapEvidence);

  const controls = [
    control({
      id: "vercel-production-env",
      passed: vercelEnv.status === "passed" && missingEnv.length === 0,
      missing: missingEnv,
      actions: [
        "fill-private-env-template",
        "set-vercel-production-env",
        "redeploy-vercel-production",
        "inspect-vercel-production-deployment",
        "rerun-final-gate",
      ],
      handoffActionIds,
    }),
    control({
      id: "neon-storage-readiness",
      passed: (
        readiness.storagePostgresConnected === true
        && readiness.storageProvider === "neon"
      ) || (
        requiredChecks.readiness === true
        && !hasMissingStorageEnv(missingEnv)
      ),
      actions: [
        "fill-private-env-template",
        "set-vercel-production-env",
        "redeploy-vercel-production",
        "inspect-vercel-production-deployment",
        "rerun-final-gate",
      ],
      handoffActionIds,
    }),
    control({
      id: "deployment-release-identity",
      passed: readiness.releaseIdMatchesExpected === true,
      actions: [
        "fill-private-env-template",
        "set-vercel-production-env",
        "redeploy-vercel-production",
        "inspect-vercel-production-deployment",
        "rerun-final-gate",
      ],
      note: "Requires deployed /api/system/readiness to report the expected AAIS_RELEASE_ID; Vercel git short SHA is recorded when available.",
      handoffActionIds,
    }),
    control({
      id: "vercel-deployment-ready",
      passed: vercelDeployment.status === "passed"
        && vercelDeployment.readyState === "READY"
        && vercelDeployment.urlMatchesExpected === true
        && vercelDeployment.targetMatchesProduction === true,
      actions: [
        "redeploy-vercel-production",
        "inspect-vercel-production-deployment",
        "rerun-final-gate",
      ],
      note: "Requires redacted Vercel inspect evidence from the deployment URL returned by vercel deploy --prod -y --no-wait.",
      handoffActionIds,
    }),
    control({
      id: "security-headers",
      passed: requiredChecks.securityHeaders === true,
      actions: ["rerun-final-gate"],
      handoffActionIds,
    }),
    control({
      id: "legal-pages",
      passed: requiredChecks.legalPages === true,
      actions: ["redeploy-vercel-production", "inspect-vercel-production-deployment", "rerun-final-gate"],
      note: "Requires deployed /terms and /privacy to return redacted 200/HTML/content-presence evidence.",
      handoffActionIds,
    }),
    control({
      id: "lrs-health",
      passed: requiredChecks.lrsHealth === true,
      actions: ["rerun-final-gate"],
      handoffActionIds,
    }),
    control({
      id: "scheduled-outbox-drain",
      passed: vercelConfig.status === "passed"
        && vercelConfig.path === "/api/learning/lrs/outbox/flush"
        && vercelConfig.outboxCronPresent === true
        && vercelConfig.outboxCronDaily === true
        && vercelConfig.secretScanStatus === "passed",
      actions: ["redeploy-vercel-production", "inspect-vercel-production-deployment", "rerun-final-gate"],
      note: "Requires final release evidence to prove the daily Vercel Cron drain for /api/learning/lrs/outbox/flush.",
      handoffActionIds,
    }),
    control({
      id: "artifact-event-coalescing",
      passed: enterprise.artifactCoalescing?.complete === true,
      actions: ["redeploy-vercel-production", "inspect-vercel-production-deployment", "rerun-final-gate"],
      handoffActionIds,
    }),
    control({
      id: "agent-evidence",
      passed: requiredChecks.agentEvidence === true
        || requiredChecks.a3Supervision === true
        || requiredChecks.a2Monitoring === true
        || enterprise.agentEvidence?.complete === true
        || enterprise.a3SupervisionEvidence?.complete === true
        || enterprise.a2MonitoringEvidence?.complete === true,
      actions: ["redeploy-vercel-production", "inspect-vercel-production-deployment", "rerun-final-gate"],
      note: "Requires deployed readiness evidence for the A1-A4 responsibility map, A3 supervision signals, A2 coaching, keyed AI acceptance revisions, and raw learner-text exclusion.",
      handoffActionIds,
    }),
    control({
      id: "cohort-analytics",
      passed: requiredChecks.cohortAnalytics === true,
      actions: ["run-trial-auth-enterprise-smoke", "run-teacher-cohort-analytics-smoke", "rerun-final-gate"],
      note: "Requires teacher/admin cohort analytics and cohort export proof from the current auth-mode smoke session.",
      handoffActionIds,
    }),
    control({
      id: "oidc-start",
      passed: requiredChecks.oidcStart === true,
      actions: [
        "fill-private-env-template",
        "set-vercel-production-env",
        "redeploy-vercel-production",
        "inspect-vercel-production-deployment",
        "rerun-final-gate",
      ],
      handoffActionIds,
    }),
    control({
      id: "oidc-callback-handoff",
      passed: requiredChecks.oidcCallback === true,
      actions: ["run-real-oidc-callback-smoke", "rerun-final-gate"],
      handoffActionIds,
    }),
    control({
      id: "sso-only-mode",
      passed: requiredChecks.ssoOnlyMode === true,
      actions: [
        "run-real-oidc-callback-smoke",
        "set-sso-only-runtime-mode",
        "redeploy-vercel-production-after-sso-only",
        "inspect-vercel-production-deployment-after-sso-only",
        "rerun-final-gate",
      ],
      handoffActionIds,
    }),
    control({
      id: "live-ai-eval",
      passed: aiEval.status === "passed"
        && aiEval.compatibleWithEnterpriseReadiness === true
        && aiEval.blockedCount === 0
        && aiEval.agentEvidenceComplete === true
        && aiEval.agentEvidenceContractVersion === "aais-a1-a4-ca-eval-v2"
        && aiEval.modelFingerprintMatchesEnterprise === true,
      actions: ["rerun-final-gate"],
      handoffActionIds,
    }),
    control({
      id: "neon-restore-rehearsal",
      passed: postgresRestore.status === "passed"
        && postgresRestore.targetPurpose === "restored-staging"
        && postgresRestore.sameAsSource === false
        && postgresRestore.tablePresent === true
        && postgresRestore.lrsOutboxTablePresent === true
        && postgresRestore.smokeInsertOnly === true
        && postgresRestore.smokeInserted === true
        && postgresRestore.smokeReadBack === true
        && postgresRestore.smokeDeleted === true,
      actions: ["fill-postgres-restore-template", "run-neon-restore-rehearsal", "rerun-final-gate"],
      handoffActionIds,
    }),
    control({
      id: "evidence-order",
      passed: enterprise.evidenceOrder?.enterpriseAfterVercelEnv === true
        && enterprise.evidenceOrder?.enterpriseAfterVercelDeployment === true,
      actions: ["rerun-final-gate"],
      handoffActionIds,
    }),
    control({
      id: "release-consistency",
      passed: releaseCheck?.release?.consistent === true,
      actions: [
        "fill-postgres-restore-template",
        "run-neon-restore-rehearsal",
        "run-real-oidc-callback-smoke",
        "rerun-final-gate",
      ],
      handoffActionIds,
    }),
  ];

  const filteredControls = ssoOnlyGate
    ? controls
    : controls.filter((controlRow) => !["oidc-start", "oidc-callback-handoff", "sso-only-mode"].includes(controlRow.id));

  if (gapEvidence) {
    filteredControls.splice(Math.min(16, filteredControls.length), 0, control({
      id: "enterprise-gap-input-preflight",
      passed: gapPreflight.ready,
      missing: gapPreflight.requiredNames,
      actions: [
        "fill-postgres-restore-template",
        "run-neon-restore-rehearsal",
        "run-trial-auth-enterprise-smoke",
        "run-real-oidc-callback-smoke",
        "run-teacher-cohort-analytics-smoke",
        "rerun-final-gate",
      ],
      note: "Requires verify:enterprise-gaps --preflight-only to report ready before consuming trial smoke evidence or opening the restored Neon database.",
      handoffActionIds,
    }));
  }

  return filteredControls;
}

function buildBusinessGapGroups(requiredControls) {
  const controlById = new Map(requiredControls.map((controlRow) => [controlRow.id, controlRow]));
  const ssoOnlyGate = ["oidc-start", "oidc-callback-handoff", "sso-only-mode"].some((id) => controlById.has(id));
  return businessGapDefinitions.filter((definition) => (
    typeof definition.appliesTo === "function" ? definition.appliesTo({ ssoOnlyGate }) : true
  )).map((definition) => {
    const controls = definition.controlIds.map((controlId) => {
      const controlRow = controlById.get(controlId);
      return {
        id: controlId,
        status: controlRow?.status ?? "missing",
      };
    });
    const status = controls.every((controlRow) => controlRow.status === "passed")
      ? "passed"
      : "action-required";
    const sourceControls = definition.controlIds
      .map((controlId) => controlById.get(controlId))
      .filter(Boolean);
    const actions = uniqueSafeStrings(sourceControls.flatMap((controlRow) => controlRow.actions ?? []));
    const missing = uniqueSafeStrings(sourceControls.flatMap((controlRow) => controlRow.missing ?? []));
    const gap = {
      id: definition.id,
      label: definition.label,
      status,
      description: definition.description,
      controls,
    };
    if (status !== "passed") {
      if (missing.length > 0) {
        gap.missing = missing;
      }
      if (actions.length > 0) {
        gap.actions = actions;
      }
    }
    return gap;
  });
}

function control({ id, passed, missing = undefined, actions, note = undefined, handoffActionIds }) {
  const status = passed ? "passed" : "action-required";
  const row = {
    id,
    status,
  };
  if (Array.isArray(missing) && missing.length > 0) {
    row.missing = missing;
  }
  if (status !== "passed") {
    row.actions = actions.filter((action) => handoffActionIds.size === 0 || handoffActionIds.has(action));
    if (note) {
      row.note = note;
    }
  }
  return row;
}

async function readJsonIfExists(filePath) {
  try {
    const raw = await readFile(filePath, "utf8");
    return {
      ok: true,
      value: JSON.parse(raw),
    };
  } catch {
    return {
      ok: false,
      value: null,
    };
  }
}

function renderMarkdown(report) {
  const lines = [
    "# AAIS Enterprise Readiness Audit",
    "",
    `Status: ${report.status}`,
    `Generated: ${report.generatedAt}`,
    `Gate: ${report.gate.status}`,
    `Summary: ${report.summary.passed}/${report.summary.total} passed`,
    `Business gaps: ${report.businessGapSummary.passed}/${report.businessGapSummary.total} passed`,
    "",
    "## Business Gap Groups",
    "",
    ...report.businessGaps.flatMap((gap) => [
      `- ${gap.id}: ${gap.status} (${gap.label})`,
      `  - controls: ${gap.controls.map((controlRow) => `${controlRow.id}=${controlRow.status}`).join(", ")}`,
      `  - description: ${gap.description}`,
      ...(gap.missing ? [`  - missing: ${gap.missing.join(", ")}`] : []),
      ...(gap.actions ? [`  - actions: ${gap.actions.join(", ")}`] : []),
    ]),
    "",
    "## Required Controls",
    "",
    ...report.requiredControls.flatMap((controlRow) => [
      `- ${controlRow.id}: ${controlRow.status}`,
      ...(controlRow.missing ? [`  - missing: ${controlRow.missing.join(", ")}`] : []),
      ...(controlRow.actions ? [`  - actions: ${controlRow.actions.join(", ")}`] : []),
      ...(controlRow.note ? [`  - note: ${controlRow.note}`] : []),
    ]),
    "",
    "## Redaction",
    "",
    "- Secret values are omitted.",
    "- This audit reports statuses, variable names, and action ids only.",
    "",
  ];
  return lines.join("\n");
}

async function writeTextFile(filePath, text) {
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, text, "utf8");
}

function getSafeEnvNames(value) {
  return Array.isArray(value)
    ? value
      .map((item) => String(item ?? "").trim())
      .filter((item) => /^[A-Z][A-Z0-9_*\\/-]{1,127}$/.test(item))
    : [];
}

function uniqueSafeStrings(values) {
  return [...new Set(
    values
      .map((value) => String(value ?? "").trim())
      .filter((value) => /^[A-Za-z0-9_*\\/.-]{1,160}$/.test(value)),
  )];
}

function hasMissingStorageEnv(missingEnv) {
  return missingEnv.some((name) => (
    name === "AAIS_DATABASE_URL"
    || name === "DATABASE_URL"
    || name === "POSTGRES_URL"
    || name === "POSTGRES_PRISMA_URL"
    || name === "POSTGRES_URL_NO_SSL"
    || name === "DATABASE_URL_UNPOOLED"
    || name === "POSTGRES_URL_NON_POOLING"
    || name === "PGHOST/PGUSER/PGDATABASE/PGPASSWORD"
    || name === "POSTGRES_HOST/POSTGRES_USER/POSTGRES_DATABASE/POSTGRES_PASSWORD"
  ));
}

function getGapPreflightStatus(report) {
  const required = report?.preflight?.required ?? {};
  const missing = getSafeEnvNames(required.missing);
  const placeholders = getSafeEnvNames(required.placeholders);
  const invalid = getSafeEnvNames(required.invalid);
  const requiredNames = [...new Set([...missing, ...placeholders, ...invalid])];
  return {
    ready: report?.preflight?.status === "ready"
      && (report?.status === "preflight-ready" || report?.status === "passed")
      && requiredNames.length === 0,
    requiredNames,
  };
}

function readSafeActionId(value) {
  const text = String(value ?? "").trim();
  return /^[a-z][a-z0-9-]{1,63}$/.test(text) ? text : null;
}

function normalizeStatus(value) {
  const status = String(value ?? "").trim().toLowerCase();
  return /^[a-z][a-z0-9_-]{1,31}$/.test(status) ? status : "unknown";
}

function readAuthMode(value, missingEnv = []) {
  const normalized = String(value ?? "").trim().toLowerCase();
  if (normalized === "sso-only" || normalized === "trial") {
    return normalized;
  }
  return missingEnv.some((name) => name.startsWith("AAIS_OIDC_")) ? "sso-only" : "trial";
}

function readIsoTimestamp(value) {
  if (typeof value !== "string") {
    return null;
  }
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString();
}

function parseCliArgs(argv) {
  const args = new Map();
  for (let index = 0; index < argv.length; index += 1) {
    const current = argv[index];
    if (!current.startsWith("--")) {
      continue;
    }
    const [rawKey, inlineValue] = current.slice(2).split("=");
    const nextValue = argv[index + 1];
    const value = inlineValue ?? (nextValue && !nextValue.startsWith("--") ? nextValue : true);
    if (inlineValue === undefined && value === nextValue) {
      index += 1;
    }
    args.set(rawKey, value);
  }
  return args;
}

async function main() {
  const args = parseCliArgs(process.argv.slice(2));
  const report = await auditAaisEnterpriseReadiness({
    releaseCheckReportPath: args.get("release-check-report"),
    handoffReportPath: args.get("handoff-report"),
    gapEvidenceReportPath: args.get("gap-evidence-report"),
    outputPath: args.get("output"),
    markdownOutputPath: args.get("markdown-output"),
  });
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  if (report.status !== "ready") {
    process.exitCode = 1;
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : "AAIS enterprise readiness audit failed."}\n`);
    process.exitCode = 1;
  });
}
