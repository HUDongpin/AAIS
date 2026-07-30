import {
  createHash,
  createPublicKey,
  verify as verifySignature,
  type KeyObject,
} from "node:crypto";
import {
  AaisResearchConfigurationError,
  requireAaisResearchLrsNamespace,
} from "@/lib/server/aais-research-contract";

export const AAIS_RESEARCH_LRS_REQUEST_TIMEOUT_MS = 30_000;
export const AAIS_RESEARCH_LRS_ABSENCE_RECEIPT_SCHEMA =
  "https://www.aais.site/xapi/receipts/absence/v1";

export type AaisResearchLrsReceiptVerification = {
  keyId: string;
  publicKey: KeyObject;
};

export type AaisResearchLrsConfiguration = {
  endpoint: string;
  username: string;
  password: string;
  storeId: string;
  receiptVerification?: AaisResearchLrsReceiptVerification | null;
};

export type AaisResearchLrsAbsenceConfirmation = {
  confirmedAt: string;
  receiptKeyId: string;
  receiptSignature: string;
};

export type AaisResearchOutboxPayload = {
  eventId: string;
  participantId: string;
  studyRunId: string;
  visitId: string;
  projectId: "aais";
  studyId: string;
  environment: "production" | "staging" | "research";
  lrsNamespace: string;
  lrsStoreId: string;
  condition: string;
  schemaVersion: 1;
  appVersion: string;
  commitSha: string;
  eventSequence: number;
  clientTime: string;
  serverReceivedAt: string;
  eventName: string;
  outcome: "attempted" | "success" | "failure" | "retry" | "disconnected";
  retryCount: number;
  disconnectCount: number;
  aiLatencyMs: number | null;
  detail: Record<string, string | number | boolean | null>;
  lrsEligible: true;
};

type AaisResearchXapiStatement = {
  id: string;
  actor: {
    objectType: "Agent";
    account: { homePage: string; name: string };
  };
  verb: {
    id: string;
    display: { "en-US": string };
  };
  object: {
    objectType: "Activity";
    id: string;
    definition: {
      type: string;
      name: { "en-US": string };
    };
  };
  context: {
    registration: string;
    contextActivities: {
      grouping: Array<{ id: string }>;
      category: Array<{ id: string }>;
    };
    extensions: Record<string, unknown>;
  };
  result: {
    success?: boolean;
    completion: boolean;
    extensions: Record<string, unknown>;
  };
  timestamp: string;
};

export function getAaisResearchLrsConfiguration(
  env: Record<string, string | undefined> = process.env,
): AaisResearchLrsConfiguration {
  const endpoint = env.AAIS_RESEARCH_LRS_ENDPOINT?.trim();
  const username = env.AAIS_RESEARCH_LRS_USERNAME?.trim();
  const password = env.AAIS_RESEARCH_LRS_PASSWORD?.trim();
  const storeId = env.AAIS_RESEARCH_LRS_STORE_ID?.trim();
  if (!endpoint || !username || !password || !storeId) {
    throw new AaisResearchConfigurationError(
      "AAIS research LRS credentials are not configured.",
    );
  }
  let parsed: URL;
  try {
    parsed = new URL(endpoint);
  } catch {
    throw new AaisResearchConfigurationError("AAIS research LRS endpoint is invalid.");
  }
  if (parsed.protocol !== "https:" && parsed.hostname !== "localhost") {
    throw new AaisResearchConfigurationError("AAIS research LRS endpoint must use HTTPS.");
  }
  if (parsed.username || parsed.password || parsed.search || parsed.hash) {
    throw new AaisResearchConfigurationError(
      "AAIS research LRS endpoint must not embed credentials, query parameters, or fragments.",
    );
  }
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(storeId)) {
    throw new AaisResearchConfigurationError("AAIS research LRS store id is invalid.");
  }
  const receiptVerification = readReceiptVerificationConfiguration(env);
  assertDedicatedLrsCredentials({ endpoint, username, password, storeId }, env);
  return {
    endpoint: endpoint.replace(/\/+$/, ""),
    username,
    password,
    storeId,
    receiptVerification,
  };
}

