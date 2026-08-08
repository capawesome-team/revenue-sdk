import { describe, expect, it } from 'vitest';
import { RevenueError } from '../../src/errors.ts';
import {
  assertSameOriginUrl,
  clampLimit,
  decodeCursor,
  encodeCursor,
  pageNumberCursor,
} from '../../src/pagination.ts';

async function expectRevenueError(fn: () => unknown, code: string): Promise<void> {
  try {
    fn();
    expect.unreachable('expected RevenueError');
  } catch (error) {
    expect(error).toBeInstanceOf(RevenueError);
    expect((error as RevenueError).code).toBe(code);
  }
}

describe('cursor', () => {
  it('round-trips cursor state', () => {
    const cursor = encodeCursor('polar', { page: 3 });
    expect(decodeCursor<{ page: number }>('polar', cursor)).toEqual({ page: 3 });
  });

  it('rejects a cursor from another provider', async () => {
    const cursor = encodeCursor('stripe', { startingAfter: 'sub_1' });
    await expectRevenueError(() => decodeCursor('polar', cursor), 'validation');
  });

  it('rejects a malformed cursor', async () => {
    await expectRevenueError(() => decodeCursor('polar', 'not-a-cursor!'), 'validation');
  });
});

describe('assertSameOriginUrl', () => {
  it('accepts a same-origin URL', () => {
    expect(() =>
      assertSameOriginUrl(
        'paddle',
        'https://api.paddle.com',
        'https://api.paddle.com/customers?after=ctm_1',
      ),
    ).not.toThrow();
  });

  it('rejects a cross-origin URL', async () => {
    await expectRevenueError(
      () => assertSameOriginUrl('paddle', 'https://api.paddle.com', 'https://evil.example.com/x'),
      'validation',
    );
  });

  it('rejects an invalid URL', async () => {
    await expectRevenueError(
      () => assertSameOriginUrl('paddle', 'https://api.paddle.com', 'not a url'),
      'validation',
    );
  });
});

describe('clampLimit', () => {
  it('falls back when undefined', () => {
    expect(clampLimit(undefined, 10, 100)).toBe(10);
  });

  it('clamps into range', () => {
    expect(clampLimit(0, 10, 100)).toBe(1);
    expect(clampLimit(1000, 10, 100)).toBe(100);
    expect(clampLimit(25.7, 10, 100)).toBe(25);
  });

  it('falls back on a non-finite limit', () => {
    // `Math.trunc(NaN)` is `NaN`, which would reach the wire as `limit=NaN`.
    expect(clampLimit(Number.NaN, 10, 100)).toBe(10);
    expect(clampLimit(Number.POSITIVE_INFINITY, 10, 100)).toBe(10);
  });
});

describe('pageNumberCursor', () => {
  const pages = pageNumberCursor('polar', {
    startPage: 1,
    defaultLimit: 10,
    maxLimit: 100,
    pageKey: 'page',
    limitKey: 'limit',
  });

  it('starts at the configured page and names the query parameters', () => {
    expect(pages.read(undefined, undefined)).toEqual({
      page: 1,
      limit: 10,
      query: { page: 1, limit: 10 },
    });
  });

  it('round-trips the page number through the cursor', () => {
    const cursor = pages.next(1, true);
    expect(cursor).toBeDefined();
    expect(pages.read(cursor, 25)).toEqual({
      page: 2,
      limit: 25,
      query: { page: 2, limit: 25 },
    });
  });

  it('ends the walk when there are no more pages', () => {
    expect(pages.next(3, false)).toBeUndefined();
  });

  it('supports zero-based page numbers', () => {
    const zeroBased = pageNumberCursor('dodo-payments', {
      startPage: 0,
      defaultLimit: 10,
      maxLimit: 100,
      pageKey: 'page_number',
      limitKey: 'page_size',
    });
    expect(zeroBased.read(undefined, undefined).query).toEqual({ page_number: 0, page_size: 10 });
  });

  it('rejects a cursor from another provider', async () => {
    await expectRevenueError(
      () => pages.read(encodeCursor('stripe', { page: 2 }), 10),
      'validation',
    );
  });
});
