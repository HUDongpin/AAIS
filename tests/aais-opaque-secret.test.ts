import { describe, expect, it } from "vitest";
import {
  areAaisOpaqueSecretsDistinct,
  isAaisStrongOpaqueSecret,
} from "@/lib/server/aais-opaque-secret";

describe("AAIS operator secret policy", () => {
  it("rejects short, repeated, whitespace and placeholder values", () => {
    expect(isAaisStrongOpaqueSecret("x")).toBe(false);
    expect(isAaisStrongOpaqueSecret("x".repeat(64))).toBe(false);
    expect(isAaisStrongOpaqueSecret("change-me-to-a-production-secret-value-now")).toBe(false);
    expect(isAaisStrongOpaqueSecret("strong-secret-with whitespace-123456789")).toBe(false);
  });

  it("accepts strong opaque values and detects cross-purpose reuse", () => {
    const first = "first-operator-secret-2026-Aa9!bcdef";
    const second = "second-operator-secret-2026-Bb8@cdef";
    expect(isAaisStrongOpaqueSecret(first)).toBe(true);
    expect(isAaisStrongOpaqueSecret(second)).toBe(true);
    expect(areAaisOpaqueSecretsDistinct([first, second])).toBe(true);
    expect(areAaisOpaqueSecretsDistinct([first, first])).toBe(false);
  });
});
