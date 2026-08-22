import { NextResponse } from "next/server";
import {
  AaisApiRouteError,
  createAaisApiErrorResponse,
  isAaisApiRouteError,
} from "@/lib/server/aais-api-error";
import { recordAaisAuditEvent } from "@/lib/server/aais-audit-log";
import {
  createAaisUserStore,
  isAaisAuthEmailDeliveryFencedError,
  isAaisAuthTokenError,
  isAaisUserStoreConfigurationError,
} from "@/lib/server/aais-users";
import {
  recordAaisPasswordResetRequest,
  recordAaisSetPasswordRequest,
} from "@/lib/server/aais-auth-rate-limit";
import {
  AaisRequestBodyError,
  readAaisBoundedJson,
} from "@/lib/server/aais-request-json";
import { AaisPasswordKdfCapacityError } from "@/lib/server/aais-password-kdf";
import {
  isAaisAuthDeliveryConfigurationError,
  requireAaisAuthDeliveryConfiguration,
} from "@/lib/server/aais-auth-delivery";

const aaisPasswordBodyMaxBytes = 16 * 1024;
const aaisPasswordEmailMaxCharacters = 320;
const aaisPasswordTokenMaxCharacters = 1_024;
const aaisPasswordMinCharacters = 10;
const aaisPasswordMaxCharacters = 256;
const aaisSensitiveResponseHeaders = { "cache-control": "private, no-store" } as const;

type PasswordManagementBody =
  | {
      action: "set-password";
      password: string;
      token: string;
    }
  | {
      action: "request-reset";
      email: string;
    };

export async function POST(request: Request) {
  try {
    const body = await readPasswordManagementBody(request);
    const store = createAaisUserStore();
    if (body.action === "set-password") {
      const rateLimit = await recordAaisSetPasswordRequest({
        token: body.token,
        request,
      }).catch((error: unknown) => {
        throw new AaisSetPasswordRateLimitUnavailableError(error);
      });
      if (rateLimit.status === "blocked") {
        recordAaisAuditEvent({
          event: "auth.password.set",
          outcome: "failure",
          metadata: {
            reason: "rate_limited",
            retryAfterSeconds: rateLimit.retryAfterSeconds,
          },
        });
        return createAaisApiErrorResponse({
          code: "AAIS_SET_PASSWORD_RATE_LIMITED",
          message: "AAIS password request is temporarily rate limited.",
          status: 429,
          headers: {
            ...aaisSensitiveResponseHeaders,
            "retry-after": String(rateLimit.retryAfterSeconds),
          },
        });
      }
      const user = await store.setPasswordWithToken({
        token: body.token,
        password: body.password,
      });
      recordAaisAuditEvent({
        event: "auth.password.set",
        actorId: user.id,
        outcome: "success",
        metadata: {
          role: user.role,
          status: user.status,
        },
      });
      return NextResponse.json(
        {
          user,
          secrets: "redacted",
        },
        { headers: aaisSensitiveResponseHeaders },
      );
    }
    const email = body.email;
    requireAaisAuthDeliveryConfiguration();
    const rateLimit = await recordAaisPasswordResetRequest({
      accountId: email,
      request,
    }).catch((error: unknown) => {
      throw new AaisPasswordResetRateLimitUnavailableError(error);
    });
    if (rateLimit.status === "allowed") {
      await store.createPasswordReset({
        email,
        createdBy: "self-service",
      }).catch((error: unknown) => {
        if (!isAaisAuthEmailDeliveryFencedError(error)) {
          throw error;
        }
        return null;
      });
    }
    recordAaisAuditEvent({
      event: "auth.password.reset.requested",
      actorId: "self-service",
      outcome: rateLimit.status === "allowed" ? "success" : "failure",
      metadata: {
        delivery: "queued_if_account_exists",
        abuseControl: rateLimit.status === "allowed" ? "allowed" : "rate_limited",
      },
    });
    return NextResponse.json(
      {
        ok: true,
        delivery: "queued_if_account_exists",
        secrets: "redacted",
      },
      { headers: aaisSensitiveResponseHeaders },
    );
  } catch (error) {
    return createAaisApiErrorResponse({
      ...getErrorResponseInput(error),
      headers: aaisSensitiveResponseHeaders,
    });
  }
}

