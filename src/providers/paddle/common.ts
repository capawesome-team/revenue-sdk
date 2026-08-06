import type {
  BillingInterval,
  Checkout,
  CheckoutStatus,
  Customer,
  Order,
  Price,
  Product,
  Subscription,
  SubscriptionStatus,
} from '../../types.ts';
import { toDate, toMetadata } from '../shared.ts';

export interface PaddleResponse<T> {
  data: T;
}

export interface PaddleListResponse<T> {
  data: T[];
  meta?: {
    pagination?: {
      next?: string | null;
      has_more?: boolean;
    };
  };
}

interface PaddleMoney {
  /** String integer in the currency's lowest denomination, e.g. `"2499"`. */
  amount: string;
  currency_code: string;
}

interface PaddleBillingCycle {
  interval: BillingInterval;
  frequency: number;
}

export interface PaddlePrice {
  id: string;
  product_id?: string;
  name?: string | null;
  billing_cycle?: PaddleBillingCycle | null;
  trial_period?: PaddleBillingCycle | null;
  unit_price?: PaddleMoney | null;
}

export interface PaddleProduct {
  id: string;
  name: string;
  description?: string | null;
  prices?: PaddlePrice[] | null;
}

export interface PaddleTransaction {
  id: string;
  status?: string | null;
  customer_id?: string | null;
  subscription_id?: string | null;
  currency_code?: string | null;
  custom_data?: Record<string, unknown> | null;
  checkout?: { url?: string | null } | null;
  details?: {
    totals?: {
      total?: string | null;
      grand_total?: string | null;
    } | null;
  } | null;
}

export interface PaddleCustomer {
  id: string;
  email: string;
  name?: string | null;
  custom_data?: Record<string, unknown> | null;
  created_at?: string | null;
}

interface PaddleScheduledChange {
  action: string;
  effective_at?: string | null;
  /** Only set on `pause` changes; a `resume` change carries the date on `effective_at`. */
  resume_at?: string | null;
}

export interface PaddleSubscription {
  id: string;
  status: string;
  customer_id: string;
  currency_code?: string | null;
  started_at?: string | null;
  canceled_at?: string | null;
  trial_dates?: { starts_at?: string | null; ends_at?: string | null } | null;
  current_billing_period?: { starts_at?: string | null; ends_at?: string | null } | null;
  billing_cycle?: PaddleBillingCycle | null;
  scheduled_change?: PaddleScheduledChange | null;
  custom_data?: Record<string, unknown> | null;
  items?: Array<{
    quantity?: number | null;
    trial_dates?: { ends_at?: string | null } | null;
    price?: PaddlePrice | null;
  }> | null;
}

export function parseAmount(value: string | null | undefined): number | undefined {
  if (value === null || value === undefined) {
    return undefined;
  }
  const amount = Number.parseInt(value, 10);
  return Number.isFinite(amount) ? amount : undefined;
}

function toTrialDays(trial: PaddleBillingCycle | null | undefined): number | undefined {
  if (!trial) {
    return undefined;
  }
  if (trial.interval === 'day') {
    return trial.frequency;
  }
  if (trial.interval === 'week') {
    return trial.frequency * 7;
  }
  return undefined;
}

export function toPrice(price: PaddlePrice): Price {
  return {
    id: price.id,
    checkoutRef: price.id,
    type: price.billing_cycle ? 'recurring' : 'one_time',
    // Paddle has no metered or tiered pricing: a price carries only a `unit_price`, per-country
    // `unit_price_overrides` (still fixed amounts) and `quantity` min/max bounds — never a model.
    model: 'fixed',
    amount: parseAmount(price.unit_price?.amount) ?? null,
    currency: price.unit_price?.currency_code.toLowerCase() ?? 'usd',
    interval: price.billing_cycle?.interval,
    intervalCount: price.billing_cycle?.frequency,
    trialDays: toTrialDays(price.trial_period),
    raw: price,
  };
}

