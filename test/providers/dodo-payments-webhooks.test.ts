import { describe, expect, it } from 'vitest';
import { bytesToBase64 } from '../../src/base64.ts';
import { parseWebhookEvent, verifyWebhook } from '../../src/providers/dodo-payments/webhooks.ts';
import { hmacSha256 } from '../../src/webhooks/verify.ts';

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

  it('maps lifecycle events to subscription.updated (no created event exists)', async () => {
    const event = await parseWebhookEvent({
      headers: {},
      body: JSON.stringify({
        business_id: 'bus_1',
        type: 'subscription.active',
        data: { ...subscriptionData, payload_type: 'Subscription' },
      }),
    });
    expect(event.type).toBe('subscription.updated');
    expect(event.subscription?.id).toBe('sub_abc');
  });

  it('maps cancelled, expired, and failed to the terminal subscription.canceled', async () => {
    for (const providerType of [
      'subscription.cancelled',
      'subscription.expired',
      'subscription.failed',
    ]) {
      const event = await parseWebhookEvent({
        headers: {},
        body: JSON.stringify({
          business_id: 'bus_1',
          type: providerType,
          data: { ...subscriptionData, status: 'cancelled' },
        }),
      });
      expect(event.type).toBe('subscription.canceled');
      expect(event.subscription?.status).toBe('canceled');
    }
  });

  it('maps payment.succeeded to order.paid', async () => {
    const event = await parseWebhookEvent({
      headers: {},
      body: JSON.stringify({
        business_id: 'bus_1',
        type: 'payment.succeeded',
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
  });

  it('maps license_key.created to license.issued with the plaintext key', async () => {
    const event = await parseWebhookEvent({
      headers: {},
      body: JSON.stringify({
        business_id: 'bus_1',
        type: 'license_key.created',
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
  });

  it('never throws on unknown event types', async () => {
    const event = await parseWebhookEvent({
      headers: {},
      body: JSON.stringify({ business_id: 'bus_1', type: 'dispute.opened', data: {} }),
    });
    expect(event.type).toBe('unknown');
    expect(event.providerType).toBe('dispute.opened');
  });
});
