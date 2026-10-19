import { Router, type NextFunction, type Request, type Response } from 'express';
import { validate } from '../../middleware/validate.js';
import { AppError } from '../../errors/AppError.js';
import {
  listNotificationsQuerySchema,
  markReadSchema,
  notificationIdParamSchema,
  type ListNotificationsQuery,
} from './notifications.schemas.js';
import {
  listNotifications,
  markAllNotificationsRead,
  markNotificationRead,
} from './notifications.service.js';

/**
 * Notifications router. Mounted behind the global auth middleware, so req.user
 * is always present on these routes.
 */
export const notificationsRouter = Router();

function requireUser(req: Request): { id: number } {
  if (!req.user) {
    throw new AppError('UNAUTHENTICATED', 'Authentication required');
  }
  return req.user;
}

/** GET /notifications — the caller's notifications, newest-first, paginated. */
notificationsRouter.get(
  '/notifications',
  validate(listNotificationsQuerySchema, 'query'),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const user = requireUser(req);
      const result = await listNotifications(user.id, req.query as unknown as ListNotificationsQuery);
      res.status(200).json(result);
    } catch (err) {
      next(err);
    }
  }
);

/** POST /notifications/read-all — mark all the caller's notifications read. */
notificationsRouter.post(
  '/notifications/read-all',
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const user = requireUser(req);
      const updated = await markAllNotificationsRead(user.id);
      res.status(200).json({ updated });
    } catch (err) {
      next(err);
    }
  }
);

/** PATCH /notifications/:id — mark one notification read (owner-only). */
notificationsRouter.patch(
  '/notifications/:id',
  validate(notificationIdParamSchema, 'params'),
  validate(markReadSchema, 'body'),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const user = requireUser(req);
      const { id } = req.params as unknown as { id: number };
      const notification = await markNotificationRead(id, user.id);
      res.status(200).json({ notification });
    } catch (err) {
      next(err);
    }
  }
);
