import { query } from '../../db/pool.js';
import { AppError } from '../../errors/AppError.js';
import type { Paginated } from '../shared/pagination.js';
import type { ListNotificationsQuery } from './notifications.schemas.js';

/**
 * Canonical notification object returned by GET /notifications list items and
 * PATCH /notifications/:id. The payload JSONB carries the fixed-key task
 * snapshot shared with the socket event.
 */
export interface Notification {
  id: number;
  user_id: number;
  type: 'task_assigned' | 'task_updated';
  payload: {
    task_id: number;
    title: string;
    status: 'open' | 'in_progress' | 'completed';
    project_id: number | null;
    actor_id: number;
  };
  read: boolean;
  created_at: Date;
}

/** Columns selected to materialize the canonical notification object. */
const NOTIFICATION_COLUMNS = 'id, user_id, type, payload, read, created_at';

/**
 * GET /notifications. Lists the caller's notifications newest-first with the
 * authoritative ORDER BY (created_at DESC, id DESC). An optional `read` filter
 * narrows the set. data and COUNT(*) share the identical predicate.
 */
export async function listNotifications(
  callerId: number,
  q: ListNotificationsQuery
): Promise<Paginated<Notification>> {
  const params: unknown[] = [callerId];
  let where = 'user_id = $1';
  if (q.read !== undefined) {
    params.push(q.read);
    where += ` AND read = $${params.length}`;
  }

  const dataParams = [...params, q.limit, q.offset];
  const limitParam = `$${dataParams.length - 1}`;
  const offsetParam = `$${dataParams.length}`;

  const dataResult = await query<Notification>(
    `SELECT ${NOTIFICATION_COLUMNS}
     FROM notifications
     WHERE ${where}
     ORDER BY created_at DESC, id DESC
     LIMIT ${limitParam} OFFSET ${offsetParam}`,
    dataParams
  );

  const countResult = await query<{ count: number }>(
    `SELECT COUNT(*)::bigint AS count FROM notifications WHERE ${where}`,
    params
  );
  const total = countResult.rows[0]?.count ?? 0;

  return { data: dataResult.rows, pagination: { limit: q.limit, offset: q.offset, total } };
}

/**
 * PATCH /notifications/:id. Owner-only: marks the row read. A row that is not
 * the caller's (or absent) -> 404 (no existence leak). Returns the updated row.
 */
export async function markNotificationRead(
  notificationId: number,
  callerId: number
): Promise<Notification> {
  const result = await query<Notification>(
    `UPDATE notifications
     SET read = true
     WHERE id = $1 AND user_id = $2
     RETURNING ${NOTIFICATION_COLUMNS}`,
    [notificationId, callerId]
  );
  const row = result.rows[0];
  if (!row) {
    throw new AppError('NOT_FOUND', 'Notification not found');
  }
  return row;
}

/**
 * POST /notifications/read-all. Marks every one of the caller's notifications
 * read and returns how many rows were updated.
 */
export async function markAllNotificationsRead(callerId: number): Promise<number> {
  const result = await query(
    'UPDATE notifications SET read = true WHERE user_id = $1 AND read = false',
    [callerId]
  );
  return result.rowCount ?? 0;
}
