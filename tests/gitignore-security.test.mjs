import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

describe("AAIS git secret guardrails", () => {
  it("ignores owner-provided env files and generated private artifacts", async () => {
    const gitignore = await readFile(".gitignore", "utf8");
    const patterns = gitignore
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean);

    expect(patterns).toEqual(expect.arrayContaining([
      ".aais-data/",
      ".env",
      ".env.*",
      "!.env.example",
      "output/",
      "All API Keys.docx",
      "/*.docx",
    ]));
  });

  it("excludes local credentials and generated private artifacts from Vercel deployments", async () => {
    const vercelignore = await readFile(".vercelignore", "utf8");
    const patterns = vercelignore
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean);

    expect(patterns).toEqual(expect.arrayContaining([
      ".aais-data/",
      ".env",
      ".env.*",
      "!.env.example",
      ".vercel/",
      "output/",
      "All API Keys.docx",
      "/*.docx",
    ]));
  });
});
