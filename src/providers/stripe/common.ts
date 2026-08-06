import type {
  BillingInterval,
  Checkout,
  Customer,
  Order,
  Price,
  PriceModel,
  Product,
  Subscription,
  SubscriptionStatus,
} from '../../types.ts';
import { toMetadata } from '../shared.ts';

export interface StripeList<T> {
  data: T[];
  has_more: boolean;
}

export interface StripeProduct {
  id: string;
  name: string;
  description?: string | null;
}

export interface StripePrice {
  id: string;
  product: string | { id: string };
  currency: string;
  unit_amount?: number | null;
  type?: 'one_time' | 'recurring';
  billing_scheme?: string | null;
  custom_unit_amount?: unknown | null;
  recurring?: {
    interval: BillingInterval;
    interval_count?: number | null;
    usage_type?: string | null;
  } | null;
}

export interface StripeCheckoutSession {
  id: string;
  url?: string | null;
  status?: string | null;
  payment_status?: string | null;
  customer?: string | { id: string } | null;
  customer_email?: string | null;
  customer_details?: { email?: string | null } | null;
  subscription?: string | { id: string } | null;
  metadata?: Record<string, unknown> | null;
  expires_at?: number | null;
}

export interface StripeCustomer {
  id: string;
  email?: string | null;
  name?: string | null;
  metadata?: Record<string, unknown> | null;
  created?: number | null;
}

export interface StripeSubscriptionItem {
  id: string;
  quantity?: number | null;
  current_period_start?: number | null;
  current_period_end?: number | null;
  price?: StripePrice | null;
}

export interface StripeSubscription {
  id: string;
  status: string;
  cancel_at_period_end?: boolean | null;
  cancel_at?: number | null;
  canceled_at?: number | null;
  ended_at?: number | null;
  customer: string | { id: string };
  currency?: string | null;
  trial_end?: number | null;
  start_date?: number | null;
  metadata?: Record<string, unknown> | null;
  items?: StripeList<StripeSubscriptionItem> | null;
}

export interface StripeInvoice {
  id: string;
  amount_paid?: number | null;
  total?: number | null;
  currency?: string | null;
  customer?: string | { id: string } | null;
  customer_email?: string | null;
  metadata?: Record<string, unknown> | null;
  parent?: {
    subscription_details?: {
      subscription?: string | { id: string } | null;
      metadata?: Record<string, unknown> | null;
    } | null;
  } | null;
}

export function fromUnixSeconds(value: number | null | undefined): Date | undefined {
  return typeof value === 'number' ? new Date(value * 1000) : undefined;
}

export function idOf(value: string | { id: string } | null | undefined): string | undefined {
  if (typeof value === 'string') {
    return value;
  }
  return value?.id;
}

function toPriceModel(price: StripePrice): PriceModel {
  if (price.recurring?.usage_type === 'metered') {
    return 'metered';
  }
  if (price.billing_scheme === 'tiered') {
    return 'tiered';
  }
  if (price.custom_unit_amount) {
    return 'custom';
  }
  return 'fixed';
}

export function toPrice(price: StripePrice): Price {
  const model = toPriceModel(price);
  return {
    id: price.id,
    checkoutRef: price.id,
    type: price.recurring ? 'recurring' : 'one_time',
    model,
    amount: model === 'fixed' ? (price.unit_amount ?? null) : null,
    currency: price.currency,
    interval: price.recurring?.interval,
    intervalCount: price.recurring?.interval_count ?? undefined,
    raw: price,
  };
}

export function toProduct(product: StripeProduct, prices: StripePrice[]): Product {
  return {
    id: product.id,
    name: product.name,
    description: product.description ?? undefined,
    prices: prices.map(toPrice),
    raw: product,
  };
}

export function toCheckout(session: StripeCheckoutSession): Checkout {
  // A `complete` session is only mapped to `complete` once it is actually paid — delayed
  // payment methods finish the session with `payment_status: "unpaid"`.
  let status: Checkout['status'] = null;
  if (session.status === 'open') {
    status = 'open';
  } else if (session.status === 'expired') {
    status = 'expired';
  } else if (session.status === 'complete') {
    status = session.payment_status === 'unpaid' ? 'open' : 'complete';
  }
  return {
    id: session.id,
    url: session.url ?? '',
    status,
    customerId: idOf(session.customer),
    customerEmail: session.customer_details?.email ?? session.customer_email ?? undefined,
    subscriptionId: idOf(session.subscription),
    metadata: toMetadata(session.metadata),
    expiresAt: fromUnixSeconds(session.expires_at),
    raw: session,
  };
}

export function toCustomer(customer: StripeCustomer): Customer {
  return {
    id: customer.id,
    email: customer.email ?? '',
    name: customer.name ?? undefined,
    metadata: toMetadata(customer.metadata),
    createdAt: fromUnixSeconds(customer.created),
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

export function toSubscription(subscription: StripeSubscription): Subscription {
  const status = toSubscriptionStatus(subscription.status);
  const item = subscription.items?.data[0];
  const currentPeriodEnd = fromUnixSeconds(item?.current_period_end);
  // Flexible billing mode (the default) writes portal cancellations to `cancel_at` with
  // `cancel_at_period_end: false` — both fields must be checked.
  const scheduledToCancel =
    (subscription.cancel_at_period_end ?? false) || subscription.cancel_at != null;
  const cancelAtPeriodEnd = status === 'canceled' ? false : scheduledToCancel;
  return {
    id: subscription.id,
    status,
    cancelAtPeriodEnd,
    customerId: idOf(subscription.customer) ?? '',
    productId: item?.price ? idOf(item.price.product) : undefined,
    priceId: item?.price?.id,
    quantity: item?.quantity ?? undefined,
    currency: item?.price?.currency ?? subscription.currency ?? undefined,
    amount: item?.price?.unit_amount ?? undefined,
    interval: item?.price?.recurring?.interval,
    intervalCount: item?.price?.recurring?.interval_count ?? undefined,
    currentPeriodStart: fromUnixSeconds(item?.current_period_start),
    currentPeriodEnd,
    trialEndsAt: fromUnixSeconds(subscription.trial_end),
    startedAt: fromUnixSeconds(subscription.start_date),
    endsAt:
      fromUnixSeconds(subscription.cancel_at) ?? (cancelAtPeriodEnd ? currentPeriodEnd : undefined),
    endedAt: fromUnixSeconds(subscription.ended_at),
    metadata: toMetadata(subscription.metadata),
    raw: subscription,
  };
}

export function toOrderFromInvoice(invoice: StripeInvoice): Order {
  return {
    id: invoice.id,
    amount: invoice.amount_paid ?? invoice.total ?? undefined,
    currency: invoice.currency ?? undefined,
    customerId: idOf(invoice.customer),
    customerEmail: invoice.customer_email ?? undefined,
    subscriptionId: idOf(invoice.parent?.subscription_details?.subscription),
    metadata:
      toMetadata(invoice.metadata) ?? toMetadata(invoice.parent?.subscription_details?.metadata),
    raw: invoice,
  };
}
