import { Router, type NextFunction, type Request, type Response } from 'express';
import { validate } from '../../middleware/validate.js';
import { AppError } from '../../errors/AppError.js';
import {
  commentTaskIdParamSchema,
  createCommentSchema,
  listCommentsQuerySchema,
} from './comments.schemas.js';
import { createComment, listComments } from './comments.service.js';

/**
 * Comments router (nested under task). Mounted behind the global auth
 * middleware, so req.user is always present.
 */
export const commentsRouter = Router();

function requireUser(req: Request): { id: number } {
  if (!req.user) {
    throw new AppError('UNAUTHENTICATED', 'Authentication required');
  }
  return req.user;
}

/** POST /tasks/:id/comments — add a comment (task-visibility required). */
commentsRouter.post(
  '/tasks/:id/comments',
  validate(commentTaskIdParamSchema, 'params'),
  validate(createCommentSchema, 'body'),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const user = requireUser(req);
      const { id } = req.params as unknown as { id: number };
      const comment = await createComment(id, user.id, req.body);
      res.status(201).json({ comment });
    } catch (err) {
      next(err);
    }
  }
);

/** GET /tasks/:id/comments — list comments (task-visibility required). */
commentsRouter.get(
  '/tasks/:id/comments',
  validate(commentTaskIdParamSchema, 'params'),
  validate(listCommentsQuerySchema, 'query'),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const user = requireUser(req);
      const { id } = req.params as unknown as { id: number };
      const { limit, offset } = req.query as unknown as { limit: number; offset: number };
      const result = await listComments(id, user.id, limit, offset);
      res.status(200).json(result);
    } catch (err) {
      next(err);
    }
  }
);
