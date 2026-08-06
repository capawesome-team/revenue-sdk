import type {
  BillingInterval,
  Checkout,
  Customer,
  LicenseKey,
  LicenseKeyActivation,
  LicenseKeyStatus,
  Metadata,
  Order,
  Price,
  PriceModel,
  Product,
  Subscription,
  SubscriptionStatus,
} from '../../types.ts';
import { toDate, toMetadata } from '../shared.ts';

export const BASE_URL = 'https://api.lemonsqueezy.com';

export interface LsResource<A> {
  type: string;
  id: string;
  attributes: A;
}

export interface LsListResponse<A> {
  data: LsResource<A>[];
  meta?: {
    page?: {
      currentPage?: number;
      lastPage?: number;
    };
  };
}

export interface LsSingleResponse<A> {
  data: LsResource<A>;
}

export interface LsVariantAttributes {
  product_id: number;
  name: string;
  description?: string | null;
  status?: string;
}

export interface LsPriceAttributes {
  variant_id: number;
  category?: string | null;
  scheme?: string | null;
  usage_aggregation?: string | null;
  unit_price?: number | null;
  renewal_interval_unit?: BillingInterval | null;
  renewal_interval_quantity?: number | null;
  trial_interval_unit?: string | null;
  trial_interval_quantity?: number | null;
}

// Lemon Squeezy serializes empty objects as `[]` (e.g. `custom`, `billing_address`).
type EmptyableObject<T> = T | unknown[] | null;

export interface LsCheckoutAttributes {
  url?: string | null;
  expires_at?: string | null;
  checkout_data?: EmptyableObject<{
    email?: string | null;
    custom?: EmptyableObject<Record<string, unknown>>;
  }>;
}

export interface LsCustomerAttributes {
  name?: string | null;
  email: string;
  created_at?: string | null;
}

export interface LsSubscriptionAttributes {
  customer_id: number;
  product_id?: number | null;
  variant_id?: number | null;
  status: string;
  pause?: {
    mode: string;
    resumes_at: string | null;
  } | null;
  cancelled?: boolean | null;
  trial_ends_at?: string | null;
  renews_at?: string | null;
  ends_at?: string | null;
  created_at?: string | null;
  user_email?: string | null;
  payment_processor?: string | null;
  first_subscription_item?: {
    id: number;
    price_id: number;
    quantity: number;
  } | null;
  urls?: {
    customer_portal?: string | null;
    update_payment_method?: string | null;
  } | null;
}

export interface LsOrderAttributes {
  customer_id?: number | null;
  user_email?: string | null;
  currency?: string | null;
  total?: number | null;
}

export interface LsSubscriptionInvoiceAttributes {
  subscription_id?: number | null;
  customer_id?: number | null;
  user_email?: string | null;
  currency?: string | null;
  total?: number | null;
}

export interface LsLicenseKeyAttributes {
  key: string;
  status: string;
  activation_limit?: number | null;
  instances_count?: number;
  expires_at?: string | null;
  customer_id?: number | null;
  // Documented as a boolean but typed as a number in the official SDK, so any truthy value counts.
  disabled?: boolean | number;
}

/** The flat license object of the public license API — not a JSON:API resource. */
export interface LsLicense {
  id: number;
  key: string;
  status: string;
  activation_limit?: number | null;
  activation_usage?: number;
  expires_at?: string | null;
}

/** The ownership context of a public license API response; callers must assert it themselves. */
export interface LsLicenseMeta {
  store_id: number;
  product_id: number;
  variant_id: number;
  customer_id: number;
}

