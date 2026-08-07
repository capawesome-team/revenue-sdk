import type { ProviderName } from './types.ts';

export type RevenueErrorCode =
  | 'conflict'
  | 'forbidden'
  | 'network_error'
  | 'not_found'
  | 'payment_required'
  | 'provider_error'
  | 'rate_limited'
  | 'unauthorized'
  | 'unsupported'
  | 'validation';

export interface RevenueErrorOptions {
  code: RevenueErrorCode;
  provider?: ProviderName;
  status?: number;
  /** Seconds to wait before retrying, taken from the provider's rate-limit response. */
  retryAfter?: number;
  retryable?: boolean;
  cause?: unknown;
  /** The provider's parsed error response body. Never redacted — see `RevenueError.responseBody`. */
  responseBody?: unknown;
  /** Secret values redacted from the error message. */
  secrets?: readonly string[];
}

const RETRYABLE_CODES: ReadonlySet<RevenueErrorCode> = new Set(['network_error', 'rate_limited']);

function redactSecrets(message: string, secrets: readonly string[]): string {
  let redacted = message;
  for (const secret of secrets) {
    if (secret.length > 0) {
      redacted = redacted.split(secret).join('[redacted]');
    }
  }
  return redacted;
}

export class RevenueError extends Error {
  readonly code: RevenueErrorCode;
  readonly provider?: ProviderName;
  readonly status?: number;
  readonly retryAfter?: number;
  readonly retryable: boolean;
  /**
   * The provider's parsed error response body, kept verbatim and never redacted — it routinely
   * carries customer PII and, on the license routes, the license key itself. The property is
   * non-enumerable so it stays out of `console.error`, `util.inspect`, `JSON.stringify` and error
   * reporters, which means reading it is always a deliberate act. `declare` keeps TypeScript from
   * emitting an enumerable class field over it.
   */
  declare readonly responseBody?: unknown;

  constructor(message: string, options: RevenueErrorOptions) {
    super(redactSecrets(message, options.secrets ?? []), { cause: options.cause });
    this.name = 'RevenueError';
    this.code = options.code;
    this.provider = options.provider;
    this.status = options.status;
    this.retryAfter = options.retryAfter;
    this.retryable =
      options.retryable ??
      (RETRYABLE_CODES.has(options.code) ||
        (options.status !== undefined && options.status >= 500));
    Object.defineProperty(this, 'responseBody', {
      value: options.responseBody,
      enumerable: false,
      configurable: true,
    });
  }
}
