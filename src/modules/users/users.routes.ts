import { Router, type NextFunction, type Request, type Response } from 'express';
import { validate } from '../../middleware/validate.js';
import { AppError } from '../../errors/AppError.js';
import { updateMeSchema } from './users.schemas.js';
import { getUserById, updateUser } from './users.service.js';

/**
 * Users router. These routes assume the auth middleware has already run (it is
 * applied globally to all non-/auth, non-/health routes in buildApp), so
 * req.user is guaranteed present here.
 */
export const usersRouter = Router();

/** GET /users/me — the authenticated user's canonical profile. */
usersRouter.get('/users/me', async (req: Request, res: Response, next: NextFunction) => {
  try {
    if (!req.user) {
      throw new AppError('UNAUTHENTICATED', 'Authentication required');
    }
    const user = await getUserById(req.user.id);
    res.status(200).json({ user });
  } catch (err) {
    next(err);
  }
});

/** PATCH /users/me — update provided profile fields; email collision -> 409. */
usersRouter.patch(
  '/users/me',
  validate(updateMeSchema, 'body'),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      if (!req.user) {
        throw new AppError('UNAUTHENTICATED', 'Authentication required');
      }
      const user = await updateUser(req.user.id, req.body);
      res.status(200).json({ user });
    } catch (err) {
      next(err);
    }
  }
);
