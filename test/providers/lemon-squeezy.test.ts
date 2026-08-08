import { describe, expect, it } from 'vitest';
import { RevenueError } from '../../src/errors.ts';
import { decodeCursor, encodeCursor } from '../../src/pagination.ts';
import { lemonSqueezy } from '../../src/providers/lemon-squeezy/index.ts';
import { createFetchStub, type StubHandler, type StubResponse } from '../helpers/fetch-stub.ts';

const API_KEY = 'ls_test_api_key';

function setup(handler: StubHandler) {
  const stub = createFetchStub(handler);
  const provider = lemonSqueezy({ apiKey: API_KEY, storeId: 76833, fetch: stub.fetch });
  return { provider, stub };
}

const STORE_RESPONSE = { data: { type: 'stores', id: '76833', attributes: { currency: 'USD' } } };

const VARIANT = {
  type: 'variants',
  id: '1615641',
  attributes: { product_id: 1030025, name: 'Pro (Monthly)', description: '<p>Pro plan</p>' },
};

const PRICE_MODEL = {
  data: {
    type: 'prices',
    id: '99',
    attributes: {
      variant_id: 1615641,
      category: 'subscription',
      scheme: 'standard',
      usage_aggregation: null,
      unit_price: 2900,
      renewal_interval_unit: 'month',
      renewal_interval_quantity: 1,
      trial_interval_unit: 'days',
      trial_interval_quantity: 14,
    },
  },
};

const SUBSCRIPTION = {
  type: 'subscriptions',
  id: '42',
  attributes: {
    customer_id: 7,
    product_id: 1030025,
    variant_id: 1615641,
    status: 'active',
    cancelled: false,
    trial_ends_at: null,
    renews_at: '2026-09-01T00:00:00.000000Z',
    ends_at: null,
    created_at: '2026-08-01T00:00:00.000000Z',
    user_email: 'user@example.com',
    payment_processor: 'stripe',
    first_subscription_item: { id: 5, price_id: 99, quantity: 1 },
    urls: { customer_portal: 'https://store.lemonsqueezy.com/billing?signed' },
  },
};

const PAYPAL_SUBSCRIPTION = {
  ...SUBSCRIPTION,
  attributes: { ...SUBSCRIPTION.attributes, payment_processor: 'paypal' },
};

const TRIALING_SUBSCRIPTION = {
  ...SUBSCRIPTION,
  attributes: {
    ...SUBSCRIPTION.attributes,
    status: 'on_trial',
    trial_ends_at: '2026-08-15T00:00:00.000000Z',
  },
};

const PAUSED_SUBSCRIPTION = {
  ...SUBSCRIPTION,
  attributes: {
    ...SUBSCRIPTION.attributes,
    status: 'paused',
    pause: { mode: 'void', resumes_at: '2026-10-01T00:00:00.000000Z' },
  },
};

function routes(handlers: Record<string, unknown>): StubHandler {
  return (request) => {
    const path = new URL(request.url).pathname;
    for (const [route, json] of Object.entries(handlers)) {
      if (path === route) {
        return { json };
      }
    }
    throw new Error(`Unhandled route: ${request.method} ${path}`);
  };
}

async function expectRevenueError(promise: Promise<unknown>, code: string): Promise<void> {
  try {
    await promise;
    expect.unreachable('expected RevenueError');
  } catch (error) {
    expect(error).toBeInstanceOf(RevenueError);
    expect((error as RevenueError).code).toBe(code);
  }
}

