import { createServer as createHttpServer, type Server } from 'node:http';
import type { Express } from 'express';
import type { Server as IOServer } from 'socket.io';
import { buildApp } from './app.js';
import { attachRealtime, detachRealtime } from './realtime/socket.js';
import { setNotificationEmitter } from './modules/tasks/tasks.service.js';
import { createSocketNotificationEmitter } from './modules/notifications/notifications.emitter.js';

export interface AppServer {
  /** The underlying Node HTTP server (socket.io is attached here). */
  http: Server;
  /** The Express app, exposed for tests and the realtime attach point. */
  app: Express;
  /** The attached socket.io server. */
  io: IOServer;
  /** Start listening on the given port; resolves once bound. */
  start: (port: number) => Promise<void>;
  /** Stop the server; resolves once closed. */
  stop: () => Promise<void>;
}

/**
 * Wrap buildApp() in an HTTP server with start/stop helpers, attach socket.io to
 * the same HTTP server, and swap the task service's no-op notification emitter
 * for the socket-backed one so PATCH /tasks pushes real-time events after commit.
 */
export function createServer(): AppServer {
  const app = buildApp();
  const http = createHttpServer(app);

  // Attach socket.io (JWT handshake auth + per-user rooms) and wire the real
  // notification emitter in place of the default no-op.
  const io = attachRealtime(http);
  setNotificationEmitter(createSocketNotificationEmitter());

  return {
    http,
    app,
    io,
    start: (port: number) =>
      new Promise<void>((resolve) => {
        http.listen(port, () => resolve());
      }),
    stop: () =>
      new Promise<void>((resolve, reject) => {
        // socket.io's close() also closes the HTTP server it is attached to, so
        // after detachRealtime() the HTTP server may already be closed. Only
        // call http.close() if it is still listening, and treat an
        // already-closed server (ERR_SERVER_NOT_RUNNING) as success since the
        // goal — a stopped server — is already met.
        void detachRealtime().finally(() => {
          if (!http.listening) {
            resolve();
            return;
          }
          http.close((err) => {
            if (err && (err as NodeJS.ErrnoException).code !== 'ERR_SERVER_NOT_RUNNING') {
              reject(err);
              return;
            }
            resolve();
          });
        });
      }),
  };
}
