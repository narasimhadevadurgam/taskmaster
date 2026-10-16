import { z } from 'zod';

/** Default page size when `limit` is omitted. */
export const DEFAULT_LIMIT = 20;

/**
 * Shared limit/offset query fields reused by every paginated list endpoint.
 * limit is 1..100 (default 20); offset is >= 0 (default 0). Coerced from the
 * raw query strings by zod.
 */
export const paginationFields = {
  limit: z.coerce.number().int().min(1).max(100).default(DEFAULT_LIMIT),
  offset: z.coerce.number().int().min(0).default(0),
};

/** The pagination block returned in every list response. */
export interface Pagination {
  limit: number;
  offset: number;
  total: number;
}

/** A uniform paginated list envelope. */
export interface Paginated<T> {
  data: T[];
  pagination: Pagination;
}