describe('lemonSqueezy', () => {
  it('exposes name and capabilities', () => {
    const { provider } = setup(() => ({ json: {} }));
    expect(provider.name).toBe('lemon-squeezy');
    expect(provider.capabilities.checkoutStatus).toBe(false);
    expect(provider.capabilities.checkoutExpiresAt).toBe(true);
    expect(provider.capabilities.revoke).toBe(false);
    expect(provider.capabilities.listSubscriptionsByCustomer).toBe(false);
    expect(provider.capabilities.listOrdersByCustomer).toBe(false);
    expect(provider.capabilities.pause).toBe(true);
    expect(provider.capabilities.pauseBehaviors).toEqual(['immediately']);
    expect(provider.capabilities.usageReporting).toBe(false);
    expect(provider.capabilities.licenseKeys).toBe(true);
  });

  describe('listProducts', () => {
    it('lists variants, resolves price-models, and uses the store currency', async () => {
      const { provider, stub } = setup(
        routes({
          '/v1/variants': { data: [VARIANT], meta: { page: { currentPage: 1, lastPage: 1 } } },
          '/v1/variants/1615641/price-model': PRICE_MODEL,
          '/v1/stores/76833': STORE_RESPONSE,
        }),
      );
      const page = await provider.listProducts({});
      const listRequest = stub.requests[0]!;
      expect(listRequest.url).toContain('/v1/variants?');
      expect(listRequest.url).toContain('page%5Bnumber%5D=1');
      // Draft and pending variants cannot be bought.
      expect(listRequest.url).toContain('filter%5Bstatus%5D=published');
      expect(listRequest.headers['accept']).toBe('application/vnd.api+json');
      expect(listRequest.headers['content-type']).toBe('application/vnd.api+json');
      expect(listRequest.headers['authorization']).toBe(`Bearer ${API_KEY}`);
      expect(page.cursor).toBeUndefined();
      const product = page.items[0]!;
      expect(product).toMatchObject({ id: '1615641', name: 'Pro (Monthly)' });
      expect(product.prices[0]).toMatchObject({
        id: '99',
        checkoutRef: '1615641',
        type: 'recurring',
        model: 'fixed',
        amount: 2900,
        currency: 'usd',
        interval: 'month',
        trialDays: 14,
      });
    });

    it('caches the store currency across pages', async () => {
      const { provider, stub } = setup(
        routes({
          '/v1/variants': { data: [VARIANT], meta: { page: { currentPage: 1, lastPage: 1 } } },
          '/v1/variants/1615641/price-model': PRICE_MODEL,
          '/v1/stores/76833': STORE_RESPONSE,
        }),
      );
      await provider.listProducts({});
      await provider.listProducts({});
      const storeRequests = stub.requests.filter((request) => request.url.includes('/v1/stores/'));
      expect(storeRequests).toHaveLength(1);
    });
  });

  describe('price models', () => {
    async function getPrice(attributes: Record<string, unknown>) {
      const { provider } = setup(
        routes({
          '/v1/variants/1615641': { data: VARIANT },
          '/v1/variants/1615641/price-model': {
            data: {
              ...PRICE_MODEL.data,
              attributes: { ...PRICE_MODEL.data.attributes, ...attributes },
            },
          },
          '/v1/stores/76833': STORE_RESPONSE,
        }),
      );
      const product = await provider.getProduct({ id: '1615641' });
      return product.prices[0]!;
    }

    it('maps a usage-aggregated price to metered without an amount', async () => {
      expect(await getPrice({ usage_aggregation: 'sum' })).toMatchObject({
        model: 'metered',
        amount: null,
      });
    });

    it.each(['graduated', 'volume', 'package'])(
      'maps the %s scheme to tiered without an amount',
      async (scheme) => {
        expect(await getPrice({ scheme })).toMatchObject({ model: 'tiered', amount: null });
      },
    );

    it('maps a pay-what-you-want price to custom without an amount', async () => {
      expect(await getPrice({ category: 'pwyw' })).toMatchObject({
        model: 'custom',
        amount: null,
      });
    });

    it('prefers metered over tiered when a metered price also has a tiered scheme', async () => {
      expect(await getPrice({ usage_aggregation: 'sum', scheme: 'graduated' })).toMatchObject({
        model: 'metered',
        amount: null,
      });
    });
  });

  describe('createCheckout', () => {
    it('posts a JSON:API checkout with store and variant relationships', async () => {
      const { provider, stub } = setup(() => ({
        json: {
          data: {
            type: 'checkouts',
            id: '5e8b546c-c561-4a2c-a586-40c18bb2a195',
            attributes: {
              url: 'https://store.lemonsqueezy.com/checkout/custom/uuid?signature=sig',
              expires_at: null,
              checkout_data: { email: 'user@example.com', custom: { organization_id: 'org_1' } },
            },
          },
        },
      }));
      const checkout = await provider.createCheckout({
        items: [{ product: '1615641' }],
        successUrl: 'https://app.example.com/thanks',
        customerEmail: 'user@example.com',
        metadata: { organization_id: 'org_1' },
      });
      const request = stub.requests[0]!;
      expect(request.method).toBe('POST');
      expect(request.url).toBe('https://api.lemonsqueezy.com/v1/checkouts');
      expect(JSON.parse(request.body!)).toEqual({
        data: {
          type: 'checkouts',
          attributes: {
            checkout_data: {
              email: 'user@example.com',
              custom: { organization_id: 'org_1' },
            },
            product_options: {
              enabled_variants: [1615641],
              redirect_url: 'https://app.example.com/thanks',
            },
          },
          relationships: {
            store: { data: { type: 'stores', id: '76833' } },
            variant: { data: { type: 'variants', id: '1615641' } },
          },
        },
      });
      expect(checkout).toMatchObject({
        id: '5e8b546c-c561-4a2c-a586-40c18bb2a195',
        url: 'https://store.lemonsqueezy.com/checkout/custom/uuid?signature=sig',
        status: null,
        customerEmail: 'user@example.com',
        metadata: { organization_id: 'org_1' },
      });
    });

    it('passes quantities via variant_quantities', async () => {
      const { provider, stub } = setup(() => ({
        json: { data: { type: 'checkouts', id: 'c1', attributes: { url: 'https://x' } } },
      }));
      await provider.createCheckout({ items: [{ product: '1615641', quantity: 3 }] });
      const body = JSON.parse(stub.requests[0]!.body!);
      expect(body.data.attributes.checkout_data.variant_quantities).toEqual([
        { variant_id: 1615641, quantity: 3 },
      ]);
    });

    it('sends expires_at as an ISO string beside checkout_data', async () => {
      const { provider, stub } = setup(() => ({
        json: {
          data: {
            type: 'checkouts',
            id: 'c1',
            attributes: { url: 'https://x', expires_at: '2026-08-08T00:00:00.000000Z' },
          },
        },
      }));
      const checkout = await provider.createCheckout({
        items: [{ product: '1615641' }],
        expiresAt: new Date('2026-08-08T00:00:00Z'),
      });
      const attributes = JSON.parse(stub.requests[0]!.body!).data.attributes;
      expect(attributes.expires_at).toBe('2026-08-08T00:00:00.000Z');
      // A sibling of checkout_data/product_options, never nested inside them.
      expect(attributes.product_options.expires_at).toBeUndefined();
      expect(checkout.expiresAt).toEqual(new Date('2026-08-08T00:00:00.000000Z'));
    });

    it('omits expires_at when no expiry is given', async () => {
      const { provider, stub } = setup(() => ({
        json: { data: { type: 'checkouts', id: 'c1', attributes: { url: 'https://x' } } },
      }));
      await provider.createCheckout({ items: [{ product: '1615641' }] });
      const attributes = JSON.parse(stub.requests[0]!.body!).data.attributes;
      expect('expires_at' in attributes).toBe(false);
    });

    it('rejects multi-item checkouts and existing-customer attachment', async () => {
      const { provider } = setup(() => ({ json: {} }));
      await expectRevenueError(
        provider.createCheckout({ items: [{ product: '1' }, { product: '2' }] }),
        'unsupported',
      );
      await expectRevenueError(
        provider.createCheckout({ items: [{ product: '1' }], customerId: '7' }),
        'unsupported',
      );
    });

    it('normalizes empty-array artifacts in checkout_data', async () => {
      const { provider } = setup(() => ({
        json: {
          data: {
            type: 'checkouts',
            id: 'c1',
            // Lemon Squeezy serializes empty objects as arrays.
            attributes: { url: 'https://x', checkout_data: { custom: [], billing_address: [] } },
          },
        },
      }));
      const checkout = await provider.getCheckout({ id: 'c1' });
      expect(checkout.metadata).toBeUndefined();
      expect(checkout.customerEmail).toBeUndefined();
    });
  });

  describe('subscriptions', () => {
    it('maps an active subscription with numeric IDs coerced to strings', async () => {
      const { provider } = setup(() => ({ json: { data: SUBSCRIPTION } }));
      const subscription = await provider.getSubscription({ id: '42' });
      expect(subscription).toMatchObject({
        id: '42',
        status: 'active',
        cancelAtPeriodEnd: false,
        customerId: '7',
        productId: '1615641',
        priceId: '99',
        quantity: 1,
      });
      expect(subscription.currentPeriodEnd).toEqual(new Date('2026-09-01T00:00:00.000000Z'));
    });

    it('maps the cancelled status to active + cancelAtPeriodEnd', async () => {
      const { provider } = setup(() => ({
        json: {
          data: {
            ...SUBSCRIPTION,
            attributes: {
              ...SUBSCRIPTION.attributes,
              status: 'cancelled',
              cancelled: true,
              ends_at: '2026-09-01T00:00:00.000000Z',
            },
          },
        },
      }));
      const subscription = await provider.getSubscription({ id: '42' });
      expect(subscription.status).toBe('active');
      expect(subscription.cancelAtPeriodEnd).toBe(true);
      expect(subscription.endsAt).toEqual(new Date('2026-09-01T00:00:00.000000Z'));
    });

    it('maps expired to the terminal canceled status', async () => {
      const { provider } = setup(() => ({
        json: {
          data: {
            ...SUBSCRIPTION,
            attributes: {
              ...SUBSCRIPTION.attributes,
              status: 'expired',
              cancelled: true,
              ends_at: '2026-08-01T00:00:00.000000Z',
            },
          },
        },
      }));
      const subscription = await provider.getSubscription({ id: '42' });
      expect(subscription.status).toBe('canceled');
      expect(subscription.cancelAtPeriodEnd).toBe(false);
      expect(subscription.endedAt).toEqual(new Date('2026-08-01T00:00:00.000000Z'));
    });

    it('cancels via DELETE and rejects unsupported cancellation reasons', async () => {
      const { provider, stub } = setup(() => ({
        json: {
          data: {
            ...SUBSCRIPTION,
            attributes: { ...SUBSCRIPTION.attributes, status: 'cancelled', cancelled: true },
          },
        },
      }));
      const subscription = await provider.cancelSubscription({ id: '42' });
      expect(stub.requests[0]!.method).toBe('DELETE');
      expect(stub.requests[0]!.url).toBe('https://api.lemonsqueezy.com/v1/subscriptions/42');
      expect(subscription.cancelAtPeriodEnd).toBe(true);
      await expectRevenueError(
        provider.cancelSubscription({ id: '42', reason: 'too_expensive' }),
        'unsupported',
      );
    });

    it('uncancels via PATCH cancelled:false', async () => {
      const { provider, stub } = setup(() => ({ json: { data: SUBSCRIPTION } }));
      await provider.uncancelSubscription({ id: '42' });
      const request = stub.requests[0]!;
      expect(request.method).toBe('PATCH');
      expect(JSON.parse(request.body!)).toEqual({
        data: { type: 'subscriptions', id: '42', attributes: { cancelled: false } },
      });
    });

    it('changes plans by resolving the variant product and mapping proration', async () => {
      const { provider, stub } = setup(
        routes({
          '/v1/variants/1615642': {
            data: {
              type: 'variants',
              id: '1615642',
              attributes: { product_id: 1030025, name: 'Pro (Yearly)' },
            },
          },
          '/v1/subscriptions/42': { data: SUBSCRIPTION },
        }),
      );
      await provider.changeSubscriptionPlan({
        id: '42',
        product: '1615642',
        prorationBehavior: 'invoice_now',
      });
      const patch = stub.requests[1]!;
      expect(patch.method).toBe('PATCH');
      expect(JSON.parse(patch.body!)).toEqual({
        data: {
          type: 'subscriptions',
          id: '42',
          attributes: { product_id: 1030025, variant_id: 1615642, invoice_immediately: true },
        },
      });
    });

    it('ends a trial by resetting the billing anchor, the only documented lever', async () => {
      const { provider, stub } = setup(() => ({ json: { data: TRIALING_SUBSCRIPTION } }));
      await provider.endSubscriptionTrial({ id: '42' });
      const preflight = stub.requests[0]!;
      expect(preflight.method).toBe('GET');
      expect(preflight.url).toBe('https://api.lemonsqueezy.com/v1/subscriptions/42');
      const patch = stub.requests[1]!;
      expect(patch.method).toBe('PATCH');
      const attributes = JSON.parse(patch.body!).data.attributes;
      // `null` must reach the API — a dropped key would leave the trial running.
      expect('billing_anchor' in attributes).toBe(true);
      expect(attributes.billing_anchor).toBeNull();
      // Lemon Squeezy describes `trial_ends_at` as adjusting a trial's duration and documents
      // nothing for past or present values, so it is deliberately not sent.
      expect('trial_ends_at' in attributes).toBe(false);
    });

    it('refuses to end a trial on a subscription that is not trialing', async () => {
      const { provider, stub } = setup(() => ({ json: { data: SUBSCRIPTION } }));
      // The anchor reset is unconditional upstream, so the PATCH would move the billing day.
      await expectRevenueError(provider.endSubscriptionTrial({ id: '42' }), 'validation');
      expect(stub.requests).toHaveLength(1);
      expect(stub.requests[0]!.method).toBe('GET');
    });

    it('pauses immediately in void mode without a resume date', async () => {
      const { provider, stub } = setup(() => ({ json: { data: PAUSED_SUBSCRIPTION } }));
      const subscription = await provider.pauseSubscription({ id: '42' });
      const request = stub.requests[0]!;
      expect(request.method).toBe('PATCH');
      expect(request.url).toBe('https://api.lemonsqueezy.com/v1/subscriptions/42');
      expect(request.headers['content-type']).toBe('application/vnd.api+json');
      expect(JSON.parse(request.body!)).toEqual({
        data: {
          type: 'subscriptions',
          id: '42',
          attributes: { pause: { mode: 'void' } },
        },
      });
      expect(subscription.status).toBe('paused');
    });

    it('sends resumes_at as an ISO string when a resume date is given', async () => {
      const { provider, stub } = setup(() => ({ json: { data: PAUSED_SUBSCRIPTION } }));
      await provider.pauseSubscription({ id: '42', resumesAt: new Date('2026-10-01T00:00:00Z') });
      expect(JSON.parse(stub.requests[0]!.body!)).toEqual({
        data: {
          type: 'subscriptions',
          id: '42',
          attributes: { pause: { mode: 'void', resumes_at: '2026-10-01T00:00:00.000Z' } },
        },
      });
    });

    it('resumes by sending a literal null pause', async () => {
      const { provider, stub } = setup(() => ({ json: { data: SUBSCRIPTION } }));
      const subscription = await provider.resumeSubscription({ id: '42' });
      const request = stub.requests[0]!;
      expect(request.method).toBe('PATCH');
      expect(request.headers['content-type']).toBe('application/vnd.api+json');
      const attributes = JSON.parse(request.body!).data.attributes;
      // `null` must reach the API — a dropped key would leave the subscription paused.
      expect('pause' in attributes).toBe(true);
      expect(attributes.pause).toBeNull();
      expect(subscription.status).toBe('active');
    });

    it('maps a paused subscription with its resume date', async () => {
      const { provider } = setup(() => ({ json: { data: PAUSED_SUBSCRIPTION } }));
      const subscription = await provider.getSubscription({ id: '42' });
      expect(subscription.status).toBe('paused');
      expect(subscription.pauseAtPeriodEnd).toBe(false);
      expect(subscription.resumesAt).toEqual(new Date('2026-10-01T00:00:00.000000Z'));
    });

    it('throws on every PATCH-backed update of a PayPal subscription', async () => {
      const { provider } = setup(
        routes({
          '/v1/variants/1615642': {
            data: {
              type: 'variants',
              id: '1615642',
              attributes: { product_id: 1030025, name: 'Pro (Yearly)' },
            },
          },
          '/v1/subscriptions/42': { data: PAYPAL_SUBSCRIPTION },
        }),
      );
      // Lemon Squeezy answers 200 with the subscription unchanged instead of applying the PATCH.
      await expectRevenueError(
        provider.changeSubscriptionPlan({ id: '42', product: '1615642' }),
        'unsupported',
      );
      await expectRevenueError(provider.uncancelSubscription({ id: '42' }), 'unsupported');
      await expectRevenueError(provider.pauseSubscription({ id: '42' }), 'unsupported');
      await expectRevenueError(provider.resumeSubscription({ id: '42' }), 'unsupported');
      await expect(provider.pauseSubscription({ id: '42' })).rejects.toThrow(/PayPal/);
      // endTrial reads the subscription first, so its fixture has to be trialing to get that far.
      const { provider: trialing } = setup(() => ({
        json: {
          data: {
            ...PAYPAL_SUBSCRIPTION,
            attributes: { ...TRIALING_SUBSCRIPTION.attributes, payment_processor: 'paypal' },
          },
        },
      }));
      await expectRevenueError(trialing.endSubscriptionTrial({ id: '42' }), 'unsupported');
    });

    it('still cancels a PayPal subscription via DELETE', async () => {
      const { provider, stub } = setup(() => ({
        json: {
          data: {
            ...PAYPAL_SUBSCRIPTION,
            attributes: {
              ...PAYPAL_SUBSCRIPTION.attributes,
              status: 'cancelled',
              cancelled: true,
            },
          },
        },
      }));
      const subscription = await provider.cancelSubscription({ id: '42' });
      expect(stub.requests[0]!.method).toBe('DELETE');
      expect(subscription.cancelAtPeriodEnd).toBe(true);
    });

    it('rejects revoke and customer-filtered listing', async () => {
      const { provider } = setup(() => ({ json: {} }));
      await expectRevenueError(provider.revokeSubscription({ id: '42' }), 'unsupported');
      await expectRevenueError(provider.listSubscriptions({ customerId: '7' }), 'unsupported');
    });
  });

  describe('customer portal', () => {
    it('returns the fresh signed portal URL from the customer', async () => {
      const { provider, stub } = setup(() => ({
        json: {
          data: {
            type: 'customers',
            id: '7',
            attributes: {
              email: 'user@example.com',
              urls: { customer_portal: 'https://store.lemonsqueezy.com/billing?expires=1&sig=2' },
            },
          },
        },
      }));
      const session = await provider.createCustomerPortalSession({ customerId: '7' });
      expect(stub.requests[0]!.url).toBe('https://api.lemonsqueezy.com/v1/customers/7');
      expect(session.url).toBe('https://store.lemonsqueezy.com/billing?expires=1&sig=2');
    });

    it('throws not_found when the customer has no portal', async () => {
      const { provider } = setup(() => ({
        json: {
          data: {
            type: 'customers',
            id: '7',
            attributes: { email: 'user@example.com', urls: { customer_portal: null } },
          },
        },
      }));
      await expectRevenueError(
        provider.createCustomerPortalSession({ customerId: '7' }),
        'not_found',
      );
    });

    it('rejects returnUrl', async () => {
      const { provider } = setup(() => ({ json: {} }));
      await expectRevenueError(
        provider.createCustomerPortalSession({ customerId: '7', returnUrl: 'https://x' }),
        'unsupported',
      );
    });
  });

  describe('orders', () => {
    const ORDER = {
      type: 'orders',
      id: '11',
      attributes: {
        store_id: 76833,
        customer_id: 7,
        identifier: '5e8b546c-c561-4a2c-a586-40c18bb2a195',
        order_number: 1,
        user_name: 'User',
        user_email: 'user@example.com',
        currency: 'USD',
        subtotal: 2900,
        discount_total: 0,
        tax: 0,
        total: 2900,
        refunded: false,
        refunded_amount: 0,
        refunded_at: null,
        status: 'paid',
        created_at: '2026-08-01T00:00:00.000000Z',
        updated_at: '2026-08-01T00:00:00.000000Z',
        urls: { receipt: 'https://app.lemonsqueezy.com/my-orders/5e8b546c?signature=sig' },
        test_mode: false,
      },
    };

    const INVOICE = {
      type: 'subscription-invoices',
      id: '77',
      attributes: {
        store_id: 76833,
        subscription_id: 42,
        customer_id: 7,
        user_email: 'user@example.com',
        billing_reason: 'renewal',
        status: 'paid',
        refunded: false,
        refunded_amount: 0,
        subtotal: 2900,
        discount_total: 0,
        tax: 0,
        total: 2900,
        currency: 'USD',
        created_at: '2026-09-01T00:00:00.000000Z',
        updated_at: '2026-09-01T00:00:00.000000Z',
        urls: { invoice_url: 'https://app.lemonsqueezy.com/invoices/77.pdf?signature=sig' },
        test_mode: false,
      },
    };

    // The first payment of a subscription is billed as an order AND as an initial invoice.
    const INITIAL_INVOICE = {
      ...INVOICE,
      id: '76',
      attributes: { ...INVOICE.attributes, billing_reason: 'initial' },
    };

    const NOT_FOUND: StubResponse = {
      status: 404,
      json: { errors: [{ detail: 'No query results.', status: '404' }] },
    };

    function stubRoutes(handlers: Record<string, StubResponse>): StubHandler {
      return (request) => {
        const path = new URL(request.url).pathname;
        const response = handlers[path];
        if (response === undefined) {
          throw new Error(`Unhandled route: ${request.method} ${path}`);
        }
        return response;
      };
    }

    function cursorState(cursor: string | undefined) {
      return decodeCursor<{ source: string; page: number }>('lemon-squeezy', cursor!);
    }

    function getOrderWith(attributes: Record<string, unknown>) {
      const { provider } = setup(() => ({
        json: { data: { ...ORDER, attributes: { ...ORDER.attributes, ...attributes } } },
      }));
      return provider.getOrder({ id: '11' });
    }

    it('lists the store orders and maps them', async () => {
      const { provider, stub } = setup(
        stubRoutes({
          '/v1/orders': {
            json: { data: [ORDER], meta: { page: { currentPage: 1, lastPage: 1 } } },
          },
        }),
      );
      const page = await provider.listOrders({});
      const request = stub.requests[0]!;
      expect(request.method).toBe('GET');
      expect(request.url).toContain('/v1/orders?');
      expect(request.url).toContain('page%5Bnumber%5D=1');
      expect(request.url).toContain('page%5Bsize%5D=10');
      expect(request.url).toContain('filter%5Bstore_id%5D=76833');
      expect(request.headers['accept']).toBe('application/vnd.api+json');
      expect(page.items).toHaveLength(1);
      expect(page.items[0]).toMatchObject({
        id: '11',
        status: 'paid',
        amount: 2900,
        currency: 'usd',
        customerId: '7',
        customerEmail: 'user@example.com',
      });
      expect(page.items[0]!.createdAt).toEqual(new Date('2026-08-01T00:00:00.000000Z'));
      expect(page.items[0]!.refundStatus).toBeUndefined();
      expect(page.items[0]!.subscriptionId).toBeUndefined();
    });

    it('keeps paginating orders while order pages remain', async () => {
      const { provider, stub } = setup(
        stubRoutes({
          '/v1/orders': {
            json: { data: [ORDER], meta: { page: { currentPage: 1, lastPage: 3 } } },
          },
        }),
      );
      const page = await provider.listOrders({ limit: 2 });
      expect(cursorState(page.cursor)).toEqual({ source: 'orders', page: 2 });
      await provider.listOrders({ cursor: page.cursor, limit: 2 });
      expect(stub.requests[1]!.url).toContain('/v1/orders?');
      expect(stub.requests[1]!.url).toContain('page%5Bnumber%5D=2');
      expect(stub.requests[1]!.url).toContain('page%5Bsize%5D=2');
    });

    it('hands back an invoices cursor on the last page of orders', async () => {
      const { provider } = setup(
        stubRoutes({
          '/v1/orders': {
            json: { data: [ORDER], meta: { page: { currentPage: 2, lastPage: 2 } } },
          },
        }),
      );
      const page = await provider.listOrders({
        cursor: encodeCursor('lemon-squeezy', { source: 'orders', page: 2 }),
      });
      expect(cursorState(page.cursor)).toEqual({ source: 'invoices', page: 1 });
    });

    it('drains the subscription invoices and drops the initial ones', async () => {
      const { provider, stub } = setup(
        stubRoutes({
          '/v1/subscription-invoices': {
            json: {
              data: [INVOICE, INITIAL_INVOICE],
              meta: { page: { currentPage: 1, lastPage: 1 } },
            },
          },
        }),
      );
      const page = await provider.listOrders({
        cursor: encodeCursor('lemon-squeezy', { source: 'invoices', page: 1 }),
      });
      const request = stub.requests[0]!;
      expect(request.url).toContain('/v1/subscription-invoices?');
      expect(request.url).toContain('page%5Bnumber%5D=1');
      expect(request.url).toContain('filter%5Bstore_id%5D=76833');
      // The initial invoice bills the same money as an order, so it would double-count.
      expect(page.items.map((order) => order.id)).toEqual(['77']);
      expect(page.items[0]).toMatchObject({ id: '77', status: 'paid', subscriptionId: '42' });
      expect(page.items[0]!.createdAt).toEqual(new Date('2026-09-01T00:00:00.000000Z'));
      expect(page.cursor).toBeUndefined();
    });

    it('returns a short page rather than backfilling filtered invoices', async () => {
      const { provider } = setup(
        stubRoutes({
          '/v1/subscription-invoices': {
            json: { data: [INITIAL_INVOICE], meta: { page: { currentPage: 1, lastPage: 2 } } },
          },
        }),
      );
      const page = await provider.listOrders({
        cursor: encodeCursor('lemon-squeezy', { source: 'invoices', page: 1 }),
      });
      expect(page.items).toEqual([]);
      expect(cursorState(page.cursor)).toEqual({ source: 'invoices', page: 2 });
    });

    it('rejects customer-filtered listing', async () => {
      const { provider } = setup(() => ({ json: {} }));
      await expectRevenueError(provider.listOrders({ customerId: '7' }), 'unsupported');
    });

    it.each([
      ['paid', 'paid'],
      ['pending', 'pending'],
      ['failed', 'failed'],
      ['fraudulent', 'failed'],
      ['refunded', 'refunded'],
      ['partial_refund', 'partially_refunded'],
      ['void', 'void'],
      ['something_new', 'pending'],
    ])('maps the %s status to %s', async (status, expected) => {
      expect((await getOrderWith({ status })).status).toBe(expected);
    });

    it('reports a full refund', async () => {
      const order = await getOrderWith({
        status: 'refunded',
        refunded: true,
        refunded_amount: 2900,
      });
      expect(order.status).toBe('refunded');
      expect(order.refundStatus).toBe('full');
    });

    it('reports a partial refund even though the refunded flag is false', async () => {
      const order = await getOrderWith({
        status: 'partial_refund',
        refunded: false,
        refunded_amount: 500,
      });
      expect(order.status).toBe('partially_refunded');
      expect(order.refundStatus).toBe('partial');
    });

    it('leaves the refund status unset when nothing was refunded', async () => {
      expect((await getOrderWith({ refunded_amount: 0 })).refundStatus).toBeUndefined();
    });

    it('gets an order without touching the invoice endpoint', async () => {
      const { provider, stub } = setup(stubRoutes({ '/v1/orders/11': { json: { data: ORDER } } }));
      const order = await provider.getOrder({ id: '11' });
      expect(stub.requests).toHaveLength(1);
      expect(stub.requests[0]!.url).toBe('https://api.lemonsqueezy.com/v1/orders/11');
      expect(order).toMatchObject({ id: '11', status: 'paid', amount: 2900 });
    });

    it('falls back to the subscription invoice when the order ID misses', async () => {
      const { provider, stub } = setup(
        stubRoutes({
          '/v1/orders/77': NOT_FOUND,
          '/v1/subscription-invoices/77': { json: { data: INVOICE } },
        }),
      );
      const order = await provider.getOrder({ id: '77' });
      expect(stub.requests.map((request) => new URL(request.url).pathname)).toEqual([
        '/v1/orders/77',
        '/v1/subscription-invoices/77',
      ]);
      expect(order).toMatchObject({ id: '77', status: 'paid', subscriptionId: '42' });
    });

    it('throws not_found when neither ID space has the order', async () => {
      const { provider, stub } = setup(
        stubRoutes({ '/v1/orders/99': NOT_FOUND, '/v1/subscription-invoices/99': NOT_FOUND }),
      );
      await expectRevenueError(provider.getOrder({ id: '99' }), 'not_found');
      expect(stub.requests).toHaveLength(2);
    });

    it('does not fall back on errors other than not_found', async () => {
      const { provider, stub } = setup(
        stubRoutes({
          '/v1/orders/11': { status: 401, json: { errors: [{ detail: 'Unauthenticated.' }] } },
        }),
      );
      await expectRevenueError(provider.getOrder({ id: '11' }), 'unauthorized');
      expect(stub.requests).toHaveLength(1);
    });

    it('returns the receipt URL of an order', async () => {
      const { provider } = setup(stubRoutes({ '/v1/orders/11': { json: { data: ORDER } } }));
      await expect(provider.getOrderInvoiceUrl({ id: '11' })).resolves.toBe(
        'https://app.lemonsqueezy.com/my-orders/5e8b546c?signature=sig',
      );
    });

    it('returns the signed PDF URL of a subscription invoice', async () => {
      const { provider } = setup(
        stubRoutes({
          '/v1/orders/77': NOT_FOUND,
          '/v1/subscription-invoices/77': { json: { data: INVOICE } },
        }),
      );
      await expect(provider.getOrderInvoiceUrl({ id: '77' })).resolves.toBe(
        'https://app.lemonsqueezy.com/invoices/77.pdf?signature=sig',
      );
    });

    it('throws not_found while a pending invoice has no PDF yet', async () => {
      const { provider } = setup(
        stubRoutes({
          '/v1/orders/77': NOT_FOUND,
          '/v1/subscription-invoices/77': {
            json: {
              data: {
                ...INVOICE,
                attributes: {
                  ...INVOICE.attributes,
                  status: 'pending',
                  urls: { invoice_url: null },
                },
              },
            },
          },
        }),
      );
      await expectRevenueError(provider.getOrderInvoiceUrl({ id: '77' }), 'not_found');
    });
  });

  describe('license keys', () => {
    const LICENSE_KEY = {
      type: 'license-keys',
      id: '1',
      attributes: {
        store_id: 76833,
        customer_id: 7,
        order_id: 11,
        product_id: 1030025,
        user_email: 'user@example.com',
        key: '38b1460a-5104-4067-a91d-77b872934d51',
        key_short: '38B1-...-4D51',
        activation_limit: 5,
        instances_count: 1,
        disabled: 0,
        status: 'active',
        expires_at: null,
        created_at: '2026-08-01T00:00:00.000000Z',
      },
    };

    it('lists the store license keys and maps them', async () => {
      const { provider, stub } = setup(() => ({
        json: { data: [LICENSE_KEY], meta: { page: { currentPage: 1, lastPage: 2 } } },
      }));
      const page = await provider.listLicenseKeys({ limit: 2 });
      const request = stub.requests[0]!;
      expect(request.url).toContain('/v1/license-keys?');
      expect(request.url).toContain('page%5Bsize%5D=2');
      expect(request.url).toContain('filter%5Bstore_id%5D=76833');
      expect(page.cursor).toBeDefined();
      expect(page.items[0]).toMatchObject({
        id: '1',
        key: '38b1460a-5104-4067-a91d-77b872934d51',
        status: 'active',
        activationLimit: 5,
        activationCount: 1,
        customerId: '7',
      });
      // The license key references the Lemon Squeezy product, not the variant a unified
      // `Product` maps to, so no product ID is reported.
      expect(page.items[0]!.productId).toBeUndefined();
      expect(page.items[0]!.expiresAt).toBeUndefined();
    });

    it('gets a license key and maps an unlimited activation limit and an expiry', async () => {
      const { provider, stub } = setup(() => ({
        json: {
          data: {
            ...LICENSE_KEY,
            attributes: {
              ...LICENSE_KEY.attributes,
              activation_limit: null,
              expires_at: '2027-01-01T00:00:00.000000Z',
            },
          },
        },
      }));
      const licenseKey = await provider.getLicenseKey({ id: '1' });
      expect(stub.requests[0]!.url).toBe('https://api.lemonsqueezy.com/v1/license-keys/1');
      expect(licenseKey.activationLimit).toBeUndefined();
      expect(licenseKey.expiresAt).toEqual(new Date('2027-01-01T00:00:00.000000Z'));
    });

    it.each([
      ['a numeric flag', 1],
      ['a boolean flag', true],
    ])('maps %s to the disabled status', async (_name, disabled) => {
      const { provider } = setup(() => ({
        json: { data: { ...LICENSE_KEY, attributes: { ...LICENSE_KEY.attributes, disabled } } },
      }));
      expect((await provider.getLicenseKey({ id: '1' })).status).toBe('disabled');
    });

    it.each([
      ['expired', 'expired'],
      ['inactive', 'active'],
    ])('maps the %s status to %s', async (status, expected) => {
      const { provider } = setup(() => ({
        json: { data: { ...LICENSE_KEY, attributes: { ...LICENSE_KEY.attributes, status } } },
      }));
      expect((await provider.getLicenseKey({ id: '1' })).status).toBe(expected);
    });

    it('updates a license key via a JSON:API PATCH', async () => {
      const { provider, stub } = setup(() => ({ json: { data: LICENSE_KEY } }));
      await provider.updateLicenseKey({
        id: '1',
        disabled: true,
        activationLimit: 10,
        expiresAt: new Date('2027-01-01T00:00:00Z'),
      });
      const request = stub.requests[0]!;
      expect(request.method).toBe('PATCH');
      expect(request.url).toBe('https://api.lemonsqueezy.com/v1/license-keys/1');
      expect(request.headers['content-type']).toBe('application/vnd.api+json');
      expect(JSON.parse(request.body!)).toEqual({
        data: {
          type: 'license-keys',
          id: '1',
          attributes: {
            disabled: true,
            activation_limit: 10,
            expires_at: '2027-01-01T00:00:00.000Z',
          },
        },
      });
    });

    it('sends literal nulls to remove the limit and the expiry', async () => {
      const { provider, stub } = setup(() => ({ json: { data: LICENSE_KEY } }));
      await provider.updateLicenseKey({ id: '1', activationLimit: null, expiresAt: null });
      const attributes = JSON.parse(stub.requests[0]!.body!).data.attributes;
      // Dropped keys would leave the current limit and expiry in place.
      expect(attributes).toEqual({ activation_limit: null, expires_at: null });
    });

    it('omits untouched attributes', async () => {
      const { provider, stub } = setup(() => ({ json: { data: LICENSE_KEY } }));
      await provider.updateLicenseKey({ id: '1', disabled: false });
      expect(JSON.parse(stub.requests[0]!.body!).data.attributes).toEqual({ disabled: false });
    });
  });

  it('rejects usage reporting', async () => {
    const { provider } = setup(() => ({ json: {} }));
    await expectRevenueError(
      provider.reportUsage({ customerId: 'c1', eventName: 'api' }),
      'unsupported',
    );
  });

  it('maps JSON:API error bodies onto RevenueError', async () => {
    const { provider } = setup(() => ({
      status: 401,
      json: { errors: [{ detail: 'Unauthenticated.', status: '401', title: 'Unauthorized' }] },
    }));
    try {
      await provider.getSubscription({ id: '42' });
      expect.unreachable('expected RevenueError');
    } catch (error) {
      expect(error).toBeInstanceOf(RevenueError);
      expect((error as RevenueError).code).toBe('unauthorized');
      expect((error as RevenueError).message).toBe('Unauthenticated.');
    }
  });
});
