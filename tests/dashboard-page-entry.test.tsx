import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  locale: undefined as string | undefined,
  requireEducator: vi.fn(),
}));

vi.mock("next/headers", () => ({
  cookies: vi.fn(async () => ({
    get: (name: string) => name === "aais_locale" && mocks.locale
      ? { value: mocks.locale }
      : undefined,
  })),
}));

vi.mock("@/lib/server/aais-page-auth", () => ({
  requireAaisEducatorPageSession: mocks.requireEducator,
}));

describe("AAIS dashboard page locale entry", () => {
  beforeEach(() => {
    mocks.locale = undefined;
    mocks.requireEducator.mockReset();
    mocks.requireEducator.mockResolvedValue({
      id: "teacher-test",
      role: "teacher",
      displayName: "Teacher Test",
    });
  });

  it("passes the authenticated locale cookie into the teacher dashboard", async () => {
    mocks.locale = "en-US";
    const { default: Page } = await import("@/app/dashboard/page");

    const result = await Page();

    expect(mocks.requireEducator).toHaveBeenCalledWith("/dashboard");
    expect(result.props.locale).toBe("en-US");
  });

  it("keeps Chinese as the default for an absent or invalid locale cookie", async () => {
    mocks.locale = "fr-FR";
    const { default: Page } = await import("@/app/dashboard/page");

    const result = await Page();

    expect(result.props.locale).toBe("zh-CN");
  });
});
