/**
 * Dev seed script (`npm run seed`, run via tsx).
 *
 * Populates a MIGRATED database with a realistic dataset:
 *   - ~20 users, all sharing one known password hashed exactly once (fast).
 *   - ~5 projects, each owned by one user and given a subset of users as members.
 *   - ~200 tasks with varied status/priority, assignees drawn from each task's
 *     project members (respecting the assignment invariant: a task in a project
 *     is only ever assigned to a member of that project), and nullable due dates
 *     spread across past and future (some left NULL).
 *   - comments scattered across a subset of tasks.
 *
 * The script is re-runnable: it TRUNCATEs all domain tables RESTART IDENTITY
 * CASCADE first, so re-running yields a clean, deterministic-size dataset. It
 * never creates attachment files on disk. Inserts are batched (multi-row
 * INSERT ... VALUES with parameter arrays) and wrapped per entity in a
 * transaction to stay fast.
 *
 * Requires a reachable Postgres via DATABASE_URL and the schema already applied
 * (`npm run migrate` / `npm run migrate:dev`).
 */
import bcrypt from 'bcrypt';
import { pool, withTransaction } from '../src/db/pool.js';
import { logger } from '../src/utils/logger.js';

const USER_COUNT = 20;
const PROJECT_COUNT = 5;
const TASK_COUNT = 200;
const SEED_PASSWORD = 'password123';

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

const STATUSES = ['open', 'in_progress', 'completed'] as const;
const PRIORITIES = ['low', 'medium', 'high', null] as const;

/** Deterministic pseudo-random generator so re-runs produce the same shape. */
function makeRng(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    // xorshift32
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    state >>>= 0;
    return state / 0xffffffff;
  };
}

function pick<T>(rng: () => number, items: readonly T[]): T {
  return items[Math.floor(rng() * items.length)] as T;
}

/**
 * Build a flat parameter list and a `($1,$2,...),($n,...)` VALUES clause for a
 * multi-row INSERT. `rows` is an array of column-value tuples (all the same
 * arity). Returns the clause plus the flattened params.
 */
function buildValues(rows: ReadonlyArray<ReadonlyArray<unknown>>): {
  clause: string;
  params: unknown[];
} {
  const params: unknown[] = [];
  const clauses: string[] = [];
  let p = 0;
  for (const row of rows) {
    const placeholders = row.map(() => {
      p += 1;
      return `$${p}`;
    });
    clauses.push(`(${placeholders.join(', ')})`);
    params.push(...row);
  }
  return { clause: clauses.join(', '), params };
}

