import { afterEach, describe, expect, it, vi } from "vitest";
import {
  AaisPasswordKdfCapacityError,
  verifyAaisPasswordCandidate,
} from "@/lib/server/aais-password-kdf";

afterEach(() => {
  delete process.env.AAIS_TRIAL_ACCOUNTS_JSON;
  vi.doUnmock("@/lib/server/aais-password-kdf");
  vi.resetModules();
  vi.restoreAllMocks();
});

describe("AAIS password KDF", () => {
  it("bounds concurrent and queued scrypt work instead of exhausting the process", async () => {
    const attempts = Array.from({ length: 37 }, () =>
      verifyAaisPasswordCandidate("capacity-test-password", null)
    );
    const results = await Promise.allSettled(attempts);

    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(36);
    const rejected = results.filter((result) => result.status === "rejected");
    expect(rejected).toHaveLength(1);
    expect((rejected[0] as PromiseRejectedResult).reason)
      .toBeInstanceOf(AaisPasswordKdfCapacityError);
  });

  it("uses the same verifier abstraction for known and missing trial identities", async () => {
    const passwordVerifier = vi.fn(async (
      _password: string,
      record: { algorithm: "scrypt"; salt: string; hash: string } | null,
    ) => record !== null);
    vi.doMock("@/lib/server/aais-password-kdf", async () => {
      const actual = await vi.importActual<typeof import("@/lib/server/aais-password-kdf")>(
        "@/lib/server/aais-password-kdf",
      );
      return {
        ...actual,
        verifyAaisPasswordCandidate: passwordVerifier,
      };
    });
    process.env.AAIS_TRIAL_ACCOUNTS_JSON = JSON.stringify([
      {
        id: "KdfKnown",
        displayName: "KDF Known",
        role: "student",
        password: {
          algorithm: "scrypt",
          salt: "known-trial-salt",
          hash: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
        },
      },
    ]);
    const { authenticateAaisTrialAccount } = await import(
      "@/lib/server/aais-trial-accounts"
    );

    await expect(authenticateAaisTrialAccount("KdfKnown", "candidate-password"))
      .resolves.toMatchObject({ status: "ok" });
    await expect(authenticateAaisTrialAccount("KdfMissing", "candidate-password"))
      .resolves.toEqual({ status: "invalid" });

    expect(passwordVerifier).toHaveBeenCalledTimes(2);
    expect(passwordVerifier.mock.calls[0]?.[1]).toMatchObject({
      algorithm: "scrypt",
      salt: "known-trial-salt",
    });
    expect(passwordVerifier.mock.calls[1]?.[1]).toBeNull();
  });
});
