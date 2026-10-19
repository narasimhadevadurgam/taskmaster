import type { PoolClient } from 'pg';
import { query, withTransaction } from '../../db/pool.js';
import { AppError } from '../../errors/AppError.js';
import { logger } from '../../utils/logger.js';
import type { Paginated } from '../shared/pagination.js';
import { isProjectMember } from '../projects/projects.service.js';
import {
  createNoopNotificationEmitter,
  type NotificationEmitter,
  type NotificationInput,
  type PersistedNotification,
} from './notification-emitter.js';
import type { CreateTaskInput, ListTasksQuery, UpdateTaskInput } from './tasks.schemas.js';

/** Canonical task object returned by every task endpoint (no joined names). */
export interface Task {
  id: number;
  title: string;
  description: string | null;
  status: 'open' | 'in_progress' | 'completed';
  priority: 'low' | 'medium' | 'high' | null;
  due_date: Date | null;
  creator_id: number;
  assignee_id: number | null;
  project_id: number | null;
  created_at: Date;
  updated_at: Date;
}

/** Columns selected to materialize the canonical task object. */
const TASK_COLUMNS =
  't.id, t.title, t.description, t.status, t.priority, t.due_date, ' +
  't.creator_id, t.assignee_id, t.project_id, t.created_at, t.updated_at';

/**
 * The injected notification emitter. The socket layer overrides it at startup
 * via setNotificationEmitter(); the default is a persist-only no-op so the task
 * module works without the socket layer attached.
 */
let notificationEmitter: NotificationEmitter = createNoopNotificationEmitter();

/** Replace the notification emitter (the socket layer wires socket.io here). */
export function setNotificationEmitter(emitter: NotificationEmitter): void {
  notificationEmitter = emitter;
}

function isForeignKeyViolation(err: unknown): boolean {
  return typeof err === 'object' && err !== null && (err as { code?: string }).code === '23503';
}

/**
 * The ONE visibility predicate: a task is visible to a user if they are the
 * creator, the assignee, or a member of the task's project. Returned as a SQL
 * fragment plus the single `$me` parameter so GET /tasks reuses it byte-identical
 * for the data query and the COUNT(*).
 */
function visibilityPredicate(meParam: string): string {
  return `(t.creator_id = ${meParam}
           OR t.assignee_id = ${meParam}
           OR t.project_id IN (SELECT project_id FROM project_members WHERE user_id = ${meParam}))`;
}

/**
 * Validate the assignment invariant on the given transaction client. If the
 * task has a project_id, the assignee must be a current member of that project;
 * otherwise the assignee must simply exist. A violation -> 400 VALIDATION_ERROR.
 */
async function validateAssignment(
  client: PoolClient,
  assigneeId: number,
  projectId: number | null
): Promise<void> {
  if (projectId != null) {
    const member = await isProjectMember(projectId, assigneeId, client);
    if (!member) {
      throw new AppError(
        'VALIDATION_ERROR',
        'Assignee must be a member of the task\'s project'
      );
    }
    return;
  }
  const result = await client.query('SELECT 1 FROM users WHERE id = $1', [assigneeId]);
  if ((result.rowCount ?? 0) === 0) {
    throw new AppError('VALIDATION_ERROR', 'Assignee user does not exist');
  }
}

/**
 * Create a task. creator_id is always the caller. If project_id is given the
 * caller must be a member (else 404). The assignment invariant is validated in
 * the same transaction as the insert.
 */
