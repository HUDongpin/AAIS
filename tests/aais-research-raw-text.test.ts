// @vitest-environment node

import { afterEach, describe, expect, it, vi } from "vitest";
import { acquireAaisResearchRawTextWriteLeaseIfRequired } from
  "@/lib/server/aais-research-raw-text";

const storeMocks = vi.hoisted(() => ({
  acquire: vi.fn(async () => ({
    leaseId: "10000000-0000-4000-8000-000000000001",
    visitId: "10000000-0000-4000-8000-000000000002",
    expiresAt: "2026-07-30T10:05:00.000Z",
  })),
  release: vi.fn(async () => true),
}));

vi.mock("@/lib/server/aais-research-store", () => ({
  getAaisResearchStore: () => ({
    acquireRawTextWriteLease: storeMocks.acquire,
    releaseRawTextWriteLease: storeMocks.release,
  }),
}));

const student = {
  id: "Synthetic1",
  role: "student" as const,
  displayName: "Synthetic 1",
};

afterEach(() => {
  vi.unstubAllEnvs();
  storeMocks.acquire.mockClear();
  storeMocks.release.mockClear();
});

describe("AAIS research raw-text write coordination", () => {
  it("does not touch the research database outside an isolated study deployment", async () => {
    await expect(acquireAaisResearchRawTextWriteLeaseIfRequired(student)).resolves.toBeNull();
    expect(storeMocks.acquire).not.toHaveBeenCalled();
  });

  it("fails closed when the required sentinel is on but collection mode is off", async () => {
    vi.stubEnv("AAIS_RESEARCH_REQUIRED", "true");
    vi.stubEnv("AAIS_RESEARCH_MODE", "false");

    await expect(acquireAaisResearchRawTextWriteLeaseIfRequired(student)).rejects.toMatchObject({
      code: "AAIS_RESEARCH_MODE_REQUIRED",
      status: 503,
    });
    expect(storeMocks.acquire).not.toHaveBeenCalled();
  });

  it("acquires one opaque lease and releases it idempotently", async () => {
    vi.stubEnv("AAIS_RESEARCH_REQUIRED", "true");
    vi.stubEnv("AAIS_RESEARCH_MODE", "true");

    const lease = await acquireAaisResearchRawTextWriteLeaseIfRequired(student);
    await lease?.release();
    await lease?.release();

    expect(storeMocks.acquire).toHaveBeenCalledOnce();
    expect(storeMocks.acquire).toHaveBeenCalledWith(student);
    expect(storeMocks.release).toHaveBeenCalledOnce();
    expect(storeMocks.release).toHaveBeenCalledWith(
      "10000000-0000-4000-8000-000000000001",
    );
  });
});
