import { describe, expect, it } from 'vitest';
import { env } from '../helpers/env.ts';
import { createClient } from '../../src/index.ts';
import { stripe } from '../../src/stripe.ts';

const secretKey = env('REVENUE_SDK_LIVE_STRIPE_SECRET_KEY');

describe.skipIf(!secretKey)('stripe (live, read-only)', () => {
  const client = () => createClient({ provider: stripe({ secretKey: secretKey! }) });

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
