import type { NextFunction, Request, Response } from 'express';
import type { ZodTypeAny } from 'zod';
import { AppError, type ErrorDetail } from '../errors/AppError.js';

export type ValidationSource = 'body' | 'params' | 'query';

/**
 * Factory producing an Express middleware that validates one request source
 * against a zod schema. On success the parsed (and coerced) value replaces the
 * original source so handlers read typed, normalized input. On failure it throws
 * a VALIDATION_ERROR with a details array of { path, message }.
 */
export function validate(schema: ZodTypeAny, source: ValidationSource) {
  return (req: Request, _res: Response, next: NextFunction): void => {
    const result = schema.safeParse(req[source]);
    if (!result.success) {
      const details: ErrorDetail[] = result.error.issues.map((issue) => ({
        path: issue.path.join('.'),
        message: issue.message,
      }));
      next(new AppError('VALIDATION_ERROR', 'Request validation failed', details));
      return;
    }
    // Express 4 query/params are getters on some versions; assign defensively.
    (req as unknown as Record<ValidationSource, unknown>)[source] = result.data;
    next();
  };
}
