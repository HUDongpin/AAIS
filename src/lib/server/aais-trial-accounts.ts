import { createHash, createHmac, randomBytes, scryptSync, timingSafeEqual } from "node:crypto";
import type { AaisSessionActor } from "@/lib/server/aais-session";
import { verifyAaisPasswordCandidate } from "@/lib/server/aais-password-kdf";
import { requireAaisSessionSecret } from "@/lib/server/aais-session-secret";

type PasswordRecord = {
  algorithm: "scrypt";
  salt: string;
  hash: string;
};

type TrialAccountRecord = {
  id: string;
  displayName: string;
  role: AaisSessionActor["role"];
  password: PasswordRecord;
};

type AccountLookupResult =
  | {
      status: "ok";
      actor: AaisSessionActor;
    }
  | {
      status: "invalid";
    }
  | {
      status: "not_configured";
    };

export type AaisTrialAccountConfigurationStatus = {
  status: "configured" | "missing" | "invalid" | "disabled";
  configured: boolean;
  accountCount: number;
};

type ConfiguredTrialAccountLookup =
  | {
      status: "configured";
      accounts: TrialAccountRecord[];
    }
  | {
      status: "missing" | "invalid";
      accounts: null;
    };

const builtInLearnerTrialAccounts: TrialAccountRecord[] = [
  {
    id: "Bobie",
    displayName: "Bobie",
    role: "student",
    password: {
      algorithm: "scrypt",
      salt: "aais-dev-bobie",
      hash: "zytgkwvZiyugfkxf6cZL_L2Zj9n-fC53TGaKJbWTvbs",
    },
  },
  {
    id: "Phoebe",
    displayName: "Phoebe",
    role: "student",
    password: {
      algorithm: "scrypt",
      salt: "aais-dev-phoebe",
      hash: "3Y6ksi7dXQPO8Yjc_Pt2qTvSTKNGxvB5owapxTlcDZw",
    },
  },
];

const trialActorIdPrefix = "trial:v1:";

export function createPasswordRecord(password: string, salt = randomBytes(16).toString("base64url")) {
  return {
    algorithm: "scrypt" as const,
    salt,
    hash: scryptSync(password, salt, 32).toString("base64url"),
  };
}

export async function authenticateAaisTrialAccount(
  accountId: string,
  password: string,
): Promise<AccountLookupResult> {
  if (!isAaisTrialLoginEnabled()) {
    return {
      status: "not_configured",
    };
  }
  const accounts = readTrialAccounts();
  if (!accounts) {
    await verifyAaisPasswordCandidate(password, null);
    return {
      status: "not_configured",
    };
  }
  const account = accounts.find((candidate) => candidate.id === accountId);
  const passwordValid = await verifyAaisPasswordCandidate(
    password,
    account?.password ?? null,
  );
  if (!account || !passwordValid) {
    return {
      status: "invalid",
    };
  }
  return {
    status: "ok",
    actor: {
      id: createAaisTrialActorId(account.id),
      role: account.role,
      displayName: account.displayName,
    },
  };
}

export function resolveAaisTrialSessionActor(actorId: string): AaisSessionActor | null {
  const account = findTrialAccountByActorId(actorId);
  return account
    ? {
        id: createAaisTrialActorId(account.id),
        role: account.role,
        displayName: account.displayName,
      }
    : null;
}

export function getAaisTrialSessionPolicyFingerprint(actorId: string) {
  const account = findTrialAccountByActorId(actorId);
  return account ? createTrialSessionPolicyFingerprint(account) : null;
}

export function verifyAaisTrialSessionActor(input: {
  actorId: string;
  role: AaisSessionActor["role"];
  policyFingerprint: string;
}): AaisSessionActor | null {
  const account = findTrialAccountByActorId(input.actorId);
  if (!account) {
    return null;
  }
  const currentFingerprint = createTrialSessionPolicyFingerprint(account);
  if (!policyFingerprintsMatch(input.policyFingerprint, currentFingerprint)) {
    return null;
  }
  const actor = {
    id: createAaisTrialActorId(account.id),
    role: account.role,
    displayName: account.displayName,
  };
  return actor.role === input.role ? actor : null;
}

export function createAaisTrialActorId(accountId: string) {
  const digest = createHash("sha256")
    .update("aais-trial-actor:v1\0", "utf8")
    .update(accountId, "utf8")
    .digest("hex");
  return `${trialActorIdPrefix}${digest}`;
}

function createTrialSessionPolicyFingerprint(account: TrialAccountRecord) {
  const actorId = createAaisTrialActorId(account.id);
  const passwordRecordDigest = createHash("sha256")
    .update("aais.trial.password-record:v1\0", "utf8")
    .update(account.password.algorithm, "utf8")
    .update("\0", "utf8")
    .update(account.password.salt, "utf8")
    .update("\0", "utf8")
    .update(account.password.hash, "utf8")
    .digest("hex");
  return createHmac("sha256", requireAaisSessionSecret())
    .update("aais.trial.session-policy:v1\0", "utf8")
    .update(actorId, "utf8")
    .update("\0", "utf8")
    .update(account.role, "utf8")
    .update("\0", "utf8")
    .update(passwordRecordDigest, "utf8")
    .digest("hex");
}

