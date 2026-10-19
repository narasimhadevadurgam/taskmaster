import { Router, type NextFunction, type Request, type Response } from 'express';
import { validate } from '../../middleware/validate.js';
import { authenticate } from '../../middleware/auth.js';
import { AppError } from '../../errors/AppError.js';
import { loginSchema, registerSchema } from './auth.schemas.js';
import { loginUser, logoutUser, registerUser } from './auth.service.js';

export const authRouter = Router();

/**
 * POST /auth/register — public. Creates a user and returns the canonical public
 * user (never password_hash). Duplicate email -> 409 CONFLICT.
 */
authRouter.post(
  '/auth/register',
  validate(registerSchema, 'body'),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const user = await registerUser(req.body);
      res.status(201).json({ user });
    } catch (err) {
      next(err);
    }
  }
);

/**
 * POST /auth/login — public. Verifies credentials and returns { token, user }.
 * Bad credentials -> 401 (generic, no enumeration).
 */
authRouter.post(
  '/auth/login',
  validate(loginSchema, 'body'),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const result = await loginUser(req.body);
      res.status(200).json(result);
    } catch (err) {
      next(err);
    }
  }
);

/**
 * POST /auth/logout — auth-protected. Blocklists the current token's jti so it
 * is rejected on reuse. Idempotent; always returns { status: 'logged_out' }.
 */
authRouter.post(
  '/auth/logout',
  authenticate,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      if (!req.user || !req.auth) {
        throw new AppError('UNAUTHENTICATED', 'Authentication required');
      }
      await logoutUser(req.user.id, req.auth.jti, req.auth.exp);
      res.status(200).json({ status: 'logged_out' });
    } catch (err) {
      next(err);
    }
  }
);
