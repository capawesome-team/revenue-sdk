import { describe, expect, it } from 'vitest';
import { parseWebhookEvent, verifyWebhook } from '../../src/providers/stripe/webhooks.ts';
import { hmacSha256, sha256Hex, toHex } from '../../src/webhooks/verify.ts';
import { expectEvent } from '../helpers/webhook-events.ts';

const SECRET = 'whsec_wRNftLajMZNeslQOP6vEPm4iVx5NlZ6z';

async function sign(secret: string, timestamp: number, body: string) {
  return toHex(await hmacSha256(secret, `${timestamp}.${body}`));
}

describe('stripe verifyWebhook', () => {
  it('accepts a valid v1 signature computed over the verbatim whsec_ secret', async () => {
    const body = JSON.stringify({ id: 'evt_1', type: 'invoice.paid' });
    const timestamp = Math.floor(Date.now() / 1000);
    const signature = await sign(SECRET, timestamp, body);
    await expect(
      verifyWebhook({
        headers: { 'Stripe-Signature': `t=${timestamp},v1=${signature}` },
        body,
        secret: SECRET,
      }),
    ).resolves.toBe(true);
  });

  it('ignores v0 signatures and accepts any matching v1 (secret rolling)', async () => {
    const body = '{}';
    const timestamp = Math.floor(Date.now() / 1000);
    const valid = await sign(SECRET, timestamp, body);
    const header = `t=${timestamp},v0=${'0'.repeat(64)},v1=${'f'.repeat(64)},v1=${valid}`;
    await expect(
      verifyWebhook({ headers: { 'stripe-signature': header }, body, secret: SECRET }),
    ).resolves.toBe(true);
  });

  it('rejects a v0-only header even if the digest matches', async () => {
    const body = '{}';
    const timestamp = Math.floor(Date.now() / 1000);
    const valid = await sign(SECRET, timestamp, body);
    await expect(
      verifyWebhook({
        headers: { 'stripe-signature': `t=${timestamp},v0=${valid}` },
        body,
        secret: SECRET,
      }),
    ).resolves.toBe(false);
  });

  it('rejects stale timestamps and missing headers', async () => {
    const body = '{}';
    const timestamp = Math.floor(Date.now() / 1000) - 301;
    const signature = await sign(SECRET, timestamp, body);
    await expect(
      verifyWebhook({
        headers: { 'stripe-signature': `t=${timestamp},v1=${signature}` },
        body,
        secret: SECRET,
      }),
    ).resolves.toBe(false);
    await expect(verifyWebhook({ headers: {}, body, secret: SECRET })).resolves.toBe(false);
  });
});

