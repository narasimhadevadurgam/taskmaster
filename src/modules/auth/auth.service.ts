import { randomUUID } from 'node:crypto';
import bcrypt from 'bcrypt';
import jwt from 'jsonwebtoken';
import { config } from '../../config/env.js';
import { query } from '../../db/pool.js';
import { AppError } from '../../errors/AppError.js';
import type { LoginInput, RegisterInput } from './auth.schemas.js';

/** bcrypt work factor (design-locked at cost 12). */
const BCRYPT_COST = 12;
/** Token lifetime in seconds (~24h). */
const TOKEN_TTL_SECONDS = 24 * 60 * 60;

/**
 * Canonical user object returned by auth/users endpoints. password_hash is
 * deliberately absent from this shape so it can never be serialized.
 */
export interface PublicUser {
  id: number;
  name: string;
  email: string;
  created_at: Date;
  updated_at: Date;
}

/** Postgres error shape we care about (unique violation). */
function isUniqueViolation(err: unknown): boolean {
  return typeof err === 'object' && err !== null && (err as { code?: string }).code === '23505';
}

/**
 * Register a new user. The email is lower-cased cosmetically (uniqueness is
 * enforced by the case-insensitive CITEXT unique index). The password is hashed
 * with bcrypt cost 12 and only the hash is stored. A duplicate email surfaces
 * as 409 CONFLICT (mapped from the 23505 unique violation).
 */
export async function registerUser(input: RegisterInput): Promise<PublicUser> {
  const email = input.email.toLowerCase();
  const passwordHash = await bcrypt.hash(input.password, BCRYPT_COST);

  try {
    const result = await query<PublicUser>(
      `INSERT INTO users (name, email, password_hash)
       VALUES ($1, $2, $3)
       RETURNING id, name, email, created_at, updated_at`,
      [input.name, email, passwordHash]
    );
    return result.rows[0];
  } catch (err) {
    if (isUniqueViolation(err)) {
      throw new AppError('CONFLICT', 'Email is already registered');
    }
    throw err;
  }
}

/** The result of a successful login: a signed token plus the public user. */
export interface LoginResult {
  token: string;
  user: PublicUser;
}

/**
 * Verify credentials and mint a JWT. On any mismatch (unknown email or wrong
 * password) throws a generic 401 UNAUTHENTICATED with no user enumeration. A
 * fresh v4 UUID jti is minted and signed into the token so logout can later
 * blocklist it.
 */
export async function loginUser(input: LoginInput): Promise<LoginResult> {
  const email = input.email.toLowerCase();
  const result = await query<PublicUser & { password_hash: string }>(
    `SELECT id, name, email, password_hash, created_at, updated_at
     FROM users WHERE email = $1`,
    [email]
  );
  const row = result.rows[0];

  // Compare even when the user is absent is not required; a generic failure is
  // returned either way. (No dummy-hash timing defense is specified by design.)
  if (!row) {
    throw invalidCredentials();
  }
  const ok = await bcrypt.compare(input.password, row.password_hash);
  if (!ok) {
    throw invalidCredentials();
  }

  const jti = randomUUID();
  const token = jwt.sign({ jti }, config.JWT_SECRET, {
    subject: String(row.id),
    expiresIn: TOKEN_TTL_SECONDS,
  });

  const user: PublicUser = {
    id: row.id,
    name: row.name,
    email: row.email,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
  return { token, user };
}

/**
 * Record the current token's jti in the blocklist so it is rejected by the auth
 * middleware on reuse. The JWT exp is epoch seconds (a number); the column is
 * TIMESTAMPTZ, so the insert converts explicitly with to_timestamp($3).
 * Idempotent via ON CONFLICT DO NOTHING.
 */
export async function logoutUser(userId: number, jti: string, exp: number): Promise<void> {
  await query(
    `INSERT INTO token_blocklist (jti, user_id, expires_at)
     VALUES ($1, $2, to_timestamp($3))
     ON CONFLICT (jti) DO NOTHING`,
    [jti, userId, exp]
  );
}

function invalidCredentials(): AppError {
  return new AppError('UNAUTHENTICATED', 'Invalid email or password');
}
