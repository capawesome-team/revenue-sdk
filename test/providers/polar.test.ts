import { describe, expect, it } from 'vitest';
import { RevenueError } from '../../src/errors.ts';
import { polar } from '../../src/providers/polar/index.ts';
import { createFetchStub, type StubHandler } from '../helpers/fetch-stub.ts';

const TOKEN = 'polar_oat_test_token';

function setup(handler: StubHandler, options: { server?: 'sandbox' } = {}) {
  const stub = createFetchStub(handler);
  const provider = polar({ accessToken: TOKEN, fetch: stub.fetch, ...options });
  return { provider, stub };
}

function emptyPage(items: unknown[] = [], maxPage = 1) {
  return { items, pagination: { total_count: items.length, max_page: maxPage } };
}

const PRODUCT = {
  id: 'prod-uuid-1',
  name: 'Pro',
  description: 'Pro plan',
  recurring_interval: 'month',
  recurring_interval_count: 1,
  trial_interval: 'day',
  trial_interval_count: 14,
  prices: [{ id: 'price-uuid-1', amount_type: 'fixed', price_amount: 2900, price_currency: 'usd' }],
};

const SUBSCRIPTION = {
  id: 'sub-uuid-1',
  status: 'active',
  cancel_at_period_end: false,
  pause_at_period_end: false,
  customer_id: 'cus-uuid-1',
  product_id: 'prod-uuid-1',
  amount: 2900,
  currency: 'usd',
  recurring_interval: 'month',
  current_period_start: '2026-08-01T00:00:00Z',
  current_period_end: '2026-09-01T00:00:00Z',
  started_at: '2026-08-01T00:00:00Z',
  trial_end: null,
  paused_at: null,
  resumes_at: null,
  ends_at: null,
  ended_at: null,
  metadata: { organization_id: 'org_1' },
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

describe('polar', () => {
  it('exposes name and capabilities', () => {
    const { provider } = setup(() => ({ json: emptyPage() }));
    expect(provider.name).toBe('polar');
    expect(provider.capabilities.hostedCheckout).toBe(true);
    expect(provider.capabilities.prorationBehaviors).toEqual(['invoice_now', 'prorate']);
    expect(provider.capabilities.pause).toBe(true);
    expect(provider.capabilities.pauseBehaviors).toEqual(['period_end']);
    expect(provider.capabilities.usageReporting).toBe(true);
  });

  it('uses the sandbox base URL when configured', async () => {
    const { provider, stub } = setup(() => ({ json: emptyPage() }), { server: 'sandbox' });
    await provider.listProducts({});
    expect(stub.requests[0]!.url).toContain('https://sandbox-api.polar.sh/v1/products/');
  });

  describe('listProducts', () => {
    it('requests the collection with auth and maps products', async () => {
      const { provider, stub } = setup(() => ({ json: emptyPage([PRODUCT]) }));
      const page = await provider.listProducts({ limit: 25 });
      const request = stub.requests[0]!;
      expect(request.url).toBe(
        'https://api.polar.sh/v1/products/?page=1&limit=25&is_archived=false',
      );
      expect(request.headers['authorization']).toBe(`Bearer ${TOKEN}`);
      expect(page.cursor).toBeUndefined();
      const product = page.items[0]!;
      expect(product.id).toBe('prod-uuid-1');
      expect(product.name).toBe('Pro');
      const price = product.prices[0]!;
      expect(price).toMatchObject({
        id: 'price-uuid-1',
        checkoutRef: 'prod-uuid-1',
        type: 'recurring',
        model: 'fixed',
        amount: 2900,
        currency: 'usd',
        interval: 'month',
        trialDays: 14,
      });
    });

    it('pages via opaque cursors', async () => {
      const { provider, stub } = setup(() => ({ json: emptyPage([PRODUCT], 3) }));
      const first = await provider.listProducts({});
      expect(first.cursor).toBeDefined();
      await provider.listProducts({ cursor: first.cursor });
      expect(stub.requests[1]!.url).toContain('page=2');
    });
  });

  it('maps a metered price to the metered model without an amount', async () => {
    const { provider } = setup(() => ({
      json: {
        ...PRODUCT,
        prices: [{ id: 'price-uuid-2', amount_type: 'metered_unit', price_currency: 'usd' }],
      },
    }));
    const product = await provider.getProduct({ id: 'prod-uuid-1' });
    expect(product.prices[0]).toMatchObject({
      id: 'price-uuid-2',
      model: 'metered',
      amount: null,
      currency: 'usd',
    });
  });

  describe('createCheckout', () => {
    it('posts products, success url, and metadata', async () => {
      const { provider, stub } = setup(() => ({
        json: {
          id: 'checkout-1',
          status: 'open',
          url: 'https://polar.sh/checkout/secret',
          expires_at: '2026-08-07T00:00:00Z',
          customer_email: 'user@example.com',
          metadata: { organization_id: 'org_1' },
        },
      }));
      const checkout = await provider.createCheckout({
        items: [{ product: 'prod-uuid-1' }],
        successUrl: 'https://app.example.com/thanks',
        customerEmail: 'user@example.com',
        metadata: { organization_id: 'org_1' },
      });
      const request = stub.requests[0]!;
      expect(request.method).toBe('POST');
      expect(request.url).toBe('https://api.polar.sh/v1/checkouts/');
      expect(JSON.parse(request.body!)).toEqual({
        products: ['prod-uuid-1'],
        success_url: 'https://app.example.com/thanks',
        customer_email: 'user@example.com',
        metadata: { organization_id: 'org_1' },
      });
      expect(checkout).toMatchObject({
        id: 'checkout-1',
        url: 'https://polar.sh/checkout/secret',
        status: 'open',
        customerEmail: 'user@example.com',
        metadata: { organization_id: 'org_1' },
      });
      expect(checkout.expiresAt).toEqual(new Date('2026-08-07T00:00:00Z'));
    });

    it('rejects item quantities', async () => {
      const { provider } = setup(() => ({ json: {} }));
      await expectRevenueError(
        provider.createCheckout({ items: [{ product: 'p1', quantity: 2 }] }),
        'unsupported',
      );
    });
  });

  it('maps a succeeded checkout to complete', async () => {
    const { provider } = setup(() => ({
      json: { id: 'checkout-1', status: 'succeeded', url: null, subscription_id: 'sub-uuid-1' },
    }));
    const checkout = await provider.getCheckout({ id: 'checkout-1' });
    expect(checkout.status).toBe('complete');
    expect(checkout.subscriptionId).toBe('sub-uuid-1');
  });

  describe('customers', () => {
    it('gets a customer', async () => {
      const { provider, stub } = setup(() => ({
        json: {
          id: 'cus-uuid-1',
          email: 'user@example.com',
          name: 'User',
          created_at: '2026-01-01T00:00:00Z',
        },
      }));
      const customer = await provider.getCustomer({ id: 'cus-uuid-1' });
      expect(stub.requests[0]!.url).toBe('https://api.polar.sh/v1/customers/cus-uuid-1');
      expect(customer).toMatchObject({ id: 'cus-uuid-1', email: 'user@example.com', name: 'User' });
    });

    it('lists customers filtered by email', async () => {
      const { provider, stub } = setup(() => ({ json: emptyPage() }));
      await provider.listCustomers({ email: 'user@example.com' });
      expect(stub.requests[0]!.url).toContain('email=user%40example.com');
    });
  });

  describe('subscriptions', () => {
    it('maps an active subscription', async () => {
      const { provider } = setup(() => ({ json: SUBSCRIPTION }));
      const subscription = await provider.getSubscription({ id: 'sub-uuid-1' });
      expect(subscription).toMatchObject({
        id: 'sub-uuid-1',
        status: 'active',
        cancelAtPeriodEnd: false,
        pauseAtPeriodEnd: false,
        customerId: 'cus-uuid-1',
        productId: 'prod-uuid-1',
        amount: 2900,
        currency: 'usd',
        interval: 'month',
        metadata: { organization_id: 'org_1' },
      });
      expect(subscription.currentPeriodEnd).toEqual(new Date('2026-09-01T00:00:00Z'));
    });

    it('maps inline meters', async () => {
      const meter = {
        id: 'sub-meter-uuid-1',
        meter_id: 'meter-uuid-1',
        meter: { id: 'meter-uuid-1', name: 'AI tokens', unit: 'token' },
        consumed_units: 1234.5,
        credited_units: 1000,
        amount: 250,
      };
      const { provider } = setup(() => ({ json: { ...SUBSCRIPTION, meters: [meter] } }));
      const subscription = await provider.getSubscription({ id: 'sub-uuid-1' });
      expect(subscription.meters).toEqual([
        {
          id: 'meter-uuid-1',
          name: 'AI tokens',
          consumedUnits: 1234.5,
          creditedUnits: 1000,
          amount: 250,
          raw: meter,
        },
      ]);
    });

    it('leaves meters absent when the payload has none', async () => {
      const { provider } = setup(() => ({ json: SUBSCRIPTION }));
      const subscription = await provider.getSubscription({ id: 'sub-uuid-1' });
      expect(subscription.meters).toBeUndefined();
    });

    it('maps scheduled cancellations to cancelAtPeriodEnd', async () => {
      const { provider } = setup(() => ({
        json: {
          ...SUBSCRIPTION,
          cancel_at_period_end: true,
          ends_at: '2026-09-01T00:00:00Z',
        },
      }));
      const subscription = await provider.getSubscription({ id: 'sub-uuid-1' });
      expect(subscription.status).toBe('active');
      expect(subscription.cancelAtPeriodEnd).toBe(true);
      expect(subscription.endsAt).toEqual(new Date('2026-09-01T00:00:00Z'));
    });

    it('maps a paused subscription with its resume date', async () => {
      const { provider } = setup(() => ({
        json: {
          ...SUBSCRIPTION,
          status: 'paused',
          pause_at_period_end: true,
          paused_at: '2026-09-01T00:00:00Z',
          resumes_at: '2026-10-01T00:00:00Z',
        },
      }));
      const subscription = await provider.getSubscription({ id: 'sub-uuid-1' });
      expect(subscription.status).toBe('paused');
      expect(subscription.pauseAtPeriodEnd).toBe(true);
      expect(subscription.resumesAt).toEqual(new Date('2026-10-01T00:00:00Z'));
    });

    it('maps terminal and edge statuses', async () => {
      for (const [polarStatus, unified] of [
        ['canceled', 'canceled'],
        ['incomplete_expired', 'canceled'],
        ['trialing', 'trialing'],
        ['unpaid', 'unpaid'],
        ['paused', 'paused'],
        ['past_due', 'past_due'],
        ['incomplete', 'incomplete'],
      ] as const) {
        const { provider } = setup(() => ({ json: { ...SUBSCRIPTION, status: polarStatus } }));
        const subscription = await provider.getSubscription({ id: 'sub-uuid-1' });
        expect(subscription.status).toBe(unified);
      }
    });

    it('lists subscriptions filtered by customer', async () => {
      const { provider, stub } = setup(() => ({ json: emptyPage() }));
      await provider.listSubscriptions({ customerId: 'cus-uuid-1' });
      expect(stub.requests[0]!.url).toBe(
        'https://api.polar.sh/v1/subscriptions/?page=1&limit=10&customer_id=cus-uuid-1',
      );
    });

    it('cancels at period end with reason and comment', async () => {
      const { provider, stub } = setup(() => ({
        json: { ...SUBSCRIPTION, cancel_at_period_end: true },
      }));
      await provider.cancelSubscription({
        id: 'sub-uuid-1',
        reason: 'too_expensive',
        comment: 'Switching to annual billing',
      });
      const request = stub.requests[0]!;
      expect(request.method).toBe('PATCH');
      expect(request.url).toBe('https://api.polar.sh/v1/subscriptions/sub-uuid-1');
      expect(JSON.parse(request.body!)).toEqual({
        cancel_at_period_end: true,
        customer_cancellation_reason: 'too_expensive',
        customer_cancellation_comment: 'Switching to annual billing',
      });
    });

    it('uncancels', async () => {
      const { provider, stub } = setup(() => ({ json: SUBSCRIPTION }));
      await provider.uncancelSubscription({ id: 'sub-uuid-1' });
      expect(JSON.parse(stub.requests[0]!.body!)).toEqual({ cancel_at_period_end: false });
    });

    it('changes the plan with mapped proration behavior', async () => {
      const { provider, stub } = setup(() => ({ json: SUBSCRIPTION }));
      await provider.changeSubscriptionPlan({
        id: 'sub-uuid-1',
        product: 'prod-uuid-2',
        prorationBehavior: 'invoice_now',
      });
      expect(JSON.parse(stub.requests[0]!.body!)).toEqual({
        product_id: 'prod-uuid-2',
        proration_behavior: 'invoice',
      });
    });

    it('rejects the none proration behavior', async () => {
      const { provider } = setup(() => ({ json: SUBSCRIPTION }));
      await expectRevenueError(
        provider.changeSubscriptionPlan({
          id: 'sub-uuid-1',
          product: 'prod-uuid-2',
          prorationBehavior: 'none',
        }),
        'unsupported',
      );
    });

    it('ends a trial immediately', async () => {
      const { provider, stub } = setup(() => ({ json: SUBSCRIPTION }));
      await provider.endSubscriptionTrial({ id: 'sub-uuid-1' });
      expect(JSON.parse(stub.requests[0]!.body!)).toEqual({ trial_end: 'now' });
    });

    it('pauses at period end without a resume date', async () => {
      const { provider, stub } = setup(() => ({
        json: { ...SUBSCRIPTION, pause_at_period_end: true },
      }));
      const subscription = await provider.pauseSubscription({ id: 'sub-uuid-1' });
      const request = stub.requests[0]!;
      expect(request.method).toBe('PATCH');
      expect(request.url).toBe('https://api.polar.sh/v1/subscriptions/sub-uuid-1');
      expect(JSON.parse(request.body!)).toEqual({ pause_at_period_end: true });
      expect(subscription.pauseAtPeriodEnd).toBe(true);
    });

    it('sends the resume date as an ISO string when pausing', async () => {
      const { provider, stub } = setup(() => ({
        json: { ...SUBSCRIPTION, pause_at_period_end: true, resumes_at: '2026-10-01T00:00:00Z' },
      }));
      await provider.pauseSubscription({
        id: 'sub-uuid-1',
        resumesAt: new Date('2026-10-01T00:00:00Z'),
      });
      expect(JSON.parse(stub.requests[0]!.body!)).toEqual({
        pause_at_period_end: true,
        resumes_at: '2026-10-01T00:00:00.000Z',
      });
    });

    it('resumes immediately', async () => {
      const { provider, stub } = setup(() => ({ json: SUBSCRIPTION }));
      const subscription = await provider.resumeSubscription({ id: 'sub-uuid-1' });
      const request = stub.requests[0]!;
      expect(request.method).toBe('PATCH');
      expect(JSON.parse(request.body!)).toEqual({ resume: true });
      expect(subscription.status).toBe('active');
    });

    it('revokes via DELETE', async () => {
      const { provider, stub } = setup(() => ({
        json: { ...SUBSCRIPTION, status: 'canceled', ended_at: '2026-08-06T00:00:00Z' },
      }));
      const subscription = await provider.revokeSubscription({ id: 'sub-uuid-1' });
      expect(stub.requests[0]!.method).toBe('DELETE');
      expect(subscription.status).toBe('canceled');
    });
  });

  it('creates a customer portal session', async () => {
    const { provider, stub } = setup(() => ({
      json: { customer_portal_url: 'https://polar.sh/acme/portal?customer_session_token=tok' },
    }));
    const session = await provider.createCustomerPortalSession({
      customerId: 'cus-uuid-1',
      returnUrl: 'https://app.example.com/billing',
    });
    const request = stub.requests[0]!;
    expect(request.url).toBe('https://api.polar.sh/v1/customer-sessions/');
    expect(JSON.parse(request.body!)).toEqual({
      customer_id: 'cus-uuid-1',
      return_url: 'https://app.example.com/billing',
    });
    expect(session.url).toBe('https://polar.sh/acme/portal?customer_session_token=tok');
  });

  describe('reportUsage', () => {
    it('ingests a single-event batch', async () => {
      const { provider, stub } = setup(() => ({ json: { inserted: 1, duplicates: 0 } }));
      await provider.reportUsage({ customerId: 'cus-uuid-1', eventName: 'ai_usage' });
      const request = stub.requests[0]!;
      expect(request.method).toBe('POST');
      expect(request.url).toBe('https://api.polar.sh/v1/events/ingest');
      expect(JSON.parse(request.body!)).toEqual({
        events: [{ name: 'ai_usage', customer_id: 'cus-uuid-1' }],
      });
    });

    it('merges value over metadata and maps the idempotency key and timestamp', async () => {
      const { provider, stub } = setup(() => ({ json: { inserted: 1, duplicates: 0 } }));
      await provider.reportUsage({
        customerId: 'cus-uuid-1',
        eventName: 'ai_usage',
        value: 77,
        metadata: { model: 'sonnet', value: 1 },
        idempotencyKey: 'evt_abc',
        timestamp: new Date('2026-08-06T10:00:00Z'),
      });
      expect(JSON.parse(stub.requests[0]!.body!)).toEqual({
        events: [
          {
            name: 'ai_usage',
            customer_id: 'cus-uuid-1',
            timestamp: '2026-08-06T10:00:00.000Z',
            external_id: 'evt_abc',
            metadata: { model: 'sonnet', value: 77 },
          },
        ],
      });
    });
  });

  it('maps Polar error bodies onto RevenueError', async () => {
    const { provider } = setup(() => ({
      status: 404,
      json: { error: 'ResourceNotFound', detail: 'Subscription does not exist.' },
    }));
    try {
      await provider.getSubscription({ id: 'missing' });
      expect.unreachable('expected RevenueError');
    } catch (error) {
      expect(error).toBeInstanceOf(RevenueError);
      const revenueError = error as RevenueError;
      expect(revenueError.code).toBe('not_found');
      expect(revenueError.message).toBe('ResourceNotFound: Subscription does not exist.');
    }
  });
});
