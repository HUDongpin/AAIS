import {
  createCipheriv,
  createDecipheriv,
  hkdfSync,
  randomBytes,
  randomUUID,
} from "node:crypto";
import {
  getAaisDatabaseConfiguration,
  type AaisDatabaseClient,
} from "@/lib/server/aais-learning-store";
import { isAaisStrongOpaqueSecret } from "@/lib/server/aais-opaque-secret";
import { readAaisBoundedResponseJson } from "@/lib/server/aais-bounded-response";
import {
  createAaisNeonQueryClient,
  getAaisSharedPostgresPool,
} from "@/lib/server/aais-postgres-pool";

export type AaisAuthDeliveryConfigurationStatus = {
  status: "configured" | "invalid" | "not_configured";
  appBaseUrlConfigured: boolean;
  appBaseUrlValid: boolean;
  emailProviderConfigured: boolean;
  emailProviderValid: boolean;
  encryptionSecretConfigured: boolean;
  encryptionSecretValid: boolean;
  issues: string[];
};

export type AaisAuthDeliveryConfiguration = {
  appBaseUrl: string;
  apiKey: string;
  from: string;
  encryptionSecret: string;
};

export type AaisAuthEmailPurpose = "invite" | "password_reset";

export type AaisAuthEmailPayloadEnvelope = {
  version: 1;
  nonce: string;
  tag: string;
  ciphertext: string;
};

export type AaisAuthEmailOutboxMessage = {
  id: string;
  purpose: AaisAuthEmailPurpose;
  authTokenId: string;
  authTokenHash: string;
  recipient: string;
  payloadEnvelope: AaisAuthEmailPayloadEnvelope;
  idempotencyKey: string;
};

export type AaisAuthEmailOutboxFlushReport = {
  status: "pass";
  claimed: number;
  sent: number;
  retry: number;
  deadLetter: number;
  stale: number;
  deferred: number;
  hasMore: boolean;
  stoppedReason: "empty" | "limit" | "runtime_budget";
  secrets: "redacted";
};

export type AaisAuthEmailReconciliationDisposition = "sent" | "not_sent";

export type AaisAuthEmailProviderEvidence = {
  provider: "resend";
  messageId: string;
  status: "sent" | "delivered" | "failed" | "bounced" | "canceled" | "suppressed";
  observedAt: string;
};

export type AaisAuthEmailReconciliationResult = {
  outboxId: string;
  disposition: AaisAuthEmailReconciliationDisposition;
  status: "sent" | "dead";
  tokenState: "delivered" | "idle";
  reissueAllowed: boolean;
  reconciledAt: string;
};

type AaisAuthEmailPayload = {
  from: string;
  to: string;
  subject: string;
  text: string;
};

type ClaimedAuthEmailRow = {
  id: string;
  purpose: AaisAuthEmailPurpose;
  authTokenId: string;
  authTokenHash: string;
  authTokenExpiresAt: string;
  recipient: string;
  payloadEnvelope: AaisAuthEmailPayloadEnvelope;
  idempotencyKey: string;
  attemptCount: number;
  firstAttemptAt: string;
  uncertainSince: string | null;
};

type DeliveryAttempt =
  | { status: "sent" }
  | {
      status: "failed";
      errorCode: string;
      retryable: boolean;
      uncertain: boolean;
    };

type FlushInput = {
  database?: AaisDatabaseClient | null;
  env?: Record<string, string | undefined>;
  fetchImpl?: typeof fetch;
  now?: () => Date;
  batchSize?: number;
  leaseMs?: number;
  timeoutMs?: number;
  maxAttempts?: number;
  runtimeBudgetMs?: number;
  beforeDispatch?: () => Promise<void>;
};

const authEmailKeySalt = Buffer.from("aais-auth-email-outbox:key-derivation:v1", "utf8");
const authEmailKeyInfo = Buffer.from("aes-256-gcm:payload", "utf8");
const authEmailAadPrefix = "aais-auth-email-outbox:payload:v1";
const defaultBatchSize = 5;
const defaultLeaseMs = 2 * 60 * 1_000;
const defaultTimeoutMs = 10_000;
const defaultMaxAttempts = 8;
const defaultRuntimeBudgetMs = 20_000;
const deliveryLeaseSafetyMarginMs = 5_000;
const runtimeFinalizeGuardMs = 2_000;
const resendIdempotencyWindowGuardMs = 23 * 60 * 60 * 1_000;
const maximumAuthEmailSubjectCharacters = 200;
const maximumAuthEmailBodyBytes = 64 * 1_024;

let cachedOutboxDatabase: { url: string; client: AaisDatabaseClient } | null = null;

export class AaisAuthDeliveryConfigurationError extends Error {
  constructor() {
    super("AAIS authentication email delivery is not configured safely.");
    this.name = "AaisAuthDeliveryConfigurationError";
  }
}

export class AaisAuthEmailOutboxStoreError extends Error {
  constructor() {
    super("AAIS authentication email outbox requires Postgres configuration.");
    this.name = "AaisAuthEmailOutboxStoreError";
  }
}

export class AaisAuthEmailReconciliationConflictError extends Error {
  constructor() {
    super("AAIS authentication email reconciliation is not eligible or conflicts with evidence.");
    this.name = "AaisAuthEmailReconciliationConflictError";
  }
}

export function isAaisAuthDeliveryConfigurationError(
  error: unknown,
): error is AaisAuthDeliveryConfigurationError {
  return error instanceof AaisAuthDeliveryConfigurationError;
}

export function isAaisAuthEmailOutboxStoreError(
  error: unknown,
): error is AaisAuthEmailOutboxStoreError {
  return error instanceof AaisAuthEmailOutboxStoreError;
}

export function isAaisAuthEmailReconciliationConflictError(
  error: unknown,
): error is AaisAuthEmailReconciliationConflictError {
  return error instanceof AaisAuthEmailReconciliationConflictError;
}

export function inspectAaisAuthDeliveryConfiguration(
  env: Record<string, string | undefined> = process.env,
): AaisAuthDeliveryConfigurationStatus {
  const production = isProductionRuntime(env);
  const rawAppBaseUrl = env.AAIS_APP_BASE_URL?.trim() ?? "";
  const rawApiKey = env.RESEND_API_KEY?.trim() ?? "";
  const rawFrom = env.AAIS_AUTH_EMAIL_FROM?.trim() ?? "";
  const rawEncryptionSecret = env.AAIS_SESSION_SECRET?.trim() ?? "";
  const appBaseUrlConfigured = Boolean(rawAppBaseUrl);
  const emailProviderConfigured = Boolean(rawApiKey && rawFrom);
  const encryptionSecretConfigured = Boolean(rawEncryptionSecret);
  const appBaseUrlValid = Boolean(
    parseSafeAppBaseUrl(rawAppBaseUrl || (production ? "" : "http://localhost:3000"), production),
  );
  const emailProviderValid = Boolean(
    isSafeResendApiKey(rawApiKey)
    && isSafeEmailFrom(rawFrom),
  );
  const encryptionSecretValid = isAaisStrongOpaqueSecret(rawEncryptionSecret);
  const issues: string[] = [];

  if (production && !appBaseUrlConfigured) {
    issues.push("AAIS_APP_BASE_URL");
  } else if (!appBaseUrlValid) {
    issues.push("AAIS_APP_BASE_URL_INVALID");
  }
  if (!rawApiKey && !rawFrom) {
    if (production) {
      issues.push("AAIS_AUTH_EMAIL_PROVIDER");
    }
  } else if (!emailProviderValid) {
    issues.push("AAIS_AUTH_EMAIL_PROVIDER_INVALID");
  }
  if (!rawEncryptionSecret) {
    if (production) {
      issues.push("AAIS_AUTH_EMAIL_ENCRYPTION_SECRET");
    }
  } else if (!encryptionSecretValid) {
    issues.push("AAIS_AUTH_EMAIL_ENCRYPTION_SECRET_INVALID");
  }

  return {
    status: issues.length > 0
      ? "invalid"
      : emailProviderConfigured && emailProviderValid && encryptionSecretValid
        ? "configured"
        : "not_configured",
    appBaseUrlConfigured,
    appBaseUrlValid,
    emailProviderConfigured,
    emailProviderValid,
    encryptionSecretConfigured,
    encryptionSecretValid,
    issues,
  };
}

