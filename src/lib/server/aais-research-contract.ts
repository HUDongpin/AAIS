import {
  createCipheriv,
  createDecipheriv,
  createHmac,
  randomBytes,
  randomUUID,
} from "node:crypto";
import type { AaisSessionActor } from "@/lib/server/aais-session";

export const AAIS_RESEARCH_PROJECT_ID = "aais" as const;
export const AAIS_RESEARCH_SCHEMA_VERSION = 1 as const;
export const AAIS_RESEARCH_MAX_PARTICIPANTS = 30 as const;
export const AAIS_RESEARCH_DEFAULT_LRS_NAMESPACE =
  "https://www.aais.site/xapi/studies/aais-ca-pilot/research/v1";

export const aaisResearchEventNames = [
  "workspace_session_load",
  "client_connectivity",
  "account_menu_toggled",
  "learner_data_export",
  "learner_data_delete",
  "account_logout",
  "content_tab_selected",
  "content_item_opened",
  "content_item_back",
  "history_document_opened",
  "panel_resize_completed",
  "guide_quick_start_selected",
  "guide_attachment_picker_opened",
  "guide_attachment_add",
  "guide_attachment_removed",
  "ai_guide_submit",
  "guide_response_link_opened",
  "document_artifact_save",
  "document_title_committed",
  "editor_format_applied",
  "document_save_closed",
  "document_download",
] as const;

export type AaisResearchEventName = (typeof aaisResearchEventNames)[number];

export const aaisResearchDetailKeys = [
  "operation_id",
  "task_id",
  "trigger",
  "tab_id",
  "content_id",
  "document_id",
  "format_id",
  "value_id",
  "quick_start_id",
  "input_mode",
  "prompt_length",
  "attachment_count",
  "file_count",
  "mime_type",
  "size_bytes",
  "total_size_bytes",
  "error_kind",
  "attempt_number",
  "retry_reason",
  "fallback",
  "agent_count",
  "title_length",
  "artifact_length",
  "previous_characters",
  "current_characters",
  "delta_characters",
  "width_px",
  "delta_px",
  "input_method",
  "download_method",
  "confirmed",
  "pending_save",
  "source",
  "http_status",
  "link_protocol",
  "link_host",
  "target_agent_count",
  "has_attachments",
] as const;

export type AaisResearchDetailKey = (typeof aaisResearchDetailKeys)[number];
export type AaisResearchEnvironment = "production" | "staging" | "research";
export type AaisResearchOutcome =
  | "attempted"
  | "success"
  | "failure"
  | "retry"
  | "disconnected";
export type AaisResearchDetailValue = string | number | boolean | null;
export type AaisResearchDetail = Partial<
  Record<AaisResearchDetailKey, AaisResearchDetailValue>
>;

export type AaisResearchConfiguration = {
  enabled: true;
  projectId: typeof AAIS_RESEARCH_PROJECT_ID;
  studyId: string;
  environment: AaisResearchEnvironment;
  lrsNamespace: string;
  lrsStoreId: string;
  appVersion: string;
  commitSha: string;
  conditions: string[];
  databaseUrl: string;
  databaseInstanceId: string;
  databaseDriver: "pg" | "neon-serverless";
  rehearsalMode: boolean;
  participantActorIds: string[];
  identityEncryptionKey: Buffer;
  identityFingerprintKey: Buffer;
  identityKeyVersion: string;
  identityRetentionDays: number;
  rawTextRetentionDays: number;
  factRetentionDays: number;
  backupRetentionDays: number;
};

export type AaisResearchEventInput = {
  clientEventId: string;
  clientTime: string;
  expectedVisitId: string;
  eventName: AaisResearchEventName;
  outcome: AaisResearchOutcome;
  aiLatencyMs: number | null;
  detail: AaisResearchDetail;
  retryCount: number;
  disconnectCount: number;
};

export class AaisResearchDisabledError extends Error {
  constructor() {
    super("AAIS research data collection is disabled.");
    this.name = "AaisResearchDisabledError";
  }
}

export class AaisResearchConfigurationError extends Error {
  constructor(message = "AAIS research configuration is incomplete or invalid.") {
    super(message);
    this.name = "AaisResearchConfigurationError";
  }
}

export class AaisResearchValidationError extends Error {
  constructor(message = "AAIS research event is invalid.") {
    super(message);
    this.name = "AaisResearchValidationError";
  }
}

