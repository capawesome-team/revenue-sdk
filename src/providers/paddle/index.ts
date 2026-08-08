import { RevenueError } from '../../errors.ts';
import { HttpClient, type ProviderErrorInfo } from '../../http.ts';
import { assertSameOriginUrl, clampLimit, decodeCursor, encodeCursor } from '../../pagination.ts';
import type {
  PauseBehavior,
  ProrationBehavior,
  RevenueCapabilities,
  RevenueProvider,
} from '../../types.ts';
import { requireOptions, unsupported } from '../shared.ts';
import {
  toCheckout,
  toCustomer,
  toOrderFromTransaction,
  toProduct,
  toSubscription,
  type PaddleCustomer,
  type PaddleListResponse,
  type PaddleProduct,
  type PaddleResponse,
  type PaddleSubscription,
  type PaddleTransaction,
} from './common.ts';

const PRODUCTION_BASE_URL = 'https://api.paddle.com';
const SANDBOX_BASE_URL = 'https://sandbox-api.paddle.com';
const DEFAULT_PAGE_LIMIT = 10;
const MAX_PAGE_LIMIT = 200;
/** `/transactions` rejects a `per_page` above 30, unlike every other collection. */
const MAX_TRANSACTION_PAGE_LIMIT = 30;

const CAPABILITIES: RevenueCapabilities = {
  cancellationReason: false,
  // A transaction item is either a catalog `price_id` (which carries no amount field) or a
  // fully specified ad-hoc `price` object — mutually exclusive, and neither re-prices a catalog
  // price.
  checkoutCustomAmount: false,
  // Transactions carry no checkout expiry field.
  checkoutExpiresAt: false,
  checkoutStatus: true,
  // Success redirects are configured in Paddle.js on the merchant's checkout page.
  checkoutSuccessUrl: false,
  customerMetadata: true,
  endTrial: true,
  // The returned checkout URL requires the merchant's own Paddle.js page (default payment
  // link) — there is no Paddle-hosted checkout via the API.
  hostedCheckout: false,
  // Paddle Classic generated and activated license keys; Billing v1 dropped them with no
  // equivalent, and Classic takes no new signups.
  licenseKeys: false,
  listOrdersByCustomer: true,
  listSubscriptionsByCustomer: true,
  pause: true,
  pauseBehaviors: ['immediately', 'period_end'],
  portalReturnUrl: false,
  prorationBehaviors: ['invoice_now', 'none', 'prorate'],
  revoke: true,
  uncancel: true,
  // Paddle has no usage API at all; usage must be metered externally and billed as a one-time
  // charge (`POST /subscriptions/{id}/charge`) with a price the merchant computes itself.
  usageReporting: false,
};

export interface PaddleProviderOptions {
  apiKey: string;
  server?: 'production' | 'sandbox';
  /** Overrides `server`; used verbatim. */
  baseUrl?: string;
  fetch?: typeof fetch;
}

interface CursorState {
  url: string;
}

const AUTH_ERROR_CODES = new Set([
  'authentication_malformed',
  'authentication_missing',
  'invalid_token',
]);

function mapError(status: number, body: unknown): ProviderErrorInfo {
  if (body === null || typeof body !== 'object') {
    return {};
  }
  const { error } = body as { error?: { code?: unknown; detail?: unknown } };
  const info: ProviderErrorInfo = {};
  if (typeof error?.detail === 'string') {
    info.message = error.detail;
  }
  // Paddle reports authentication failures as 403, which would otherwise map to `forbidden`.
  if (typeof error?.code === 'string' && AUTH_ERROR_CODES.has(error.code)) {
    info.code = 'unauthorized';
  }
  return info;
}

function toProrationBillingMode(behavior: ProrationBehavior | undefined): string {
  switch (behavior) {
    case 'invoice_now':
      return 'prorated_immediately';
    case 'none':
      return 'do_not_bill';
    // Paddle requires the field on every items change; `prorate` (defer the prorated
    // difference to the next invoice) is the unified default.
    default:
      return 'prorated_next_billing_period';
  }
}

function toPauseEffectiveFrom(behavior: PauseBehavior | undefined): string | undefined {
  switch (behavior) {
    case 'immediately':
      return 'immediately';
    case 'period_end':
      return 'next_billing_period';
    // Omitting the field lets Paddle apply its own default (`next_billing_period`).
    default:
      return undefined;
  }
}

