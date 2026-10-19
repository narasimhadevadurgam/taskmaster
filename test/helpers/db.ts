import { runMigrations } from '../../src/db/migrate.js';
import { query } from '../../src/db/pool.js';

/** All domain tables truncated between tests to keep integration tests honest. */
const DOMAIN_TABLES = [
  'users',
  'projects',
  'project_members',
  'tasks',
  'comments',
  'attachments',
  'notifications',
  'token_blocklist',
];

/**
 * Apply all pending migrations once so the test schema matches production.
 * Call from a global/beforeAll. Safe to call repeatedly (the runner is a no-op
 * when nothing is pending).
 */
export async function migrateTestDb(): Promise<void> {
  await runMigrations();
}

/**
 * Reset the database to an empty state. Truncates every domain table with
 * RESTART IDENTITY CASCADE so identity sequences and FKs reset cleanly. Call
 * from beforeEach so each test starts from a known-empty DB.
 */
export async function resetDb(): Promise<void> {
  await query(`TRUNCATE ${DOMAIN_TABLES.join(', ')} RESTART IDENTITY CASCADE`);
}
