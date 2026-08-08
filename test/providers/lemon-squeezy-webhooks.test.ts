import { describe, expect, it } from 'vitest';
import { parseWebhookEvent, verifyWebhook } from '../../src/providers/lemon-squeezy/webhooks.ts';
import { hmacSha256, sha256Hex, toHex } from '../../src/webhooks/verify.ts';
import { expectEvent } from '../helpers/webhook-events.ts';

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
  // Lemon Squeezy publishes no event id, so every key is a digest of the raw body.
  const DIGEST_KEY = /^lemon-squeezy:sha256:[0-9a-f]{64}$/;

  it('maps subscription_created and merges meta.custom_data into metadata', async () => {
    const parsed = await parseWebhookEvent({
      headers: {},
      body: JSON.stringify({
        meta: { event_name: 'subscription_created', custom_data: { organization_id: 'org_1' } },
        data: subscriptionResource,
      }),
    });
    const event = expectEvent(parsed, 'subscription.created');
    expect(event.subscription.metadata).toEqual({ organization_id: 'org_1' });
    expect(event.idempotencyKey).toMatch(DIGEST_KEY);
    expect(event.createdAt).toBeUndefined();
  });

  it('keys every delivery on a digest of the raw body', async () => {
    const body = JSON.stringify({
      meta: { event_name: 'subscription_updated' },
      data: subscriptionResource,
    });
    const event = await parseWebhookEvent({ headers: {}, body });
    expect(event.idempotencyKey).toBe(`lemon-squeezy:sha256:${await sha256Hex(body)}`);

    const other = await parseWebhookEvent({ headers: {}, body: `${body} ` });
    expect(other.idempotencyKey).not.toBe(event.idempotencyKey);
  });

  it.each([
    // `subscription_resumed` reverses a CANCELLATION; `subscription_unpaused` reverses a pause.
    ['subscription_cancelled', 'cancel_scheduled'],
    ['subscription_paused', 'paused'],
    ['subscription_resumed', 'uncanceled'],
    ['subscription_unpaused', 'resumed'],
  ])('reports the transition named by %s', async (providerType, subscriptionChange) => {
    const parsed = await parseWebhookEvent({
      headers: {},
      body: JSON.stringify({ meta: { event_name: providerType }, data: subscriptionResource }),
    });
    const event = expectEvent(parsed, 'subscription.updated');
    expect(event.subscriptionChange).toBe(subscriptionChange);
  });

  it('names no transition on subscription_updated', async () => {
    const parsed = await parseWebhookEvent({
      headers: {},
      body: JSON.stringify({
        meta: { event_name: 'subscription_updated' },
        data: subscriptionResource,
      }),
    });
    const event = expectEvent(parsed, 'subscription.updated');
    expect(event.subscriptionChange).toBeUndefined();
  });

  it('leaves subscription_payment_failed unmapped (it carries an invoice, not a subscription)', async () => {
    const event = await parseWebhookEvent({
      headers: {},
      body: JSON.stringify({ meta: { event_name: 'subscription_payment_failed' }, data: {} }),
    });
    expect(event.type).toBe('unknown');
  });

  it('maps subscription_cancelled to updated with cancelAtPeriodEnd', async () => {
    const parsed = await parseWebhookEvent({
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
    const event = expectEvent(parsed, 'subscription.updated');
    expect(event.subscription.status).toBe('active');
    expect(event.subscription.cancelAtPeriodEnd).toBe(true);
    expect(event.idempotencyKey).toMatch(DIGEST_KEY);
    expect(event.createdAt).toBeUndefined();
  });

  it('maps subscription_expired to the terminal subscription.canceled', async () => {
    const parsed = await parseWebhookEvent({
      headers: {},
      body: JSON.stringify({
        meta: { event_name: 'subscription_expired' },
        data: {
          ...subscriptionResource,
          attributes: { ...subscriptionResource.attributes, status: 'expired' },
        },
      }),
    });
    const event = expectEvent(parsed, 'subscription.canceled');
    expect(event.subscription.status).toBe('canceled');
    expect(event.idempotencyKey).toMatch(DIGEST_KEY);
    expect(event.createdAt).toBeUndefined();
  });

  it('maps order_created to order.paid', async () => {
    const parsed = await parseWebhookEvent({
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
            status: 'paid',
            refunded: false,
            refunded_amount: 0,
            created_at: '2026-08-01T00:00:00.000000Z',
          },
        },
      }),
    });
    const event = expectEvent(parsed, 'order.paid');
    expect(event.order).toMatchObject({
      id: '11',
      status: 'paid',
      amount: 2900,
      currency: 'usd',
      customerId: '7',
      customerEmail: 'user@example.com',
      metadata: { organization_id: 'org_1' },
    });
    expect(event.idempotencyKey).toMatch(DIGEST_KEY);
    expect(event.createdAt).toBeUndefined();
  });

  function paymentSuccessBody(billingReason: string) {
    return JSON.stringify({
      meta: {
        event_name: 'subscription_payment_success',
        custom_data: { organization_id: 'org_1' },
      },
      data: {
        type: 'subscription-invoices',
        id: '77',
        attributes: {
          subscription_id: 42,
          customer_id: 7,
          user_email: 'user@example.com',
          currency: 'USD',
          total: 2900,
          status: 'paid',
          billing_reason: billingReason,
        },
      },
    });
  }

  it('maps subscription_payment_success (an invoice payload) to order.paid', async () => {
    const parsed = await parseWebhookEvent({ headers: {}, body: paymentSuccessBody('renewal') });
    const event = expectEvent(parsed, 'order.paid');
    expect(event.order).toMatchObject({
      id: '77',
      status: 'paid',
      subscriptionId: '42',
      amount: 2900,
      metadata: { organization_id: 'org_1' },
    });
    expect(event.idempotencyKey).toMatch(DIGEST_KEY);
    expect(event.createdAt).toBeUndefined();
  });

  it('leaves the initial invoice unmapped so the first payment only fires order_created', async () => {
    const event = await parseWebhookEvent({ headers: {}, body: paymentSuccessBody('initial') });
    expect(event.type).toBe('unknown');
    expect(event.providerType).toBe('subscription_payment_success');
    expect(event.idempotencyKey).toMatch(DIGEST_KEY);
  });

  it('maps license_key_created to license.issued with the plaintext key', async () => {
    const parsed = await parseWebhookEvent({
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
    const event = expectEvent(parsed, 'license.issued');
    expect(event.providerType).toBe('license_key_created');
    expect(event.licenseKeyId).toBe('99');
    expect(event.licenseKey).toMatchObject({
      id: '99',
      key: 'ABCD-1234-EFGH-5678',
      status: 'active',
      activationLimit: 5,
      customerId: '7',
    });
    expect(event.idempotencyKey).toMatch(DIGEST_KEY);
    expect(event.createdAt).toBeUndefined();
  });

  it('never throws on unknown event types', async () => {
    const event = await parseWebhookEvent({
      headers: {},
      body: JSON.stringify({ meta: { event_name: 'license_key_updated' }, data: {} }),
    });
    expect(event.type).toBe('unknown');
    expect(event.providerType).toBe('license_key_updated');
    expect(event.idempotencyKey).toMatch(DIGEST_KEY);
    expect(event.createdAt).toBeUndefined();
  });
});
