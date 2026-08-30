import { createHash, randomBytes } from "node:crypto";
import type { AaisSessionActor } from "@/lib/server/aais-session";
import {
  getAaisDatabaseConfiguration,
  type AaisDatabaseClient,
} from "@/lib/server/aais-learning-store";
import {
  createAaisPasswordRecordAsync,
  verifyAaisPasswordCandidate,
  type AaisPasswordRecord,
} from "@/lib/server/aais-password-kdf";
import {
  createAaisAuthEmailOutboxMessage,
  requireAaisAuthDeliveryConfiguration,
} from "@/lib/server/aais-auth-delivery";
import { getAaisSharedPostgresPool } from "@/lib/server/aais-postgres-pool";

type PasswordRecord = AaisPasswordRecord;

type AaisUserRole = AaisSessionActor["role"];
type AaisUserStatus = "invited" | "active" | "disabled";
type AaisAuthTokenPurpose = "invite" | "password_reset";

export type AaisUserListItem = {
  id: string;
  email: string;
  displayName: string;
  role: AaisUserRole;
  status: AaisUserStatus;
  createdAt: string;
  updatedAt: string;
  lastLoginAt: string | null;
};

export type AaisUserInviteResult = {
  user: AaisUserListItem;
  token: string;
  setPasswordUrl: string;
  delivery: AaisAuthEmailDelivery;
};

export type AaisPasswordResetResult = {
  user: AaisUserListItem;
  token: string;
  resetUrl: string;
  delivery: AaisAuthEmailDelivery;
};

export type AaisAuthEmailDelivery = {
  status: "queued";
  provider: "resend";
};

type AaisUserAuthResult =
  | {
      status: "ok";
      actor: AaisSessionActor;
      authVersion: number;
    }
  | {
      status: "invalid";
    }
  | {
      status: "not_found";
    }
  | {
      status: "not_configured";
    };

export type AaisDatabaseSessionActorResolution =
  | {
      status: "active";
      actor: AaisSessionActor;
      authVersion: number;
    }
  | {
      status: "inactive" | "not_found" | "not_configured";
    };

type StoreInput = {
  database?: AaisDatabaseClient | null;
  appBaseUrl?: string;
  env?: Record<string, string | undefined>;
  /** Retained for source compatibility; auth email delivery is asynchronous. */
  fetchImpl?: typeof fetch;
  now?: () => Date;
  /** Retained for source compatibility; the outbox worker owns provider timeouts. */
  emailTimeoutMs?: number;
  passwordVerifier?: typeof verifyAaisPasswordCandidate;
  passwordRecordCreator?: typeof createAaisPasswordRecordAsync;
};

let cachedDatabase: {
  url: string;
  client: AaisDatabaseClient;
} | null = null;

const defaultCourseId = "cognitive-apprenticeship";
const defaultCohort = "default";
const activeAdminInvariantConstraint = "aais_users_active_admin_invariant";
const activeAdminInvariantMessage = "AAIS active administrator invariant violation.";
const authEmailDeliveryFenceMessage = "AAIS_AUTH_EMAIL_DELIVERY_FENCED";

export async function authenticateAaisUserAccount(
  accountId: string,
  password: string,
) {
  try {
    return await createAaisUserStore().authenticate(accountId, password);
  } catch (error) {
    if (isAaisUserStoreConfigurationError(error)) {
      return { status: "schema_unavailable" as const };
    }
    throw error;
  }
}

export async function resolveAaisDatabaseSessionActor(
  actorId: string,
  input: { database?: AaisDatabaseClient | null } = {},
): Promise<AaisDatabaseSessionActorResolution> {
  const database = input.database === undefined ? getConfiguredUserDatabaseClient() : input.database;
  if (!database) {
    return { status: "not_configured" };
  }
  const result = await database.query(
    `select id, display_name, role, status, auth_version
       from aais_users
      where id = $1
      limit 1`,
    [actorId],
  );
  const row = result.rows[0];
  if (!row) {
    return { status: "not_found" };
  }
  if (!isAaisUserRole(row.role) || !isAaisUserStatus(row.status)) {
    throw new Error("Invalid AAIS session actor row.");
  }
  if (row.status !== "active") {
    return { status: "inactive" };
  }
  return {
    status: "active",
      actor: {
        id: String(row.id),
        role: row.role,
        displayName: String(row.display_name),
      },
      authVersion: readAuthVersion(row.auth_version),
  };
}

