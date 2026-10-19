import type { NextFunction, Request, Response } from 'express';
import { AppError, type ErrorCode, type ErrorDetail } from '../errors/AppError.js';
import { logger } from '../utils/logger.js';

interface ErrorBody {
  error: {
    code: ErrorCode;
    message: string;
    request_id: string;
    details?: ErrorDetail[];
  };
}

/**
 * Build the uniform error body. Exported for unit tests of the error shape.
 */
export function buildErrorBody(
  code: ErrorCode,
  message: string,
  requestId: string,
  details?: ErrorDetail[]
): ErrorBody {
  const body: ErrorBody = { error: { code, message, request_id: requestId } };
  if (details && details.length > 0) {
    body.error.details = details;
  }
  return body;
}

/**
 * The SOLE place that writes error responses. AppErrors map directly to their
 * code/status/message. Anything else is logged with request_id + stack and
 * returned as a generic 500 INTERNAL with no internal detail leaked.
 */
export function errorHandler(
  err: unknown,
  req: Request,
  res: Response,
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  _next: NextFunction
): void {
  const requestId = req.requestId ?? 'unknown';

  if (err instanceof AppError) {
    logger.debug('request error', {
      request_id: requestId,
      code: err.code,
      message: err.message,
    });
    res
      .status(err.httpStatus)
      .json(buildErrorBody(err.code, err.message, requestId, err.details));
    return;
  }

  logger.error('unexpected error', {
    request_id: requestId,
    error: err instanceof Error ? err.message : String(err),
    stack: err instanceof Error ? err.stack : undefined,
  });
  res
    .status(500)
    .json(buildErrorBody('INTERNAL', 'Internal server error', requestId));
}
