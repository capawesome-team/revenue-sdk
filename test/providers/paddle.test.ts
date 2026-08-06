import { describe, expect, it } from 'vitest';
import { RevenueError } from '../../src/errors.ts';
import { paddle } from '../../src/providers/paddle/index.ts';
import { createFetchStub, type StubHandler } from '../helpers/fetch-stub.ts';

const API_KEY = 'pdl_sdbx_apikey_test';

function setup(handler: StubHandler, options: { server?: 'sandbox' } = {}) {
  const stub = createFetchStub(handler);
  const provider = paddle({ apiKey: API_KEY, fetch: stub.fetch, ...options });
  return { provider, stub };
}

const PRICE = {
  id: 'pri_1',
  product_id: 'pro_1',
  name: 'Pro monthly',
  billing_cycle: { interval: 'month', frequency: 1 },
  trial_period: { interval: 'day', frequency: 14 },
  unit_price: { amount: '2499', currency_code: 'USD' },
};

const SUBSCRIPTION = {
  id: 'sub_1',
  status: 'active',
  customer_id: 'ctm_1',
  currency_code: 'USD',
  started_at: '2026-08-01T00:00:00Z',
  canceled_at: null,
  current_billing_period: { starts_at: '2026-08-01T00:00:00Z', ends_at: '2026-09-01T00:00:00Z' },
  billing_cycle: { interval: 'month', frequency: 1 },
  scheduled_change: null,
  custom_data: { org_id: 'org_1' },
  items: [{ quantity: 1, price: PRICE }],
};

async function expectRevenueError(promise: Promise<unknown>, code: string): Promise<void> {
  try {
    await promise;
    expect.unreachable('expected RevenueError');
  } catch (error) {
    expect(error).toBeInstanceOf(RevenueError);
    expect((error as RevenueError).code).toBe(code);
  }
}

