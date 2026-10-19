import type { NextFunction, Request, Response } from 'express';
import { AppError } from '../errors/AppError.js';

/**
 * Fallback for unmatched routes. Forwards a NOT_FOUND AppError to the error
 * middleware so the response uses the uniform error shape.
 */
export function notFound(req: Request, _res: Response, next: NextFunction): void {
  next(new AppError('NOT_FOUND', `Route not found: ${req.method} ${req.path}`));
}
