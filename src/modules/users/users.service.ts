import bcrypt from 'bcrypt';
import { query } from '../../db/pool.js';
import { AppError } from '../../errors/AppError.js';
import type { PublicUser } from '../auth/auth.service.js';
import type { UpdateMeInput } from './users.schemas.js';

/** bcrypt work factor (design-locked at cost 12), shared with registration. */
const BCRYPT_COST = 12;

function isUniqueViolation(err: unknown): boolean {
  return typeof err === 'object' && err !== null && (err as { code?: string }).code === '23505';
}

/**
 * Load the canonical public user by id. password_hash is never selected.
 * Throws 404 NOT_FOUND if the user no longer exists (e.g. deleted after the
 * token was issued), consistent with the no-existence-leak policy.
 */
export async function getUserById(id: number): Promise<PublicUser> {
  const result = await query<PublicUser>(
    'SELECT id, name, email, created_at, updated_at FROM users WHERE id = $1',
    [id]
  );
  const user = result.rows[0];
  if (!user) {
    throw new AppError('NOT_FOUND', 'User not found');
  }
  return user;
}

/**
 * Update the given fields on the caller's own record. Only provided fields are
 * written; password (if present) is re-hashed with bcrypt cost 12. updated_at
 * is always bumped. password_hash is never returned. An email collision surfaces
 * as 409 CONFLICT (mapped from the 23505 unique violation).
 */
export async function updateUser(id: number, input: UpdateMeInput): Promise<PublicUser> {
  const sets: string[] = [];
  const params: unknown[] = [];
  let i = 1;

  if (input.name !== undefined) {
    sets.push(`name = $${i++}`);
    params.push(input.name);
  }
  if (input.email !== undefined) {
    sets.push(`email = $${i++}`);
    params.push(input.email.toLowerCase());
  }
  if (input.password !== undefined) {
    const passwordHash = await bcrypt.hash(input.password, BCRYPT_COST);
    sets.push(`password_hash = $${i++}`);
    params.push(passwordHash);
  }

  // Always bump updated_at on any profile edit.
  sets.push('updated_at = now()');
  params.push(id);

  try {
    const result = await query<PublicUser>(
      `UPDATE users SET ${sets.join(', ')}
       WHERE id = $${i}
       RETURNING id, name, email, created_at, updated_at`,
      params
    );
    const user = result.rows[0];
    if (!user) {
      throw new AppError('NOT_FOUND', 'User not found');
    }
    return user;
  } catch (err) {
    if (isUniqueViolation(err)) {
      throw new AppError('CONFLICT', 'Email is already registered');
    }
    throw err;
  }
}