export function requireAaisAuthDeliveryConfiguration(
  env: Record<string, string | undefined> = process.env,
): AaisAuthDeliveryConfiguration {
  const status = inspectAaisAuthDeliveryConfiguration(env);
  if (status.status !== "configured") {
    throw new AaisAuthDeliveryConfigurationError();
  }
  const production = isProductionRuntime(env);
  const appBaseUrl = parseSafeAppBaseUrl(
    env.AAIS_APP_BASE_URL?.trim() || (production ? "" : "http://localhost:3000"),
    production,
  );
  if (!appBaseUrl) {
    throw new AaisAuthDeliveryConfigurationError();
  }
  return {
    appBaseUrl,
    apiKey: env.RESEND_API_KEY!.trim(),
    from: env.AAIS_AUTH_EMAIL_FROM!.trim(),
    encryptionSecret: env.AAIS_SESSION_SECRET!.trim(),
  };
}

export function createAaisAuthEmailOutboxMessage(input: {
  configuration: AaisAuthDeliveryConfiguration;
  id?: string;
  purpose: AaisAuthEmailPurpose;
  authTokenId: string;
  authTokenHash: string;
  recipient: string;
  subject: string;
  text: string;
}): AaisAuthEmailOutboxMessage {
  const id = input.id ?? randomUUID();
  if (!isUuid(id) || !isAaisAuthEmailPurpose(input.purpose)) {
    throw new Error("Invalid AAIS authentication email outbox identity.");
  }
  if (
    !/^auth-(?:invite|reset)-[a-f0-9]{24}$/.test(input.authTokenId)
    || !/^[a-f0-9]{64}$/.test(input.authTokenHash)
  ) {
    throw new Error("Invalid AAIS authentication email token fence.");
  }
  const recipient = requireEmailAddress(input.recipient);
  const payload = requireAuthEmailPayload({
    from: input.configuration.from,
    to: recipient,
    subject: input.subject,
    text: input.text,
  });
  const idempotencyKey = `aais_auth_email_${id}`;
  return {
    id,
    purpose: input.purpose,
    authTokenId: input.authTokenId,
    authTokenHash: input.authTokenHash,
    recipient,
    payloadEnvelope: encryptAuthEmailPayload({
      configuration: input.configuration,
      id,
      authTokenId: input.authTokenId,
      authTokenHash: input.authTokenHash,
      idempotencyKey,
      payload,
      purpose: input.purpose,
      recipient,
    }),
    idempotencyKey,
  };
}

export async function reconcileAaisAuthEmailOutbox(input: {
  actorId: string;
  database?: AaisDatabaseClient | null;
  disposition: AaisAuthEmailReconciliationDisposition;
  env?: Record<string, string | undefined>;
  evidence: AaisAuthEmailProviderEvidence;
  now?: () => Date;
  outboxId: string;
}): Promise<AaisAuthEmailReconciliationResult> {
  const outboxId = requireUuid(input.outboxId, "outbox id");
  const actorId = requireReconciliationActorId(input.actorId);
  const disposition = requireReconciliationDisposition(input.disposition);
  const reconciledAt = (input.now ?? (() => new Date()))();
  if (!Number.isFinite(reconciledAt.getTime())) {
    throw new Error("Invalid AAIS authentication email reconciliation time.");
  }
  const evidence = requireProviderEvidence(input.evidence, disposition, reconciledAt);
  const database = input.database === undefined
    ? getConfiguredAuthEmailOutboxDatabase(input.env ?? process.env)
    : input.database;
  if (!database) {
    throw new AaisAuthEmailOutboxStoreError();
  }
  const result = await database.query(
    `with locked_reconciliation as materialized (
       select email.id, email.status, email.auth_token_id, email.auth_token_hash,
              email.uncertain_since, email.reconciliation_disposition,
              email.reconciliation_provider, email.reconciliation_message_id,
              email.reconciliation_observed_status,
              email.reconciliation_observed_at, email.reconciled_at,
              token.token_hash as current_token_hash,
              token.email_delivery_state, token.email_delivery_outbox_id,
              token.email_delivery_claim_id
         from public.aais_auth_email_outbox email
         join public.aais_user_auth_tokens token
           on token.id = email.auth_token_id
        where email.id = $1::uuid
        for update of email, token
     ),
     existing_reconciliation as materialized (
       select locked.id, locked.reconciliation_disposition as disposition,
              locked.status,
              case when locked.reconciliation_disposition = 'sent'
                then 'delivered'
                else 'idle'
              end as token_state,
              locked.reconciled_at
         from locked_reconciliation locked
        where locked.reconciliation_disposition = $2
          and locked.reconciliation_provider = $3
          and locked.reconciliation_message_id = $4
          and locked.reconciliation_observed_status = $5
          and locked.reconciliation_observed_at = $6::timestamptz
          and (($2 = 'sent' and locked.status = 'sent')
            or ($2 = 'not_sent' and locked.status = 'dead'))
     ),
     transition_candidate as materialized (
       select locked.*
         from locked_reconciliation locked
        where locked.reconciliation_disposition is null
          and locked.status = 'dead'
          and locked.uncertain_since is not null
          and locked.current_token_hash = locked.auth_token_hash
          and locked.email_delivery_state = 'uncertain'
          and locked.email_delivery_outbox_id = locked.id
          and locked.email_delivery_claim_id is null
     ),
     updated_token_fence as (
       update public.aais_user_auth_tokens token
          set consumed_at = case
                when $2 = 'not_sent' then coalesce(token.consumed_at, $7::timestamptz)
                else token.consumed_at
              end,
              email_delivery_state = case
                when $2 = 'sent' then 'delivered'
                else 'idle'
              end,
              email_delivery_outbox_id = case
                when $2 = 'sent' then candidate.id
                else null
              end,
              email_delivery_claim_id = null,
              email_delivery_started_at = case
                when $2 = 'sent' then coalesce(token.email_delivery_started_at, $7::timestamptz)
                else null
              end
         from transition_candidate candidate
        where token.id = candidate.auth_token_id
          and token.token_hash = candidate.auth_token_hash
          and token.email_delivery_state = 'uncertain'
          and token.email_delivery_outbox_id = candidate.id
          and token.email_delivery_claim_id is null
        returning token.id, candidate.id as outbox_id,
                  token.email_delivery_state as token_state
     ),
     reconciled_email as (
       update public.aais_auth_email_outbox email
          set status = case when $2 = 'sent' then 'sent' else 'dead' end,
              sent_at = case when $2 = 'sent' then $7::timestamptz else null end,
              dead_lettered_at = case
                when $2 = 'sent' then null
                else coalesce(email.dead_lettered_at, $7::timestamptz)
              end,
              last_error_code = case
                when $2 = 'sent' then 'operator_confirmed_sent'
                else 'operator_confirmed_not_sent'
              end,
              reconciliation_disposition = $2,
              reconciliation_provider = $3,
              reconciliation_message_id = $4,
              reconciliation_observed_status = $5,
              reconciliation_observed_at = $6::timestamptz,
              reconciled_at = $7::timestamptz,
              reconciled_by = $8,
              updated_at = $7::timestamptz
         from updated_token_fence token_fence
        where email.id = token_fence.outbox_id
          and email.reconciliation_disposition is null
        returning email.id, email.reconciliation_disposition as disposition,
                  email.status, email.reconciled_at,
                  token_fence.token_state
     )
     select existing.id, existing.disposition, existing.status,
            existing.token_state, existing.reconciled_at
       from existing_reconciliation existing
     union all
     select reconciled.id, reconciled.disposition, reconciled.status,
            reconciled.token_state, reconciled.reconciled_at
       from reconciled_email reconciled`,
    [
      outboxId,
      disposition,
      evidence.provider,
      evidence.messageId,
      evidence.status,
      evidence.observedAt,
      reconciledAt.toISOString(),
      actorId,
    ],
  ).catch((error: unknown) => {
    if (isReconciliationEvidenceConflictDatabaseError(error)) {
      throw new AaisAuthEmailReconciliationConflictError();
    }
    throw error;
  });
  const row = result.rows[0];
  if (!row || result.rows.length !== 1) {
    throw new AaisAuthEmailReconciliationConflictError();
  }
  return parseReconciliationResult(row, outboxId, disposition);
}

