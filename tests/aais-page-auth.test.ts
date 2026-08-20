import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createAaisSessionToken } from "@/lib/server/aais-session";

const mocks = vi.hoisted(() => ({
  cookieValue: undefined as string | undefined,
  redirect: vi.fn((target: string) => {
    throw new Error(`redirect:${target}`);
  }),
}));

vi.mock("next/headers", () => ({
  cookies: vi.fn(async () => ({
    get: (name: string) => name === "aais_session" && mocks.cookieValue
      ? { value: mocks.cookieValue }
      : undefined,
  })),
}));

vi.mock("next/navigation", () => ({
  redirect: mocks.redirect,
}));

beforeEach(() => {
  process.env.AAIS_SESSION_SECRET = "test-session-secret-with-at-least-32-characters";
  mocks.cookieValue = undefined;
  mocks.redirect.mockClear();
});

afterEach(() => {
  delete process.env.AAIS_SESSION_SECRET;
});

describe("AAIS protected page auth", () => {
  it("returns the signed actor when the page request has a valid session", async () => {
    const { requireAaisPageSession } = await import("@/lib/server/aais-page-auth");
    mocks.cookieValue = createAaisSessionToken({
      id: "Bobie",
      role: "student",
      displayName: "Bobie",
    }, new Date(), { authSource: "development" });

    const actor = await requireAaisPageSession("/learning");

    expect(actor.id).toBe("Bobie");
    expect(mocks.redirect).not.toHaveBeenCalled();
  });

  it("redirects anonymous page requests to login with a local return target", async () => {
    const { requireAaisPageSession } = await import("@/lib/server/aais-page-auth");

    await expect(requireAaisPageSession("/learning")).rejects.toThrow(
      "redirect:/login?from=%2Flearning",
    );

    expect(mocks.redirect).toHaveBeenCalledWith("/login?from=%2Flearning");
  });

  it("allows teacher and admin actors to open protected educator pages", async () => {
    const { requireAaisEducatorPageSession } = await import("@/lib/server/aais-page-auth");
    mocks.cookieValue = createAaisSessionToken({
      id: "teacher-a",
      role: "teacher",
      displayName: "Teacher A",
    }, new Date(), { authSource: "development" });

    const actor = await requireAaisEducatorPageSession("/dashboard");

    expect(actor.role).toBe("teacher");
    expect(mocks.redirect).not.toHaveBeenCalled();
  });

  it("redirects signed learner actors away from protected educator pages", async () => {
    const { requireAaisEducatorPageSession } = await import("@/lib/server/aais-page-auth");
    mocks.cookieValue = createAaisSessionToken({
      id: "S001",
      role: "student",
      displayName: "S001",
    }, new Date(), { authSource: "development" });

    await expect(requireAaisEducatorPageSession("/dashboard")).rejects.toThrow(
      "redirect:/learning",
    );

    expect(mocks.redirect).toHaveBeenCalledWith("/learning");
  });
});