export function getAaisResearchLrsConfigurationStatus(
  env: Record<string, string | undefined> = process.env,
) {
  const rehearsal = env.AAIS_RESEARCH_REHEARSAL_MODE?.trim().toLowerCase() === "true";
  const requiredEnv = [
    "AAIS_RESEARCH_LRS_ENDPOINT",
    "AAIS_RESEARCH_LRS_USERNAME",
    "AAIS_RESEARCH_LRS_PASSWORD",
    "AAIS_RESEARCH_LRS_STORE_ID",
    ...(rehearsal ? [] : [
      "AAIS_RESEARCH_LRS_RECEIPT_VERIFYING_KEY_ID",
      "AAIS_RESEARCH_LRS_RECEIPT_VERIFYING_KEY_SPKI",
    ]),
  ];
  let receiptVerification: AaisResearchLrsReceiptVerification | null = null;
  try {
    receiptVerification = readReceiptVerificationConfiguration(env, true);
  } catch {
    // Readiness reports booleans only and never exposes key material or parser details.
  }
  try {
    const configuration = getAaisResearchLrsConfiguration(env);
    return {
      configured: true,
      requiredEnv,
      isolatedFromGenericLrs: true,
      receiptVerificationConfigured: Boolean(configuration.receiptVerification),
      receiptVerifyingKeyIdConfigured: Boolean(configuration.receiptVerification?.keyId),
    };
  } catch {
    return {
      configured: false,
      requiredEnv,
      isolatedFromGenericLrs: true,
      receiptVerificationConfigured: Boolean(receiptVerification),
      receiptVerifyingKeyIdConfigured: Boolean(receiptVerification?.keyId),
    };
  }
}

/**
 * Byte-exact payload signed by the LRS provider for a physical-absence receipt.
 * The fixed property order and compact JSON encoding are part of the protocol.
 */
export function createAaisResearchLrsAbsenceReceiptEnvelope(input: {
  storeId: string;
  statementId: string;
  confirmedAt: string;
  receiptSha256: string;
  keyId: string;
}) {
  return Buffer.from(JSON.stringify({
    schema: AAIS_RESEARCH_LRS_ABSENCE_RECEIPT_SCHEMA,
    store_id: input.storeId,
    statement_id: input.statementId,
    confirmed_at: input.confirmedAt,
    receipt_sha256: input.receiptSha256,
    key_id: input.keyId,
  }), "utf8");
}

export function buildAaisResearchXapiStatement(
  payload: AaisResearchOutboxPayload,
): AaisResearchXapiStatement {
  const namespace = requireAaisResearchLrsNamespace(payload.lrsNamespace);
  const expectedNamespace = `https://www.aais.site/xapi/studies/${encodeURIComponent(payload.studyId)}/${payload.environment}/v1`;
  if (namespace !== expectedNamespace) {
    throw new AaisResearchConfigurationError(
      "AAIS research outbox namespace does not match its study scope.",
    );
  }
  const extension = (name: string) => `${namespace}/extensions/${name}`;
  const success = payload.outcome === "success"
    ? true
    : payload.outcome === "failure"
      ? false
      : undefined;
  return {
    id: payload.eventId,
    actor: {
      objectType: "Agent",
      account: {
        homePage: "https://www.aais.site",
        name: payload.participantId,
      },
    },
    verb: getOutcomeVerb(payload.outcome, namespace),
    object: {
      objectType: "Activity",
      id: `${namespace}/activities/${encodeURIComponent(payload.eventName)}`,
      definition: {
        type: `${namespace}/activities/research-ui-event`,
        name: { "en-US": `AAIS ${payload.eventName}` },
      },
    },
    context: {
      registration: payload.studyRunId,
      contextActivities: {
        grouping: [{ id: `${namespace}/studies/${encodeURIComponent(payload.studyId)}` }],
        category: [{ id: `${namespace}/schema/${payload.schemaVersion}` }],
      },
      extensions: {
        [extension("project-id")]: payload.projectId,
        [extension("study-id")]: payload.studyId,
        [extension("environment")]: payload.environment,
        [extension("lrs-namespace")]: namespace,
        [extension("lrs-store-id")]: payload.lrsStoreId,
        [extension("schema-version")]: payload.schemaVersion,
        [extension("app-version")]: payload.appVersion,
        [extension("commit-sha")]: payload.commitSha,
        [extension("participant-id")]: payload.participantId,
        [extension("study-run-id")]: payload.studyRunId,
        [extension("visit-id")]: payload.visitId,
        [extension("condition")]: payload.condition,
        [extension("event-id")]: payload.eventId,
        [extension("event-sequence")]: payload.eventSequence,
        [extension("event-name")]: payload.eventName,
        [extension("client-time")]: payload.clientTime,
        [extension("server-received-at")]: payload.serverReceivedAt,
        [extension("safe-detail")]: payload.detail,
      },
    },
    result: {
      ...(success === undefined ? {} : { success }),
      completion: payload.outcome === "success" || payload.outcome === "failure",
      extensions: {
        [extension("outcome")]: payload.outcome,
        [extension("retry-count")]: payload.retryCount,
        [extension("disconnect-count")]: payload.disconnectCount,
        ...(payload.aiLatencyMs === null
          ? {}
          : { [extension("ai-latency-ms")]: payload.aiLatencyMs }),
      },
    },
    timestamp: payload.clientTime,
  };
}

