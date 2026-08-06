import { describe, expect, it } from 'vitest';
import { RevenueError } from '../../src/errors.ts';
import { dodoPayments } from '../../src/providers/dodo-payments/index.ts';
import { createFetchStub, type StubHandler } from '../helpers/fetch-stub.ts';

const API_KEY = 'dodo_test_api_key';

function setup(handler: StubHandler, options: { server?: 'test' } = {}) {
  const stub = createFetchStub(handler);
  const provider = dodoPayments({ apiKey: API_KEY, fetch: stub.fetch, ...options });
  return { provider, stub };
}

const SUBSCRIPTION = {
  subscription_id: 'sub_abc',
  status: 'active',
  cancel_at_next_billing_date: false,
  product_id: 'pdt_1',
  quantity: 1,
  currency: 'USD',
  recurring_pre_tax_amount: 2500,
  payment_frequency_count: 1,
  payment_frequency_interval: 'Month',
  previous_billing_date: '2026-08-01T00:00:00Z',
  next_billing_date: '2026-09-01T00:00:00Z',
  created_at: '2026-08-01T00:00:00Z',
  cancelled_at: null,
  customer: { customer_id: 'cus_1', email: 'user@example.com' },
  metadata: { org_id: 'org_1' },
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

describe('dodoPayments', () => {
  it('uses the test host when configured', async () => {
    const { provider, stub } = setup(() => ({ json: { items: [] } }), { server: 'test' });
    await provider.listProducts({});
    expect(stub.requests[0]!.url).toContain('https://test.dodopayments.com/products');
    expect(stub.requests[0]!.headers['authorization']).toBe(`Bearer ${API_KEY}`);
  });

  describe('products', () => {
    it('lists products with zero-based pagination and capitalized intervals mapped', async () => {
      const { provider, stub } = setup(() => ({
        json: {
          items: [
            {
              product_id: 'pdt_1',
              name: 'Pro',
              price: 2500,
              currency: 'USD',
              is_recurring: true,
              price_detail: {
                type: 'recurring_price',
                currency: 'USD',
                price: 2500,
                payment_frequency_count: 1,
                payment_frequency_interval: 'Month',
                trial_period_days: 14,
              },
            },
          ],
        },
      }));
      const page = await provider.listProducts({ limit: 25 });
      expect(stub.requests[0]!.url).toBe(
        'https://live.dodopayments.com/products?page_number=0&page_size=25&archived=false',
      );
      const price = page.items[0]!.prices[0]!;
      expect(price).toMatchObject({
        id: 'pdt_1',
        checkoutRef: 'pdt_1',
        type: 'recurring',
        model: 'fixed',
        amount: 2500,
        currency: 'usd',
        interval: 'month',
        trialDays: 14,
      });
    });

    it('terminates pagination when a page is not full', async () => {
      const fullPage = Array.from({ length: 10 }, (_, index) => ({
        product_id: `pdt_${index}`,
        name: 'P',
      }));
      let call = 0;
      const { provider, stub } = setup(() => {
        call += 1;
        return { json: { items: call === 1 ? fullPage : fullPage.slice(0, 3) } };
      });
      const first = await provider.listProducts({});
      expect(first.cursor).toBeDefined();
      const second = await provider.listProducts({ cursor: first.cursor });
      expect(stub.requests[1]!.url).toContain('page_number=1');
      expect(second.cursor).toBeUndefined();
    });
  });

  describe('checkouts', () => {
    it('creates a checkout session', async () => {
      const { provider, stub } = setup(() => ({
        json: {
          session_id: 'cks_1',
          checkout_url: 'https://checkout.dodopayments.com/session/cks_1',
        },
      }));
      const checkout = await provider.createCheckout({
        items: [{ product: 'pdt_1', quantity: 2 }],
        customerEmail: 'user@example.com',
        successUrl: 'https://app.example.com/thanks',
        metadata: { org_id: 'org_1' },
      });
      expect(JSON.parse(stub.requests[0]!.body!)).toEqual({
        product_cart: [{ product_id: 'pdt_1', quantity: 2 }],
        customer: { email: 'user@example.com' },
        return_url: 'https://app.example.com/thanks',
        metadata: { org_id: 'org_1' },
      });
      expect(checkout).toMatchObject({
        id: 'cks_1',
        url: 'https://checkout.dodopayments.com/session/cks_1',
        status: 'open',
      });
    });

    it('attaches an existing customer by id', async () => {
      const { provider, stub } = setup(() => ({
        json: { session_id: 'cks_1', checkout_url: 'https://x' },
      }));
      await provider.createCheckout({
        items: [{ product: 'pdt_1' }],
        customerId: 'cus_1',
        customerEmail: 'ignored@example.com',
      });
      expect(JSON.parse(stub.requests[0]!.body!).customer).toEqual({ customer_id: 'cus_1' });
    });

    it('maps the session status endpoint', async () => {
      const { provider } = setup(() => ({
        json: {
          id: 'cks_1',
          payment_id: 'pay_1',
          payment_status: 'succeeded',
          customer_email: 'user@example.com',
        },
      }));
      const checkout = await provider.getCheckout({ id: 'cks_1' });
      expect(checkout.status).toBe('complete');
      expect(checkout.customerEmail).toBe('user@example.com');
    });
  });

  describe('subscriptions', () => {
    it('maps an active subscription with capitalized intervals', async () => {
      const { provider } = setup(() => ({ json: SUBSCRIPTION }));
      const subscription = await provider.getSubscription({ id: 'sub_abc' });
      expect(subscription).toMatchObject({
        id: 'sub_abc',
        status: 'active',
        cancelAtPeriodEnd: false,
        customerId: 'cus_1',
        productId: 'pdt_1',
        currency: 'usd',
        amount: 2500,
        interval: 'month',
        metadata: { org_id: 'org_1' },
      });
      expect(subscription.currentPeriodEnd).toEqual(new Date('2026-09-01T00:00:00Z'));
    });

    it('maps on_hold to past_due and terminal statuses to canceled', async () => {
      for (const [dodoStatus, unified] of [
        ['pending', 'incomplete'],
        ['on_hold', 'past_due'],
        ['cancelled', 'canceled'],
        ['failed', 'canceled'],
        ['expired', 'canceled'],
      ] as const) {
        const { provider } = setup(() => ({ json: { ...SUBSCRIPTION, status: dodoStatus } }));
        const subscription = await provider.getSubscription({ id: 'sub_abc' });
        expect(subscription.status).toBe(unified);
      }
    });

    it('maps a scheduled cancellation', async () => {
      const { provider } = setup(() => ({
        json: { ...SUBSCRIPTION, cancel_at_next_billing_date: true },
      }));
      const subscription = await provider.getSubscription({ id: 'sub_abc' });
      expect(subscription.status).toBe('active');
      expect(subscription.cancelAtPeriodEnd).toBe(true);
      expect(subscription.endsAt).toEqual(new Date('2026-09-01T00:00:00Z'));
    });

    it('cancels with feedback and comment', async () => {
      const { provider, stub } = setup(() => ({
        json: { ...SUBSCRIPTION, cancel_at_next_billing_date: true },
      }));
      await provider.cancelSubscription({
        id: 'sub_abc',
        reason: 'too_expensive',
        comment: 'Budget cuts',
      });
      const request = stub.requests[0]!;
      expect(request.method).toBe('PATCH');
      expect(JSON.parse(request.body!)).toEqual({
        cancel_at_next_billing_date: true,
        cancellation_feedback: 'too_expensive',
        cancellation_comment: 'Budget cuts',
      });
    });

    it('changes plans via change-plan (empty 200) and re-fetches the subscription', async () => {
      const { provider, stub } = setup((request) => {
        if (request.url.endsWith('/change-plan')) {
          return { status: 200, body: '' };
        }
        return { json: SUBSCRIPTION };
      });
      const subscription = await provider.changeSubscriptionPlan({
        id: 'sub_abc',
        product: 'pdt_2',
        quantity: 2,
        prorationBehavior: 'invoice_now',
      });
      expect(JSON.parse(stub.requests[0]!.body!)).toEqual({
        product_id: 'pdt_2',
        quantity: 2,
        proration_billing_mode: 'prorated_immediately',
      });
      expect(stub.requests[1]!.method).toBe('GET');
      expect(subscription.id).toBe('sub_abc');
    });

    it('rejects the prorate behavior and endTrial', async () => {
      const { provider } = setup(() => ({ json: SUBSCRIPTION }));
      await expectRevenueError(
        provider.changeSubscriptionPlan({
          id: 'sub_abc',
          product: 'pdt_2',
          prorationBehavior: 'prorate',
        }),
        'unsupported',
      );
      await expectRevenueError(provider.endSubscriptionTrial({ id: 'sub_abc' }), 'unsupported');
    });

    it('revokes by setting the status to cancelled', async () => {
      const { provider, stub } = setup(() => ({
        json: { ...SUBSCRIPTION, status: 'cancelled', cancelled_at: '2026-08-06T00:00:00Z' },
      }));
      const subscription = await provider.revokeSubscription({ id: 'sub_abc' });
      expect(JSON.parse(stub.requests[0]!.body!)).toEqual({ status: 'cancelled' });
      expect(subscription.status).toBe('canceled');
      expect(subscription.cancelAtPeriodEnd).toBe(false);
    });
  });

  it('creates portal sessions with query-string parameters', async () => {
    const { provider, stub } = setup(() => ({
      json: { link: 'https://portal.dodopayments.com/session/tok' },
    }));
    const session = await provider.createCustomerPortalSession({
      customerId: 'cus_1',
      returnUrl: 'https://app.example.com/billing',
    });
    const request = stub.requests[0]!;
    expect(request.method).toBe('POST');
    expect(request.url).toBe(
      'https://live.dodopayments.com/customers/cus_1/customer-portal/session?return_url=https%3A%2F%2Fapp.example.com%2Fbilling',
    );
    expect(session.url).toBe('https://portal.dodopayments.com/session/tok');
  });

  it('maps Dodo error bodies onto RevenueError', async () => {
    const { provider } = setup(() => ({
      status: 409,
      json: { code: 'PENDING_PLAN_CHANGE_EXISTS', message: 'A plan change is already pending' },
    }));
    try {
      await provider.getSubscription({ id: 'sub_abc' });
      expect.unreachable('expected RevenueError');
    } catch (error) {
      expect(error).toBeInstanceOf(RevenueError);
      expect((error as RevenueError).code).toBe('conflict');
      expect((error as RevenueError).message).toBe(
        'PENDING_PLAN_CHANGE_EXISTS: A plan change is already pending',
      );
    }
  });
});
