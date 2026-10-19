import { Router, type NextFunction, type Request, type Response } from 'express';
import { z } from 'zod';
import { validate } from '../../middleware/validate.js';
import { AppError } from '../../errors/AppError.js';
import { paginationFields } from '../shared/pagination.js';
import {
  addMemberSchema,
  createProjectSchema,
  projectIdParamSchema,
} from './projects.schemas.js';
import { addMember, createProject, getProject, listProjects } from './projects.service.js';

/**
 * Projects router. Mounted behind the global auth middleware, so req.user is
 * always present on these routes.
 */
export const projectsRouter = Router();

const listQuerySchema = z.object({ ...paginationFields });

function requireUser(req: Request): { id: number } {
  if (!req.user) {
    throw new AppError('UNAUTHENTICATED', 'Authentication required');
  }
  return req.user;
}

/** POST /projects — create a project (caller becomes owner). */
projectsRouter.post(
  '/projects',
  validate(createProjectSchema, 'body'),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const user = requireUser(req);
      const project = await createProject(user.id, req.body);
      res.status(201).json({ project });
    } catch (err) {
      next(err);
    }
  }
);

/** GET /projects — list projects the caller owns or belongs to. */
projectsRouter.get(
  '/projects',
  validate(listQuerySchema, 'query'),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const user = requireUser(req);
      const { limit, offset } = req.query as unknown as { limit: number; offset: number };
      const result = await listProjects(user.id, limit, offset);
      res.status(200).json(result);
    } catch (err) {
      next(err);
    }
  }
);

/** GET /projects/:id — a project plus its members (member-only, else 404). */
projectsRouter.get(
  '/projects/:id',
  validate(projectIdParamSchema, 'params'),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const user = requireUser(req);
      const { id } = req.params as unknown as { id: number };
      const result = await getProject(id, user.id);
      res.status(200).json(result);
    } catch (err) {
      next(err);
    }
  }
);

/** POST /projects/:id/members — owner-only member add. */
projectsRouter.post(
  '/projects/:id/members',
  validate(projectIdParamSchema, 'params'),
  validate(addMemberSchema, 'body'),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const user = requireUser(req);
      const { id } = req.params as unknown as { id: number };
      const member = await addMember(id, user.id, req.body);
      res.status(201).json({ member });
    } catch (err) {
      next(err);
    }
  }
);
