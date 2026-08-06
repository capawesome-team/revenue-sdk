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

export interface DodoListResponse<T> {
  items: T[];
}

/** Dodo's `TimeInterval` values are capitalized (`'Month'`), unlike every other enum. */
type DodoTimeInterval = 'Day' | 'Week' | 'Month' | 'Year';

export interface DodoPriceDetail {
  type: string;
  currency?: string | null;
  price?: number | null;
  fixed_price?: number | null;
  payment_frequency_count?: number | null;
  payment_frequency_interval?: DodoTimeInterval | null;
  trial_period_days?: number | null;
}

export interface DodoProduct {
  product_id: string;
  name?: string | null;
  description?: string | null;
  price?: DodoPriceDetail | number | null;
  /** The list shape carries the price object under `price_detail` instead of `price`. */
  price_detail?: DodoPriceDetail | null;
  currency?: string | null;
  is_recurring?: boolean;
  metadata?: Record<string, unknown> | null;
}

export interface DodoCheckoutSession {
  session_id: string;
  checkout_url?: string | null;
}

export interface DodoCheckoutSessionStatus {
  id: string;
  payment_id?: string | null;
  payment_status?: string | null;
  customer_email?: string | null;
}

export interface DodoCustomer {
  customer_id: string;
  email: string;
  name?: string | null;
  metadata?: Record<string, unknown> | null;
  created_at?: string | null;
}

export interface DodoSubscription {
  subscription_id: string;
  status: string;
  cancel_at_next_billing_date?: boolean | null;
  product_id: string;
  quantity?: number | null;
  currency?: string | null;
  recurring_pre_tax_amount?: number | null;
  payment_frequency_count?: number | null;
  payment_frequency_interval?: DodoTimeInterval | null;
  previous_billing_date?: string | null;
  next_billing_date?: string | null;
  created_at?: string | null;
  cancelled_at?: string | null;
  expires_at?: string | null;
  customer?: { customer_id?: string | null; email?: string | null } | null;
  metadata?: Record<string, unknown> | null;
}

export interface DodoPayment {
  payment_id: string;
  total_amount?: number | null;
  currency?: string | null;
  subscription_id?: string | null;
  customer?: { customer_id?: string | null; email?: string | null } | null;
  metadata?: Record<string, unknown> | null;
}

function toInterval(interval: DodoTimeInterval | null | undefined): BillingInterval | undefined {
  switch (interval) {
    case 'Day':
      return 'day';
    case 'Week':
      return 'week';
    case 'Month':
      return 'month';
    case 'Year':
      return 'year';
    default:
      return undefined;
  }
}

function toPrice(detail: DodoPriceDetail, productId: string): Price {
  const metered = detail.type === 'usage_based_price';
  const recurring = detail.type !== 'one_time_price';
  return {
    // Dodo prices have no own identifier — the product is the purchasable unit.
    id: productId,
    checkoutRef: productId,
    type: recurring ? 'recurring' : 'one_time',
    model: metered ? 'metered' : 'fixed',
    amount: metered ? null : (detail.price ?? detail.fixed_price ?? null),
    currency: detail.currency?.toLowerCase() ?? 'usd',
    interval: recurring ? toInterval(detail.payment_frequency_interval) : undefined,
    intervalCount: recurring ? (detail.payment_frequency_count ?? undefined) : undefined,
    trialDays: detail.trial_period_days || undefined,
    raw: detail,
  };
}

export function toProduct(product: DodoProduct): Product {
  const detail =
    product.price_detail ??
    (typeof product.price === 'object' && product.price !== null ? product.price : undefined);
  return {
    id: product.product_id,
    name: product.name ?? product.product_id,
    description: product.description ?? undefined,
    prices: detail ? [toPrice(detail, product.product_id)] : [],
    raw: product,
  };
}

export function toCheckoutFromSession(session: DodoCheckoutSession): Checkout {
  return {
    id: session.session_id,
    url: session.checkout_url ?? '',
    status: 'open',
    raw: session,
  };
}

function toCheckoutStatus(paymentStatus: string | null | undefined): CheckoutStatus {
  switch (paymentStatus) {
    case 'succeeded':
      return 'complete';
    case 'cancelled':
    case 'failed':
      return 'expired';
    default:
      return 'open';
  }
}

export function toCheckoutFromStatus(session: DodoCheckoutSessionStatus): Checkout {
  return {
    id: session.id,
    // The status endpoint does not return the checkout URL.
    url: '',
    status: toCheckoutStatus(session.payment_status),
    customerEmail: session.customer_email ?? undefined,
    raw: session,
  };
}

export function toCustomer(customer: DodoCustomer): Customer {
  return {
    id: customer.customer_id,
    email: customer.email,
    name: customer.name ?? undefined,
    metadata: toMetadata(customer.metadata),
    createdAt: toDate(customer.created_at),
    raw: customer,
  };
}

function toSubscriptionStatus(status: string): SubscriptionStatus {
  switch (status) {
    case 'pending':
      return 'incomplete';
    // Renewal failed, payment retries in progress — the closest unified state.
    case 'on_hold':
      return 'past_due';
    case 'cancelled':
    case 'expired':
    case 'failed':
      return 'canceled';
    default:
      return 'active';
  }
}

export function toSubscription(subscription: DodoSubscription): Subscription {
  const status = toSubscriptionStatus(subscription.status);
  const scheduledToCancel =
    status !== 'canceled' && (subscription.cancel_at_next_billing_date ?? false);
  const currentPeriodEnd = toDate(subscription.next_billing_date);
  return {
    id: subscription.subscription_id,
    status,
    cancelAtPeriodEnd: scheduledToCancel,
    customerId: subscription.customer?.customer_id ?? '',
    productId: subscription.product_id,
    quantity: subscription.quantity ?? undefined,
    currency: subscription.currency?.toLowerCase(),
    amount: subscription.recurring_pre_tax_amount ?? undefined,
    interval: toInterval(subscription.payment_frequency_interval),
    intervalCount: subscription.payment_frequency_count ?? undefined,
    currentPeriodStart: toDate(subscription.previous_billing_date),
    currentPeriodEnd,
    startedAt: toDate(subscription.created_at),
    endsAt: scheduledToCancel ? currentPeriodEnd : toDate(subscription.expires_at),
    endedAt: toDate(subscription.cancelled_at),
    metadata: toMetadata(subscription.metadata),
    raw: subscription,
  };
}

export function toOrderFromPayment(payment: DodoPayment): Order {
  return {
    id: payment.payment_id,
    amount: payment.total_amount ?? undefined,
    currency: payment.currency?.toLowerCase(),
    customerId: payment.customer?.customer_id ?? undefined,
    customerEmail: payment.customer?.email ?? undefined,
    subscriptionId: payment.subscription_id ?? undefined,
    metadata: toMetadata(payment.metadata),
    raw: payment,
  };
}
