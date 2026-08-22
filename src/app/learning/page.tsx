import { LearningPage } from "@/components/pages/learning-page";
import { LearningResearchBoundaryNotice } from "@/components/pages/learning/research-telemetry-boundary";
import { cookies } from "next/headers";
import {
  aaisLocaleCookieName,
  defaultAaisLocale,
  parseAaisLocale,
} from "@/lib/aais-locale";
import { requireAaisPageSession } from "@/lib/server/aais-page-auth";
import {
  AaisResearchConfigurationError,
  isAaisResearchModeEnabled,
} from "@/lib/server/aais-research-contract";
import {
  getAaisReadinessReport,
  type AaisReadinessReport,
} from "@/lib/server/aais-readiness";
import {
  AaisResearchAuthorizationError,
  AaisResearchCapacityError,
  AaisResearchVisitInactiveError,
  AaisResearchVisitNotFoundError,
  getAaisResearchStore,
  type AaisResearchVisit,
} from "@/lib/server/aais-research-store";

export const dynamic = "force-dynamic";

export default async function Page() {
  const locale = await readLearningPageLocale();
  const actor = await requireAaisPageSession("/learning");
  if (!isAaisResearchModeEnabled()) {
    if (isResearchCollectionRequired()) {
      return terminalResearchBoundary(locale);
    }
    return <LearningPage actor={toClientActor(actor)} locale={locale} research={nonResearchBoundary} />;
  }

  let readiness: AaisReadinessReport["checks"]["research"] | null = null;
  try {
    readiness = (await getAaisReadinessReport()).checks.research;
  } catch {
    // Without a complete launch-gate result, the visit endpoint must not be
    // used as a shortcut around formal readiness.
  }
  if (!readiness) {
    return terminalResearchBoundary(locale);
  }
  const launchGate = classifyResearchLaunch(readiness);
  if (launchGate === "temporary") {
    return (
      <LearningPage
        actor={toClientActor(actor)}
        locale={locale}
        research={{ required: true, initialVisit: null }}
      />
    );
  }
  if (launchGate === "terminal") {
    return terminalResearchBoundary(locale);
  }

  let visit: AaisResearchVisit | null = null;
  let bootstrapError: unknown;
  try {
    visit = await getAaisResearchStore().getOrCreateVisit(actor);
  } catch (error) {
    bootstrapError = error;
  }
  if (visit) {
    return (
      <LearningPage
        actor={toClientActor(actor)}
        locale={locale}
        research={{ required: true, initialVisit: toClientVisit(visit) }}
      />
    );
  }
  if (!isTerminalResearchBootstrapError(bootstrapError)) {
    return (
      <LearningPage
        actor={toClientActor(actor)}
        locale={locale}
        research={{ required: true, initialVisit: null }}
      />
    );
  }
  return terminalResearchBoundary(locale);
}

const nonResearchBoundary = {
  required: false,
  initialVisit: null,
} as const;

function toClientActor(actor: { id: string; displayName: string }) {
  return {
    id: actor.id,
    displayName: actor.displayName,
  };
}

function toClientVisit(visit: AaisResearchVisit) {
  return {
    participantId: visit.participantId,
    studyRunId: visit.studyRunId,
    visitId: visit.visitId,
    condition: visit.condition,
    appVersion: visit.appVersion,
    commitSha: visit.commitSha,
  };
}

function isTerminalResearchBootstrapError(error: unknown) {
  return error instanceof AaisResearchConfigurationError
    || error instanceof AaisResearchAuthorizationError
    || error instanceof AaisResearchCapacityError
    || error instanceof AaisResearchVisitInactiveError
    || error instanceof AaisResearchVisitNotFoundError;
}

function isResearchCollectionRequired() {
  return process.env.AAIS_RESEARCH_REQUIRED?.trim().toLowerCase() === "true"
    || process.env.AAIS_RESEARCH_ENVIRONMENT?.trim().toLowerCase() === "research";
}

function classifyResearchLaunch(
  readiness: AaisReadinessReport["checks"]["research"],
) {
  if (!readiness.enabled || readiness.status === "disabled") {
    return "terminal";
  }
  if (readiness.roster.mode === "rehearsal") {
    if (readiness.applicationReady && readiness.roster.status === "ok") {
      return "ready";
    }
    return readiness.configuration.status === "ok"
      && readiness.roster.status === "ok"
      && readiness.lrs.status === "ok"
      && readiness.storage.status !== "ok"
      ? "temporary"
      : "terminal";
  }
  if (readiness.roster.mode !== "formal") {
    return "terminal";
  }
  if (readiness.studyLaunchReady) {
    return "ready";
  }
  const staticLaunchControlsReady = readiness.configuration.status === "ok"
    && readiness.roster.status === "ok"
    && readiness.lrs.status === "ok"
    && readiness.access.status === "ok"
    && readiness.workers.status === "ok"
    && readiness.evidence.status === "ok";
  return staticLaunchControlsReady && readiness.storage.status !== "ok"
    ? "temporary"
    : "terminal";
}

function terminalResearchBoundary(locale: typeof defaultAaisLocale) {
  return <LearningResearchBoundaryNotice locale={locale} state="terminal-blocked" />;
}

async function readLearningPageLocale() {
  try {
    const cookieStore = await cookies();
    return parseAaisLocale(cookieStore.get(aaisLocaleCookieName)?.value) ?? defaultAaisLocale;
  } catch {
    // Unit rendering has no request-scoped cookie store, so use the stable
    // Chinese default in that non-request context.
    return defaultAaisLocale;
  }
}