export function paddle(options: PaddleProviderOptions): RevenueProvider {
  requireOptions('paddle', { apiKey: options.apiKey });
  const baseUrl =
    options.baseUrl ?? (options.server === 'sandbox' ? SANDBOX_BASE_URL : PRODUCTION_BASE_URL);
  const http = new HttpClient({
    provider: 'paddle',
    baseUrl,
    fetchImpl: options.fetch,
    authHeaders: () => ({ Authorization: `Bearer ${options.apiKey}` }),
    defaultHeaders: { 'Paddle-Version': '1' },
    mapError,
    secrets: () => [options.apiKey],
  });

  async function listPage<T>(
    path: string,
    query: Record<string, string | number | boolean | undefined>,
    cursor: string | undefined,
    limit: number | undefined,
    signal: AbortSignal | undefined,
  ): Promise<{ data: T[]; cursor?: string }> {
    let response: PaddleListResponse<T>;
    if (cursor === undefined) {
      const result = await http.json<PaddleListResponse<T>>(path, {
        query: { ...query, per_page: clampLimit(limit, DEFAULT_PAGE_LIMIT, MAX_PAGE_LIMIT) },
        signal,
      });
      response = result.data;
    } else {
      // Paddle's `next` URL already carries the original filters and cursor.
      const { url } = decodeCursor<CursorState>('paddle', cursor);
      assertSameOriginUrl('paddle', baseUrl, url);
      const result = await http.json<PaddleListResponse<T>>(url, { signal });
      response = result.data;
    }
    const next = response.meta?.pagination?.next;
    const hasMore = response.meta?.pagination?.has_more ?? false;
    return {
      data: response.data,
      cursor: hasMore && next ? encodeCursor<CursorState>('paddle', { url: next }) : undefined,
    };
  }

  async function findOrCreateCustomerByEmail(
    email: string,
    signal: AbortSignal | undefined,
  ): Promise<string> {
    const { data: existing } = await http.json<PaddleListResponse<PaddleCustomer>>('/customers', {
      query: { email },
      signal,
    });
    const match = existing.data[0];
    if (match) {
      return match.id;
    }
    const { data: created } = await http.json<PaddleResponse<PaddleCustomer>>('/customers', {
      method: 'POST',
      body: { email },
      signal,
    });
    return created.data.id;
  }

  async function postSubscription(
    path: string,
    body: Record<string, unknown> | undefined,
    signal: AbortSignal | undefined,
  ) {
    const { data } = await http.json<PaddleResponse<PaddleSubscription>>(path, {
      method: 'POST',
      body: body ?? {},
      signal,
    });
    return toSubscription(data.data);
  }

  return {
    name: 'paddle',
    capabilities: CAPABILITIES,

    async listProducts(params) {
      const page = await listPage<PaddleProduct>(
        '/products',
        { status: 'active', include: 'prices' },
        params.cursor,
        params.limit,
        params.signal,
      );
      return { items: page.data.map(toProduct), cursor: page.cursor };
    },

    async getProduct(params) {
      const { data } = await http.json<PaddleResponse<PaddleProduct>>(`/products/${params.id}`, {
        query: { include: 'prices' },
        signal: params.signal,
      });
      return toProduct(data.data);
    },

    async createCheckout(params) {
      if (params.successUrl !== undefined) {
        throw unsupported('paddle', 'a checkout success URL; configure it in Paddle.js instead');
      }
      let customerId = params.customerId;
      if (customerId === undefined && params.customerEmail !== undefined) {
        customerId = await findOrCreateCustomerByEmail(params.customerEmail, params.signal);
      }
      const { data } = await http.json<PaddleResponse<PaddleTransaction>>('/transactions', {
        method: 'POST',
        body: {
          items: params.items.map((item) => ({
            price_id: item.product,
            quantity: item.quantity ?? 1,
          })),
          customer_id: customerId,
          custom_data: params.metadata,
        },
        signal: params.signal,
      });
      return toCheckout(data.data);
    },

    async getCheckout(params) {
      const { data } = await http.json<PaddleResponse<PaddleTransaction>>(
        `/transactions/${params.id}`,
        { signal: params.signal },
      );
      return toCheckout(data.data);
    },

    async getCustomer(params) {
      const { data } = await http.json<PaddleResponse<PaddleCustomer>>(`/customers/${params.id}`, {
        signal: params.signal,
      });
      return toCustomer(data.data);
    },

    async listCustomers(params) {
      const page = await listPage<PaddleCustomer>(
        '/customers',
        { email: params.email },
        params.cursor,
        params.limit,
        params.signal,
      );
      return { items: page.data.map(toCustomer), cursor: page.cursor };
    },

    async createCustomer(params) {
      // Paddle answers 409 `customer_already_exists` when the email is taken, which surfaces as
      // `conflict` — the existing customer's ID is in the error detail.
      const { data } = await http.json<PaddleResponse<PaddleCustomer>>('/customers', {
        method: 'POST',
        body: { email: params.email, name: params.name, custom_data: params.metadata },
        signal: params.signal,
      });
      return toCustomer(data.data);
    },

    async updateCustomer(params) {
      // `custom_data` is replaced as a whole, like Paddle's list fields. It is sent as given
      // rather than merged into the stored object: a GET-merge would make clearing a key
      // impossible and would silently resurrect entries the caller left out.
      const { data } = await http.json<PaddleResponse<PaddleCustomer>>(`/customers/${params.id}`, {
        method: 'PATCH',
        body: { email: params.email, name: params.name, custom_data: params.metadata },
        signal: params.signal,
      });
      return toCustomer(data.data);
    },

    async getSubscription(params) {
      const { data } = await http.json<PaddleResponse<PaddleSubscription>>(
        `/subscriptions/${params.id}`,
        { signal: params.signal },
      );
      return toSubscription(data.data);
    },

    async listSubscriptions(params) {
      const page = await listPage<PaddleSubscription>(
        '/subscriptions',
        { customer_id: params.customerId },
        params.cursor,
        params.limit,
        params.signal,
      );
      return { items: page.data.map(toSubscription), cursor: page.cursor };
    },

    async cancelSubscription(params) {
      if (params.reason !== undefined || params.comment !== undefined) {
        throw unsupported('paddle', 'cancellation reasons');
      }
      return postSubscription(
        `/subscriptions/${params.id}/cancel`,
        { effective_from: 'next_billing_period' },
        params.signal,
      );
    },

    async uncancelSubscription(params) {
      const { data } = await http.json<PaddleResponse<PaddleSubscription>>(
        `/subscriptions/${params.id}`,
        {
          method: 'PATCH',
          body: { scheduled_change: null },
          signal: params.signal,
        },
      );
      return toSubscription(data.data);
    },

    async changeSubscriptionPlan(params) {
      // `items` is a full replacement; the unified model targets single-product
      // subscriptions, so the new price replaces all existing items.
      const { data } = await http.json<PaddleResponse<PaddleSubscription>>(
        `/subscriptions/${params.id}`,
        {
          method: 'PATCH',
          body: {
            items: [{ price_id: params.product, quantity: params.quantity ?? 1 }],
            proration_billing_mode: toProrationBillingMode(params.prorationBehavior),
          },
          signal: params.signal,
        },
      );
      return toSubscription(data.data);
    },

    async endSubscriptionTrial(params) {
      // Activates a trialing subscription: bills immediately and starts the billing cycle.
      return postSubscription(`/subscriptions/${params.id}/activate`, undefined, params.signal);
    },

    async pauseSubscription(params) {
      return postSubscription(
        `/subscriptions/${params.id}/pause`,
        {
          effective_from: toPauseEffectiveFrom(params.behavior),
          resume_at: params.resumesAt?.toISOString(),
        },
        params.signal,
      );
    },

    async resumeSubscription(params) {
      // `effective_from` is required by Paddle; the unified resume is always immediate.
      return postSubscription(
        `/subscriptions/${params.id}/resume`,
        { effective_from: 'immediately' },
        params.signal,
      );
    },

    async revokeSubscription(params) {
      return postSubscription(
        `/subscriptions/${params.id}/cancel`,
        { effective_from: 'immediately' },
        params.signal,
      );
    },

    async createCustomerPortalSession(params) {
      if (params.returnUrl !== undefined) {
        throw unsupported('paddle', 'a return URL on customer portal sessions');
      }
      const { data } = await http.json<
        PaddleResponse<{ urls?: { general?: { overview?: string } } }>
      >(`/customers/${params.customerId}/portal-sessions`, {
        method: 'POST',
        body: {},
        signal: params.signal,
      });
      const url = data.data.urls?.general?.overview;
      if (!url) {
        throw new RevenueError('Paddle did not return a customer portal URL', {
          code: 'provider_error',
          provider: 'paddle',
        });
      }
      return { url, raw: data.data };
    },

    async reportUsage() {
      throw unsupported('paddle', 'usage reporting');
    },

    async listOrders(params) {
      const page = await listPage<PaddleTransaction>(
        '/transactions',
        {
          customer_id: params.customerId,
          // `draft` and `ready` transactions are abandoned checkouts, and Paddle returns them
          // by default — they are not billing history.
          status: 'completed',
          // Transactions default to `id[DESC]`, which is not a chronological order.
          order_by: 'billed_at[DESC]',
          // Refunds live on separate Adjustment entities; the include keeps `refundStatus`
          // free of an extra request.
          include: 'adjustments_totals',
        },
        params.cursor,
        clampLimit(params.limit, DEFAULT_PAGE_LIMIT, MAX_TRANSACTION_PAGE_LIMIT),
        params.signal,
      );
      return { items: page.data.map(toOrderFromTransaction), cursor: page.cursor };
    },

    async getOrder(params) {
      const { data } = await http.json<PaddleResponse<PaddleTransaction>>(
        `/transactions/${params.id}`,
        { query: { include: 'adjustments_totals' }, signal: params.signal },
      );
      return toOrderFromTransaction(data.data);
    },

    async getOrderInvoiceUrl(params) {
      // The minted URL expires after an hour, so it is fetched on demand and never stored.
      const { data } = await http.json<PaddleResponse<{ url?: string | null }>>(
        `/transactions/${params.id}/invoice`,
        { query: { disposition: 'inline' }, signal: params.signal },
      );
      const url = data.data.url;
      if (!url) {
        throw new RevenueError(
          `Paddle has no invoice for transaction ${params.id}; invoices exist only for billed or completed transactions with a non-zero total`,
          { code: 'not_found', provider: 'paddle' },
        );
      }
      return url;
    },

    async listLicenseKeys() {
      throw unsupported('paddle', 'license keys');
    },

    async getLicenseKey() {
      throw unsupported('paddle', 'license keys');
    },

    async updateLicenseKey() {
      throw unsupported('paddle', 'license keys');
    },
  };
}