export function createAaisUserStore(input: StoreInput = {}) {
  const database = input.database === undefined ? getConfiguredUserDatabaseClient() : input.database;
  const now = input.now ?? (() => new Date());
  const baseEnv = input.env ?? process.env;
  const deliveryEnv = input.appBaseUrl === undefined
    ? baseEnv
    : { ...baseEnv, AAIS_APP_BASE_URL: input.appBaseUrl };
  const passwordVerifier = input.passwordVerifier ?? verifyAaisPasswordCandidate;
  const passwordRecordCreator = input.passwordRecordCreator ?? createAaisPasswordRecordAsync;

  async function authenticate(accountId: string, password: string): Promise<AaisUserAuthResult> {
    if (!database) {
      return { status: "not_configured" };
    }
    const normalizedAccount = normalizeAaisEmailOrId(accountId);
    const result = await database.query(
      `select id, email, display_name, role, status, password,
              auth_version
       from aais_users
       where normalized_email = $1 or lower(id) = $1
       limit 1`,
      [normalizedAccount],
    ).catch((error: unknown) => {
      if (isMissingAaisUserSchemaError(error)) {
        throw new AaisUserStoreConfigurationError();
      }
      throw error;
    });
    const row = result.rows[0];
    const identityActive = Boolean(
      row
      && row.status === "active"
      && isAaisUserRole(row.role),
    );
    const passwordRecord = identityActive ? parsePasswordRecord(row?.password) : null;
    const passwordValid = await passwordVerifier(password, passwordRecord);
    if (!row) {
      return { status: "not_found" };
    }
    if (!identityActive) {
      return { status: "invalid" };
    }
    if (!passwordRecord || !passwordValid) {
      return { status: "invalid" };
    }
    const authVersion = readAuthVersion(row.auth_version);
    const updated = await database.query(
      `update aais_users
          set last_login_at = $2::timestamptz,
              updated_at = $2::timestamptz
        where id = $1
          and status = 'active'
          and auth_version = $3
        returning id, display_name, role, auth_version`,
      [String(row.id), now().toISOString(), authVersion],
    );
    const current = updated.rows[0];
    if (!current || !isAaisUserRole(current.role)) {
      return { status: "invalid" };
    }
    return {
      status: "ok",
      actor: {
        id: String(current.id),
        role: current.role,
        displayName: String(current.display_name),
      },
      authVersion: readAuthVersion(current.auth_version),
    };
  }

  async function listUsers() {
    const requiredDatabase = requireDatabase();
    const result = await requiredDatabase.query(
      `select id, email, display_name, role, status, created_at, updated_at, last_login_at
       from aais_users
       order by updated_at desc, email asc`,
    );
    return result.rows.map(parseUserListItem);
  }

  async function createInvite(input: {
    email: string;
    displayName: string;
    role: AaisUserRole;
    createdBy: string;
  }): Promise<AaisUserInviteResult> {
    const requiredDatabase = requireDatabase();
    const email = normalizeAaisEmail(input.email);
    const displayName = requireDisplayName(input.displayName);
    const role = requireAaisUserRole(input.role);
    const deliveryConfiguration = requireAaisAuthDeliveryConfiguration(deliveryEnv);
    const userId = createAaisUserId(email);
    const issuedAt = now();
    const token = createRawAuthToken("invite");
    const tokenId = createInviteSlotId(email);
    const tokenHash = hashAuthToken(token);
    const expiresAt = new Date(issuedAt.getTime() + 7 * 24 * 60 * 60 * 1000).toISOString();
    const issuedAtIso = issuedAt.toISOString();
    const courseId = readConfiguredCatalogId(
      process.env.AAIS_DEFAULT_COURSE_ID,
      defaultCourseId,
      "course id",
    );
    const cohort = readConfiguredCohort(process.env.AAIS_DEFAULT_COHORT, defaultCohort);
    const setPasswordUrl = buildAuthUrl(
      deliveryConfiguration.appBaseUrl,
      "/login",
      token,
      "invite_token",
    );
    const queuedMessage = createAaisAuthEmailOutboxMessage({
      configuration: deliveryConfiguration,
      purpose: "invite",
      authTokenId: tokenId,
      authTokenHash: tokenHash,
      recipient: email,
      subject: "AAIS account invitation",
      text: `Use this one-time link to set your AAIS password: ${setPasswordUrl}`,
    });

    const result = await requiredDatabase.query(
      `with invited_user as (
         insert into aais_users (
           id,
           email,
           normalized_email,
           display_name,
           role,
           status,
           invited_by,
           created_at,
           updated_at
         )
         values ($1, $2, $2, $3, $4, 'invited', $5, $6::timestamptz, $6::timestamptz)
         on conflict (normalized_email) do update
         set
           display_name = excluded.display_name,
           role = excluded.role,
           status = 'invited',
           invited_by = excluded.invited_by,
           auth_version = aais_users.auth_version + 1,
           updated_at = excluded.updated_at
         where aais_users.status = 'invited'
         returning id, email, display_name, role, status, created_at, updated_at, last_login_at
       ),
       invalidated_invites as (
         update aais_user_auth_tokens token
            set consumed_at = $6::timestamptz
           from invited_user invited
          where token.user_id = invited.id
            and token.purpose = 'invite'
            and token.id <> $7
            and token.consumed_at is null
          returning token.id
       ),
       inserted_token as (
         insert into aais_user_auth_tokens (
           id,
           user_id,
           purpose,
           token_hash,
           created_by,
           expires_at,
           consumed_at,
           created_at
         )
         select $7, invited.id, 'invite', $8, $5, $9::timestamptz, null, $6::timestamptz
           from invited_user invited
          cross join (select count(*) from invalidated_invites) invalidation_barrier
         on conflict (id) do update
         set
           user_id = excluded.user_id,
           purpose = excluded.purpose,
           token_hash = excluded.token_hash,
           created_by = excluded.created_by,
           expires_at = excluded.expires_at,
           consumed_at = null,
           created_at = excluded.created_at,
           email_delivery_state = 'idle',
           email_delivery_outbox_id = null,
           email_delivery_claim_id = null,
           email_delivery_started_at = null
         returning id, user_id, purpose, token_hash
       ),
       upserted_enrollment as (
         insert into aais_enrollments (
           course_id,
           user_id,
           cohort,
           role,
           status,
           enrolled_at,
           updated_at
         )
         select $10, invited.id, $11, invited.role,
                case when invited.status = 'disabled' then 'withdrawn' else 'active' end,
                $6::timestamptz, $6::timestamptz
           from invited_user invited
           join inserted_token token on token.user_id = invited.id
         on conflict (course_id, user_id) do update
         set
           role = excluded.role,
           status = excluded.status,
           updated_at = excluded.updated_at
         returning user_id
       ),
       queued_email as (
         insert into public.aais_auth_email_outbox (
           id, purpose, auth_token_id, auth_token_hash,
           recipient, payload_envelope, idempotency_key, status,
           attempt_count, next_attempt_at, created_at, updated_at
         )
         select $12::uuid, token.purpose, token.id, token.token_hash,
                $2, $13::jsonb, $14, 'pending',
                0, $6::timestamptz, $6::timestamptz, $6::timestamptz
           from invited_user invited
           join inserted_token token on token.user_id = invited.id
           join upserted_enrollment enrollment on enrollment.user_id = invited.id
         returning auth_token_id
       )
       select invited.*
         from invited_user invited
         join inserted_token token on token.user_id = invited.id
         join upserted_enrollment enrollment on enrollment.user_id = invited.id
         join queued_email queued on queued.auth_token_id = token.id`,
      [
        userId,
        email,
        displayName,
        role,
        input.createdBy,
        issuedAtIso,
        tokenId,
        tokenHash,
        expiresAt,
        courseId,
        cohort,
        queuedMessage.id,
        JSON.stringify(queuedMessage.payloadEnvelope),
        queuedMessage.idempotencyKey,
      ],
    ).catch((error: unknown) => {
      if (isAuthEmailDeliveryFenceDatabaseError(error)) {
        throw new AaisAuthEmailDeliveryFencedError();
      }
      throw error;
    });
    if (!result.rows[0]) {
      throw new AaisUserInviteConflictError();
    }
    const user = parseUserListItem(result.rows[0]);
    return {
      user,
      token,
      setPasswordUrl,
      delivery: { status: "queued", provider: "resend" },
    };
  }

  async function createPasswordReset(input: {
    email: string;
    createdBy: string;
  }): Promise<AaisPasswordResetResult | null> {
    const requiredDatabase = requireDatabase();
    const email = normalizeAaisEmail(input.email);
    const deliveryConfiguration = requireAaisAuthDeliveryConfiguration(deliveryEnv);
    const issuedAt = now();
    const token = createRawAuthToken("password_reset");
    const tokenId = createPasswordResetSlotId(email);
    const tokenHash = hashAuthToken(token);
    const expiresAt = new Date(issuedAt.getTime() + 2 * 60 * 60 * 1000).toISOString();
    const issuedAtIso = issuedAt.toISOString();
    const resetUrl = buildAuthUrl(
      deliveryConfiguration.appBaseUrl,
      "/login",
      token,
      "reset_token",
    );
    const queuedMessage = createAaisAuthEmailOutboxMessage({
      configuration: deliveryConfiguration,
      purpose: "password_reset",
      authTokenId: tokenId,
      authTokenHash: tokenHash,
      recipient: email,
      subject: "AAIS password reset",
      text: `Use this one-time link to reset your AAIS password: ${resetUrl}`,
    });
    const result = await requiredDatabase.query(
      `with reset_user as materialized (
         select id, email, display_name, role, status, created_at, updated_at, last_login_at
           from aais_users
          where normalized_email = $1
            and status <> 'disabled'
          limit 1
          for no key update
       ),
       invalidated_reset_tokens as (
         update aais_user_auth_tokens token
            set consumed_at = $6::timestamptz
           from reset_user account
          where token.user_id = account.id
            and token.purpose = 'password_reset'
            and token.id <> $2
            and token.consumed_at is null
          returning token.id
       ),
       inserted_reset_token as (
         insert into aais_user_auth_tokens (
           id,
           user_id,
           purpose,
           token_hash,
           created_by,
           expires_at,
           consumed_at,
           created_at
         )
         select $2, account.id, 'password_reset', $3, $4, $5::timestamptz, null, $6::timestamptz
           from reset_user account
          cross join (select count(*) from invalidated_reset_tokens) invalidation_barrier
         on conflict (id) do update
         set
           user_id = excluded.user_id,
           purpose = excluded.purpose,
           token_hash = excluded.token_hash,
           created_by = excluded.created_by,
           expires_at = excluded.expires_at,
           consumed_at = null,
           created_at = excluded.created_at,
           email_delivery_state = 'idle',
           email_delivery_outbox_id = null,
           email_delivery_claim_id = null,
           email_delivery_started_at = null
         returning id, user_id, purpose, token_hash
       ),
       queued_email as (
         insert into public.aais_auth_email_outbox (
           id, purpose, auth_token_id, auth_token_hash,
           recipient, payload_envelope, idempotency_key, status,
           attempt_count, next_attempt_at, created_at, updated_at
         )
         select $7::uuid, token.purpose, token.id, token.token_hash,
                $1, $8::jsonb, $9, 'pending',
                0, $6::timestamptz, $6::timestamptz, $6::timestamptz
           from reset_user account
           join inserted_reset_token token on token.user_id = account.id
         returning auth_token_id
       )
       select account.*
         from reset_user account
         join inserted_reset_token token on token.user_id = account.id
         join queued_email queued on queued.auth_token_id = token.id`,
      [
        email,
        tokenId,
        tokenHash,
        input.createdBy,
        expiresAt,
        issuedAtIso,
        queuedMessage.id,
        JSON.stringify(queuedMessage.payloadEnvelope),
        queuedMessage.idempotencyKey,
      ],
    ).catch((error: unknown) => {
      if (isAuthEmailDeliveryFenceDatabaseError(error)) {
        throw new AaisAuthEmailDeliveryFencedError();
      }
      throw error;
    });
    if (!result.rows[0]) {
      return null;
    }
    const user = parseUserListItem(result.rows[0]);
    return {
      user,
      token,
      resetUrl,
      delivery: { status: "queued", provider: "resend" },
    };
  }

  async function updateUserAccess(input: {
    userId: string;
    role: AaisUserRole;
    status: AaisUserStatus;
    updatedBy: string;
  }) {
    const requiredDatabase = requireDatabase();
    const userId = requireAaisUserId(input.userId);
    const role = requireAaisUserRole(input.role);
    const status = requireAaisUserStatus(input.status);
    const updatedAt = now().toISOString();
    const courseId = readConfiguredCatalogId(
      process.env.AAIS_DEFAULT_COURSE_ID,
      defaultCourseId,
      "course id",
    );
    const cohort = readConfiguredCohort(process.env.AAIS_DEFAULT_COHORT, defaultCohort);
    const result = await requiredDatabase.query(
      `with updated_user as (
         update aais_users
            set role = $2,
                status = $3,
                updated_at = $4::timestamptz,
                auth_version = auth_version + 1
          where id = $1
          returning id, email, display_name, role, status, created_at, updated_at, last_login_at
       ),
       upserted_enrollment as (
         insert into aais_enrollments (
           course_id,
           user_id,
           cohort,
           role,
           status,
           enrolled_at,
           updated_at
         )
         select $5, account.id, $6, account.role,
                case when account.status = 'disabled' then 'withdrawn' else 'active' end,
                $4::timestamptz, $4::timestamptz
           from updated_user account
         on conflict (course_id, user_id) do update
         set
           role = excluded.role,
           status = excluded.status,
           updated_at = excluded.updated_at
         returning user_id
       )
       select account.*
         from updated_user account
         join upserted_enrollment enrollment on enrollment.user_id = account.id`,
      [userId, role, status, updatedAt, courseId, cohort],
    ).catch((error: unknown) => {
      if (isActiveAdminInvariantDatabaseError(error)) {
        throw new AaisActiveAdminInvariantError();
      }
      throw error;
    });
    const row = result.rows[0];
    if (!row) {
      throw new AaisUserNotFoundError();
    }
    return parseUserListItem(row);
  }

  async function setPasswordWithToken(input: {
    token: string;
    password: string;
  }) {
    const requiredDatabase = requireDatabase();
    const password = requireStrongEnoughPassword(input.password);
    const tokenHash = hashAuthToken(requireRawAuthToken(input.token));
    const preflightAt = now().toISOString();
    const preflight = await requiredDatabase.query(
      `select token.id
         from aais_user_auth_tokens token
         join aais_users account on account.id = token.user_id
        where token.token_hash = $1
          and token.purpose in ('invite', 'password_reset')
          and token.consumed_at is null
          and token.expires_at > $2::timestamptz
          and account.status <> 'disabled'
        limit 1`,
      [tokenHash, preflightAt],
    ).catch((error: unknown) => {
      if (isMissingAaisUserSchemaError(error)) {
        throw new AaisUserStoreConfigurationError();
      }
      throw error;
    });
    if (!preflight.rows[0]) {
      throw new AaisAuthTokenError();
    }
    const passwordRecord = await passwordRecordCreator(password);
    const updatedAt = now().toISOString();
    const result = await requiredDatabase.query(
      `with token_candidate as materialized (
         select token.id as token_id, token.user_id,
                token.email_delivery_outbox_id
           from aais_user_auth_tokens token
           join aais_users account on account.id = token.user_id
          where token.token_hash = $1
            and token.purpose in ('invite', 'password_reset')
            and token.consumed_at is null
            and token.expires_at > $3::timestamptz
            and account.status <> 'disabled'
          limit 1
       ),
       locked_user as materialized (
         select account.id
           from aais_users account
           join token_candidate candidate on candidate.user_id = account.id
          where account.status <> 'disabled'
          for no key update of account
       ),
       claimed_token as (
         update aais_user_auth_tokens token
            set consumed_at = $3::timestamptz,
                email_delivery_state = 'idle',
                email_delivery_outbox_id = null,
                email_delivery_claim_id = null,
                email_delivery_started_at = null
           from token_candidate candidate
           join locked_user account on account.id = candidate.user_id
          where token.id = candidate.token_id
            and token.user_id = candidate.user_id
            and token.token_hash = $1
            and token.purpose in ('invite', 'password_reset')
            and token.consumed_at is null
            and token.expires_at > $3::timestamptz
          returning token.id as token_id, token.user_id,
                    candidate.email_delivery_outbox_id
       ),
       updated_user as (
         update aais_users target
            set password = $2::jsonb,
                status = 'active',
                updated_at = $3::timestamptz,
                auth_version = target.auth_version + 1
           from claimed_token claimed
          where target.id = claimed.user_id
          returning target.id, target.email, target.display_name, target.role, target.status,
                    target.created_at, target.updated_at, target.last_login_at,
                    target.auth_version
       ),
       invalidated_tokens as (
         update aais_user_auth_tokens token
            set consumed_at = $3::timestamptz,
                email_delivery_state = 'idle',
                email_delivery_outbox_id = null,
                email_delivery_claim_id = null,
                email_delivery_started_at = null
           from claimed_token claimed, updated_user updated
          where token.user_id = updated.id
            and token.id <> claimed.token_id
            and token.consumed_at is null
          returning token.id
       ),
       resolved_email_delivery as (
         update public.aais_auth_email_outbox email
            set status = 'sent',
                claim_id = null,
                claimed_at = null,
                lease_expires_at = null,
                sent_at = coalesce(email.sent_at, $3::timestamptz),
                dead_lettered_at = null,
                uncertain_since = null,
                last_error_code = 'token_consumed',
                updated_at = $3::timestamptz
           from claimed_token claimed
          where email.id = claimed.email_delivery_outbox_id
            and email.auth_token_id = claimed.token_id
            and email.status in ('sending', 'retry', 'dead')
          returning email.id
       )
       select updated.*,
              (select count(*)::integer from invalidated_tokens) as sibling_tokens_consumed,
              (select count(*)::integer from resolved_email_delivery) as delivery_rows_resolved
         from updated_user updated`,
      [tokenHash, JSON.stringify(passwordRecord), updatedAt],
    );
    if (!result.rows[0]) {
      throw new AaisAuthTokenError();
    }
    return parseUserListItem(result.rows[0]);
  }

  function requireDatabase() {
    if (!database) {
      throw new AaisUserStoreConfigurationError();
    }
    return database;
  }

  function buildAuthUrl(baseUrl: string, path: string, token: string, param: string) {
    const url = new URL(path, baseUrl);
    // URL fragments are not sent in HTTP requests or Referer headers. Keep
    // one-time credential material out of server, proxy and navigation logs.
    url.hash = new URLSearchParams({ [param]: token }).toString();
    return url.toString();
  }

  return {
    authenticate,
    createInvite,
    createPasswordReset,
    listUsers,
    setPasswordWithToken,
    updateUserAccess,
  };
}

