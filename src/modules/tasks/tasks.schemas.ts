import { z } from 'zod';
import { paginationFields } from '../shared/pagination.js';

export const TASK_STATUS = ['open', 'in_progress', 'completed'] as const;
export const TASK_PRIORITY = ['low', 'medium', 'high'] as const;

const statusEnum = z.enum(TASK_STATUS);
const priorityEnum = z.enum(TASK_PRIORITY);

/**
 * POST /tasks body. creator_id is NEVER accepted from the client (always
 * req.user.id). due_date requires a full ISO-8601 datetime (date-only -> 400).
 */
export const createTaskSchema = z.object({
  title: z.string().trim().min(1, 'title is required').max(300),
  description: z.string().max(10000).optional(),
  status: statusEnum.optional(),
  priority: priorityEnum.optional(),
  due_date: z.string().datetime().optional(),
  assignee_id: z.coerce.number().int().positive().optional(),
  project_id: z.coerce.number().int().positive().optional(),
});

export type CreateTaskInput = z.infer<typeof createTaskSchema>;

/**
 * PATCH /tasks/:id body. Any subset of mutable fields; at least one must be
 * present. Nullable fields accept null to clear them (description, priority,
 * due_date, assignee_id, project_id). project_id/assignee_id are coerced to
 * numbers; null is preserved.
 */
const nullableNumber = z
  .union([z.coerce.number().int().positive(), z.null()])
  .optional();

export const updateTaskSchema = z
  .object({
    title: z.string().trim().min(1).max(300).optional(),
    description: z.union([z.string().max(10000), z.null()]).optional(),
    status: statusEnum.optional(),
    priority: z.union([priorityEnum, z.null()]).optional(),
    due_date: z.union([z.string().datetime(), z.null()]).optional(),
    assignee_id: nullableNumber,
    project_id: nullableNumber,
  })
  .refine((d) => Object.values(d).some((v) => v !== undefined), {
    message: 'provide at least one field to update',
  });

export type UpdateTaskInput = z.infer<typeof updateTaskSchema>;

/** :id path param for task routes. Non-numeric -> 400 (not 404). */
export const taskIdParamSchema = z.object({
  id: z.coerce.number().int().positive(),
});

export type TaskIdParam = z.infer<typeof taskIdParamSchema>;

/**
 * GET /tasks query. assignee is literal 'me' or a positive int; q is a literal
 * substring (max 200). sort/order are enum literals with defaults.
 */
export const listTasksQuerySchema = z.object({
  status: statusEnum.optional(),
  assignee: z
    .union([z.literal('me'), z.coerce.number().int().positive()])
    .optional(),
  project: z.coerce.number().int().positive().optional(),
  sort: z.enum(['due_date', 'created_at', 'priority']).default('created_at'),
  order: z.enum(['asc', 'desc']).default('desc'),
  q: z.string().max(200).optional(),
  ...paginationFields,
});

export type ListTasksQuery = z.infer<typeof listTasksQuerySchema>;
