import { RevenueError, type RevenueErrorCode } from './errors.ts';
import type { ProviderName } from './types.ts';

const USER_AGENT = 'revenue-sdk';

export interface ProviderErrorInfo {
  code?: RevenueErrorCode;
  message?: string;
  /** Overrides the retryability derived from the code and status — see `RevenueError.retryable`. */
  retryable?: boolean;
}

export interface HttpClientOptions {
  provider: ProviderName;
  baseUrl: string;
  fetchImpl?: typeof fetch;
  authHeaders: () => Record<string, string> | Promise<Record<string, string>>;
  defaultHeaders?: Record<string, string>;
  mapError?: (status: number, body: unknown, response: Response) => ProviderErrorInfo;
  secrets?: () => readonly string[];
}

export type QueryValue =
  boolean | number | string | undefined | ReadonlyArray<boolean | number | string>;

export interface HttpRequestOptions {
  method?: string;
  query?: Record<string, QueryValue>;
  headers?: Record<string, string>;
  /** JSON request body; serialized with `JSON.stringify`. */
  body?: unknown;
  /** Form-encoded request body; takes precedence over `body`. */
  form?: URLSearchParams;
  signal?: AbortSignal;
}

export interface HttpResult<T> {
  data: T;
  response: Response;
}

export function codeFromStatus(status: number): RevenueErrorCode {
  switch (status) {
    case 400:
    case 422:
      return 'validation';
    case 401:
      return 'unauthorized';
    case 402:
      return 'payment_required';
    case 403:
      return 'forbidden';
    case 404:
    case 410:
      return 'not_found';
    case 409:
    case 412:
      return 'conflict';
    case 429:
      return 'rate_limited';
    default:
      return 'provider_error';
  }
}

function parseRetryAfter(header: string | null): number | undefined {
  if (!header) {
    return undefined;
  }
  const seconds = Number(header);
  if (Number.isFinite(seconds) && seconds >= 0) {
    return seconds;
  }
  const date = Date.parse(header);
  if (!Number.isNaN(date)) {
    return Math.max(0, Math.ceil((date - Date.now()) / 1000));
  }
  return undefined;
}

export class HttpClient {
  private readonly provider: ProviderName;
  private readonly baseUrl: string;
  private readonly fetchImpl: typeof fetch;
  private readonly authHeaders: HttpClientOptions['authHeaders'];
  private readonly defaultHeaders: Record<string, string>;
  private readonly mapError: HttpClientOptions['mapError'];
  private readonly secrets: () => readonly string[];

  constructor(options: HttpClientOptions) {
    this.provider = options.provider;
    this.baseUrl = options.baseUrl;
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.authHeaders = options.authHeaders;
    this.defaultHeaders = options.defaultHeaders ?? {};
    this.mapError = options.mapError;
    this.secrets = options.secrets ?? (() => []);
  }

  buildUrl(path: string, query?: Record<string, QueryValue>): string {
    // Paths are used verbatim; Polar's trailing slashes on collection routes are load-bearing.
    const url = /^https?:\/\//.test(path) ? new URL(path) : new URL(path, this.baseUrl);
    if (query) {
      for (const [key, value] of Object.entries(query)) {
        if (value === undefined) {
          continue;
        }
        if (Array.isArray(value)) {
          for (const entry of value) {
            url.searchParams.append(key, String(entry));
          }
        } else {
          url.searchParams.append(key, String(value));
        }
      }
    }
    return url.toString();
  }

  async raw(path: string, options: HttpRequestOptions = {}): Promise<Response> {
    const url = this.buildUrl(path, options.query);
    const headers: Record<string, string> = {
      ...this.defaultHeaders,
      ...(await this.authHeaders()),
      ...options.headers,
    };
    headers['User-Agent'] ??= USER_AGENT;
    let body: BodyInit | undefined;
    if (options.form !== undefined) {
      body = options.form;
      headers['Content-Type'] ??= 'application/x-www-form-urlencoded';
    } else if (options.body !== undefined) {
      body = JSON.stringify(options.body);
      headers['Content-Type'] ??= 'application/json';
    }
    const { fetchImpl } = this;
    let response: Response;
    try {
      response = await fetchImpl(url, {
        method: options.method ?? 'GET',
        headers,
        body,
        signal: options.signal,
      });
    } catch (error) {
      if (error instanceof Error && error.name === 'AbortError') {
        throw error;
      }
      throw new RevenueError(`Network request to ${this.provider} failed`, {
        code: 'network_error',
        provider: this.provider,
        cause: error,
        secrets: this.secrets(),
      });
    }
    if (!response.ok) {
      throw await this.toError(response);
    }
    return response;
  }

  async json<T>(path: string, options: HttpRequestOptions = {}): Promise<HttpResult<T>> {
    const response = await this.raw(path, options);
    if (response.status === 204 || response.status === 205) {
      return { data: undefined as T, response };
    }
    const text = await response.text();
    if (text === '') {
      return { data: undefined as T, response };
    }
    try {
      return { data: JSON.parse(text) as T, response };
    } catch (error) {
      throw new RevenueError(`Received invalid JSON from ${this.provider}`, {
        code: 'provider_error',
        provider: this.provider,
        status: response.status,
        cause: error,
        secrets: this.secrets(),
      });
    }
  }

  private async toError(response: Response): Promise<RevenueError> {
    const text = await response.text().catch(() => '');
    let body: unknown;
    try {
      body = JSON.parse(text);
    } catch {
      body = text;
    }
    const info = this.mapError?.(response.status, body, response) ?? {};
    const code = info.code ?? codeFromStatus(response.status);
    const message =
      info.message ?? `${this.provider} request failed with status ${response.status}`;
    return new RevenueError(message, {
      code,
      provider: this.provider,
      status: response.status,
      retryAfter: parseRetryAfter(response.headers.get('retry-after')),
      retryable: info.retryable,
      responseBody: body,
      secrets: this.secrets(),
    });
  }
}
