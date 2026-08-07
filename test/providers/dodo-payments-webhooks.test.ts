import { describe, expect, it } from 'vitest';
import { bytesToBase64 } from '../../src/base64.ts';
import { parseWebhookEvent, verifyWebhook } from '../../src/providers/dodo-payments/webhooks.ts';
import { hmacSha256, sha256Hex } from '../../src/webhooks/verify.ts';

// Standard Webhooks secret: whsec_ + base64-encoded key bytes.
const KEY_BYTES = new TextEncoder().encode('dodo-secret-key-bytes');
const SECRET = `whsec_${bytesToBase64(KEY_BYTES)}`;

async function sign(id: string, timestamp: number, body: string) {
  return `v1,${bytesToBase64(await hmacSha256(KEY_BYTES, `${id}.${timestamp}.${body}`))}`;
}

function headersFor(id: string, timestamp: number, signature: string) {
  return {
    'webhook-id': id,
    'webhook-timestamp': String(timestamp),
    'webhook-signature': signature,
  };
}

describe('dodo-payments verifyWebhook', () => {
  it('accepts a signature keyed by the base64-DECODED secret', async () => {
    const body = JSON.stringify({ business_id: 'bus_1', type: 'payment.succeeded', data: {} });
    const timestamp = Math.floor(Date.now() / 1000);
    const signature = await sign('msg_1', timestamp, body);
    await expect(
      verifyWebhook({ headers: headersFor('msg_1', timestamp, signature), body, secret: SECRET }),
    ).resolves.toBe(true);
  });

  it('rejects a signature computed over the verbatim secret (Polar-style)', async () => {
    const body = '{}';
    const timestamp = Math.floor(Date.now() / 1000);
    const verbatim = `v1,${bytesToBase64(await hmacSha256(SECRET, `msg_1.${timestamp}.${body}`))}`;
    await expect(
      verifyWebhook({ headers: headersFor('msg_1', timestamp, verbatim), body, secret: SECRET }),
    ).resolves.toBe(false);
  });

  it('rejects stale timestamps and invalid secrets without throwing', async () => {
    const body = '{}';
    const stale = Math.floor(Date.now() / 1000) - 301;
    await expect(
      verifyWebhook({
        headers: headersFor('msg_1', stale, await sign('msg_1', stale, body)),
        body,
        secret: SECRET,
      }),
    ).resolves.toBe(false);
    const timestamp = Math.floor(Date.now() / 1000);
    await expect(
      verifyWebhook({
        headers: headersFor('msg_1', timestamp, 'v1,abc'),
        body,
        secret: 'whsec_%%%not-base64%%%',
      }),
    ).resolves.toBe(false);
  });
});

