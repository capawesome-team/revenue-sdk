import { describe, expect, it } from 'vitest';
import { parseWebhookEvent, verifyWebhook } from '../../src/providers/paddle/webhooks.ts';
import { hmacSha256, sha256Hex, toHex } from '../../src/webhooks/verify.ts';

const SECRET = 'pdl_ntfset_01gkpjp8bkm3tm53kdgkx6sms7_secret';

async function sign(secret: string, timestamp: number, body: string) {
  return toHex(await hmacSha256(secret, `${timestamp}:${body}`));
}

describe('paddle verifyWebhook', () => {
  it('accepts a valid ts/h1 signature over ts:body', async () => {
    const body = JSON.stringify({ event_type: 'subscription.created', data: {} });
    const timestamp = Math.floor(Date.now() / 1000);
    const signature = await sign(SECRET, timestamp, body);
    await expect(
      verifyWebhook({
        headers: { 'Paddle-Signature': `ts=${timestamp};h1=${signature}` },
        body,
        secret: SECRET,
      }),
    ).resolves.toBe(true);
  });

  it('accepts any matching h1 during secret rotation', async () => {
    const body = '{}';
    const timestamp = Math.floor(Date.now() / 1000);
    const valid = await sign(SECRET, timestamp, body);
    await expect(
      verifyWebhook({
        headers: { 'paddle-signature': `ts=${timestamp};h1=${'a'.repeat(64)};h1=${valid}` },
        body,
        secret: SECRET,
      }),
    ).resolves.toBe(true);
  });

  it('rejects stale timestamps, bad signatures, and missing headers', async () => {
    const body = '{}';
    const stale = Math.floor(Date.now() / 1000) - 301;
    await expect(
      verifyWebhook({
        headers: { 'paddle-signature': `ts=${stale};h1=${await sign(SECRET, stale, body)}` },
        body,
        secret: SECRET,
      }),
    ).resolves.toBe(false);
    const timestamp = Math.floor(Date.now() / 1000);
    await expect(
      verifyWebhook({
        headers: { 'paddle-signature': `ts=${timestamp};h1=${'a'.repeat(64)}` },
        body,
        secret: SECRET,
      }),
    ).resolves.toBe(false);
    await expect(verifyWebhook({ headers: {}, body, secret: SECRET })).resolves.toBe(false);
  });
});