export async function flushAaisAuthEmailOutbox(
  input: FlushInput = {},
): Promise<AaisAuthEmailOutboxFlushReport> {
  const env = input.env ?? process.env;
  const configuration = requireAaisAuthDeliveryConfiguration(env);
  const database = input.database === undefined
    ? getConfiguredAuthEmailOutboxDatabase(env)
    : input.database;
  if (!database) {
    throw new AaisAuthEmailOutboxStoreError();
  }
  const fetchImpl = input.fetchImpl ?? fetch;
  const now = input.now ?? (() => new Date());
  const batchSize = readBoundedInteger(input.batchSize, defaultBatchSize, 1, 25);
  const leaseMs = readBoundedInteger(input.leaseMs, defaultLeaseMs, 30_000, 10 * 60 * 1_000);
  const timeoutMs = readBoundedInteger(input.timeoutMs, defaultTimeoutMs, 100, 30_000);
  const maxAttempts = readBoundedInteger(input.maxAttempts, defaultMaxAttempts, 1, 16);
  const runtimeBudgetMs = readBoundedInteger(
    input.runtimeBudgetMs,
    Math.max(defaultRuntimeBudgetMs, timeoutMs + runtimeFinalizeGuardMs),
    1_000,
    60_000,
  );
  if (leaseMs < timeoutMs + deliveryLeaseSafetyMarginMs) {
    throw new Error("AAIS authentication email lease must exceed the provider timeout.");
  }
  if (runtimeBudgetMs < timeoutMs + runtimeFinalizeGuardMs) {
    throw new Error("AAIS authentication email runtime budget must cover the provider timeout.");
  }
  if (leaseMs < runtimeBudgetMs + runtimeFinalizeGuardMs) {
    throw new Error("AAIS authentication email lease must exceed the worker runtime budget.");
  }
  const claimedAt = now();
  const runtimeDeadline = claimedAt.getTime() + runtimeBudgetMs;
  const claimId = randomUUID();
  const claimResult = await claimAuthEmailRows(database, {
    batchSize,
    claimId,
    claimedAt,
    leaseExpiresAt: new Date(claimedAt.getTime() + leaseMs),
  });
  const report: AaisAuthEmailOutboxFlushReport = {
    status: "pass",
    claimed: claimResult.rows.length,
    sent: 0,
    retry: 0,
    deadLetter: claimResult.invalidatedCount,
    stale: 0,
    deferred: 0,
    hasMore: claimResult.rows.length + claimResult.invalidatedCount >= batchSize,
    stoppedReason: claimResult.rows.length + claimResult.invalidatedCount >= batchSize
      ? "limit"
      : "empty",
    secrets: "redacted",
  };

  for (let rowIndex = 0; rowIndex < claimResult.rows.length; rowIndex += 1) {
    const rawRow = claimResult.rows[rowIndex]!;
    if (workerRuntimeBudgetReached(now(), runtimeDeadline)) {
      await releaseUnstartedAuthEmailRowsAndUpdateReport(database, {
        claimId,
        rawRows: claimResult.rows.slice(rowIndex),
        report,
        releasedAt: now(),
      });
      break;
    }
    const attemptedAt = now();
    let row: ClaimedAuthEmailRow;
    try {
      row = parseClaimedAuthEmailRow(rawRow);
    } catch {
      const poisonedId = readUuid(rawRow.id);
      const fenced = poisonedId
        ? await finalizeFailedAuthEmail(database, {
            claimId,
            errorCode: "payload_invalid",
            id: poisonedId,
            nextAttemptAt: attemptedAt,
            status: "dead",
            uncertainSince: readFailClosedUncertainSince(
              rawRow.uncertain_since,
              attemptedAt,
            ),
            updatedAt: attemptedAt,
          })
        : false;
      if (fenced) {
        report.deadLetter += 1;
      } else {
        report.stale += 1;
      }
      continue;
    }

    const tokenExpired = Date.parse(row.authTokenExpiresAt) <= attemptedAt.getTime();
    if (
      row.attemptCount > maxAttempts
      || tokenExpired
      || isExpiredDeliveryWindow(row.firstAttemptAt, attemptedAt)
    ) {
      const fenced = await finalizeFailedAuthEmail(database, {
        claimId,
        errorCode: row.attemptCount > maxAttempts
          ? "attempt_limit_exceeded"
          : tokenExpired
            ? "auth_token_inactive"
            : "idempotency_window_expired",
        id: row.id,
        nextAttemptAt: attemptedAt,
        status: "dead",
        uncertainSince: row.uncertainSince,
        updatedAt: attemptedAt,
      });
      if (fenced) {
        report.deadLetter += 1;
      } else {
        report.stale += 1;
      }
      continue;
    }

    let payload: AaisAuthEmailPayload;
    try {
      payload = decryptAuthEmailPayload({ configuration, row });
    } catch {
      const fenced = await finalizeFailedAuthEmail(database, {
        claimId,
        errorCode: "payload_invalid",
        id: row.id,
        nextAttemptAt: attemptedAt,
        status: "dead",
        uncertainSince: row.uncertainSince,
        updatedAt: attemptedAt,
      });
      if (fenced) {
        report.deadLetter += 1;
      } else {
        report.stale += 1;
      }
      continue;
    }

    const renewed = await renewClaimAndValidateToken(database, {
      authTokenHash: row.authTokenHash,
      authTokenId: row.authTokenId,
      claimId,
      id: row.id,
      leaseExpiresAt: new Date(attemptedAt.getTime() + leaseMs),
      now: attemptedAt,
    });
    if (!renewed) {
      // A lost/expired lease or changed token fence is not ours to finalize.
      // The next bounded claim pass will either reclaim it or invalidate it.
      report.stale += 1;
      continue;
    }

    const dispatchAt = now();
    if (workerRuntimeBudgetReached(
      dispatchAt,
      runtimeDeadline,
      timeoutMs + runtimeFinalizeGuardMs,
    )) {
      await releaseUnstartedAuthEmailRowsAndUpdateReport(database, {
        claimId,
        rawRows: claimResult.rows.slice(rowIndex),
        report,
        releasedAt: dispatchAt,
      });
      break;
    }

    if (input.beforeDispatch) {
      try {
        await input.beforeDispatch();
      } catch (error) {
        await releaseUnstartedAuthEmailRowsAndUpdateReport(database, {
          claimId,
          rawRows: claimResult.rows.slice(rowIndex),
          report,
          releasedAt: dispatchAt,
        });
        throw error;
      }
    }

    const delivery = await deliverAuthEmail({
      configuration,
      fetchImpl,
      idempotencyKey: row.idempotencyKey,
      payload,
      timeoutMs,
    });
    if (delivery.status === "sent") {
      const fenced = await acknowledgeAuthEmail(database, {
        claimId,
        id: row.id,
        sentAt: attemptedAt,
      });
      if (fenced) {
        report.sent += 1;
      } else {
        report.stale += 1;
      }
      continue;
    }

    const deadLetter = !delivery.retryable || row.attemptCount >= maxAttempts;
    const uncertainSince = delivery.uncertain
      ? row.uncertainSince ?? attemptedAt.toISOString()
      : row.uncertainSince;
    const fenced = await finalizeFailedAuthEmail(database, {
      claimId,
      errorCode: delivery.errorCode,
      id: row.id,
      nextAttemptAt: deadLetter
        ? attemptedAt
        : new Date(attemptedAt.getTime() + retryDelayMs(row.id, row.attemptCount)),
      status: deadLetter ? "dead" : "retry",
      uncertainSince,
      updatedAt: attemptedAt,
    });
    if (!fenced) {
      report.stale += 1;
    } else if (deadLetter) {
      report.deadLetter += 1;
    } else {
      report.retry += 1;
    }
  }

  return report;
}

