import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

describe("AAIS git secret guardrails", () => {
  it("ignores owner-provided env files and generated release evidence artifacts", async () => {
    const gitignore = await readFile(".gitignore", "utf8");
    const patterns = gitignore
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean);

    expect(patterns).toEqual(expect.arrayContaining([
      ".env",
      ".env.*",
      "output/",
      "All API Keys.docx",
    ]));
  });

  it("excludes local credentials and release evidence from Vercel deployments", async () => {
    const vercelignore = await readFile(".vercelignore", "utf8");
    const patterns = vercelignore
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean);

    expect(patterns).toEqual(expect.arrayContaining([
      ".env",
      ".env.*",
      ".vercel/",
      "output/",
      "All API Keys.docx",
    ]));
  });
});
