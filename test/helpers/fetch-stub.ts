export interface StubRequest {
  url: string;
  method: string;
  headers: Record<string, string>;
  body?: string;
}

export interface StubResponse {
  status?: number;
  headers?: Record<string, string>;
  json?: unknown;
  body?: string;
}

export type StubHandler = (request: StubRequest) => Promise<StubResponse> | StubResponse;

export function createFetchStub(handler: StubHandler): {
  fetch: typeof fetch;
  requests: StubRequest[];
} {
  const requests: StubRequest[] = [];
  const stubFetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = new Request(input, init);
    const headers: Record<string, string> = {};
    request.headers.forEach((value, key) => {
      headers[key.toLowerCase()] = value;
    });
    const body = await request.clone().text();
    const stubRequest: StubRequest = {
      url: request.url,
      method: request.method,
      headers,
      body: body === '' ? undefined : body,
    };
    requests.push(stubRequest);
    const result = await handler(stubRequest);
    const status = result.status ?? 200;
    if (status === 204 || status === 205 || status === 304) {
      return new Response(null, { status, headers: result.headers });
    }
    if (result.json !== undefined) {
      return new Response(JSON.stringify(result.json), {
        status,
        headers: { 'Content-Type': 'application/json', ...result.headers },
      });
    }
    return new Response(result.body ?? '', { status, headers: result.headers });
  }) as typeof fetch;
  return { fetch: stubFetch, requests };
}
