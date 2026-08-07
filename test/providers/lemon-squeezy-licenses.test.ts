import { describe, expect, it } from 'vitest';
import { RevenueError } from '../../src/errors.ts';
import {
  activateLicenseKey,
  deactivateLicenseKey,
  validateLicenseKey,
} from '../../src/providers/lemon-squeezy/licenses.ts';
import { createFetchStub } from '../helpers/fetch-stub.ts';

const KEY = '38b1460a-5104-4067-a91d-77b872934d51';
const INSTANCE_ID = '9c1b0ee6-2b3f-4a53-9a9f-1d7ba4a5a0d4';
const EXPECTATION = { storeId: 76833 };

const META = {
  store_id: 76833,
  order_id: 11,
  order_item_id: 12,
  product_id: 1030025,
  product_name: 'Pro',
  variant_id: 1615641,
  variant_name: 'Pro (Monthly)',
  customer_id: 7,
  customer_name: 'Example User',
  customer_email: 'user@example.com',
};

const LICENSE = {
  id: 1,
  status: 'inactive',
  key: KEY,
  activation_limit: 5,
  activation_usage: 0,
  created_at: '2026-08-01T00:00:00.000000Z',
  expires_at: null,
  test_mode: false,
};

const INSTANCE = {
  id: INSTANCE_ID,
  name: 'MacBook Pro',
  created_at: '2026-08-02T00:00:00.000000Z',
};

describe('lemon-squeezy validateLicenseKey', () => {
  it('posts a form-encoded body without any credential', async () => {
    const stub = createFetchStub(() => ({
      json: { valid: true, error: null, license_key: LICENSE, meta: META },
    }));
    const validation = await validateLicenseKey({
      key: KEY,
      expect: EXPECTATION,
      fetch: stub.fetch,
    });
    const request = stub.requests[0]!;
    expect(request.method).toBe('POST');
    expect(request.url).toBe('https://api.lemonsqueezy.com/v1/licenses/validate');
    expect(request.headers['content-type']).toBe('application/x-www-form-urlencoded');
    expect(request.headers['accept']).toBe('application/json');
    // The license API needs no secret; sending one would push merchant keys into client apps.
    expect(request.headers['authorization']).toBeUndefined();
    expect(request.body).toBe(`license_key=${KEY}`);
    expect(validation.valid).toBe(true);
    expect(validation.licenseKey).toMatchObject({
      id: '1',
      key: KEY,
      // `inactive` only means "never activated".
      status: 'active',
      activationLimit: 5,
      activationCount: 0,
      customerId: '7',
      // The unified product is the Lemon Squeezy variant, not `meta.product_id`.
      productId: '1615641',
    });
    expect(validation.licenseKey?.expiresAt).toBeUndefined();
    expect(validation.activation).toBeUndefined();
  });

  it('sends instance_id and maps the matched activation', async () => {
    const stub = createFetchStub(() => ({
      json: { valid: true, error: null, license_key: LICENSE, instance: INSTANCE, meta: META },
    }));
    const validation = await validateLicenseKey({
      key: KEY,
      expect: EXPECTATION,
      activationId: INSTANCE_ID,
      fetch: stub.fetch,
    });
    expect(stub.requests[0]!.body).toBe(`license_key=${KEY}&instance_id=${INSTANCE_ID}`);
    expect(validation.activation).toMatchObject({ id: INSTANCE_ID, label: 'MacBook Pro' });
    expect(validation.activation?.createdAt).toEqual(new Date('2026-08-02T00:00:00.000000Z'));
  });

  it('rejects a key from another store even though Lemon Squeezy calls it valid', async () => {
    const stub = createFetchStub(() => ({
      json: {
        valid: true,
        error: null,
        license_key: LICENSE,
        meta: { ...META, store_id: 99999 },
      },
    }));
    const validation = await validateLicenseKey({
      key: KEY,
      expect: EXPECTATION,
      fetch: stub.fetch,
    });
    // Without this guard any Lemon Squeezy merchant's key would unlock this product.
    expect(validation.valid).toBe(false);
    expect(validation.licenseKey).toBeUndefined();
    expect(validation.activation).toBeUndefined();
    expect(validation.raw).toMatchObject({ valid: true });
  });

  it.each([
    ['product', { productId: 999 }],
    ['variant', { variantId: 999 }],
  ])('rejects a %s mismatch', async (_name, extra) => {
    const stub = createFetchStub(() => ({
      json: { valid: true, license_key: LICENSE, meta: META },
    }));
    const validation = await validateLicenseKey({
      key: KEY,
      expect: { ...EXPECTATION, ...extra },
      fetch: stub.fetch,
    });
    expect(validation.valid).toBe(false);
    expect(validation.licenseKey).toBeUndefined();
  });

  it('accepts matching product and variant IDs given as strings', async () => {
    const stub = createFetchStub(() => ({
      json: { valid: true, license_key: LICENSE, meta: META },
    }));
    const validation = await validateLicenseKey({
      key: KEY,
      expect: { storeId: '76833', productId: '1030025', variantId: '1615641' },
      fetch: stub.fetch,
    });
    expect(validation.valid).toBe(true);
  });

  it('rejects a response without meta', async () => {
    const stub = createFetchStub(() => ({ json: { valid: true, license_key: LICENSE } }));
    const validation = await validateLicenseKey({
      key: KEY,
      expect: EXPECTATION,
      fetch: stub.fetch,
    });
    expect(validation.valid).toBe(false);
  });

  it('maps an unknown key (404 with a verdict body) to invalid without throwing', async () => {
    const stub = createFetchStub(() => ({
      status: 404,
      json: { valid: false, error: 'license_key not found.', license_key: null, meta: null },
    }));
    const validation = await validateLicenseKey({
      key: KEY,
      expect: EXPECTATION,
      fetch: stub.fetch,
    });
    expect(validation.valid).toBe(false);
    expect(validation.licenseKey).toBeUndefined();
    expect(validation.raw).toMatchObject({ error: 'license_key not found.' });
  });

  it('throws when the failure carries no verdict', async () => {
    const stub = createFetchStub(() => ({ status: 429, json: { error: 'Too many requests.' } }));
    try {
      await validateLicenseKey({ key: KEY, expect: EXPECTATION, fetch: stub.fetch });
      expect.unreachable('expected RevenueError');
    } catch (error) {
      expect(error).toBeInstanceOf(RevenueError);
      expect((error as RevenueError).code).toBe('rate_limited');
      expect((error as RevenueError).message).toBe('Too many requests.');
    }
  });

  it('threads the abort signal through to fetch', async () => {
    const stub = createFetchStub(() => ({
      json: { valid: true, license_key: LICENSE, meta: META },
    }));
    const controller = new AbortController();
    let seen: AbortSignal | null | undefined;
    const fetchImpl: typeof fetch = (input, init) => {
      seen = init?.signal;
      return stub.fetch(input, init);
    };
    await validateLicenseKey({
      key: KEY,
      expect: EXPECTATION,
      signal: controller.signal,
      fetch: fetchImpl,
    });
    expect(seen).toBe(controller.signal);
  });
});