function workerRuntimeBudgetReached(
  now: Date,
  deadlineMs: number,
  requiredRemainingMs = runtimeFinalizeGuardMs,
) {
  return now.getTime() >= deadlineMs - requiredRemainingMs;
}

async function releaseUnstartedAuthEmailRowsAndUpdateReport(
  database: AaisDatabaseClient,
  input: {
    claimId: string;
    rawRows: Record<string, unknown>[];
    releasedAt: Date;
    report: AaisAuthEmailOutboxFlushReport;
  },
) {
  const ids = input.rawRows
    .map((row) => readUuid(row.id))
    .filter((id): id is string => Boolean(id));
  const released = ids.length
    ? await releaseUnstartedAuthEmailRows(database, {
        claimId: input.claimId,
        ids,
        releasedAt: input.releasedAt,
      })
    : 0;
  input.report.deferred += released;
  input.report.stale += input.rawRows.length - released;
  input.report.hasMore = true;
  input.report.stoppedReason = "runtime_budget";
}

async function claimAuthEmailRows(
  database: AaisDatabaseClient,
  input: {
    batchSize: number;
    claimId: string;
    claimedAt: Date;
    leaseExpiresAt: Date;
  },
) {
  const result = await database.query(
    `with invalidatable_email as materialized (
       select email.id
         from public.aais_auth_email_outbox email
        where ((
          email.status in ('pending', 'retry')
          and email.next_attempt_at <= $1::timestamptz
        ) or (
          email.status = 'sending'
          and email.lease_expires_at <= $1::timestamptz
        ))
          and not exists (
            select 1
              from public.aais_user_auth_tokens token
              join public.aais_users account
                on account.id = token.user_id
             where token.id = email.auth_token_id
               and token.token_hash = email.auth_token_hash
               and token.purpose = email.purpose
               and token.consumed_at is null
               and token.expires_at > $1::timestamptz
               and account.status <> 'disabled'
          )
        order by email.next_attempt_at asc, email.created_at asc, email.id asc
        for update of email skip locked
        limit $2
     ),
     invalidated_email as (
       update public.aais_auth_email_outbox email
          set status = 'dead',
              last_error_code = 'auth_token_inactive',
              dead_lettered_at = $1::timestamptz,
              uncertain_since = case
                when email.status = 'sending'
                  then coalesce(email.uncertain_since, $1::timestamptz)
                else email.uncertain_since
              end,
              claim_id = null,
              claimed_at = null,
              lease_expires_at = null,
              updated_at = $1::timestamptz
         from invalidatable_email invalidatable
        where email.id = invalidatable.id
        returning email.id, email.auth_token_id, email.uncertain_since
     ),
     released_invalid_token as (
       update public.aais_user_auth_tokens token
          set email_delivery_state = case
                when invalidated.uncertain_since is null then 'idle'
                else 'uncertain'
              end,
              email_delivery_outbox_id = case
                when invalidated.uncertain_since is null then null
                else invalidated.id
              end,
              email_delivery_claim_id = null,
              email_delivery_started_at = case
                when invalidated.uncertain_since is null then null
                else coalesce(
                  token.email_delivery_started_at,
                  invalidated.uncertain_since
                )
              end
         from invalidated_email invalidated
        where token.id = invalidated.auth_token_id
          and token.email_delivery_outbox_id = invalidated.id
        returning token.id
     ),
     claimable_email as materialized (
       select email.id, email.auth_token_id, email.auth_token_hash
         from public.aais_auth_email_outbox email
         join public.aais_user_auth_tokens token
           on token.id = email.auth_token_id
          and token.token_hash = email.auth_token_hash
          and token.purpose = email.purpose
         join public.aais_users account
           on account.id = token.user_id
        where ((
          email.status in ('pending', 'retry')
          and email.next_attempt_at <= $1::timestamptz
        ) or (
          email.status = 'sending'
          and email.lease_expires_at <= $1::timestamptz
        ))
          and token.consumed_at is null
          and token.expires_at > $1::timestamptz
          and account.status <> 'disabled'
          and (
            token.email_delivery_state = 'idle'
            or (
              token.email_delivery_state in ('in_flight', 'uncertain')
              and token.email_delivery_outbox_id = email.id
            )
          )
        order by email.next_attempt_at asc, email.created_at asc, email.id asc
        for update of email skip locked
        limit greatest(
          0,
          $2 - (select count(*)::integer from invalidated_email)
        )
     ),
     fenced_token as (
       update public.aais_user_auth_tokens token
          set email_delivery_state = 'in_flight',
              email_delivery_outbox_id = claimable.id,
              email_delivery_claim_id = $3::uuid,
              email_delivery_started_at = case
                when token.email_delivery_outbox_id = claimable.id
                  then coalesce(token.email_delivery_started_at, $1::timestamptz)
                else $1::timestamptz
              end
         from claimable_email claimable
        where token.id = claimable.auth_token_id
          and token.token_hash = claimable.auth_token_hash
          and (
            token.email_delivery_state = 'idle'
            or (
              token.email_delivery_state in ('in_flight', 'uncertain')
              and token.email_delivery_outbox_id = claimable.id
            )
          )
        returning token.id, claimable.id as outbox_id
     ),
     claimed_email as (
       update public.aais_auth_email_outbox email
          set status = 'sending',
              claim_id = $3::uuid,
              claimed_at = $1::timestamptz,
              lease_expires_at = $4::timestamptz,
              attempt_count = email.attempt_count + 1,
              first_attempt_at = coalesce(email.first_attempt_at, $1::timestamptz),
              uncertain_since = case
                when email.status = 'sending'
                  then coalesce(email.uncertain_since, $1::timestamptz)
                else email.uncertain_since
              end,
              updated_at = $1::timestamptz
        from claimable_email claimable
        join fenced_token fenced on fenced.outbox_id = claimable.id
        where email.id = claimable.id
        returning email.id, email.purpose, email.recipient,
                  email.auth_token_id, email.auth_token_hash,
                  email.payload_envelope, email.idempotency_key,
                  email.attempt_count, email.first_attempt_at,
                  email.uncertain_since,
                  (select token.expires_at
                     from public.aais_user_auth_tokens token
                    where token.id = email.auth_token_id
                      and token.token_hash = email.auth_token_hash
                  ) as auth_token_expires_at
     )
     select false as invalidated, claimed.*
       from claimed_email claimed
     union all
     select true as invalidated,
            invalidated.id,
            null::text as purpose,
            null::text as recipient,
            null::text as auth_token_id,
            null::text as auth_token_hash,
            null::jsonb as payload_envelope,
            null::text as idempotency_key,
            null::integer as attempt_count,
            null::timestamptz as first_attempt_at,
            null::timestamptz as uncertain_since,
            null::timestamptz as auth_token_expires_at
       from invalidated_email invalidated
      cross join (select count(*) from released_invalid_token) release_barrier
      order by invalidated asc, first_attempt_at asc nulls last, id asc`,
    [
      input.claimedAt.toISOString(),
      input.batchSize,
      input.claimId,
      input.leaseExpiresAt.toISOString(),
    ],
  );
  return {
    rows: result.rows.filter((row) => row.invalidated !== true),
    invalidatedCount: result.rows.filter((row) => row.invalidated === true).length,
  };
}