export class AaisUserStoreConfigurationError extends Error {
  constructor() {
    super("AAIS user store requires Postgres configuration.");
    this.name = "AaisUserStoreConfigurationError";
  }
}

export class AaisAuthTokenError extends Error {
  constructor() {
    super("AAIS auth token is invalid or expired.");
    this.name = "AaisAuthTokenError";
  }
}

export class AaisUserNotFoundError extends Error {
  constructor() {
    super("AAIS user was not found.");
    this.name = "AaisUserNotFoundError";
  }
}

export class AaisActiveAdminInvariantError extends Error {
  constructor() {
    super("AAIS must retain at least one active administrator.");
    this.name = "AaisActiveAdminInvariantError";
  }
}

export class AaisUserInviteConflictError extends Error {
  constructor() {
    super("AAIS cannot invite an account that is already active or disabled.");
    this.name = "AaisUserInviteConflictError";
  }
}

export class AaisAuthEmailDeliveryFencedError extends Error {
  constructor() {
    super("AAIS authentication email delivery is already in progress.");
    this.name = "AaisAuthEmailDeliveryFencedError";
  }
}

export function isAaisUserStoreConfigurationError(
  error: unknown,
): error is AaisUserStoreConfigurationError {
  return error instanceof AaisUserStoreConfigurationError;
}