describe('lemon-squeezy activateLicenseKey', () => {
  it('posts the instance name and maps the activation', async () => {
    const stub = createFetchStub(() => ({
      json: {
        activated: true,
        error: null,
        license_key: { ...LICENSE, status: 'active', activation_usage: 1 },
        instance: INSTANCE,
        meta: META,
      },
    }));
    const activation = await activateLicenseKey({
      key: KEY,
      label: 'MacBook Pro',
      expect: EXPECTATION,
      fetch: stub.fetch,
    });
    const request = stub.requests[0]!;
    expect(request.url).toBe('https://api.lemonsqueezy.com/v1/licenses/activate');
    expect(request.headers['authorization']).toBeUndefined();
    expect(request.body).toBe(`license_key=${KEY}&instance_name=MacBook+Pro`);
    expect(activation).toMatchObject({
      id: INSTANCE_ID,
      label: 'MacBook Pro',
      createdAt: new Date('2026-08-02T00:00:00.000000Z'),
      raw: INSTANCE,
    });
  });

  it('throws without describing an activation belonging to another store', async () => {
    const stub = createFetchStub(() => ({
      json: {
        activated: true,
        license_key: LICENSE,
        instance: INSTANCE,
        meta: { ...META, store_id: 99999 },
      },
    }));
    try {
      await activateLicenseKey({
        key: KEY,
        label: 'MacBook Pro',
        expect: EXPECTATION,
        fetch: stub.fetch,
      });
      expect.unreachable('expected RevenueError');
    } catch (error) {
      expect(error).toBeInstanceOf(RevenueError);
      expect((error as RevenueError).code).toBe('not_found');
      // A foreign key is never handed back — not even through the error.
      expect((error as RevenueError).message).not.toContain(KEY);
      expect((error as RevenueError).message).not.toContain('99999');
    }
  });

  it('throws with the provider message when the activation limit is reached', async () => {
    const stub = createFetchStub(() => ({
      status: 400,
      json: { activated: false, error: 'License key activation limit reached.' },
    }));
    try {
      await activateLicenseKey({
        key: KEY,
        label: 'MacBook Pro',
        expect: EXPECTATION,
        fetch: stub.fetch,
      });
      expect.unreachable('expected RevenueError');
    } catch (error) {
      expect(error).toBeInstanceOf(RevenueError);
      expect((error as RevenueError).code).toBe('validation');
      expect((error as RevenueError).message).toBe('License key activation limit reached.');
    }
  });

  it('throws when a 2XX carries a false verdict', async () => {
    const stub = createFetchStub(() => ({
      json: { activated: false, error: 'License key has expired.', meta: META },
    }));
    try {
      await activateLicenseKey({
        key: KEY,
        label: 'MacBook Pro',
        expect: EXPECTATION,
        fetch: stub.fetch,
      });
      expect.unreachable('expected RevenueError');
    } catch (error) {
      expect(error).toBeInstanceOf(RevenueError);
      expect((error as RevenueError).code).toBe('validation');
      expect((error as RevenueError).message).toBe('License key has expired.');
    }
  });

  it('keeps the license key out of the logged error surface', async () => {
    const stub = createFetchStub(() => ({
      json: {
        activated: false,
        error: 'License key has expired.',
        license_key: LICENSE,
        meta: META,
      },
    }));
    try {
      await activateLicenseKey({
        key: KEY,
        label: 'MacBook Pro',
        expect: EXPECTATION,
        fetch: stub.fetch,
      });
      expect.unreachable('expected RevenueError');
    } catch (error) {
      const revenueError = error as RevenueError;
      // The verdict body carries the full key, so it must not ride along on `cause` — anything
      // enumerable or on `cause` ends up in `console.error` and error reporters verbatim.
      expect(revenueError.cause).toBeUndefined();
      expect(Object.keys(revenueError)).not.toContain('responseBody');
      expect(JSON.stringify(revenueError)).not.toContain(KEY);
      expect(revenueError.message).not.toContain(KEY);
      // Still reachable for a caller who asks for it.
      expect(revenueError.responseBody).toMatchObject({ license_key: { key: KEY } });
    }
  });

  it('throws when the activation carries no instance', async () => {
    const stub = createFetchStub(() => ({
      json: { activated: true, license_key: LICENSE, meta: META },
    }));
    await expect(
      activateLicenseKey({
        key: KEY,
        label: 'MacBook Pro',
        expect: EXPECTATION,
        fetch: stub.fetch,
      }),
    ).rejects.toMatchObject({ code: 'provider_error' });
  });
});

