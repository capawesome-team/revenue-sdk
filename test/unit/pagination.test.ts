import { describe, expect, it } from 'vitest';
import { RevenueError } from '../../src/errors.ts';
import {
  assertSameOriginUrl,
  clampLimit,
  decodeCursor,
  encodeCursor,
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
});