describe('stripe parseWebhookEvent', () => {
  const subscriptionObject = {
    id: 'sub_1',
    status: 'active',
    cancel_at_period_end: false,
    customer: 'cus_1',
    items: {
      data: [{ id: 'si_1', price: { id: 'price_1', product: 'prod_1', currency: 'usd' } }],
      has_more: false,
    },
  };

  const CREATED = 1754481600;

  it('maps customer.subscription.created', async () => {
    const parsed = await parseWebhookEvent({
      headers: {},
      body: JSON.stringify({
        id: 'evt_1',
        type: 'customer.subscription.created',
        created: CREATED,
        data: { object: subscriptionObject },
      }),
    });
    const event = expectEvent(parsed, 'subscription.created');
    expect(event.subscription.id).toBe('sub_1');
    expect(event.idempotencyKey).toBe('stripe:evt_1');
    expect(event.createdAt).toEqual(new Date(CREATED * 1000));
  });

  it('falls back to a body digest when the envelope carries no id', async () => {
    const body = JSON.stringify({
      type: 'customer.subscription.updated',
      data: { object: subscriptionObject },
    });
    const event = await parseWebhookEvent({ headers: {}, body });
    expect(event.idempotencyKey).toBe(`stripe:sha256:${await sha256Hex(body)}`);
    expect(event.createdAt).toBeUndefined();
  });

  it.each([
    ['customer.subscription.paused', 'paused'],
    ['customer.subscription.resumed', 'resumed'],
  ])('reports the transition named by %s', async (providerType, subscriptionChange) => {
    const parsed = await parseWebhookEvent({
      headers: {},
      body: JSON.stringify({
        id: 'evt_1',
        type: providerType,
        created: CREATED,
        data: { object: subscriptionObject },
      }),
    });
    const event = expectEvent(parsed, 'subscription.updated');
    expect(event.subscriptionChange).toBe(subscriptionChange);
  });

  it.each([
    'customer.subscription.pending_update_applied',
    'customer.subscription.pending_update_expired',
    'customer.subscription.updated',
  ])('maps %s to subscription.updated without naming a transition', async (providerType) => {
    const parsed = await parseWebhookEvent({
      headers: {},
      body: JSON.stringify({
        id: 'evt_1',
        type: providerType,
        created: CREATED,
        data: { object: subscriptionObject },
      }),
    });
    const event = expectEvent(parsed, 'subscription.updated');
    expect(event.providerType).toBe(providerType);
    expect(event.subscription.id).toBe('sub_1');
    expect(event.subscriptionChange).toBeUndefined();
  });

  it('maps customer.subscription.deleted to the terminal subscription.canceled', async () => {
    const parsed = await parseWebhookEvent({
      headers: {},
      body: JSON.stringify({
        id: 'evt_1',
        type: 'customer.subscription.deleted',
        created: CREATED,
        data: { object: { ...subscriptionObject, status: 'canceled', ended_at: 1754438400 } },
      }),
    });
    const event = expectEvent(parsed, 'subscription.canceled');
    expect(event.subscription.status).toBe('canceled');
    expect(event.idempotencyKey).toBe('stripe:evt_1');
    expect(event.createdAt).toEqual(new Date(CREATED * 1000));
  });

  it('maps checkout.session.completed to checkout.completed only when paid', async () => {
    const paid = await parseWebhookEvent({
      headers: {},
      body: JSON.stringify({
        id: 'evt_1',
        type: 'checkout.session.completed',
        created: CREATED,
        data: { object: { id: 'cs_1', status: 'complete', payment_status: 'paid' } },
      }),
    });
    expect(paid.type).toBe('checkout.completed');
    expect(paid.idempotencyKey).toBe('stripe:evt_1');
    expect(paid.createdAt).toEqual(new Date(CREATED * 1000));

    const unpaid = await parseWebhookEvent({
      headers: {},
      body: JSON.stringify({
        id: 'evt_2',
        type: 'checkout.session.completed',
        created: CREATED,
        data: { object: { id: 'cs_1', status: 'complete', payment_status: 'unpaid' } },
      }),
    });
    expect(unpaid.type).toBe('unknown');
    expect(unpaid.idempotencyKey).toBe('stripe:evt_2');

    const asyncPaid = await parseWebhookEvent({
      headers: {},
      body: JSON.stringify({
        id: 'evt_3',
        type: 'checkout.session.async_payment_succeeded',
        created: CREATED,
        data: { object: { id: 'cs_1', status: 'complete', payment_status: 'paid' } },
      }),
    });
    expect(asyncPaid.type).toBe('checkout.completed');
    expect(asyncPaid.idempotencyKey).toBe('stripe:evt_3');
  });

  it('maps invoice.paid to order.paid with the parent subscription', async () => {
    const parsed = await parseWebhookEvent({
      headers: {},
      body: JSON.stringify({
        id: 'evt_1',
        type: 'invoice.paid',
        created: CREATED,
        data: {
          object: {
            id: 'in_1',
            status: 'paid',
            created: 1754006400,
            amount_paid: 2900,
            total: 2900,
            currency: 'usd',
            customer: 'cus_1',
            customer_email: 'user@example.com',
            parent: {
              subscription_details: { subscription: 'sub_1', metadata: { org_id: 'org_1' } },
            },
          },
        },
      }),
    });
    const event = expectEvent(parsed, 'order.paid');
    expect(event.order).toMatchObject({
      id: 'in_1',
      status: 'paid',
      amount: 2900,
      currency: 'usd',
      customerId: 'cus_1',
      subscriptionId: 'sub_1',
      createdAt: new Date(1754006400 * 1000),
      metadata: { org_id: 'org_1' },
    });
    expect(event.idempotencyKey).toBe('stripe:evt_1');
    expect(event.createdAt).toEqual(new Date(CREATED * 1000));
  });

  it('never throws on unknown event types', async () => {
    const event = await parseWebhookEvent({
      headers: {},
      body: JSON.stringify({
        id: 'evt_1',
        type: 'payment_intent.created',
        created: CREATED,
        data: { object: {} },
      }),
    });
    expect(event.type).toBe('unknown');
    expect(event.providerType).toBe('payment_intent.created');
    expect(event.idempotencyKey).toBe('stripe:evt_1');
    expect(event.createdAt).toEqual(new Date(CREATED * 1000));
  });
});
