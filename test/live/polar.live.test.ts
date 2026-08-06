import { describe, expect, it } from 'vitest';
import { env } from '../helpers/env.ts';
import { createClient } from '../../src/index.ts';
import { polar } from '../../src/polar.ts';

const accessToken = env('REVENUE_SDK_LIVE_POLAR_ACCESS_TOKEN');
const server = env('REVENUE_SDK_LIVE_POLAR_SERVER') === 'production' ? undefined : 'sandbox';

describe.skipIf(!accessToken)('polar (live, read-only)', () => {
  const client = () => createClient({ provider: polar({ accessToken: accessToken!, server }) });

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