async function seed(): Promise<void> {
  const rng = makeRng(0xc0ffee);

  // 0) Clean slate (re-runnable).
  await pool.query(`TRUNCATE ${DOMAIN_TABLES.join(', ')} RESTART IDENTITY CASCADE`);
  logger.info('seed: truncated domain tables');

  // 1) Users — hash the shared password ONCE, reuse for every row.
  const passwordHash = await bcrypt.hash(SEED_PASSWORD, 12);
  const userIds = await withTransaction(async (client) => {
    const rows = Array.from({ length: USER_COUNT }, (_, i) => [
      `User ${i + 1}`,
      `user${i + 1}@example.com`,
      passwordHash,
    ]);
    const { clause, params } = buildValues(rows);
    const { rows: inserted } = await client.query<{ id: number }>(
      `INSERT INTO users (name, email, password_hash) VALUES ${clause} RETURNING id`,
      params
    );
    return inserted.map((r) => r.id);
  });
  logger.info('seed: inserted users', { count: userIds.length });

  // 2) Projects + members. Each project has one owner and a random member
  //    subset; the owner is always a member with role 'owner'.
  const projectMembers = new Map<number, number[]>(); // project id -> member user ids
  const projectIds = await withTransaction(async (client) => {
    const projectRows = Array.from({ length: PROJECT_COUNT }, (_, i) => {
      const owner = userIds[i % userIds.length] as number;
      return [`Project ${i + 1}`, `Seeded project number ${i + 1}`, owner];
    });
    const { clause, params } = buildValues(projectRows);
    const { rows: inserted } = await client.query<{ id: number; owner_id: number }>(
      `INSERT INTO projects (name, description, owner_id) VALUES ${clause} RETURNING id, owner_id`,
      params
    );

    // Build membership rows: owner first, then a random subset of other users.
    const memberRows: Array<[number, number, string]> = [];
    for (const proj of inserted) {
      const members = new Set<number>([proj.owner_id]);
      // Add 3..7 additional distinct members.
      const extra = 3 + Math.floor(rng() * 5);
      let guard = 0;
      while (members.size < extra + 1 && guard < USER_COUNT * 2) {
        members.add(pick(rng, userIds));
        guard += 1;
      }
      const ids = [...members];
      projectMembers.set(proj.id, ids);
      for (const uid of ids) {
        memberRows.push([proj.id, uid, uid === proj.owner_id ? 'owner' : 'member']);
      }
    }
    const mv = buildValues(memberRows);
    await client.query(
      `INSERT INTO project_members (project_id, user_id, role) VALUES ${mv.clause}`,
      mv.params
    );
    return inserted.map((r) => r.id);
  });
  logger.info('seed: inserted projects + members', { count: projectIds.length });

  // 3) Tasks. ~70% belong to a project (assignee drawn from that project's
  //    members, honoring the invariant); the rest are project-less (assignee is
  //    any user or null). Due dates spread past/future, some NULL. Insert in
  //    batches to keep the statement size reasonable.
  const now = Date.now();
  const day = 24 * 60 * 60 * 1000;
  const taskRows: Array<[string, string | null, string, string | null, Date | null, number, number | null, number | null]> = [];
  for (let i = 0; i < TASK_COUNT; i += 1) {
    const creator = pick(rng, userIds);
    const inProject = rng() < 0.7;
    let projectId: number | null = null;
    let assignee: number | null = null;

    if (inProject) {
      projectId = pick(rng, projectIds);
      const members = projectMembers.get(projectId) ?? [];
      // Assignee must be a project member (invariant); sometimes leave unassigned.
      assignee = rng() < 0.8 && members.length > 0 ? pick(rng, members) : null;
    } else {
      // Project-less: assignee may be any existing user, or null.
      assignee = rng() < 0.5 ? pick(rng, userIds) : null;
    }

    let dueDate: Date | null = null;
    const d = rng();
    if (d < 0.4) {
      dueDate = new Date(now - Math.floor(rng() * 30) * day); // past
    } else if (d < 0.8) {
      dueDate = new Date(now + Math.floor(rng() * 30) * day); // future
    } // else leave NULL

    taskRows.push([
      `Task ${i + 1}`,
      rng() < 0.85 ? `Auto-generated description for task ${i + 1}.` : null,
      pick(rng, STATUSES),
      pick(rng, PRIORITIES),
      dueDate,
      creator,
      assignee,
      projectId,
    ]);
  }

  const taskIds = await withTransaction(async (client) => {
    const ids: number[] = [];
    const BATCH = 50;
    for (let start = 0; start < taskRows.length; start += BATCH) {
      const batch = taskRows.slice(start, start + BATCH);
      const { clause, params } = buildValues(batch);
      const { rows: inserted } = await client.query<{ id: number }>(
        `INSERT INTO tasks
           (title, description, status, priority, due_date, creator_id, assignee_id, project_id)
         VALUES ${clause}
         RETURNING id`,
        params
      );
      ids.push(...inserted.map((r) => r.id));
    }
    return ids;
  });
  logger.info('seed: inserted tasks', { count: taskIds.length });

  // 4) Comments scattered across a subset of tasks. For project tasks the author
  //    is a project member; for project-less tasks the author is any user.
  await withTransaction(async (client) => {
    const commentRows: Array<[number, number, string]> = [];
    for (let i = 0; i < taskIds.length; i += 1) {
      if (rng() < 0.45) continue; // only some tasks get comments
      const taskId = taskIds[i] as number;
      const taskProject = taskRows[i]?.[7] ?? null;
      const authorPool =
        taskProject != null ? projectMembers.get(taskProject) ?? userIds : userIds;
      const commentCount = 1 + Math.floor(rng() * 3);
      for (let c = 0; c < commentCount; c += 1) {
        commentRows.push([
          taskId,
          pick(rng, authorPool),
          `Seed comment ${c + 1} on task ${taskId}.`,
        ]);
      }
    }
    if (commentRows.length > 0) {
      const BATCH = 100;
      for (let start = 0; start < commentRows.length; start += BATCH) {
        const batch = commentRows.slice(start, start + BATCH);
        const { clause, params } = buildValues(batch);
        await client.query(
          `INSERT INTO comments (task_id, author_id, body) VALUES ${clause}`,
          params
        );
      }
    }
    logger.info('seed: inserted comments', { count: commentRows.length });
  });

  // Report final counts so the operator can confirm the dataset.
  const counts = await pool.query<{ users: string; projects: string; tasks: string; comments: string }>(
    `SELECT
       (SELECT count(*) FROM users)    AS users,
       (SELECT count(*) FROM projects) AS projects,
       (SELECT count(*) FROM tasks)    AS tasks,
       (SELECT count(*) FROM comments) AS comments`
  );
  logger.info('seed complete', counts.rows[0]);
}

seed()
  .then(async () => {
    await pool.end();
    process.exit(0);
  })
  .catch(async (err) => {
    logger.error('seed failed', {
      error: err instanceof Error ? err.message : String(err),
      stack: err instanceof Error ? err.stack : undefined,
    });
    await pool.end().catch(() => undefined);
    process.exit(1);
  });
