import { query } from '../../db/pool.js';
import { AppError } from '../../errors/AppError.js';
import type { Paginated } from '../shared/pagination.js';
import { assertTaskVisible } from '../tasks/tasks.service.js';

/**
 * Canonical attachment metadata object. The server-side `path` column is NEVER
 * part of this shape, so it can never be serialized. mime_type/size_bytes are
 * the public field names mapping to the DB `mime`/`size` columns.
 */
export interface Attachment {
  id: number;
  task_id: number;
  uploader_id: number;
  filename: string;
  mime_type: string;
  size_bytes: number;
  created_at: Date;
}

/** The uploaded file metadata the route passes to the service. */
export interface StoredFile {
  filename: string;
  mime: string;
  size: number;
  path: string;
}

/**
 * Persist an attachment metadata row for an uploaded file. Requires
 * task-visibility (else 404). Returns the canonical shape (never the path).
 */
export async function createAttachment(
  taskId: number,
  callerId: number,
  file: StoredFile
): Promise<Attachment> {
  await assertTaskVisible(taskId, callerId);
  const result = await query<Attachment>(
    `INSERT INTO attachments (task_id, uploader_id, filename, mime, size, path)
     VALUES ($1, $2, $3, $4, $5, $6)
     RETURNING id, task_id, uploader_id, filename,
               mime AS mime_type, size AS size_bytes, created_at`,
    [taskId, callerId, file.filename, file.mime, file.size, file.path]
  );
  return result.rows[0];
}

/**
 * List attachment metadata for a task, paginated, ordered created_at ASC,
 * id ASC. Requires task-visibility (else 404). Never returns the path.
 */
export async function listAttachments(
  taskId: number,
  callerId: number,
  limit: number,
  offset: number
): Promise<Paginated<Attachment>> {
  await assertTaskVisible(taskId, callerId);
  const dataResult = await query<Attachment>(
    `SELECT id, task_id, uploader_id, filename,
            mime AS mime_type, size AS size_bytes, created_at
     FROM attachments
     WHERE task_id = $1
     ORDER BY created_at ASC, id ASC
     LIMIT $2 OFFSET $3`,
    [taskId, limit, offset]
  );
  const countResult = await query<{ count: number }>(
    'SELECT COUNT(*)::bigint AS count FROM attachments WHERE task_id = $1',
    [taskId]
  );
  const total = countResult.rows[0]?.count ?? 0;
  return { data: dataResult.rows, pagination: { limit, offset, total } };
}

/** An attachment row including the private server path (download only). */
export interface AttachmentFile {
  filename: string;
  mime: string;
  path: string;
}

/**
 * Resolve an attachment for download after re-checking task-visibility of its
 * task. Row missing or task not visible -> 404. Returns the private path plus
 * the display metadata needed to stream the file.
 */
export async function getAttachmentForDownload(
  attachmentId: number,
  callerId: number
): Promise<AttachmentFile> {
  const result = await query<{ task_id: number; filename: string; mime: string; path: string }>(
    'SELECT task_id, filename, mime, path FROM attachments WHERE id = $1',
    [attachmentId]
  );
  const row = result.rows[0];
  if (!row) {
    throw new AppError('NOT_FOUND', 'Attachment not found');
  }
  // Re-check task-visibility; non-visible -> 404 (no existence leak).
  await assertTaskVisible(row.task_id, callerId);
  return { filename: row.filename, mime: row.mime, path: row.path };
}
