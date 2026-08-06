import { describe, expect, it } from 'vitest';
import { RevenueError } from '../../src/errors.ts';

describe('RevenueError', () => {
  it('exposes code, provider, and status', () => {
    const error = new RevenueError('not found', {
      code: 'not_found',
      provider: 'polar',
      status: 404,
    });
    expect(error).toBeInstanceOf(Error);
    expect(error.name).toBe('RevenueError');
    expect(error.code).toBe('not_found');
    expect(error.provider).toBe('polar');
    expect(error.status).toBe(404);
  });

  it('marks rate_limited and network_error as retryable by default', () => {
    expect(new RevenueError('x', { code: 'rate_limited' }).retryable).toBe(true);
    expect(new RevenueError('x', { code: 'network_error' }).retryable).toBe(true);
    expect(new RevenueError('x', { code: 'validation' }).retryable).toBe(false);
  });

  it('marks 5xx provider errors as retryable', () => {
    expect(new RevenueError('x', { code: 'provider_error', status: 500 }).retryable).toBe(true);
    expect(new RevenueError('x', { code: 'provider_error', status: 400 }).retryable).toBe(false);
  });

  it('honors an explicit retryable override', () => {
    expect(new RevenueError('x', { code: 'rate_limited', retryable: false }).retryable).toBe(false);
  });

  it('redacts secrets from the message', () => {
    const error = new RevenueError('request with key sk_test_123 failed', {
      code: 'provider_error',
      secrets: ['sk_test_123'],
    });
    expect(error.message).toBe('request with key [redacted] failed');
  });

  it('preserves the cause', () => {
    const cause = new Error('boom');
    expect(new RevenueError('x', { code: 'network_error', cause }).cause).toBe(cause);
  });
});