describe('lemon-squeezy deactivateLicenseKey', () => {
  it('posts the instance id and resolves', async () => {
    const stub = createFetchStub(() => ({
      json: { deactivated: true, error: null, license_key: LICENSE, meta: META },
    }));
    await expect(
      deactivateLicenseKey({
        key: KEY,
        activationId: INSTANCE_ID,
        expect: EXPECTATION,
        fetch: stub.fetch,
      }),
    ).resolves.toBeUndefined();
    const request = stub.requests[0]!;
    expect(request.url).toBe('https://api.lemonsqueezy.com/v1/licenses/deactivate');
    expect(request.headers['content-type']).toBe('application/x-www-form-urlencoded');
    expect(request.headers['authorization']).toBeUndefined();
    expect(request.body).toBe(`license_key=${KEY}&instance_id=${INSTANCE_ID}`);
  });

  it('throws without describing a deactivation belonging to another store', async () => {
    const stub = createFetchStub(() => ({
      json: { deactivated: true, license_key: LICENSE, meta: { ...META, store_id: 99999 } },
    }));
    try {
      await deactivateLicenseKey({
        key: KEY,
        activationId: INSTANCE_ID,
        expect: EXPECTATION,
        fetch: stub.fetch,
      });
      expect.unreachable('expected RevenueError');
    } catch (error) {
      expect(error).toBeInstanceOf(RevenueError);
      expect((error as RevenueError).code).toBe('not_found');
      expect((error as RevenueError).message).not.toContain(KEY);
      expect((error as RevenueError).message).not.toContain('99999');
    }
  });

  it('throws when Lemon Squeezy reports a false verdict', async () => {
    const stub = createFetchStub(() => ({
      status: 404,
      json: { deactivated: false, error: 'license_key_instance not found.' },
    }));
    try {
      await deactivateLicenseKey({
        key: KEY,
        activationId: INSTANCE_ID,
        expect: EXPECTATION,
        fetch: stub.fetch,
      });
      expect.unreachable('expected RevenueError');
    } catch (error) {
      expect(error).toBeInstanceOf(RevenueError);
      expect((error as RevenueError).code).toBe('not_found');
      expect((error as RevenueError).message).toBe('license_key_instance not found.');
    }
  });

  it('honors a custom base URL', async () => {
    const stub = createFetchStub(() => ({
      json: { deactivated: true, license_key: LICENSE, meta: META },
    }));
    await deactivateLicenseKey({
      key: KEY,
      activationId: INSTANCE_ID,
      expect: EXPECTATION,
      baseUrl: 'https://mock.example.com',
      fetch: stub.fetch,
    });
    expect(stub.requests[0]!.url).toBe('https://mock.example.com/v1/licenses/deactivate');
  });
});
