import { config } from './config/env.js';
import { runMigrations } from './db/migrate.js';
import { createServer } from './server.js';
import { pool } from './db/pool.js';
import { logger } from './utils/logger.js';

/**
 * Process entry: env is validated on import of config, then migrations run, then
 * the HTTP server starts. Any startup failure logs and exits non-zero.
 */
async function main(): Promise<void> {
  await runMigrations();

  const server = createServer();
  await server.start(config.PORT);
  logger.info('server started', { port: config.PORT, env: config.NODE_ENV });

  const shutdown = async (signal: string): Promise<void> => {
    logger.info('shutting down', { signal });
    await server.stop().catch(() => undefined);
    await pool.end().catch(() => undefined);
    process.exit(0);
  };
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
}

main().catch(async (err) => {
  logger.error('startup failed', {
    error: err instanceof Error ? err.message : String(err),
    stack: err instanceof Error ? err.stack : undefined,
  });
  await pool.end().catch(() => undefined);
  process.exit(1);
});
