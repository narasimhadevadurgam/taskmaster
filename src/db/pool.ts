import pg from 'pg';
import { config } from '../config/env.js';

/**
 * BIGINT / id serialization policy (design-locked).
 *
 * By default node-postgres returns int8/BIGINT (OID 20) as JS strings to avoid
 * precision loss beyond Number.MAX_SAFE_INTEGER. This project chooses the number
 * contract: register the OID-20 parser BEFORE the Pool is created so every id and
 * COUNT(*) comes back as a JS number.
 *
 * Precision ceiling (accepted): identity sequences and row counts for this app
 * will not exceed 2^53 - 1, so parsing BIGINT to number is safe here.
 */
pg.types.setTypeParser(20, (value: string | null) =>
  value === null ? null : parseInt(value, 10)
);

const { Pool } = pg;

export const pool = new Pool({ connectionString: config.DATABASE_URL });

/**
 * Run a parameterized query and return the typed rows. T is the row shape.
 */
export async function query<T extends pg.QueryResultRow = pg.QueryResultRow>(
  text: string,
  params?: ReadonlyArray<unknown>
): Promise<pg.QueryResult<T>> {
  return pool.query<T>(text, params as unknown[] | undefined);
}

/**
 * Execute fn inside a single transaction on a dedicated connection. Commits on
 * success, rolls back on any throw, and always releases the client. The callback
 * receives the connected client so all statements run on the same connection.
 */
export async function withTransaction<T>(
  fn: (client: pg.PoolClient) => Promise<T>
): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    try {
      await client.query('ROLLBACK');
    } catch {
      // ignore rollback failure; original error is rethrown below
    }
    throw err;
  } finally {
    client.release();
  }
}
