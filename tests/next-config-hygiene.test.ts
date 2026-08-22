import { describe, expect, it } from "vitest";
import nextConfig from "@/../next.config";

describe("AAIS Next config hygiene", () => {
  it("keeps Next dev from rewriting the project-owned agent instructions", () => {
    expect(nextConfig.agentRules).toBe(false);
  });
});
