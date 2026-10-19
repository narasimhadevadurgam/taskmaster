/**
 * Vitest global setup. Runs ONCE before the whole suite (not per file): applies
 * all pending migrations to the test database so the schema matches production
 * exactly, then closes the setup pool. Per-test isolation is handled separately
 * by resetDb() (TRUNCATE ... RESTART IDENTITY CASCADE) in each suite's
 * beforeEach.
 *
 * The test DB is selected via TEST_DATABASE_URL (preferred) or DATABASE_URL. If
 * neither is set, there is nothing to migrate: the integration suites skip
 * themselves (see test/*.integration.test.ts), so global setup is a no-op and
 * `npm test` stays green on DB-less stages.
 */
export default async function setup(): Promise<void> {
  const dbUrl = process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL;
  if (!dbUrl) {
    return;
  }
  // The pool reads config.DATABASE_URL at import time; mirror TEST_DATABASE_URL
  // onto DATABASE_URL before importing any src module so a single reachable
  // Postgres is used uniformly by setup, migrations, and the suites.
  if (!process.env.DATABASE_URL) {
    process.env.DATABASE_URL = dbUrl;
  }
  if (!process.env.JWT_SECRET) {
    process.env.JWT_SECRET = 'test-secret-at-least-16-chars-long';
  }

  const { runMigrations } = await import('../../src/db/migrate.js');
  const { pool } = await import('../../src/db/pool.js');
  try {
    await runMigrations();
  } finally {
    await pool.end();
  }
}
