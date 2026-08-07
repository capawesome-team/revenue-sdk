import { describe, expect, it } from 'vitest';
import { parseWebhookEvent, verifyWebhook } from '../../src/providers/lemon-squeezy/webhooks.ts';
import { hmacSha256, toHex } from '../../src/webhooks/verify.ts';

const SECRET = 'ls-signing-secret';

describe('lemon-squeezy verifyWebhook', () => {
  it('accepts a valid hex signature over the raw body', async () => {
    const body = JSON.stringify({ meta: { event_name: 'order_created' }, data: {} });
    const signature = toHex(await hmacSha256(SECRET, body));
    await expect(
      verifyWebhook({ headers: { 'X-Signature': signature }, body, secret: SECRET }),
    ).resolves.toBe(true);
  });

  it('accepts uppercase hex signatures', async () => {
    const body = '{}';
    const signature = toHex(await hmacSha256(SECRET, body)).toUpperCase();
    await expect(
      verifyWebhook({ headers: { 'x-signature': signature }, body, secret: SECRET }),
    ).resolves.toBe(true);
  });

  it('rejects an invalid signature and a missing header', async () => {
    const body = '{}';
    const signature = toHex(await hmacSha256('other-secret', body));
    await expect(
      verifyWebhook({ headers: { 'x-signature': signature }, body, secret: SECRET }),
    ).resolves.toBe(false);
    await expect(verifyWebhook({ headers: {}, body, secret: SECRET })).resolves.toBe(false);
  });

  it('rejects when the body was re-serialized', async () => {
    const body = '{"meta":  {"event_name": "order_created"}}';
    const signature = toHex(await hmacSha256(SECRET, body));
    const reserialized = JSON.stringify(JSON.parse(body));
    await expect(
      verifyWebhook({ headers: { 'x-signature': signature }, body: reserialized, secret: SECRET }),
    ).resolves.toBe(false);
  });
});

describe('lemon-squeezy parseWebhookEvent', () => {
  const subscriptionResource = {
    type: 'subscriptions',
    id: '42',
    attributes: {
      customer_id: 7,
      variant_id: 1615641,
      status: 'active',
      cancelled: false,
      renews_at: '2026-09-01T00:00:00.000000Z',
    },
  };

  it('maps subscription_created and merges meta.custom_data into metadata', async () => {
    const event = await parseWebhookEvent({
      headers: {},
      body: JSON.stringify({
        meta: { event_name: 'subscription_created', custom_data: { organization_id: 'org_1' } },
        data: subscriptionResource,
      }),
    });
    expect(event.type).toBe('subscription.created');
    expect(event.subscription?.metadata).toEqual({ organization_id: 'org_1' });
  });

  it('maps subscription_cancelled to updated with cancelAtPeriodEnd', async () => {
    const event = await parseWebhookEvent({
      headers: {},
      body: JSON.stringify({
        meta: { event_name: 'subscription_cancelled' },
        data: {
          ...subscriptionResource,
          attributes: {
            ...subscriptionResource.attributes,
            status: 'cancelled',
            cancelled: true,
            ends_at: '2026-09-01T00:00:00.000000Z',
          },
        },
      }),
    });
    expect(event.type).toBe('subscription.updated');
    expect(event.subscription?.status).toBe('active');
    expect(event.subscription?.cancelAtPeriodEnd).toBe(true);
  });

  it('maps subscription_expired to the terminal subscription.canceled', async () => {
    const event = await parseWebhookEvent({
      headers: {},
      body: JSON.stringify({
        meta: { event_name: 'subscription_expired' },
        data: {
          ...subscriptionResource,
          attributes: { ...subscriptionResource.attributes, status: 'expired' },
        },
      }),
    });
    expect(event.type).toBe('subscription.canceled');
    expect(event.subscription?.status).toBe('canceled');
  });

  it('maps order_created to order.paid', async () => {
    const event = await parseWebhookEvent({
      headers: {},
      body: JSON.stringify({
        meta: { event_name: 'order_created', custom_data: { organization_id: 'org_1' } },
        data: {
          type: 'orders',
          id: '11',
          attributes: {
            customer_id: 7,
            user_email: 'user@example.com',
            currency: 'USD',
            total: 2900,
          },
        },
      }),
    });
    expect(event.type).toBe('order.paid');
    expect(event.order).toMatchObject({
      id: '11',
      amount: 2900,
      currency: 'usd',
      customerId: '7',
      customerEmail: 'user@example.com',
      metadata: { organization_id: 'org_1' },
    });
  });

  it('maps subscription_payment_success (an invoice payload) to order.paid', async () => {
    const event = await parseWebhookEvent({
      headers: {},
      body: JSON.stringify({
        meta: { event_name: 'subscription_payment_success' },
        data: {
          type: 'subscription-invoices',
          id: '77',
          attributes: {
            subscription_id: 42,
            customer_id: 7,
            user_email: 'user@example.com',
            currency: 'USD',
            total: 2900,
          },
        },
      }),
    });
    expect(event.type).toBe('order.paid');
    expect(event.order).toMatchObject({ id: '77', subscriptionId: '42', amount: 2900 });
  });

  it('maps license_key_created to license.issued with the plaintext key', async () => {
    const event = await parseWebhookEvent({
      headers: {},
      body: JSON.stringify({
        meta: { event_name: 'license_key_created' },
        data: {
          type: 'license-keys',
          id: '99',
          attributes: {
            customer_id: 7,
            key: 'ABCD-1234-EFGH-5678',
            status: 'inactive',
            activation_limit: 5,
            instances_count: 0,
            disabled: 0,
          },
        },
      }),
    });
    expect(event.type).toBe('license.issued');
    expect(event.providerType).toBe('license_key_created');
    expect(event.licenseKeyId).toBe('99');
    expect(event.licenseKey).toMatchObject({
      id: '99',
      key: 'ABCD-1234-EFGH-5678',
      status: 'active',
      activationLimit: 5,
      customerId: '7',
    });
  });

  it('never throws on unknown event types', async () => {
    const event = await parseWebhookEvent({
      headers: {},
      body: JSON.stringify({ meta: { event_name: 'license_key_updated' }, data: {} }),
    });
    expect(event.type).toBe('unknown');
    expect(event.providerType).toBe('license_key_updated');
  });
});