export function isAaisResearchModeEnabled(
  env: Record<string, string | undefined> = process.env,
) {
  const value = env.AAIS_RESEARCH_MODE?.trim().toLowerCase();
  return value === "true";
}

/**
 * The dedicated study deployment must never fall back to the legacy product
 * event/LRS pipeline. The REQUIRED sentinel therefore keeps that isolation
 * active even when the collection switch is accidentally missing or false.
 */
export function requiresAaisResearchDataPlaneIsolation(
  env: Record<string, string | undefined> = process.env,
) {
  return isAaisResearchModeEnabled(env)
    || env.AAIS_RESEARCH_REQUIRED?.trim().toLowerCase() === "true";
}

export function assertAaisResearchModeEnabled(
  env: Record<string, string | undefined> = process.env,
) {
  if (!isAaisResearchModeEnabled(env)) {
    throw new AaisResearchDisabledError();
  }
}

export function getAaisResearchConfiguration(
  env: Record<string, string | undefined> = process.env,
): AaisResearchConfiguration {
  assertAaisResearchModeEnabled(env);

  const projectId = env.AAIS_RESEARCH_PROJECT_ID?.trim() || AAIS_RESEARCH_PROJECT_ID;
  if (projectId !== AAIS_RESEARCH_PROJECT_ID) {
    throw new AaisResearchConfigurationError("AAIS research project id must be aais.");
  }
  const studyId = requireAsciiToken(env.AAIS_RESEARCH_STUDY_ID, "study id", 128);
  const environment = requireEnvironment(env.AAIS_RESEARCH_ENVIRONMENT);
  const expectedLrsNamespace =
    `https://www.aais.site/xapi/studies/${encodeURIComponent(studyId)}/${environment}/v1`;
  const lrsNamespace = requireAaisResearchLrsNamespace(
    env.AAIS_RESEARCH_LRS_NAMESPACE?.trim() || expectedLrsNamespace,
  );
  if (lrsNamespace !== expectedLrsNamespace) {
    throw new AaisResearchConfigurationError(
      "AAIS research LRS namespace does not match the configured study scope.",
    );
  }
  const lrsStoreId = requireAsciiToken(
    env.AAIS_RESEARCH_LRS_STORE_ID,
    "LRS store id",
    128,
  );
  const appVersion = requireAsciiToken(env.AAIS_APP_VERSION, "app version", 64);
  const commitSha = requireCommitSha(
    env.VERCEL_GIT_COMMIT_SHA?.trim() || env.AAIS_COMMIT_SHA?.trim(),
  );
  const conditions = requireConditions(env.AAIS_RESEARCH_CONDITIONS);
  const databaseUrl = requireDatabaseUrl(env.AAIS_RESEARCH_DATABASE_URL);
  assertDedicatedDatabaseTarget(databaseUrl, env);
  const databaseInstanceId = requireAsciiToken(
    env.AAIS_RESEARCH_DATABASE_INSTANCE_ID,
    "database instance id",
    128,
  );
  assertDedicatedDatabaseInstanceId(databaseInstanceId, env);
  const rehearsalMode = env.AAIS_RESEARCH_REHEARSAL_MODE?.trim().toLowerCase() === "true";
  if (
    rehearsalMode
    && (
      environment !== "research"
      || env.AAIS_RESEARCH_REHEARSAL_APPROVED?.trim().toLowerCase() !== "true"
    )
  ) {
    throw new AaisResearchConfigurationError(
      "AAIS research rehearsal mode requires the approved research environment.",
    );
  }
  const participantActorIds = requireParticipantActorIds(
    env.AAIS_RESEARCH_PARTICIPANT_ACTOR_IDS,
    rehearsalMode,
  );
  const identityEncryptionKey = requireBase64Key(
    env.AAIS_RESEARCH_IDENTITY_ENCRYPTION_KEY,
    "identity encryption key",
  );
  const identityFingerprintKey = requireBase64Key(
    env.AAIS_RESEARCH_IDENTITY_FINGERPRINT_KEY,
    "identity fingerprint key",
  );
  if (identityEncryptionKey.equals(identityFingerprintKey)) {
    throw new AaisResearchConfigurationError(
      "AAIS research identity encryption and fingerprint keys must be different.",
    );
  }
  const identityKeyVersion = requireAsciiToken(
    env.AAIS_RESEARCH_IDENTITY_KEY_VERSION?.trim() || "v1",
    "identity key version",
    64,
  );

  return {
    enabled: true,
    projectId,
    studyId,
    environment,
    lrsNamespace,
    lrsStoreId,
    appVersion,
    commitSha,
    conditions,
    databaseUrl,
    databaseInstanceId,
    databaseDriver: selectDatabaseDriver(databaseUrl, env.AAIS_RESEARCH_DATABASE_DRIVER),
    rehearsalMode,
    participantActorIds,
    identityEncryptionKey,
    identityFingerprintKey,
    identityKeyVersion,
    identityRetentionDays: readRetentionDays(
      env.AAIS_RESEARCH_IDENTITY_RETENTION_DAYS,
      90,
      90,
    ),
    rawTextRetentionDays: readRetentionDays(
      env.AAIS_RESEARCH_RAW_TEXT_RETENTION_DAYS,
      180,
      180,
    ),
    factRetentionDays: readRetentionDays(
      env.AAIS_RESEARCH_EVENT_RETENTION_DAYS,
      1825,
      1825,
    ),
    backupRetentionDays: readRetentionDays(
      env.AAIS_RESEARCH_BACKUP_RETENTION_DAYS,
      35,
      35,
    ),
  };
}