export function toProduct(product: PaddleProduct): Product {
  return {
    id: product.id,
    name: product.name,
    description: product.description ?? undefined,
    prices: (product.prices ?? []).map(toPrice),
    raw: product,
  };
}

function toCheckoutStatus(status: string | null | undefined): CheckoutStatus {
  switch (status) {
    case 'paid':
    case 'completed':
      return 'complete';
    case 'canceled':
      return 'expired';
    default:
      return 'open';
  }
}

/** The unified `Checkout` is a Paddle TRANSACTION; its `checkout.url` points at the merchant's own Paddle.js page. */
export function toCheckout(transaction: PaddleTransaction): Checkout {
  return {
    id: transaction.id,
    url: transaction.checkout?.url ?? '',
    status: toCheckoutStatus(transaction.status),
    customerId: transaction.customer_id ?? undefined,
    subscriptionId: transaction.subscription_id ?? undefined,
    metadata: toMetadata(transaction.custom_data),
    raw: transaction,
  };
}

export function toCustomer(customer: PaddleCustomer): Customer {
  return {
    id: customer.id,
    email: customer.email,
    name: customer.name ?? undefined,
    metadata: toMetadata(customer.custom_data),
    createdAt: toDate(customer.created_at),
    raw: customer,
  };
}

function toSubscriptionStatus(status: string): SubscriptionStatus {
  switch (status) {
    case 'trialing':
      return 'trialing';
    case 'past_due':
      return 'past_due';
    case 'paused':
      return 'paused';
    case 'canceled':
      return 'canceled';
    default:
      return 'active';
  }
}

function toResumesAt(change: PaddleScheduledChange | null | undefined): Date | undefined {
  // A scheduled pause carries its automatic resume date on `resume_at`. Once the pause takes
  // effect, Paddle replaces it with a `resume` change whose `effective_at` is that date.
  if (change?.action === 'pause') {
    return toDate(change.resume_at);
  }
  if (change?.action === 'resume') {
    return toDate(change.effective_at);
  }
  return undefined;
}

export function toSubscription(subscription: PaddleSubscription): Subscription {
  const item = subscription.items?.[0];
  const scheduledToCancel = subscription.scheduled_change?.action === 'cancel';
  return {
    id: subscription.id,
    status: toSubscriptionStatus(subscription.status),
    cancelAtPeriodEnd: scheduledToCancel,
    pauseAtPeriodEnd: subscription.scheduled_change?.action === 'pause',
    customerId: subscription.customer_id,
    productId: item?.price?.product_id,
    priceId: item?.price?.id,
    quantity: item?.quantity ?? undefined,
    currency: subscription.currency_code?.toLowerCase(),
    amount: parseAmount(item?.price?.unit_price?.amount),
    interval: subscription.billing_cycle?.interval,
    intervalCount: subscription.billing_cycle?.frequency,
    currentPeriodStart: toDate(subscription.current_billing_period?.starts_at),
    currentPeriodEnd: toDate(subscription.current_billing_period?.ends_at),
    trialEndsAt: toDate(item?.trial_dates?.ends_at),
    resumesAt: toResumesAt(subscription.scheduled_change),
    startedAt: toDate(subscription.started_at),
    endsAt: scheduledToCancel ? toDate(subscription.scheduled_change?.effective_at) : undefined,
    // `canceled_at` is only set once the cancellation actually takes effect.
    endedAt: toDate(subscription.canceled_at),
    metadata: toMetadata(subscription.custom_data),
    raw: subscription,
  };
}

export function toOrderFromTransaction(transaction: PaddleTransaction): Order {
  return {
    id: transaction.id,
    amount: parseAmount(
      transaction.details?.totals?.grand_total ?? transaction.details?.totals?.total,
    ),
    currency: transaction.currency_code?.toLowerCase(),
    customerId: transaction.customer_id ?? undefined,
    subscriptionId: transaction.subscription_id ?? undefined,
    metadata: toMetadata(transaction.custom_data),
    raw: transaction,
  };
}
