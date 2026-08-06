export type ProviderName =
  'dodo-payments' | 'lemon-squeezy' | 'paddle' | 'polar' | 'stripe' | 'testing';

export interface BaseParams {
  signal?: AbortSignal;
}

export interface Page<T> {
  items: T[];
  /** Opaque cursor for the next page; absent on the last page. */
  cursor?: string;
}

export type Metadata = Record<string, string | number | boolean>;

export type BillingInterval = 'day' | 'week' | 'month' | 'year';

export type PriceType = 'one_time' | 'recurring';

export type PriceModel = 'custom' | 'fixed' | 'metered' | 'seat_based' | 'tiered';

export interface Price {
  id: string;
  /** The identifier `checkouts.create` accepts for this price (provider-dependent: Polar product ID, Lemon Squeezy variant ID, Stripe price ID, Paddle price ID, Dodo Payments product ID). */
  checkoutRef: string;
  type: PriceType;
  /** Only `fixed` prices are fully normalized; inspect `raw` for the other models. */
  model: PriceModel;
  /** Amount in the currency's minor units; `null` unless `model` is `fixed`. */
  amount: number | null;
  /** Lowercase ISO 4217 currency code. */
  currency: string;
  interval?: BillingInterval;
  intervalCount?: number;
  trialDays?: number;
  raw: unknown;
}

export interface Product {
  id: string;
  name: string;
  description?: string;
  prices: Price[];
  raw: unknown;
}

export type CheckoutStatus = 'complete' | 'expired' | 'open';

export interface Checkout {
  id: string;
  url: string;
  /** `null` when the provider does not expose a checkout status (see capabilities). */
  status: CheckoutStatus | null;
  customerId?: string;
  customerEmail?: string;
  subscriptionId?: string;
  metadata?: Metadata;
  expiresAt?: Date;
  raw: unknown;
}

export interface Customer {
  id: string;
  email: string;
  name?: string;
  metadata?: Metadata;
  createdAt?: Date;
  raw: unknown;
}

export type SubscriptionStatus =
  'active' | 'canceled' | 'incomplete' | 'past_due' | 'paused' | 'trialing' | 'unpaid';

export interface SubscriptionMeter {
  /** The meter's identifier. */
  id: string;
  name: string;
  /** Units consumed in the current meter period. */
  consumedUnits: number;
  /** Units granted upfront (included allowance or credits). */
  creditedUnits: number;
  /** Amount accrued for this meter so far in the current period, in the currency's minor units. */
  amount: number;
  raw: unknown;
}

export interface Subscription {
  id: string;
  /** `canceled` is terminal. A pending "cancel at period end" keeps the status unchanged and sets `cancelAtPeriodEnd`. */
  status: SubscriptionStatus;
  cancelAtPeriodEnd: boolean;
  /** Whether a pause is scheduled for the end of the current period. The status stays unchanged until it takes effect. */
  pauseAtPeriodEnd: boolean;
  customerId: string;
  productId?: string;
  priceId?: string;
  quantity?: number;
  /** Lowercase ISO 4217 currency code. */
  currency?: string;
  /** Amount in the currency's minor units per billing interval. */
  amount?: number;
  interval?: BillingInterval;
  intervalCount?: number;
  currentPeriodStart?: Date;
  currentPeriodEnd?: Date;
  trialEndsAt?: Date;
  /** When a paused — or pause-scheduled — subscription resumes automatically; absent for an indefinite pause. */
  resumesAt?: Date;
  startedAt?: Date;
  /** When access ends: the effective date of a scheduled cancellation, or the end of a grace period. */
  endsAt?: Date;
  /** When the subscription actually terminated. */
  endedAt?: Date;
  /** Per-meter usage for the current period. Absent unless the provider reports it inline — only Polar does. */
  meters?: SubscriptionMeter[];
  metadata?: Metadata;
  raw: unknown;
}

export interface Order {
  id: string;
  /** Total amount in the currency's minor units. */
  amount?: number;
  currency?: string;
  customerId?: string;
  customerEmail?: string;
  subscriptionId?: string;
  metadata?: Metadata;
  raw: unknown;
}

export interface CustomerPortalSession {
  url: string;
  raw: unknown;
}

export type CancellationReason =
  | 'customer_service'
  | 'low_quality'
  | 'missing_features'
  | 'other'
  | 'switched_service'
  | 'too_complex'
  | 'too_expensive'
  | 'unused';

export type PauseBehavior = 'immediately' | 'period_end';

export type ProrationBehavior = 'invoice_now' | 'none' | 'prorate';

export type WebhookEventType =
  | 'checkout.completed'
  | 'order.paid'
  | 'subscription.canceled'
  | 'subscription.created'
  | 'subscription.updated'
  | 'unknown';

export interface WebhookEvent {
  /** Normalized event type; `unknown` for provider events outside the normalized set. */
  type: WebhookEventType;
  /** The provider's original event type string. */
  providerType: string;
  subscription?: Subscription;
  order?: Order;
  checkout?: Checkout;
  raw: unknown;
}

