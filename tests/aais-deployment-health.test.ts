import { afterEach, describe, expect, it, vi } from "vitest";
import {
  getAaisReleaseMetadata,
  readAaisDeploymentProvider,
} from "@/lib/server/aais-deployment-metadata";

describe("AAIS deployment metadata and liveness", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("reports an explicit Aliyun release without exposing deployment secrets", async () => {
    vi.stubEnv("AAIS_DEPLOYMENT_PROVIDER", "aliyun");
    vi.stubEnv("AAIS_RELEASE_ID", "0123456789abcdef0123456789abcdef01234567");
    vi.stubEnv("AAIS_DEPLOYMENT_GIT_COMMIT_SHA", "0123456789abcdef0123456789abcdef01234567");
    const { GET } = await import("@/app/api/system/live/route");

    const response = await GET();

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    await expect(response.json()).resolves.toEqual({
      status: "live",
      releaseId: "0123456789abcdef0123456789abcdef01234567",
      provider: "aliyun",
    });
  });

  it("keeps Vercel auto-detection while allowing an explicit provider", () => {
    expect(readAaisDeploymentProvider({ VERCEL: "1" })).toBe("vercel");
    expect(readAaisDeploymentProvider({
      VERCEL: "1",
      AAIS_DEPLOYMENT_PROVIDER: "aliyun",
    })).toBe("aliyun");
    expect(readAaisDeploymentProvider({
      AAIS_DEPLOYMENT_PROVIDER: "invalid",
    })).toBe("unknown");
  });

  it("binds a Vercel release ID to the complete provider Git SHA", () => {
    expect(getAaisReleaseMetadata({
      VERCEL: "1",
      VERCEL_GIT_COMMIT_SHA: "ABCDEF0123456789ABCDEF0123456789ABCDEF01",
      AAIS_RELEASE_ID: "stale-manual-release",
    })).toMatchObject({
      id: "abcdef0123456789abcdef0123456789abcdef01",
      source: "VERCEL_GIT_COMMIT_SHA",
      deployment: {
        provider: "vercel",
        gitCommit: {
          present: true,
          shortSha: "abcdef012345",
          source: "VERCEL_GIT_COMMIT_SHA",
        },
      },
    });
  });

  it("rejects an Aliyun release ID that is not the exact deployed Git SHA", () => {
    expect(getAaisReleaseMetadata({
      AAIS_DEPLOYMENT_PROVIDER: "aliyun",
      AAIS_RELEASE_ID: "0123456789abcdef0123456789abcdef01234567",
      AAIS_DEPLOYMENT_GIT_COMMIT_SHA: "abcdef0123456789abcdef0123456789abcdef01",
    })).toMatchObject({
      id: null,
      source: "missing",
      deployment: {
        provider: "aliyun",
        gitCommit: {
          present: true,
          shortSha: "abcdef012345",
        },
      },
    });
  });

  it("redacts malformed release metadata instead of reflecting it", () => {
    expect(getAaisReleaseMetadata({
      AAIS_DEPLOYMENT_PROVIDER: "aliyun",
      AAIS_RELEASE_ID: "secret value with spaces",
      AAIS_DEPLOYMENT_GIT_COMMIT_SHA: "not-a-sha",
    })).toEqual({
      id: null,
      source: "missing",
      deployment: {
        provider: "aliyun",
        gitCommit: {
          present: false,
          shortSha: null,
          source: "missing",
        },
      },
    });
  });
});
