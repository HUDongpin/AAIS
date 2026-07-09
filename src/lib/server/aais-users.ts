import { createHash, randomBytes, scryptSync, timingSafeEqual } from "node:crypto";
import { Pool } from "pg";
import type { AaisSessionActor } from "@/lib/server/aais-session";
import {
  getAaisDatabaseConfiguration,
  type AaisDatabaseClient,
} from "@/lib/server/aais-learning-store";
import { createPasswordRecord } from "@/lib/server/aais-trial-accounts";

type PasswordRecord = ReturnType<typeof createPasswordRecord>;

type AaisUserRole = AaisSessionActor["role"];
type AaisUserStatus = "invited" | "active" | "disabled";
type AaisEnrollmentStatus = "active" | "completed" | "withdrawn";
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

export type AaisAuthEmailDelivery =
  | {
      status: "sent";
      provider: "resend";
    }
  | {
      status: "not_configured";
      provider: "resend";
    };

type AaisUserAuthResult =
  | {
      status: "ok";
      actor: AaisSessionActor;
    }
  | {
      status: "invalid";
    }
  | {
      status: "not_configured";
    };

type StoreInput = {
  database?: AaisDatabaseClient | null;
  appBaseUrl?: string;
  fetchImpl?: typeof fetch;
  now?: () => Date;
};

let cachedDatabase: {
  url: string;
  client: AaisDatabaseClient;
} | null = null;

const defaultCourseId = "cognitive-apprenticeship";
const defaultCohort = "default";

export async function authenticateAaisUserAccount(
  accountId: string,
  password: string,
) {
  return createAaisUserStore().authenticate(accountId, password);
}