async function releaseUnstartedAuthEmailRows(
  database: AaisDatabaseClient,
  input: {
    claimId: string;
    ids: string[];
    releasedAt: Date;
  },
) {
  const result = await database.query(
    `with releasable_email as materialized (
       select email.id, email.auth_token_id, email.auth_token_hash,
              email.attempt_count, email.uncertain_since
         from public.aais_auth_email_outbox email
         join public.aais_user_auth_tokens token
           on token.id = email.auth_token_id
          and token.token_hash = email.auth_token_hash
        where email.id = any($2::uuid[])
          and email.claim_id = $1::uuid
          and email.status = 'sending'
          and token.email_delivery_state = 'in_flight'
          and token.email_delivery_outbox_id = email.id
          and token.email_delivery_claim_id = $1::uuid
        for update of email, token
     ),
     released_token_fence as (
       update public.aais_user_auth_tokens token
          set email_delivery_state = case
                when releasable.uncertain_since is null then 'idle'
                else 'uncertain'
              end,
              email_delivery_outbox_id = case
                when releasable.uncertain_since is null then null
                else releasable.id
              end,
              email_delivery_claim_id = null,
              email_delivery_started_at = case
                when releasable.uncertain_since is null then null
                else coalesce(
                  token.email_delivery_started_at,
                  releasable.uncertain_since
                )
              end
         from releasable_email releasable
        where token.id = releasable.auth_token_id
          and token.token_hash = releasable.auth_token_hash
          and token.email_delivery_state = 'in_flight'
          and token.email_delivery_outbox_id = releasable.id
          and token.email_delivery_claim_id = $1::uuid
        returning token.id as auth_token_id
     ),
     released_email as (
       update public.aais_auth_email_outbox email
          set status = case
                when releasable.attempt_count <= 1 then 'pending'
                else 'retry'
              end,
              attempt_count = greatest(0, releasable.attempt_count - 1),
              first_attempt_at = case
                when releasable.attempt_count <= 1 then null
                else email.first_attempt_at
              end,
              next_attempt_at = $3::timestamptz,
              claim_id = null,
              claimed_at = null,
              lease_expires_at = null,
              updated_at = $3::timestamptz
         from released_token_fence token_fence
         join releasable_email releasable
           on releasable.auth_token_id = token_fence.auth_token_id
        where email.id = releasable.id
          and email.claim_id = $1::uuid
          and email.status = 'sending'
        returning email.id
     )
     select released.id
       from released_email released`,
    [input.claimId, input.ids, input.releasedAt.toISOString()],
  );
  return result.rows.length;
}

async function renewClaimAndValidateToken(
  database: AaisDatabaseClient,
  input: {
    id: string;
    claimId: string;
    authTokenId: string;
    authTokenHash: string;
    now: Date;
    leaseExpiresAt: Date;
  },
) {
  const result = await database.query(
    `update public.aais_auth_email_outbox email
        set lease_expires_at = $6::timestamptz,
            updated_at = $5::timestamptz
       from public.aais_user_auth_tokens token,
            public.aais_users account
      where email.id = $1::uuid
        and email.claim_id = $2::uuid
        and email.status = 'sending'
        and email.lease_expires_at > $5::timestamptz
        and email.auth_token_id = $3
        and email.auth_token_hash = $4
        and token.id = email.auth_token_id
        and token.token_hash = email.auth_token_hash
        and token.purpose = email.purpose
        and token.consumed_at is null
        and token.expires_at > $5::timestamptz
        and account.id = token.user_id
        and account.status <> 'disabled'
        and token.email_delivery_state = 'in_flight'
        and token.email_delivery_outbox_id = email.id
        and token.email_delivery_claim_id = $2::uuid
      returning email.id`,
    [
      input.id,
      input.claimId,
      input.authTokenId,
      input.authTokenHash,
      input.now.toISOString(),
      input.leaseExpiresAt.toISOString(),
    ],
  );
  return Boolean(result.rows[0]);
}

