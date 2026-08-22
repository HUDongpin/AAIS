import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createAaisSessionToken } from "@/lib/server/aais-session";

const mocks = vi.hoisted(() => ({
  resolveDatabaseActor: vi.fn(),
  verifyTrialActor: vi.fn(),
  revoked: vi.fn(),
  oidcPolicyFingerprint: vi.fn(),
}));

vi.mock("@/lib/server/aais-users", () => ({
  resolveAaisDatabaseSessionActor: mocks.resolveDatabaseActor,
}));

vi.mock("@/lib/server/aais-trial-accounts", () => ({
  verifyAaisTrialSessionActor: mocks.verifyTrialActor,
}));

vi.mock("@/lib/server/aais-session-revocations", () => ({
  isAaisSessionTokenRevoked: mocks.revoked,
}));

vi.mock("@/lib/server/aais-oidc", () => ({
  getAaisOidcSessionPolicyFingerprint: mocks.oidcPolicyFingerprint,
}));

import { verifyAaisRequestSessionToken } from "@/lib/server/aais-request-auth";

beforeEach(() => {
  process.env.AAIS_SESSION_SECRET = "test-session-secret-with-at-least-32-characters";
  mocks.revoked.mockReset().mockResolvedValue(false);
  mocks.resolveDatabaseActor.mockReset().mockResolvedValue({ status: "not_configured" });
  mocks.verifyTrialActor.mockReset().mockReturnValue(null);
  mocks.oidcPolicyFingerprint.mockReset().mockReturnValue("a".repeat(64));
});