export function requireAaisResearchLrsNamespace(value: string) {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new AaisResearchConfigurationError("AAIS research LRS namespace is invalid.");
  }
  const canonicalPrefix = "https://www.aais.site/xapi/";
  if (
    parsed.protocol !== "https:"
    || parsed.hostname !== "www.aais.site"
    || parsed.username
    || parsed.password
    || parsed.search
    || parsed.hash
    || !value.startsWith(canonicalPrefix)
  ) {
    throw new AaisResearchConfigurationError(
      "AAIS research LRS namespace must use the AAIS research xAPI prefix.",
    );
  }
  return value.replace(/\/+$/, "");
}

export function parseAaisResearchEventInput(
  value: unknown,
  createId: () => string = randomUUID,
): AaisResearchEventInput {
  if (!isPlainRecord(value)) {
    throw new AaisResearchValidationError();
  }
  rejectUnknownKeys(value, [
    "clientEventId",
    "clientTime",
    "expectedVisitId",
    "eventName",
    "outcome",
    "aiLatencyMs",
    "detail",
  ]);

  const clientEventId = value.clientEventId === undefined
    ? createId()
    : requireUuid(value.clientEventId, "client event id");
  const clientTime = requireIsoDate(value.clientTime, "client time");
  const expectedVisitId = requireUuid(value.expectedVisitId, "expected visit id");
  if (!aaisResearchEventNames.includes(value.eventName as AaisResearchEventName)) {
    throw new AaisResearchValidationError("AAIS research event name is invalid.");
  }
  if (!isAaisResearchOutcome(value.outcome)) {
    throw new AaisResearchValidationError("AAIS research event outcome is invalid.");
  }
  const detail = parseAaisResearchDetail(value.detail ?? {});
  const aiLatencyMs = readOptionalNonnegativeInteger(value.aiLatencyMs, "AI latency");
  if (value.eventName !== "ai_guide_submit" && aiLatencyMs !== null) {
    throw new AaisResearchValidationError(
      "AAIS research AI latency is valid only for AI guide events.",
    );
  }
  const attemptNumber = typeof detail.attempt_number === "number"
    ? detail.attempt_number
    : 1;

  return {
    clientEventId,
    clientTime,
    expectedVisitId,
    eventName: value.eventName as AaisResearchEventName,
    outcome: value.outcome,
    aiLatencyMs,
    detail,
    retryCount: Math.max(attemptNumber - 1, value.outcome === "retry" ? 1 : 0),
    disconnectCount: value.outcome === "disconnected"
      || isDisconnectErrorKind(detail.error_kind)
      ? 1
      : 0,
  };
}

export function parseAaisResearchDetail(value: unknown): AaisResearchDetail {
  if (!isPlainRecord(value)) {
    throw new AaisResearchValidationError("AAIS research event detail is invalid.");
  }
  const allowed = new Set<string>(aaisResearchDetailKeys);
  const result: AaisResearchDetail = {};
  for (const [key, item] of Object.entries(value)) {
    if (!allowed.has(key)) {
      throw new AaisResearchValidationError(
        "AAIS research event detail contains an unsupported field.",
      );
    }
    if (!isSafePrimitive(item)) {
      throw new AaisResearchValidationError(
        "AAIS research event detail contains unsafe text or structure.",
      );
    }
    validateTypedDetailValue(key as AaisResearchDetailKey, item);
    result[key as AaisResearchDetailKey] = item;
  }
  return result;
}

