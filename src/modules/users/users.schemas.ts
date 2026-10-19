import { z } from 'zod';

/**
 * PATCH /users/me body. Every field is optional, but at least one must be
 * present (an empty body is a VALIDATION_ERROR). password, if present, is
 * re-hashed by the service and never logged or returned.
 */
export const updateMeSchema = z
  .object({
    name: z.string().trim().min(1).max(200).optional(),
    email: z.string().email().max(320).optional(),
    password: z.string().min(8, 'password must be at least 8 characters').max(200).optional(),
  })
  .refine(
    (data) => data.name !== undefined || data.email !== undefined || data.password !== undefined,
    { message: 'provide at least one of name, email, or password' }
  );

export type UpdateMeInput = z.infer<typeof updateMeSchema>;
