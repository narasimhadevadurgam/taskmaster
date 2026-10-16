import { z } from 'zod';
import { paginationFields } from '../shared/pagination.js';

/** :id (task id) path param for task-nested attachment routes. */
export const attachmentTaskIdParamSchema = z.object({
  id: z.coerce.number().int().positive(),
});

/** :id (attachment id) path param for the download route. */
export const attachmentIdParamSchema = z.object({
  id: z.coerce.number().int().positive(),
});

/** GET /tasks/:id/attachments query (pagination only). */
export const listAttachmentsQuerySchema = z.object({ ...paginationFields });