export type AaisEncryptedResearchIdentity = {
  fingerprint: string;
  ciphertext: Buffer;
  iv: Buffer;
  authenticationTag: Buffer;
  keyVersion: string;
};

export function encryptAaisResearchIdentity(input: {
  actor: Pick<AaisSessionActor, "id" | "displayName">;
  configuration: Pick<
    AaisResearchConfiguration,
    | "identityEncryptionKey"
    | "identityFingerprintKey"
    | "identityKeyVersion"
    | "projectId"
    | "studyId"
    | "environment"
    | "lrsNamespace"
  >;
  randomBytesImpl?: (size: number) => Buffer;
}): AaisEncryptedResearchIdentity {
  const iv = (input.randomBytesImpl ?? randomBytes)(12);
  const aad = createIdentityAad(input.configuration);
  const cipher = createCipheriv("aes-256-gcm", input.configuration.identityEncryptionKey, iv);
  cipher.setAAD(aad);
  const plaintext = Buffer.from(JSON.stringify({
    actorId: input.actor.id,
    displayName: input.actor.displayName,
  }), "utf8");
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  return {
    fingerprint: createAaisResearchActorFingerprint(
      input.actor.id,
      input.configuration.identityFingerprintKey,
    ),
    ciphertext,
    iv,
    authenticationTag: cipher.getAuthTag(),
    keyVersion: input.configuration.identityKeyVersion,
  };
}

export function decryptAaisResearchIdentity(input: {
  ciphertext: Buffer;
  iv: Buffer;
  authenticationTag: Buffer;
  configuration: Pick<
    AaisResearchConfiguration,
    "identityEncryptionKey" | "projectId" | "studyId" | "environment" | "lrsNamespace"
  >;
}) {
  const decipher = createDecipheriv(
    "aes-256-gcm",
    input.configuration.identityEncryptionKey,
    input.iv,
  );
  decipher.setAAD(createIdentityAad(input.configuration));
  decipher.setAuthTag(input.authenticationTag);
  const plaintext = Buffer.concat([
    decipher.update(input.ciphertext),
    decipher.final(),
  ]).toString("utf8");
  const parsed = JSON.parse(plaintext) as unknown;
  if (
    !isPlainRecord(parsed)
    || typeof parsed.actorId !== "string"
    || typeof parsed.displayName !== "string"
  ) {
    throw new AaisResearchValidationError("AAIS research identity payload is invalid.");
  }
  return { actorId: parsed.actorId, displayName: parsed.displayName };
}

export function createAaisResearchActorFingerprint(actorId: string, key: Buffer) {
  return createHmac("sha256", key)
    .update(`aais-research-identity-fingerprint:v1:${actorId}`)
    .digest("hex");
}

export function requireUuid(value: unknown, label = "identifier") {
  if (
    typeof value !== "string"
    || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)
  ) {
    throw new AaisResearchValidationError(`AAIS research ${label} is invalid.`);
  }
  return value.toLowerCase();
}

function createIdentityAad(
  configuration: Pick<
    AaisResearchConfiguration,
    "projectId" | "studyId" | "environment" | "lrsNamespace"
  >,
) {
  return Buffer.from([
    "aais-research-identity:v1",
    configuration.projectId,
    configuration.studyId,
    configuration.environment,
    configuration.lrsNamespace,
  ].join("\u0000"), "utf8");
}

function requireEnvironment(value: string | undefined): AaisResearchEnvironment {
  if (value === "research") {
    return value;
  }
  throw new AaisResearchConfigurationError(
    "AAIS experimental collection must run in the isolated research environment.",
  );
}

function requireCommitSha(value: string | undefined) {
  if (!value || !/^[0-9a-f]{7,64}$/i.test(value)) {
    throw new AaisResearchConfigurationError("AAIS research commit SHA is required.");
  }
  return value.toLowerCase();
}

