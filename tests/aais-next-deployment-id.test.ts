import { describe, expect, it } from "vitest";

import { readAaisBuildDeploymentId } from "../src/lib/build/aais-next-deployment-id";

describe("readAaisBuildDeploymentId", () => {
  const gitSha = "0123456789abcdef0123456789abcdef01234567";

  it("preserves the provider deployment ID required by Vercel", () => {
    expect(
      readAaisBuildDeploymentId({
        NEXT_DEPLOYMENT_ID: "dpl_provider_owned_id",
        AAIS_DEPLOYMENT_GIT_COMMIT_SHA: gitSha,
      }),
    ).toBe("dpl_provider_owned_id");
  });

  it("uses the exact Git SHA for an Aliyun image build", () => {
    expect(
      readAaisBuildDeploymentId({
        AAIS_DEPLOYMENT_GIT_COMMIT_SHA: gitSha.toUpperCase(),
      }),
    ).toBe(gitSha);
  });

  it("falls back to the Vercel Git SHA when no provider ID is present", () => {
    expect(readAaisBuildDeploymentId({ VERCEL_GIT_COMMIT_SHA: gitSha })).toBe(gitSha);
  });

  it("does not accept an arbitrary value as a Git release identifier", () => {
    expect(readAaisBuildDeploymentId({ VERCEL_GIT_COMMIT_SHA: "main" })).toBeUndefined();
  });
});