export interface RevenueCapabilities {
  /** Whether `subscriptions.cancel` forwards `reason`/`comment` to the provider. */
  cancellationReason: boolean;
  /** Whether `Checkout.status` is populated. */
  checkoutStatus: boolean;
  /** Whether `checkouts.create` supports `successUrl`. Paddle configures redirects in Paddle.js instead. */
  checkoutSuccessUrl: boolean;
  /** Whether `subscriptions.endTrial` is supported. */
  endTrial: boolean;
  /** Whether `checkouts.create` returns a ready-to-use provider-hosted URL. Paddle requires a merchant-hosted Paddle.js page instead. */
  hostedCheckout: boolean;
  /** Whether `subscriptions.list` supports the `customerId` filter. */
  listSubscriptionsByCustomer: boolean;
  /** Whether `subscriptions.pause` and `subscriptions.resume` are supported. */
  pause: boolean;
  /** Pause behaviors supported by `subscriptions.pause`. */
  pauseBehaviors: PauseBehavior[];
  /** Whether `customerPortal.createSession` supports `returnUrl`. */
  portalReturnUrl: boolean;
  /** Proration behaviors supported by `subscriptions.changePlan`. */
  prorationBehaviors: ProrationBehavior[];
  /** Whether `subscriptions.revoke` (cancel immediately) is supported. */
  revoke: boolean;
  /** Whether a scheduled cancellation can be reverted via `subscriptions.uncancel`. */
  uncancel: boolean;
  /** Whether `usage.report` is supported. */
  usageReporting: boolean;
}

export interface ListProductsParams extends BaseParams {
  cursor?: string;
  limit?: number;
}

export interface GetProductParams extends BaseParams {
  id: string;
}

export interface CheckoutItem {
  /** The provider's purchasable identifier — see `Price.checkoutRef`. */
  product: string;
  quantity?: number;
}

export interface CreateCheckoutParams extends BaseParams {
  items: CheckoutItem[];
  /** Where the customer is sent after a completed checkout. */
  successUrl?: string;
  customerId?: string;
  customerEmail?: string;
  /** Copied onto the resulting order/subscription where the provider supports it. */
  metadata?: Metadata;
}

export interface GetCheckoutParams extends BaseParams {
  id: string;
}

export interface GetCustomerParams extends BaseParams {
  id: string;
}

export interface ListCustomersParams extends BaseParams {
  cursor?: string;
  limit?: number;
  /** Exact-match email filter. */
  email?: string;
}

export interface GetSubscriptionParams extends BaseParams {
  id: string;
}

export interface ListSubscriptionsParams extends BaseParams {
  cursor?: string;
  limit?: number;
  customerId?: string;
}

export interface CancelSubscriptionParams extends BaseParams {
  id: string;
  reason?: CancellationReason;
  comment?: string;
}

export interface UncancelSubscriptionParams extends BaseParams {
  id: string;
}

export interface ChangeSubscriptionPlanParams extends BaseParams {
  id: string;
  /** The provider's purchasable identifier — see `Price.checkoutRef`. */
  product: string;
  quantity?: number;
  prorationBehavior?: ProrationBehavior;
}

export interface EndSubscriptionTrialParams extends BaseParams {
  id: string;
}

export interface PauseSubscriptionParams extends BaseParams {
  id: string;
  /** Defaults to the provider's native behavior — see `RevenueCapabilities.pauseBehaviors`. */
  behavior?: PauseBehavior;
  /** When the subscription resumes automatically; omit to pause indefinitely. */
  resumesAt?: Date;
}

export interface ResumeSubscriptionParams extends BaseParams {
  id: string;
}

export interface RevokeSubscriptionParams extends BaseParams {
  id: string;
}

export interface CreateCustomerPortalSessionParams extends BaseParams {
  customerId: string;
  returnUrl?: string;
}

export interface ReportUsageParams extends BaseParams {
  /** The provider's customer identifier. */
  customerId: string;
  /** The meter's event name. Must match the meter configuration exactly — providers match case-sensitively. */
  eventName: string;
  /** Shorthand for a `value` entry in `metadata`, the key meters aggregate on by default. */
  value?: number;
  /** Event properties the meter can filter or aggregate on. */
  metadata?: Metadata;
  /** Deduplicates replays. Polar dedupes permanently, Dodo Payments per event ID, Stripe over a rolling 24 hours. */
  idempotencyKey?: string;
  /** When the usage occurred. Backdating windows differ sharply per provider — see the usage docs. */
  timestamp?: Date;
}

export interface RevenueProvider {
  name: ProviderName;
  capabilities: RevenueCapabilities;
  listProducts(params: ListProductsParams): Promise<Page<Product>>;
  getProduct(params: GetProductParams): Promise<Product>;
  createCheckout(params: CreateCheckoutParams): Promise<Checkout>;
  getCheckout(params: GetCheckoutParams): Promise<Checkout>;
  getCustomer(params: GetCustomerParams): Promise<Customer>;
  listCustomers(params: ListCustomersParams): Promise<Page<Customer>>;
  getSubscription(params: GetSubscriptionParams): Promise<Subscription>;
  listSubscriptions(params: ListSubscriptionsParams): Promise<Page<Subscription>>;
  cancelSubscription(params: CancelSubscriptionParams): Promise<Subscription>;
  uncancelSubscription(params: UncancelSubscriptionParams): Promise<Subscription>;
  changeSubscriptionPlan(params: ChangeSubscriptionPlanParams): Promise<Subscription>;
  endSubscriptionTrial(params: EndSubscriptionTrialParams): Promise<Subscription>;
  pauseSubscription(params: PauseSubscriptionParams): Promise<Subscription>;
  resumeSubscription(params: ResumeSubscriptionParams): Promise<Subscription>;
  revokeSubscription(params: RevokeSubscriptionParams): Promise<Subscription>;
  createCustomerPortalSession(
    params: CreateCustomerPortalSessionParams,
  ): Promise<CustomerPortalSession>;
  reportUsage(params: ReportUsageParams): Promise<void>;
}
