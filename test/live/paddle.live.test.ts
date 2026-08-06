import { describe, expect, it } from 'vitest';
import { env } from '../helpers/env.ts';
import { createClient } from '../../src/index.ts';
import { paddle } from '../../src/paddle.ts';

const apiKey = env('REVENUE_SDK_LIVE_PADDLE_API_KEY');
const server = env('REVENUE_SDK_LIVE_PADDLE_SERVER') === 'production' ? undefined : 'sandbox';

describe.skipIf(!apiKey)('paddle (live, read-only)', () => {
  const client = () => createClient({ provider: paddle({ apiKey: apiKey!, server }) });

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
