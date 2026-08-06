import { describe, expect, it } from 'vitest';
import { RevenueError } from '../../src/errors.ts';
import {
  activateLicenseKey,
  deactivateLicenseKey,
  validateLicenseKey,
} from '../../src/providers/polar/licenses.ts';
import { createFetchStub, type StubHandler } from '../helpers/fetch-stub.ts';

const ORGANIZATION_ID = 'org-uuid-1';
const KEY = 'POLAR-TEST-KEY-0001';

const ACTIVATION = {
  id: 'act-uuid-1',
  license_key_id: 'lk-uuid-1',
  label: 'MacBook Pro',
  meta: {},
  created_at: '2026-08-01T00:00:00Z',
  modified_at: null,
};

const LICENSE_KEY = {
  id: 'lk-uuid-1',
  organization_id: ORGANIZATION_ID,
  customer_id: 'cus-uuid-1',
  benefit_id: 'ben-uuid-1',
  key: KEY,
  display_key: '****-0001',
  status: 'granted',
  limit_activations: 3,
  usage: 0,
  limit_usage: null,
  validations: 1,
  last_validated_at: '2026-08-06T00:00:00Z',
  expires_at: '2027-01-01T00:00:00Z',
  created_at: '2026-08-01T00:00:00Z',
  modified_at: null,
};

const NOT_FOUND = { error: 'ResourceNotFound', detail: 'License key has expired.' };

function setup(handler: StubHandler) {
  const stub = createFetchStub(handler);
  return { stub, connection: { organizationId: ORGANIZATION_ID, fetch: stub.fetch } };
}

describe('polar validateLicenseKey', () => {
  it('posts to the public route without an Authorization header and maps the key', async () => {
    const { stub, connection } = setup(() => ({ json: LICENSE_KEY }));
    const validation = await validateLicenseKey({ ...connection, key: KEY });
    const request = stub.requests[0]!;
    expect(request.method).toBe('POST');
    expect(request.url).toBe('https://api.polar.sh/v1/customer-portal/license-keys/validate');
    expect(request.headers['authorization']).toBeUndefined();
    expect(JSON.parse(request.body!)).toEqual({ key: KEY, organization_id: ORGANIZATION_ID });
    expect(validation.valid).toBe(true);
    expect(validation.activation).toBeUndefined();
    expect(validation.licenseKey).toMatchObject({
      id: 'lk-uuid-1',
      key: KEY,
      status: 'active',
      activationLimit: 3,
      customerId: 'cus-uuid-1',
      expiresAt: new Date('2027-01-01T00:00:00Z'),
    });
    expect(validation.licenseKey!.activationCount).toBeUndefined();
  });

  it('sends the activation id and maps the matched activation', async () => {
    const { stub, connection } = setup(() => ({
      json: { ...LICENSE_KEY, activation: ACTIVATION },
    }));
    const validation = await validateLicenseKey({
      ...connection,
      key: KEY,
      activationId: 'act-uuid-1',
    });
    expect(JSON.parse(stub.requests[0]!.body!)).toEqual({
      key: KEY,
      organization_id: ORGANIZATION_ID,
      activation_id: 'act-uuid-1',
    });
    expect(validation.activation).toMatchObject({
      id: 'act-uuid-1',
      label: 'MacBook Pro',
      createdAt: new Date('2026-08-01T00:00:00Z'),
    });
  });

  it('reports a 404 as an invalid key instead of throwing', async () => {
    const { connection } = setup(() => ({ status: 404, json: NOT_FOUND }));
    const validation = await validateLicenseKey({ ...connection, key: KEY });
    expect(validation.valid).toBe(false);
    expect(validation.licenseKey).toBeUndefined();
    expect(validation.raw).toEqual(NOT_FOUND);
  });

  it('still throws on other error statuses', async () => {
    const { connection } = setup(() => ({ status: 422, json: { detail: 'Invalid payload.' } }));
    await expect(validateLicenseKey({ ...connection, key: KEY })).rejects.toBeInstanceOf(
      RevenueError,
    );
  });

  it('uses the sandbox host when configured', async () => {
    const { stub, connection } = setup(() => ({ json: LICENSE_KEY }));
    await validateLicenseKey({ ...connection, key: KEY, server: 'sandbox' });
    expect(stub.requests[0]!.url).toBe(
      'https://sandbox-api.polar.sh/v1/customer-portal/license-keys/validate',
    );
  });

  it('derives the expired status from expires_at', async () => {
    const { connection } = setup(() => ({
      json: { ...LICENSE_KEY, expires_at: '2020-01-01T00:00:00Z' },
    }));
    const validation = await validateLicenseKey({ ...connection, key: KEY });
    expect(validation.licenseKey!.status).toBe('expired');
  });
});

describe('polar activateLicenseKey', () => {
  it('posts the label without an Authorization header and maps the activation', async () => {
    const { stub, connection } = setup(() => ({ json: ACTIVATION }));
    const activation = await activateLicenseKey({
      ...connection,
      key: KEY,
      label: 'MacBook Pro',
    });
    const request = stub.requests[0]!;
    expect(request.method).toBe('POST');
    expect(request.url).toBe('https://api.polar.sh/v1/customer-portal/license-keys/activate');
    expect(request.headers['authorization']).toBeUndefined();
    expect(JSON.parse(request.body!)).toEqual({
      key: KEY,
      organization_id: ORGANIZATION_ID,
      label: 'MacBook Pro',
    });
    expect(activation).toMatchObject({
      id: 'act-uuid-1',
      label: 'MacBook Pro',
      createdAt: new Date('2026-08-01T00:00:00Z'),
    });
  });

  it('throws forbidden when the activation limit is reached', async () => {
    const { connection } = setup(() => ({
      status: 403,
      json: { error: 'NotPermitted', detail: 'License key activation limit already reached' },
    }));
    try {
      await activateLicenseKey({ ...connection, key: KEY, label: 'MacBook Pro' });
      expect.unreachable('expected RevenueError');
    } catch (error) {
      expect(error).toBeInstanceOf(RevenueError);
      expect((error as RevenueError).code).toBe('forbidden');
      expect((error as RevenueError).message).toBe(
        'NotPermitted: License key activation limit already reached',
      );
    }
  });
});

describe('polar deactivateLicenseKey', () => {
  it('posts the activation id without an Authorization header and tolerates 204', async () => {
    const { stub, connection } = setup(() => ({ status: 204 }));
    await expect(
      deactivateLicenseKey({ ...connection, key: KEY, activationId: 'act-uuid-1' }),
    ).resolves.toBeUndefined();
    const request = stub.requests[0]!;
    expect(request.method).toBe('POST');
    expect(request.url).toBe('https://api.polar.sh/v1/customer-portal/license-keys/deactivate');
    expect(request.headers['authorization']).toBeUndefined();
    expect(JSON.parse(request.body!)).toEqual({
      key: KEY,
      organization_id: ORGANIZATION_ID,
      activation_id: 'act-uuid-1',
    });
  });

  it('throws when the activation does not exist', async () => {
    const { connection } = setup(() => ({ status: 404, json: NOT_FOUND }));
    await expect(
      deactivateLicenseKey({ ...connection, key: KEY, activationId: 'missing' }),
    ).rejects.toBeInstanceOf(RevenueError);
  });
});