async function acknowledgeAuthEmail(
  database: AaisDatabaseClient,
  input: { id: string; claimId: string; sentAt: Date },
) {
  const result = await database.query(
    `with acknowledged_candidate as materialized (
       select email.id, email.auth_token_id, email.auth_token_hash
         from public.aais_auth_email_outbox email
         join public.aais_user_auth_tokens token
           on token.id = email.auth_token_id
          and token.token_hash = email.auth_token_hash
        where email.id = $1::uuid
          and email.claim_id = $2::uuid
          and email.status = 'sending'
          and token.email_delivery_state = 'in_flight'
          and token.email_delivery_outbox_id = email.id
          and token.email_delivery_claim_id = $2::uuid
        for update of email, token
     ),
     updated_token_fence as (
       update public.aais_user_auth_tokens token
          set email_delivery_state = 'delivered',
              email_delivery_claim_id = null,
              email_delivery_started_at = coalesce(
                token.email_delivery_started_at,
                $3::timestamptz
              )
         from acknowledged_candidate acknowledged
        where token.id = acknowledged.auth_token_id
          and token.token_hash = acknowledged.auth_token_hash
          and token.email_delivery_state = 'in_flight'
          and token.email_delivery_outbox_id = acknowledged.id
          and token.email_delivery_claim_id = $2::uuid
        returning acknowledged.id as outbox_id
     ),
     acknowledged_email as (
       update public.aais_auth_email_outbox email
          set status = 'sent',
              claim_id = null,
              claimed_at = null,
              lease_expires_at = null,
              sent_at = $3::timestamptz,
              uncertain_since = null,
              last_error_code = null,
              updated_at = $3::timestamptz
         from updated_token_fence token_fence
        where email.id = token_fence.outbox_id
          and email.claim_id = $2::uuid
          and email.status = 'sending'
        returning email.id
     )
     select acknowledged.id
       from acknowledged_email acknowledged`,
    [input.id, input.claimId, input.sentAt.toISOString()],
  );
  return Boolean(result.rows[0]);
}

async function finalizeFailedAuthEmail(
  database: AaisDatabaseClient,
  input: {
    id: string;
    claimId: string;
    status: "retry" | "dead";
    nextAttemptAt: Date;
    errorCode: string;
    updatedAt: Date;
    uncertainSince: string | null;
  },
) {
  const result = await database.query(
    `with failed_candidate as materialized (
       select email.id, email.auth_token_id, email.auth_token_hash
         from public.aais_auth_email_outbox email
         join public.aais_user_auth_tokens token
           on token.id = email.auth_token_id
          and token.token_hash = email.auth_token_hash
        where email.id = $1::uuid
          and email.claim_id = $2::uuid
          and email.status = 'sending'
          and token.email_delivery_state = 'in_flight'
          and token.email_delivery_outbox_id = email.id
          and token.email_delivery_claim_id = $2::uuid
        for update of email, token
     ),
     updated_token_fence as (
       update public.aais_user_auth_tokens token
          set email_delivery_state = case
                when $7::timestamptz is null then 'idle'
                else 'uncertain'
              end,
              email_delivery_outbox_id = case
                when $7::timestamptz is null then null
                else failed.id
              end,
              email_delivery_claim_id = null,
              email_delivery_started_at = case
                when $7::timestamptz is null then null
                else coalesce(token.email_delivery_started_at, $6::timestamptz)
              end
         from failed_candidate failed
        where token.id = failed.auth_token_id
          and token.token_hash = failed.auth_token_hash
          and token.email_delivery_outbox_id = failed.id
          and token.email_delivery_claim_id = $2::uuid
        returning failed.id as outbox_id
     ),
     failed_email as (
       update public.aais_auth_email_outbox email
          set status = $3,
              next_attempt_at = $4::timestamptz,
              last_error_code = $5,
              updated_at = $6::timestamptz,
              uncertain_since = case
                when $7::timestamptz is null then email.uncertain_since
                else coalesce(email.uncertain_since, $7::timestamptz)
              end,
              dead_lettered_at = case
                when $3 = 'dead' then $6::timestamptz
                else null
              end,
              claim_id = null,
              claimed_at = null,
              lease_expires_at = null
         from updated_token_fence token_fence
        where email.id = token_fence.outbox_id
          and email.claim_id = $2::uuid
          and email.status = 'sending'
        returning email.id
     )
     select failed.id
       from failed_email failed`,
    [
      input.id,
      input.claimId,
      input.status,
      input.nextAttemptAt.toISOString(),
      input.errorCode,
      input.updatedAt.toISOString(),
      input.uncertainSince,
    ],
  );
  return Boolean(result.rows[0]);
}

async function deliverAuthEmail(input: {
  configuration: AaisAuthDeliveryConfiguration;
  fetchImpl: typeof fetch;
  idempotencyKey: string;
  payload: AaisAuthEmailPayload;
  timeoutMs: number;
}): Promise<DeliveryAttempt> {
  try {
    const response = await input.fetchImpl("https://api.resend.com/emails", {
      method: "POST",
      signal: AbortSignal.timeout(input.timeoutMs),
      headers: {
        authorization: `Bearer ${input.configuration.apiKey}`,
        "content-type": "application/json",
        "idempotency-key": input.idempotencyKey,
        "user-agent": "AAIS-auth-email-outbox/1.0",
      },
      body: JSON.stringify({
        from: input.payload.from,
        to: input.payload.to,
        subject: input.payload.subject,
        text: input.payload.text,
      }),
    });
    if (response.ok) {
      await response.body?.cancel().catch(() => undefined);
      return { status: "sent" };
    }
    const status = response.status;
    const providerError = status === 409
      ? await readResendErrorKind(response)
      : null;
    if (status !== 409) {
      await response.body?.cancel().catch(() => undefined);
    }
    const invalidIdempotency = providerError === "invalid_idempotent_request";
    return {
      status: "failed",
      errorCode: invalidIdempotency
        ? "provider_invalid_idempotency"
        : `provider_${status}`,
      retryable: !invalidIdempotency && (status === 408
        || status === 409
        || status === 425
        || status === 429
        || status >= 500),
      uncertain: !invalidIdempotency
        && (status === 408 || status === 409 || status >= 500),
    };
  } catch {
    return {
      status: "failed",
      errorCode: "transport_error",
      retryable: true,
      uncertain: true,
    };
  }
}

async function readResendErrorKind(response: Response) {
  try {
    const parsed = await readAaisBoundedResponseJson(
      response,
      4_096,
      "AAIS email provider error response is too large.",
    );
    if (!isPlainRecord(parsed)) {
      return null;
    }
    const value = typeof parsed.name === "string"
      ? parsed.name
      : typeof parsed.code === "string" ? parsed.code : null;
    return value && /^[a-z0-9_]{1,64}$/.test(value) ? value : null;
  } catch {
    return null;
  }
}

function encryptAuthEmailPayload(input: {
  configuration: AaisAuthDeliveryConfiguration;
  id: string;
  purpose: AaisAuthEmailPurpose;
  authTokenId: string;
  authTokenHash: string;
  idempotencyKey: string;
  recipient: string;
  payload: AaisAuthEmailPayload;
}): AaisAuthEmailPayloadEnvelope {
  const nonce = randomBytes(12);
  const cipher = createCipheriv(
    "aes-256-gcm",
    deriveAuthEmailKey(input.configuration.encryptionSecret),
    nonce,
  );
  cipher.setAAD(createAuthEmailAad(input));
  const ciphertext = Buffer.concat([
    cipher.update(JSON.stringify(input.payload), "utf8"),
    cipher.final(),
  ]);
  return {
    version: 1,
    nonce: nonce.toString("base64url"),
    tag: cipher.getAuthTag().toString("base64url"),
    ciphertext: ciphertext.toString("base64url"),
  };
}

