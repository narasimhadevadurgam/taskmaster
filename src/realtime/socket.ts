import type { Server as HttpServer } from 'node:http';
import jwt from 'jsonwebtoken';
import { z } from 'zod';
import { Server as IOServer, type Socket } from 'socket.io';
import { config } from '../config/env.js';
import { query } from '../db/pool.js';
import { logger } from '../utils/logger.js';
import type { PersistedNotification } from '../modules/tasks/notification-emitter.js';

/**
 * The subset of JWT claims the handshake relies on (mirrors middleware/auth.ts).
 */
interface TokenClaims extends jwt.JwtPayload {
  sub: string;
  jti: string;
  exp: number;
}

const jtiSchema = z.string().uuid();

/** The room a user's sockets join; one room per user id. */
function userRoom(userId: number): string {
  return `user:${userId}`;
}

/**
 * The live socket.io server once attached. Kept at module scope so
 * emitNotification can reach it without threading the instance through the task
 * service. Reset on detach so tests can start/stop cleanly.
 */
let io: IOServer | null = null;

/**
 * Verify a handshake JWT the same way the HTTP auth middleware does: signature +
 * expiry, a syntactically valid UUID jti (guarding the UUID-typed blocklist
 * lookup), the blocklist check, then the user must still exist. Returns the user
 * id on success or null on any failure (the caller rejects with a connect error).
 */
async function authenticateHandshake(token: string | undefined): Promise<number | null> {
  if (!token || typeof token !== 'string' || token.trim().length === 0) {
    return null;
  }

  let claims: TokenClaims;
  try {
    claims = jwt.verify(token, config.JWT_SECRET) as TokenClaims;
  } catch {
    return null;
  }

  const jtiResult = jtiSchema.safeParse(claims.jti);
  if (!jtiResult.success) {
    return null;
  }

  const blocked = await query('SELECT 1 FROM token_blocklist WHERE jti = $1', [jtiResult.data]);
  if (blocked.rowCount && blocked.rowCount > 0) {
    return null;
  }

  const sub = Number(claims.sub);
  if (!Number.isInteger(sub) || sub <= 0) {
    return null;
  }
  const users = await query<{ id: number }>('SELECT id FROM users WHERE id = $1', [sub]);
  const user = users.rows[0];
  if (!user) {
    return null;
  }
  return user.id;
}

/**
 * Create the socket.io v4 server and attach it to the same HTTP server as
 * Express. The handshake auth middleware reads socket.handshake.auth.token,
 * verifies the JWT, checks the blocklist, and on success joins the socket to
 * room `user:<id>`; invalid/blocklisted tokens are rejected with a connect
 * error. Returns the IOServer and stores it for emitNotification.
 */
export function attachRealtime(http: HttpServer): IOServer {
  const server = new IOServer(http, {
    // No CORS config needed for same-origin; left default.
  });

  server.use((socket: Socket, nextFn: (err?: Error) => void) => {
    const token = socket.handshake.auth?.token as string | undefined;
    authenticateHandshake(token)
      .then((userId) => {
        if (userId == null) {
          nextFn(new Error('UNAUTHENTICATED'));
          return;
        }
        // Join the per-user room so emitNotification can target this user.
        void socket.join(userRoom(userId));
        nextFn();
      })
      .catch((err: unknown) => {
        logger.warn('socket handshake auth error', {
          error: err instanceof Error ? err.message : String(err),
        });
        nextFn(new Error('UNAUTHENTICATED'));
      });
  });

  io = server;
  return server;
}

/**
 * Detach and close the socket.io server (used by server.stop and tests). Safe to
 * call when nothing is attached.
 */
export async function detachRealtime(): Promise<void> {
  const current = io;
  io = null;
  if (!current) {
    return;
  }
  await new Promise<void>((resolve) => {
    current.close(() => resolve());
  });
}

/**
 * Emit the 'notification' event carrying a persisted notification row to its
 * recipient's room. Best-effort: if no socket layer is attached (e.g. tests that
 * never start realtime) this is a no-op. The caller already treats emit as
 * best-effort and wraps it in try/catch.
 */
export function emitNotification(userId: number, notification: PersistedNotification): void {
  if (!io) {
    return;
  }
  io.to(userRoom(userId)).emit('notification', serializeNotification(notification));
}

/**
 * Shape the persisted row into the canonical notification object emitted over
 * the socket (identical contract to the REST fallback). Dates serialize as
 * ISO-8601 strings via JSON.
 */
function serializeNotification(n: PersistedNotification): {
  id: number;
  user_id: number;
  type: string;
  payload: PersistedNotification['payload'];
  read: boolean;
  created_at: Date;
} {
  return {
    id: n.id,
    user_id: n.user_id,
    type: n.type,
    payload: n.payload,
    read: n.read,
    created_at: n.created_at,
  };
}
