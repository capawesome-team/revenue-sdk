import { describe, expect, it } from 'vitest';
import { bytesToBase64 } from '../../src/base64.ts';
import { parseWebhookEvent, verifyWebhook } from '../../src/providers/polar/webhooks.ts';
import { hmacSha256, sha256Hex } from '../../src/webhooks/verify.ts';
import { expectEvent } from '../helpers/webhook-events.ts';

const SECRET = 'whsec_ovyN6cPrTv56AApvzCaJno08SSmGJmgb';

async function sign(secret: string, id: string, timestamp: number, body: string) {
  return `v1,${bytesToBase64(await hmacSha256(secret, `${id}.${timestamp}.${body}`))}`;
}

function headersFor(id: string, timestamp: number, signature: string) {
  return {
    'webhook-id': id,
    'webhook-timestamp': String(timestamp),
    'webhook-signature': signature,
  };
}

describe('polar verifyWebhook', () => {
  it('accepts a valid signature computed over the verbatim secret', async () => {
    const body = JSON.stringify({ type: 'order.paid', data: { id: 'order-1' } });
    const timestamp = Math.floor(Date.now() / 1000);
    const signature = await sign(SECRET, 'msg_1', timestamp, body);
    await expect(
      verifyWebhook({ headers: headersFor('msg_1', timestamp, signature), body, secret: SECRET }),
    ).resolves.toBe(true);
  });

  it('rejects a signature computed with a stripped/base64-decoded secret', async () => {
    const body = '{}';
    const timestamp = Math.floor(Date.now() / 1000);
    // The Standard Webhooks spec strips `whsec_` and base64-decodes the rest; Polar does not.
    const strippedSecret = SECRET.slice('whsec_'.length);
    const signature = await sign(strippedSecret, 'msg_1', timestamp, body);
    await expect(
      verifyWebhook({ headers: headersFor('msg_1', timestamp, signature), body, secret: SECRET }),
    ).resolves.toBe(false);
  });

  it('accepts when any v1 signature matches and ignores other schemes', async () => {
    const body = '{}';
    const timestamp = Math.floor(Date.now() / 1000);
    const valid = await sign(SECRET, 'msg_1', timestamp, body);
    const header = `v2,bogus v1,notvalid ${valid}`;
    await expect(
      verifyWebhook({ headers: headersFor('msg_1', timestamp, header), body, secret: SECRET }),
    ).resolves.toBe(true);
  });

  it('rejects stale timestamps', async () => {
    const body = '{}';
    const timestamp = Math.floor(Date.now() / 1000) - 301;
    const signature = await sign(SECRET, 'msg_1', timestamp, body);
    await expect(
      verifyWebhook({ headers: headersFor('msg_1', timestamp, signature), body, secret: SECRET }),
    ).resolves.toBe(false);
  });

  it('rejects missing headers', async () => {
    await expect(verifyWebhook({ headers: {}, body: '{}', secret: SECRET })).resolves.toBe(false);
  });

  it('verifies a Request without consuming its body', async () => {
    const body = '{"type":"order.paid","data":{"id":"order-1"}}';
    const timestamp = Math.floor(Date.now() / 1000);
    const signature = await sign(SECRET, 'msg_1', timestamp, body);
    const request = new Request('https://example.com/webhook', {
      method: 'POST',
      headers: headersFor('msg_1', timestamp, signature),
      body,
    });
    await expect(verifyWebhook({ request, secret: SECRET })).resolves.toBe(true);
    await expect(request.text()).resolves.toBe(body);
  });
});