export async function sendAaisResearchStatement(input: {
  payload: AaisResearchOutboxPayload;
  configuration?: AaisResearchLrsConfiguration;
  env?: Record<string, string | undefined>;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}) {
  const configuration = input.configuration
    ?? getAaisResearchLrsConfiguration(input.env);
  if (configuration.storeId !== input.payload.lrsStoreId) {
    throw new AaisResearchConfigurationError(
      "AAIS research LRS store id does not match the queued event.",
    );
  }
  const statement = buildAaisResearchXapiStatement(input.payload);
  const response = await fetchAaisResearchLrs(
    input.fetchImpl ?? fetch,
    getStatementUrl(configuration.endpoint, statement.id),
    {
      method: "PUT",
      headers: createHeaders(configuration),
      body: JSON.stringify(statement),
    },
    normalizeRequestTimeout(input.timeoutMs),
  );
  return {
    ok: response.ok,
    httpStatus: response.status,
  };
}

export async function deleteAaisResearchStatement(input: {
  statementId: string;
  expectedStoreId: string;
  configuration?: AaisResearchLrsConfiguration;
  env?: Record<string, string | undefined>;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}) {
  const configuration = input.configuration
    ?? getAaisResearchLrsConfiguration(input.env);
  if (configuration.storeId !== input.expectedStoreId) {
    throw new AaisResearchConfigurationError(
      "AAIS research LRS store id does not match the deletion request.",
    );
  }
  const response = await fetchAaisResearchLrs(
    input.fetchImpl ?? fetch,
    getStatementUrl(configuration.endpoint, input.statementId),
    {
      method: "DELETE",
      headers: createHeaders(configuration),
    },
    normalizeRequestTimeout(input.timeoutMs),
  );
  const receipt = Buffer.from(await response.arrayBuffer());
  const receiptSha256 = createHash("sha256").update(receipt).digest("hex");
  return {
    ok: response.ok,
    httpStatus: response.status,
    receiptSha256,
    absenceConfirmation: readProviderAbsenceConfirmation({
      response,
      receiptSha256,
      statementId: input.statementId,
      configuration,
    }),
  };
}

function readProviderAbsenceConfirmation(input: {
  response: Response;
  receiptSha256: string;
  statementId: string;
  configuration: AaisResearchLrsConfiguration;
}): AaisResearchLrsAbsenceConfirmation | null {
  const { response, receiptSha256, statementId, configuration } = input;
  if ((!response.ok && response.status !== 404)
    || !configuration.receiptVerification
    || configuration.receiptVerification.publicKey.asymmetricKeyType !== "ed25519") {
    return null;
  }
  const confirmedAt = response.headers.get("x-aais-lrs-absence-confirmed-at")?.trim();
  const claimedReceiptSha256 = response.headers
    .get("x-aais-lrs-absence-receipt-sha256")
    ?.trim();
  const receiptKeyId = response.headers
    .get("x-aais-lrs-absence-receipt-key-id")
    ?.trim();
  const receiptSignature = response.headers
    .get("x-aais-lrs-absence-receipt-signature")
    ?.trim();
  if (!confirmedAt
    || !isExactIsoTimestamp(confirmedAt)
    || !claimedReceiptSha256
    || !/^[0-9a-f]{64}$/.test(claimedReceiptSha256)
    || claimedReceiptSha256 !== receiptSha256
    || receiptKeyId !== configuration.receiptVerification.keyId
    || !receiptSignature
    || !/^[A-Za-z0-9_-]{86}$/.test(receiptSignature)) {
    return null;
  }
  let signature: Buffer;
  try {
    signature = Buffer.from(receiptSignature, "base64url");
  } catch {
    return null;
  }
  if (signature.length !== 64 || signature.toString("base64url") !== receiptSignature) {
    return null;
  }
  const envelope = createAaisResearchLrsAbsenceReceiptEnvelope({
    storeId: configuration.storeId,
    statementId,
    confirmedAt,
    receiptSha256,
    keyId: receiptKeyId,
  });
  try {
    if (!verifySignature(
      null,
      envelope,
      configuration.receiptVerification.publicKey,
      signature,
    )) {
      return null;
    }
  } catch {
    return null;
  }
  return { confirmedAt, receiptKeyId, receiptSignature };
}

function isExactIsoTimestamp(value: string) {
  const parsed = new Date(value);
  return Number.isFinite(parsed.getTime()) && parsed.toISOString() === value;
}

async function fetchAaisResearchLrs(
  fetchImpl: typeof fetch,
  url: string,
  init: RequestInit,
  timeoutMs: number,
) {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetchImpl(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timeoutId);
  }
}

function normalizeRequestTimeout(value: number | undefined) {
  if (value === undefined) {
    return AAIS_RESEARCH_LRS_REQUEST_TIMEOUT_MS;
  }
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new AaisResearchConfigurationError("AAIS research LRS timeout is invalid.");
  }
  return Math.min(value, AAIS_RESEARCH_LRS_REQUEST_TIMEOUT_MS);
}

