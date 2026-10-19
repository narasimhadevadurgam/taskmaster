/**
 * The closed set of application error codes. Each maps to a fixed HTTP status
 * (see ERROR_STATUS). Services throw AppError with one of these codes; the error
 * middleware is the single place that translates them into the uniform body.
 */
export type ErrorCode =
  | 'VALIDATION_ERROR'
  | 'UNAUTHENTICATED'
  | 'FORBIDDEN'
  | 'NOT_FOUND'
  | 'CONFLICT'
  | 'PAYLOAD_TOO_LARGE'
  | 'UNSUPPORTED_MEDIA_TYPE'
  | 'AI_UNAVAILABLE'
  | 'SERVICE_UNAVAILABLE'
  | 'INTERNAL';

/** Canonical code -> HTTP status mapping used by the error middleware. */
export const ERROR_STATUS: Record<ErrorCode, number> = {
  VALIDATION_ERROR: 400,
  UNAUTHENTICATED: 401,
  FORBIDDEN: 403,
  NOT_FOUND: 404,
  CONFLICT: 409,
  PAYLOAD_TOO_LARGE: 413,
  UNSUPPORTED_MEDIA_TYPE: 415,
  AI_UNAVAILABLE: 502,
  SERVICE_UNAVAILABLE: 503,
  INTERNAL: 500,
};

/** One entry of a validation error details array. */
export interface ErrorDetail {
  path: string;
  message: string;
}

/**
 * Typed application error. The httpStatus is derived from the code via
 * ERROR_STATUS by default, so callers only pass the code and a message.
 */
export class AppError extends Error {
  readonly code: ErrorCode;
  readonly httpStatus: number;
  readonly details?: ErrorDetail[];

  constructor(code: ErrorCode, message: string, details?: ErrorDetail[]) {
    super(message);
    this.name = 'AppError';
    this.code = code;
    this.httpStatus = ERROR_STATUS[code];
    this.details = details;
    Object.setPrototypeOf(this, AppError.prototype);
  }
}
