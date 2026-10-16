import { createServer as createHttpServer, type Server } from 'node:http';
import type { Express } from 'express';
import { buildApp } from './app.js';

export interface AppServer {
  /** The underlying Node HTTP server (socket.io attaches here in FEAT-004). */
  http: Server;
  /** The Express app, exposed for tests and the realtime attach point. */
  app: Express;
  /** Start listening on the given port; resolves once bound. */
  start: (port: number) => Promise<void>;
  /** Stop the server; resolves once closed. */
  stop: () => Promise<void>;
}

/**
 * Wrap buildApp() in an HTTP server with start/stop helpers. The socket.io
 * server will attach to `http` in FEAT-004; the attach point is reserved here.
 */
export function createServer(): AppServer {
  const app = buildApp();
  const http = createHttpServer(app);

  // FEAT-004 reserved: attachRealtime(http) will mount socket.io on this server.

  return {
    http,
    app,
    start: (port: number) =>
      new Promise<void>((resolve) => {
        http.listen(port, () => resolve());
      }),
    stop: () =>
      new Promise<void>((resolve, reject) => {
        http.close((err) => (err ? reject(err) : resolve()));
      }),
  };
}
