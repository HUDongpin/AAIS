import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const architecture = readFileSync("ARCHITECTURE.md", "utf8");

describe("AAIS architecture documentation", () => {
  it("keeps the real runtime diagram and deliberate not-yet list", () => {
    expect(architecture).toContain("```mermaid");
    expect(architecture).toContain("flowchart LR");
    expect(architecture).toContain("Next.js App Router pages");
    expect(architecture).toContain("Next.js route handlers under src/app/api");
    expect(architecture).toContain("Signed session cookie + CSRF + revocation");
    expect(architecture).toContain("Neon/Postgres tables");
    expect(architecture).toContain("aais_lrs_outbox");
    expect(architecture).toContain("External LRS");
    expect(architecture).toContain("LangGraph A1-A4 guide orchestration");
    expect(architecture).toContain("Sentry monitoring when configured");
    expect(architecture).toContain("## Not Yet");
    expect(architecture).toContain("Separate API service");
    expect(architecture).toContain("Message queue beyond `aais_lrs_outbox`");
    expect(architecture).toContain("Redis or cache tier");
    expect(architecture).toContain("Multi-region deployment");
    expect(architecture).toContain("ML pipeline");
    expect(architecture).toContain("CMS or authoring system");
  });
});
