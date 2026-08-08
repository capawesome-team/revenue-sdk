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

  it('honors an explicit retryable override in both directions', () => {
    expect(new RevenueError('x', { code: 'rate_limited', retryable: false }).retryable).toBe(false);
    expect(
      new RevenueError('x', { code: 'conflict', status: 409, retryable: true }).retryable,
    ).toBe(true);
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

  it('exposes the response body by reference', () => {
    const responseBody = { detail: [{ msg: 'invalid', input: 'user@example.com' }] };
    const error = new RevenueError('x', { code: 'validation', responseBody });
    expect(error.responseBody).toBe(responseBody);
  });

  it('keeps the response body out of enumeration and serialization', () => {
    const error = new RevenueError('x', {
      code: 'validation',
      responseBody: { key: 'sk_live_secret' },
    });
    // Non-enumerable so loggers, `util.inspect` and error reporters never pick the body up;
    // reading it has to be deliberate.
    expect(Object.keys(error)).not.toContain('responseBody');
    expect(Object.prototype.propertyIsEnumerable.call(error, 'responseBody')).toBe(false);
    expect(JSON.stringify(error)).not.toContain('sk_live_secret');
    expect(JSON.stringify({ ...error })).not.toContain('sk_live_secret');
  });

  it('leaves the response body unredacted', () => {
    const responseBody = { key: 'sk_test_123' };
    const error = new RevenueError('failed for sk_test_123', {
      code: 'validation',
      responseBody,
      secrets: ['sk_test_123'],
    });
    expect(error.message).toBe('failed for [redacted]');
    expect(error.responseBody).toBe(responseBody);
  });
});