export async function createTask(callerId: number, input: CreateTaskInput): Promise<Task> {
  return withTransaction(async (client) => {
    const projectId = input.project_id ?? null;
    if (projectId != null) {
      const member = await isProjectMember(projectId, callerId, client);
      if (!member) {
        // Target project not visible to caller -> 404 (no existence leak).
        throw new AppError('NOT_FOUND', 'Project not found');
      }
    }

    if (input.assignee_id != null) {
      await validateAssignment(client, input.assignee_id, projectId);
    }

    try {
      const result = await client.query<Task>(
        `INSERT INTO tasks (title, description, status, priority, due_date, creator_id, assignee_id, project_id)
         VALUES ($1, $2, COALESCE($3::task_status, 'open'), $4::task_priority, $5, $6, $7, $8)
         RETURNING ${TASK_COLUMNS.replace(/t\./g, '')}`,
        [
          input.title,
          input.description ?? null,
          input.status ?? null,
          input.priority ?? null,
          input.due_date ?? null,
          callerId,
          input.assignee_id ?? null,
          projectId,
        ]
      );
      return result.rows[0];
    } catch (err) {
      if (isForeignKeyViolation(err)) {
        throw new AppError('VALIDATION_ERROR', 'Referenced user or project does not exist');
      }
      throw err;
    }
  });
}

/** Load a task row by id (no visibility check). */
async function loadTask(client: PoolClient, taskId: number): Promise<Task | undefined> {
  const result = await client.query<Task>(
    `SELECT ${TASK_COLUMNS} FROM tasks t WHERE t.id = $1`,
    [taskId]
  );
  return result.rows[0];
}

/** Whether the user may SEE the task (creator / assignee / project member). */
async function canView(client: PoolClient, task: Task, userId: number): Promise<boolean> {
  if (task.creator_id === userId || task.assignee_id === userId) {
    return true;
  }
  if (task.project_id != null) {
    return isProjectMember(task.project_id, userId, client);
  }
  return false;
}

/** GET /tasks/:id — visibility rule: non-visible -> 404. */
export async function getTask(taskId: number, callerId: number): Promise<Task> {
  return withTransaction(async (client) => {
    const task = await loadTask(client, taskId);
    if (!task || !(await canView(client, task, callerId))) {
      throw new AppError('NOT_FOUND', 'Task not found');
    }
    return task;
  });
}

/**
 * PATCH /tasks/:id. Edit rule: creator, assignee, or current-project member.
 * Setting a non-null project_id additionally requires membership of the TARGET
 * project (else 404); detaching to null needs only edit permission. The
 * assignment invariant is re-validated against the post-update project. On
 * success updated_at is bumped and notifications are persisted (one per
 * recipient) in the same transaction, then emitted best-effort after commit.
 */