function readReceiptVerificationConfiguration(
  env: Record<string, string | undefined>,
  allowMissing = false,
): AaisResearchLrsReceiptVerification | null {
  const keyId = env.AAIS_RESEARCH_LRS_RECEIPT_VERIFYING_KEY_ID?.trim() ?? "";
  const encodedSpki = env.AAIS_RESEARCH_LRS_RECEIPT_VERIFYING_KEY_SPKI?.trim() ?? "";
  const rehearsal = env.AAIS_RESEARCH_REHEARSAL_MODE?.trim().toLowerCase() === "true";
  if (!keyId && !encodedSpki) {
    if (rehearsal || allowMissing) {
      return null;
    }
    throw new AaisResearchConfigurationError(
      "AAIS research LRS receipt verification key is not configured.",
    );
  }
  if (!keyId || !encodedSpki) {
    throw new AaisResearchConfigurationError(
      "AAIS research LRS receipt verification key configuration is incomplete.",
    );
  }
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(keyId)) {
    throw new AaisResearchConfigurationError(
      "AAIS research LRS receipt verification key id is invalid.",
    );
  }
  if (encodedSpki.length > 4096
    || encodedSpki.length % 4 !== 0
    || !/^[A-Za-z0-9+/]+={0,2}$/.test(encodedSpki)) {
    throw new AaisResearchConfigurationError(
      "AAIS research LRS receipt verification SPKI is invalid.",
    );
  }
  const spki = Buffer.from(encodedSpki, "base64");
  if (spki.length === 0 || spki.toString("base64") !== encodedSpki) {
    throw new AaisResearchConfigurationError(
      "AAIS research LRS receipt verification SPKI is invalid.",
    );
  }
  let publicKey: KeyObject;
  try {
    publicKey = createPublicKey({ key: spki, format: "der", type: "spki" });
  } catch {
    throw new AaisResearchConfigurationError(
      "AAIS research LRS receipt verification SPKI is invalid.",
    );
  }
  const canonicalSpki = publicKey.export({ format: "der", type: "spki" });
  if (publicKey.asymmetricKeyType !== "ed25519"
    || !Buffer.isBuffer(canonicalSpki)
    || !canonicalSpki.equals(spki)) {
    throw new AaisResearchConfigurationError(
      "AAIS research LRS receipt verification key must be a canonical Ed25519 SPKI.",
    );
  }
  return { keyId, publicKey };
}

function assertDedicatedLrsCredentials(
  research: { endpoint: string; username: string; password: string; storeId: string },
  env: Record<string, string | undefined>,
) {
  for (const prefix of [
    "LRS",
    "AAIS_LRS",
    "AAIS_PRODUCTION_LRS",
    "AAIS_STAGING_LRS",
    "AAIS_LEGACY_LRS",
    "MAIS_LRS",
  ]) {
    const username = env[`${prefix}_USERNAME`]?.trim();
    const password = env[`${prefix}_PASSWORD`]?.trim();
    const storeId = env[`${prefix}_STORE_ID`]?.trim();
    if (
      (username && username === research.username)
      || (password && password === research.password)
      || (storeId && storeId === research.storeId)
    ) {
      throw new AaisResearchConfigurationError(
        "AAIS research LRS credentials must be isolated from generic, legacy, and MAIS stores.",
      );
    }
  }
}

function getOutcomeVerb(
  outcome: AaisResearchOutboxPayload["outcome"],
  namespace: string,
) {
  const values = {
    attempted: {
      id: "http://adlnet.gov/expapi/verbs/attempted",
      display: { "en-US": "attempted" as const },
    },
    success: {
      id: "http://adlnet.gov/expapi/verbs/completed",
      display: { "en-US": "completed" as const },
    },
    failure: {
      id: "http://adlnet.gov/expapi/verbs/failed",
      display: { "en-US": "failed" as const },
    },
    retry: {
      id: `${namespace}/verbs/retried`,
      display: { "en-US": "retried" as const },
    },
    disconnected: {
      id: `${namespace}/verbs/disconnected`,
      display: { "en-US": "disconnected" as const },
    },
  };
  return values[outcome];
}

function createHeaders(configuration: AaisResearchLrsConfiguration) {
  return {
    authorization: `Basic ${Buffer.from(`${configuration.username}:${configuration.password}`).toString("base64")}`,
    "content-type": "application/json",
    "x-experience-api-version": "1.0.3",
  };
}

function getStatementUrl(endpoint: string, statementId: string) {
  const base = endpoint.endsWith("/statements") ? endpoint : `${endpoint}/statements`;
  const url = new URL(base);
  url.searchParams.set("statementId", statementId);
  return url.toString();
}
