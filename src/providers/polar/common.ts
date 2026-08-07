import type { ProviderErrorInfo } from '../../http.ts';
import type {
  BillingInterval,
  Checkout,
  CheckoutStatus,
  Customer,
  LicenseKey,
  LicenseKeyActivation,
  LicenseKeyStatus,
  Order,
  Price,
  PriceModel,
  Product,
  Subscription,
  SubscriptionMeter,
  SubscriptionStatus,
} from '../../types.ts';
import { toDate, toMetadata } from '../shared.ts';

const PRODUCTION_BASE_URL = 'https://api.polar.sh';
const SANDBOX_BASE_URL = 'https://sandbox-api.polar.sh';

export function toBaseUrl(options: {
  server?: 'production' | 'sandbox';
  baseUrl?: string;
}): string {
  return options.baseUrl ?? (options.server === 'sandbox' ? SANDBOX_BASE_URL : PRODUCTION_BASE_URL);
}

export function mapError(status: number, body: unknown): ProviderErrorInfo {
  if (body === null || typeof body !== 'object') {
    return {};
  }
  const { error, detail } = body as { error?: unknown; detail?: unknown };
  if (typeof detail === 'string') {
    return { message: typeof error === 'string' ? `${error}: ${detail}` : detail };
  }
  return {};
}

export interface PolarListResponse<T> {
  items: T[];
  pagination: {
    total_count: number;
    max_page: number;
  };
}

interface PolarPrice {
  id: string;
  amount_type: string;
  price_amount?: number | null;
  price_currency?: string | null;
}

export interface PolarProduct {
  id: string;
  name: string;
  description?: string | null;
  recurring_interval?: BillingInterval | null;
  recurring_interval_count?: number | null;
  trial_interval?: string | null;
  trial_interval_count?: number | null;
  prices?: PolarPrice[] | null;
}

export interface PolarCheckout {
  id: string;
  status?: string | null;
  url?: string | null;
  expires_at?: string | null;
  customer_id?: string | null;
  customer_email?: string | null;
  subscription_id?: string | null;
  metadata?: Record<string, unknown> | null;
}

export interface PolarCustomer {
  id: string;
  email: string;
  name?: string | null;
  created_at?: string | null;
  metadata?: Record<string, unknown> | null;
}

interface PolarSubscriptionMeter {
  meter_id: string;
  meter: { name: string };
  consumed_units: number;
  credited_units: number;
  amount: number;
}

export interface PolarSubscription {
  id: string;
  status: string;
  cancel_at_period_end?: boolean | null;
  pause_at_period_end?: boolean | null;
  customer_id: string;
  product_id?: string | null;
  amount?: number | null;
  currency?: string | null;
  recurring_interval?: BillingInterval | null;
  recurring_interval_count?: number | null;
  current_period_start?: string | null;
  current_period_end?: string | null;
  trial_end?: string | null;
  resumes_at?: string | null;
  started_at?: string | null;
  ends_at?: string | null;
  ended_at?: string | null;
  meters?: PolarSubscriptionMeter[] | null;
  metadata?: Record<string, unknown> | null;
}

export interface PolarLicenseKeyActivation {
  id: string;
  label: string;
  created_at: string;
}

export interface PolarLicenseKey {
  id: string;
  key: string;
  status: string;
  customer_id: string;
  limit_activations?: number | null;
  expires_at?: string | null;
  /** Only returned when reading a single key; list responses omit it. */
  activations?: PolarLicenseKeyActivation[];
}

export interface PolarOrder {
  id: string;
  total_amount?: number | null;
  currency?: string | null;
  customer_id?: string | null;
  customer?: { email?: string | null } | null;
  subscription_id?: string | null;
  metadata?: Record<string, unknown> | null;
}

function toPriceModel(amountType: string): PriceModel {
  switch (amountType) {
    case 'fixed':
      return 'fixed';
    case 'custom':
      return 'custom';
    case 'metered_unit':
      return 'metered';
    case 'seat_based':
      return 'seat_based';
    default:
      return 'custom';
  }
}

function toTrialDays(interval: string | null | undefined, count: number | null | undefined) {
  if (!interval || !count) {
    return undefined;
  }
  // Month- and year-based trials have no exact day count; read them from `raw` instead.
  if (interval === 'day') {
    return count;
  }
  if (interval === 'week') {
    return count * 7;
  }
  return undefined;
}

function toPrice(price: PolarPrice, product: PolarProduct): Price {
  const model = toPriceModel(price.amount_type);
  return {
    id: price.id,
    checkoutRef: product.id,
    type: product.recurring_interval ? 'recurring' : 'one_time',
    model,
    amount: model === 'fixed' ? (price.price_amount ?? null) : null,
    currency: price.price_currency ?? 'usd',
    interval: product.recurring_interval ?? undefined,
    intervalCount: product.recurring_interval_count ?? undefined,
    trialDays: toTrialDays(product.trial_interval, product.trial_interval_count),
    raw: price,
  };
}

