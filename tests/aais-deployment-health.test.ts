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