async function readPasswordManagementBody(request: Request): Promise<PasswordManagementBody> {
  let value: unknown;
  try {
    value = await readAaisBoundedJson(request, { maxBytes: aaisPasswordBodyMaxBytes });
  } catch (error) {
    if (error instanceof AaisRequestBodyError && error.reason === "too_large") {
      throw passwordRequestError(
        "AAIS_PASSWORD_REQUEST_TOO_LARGE",
        "AAIS password request is too large.",
        413,
      );
    }
    throw passwordRequestError(
      "AAIS_PASSWORD_REQUEST_INVALID",
      "AAIS password request is invalid.",
      400,
    );
  }
  if (!isPlainJsonObject(value) || typeof value.action !== "string") {
    throw passwordRequestError(
      "AAIS_PASSWORD_REQUEST_INVALID",
      "AAIS password request is invalid.",
      400,
    );
  }
  if (value.action.length > 64) {
    throw passwordRequestError(
      "AAIS_PASSWORD_REQUEST_TOO_LARGE",
      "AAIS password request is too large.",
      413,
    );
  }
  if (value.action === "set-password") {
    requireOnlyKeys(value, ["action", "token", "password"]);
    if (typeof value.token !== "string" || typeof value.password !== "string") {
      throw passwordRequestError(
        "AAIS_PASSWORD_REQUEST_INVALID",
        "AAIS password request is invalid.",
        400,
      );
    }
    if (
      value.token.length > aaisPasswordTokenMaxCharacters
      || value.password.length > aaisPasswordMaxCharacters
    ) {
      throw passwordRequestError(
        "AAIS_PASSWORD_REQUEST_TOO_LARGE",
        "AAIS password request is too large.",
        413,
      );
    }
    const token = value.token.trim();
    // Password whitespace is credential material, not presentation padding.
    // Preserve it exactly so the password accepted here is the one users can
    // later authenticate with.
    const password = value.password;
    if (!token || password.length < aaisPasswordMinCharacters) {
      throw passwordRequestError(
        "AAIS_PASSWORD_REQUEST_INVALID",
        "AAIS password request is invalid.",
        400,
      );
    }
    return {
      action: value.action,
      token,
      password,
    };
  }
  if (value.action === "request-reset") {
    requireOnlyKeys(value, ["action", "email"]);
    if (typeof value.email !== "string") {
      throw passwordRequestError(
        "AAIS_PASSWORD_REQUEST_INVALID",
        "AAIS password request is invalid.",
        400,
      );
    }
    if (value.email.length > aaisPasswordEmailMaxCharacters) {
      throw passwordRequestError(
        "AAIS_PASSWORD_REQUEST_TOO_LARGE",
        "AAIS password request is too large.",
        413,
      );
    }
    const email = value.email.trim();
    if (!email) {
      throw passwordRequestError(
        "AAIS_PASSWORD_REQUEST_INVALID",
        "AAIS password request is invalid.",
        400,
      );
    }
    return {
      action: value.action,
      email,
    };
  }
  requireOnlyKeys(value, ["action"]);
  throw new AaisApiRouteError({
    code: "AAIS_PASSWORD_ACTION_UNSUPPORTED",
    message: "Unsupported AAIS password action.",
    status: 400,
  });
}

function isPlainJsonObject(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function requireOnlyKeys(record: Record<string, unknown>, allowedKeys: readonly string[]) {
  const allowed = new Set(allowedKeys);
  if (Object.keys(record).some((key) => !allowed.has(key))) {
    throw passwordRequestError(
      "AAIS_PASSWORD_REQUEST_INVALID",
      "AAIS password request is invalid.",
      400,
    );
  }
}

function passwordRequestError(code: string, message: string, status: 400 | 413) {
  return new AaisApiRouteError({ code, message, status });
}

function getErrorResponseInput(error: unknown) {
  if (error instanceof AaisPasswordKdfCapacityError) {
    return {
      code: "AAIS_PASSWORD_CAPACITY_UNAVAILABLE",
      message: "AAIS password service is temporarily busy. Please retry shortly.",
      status: 503,
    };
  }
  if (error instanceof AaisPasswordResetRateLimitUnavailableError) {
    return {
      code: "AAIS_PASSWORD_RESET_RATE_LIMIT_UNAVAILABLE",
      message: "AAIS password reset protection is temporarily unavailable.",
      status: 503,
      cause: error.cause,
      route: "/api/auth/password",
    };
  }
  if (error instanceof AaisSetPasswordRateLimitUnavailableError) {
    return {
      code: "AAIS_SET_PASSWORD_RATE_LIMIT_UNAVAILABLE",
      message: "AAIS password protection is temporarily unavailable.",
      status: 503,
      cause: error.cause,
      route: "/api/auth/password",
    };
  }
  if (isAaisAuthDeliveryConfigurationError(error)) {
    return {
      code: "AAIS_AUTH_DELIVERY_NOT_CONFIGURED",
      message: "AAIS authentication email delivery is temporarily unavailable.",
      status: 503,
    };
  }
  if (isAaisApiRouteError(error)) {
    return {
      code: error.code,
      message: error.message,
      status: error.status,
    };
  }
  if (isAaisAuthTokenError(error)) {
    return {
      code: "AAIS_PASSWORD_TOKEN_INVALID",
      message: "AAIS password token is invalid or expired.",
      status: 400,
    };
  }
  if (isAaisUserStoreConfigurationError(error)) {
    return {
      code: "AAIS_USER_STORE_NOT_CONFIGURED",
      message: "AAIS user store requires Postgres configuration.",
      status: 503,
    };
  }
  if (error instanceof Error && error.message.startsWith("Invalid AAIS")) {
    return {
      code: "AAIS_PASSWORD_INPUT_INVALID",
      message: "AAIS password input is invalid.",
      status: 400,
    };
  }
  if (error instanceof Error && error.message.startsWith("AAIS password")) {
    return {
      code: "AAIS_PASSWORD_INPUT_INVALID",
      message: "AAIS password input is invalid.",
      status: 400,
    };
  }
  return {
    code: "AAIS_PASSWORD_REQUEST_FAILED",
    message: "AAIS password request failed.",
    status: 500,
    cause: error,
    route: "/api/auth/password",
  };
}

class AaisPasswordResetRateLimitUnavailableError extends Error {
  constructor(readonly cause: unknown) {
    super("AAIS password reset protection is unavailable.");
    this.name = "AaisPasswordResetRateLimitUnavailableError";
  }
}

class AaisSetPasswordRateLimitUnavailableError extends Error {
  constructor(readonly cause: unknown) {
    super("AAIS password protection is unavailable.");
    this.name = "AaisSetPasswordRateLimitUnavailableError";
  }
}
