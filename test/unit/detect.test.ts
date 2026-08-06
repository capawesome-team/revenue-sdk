import { describe, expect, it } from 'vitest';
import { detectWebhookProvider } from '../../src/webhooks/detect.ts';

describe('detectWebhookProvider', () => {
  it('detects Stripe by stripe-signature', async () => {
    await expect(
      detectWebhookProvider({ headers: { 'Stripe-Signature': 't=1,v1=a' }, body: '{}' }),
    ).resolves.toBe('stripe');
  });

  it('detects Paddle by paddle-signature', async () => {
    await expect(
      detectWebhookProvider({ headers: { 'Paddle-Signature': 'ts=1;h1=a' }, body: '{}' }),
    ).resolves.toBe('paddle');
  });

  it('detects Lemon Squeezy by x-signature', async () => {
    await expect(
      detectWebhookProvider({ headers: { 'X-Signature': 'abc' }, body: '{}' }),
    ).resolves.toBe('lemon-squeezy');
  });

  it('distinguishes Dodo Payments from Polar by business_id in the payload', async () => {
    const standardWebhookHeaders = {
      'webhook-id': 'msg_1',
      'webhook-timestamp': '1700000000',
      'webhook-signature': 'v1,abc',
    };
    await expect(
      detectWebhookProvider({
        headers: standardWebhookHeaders,
        body: JSON.stringify({ business_id: 'bus_1', type: 'payment.succeeded', data: {} }),
      }),
    ).resolves.toBe('dodo-payments');
    await expect(
      detectWebhookProvider({
        headers: standardWebhookHeaders,
        body: JSON.stringify({ type: 'order.paid', timestamp: '2026-01-01T00:00:00Z', data: {} }),
      }),
    ).resolves.toBe('polar');
  });

  it('returns undefined for unparseable standard-webhooks payloads', async () => {
    await expect(
      detectWebhookProvider({
        headers: { 'webhook-id': 'msg_1', 'webhook-signature': 'v1,abc' },
        body: 'not json',
      }),
    ).resolves.toBeUndefined();
  });

  it('returns undefined when no known headers are present', async () => {
    await expect(detectWebhookProvider({ headers: {}, body: '{}' })).resolves.toBeUndefined();
  });

  it('accepts a Request as input', async () => {
    const request = new Request('https://example.com/webhook', {
      method: 'POST',
      headers: { 'Stripe-Signature': 't=1,v1=a' },
      body: '{}',
    });
    await expect(detectWebhookProvider({ request })).resolves.toBe('stripe');
  });
});
