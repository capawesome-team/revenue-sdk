import { describe, expect, it } from 'vitest';
import { parseWebhookEvent, verifyWebhook } from '../../src/providers/stripe/webhooks.ts';
import { hmacSha256, toHex } from '../../src/webhooks/verify.ts';

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

  it('maps customer.subscription.created', async () => {
    const event = await parseWebhookEvent({
      headers: {},
      body: JSON.stringify({
        type: 'customer.subscription.created',
        data: { object: subscriptionObject },
      }),
    });
    expect(event.type).toBe('subscription.created');
    expect(event.subscription?.id).toBe('sub_1');
  });

  it('maps customer.subscription.deleted to the terminal subscription.canceled', async () => {
    const event = await parseWebhookEvent({
      headers: {},
      body: JSON.stringify({
        type: 'customer.subscription.deleted',
        data: { object: { ...subscriptionObject, status: 'canceled', ended_at: 1754438400 } },
      }),
    });
    expect(event.type).toBe('subscription.canceled');
    expect(event.subscription?.status).toBe('canceled');
  });

  it('maps checkout.session.completed to checkout.completed only when paid', async () => {
    const paid = await parseWebhookEvent({
      headers: {},
      body: JSON.stringify({
        type: 'checkout.session.completed',
        data: { object: { id: 'cs_1', status: 'complete', payment_status: 'paid' } },
      }),
    });
    expect(paid.type).toBe('checkout.completed');

    const unpaid = await parseWebhookEvent({
      headers: {},
      body: JSON.stringify({
        type: 'checkout.session.completed',
        data: { object: { id: 'cs_1', status: 'complete', payment_status: 'unpaid' } },
      }),
    });
    expect(unpaid.type).toBe('unknown');

    const asyncPaid = await parseWebhookEvent({
      headers: {},
      body: JSON.stringify({
        type: 'checkout.session.async_payment_succeeded',
        data: { object: { id: 'cs_1', status: 'complete', payment_status: 'paid' } },
      }),
    });
    expect(asyncPaid.type).toBe('checkout.completed');
  });

  it('maps invoice.paid to order.paid with the parent subscription', async () => {
    const event = await parseWebhookEvent({
      headers: {},
      body: JSON.stringify({
        type: 'invoice.paid',
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
    expect(event.type).toBe('order.paid');
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
  });

  it('never throws on unknown event types', async () => {
    const event = await parseWebhookEvent({
      headers: {},
      body: JSON.stringify({ type: 'payment_intent.created', data: { object: {} } }),
    });
    expect(event.type).toBe('unknown');
    expect(event.providerType).toBe('payment_intent.created');
  });
});
