import { describe, expect, it } from 'vitest';
import { RevenueError } from '../../src/errors.ts';
import { lemonSqueezy } from '../../src/providers/lemon-squeezy/index.ts';
import { createFetchStub, type StubHandler } from '../helpers/fetch-stub.ts';

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
    expect(provider.capabilities.revoke).toBe(false);
    expect(provider.capabilities.listSubscriptionsByCustomer).toBe(false);
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

    it('ends a trial by resetting the billing anchor', async () => {
      const { provider, stub } = setup(() => ({ json: { data: SUBSCRIPTION } }));
      await provider.endSubscriptionTrial({ id: '42' });
      expect(JSON.parse(stub.requests[0]!.body!)).toEqual({
        data: { type: 'subscriptions', id: '42', attributes: { billing_anchor: null } },
      });
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
