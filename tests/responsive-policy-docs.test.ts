import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const readme = readFileSync("README.md", "utf8");
const architecture = readFileSync("ARCHITECTURE.md", "utf8");
const operations = readFileSync("OPERATIONS.md", "utf8");
const releaseChecklist = readFileSync("docs/release-checklist.md", "utf8");
const mobileLearningSpec = readFileSync("tests/e2e/mobile-learning.spec.ts", "utf8");

describe("AAIS responsive support policy", () => {
  it("states the supported viewport contract in docs and release gates", () => {
    [readme, architecture, operations].forEach((document) => {
      expect(document).toContain("login");
      expect(document).toContain("learner cockpit");
      expect(document).toMatch(/phone-width|phone-width viewport|390px/);
      expect(document).toMatch(/teacher\/admin|Teacher\/admin/);
      expect(document).toMatch(/tablet and desktop|tablet\/desktop/);
    });

    expect(releaseChecklist).toContain("Responsive policy reviewed");
    expect(releaseChecklist).toContain("phone-width E2E smoke");
    expect(releaseChecklist).toContain("tablet/desktop");
  });

  it("keeps the phone-width learner cockpit smoke as executable evidence", () => {
    expect(mobileLearningSpec).toContain("width: 390");
    expect(mobileLearningSpec).toContain("student learning cockpit remains usable on a phone-width viewport");
    expect(mobileLearningSpec).toContain("horizontalOverflow");
  });
});