describe('paddle', () => {
  it('exposes capabilities reflecting the Paddle.js checkout model', () => {
    const { provider } = setup(() => ({ json: { data: [] } }));
    expect(provider.capabilities.hostedCheckout).toBe(false);
    expect(provider.capabilities.checkoutSuccessUrl).toBe(false);
    expect(provider.capabilities.cancellationReason).toBe(false);
    expect(provider.capabilities.usageReporting).toBe(false);
  });

  it('rejects usage reporting', async () => {
    const { provider } = setup(() => ({ json: { data: [] } }));
    await expectRevenueError(
      provider.reportUsage({ customerId: 'ctm_1', eventName: 'api' }),
      'unsupported',
    );
  });

  it('sends Paddle-Version and bearer auth, and uses the sandbox host', async () => {
    const { provider, stub } = setup(() => ({ json: { data: [] } }), { server: 'sandbox' });
    await provider.listProducts({});
    const request = stub.requests[0]!;
    expect(request.url).toContain('https://sandbox-api.paddle.com/products');
    expect(request.headers['authorization']).toBe(`Bearer ${API_KEY}`);
    expect(request.headers['paddle-version']).toBe('1');
  });

  describe('products', () => {
    it('lists active products with included prices and string-int amounts parsed', async () => {
      const { provider, stub } = setup(() => ({
        json: {
          data: [{ id: 'pro_1', name: 'Pro', description: 'Pro plan', prices: [PRICE] }],
          meta: { pagination: { has_more: false, next: null } },
        },
      }));
      const page = await provider.listProducts({});
      expect(stub.requests[0]!.url).toBe(
        'https://api.paddle.com/products?status=active&include=prices&per_page=10',
      );
      const price = page.items[0]!.prices[0]!;
      expect(price).toMatchObject({
        id: 'pri_1',
        checkoutRef: 'pri_1',
        type: 'recurring',
        model: 'fixed',
        amount: 2499,
        currency: 'usd',
        interval: 'month',
        trialDays: 14,
      });
    });

    it('follows the meta.pagination.next URL via the cursor', async () => {
      const { provider, stub } = setup(() => ({
        json: {
          data: [{ id: 'pro_1', name: 'Pro' }],
          meta: {
            pagination: {
              has_more: true,
              next: 'https://api.paddle.com/products?after=pro_1&per_page=10',
            },
          },
        },
      }));
      const page = await provider.listProducts({});
      expect(page.cursor).toBeDefined();
      await provider.listProducts({ cursor: page.cursor });
      expect(stub.requests[1]!.url).toBe('https://api.paddle.com/products?after=pro_1&per_page=10');
    });

    it('rejects a forged cross-origin next URL', async () => {
      const { provider } = setup(() => ({
        json: {
          data: [],
          meta: { pagination: { has_more: true, next: 'https://evil.example.com/products' } },
        },
      }));
      const page = await provider.listProducts({});
      await expectRevenueError(provider.listProducts({ cursor: page.cursor }), 'validation');
    });
  });

  describe('createCheckout', () => {
    it('creates a transaction and returns its checkout URL', async () => {
      const { provider, stub } = setup(() => ({
        json: {
          data: {
            id: 'txn_1',
            status: 'ready',
            customer_id: 'ctm_1',
            checkout: { url: 'https://app.example.com/pay?_ptxn=txn_1' },
            custom_data: { org_id: 'org_1' },
          },
        },
      }));
      const checkout = await provider.createCheckout({
        items: [{ product: 'pri_1', quantity: 2 }],
        customerId: 'ctm_1',
        metadata: { org_id: 'org_1' },
      });
      const request = stub.requests[0]!;
      expect(request.method).toBe('POST');
      expect(request.url).toBe('https://api.paddle.com/transactions');
      expect(JSON.parse(request.body!)).toEqual({
        items: [{ price_id: 'pri_1', quantity: 2 }],
        customer_id: 'ctm_1',
        custom_data: { org_id: 'org_1' },
      });
      expect(checkout).toMatchObject({
        id: 'txn_1',
        url: 'https://app.example.com/pay?_ptxn=txn_1',
        status: 'open',
        customerId: 'ctm_1',
      });
    });

    it('resolves an existing customer by email before creating the transaction', async () => {
      const { provider, stub } = setup((request) => {
        const path = new URL(request.url).pathname;
        if (path === '/customers') {
          return { json: { data: [{ id: 'ctm_9', email: 'user@example.com' }] } };
        }
        return { json: { data: { id: 'txn_1', status: 'ready', checkout: null } } };
      });
      await provider.createCheckout({
        items: [{ product: 'pri_1' }],
        customerEmail: 'user@example.com',
      });
      expect(stub.requests[0]!.url).toContain('/customers?email=user%40example.com');
      expect(JSON.parse(stub.requests[1]!.body!).customer_id).toBe('ctm_9');
    });

    it('creates a new customer when the email has no match', async () => {
      const { provider, stub } = setup((request) => {
        const path = new URL(request.url).pathname;
        if (path === '/customers' && request.method === 'GET') {
          return { json: { data: [] } };
        }
        if (path === '/customers' && request.method === 'POST') {
          return { json: { data: { id: 'ctm_new', email: 'user@example.com' } } };
        }
        return { json: { data: { id: 'txn_1', status: 'ready', checkout: null } } };
      });
      await provider.createCheckout({
        items: [{ product: 'pri_1' }],
        customerEmail: 'user@example.com',
      });
      expect(JSON.parse(stub.requests[1]!.body!)).toEqual({ email: 'user@example.com' });
      expect(JSON.parse(stub.requests[2]!.body!).customer_id).toBe('ctm_new');
    });

    it('rejects successUrl', async () => {
      const { provider } = setup(() => ({ json: { data: {} } }));
      await expectRevenueError(
        provider.createCheckout({ items: [{ product: 'pri_1' }], successUrl: 'https://x' }),
        'unsupported',
      );
    });
  });

  describe('subscriptions', () => {
    it('maps an active subscription', async () => {
      const { provider } = setup(() => ({ json: { data: SUBSCRIPTION } }));
      const subscription = await provider.getSubscription({ id: 'sub_1' });
      expect(subscription).toMatchObject({
        id: 'sub_1',
        status: 'active',
        cancelAtPeriodEnd: false,
        pauseAtPeriodEnd: false,
        customerId: 'ctm_1',
        productId: 'pro_1',
        priceId: 'pri_1',
        quantity: 1,
        currency: 'usd',
        amount: 2499,
        interval: 'month',
        metadata: { org_id: 'org_1' },
      });
      expect(subscription.currentPeriodEnd).toEqual(new Date('2026-09-01T00:00:00Z'));
    });

    it('derives cancelAtPeriodEnd from scheduled_change', async () => {
      const { provider } = setup(() => ({
        json: {
          data: {
            ...SUBSCRIPTION,
            scheduled_change: { action: 'cancel', effective_at: '2026-09-01T00:00:00Z' },
          },
        },
      }));
      const subscription = await provider.getSubscription({ id: 'sub_1' });
      expect(subscription.status).toBe('active');
      expect(subscription.cancelAtPeriodEnd).toBe(true);
      expect(subscription.endsAt).toEqual(new Date('2026-09-01T00:00:00Z'));
    });

    it('maps a scheduled pause without treating it as a cancellation', async () => {
      const { provider } = setup(() => ({
        json: {
          data: {
            ...SUBSCRIPTION,
            scheduled_change: {
              action: 'pause',
              effective_at: '2026-09-01T00:00:00Z',
              resume_at: '2026-10-01T00:00:00Z',
            },
          },
        },
      }));
      const subscription = await provider.getSubscription({ id: 'sub_1' });
      expect(subscription.status).toBe('active');
      expect(subscription.pauseAtPeriodEnd).toBe(true);
      expect(subscription.resumesAt).toEqual(new Date('2026-10-01T00:00:00Z'));
      expect(subscription.cancelAtPeriodEnd).toBe(false);
      expect(subscription.endsAt).toBeUndefined();
    });

    it('reads resumesAt from the resume change once the pause took effect', async () => {
      const { provider } = setup(() => ({
        json: {
          data: {
            ...SUBSCRIPTION,
            status: 'paused',
            scheduled_change: { action: 'resume', effective_at: '2026-10-01T00:00:00Z' },
          },
        },
      }));
      const subscription = await provider.getSubscription({ id: 'sub_1' });
      expect(subscription.status).toBe('paused');
      expect(subscription.pauseAtPeriodEnd).toBe(false);
      expect(subscription.resumesAt).toEqual(new Date('2026-10-01T00:00:00Z'));
    });

    it('pauses without effective_from when no behavior is given', async () => {
      const { provider, stub } = setup(() => ({ json: { data: SUBSCRIPTION } }));
      await provider.pauseSubscription({ id: 'sub_1' });
      const request = stub.requests[0]!;
      expect(request.method).toBe('POST');
      expect(request.url).toBe('https://api.paddle.com/subscriptions/sub_1/pause');
      expect(JSON.parse(request.body!)).toEqual({});
    });

    it('maps the pause behavior to Paddle effective_from values', async () => {
      const { provider, stub } = setup(() => ({ json: { data: SUBSCRIPTION } }));
      await provider.pauseSubscription({ id: 'sub_1', behavior: 'immediately' });
      expect(JSON.parse(stub.requests[0]!.body!)).toEqual({ effective_from: 'immediately' });
      await provider.pauseSubscription({ id: 'sub_1', behavior: 'period_end' });
      expect(JSON.parse(stub.requests[1]!.body!)).toEqual({
        effective_from: 'next_billing_period',
      });
    });

    it('sends resume_at when a resume date is given', async () => {
      const { provider, stub } = setup(() => ({ json: { data: SUBSCRIPTION } }));
      await provider.pauseSubscription({
        id: 'sub_1',
        behavior: 'immediately',
        resumesAt: new Date('2026-10-01T00:00:00Z'),
      });
      expect(JSON.parse(stub.requests[0]!.body!)).toEqual({
        effective_from: 'immediately',
        resume_at: '2026-10-01T00:00:00.000Z',
      });
    });

    it('resumes immediately', async () => {
      const { provider, stub } = setup(() => ({ json: { data: SUBSCRIPTION } }));
      await provider.resumeSubscription({ id: 'sub_1' });
      const request = stub.requests[0]!;
      expect(request.method).toBe('POST');
      expect(request.url).toBe('https://api.paddle.com/subscriptions/sub_1/resume');
      expect(JSON.parse(request.body!)).toEqual({ effective_from: 'immediately' });
    });

    it('cancels at the next billing period', async () => {
      const { provider, stub } = setup(() => ({ json: { data: SUBSCRIPTION } }));
      await provider.cancelSubscription({ id: 'sub_1' });
      const request = stub.requests[0]!;
      expect(request.url).toBe('https://api.paddle.com/subscriptions/sub_1/cancel');
      expect(JSON.parse(request.body!)).toEqual({ effective_from: 'next_billing_period' });
    });

    it('uncancels by clearing the scheduled change', async () => {
      const { provider, stub } = setup(() => ({ json: { data: SUBSCRIPTION } }));
      await provider.uncancelSubscription({ id: 'sub_1' });
      const request = stub.requests[0]!;
      expect(request.method).toBe('PATCH');
      expect(request.body).toBe('{"scheduled_change":null}');
    });

    it('changes plans with a full items replacement and mapped proration', async () => {
      const { provider, stub } = setup(() => ({ json: { data: SUBSCRIPTION } }));
      await provider.changeSubscriptionPlan({
        id: 'sub_1',
        product: 'pri_2',
        prorationBehavior: 'invoice_now',
      });
      expect(JSON.parse(stub.requests[0]!.body!)).toEqual({
        items: [{ price_id: 'pri_2', quantity: 1 }],
        proration_billing_mode: 'prorated_immediately',
      });
    });

    it('defaults the proration mode to prorated_next_billing_period', async () => {
      const { provider, stub } = setup(() => ({ json: { data: SUBSCRIPTION } }));
      await provider.changeSubscriptionPlan({ id: 'sub_1', product: 'pri_2' });
      expect(JSON.parse(stub.requests[0]!.body!).proration_billing_mode).toBe(
        'prorated_next_billing_period',
      );
    });

    it('ends a trial via activate and revokes via immediate cancel', async () => {
      const { provider, stub } = setup(() => ({ json: { data: SUBSCRIPTION } }));
      await provider.endSubscriptionTrial({ id: 'sub_1' });
      expect(stub.requests[0]!.url).toBe('https://api.paddle.com/subscriptions/sub_1/activate');
      await provider.revokeSubscription({ id: 'sub_1' });
      expect(stub.requests[1]!.url).toBe('https://api.paddle.com/subscriptions/sub_1/cancel');
      expect(JSON.parse(stub.requests[1]!.body!)).toEqual({ effective_from: 'immediately' });
    });
  });

  it('creates portal sessions via the customer-scoped path', async () => {
    const { provider, stub } = setup(() => ({
      json: {
        data: {
          id: 'cpls_1',
          urls: { general: { overview: 'https://customer-portal.paddle.com/cpl_1?token=pga_1' } },
        },
      },
    }));
    const session = await provider.createCustomerPortalSession({ customerId: 'ctm_1' });
    expect(stub.requests[0]!.url).toBe('https://api.paddle.com/customers/ctm_1/portal-sessions');
    expect(session.url).toBe('https://customer-portal.paddle.com/cpl_1?token=pga_1');
  });

  it('maps 403 authentication errors to unauthorized', async () => {
    const { provider } = setup(() => ({
      status: 403,
      json: {
        error: {
          type: 'request_error',
          code: 'invalid_token',
          detail: 'Invalid API key.',
        },
      },
    }));
    try {
      await provider.getSubscription({ id: 'sub_1' });
      expect.unreachable('expected RevenueError');
    } catch (error) {
      expect(error).toBeInstanceOf(RevenueError);
      expect((error as RevenueError).code).toBe('unauthorized');
      expect((error as RevenueError).message).toBe('Invalid API key.');
    }
  });
});
