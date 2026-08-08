import { afterEach, describe, expect, it, vi } from 'vitest';
import { createClient } from '../../src/client.ts';
import { RevenueError } from '../../src/errors.ts';
import type { Page, RevenueCapabilities, RevenueProvider, Subscription } from '../../src/types.ts';

const ALL_CAPABILITIES: RevenueCapabilities = {
  cancellationReason: true,
  checkoutExpiresAt: true,
  checkoutStatus: true,
  checkoutSuccessUrl: true,
  endTrial: true,
  hostedCheckout: true,
  licenseKeys: true,
  listOrdersByCustomer: true,
  listSubscriptionsByCustomer: true,
  pause: true,
  pauseBehaviors: ['immediately', 'period_end'],
  portalReturnUrl: true,
  prorationBehaviors: ['invoice_now', 'none', 'prorate'],
  revoke: true,
  uncancel: true,
  usageReporting: true,
};

function notImplemented(): never {
  throw new Error('not implemented');
}

function fakeProvider(
  overrides: Partial<RevenueProvider> = {},
  capabilities: Partial<RevenueCapabilities> = {},
): RevenueProvider {
  return {
    name: 'testing',
    capabilities: { ...ALL_CAPABILITIES, ...capabilities },
    listProducts: notImplemented,
    getProduct: notImplemented,
    createCheckout: notImplemented,
    getCheckout: notImplemented,
    getCustomer: notImplemented,
    listCustomers: notImplemented,
    createCustomer: notImplemented,
    updateCustomer: notImplemented,
    getSubscription: notImplemented,
    listSubscriptions: notImplemented,
    cancelSubscription: notImplemented,
    uncancelSubscription: notImplemented,
    changeSubscriptionPlan: notImplemented,
    endSubscriptionTrial: notImplemented,
    pauseSubscription: notImplemented,
    resumeSubscription: notImplemented,
    revokeSubscription: notImplemented,
    createCustomerPortalSession: notImplemented,
    reportUsage: notImplemented,
    listOrders: notImplemented,
    getOrder: notImplemented,
    getOrderInvoiceUrl: notImplemented,
    listLicenseKeys: notImplemented,
    getLicenseKey: notImplemented,
    updateLicenseKey: notImplemented,
    ...overrides,
  };
}

