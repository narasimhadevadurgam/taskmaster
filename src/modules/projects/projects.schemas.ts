import { z } from 'zod';

/** POST /projects body. name 1..200 (trimmed), optional description 0..2000. */
export const createProjectSchema = z.object({
  name: z.string().trim().min(1, 'name is required').max(200),
  description: z.string().max(2000).optional(),
});

export type CreateProjectInput = z.infer<typeof createProjectSchema>;

/**
 * POST /projects/:id/members body. Exactly one of user_id | email must be
 * present (the cross-field rule is not expressible by a plain z.object, so a
 * .refine enforces the XOR; both-or-neither -> 400 VALIDATION_ERROR).
 */
export const addMemberSchema = z
  .object({
    user_id: z.coerce.number().int().positive().optional(),
    email: z.string().email().max(320).optional(),
  })
  .refine((d) => (d.user_id == null) !== (d.email == null), {
    message: 'provide exactly one of user_id or email',
  });

export type AddMemberInput = z.infer<typeof addMemberSchema>;

/** :id path param for project routes. Non-numeric -> 400 (not 404). */
export const projectIdParamSchema = z.object({
  id: z.coerce.number().int().positive(),
});

export type ProjectIdParam = z.infer<typeof projectIdParamSchema>;
