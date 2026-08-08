import { RevenueError } from '../errors.ts';
import type { Metadata, ProviderName, ReportUsageParams } from '../types.ts';

const PROVIDER_DISPLAY_NAMES: Record<ProviderName, string> = {
  'dodo-payments': 'Dodo Payments',
  'lemon-squeezy': 'Lemon Squeezy',
  paddle: 'Paddle',
  polar: 'Polar',
  stripe: 'Stripe',
  testing: 'Testing',
};

export function unsupported(provider: ProviderName, feature: string): RevenueError {
  return new RevenueError(`${PROVIDER_DISPLAY_NAMES[provider]} does not support ${feature}`, {
    code: 'unsupported',
    provider,
  });
}

/**
 * Fails a factory on a missing credential instead of letting it reach the provider as
 * `Bearer undefined`. Only the names of the missing options are reported — never their values.
 */
export function requireOptions(provider: ProviderName, options: Record<string, unknown>): void {
  const missing = Object.entries(options)
    .filter(([, value]) => !isProvided(value))
    .map(([name]) => name);
  if (missing.length === 0) {
    return;
  }
  const suffix = missing.length > 1 ? 'options' : 'option';
  throw new RevenueError(
    `The ${PROVIDER_DISPLAY_NAMES[provider]} provider requires the ${missing.join(', ')} ${suffix}`,
    { code: 'validation', provider },
  );
}

function isProvided(value: unknown): boolean {
  if (value === undefined || value === null) {
    return false;
  }
  return typeof value !== 'string' || value.trim() !== '';
}

export function toDate(value: string | null | undefined): Date | undefined {
  if (!value) {
    return undefined;
  }
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? undefined : date;
}

export function fromUnixSeconds(value: number | null | undefined): Date | undefined {
  // `typeof NaN === 'number'`, so guard on finiteness: an out-of-range or non-finite timestamp must
  // read as absent rather than reaching a model as an Invalid Date.
  if (!Number.isFinite(value)) {
    return undefined;
  }
  const date = new Date((value as number) * 1000);
  return Number.isNaN(date.getTime()) ? undefined : date;
}

/** Folds the `value` shorthand into the event properties; an explicit `value` wins over `metadata.value`. */
export function toUsagePayload(params: ReportUsageParams): Metadata | undefined {
  if (params.value === undefined) {
    return params.metadata;
  }
  return { ...params.metadata, value: params.value };
}

export function toMetadata(value: unknown): Metadata | undefined {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return undefined;
  }
  const entries = Object.entries(value as Record<string, unknown>).filter(
    ([, entry]) =>
      typeof entry === 'string' || typeof entry === 'number' || typeof entry === 'boolean',
  );
  if (entries.length === 0) {
    return undefined;
  }
  return Object.fromEntries(entries) as Metadata;
}
