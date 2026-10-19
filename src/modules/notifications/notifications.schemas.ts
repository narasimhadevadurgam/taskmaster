import { z } from 'zod';
import { paginationFields } from '../shared/pagination.js';

/**
 * GET /notifications query. Optional `read` boolean filter (coerced from the
 * query string), plus shared pagination fields. A missing `read` lists all.
 */
export const listNotificationsQuerySchema = z.object({
  read: z
    .union([z.literal('true'), z.literal('false')])
    .transform((v) => v === 'true')
    .optional(),
  ...paginationFields,
});

export type ListNotificationsQuery = z.infer<typeof listNotificationsQuerySchema>;

/** :id path param for notification routes. Non-numeric -> 400 (not 404). */
export const notificationIdParamSchema = z.object({
  id: z.coerce.number().int().positive(),
});

export type NotificationIdParam = z.infer<typeof notificationIdParamSchema>;

/**
 * PATCH /notifications/:id body. `read` is validated as the literal `true`
 * (never z.boolean()), so a `false` is a VALIDATION_ERROR rather than a silent
 * no-op, per the design.
 */
export const markReadSchema = z.object({
  read: z.literal(true),
});

export type MarkReadInput = z.infer<typeof markReadSchema>;