export function isAaisAuthTokenError(error: unknown): error is AaisAuthTokenError {
  return error instanceof AaisAuthTokenError;
}

export function isAaisUserNotFoundError(error: unknown): error is AaisUserNotFoundError {
  return error instanceof AaisUserNotFoundError;
}

export function isAaisActiveAdminInvariantError(
  error: unknown,
): error is AaisActiveAdminInvariantError {
  return error instanceof AaisActiveAdminInvariantError;
}

export function isAaisUserInviteConflictError(
  error: unknown,
): error is AaisUserInviteConflictError {
  return error instanceof AaisUserInviteConflictError;
}

export function isAaisAuthEmailDeliveryFencedError(
  error: unknown,
): error is AaisAuthEmailDeliveryFencedError {
  return error instanceof AaisAuthEmailDeliveryFencedError;
}

function isActiveAdminInvariantDatabaseError(error: unknown) {
  if (!error || typeof error !== "object") {
    return false;
  }
  const databaseError = error as {
    code?: unknown;
    constraint?: unknown;
    message?: unknown;
  };
  return databaseError.code === "23514"
    && (
      databaseError.constraint === activeAdminInvariantConstraint
      || databaseError.message === activeAdminInvariantMessage
    );
}

function isAuthEmailDeliveryFenceDatabaseError(error: unknown) {
  if (!error || typeof error !== "object") {
    return false;
  }
  const databaseError = error as { code?: unknown; message?: unknown };
  return databaseError.code === "P0001"
    && databaseError.message === authEmailDeliveryFenceMessage;
}

