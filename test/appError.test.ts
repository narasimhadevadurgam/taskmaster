import { describe, it, expect } from 'vitest';
import { AppError, ERROR_STATUS } from '../src/errors/AppError.js';

describe('AppError', () => {
  it('maps every code to its canonical HTTP status', () => {
    expect(ERROR_STATUS).toEqual({
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
    });
  });

  it('derives httpStatus from code', () => {
    expect(new AppError('NOT_FOUND', 'nope').httpStatus).toBe(404);
    expect(new AppError('CONFLICT', 'dup').httpStatus).toBe(409);
    expect(new AppError('INTERNAL', 'boom').httpStatus).toBe(500);
  });

  it('carries message and optional details', () => {
    const err = new AppError('VALIDATION_ERROR', 'bad', [{ path: 'email', message: 'required' }]);
    expect(err.code).toBe('VALIDATION_ERROR');
    expect(err.message).toBe('bad');
    expect(err.details).toEqual([{ path: 'email', message: 'required' }]);
    expect(err).toBeInstanceOf(Error);
    expect(err).toBeInstanceOf(AppError);
  });
});
