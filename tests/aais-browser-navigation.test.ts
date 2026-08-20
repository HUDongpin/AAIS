import { describe, expect, it, vi } from "vitest";
import { replaceAaisBrowserLocation } from "@/lib/client/aais-browser-navigation";
import {
  isSafeAaisLocalRedirectTarget,
  normalizeAaisLocalRedirectTarget,
} from "@/lib/aais-local-redirect";

describe("AAIS browser navigation", () => {
  it("uses a full-document replacement for the post-revocation login redirect", () => {
    const replace = vi.fn();

    replaceAaisBrowserLocation("/login", { replace });

    expect(replace).toHaveBeenCalledOnce();
    expect(replace).toHaveBeenCalledWith("/login");
  });

  it.each([
    "/learning",
    "/dashboard?from=%2Flearning#summary",
    "/terms",
  ])("accepts the same-origin redirect target %s", (target) => {
    expect(isSafeAaisLocalRedirectTarget(target)).toBe(true);
    expect(normalizeAaisLocalRedirectTarget(target)).toBe(target);
  });

  it.each([
    "https://evil.example/path",
    "//evil.example/path",
    "/\\evil.example/path",
    "/%5cevil.example/path",
    "/%2f%2fevil.example/path",
    "/%255cevil.example/path",
    "/learning%0aevil",
    "/broken%escape",
  ])("rejects the cross-origin or ambiguous redirect target %s", (target) => {
    expect(isSafeAaisLocalRedirectTarget(target)).toBe(false);
    expect(normalizeAaisLocalRedirectTarget(target)).toBe("/learning");
  });
});