describe('dodo-payments parseWebhookEvent', () => {
  const subscriptionData = {
    subscription_id: 'sub_abc',
    status: 'active',
    cancel_at_next_billing_date: false,
    product_id: 'pdt_1',
    customer: { customer_id: 'cus_1' },
  };
  const EVENT_HEADERS = { 'webhook-id': 'msg_1' };
  const OCCURRED_AT = '2026-08-06T12:00:00Z';

  it('maps lifecycle events to subscription.updated (no created event exists)', async () => {
    const event = await parseWebhookEvent({
      headers: EVENT_HEADERS,
      body: JSON.stringify({
        business_id: 'bus_1',
        type: 'subscription.active',
        timestamp: OCCURRED_AT,
        data: { ...subscriptionData, payload_type: 'Subscription' },
      }),
    });
    expect(event.type).toBe('subscription.updated');
    expect(event.subscription?.id).toBe('sub_abc');
    expect(event.idempotencyKey).toBe('dodo-payments:msg_1');
    expect(event.createdAt).toEqual(new Date(OCCURRED_AT));
    expect(event.subscriptionChange).toBeUndefined();
  });

  it('reports past_due for subscription.on_hold', async () => {
    const event = await parseWebhookEvent({
      headers: EVENT_HEADERS,
      body: JSON.stringify({
        business_id: 'bus_1',
        type: 'subscription.on_hold',
        data: { ...subscriptionData, status: 'on_hold' },
      }),
    });
    expect(event.type).toBe('subscription.updated');
    expect(event.subscription?.status).toBe('past_due');
    expect(event.subscriptionChange).toBe('past_due');
  });

  it.each([
    'subscription.plan_changed',
    'subscription.renewed',
    'subscription.update_payment_method',
    'subscription.updated',
  ])('maps %s to subscription.updated without naming a transition', async (providerType) => {
    const event = await parseWebhookEvent({
      headers: EVENT_HEADERS,
      body: JSON.stringify({ business_id: 'bus_1', type: providerType, data: subscriptionData }),
    });
    expect(event.type).toBe('subscription.updated');
    expect(event.providerType).toBe(providerType);
    expect(event.subscription?.id).toBe('sub_abc');
    expect(event.subscriptionChange).toBeUndefined();
  });

  // Dodo has no paused status, no pause endpoint and `capabilities.pause: false`.
  it('leaves subscription.paused unmapped', async () => {
    const event = await parseWebhookEvent({
      headers: EVENT_HEADERS,
      body: JSON.stringify({
        business_id: 'bus_1',
        type: 'subscription.paused',
        data: subscriptionData,
      }),
    });
    expect(event.type).toBe('unknown');
    expect(event.providerType).toBe('subscription.paused');
    expect(event.subscription).toBeUndefined();
    expect(event.subscriptionChange).toBeUndefined();
  });

  it('reads the idempotency key from webhook-id case-insensitively', async () => {
    const event = await parseWebhookEvent({
      headers: { 'Webhook-Id': 'msg_2' },
      body: JSON.stringify({ business_id: 'bus_1', type: 'subscription.updated', data: {} }),
    });
    expect(event.idempotencyKey).toBe('dodo-payments:msg_2');
  });

  it('falls back to a body digest when the webhook-id header is absent', async () => {
    const body = JSON.stringify({
      business_id: 'bus_1',
      type: 'subscription.updated',
      data: subscriptionData,
    });
    const event = await parseWebhookEvent({ headers: {}, body });
    expect(event.idempotencyKey).toBe(`dodo-payments:sha256:${await sha256Hex(body)}`);
  });

  it('reads the event time from the envelope, never from the webhook-timestamp header', async () => {
    const event = await parseWebhookEvent({
      headers: { ...EVENT_HEADERS, 'webhook-timestamp': '1000000000' },
      body: JSON.stringify({
        business_id: 'bus_1',
        type: 'subscription.updated',
        timestamp: OCCURRED_AT,
        data: subscriptionData,
      }),
    });
    expect(event.createdAt).toEqual(new Date(OCCURRED_AT));
  });

  it('leaves createdAt undefined for a missing or unparseable timestamp', async () => {
    const missing = await parseWebhookEvent({
      headers: EVENT_HEADERS,
      body: JSON.stringify({
        business_id: 'bus_1',
        type: 'subscription.updated',
        data: subscriptionData,
      }),
    });
    expect(missing.createdAt).toBeUndefined();

    const invalid = await parseWebhookEvent({
      headers: EVENT_HEADERS,
      body: JSON.stringify({
        business_id: 'bus_1',
        type: 'subscription.updated',
        timestamp: 'not a date',
        data: subscriptionData,
      }),
    });
    expect(invalid.createdAt).toBeUndefined();
  });

  it('maps cancelled, expired, and failed to the terminal subscription.canceled', async () => {
    for (const providerType of [
      'subscription.cancelled',
      'subscription.expired',
      'subscription.failed',
    ]) {
      const event = await parseWebhookEvent({
        headers: EVENT_HEADERS,
        body: JSON.stringify({
          business_id: 'bus_1',
          type: providerType,
          timestamp: OCCURRED_AT,
          data: { ...subscriptionData, status: 'cancelled' },
        }),
      });
      expect(event.type).toBe('subscription.canceled');
      expect(event.subscription?.status).toBe('canceled');
      expect(event.idempotencyKey).toBe('dodo-payments:msg_1');
      expect(event.createdAt).toEqual(new Date(OCCURRED_AT));
      expect(event.subscriptionChange).toBeUndefined();
    }
  });

  it('maps payment.succeeded to order.paid', async () => {
    const event = await parseWebhookEvent({
      headers: EVENT_HEADERS,
      body: JSON.stringify({
        business_id: 'bus_1',
        type: 'payment.succeeded',
        timestamp: OCCURRED_AT,
        data: {
          payload_type: 'Payment',
          payment_id: 'pay_1',
          status: 'succeeded',
          total_amount: 2500,
          currency: 'USD',
          subscription_id: 'sub_abc',
          customer: { customer_id: 'cus_1', email: 'user@example.com' },
          created_at: '2026-08-01T00:00:00Z',
          metadata: { org_id: 'org_1' },
        },
      }),
    });
    expect(event.type).toBe('order.paid');
    expect(event.order).toMatchObject({
      id: 'pay_1',
      status: 'paid',
      amount: 2500,
      currency: 'usd',
      customerId: 'cus_1',
      customerEmail: 'user@example.com',
      subscriptionId: 'sub_abc',
      createdAt: new Date('2026-08-01T00:00:00Z'),
      metadata: { org_id: 'org_1' },
    });
    expect(event.idempotencyKey).toBe('dodo-payments:msg_1');
    expect(event.createdAt).toEqual(new Date(OCCURRED_AT));
  });

  it('maps license_key.created to license.issued with the plaintext key', async () => {
    const event = await parseWebhookEvent({
      headers: EVENT_HEADERS,
      body: JSON.stringify({
        business_id: 'bus_1',
        type: 'license_key.created',
        timestamp: OCCURRED_AT,
        data: {
          payload_type: 'LicenseKey',
          id: 'lic_1',
          key: 'ABCD-1234-EFGH-5678',
          status: 'active',
          activations_limit: 5,
          instances_count: 0,
          customer_id: 'cus_1',
          product_id: 'prod_1',
        },
      }),
    });
    expect(event.type).toBe('license.issued');
    expect(event.providerType).toBe('license_key.created');
    expect(event.licenseKeyId).toBe('lic_1');
    expect(event.licenseKey).toMatchObject({
      id: 'lic_1',
      key: 'ABCD-1234-EFGH-5678',
      status: 'active',
      activationLimit: 5,
      customerId: 'cus_1',
      productId: 'prod_1',
    });
    expect(event.idempotencyKey).toBe('dodo-payments:msg_1');
    expect(event.createdAt).toEqual(new Date(OCCURRED_AT));
  });

  it('never throws on unknown event types', async () => {
    const event = await parseWebhookEvent({
      headers: EVENT_HEADERS,
      body: JSON.stringify({
        business_id: 'bus_1',
        type: 'dispute.opened',
        timestamp: OCCURRED_AT,
        data: {},
      }),
    });
    expect(event.type).toBe('unknown');
    expect(event.providerType).toBe('dispute.opened');
    expect(event.idempotencyKey).toBe('dodo-payments:msg_1');
    expect(event.createdAt).toEqual(new Date(OCCURRED_AT));
  });
});
