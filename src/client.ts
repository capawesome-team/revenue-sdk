import { RevenueError } from './errors.ts';
import type {
  BaseParams,
  CancelSubscriptionParams,
  ChangeSubscriptionPlanParams,
  Checkout,
  CheckoutItem,
  CreateCheckoutParams,
  CreateCustomerParams,
  CreateCustomerPortalSessionParams,
  Customer,
  CustomerPortalSession,
  EndSubscriptionTrialParams,
  GetCheckoutParams,
  GetCustomerParams,
  GetLicenseKeyParams,
  GetOrderInvoiceUrlParams,
  GetOrderParams,
  GetProductParams,
  GetSubscriptionParams,
  LicenseKey,
  ListCustomersParams,
  ListLicenseKeysParams,
  ListOrdersParams,
  ListProductsParams,
  ListSubscriptionsParams,
  Metadata,
  Order,
  Page,
  PauseSubscriptionParams,
  Product,
  ProviderName,
  ReportUsageParams,
  ResumeSubscriptionParams,
  RevenueCapabilities,
  RevenueProvider,
  RevokeSubscriptionParams,
  Subscription,
  UncancelSubscriptionParams,
  UpdateCustomerParams,
  UpdateLicenseKeyParams,
} from './types.ts';

const DEFAULT_MAX_RETRY_AFTER_SECONDS = 10;
// Stripe never sends `Retry-After`, and no provider sends one on a network error or a 5xx.
const DEFAULT_RETRY_DELAY_SECONDS = 1;

export interface RetryOptions {
  /**
   * Caps the wait before the single retry: a retry is skipped when the provider's Retry-After —
   * or the one-second default when it sent none — exceeds this many seconds. Set to 0 to disable
   * the retry.
   */
  maxRetryAfterSeconds?: number;
}

export interface CreateClientOptions {
  provider: RevenueProvider;
  retry?: RetryOptions;
}

export interface RevenueClient {
  providerName: ProviderName | (string & {});
  capabilities: RevenueCapabilities;
  products: {
    list(params?: ListProductsParams): Promise<Page<Product>>;
    listAll(params?: Omit<ListProductsParams, 'cursor'>): AsyncGenerator<Product, void>;
    get(params: GetProductParams): Promise<Product>;
  };
  checkouts: {
    create(params: CreateCheckoutParams): Promise<Checkout>;
    get(params: GetCheckoutParams): Promise<Checkout>;
  };
  customers: {
    get(params: GetCustomerParams): Promise<Customer>;
    list(params?: ListCustomersParams): Promise<Page<Customer>>;
    listAll(params?: Omit<ListCustomersParams, 'cursor'>): AsyncGenerator<Customer, void>;
    create(params: CreateCustomerParams): Promise<Customer>;
    update(params: UpdateCustomerParams): Promise<Customer>;
  };
  subscriptions: {
    get(params: GetSubscriptionParams): Promise<Subscription>;
    list(params?: ListSubscriptionsParams): Promise<Page<Subscription>>;
    listAll(params?: Omit<ListSubscriptionsParams, 'cursor'>): AsyncGenerator<Subscription, void>;
    cancel(params: CancelSubscriptionParams): Promise<Subscription>;
    uncancel(params: UncancelSubscriptionParams): Promise<Subscription>;
    changePlan(params: ChangeSubscriptionPlanParams): Promise<Subscription>;
    endTrial(params: EndSubscriptionTrialParams): Promise<Subscription>;
    pause(params: PauseSubscriptionParams): Promise<Subscription>;
    resume(params: ResumeSubscriptionParams): Promise<Subscription>;
    revoke(params: RevokeSubscriptionParams): Promise<Subscription>;
  };
  customerPortal: {
    createSession(params: CreateCustomerPortalSessionParams): Promise<CustomerPortalSession>;
  };
  usage: {
    report(params: ReportUsageParams): Promise<void>;
  };
  licenseKeys: {
    list(params?: ListLicenseKeysParams): Promise<Page<LicenseKey>>;
    listAll(params?: Omit<ListLicenseKeysParams, 'cursor'>): AsyncGenerator<LicenseKey, void>;
    get(params: GetLicenseKeyParams): Promise<LicenseKey>;
    update(params: UpdateLicenseKeyParams): Promise<LicenseKey>;
  };
  orders: {
    list(params?: ListOrdersParams): Promise<Page<Order>>;
    listAll(params?: Omit<ListOrdersParams, 'cursor'>): AsyncGenerator<Order, void>;
    get(params: GetOrderParams): Promise<Order>;
    /** Fetched on demand — several providers mint short-lived URLs, so they are never listed. */
    getInvoiceUrl(params: GetOrderInvoiceUrlParams): Promise<string>;
  };
}

