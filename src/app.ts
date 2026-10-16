import express, { type Express } from 'express';
import { requestId } from './middleware/requestId.js';
import { authenticate } from './middleware/auth.js';
import { notFound } from './middleware/notFound.js';
import { errorHandler } from './middleware/error.js';
import { healthRouter } from './modules/health/health.routes.js';
import { authRouter } from './modules/auth/auth.routes.js';
import { usersRouter } from './modules/users/users.routes.js';

/**
 * Build the Express application with middleware and routers wired in order:
 * requestId -> json body parser -> routers -> notFound -> error handler (last).
 * Exported so tests can exercise the app via supertest without a live server.
 * Later FEATs mount their routers in the "routers" section below.
 */
export function buildApp(): Express {
  const app = express();

  app.use(requestId);
  app.use(express.json());

  // Public routers: /health and /auth require no authentication. The logout
  // route inside authRouter applies the auth middleware itself.
  app.use(healthRouter);
  app.use(authRouter);

  // Everything mounted below the authenticate middleware is protected: a valid,
  // non-blocklisted JWT is required and req.user is populated. Later FEATs mount
  // their protected routers (projects, tasks, comments, attachments,
  // notifications, ai) in the "protected routers" section below.
  app.use(authenticate);

  // Protected routers
  app.use(usersRouter);

  app.use(notFound);
  app.use(errorHandler);

  return app;
}