describe('polar parseWebhookEvent', () => {
  const subscription = {
    id: 'sub-uuid-1',
    status: 'active',
    cancel_at_period_end: false,
    customer_id: 'cus-uuid-1',
    product_id: 'prod-uuid-1',
  };
  const EVENT_HEADERS = { 'webhook-id': 'msg_1' };
  const OCCURRED_AT = '2026-08-06T12:00:00Z';

  it('maps subscription.created', async () => {
    const parsed = await parseWebhookEvent({
      headers: EVENT_HEADERS,
      body: JSON.stringify({
        type: 'subscription.created',
        timestamp: OCCURRED_AT,
        data: subscription,
      }),
    });
    const event = expectEvent(parsed, 'subscription.created');
    expect(event.providerType).toBe('subscription.created');
    expect(event.subscription.id).toBe('sub-uuid-1');
    expect(event.idempotencyKey).toBe('polar:msg_1');
    expect(event.createdAt).toEqual(new Date(OCCURRED_AT));
  });

  it('maps a scheduled cancellation to subscription.updated', async () => {
    const parsed = await parseWebhookEvent({
      headers: EVENT_HEADERS,
      body: JSON.stringify({
        type: 'subscription.canceled',
        timestamp: OCCURRED_AT,
        data: { ...subscription, cancel_at_period_end: true },
      }),
    });
    const event = expectEvent(parsed, 'subscription.updated');
    expect(event.subscription.cancelAtPeriodEnd).toBe(true);
    expect(event.subscription.status).toBe('active');
    expect(event.idempotencyKey).toBe('polar:msg_1');
    expect(event.createdAt).toEqual(new Date(OCCURRED_AT));
  });

  it.each([
    ['subscription.canceled', 'cancel_scheduled'],
    ['subscription.past_due', 'past_due'],
    ['subscription.paused', 'paused'],
    ['subscription.resumed', 'resumed'],
    ['subscription.uncanceled', 'uncanceled'],
  ])('reports the transition named by %s', async (providerType, subscriptionChange) => {
    const parsed = await parseWebhookEvent({
      headers: EVENT_HEADERS,
      body: JSON.stringify({ type: providerType, timestamp: OCCURRED_AT, data: subscription }),
    });
    const event = expectEvent(parsed, 'subscription.updated');
    expect(event.subscriptionChange).toBe(subscriptionChange);
  });

  it.each(['subscription.active', 'subscription.cycled', 'subscription.updated'])(
    'names no transition on %s',
    async (providerType) => {
      const parsed = await parseWebhookEvent({
        headers: EVENT_HEADERS,
        body: JSON.stringify({ type: providerType, timestamp: OCCURRED_AT, data: subscription }),
      });
      const event = expectEvent(parsed, 'subscription.updated');
      expect(event.subscriptionChange).toBeUndefined();
    },
  );

  it('reads the event time from the envelope, never from the webhook-timestamp header', async () => {
    const event = await parseWebhookEvent({
      headers: { ...EVENT_HEADERS, 'webhook-timestamp': '1000000000' },
      body: JSON.stringify({
        type: 'subscription.updated',
        timestamp: OCCURRED_AT,
        data: subscription,
      }),
    });
    expect(event.createdAt).toEqual(new Date(OCCURRED_AT));
  });

  it('leaves createdAt undefined for a missing or unparseable timestamp', async () => {
    const missing = await parseWebhookEvent({
      headers: EVENT_HEADERS,
      body: JSON.stringify({ type: 'subscription.updated', data: subscription }),
    });
    expect(missing.createdAt).toBeUndefined();

    const invalid = await parseWebhookEvent({
      headers: EVENT_HEADERS,
      body: JSON.stringify({
        type: 'subscription.updated',
        timestamp: 'not a date',
        data: subscription,
      }),
    });
    expect(invalid.createdAt).toBeUndefined();
  });

  it('reads the idempotency key from webhook-id case-insensitively', async () => {
    const event = await parseWebhookEvent({
      headers: { 'Webhook-Id': 'msg_2' },
      body: JSON.stringify({ type: 'subscription.updated', data: subscription }),
    });
    expect(event.idempotencyKey).toBe('polar:msg_2');
  });

  it('falls back to a body digest when the webhook-id header is absent', async () => {
    const body = JSON.stringify({ type: 'subscription.updated', data: subscription });
    const event = await parseWebhookEvent({ headers: {}, body });
    expect(event.idempotencyKey).toBe(`polar:sha256:${await sha256Hex(body)}`);
  });

  it('maps subscription.revoked to the terminal subscription.canceled', async () => {
    const parsed = await parseWebhookEvent({
      headers: EVENT_HEADERS,
      body: JSON.stringify({
        type: 'subscription.revoked',
        timestamp: OCCURRED_AT,
        data: { ...subscription, status: 'canceled', ended_at: '2026-08-06T00:00:00Z' },
      }),
    });
    const event = expectEvent(parsed, 'subscription.canceled');
    expect(event.subscription.status).toBe('canceled');
    expect(event.idempotencyKey).toBe('polar:msg_1');
    expect(event.createdAt).toEqual(new Date(OCCURRED_AT));
  });

  it('maps order.paid', async () => {
    const parsed = await parseWebhookEvent({
      headers: EVENT_HEADERS,
      body: JSON.stringify({
        type: 'order.paid',
        timestamp: OCCURRED_AT,
        data: {
          id: 'order-1',
          status: 'paid',
          created_at: '2026-08-01T00:00:00Z',
          total_amount: 2900,
          currency: 'usd',
          customer_id: 'cus-uuid-1',
          subscription_id: 'sub-uuid-1',
          metadata: { organization_id: 'org_1' },
        },
      }),
    });
    const event = expectEvent(parsed, 'order.paid');
    expect(event.order).toMatchObject({
      id: 'order-1',
      status: 'paid',
      amount: 2900,
      currency: 'usd',
      customerId: 'cus-uuid-1',
      subscriptionId: 'sub-uuid-1',
      createdAt: new Date('2026-08-01T00:00:00Z'),
      metadata: { organization_id: 'org_1' },
    });
    expect(event.idempotencyKey).toBe('polar:msg_1');
    expect(event.createdAt).toEqual(new Date(OCCURRED_AT));
  });

  it('maps a succeeded checkout.updated to checkout.completed', async () => {
    const parsed = await parseWebhookEvent({
      headers: EVENT_HEADERS,
      body: JSON.stringify({
        type: 'checkout.updated',
        timestamp: OCCURRED_AT,
        data: { id: 'checkout-1', status: 'succeeded', url: null },
      }),
    });
    const event = expectEvent(parsed, 'checkout.completed');
    expect(event.checkout.status).toBe('complete');
    expect(event.idempotencyKey).toBe('polar:msg_1');
    expect(event.createdAt).toEqual(new Date(OCCURRED_AT));
  });

  it('maps a license-keys benefit_grant.created to license.issued without the key', async () => {
    const parsed = await parseWebhookEvent({
      headers: EVENT_HEADERS,
      body: JSON.stringify({
        type: 'benefit_grant.created',
        timestamp: OCCURRED_AT,
        data: {
          id: 'grant-1',
          benefit: { id: 'ben-1', type: 'license_keys' },
          properties: {
            license_key_id: 'lk-uuid-1',
            display_key: '****-****-1234',
            user_provided_key: false,
          },
        },
      }),
    });
    const event = expectEvent(parsed, 'license.issued');
    expect(event.providerType).toBe('benefit_grant.created');
    expect(event.licenseKeyId).toBe('lk-uuid-1');
    // Polar sends only a masked `display_key`, so the full record is never available here.
    expect(event.licenseKey).toBeUndefined();
    expect(event.idempotencyKey).toBe('polar:msg_1');
    expect(event.createdAt).toEqual(new Date(OCCURRED_AT));
  });

  it('maps a benefit_grant.created for a non-license benefit to unknown', async () => {
    const event = await parseWebhookEvent({
      headers: EVENT_HEADERS,
      body: JSON.stringify({
        type: 'benefit_grant.created',
        timestamp: OCCURRED_AT,
        data: { id: 'grant-2', benefit: { id: 'ben-2', type: 'discord' }, properties: {} },
      }),
    });
    expect(event.type).toBe('unknown');
    expect(event.providerType).toBe('benefit_grant.created');
    expect(event.idempotencyKey).toBe('polar:msg_1');
    expect(event.createdAt).toEqual(new Date(OCCURRED_AT));
  });

  it('never throws on unknown event types', async () => {
    const event = await parseWebhookEvent({
      headers: EVENT_HEADERS,
      body: JSON.stringify({ type: 'benefit_grant.cycled', timestamp: OCCURRED_AT, data: {} }),
    });
    expect(event.type).toBe('unknown');
    expect(event.providerType).toBe('benefit_grant.cycled');
    expect(event.idempotencyKey).toBe('polar:msg_1');
    expect(event.createdAt).toEqual(new Date(OCCURRED_AT));
  });

  it('throws validation on unparseable payloads', async () => {
    await expect(
      parseWebhookEvent({ headers: EVENT_HEADERS, body: 'not json' }),
    ).rejects.toMatchObject({ code: 'validation' });
  });
});
