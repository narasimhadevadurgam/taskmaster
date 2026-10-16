import { z } from 'zod';

/**
 * Registration body. name 1..200 (trimmed), email (max 320), password 8..200.
 * password is validated here but never logged nor returned.
 */
export const registerSchema = z.object({
  name: z.string().trim().min(1, 'name is required').max(200),
  email: z.string().email().max(320),
  password: z.string().min(8, 'password must be at least 8 characters').max(200),
});

export type RegisterInput = z.infer<typeof registerSchema>;

/** Login body. Deliberately minimal; bad credentials never reveal which field. */
export const loginSchema = z.object({
  email: z.string().email().max(320),
  password: z.string().min(1, 'password is required').max(200),
});

export type LoginInput = z.infer<typeof loginSchema>;
