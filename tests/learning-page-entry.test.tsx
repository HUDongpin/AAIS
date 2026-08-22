import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  ConfigurationError: class ConfigurationError extends Error {},
  AuthorizationError: class AuthorizationError extends Error {},
  CapacityError: class CapacityError extends Error {},
  VisitInactiveError: class VisitInactiveError extends Error {},
  VisitNotFoundError: class VisitNotFoundError extends Error {},
  getOrCreateVisit: vi.fn(),
  getReadinessReport: vi.fn(),
  researchModeEnabled: false,
  requireAaisPageSession: vi.fn(async () => ({
    id: "Phoebe",
    role: "student" as const,
    displayName: "Phoebe",
  })),
}));

vi.mock("@/lib/server/aais-page-auth", () => ({
  requireAaisPageSession: mocks.requireAaisPageSession,
}));

vi.mock("@/lib/server/aais-research-contract", () => ({
  AaisResearchConfigurationError: mocks.ConfigurationError,
  isAaisResearchModeEnabled: () => mocks.researchModeEnabled,
}));

vi.mock("@/lib/server/aais-research-store", () => ({
  AaisResearchAuthorizationError: mocks.AuthorizationError,
  AaisResearchCapacityError: mocks.CapacityError,
  AaisResearchVisitInactiveError: mocks.VisitInactiveError,
  AaisResearchVisitNotFoundError: mocks.VisitNotFoundError,
  getAaisResearchStore: () => ({
    getOrCreateVisit: mocks.getOrCreateVisit,
  }),
}));

vi.mock("@/lib/server/aais-readiness", () => ({
  getAaisReadinessReport: mocks.getReadinessReport,
}));

vi.mock("@/components/pages/learning-page", () => ({
  LearningPage: () => null,
}));

beforeEach(() => {
  mocks.getOrCreateVisit.mockReset();
  mocks.getReadinessReport.mockReset();
  mocks.getReadinessReport.mockResolvedValue(createReadinessReport());
  mocks.researchModeEnabled = false;
  mocks.requireAaisPageSession.mockClear();
  delete process.env.AAIS_RESEARCH_REQUIRED;
  delete process.env.AAIS_RESEARCH_ENVIRONMENT;
});