export function toProduct(product: PolarProduct): Product {
  return {
    id: product.id,
    name: product.name,
    description: product.description ?? undefined,
    prices: (product.prices ?? []).map((price) => toPrice(price, product)),
    raw: product,
  };
}

function toCheckoutStatus(status: string | null | undefined): CheckoutStatus {
  switch (status) {
    case 'succeeded':
      return 'complete';
    case 'expired':
    case 'failed':
      return 'expired';
    default:
      return 'open';
  }
}

export function toCheckout(checkout: PolarCheckout): Checkout {
  return {
    id: checkout.id,
    url: checkout.url ?? '',
    status: toCheckoutStatus(checkout.status),
    customerId: checkout.customer_id ?? undefined,
    customerEmail: checkout.customer_email ?? undefined,
    subscriptionId: checkout.subscription_id ?? undefined,
    metadata: toMetadata(checkout.metadata),
    expiresAt: toDate(checkout.expires_at),
    raw: checkout,
  };
}

export function toCustomer(customer: PolarCustomer): Customer {
  return {
    id: customer.id,
    email: customer.email,
    name: customer.name ?? undefined,
    metadata: toMetadata(customer.metadata),
    createdAt: toDate(customer.created_at),
    raw: customer,
  };
}

function toSubscriptionStatus(status: string): SubscriptionStatus {
  switch (status) {
    case 'incomplete':
      return 'incomplete';
    case 'incomplete_expired':
      return 'canceled';
    case 'trialing':
      return 'trialing';
    case 'past_due':
      return 'past_due';
    case 'canceled':
      return 'canceled';
    case 'unpaid':
      return 'unpaid';
    case 'paused':
      return 'paused';
    default:
      return 'active';
  }
}

function toSubscriptionMeter(meter: PolarSubscriptionMeter): SubscriptionMeter {
  return {
    // `meter_id` identifies the meter; the entry's own `id` is the per-subscription row.
    id: meter.meter_id,
    name: meter.meter.name,
    consumedUnits: meter.consumed_units,
    creditedUnits: meter.credited_units,
    amount: meter.amount,
    raw: meter,
  };
}

export function toSubscription(subscription: PolarSubscription): Subscription {
  return {
    id: subscription.id,
    status: toSubscriptionStatus(subscription.status),
    cancelAtPeriodEnd: subscription.cancel_at_period_end ?? false,
    pauseAtPeriodEnd: subscription.pause_at_period_end ?? false,
    customerId: String(subscription.customer_id),
    productId: subscription.product_id ?? undefined,
    amount: subscription.amount ?? undefined,
    currency: subscription.currency ?? undefined,
    interval: subscription.recurring_interval ?? undefined,
    intervalCount: subscription.recurring_interval_count ?? undefined,
    currentPeriodStart: toDate(subscription.current_period_start),
    currentPeriodEnd: toDate(subscription.current_period_end),
    trialEndsAt: toDate(subscription.trial_end),
    resumesAt: toDate(subscription.resumes_at),
    startedAt: toDate(subscription.started_at),
    endsAt: toDate(subscription.ends_at),
    endedAt: toDate(subscription.ended_at),
    meters: subscription.meters?.map(toSubscriptionMeter),
    metadata: toMetadata(subscription.metadata),
    raw: subscription,
  };
}

export function toOrder(order: PolarOrder): Order {
  return {
    id: order.id,
    amount: order.total_amount ?? undefined,
    currency: order.currency ?? undefined,
    customerId: order.customer_id ?? undefined,
    customerEmail: order.customer?.email ?? undefined,
    subscriptionId: order.subscription_id ?? undefined,
    metadata: toMetadata(order.metadata),
    raw: order,
  };
}

function toLicenseKeyStatus(status: string, expiresAt: Date | undefined): LicenseKeyStatus {
  // `revoked` is set by Polar when the granting benefit is revoked; `disabled` is the
  // merchant's own switch. Both mean the key no longer validates.
  if (status !== 'granted') {
    return 'disabled';
  }
  // Polar has no `expired` status — expiry lives only in `expires_at`. The derivation uses the
  // local clock, but Polar rejects expired keys server-side, so validation stays authoritative.
  return expiresAt !== undefined && expiresAt.getTime() <= Date.now() ? 'expired' : 'active';
}

export function toLicenseKey(licenseKey: PolarLicenseKey): LicenseKey {
  const expiresAt = toDate(licenseKey.expires_at);
  return {
    id: licenseKey.id,
    key: licenseKey.key,
    status: toLicenseKeyStatus(licenseKey.status, expiresAt),
    activationLimit: licenseKey.limit_activations ?? undefined,
    activationCount: licenseKey.activations?.length,
    expiresAt,
    customerId: licenseKey.customer_id,
    // `productId` stays unset: a Polar key hangs off a benefit, not a product (`benefit_id` in `raw`).
    raw: licenseKey,
  };
}

export function toLicenseKeyActivation(
  activation: PolarLicenseKeyActivation,
): LicenseKeyActivation {
  return {
    id: activation.id,
    label: activation.label,
    createdAt: toDate(activation.created_at),
    raw: activation,
  };
}
