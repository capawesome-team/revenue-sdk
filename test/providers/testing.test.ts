import { describe, expect, it } from 'vitest';
import { createClient } from '../../src/client.ts';
import { RevenueError } from '../../src/errors.ts';
import { createInMemoryProvider } from '../../src/providers/testing/index.ts';

describe('createInMemoryProvider', () => {
  it('seeds products, customers, and subscriptions with defaults', async () => {
    const provider = createInMemoryProvider({
      products: [{ name: 'Pro', prices: [{ amount: 2900 }] }],
      customers: [{ email: 'user@example.com' }],
      subscriptions: [{ customerId: 'customer-2' }],
    });
    const products = await provider.listProducts({});
    expect(products.items[0]!.name).toBe('Pro');
    expect(products.items[0]!.prices[0]!.amount).toBe(2900);
    expect(products.items[0]!.prices[0]!.checkoutRef).toBe(products.items[0]!.id);
    const customers = await provider.listCustomers({ email: 'user@example.com' });
    expect(customers.items).toHaveLength(1);
    const subscriptions = await provider.listSubscriptions({});
    expect(subscriptions.items[0]!.status).toBe('active');
  });

  it('paginates with PAGE_SIZE 2 to force cursor handling', async () => {
    const provider = createInMemoryProvider({
      products: [{ name: 'A' }, { name: 'B' }, { name: 'C' }],
    });
    const first = await provider.listProducts({});
    expect(first.items).toHaveLength(2);
    expect(first.cursor).toBeDefined();
    const second = await provider.listProducts({ cursor: first.cursor });
    expect(second.items).toHaveLength(1);
    expect(second.cursor).toBeUndefined();
  });

  it('records created checkouts in state', async () => {
    const provider = createInMemoryProvider();
    const checkout = await provider.createCheckout({
      items: [{ product: 'product-1' }],
      customerEmail: 'user@example.com',
      metadata: { org: '1' },
    });
    expect(provider.state.checkouts).toHaveLength(1);
    await expect(provider.getCheckout({ id: checkout.id })).resolves.toMatchObject({
      customerEmail: 'user@example.com',
      status: 'open',
    });
  });

  it('mutates subscriptions through the lifecycle operations', async () => {
    const provider = createInMemoryProvider({
      subscriptions: [{ id: 'sub-1', currentPeriodEnd: new Date('2026-09-01T00:00:00Z') }],
    });
    const canceled = await provider.cancelSubscription({ id: 'sub-1' });
    expect(canceled.cancelAtPeriodEnd).toBe(true);
    expect(canceled.endsAt).toEqual(new Date('2026-09-01T00:00:00Z'));
    const uncanceled = await provider.uncancelSubscription({ id: 'sub-1' });
    expect(uncanceled.cancelAtPeriodEnd).toBe(false);
    const changed = await provider.changeSubscriptionPlan({ id: 'sub-1', product: 'product-9' });
    expect(changed.productId).toBe('product-9');
    const revoked = await provider.revokeSubscription({ id: 'sub-1' });
    expect(revoked.status).toBe('canceled');
    expect(provider.state.subscriptions[0]!.status).toBe('canceled');
  });

  it('throws not_found for unknown resources', async () => {
    const provider = createInMemoryProvider();
    await expect(provider.getSubscription({ id: 'missing' })).rejects.toMatchObject({
      code: 'not_found',
    });
    await expect(
      provider.createCustomerPortalSession({ customerId: 'missing' }),
    ).rejects.toBeInstanceOf(RevenueError);
  });

  it('simulates another provider name and capability set', async () => {
    const provider = createInMemoryProvider(
      {},
      { name: 'lemon-squeezy', capabilities: { revoke: false, checkoutStatus: false } },
    );
    expect(provider.name).toBe('lemon-squeezy');
    const client = createClient({ provider });
    await expect(client.subscriptions.revoke({ id: 'sub-1' })).rejects.toMatchObject({
      code: 'unsupported',
    });
    const checkout = await client.checkouts.create({ items: [{ product: 'p1' }] });
    expect(checkout.status).toBeNull();
  });

  it('works end-to-end with createClient listAll', async () => {
    const provider = createInMemoryProvider({
      subscriptions: [{ id: 's1' }, { id: 's2' }, { id: 's3' }, { id: 's4' }, { id: 's5' }],
    });
    const client = createClient({ provider });
    const ids: string[] = [];
    for await (const subscription of client.subscriptions.listAll()) {
      ids.push(subscription.id);
    }
    expect(ids).toEqual(['s1', 's2', 's3', 's4', 's5']);
  });
});
