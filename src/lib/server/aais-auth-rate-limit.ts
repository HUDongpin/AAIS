type AaisLoginRateLimitRecord = {
  failures: number;
  firstFailureAt: number;
  lockedUntil: number;
};

const maxFailures = 5;
const windowMs = 15 * 60 * 1000;
const lockMs = 15 * 60 * 1000;
const attempts = new Map<string, AaisLoginRateLimitRecord>();

export type AaisLoginRateLimitResult =
  | {
      status: "allowed";
    }
  | {
      status: "blocked";
      retryAfterSeconds: number;
    };

export function checkAaisLoginRateLimit(input: {
  accountId: string;
  request: Request;
  now?: number;
}): AaisLoginRateLimitResult {
  const now = input.now ?? Date.now();
  const record = attempts.get(createRateLimitKey(input.accountId, input.request));
  if (!record || record.lockedUntil <= now) {
    return {
      status: "allowed",
    };
  }
  return {
    status: "blocked",
    retryAfterSeconds: Math.max(1, Math.ceil((record.lockedUntil - now) / 1000)),
  };
}

export function recordAaisLoginFailure(input: {
  accountId: string;
  request: Request;
  now?: number;
}): AaisLoginRateLimitResult {
  const now = input.now ?? Date.now();
  const key = createRateLimitKey(input.accountId, input.request);
  const existing = attempts.get(key);
  const record: AaisLoginRateLimitRecord =
    existing && now - existing.firstFailureAt < windowMs
      ? existing
      : {
          failures: 0,
          firstFailureAt: now,
          lockedUntil: 0,
        };
  record.failures += 1;
  if (record.failures > maxFailures) {
    record.lockedUntil = now + lockMs;
  }
  attempts.set(key, record);
  return checkAaisLoginRateLimit(input);
}

export function clearAaisLoginFailures(input: {
  accountId: string;
  request: Request;
}) {
  attempts.delete(createRateLimitKey(input.accountId, input.request));
}

function createRateLimitKey(accountId: string, request: Request) {
  return `${normalizeAccount(accountId)}:${getClientAddress(request)}`;
}

function normalizeAccount(accountId: string) {
  return accountId.trim().toLowerCase();
}

function getClientAddress(request: Request) {
  const forwardedFor = request.headers.get("x-forwarded-for")?.split(",")[0]?.trim();
  return forwardedFor
    || request.headers.get("cf-connecting-ip")?.trim()
    || request.headers.get("x-real-ip")?.trim()
    || "unknown";
}