function requireConditions(value: string | undefined) {
  const conditions = (value?.trim() || "control,treatment")
    .split(",")
    .map((condition) => condition.trim())
    .filter(Boolean);
  if (
    conditions.length < 1
    || conditions.length > 16
    || new Set(conditions).size !== conditions.length
    || conditions.some((condition) => !/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(condition))
  ) {
    throw new AaisResearchConfigurationError("AAIS research conditions are invalid.");
  }
  return conditions;
}

function requireDatabaseUrl(value: string | undefined) {
  if (!value?.trim()) {
    throw new AaisResearchConfigurationError(
      "AAIS_RESEARCH_DATABASE_URL is required for research mode.",
    );
  }
  try {
    const parsed = new URL(value);
    if (parsed.protocol !== "postgres:" && parsed.protocol !== "postgresql:") {
      throw new Error("invalid protocol");
    }
  } catch {
    throw new AaisResearchConfigurationError("AAIS research database URL is invalid.");
  }
  return value;
}

function requireBase64Key(value: string | undefined, label: string) {
  if (!value?.trim()) {
    throw new AaisResearchConfigurationError(
      `AAIS research ${label} is required.`,
    );
  }
  const key = Buffer.from(value.trim(), "base64");
  if (key.length !== 32 || key.toString("base64").replace(/=+$/, "") !== value.trim().replace(/=+$/, "")) {
    throw new AaisResearchConfigurationError(
      `AAIS research ${label} must be 32-byte base64.`,
    );
  }
  return key;
}

function requireParticipantActorIds(value: string | undefined, rehearsalMode: boolean) {
  const ids = (value ?? "")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
  if (
    (rehearsalMode
      ? ids.length < 3 || ids.length > 5
      : ids.length !== AAIS_RESEARCH_MAX_PARTICIPANTS)
    || new Set(ids).size !== ids.length
    || ids.some((id) => !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(id))
  ) {
    throw new AaisResearchConfigurationError(
      "AAIS research participant roster is missing or invalid.",
    );
  }
  return ids;
}

function assertDedicatedDatabaseTarget(
  researchUrl: string,
  env: Record<string, string | undefined>,
) {
  const researchTarget = normalizeDatabaseTarget(researchUrl);
  const productNames = [
    "AAIS_DATABASE_URL",
    "DATABASE_URL",
    "POSTGRES_URL",
    "POSTGRES_PRISMA_URL",
    "POSTGRES_URL_NO_SSL",
    "DATABASE_URL_UNPOOLED",
    "POSTGRES_URL_NON_POOLING",
    "AAIS_PRODUCTION_DATABASE_URL",
    "AAIS_STAGING_DATABASE_URL",
    "MAIS_DATABASE_URL",
  ];
  const configuredTargets = productNames.flatMap((name) => {
    const value = env[name]?.trim();
    const target = value ? normalizeDatabaseTarget(value) : "";
    return target ? [target] : [];
  });
  for (const rawTarget of [
    normalizeRawDatabaseTarget({
      host: env.PGHOST?.trim() || env.PGHOST_UNPOOLED?.trim(),
      database: env.PGDATABASE?.trim(),
      port: env.PGPORT?.trim(),
    }),
    normalizeRawDatabaseTarget({
      host: env.POSTGRES_HOST?.trim() || env.POSTGRES_HOST_NON_POOLING?.trim(),
      database: env.POSTGRES_DATABASE?.trim(),
      port: env.POSTGRES_PORT?.trim(),
    }),
  ]) {
    if (rawTarget) {
      configuredTargets.push(rawTarget);
    }
  }
  if (configuredTargets.includes(researchTarget)) {
    throw new AaisResearchConfigurationError(
      "AAIS research Postgres target must be separate from the product database.",
    );
  }
}

function assertDedicatedDatabaseInstanceId(
  researchInstanceId: string,
  env: Record<string, string | undefined>,
) {
  const shared = [
    "AAIS_DATABASE_INSTANCE_ID",
    "AAIS_PRODUCTION_DATABASE_INSTANCE_ID",
    "AAIS_STAGING_DATABASE_INSTANCE_ID",
    "MAIS_DATABASE_INSTANCE_ID",
  ].some((name) => env[name]?.trim() === researchInstanceId);
  if (shared) {
    throw new AaisResearchConfigurationError(
      "AAIS research Postgres instance id must be separate from product, staging, and MAIS.",
    );
  }
}