export function createAaisUserStore(input: StoreInput = {}) {
  const database = input.database === undefined ? getConfiguredUserDatabaseClient() : input.database;
  const now = input.now ?? (() => new Date());
  const appBaseUrl = input.appBaseUrl ?? process.env.AAIS_APP_BASE_URL?.trim() ?? "";
  const fetchImpl = input.fetchImpl ?? fetch;

  async function authenticate(accountId: string, password: string): Promise<AaisUserAuthResult> {
    if (!database) {
      return { status: "not_configured" };
    }
    const normalizedAccount = normalizeAaisEmailOrId(accountId);
    try {
      const result = await database.query(
        `select id, email, display_name, role, status, password
         from aais_users
         where normalized_email = $1 or lower(id) = $1
         limit 1`,
        [normalizedAccount],
      );
      const row = result.rows[0];
      if (!row || row.status !== "active" || !isAaisUserRole(row.role)) {
        return { status: "invalid" };
      }
      const passwordRecord = parsePasswordRecord(row.password);
      if (!passwordRecord || !passwordMatches(password, passwordRecord)) {
        return { status: "invalid" };
      }
      await database.query(
        "update aais_users set last_login_at = $2::timestamptz, updated_at = $2::timestamptz where id = $1",
        [String(row.id), now().toISOString()],
      );
      return {
        status: "ok",
        actor: {
          id: String(row.id),
          role: row.role,
          displayName: String(row.display_name),
        },
      };
    } catch (error) {
      if (isMissingUsersTableError(error)) {
        return { status: "not_configured" };
      }
      throw error;
    }
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
    const userId = createAaisUserId(email);
    const issuedAt = now();
    const token = createRawAuthToken("invite");
    const tokenId = createAuthTokenId(token);
    const tokenHash = hashAuthToken(token);
    const expiresAt = new Date(issuedAt.getTime() + 7 * 24 * 60 * 60 * 1000).toISOString();

    await requiredDatabase.query(
      `insert into aais_users (
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
       values ($1, $2, $3, $4, $5, 'invited', $6, $7::timestamptz, $7::timestamptz)
       on conflict (normalized_email) do update
       set
         display_name = excluded.display_name,
         role = excluded.role,
         status = case when aais_users.status = 'disabled' then 'disabled' else 'invited' end,
         invited_by = excluded.invited_by,
         updated_at = excluded.updated_at`,
      [userId, email, email, displayName, role, input.createdBy, issuedAt.toISOString()],
    );
    await requiredDatabase.query(
      `insert into aais_user_auth_tokens (
         id,
         user_id,
         purpose,
         token_hash,
         created_by,
         expires_at,
         created_at
       )
       values ($1, $2, 'invite', $3, $4, $5::timestamptz, $6::timestamptz)`,
      [tokenId, userId, tokenHash, input.createdBy, expiresAt, issuedAt.toISOString()],
    );
    const user = await readUserById(requiredDatabase, userId);
    await upsertDefaultEnrollment(requiredDatabase, user, issuedAt.toISOString());
    const setPasswordUrl = buildAuthUrl("/login", token, "invite_token");
    const delivery = await sendAuthEmail({
      to: email,
      subject: "AAIS account invitation",
      body: `Use this one-time link to set your AAIS password: ${setPasswordUrl}`,
    });
    return {
      user,
      token,
      setPasswordUrl,
      delivery,
    };
  }

  async function createPasswordReset(input: {
    email: string;
    createdBy: string;
  }): Promise<AaisPasswordResetResult | null> {
    const requiredDatabase = requireDatabase();
    const email = normalizeAaisEmail(input.email);
    const userResult = await requiredDatabase.query(
      `select id, email, display_name, role, status, created_at, updated_at, last_login_at
       from aais_users
       where normalized_email = $1
       limit 1`,
      [email],
    );
    if (!userResult.rows[0] || userResult.rows[0].status === "disabled") {
      return null;
    }
    const user = parseUserListItem(userResult.rows[0]);
    const issuedAt = now();
    const token = createRawAuthToken("password_reset");
    const tokenId = createAuthTokenId(token);
    const expiresAt = new Date(issuedAt.getTime() + 2 * 60 * 60 * 1000).toISOString();
    await requiredDatabase.query(
      `insert into aais_user_auth_tokens (
         id,
         user_id,
         purpose,
         token_hash,
         created_by,
         expires_at,
         created_at
       )
       values ($1, $2, 'password_reset', $3, $4, $5::timestamptz, $6::timestamptz)`,
      [tokenId, user.id, hashAuthToken(token), input.createdBy, expiresAt, issuedAt.toISOString()],
    );
    const resetUrl = buildAuthUrl("/login", token, "reset_token");
    const delivery = await sendAuthEmail({
      to: email,
      subject: "AAIS password reset",
      body: `Use this one-time link to reset your AAIS password: ${resetUrl}`,
    });
    return {
      user,
      token,
      resetUrl,
      delivery,
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
    const result = await requiredDatabase.query(
      `update aais_users
       set role = $2,
           status = $3,
           updated_at = $4::timestamptz
       where id = $1
       returning id, email, display_name, role, status, created_at, updated_at, last_login_at`,
      [userId, role, status, updatedAt],
    );
    const row = result.rows[0];
    if (!row) {
      throw new AaisUserNotFoundError();
    }
    const user = parseUserListItem(row);
    await upsertDefaultEnrollment(requiredDatabase, user, updatedAt);
    return user;
  }

  async function setPasswordWithToken(input: {
    token: string;
    password: string;
  }) {
    const requiredDatabase = requireDatabase();
    const tokenHash = hashAuthToken(requireRawAuthToken(input.token));
    const tokenResult = await requiredDatabase.query(
      `select t.id, t.user_id, t.purpose, t.expires_at, t.consumed_at, u.status
       from aais_user_auth_tokens t
       inner join aais_users u on u.id = t.user_id
       where t.token_hash = $1
       limit 1`,
      [tokenHash],
    );
    const tokenRow = tokenResult.rows[0];
    if (
      !tokenRow
      || tokenRow.consumed_at
      || Date.parse(String(tokenRow.expires_at)) <= now().getTime()
      || tokenRow.status === "disabled"
    ) {
      throw new AaisAuthTokenError();
    }
    const password = requireStrongEnoughPassword(input.password);
    const passwordRecord = createPasswordRecord(password);
    const updatedAt = now().toISOString();
    await requiredDatabase.query(
      `update aais_users
       set password = $2::jsonb, status = 'active', updated_at = $3::timestamptz
       where id = $1`,
      [String(tokenRow.user_id), JSON.stringify(passwordRecord), updatedAt],
    );
    await requiredDatabase.query(
      `update aais_user_auth_tokens
       set consumed_at = $2::timestamptz
       where id = $1`,
      [String(tokenRow.id), updatedAt],
    );
    return readUserById(requiredDatabase, String(tokenRow.user_id));
  }

  function requireDatabase() {
    if (!database) {
      throw new AaisUserStoreConfigurationError();
    }
    return database;
  }

  function buildAuthUrl(path: string, token: string, param: string) {
    const base = appBaseUrl || "http://localhost:3000";
    const url = new URL(path, base);
    url.searchParams.set(param, token);
    return url.toString();
  }

  async function sendAuthEmail(input: {
    to: string;
    subject: string;
    body: string;
  }): Promise<AaisAuthEmailDelivery> {
    const apiKey = process.env.RESEND_API_KEY?.trim();
    const from = process.env.AAIS_AUTH_EMAIL_FROM?.trim();
    if (!apiKey || !from) {
      return {
        status: "not_configured",
        provider: "resend",
      };
    }
    const response = await fetchImpl("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        authorization: `Bearer ${apiKey}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        from,
        to: input.to,
        subject: input.subject,
        text: input.body,
      }),
    });
    if (!response.ok) {
      throw new Error("AAIS auth email provider rejected the request.");
    }
    return {
      status: "sent",
      provider: "resend",
    };
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

