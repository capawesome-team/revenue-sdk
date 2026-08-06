import { RevenueError } from './errors.ts';
import type {
  CancelSubscriptionParams,
  ChangeSubscriptionPlanParams,
  Checkout,
  CheckoutItem,
  CreateCheckoutParams,
  CreateCustomerPortalSessionParams,
  Customer,
  CustomerPortalSession,
  EndSubscriptionTrialParams,
  GetCheckoutParams,
  GetCustomerParams,
  GetProductParams,
  GetSubscriptionParams,
  ListCustomersParams,
  ListProductsParams,
  ListSubscriptionsParams,
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
} from './types.ts';

const DEFAULT_MAX_RETRY_AFTER_SECONDS = 10;

export interface RetryOptions {
  /**
   * Rate-limited requests are retried once when the provider's Retry-After is at most this
   * many seconds. Set to 0 to disable the retry.
   */
  maxRetryAfterSeconds?: number;
}

export interface CreateClientOptions {
  provider: RevenueProvider;
  retry?: RetryOptions;
}

export interface RevenueClient {
  providerName: ProviderName;
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
}

function sleep(seconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, seconds * 1000));
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

  async function withRetry<T>(run: () => Promise<T>): Promise<T> {
    try {
      return await run();
    } catch (error) {
      if (
        error instanceof RevenueError &&
        error.code === 'rate_limited' &&
        error.retryAfter !== undefined &&
        maxRetryAfterSeconds > 0 &&
        error.retryAfter <= maxRetryAfterSeconds
      ) {
        await sleep(error.retryAfter);
        return run();
      }
      throw error;
    }
  }

  async function* listAllOf<T, P extends { cursor?: string }>(
    params: Omit<P, 'cursor'>,
    fetchPage: (params: P) => Promise<Page<T>>,
  ): AsyncGenerator<T, void> {
    let cursor: string | undefined;
    do {
      const page = await withRetry(() => fetchPage({ ...params, cursor } as P));
      yield* page.items;
      cursor = page.cursor;
    } while (cursor !== undefined);
  }

  return {
    providerName: provider.name,
    capabilities: provider.capabilities,

    products: {
      list: (params = {}) => withRetry(() => provider.listProducts(params)),
      listAll: (params = {}) => listAllOf(params, (p) => provider.listProducts(p)),
      get: async (params) => {
        requireNonEmpty(params.id, 'id');
        return withRetry(() => provider.getProduct(params));
      },
    },

    checkouts: {
      create: async (params) => {
        checkItems(params.items);
        if (params.successUrl !== undefined && !provider.capabilities.checkoutSuccessUrl) {
          fail('unsupported', `${provider.name} does not support a checkout success URL`);
        }
        return withRetry(() => provider.createCheckout(params));
      },
      get: async (params) => {
        requireNonEmpty(params.id, 'id');
        return withRetry(() => provider.getCheckout(params));
      },
    },

    customers: {
      get: async (params) => {
        requireNonEmpty(params.id, 'id');
        return withRetry(() => provider.getCustomer(params));
      },
      list: (params = {}) => withRetry(() => provider.listCustomers(params)),
      listAll: (params = {}) => listAllOf(params, (p) => provider.listCustomers(p)),
    },

    subscriptions: {
      get: async (params) => {
        requireNonEmpty(params.id, 'id');
        return withRetry(() => provider.getSubscription(params));
      },
      list: async (params = {}) => {
        if (params.customerId !== undefined && !provider.capabilities.listSubscriptionsByCustomer) {
          fail('unsupported', `${provider.name} cannot filter subscriptions by customer`);
        }
        return withRetry(() => provider.listSubscriptions(params));
      },
      listAll: (params = {}) => {
        if (params.customerId !== undefined && !provider.capabilities.listSubscriptionsByCustomer) {
          fail('unsupported', `${provider.name} cannot filter subscriptions by customer`);
        }
        return listAllOf(params, (p) => provider.listSubscriptions(p));
      },
      cancel: async (params) => {
        requireNonEmpty(params.id, 'id');
        if (
          (params.reason !== undefined || params.comment !== undefined) &&
          !provider.capabilities.cancellationReason
        ) {
          fail('unsupported', `${provider.name} does not support cancellation reasons`);
        }
        return withRetry(() => provider.cancelSubscription(params));
      },
      uncancel: async (params) => {
        requireNonEmpty(params.id, 'id');
        if (!provider.capabilities.uncancel) {
          fail('unsupported', `${provider.name} cannot revert a scheduled cancellation`);
        }
        return withRetry(() => provider.uncancelSubscription(params));
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
        return withRetry(() => provider.changeSubscriptionPlan(params));
      },
      endTrial: async (params) => {
        requireNonEmpty(params.id, 'id');
        if (!provider.capabilities.endTrial) {
          fail('unsupported', `${provider.name} cannot end a trial early`);
        }
        return withRetry(() => provider.endSubscriptionTrial(params));
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
        return withRetry(() => provider.pauseSubscription(params));
      },
      resume: async (params) => {
        requireNonEmpty(params.id, 'id');
        if (!provider.capabilities.pause) {
          fail('unsupported', `${provider.name} cannot resume a subscription`);
        }
        return withRetry(() => provider.resumeSubscription(params));
      },
      revoke: async (params) => {
        requireNonEmpty(params.id, 'id');
        if (!provider.capabilities.revoke) {
          fail('unsupported', `${provider.name} cannot revoke a subscription immediately`);
        }
        return withRetry(() => provider.revokeSubscription(params));
      },
    },

    customerPortal: {
      createSession: async (params) => {
        requireNonEmpty(params.customerId, 'customerId');
        if (params.returnUrl !== undefined && !provider.capabilities.portalReturnUrl) {
          fail('unsupported', `${provider.name} does not support a portal return URL`);
        }
        return withRetry(() => provider.createCustomerPortalSession(params));
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
        // Deliberately not wrapped in `withRetry`: a replayed usage event is only deduplicated
        // when `idempotencyKey` is set, so an automatic retry would over-bill the customer.
        return provider.reportUsage(params);
      },
    },
  };
}
