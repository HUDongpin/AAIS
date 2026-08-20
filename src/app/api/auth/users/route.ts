import { NextResponse } from "next/server";
import { isAaisCsrfError, requireAaisCsrf } from "@/lib/server/aais-csrf";
import { isAaisAuthError, requireAaisSessionActor } from "@/lib/server/aais-request-auth";
import { recordAaisAuditEvent } from "@/lib/server/aais-audit-log";
import {
  AaisApiRouteError,
  createAaisApiErrorResponse,
  isAaisApiRouteError,
} from "@/lib/server/aais-api-error";
import {
  createAaisUserStore,
  isAaisActiveAdminInvariantError,
  isAaisAuthEmailDeliveryFencedError,
  isAaisUserInviteConflictError,
  isAaisUserNotFoundError,
  isAaisUserStoreConfigurationError,
} from "@/lib/server/aais-users";
import {
  AaisRequestBodyError,
  readAaisBoundedJson,
} from "@/lib/server/aais-request-json";
import { isAaisAuthDeliveryConfigurationError } from "@/lib/server/aais-auth-delivery";

const aaisUsersBodyMaxBytes = 16 * 1024;
const aaisUserEmailMaxCharacters = 320;
const aaisUserDisplayNameMaxCharacters = 120;
const aaisUserIdMaxCharacters = 128;
const aaisSensitiveResponseHeaders = { "cache-control": "private, no-store" } as const;

type AaisUserRole = "student" | "teacher" | "researcher" | "admin";
type AaisUserStatus = "invited" | "active" | "disabled";

type UserManagementBody =
  | {
      action: "invite";
      email: string;
      displayName: string;
      role: AaisUserRole;
    }
  | {
      action: "password-reset";
      email: string;
    }
  | {
      action: "update-access";
      role: AaisUserRole;
      status: AaisUserStatus;
      userId: string;
    };

