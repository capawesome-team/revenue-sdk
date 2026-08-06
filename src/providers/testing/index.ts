import { RevenueError } from '../../errors.ts';
import { decodeCursor, encodeCursor } from '../../pagination.ts';
import type {
  BillingInterval,
  Checkout,
  Customer,
  Metadata,
  Page,
  PriceModel,
  PriceType,
  Product,
  ProviderName,
  RevenueCapabilities,
  RevenueProvider,
  Subscription,
  SubscriptionStatus,
} from '../../types.ts';

// Deliberately tiny so consumers exercise cursor handling in their tests.
const PAGE_SIZE = 2;

const DEFAULT_CAPABILITIES: RevenueCapabilities = {
  cancellationReason: true,
  checkoutStatus: true,
  checkoutSuccessUrl: true,
  endTrial: true,
  hostedCheckout: true,
  listSubscriptionsByCustomer: true,
  pause: true,
  pauseBehaviors: ['immediately', 'period_end'],
  portalReturnUrl: true,
  prorationBehaviors: ['invoice_now', 'none', 'prorate'],
  revoke: true,
  uncancel: true,
};

export interface InMemoryPriceSeed {
  id?: string;
  checkoutRef?: string;
  type?: PriceType;
  model?: PriceModel;
  amount?: number | null;
  currency?: string;
  interval?: BillingInterval;
  intervalCount?: number;
  trialDays?: number;
}

export interface InMemoryProductSeed {
  id?: string;
  name?: string;
  description?: string;
  prices?: InMemoryPriceSeed[];
}

export interface InMemoryCustomerSeed {
  id?: string;
  email?: string;
  name?: string;
  metadata?: Metadata;
}

export interface InMemorySubscriptionSeed {
  id?: string;
  status?: SubscriptionStatus;
  cancelAtPeriodEnd?: boolean;
  pauseAtPeriodEnd?: boolean;
  customerId?: string;
  productId?: string;
  quantity?: number;
  currency?: string;
  amount?: number;
  interval?: BillingInterval;
  currentPeriodEnd?: Date;
  trialEndsAt?: Date;
  resumesAt?: Date;
  endsAt?: Date;
  metadata?: Metadata;
}

export interface InMemorySeed {
  products?: InMemoryProductSeed[];
  customers?: InMemoryCustomerSeed[];
  subscriptions?: InMemorySubscriptionSeed[];
}

export interface InMemoryState {
  products: Product[];
  customers: Customer[];
  subscriptions: Subscription[];
  checkouts: Checkout[];
}

export interface InMemoryProviderOptions {
  /** Simulate a specific provider's identity. */
  name?: ProviderName;
  /** Simulate a specific provider's capability set. */
  capabilities?: Partial<RevenueCapabilities>;
}

export type InMemoryProvider = RevenueProvider & { state: InMemoryState };

