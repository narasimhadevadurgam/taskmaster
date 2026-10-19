import { describe, it, expect } from 'vitest';
import { ZodError } from 'zod';
import { parseEnv } from '../src/config/env.js';

const base = {
  DATABASE_URL: 'postgres://u:p@localhost:5432/db',
  JWT_SECRET: 'a-sufficiently-long-secret',
};

describe('env parsing', () => {
  it('parses a valid environment and applies defaults', () => {
    const env = parseEnv(base as NodeJS.ProcessEnv);
    expect(env.DATABASE_URL).toBe(base.DATABASE_URL);
    expect(env.PORT).toBe(3000);
    expect(env.LLM_PROVIDER).toBe('mock');
    expect(env.OLLAMA_URL).toBe('http://localhost:11434');
    expect(env.UPLOAD_DIR).toBe('uploads');
    expect(env.MAX_UPLOAD_BYTES).toBe(10485760);
    expect(env.NODE_ENV).toBe('development');
  });

  it('coerces numeric strings for PORT and MAX_UPLOAD_BYTES', () => {
    const env = parseEnv({ ...base, PORT: '8080', MAX_UPLOAD_BYTES: '2048' } as NodeJS.ProcessEnv);
    expect(env.PORT).toBe(8080);
    expect(env.MAX_UPLOAD_BYTES).toBe(2048);
  });

  it('throws when DATABASE_URL is missing', () => {
    expect(() => parseEnv({ JWT_SECRET: base.JWT_SECRET } as NodeJS.ProcessEnv)).toThrow(ZodError);
  });

  it('throws when JWT_SECRET is too short', () => {
    expect(() => parseEnv({ ...base, JWT_SECRET: 'short' } as NodeJS.ProcessEnv)).toThrow(ZodError);
  });

  it('throws when LLM_PROVIDER is not an allowed value', () => {
    expect(() => parseEnv({ ...base, LLM_PROVIDER: 'openai' } as NodeJS.ProcessEnv)).toThrow(ZodError);
  });
});