export async function updateTask(
  taskId: number,
  callerId: number,
  input: UpdateTaskInput
): Promise<Task> {
  const { task, emits } = await withTransaction(async (client) => {
    const existing = await loadTask(client, taskId);
    if (!existing || !(await canView(client, existing, callerId))) {
      // Edit permission is the same visibility set here (creator/assignee/member),
      // so a non-visible task -> 404.
      throw new AppError('NOT_FOUND', 'Task not found');
    }

    // Determine the effective (post-update) project.
    const projectChanged = Object.prototype.hasOwnProperty.call(input, 'project_id');
    const effectiveProjectId = projectChanged ? input.project_id ?? null : existing.project_id;

    // Moving INTO/within a non-null project requires target-project membership.
    if (projectChanged && input.project_id != null) {
      const member = await isProjectMember(input.project_id, callerId, client);
      if (!member) {
        throw new AppError('NOT_FOUND', 'Project not found');
      }
    }

    // Determine the effective assignee (post-update).
    const assigneeChanged = Object.prototype.hasOwnProperty.call(input, 'assignee_id');
    const effectiveAssigneeId = assigneeChanged ? input.assignee_id ?? null : existing.assignee_id;

    // Re-validate the assignment invariant against the effective project when
    // there is a non-null assignee and either the assignee or project changed.
    if (effectiveAssigneeId != null && (assigneeChanged || projectChanged)) {
      await validateAssignment(client, effectiveAssigneeId, effectiveProjectId);
    }

    // Build a dynamic SET from only the provided fields.
    const sets: string[] = [];
    const params: unknown[] = [];
    let i = 1;
    const push = (col: string, value: unknown) => {
      sets.push(`${col} = $${i++}`);
      params.push(value);
    };
    if (input.title !== undefined) push('title', input.title);
    if (input.description !== undefined) push('description', input.description);
    if (input.status !== undefined) push('status', input.status);
    if (input.priority !== undefined) push('priority', input.priority);
    if (input.due_date !== undefined) push('due_date', input.due_date);
    if (assigneeChanged) push('assignee_id', input.assignee_id ?? null);
    if (projectChanged) push('project_id', input.project_id ?? null);
    sets.push('updated_at = now()');
    params.push(taskId);

    let updated: Task;
    try {
      const result = await client.query<Task>(
        `UPDATE tasks SET ${sets.join(', ')}
         WHERE id = $${i}
         RETURNING ${TASK_COLUMNS.replace(/t\./g, '')}`,
        params
      );
      updated = result.rows[0];
    } catch (err) {
      if (isForeignKeyViolation(err)) {
        throw new AppError('VALIDATION_ERROR', 'Referenced user or project does not exist');
      }
      throw err;
    }

    // Compute notification recipients per the design rule.
    const toEmit = await computeAndPersistNotifications(client, {
      actorId: callerId,
      previous: existing,
      updated,
      assigneeChanged,
    });

    return { task: updated, emits: toEmit };
  });

  // Best-effort emit after commit; never fails the request.
  for (const n of emits) {
    try {
      notificationEmitter.emit(n);
    } catch (err) {
      logger.warn('notification emit failed', {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  return task;
}

/**
 * Compute the notification recipient set for a PATCH and persist one row per
 * recipient on the transaction client. Returns the persisted rows for post-commit
 * emission.
 *
 * Rule:
 *  1. Assignment change: if assignee_id was set to a value different from the
 *     previous assignee AND the new assignee is not the actor -> one
 *     'task_assigned' row for the new assignee.
 *  2. Other field changes: if any non-assignee field actually changed, recipients
 *     are {creator_id, post-update assignee_id} minus the actor and nulls, deduped
 *     -> one 'task_updated' row each.
 *  3. Empty recipient set -> no rows.
 */
async function computeAndPersistNotifications(
  client: PoolClient,
  args: { actorId: number; previous: Task; updated: Task; assigneeChanged: boolean }
): Promise<PersistedNotification[]> {
  const { actorId, previous, updated, assigneeChanged } = args;
  const inputs: NotificationInput[] = [];

  const snapshot = {
    task_id: updated.id,
    title: updated.title,
    status: updated.status,
    project_id: updated.project_id,
    actor_id: actorId,
  };

  // 1. Assignment change.
  const assignmentIsNew =
    assigneeChanged &&
    updated.assignee_id != null &&
    updated.assignee_id !== previous.assignee_id &&
    updated.assignee_id !== actorId;
  if (assignmentIsNew && updated.assignee_id != null) {
    inputs.push({ user_id: updated.assignee_id, type: 'task_assigned', payload: snapshot });
  }

  // 2. Other field changes.
  const otherFieldChanged =
    previous.title !== updated.title ||
    previous.description !== updated.description ||
    previous.status !== updated.status ||
    previous.priority !== updated.priority ||
    !sameDate(previous.due_date, updated.due_date) ||
    previous.project_id !== updated.project_id;
  if (otherFieldChanged) {
    const recipients = new Set<number>();
    if (updated.creator_id !== actorId) recipients.add(updated.creator_id);
    if (updated.assignee_id != null && updated.assignee_id !== actorId) {
      recipients.add(updated.assignee_id);
    }
    for (const user_id of recipients) {
      inputs.push({ user_id, type: 'task_updated', payload: snapshot });
    }
  }

  const persisted: PersistedNotification[] = [];
  for (const input of inputs) {
    persisted.push(await notificationEmitter.persist(client, input));
  }
  return persisted;
}

function sameDate(a: Date | null, b: Date | null): boolean {
  if (a === null && b === null) return true;
  if (a === null || b === null) return false;
  return a.getTime() === b.getTime();
}

/**
 * DELETE /tasks/:id. Delete rule: creator or the owner of the task's project
 * (else 403 if visible). Comments/attachments rows cascade via FK; attachment
 * files are unlinked best-effort by the caller (route) after deletion. Returns
 * the deleted attachments' server paths so the route can unlink them.
 */
export async function deleteTask(taskId: number, callerId: number): Promise<string[]> {
  return withTransaction(async (client) => {
    const task = await loadTask(client, taskId);
    if (!task || !(await canView(client, task, callerId))) {
      throw new AppError('NOT_FOUND', 'Task not found');
    }

    let permitted = task.creator_id === callerId;
    if (!permitted && task.project_id != null) {
      const ownerResult = await client.query<{ owner_id: number }>(
        'SELECT owner_id FROM projects WHERE id = $1',
        [task.project_id]
      );
      permitted = ownerResult.rows[0]?.owner_id === callerId;
    }
    if (!permitted) {
      throw new AppError('FORBIDDEN', 'Only the task creator or project owner may delete this task');
    }

    // Collect attachment paths to unlink after the row cascade.
    const attachments = await client.query<{ path: string }>(
      'SELECT path FROM attachments WHERE task_id = $1',
      [taskId]
    );
    await client.query('DELETE FROM tasks WHERE id = $1', [taskId]);
    return attachments.rows.map((r) => r.path);
  });
}

/**
 * GET /tasks. Builds the ONE visibility+filter predicate and reuses it
 * byte-identical for the paginated SELECT and the COUNT(*).
 */
export async function listTasks(
  callerId: number,
  q: ListTasksQuery
): Promise<Paginated<Task>> {
  const params: unknown[] = [];
  const push = (value: unknown): string => {
    params.push(value);
    return `$${params.length}`;
  };

  const me = push(callerId);
  const clauses: string[] = [visibilityPredicate(me)];

  if (q.status !== undefined) {
    clauses.push(`t.status = ${push(q.status)}`);
  }
  if (q.project !== undefined) {
    clauses.push(`t.project_id = ${push(q.project)}`);
  }
  if (q.assignee !== undefined) {
    const assigneeId = q.assignee === 'me' ? callerId : q.assignee;
    clauses.push(`t.assignee_id = ${push(assigneeId)}`);
  }
  if (q.q !== undefined) {
    // Escape LIKE metacharacters so q is a literal substring, then ESCAPE '\'.
    const likeQ = q.q.replace(/([\\%_])/g, '\\$1');
    const qp = push(likeQ);
    clauses.push(
      `(t.title ILIKE '%'||${qp}||'%' ESCAPE '\\' OR t.description ILIKE '%'||${qp}||'%' ESCAPE '\\')`
    );
  }

  const where = clauses.join('\n    AND ');

  // Authoritative ORDER BY: `<sortcol> <order> NULLS LAST, id <order>`.
  const sortcol = q.sort; // created_at | due_date | priority (safe enum literals)
  const order = q.order === 'asc' ? 'ASC' : 'DESC';
  const orderBy = `ORDER BY t.${sortcol} ${order} NULLS LAST, t.id ${order}`;

  const limitParam = push(q.limit);
  const offsetParam = push(q.offset);

  const dataResult = await query<Task>(
    `SELECT ${TASK_COLUMNS}
     FROM tasks t
     WHERE ${where}
     ${orderBy}
     LIMIT ${limitParam} OFFSET ${offsetParam}`,
    params
  );

  // COUNT(*) reuses the identical WHERE and its params (minus limit/offset,
  // which are harmlessly extra in the array but unreferenced by this query).
  const countResult = await query<{ count: number }>(
    `SELECT COUNT(*)::bigint AS count
     FROM tasks t
     WHERE ${where}`,
    params.slice(0, params.length - 2)
  );
  const total = countResult.rows[0]?.count ?? 0;

  return { data: dataResult.rows, pagination: { limit: q.limit, offset: q.offset, total } };
}

/**
 * Internal helper reused by comments/attachments services: assert the caller may
 * see the task (creator/assignee/project member), else 404. Returns the task.
 */
export async function assertTaskVisible(taskId: number, callerId: number): Promise<Task> {
  return getTask(taskId, callerId);
}
