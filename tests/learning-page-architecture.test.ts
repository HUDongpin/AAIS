import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const pageTreeRoot = path.join(process.cwd(), "src", "components", "pages");
const learningTreeRoot = path.join(pageTreeRoot, "learning");
const learningSourceFiles = [
  path.join(pageTreeRoot, "learning-page.tsx"),
  ...readdirSync(learningTreeRoot)
    .filter((fileName) => /\.(ts|tsx)$/.test(fileName))
    .map((fileName) => path.join(learningTreeRoot, fileName)),
];

describe("learning page architecture", () => {
  it("keeps the learning page tree split into sub-500-line modules", () => {
    const oversizedFiles = learningSourceFiles
      .map((filePath) => ({
        filePath,
        lines: readFileSync(filePath, "utf8").split("\n").length,
      }))
      .filter((file) => statSync(file.filePath).isFile() && file.lines > 500);

    expect(oversizedFiles).toEqual([]);
  });

  it("keeps session API calls behind the typed learning-session client", () => {
    const sessionClientPath = path.join(learningTreeRoot, "learning-session-client.ts");
    const sessionClient = readFileSync(sessionClientPath, "utf8");
    const sessionConsumers = learningSourceFiles
      .filter((filePath) => filePath !== sessionClientPath)
      .map((filePath) => readFileSync(filePath, "utf8"))
      .join("\n");

    expect(sessionConsumers).toContain("learning-session-client");
    expect(sessionConsumers).not.toContain("\"/api/learning/session\"");
    expect(sessionConsumers).not.toContain("\"/api/auth/app-session\"");
    expect(sessionClient).toContain("fetchLearningSession");
    expect(sessionClient).toContain("patchLearningSession");
    expect(sessionClient).toContain("deleteAaisAppSession");
  });
});
