import { describe, expect, it } from 'vitest';
import { RevenueError } from '../../src/errors.ts';
import { stripe } from '../../src/providers/stripe/index.ts';
import { createFetchStub, type StubHandler, type StubRequest } from '../helpers/fetch-stub.ts';

const SECRET_KEY = 'sk_test_secret_key';

function setup(handler: StubHandler) {
  const stub = createFetchStub(handler);
  const provider = stripe({ secretKey: SECRET_KEY, fetch: stub.fetch });
  return { provider, stub };
}

function routes(
  handlers: Record<string, unknown | ((request: StubRequest) => unknown)>,
): StubHandler {
  return (request) => {
    const path = new URL(request.url).pathname;
    const handler = handlers[path];
    if (handler === undefined) {
      throw new Error(`Unhandled route: ${request.method} ${path}`);
    }
    return { json: typeof handler === 'function' ? handler(request) : handler };
  };
}

const RECURRING_PRICE = {
  id: 'price_1',
  product: 'prod_1',
  currency: 'usd',
  unit_amount: 2900,
  type: 'recurring',
  billing_scheme: 'per_unit',
  recurring: { interval: 'month', interval_count: 1, usage_type: 'licensed' },
};

const RESUMES_AT = 1790899200;

const PAUSE_COLLECTION = { behavior: 'void', resumes_at: RESUMES_AT };

const SUBSCRIPTION = {
  id: 'sub_1',
  status: 'active',
  cancel_at_period_end: false,
  cancel_at: null,
  pause_collection: null,
  canceled_at: null,
  ended_at: null,
  customer: 'cus_1',
  currency: 'usd',
  trial_end: null,
  start_date: 1754006400,
  metadata: { org_id: 'org_1' },
  items: {
    data: [
      {
        id: 'si_1',
        quantity: 1,
        current_period_start: 1754006400,
        current_period_end: 1756684800,
        price: RECURRING_PRICE,
      },
    ],
    has_more: false,
  },
};

