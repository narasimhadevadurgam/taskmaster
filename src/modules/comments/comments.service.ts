import { query } from '../../db/pool.js';
import type { Paginated } from '../shared/pagination.js';
import { assertTaskVisible } from '../tasks/tasks.service.js';
import type { CreateCommentInput } from './comments.schemas.js';

/** Canonical comment object. */
export interface Comment {
  id: number;
  task_id: number;
  author_id: number;
  body: string;
  created_at: Date;
}

/**
 * Create a comment on a task. Requires task-visibility (else 404, via
 * assertTaskVisible). author_id is always the caller.
 */
export async function createComment(
  taskId: number,
  callerId: number,
  input: CreateCommentInput
): Promise<Comment> {
  await assertTaskVisible(taskId, callerId);
  const result = await query<Comment>(
    `INSERT INTO comments (task_id, author_id, body)
     VALUES ($1, $2, $3)
     RETURNING id, task_id, author_id, body, created_at`,
    [taskId, callerId, input.body]
  );
  return result.rows[0];
}

/**
 * List comments on a task, paginated, ordered created_at ASC, id ASC. Requires
 * task-visibility (else 404).
 */
export async function listComments(
  taskId: number,
  callerId: number,
  limit: number,
  offset: number
): Promise<Paginated<Comment>> {
  await assertTaskVisible(taskId, callerId);
  const dataResult = await query<Comment>(
    `SELECT id, task_id, author_id, body, created_at
     FROM comments
     WHERE task_id = $1
     ORDER BY created_at ASC, id ASC
     LIMIT $2 OFFSET $3`,
    [taskId, limit, offset]
  );
  const countResult = await query<{ count: number }>(
    'SELECT COUNT(*)::bigint AS count FROM comments WHERE task_id = $1',
    [taskId]
  );
  const total = countResult.rows[0]?.count ?? 0;
  return { data: dataResult.rows, pagination: { limit, offset, total } };
}
