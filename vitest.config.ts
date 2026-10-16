import { defineConfig } from 'vitest/config';

// Serial execution is the single authoritative spelling for the real-Postgres
// integration suite (tests share one database). Unit tests in FEAT-001 do not
// touch the DB, but the config is pinned here once for the whole project.
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
  },
});