function subscription(id: string): Subscription {
  return {
    id,
    status: 'active',
    cancelAtPeriodEnd: false,
    pauseAtPeriodEnd: false,
    customerId: 'c1',
    raw: {},
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

describe('createClient', () => {
  it('exposes the provider name and capabilities', () => {
    const client = createClient({ provider: fakeProvider() });
    expect(client.providerName).toBe('testing');
    expect(client.capabilities.uncancel).toBe(true);
  });

  describe('validation', () => {
    it('rejects empty ids without calling the provider', async () => {
      const getSubscription = vi.fn();
      const client = createClient({ provider: fakeProvider({ getSubscription }) });
      await expectRevenueError(client.subscriptions.get({ id: '  ' }), 'validation');
      expect(getSubscription).not.toHaveBeenCalled();
    });

    it('rejects empty checkout items', async () => {
      const client = createClient({ provider: fakeProvider() });
      await expectRevenueError(client.checkouts.create({ items: [] }), 'validation');
      await expectRevenueError(client.checkouts.create({ items: [{ product: '' }] }), 'validation');
      await expectRevenueError(
        client.checkouts.create({ items: [{ product: 'p1', quantity: 0 }] }),
        'validation',
      );
      await expectRevenueError(
        client.checkouts.create({ items: [{ product: 'p1', quantity: 1.5 }] }),
        'validation',
      );
    });

    it('rejects a blank email or name on customer writes', async () => {
      const createCustomer = vi.fn();
      const updateCustomer = vi.fn();
      const client = createClient({ provider: fakeProvider({ createCustomer, updateCustomer }) });
      await expectRevenueError(client.customers.create({ email: '  ', name: 'Ada' }), 'validation');
      await expectRevenueError(
        client.customers.create({ email: 'ada@example.com', name: '' }),
        'validation',
      );
      await expectRevenueError(client.customers.update({ id: ' ' }), 'validation');
      // An empty value would overwrite the stored one rather than leave it alone.
      await expectRevenueError(client.customers.update({ id: 'c1', name: '' }), 'validation');
      expect(createCustomer).not.toHaveBeenCalled();
      expect(updateCustomer).not.toHaveBeenCalled();
    });

    it('updates a customer with only an id', async () => {
      const updateCustomer = vi.fn().mockResolvedValue({ id: 'c1', email: 'a@b.c', raw: {} });
      const client = createClient({ provider: fakeProvider({ updateCustomer }) });
      await client.customers.update({ id: 'c1' });
      expect(updateCustomer).toHaveBeenCalledWith({ id: 'c1' });
    });

    it('rejects a limit that is not a positive integer', async () => {
      const listProducts = vi.fn();
      const client = createClient({ provider: fakeProvider({ listProducts }) });
      await expectRevenueError(client.products.list({ limit: 0 }), 'validation');
      await expectRevenueError(client.products.list({ limit: 1.5 }), 'validation');
      // Without the check this reaches the provider — and the wire — as `limit=NaN`.
      await expectRevenueError(client.products.list({ limit: Number.NaN }), 'validation');
      await expectRevenueError(
        (async () => {
          for await (const product of client.products.listAll({ limit: -1 })) {
            void product;
          }
        })(),
        'validation',
      );
      expect(listProducts).not.toHaveBeenCalled();
    });

    it('rejects an invalid limit on every list resource', async () => {
      const client = createClient({ provider: fakeProvider() });
      await expectRevenueError(client.customers.list({ limit: 0 }), 'validation');
      await expectRevenueError(client.subscriptions.list({ limit: 0 }), 'validation');
      await expectRevenueError(client.licenseKeys.list({ limit: 0 }), 'validation');
      await expectRevenueError(client.orders.list({ limit: 0 }), 'validation');
    });

    it('rejects a checkout expiry when unsupported', async () => {
      const createCheckout = vi.fn();
      const client = createClient({
        provider: fakeProvider({ createCheckout }, { checkoutExpiresAt: false }),
      });
      await expectRevenueError(
        client.checkouts.create({
          items: [{ product: 'p1' }],
          expiresAt: new Date(Date.now() + 60_000),
        }),
        'unsupported',
      );
      expect(createCheckout).not.toHaveBeenCalled();
    });

    it('rejects an invalid or past checkout expiry', async () => {
      const createCheckout = vi.fn();
      const client = createClient({ provider: fakeProvider({ createCheckout }) });
      await expectRevenueError(
        client.checkouts.create({ items: [{ product: 'p1' }], expiresAt: new Date(Number.NaN) }),
        'validation',
      );
      await expectRevenueError(
        client.checkouts.create({
          items: [{ product: 'p1' }],
          expiresAt: new Date(Date.now() - 1000),
        }),
        'validation',
      );
      expect(createCheckout).not.toHaveBeenCalled();
    });

    it('rejects an empty usage customer, event name, or non-finite value', async () => {
      const reportUsage = vi.fn();
      const client = createClient({ provider: fakeProvider({ reportUsage }) });
      await expectRevenueError(
        client.usage.report({ customerId: ' ', eventName: 'api_call' }),
        'validation',
      );
      await expectRevenueError(
        client.usage.report({ customerId: 'c1', eventName: '' }),
        'validation',
      );
      await expectRevenueError(
        client.usage.report({ customerId: 'c1', eventName: 'api_call', value: Number.NaN }),
        'validation',
      );
      expect(reportUsage).not.toHaveBeenCalled();
    });

    it('rejects non-finite usage metadata under any key', async () => {
      // Meters aggregate on a caller-configured key, so any numeric entry can be the billed
      // quantity — not just one named `value`.
      const reportUsage = vi.fn();
      const client = createClient({ provider: fakeProvider({ reportUsage }) });
      await expectRevenueError(
        client.usage.report({
          customerId: 'c1',
          eventName: 'api_call',
          metadata: { value: Number.NaN },
        }),
        'validation',
      );
      await expectRevenueError(
        client.usage.report({
          customerId: 'c1',
          eventName: 'api_call',
          metadata: { total_tokens: Number.POSITIVE_INFINITY },
        }),
        'validation',
      );
      expect(reportUsage).not.toHaveBeenCalled();
    });

    it('accepts finite and non-numeric usage metadata', async () => {
      const reportUsage = vi.fn().mockResolvedValue(undefined);
      const client = createClient({ provider: fakeProvider({ reportUsage }) });
      await client.usage.report({
        customerId: 'c1',
        eventName: 'api_call',
        metadata: { total_tokens: 0, region: 'eu', premium: true },
      });
      expect(reportUsage).toHaveBeenCalledOnce();
    });

    it('rejects an invalid license-key activation limit', async () => {
      const updateLicenseKey = vi.fn();
      const client = createClient({ provider: fakeProvider({ updateLicenseKey }) });
      await expectRevenueError(
        client.licenseKeys.update({ id: 'lk1', activationLimit: 0 }),
        'validation',
      );
      await expectRevenueError(
        client.licenseKeys.update({ id: 'lk1', activationLimit: 1.5 }),
        'validation',
      );
      expect(updateLicenseKey).not.toHaveBeenCalled();
    });

    it('allows a null activation limit to clear it', async () => {
      const updateLicenseKey = vi.fn().mockResolvedValue({ id: 'lk1' });
      const client = createClient({ provider: fakeProvider({ updateLicenseKey }) });
      await client.licenseKeys.update({ id: 'lk1', activationLimit: null });
      expect(updateLicenseKey).toHaveBeenCalledOnce();
    });

    it('rejects an empty plan-change product', async () => {
      const client = createClient({ provider: fakeProvider() });
      await expectRevenueError(
        client.subscriptions.changePlan({ id: 's1', product: '' }),
        'validation',
      );
    });
  });

  describe('capability gating', () => {
    it('rejects cancellation reasons when unsupported', async () => {
      const cancelSubscription = vi.fn();
      const client = createClient({
        provider: fakeProvider({ cancelSubscription }, { cancellationReason: false }),
      });
      await expectRevenueError(
        client.subscriptions.cancel({ id: 's1', reason: 'too_expensive' }),
        'unsupported',
      );
      expect(cancelSubscription).not.toHaveBeenCalled();
    });

    it('still cancels without a reason when reasons are unsupported', async () => {
      const cancelSubscription = vi.fn().mockResolvedValue(subscription('s1'));
      const client = createClient({
        provider: fakeProvider({ cancelSubscription }, { cancellationReason: false }),
      });
      await client.subscriptions.cancel({ id: 's1' });
      expect(cancelSubscription).toHaveBeenCalledOnce();
    });

    it('rejects unsupported proration behaviors', async () => {
      const client = createClient({
        provider: fakeProvider({}, { prorationBehaviors: ['invoice_now'] }),
      });
      await expectRevenueError(
        client.subscriptions.changePlan({ id: 's1', product: 'p1', prorationBehavior: 'none' }),
        'unsupported',
      );
    });

    it('rejects endTrial, revoke, and uncancel when unsupported', async () => {
      const client = createClient({
        provider: fakeProvider({}, { endTrial: false, revoke: false, uncancel: false }),
      });
      await expectRevenueError(client.subscriptions.endTrial({ id: 's1' }), 'unsupported');
      await expectRevenueError(client.subscriptions.revoke({ id: 's1' }), 'unsupported');
      await expectRevenueError(client.subscriptions.uncancel({ id: 's1' }), 'unsupported');
    });

    it('rejects pause and resume when unsupported', async () => {
      const pauseSubscription = vi.fn();
      const resumeSubscription = vi.fn();
      const client = createClient({
        provider: fakeProvider(
          { pauseSubscription, resumeSubscription },
          { pause: false, pauseBehaviors: [] },
        ),
      });
      await expectRevenueError(client.subscriptions.pause({ id: 's1' }), 'unsupported');
      await expectRevenueError(client.subscriptions.resume({ id: 's1' }), 'unsupported');
      expect(pauseSubscription).not.toHaveBeenCalled();
      expect(resumeSubscription).not.toHaveBeenCalled();
    });

    it('rejects unsupported pause behaviors', async () => {
      const client = createClient({
        provider: fakeProvider({}, { pauseBehaviors: ['period_end'] }),
      });
      await expectRevenueError(
        client.subscriptions.pause({ id: 's1', behavior: 'immediately' }),
        'unsupported',
      );
    });

    it('pauses without a behavior even when only one behavior is supported', async () => {
      const pauseSubscription = vi.fn().mockResolvedValue(subscription('s1'));
      const client = createClient({
        provider: fakeProvider({ pauseSubscription }, { pauseBehaviors: ['period_end'] }),
      });
      await client.subscriptions.pause({ id: 's1' });
      expect(pauseSubscription).toHaveBeenCalledOnce();
    });

    it('rejects customer-filtered order listing when unsupported', async () => {
      const listOrders = vi.fn();
      const client = createClient({
        provider: fakeProvider({ listOrders }, { listOrdersByCustomer: false }),
      });
      await expectRevenueError(client.orders.list({ customerId: 'c1' }), 'unsupported');
      await expectRevenueError(
        (async () => {
          for await (const order of client.orders.listAll({ customerId: 'c1' })) {
            void order;
          }
        })(),
        'unsupported',
      );
      expect(listOrders).not.toHaveBeenCalled();
    });

    it('still lists orders unfiltered when the customer filter is unsupported', async () => {
      const listOrders = vi.fn().mockResolvedValue({ items: [] });
      const client = createClient({
        provider: fakeProvider({ listOrders }, { listOrdersByCustomer: false }),
      });
      await client.orders.list();
      expect(listOrders).toHaveBeenCalledOnce();
    });

    it('rejects customer-filtered listing when unsupported', async () => {
      const client = createClient({
        provider: fakeProvider({}, { listSubscriptionsByCustomer: false }),
      });
      await expectRevenueError(client.subscriptions.list({ customerId: 'c1' }), 'unsupported');
    });

    it('rejects usage reporting when unsupported', async () => {
      const reportUsage = vi.fn();
      const client = createClient({
        provider: fakeProvider({ reportUsage }, { usageReporting: false }),
      });
      await expectRevenueError(
        client.usage.report({ customerId: 'c1', eventName: 'api_call' }),
        'unsupported',
      );
      expect(reportUsage).not.toHaveBeenCalled();
    });

    it('rejects every license-key operation when unsupported', async () => {
      const listLicenseKeys = vi.fn();
      const client = createClient({
        provider: fakeProvider({ listLicenseKeys }, { licenseKeys: false }),
      });
      await expectRevenueError(client.licenseKeys.list(), 'unsupported');
      await expectRevenueError(client.licenseKeys.get({ id: 'lk1' }), 'unsupported');
      await expectRevenueError(
        client.licenseKeys.update({ id: 'lk1', disabled: true }),
        'unsupported',
      );
      await expectRevenueError(
        (async () => {
          for await (const key of client.licenseKeys.listAll()) {
            void key;
          }
        })(),
        'unsupported',
      );
      expect(listLicenseKeys).not.toHaveBeenCalled();
    });

    it('rejects a portal return URL when unsupported', async () => {
      const client = createClient({ provider: fakeProvider({}, { portalReturnUrl: false }) });
      await expectRevenueError(
        client.customerPortal.createSession({ customerId: 'c1', returnUrl: 'https://x' }),
        'unsupported',
      );
    });
  });

  describe('retry', () => {
    // Only the tests that exercise the default delay switch to fake timers; this keeps a failed
    // assertion inside one of them from leaking faked timers into the rest of the suite.
    afterEach(() => {
      vi.useRealTimers();
    });

    it('retries once on a small rate-limit Retry-After', async () => {
      const getSubscription = vi
        .fn()
        .mockRejectedValueOnce(
          new RevenueError('rate limited', { code: 'rate_limited', retryAfter: 0 }),
        )
        .mockResolvedValueOnce(subscription('s1'));
      const client = createClient({ provider: fakeProvider({ getSubscription }) });
      const result = await client.subscriptions.get({ id: 's1' });
      expect(result.id).toBe('s1');
      expect(getSubscription).toHaveBeenCalledTimes(2);
    });

    it('does not retry when Retry-After exceeds the maximum', async () => {
      const getSubscription = vi
        .fn()
        .mockRejectedValue(
          new RevenueError('rate limited', { code: 'rate_limited', retryAfter: 60 }),
        );
      const client = createClient({ provider: fakeProvider({ getSubscription }) });
      await expectRevenueError(client.subscriptions.get({ id: 's1' }), 'rate_limited');
      expect(getSubscription).toHaveBeenCalledTimes(1);
    });

    it('retries at most once', async () => {
      const getSubscription = vi
        .fn()
        .mockRejectedValue(
          new RevenueError('rate limited', { code: 'rate_limited', retryAfter: 0 }),
        );
      const client = createClient({ provider: fakeProvider({ getSubscription }) });
      await expectRevenueError(client.subscriptions.get({ id: 's1' }), 'rate_limited');
      expect(getSubscription).toHaveBeenCalledTimes(2);
    });

    it('never retries usage reports', async () => {
      // A replayed usage event is only deduplicated when the caller passes an idempotency key,
      // so an automatic retry would over-bill the customer.
      const reportUsage = vi
        .fn()
        .mockRejectedValue(
          new RevenueError('rate limited', { code: 'rate_limited', retryAfter: 0 }),
        );
      const client = createClient({ provider: fakeProvider({ reportUsage }) });
      await expectRevenueError(
        client.usage.report({ customerId: 'c1', eventName: 'api_call' }),
        'rate_limited',
      );
      expect(reportUsage).toHaveBeenCalledTimes(1);
    });

    it('retries once after the default delay when the provider sent no Retry-After', async () => {
      // Stripe never sends `Retry-After`, so waiting for one would disable the retry there.
      vi.useFakeTimers();
      const getSubscription = vi
        .fn()
        .mockRejectedValueOnce(new RevenueError('rate limited', { code: 'rate_limited' }))
        .mockResolvedValueOnce(subscription('s1'));
      const client = createClient({ provider: fakeProvider({ getSubscription }) });
      const pending = client.subscriptions.get({ id: 's1' });
      await vi.advanceTimersByTimeAsync(1000);
      await expect(pending).resolves.toMatchObject({ id: 's1' });
      expect(getSubscription).toHaveBeenCalledTimes(2);
    });

    it('does not retry a rate limit the provider marked as not retryable', async () => {
      // Stripe answers `Stripe-Should-Retry: false` when replaying cannot succeed.
      const getSubscription = vi.fn().mockRejectedValue(
        new RevenueError('rate limited', {
          code: 'rate_limited',
          retryAfter: 0,
          retryable: false,
        }),
      );
      const client = createClient({ provider: fakeProvider({ getSubscription }) });
      await expectRevenueError(client.subscriptions.get({ id: 's1' }), 'rate_limited');
      expect(getSubscription).toHaveBeenCalledTimes(1);
    });

    it('retries a read once on a transport failure', async () => {
      vi.useFakeTimers();
      const getSubscription = vi
        .fn()
        .mockRejectedValueOnce(new RevenueError('boom', { code: 'network_error' }))
        .mockResolvedValueOnce(subscription('s1'));
      const client = createClient({ provider: fakeProvider({ getSubscription }) });
      const pending = client.subscriptions.get({ id: 's1' });
      await vi.advanceTimersByTimeAsync(1000);
      await expect(pending).resolves.toMatchObject({ id: 's1' });
      expect(getSubscription).toHaveBeenCalledTimes(2);
    });

    it('never retries a write on a transport failure', async () => {
      // The request may have reached the provider, so replaying it could act twice.
      const cancelSubscription = vi
        .fn()
        .mockRejectedValue(new RevenueError('boom', { code: 'network_error' }));
      const client = createClient({ provider: fakeProvider({ cancelSubscription }) });
      await expectRevenueError(client.subscriptions.cancel({ id: 's1' }), 'network_error');
      expect(cancelSubscription).toHaveBeenCalledTimes(1);
    });

    it('never retries a customer create on a transport failure', async () => {
      // No provider offers idempotency keys on customers, so a replay could create a duplicate.
      const createCustomer = vi
        .fn()
        .mockRejectedValue(new RevenueError('boom', { code: 'network_error' }));
      const client = createClient({ provider: fakeProvider({ createCustomer }) });
      await expectRevenueError(
        client.customers.create({ email: 'ada@example.com', name: 'Ada' }),
        'network_error',
      );
      expect(createCustomer).toHaveBeenCalledTimes(1);
    });

    it('still retries a write on a rate limit', async () => {
      // A 429 is rejected before the provider does anything, so the write never landed.
      const cancelSubscription = vi
        .fn()
        .mockRejectedValueOnce(
          new RevenueError('rate limited', { code: 'rate_limited', retryAfter: 0 }),
        )
        .mockResolvedValueOnce(subscription('s1'));
      const client = createClient({ provider: fakeProvider({ cancelSubscription }) });
      await client.subscriptions.cancel({ id: 's1' });
      expect(cancelSubscription).toHaveBeenCalledTimes(2);
    });

    it('stops waiting for the retry when the caller aborts', async () => {
      const controller = new AbortController();
      const getSubscription = vi
        .fn()
        .mockRejectedValue(
          new RevenueError('rate limited', { code: 'rate_limited', retryAfter: 5 }),
        );
      const client = createClient({ provider: fakeProvider({ getSubscription }) });
      const pending = client.subscriptions.get({ id: 's1', signal: controller.signal });
      // A macrotask: every pending microtask has run, so the retry is asleep by now.
      await new Promise((resolve) => setTimeout(resolve, 0));
      controller.abort();
      const error = await pending.catch((reason: unknown) => reason);
      // The abort reason, not the rate limit — the same thing an aborted `fetch` throws.
      expect((error as Error).name).toBe('AbortError');
      expect(getSubscription).toHaveBeenCalledTimes(1);
    });

    it('does not retry other errors', async () => {
      const getSubscription = vi
        .fn()
        .mockRejectedValue(new RevenueError('nope', { code: 'not_found' }));
      const client = createClient({ provider: fakeProvider({ getSubscription }) });
      await expectRevenueError(client.subscriptions.get({ id: 's1' }), 'not_found');
      expect(getSubscription).toHaveBeenCalledTimes(1);
    });

    it('disables the retry when maxRetryAfterSeconds is 0', async () => {
      const getSubscription = vi
        .fn()
        .mockRejectedValue(
          new RevenueError('rate limited', { code: 'rate_limited', retryAfter: 0 }),
        );
      const client = createClient({
        provider: fakeProvider({ getSubscription }),
        retry: { maxRetryAfterSeconds: 0 },
      });
      await expectRevenueError(client.subscriptions.get({ id: 's1' }), 'rate_limited');
      expect(getSubscription).toHaveBeenCalledTimes(1);
    });
  });

  describe('listAll', () => {
    it('walks all pages via cursors', async () => {
      const pages: Record<string, Page<Subscription>> = {
        start: { items: [subscription('s1'), subscription('s2')], cursor: 'next' },
        next: { items: [subscription('s3')] },
      };
      const listSubscriptions = vi.fn(async (params: { cursor?: string }) => {
        return pages[params.cursor ?? 'start']!;
      });
      const client = createClient({ provider: fakeProvider({ listSubscriptions }) });
      const ids: string[] = [];
      for await (const item of client.subscriptions.listAll()) {
        ids.push(item.id);
      }
      expect(ids).toEqual(['s1', 's2', 's3']);
      expect(listSubscriptions).toHaveBeenCalledTimes(2);
    });

    it('rejects on the first page rather than throwing synchronously', async () => {
      const client = createClient({ provider: fakeProvider({}, { licenseKeys: false }) });
      // Creating the generator must not throw: the caller only ever sees a rejected `next()`.
      const iterator = client.licenseKeys.listAll();
      await expect(iterator.next()).rejects.toBeInstanceOf(RevenueError);
    });

    it('retries each page exactly once', async () => {
      const listSubscriptions = vi
        .fn()
        .mockRejectedValueOnce(
          new RevenueError('rate limited', { code: 'rate_limited', retryAfter: 0 }),
        )
        .mockResolvedValueOnce({ items: [subscription('s1')], cursor: 'next' })
        .mockRejectedValueOnce(
          new RevenueError('rate limited', { code: 'rate_limited', retryAfter: 0 }),
        )
        .mockResolvedValueOnce({ items: [subscription('s2')] });
      const client = createClient({ provider: fakeProvider({ listSubscriptions }) });
      const ids: string[] = [];
      for await (const item of client.subscriptions.listAll()) {
        ids.push(item.id);
      }
      expect(ids).toEqual(['s1', 's2']);
      expect(listSubscriptions).toHaveBeenCalledTimes(4);
    });
  });

  it('passes params through to the provider', async () => {
    const createCheckout = vi.fn().mockResolvedValue({ id: 'c1', url: 'u', status: null, raw: {} });
    const client = createClient({ provider: fakeProvider({ createCheckout }) });
    const params = {
      items: [{ product: 'p1', quantity: 2 }],
      successUrl: 'https://x',
      metadata: { org: '1' },
    };
    await client.checkouts.create(params);
    expect(createCheckout).toHaveBeenCalledWith(params);
  });
});
