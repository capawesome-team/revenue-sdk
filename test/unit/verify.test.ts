import { describe, expect, it } from 'vitest';
import {
  hmacSha256,
  isTimestampWithinTolerance,
  timingSafeEqual,
  toHex,
  toIncomingWebhook,
} from '../../src/webhooks/verify.ts';

describe('hmacSha256', () => {
  it('computes the RFC test vector', async () => {
    const mac = await hmacSha256('key', 'The quick brown fox jumps over the lazy dog');
    expect(toHex(mac)).toBe('f7bc83f430538424b13298e6aa6fb143ef4d59a14946175997479dbc2d1a3cd8');
  });

  it('accepts raw key bytes', async () => {
    const fromString = await hmacSha256('key', 'message');
    const fromBytes = await hmacSha256(new TextEncoder().encode('key'), 'message');
    expect(toHex(fromBytes)).toBe(toHex(fromString));
  });
});

describe('toHex', () => {
  it('pads single-digit bytes', () => {
    expect(toHex(new Uint8Array([0, 15, 255]))).toBe('000fff');
  });
});

describe('timingSafeEqual', () => {
  it('matches equal strings', () => {
    expect(timingSafeEqual('abc123', 'abc123')).toBe(true);
  });

  it('rejects different strings and lengths', () => {
    expect(timingSafeEqual('abc123', 'abc124')).toBe(false);
    expect(timingSafeEqual('abc', 'abcd')).toBe(false);
  });
});

describe('isTimestampWithinTolerance', () => {
  const now = 1_800_000_000_000;

  it('accepts timestamps within tolerance', () => {
    expect(isTimestampWithinTolerance(1_800_000_000 - 200, 300, now)).toBe(true);
    expect(isTimestampWithinTolerance(1_800_000_000 + 200, 300, now)).toBe(true);
  });

  it('rejects timestamps outside tolerance', () => {
    expect(isTimestampWithinTolerance(1_800_000_000 - 301, 300, now)).toBe(false);
    expect(isTimestampWithinTolerance(1_800_000_000 + 301, 300, now)).toBe(false);
  });

  it('rejects non-finite timestamps', () => {
    expect(isTimestampWithinTolerance(Number.NaN, 300, now)).toBe(false);
  });
});

describe('toIncomingWebhook', () => {
  it('lowercases header names from a plain object', async () => {
    const incoming = await toIncomingWebhook({
      headers: { 'X-Signature': 'abc' },
      body: '{}',
    });
    expect(incoming.headers['x-signature']).toBe('abc');
    expect(incoming.body).toBe('{}');
  });

  it('reads headers and body from a Request without consuming it', async () => {
    const request = new Request('https://example.com/webhook', {
      method: 'POST',
      headers: { 'Stripe-Signature': 't=1,v1=abc' },
      body: '{"id":"evt_1"}',
    });
    const incoming = await toIncomingWebhook({ request });
    expect(incoming.headers['stripe-signature']).toBe('t=1,v1=abc');
    expect(incoming.body).toBe('{"id":"evt_1"}');
    await expect(request.text()).resolves.toBe('{"id":"evt_1"}');
  });
});