const INVOICE = {
  id: 'in_1',
  status: 'paid',
  created: 1754006400,
  amount_paid: 2900,
  total: 2900,
  currency: 'usd',
  customer: 'cus_1',
  customer_email: 'user@example.com',
  hosted_invoice_url: 'https://invoice.stripe.com/i/acct_1/live_1',
  invoice_pdf: 'https://pay.stripe.com/invoice/acct_1/live_1/pdf',
  metadata: { org_id: 'org_1' },
  parent: { subscription_details: { subscription: 'sub_1', metadata: { org_id: 'org_1' } } },
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

describe('stripe', () => {
  it('rejects a factory call without a secret key', () => {
    expect(() => stripe({ secretKey: '' })).toThrow(RevenueError);
    expect(() => stripe({ secretKey: '' })).toThrow(/secretKey/);
  });

  it('sends the pinned Stripe-Version and bearer auth', async () => {
    const { provider, stub } = setup(routes({ '/v1/products': { data: [], has_more: false } }));
    await provider.listProducts({});
    const request = stub.requests[0]!;
    expect(request.headers['authorization']).toBe(`Bearer ${SECRET_KEY}`);
    expect(request.headers['stripe-version']).toBe('2026-07-29.dahlia');
  });

  it('exposes name and capabilities', () => {
    const { provider } = setup(() => ({ json: {} }));
    expect(provider.name).toBe('stripe');
    expect(provider.capabilities.hostedCheckout).toBe(true);
    expect(provider.capabilities.checkoutExpiresAt).toBe(true);
    expect(provider.capabilities.usageReporting).toBe(true);
    expect(provider.capabilities.licenseKeys).toBe(false);
    expect(provider.capabilities.listOrdersByCustomer).toBe(true);
  });

  it('rejects license key operations', async () => {
    const { provider } = setup(() => ({ json: {} }));
    await expectRevenueError(provider.listLicenseKeys({}), 'unsupported');
    await expectRevenueError(provider.getLicenseKey({ id: 'lk_1' }), 'unsupported');
    await expectRevenueError(
      provider.updateLicenseKey({ id: 'lk_1', disabled: true }),
      'unsupported',
    );
  });

  describe('products', () => {
    it('lists products with their active prices', async () => {
      const { provider, stub } = setup(
        routes({
          '/v1/products': {
            data: [{ id: 'prod_1', name: 'Pro', description: 'Pro plan' }],
            has_more: false,
          },
          '/v1/prices': { data: [RECURRING_PRICE], has_more: false },
        }),
      );
      const page = await provider.listProducts({});
      expect(stub.requests[0]!.url).toContain('/v1/products?active=true&limit=10');
      expect(stub.requests[1]!.url).toContain('/v1/prices?product=prod_1&active=true&limit=100');
      const product = page.items[0]!;
      expect(product.name).toBe('Pro');
      expect(product.prices[0]).toMatchObject({
        id: 'price_1',
        checkoutRef: 'price_1',
        type: 'recurring',
        model: 'fixed',
        amount: 2900,
        currency: 'usd',
        interval: 'month',
      });
    });

    it('pages with starting_after cursors', async () => {
      const { provider, stub } = setup(
        routes({
          '/v1/products': { data: [{ id: 'prod_1', name: 'Pro' }], has_more: true },
          '/v1/prices': { data: [], has_more: false },
        }),
      );
      const page = await provider.listProducts({});
      expect(page.cursor).toBeDefined();
      await provider.listProducts({ cursor: page.cursor });
      const secondListRequest = stub.requests.filter((request) =>
        request.url.includes('/v1/products?'),
      )[1]!;
      expect(secondListRequest.url).toContain('starting_after=prod_1');
    });

    async function mapPrice(price: Record<string, unknown>) {
      const { provider } = setup(
        routes({
          '/v1/products/prod_1': { id: 'prod_1', name: 'Pro' },
          '/v1/prices': { data: [price], has_more: false },
        }),
      );
      const product = await provider.getProduct({ id: 'prod_1' });
      return product.prices[0]!;
    }

    it('maps metered prices without an amount', async () => {
      const price = await mapPrice({
        ...RECURRING_PRICE,
        unit_amount: 1,
        recurring: { interval: 'month', interval_count: 1, usage_type: 'metered' },
      });
      expect(price).toMatchObject({ type: 'recurring', model: 'metered', amount: null });
    });

    it('maps tiered prices without an amount', async () => {
      const price = await mapPrice({
        ...RECURRING_PRICE,
        unit_amount: null,
        billing_scheme: 'tiered',
      });
      expect(price).toMatchObject({ type: 'recurring', model: 'tiered', amount: null });
    });

    it('maps custom-amount prices without an amount', async () => {
      const price = await mapPrice({
        ...RECURRING_PRICE,
        unit_amount: null,
        type: 'one_time',
        recurring: null,
        custom_unit_amount: { maximum: 10000, minimum: 100, preset: 2000 },
      });
      expect(price).toMatchObject({ type: 'one_time', model: 'custom', amount: null });
    });

    it('prefers metered over tiered', async () => {
      const price = await mapPrice({
        ...RECURRING_PRICE,
        unit_amount: null,
        billing_scheme: 'tiered',
        recurring: { interval: 'month', interval_count: 1, usage_type: 'metered' },
      });
      expect(price.model).toBe('metered');
    });
  });

  describe('createCheckout', () => {
    it('derives subscription mode and form-encodes the session', async () => {
      const { provider, stub } = setup(
        routes({
          '/v1/prices/price_1': RECURRING_PRICE,
          '/v1/checkout/sessions': {
            id: 'cs_test_1',
            url: 'https://checkout.stripe.com/c/pay/cs_test_1',
            status: 'open',
            payment_status: 'unpaid',
            metadata: { org_id: 'org_1' },
          },
        }),
      );
      const checkout = await provider.createCheckout({
        items: [{ product: 'price_1', quantity: 2 }],
        successUrl: 'https://app.example.com/thanks?session_id={CHECKOUT_SESSION_ID}',
        customerEmail: 'user@example.com',
        metadata: { org_id: 'org_1' },
      });
      const request = stub.requests[1]!;
      expect(request.headers['content-type']).toBe('application/x-www-form-urlencoded');
      const form = new URLSearchParams(request.body);
      expect(form.get('mode')).toBe('subscription');
      expect(form.get('line_items[0][price]')).toBe('price_1');
      expect(form.get('line_items[0][quantity]')).toBe('2');
      expect(form.get('success_url')).toBe(
        'https://app.example.com/thanks?session_id={CHECKOUT_SESSION_ID}',
      );
      expect(form.get('customer_email')).toBe('user@example.com');
      expect(form.get('metadata[org_id]')).toBe('org_1');
      expect(form.get('subscription_data[metadata][org_id]')).toBe('org_1');
      // Subscription mode always invoices and rejects the parameter.
      expect(form.get('invoice_creation[enabled]')).toBeNull();
      expect(checkout).toMatchObject({ id: 'cs_test_1', status: 'open' });
    });

    it('uses payment mode for one-time prices and skips subscription_data', async () => {
      const { provider, stub } = setup(
        routes({
          '/v1/prices/price_onetime': { ...RECURRING_PRICE, id: 'price_onetime', recurring: null },
          '/v1/checkout/sessions': { id: 'cs_test_2', url: 'https://x', status: 'open' },
        }),
      );
      await provider.createCheckout({
        items: [{ product: 'price_onetime' }],
        metadata: { org_id: 'org_1' },
      });
      const form = new URLSearchParams(stub.requests[1]!.body);
      expect(form.get('mode')).toBe('payment');
      expect(form.get('subscription_data[metadata][org_id]')).toBeNull();
      // Without an invoice a one-off purchase never reaches `orders.list` or `order.paid`.
      expect(form.get('invoice_creation[enabled]')).toBe('true');
    });

    it('sends expires_at as unix seconds', async () => {
      const { provider, stub } = setup(
        routes({
          '/v1/prices/price_1': RECURRING_PRICE,
          '/v1/checkout/sessions': { id: 'cs_test_4', url: 'https://x', status: 'open' },
        }),
      );
      await provider.createCheckout({
        items: [{ product: 'price_1' }],
        expiresAt: new Date('2026-08-08T00:00:00Z'),
      });
      const form = new URLSearchParams(stub.requests[1]!.body);
      expect(form.get('expires_at')).toBe('1786147200');
    });

    it('prefers an existing customer over customer_email', async () => {
      const { provider, stub } = setup(
        routes({
          '/v1/prices/price_1': RECURRING_PRICE,
          '/v1/checkout/sessions': { id: 'cs_test_3', url: 'https://x', status: 'open' },
        }),
      );
      await provider.createCheckout({
        items: [{ product: 'price_1' }],
        customerId: 'cus_1',
        customerEmail: 'user@example.com',
      });
      const form = new URLSearchParams(stub.requests[1]!.body);
      expect(form.get('customer')).toBe('cus_1');
      expect(form.get('customer_email')).toBeNull();
    });
  });

  it('maps a complete-but-unpaid session to open', async () => {
    const { provider } = setup(
      routes({
        '/v1/checkout/sessions/cs_1': {
          id: 'cs_1',
          url: null,
          status: 'complete',
          payment_status: 'unpaid',
        },
      }),
    );
    const checkout = await provider.getCheckout({ id: 'cs_1' });
    expect(checkout.status).toBe('open');
  });

  it('maps a paid complete session to complete', async () => {
    const { provider } = setup(
      routes({
        '/v1/checkout/sessions/cs_1': {
          id: 'cs_1',
          url: null,
          status: 'complete',
          payment_status: 'paid',
          subscription: 'sub_1',
        },
      }),
    );
    const checkout = await provider.getCheckout({ id: 'cs_1' });
    expect(checkout.status).toBe('complete');
    expect(checkout.subscriptionId).toBe('sub_1');
  });

  describe('subscriptions', () => {
    it('maps item-level billing periods and price fields', async () => {
      const { provider } = setup(routes({ '/v1/subscriptions/sub_1': SUBSCRIPTION }));
      const subscription = await provider.getSubscription({ id: 'sub_1' });
      expect(subscription).toMatchObject({
        id: 'sub_1',
        status: 'active',
        cancelAtPeriodEnd: false,
        customerId: 'cus_1',
        productId: 'prod_1',
        priceId: 'price_1',
        quantity: 1,
        amount: 2900,
        currency: 'usd',
        interval: 'month',
        metadata: { org_id: 'org_1' },
      });
      expect(subscription.currentPeriodEnd).toEqual(new Date(1756684800 * 1000));
    });

    it('detects flexible-mode cancellations via cancel_at', async () => {
      const { provider } = setup(
        routes({
          '/v1/subscriptions/sub_1': {
            ...SUBSCRIPTION,
            cancel_at_period_end: false,
            cancel_at: 1756684800,
          },
        }),
      );
      const subscription = await provider.getSubscription({ id: 'sub_1' });
      expect(subscription.status).toBe('active');
      expect(subscription.cancelAtPeriodEnd).toBe(true);
      expect(subscription.endsAt).toEqual(new Date(1756684800 * 1000));
    });

    it('requests status=all when listing', async () => {
      const { provider, stub } = setup(
        routes({ '/v1/subscriptions': { data: [], has_more: false } }),
      );
      await provider.listSubscriptions({ customerId: 'cus_1' });
      expect(stub.requests[0]!.url).toContain('customer=cus_1');
      expect(stub.requests[0]!.url).toContain('status=all');
    });

    it('cancels with cancellation_details', async () => {
      const { provider, stub } = setup(
        routes({ '/v1/subscriptions/sub_1': { ...SUBSCRIPTION, cancel_at_period_end: true } }),
      );
      await provider.cancelSubscription({
        id: 'sub_1',
        reason: 'too_expensive',
        comment: 'Too pricey',
      });
      const form = new URLSearchParams(stub.requests[0]!.body);
      expect(form.get('cancel_at_period_end')).toBe('true');
      expect(form.get('cancellation_details[feedback]')).toBe('too_expensive');
      expect(form.get('cancellation_details[comment]')).toBe('Too pricey');
    });

    it('uncancels by clearing both cancel fields', async () => {
      const { provider, stub } = setup(routes({ '/v1/subscriptions/sub_1': SUBSCRIPTION }));
      await provider.uncancelSubscription({ id: 'sub_1' });
      const form = new URLSearchParams(stub.requests[0]!.body);
      expect(form.get('cancel_at_period_end')).toBe('false');
      expect(form.get('cancel_at')).toBe('');
    });

    it('changes plans by replacing the existing item', async () => {
      let patched = false;
      const { provider, stub } = setup((request) => {
        if (request.method === 'POST') {
          patched = true;
        }
        return { json: SUBSCRIPTION };
      });
      await provider.changeSubscriptionPlan({
        id: 'sub_1',
        product: 'price_2',
        quantity: 3,
        prorationBehavior: 'invoice_now',
      });
      expect(patched).toBe(true);
      const form = new URLSearchParams(stub.requests[1]!.body);
      expect(form.get('items[0][id]')).toBe('si_1');
      expect(form.get('items[0][price]')).toBe('price_2');
      expect(form.get('items[0][quantity]')).toBe('3');
      expect(form.get('proration_behavior')).toBe('always_invoice');
    });

    it('refuses a plan change when the subscription has no items', async () => {
      const { provider, stub } = setup(
        routes({
          '/v1/subscriptions/sub_1': { ...SUBSCRIPTION, items: { data: [], has_more: false } },
        }),
      );
      await expectRevenueError(
        provider.changeSubscriptionPlan({ id: 'sub_1', product: 'price_2' }),
        'provider_error',
      );
      expect(stub.requests).toHaveLength(1);
      expect(stub.requests[0]!.method).toBe('GET');
    });

    it('pauses by voiding collection without a resume date', async () => {
      const { provider, stub } = setup(
        routes({
          '/v1/subscriptions/sub_1': { ...SUBSCRIPTION, pause_collection: PAUSE_COLLECTION },
        }),
      );
      const subscription = await provider.pauseSubscription({ id: 'sub_1' });
      expect(stub.requests[0]!.method).toBe('POST');
      const form = new URLSearchParams(stub.requests[0]!.body);
      expect(form.get('pause_collection[behavior]')).toBe('void');
      expect(form.get('pause_collection[resumes_at]')).toBeNull();
      expect(subscription.status).toBe('paused');
    });

    it('sends resumes_at as unix seconds', async () => {
      const { provider, stub } = setup(
        routes({
          '/v1/subscriptions/sub_1': { ...SUBSCRIPTION, pause_collection: PAUSE_COLLECTION },
        }),
      );
      await provider.pauseSubscription({ id: 'sub_1', resumesAt: new Date(RESUMES_AT * 1000) });
      const form = new URLSearchParams(stub.requests[0]!.body);
      expect(form.get('pause_collection[behavior]')).toBe('void');
      expect(form.get('pause_collection[resumes_at]')).toBe(String(RESUMES_AT));
    });

    it('resumes a pause_collection pause by clearing the field', async () => {
      const { provider, stub } = setup(
        routes({
          '/v1/subscriptions/sub_1': (request: StubRequest) =>
            request.method === 'GET'
              ? { ...SUBSCRIPTION, pause_collection: PAUSE_COLLECTION }
              : SUBSCRIPTION,
        }),
      );
      const subscription = await provider.resumeSubscription({ id: 'sub_1' });
      expect(stub.requests).toHaveLength(2);
      expect(stub.requests[0]!.method).toBe('GET');
      expect(new URL(stub.requests[1]!.url).pathname).toBe('/v1/subscriptions/sub_1');
      expect(stub.requests[1]!.method).toBe('POST');
      expect(new URLSearchParams(stub.requests[1]!.body).get('pause_collection')).toBe('');
      expect(subscription.status).toBe('active');
    });

    it('resumes a trial-end pause via the dedicated endpoint', async () => {
      const { provider, stub } = setup(
        routes({
          '/v1/subscriptions/sub_1': { ...SUBSCRIPTION, status: 'paused' },
          '/v1/subscriptions/sub_1/resume': SUBSCRIPTION,
        }),
      );
      const subscription = await provider.resumeSubscription({ id: 'sub_1' });
      expect(stub.requests).toHaveLength(2);
      expect(stub.requests[0]!.method).toBe('GET');
      expect(new URL(stub.requests[1]!.url).pathname).toBe('/v1/subscriptions/sub_1/resume');
      expect(stub.requests[1]!.method).toBe('POST');
      expect(new URLSearchParams(stub.requests[1]!.body).get('billing_cycle_anchor')).toBe('now');
      expect(subscription.status).toBe('active');
    });

    it('maps an active subscription with pause_collection to paused', async () => {
      const { provider } = setup(
        routes({
          '/v1/subscriptions/sub_1': {
            ...SUBSCRIPTION,
            status: 'active',
            pause_collection: PAUSE_COLLECTION,
          },
        }),
      );
      const subscription = await provider.getSubscription({ id: 'sub_1' });
      expect(subscription.status).toBe('paused');
      expect(subscription.pauseAtPeriodEnd).toBe(false);
      expect(subscription.resumesAt).toEqual(new Date(RESUMES_AT * 1000));
    });

    it('keeps a canceled subscription canceled despite a leftover pause_collection', async () => {
      const { provider } = setup(
        routes({
          '/v1/subscriptions/sub_1': {
            ...SUBSCRIPTION,
            status: 'canceled',
            pause_collection: PAUSE_COLLECTION,
          },
        }),
      );
      const subscription = await provider.getSubscription({ id: 'sub_1' });
      expect(subscription.status).toBe('canceled');
      // A terminated subscription never resumes, so the leftover date must not surface either.
      expect(subscription.resumesAt).toBeUndefined();
    });

    it('revokes via DELETE', async () => {
      const { provider, stub } = setup(
        routes({
          '/v1/subscriptions/sub_1': { ...SUBSCRIPTION, status: 'canceled', ended_at: 1754438400 },
        }),
      );
      const subscription = await provider.revokeSubscription({ id: 'sub_1' });
      expect(stub.requests[0]!.method).toBe('DELETE');
      expect(subscription.status).toBe('canceled');
      expect(subscription.cancelAtPeriodEnd).toBe(false);
    });
  });

  it('creates billing portal sessions', async () => {
    const { provider, stub } = setup(
      routes({
        '/v1/billing_portal/sessions': {
          id: 'bps_1',
          url: 'https://billing.stripe.com/p/session/test_x',
        },
      }),
    );
    const session = await provider.createCustomerPortalSession({
      customerId: 'cus_1',
      returnUrl: 'https://app.example.com/billing',
    });
    const form = new URLSearchParams(stub.requests[0]!.body);
    expect(form.get('customer')).toBe('cus_1');
    expect(form.get('return_url')).toBe('https://app.example.com/billing');
    expect(session.url).toBe('https://billing.stripe.com/p/session/test_x');
  });

  describe('reportUsage', () => {
    const REPORTED_AT = 1754006400;

    const METER_EVENT = {
      object: 'billing.meter_event',
      event_name: 'ai_search_api',
      identifier: 'idmp_1',
      payload: { stripe_customer_id: 'cus_1', value: '25' },
      timestamp: REPORTED_AT,
    };

    function setupUsage() {
      return setup(routes({ '/v1/billing/meter_events': METER_EVENT }));
    }

    it('posts a minimal meter event and discards the response', async () => {
      const { provider, stub } = setupUsage();
      const result = await provider.reportUsage({
        customerId: 'cus_1',
        eventName: 'ai_search_api',
      });
      const request = stub.requests[0]!;
      expect(request.method).toBe('POST');
      expect(new URL(request.url).pathname).toBe('/v1/billing/meter_events');
      expect(request.headers['content-type']).toBe('application/x-www-form-urlencoded');
      const form = new URLSearchParams(request.body);
      expect(form.get('event_name')).toBe('ai_search_api');
      expect(form.get('payload[stripe_customer_id]')).toBe('cus_1');
      expect(form.get('payload[value]')).toBeNull();
      expect(form.get('identifier')).toBeNull();
      expect(form.get('timestamp')).toBeNull();
      expect(result).toBeUndefined();
    });

    it('sends value, metadata, identifier and a unix-second timestamp', async () => {
      const { provider, stub } = setupUsage();
      await provider.reportUsage({
        customerId: 'cus_1',
        eventName: 'ai_search_api',
        value: 25,
        metadata: { region: 'eu', premium: true },
        idempotencyKey: 'idmp_1',
        timestamp: new Date(REPORTED_AT * 1000),
      });
      const form = new URLSearchParams(stub.requests[0]!.body);
      expect(form.get('event_name')).toBe('ai_search_api');
      expect(form.get('payload[stripe_customer_id]')).toBe('cus_1');
      expect(form.get('payload[value]')).toBe('25');
      expect(form.get('payload[region]')).toBe('eu');
      expect(form.get('payload[premium]')).toBe('true');
      expect(form.get('identifier')).toBe('idmp_1');
      expect(form.get('timestamp')).toBe(String(REPORTED_AT));
    });

    it('lets an explicit value override metadata.value', async () => {
      const { provider, stub } = setupUsage();
      await provider.reportUsage({
        customerId: 'cus_1',
        eventName: 'ai_search_api',
        value: 25,
        metadata: { value: 1 },
      });
      const form = new URLSearchParams(stub.requests[0]!.body);
      expect(form.getAll('payload[value]')).toEqual(['25']);
    });
  });

  describe('orders', () => {
    it('lists invoices for a customer, drops drafts, and pages past them', async () => {
      const { provider, stub } = setup(
        routes({
          '/v1/invoices': {
            data: [
              INVOICE,
              { ...INVOICE, id: 'in_2', status: 'open', amount_paid: 0 },
              { ...INVOICE, id: 'in_3', status: 'draft', amount_paid: 0 },
            ],
            has_more: true,
          },
        }),
      );
      const page = await provider.listOrders({ limit: 25, customerId: 'cus_1' });
      expect(stub.requests[0]!.url).toBe(
        'https://api.stripe.com/v1/invoices?customer=cus_1&limit=25',
      );
      expect(page.items.map((item) => item.id)).toEqual(['in_1', 'in_2']);
      expect(page.items.map((item) => item.status)).toEqual(['paid', 'pending']);
      // The dropped draft is still the page's last row, so it has to carry the cursor.
      await provider.listOrders({ cursor: page.cursor });
      expect(stub.requests[1]!.url).toContain('starting_after=in_3');
    });

    it('maps an invoice onto the unified order', async () => {
      const { provider, stub } = setup(routes({ '/v1/invoices/in_1': INVOICE }));
      const order = await provider.getOrder({ id: 'in_1' });
      expect(stub.requests[0]!.url).toBe('https://api.stripe.com/v1/invoices/in_1');
      expect(order).toMatchObject({
        id: 'in_1',
        status: 'paid',
        amount: 2900,
        currency: 'usd',
        customerId: 'cus_1',
        customerEmail: 'user@example.com',
        subscriptionId: 'sub_1',
        createdAt: new Date(1754006400 * 1000),
        metadata: { org_id: 'org_1' },
      });
      // Stripe never reports refunds on an invoice.
      expect(order.refundStatus).toBeUndefined();
    });

    it('maps the invoice statuses and keeps the billed total on unpaid invoices', async () => {
      const { provider } = setup(
        routes({
          '/v1/invoices': {
            data: [
              { ...INVOICE, status: 'open', amount_paid: 0 },
              { ...INVOICE, status: 'uncollectible', amount_paid: 0 },
              { ...INVOICE, status: 'void', amount_paid: 0 },
              { ...INVOICE, status: 'something_new' },
            ],
            has_more: false,
          },
        }),
      );
      const page = await provider.listOrders({});
      expect(page.items.map((item) => item.status)).toEqual([
        'pending',
        'failed',
        'void',
        'pending',
      ]);
      expect(page.items.map((item) => item.amount)).toEqual([2900, 2900, 2900, 2900]);
      expect(page.cursor).toBeUndefined();
    });

    it('reports what was charged when a credit balance covered part of a paid invoice', async () => {
      const { provider } = setup(
        routes({
          '/v1/invoices/in_1': { ...INVOICE, status: 'paid', total: 2900, amount_paid: 1900 },
        }),
      );
      const order = await provider.getOrder({ id: 'in_1' });
      expect(order.amount).toBe(1900);
    });

    it('prefers the hosted invoice url and falls back to the pdf', async () => {
      const { provider, stub } = setup(routes({ '/v1/invoices/in_1': INVOICE }));
      expect(await provider.getOrderInvoiceUrl({ id: 'in_1' })).toBe(
        'https://invoice.stripe.com/i/acct_1/live_1',
      );
      expect(stub.requests[0]!.url).toBe('https://api.stripe.com/v1/invoices/in_1');

      const pdfOnly = setup(
        routes({ '/v1/invoices/in_1': { ...INVOICE, hosted_invoice_url: null } }),
      );
      expect(await pdfOnly.provider.getOrderInvoiceUrl({ id: 'in_1' })).toBe(
        'https://pay.stripe.com/invoice/acct_1/live_1/pdf',
      );
    });

    it('throws not_found while the invoice is not finalized', async () => {
      const { provider } = setup(
        routes({
          '/v1/invoices/in_1': {
            ...INVOICE,
            status: 'draft',
            hosted_invoice_url: null,
            invoice_pdf: null,
          },
        }),
      );
      await expectRevenueError(provider.getOrderInvoiceUrl({ id: 'in_1' }), 'not_found');
    });
  });

  it('maps Stripe error bodies onto RevenueError', async () => {
    const { provider } = setup(() => ({
      status: 404,
      json: {
        error: {
          type: 'invalid_request_error',
          code: 'resource_missing',
          message: 'No such subscription: sub_missing',
        },
      },
    }));
    try {
      await provider.getSubscription({ id: 'sub_missing' });
      expect.unreachable('expected RevenueError');
    } catch (error) {
      expect(error).toBeInstanceOf(RevenueError);
      expect((error as RevenueError).code).toBe('not_found');
      expect((error as RevenueError).message).toBe('No such subscription: sub_missing');
    }
  });

  it('derives retryability from Stripe-Should-Retry', async () => {
    // Stripe never sends `Retry-After` — the header is the only signal it gives, and it overrides
    // both directions of the default (a 429 is retryable, a 409 is not).
    const rateLimited = setup(() => ({
      status: 429,
      headers: { 'Stripe-Should-Retry': 'false' },
      json: { error: { message: 'Too many requests' } },
    }));
    try {
      await rateLimited.provider.getSubscription({ id: 'sub_1' });
      expect.unreachable('expected RevenueError');
    } catch (error) {
      expect((error as RevenueError).code).toBe('rate_limited');
      expect((error as RevenueError).retryAfter).toBeUndefined();
      expect((error as RevenueError).retryable).toBe(false);
    }

    const lockTimeout = setup(() => ({
      status: 409,
      headers: { 'Stripe-Should-Retry': 'true' },
      json: { error: { message: 'This object cannot be accessed right now' } },
    }));
    try {
      await lockTimeout.provider.getSubscription({ id: 'sub_1' });
      expect.unreachable('expected RevenueError');
    } catch (error) {
      expect((error as RevenueError).code).toBe('conflict');
      expect((error as RevenueError).retryable).toBe(true);
    }
  });

  it('rejects empty checkout items', async () => {
    const { provider } = setup(() => ({ json: {} }));
    await expectRevenueError(provider.createCheckout({ items: [] }), 'validation');
  });
});
