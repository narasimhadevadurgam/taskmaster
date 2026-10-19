import { describe, it, expect, vi } from 'vitest';
import type { Request, Response } from 'express';
import { requestId } from '../src/middleware/requestId.js';

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function makeReqRes(headerValue?: string) {
  const headers: Record<string, string> = {};
  const req = {
    header: (name: string) => (name === 'X-Request-Id' ? headerValue : undefined),
  } as unknown as Request;
  const res = {
    setHeader: (name: string, value: string) => {
      headers[name] = value;
    },
  } as unknown as Response;
  return { req, res, headers };
}

describe('requestId middleware', () => {
  it('reuses a well-formed incoming UUID', () => {
    const incoming = '123e4567-e89b-12d3-a456-426614174000';
    const { req, res, headers } = makeReqRes(incoming);
    const next = vi.fn();
    requestId(req, res, next);
    expect(req.requestId).toBe(incoming);
    expect(headers['X-Request-Id']).toBe(incoming);
    expect(next).toHaveBeenCalledOnce();
  });

  it('regenerates when the incoming id is not a valid UUID', () => {
    const { req, res, headers } = makeReqRes('not-a-uuid; rm -rf');
    const next = vi.fn();
    requestId(req, res, next);
    expect(req.requestId).not.toBe('not-a-uuid; rm -rf');
    expect(UUID_RE.test(req.requestId)).toBe(true);
    expect(headers['X-Request-Id']).toBe(req.requestId);
    expect(next).toHaveBeenCalledOnce();
  });

  it('generates a UUID when no header is present', () => {
    const { req, res } = makeReqRes(undefined);
    const next = vi.fn();
    requestId(req, res, next);
    expect(UUID_RE.test(req.requestId)).toBe(true);
  });
});