export interface LsLicenseInstance {
  id: string;
  name?: string | null;
  created_at?: string | null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function toTrialDays(unit: string | null | undefined, quantity: number | null | undefined) {
  if (!unit || !quantity) {
    return undefined;
  }
  if (unit === 'days') {
    return quantity;
  }
  // Month- and year-based trials have no exact day count; read them from `raw` instead.
  return undefined;
}

function toPriceModel(attributes: LsPriceAttributes): PriceModel {
  if (attributes.usage_aggregation) {
    return 'metered';
  }
  if (attributes.category === 'pwyw') {
    return 'custom';
  }
  switch (attributes.scheme) {
    case 'graduated':
    case 'volume':
    case 'package':
      return 'tiered';
    default:
      return 'fixed';
  }
}

function toPrice(price: LsResource<LsPriceAttributes>, variantId: string, currency: string): Price {
  const attributes = price.attributes;
  const model = toPriceModel(attributes);
  const type = attributes.category === 'subscription' ? 'recurring' : 'one_time';
  return {
    id: String(price.id),
    checkoutRef: variantId,
    type,
    model,
    amount: model === 'fixed' ? (attributes.unit_price ?? null) : null,
    currency,
    interval: type === 'recurring' ? (attributes.renewal_interval_unit ?? undefined) : undefined,
    intervalCount:
      type === 'recurring' ? (attributes.renewal_interval_quantity ?? undefined) : undefined,
    trialDays: toTrialDays(attributes.trial_interval_unit, attributes.trial_interval_quantity),
    raw: price,
  };
}

/** The unified `Product` is a Lemon Squeezy VARIANT — the purchasable unit checkouts accept. */
export function toProduct(
  variant: LsResource<LsVariantAttributes>,
  price: LsResource<LsPriceAttributes>,
  currency: string,
): Product {
  return {
    id: String(variant.id),
    name: variant.attributes.name,
    description: variant.attributes.description ?? undefined,
    prices: [toPrice(price, String(variant.id), currency)],
    raw: variant,
  };
}

export function toCheckout(checkout: LsResource<LsCheckoutAttributes>): Checkout {
  const attributes = checkout.attributes;
  const checkoutData = isRecord(attributes.checkout_data) ? attributes.checkout_data : undefined;
  const email = typeof checkoutData?.email === 'string' ? checkoutData.email : undefined;
  return {
    id: String(checkout.id),
    url: attributes.url ?? '',
    // Lemon Squeezy checkouts carry no lifecycle status.
    status: null,
    customerEmail: email || undefined,
    metadata: toMetadata(checkoutData?.custom),
    expiresAt: toDate(attributes.expires_at),
    raw: checkout,
  };
}

export function toCustomer(customer: LsResource<LsCustomerAttributes>): Customer {
  return {
    id: String(customer.id),
    email: customer.attributes.email,
    name: customer.attributes.name ?? undefined,
    createdAt: toDate(customer.attributes.created_at),
    raw: customer,
  };
}

function toSubscriptionStatus(status: string): SubscriptionStatus {
  switch (status) {
    case 'on_trial':
      return 'trialing';
    case 'past_due':
      return 'past_due';
    case 'unpaid':
      return 'unpaid';
    case 'paused':
      return 'paused';
    // `cancelled` means "grace period until ends_at, still resumable" — unified as an
    // active subscription with a scheduled cancellation.
    case 'cancelled':
      return 'active';
    case 'expired':
      return 'canceled';
    default:
      return 'active';
  }
}

export function toSubscription(
  resource: LsResource<LsSubscriptionAttributes>,
  metadata?: Metadata,
): Subscription {
  const attributes = resource.attributes;
  const scheduledToCancel = attributes.status === 'cancelled';
  return {
    id: String(resource.id),
    status: toSubscriptionStatus(attributes.status),
    cancelAtPeriodEnd: scheduledToCancel,
    // Lemon Squeezy pauses always take effect immediately; they cannot be scheduled.
    pauseAtPeriodEnd: false,
    customerId: String(attributes.customer_id),
    productId:
      attributes.variant_id === null || attributes.variant_id === undefined
        ? undefined
        : String(attributes.variant_id),
    priceId: attributes.first_subscription_item
      ? String(attributes.first_subscription_item.price_id)
      : undefined,
    quantity: attributes.first_subscription_item?.quantity,
    currentPeriodEnd: toDate(attributes.renews_at),
    trialEndsAt: toDate(attributes.trial_ends_at),
    resumesAt: toDate(attributes.pause?.resumes_at),
    startedAt: toDate(attributes.created_at),
    endsAt: toDate(attributes.ends_at),
    endedAt: attributes.status === 'expired' ? toDate(attributes.ends_at) : undefined,
    metadata,
    raw: resource,
  };
}

export function toOrderFromOrder(
  resource: LsResource<LsOrderAttributes>,
  metadata?: Metadata,
): Order {
  const attributes = resource.attributes;
  return {
    id: String(resource.id),
    amount: attributes.total ?? undefined,
    currency: attributes.currency?.toLowerCase(),
    customerId:
      attributes.customer_id === null || attributes.customer_id === undefined
        ? undefined
        : String(attributes.customer_id),
    customerEmail: attributes.user_email ?? undefined,
    metadata,
    raw: resource,
  };
}

export function toOrderFromInvoice(resource: LsResource<LsSubscriptionInvoiceAttributes>): Order {
  const attributes = resource.attributes;
  return {
    id: String(resource.id),
    amount: attributes.total ?? undefined,
    currency: attributes.currency?.toLowerCase(),
    customerId:
      attributes.customer_id === null || attributes.customer_id === undefined
        ? undefined
        : String(attributes.customer_id),
    customerEmail: attributes.user_email ?? undefined,
    subscriptionId:
      attributes.subscription_id === null || attributes.subscription_id === undefined
        ? undefined
        : String(attributes.subscription_id),
    raw: resource,
  };
}

function toLicenseKeyStatus(status: string, disabled?: boolean | number): LicenseKeyStatus {
  if (disabled) {
    return 'disabled';
  }
  switch (status) {
    case 'disabled':
      return 'disabled';
    case 'expired':
      return 'expired';
    // `inactive` only means "never activated", which is still a usable key.
    default:
      return 'active';
  }
}

export function toLicenseKey(resource: LsResource<LsLicenseKeyAttributes>): LicenseKey {
  const attributes = resource.attributes;
  return {
    id: String(resource.id),
    key: attributes.key,
    status: toLicenseKeyStatus(attributes.status, attributes.disabled),
    activationLimit: attributes.activation_limit ?? undefined,
    activationCount: attributes.instances_count,
    expiresAt: toDate(attributes.expires_at),
    customerId:
      attributes.customer_id === null || attributes.customer_id === undefined
        ? undefined
        : String(attributes.customer_id),
    // `product_id` names the Lemon Squeezy PRODUCT, while the unified `Product` is a variant —
    // there is no id here that `products.get` would accept, so none is reported.
    raw: resource,
  };
}

export function toLicenseKeyFromLicense(license: LsLicense, meta: LsLicenseMeta): LicenseKey {
  return {
    id: String(license.id),
    key: license.key,
    status: toLicenseKeyStatus(license.status),
    activationLimit: license.activation_limit ?? undefined,
    activationCount: license.activation_usage,
    expiresAt: toDate(license.expires_at),
    customerId: String(meta.customer_id),
    // The unified `Product` is a Lemon Squeezy variant.
    productId: String(meta.variant_id),
    raw: license,
  };
}

export function toLicenseKeyActivation(instance: LsLicenseInstance): LicenseKeyActivation {
  return {
    id: instance.id,
    label: instance.name ?? undefined,
    createdAt: toDate(instance.created_at),
    raw: instance,
  };
}
