import { defineConfig } from 'vitest/config';

// The real-Postgres integration suite shares ONE database, so execution must be
// serial. This is the single authoritative spelling for Vitest v1 — configured
// here once, never via conflicting CLI flags:
//   - pool: 'forks' + poolOptions.forks.singleFork  -> one worker process
//   - fileParallelism: false                         -> files run one at a time
// globalSetup runs the migration runner once (not per file) against the test DB
// (TEST_DATABASE_URL / DATABASE_URL); per-test isolation is resetDb() TRUNCATE
// in each suite's beforeEach. Documented in the README (serial-test note).
export default defineConfig({
  test: {
    pool: 'forks',
    poolOptions: {
      forks: {
        singleFork: true,
      },
    },
    fileParallelism: false,
    include: ['test/**/*.test.ts'],
    globalSetup: ['test/helpers/globalSetup.ts'],
  },
});