export async function GET(request: Request) {
  try {
    const actor = await requireAdminActor(request);
    requireAaisCsrf(request, actor.id);
    const users = await createAaisUserStore().listUsers();
    return NextResponse.json(
      {
        users,
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

export async function POST(request: Request) {
  try {
    const actor = await requireAdminActor(request);
    requireAaisCsrf(request, actor.id);
    const body = await readUserManagementBody(request);
    const store = createAaisUserStore();
    if (body.action === "invite") {
      const invite = await store.createInvite({
        email: body.email,
        displayName: body.displayName,
        role: body.role,
        createdBy: actor.id,
      });
      recordAaisAuditEvent({
        event: "auth.user.invite.created",
        actorId: actor.id,
        outcome: "success",
        metadata: {
          targetRole: invite.user.role,
          deliveryStatus: invite.delivery.status,
        },
      });
      return NextResponse.json(
        {
          invite: redactInviteResult(invite),
          secrets: "redacted",
        },
        { headers: aaisSensitiveResponseHeaders },
      );
    }
    if (body.action === "password-reset") {
      const reset = await store.createPasswordReset({
        email: body.email,
        createdBy: actor.id,
      });
      recordAaisAuditEvent({
        event: "auth.user.password_reset.created",
        actorId: actor.id,
        outcome: "success",
        metadata: {
          targetFound: Boolean(reset),
          deliveryStatus: reset?.delivery.status ?? "not_queued",
        },
      });
      return NextResponse.json(
        {
          reset: reset ? redactPasswordResetResult(reset) : null,
          secrets: "redacted",
        },
        { headers: aaisSensitiveResponseHeaders },
      );
    }
    const { userId, role, status } = body;
    if (userId === actor.id && (role !== "admin" || status !== "active")) {
      throw new AaisApiRouteError({
        code: "AAIS_USER_SELF_ACTIVE_ADMIN_REQUIRED",
        message: "AAIS administrators must keep their own account active with the admin role.",
        status: 409,
      });
    }
    const user = await store.updateUserAccess({
      userId,
      role,
      status,
      updatedBy: actor.id,
    });
    recordAaisAuditEvent({
      event: "auth.user.access.updated",
      actorId: actor.id,
      outcome: "success",
      metadata: {
        targetRole: user.role,
        targetStatus: user.status,
      },
    });
    return NextResponse.json(
      {
        user,
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

async function requireAdminActor(request: Request) {
  const actor = await requireAaisSessionActor(request);
  if (actor.role !== "admin") {
    throw new AaisUserManagementAuthorizationError();
  }
  return actor;
}

async function readUserManagementBody(request: Request): Promise<UserManagementBody> {
  let value: unknown;
  try {
    value = await readAaisBoundedJson(request, { maxBytes: aaisUsersBodyMaxBytes });
  } catch (error) {
    if (error instanceof AaisRequestBodyError && error.reason === "too_large") {
      throw userRequestError(
        "AAIS_USER_REQUEST_TOO_LARGE",
        "AAIS user management request is too large.",
        413,
      );
    }
    throw userRequestError(
      "AAIS_USER_REQUEST_INVALID",
      "AAIS user management request is invalid.",
      400,
    );
  }
  if (!isPlainJsonObject(value) || typeof value.action !== "string") {
    throw userRequestError(
      "AAIS_USER_REQUEST_INVALID",
      "AAIS user management request is invalid.",
      400,
    );
  }
  if (value.action.length > 64) {
    throw userRequestError(
      "AAIS_USER_REQUEST_TOO_LARGE",
      "AAIS user management request is too large.",
      413,
    );
  }
  if (value.action === "invite") {
    requireOnlyKeys(value, ["action", "email", "displayName", "role"]);
    if (
      typeof value.email !== "string"
      || typeof value.displayName !== "string"
      || !isAaisUserRole(value.role)
    ) {
      throw userRequestError(
        "AAIS_USER_REQUEST_INVALID",
        "AAIS user management request is invalid.",
        400,
      );
    }
    if (
      value.email.length > aaisUserEmailMaxCharacters
      || value.displayName.length > aaisUserDisplayNameMaxCharacters
    ) {
      throw userRequestError(
        "AAIS_USER_REQUEST_TOO_LARGE",
        "AAIS user management request is too large.",
        413,
      );
    }
    const email = value.email.trim();
    const displayName = value.displayName.trim();
    if (!email || !displayName) {
      throw userRequestError(
        "AAIS_USER_REQUEST_INVALID",
        "AAIS user management request is invalid.",
        400,
      );
    }
    return {
      action: value.action,
      email,
      displayName,
      role: value.role,
    };
  }
  if (value.action === "password-reset") {
    requireOnlyKeys(value, ["action", "email"]);
    if (typeof value.email !== "string") {
      throw userRequestError(
        "AAIS_USER_REQUEST_INVALID",
        "AAIS user management request is invalid.",
        400,
      );
    }
    if (value.email.length > aaisUserEmailMaxCharacters) {
      throw userRequestError(
        "AAIS_USER_REQUEST_TOO_LARGE",
        "AAIS user management request is too large.",
        413,
      );
    }
    const email = value.email.trim();
    if (!email) {
      throw userRequestError(
        "AAIS_USER_REQUEST_INVALID",
        "AAIS user management request is invalid.",
        400,
      );
    }
    return { action: value.action, email };
  }
  if (value.action === "update-access") {
    requireOnlyKeys(value, ["action", "userId", "role", "status"]);
    if (
      typeof value.userId !== "string"
      || !isAaisUserRole(value.role)
      || !isAaisUserStatus(value.status)
    ) {
      throw userRequestError(
        "AAIS_USER_REQUEST_INVALID",
        "AAIS user management request is invalid.",
        400,
      );
    }
    if (value.userId.length > aaisUserIdMaxCharacters) {
      throw userRequestError(
        "AAIS_USER_REQUEST_TOO_LARGE",
        "AAIS user management request is too large.",
        413,
      );
    }
    const userId = value.userId.trim();
    if (!userId) {
      throw userRequestError(
        "AAIS_USER_REQUEST_INVALID",
        "AAIS user management request is invalid.",
        400,
      );
    }
    return {
      action: value.action,
      userId,
      role: value.role,
      status: value.status,
    };
  }
  requireOnlyKeys(value, ["action"]);
  throw new AaisApiRouteError({
    code: "AAIS_USER_ACTION_UNSUPPORTED",
    message: "Unsupported AAIS user management action.",
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
    throw userRequestError(
      "AAIS_USER_REQUEST_INVALID",
      "AAIS user management request is invalid.",
      400,
    );
  }
}

function isAaisUserRole(value: unknown): value is AaisUserRole {
  return value === "student" || value === "teacher" || value === "researcher" || value === "admin";
}

function isAaisUserStatus(value: unknown): value is AaisUserStatus {
  return value === "invited" || value === "active" || value === "disabled";
}

function userRequestError(code: string, message: string, status: 400 | 413) {
  return new AaisApiRouteError({ code, message, status });
}

class AaisUserManagementAuthorizationError extends Error {
  constructor() {
    super("AAIS user management requires admin authorization.");
  }
}

function redactInviteResult(
  invite: Awaited<ReturnType<ReturnType<typeof createAaisUserStore>["createInvite"]>>,
) {
  return {
    user: invite.user,
    delivery: invite.delivery,
  };
}

function redactPasswordResetResult(
  reset: NonNullable<Awaited<ReturnType<ReturnType<typeof createAaisUserStore>["createPasswordReset"]>>>,
) {
  return {
    user: reset.user,
    delivery: reset.delivery,
  };
}

function getErrorResponseInput(error: unknown) {
  if (isAaisApiRouteError(error)) {
    return {
      code: error.code,
      message: error.message,
      status: error.status,
    };
  }
  if (isAaisAuthError(error)) {
    return {
      code: "AAIS_AUTH_REQUIRED",
      message: "AAIS authentication is required.",
      status: 401,
    };
  }
  if (error instanceof AaisUserManagementAuthorizationError) {
    return {
      code: "AAIS_USER_MANAGEMENT_FORBIDDEN",
      message: "AAIS user management requires admin authorization.",
      status: 403,
    };
  }
  if (isAaisCsrfError(error)) {
    return {
      code: "AAIS_CSRF_REQUIRED",
      message: "AAIS CSRF token is required.",
      status: 403,
    };
  }
  if (isAaisUserStoreConfigurationError(error)) {
    return {
      code: "AAIS_USER_STORE_NOT_CONFIGURED",
      message: "AAIS user store requires Postgres configuration.",
      status: 503,
    };
  }
  if (isAaisAuthDeliveryConfigurationError(error)) {
    return {
      code: "AAIS_AUTH_DELIVERY_NOT_CONFIGURED",
      message: "AAIS authentication email delivery is temporarily unavailable.",
      status: 503,
    };
  }
  if (isAaisUserNotFoundError(error)) {
    return {
      code: "AAIS_USER_NOT_FOUND",
      message: "AAIS user was not found.",
      status: 404,
    };
  }
  if (isAaisActiveAdminInvariantError(error)) {
    return {
      code: "AAIS_ACTIVE_ADMIN_REQUIRED",
      message: "AAIS must retain at least one active administrator.",
      status: 409,
    };
  }
  if (isAaisUserInviteConflictError(error)) {
    return {
      code: "AAIS_USER_INVITE_CONFLICT",
      message: "AAIS cannot invite an account that is already active or disabled.",
      status: 409,
    };
  }
  if (isAaisAuthEmailDeliveryFencedError(error)) {
    return {
      code: "AAIS_AUTH_EMAIL_DELIVERY_IN_PROGRESS",
      message: "AAIS authentication email delivery is already in progress.",
      status: 409,
    };
  }
  if (error instanceof Error && error.message.startsWith("Invalid AAIS")) {
    return {
      code: "AAIS_USER_INPUT_INVALID",
      message: "AAIS user input is invalid.",
      status: 400,
    };
  }
  return {
    code: "AAIS_USER_MANAGEMENT_FAILED",
    message: "AAIS user management request failed.",
    status: 500,
    cause: error,
    route: "/api/auth/users",
  };
}
