import express, { type Express } from 'express';
import { requestId } from './middleware/requestId.js';
import { notFound } from './middleware/notFound.js';
import { errorHandler } from './middleware/error.js';
import { healthRouter } from './modules/health/health.routes.js';

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

  // Routers
  app.use(healthRouter);
  // (auth, users, projects, tasks, comments, attachments, notifications, ai
  //  routers are mounted here by later FEATs)

  app.use(notFound);
  app.use(errorHandler);

  return app;
}
