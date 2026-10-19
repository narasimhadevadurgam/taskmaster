import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, join, parse, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { pool } from './pool.js';
import { logger } from '../utils/logger.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

/**
 * Locate the migrations/ directory by walking up from this module's location
 * until a directory containing migrations/ is found. This resolves correctly in
 * every layout the runner ships in:
 *   - source via tsx:   src/db/migrate.ts   -> <repo>/migrations
 *   - compiled via node: dist/src/db/migrate.js -> <repo>/migrations
 *   - Docker image:      /app/dist/src/db/migrate.js, migrations copied to
 *                        /app/migrations -> /app/migrations
 * A fixed relative path would point at dist/migrations in the compiled layout,
 * which does not exist (tsc does not copy .sql files).
 */
function findMigrationsDir(): string {
  let current = __dirname;
  const { root } = parse(current);
  while (true) {
    const candidate = resolve(current, 'migrations');
    if (existsSync(candidate)) {
      return candidate;
    }
    if (current === root) break;
    current = dirname(current);
  }
  // Fall back to the conventional location relative to the project root so the
  // error message points at a sensible path if nothing was found.
  return resolve(__dirname, '..', '..', 'migrations');
}

const MIGRATIONS_DIR = findMigrationsDir();

async function ensureMigrationsTable(): Promise<void> {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      filename   TEXT PRIMARY KEY,
      applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
  `);
}

async function appliedFilenames(): Promise<Set<string>> {
  const { rows } = await pool.query<{ filename: string }>(
    'SELECT filename FROM schema_migrations'
  );
  return new Set(rows.map((r) => r.filename));
}

function listMigrationFiles(): string[] {
  return readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith('.sql'))
    .sort((a, b) => a.localeCompare(b));
}

/**
 * Apply all pending migrations in lexical order. Each file is applied inside a
 * single transaction together with its schema_migrations insert, so a file either
 * fully applies or rolls back. Returns the list of filenames applied this run.
 */
export async function runMigrations(): Promise<string[]> {
  await ensureMigrationsTable();
  const already = await appliedFilenames();
  const files = listMigrationFiles();
  const applied: string[] = [];

  for (const file of files) {
    if (already.has(file)) continue;
    const sql = readFileSync(join(MIGRATIONS_DIR, file), 'utf8');
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(sql);
      await client.query('INSERT INTO schema_migrations (filename) VALUES ($1)', [file]);
      await client.query('COMMIT');
      logger.info('applied migration', { filename: file });
      applied.push(file);
    } catch (err) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw err;
    } finally {
      client.release();
    }
  }

  if (applied.length === 0) {
    logger.info('no pending migrations');
  }
  return applied;
}

/** True when this module is executed directly as a CLI (not imported). */
function isMain(): boolean {
  const entry = process.argv[1];
  if (!entry) return false;
  return import.meta.url === pathToFileURL(entry).href;
}

if (isMain()) {
  runMigrations()
    .then(async () => {
      await pool.end();
      process.exit(0);
    })
    .catch(async (err) => {
      logger.error('migration failed', {
        error: err instanceof Error ? err.message : String(err),
        stack: err instanceof Error ? err.stack : undefined,
      });
      await pool.end().catch(() => undefined);
      process.exit(1);
    });
}