function isMissingAaisUserSchemaError(error: unknown) {
  if (!error || typeof error !== "object") {
    return false;
  }
  const code = (error as { code?: unknown }).code;
  return code === "42703" || code === "42P01";
}

function parseUserListItem(row: Record<string, unknown> | undefined): AaisUserListItem {
  if (!row || !isAaisUserRole(row.role) || !isAaisUserStatus(row.status)) {
    throw new Error("Invalid AAIS user row.");
  }
  return {
    id: String(row.id),
    email: String(row.email),
    displayName: String(row.display_name),
    role: row.role,
    status: row.status,
    createdAt: readDateString(row.created_at),
    updatedAt: readDateString(row.updated_at),
    lastLoginAt: row.last_login_at ? readDateString(row.last_login_at) : null,
  };
}

function normalizeAaisEmail(value: string) {
  const email = value.trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email.length > 254) {
    throw new Error("Invalid AAIS user email.");
  }
  return email;
}

function normalizeAaisEmailOrId(value: string) {
  const normalized = value.trim().toLowerCase();
  if (!normalized || normalized.length > 254) {
    throw new Error("Invalid AAIS account id.");
  }
  return normalized;
}

function requireDisplayName(value: string) {
  const displayName = value.trim();
  if (!displayName || displayName.length > 120) {
    throw new Error("Invalid AAIS display name.");
  }
  return displayName;
}