function normalizeDatabaseTarget(value: string) {
  try {
    const parsed = new URL(value);
    if (parsed.protocol !== "postgres:" && parsed.protocol !== "postgresql:") {
      return "";
    }
    const host = parsed.hostname.toLowerCase().replace(/^\[|\]$/g, "");
    return `${host}:${parsed.port || "5432"}${parsed.pathname}`;
  } catch {
    return "";
  }
}

function normalizeRawDatabaseTarget(input: {
  host: string | undefined;
  database: string | undefined;
  port: string | undefined;
}) {
  if (!input.host || !input.database) {
    return "";
  }
  const host = input.host.toLowerCase().replace(/^\[|\]$/g, "");
  const database = input.database.replace(/^\/+/, "");
  if (!host || !database || (input.port && !/^\d{1,5}$/.test(input.port))) {
    return "";
  }
  return `${host}:${input.port || "5432"}/${database}`;
}

function requireAsciiToken(value: string | undefined, label: string, maxLength: number) {
  const normalized = value?.trim();
  if (
    !normalized
    || normalized.length > maxLength
    || !/^[A-Za-z0-9][A-Za-z0-9._:-]*$/.test(normalized)
  ) {
    throw new AaisResearchConfigurationError(`AAIS research ${label} is invalid.`);
  }
  return normalized;
}

function selectDatabaseDriver(
  url: string,
  configured: string | undefined,
): "pg" | "neon-serverless" {
  const value = configured?.trim().toLowerCase();
  if (value === "pg" || value === "neon-serverless") {
    return value;
  }
  return new URL(url).hostname.toLowerCase().endsWith(".neon.tech")
    ? "neon-serverless"
    : "pg";
}

function readRetentionDays(value: string | undefined, fallback: number, maximum: number) {
  if (!value?.trim()) {
    return fallback;
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1 || parsed > maximum) {
    throw new AaisResearchConfigurationError("AAIS research retention period is invalid.");
  }
  return parsed;
}

function rejectUnknownKeys(value: Record<string, unknown>, allowed: string[]) {
  const allowedSet = new Set(allowed);
  if (Object.keys(value).some((key) => !allowedSet.has(key))) {
    throw new AaisResearchValidationError(
      "AAIS research event contains an unsupported field.",
    );
  }
}

function requireIsoDate(value: unknown, label: string) {
  if (typeof value !== "string") {
    throw new AaisResearchValidationError(`AAIS research ${label} is invalid.`);
  }
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) {
    throw new AaisResearchValidationError(`AAIS research ${label} is invalid.`);
  }
  return new Date(timestamp).toISOString();
}

function isAaisResearchOutcome(value: unknown): value is AaisResearchOutcome {
  return value === "attempted"
    || value === "success"
    || value === "failure"
    || value === "retry"
    || value === "disconnected";
}

function isDisconnectErrorKind(value: AaisResearchDetailValue | undefined) {
  return value === "offline" || value === "network" || value === "stream_disconnected";
}

function isSafePrimitive(value: unknown): value is AaisResearchDetailValue {
  if (value === null || typeof value === "boolean") {
    return true;
  }
  if (typeof value === "number") {
    return Number.isFinite(value) && Number.isSafeInteger(value);
  }
  return typeof value === "string" && value.length <= 128 && /^[\x20-\x7e]*$/.test(value);
}

const numericDetailKeys = new Set<AaisResearchDetailKey>([
  "prompt_length",
  "attachment_count",
  "file_count",
  "size_bytes",
  "total_size_bytes",
  "attempt_number",
  "agent_count",
  "title_length",
  "artifact_length",
  "previous_characters",
  "current_characters",
  "delta_characters",
  "width_px",
  "delta_px",
  "http_status",
  "target_agent_count",
]);

const booleanDetailKeys = new Set<AaisResearchDetailKey>([
  "fallback",
  "confirmed",
  "pending_save",
  "has_attachments",
]);

const controlledStringDetailValues: Partial<
  Record<AaisResearchDetailKey, ReadonlySet<string>>
