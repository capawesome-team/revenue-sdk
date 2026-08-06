import { describe, expect, it } from 'vitest';
import { env } from '../helpers/env.ts';
import { dodoPayments } from '../../src/dodo-payments.ts';
import { createClient } from '../../src/index.ts';

const apiKey = env('REVENUE_SDK_LIVE_DODO_PAYMENTS_API_KEY');
const server = env('REVENUE_SDK_LIVE_DODO_PAYMENTS_SERVER') === 'live' ? undefined : 'test';

describe.skipIf(!apiKey)('dodo-payments (live, read-only)', () => {
  const client = () => createClient({ provider: dodoPayments({ apiKey: apiKey!, server }) });

  it('lists products', async () => {
    const page = await client().products.list({ limit: 5 });
    expect(Array.isArray(page.items)).toBe(true);
  });

  it('lists customers', async () => {
    const page = await client().customers.list({ limit: 5 });
    expect(Array.isArray(page.items)).toBe(true);
  });

  it('lists subscriptions', async () => {
    const page = await client().subscriptions.list({ limit: 5 });
    expect(Array.isArray(page.items)).toBe(true);
  });
});
