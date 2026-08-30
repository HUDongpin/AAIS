import { beforeEach, describe, expect, it, vi } from "vitest";

const getDatabaseConfiguration = vi.hoisted(() => vi.fn());
const probeTrafficStorage = vi.hoisted(() => vi.fn());
const durableStorageRequired = vi.hoisted(() => vi.fn());

vi.mock("@/lib/server/aais-learning-store", () => ({
  getAaisDatabaseConfiguration: getDatabaseConfiguration,
  probeAaisTrafficStorage: probeTrafficStorage,
}));

vi.mock("@/lib/server/aais-runtime", () => ({
  requiresAaisDurableStorage: durableStorageRequired,
}));

import { getAaisTrafficReadinessReport } from "@/lib/server/aais-traffic-readiness";

describe("AAIS traffic readiness", () => {
  beforeEach(() => {
    getDatabaseConfiguration.mockReset();
    probeTrafficStorage.mockReset();
    durableStorageRequired.mockReset();
    vi.stubEnv("AAIS_DEPLOYMENT_PROVIDER", "aliyun");
    vi.stubEnv("AAIS_RELEASE_ID", "release-0123456789abcdef");
    vi.stubEnv("AAIS_DEPLOYMENT_GIT_COMMIT_SHA", "0123456789abcdef0123456789abcdef01234567");
    vi.stubEnv("AAIS_DATABASE_TARGET_ID", "aais-source-production");
  });

  it("is ready only after the durable product schema probe succeeds", async () => {
    getDatabaseConfiguration.mockReturnValue({
      url: "postgres://redacted@example.test/aais",
      sourceEnv: "AAIS_DATABASE_URL",
    });
    durableStorageRequired.mockReturnValue(true);
    probeTrafficStorage.mockResolvedValue({ mode: "postgres", status: "connected" });

    await expect(getAaisTrafficReadinessReport()).resolves.toEqual({
      status: "ready",
      releaseId: "release-0123456789abcdef",
      provider: "aliyun",
      deployment: "valid",
      database: "ok",
      schema: "current",
    });
  });

  it("fails closed when production has no database configuration", async () => {
    getDatabaseConfiguration.mockReturnValue(null);
    durableStorageRequired.mockReturnValue(true);

    await expect(getAaisTrafficReadinessReport()).resolves.toMatchObject({
      status: "not_ready",
      database: "unavailable",
      schema: "unavailable",
      deployment: "invalid",
    });
    expect(probeTrafficStorage).not.toHaveBeenCalled();
  });

  it("does not turn an external provider outage into a traffic decision", async () => {
    getDatabaseConfiguration.mockReturnValue({
      url: "postgres://redacted@example.test/aais",
      sourceEnv: "AAIS_DATABASE_URL",
    });
    durableStorageRequired.mockReturnValue(true);
    probeTrafficStorage.mockResolvedValue({ mode: "postgres", status: "connected" });

    const report = await getAaisTrafficReadinessReport();

    expect(report.status).toBe("ready");
    expect(report).not.toHaveProperty("ai");
    expect(report).not.toHaveProperty("email");
    expect(report).not.toHaveProperty("lrs");
  });

  it("allows a database-free development runtime", async () => {
    getDatabaseConfiguration.mockReturnValue(null);
    durableStorageRequired.mockReturnValue(false);

    await expect(getAaisTrafficReadinessReport()).resolves.toMatchObject({
      status: "ready",
      database: "not_required",
      schema: "not_required",
      deployment: "not_required",
    });
  });

  it("fails closed when a production release has no provider provenance", async () => {
    vi.stubEnv("AAIS_DEPLOYMENT_PROVIDER", "");
    getDatabaseConfiguration.mockReturnValue({
      url: "postgres://redacted@example.test/aais",
      sourceEnv: "AAIS_DATABASE_URL",
    });
    durableStorageRequired.mockReturnValue(true);

    await expect(getAaisTrafficReadinessReport()).resolves.toMatchObject({
      status: "not_ready",
      provider: "unknown",
      deployment: "invalid",
    });
    expect(probeTrafficStorage).not.toHaveBeenCalled();
  });

  it("fails closed when the configured database identity is missing", async () => {
    vi.stubEnv("AAIS_DATABASE_TARGET_ID", "");
    getDatabaseConfiguration.mockReturnValue({
      url: "postgres://redacted@example.test/aais",
      sourceEnv: "AAIS_DATABASE_URL",
    });
    durableStorageRequired.mockReturnValue(true);

    await expect(getAaisTrafficReadinessReport()).resolves.toMatchObject({
      status: "not_ready",
      database: "unavailable",
    });
    expect(probeTrafficStorage).not.toHaveBeenCalled();
  });

  it("rejects a production fallback database alias", async () => {
    getDatabaseConfiguration.mockReturnValue({
      url: "postgres://redacted@example.test/aais",
      sourceEnv: "DATABASE_URL",
    });
    durableStorageRequired.mockReturnValue(true);

    await expect(getAaisTrafficReadinessReport()).resolves.toMatchObject({
      status: "not_ready",
      database: "unavailable",
    });
    expect(probeTrafficStorage).not.toHaveBeenCalled();
  });
});