> = {
  task_id: new Set([
    "training_task_1",
    "practice_task_1",
    "practice_task_2",
    "practice_task_3",
  ]),
  trigger: new Set([
    "manual",
    "debounce",
    "save_close",
    "download",
    "blur",
    "page_mount",
    "browser_online",
    "browser_offline",
    "upload_button",
    "pointer_start",
    "pointer_cancel",
    "pointer_end",
    "arrowleft",
    "arrowright",
    "home",
    "end",
    "server_session_revoke",
  ]),
  tab_id: new Set(["display", "editor"]),
  content_id: new Set(["platform", "theory", "history"]),
  format_id: new Set([
    "heading",
    "list",
    "font_family",
    "font_size",
    "bold",
    "italic",
    "underline",
    "align_left",
    "align_center",
    "align_right",
  ]),
  value_id: new Set([
    "open",
    "closed",
    "h1",
    "h2",
    "h3",
    "unordered",
    "ordered",
    "system",
    "serif",
    "mono",
    "17",
    "20",
    "24",
    "28",
    "bold",
    "italic",
    "underline",
    "justifyLeft",
    "justifyCenter",
    "justifyRight",
  ]),
  quick_start_id: new Set([
    "clarify_goal",
    "expert_model",
    "request_scaffold",
    "organize_reflection",
  ]),
  input_mode: new Set(["typed", "quick_start", "attachment_only"]),
  mime_type: new Set([
    "text/plain",
    "text/markdown",
    "text/csv",
    "application/pdf",
  ]),
  error_kind: new Set([
    "offline",
    "timeout",
    "stream_disconnected",
    "network",
    "request_failed",
    "user_cancelled",
    "session_revoke_failed",
    "attachment_validation",
    "validation",
    "file_count_limit",
    "file_read_failed",
  ]),
  retry_reason: new Set(["stream_protocol_fallback"]),
  source: new Set(["ai_response"]),
  input_method: new Set(["pointer", "keyboard"]),
  download_method: new Set(["file_picker", "browser_download"]),
  link_protocol: new Set(["https:", "http:", "mailto:"]),
  // Hostnames are never stored. The UI derives one of these categories.
  link_host: new Set(["aais_site", "external"]),
};

const controlledStringDetailPatterns: Partial<Record<AaisResearchDetailKey, RegExp>> = {
  operation_id:
    /^(?:account-logout|account-menu|ai-guide|artifact-save|attachment-add|attachment-picker|attachment-remove|connectivity|content-back|content-item|content-tab|document-download|document-save-close|document-title|editor-format|guide-link|history-document|learner-delete|learner-export|panel-resize|quick-start|session-load)-[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
  document_id: /^(?:training_task_1|practice_task_[1-3])-[0-9]{13}$/,
};

function validateTypedDetailValue(key: AaisResearchDetailKey, value: AaisResearchDetailValue) {
  if (value === null) {
    return;
  }
  if (numericDetailKeys.has(key)) {
    const negativeAllowed = key === "delta_characters" || key === "delta_px";
    if (
      typeof value !== "number"
      || (!negativeAllowed && value < 0)
      || (key === "attempt_number" && value < 1)
    ) {
      throw new AaisResearchValidationError("AAIS research numeric detail is invalid.");
    }
    return;
  }
  if (booleanDetailKeys.has(key)) {
    if (typeof value !== "boolean") {
      throw new AaisResearchValidationError("AAIS research boolean detail is invalid.");
    }
    return;
  }
  if (typeof value !== "string") {
    throw new AaisResearchValidationError("AAIS research token detail is invalid.");
  }
  if (!/^[A-Za-z0-9][A-Za-z0-9._:/+\-]{0,127}$/.test(value)) {
    throw new AaisResearchValidationError(
      "AAIS research token detail must be a controlled metadata token.",
    );
  }
  const allowedValues = controlledStringDetailValues[key];
  const allowedPattern = controlledStringDetailPatterns[key];
  if (
    (allowedValues && !allowedValues.has(value))
    || (allowedPattern && !allowedPattern.test(value))
    || (!allowedValues && !allowedPattern)
  ) {
    throw new AaisResearchValidationError(
      "AAIS research token detail is not an approved controlled metadata value.",
    );
  }
}

function readOptionalNonnegativeInteger(value: unknown, label: string) {
  if (value === undefined || value === null) {
    return null;
  }
  if (!Number.isSafeInteger(value) || (value as number) < 0 || (value as number) > 86_400_000) {
    throw new AaisResearchValidationError(`AAIS research ${label} is invalid.`);
  }
  return value as number;
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value)
    && typeof value === "object"
    && !Array.isArray(value)
    && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);
}
