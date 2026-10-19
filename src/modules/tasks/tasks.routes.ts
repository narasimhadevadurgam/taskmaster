import { Router, type NextFunction, type Request, type Response } from 'express';
import { unlink } from 'node:fs/promises';
import { isAbsolute, resolve } from 'node:path';
import { config } from '../../config/env.js';
import { validate } from '../../middleware/validate.js';
import { AppError } from '../../errors/AppError.js';
import { logger } from '../../utils/logger.js';
import {
  createTaskSchema,
  listTasksQuerySchema,
  taskIdParamSchema,
  updateTaskSchema,
  type ListTasksQuery,
} from './tasks.schemas.js';
import {
  createTask,
  deleteTask,
  getTask,
  listTasks,
  updateTask,
} from './tasks.service.js';

/**
 * Tasks router. Mounted behind the global auth middleware, so req.user is
 * always present on these routes.
 */
export const tasksRouter = Router();

function requireUser(req: Request): { id: number } {
  if (!req.user) {
    throw new AppError('UNAUTHENTICATED', 'Authentication required');
  }
  return req.user;
}

/** POST /tasks — create a task (creator is the caller). */
tasksRouter.post(
  '/tasks',
  validate(createTaskSchema, 'body'),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const user = requireUser(req);
      const task = await createTask(user.id, req.body);
      res.status(201).json({ task });
    } catch (err) {
      next(err);
    }
  }
);

/** GET /tasks — list visible tasks with filter/sort/search/pagination. */
tasksRouter.get(
  '/tasks',
  validate(listTasksQuerySchema, 'query'),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const user = requireUser(req);
      const q = req.query as unknown as ListTasksQuery;
      const result = await listTasks(user.id, q);
      res.status(200).json(result);
    } catch (err) {
      next(err);
    }
  }
);

/** GET /tasks/:id — a single visible task (non-visible -> 404). */
tasksRouter.get(
  '/tasks/:id',
  validate(taskIdParamSchema, 'params'),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const user = requireUser(req);
      const { id } = req.params as unknown as { id: number };
      const task = await getTask(id, user.id);
      res.status(200).json({ task });
    } catch (err) {
      next(err);
    }
  }
);

/** PATCH /tasks/:id — update mutable fields; authorization in the service. */
tasksRouter.patch(
  '/tasks/:id',
  validate(taskIdParamSchema, 'params'),
  validate(updateTaskSchema, 'body'),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const user = requireUser(req);
      const { id } = req.params as unknown as { id: number };
      const task = await updateTask(id, user.id, req.body);
      res.status(200).json({ task });
    } catch (err) {
      next(err);
    }
  }
);

/** DELETE /tasks/:id — creator or project owner; best-effort file unlink. */
tasksRouter.delete(
  '/tasks/:id',
  validate(taskIdParamSchema, 'params'),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const user = requireUser(req);
      const { id } = req.params as unknown as { id: number };
      const paths = await deleteTask(id, user.id);
      // Best-effort unlink of attachment files; failures are logged, not fatal.
      const baseDir = resolve(config.UPLOAD_DIR);
      await Promise.all(
        paths.map(async (p) => {
          const abs = isAbsolute(p) ? p : resolve(baseDir, p);
          try {
            await unlink(abs);
          } catch (err) {
            logger.warn('attachment unlink failed on task delete', {
              path: p,
              error: err instanceof Error ? err.message : String(err),
            });
          }
        })
      );
      res.status(204).end();
    } catch (err) {
      next(err);
    }
  }
);
