import { randomBytes, scryptSync, timingSafeEqual } from "node:crypto";
import type { AaisSessionActor } from "@/lib/server/aais-session";

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
    password: createPasswordRecord("12345", "aais-dev-bobie"),
  },
  {
    id: "Phoebe",
    displayName: "Phoebe",
    role: "student",
    password: createPasswordRecord("12345", "aais-dev-phoebe"),
  },
];

export function createPasswordRecord(password: string, salt = randomBytes(16).toString("base64url")) {
  return {
    algorithm: "scrypt" as const,
    salt,
    hash: scryptSync(password, salt, 32).toString("base64url"),
  };
}

export function authenticateAaisTrialAccount(accountId: string, password: string): AccountLookupResult {
  if (!isAaisTrialLoginEnabled()) {
    return {
      status: "not_configured",
    };
  }
  const accounts = readTrialAccounts();
  if (!accounts) {
    return {
      status: "not_configured",
    };
  }
  const account = accounts.find((candidate) => candidate.id === accountId);
  if (!account || !passwordMatches(password, account.password)) {
    return {
      status: "invalid",
    };
  }
  return {
    status: "ok",
    actor: {
      id: account.id,
      role: account.role,
      displayName: account.displayName,
    },
  };
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
    process.env.AAIS_TRIAL_ACCOUNTS_JSON?.trim(),
    process.env.AAIS_TRIAL_SMOKE_ACCOUNTS_JSON?.trim(),
    process.env.AAIS_TRIAL_ADDITIONAL_ACCOUNTS_JSON?.trim(),
  ].filter((raw): raw is string => Boolean(raw));
  if (!rawSources.length) {
    return {
      status: "missing",
      accounts: null,
    };
  }
  const accountsById = new Map<string, TrialAccountRecord>();
  try {
    for (const raw of rawSources) {
      const parsed = JSON.parse(raw) as Partial<TrialAccountRecord>[];
      if (!Array.isArray(parsed)) {
        return {
          status: "invalid",
          accounts: null,
        };
      }
      const sourceAccounts = parsed.map(requireTrialAccount);
      if (new Set(sourceAccounts.map((account) => account.id)).size !== sourceAccounts.length) {
        return {
          status: "invalid",
          accounts: null,
        };
      }
      for (const account of sourceAccounts) {
        accountsById.set(account.id, account);
      }
    }
    const accounts = [...accountsById.values()];
    if (accounts.length === 0) {
      return {
        status: "invalid",
        accounts: null,
      };
    }
    if (isProductionRuntime() && accounts.some((account) => account.role !== "student")) {
      return {
        status: "invalid",
        accounts: null,
      };
    }
    return {
      status: "configured",
      accounts,
    };
  } catch {
    return {
      status: "invalid",
      accounts: null,
    };
  }
}

function requireTrialAccount(account: Partial<TrialAccountRecord>): TrialAccountRecord {
  if (
    typeof account.id !== "string"
    || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(account.id)
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

function passwordMatches(password: string, record: PasswordRecord) {
  const actual = scryptSync(password, record.salt, 32);
  const expected = Buffer.from(record.hash, "base64url");
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

function isProductionRuntime() {
  return process.env.NODE_ENV === "production" || process.env.VERCEL_ENV === "production";
}