function decryptAuthEmailPayload(input: {
  configuration: AaisAuthDeliveryConfiguration;
  row: ClaimedAuthEmailRow;
}) {
  const envelope = requirePayloadEnvelope(input.row.payloadEnvelope);
  const nonce = Buffer.from(envelope.nonce, "base64url");
  const tag = Buffer.from(envelope.tag, "base64url");
  const ciphertext = Buffer.from(envelope.ciphertext, "base64url");
  if (nonce.length !== 12 || tag.length !== 16 || !ciphertext.length) {
    throw new Error("Invalid AAIS authentication email payload envelope.");
  }
  const decipher = createDecipheriv(
    "aes-256-gcm",
    deriveAuthEmailKey(input.configuration.encryptionSecret),
    nonce,
  );
  decipher.setAAD(createAuthEmailAad({
    id: input.row.id,
    purpose: input.row.purpose,
    authTokenId: input.row.authTokenId,
    authTokenHash: input.row.authTokenHash,
    idempotencyKey: input.row.idempotencyKey,
    recipient: input.row.recipient,
  }));
  decipher.setAuthTag(tag);
  const plaintext = Buffer.concat([
    decipher.update(ciphertext),
    decipher.final(),
  ]).toString("utf8");
  const payload = requireAuthEmailPayload(JSON.parse(plaintext) as unknown);
  if (payload.to !== input.row.recipient) {
    throw new Error("Invalid AAIS authentication email recipient binding.");
  }
  return payload;
}

function deriveAuthEmailKey(secret: string) {
  return Buffer.from(hkdfSync(
    "sha256",
    Buffer.from(secret, "utf8"),
    authEmailKeySalt,
    authEmailKeyInfo,
    32,
  ));
}

function createAuthEmailAad(input: {
  id: string;
  purpose: AaisAuthEmailPurpose;
  authTokenId: string;
  authTokenHash: string;
  idempotencyKey: string;
  recipient: string;
}) {
  return Buffer.from(JSON.stringify([
    authEmailAadPrefix,
    1,
    input.id,
    input.purpose,
    input.authTokenId,
    input.authTokenHash,
    input.recipient,
    input.idempotencyKey,
  ]), "utf8");
}

function parseClaimedAuthEmailRow(row: Record<string, unknown>): ClaimedAuthEmailRow {
  const id = String(row.id ?? "");
  const purpose = row.purpose;
  const authTokenId = String(row.auth_token_id ?? "");
  const authTokenHash = String(row.auth_token_hash ?? "");
  const authTokenExpiresAt = readDateString(row.auth_token_expires_at);
  const recipient = requireEmailAddress(String(row.recipient ?? ""));
  const idempotencyKey = String(row.idempotency_key ?? "");
  const attemptCount = Number(row.attempt_count);
  const firstAttemptAt = readDateString(row.first_attempt_at);
  const uncertainSince = row.uncertain_since ? readDateString(row.uncertain_since) : null;
  if (
    !isUuid(id)
    || !isAaisAuthEmailPurpose(purpose)
    || !/^auth-(?:invite|reset)-[a-f0-9]{24}$/.test(authTokenId)
    || !/^[a-f0-9]{64}$/.test(authTokenHash)
    || !/^aais_auth_email_[0-9a-f-]{36}$/.test(idempotencyKey)
    || !Number.isSafeInteger(attemptCount)
    || attemptCount < 1
  ) {
    throw new Error("Invalid AAIS authentication email outbox row.");
  }
  return {
    id,
    purpose,
    authTokenId,
    authTokenHash,
    authTokenExpiresAt,
    recipient,
    payloadEnvelope: requirePayloadEnvelope(row.payload_envelope),
    idempotencyKey,
    attemptCount,
    firstAttemptAt,
    uncertainSince,
  };
}

function parseReconciliationResult(
  row: Record<string, unknown>,
  outboxId: string,
  disposition: AaisAuthEmailReconciliationDisposition,
): AaisAuthEmailReconciliationResult {
  const status = row.status;
  const tokenState = row.token_state;
  const reconciledAt = readDateString(row.reconciled_at);
  if (
    String(row.id ?? "") !== outboxId
    || row.disposition !== disposition
    || (disposition === "sent" && (status !== "sent" || tokenState !== "delivered"))
    || (disposition === "not_sent" && (status !== "dead" || tokenState !== "idle"))
  ) {
    throw new AaisAuthEmailReconciliationConflictError();
  }
  return {
    outboxId,
    disposition,
    status: disposition === "sent" ? "sent" : "dead",
    tokenState: disposition === "sent" ? "delivered" : "idle",
    reissueAllowed: disposition === "not_sent",
    reconciledAt,
  };
}

function requireReconciliationDisposition(
  value: unknown,
): AaisAuthEmailReconciliationDisposition {
  if (value !== "sent" && value !== "not_sent") {
    throw new Error("Invalid AAIS authentication email reconciliation disposition.");
  }
  return value;
}

function requireProviderEvidence(
  value: unknown,
  disposition: AaisAuthEmailReconciliationDisposition,
  reconciledAt: Date,
): AaisAuthEmailProviderEvidence {
  if (
    !isPlainRecord(value)
    || value.provider !== "resend"
    || typeof value.messageId !== "string"
    || !/^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$/.test(value.messageId)
    || typeof value.status !== "string"
    || typeof value.observedAt !== "string"
    || Object.keys(value).some((key) =>
      !["provider", "messageId", "status", "observedAt"].includes(key))
  ) {
    throw new Error("Invalid AAIS authentication email provider evidence.");
  }
  const allowedStatuses = disposition === "sent"
    ? ["sent", "delivered"]
    : ["failed", "bounced", "canceled", "suppressed"];
  if (!allowedStatuses.includes(value.status)) {
    throw new Error("AAIS authentication email provider evidence does not match the disposition.");
  }
  const observedAt = new Date(value.observedAt);
  if (
    !Number.isFinite(observedAt.getTime())
    || observedAt.toISOString() !== value.observedAt
    || observedAt.getTime() > reconciledAt.getTime()
  ) {
    throw new Error("Invalid AAIS authentication email provider observation time.");
  }
  return {
    provider: "resend",
    messageId: value.messageId,
    status: value.status as AaisAuthEmailProviderEvidence["status"],
    observedAt: value.observedAt,
  };
}

function requireReconciliationActorId(value: unknown) {
  if (typeof value !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(value)) {
    throw new Error("Invalid AAIS authentication email reconciliation actor.");
  }
  return value;
}

function requireUuid(value: unknown, label: string) {
  const candidate = typeof value === "string" ? value : "";
  if (!isUuid(candidate)) {
    throw new Error(`Invalid AAIS authentication email ${label}.`);
  }
  return candidate.toLowerCase();
}

function readFailClosedUncertainSince(value: unknown, fallback: Date) {
  if (value === null || value === undefined || value === "") {
    return null;
  }
  try {
    return readDateString(value);
  } catch {
    return fallback.toISOString();
  }
}

function isReconciliationEvidenceConflictDatabaseError(error: unknown) {
  if (!error || typeof error !== "object") {
    return false;
  }
  const candidate = error as { code?: unknown; constraint?: unknown };
  return candidate.code === "23505"
    && candidate.constraint === "aais_auth_email_outbox_reconciliation_evidence_key";
}