function requireAaisUserRole(value: string): AaisUserRole {
  if (!isAaisUserRole(value)) {
    throw new Error("Invalid AAIS user role.");
  }
  return value;
}

function requireAaisUserStatus(value: string): AaisUserStatus {
  if (!isAaisUserStatus(value)) {
    throw new Error("Invalid AAIS user status.");
  }
  return value;
}

function requireAaisUserId(value: string) {
  const userId = value.trim();
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(userId)) {
    throw new Error("Invalid AAIS user id.");
  }
  return userId;
}

function readConfiguredCatalogId(value: string | undefined, fallback: string, label: string) {
  const candidate = value?.trim() || fallback;
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(candidate)) {
    throw new Error(`Invalid AAIS ${label}.`);
  }
  return candidate;
}

function readConfiguredCohort(value: string | undefined, fallback: string) {
  const candidate = value?.trim() || fallback;
  if (!/^[A-Za-z0-9][A-Za-z0-9._: -]{0,127}$/.test(candidate)) {
    throw new Error("Invalid AAIS cohort.");
  }
  return candidate;
}

function isAaisUserRole(value: unknown): value is AaisUserRole {
  return value === "student"
    || value === "teacher"
    || value === "researcher"
    || value === "admin";
}

function isAaisUserStatus(value: unknown): value is AaisUserStatus {
  return value === "invited" || value === "active" || value === "disabled";
}

