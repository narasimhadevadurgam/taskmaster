import { describe, it, expect } from 'vitest';
import type { NextFunction, Request, Response } from 'express';
import { errorHandler, buildErrorBody } from '../src/middleware/error.js';
import { AppError } from '../src/errors/AppError.js';

const noopNext: NextFunction = () => undefined;

function makeRes() {
  const res = {
    statusCode: 0,
    body: undefined as unknown,
    status(code: number) {
      this.statusCode = code;
      return this;
    },
    json(payload: unknown) {
      this.body = payload;
      return this;
    },
  };
  return res as unknown as Response & { statusCode: number; body: unknown };
}

describe('error middleware shape', () => {
  it('builds the uniform body without details when none given', () => {
    expect(buildErrorBody('NOT_FOUND', 'missing', 'rid-1')).toEqual({
      error: { code: 'NOT_FOUND', message: 'missing', request_id: 'rid-1' },
    });
  });

  it('includes details when present', () => {
    expect(
      buildErrorBody('VALIDATION_ERROR', 'bad', 'rid-2', [{ path: 'email', message: 'required' }])
    ).toEqual({
      error: {
        code: 'VALIDATION_ERROR',
        message: 'bad',
        request_id: 'rid-2',
        details: [{ path: 'email', message: 'required' }],
      },
    });
  });

  it('maps an AppError to its code, status, and request_id', () => {
    const req = { requestId: 'rid-3' } as Request;
    const res = makeRes();
    errorHandler(new AppError('CONFLICT', 'duplicate email'), req, res, noopNext);
    expect(res.statusCode).toBe(409);
    expect(res.body).toEqual({
      error: { code: 'CONFLICT', message: 'duplicate email', request_id: 'rid-3' },
    });
  });

  it('maps an unexpected error to a generic 500 INTERNAL and leaks nothing', () => {
    const req = { requestId: 'rid-4' } as Request;
    const res = makeRes();
    errorHandler(new Error('secret stack detail'), req, res, noopNext);
    expect(res.statusCode).toBe(500);
    expect(res.body).toEqual({
      error: { code: 'INTERNAL', message: 'Internal server error', request_id: 'rid-4' },
    });
  });
});
