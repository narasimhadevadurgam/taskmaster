import { emitNotification } from '../../realtime/socket.js';
import {
  createNoopNotificationEmitter,
  type NotificationEmitter,
  type PersistedNotification,
} from '../tasks/notification-emitter.js';

/**
 * The real notification emitter (FEAT-004). It keeps the no-op's `persist`
 * verbatim — rows are still INSERTed on the task transaction client so they
 * commit atomically with the task change — and makes `emit` dispatch the
 * persisted row over socket.io to the recipient's room. The task service calls
 * emit best-effort AFTER commit and swallows any throw, so emit never fails the
 * task operation.
 */
export function createSocketNotificationEmitter(): NotificationEmitter {
  const base = createNoopNotificationEmitter();
  return {
    persist: base.persist,
    emit(notification: PersistedNotification): void {
      emitNotification(notification.user_id, notification);
    },
  };
}