describe("AAIS learning page entry", () => {
  it("passes the verified app-session actor identity into the client learning shell", async () => {
    const { default: Page } = await import("@/app/learning/page");

    const element = await Page();

    expect(mocks.requireAaisPageSession).toHaveBeenCalledWith("/learning");
    expect(element.props.actor).toEqual({
      id: "Phoebe",
      displayName: "Phoebe",
    });
    expect(element.props.research).toEqual({
      required: false,
      initialVisit: null,
    });
    expect(element.props.actor).not.toHaveProperty("role");
    expect(mocks.getOrCreateVisit).not.toHaveBeenCalled();
  });

  it("creates the Postgres-backed visit before rendering a required research workspace", async () => {
    mocks.researchModeEnabled = true;
    mocks.getOrCreateVisit.mockResolvedValue({
      participantId: "participant-01",
      studyRunId: "study-run-01",
      visitId: "visit-01",
      condition: "condition-a",
      status: "active",
      appVersion: "0.1.0",
      commitSha: "abc1234",
      created: true,
    });
    const { default: Page } = await import("@/app/learning/page");

    const element = await Page();

    expect(mocks.getReadinessReport).toHaveBeenCalledOnce();
    expect(mocks.getOrCreateVisit).toHaveBeenCalledWith(expect.objectContaining({
      id: "Phoebe",
      role: "student",
    }));
    expect(element.props.research).toEqual({
      required: true,
      initialVisit: {
        participantId: "participant-01",
        studyRunId: "study-run-01",
        visitId: "visit-01",
        condition: "condition-a",
        appVersion: "0.1.0",
        commitSha: "abc1234",
      },
    });
  });

  it("blocks a research deployment when the collection switch is accidentally disabled", async () => {
    process.env.AAIS_RESEARCH_REQUIRED = "true";
    const { default: Page } = await import("@/app/learning/page");

    const element = await Page();

    expect(element.props.state).toBe("terminal-blocked");
    expect(mocks.getReadinessReport).not.toHaveBeenCalled();
    expect(mocks.getOrCreateVisit).not.toHaveBeenCalled();
  });

  it("does not create a visit until the formal study launch gate is ready", async () => {
    mocks.researchModeEnabled = true;
    mocks.getReadinessReport.mockResolvedValue(createReadinessReport({
      applicationReady: true,
      studyLaunchReady: false,
      status: "blocked",
    }));
    const { default: Page } = await import("@/app/learning/page");

    const element = await Page();

    expect(element.props.state).toBe("terminal-blocked");
    expect(mocks.getOrCreateVisit).not.toHaveBeenCalled();
  });

  it("fails closed when the server cannot produce a complete launch-gate report", async () => {
    mocks.researchModeEnabled = true;
    mocks.getReadinessReport.mockRejectedValue(new Error("readiness unavailable"));
    const { default: Page } = await import("@/app/learning/page");

    const element = await Page();

    expect(element.props.state).toBe("terminal-blocked");
    expect(mocks.getOrCreateVisit).not.toHaveBeenCalled();
  });

  it("keeps the workspace behind the retry boundary for a transient readiness storage failure", async () => {
    mocks.researchModeEnabled = true;
    mocks.getReadinessReport.mockResolvedValue(createReadinessReport({
      applicationReady: false,
      status: "blocked",
      storageStatus: "blocked",
      studyLaunchReady: false,
    }));
    const { default: Page } = await import("@/app/learning/page");

    const element = await Page();

    expect(element.props.research).toEqual({ required: true, initialVisit: null });
    expect(mocks.getOrCreateVisit).not.toHaveBeenCalled();
  });

  it("allows an approved synthetic rehearsal through its application-ready gate", async () => {
    mocks.researchModeEnabled = true;
    mocks.getReadinessReport.mockResolvedValue(createReadinessReport({
      applicationReady: true,
      rosterMode: "rehearsal",
      studyLaunchReady: false,
    }));
    mocks.getOrCreateVisit.mockResolvedValue({
      participantId: "synthetic-01",
      studyRunId: "study-run-rehearsal",
      visitId: "visit-rehearsal",
      condition: "condition-a",
      status: "active",
      appVersion: "0.1.0",
      commitSha: "abc1234",
      created: true,
    });
    const { default: Page } = await import("@/app/learning/page");

    const element = await Page();

    expect(mocks.getOrCreateVisit).toHaveBeenCalledOnce();
    expect(element.props.research.initialVisit.visitId).toBe("visit-rehearsal");
  });

  it("keeps the workspace behind a temporary client boundary when the visit Postgres call fails", async () => {
    mocks.researchModeEnabled = true;
    mocks.getOrCreateVisit.mockRejectedValue(new Error("research database unavailable"));
    const { default: Page } = await import("@/app/learning/page");

    const element = await Page();

    expect(element.props.research).toEqual({
      required: true,
      initialVisit: null,
    });
  });

  it("does not render the workspace after a terminal research configuration failure", async () => {
    mocks.researchModeEnabled = true;
    mocks.getOrCreateVisit.mockRejectedValue(new mocks.ConfigurationError());
    const { default: Page } = await import("@/app/learning/page");

    const element = await Page();

    expect(element.props.state).toBe("terminal-blocked");
    expect(element.props).not.toHaveProperty("actor");
  });
});

function createReadinessReport(overrides: {
  applicationReady?: boolean;
  rosterMode?: "formal" | "rehearsal";
  status?: "ok" | "blocked" | "invalid";
  storageStatus?: "ok" | "blocked";
  studyLaunchReady?: boolean;
} = {}) {
  return {
    checks: {
      research: {
        enabled: true,
        status: overrides.status ?? "ok",
        applicationReady: overrides.applicationReady ?? true,
        studyLaunchReady: overrides.studyLaunchReady ?? true,
        configuration: { status: "ok" },
        roster: {
          mode: overrides.rosterMode ?? "formal",
          status: "ok",
        },
        storage: { status: overrides.storageStatus ?? "ok" },
        lrs: { status: "ok" },
        access: { status: "ok" },
        workers: { status: "ok" },
        evidence: { status: "ok" },
      },
    },
  };
}
