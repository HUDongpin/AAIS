import { NextResponse } from "next/server";
import { recordAaisMonitoringIssue } from "@/lib/server/aais-monitoring";

type AaisApiErrorBodyExtra = Record<string, unknown>;

export class AaisApiRouteError extends Error {
  readonly code: string;
  readonly status: number;

  constructor(input: {
    code: string;
    message: string;
    status: number;
  }) {
    super(input.message);
    this.name = "AaisApiRouteError";
    this.code = input.code;
    this.status = input.status;
  }
}

export function isAaisApiRouteError(error: unknown): error is AaisApiRouteError {
  return error instanceof AaisApiRouteError;
}

export function createAaisApiErrorBody(
  code: string,
  message: string,
  extra: AaisApiErrorBodyExtra = {},
) {
  return {
    error: {
      code,
      message,
    },
    ...extra,
  };
}

export function createAaisApiErrorResponse(input: {
  code: string;
  message: string;
  status: number;
  extra?: AaisApiErrorBodyExtra;
  headers?: HeadersInit;
  cause?: unknown;
  route?: string;
}) {
  const cause = input.cause;
  if (cause) {
    recordAaisApiError({
      code: input.code,
      status: input.status,
      cause,
      route: input.route,
    });
  }
  return NextResponse.json(
    createAaisApiErrorBody(input.code, input.message, input.extra),
    {
      status: input.status,
      headers: input.headers,
    },
  );
}

function recordAaisApiError(input: {
  code: string;
  status: number;
  cause: unknown;
  route?: string;
}) {
  const cause = input.cause;
  console.error(JSON.stringify({
    type: "aais.api.error",
    event: "aais.api.error",
    code: input.code,
    status: input.status,
    route: input.route,
    causeName: cause instanceof Error ? cause.name : typeof cause,
    secrets: "redacted",
  }));
  recordAaisMonitoringIssue({
    event: "aais.api.error",
    message: `AAIS API error: ${input.code}`,
    status: input.status,
    route: input.route,
    tags: {
      "aais.error_code": input.code,
      "aais.cause_name": cause instanceof Error ? cause.name : typeof cause,
    },
    extra: {
      code: input.code,
      causeName: cause instanceof Error ? cause.name : typeof cause,
    },
  });
}