function createAaisUserId(email: string) {
  return `user-${createHash("sha256").update(`aais-user:${email}`).digest("hex").slice(0, 16)}`;
}

function createRawAuthToken(purpose: AaisAuthTokenPurpose) {
  const prefix = purpose === "invite" ? "aais_invite" : "aais_reset";
  return `${prefix}_${randomBytes(32).toString("base64url")}`;
}

function createInviteSlotId(email: string) {
  return `auth-invite-${createHash("sha256")
    .update(`aais-invite-slot:${email}`)
    .digest("hex")
    .slice(0, 24)}`;
}

function createPasswordResetSlotId(email: string) {
  return `auth-reset-${createHash("sha256")
    .update(`aais-password-reset-slot:${email}`)
    .digest("hex")
    .slice(0, 24)}`;
}

function hashAuthToken(token: string) {
  return createHash("sha256").update(`aais-auth-token:${token}`).digest("hex");
}

function requireRawAuthToken(token: string) {
  if (!/^aais_(invite|reset)_[A-Za-z0-9_-]{32,}$/.test(token)) {
    throw new AaisAuthTokenError();
  }
  return token;
}

function requireStrongEnoughPassword(password: string) {
  if (typeof password !== "string" || password.length < 10 || password.length > 256) {
    throw new Error("AAIS password does not meet length requirements.");
  }
  return password;
}

