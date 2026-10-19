import { Router, type Request, type Response, type NextFunction } from 'express';
import { query } from '../../db/pool.js';
import { AppError } from '../../errors/AppError.js';

export const healthRouter = Router();

/**
 * GET /health — liveness + DB readiness. Runs a cheap SELECT 1. Returns
 * 200 { status: 'ok' } on success; on DB failure forwards a SERVICE_UNAVAILABLE
 * AppError so the error middleware emits the uniform 503 body.
 */
healthRouter.get('/health', async (_req: Request, res: Response, next: NextFunction) => {
  try {
    await query('SELECT 1');
    res.status(200).json({ status: 'ok' });
  } catch {
    next(new AppError('SERVICE_UNAVAILABLE', 'Database is unreachable'));
  }
});
