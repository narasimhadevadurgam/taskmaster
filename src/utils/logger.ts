type Level = 'debug' | 'info' | 'warn' | 'error';

interface LogFields {
  request_id?: string;
  [key: string]: unknown;
}

function emit(level: Level, message: string, fields: LogFields = {}): void {
  const line = {
    level,
    time: new Date().toISOString(),
    message,
    ...fields,
  };
  const serialized = JSON.stringify(line);
  if (level === 'error') {
    // eslint-disable-next-line no-console
    console.error(serialized);
  } else if (level === 'warn') {
    // eslint-disable-next-line no-console
    console.warn(serialized);
  } else {
    // eslint-disable-next-line no-console
    console.log(serialized);
  }
}

/**
 * Minimal structured logger. Each call accepts an optional fields object that
 * typically carries request_id so logs can be correlated to a request.
 */
export const logger = {
  debug: (message: string, fields?: LogFields) => emit('debug', message, fields),
  info: (message: string, fields?: LogFields) => emit('info', message, fields),
  warn: (message: string, fields?: LogFields) => emit('warn', message, fields),
  error: (message: string, fields?: LogFields) => emit('error', message, fields),
};

export type Logger = typeof logger;
