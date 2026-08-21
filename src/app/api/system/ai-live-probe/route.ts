import { timingSafeEqual } from "node:crypto";
import { NextResponse } from "next/server";
import {
  isAaisAiLiveProbeSyntheticId,
  projectAaisAiLiveProbePublicReport,
  runAaisAiLiveProbe,
} from "@/lib/server/aais-ai-live-probe";
import { createAaisApiErrorResponse } from "@/lib/server/aais-api-error";
import { isAaisStrongOpaqueSecret } from "@/lib/server/aais-opaque-secret";
import {
  AaisRequestBodyError,
  readAaisBoundedJson,
} from "@/lib/server/aais-request-json";

export const dynamic = "force-dynamic";
export const revalidate = 0;
export const runtime = "nodejs";
export const maxDuration = 30;

const maxProbeRequestBytes = 256;

export async function POST(request: Request) {
  try {
    authorizeAaisAiLiveProbe(request);
    const body = await readAaisBoundedJson(request, { maxBytes: maxProbeRequestBytes });
    const syntheticId = readSyntheticId(body);
    const result = await runAaisAiLiveProbe(syntheticId, { signal: request.signal });
    return NextResponse.json(projectAaisAiLiveProbePublicReport(result.report), {
      status: result.httpStatus,
      headers: {
        "cache-control": "private, no-store",
      },
    });
  } catch (error) {
    return createAaisApiErrorResponse(getProbeErrorResponse(error));
  }
}

class AaisAiLiveProbeError extends Error {
  constructor(
    readonly code:
      | "AAIS_AI_LIVE_PROBE_AUTH_REQUIRED"
      | "AAIS_AI_LIVE_PROBE_FORBIDDEN"
      | "AAIS_AI_LIVE_PROBE_NOT_CONFIGURED"
      | "AAIS_AI_LIVE_PROBE_ID_INVALID",
    readonly status: 400 | 401 | 403 | 503,
  ) {
    super(code);
    this.name = "AaisAiLiveProbeError";
  }
}

function authorizeAaisAiLiveProbe(request: Request) {
  const configuredToken = process.env.AAIS_AI_LIVE_PROBE_BEARER_TOKEN?.trim();
  if (!isAaisStrongOpaqueSecret(configuredToken)) {
    throw new AaisAiLiveProbeError("AAIS_AI_LIVE_PROBE_NOT_CONFIGURED", 503);
  }
  const bearer = readBearerToken(request.headers.get("authorization"));
  if (!bearer) {
    throw new AaisAiLiveProbeError("AAIS_AI_LIVE_PROBE_AUTH_REQUIRED", 401);
  }
  if (!tokenMatches(bearer, configuredToken)) {
    throw new AaisAiLiveProbeError("AAIS_AI_LIVE_PROBE_FORBIDDEN", 403);
  }
}

function readSyntheticId(value: unknown) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new AaisAiLiveProbeError("AAIS_AI_LIVE_PROBE_ID_INVALID", 400);
  }
  const record = value as Record<string, unknown>;
  if (Object.keys(record).length !== 1
    || !Object.prototype.hasOwnProperty.call(record, "syntheticId")
    || !isAaisAiLiveProbeSyntheticId(record.syntheticId)) {
    throw new AaisAiLiveProbeError("AAIS_AI_LIVE_PROBE_ID_INVALID", 400);
  }
  return record.syntheticId;
}

function readBearerToken(value: string | null) {
  const match = /^Bearer\s+([^\s]+)$/i.exec(String(value ?? "").trim());
  return match?.[1] ?? "";
}

function tokenMatches(actual: string, expected: string) {
  const actualBuffer = Buffer.from(actual);
  const expectedBuffer = Buffer.from(expected);
  return actualBuffer.length === expectedBuffer.length
    && timingSafeEqual(actualBuffer, expectedBuffer);
}

function getProbeErrorResponse(error: unknown) {
  if (error instanceof AaisAiLiveProbeError) {
    return {
      code: error.code,
      message: error.code === "AAIS_AI_LIVE_PROBE_AUTH_REQUIRED"
        ? "AAIS AI live probe bearer authorization is required."
        : error.code === "AAIS_AI_LIVE_PROBE_FORBIDDEN"
          ? "AAIS AI live probe bearer authorization failed."
          : error.code === "AAIS_AI_LIVE_PROBE_NOT_CONFIGURED"
            ? "AAIS AI live probe is not configured."
            : "AAIS AI live probe syntheticId is invalid.",
      status: error.status,
      extra: { secrets: "redacted" as const },
      headers: { "cache-control": "private, no-store" },
    };
  }
  if (error instanceof AaisRequestBodyError) {
    return {
      code: error.reason === "too_large"
        ? "AAIS_AI_LIVE_PROBE_BODY_TOO_LARGE"
        : "AAIS_AI_LIVE_PROBE_BODY_INVALID",
      message: error.reason === "too_large"
        ? "AAIS AI live probe request body is too large."
        : "AAIS AI live probe request body is invalid.",
      status: error.status,
      extra: { secrets: "redacted" as const },
      headers: { "cache-control": "private, no-store" },
    };
  }
  return {
    code: "AAIS_AI_LIVE_PROBE_FAILED",
    message: "AAIS AI live probe failed.",
    status: 500,
    extra: { secrets: "redacted" as const },
    headers: { "cache-control": "private, no-store" },
  };
}
