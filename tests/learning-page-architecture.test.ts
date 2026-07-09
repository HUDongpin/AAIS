import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const pageTreeRoot = path.join(process.cwd(), "src", "components", "pages");
const learningTreeRoot = path.join(pageTreeRoot, "learning");

describe("learning page architecture", () => {
  it("keeps the learning page tree split into sub-500-line modules", () => {
    const sourceFiles = [
      path.join(pageTreeRoot, "learning-page.tsx"),
      ...readdirSync(learningTreeRoot)
        .filter((fileName) => /\.(ts|tsx)$/.test(fileName))
        .map((fileName) => path.join(learningTreeRoot, fileName)),
    ];

    const oversizedFiles = sourceFiles
      .map((filePath) => ({
        filePath,
        lines: readFileSync(filePath, "utf8").split("\n").length,
      }))
      .filter((file) => statSync(file.filePath).isFile() && file.lines > 500);

    expect(oversizedFiles).toEqual([]);
  });

  it("keeps session API calls behind the typed learning-session client", () => {
    const learningPage = readFileSync(path.join(pageTreeRoot, "learning-page.tsx"), "utf8");
    const sessionClient = readFileSync(path.join(learningTreeRoot, "learning-session-client.ts"), "utf8");

    expect(learningPage).toContain("learning-session-client");
    expect(learningPage).not.toContain("\"/api/learning/session\"");
    expect(learningPage).not.toContain("\"/api/auth/app-session\"");
    expect(sessionClient).toContain("fetchLearningSession");
    expect(sessionClient).toContain("patchLearningSession");
    expect(sessionClient).toContain("deleteAaisAppSession");
  });
});