afterEach(() => {
  delete process.env.AAIS_SESSION_SECRET;
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe("AAIS request authorization", () => {
  it("returns the current database actor when role and status still match", async () => {
    mocks.resolveDatabaseActor.mockResolvedValue({
      status: "active",
      actor: { id: "admin-1", role: "admin", displayName: "Current Admin" },
      authVersion: 1,
    });

    await expect(verifyAaisRequestSessionToken(createToken("admin-1", "admin", 1)))
      .resolves.toEqual({ id: "admin-1", role: "admin", displayName: "Current Admin" });
  });

  it("invalidates an old privileged token after role change or account disablement", async () => {
    mocks.resolveDatabaseActor.mockResolvedValueOnce({
      status: "active",
      actor: { id: "admin-1", role: "teacher", displayName: "Former Admin" },
      authVersion: 1,
    });
    await expect(verifyAaisRequestSessionToken(createToken("admin-1", "admin", 1)))
      .resolves.toBeNull();

    mocks.resolveDatabaseActor.mockResolvedValueOnce({ status: "inactive" });
    await expect(verifyAaisRequestSessionToken(createToken("admin-1", "admin")))
      .resolves.toBeNull();
  });

  it("invalidates database sessions after the account auth version advances", async () => {
    mocks.resolveDatabaseActor.mockResolvedValue({
      status: "active",
      actor: {
        id: "student-1",
        role: "student",
        displayName: "Student",
      },
      authVersion: 2,
    });

    const token = createAaisSessionToken({
      id: "student-1",
      role: "student",
      displayName: "Student",
    }, new Date(), { authVersion: 1 });
    await expect(verifyAaisRequestSessionToken(token)).resolves.toBeNull();
  });

  it("rejects legacy database cookies and fails closed when a database source loses configuration", async () => {
    mocks.resolveDatabaseActor.mockResolvedValue({
      status: "active",
      actor: { id: "admin-1", role: "admin", displayName: "Admin" },
      authVersion: 1,
    });
    await expect(verifyAaisRequestSessionToken(createToken("admin-1", "admin")))
      .resolves.toBeNull();
    expect(mocks.resolveDatabaseActor).not.toHaveBeenCalled();

    mocks.resolveDatabaseActor.mockResolvedValue({ status: "not_configured" });
    await expect(verifyAaisRequestSessionToken(createToken("admin-1", "admin", 1)))
      .resolves.toBeNull();
  });

  it("keeps legacy v2 database sessions bound to the current database auth version", async () => {
    mocks.resolveDatabaseActor.mockResolvedValue({
      status: "active",
      actor: { id: "admin-1", role: "admin", displayName: "Current Admin" },
      authVersion: 1,
    });
    const legacyV2 = createAaisSessionToken(
      { id: "admin-1", role: "admin", displayName: "Token Snapshot" },
      new Date(),
      { authVersion: 1 },
    );
    await expect(verifyAaisRequestSessionToken(legacyV2)).resolves.toEqual({
      id: "admin-1",
      role: "admin",
      displayName: "Current Admin",
    });
  });

  it("fails closed when the current authorization lookup fails", async () => {
    mocks.resolveDatabaseActor.mockRejectedValue(new Error("database unavailable"));

    await expect(verifyAaisRequestSessionToken(createToken("admin-1", "admin")))
      .resolves.toBeNull();
  });

  it("fails closed before accepting an OIDC session when production revocation storage is unavailable", async () => {
    vi.stubEnv("NODE_ENV", "production");
    mocks.revoked.mockRejectedValue(new Error("durable revocation storage unavailable"));
    const token = createAaisSessionToken(
      { id: `oidc:v2:${"b".repeat(64)}`, role: "teacher", displayName: "Teacher" },
      new Date(),
      {
        authSource: "oidc",
        oidcPolicyFingerprint: "a".repeat(64),
        ttlSeconds: 15 * 60,
      },
    );

    await expect(verifyAaisRequestSessionToken(token)).resolves.toBeNull();
    expect(mocks.revoked).toHaveBeenCalledOnce();
    expect(mocks.oidcPolicyFingerprint).not.toHaveBeenCalled();
  });

  it("rejects source-ambiguous v1 sessions without guessing from actor namespaces", async () => {
    mocks.resolveDatabaseActor.mockResolvedValue({ status: "not_configured" });
    mocks.verifyTrialActor.mockReturnValue({
      id: "trial:v1:legacy",
      role: "admin",
      displayName: "Legacy Trial Admin",
    });

    for (const actorId of [
      "dev-admin",
      "database-admin",
      "trial:v1:legacy",
      "oidc:v2:legacy",
    ]) {
      await expect(verifyAaisRequestSessionToken(createToken(actorId, "admin")))
        .resolves.toBeNull();
    }
    expect(mocks.resolveDatabaseActor).not.toHaveBeenCalled();
    expect(mocks.verifyTrialActor).not.toHaveBeenCalled();
  });

  it("binds v3 trial and OIDC sessions to their explicit current source", async () => {
    mocks.verifyTrialActor.mockReturnValue({
      id: "trial-student",
      role: "student",
      displayName: "Current Trial Student",
    });
    const trialToken = createAaisSessionToken(
      { id: "trial-student", role: "student", displayName: "Token Snapshot" },
      new Date(),
      { authSource: "trial", trialPolicyFingerprint: "d".repeat(64) },
    );
    await expect(verifyAaisRequestSessionToken(trialToken)).resolves.toEqual({
      id: "trial-student",
      role: "student",
      displayName: "Current Trial Student",
    });
    expect(mocks.verifyTrialActor).toHaveBeenCalledWith({
      actorId: "trial-student",
      role: "student",
      policyFingerprint: "d".repeat(64),
    });
    mocks.verifyTrialActor.mockReturnValue(null);
    await expect(verifyAaisRequestSessionToken(trialToken)).resolves.toBeNull();

    const oidcToken = createAaisSessionToken(
      { id: `oidc:v2:${"b".repeat(64)}`, role: "teacher", displayName: "Teacher" },
      new Date(),
      {
        authSource: "oidc",
        oidcPolicyFingerprint: "a".repeat(64),
        ttlSeconds: 15 * 60,
      },
    );
    await expect(verifyAaisRequestSessionToken(oidcToken)).resolves.toMatchObject({
      role: "teacher",
    });
    mocks.oidcPolicyFingerprint.mockReturnValue("c".repeat(64));
    await expect(verifyAaisRequestSessionToken(oidcToken)).resolves.toBeNull();
    mocks.oidcPolicyFingerprint.mockReturnValue(null);
    await expect(verifyAaisRequestSessionToken(oidcToken)).resolves.toBeNull();

    const developmentToken = createAaisSessionToken(
      { id: "dev-student", role: "student", displayName: "Development Student" },
      new Date(),
      { authSource: "development" },
    );
    await expect(verifyAaisRequestSessionToken(developmentToken)).resolves.toEqual({
      id: "dev-student",
      role: "student",
      displayName: "Development Student",
    });
  });

  it("rejects legacy and development-source sessions in production without guessing by actor prefix", async () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("AAIS_SESSION_SECRET", "production-session-secret-with-at-least-32-bytes");
    mocks.resolveDatabaseActor.mockResolvedValue({ status: "not_found" });

    await expect(verifyAaisRequestSessionToken(createToken("oidc:trial-1", "admin")))
      .resolves.toBeNull();
    const developmentToken = createAaisSessionToken(
      { id: "dev-admin", role: "admin", displayName: "Development Admin" },
      new Date(),
      { authSource: "development" },
    );
    await expect(verifyAaisRequestSessionToken(developmentToken)).resolves.toBeNull();
  });
});

function createToken(
  id: string,
  role: "student" | "teacher" | "researcher" | "admin",
  authVersion?: number,
) {
  return createAaisSessionToken(
    { id, role, displayName: "Token Snapshot" },
    new Date(),
    authVersion === undefined ? {} : { authSource: "database", authVersion },
  );
}
