import { describe, expect, it } from 'vitest';
import { RevenueError } from '../../src/errors.ts';
import { HttpClient, codeFromStatus, type HttpClientOptions } from '../../src/http.ts';
import { createFetchStub, type StubHandler } from '../helpers/fetch-stub.ts';

function setup(handler: StubHandler, overrides: Partial<HttpClientOptions> = {}) {
  const stub = createFetchStub(handler);
  const http = new HttpClient({
    provider: 'polar',
    baseUrl: 'https://api.example.com',
    fetchImpl: stub.fetch,
    authHeaders: () => ({ Authorization: 'Bearer token-123' }),
    ...overrides,
  });
  return { http, stub };
}

async function expectRevenueError(promise: Promise<unknown>, code: string): Promise<RevenueError> {
  try {
    await promise;
    expect.unreachable('expected RevenueError');
  } catch (error) {
    expect(error).toBeInstanceOf(RevenueError);
    expect((error as RevenueError).code).toBe(code);
    return error as RevenueError;
  }
  throw new Error('unreachable');
}

describe('HttpClient', () => {
  it('sends auth, default, and user-agent headers', async () => {
    const { http, stub } = setup(() => ({ json: {} }), {
      defaultHeaders: { Accept: 'application/json' },
    });
    await http.json('/v1/products/');
    const request = stub.requests[0]!;
    expect(request.headers['authorization']).toBe('Bearer token-123');
    expect(request.headers['accept']).toBe('application/json');
    expect(request.headers['user-agent']).toBe('revenue-sdk');
  });

  it('preserves trailing slashes in paths', async () => {
    const { http, stub } = setup(() => ({ json: {} }));
    await http.json('/v1/checkouts/');
    expect(stub.requests[0]!.url).toBe('https://api.example.com/v1/checkouts/');
  });

  it('builds query strings, skipping undefined and repeating arrays', async () => {
    const { http, stub } = setup(() => ({ json: {} }));
    await http.json('/v1/subscriptions/', {
      query: { page: 2, active: true, skip: undefined, status: ['active', 'trialing'] },
    });
    expect(stub.requests[0]!.url).toBe(
      'https://api.example.com/v1/subscriptions/?page=2&active=true&status=active&status=trialing',
    );
  });

  it('serializes JSON bodies with a JSON content type', async () => {
    const { http, stub } = setup(() => ({ json: {} }));
    await http.json('/v1/checkouts/', { method: 'POST', body: { products: ['p1'] } });
    const request = stub.requests[0]!;
    expect(request.method).toBe('POST');
    expect(request.headers['content-type']).toBe('application/json');
    expect(request.body).toBe('{"products":["p1"]}');
  });

  it('sends form bodies with a form content type', async () => {
    const { http, stub } = setup(() => ({ json: {} }));
    const form = new URLSearchParams();
    form.append('mode', 'subscription');
    form.append('line_items[0][price]', 'price_1');
    await http.json('/v1/checkout/sessions', { method: 'POST', form });
    const request = stub.requests[0]!;
    expect(request.headers['content-type']).toBe('application/x-www-form-urlencoded');
    expect(request.body).toBe('mode=subscription&line_items%5B0%5D%5Bprice%5D=price_1');
  });

  it('returns undefined data for 204 responses and empty bodies', async () => {
    const { http } = setup(() => ({ status: 204 }));
    const { data } = await http.json('/v1/subscriptions/sub_1');
    expect(data).toBeUndefined();
    const { http: emptyHttp } = setup(() => ({ status: 200, body: '' }));
    const { data: emptyData } = await emptyHttp.json('/v1/change-plan', { method: 'POST' });
    expect(emptyData).toBeUndefined();
  });

  it('maps HTTP status codes to error codes', async () => {
    const { http } = setup(() => ({ status: 404, json: { error: 'ResourceNotFound' } }));
    const error = await expectRevenueError(http.json('/v1/products/p1'), 'not_found');
    expect(error.status).toBe(404);
    expect(error.provider).toBe('polar');
    expect(error.responseBody).toEqual({ error: 'ResourceNotFound' });
    // The body is not a JS error, so it never occupies `cause`, and it stays out of logs.
    expect(error.cause).toBeUndefined();
    expect(JSON.stringify(error)).not.toContain('ResourceNotFound');
  });

  it('lets mapError override code and message', async () => {
    const { http } = setup(() => ({ status: 403, json: { code: 'UNAUTHORIZED' } }), {
      mapError: (status, body) => {
        const code = (body as { code?: string }).code;
        return code === 'UNAUTHORIZED' ? { code: 'unauthorized', message: 'API key rejected' } : {};
      },
    });
    const error = await expectRevenueError(http.json('/v1/products'), 'unauthorized');
    expect(error.message).toBe('API key rejected');
  });

  it('parses retry-after on rate limits', async () => {
    const { http } = setup(() => ({ status: 429, headers: { 'Retry-After': '17' }, body: '' }));
    const error = await expectRevenueError(http.json('/v1/products/'), 'rate_limited');
    expect(error.retryAfter).toBe(17);
    expect(error.retryable).toBe(true);
  });

  it('wraps network failures', async () => {
    const failingFetch = (() => Promise.reject(new TypeError('fetch failed'))) as typeof fetch;
    const http = new HttpClient({
      provider: 'polar',
      baseUrl: 'https://api.example.com',
      fetchImpl: failingFetch,
      authHeaders: () => ({}),
    });
    const error = await expectRevenueError(http.json('/v1/products/'), 'network_error');
    expect(error.cause).toBeInstanceOf(TypeError);
  });

  it('redacts secrets from error messages', async () => {
    const { http } = setup(() => ({ status: 400, body: '' }), {
      mapError: () => ({ message: 'invalid key token-123 provided' }),
      secrets: () => ['token-123'],
    });
    const error = await expectRevenueError(http.json('/v1/products/'), 'validation');
    expect(error.message).toBe('invalid key [redacted] provided');
  });

  it('throws provider_error on invalid JSON success responses', async () => {
    const { http } = setup(() => ({ status: 200, body: '<html>oops</html>' }));
    await expectRevenueError(http.json('/v1/products/'), 'provider_error');
  });
});

describe('codeFromStatus', () => {
  it('maps the full status table', () => {
    expect(codeFromStatus(400)).toBe('validation');
    expect(codeFromStatus(401)).toBe('unauthorized');
    expect(codeFromStatus(402)).toBe('payment_required');
    expect(codeFromStatus(403)).toBe('forbidden');
    expect(codeFromStatus(404)).toBe('not_found');
    expect(codeFromStatus(409)).toBe('conflict');
    expect(codeFromStatus(410)).toBe('not_found');
    expect(codeFromStatus(412)).toBe('conflict');
    expect(codeFromStatus(422)).toBe('validation');
    expect(codeFromStatus(429)).toBe('rate_limited');
    expect(codeFromStatus(500)).toBe('provider_error');
  });
});
