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

    it('maps a usage-based price to the metered model', async () => {
      const { provider } = setup(() => ({
        json: {
          product_id: 'pdt_metered',
          name: 'Metered API',
          is_recurring: true,
          price: {
            type: 'usage_based_price',
            currency: 'USD',
            fixed_price: 1000,
            payment_frequency_count: 1,
            payment_frequency_interval: 'Month',
          },
        },
      }));
      const product = await provider.getProduct({ id: 'pdt_metered' });
      expect(product.prices[0]).toMatchObject({
        id: 'pdt_metered',
        checkoutRef: 'pdt_metered',
        type: 'recurring',
        model: 'metered',
        amount: null,
        currency: 'usd',
        interval: 'month',
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
    it('does not advertise a configurable checkout expiry', () => {
      const { provider } = setup(() => ({ json: {} }));
      expect(provider.capabilities.checkoutExpiresAt).toBe(false);
    });

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

    it('rejects pause and resume', async () => {
      const { provider } = setup(() => ({ json: SUBSCRIPTION }));
      expect(provider.capabilities.pause).toBe(false);
      expect(provider.capabilities.pauseBehaviors).toEqual([]);
      await expectRevenueError(provider.pauseSubscription({ id: 'sub_abc' }), 'unsupported');
      await expectRevenueError(provider.resumeSubscription({ id: 'sub_abc' }), 'unsupported');
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

  describe('usage', () => {
    it('advertises usage reporting', () => {
      const { provider } = setup(() => ({ json: {} }));
      expect(provider.capabilities.usageReporting).toBe(true);
    });

    it('ingests a one-event batch and generates an event id when none is given', async () => {
      const { provider, stub } = setup(() => ({ json: { ingested_count: 1 } }));
      const result = await provider.reportUsage({ customerId: 'cus_1', eventName: 'api_request' });
      const request = stub.requests[0]!;
      expect(request.method).toBe('POST');
      expect(request.url).toBe('https://live.dodopayments.com/events/ingest');
      const { events } = JSON.parse(request.body!);
      expect(events).toHaveLength(1);
      expect(typeof events[0].event_id).toBe('string');
      expect(events[0].event_id.length).toBeGreaterThan(0);
      expect(events[0]).toEqual({
        event_id: events[0].event_id,
        customer_id: 'cus_1',
        event_name: 'api_request',
      });
      expect(result).toBeUndefined();
    });

    it('uses the idempotency key as the event id and lets value win over metadata.value', async () => {
      const { provider, stub } = setup(() => ({ json: { ingested_count: 1 } }));
      await provider.reportUsage({
        customerId: 'cus_1',
        eventName: 'api_request',
        value: 150,
        metadata: { value: 1, region: 'eu', billable: true },
        idempotencyKey: 'api_call_12345',
        timestamp: new Date('2026-08-06T10:30:00Z'),
      });
      expect(JSON.parse(stub.requests[0]!.body!)).toEqual({
        events: [
          {
            event_id: 'api_call_12345',
            customer_id: 'cus_1',
            event_name: 'api_request',
            timestamp: '2026-08-06T10:30:00.000Z',
            metadata: { value: 150, region: 'eu', billable: true },
          },
        ],
      });
    });
  });

  describe('orders', () => {
    const PAYMENT = {
      payment_id: 'pay_1',
      status: 'succeeded',
      total_amount: 2500,
      currency: 'USD',
      subscription_id: 'sub_abc',
      customer: { customer_id: 'cus_1', email: 'user@example.com', name: 'User' },
      created_at: '2026-08-01T00:00:00Z',
      refund_status: null,
      invoice_url: 'https://live.dodopayments.com/invoices/inv_1',
      metadata: { org_id: 'org_1' },
    };

    it('lists succeeded payments with zero-based pagination', async () => {
      const { provider, stub } = setup(() => ({ json: { items: [PAYMENT] } }));
      const page = await provider.listOrders({ limit: 25 });
      expect(stub.requests[0]!.url).toBe(
        'https://live.dodopayments.com/payments?page_number=0&page_size=25&status=succeeded',
      );
      expect(page.items[0]).toMatchObject({
        id: 'pay_1',
        status: 'paid',
        amount: 2500,
        currency: 'usd',
        customerId: 'cus_1',
        customerEmail: 'user@example.com',
        subscriptionId: 'sub_abc',
        metadata: { org_id: 'org_1' },
      });
      expect(page.items[0]!.createdAt).toEqual(new Date('2026-08-01T00:00:00Z'));
      expect(page.items[0]!.refundStatus).toBeUndefined();
      expect(page.cursor).toBeUndefined();
    });

    it('filters by customer and paginates through page_number', async () => {
      const fullPage = Array.from({ length: 10 }, (_, index) => ({
        ...PAYMENT,
        payment_id: `pay_${index}`,
      }));
      let call = 0;
      const { provider, stub } = setup(() => {
        call += 1;
        return { json: { items: call === 1 ? fullPage : fullPage.slice(0, 3) } };
      });
      const first = await provider.listOrders({ customerId: 'cus_1' });
      expect(stub.requests[0]!.url).toBe(
        'https://live.dodopayments.com/payments?page_number=0&page_size=10&status=succeeded&customer_id=cus_1',
      );
      expect(first.cursor).toBeDefined();
      const second = await provider.listOrders({ cursor: first.cursor, customerId: 'cus_1' });
      expect(stub.requests[1]!.url).toContain('page_number=1');
      expect(second.cursor).toBeUndefined();
    });

    it('passes minor units through for zero-decimal currencies', async () => {
      const { provider } = setup(() => ({
        json: { ...PAYMENT, total_amount: 1000, currency: 'JPY' },
      }));
      const order = await provider.getOrder({ id: 'pay_1' });
      expect(order).toMatchObject({ amount: 1000, currency: 'jpy' });
    });

    it('maps the payment status and treats the enum as open', async () => {
      for (const [dodoStatus, unified] of [
        ['succeeded', 'paid'],
        ['processing', 'pending'],
        ['requires_payment_method', 'pending'],
        ['requires_customer_action', 'pending'],
        ['failed', 'failed'],
        ['cancelled', 'failed'],
        [null, 'pending'],
        ['something_new', 'pending'],
      ] as const) {
        const { provider } = setup(() => ({ json: { ...PAYMENT, status: dodoStatus } }));
        const order = await provider.getOrder({ id: 'pay_1' });
        expect(order.status).toBe(unified);
      }
    });

    it('maps the refund status reported on the payment', async () => {
      for (const refundStatus of ['partial', 'full'] as const) {
        const { provider, stub } = setup(() => ({
          json: { ...PAYMENT, refund_status: refundStatus },
        }));
        const order = await provider.getOrder({ id: 'pay_1' });
        expect(stub.requests[0]!.url).toBe('https://live.dodopayments.com/payments/pay_1');
        expect(order.refundStatus).toBe(refundStatus);
      }
    });

    it('returns the invoice URL carried by the payment', async () => {
      const { provider, stub } = setup(() => ({ json: PAYMENT }));
      const url = await provider.getOrderInvoiceUrl({ id: 'pay_1' });
      expect(stub.requests[0]!.url).toBe('https://live.dodopayments.com/payments/pay_1');
      expect(url).toBe('https://live.dodopayments.com/invoices/inv_1');
    });

    it('throws not_found when the payment carries no invoice URL', async () => {
      const { provider } = setup(() => ({ json: { ...PAYMENT, invoice_url: null } }));
      await expectRevenueError(provider.getOrderInvoiceUrl({ id: 'pay_1' }), 'not_found');
    });
  });

  describe('license keys', () => {
    const LICENSE_KEY = {
      id: 'lic_1',
      key: 'a1b2c3d4-0000-4000-8000-000000000000',
      status: 'active',
      activations_limit: 3,
      instances_count: 1,
      expires_at: '2027-01-01T00:00:00Z',
      customer_id: 'cus_1',
      product_id: 'pdt_1',
    };

    it('advertises license key support', () => {
      const { provider } = setup(() => ({ json: {} }));
      expect(provider.capabilities.licenseKeys).toBe(true);
    });

    it('lists license keys from the underscored merchant route', async () => {
      const { provider, stub } = setup(() => ({ json: { items: [LICENSE_KEY] } }));
      const page = await provider.listLicenseKeys({ limit: 2 });
      expect(stub.requests[0]!.url).toBe(
        'https://live.dodopayments.com/license_keys?page_number=0&page_size=2',
      );
      expect(stub.requests[0]!.headers['authorization']).toBe(`Bearer ${API_KEY}`);
      expect(page.items[0]).toMatchObject({
        id: 'lic_1',
        key: 'a1b2c3d4-0000-4000-8000-000000000000',
        status: 'active',
        activationLimit: 3,
        activationCount: 1,
        customerId: 'cus_1',
        productId: 'pdt_1',
      });
      expect(page.items[0]!.expiresAt).toEqual(new Date('2027-01-01T00:00:00Z'));
      // A short page terminates pagination — Dodo lists carry no has_more.
      expect(page.cursor).toBeUndefined();
    });

    it('maps the disabled and expired statuses', async () => {
      for (const [dodoStatus, unified] of [
        ['active', 'active'],
        ['disabled', 'disabled'],
        ['expired', 'expired'],
      ] as const) {
        const { provider } = setup(() => ({ json: { ...LICENSE_KEY, status: dodoStatus } }));
        const licenseKey = await provider.getLicenseKey({ id: 'lic_1' });
        expect(licenseKey.status).toBe(unified);
      }
    });

    it('omits an absent limit and expiry', async () => {
      const { provider, stub } = setup(() => ({
        json: { ...LICENSE_KEY, activations_limit: null, expires_at: null },
      }));
      const licenseKey = await provider.getLicenseKey({ id: 'lic_1' });
      expect(stub.requests[0]!.url).toBe('https://live.dodopayments.com/license_keys/lic_1');
      expect(licenseKey.activationLimit).toBeUndefined();
      expect(licenseKey.expiresAt).toBeUndefined();
    });

    it('updates a license key with an ISO expiry', async () => {
      const { provider, stub } = setup(() => ({ json: { ...LICENSE_KEY, activations_limit: 5 } }));
      const licenseKey = await provider.updateLicenseKey({
        id: 'lic_1',
        activationLimit: 5,
        disabled: false,
        expiresAt: new Date('2027-06-01T00:00:00Z'),
      });
      const request = stub.requests[0]!;
      expect(request.method).toBe('PATCH');
      expect(request.url).toBe('https://live.dodopayments.com/license_keys/lic_1');
      expect(JSON.parse(request.body!)).toEqual({
        activations_limit: 5,
        disabled: false,
        expires_at: '2027-06-01T00:00:00.000Z',
      });
      expect(licenseKey.activationLimit).toBe(5);
    });

    it('sends null to clear the limit and expiry and omits untouched fields', async () => {
      const { provider, stub } = setup(() => ({ json: LICENSE_KEY }));
      await provider.updateLicenseKey({ id: 'lic_1', activationLimit: null, expiresAt: null });
      expect(JSON.parse(stub.requests[0]!.body!)).toEqual({
        activations_limit: null,
        expires_at: null,
      });
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