/**
 * Rejects with the signal's reason — the shape an aborted `fetch` throws — as soon as the caller
 * aborts, so an abandoned call never waits out the retry delay.
 */
function sleep(seconds: number, signal: AbortSignal | undefined): Promise<void> {
  if (signal?.aborted) {
    return Promise.reject(signal.reason);
  }
  return new Promise((resolve, reject) => {
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal?.reason);
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, seconds * 1000);
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

/**
 * A rate limit is safe to replay on any operation — the provider rejected the request before it did
 * anything. A transport failure is not: the write may well have landed, so only reads are replayed.
 */
function isReplayable(error: RevenueError, read: boolean): boolean {
  return error.retryable && (read || error.code === 'rate_limited');
}

export function createClient(options: CreateClientOptions): RevenueClient {
  const provider = options.provider;
  const maxRetryAfterSeconds =
    options.retry?.maxRetryAfterSeconds ?? DEFAULT_MAX_RETRY_AFTER_SECONDS;

  function fail(code: 'validation' | 'unsupported', message: string): never {
    throw new RevenueError(message, { code, provider: provider.name });
  }

  function requireNonEmpty(value: string, name: string): void {
    if (value.trim() === '') {
      fail('validation', `The ${name} parameter must not be empty`);
    }
  }

  function checkItems(items: CheckoutItem[]): void {
    if (items.length === 0) {
      fail('validation', 'At least one checkout item is required');
    }
    for (const item of items) {
      requireNonEmpty(item.product, 'items[].product');
      checkQuantity(item.quantity);
    }
  }

  function checkQuantity(quantity: number | undefined): void {
    if (quantity !== undefined && (!Number.isInteger(quantity) || quantity < 1)) {
      fail('validation', 'The quantity parameter must be a positive integer');
    }
  }

  // The upper bound belongs to the price the buyer is paying for, which only the provider knows.
  function checkCustomAmount(amount: number | undefined): void {
    if (amount !== undefined && (!Number.isInteger(amount) || amount < 1)) {
      fail('validation', 'The customAmount parameter must be a positive integer');
    }
  }

  // No upper bound: every provider clamps a limit to its own maximum page size.
  function checkLimit(limit: number | undefined): void {
    if (limit !== undefined && (!Number.isInteger(limit) || limit < 1)) {
      fail('validation', 'The limit parameter must be a positive integer');
    }
  }

  // Stripe's own 30-minute-to-24-hour window is deliberately NOT enforced here: it is a single
  // provider's rule, it is evaluated against Stripe's clock (so skew would reject valid dates near
  // the boundary), and clamping would silently rewrite the caller's intent. Stripe rejects an
  // out-of-range date itself and that 400 already surfaces as `validation`.
  function checkExpiresAt(expiresAt: Date | undefined): void {
    if (expiresAt === undefined) {
      return;
    }
    // `new Date(NaN).toISOString()` throws a RangeError, which would escape as a non-RevenueError.
    if (Number.isNaN(expiresAt.getTime())) {
      fail('validation', 'The expiresAt parameter must be a valid date');
    }
    if (expiresAt.getTime() <= Date.now()) {
      fail('validation', 'The expiresAt parameter must be in the future');
    }
  }

  function requireCustomerMetadata(metadata: Metadata | undefined): void {
    if (metadata !== undefined && !provider.capabilities.customerMetadata) {
      fail('unsupported', `${provider.name} does not support customer metadata`);
    }
  }

  function requireLicenseKeys(): void {
    if (!provider.capabilities.licenseKeys) {
      fail('unsupported', `${provider.name} does not support license keys`);
    }
  }

  function checkActivationLimit(limit: number | null | undefined): void {
    if (limit !== null && limit !== undefined && (!Number.isInteger(limit) || limit < 1)) {
      fail('validation', 'The activationLimit parameter must be a positive integer or null');
    }
  }

  // Any numeric entry can be the billed quantity — meters aggregate on a caller-configured key,
  // not just `value` — and a non-finite number serializes to `null` or `"NaN"` on the wire.
  function checkUsagePayload(params: ReportUsageParams): void {
    if (params.value !== undefined && !Number.isFinite(params.value)) {
      fail('validation', 'The value parameter must be a finite number');
    }
    for (const [key, entry] of Object.entries(params.metadata ?? {})) {
      if (typeof entry === 'number' && !Number.isFinite(entry)) {
        fail('validation', `The metadata.${key} parameter must be a finite number`);
      }
    }
  }

  async function withRetry<T>(
    run: () => Promise<T>,
    read: boolean,
    signal: AbortSignal | undefined,
  ): Promise<T> {
    try {
      return await run();
    } catch (error) {
      if (!(error instanceof RevenueError) || !isReplayable(error, read)) {
        throw error;
      }
      const delay = error.retryAfter ?? DEFAULT_RETRY_DELAY_SECONDS;
      if (maxRetryAfterSeconds <= 0 || delay > maxRetryAfterSeconds) {
        throw error;
      }
      await sleep(delay, signal);
      return run();
    }
  }

  function runRead<T>(params: BaseParams, run: () => Promise<T>): Promise<T> {
    return withRetry(run, true, params.signal);
  }

  function runWrite<T>(params: BaseParams, run: () => Promise<T>): Promise<T> {
    return withRetry(run, false, params.signal);
  }

  /**
   * `fetchPage` is one of the checked list functions below, so every page is validated, capability
   * gated and retried exactly like a single `list` call — and a rejected check surfaces on the
   * first `next()` rather than as a synchronous throw.
   */
  async function* listAllOf<T, P extends { cursor?: string }>(
    params: Omit<P, 'cursor'>,
    fetchPage: (params: P) => Promise<Page<T>>,
  ): AsyncGenerator<T, void> {
    let cursor: string | undefined;
    do {
      const page = await fetchPage({ ...params, cursor } as P);
      yield* page.items;
      cursor = page.cursor;
    } while (cursor !== undefined);
  }

  async function listProducts(params: ListProductsParams = {}): Promise<Page<Product>> {
    checkLimit(params.limit);
    return runRead(params, () => provider.listProducts(params));
  }

  async function listCustomers(params: ListCustomersParams = {}): Promise<Page<Customer>> {
    checkLimit(params.limit);
    return runRead(params, () => provider.listCustomers(params));
  }

  async function listSubscriptions(
    params: ListSubscriptionsParams = {},
  ): Promise<Page<Subscription>> {
    checkLimit(params.limit);
    if (params.customerId !== undefined && !provider.capabilities.listSubscriptionsByCustomer) {
      fail('unsupported', `${provider.name} cannot filter subscriptions by customer`);
    }
    return runRead(params, () => provider.listSubscriptions(params));
  }

  async function listLicenseKeys(params: ListLicenseKeysParams = {}): Promise<Page<LicenseKey>> {
    checkLimit(params.limit);
    requireLicenseKeys();
    return runRead(params, () => provider.listLicenseKeys(params));
  }

  async function listOrders(params: ListOrdersParams = {}): Promise<Page<Order>> {
    checkLimit(params.limit);
    if (params.customerId !== undefined && !provider.capabilities.listOrdersByCustomer) {
      fail('unsupported', `${provider.name} cannot filter orders by customer`);
    }
    return runRead(params, () => provider.listOrders(params));
  }

  return {
    providerName: provider.name,
    capabilities: provider.capabilities,

    products: {
      list: listProducts,
      listAll: (params = {}) => listAllOf(params, listProducts),
      get: async (params) => {
        requireNonEmpty(params.id, 'id');
        return runRead(params, () => provider.getProduct(params));
      },
    },

    checkouts: {
      create: async (params) => {
        checkItems(params.items);
        if (params.successUrl !== undefined && !provider.capabilities.checkoutSuccessUrl) {
          fail('unsupported', `${provider.name} does not support a checkout success URL`);
        }
        if (params.expiresAt !== undefined && !provider.capabilities.checkoutExpiresAt) {
          fail('unsupported', `${provider.name} does not support a checkout expiry`);
        }
        checkExpiresAt(params.expiresAt);
        if (params.customAmount !== undefined && !provider.capabilities.checkoutCustomAmount) {
          fail('unsupported', `${provider.name} does not support a custom checkout amount`);
        }
        checkCustomAmount(params.customAmount);
        return runWrite(params, () => provider.createCheckout(params));
      },
      get: async (params) => {
        requireNonEmpty(params.id, 'id');
        return runRead(params, () => provider.getCheckout(params));
      },
    },

    customers: {
      get: async (params) => {
        requireNonEmpty(params.id, 'id');
        return runRead(params, () => provider.getCustomer(params));
      },
      list: listCustomers,
      listAll: (params = {}) => listAllOf(params, listCustomers),
      create: async (params) => {
        // Only emptiness is checked: an address the provider rejects is its own error to report,
        // and a client-side format rule would reject addresses the provider accepts.
        requireNonEmpty(params.email, 'email');
        requireNonEmpty(params.name, 'name');
        requireCustomerMetadata(params.metadata);
        return runWrite(params, () => provider.createCustomer(params));
      },
      // An omitted field leaves the stored value alone; an empty one would overwrite it with a
      // blank, which no provider treats as "clear this field".
      update: async (params) => {
        requireNonEmpty(params.id, 'id');
        if (params.email !== undefined) {
          requireNonEmpty(params.email, 'email');
        }
        if (params.name !== undefined) {
          requireNonEmpty(params.name, 'name');
        }
        requireCustomerMetadata(params.metadata);
        return runWrite(params, () => provider.updateCustomer(params));
      },
    },

    subscriptions: {
      get: async (params) => {
        requireNonEmpty(params.id, 'id');
        return runRead(params, () => provider.getSubscription(params));
      },
      list: listSubscriptions,
      listAll: (params = {}) => listAllOf(params, listSubscriptions),
      cancel: async (params) => {
        requireNonEmpty(params.id, 'id');
        if (
          (params.reason !== undefined || params.comment !== undefined) &&
          !provider.capabilities.cancellationReason
        ) {
          fail('unsupported', `${provider.name} does not support cancellation reasons`);
        }
        return runWrite(params, () => provider.cancelSubscription(params));
      },
      uncancel: async (params) => {
        requireNonEmpty(params.id, 'id');
        if (!provider.capabilities.uncancel) {
          fail('unsupported', `${provider.name} cannot revert a scheduled cancellation`);
        }
        return runWrite(params, () => provider.uncancelSubscription(params));
      },
      changePlan: async (params) => {
        requireNonEmpty(params.id, 'id');
        requireNonEmpty(params.product, 'product');
        checkQuantity(params.quantity);
        if (
          params.prorationBehavior !== undefined &&
          !provider.capabilities.prorationBehaviors.includes(params.prorationBehavior)
        ) {
          fail(
            'unsupported',
            `${provider.name} does not support the ${params.prorationBehavior} proration behavior`,
          );
        }
        return runWrite(params, () => provider.changeSubscriptionPlan(params));
      },
      endTrial: async (params) => {
        requireNonEmpty(params.id, 'id');
        if (!provider.capabilities.endTrial) {
          fail('unsupported', `${provider.name} cannot end a trial early`);
        }
        return runWrite(params, () => provider.endSubscriptionTrial(params));
      },
      pause: async (params) => {
        requireNonEmpty(params.id, 'id');
        if (!provider.capabilities.pause) {
          fail('unsupported', `${provider.name} cannot pause a subscription`);
        }
        if (
          params.behavior !== undefined &&
          !provider.capabilities.pauseBehaviors.includes(params.behavior)
        ) {
          fail(
            'unsupported',
            `${provider.name} does not support the ${params.behavior} pause behavior`,
          );
        }
        return runWrite(params, () => provider.pauseSubscription(params));
      },
      resume: async (params) => {
        requireNonEmpty(params.id, 'id');
        if (!provider.capabilities.pause) {
          fail('unsupported', `${provider.name} cannot resume a subscription`);
        }
        return runWrite(params, () => provider.resumeSubscription(params));
      },
      revoke: async (params) => {
        requireNonEmpty(params.id, 'id');
        if (!provider.capabilities.revoke) {
          fail('unsupported', `${provider.name} cannot revoke a subscription immediately`);
        }
        return runWrite(params, () => provider.revokeSubscription(params));
      },
    },

    customerPortal: {
      createSession: async (params) => {
        requireNonEmpty(params.customerId, 'customerId');
        if (params.returnUrl !== undefined && !provider.capabilities.portalReturnUrl) {
          fail('unsupported', `${provider.name} does not support a portal return URL`);
        }
        return runWrite(params, () => provider.createCustomerPortalSession(params));
      },
    },

    usage: {
      report: async (params) => {
        requireNonEmpty(params.customerId, 'customerId');
        requireNonEmpty(params.eventName, 'eventName');
        checkUsagePayload(params);
        if (!provider.capabilities.usageReporting) {
          fail('unsupported', `${provider.name} does not support usage reporting`);
        }
        // Deliberately unwrapped — not even `runWrite`: a replayed usage event is only deduplicated
        // when `idempotencyKey` is set, so an automatic retry would over-bill the customer.
        return provider.reportUsage(params);
      },
    },

    licenseKeys: {
      list: listLicenseKeys,
      listAll: (params = {}) => listAllOf(params, listLicenseKeys),
      get: async (params) => {
        requireNonEmpty(params.id, 'id');
        requireLicenseKeys();
        return runRead(params, () => provider.getLicenseKey(params));
      },
      update: async (params) => {
        requireNonEmpty(params.id, 'id');
        checkActivationLimit(params.activationLimit);
        requireLicenseKeys();
        return runWrite(params, () => provider.updateLicenseKey(params));
      },
    },

    orders: {
      list: listOrders,
      listAll: (params = {}) => listAllOf(params, listOrders),
      get: async (params) => {
        requireNonEmpty(params.id, 'id');
        return runRead(params, () => provider.getOrder(params));
      },
      getInvoiceUrl: async (params) => {
        requireNonEmpty(params.id, 'id');
        return runRead(params, () => provider.getOrderInvoiceUrl(params));
      },
    },
  };
}
