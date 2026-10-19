import 'dotenv/config';
import { z } from 'zod';

/**
 * Environment schema. Parsed once at process start. On failure we print a clear,
 * human-readable message and exit non-zero so misconfiguration fails fast.
 */
const envSchema = z.object({
  DATABASE_URL: z.string().min(1, 'DATABASE_URL is required'),
  JWT_SECRET: z.string().min(16, 'JWT_SECRET must be at least 16 characters'),
  PORT: z.coerce.number().int().positive().default(3000),
  LLM_PROVIDER: z.enum(['mock', 'ollama']).default('mock'),
  OLLAMA_URL: z.string().url().default('http://localhost:11434'),
  OLLAMA_MODEL: z.string().min(1).default('llama3.1:8b'),
  UPLOAD_DIR: z.string().min(1).default('uploads'),
  MAX_UPLOAD_BYTES: z.coerce.number().int().positive().default(10485760),
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
});

export type Env = z.infer<typeof envSchema>;

/**
 * Parse the given source (defaults to process.env). Exported separately so unit
 * tests can exercise success and failure paths without touching process.exit.
 */
export function parseEnv(source: NodeJS.ProcessEnv = process.env): Env {
  return envSchema.parse(source);
}

function loadConfig(): Env {
  // Under Vitest, importing this module must not call process.exit if the test
  // environment lacks DATABASE_URL/JWT_SECRET: unit tests exercise parseEnv()
  // directly against explicit inputs. A real test run that touches the DB sets
  // these vars, so parsing still succeeds there.
  if (process.env.VITEST) {
    const result = envSchema.safeParse(process.env);
    return result.success ? result.data : ({} as Env);
  }

  const result = envSchema.safeParse(process.env);
  if (!result.success) {
    const details = result.error.issues
      .map((issue) => `  - ${issue.path.join('.') || '(root)'}: ${issue.message}`)
      .join('\n');
    // eslint-disable-next-line no-console
    console.error(`Invalid environment configuration:\n${details}`);
    process.exit(1);
  }
  return result.data;
}

export const config: Env = loadConfig();
