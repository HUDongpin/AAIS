import { describe, expect, it } from "vitest";
import { requiresAaisDurableStorage } from "@/lib/server/aais-runtime";

describe("AAIS runtime boundaries", () => {
  it("requires durable storage for production deployments and production builds", () => {
    expect(requiresAaisDurableStorage({ NODE_ENV: "production" })).toBe(true);
    expect(requiresAaisDurableStorage({
      NODE_ENV: "development",
      VERCEL_ENV: "production",
    })).toBe(true);
  });

  it("keeps the attested Vercel Preview smoke environment stateless", () => {
    expect(requiresAaisDurableStorage({
      NODE_ENV: "production",
      VERCEL_ENV: "preview",
    })).toBe(false);
  });

  it("does not require durable storage in development", () => {
    expect(requiresAaisDurableStorage({ NODE_ENV: "development" })).toBe(false);
  });
});
