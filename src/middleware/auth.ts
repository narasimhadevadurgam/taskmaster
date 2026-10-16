import type { NextFunction, Request, Response } from 'express';
import jwt from 'jsonwebtoken';
import { z } from 'zod';
import { config } from '../config/env.js';
import { query } from '../db/pool.js';
import { AppError } from '../errors/AppError.js';

/**
 * The authenticated principal attached to req by the auth middleware. Ids are
 * JS numbers (OID-20 parser). password_hash is never loaded here, so it can
 * never leak through req.user.
 */
export interface AuthUser {
  id: number;
  name: string;
  email: string;
}

/** The subset of JWT claims this app signs and relies on. */
interface TokenClaims extends jwt.JwtPayload {
  sub: string;
  jti: string;
  exp: number;
}

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      /** Populated by the auth middleware on protected routes. */
      user?: AuthUser;
      /** The decoded, verified token claims (used by logout to read jti/exp). */
      auth?: { jti: string; exp: number };
    }
  }
}

const jtiSchema = z.string().uuid();

/**
 * JWT auth middleware. Token checks run in this exact order; any failure is a
 * generic 401 UNAUTHENTICATED (logged at debug, never leaking which check
 * failed):
 *   1. Extract `Authorization: Bearer <jwt>` (missing/malformed header -> 401).
 *   2. jwt.verify with JWT_SECRET (bad signature / expired / malformed -> 401).
 *   3. The verified `jti` claim must be a syntactically valid UUID, checked
 *      BEFORE the blocklist query so the UUID-typed lookup is always total
 *      (a non-UUID would otherwise raise a DB type error).
 *   4. SELECT 1 FROM token_blocklist WHERE jti = $1 (hit -> 401, logged out).
 *   5. Load the user by `sub` (missing -> 401). On success attach req.user.
 * Client-supplied ids are never trusted for ownership; downstream services use
 * req.user.id exclusively.
 */
export function authenticate(req: Request, _res: Response, next: NextFunction): void {
  void authenticateAsync(req, next);
}

async function authenticateAsync(req: Request, next: NextFunction): Promise<void> {
  try {
    // 1. Extract Bearer token.
    const header = req.header('Authorization');
    if (!header || !header.startsWith('Bearer ')) {
      throw unauthenticated();
    }
    const token = header.slice('Bearer '.length).trim();
    if (token.length === 0) {
      throw unauthenticated();
    }

    // 2. Verify signature / expiry / structure.
    let claims: TokenClaims;
    try {
      claims = jwt.verify(token, config.JWT_SECRET) as TokenClaims;
    } catch {
      throw unauthenticated();
    }

    // 3. UUID jti guard BEFORE any DB query.
    const jtiResult = jtiSchema.safeParse(claims.jti);
    if (!jtiResult.success) {
      throw unauthenticated();
    }
    const jti = jtiResult.data;

    // 4. Blocklist lookup — a hit means the token was logged out.
    const blocked = await query('SELECT 1 FROM token_blocklist WHERE jti = $1', [jti]);
    if (blocked.rowCount && blocked.rowCount > 0) {
      throw unauthenticated();
    }

    // 5. Load the user by sub (never selecting password_hash).
    const sub = Number(claims.sub);
    if (!Number.isInteger(sub) || sub <= 0) {
      throw unauthenticated();
    }
    const users = await query<AuthUser>(
      'SELECT id, name, email FROM users WHERE id = $1',
      [sub]
    );
    const user = users.rows[0];
    if (!user) {
      throw unauthenticated();
    }

    req.user = user;
    req.auth = { jti, exp: claims.exp };
    next();
  } catch (err) {
    next(err);
  }
}

function unauthenticated(): AppError {
  return new AppError('UNAUTHENTICATED', 'Authentication required');
}
