import { describe, expect, it } from 'vitest';
import { RevenueError } from '../../src/errors.ts';
import {
  activateLicenseKey,
  deactivateLicenseKey,
  validateLicenseKey,
} from '../../src/providers/dodo-payments/licenses.ts';
import { createFetchStub, type StubHandler } from '../helpers/fetch-stub.ts';

const KEY = 'a1b2c3d4-0000-4000-8000-000000000000';

function setup(handler: StubHandler) {
  return createFetchStub(handler);
}

describe('dodo-payments validateLicenseKey', () => {
  it('posts JSON to /licenses/validate without an Authorization header', async () => {
    const stub = setup(() => ({ json: { valid: true } }));
    const validation = await validateLicenseKey({ key: KEY, fetch: stub.fetch });
    const request = stub.requests[0]!;
    expect(request.method).toBe('POST');
    expect(request.url).toBe('https://live.dodopayments.com/licenses/validate');
    expect(request.headers['content-type']).toBe('application/json');
    // The public routes take no credential; sending one would push merchants to ship API keys.
    expect(request.headers['authorization']).toBeUndefined();
    expect(JSON.parse(request.body!)).toEqual({ license_key: KEY });
    expect(validation.valid).toBe(true);
  });

  it('leaves licenseKey undefined because the response carries only a boolean', async () => {
    const stub = setup(() => ({ json: { valid: true } }));
    const validation = await validateLicenseKey({ key: KEY, fetch: stub.fetch });
    expect(validation.licenseKey).toBeUndefined();
    expect(validation.activation).toBeUndefined();
    expect(validation.raw).toEqual({ valid: true });
  });

  it('narrows the check to an activation', async () => {
    const stub = setup(() => ({ json: { valid: true } }));
    await validateLicenseKey({ key: KEY, activationId: 'lki_1', fetch: stub.fetch });
    expect(JSON.parse(stub.requests[0]!.body!)).toEqual({
      license_key: KEY,
      license_key_instance_id: 'lki_1',
    });
  });

  it('reports an invalid key as valid: false', async () => {
    const stub = setup(() => ({ json: { valid: false } }));
    const validation = await validateLicenseKey({ key: 'unknown', fetch: stub.fetch });
    expect(validation.valid).toBe(false);
  });

  it('treats a 404 as valid: false instead of throwing', async () => {
    const stub = setup(() => ({ status: 404, json: { code: 'NOT_FOUND', message: 'Not found' } }));
    const validation = await validateLicenseKey({ key: 'unknown', fetch: stub.fetch });
    expect(validation.valid).toBe(false);
    expect(validation.raw).toEqual({ code: 'NOT_FOUND', message: 'Not found' });
  });

  it('still surfaces other failures as RevenueError', async () => {
    const stub = setup(() => ({ status: 429, json: { message: 'Too many requests' } }));
    await expect(validateLicenseKey({ key: KEY, fetch: stub.fetch })).rejects.toBeInstanceOf(
      RevenueError,
    );
  });

  it('uses the test host when configured', async () => {
    const stub = setup(() => ({ json: { valid: true } }));
    await validateLicenseKey({ key: KEY, server: 'test', fetch: stub.fetch });
    expect(stub.requests[0]!.url).toBe('https://test.dodopayments.com/licenses/validate');
  });
});

describe('dodo-payments activateLicenseKey', () => {
  it('posts the key and instance name and maps the activation', async () => {
    const stub = setup(() => ({
      status: 201,
      json: {
        id: 'lki_1',
        business_id: 'bus_1',
        created_at: '2026-08-06T10:00:00Z',
        customer: { customer_id: 'cus_1' },
        license_key_id: 'lic_1',
        name: 'MacBook Pro',
        product: { product_id: 'pdt_1', name: 'Pro' },
      },
    }));
    const activation = await activateLicenseKey({
      key: KEY,
      label: 'MacBook Pro',
      fetch: stub.fetch,
    });
    const request = stub.requests[0]!;
    expect(request.method).toBe('POST');
    expect(request.url).toBe('https://live.dodopayments.com/licenses/activate');
    expect(request.headers['authorization']).toBeUndefined();
    expect(JSON.parse(request.body!)).toEqual({ license_key: KEY, name: 'MacBook Pro' });
    expect(activation).toMatchObject({ id: 'lki_1', label: 'MacBook Pro' });
    expect(activation.createdAt).toEqual(new Date('2026-08-06T10:00:00Z'));
  });

  it('maps an unknown key onto not_found', async () => {
    const stub = setup(() => ({
      status: 404,
      json: { code: 'NOT_FOUND', message: 'License key not found' },
    }));
    try {
      await activateLicenseKey({ key: 'unknown', label: 'Device', fetch: stub.fetch });
      expect.unreachable('expected RevenueError');
    } catch (error) {
      expect(error).toBeInstanceOf(RevenueError);
      expect((error as RevenueError).code).toBe('not_found');
      expect((error as RevenueError).message).toBe('NOT_FOUND: License key not found');
    }
  });

  it('redacts the license key from a message that echoes it', async () => {
    const stub = setup(() => ({
      status: 404,
      json: { code: 'NOT_FOUND', message: `License key ${KEY} not found` },
    }));
    try {
      await activateLicenseKey({ key: KEY, label: 'Device', fetch: stub.fetch });
      expect.unreachable('expected RevenueError');
    } catch (error) {
      const revenueError = error as RevenueError;
      // Dodo's `mapError` forwards the provider message verbatim.
      expect(revenueError.message).toBe('NOT_FOUND: License key [redacted] not found');
      expect(JSON.stringify(revenueError)).not.toContain(KEY);
      // Still reachable for a caller who deliberately asks for it.
      expect(revenueError.responseBody).toMatchObject({
        message: `License key ${KEY} not found`,
      });
    }
  });
});

describe('dodo-payments deactivateLicenseKey', () => {
  it('posts the activation id and tolerates the empty 200 body', async () => {
    const stub = setup(() => ({ status: 200, body: '' }));
    const result = await deactivateLicenseKey({
      key: KEY,
      activationId: 'lki_1',
      fetch: stub.fetch,
    });
    const request = stub.requests[0]!;
    expect(request.method).toBe('POST');
    expect(request.url).toBe('https://live.dodopayments.com/licenses/deactivate');
    expect(request.headers['authorization']).toBeUndefined();
    expect(JSON.parse(request.body!)).toEqual({
      license_key: KEY,
      license_key_instance_id: 'lki_1',
    });
    expect(result).toBeUndefined();
  });
});
