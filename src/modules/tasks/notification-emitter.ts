import type { PoolClient } from 'pg';

/**
 * A persisted notification snapshot the task service hands to the emitter after
 * computing recipients inside its write transaction. The payload mirrors the
 * design's fixed-key JSONB snapshot so the socket event and the REST fallback
 * carry an identical contract.
 */
export interface NotificationInput {
  /** Recipient user id (never the actor). */
  user_id: number;
  /** 'task_assigned' | 'task_updated'. */
  type: 'task_assigned' | 'task_updated';
  payload: {
    task_id: number;
    title: string;
    status: 'open' | 'in_progress' | 'completed';
    project_id: number | null;
    actor_id: number;
  };
}

/**
 * Seam the socket layer replaces with the real socket.io-backed emitter.
 *
 * The task service calls `persist` for each computed recipient INSIDE its write
 * transaction (passing the same transaction client so rows commit atomically
 * with the task change). `emit` is called best-effort AFTER commit, once per
 * persisted row, to push the row to the recipient's socket room.
 *
 * The default implementation (createNoopNotificationEmitter) persists the rows
 * (so GET /notifications works and the persistence contract holds even with no
 * socket layer attached) and makes `emit` a no-op. The socket-backed emitter
 * dispatches to socket.io while keeping the same `persist`.
 */
export interface NotificationEmitter {
  /**
   * Persist one notification row on the given transaction client and return the
   * created row's id and created_at so `emit` can carry the full contract.
   */
  persist(client: PoolClient, input: NotificationInput): Promise<PersistedNotification>;
  /** Best-effort delivery of a persisted row; must never throw to the caller. */
  emit(notification: PersistedNotification): void;
}

/** A persisted notification row (what emit receives). */
export interface PersistedNotification extends NotificationInput {
  id: number;
  read: boolean;
  created_at: Date;
}

/**
 * Default emitter: persists rows inside the task transaction and performs no
 * socket emit. This lets the task module work without a socket layer attached;
 * the socket-backed emitter injected at startup dispatches over socket.io.
 */
export function createNoopNotificationEmitter(): NotificationEmitter {
  return {
    async persist(client, input) {
      const result = await client.query<{ id: number; read: boolean; created_at: Date }>(
        `INSERT INTO notifications (user_id, type, payload)
         VALUES ($1, $2, $3::jsonb)
         RETURNING id, read, created_at`,
        [input.user_id, input.type, JSON.stringify(input.payload)]
      );
      const row = result.rows[0];
      return {
        ...input,
        id: row.id,
        read: row.read,
        created_at: row.created_at,
      };
    },
    emit() {
      // no-op: no socket layer attached.
    },
  };
}