function parsePasswordRecord(value: unknown): PasswordRecord | null {
  let record: Partial<PasswordRecord> | null | undefined;
  try {
    record = typeof value === "string"
      ? JSON.parse(value) as Partial<PasswordRecord>
      : value as Partial<PasswordRecord> | null | undefined;
  } catch {
    return null;
  }
  if (
    record?.algorithm !== "scrypt"
    || typeof record.salt !== "string"
    || typeof record.hash !== "string"
  ) {
    return null;
  }
  return {
    algorithm: "scrypt",
    salt: record.salt,
    hash: record.hash,
  };
}

function readDateString(value: unknown) {
  if (value instanceof Date) {
    return value.toISOString();
  }
  return new Date(String(value)).toISOString();
}

function readAuthVersion(value: unknown) {
  const parsed = Number(value ?? 1);
  if (!Number.isSafeInteger(parsed) || parsed < 1) {
    throw new Error("Invalid AAIS user auth version.");
  }
  return parsed;
}


function getConfiguredUserDatabaseClient() {
  const config = getAaisDatabaseConfiguration();
  if (!config) {
    return null;
  }
  if (!cachedDatabase || cachedDatabase.url !== config.url) {
    cachedDatabase = {
      url: config.url,
      client: getAaisSharedPostgresPool(config.url) as AaisDatabaseClient,
    };
  }
  return cachedDatabase.client;
}
