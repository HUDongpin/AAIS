import { describe, expect, it, vi } from "vitest";
import { replaceAaisBrowserLocation } from "@/lib/client/aais-browser-navigation";

describe("AAIS browser navigation", () => {
  it("uses a full-document replacement for the post-revocation login redirect", () => {
    const replace = vi.fn();

    replaceAaisBrowserLocation("/login", { replace });

    expect(replace).toHaveBeenCalledOnce();
    expect(replace).toHaveBeenCalledWith("/login");
  });
});
