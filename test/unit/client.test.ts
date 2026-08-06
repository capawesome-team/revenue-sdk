import { describe, expect, it, vi } from 'vitest';
import { createClient } from '../../src/client.ts';
import { RevenueError } from '../../src/errors.ts';
import type { Page, RevenueCapabilities, RevenueProvider, Subscription } from '../../src/types.ts';

const ALL_CAPABILITIES: RevenueCapabilities = {
  cancellationReason: true,
  checkoutStatus: true,
  checkoutSuccessUrl: true,
  endTrial: true,
  hostedCheckout: true,
  listSubscriptionsByCustomer: true,
  pause: true,
  pauseBehaviors: ['immediately', 'period_end'],
  portalReturnUrl: true,
  prorationBehaviors: ['invoice_now', 'none', 'prorate'],
  revoke: true,
  uncancel: true,
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

    it('rejects customer-filtered listing when unsupported', async () => {
      const client = createClient({
        provider: fakeProvider({}, { listSubscriptionsByCustomer: false }),
      });
      await expectRevenueError(client.subscriptions.list({ customerId: 'c1' }), 'unsupported');
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
