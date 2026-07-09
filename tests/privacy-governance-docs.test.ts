import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const privacyInventory = readFileSync("docs/privacy-data-inventory.md", "utf8");
const readme = readFileSync("README.md", "utf8");
const architecture = readFileSync("ARCHITECTURE.md", "utf8");
const operations = readFileSync("OPERATIONS.md", "utf8");
const releaseChecklist = readFileSync("docs/release-checklist.md", "utf8");

describe("AAIS privacy governance documentation", () => {
  it("tracks implemented learner export/delete storage behavior", () => {
    [
      "/api/learning/privacy",
      "GET /api/learning/privacy",
      "DELETE /api/learning/privacy",
      "aais_learner_sessions",
      "aais_events",
      "aais_learner_task_state",
      "aais_lrs_outbox",
      ".aais-data",
      "cache-control: no-store",
      "actor-bound CSRF token",
      "aais_users",
      "aais_user_auth_tokens",
      "consentAccepted: true",
      "AAIS_LOGIN_CONSENT_REQUIRED",
    ].forEach((expected) => {
      expect(privacyInventory).toContain(expected);
    });
  });

  it("keeps privacy retention, processor, and consent gates explicit", () => {
    [
      "retention schedule",
      "legal basis",
      "processor/DPA",
      "data-region",
      "Vercel",
      "Neon/Postgres",
      "External LRS",
      "Sentry",
      "AI model provider",
      "FERPA",
      "COPPA",
      "GDPR",
      "PIPL",
      "no real student cohort",
      "minors",
    ].forEach((expected) => {
      expect(privacyInventory).toContain(expected);
    });
  });

  it("links the privacy baseline from project docs and release gates", () => {
    [readme, architecture, operations, releaseChecklist].forEach((document) => {
      expect(document).toContain("docs/privacy-data-inventory.md");
    });
    expect(releaseChecklist).toContain("cohort age/region/institution");
    expect(operations).toContain("AAIS_LOGIN_CONSENT_REQUIRED");
    expect(operations).toContain("formal consent workflow");
  });
});
