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
    const expiresAt = new Date('2026-08-08T00:00:00Z');
    const checkout = await provider.createCheckout({
      items: [{ product: 'product-1' }],
      customerEmail: 'user@example.com',
      metadata: { org: '1' },
      expiresAt,
    });
    expect(provider.capabilities.checkoutExpiresAt).toBe(true);
    expect(provider.state.checkouts).toHaveLength(1);
    await expect(provider.getCheckout({ id: checkout.id })).resolves.toMatchObject({
      customerEmail: 'user@example.com',
      status: 'open',
      expiresAt,
    });
  });

  it('keeps the custom amount on the recorded checkout', async () => {
    const provider = createInMemoryProvider();
    const checkout = await provider.createCheckout({
      items: [{ product: 'product-1' }],
      customAmount: 2500,
    });
    expect(provider.capabilities.checkoutCustomAmount).toBe(true);
    expect(checkout.raw).toMatchObject({ customAmount: 2500 });
  });

  it('creates and updates customers in state', async () => {
    const provider = createInMemoryProvider();
    const created = await provider.createCustomer({
      email: 'ada@example.com',
      name: 'Ada Lovelace',
      metadata: { org: '1' },
    });
    expect(provider.state.customers).toHaveLength(1);
    await expect(provider.getCustomer({ id: created.id })).resolves.toMatchObject({
      email: 'ada@example.com',
      name: 'Ada Lovelace',
      metadata: { org: '1' },
    });

    const updated = await provider.updateCustomer({ id: created.id, name: 'Ada L.' });
    expect(updated.name).toBe('Ada L.');
    // Omitted fields keep their stored value.
    expect(updated.email).toBe('ada@example.com');
    expect(provider.state.customers[0]!.name).toBe('Ada L.');
    await expect(provider.updateCustomer({ id: 'missing' })).rejects.toBeInstanceOf(RevenueError);
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

  it('pauses immediately or at period end and resumes', async () => {
    const provider = createInMemoryProvider({ subscriptions: [{ id: 'sub-1' }] });
    const resumesAt = new Date('2026-10-01T00:00:00Z');
    const paused = await provider.pauseSubscription({ id: 'sub-1', resumesAt });
    expect(paused.status).toBe('paused');
    expect(paused.pauseAtPeriodEnd).toBe(false);
    expect(paused.resumesAt).toEqual(resumesAt);
    expect(provider.state.subscriptions[0]!.status).toBe('paused');

    const resumed = await provider.resumeSubscription({ id: 'sub-1' });
    expect(resumed.status).toBe('active');
    expect(resumed.pauseAtPeriodEnd).toBe(false);
    expect(resumed.resumesAt).toBeUndefined();

    const scheduled = await provider.pauseSubscription({ id: 'sub-1', behavior: 'period_end' });
    expect(scheduled.status).toBe('active');
    expect(scheduled.pauseAtPeriodEnd).toBe(true);
    expect(provider.state.subscriptions[0]!.pauseAtPeriodEnd).toBe(true);
  });

  it('replaces any earlier pause state when pausing again', async () => {
    const provider = createInMemoryProvider({ subscriptions: [{ id: 'sub-1' }] });
    await provider.pauseSubscription({
      id: 'sub-1',
      behavior: 'period_end',
      resumesAt: new Date('2026-10-01T00:00:00Z'),
    });

    // An immediate pause supersedes the schedule, and omitting `resumesAt` means indefinitely.
    const paused = await provider.pauseSubscription({ id: 'sub-1' });
    expect(paused.status).toBe('paused');
    expect(paused.pauseAtPeriodEnd).toBe(false);
    expect(paused.resumesAt).toBeUndefined();
  });

  it('records reported usage events in state and merges value into the payload', async () => {
    const provider = createInMemoryProvider();
    const timestamp = new Date('2026-08-06T12:00:00Z');
    await provider.reportUsage({
      customerId: 'customer-1',
      eventName: 'api_request',
      value: 5,
      // An explicit `metadata.value` loses against `params.value`.
      metadata: { value: 1, region: 'eu' },
      idempotencyKey: 'evt-1',
      timestamp,
    });
    await provider.reportUsage({ customerId: 'customer-2', eventName: 'tokens' });

    expect(provider.state.usageEvents).toEqual([
      {
        customerId: 'customer-1',
        eventName: 'api_request',
        payload: { value: 5, region: 'eu' },
        idempotencyKey: 'evt-1',
        timestamp,
      },
      {
        customerId: 'customer-2',
        eventName: 'tokens',
        payload: {},
        idempotencyKey: undefined,
        timestamp: undefined,
      },
    ]);
  });

  it('seeds, filters, and paginates orders', async () => {
    const provider = createInMemoryProvider({
      orders: [
        {
          id: 'ord-1',
          amount: 2900,
          currency: 'usd',
          customerId: 'customer-1',
          subscriptionId: 'sub-1',
          createdAt: new Date('2026-08-01T00:00:00Z'),
          refundStatus: 'partial',
          metadata: { org: '1' },
        },
        { id: 'ord-2', customerId: 'customer-1' },
        { id: 'ord-3', status: 'refunded', customerId: 'customer-2' },
      ],
    });

    const first = await provider.listOrders({});
    expect(first.items.map((item) => item.id)).toEqual(['ord-1', 'ord-2']);
    const second = await provider.listOrders({ cursor: first.cursor });
    expect(second.items.map((item) => item.id)).toEqual(['ord-3']);
    expect(second.cursor).toBeUndefined();

    const byCustomer = await provider.listOrders({ customerId: 'customer-1' });
    expect(byCustomer.items.map((item) => item.id)).toEqual(['ord-1', 'ord-2']);

    await expect(provider.getOrder({ id: 'ord-1' })).resolves.toMatchObject({
      status: 'paid',
      amount: 2900,
      currency: 'usd',
      subscriptionId: 'sub-1',
      refundStatus: 'partial',
      metadata: { org: '1' },
    });
    // `status` defaults to paid and an omitted id is generated.
    await expect(provider.getOrder({ id: 'ord-2' })).resolves.toMatchObject({ status: 'paid' });
    await expect(provider.getOrder({ id: 'ord-3' })).resolves.toMatchObject({
      status: 'refunded',
    });
    await expect(provider.getOrder({ id: 'missing' })).rejects.toMatchObject({
      code: 'not_found',
    });
  });

  it('fabricates an invoice URL for a seeded order', async () => {
    const provider = createInMemoryProvider({ orders: [{ id: 'ord-1' }] });
    await expect(provider.getOrderInvoiceUrl({ id: 'ord-1' })).resolves.toBe(
      'https://invoices.example.com/ord-1',
    );
    await expect(provider.getOrderInvoiceUrl({ id: 'missing' })).rejects.toMatchObject({
      code: 'not_found',
    });
  });

  it('seeds, paginates, and reads license keys', async () => {
    const provider = createInMemoryProvider({
      licenseKeys: [
        { id: 'lk-1', key: 'AAAA-BBBB', customerId: 'customer-1', activationLimit: 3 },
        { id: 'lk-2' },
        { id: 'lk-3', status: 'expired' },
      ],
    });
    const first = await provider.listLicenseKeys({});
    expect(first.items.map((item) => item.id)).toEqual(['lk-1', 'lk-2']);
    expect(first.cursor).toBeDefined();
    const second = await provider.listLicenseKeys({ cursor: first.cursor });
    expect(second.items.map((item) => item.id)).toEqual(['lk-3']);
    expect(second.cursor).toBeUndefined();

    await expect(provider.getLicenseKey({ id: 'lk-1' })).resolves.toMatchObject({
      key: 'AAAA-BBBB',
      status: 'active',
      activationLimit: 3,
      customerId: 'customer-1',
    });
    // An omitted `key` falls back to the id, and `status` defaults to active.
    await expect(provider.getLicenseKey({ id: 'lk-2' })).resolves.toMatchObject({
      key: 'lk-2',
      status: 'active',
    });
    await expect(provider.getLicenseKey({ id: 'missing' })).rejects.toMatchObject({
      code: 'not_found',
    });
  });

  it('updates license keys and clears limits and expiries with null', async () => {
    const expiresAt = new Date('2027-01-01T00:00:00Z');
    const provider = createInMemoryProvider({
      licenseKeys: [{ id: 'lk-1', activationLimit: 3, expiresAt }],
    });

    const disabled = await provider.updateLicenseKey({ id: 'lk-1', disabled: true });
    expect(disabled.status).toBe('disabled');
    expect(provider.state.licenseKeys[0]!.status).toBe('disabled');

    const updated = await provider.updateLicenseKey({
      id: 'lk-1',
      disabled: false,
      activationLimit: 10,
      expiresAt: new Date('2028-01-01T00:00:00Z'),
    });
    expect(updated).toMatchObject({
      status: 'active',
      activationLimit: 10,
      expiresAt: new Date('2028-01-01T00:00:00Z'),
    });

    const cleared = await provider.updateLicenseKey({
      id: 'lk-1',
      activationLimit: null,
      expiresAt: null,
    });
    expect(cleared.activationLimit).toBeUndefined();
    expect(cleared.expiresAt).toBeUndefined();
    // An omitted field leaves the current value alone.
    expect(cleared.status).toBe('active');

    await expect(provider.updateLicenseKey({ id: 'missing' })).rejects.toMatchObject({
      code: 'not_found',
    });
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