function policyFingerprintsMatch(actual: string, expected: string) {
  if (!/^[a-f0-9]{64}$/.test(actual) || !/^[a-f0-9]{64}$/.test(expected)) {
    return false;
  }
  return timingSafeEqual(Buffer.from(actual, "hex"), Buffer.from(expected, "hex"));
}

function findTrialAccountByActorId(actorId: string) {
  if (!isAaisTrialLoginEnabled() || !actorId.startsWith(trialActorIdPrefix)) {
    return null;
  }
  return readTrialAccounts()?.find(
    (candidate) => createAaisTrialActorId(candidate.id) === actorId,
  ) ?? null;
}

export function getAaisTrialAccountConfigurationStatus(): AaisTrialAccountConfigurationStatus {
  if (!isAaisTrialLoginEnabled()) {
    return {
      status: "disabled",
      configured: false,
      accountCount: 0,
    };
  }
  const result = readConfiguredTrialAccountLookup();
  return {
    status: result.status,
    configured: result.status === "configured",
    accountCount: result.accounts?.length ?? 0,
  };
}

export function isAaisTrialLoginEnabled() {
  return process.env.AAIS_TRIAL_LOGIN_ENABLED !== "false";
}

function readTrialAccounts() {
  const configuredAccounts = readConfiguredTrialAccounts();
  if (configuredAccounts) {
    return isProductionRuntime()
      ? configuredAccounts
      : mergeConfiguredAccountsWithBuiltInLearners(configuredAccounts);
  }
  return isProductionRuntime() ? null : builtInLearnerTrialAccounts;
}

function readConfiguredTrialAccounts() {
  const result = readConfiguredTrialAccountLookup();
  return result.accounts;
}

function readConfiguredTrialAccountLookup(): ConfiguredTrialAccountLookup {
  const rawSources = [
    {
      raw: process.env.AAIS_TRIAL_ACCOUNTS_JSON?.trim() ?? "",
      recovery: false,
    },
    {
      raw: process.env.AAIS_TRIAL_SMOKE_ACCOUNTS_JSON?.trim() ?? "",
      recovery: false,
    },
    {
      raw: process.env.AAIS_TRIAL_ADDITIONAL_ACCOUNTS_JSON?.trim() ?? "",
      recovery: true,
    },
  ].filter((source) => Boolean(source.raw));
  if (!rawSources.length) {
    return {
      status: "missing",
      accounts: null,
    };
  }

  const accountsById = new Map<string, TrialAccountRecord>();
  let hasInvalidLegacySource = false;
  let hasValidRecoverySource = false;
  for (const source of rawSources) {
    try {
      const sourceAccounts = parseTrialAccountSource(source.raw);
      if (source.recovery && sourceAccounts.length === 0) {
        throw new Error("The recovery account source must not be empty.");
      }
      for (const account of sourceAccounts) {
        accountsById.set(account.id, account);
      }
      hasValidRecoverySource ||= source.recovery;
    } catch {
      if (source.recovery) {
        return {
          status: "invalid",
          accounts: null,
        };
      }
      hasInvalidLegacySource = true;
    }
  }
  if (hasInvalidLegacySource && !hasValidRecoverySource) {
    return {
      status: "invalid",
      accounts: null,
    };
  }

  const accounts = [...accountsById.values()];
  const allowedAccounts = isProductionRuntime()
    ? accounts.filter((account) => account.role === "student")
    : accounts;
  if (allowedAccounts.length === 0) {
    return {
      status: "invalid",
      accounts: null,
    };
  }
  return {
    status: "configured",
    accounts: allowedAccounts,
  };
}

function parseTrialAccountSource(raw: string) {
  const parsed = JSON.parse(raw) as Partial<TrialAccountRecord>[];
  if (!Array.isArray(parsed)) {
    throw new Error("AAIS trial account source must be an array.");
  }
  const accounts = parsed.map(requireTrialAccount);
  if (new Set(accounts.map((account) => account.id)).size !== accounts.length) {
    throw new Error("AAIS trial account source contains duplicate account IDs.");
  }
  return accounts;
}

function requireTrialAccount(account: Partial<TrialAccountRecord>): TrialAccountRecord {
  if (
    typeof account.id !== "string"
    || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(account.id)
    || /^(?:oidc|aais|trial):/i.test(account.id)
    || typeof account.displayName !== "string"
    || account.displayName.trim().length === 0
    || !isAaisSessionRole(account.role)
    || account.password?.algorithm !== "scrypt"
    || typeof account.password.salt !== "string"
    || typeof account.password.hash !== "string"
  ) {
    throw new Error("Invalid AAIS trial account configuration.");
  }
  return {
    id: account.id,
    displayName: account.displayName.trim(),
    role: account.role,
    password: account.password,
  };
}

function isAaisSessionRole(value: unknown): value is AaisSessionActor["role"] {
  return value === "student" || value === "teacher" || value === "admin";
}

function mergeConfiguredAccountsWithBuiltInLearners(configuredAccounts: TrialAccountRecord[]) {
  const configuredIds = new Set(configuredAccounts.map((account) => account.id));
  return [
    ...configuredAccounts,
    ...builtInLearnerTrialAccounts.filter((account) => !configuredIds.has(account.id)),
  ];
}

function isProductionRuntime() {
  return process.env.NODE_ENV === "production" || process.env.VERCEL_ENV === "production";
}