function requirePayloadEnvelope(value: unknown): AaisAuthEmailPayloadEnvelope {
  let envelope: unknown = value;
  if (typeof envelope === "string") {
    envelope = JSON.parse(envelope) as unknown;
  }
  if (
    !isPlainRecord(envelope)
    || envelope.version !== 1
    || typeof envelope.nonce !== "string"
    || typeof envelope.tag !== "string"
    || typeof envelope.ciphertext !== "string"
    || !isCanonicalBase64Url(envelope.nonce, 12)
    || !isCanonicalBase64Url(envelope.tag, 16)
    || !isCanonicalBase64Url(envelope.ciphertext, undefined, 96 * 1_024)
    || Object.keys(envelope).some((key) =>
      !["version", "nonce", "tag", "ciphertext"].includes(key))
  ) {
    throw new Error("Invalid AAIS authentication email payload envelope.");
  }
  return {
    version: 1,
    nonce: envelope.nonce,
    tag: envelope.tag,
    ciphertext: envelope.ciphertext,
  };
}

function requireAuthEmailPayload(value: unknown): AaisAuthEmailPayload {
  if (
    !isPlainRecord(value)
    || typeof value.from !== "string"
    || typeof value.to !== "string"
    || typeof value.subject !== "string"
    || typeof value.text !== "string"
    || Object.keys(value).some((key) => !["from", "to", "subject", "text"].includes(key))
    || !isSafeEmailFrom(value.from)
  ) {
    throw new Error("Invalid AAIS authentication email payload.");
  }
  const to = requireEmailAddress(value.to);
  const subject = value.subject.trim();
  if (
    !subject
    || subject.length > maximumAuthEmailSubjectCharacters
    || /[\r\n]/.test(subject)
    || !value.text
    || Buffer.byteLength(value.text, "utf8") > maximumAuthEmailBodyBytes
  ) {
    throw new Error("Invalid AAIS authentication email payload.");
  }
  return {
    from: value.from,
    to,
    subject,
    text: value.text,
  };
}

function parseSafeAppBaseUrl(value: string, production: boolean) {
  try {
    const url = new URL(value);
    if (
      !url.hostname
      || url.username
      || url.password
      || url.search
      || url.hash
      || (url.pathname !== "/" && url.pathname !== "")
      || (production ? url.protocol !== "https:" : !["http:", "https:"].includes(url.protocol))
      || (production && isLocalHostname(url.hostname))
    ) {
      return null;
    }
    return url.origin;
  } catch {
    return null;
  }
}

function isLocalHostname(hostname: string) {
  const normalized = hostname.toLowerCase().replace(/^\[|\]$/g, "");
  if (
    normalized === "localhost"
    || normalized.endsWith(".localhost")
    || normalized === "::1"
    || normalized === "0.0.0.0"
    || normalized.startsWith("127.")
    || normalized.startsWith("10.")
    || normalized.startsWith("192.168.")
    || normalized.startsWith("169.254.")
  ) {
    return true;
  }
  const secondOctet = Number.parseInt(normalized.split(".")[1] ?? "", 10);
  return normalized.startsWith("172.") && secondOctet >= 16 && secondOctet <= 31;
}

function isSafeResendApiKey(value: string) {
  return value.startsWith("re_") && isAaisStrongOpaqueSecret(value);
}

function isSafeEmailFrom(value: string) {
  if (!value || value.length > 320 || /[\r\n]/.test(value)) {
    return false;
  }
  if (value.includes(",") || (value.includes("<") !== value.includes(">"))) {
    return false;
  }
  const displayMatch = value.match(/^([^<>]{1,100}) <([^<>]+)>$/);
  if ((value.includes("<") || value.includes(">")) && !displayMatch) {
    return false;
  }
  const address = displayMatch?.[2] ?? value;
  return /^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/.test(address.trim());
}

function requireEmailAddress(value: string) {
  const email = value.trim().toLowerCase();
  if (!/^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/.test(email) || email.length > 254) {
    throw new Error("Invalid AAIS authentication email recipient.");
  }
  return email;
}

function isAaisAuthEmailPurpose(value: unknown): value is AaisAuthEmailPurpose {
  return value === "invite" || value === "password_reset";
}

function isUuid(value: string) {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function readDateString(value: unknown) {
  const parsed = value instanceof Date ? value : new Date(String(value));
  if (!Number.isFinite(parsed.getTime())) {
    throw new Error("Invalid AAIS authentication email timestamp.");
  }
  return parsed.toISOString();
}

function isExpiredDeliveryWindow(firstAttemptAt: string, now: Date) {
  return now.getTime() - Date.parse(firstAttemptAt) >= resendIdempotencyWindowGuardMs;
}

function retryDelayMs(id: string, attemptCount: number) {
  const base = Math.min(4 * 60 * 60 * 1_000, 60_000 * (2 ** Math.max(0, attemptCount - 1)));
  const jitter = Number.parseInt(id.replaceAll("-", "").slice(-4), 16) % 10_001;
  return base + jitter;
}

function readUuid(value: unknown) {
  const candidate = String(value ?? "");
  return isUuid(candidate) ? candidate : null;
}

function isCanonicalBase64Url(value: string, exactBytes?: number, maximumCharacters = 96 * 1_024) {
  if (!value || value.length > maximumCharacters || !/^[A-Za-z0-9_-]+$/.test(value)) {
    return false;
  }
  const decoded = Buffer.from(value, "base64url");
  return (exactBytes === undefined || decoded.length === exactBytes)
    && decoded.toString("base64url") === value;
}

function readBoundedInteger(
  value: number | undefined,
  fallback: number,
  minimum: number,
  maximum: number,
) {
  if (!Number.isFinite(value)) {
    return fallback;
  }
  return Math.min(maximum, Math.max(minimum, Math.trunc(value!)));
}

function getConfiguredAuthEmailOutboxDatabase(
  env: Record<string, string | undefined>,
) {
  const configuration = getAaisDatabaseConfiguration();
  if (!configuration) {
    return null;
  }
  if (!cachedOutboxDatabase || cachedOutboxDatabase.url !== configuration.url) {
    cachedOutboxDatabase = {
      url: configuration.url,
      client: createAuthEmailOutboxDatabase(configuration.url, env),
    };
  }
  return cachedOutboxDatabase.client;
}

function createAuthEmailOutboxDatabase(
  databaseUrl: string,
  env: Record<string, string | undefined>,
): AaisDatabaseClient {
  if (shouldUseNeonServerlessDriver(databaseUrl, env)) {
    return createAaisNeonQueryClient(databaseUrl);
  }
  return getAaisSharedPostgresPool(databaseUrl, env) as AaisDatabaseClient;
}

function shouldUseNeonServerlessDriver(
  databaseUrl: string,
  env: Record<string, string | undefined>,
) {
  const configuredDriver = env.AAIS_DATABASE_DRIVER?.trim().toLowerCase();
  if (configuredDriver === "pg") {
    return false;
  }
  if (configuredDriver === "neon-serverless") {
    return true;
  }
  try {
    return new URL(databaseUrl).hostname.toLowerCase().endsWith(".neon.tech");
  } catch {
    return false;
  }
}

function isProductionRuntime(env: Record<string, string | undefined>) {
  return env.NODE_ENV === "production" || env.VERCEL_ENV === "production";
}
