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
  isAaisUserNotFoundError,
  isAaisUserStoreConfigurationError,
} from "@/lib/server/aais-users";

type UserManagementBody = {
  action?: string;
  email?: string;
  displayName?: string;
  role?: "student" | "teacher" | "admin";
  status?: "invited" | "active" | "disabled";
  userId?: string;
} | null;

export async function GET(request: Request) {
  try {
    const actor = await requireAdminActor(request);
    requireAaisCsrf(request, actor.id);
    const users = await createAaisUserStore().listUsers();
    return NextResponse.json({
      users,
      secrets: "redacted",
    });
  } catch (error) {
    return createAaisApiErrorResponse(getErrorResponseInput(error));
  }
}

export async function POST(request: Request) {
  const body = (await request.json().catch(() => null)) as UserManagementBody;
  try {
    const actor = await requireAdminActor(request);
    requireAaisCsrf(request, actor.id);
    const store = createAaisUserStore();
    if (body?.action === "invite") {
      const invite = await store.createInvite({
        email: requireString(body.email, "email"),
        displayName: requireString(body.displayName, "displayName"),
        role: requireRole(body.role),
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
      return NextResponse.json({
        invite: redactInviteResult(invite),
        secrets: "redacted",
      });
    }
    if (body?.action === "password-reset") {
      const reset = await store.createPasswordReset({
        email: requireString(body.email, "email"),
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
      return NextResponse.json({
        reset: reset ? redactPasswordResetResult(reset) : null,
        secrets: "redacted",
      });
    }
    if (body?.action === "update-access") {
      const userId = requireString(body.userId, "userId");
      const status = requireStatus(body.status);
      if (userId === actor.id && status === "disabled") {
        throw new AaisApiRouteError({
          code: "AAIS_USER_SELF_DISABLE_UNSUPPORTED",
          message: "AAIS administrators cannot disable their own account.",
          status: 400,
        });
      }
      const user = await store.updateUserAccess({
        userId,
        role: requireRole(body.role),
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
      return NextResponse.json({
        user,
        secrets: "redacted",
      });
    }
    throw new AaisApiRouteError({
      code: "AAIS_USER_ACTION_UNSUPPORTED",
      message: "Unsupported AAIS user management action.",
      status: 400,
    });
  } catch (error) {
    return createAaisApiErrorResponse(getErrorResponseInput(error));
  }
}

async function requireAdminActor(request: Request) {
  const actor = await requireAaisSessionActor(request);
  if (actor.role !== "admin") {
    throw new AaisUserManagementAuthorizationError();
  }
  return actor;
}

function requireString(value: string | undefined, label: string) {
  const text = value?.trim();
  if (!text) {
    throw new AaisApiRouteError({
      code: "AAIS_USER_REQUIRED_FIELD",
      message: `${label} is required.`,
      status: 400,
    });
  }
  return text;
}

function requireRole(value: string | undefined) {
  if (value === "student" || value === "teacher" || value === "admin") {
    return value;
  }
  throw new AaisApiRouteError({
    code: "AAIS_USER_ROLE_INVALID",
    message: "AAIS user role is invalid.",
    status: 400,
  });
}

function requireStatus(value: string | undefined) {
  if (value === "invited" || value === "active" || value === "disabled") {
    return value;
  }
  throw new AaisApiRouteError({
    code: "AAIS_USER_STATUS_INVALID",
    message: "AAIS user status is invalid.",
    status: 400,
  });
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
  if (isAaisUserNotFoundError(error)) {
    return {
      code: "AAIS_USER_NOT_FOUND",
      message: "AAIS user was not found.",
      status: 404,
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
    status: 400,
    cause: error,
    route: "/api/auth/users",
  };
}
