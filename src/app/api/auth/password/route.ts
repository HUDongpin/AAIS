import { NextResponse } from "next/server";
import {
  AaisApiRouteError,
  createAaisApiErrorResponse,
  isAaisApiRouteError,
} from "@/lib/server/aais-api-error";
import { recordAaisAuditEvent } from "@/lib/server/aais-audit-log";
import {
  createAaisUserStore,
  isAaisAuthTokenError,
  isAaisUserStoreConfigurationError,
} from "@/lib/server/aais-users";

type PasswordManagementBody = {
  action?: string;
  email?: string;
  password?: string;
  token?: string;
} | null;

export async function POST(request: Request) {
  const body = (await request.json().catch(() => null)) as PasswordManagementBody;
  try {
    const store = createAaisUserStore();
    if (body?.action === "set-password") {
      const user = await store.setPasswordWithToken({
        token: requireString(body.token, "token"),
        password: requireString(body.password, "password"),
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
      return NextResponse.json({
        user,
        secrets: "redacted",
      });
    }
    if (body?.action === "request-reset") {
      const email = requireString(body.email, "email");
      await store.createPasswordReset({
        email,
        createdBy: "self-service",
      });
      recordAaisAuditEvent({
        event: "auth.password.reset.requested",
        actorId: email,
        outcome: "success",
        metadata: {
          delivery: "queued_if_account_exists",
        },
      });
      return NextResponse.json({
        ok: true,
        delivery: "queued_if_account_exists",
        secrets: "redacted",
      });
    }
    throw new AaisApiRouteError({
      code: "AAIS_PASSWORD_ACTION_UNSUPPORTED",
      message: "Unsupported AAIS password action.",
      status: 400,
    });
  } catch (error) {
    return createAaisApiErrorResponse(getErrorResponseInput(error));
  }
}

function requireString(value: string | undefined, label: string) {
  const text = value?.trim();
  if (!text) {
    throw new AaisApiRouteError({
      code: "AAIS_PASSWORD_REQUIRED_FIELD",
      message: `${label} is required.`,
      status: 400,
    });
  }
  return text;
}

function getErrorResponseInput(error: unknown) {
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
    status: 400,
    cause: error,
    route: "/api/auth/password",
  };
}