function readUserById(database: AaisDatabaseClient, userId: string) {
  return database.query(
    `select id, email, display_name, role, status, created_at, updated_at, last_login_at
     from aais_users
     where id = $1
     limit 1`,
    [userId],
  ).then((result) => parseUserListItem(result.rows[0]));
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

async function upsertDefaultEnrollment(
  database: AaisDatabaseClient,
  user: AaisUserListItem,
  updatedAt: string,
) {
  const courseId = readConfiguredCatalogId(process.env.AAIS_DEFAULT_COURSE_ID, defaultCourseId, "course id");
  const cohort = readConfiguredCohort(process.env.AAIS_DEFAULT_COHORT, defaultCohort);
  const status = getEnrollmentStatusForUser(user.status);
  await database.query(
    `insert into aais_enrollments (
       course_id,
       user_id,
       cohort,
       role,
       status,
       enrolled_at,
       updated_at
     )
     values ($1, $2, $3, $4, $5, $6::timestamptz, $6::timestamptz)
     on conflict (course_id, user_id) do update
     set
       role = excluded.role,
       status = excluded.status,
       updated_at = excluded.updated_at`,
    [courseId, user.id, cohort, user.role, status, updatedAt],
  );
}

function getEnrollmentStatusForUser(status: AaisUserStatus): AaisEnrollmentStatus {
  return status === "disabled" ? "withdrawn" : "active";
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
  return value === "student" || value === "teacher" || value === "admin";
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

function createAuthTokenId(token: string) {
  return `auth-token-${createHash("sha256").update(`aais-token-id:${token}`).digest("hex").slice(0, 24)}`;
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
  const record = typeof value === "string"
    ? JSON.parse(value) as Partial<PasswordRecord>
    : value as Partial<PasswordRecord> | null | undefined;
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

function passwordMatches(password: string, record: PasswordRecord) {
  const actual = scryptSync(password, record.salt, 32);
  const expected = Buffer.from(record.hash, "base64url");
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

function readDateString(value: unknown) {
  if (value instanceof Date) {
    return value.toISOString();
  }
  return new Date(String(value)).toISOString();
}

function getConfiguredUserDatabaseClient() {
  const config = getAaisDatabaseConfiguration();
  if (!config) {
    return null;
  }
  if (!cachedDatabase || cachedDatabase.url !== config.url) {
    cachedDatabase = {
      url: config.url,
      client: new Pool({ connectionString: config.url }) as AaisDatabaseClient,
    };
  }
  return cachedDatabase.client;
}

function isMissingUsersTableError(error: unknown) {
  return error instanceof Error
    && "code" in error
    && (error.code === "42P01" || error.code === "42703");
}