describe('paddle parseWebhookEvent', () => {
  const subscriptionData = {
    id: 'sub_1',
    status: 'active',
    customer_id: 'ctm_1',
    scheduled_change: null,
    items: [{ quantity: 1, price: { id: 'pri_1', product_id: 'pro_1' } }],
  };

  const OCCURRED_AT = '2026-08-06T12:00:00Z';

  it('maps subscription.created', async () => {
    const event = await parseWebhookEvent({
      headers: {},
      body: JSON.stringify({
        event_id: 'evt_1',
        event_type: 'subscription.created',
        occurred_at: OCCURRED_AT,
        data: subscriptionData,
      }),
    });
    expect(event.type).toBe('subscription.created');
    expect(event.subscription?.id).toBe('sub_1');
    expect(event.idempotencyKey).toBe('paddle:evt_1');
    expect(event.createdAt).toEqual(new Date(OCCURRED_AT));
    expect(event.subscriptionChange).toBeUndefined();
  });

  it('keys on event_id and ignores the per-delivery notification_id', async () => {
    const event = await parseWebhookEvent({
      headers: {},
      body: JSON.stringify({
        event_id: 'evt_1',
        // A dashboard replay of the same event mints a new notification_id.
        notification_id: 'ntf_replayed_9',
        event_type: 'subscription.updated',
        occurred_at: OCCURRED_AT,
        data: subscriptionData,
      }),
    });
    expect(event.idempotencyKey).toBe('paddle:evt_1');
  });

  it('falls back to a body digest when the envelope carries no event_id', async () => {
    const body = JSON.stringify({
      event_type: 'subscription.updated',
      data: subscriptionData,
    });
    const event = await parseWebhookEvent({ headers: {}, body });
    expect(event.idempotencyKey).toBe(`paddle:sha256:${await sha256Hex(body)}`);
    expect(event.createdAt).toBeUndefined();
  });

  it.each([
    ['subscription.past_due', 'past_due'],
    ['subscription.paused', 'paused'],
    ['subscription.resumed', 'resumed'],
  ])('reports the transition named by %s', async (eventType, subscriptionChange) => {
    const event = await parseWebhookEvent({
      headers: {},
      body: JSON.stringify({ event_id: 'evt_1', event_type: eventType, data: subscriptionData }),
    });
    expect(event.type).toBe('subscription.updated');
    expect(event.subscriptionChange).toBe(subscriptionChange);
  });

  it.each([
    'subscription.activated',
    'subscription.imported',
    'subscription.trialing',
    'subscription.updated',
  ])('maps %s to subscription.updated without naming a transition', async (eventType) => {
    const event = await parseWebhookEvent({
      headers: {},
      body: JSON.stringify({ event_id: 'evt_1', event_type: eventType, data: subscriptionData }),
    });
    expect(event.type).toBe('subscription.updated');
    expect(event.providerType).toBe(eventType);
    expect(event.subscription?.id).toBe('sub_1');
    expect(event.subscriptionChange).toBeUndefined();
  });

  it('maps a scheduled cancellation (subscription.updated + scheduled_change)', async () => {
    const event = await parseWebhookEvent({
      headers: {},
      body: JSON.stringify({
        event_id: 'evt_1',
        event_type: 'subscription.updated',
        occurred_at: OCCURRED_AT,
        data: {
          ...subscriptionData,
          scheduled_change: { action: 'cancel', effective_at: '2026-09-01T00:00:00Z' },
        },
      }),
    });
    expect(event.type).toBe('subscription.updated');
    expect(event.subscription?.cancelAtPeriodEnd).toBe(true);
    expect(event.subscription?.status).toBe('active');
    expect(event.idempotencyKey).toBe('paddle:evt_1');
    expect(event.createdAt).toEqual(new Date(OCCURRED_AT));
    // Paddle names no transition here: the cancellation is only visible in the payload.
    expect(event.subscriptionChange).toBeUndefined();
  });

  it('maps subscription.canceled as terminal', async () => {
    const event = await parseWebhookEvent({
      headers: {},
      body: JSON.stringify({
        event_id: 'evt_1',
        event_type: 'subscription.canceled',
        occurred_at: OCCURRED_AT,
        data: { ...subscriptionData, status: 'canceled', canceled_at: '2026-09-01T00:00:00Z' },
      }),
    });
    expect(event.type).toBe('subscription.canceled');
    expect(event.subscription?.status).toBe('canceled');
    expect(event.subscription?.endedAt).toEqual(new Date('2026-09-01T00:00:00Z'));
    expect(event.idempotencyKey).toBe('paddle:evt_1');
    expect(event.createdAt).toEqual(new Date(OCCURRED_AT));
    expect(event.subscriptionChange).toBeUndefined();
  });

  it('maps transaction.completed to order.paid with parsed string totals', async () => {
    const event = await parseWebhookEvent({
      headers: {},
      body: JSON.stringify({
        event_id: 'evt_1',
        event_type: 'transaction.completed',
        occurred_at: OCCURRED_AT,
        data: {
          id: 'txn_1',
          status: 'completed',
          customer_id: 'ctm_1',
          subscription_id: 'sub_1',
          currency_code: 'USD',
          custom_data: { org_id: 'org_1' },
          billed_at: '2026-08-02T00:00:00Z',
          details: { totals: { total: '2499', grand_total: '2499' } },
        },
      }),
    });
    expect(event.type).toBe('order.paid');
    expect(event.order).toMatchObject({
      id: 'txn_1',
      status: 'paid',
      amount: 2499,
      currency: 'usd',
      customerId: 'ctm_1',
      subscriptionId: 'sub_1',
      createdAt: new Date('2026-08-02T00:00:00Z'),
      metadata: { org_id: 'org_1' },
    });
    expect(event.idempotencyKey).toBe('paddle:evt_1');
    expect(event.createdAt).toEqual(new Date(OCCURRED_AT));
  });

  it('leaves transaction.paid unmapped to avoid double-firing', async () => {
    const event = await parseWebhookEvent({
      headers: {},
      body: JSON.stringify({
        event_id: 'evt_1',
        event_type: 'transaction.paid',
        occurred_at: OCCURRED_AT,
        data: { id: 'txn_1' },
      }),
    });
    expect(event.type).toBe('unknown');
    expect(event.idempotencyKey).toBe('paddle:evt_1');
    expect(event.createdAt).toEqual(new Date(OCCURRED_AT));
  });
});