export function createInMemoryProvider(
  seed: InMemorySeed = {},
  options: InMemoryProviderOptions = {},
): InMemoryProvider {
  const name = options.name ?? 'testing';
  const capabilities: RevenueCapabilities = { ...DEFAULT_CAPABILITIES, ...options.capabilities };
  let sequence = 0;
  const nextId = (prefix: string) => `${prefix}-${++sequence}`;

  const state: InMemoryState = {
    products: (seed.products ?? []).map((product) => {
      const id = product.id ?? nextId('product');
      return {
        id,
        name: product.name ?? id,
        description: product.description,
        prices: (product.prices ?? []).map((price) => ({
          id: price.id ?? nextId('price'),
          checkoutRef: price.checkoutRef ?? id,
          type: price.type ?? 'recurring',
          model: price.model ?? 'fixed',
          amount: price.amount === undefined ? 1000 : price.amount,
          currency: price.currency ?? 'usd',
          interval: price.interval ?? (price.type === 'one_time' ? undefined : 'month'),
          intervalCount: price.intervalCount,
          trialDays: price.trialDays,
          raw: price,
        })),
        raw: product,
      };
    }),
    customers: (seed.customers ?? []).map((customer) => {
      const id = customer.id ?? nextId('customer');
      return {
        id,
        email: customer.email ?? `${id}@example.com`,
        name: customer.name,
        metadata: customer.metadata,
        createdAt: new Date(0),
        raw: customer,
      };
    }),
    subscriptions: (seed.subscriptions ?? []).map((subscription) => ({
      id: subscription.id ?? nextId('subscription'),
      status: subscription.status ?? 'active',
      cancelAtPeriodEnd: subscription.cancelAtPeriodEnd ?? false,
      pauseAtPeriodEnd: subscription.pauseAtPeriodEnd ?? false,
      customerId: subscription.customerId ?? 'customer-1',
      productId: subscription.productId,
      quantity: subscription.quantity,
      currency: subscription.currency,
      amount: subscription.amount,
      interval: subscription.interval,
      currentPeriodEnd: subscription.currentPeriodEnd,
      trialEndsAt: subscription.trialEndsAt,
      resumesAt: subscription.resumesAt,
      endsAt: subscription.endsAt,
      metadata: subscription.metadata,
      raw: subscription,
    })),
    checkouts: [],
  };

  function notFound(resource: string, id: string): RevenueError {
    return new RevenueError(`No ${resource} with id ${id}`, { code: 'not_found', provider: name });
  }

  function paginate<T>(items: T[], cursor: string | undefined): Page<T> {
    const offset = cursor ? decodeCursor<{ offset: number }>(name, cursor).offset : 0;
    const page = items.slice(offset, offset + PAGE_SIZE);
    return {
      items: page,
      cursor:
        offset + PAGE_SIZE < items.length
          ? encodeCursor(name, { offset: offset + PAGE_SIZE })
          : undefined,
    };
  }

  function getSubscriptionById(id: string): Subscription {
    const subscription = state.subscriptions.find((entry) => entry.id === id);
    if (!subscription) {
      throw notFound('subscription', id);
    }
    return subscription;
  }

  return {
    name,
    capabilities,
    state,

    async listProducts(params) {
      return paginate(state.products, params.cursor);
    },

    async getProduct(params) {
      const product = state.products.find((entry) => entry.id === params.id);
      if (!product) {
        throw notFound('product', params.id);
      }
      return product;
    },

    async createCheckout(params) {
      const id = nextId('checkout');
      const checkout: Checkout = {
        id,
        url: `https://checkout.example.com/${id}`,
        status: capabilities.checkoutStatus ? 'open' : null,
        customerId: params.customerId,
        customerEmail: params.customerEmail,
        metadata: params.metadata,
        raw: params,
      };
      state.checkouts.push(checkout);
      return checkout;
    },

    async getCheckout(params) {
      const checkout = state.checkouts.find((entry) => entry.id === params.id);
      if (!checkout) {
        throw notFound('checkout', params.id);
      }
      return checkout;
    },

    async getCustomer(params) {
      const customer = state.customers.find((entry) => entry.id === params.id);
      if (!customer) {
        throw notFound('customer', params.id);
      }
      return customer;
    },

    async listCustomers(params) {
      const items = params.email
        ? state.customers.filter((entry) => entry.email === params.email)
        : state.customers;
      return paginate(items, params.cursor);
    },

    async getSubscription(params) {
      return getSubscriptionById(params.id);
    },

    async listSubscriptions(params) {
      const items = params.customerId
        ? state.subscriptions.filter((entry) => entry.customerId === params.customerId)
        : state.subscriptions;
      return paginate(items, params.cursor);
    },

    async cancelSubscription(params) {
      const subscription = getSubscriptionById(params.id);
      subscription.cancelAtPeriodEnd = true;
      subscription.endsAt = subscription.currentPeriodEnd;
      return subscription;
    },

    async uncancelSubscription(params) {
      const subscription = getSubscriptionById(params.id);
      subscription.cancelAtPeriodEnd = false;
      subscription.endsAt = undefined;
      return subscription;
    },

    async changeSubscriptionPlan(params) {
      const subscription = getSubscriptionById(params.id);
      subscription.productId = params.product;
      if (params.quantity !== undefined) {
        subscription.quantity = params.quantity;
      }
      return subscription;
    },

    async endSubscriptionTrial(params) {
      const subscription = getSubscriptionById(params.id);
      subscription.status = 'active';
      subscription.trialEndsAt = undefined;
      return subscription;
    },

    async pauseSubscription(params) {
      const subscription = getSubscriptionById(params.id);
      if (params.behavior === 'period_end') {
        subscription.pauseAtPeriodEnd = true;
      } else {
        subscription.status = 'paused';
      }
      if (params.resumesAt !== undefined) {
        subscription.resumesAt = params.resumesAt;
      }
      return subscription;
    },

    async resumeSubscription(params) {
      const subscription = getSubscriptionById(params.id);
      subscription.status = 'active';
      subscription.pauseAtPeriodEnd = false;
      subscription.resumesAt = undefined;
      return subscription;
    },

    async revokeSubscription(params) {
      const subscription = getSubscriptionById(params.id);
      subscription.status = 'canceled';
      subscription.cancelAtPeriodEnd = false;
      subscription.endedAt = new Date();
      return subscription;
    },

    async createCustomerPortalSession(params) {
      const customer = state.customers.find((entry) => entry.id === params.customerId);
      if (!customer) {
        throw notFound('customer', params.customerId);
      }
      return { url: `https://portal.example.com/${params.customerId}`, raw: customer };
    },
  };
}
