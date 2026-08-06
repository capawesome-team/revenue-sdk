import { describe, expect, it } from 'vitest';
import { env } from '../helpers/env.ts';
import { createClient } from '../../src/index.ts';
import { lemonSqueezy } from '../../src/lemon-squeezy.ts';

const apiKey = env('REVENUE_SDK_LIVE_LEMON_SQUEEZY_API_KEY');
const storeId = env('REVENUE_SDK_LIVE_LEMON_SQUEEZY_STORE_ID');

describe.skipIf(!apiKey || !storeId)('lemon-squeezy (live, read-only)', () => {
  const client = () =>
    createClient({ provider: lemonSqueezy({ apiKey: apiKey!, storeId: storeId! }) });

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
