import { z } from 'zod';
import { paginationFields } from '../shared/pagination.js';

/** POST /tasks/:id/comments body. */
export const createCommentSchema = z.object({
  body: z.string().trim().min(1, 'body is required').max(5000),
});

export type CreateCommentInput = z.infer<typeof createCommentSchema>;

/** :id (task id) path param for comment routes. Non-numeric -> 400. */
export const commentTaskIdParamSchema = z.object({
  id: z.coerce.number().int().positive(),
});

/** GET /tasks/:id/comments query (pagination only). */
export const listCommentsQuerySchema = z.object({ ...paginationFields });
