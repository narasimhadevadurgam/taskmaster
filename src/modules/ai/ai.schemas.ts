import { z } from 'zod';

/**
 * POST /ai/task-description body. `input` is required 1..1000 chars and `title`
 * is optional <=300. Both are treated strictly as opaque data to summarize or
 * expand — never interpolated into SQL or executed, and never framed as
 * instructions to the model (see the fixed template in ai.service.ts).
 */
export const generateDescriptionSchema = z.object({
  input: z.string().min(1).max(1000),
  title: z.string().max(300).optional(),
});

export type GenerateDescriptionInput = z.infer<typeof generateDescriptionSchema>;
