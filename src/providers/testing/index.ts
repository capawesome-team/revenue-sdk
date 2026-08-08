import { RevenueError } from '../../errors.ts';
import { decodeCursor, encodeCursor } from '../../pagination.ts';
import type {
  BillingInterval,
  Checkout,
  Customer,
  LicenseKey,
  LicenseKeyStatus,
  Metadata,
  Order,
  OrderStatus,
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
import { toUsagePayload } from '../shared.ts';

// Deliberately tiny so consumers exercise cursor handling in their tests.
const PAGE_SIZE = 2;

const DEFAULT_CAPABILITIES: RevenueCapabilities = {
  cancellationReason: true,
  checkoutExpiresAt: true,
  checkoutStatus: true,
  checkoutSuccessUrl: true,
  endTrial: true,
  hostedCheckout: true,
  licenseKeys: true,
  listOrdersByCustomer: true,
  listSubscriptionsByCustomer: true,
  pause: true,
  pauseBehaviors: ['immediately', 'period_end'],
  portalReturnUrl: true,
  prorationBehaviors: ['invoice_now', 'none', 'prorate'],
  revoke: true,
  uncancel: true,
  usageReporting: true,
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

export interface InMemoryOrderSeed {
  id?: string;
  status?: OrderStatus;
  amount?: number;
  currency?: string;
  customerId?: string;
  customerEmail?: string;
  subscriptionId?: string;
  createdAt?: Date;
  refundStatus?: 'full' | 'partial';
  metadata?: Metadata;
}

export interface InMemoryLicenseKeySeed {
  id?: string;
  key?: string;
  status?: LicenseKeyStatus;
  activationLimit?: number;
  activationCount?: number;
  expiresAt?: Date;
  customerId?: string;
  productId?: string;
}

export interface InMemorySeed {
  products?: InMemoryProductSeed[];
  customers?: InMemoryCustomerSeed[];
  subscriptions?: InMemorySubscriptionSeed[];
  orders?: InMemoryOrderSeed[];
  licenseKeys?: InMemoryLicenseKeySeed[];
}

export interface InMemoryUsageEvent {
  customerId: string;
  eventName: string;
  /** `metadata` with `value` merged in, exactly as a real provider would receive it. */
  payload: Metadata;
  idempotencyKey?: string;
  timestamp?: Date;
}

export interface InMemoryState {
  products: Product[];
  customers: Customer[];
  subscriptions: Subscription[];
  orders: Order[];
  licenseKeys: LicenseKey[];
  checkouts: Checkout[];
  usageEvents: InMemoryUsageEvent[];
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
    orders: (seed.orders ?? []).map((order) => ({
      id: order.id ?? nextId('order'),
      status: order.status ?? 'paid',
      amount: order.amount,
      currency: order.currency,
      customerId: order.customerId,
      customerEmail: order.customerEmail,
      subscriptionId: order.subscriptionId,
      createdAt: order.createdAt,
      refundStatus: order.refundStatus,
      metadata: order.metadata,
      raw: order,
    })),
    licenseKeys: (seed.licenseKeys ?? []).map((licenseKey) => {
      const id = licenseKey.id ?? nextId('license-key');
      return {
        id,
        key: licenseKey.key ?? id,
        status: licenseKey.status ?? 'active',
        activationLimit: licenseKey.activationLimit,
        activationCount: licenseKey.activationCount,
        expiresAt: licenseKey.expiresAt,
        customerId: licenseKey.customerId,
        productId: licenseKey.productId,
        raw: licenseKey,
      };
    }),
    checkouts: [],
    usageEvents: [],
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

  function getCustomerById(id: string): Customer {
    const customer = state.customers.find((entry) => entry.id === id);
    if (!customer) {
      throw notFound('customer', id);
    }
    return customer;
  }

  function getSubscriptionById(id: string): Subscription {
    const subscription = state.subscriptions.find((entry) => entry.id === id);
    if (!subscription) {
      throw notFound('subscription', id);
    }
    return subscription;
  }

  function getOrderById(id: string): Order {
    const order = state.orders.find((entry) => entry.id === id);
    if (!order) {
      throw notFound('order', id);
    }
    return order;
  }

  function getLicenseKeyById(id: string): LicenseKey {
    const licenseKey = state.licenseKeys.find((entry) => entry.id === id);
    if (!licenseKey) {
      throw notFound('license key', id);
    }
    return licenseKey;
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
        expiresAt: params.expiresAt,
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
      return getCustomerById(params.id);
    },

    async listCustomers(params) {
      const items = params.email
        ? state.customers.filter((entry) => entry.email === params.email)
        : state.customers;
      return paginate(items, params.cursor);
    },

    async createCustomer(params) {
      const customer: Customer = {
        id: nextId('customer'),
        email: params.email,
        name: params.name,
        metadata: params.metadata,
        createdAt: new Date(),
        raw: params,
      };
      state.customers.push(customer);
      return customer;
    },

    async updateCustomer(params) {
      const customer = getCustomerById(params.id);
      if (params.email !== undefined) {
        customer.email = params.email;
      }
      if (params.name !== undefined) {
        customer.name = params.name;
      }
      if (params.metadata !== undefined) {
        customer.metadata = params.metadata;
      }
      return customer;
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
        subscription.pauseAtPeriodEnd = false;
      }
      // Omitting `resumesAt` means "pause indefinitely", so it always replaces any earlier value.
      subscription.resumesAt = params.resumesAt;
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
      const customer = getCustomerById(params.customerId);
      return { url: `https://portal.example.com/${params.customerId}`, raw: customer };
    },

    async reportUsage(params) {
      state.usageEvents.push({
        customerId: params.customerId,
        eventName: params.eventName,
        payload: toUsagePayload(params) ?? {},
        idempotencyKey: params.idempotencyKey,
        timestamp: params.timestamp,
      });
    },

    async listOrders(params) {
      const items = params.customerId
        ? state.orders.filter((entry) => entry.customerId === params.customerId)
        : state.orders;
      return paginate(items, params.cursor);
    },

    async getOrder(params) {
      return getOrderById(params.id);
    },

    async getOrderInvoiceUrl(params) {
      return `https://invoices.example.com/${getOrderById(params.id).id}`;
    },

    async listLicenseKeys(params) {
      return paginate(state.licenseKeys, params.cursor);
    },

    async getLicenseKey(params) {
      return getLicenseKeyById(params.id);
    },

    async updateLicenseKey(params) {
      const licenseKey = getLicenseKeyById(params.id);
      if (params.disabled !== undefined) {
        licenseKey.status = params.disabled ? 'disabled' : 'active';
      }
      if (params.activationLimit !== undefined) {
        licenseKey.activationLimit = params.activationLimit ?? undefined;
      }
      if (params.expiresAt !== undefined) {
        licenseKey.expiresAt = params.expiresAt ?? undefined;
      }
      return licenseKey;
    },
  };
}
