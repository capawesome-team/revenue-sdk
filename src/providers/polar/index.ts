import { HttpClient } from '../../http.ts';
import { pageNumberCursor } from '../../pagination.ts';
import type { ProrationBehavior, RevenueCapabilities, RevenueProvider } from '../../types.ts';
import { requireOptions, toUsagePayload, unsupported } from '../shared.ts';
import {
  mapError,
  toBaseUrl,
  toCheckout,
  toCustomer,
  toLicenseKey,
  toOrder,
  toProduct,
  toSubscription,
  type PolarCheckout,
  type PolarCustomer,
  type PolarLicenseKey,
  type PolarListResponse,
  type PolarOrder,
  type PolarProduct,
  type PolarSubscription,
} from './common.ts';

const DEFAULT_PAGE_LIMIT = 10;
const MAX_PAGE_LIMIT = 100;
// Polar's list applies no status filter of its own, so unbilled `draft` orders would surface.
// The filter accepts repeated values, so drafts are excluded server-side and paging stays exact.
const LISTED_ORDER_STATUSES = ['pending', 'paid', 'refunded', 'partially_refunded', 'void'];

const CAPABILITIES: RevenueCapabilities = {
  cancellationReason: true,
  // Polar expires every checkout 24 hours after creation and accepts no override.
  checkoutExpiresAt: false,
  checkoutStatus: true,
  checkoutSuccessUrl: true,
  endTrial: true,
  hostedCheckout: true,
  licenseKeys: true,
  listOrdersByCustomer: true,
  listSubscriptionsByCustomer: true,
  pause: true,
  pauseBehaviors: ['period_end'],
  portalReturnUrl: true,
  // Polar's `next_period` defers the plan change itself and `reset` restarts the billing
  // anchor — neither matches the unified `none` ("switch now, bill nothing extra").
  prorationBehaviors: ['invoice_now', 'prorate'],
  revoke: true,
  uncancel: true,
  usageReporting: true,
};

export interface PolarProviderOptions {
  /** Organization access token (`polar_oat_...`). */
  accessToken: string;
  server?: 'production' | 'sandbox';
  /** Overrides `server`; used verbatim. */
  baseUrl?: string;
  fetch?: typeof fetch;
}

interface PolarCustomerSession {
  customer_portal_url: string;
}

interface PolarOrderInvoice {
  url: string;
}

function toLicenseKeyUpdateStatus(disabled: boolean | undefined): string | undefined {
  if (disabled === undefined) {
    return undefined;
  }
  // Polar's benefit lifecycle owns `revoked` and re-grants such keys automatically on renewal;
  // `disabled` is the merchant-controlled state it never touches.
  return disabled ? 'disabled' : 'granted';
}

function toLicenseKeyExpiresAt(expiresAt: Date | null | undefined): string | null | undefined {
  return expiresAt === null ? null : expiresAt?.toISOString();
}

function toProrationBehavior(behavior: ProrationBehavior | undefined): string | undefined {
  switch (behavior) {
    case undefined:
      return undefined;
    case 'invoice_now':
      return 'invoice';
    case 'prorate':
      return 'prorate';
    default:
      throw unsupported('polar', `the ${behavior} proration behavior`);
  }
}

const pages = pageNumberCursor('polar', {
  startPage: 1,
  defaultLimit: DEFAULT_PAGE_LIMIT,
  maxLimit: MAX_PAGE_LIMIT,
  pageKey: 'page',
  limitKey: 'limit',
});

export function polar(options: PolarProviderOptions): RevenueProvider {
  requireOptions('polar', { accessToken: options.accessToken });
  const http = new HttpClient({
    provider: 'polar',
    baseUrl: toBaseUrl(options),
    fetchImpl: options.fetch,
    authHeaders: () => ({ Authorization: `Bearer ${options.accessToken}` }),
    mapError,
    secrets: () => [options.accessToken],
  });

  async function patchSubscription(
    id: string,
    body: Record<string, unknown>,
    signal: AbortSignal | undefined,
  ) {
    const { data } = await http.json<PolarSubscription>(`/v1/subscriptions/${id}`, {
      method: 'PATCH',
      body,
      signal,
    });
    return toSubscription(data);
  }

  return {
    name: 'polar',
    capabilities: CAPABILITIES,

    async listProducts(params) {
      const { page, query } = pages.read(params.cursor, params.limit);
      const { data } = await http.json<PolarListResponse<PolarProduct>>('/v1/products/', {
        query: { ...query, is_archived: false },
        signal: params.signal,
      });
      return {
        items: data.items.map(toProduct),
        cursor: pages.next(page, page < data.pagination.max_page),
      };
    },

    async getProduct(params) {
      const { data } = await http.json<PolarProduct>(`/v1/products/${params.id}`, {
        signal: params.signal,
      });
      return toProduct(data);
    },

    async createCheckout(params) {
      const products = params.items.map((item) => {
        if (item.quantity !== undefined && item.quantity !== 1) {
          throw unsupported('polar', 'item quantities on checkouts');
        }
        return item.product;
      });
      const { data } = await http.json<PolarCheckout>('/v1/checkouts/', {
        method: 'POST',
        body: {
          products,
          success_url: params.successUrl,
          customer_id: params.customerId,
          customer_email: params.customerEmail,
          metadata: params.metadata,
        },
        signal: params.signal,
      });
      return toCheckout(data);
    },

    async getCheckout(params) {
      const { data } = await http.json<PolarCheckout>(`/v1/checkouts/${params.id}`, {
        signal: params.signal,
      });
      return toCheckout(data);
    },

    async getCustomer(params) {
      const { data } = await http.json<PolarCustomer>(`/v1/customers/${params.id}`, {
        signal: params.signal,
      });
      return toCustomer(data);
    },

    async listCustomers(params) {
      const { page, query } = pages.read(params.cursor, params.limit);
      const { data } = await http.json<PolarListResponse<PolarCustomer>>('/v1/customers/', {
        query: { ...query, email: params.email },
        signal: params.signal,
      });
      return {
        items: data.items.map(toCustomer),
        cursor: pages.next(page, page < data.pagination.max_page),
      };
    },

    async createCustomer(params) {
      // The organization is taken from the access token, so `organization_id` is not sent.
      // Polar caps metadata at 50 pairs, keys at 40 characters and string values at 500.
      const { data } = await http.json<PolarCustomer>('/v1/customers/', {
        method: 'POST',
        body: { email: params.email, name: params.name, metadata: params.metadata },
        signal: params.signal,
      });
      return toCustomer(data);
    },

    async updateCustomer(params) {
      const { data } = await http.json<PolarCustomer>(`/v1/customers/${params.id}`, {
        method: 'PATCH',
        body: { email: params.email, name: params.name, metadata: params.metadata },
        signal: params.signal,
      });
      return toCustomer(data);
    },

    async getSubscription(params) {
      const { data } = await http.json<PolarSubscription>(`/v1/subscriptions/${params.id}`, {
        signal: params.signal,
      });
      return toSubscription(data);
    },

    async listSubscriptions(params) {
      const { page, query } = pages.read(params.cursor, params.limit);
      const { data } = await http.json<PolarListResponse<PolarSubscription>>('/v1/subscriptions/', {
        query: { ...query, customer_id: params.customerId },
        signal: params.signal,
      });
      return {
        items: data.items.map(toSubscription),
        cursor: pages.next(page, page < data.pagination.max_page),
      };
    },

    async cancelSubscription(params) {
      return patchSubscription(
        params.id,
        {
          cancel_at_period_end: true,
          customer_cancellation_reason: params.reason,
          customer_cancellation_comment: params.comment,
        },
        params.signal,
      );
    },

    async uncancelSubscription(params) {
      return patchSubscription(params.id, { cancel_at_period_end: false }, params.signal);
    },

    async changeSubscriptionPlan(params) {
      if (params.quantity !== undefined && params.quantity !== 1) {
        throw unsupported('polar', 'quantities on plan changes');
      }
      return patchSubscription(
        params.id,
        {
          product_id: params.product,
          proration_behavior: toProrationBehavior(params.prorationBehavior),
        },
        params.signal,
      );
    },

    async endSubscriptionTrial(params) {
      return patchSubscription(params.id, { trial_end: 'now' }, params.signal);
    },

    async pauseSubscription(params) {
      // Polar only pauses at the end of the current period; `resumes_at` must fall after it.
      // `SubscriptionUpdate` is an exclusive union, so the pause fields must be sent on their own.
      return patchSubscription(
        params.id,
        { pause_at_period_end: true, resumes_at: params.resumesAt?.toISOString() },
        params.signal,
      );
    },

    async resumeSubscription(params) {
      // Resuming takes effect immediately: it starts a new billing period and charges the customer.
      return patchSubscription(params.id, { resume: true }, params.signal);
    },

    async revokeSubscription(params) {
      const { data } = await http.json<PolarSubscription>(`/v1/subscriptions/${params.id}`, {
        method: 'DELETE',
        signal: params.signal,
      });
      return toSubscription(data);
    },

    async createCustomerPortalSession(params) {
      const { data } = await http.json<PolarCustomerSession>('/v1/customer-sessions/', {
        method: 'POST',
        body: {
          customer_id: params.customerId,
          return_url: params.returnUrl,
        },
        signal: params.signal,
      });
      return { url: data.customer_portal_url, raw: data };
    },

    async reportUsage(params) {
      // Ingestion is batch-only — there is no single-event endpoint — so we send a one-event batch.
      // `/v1/events/ingest` is an action, not a collection: no trailing slash (unlike `/v1/events/`).
      await http.json('/v1/events/ingest', {
        method: 'POST',
        body: {
          events: [
            {
              name: params.eventName,
              // Polar also accepts `external_customer_id` for your own user IDs; the unified
              // `customerId` is always the provider's ID, so external keying needs the native API.
              customer_id: params.customerId,
              // Polar attributes events to billing periods by receipt time and never issues
              // retroactive invoices, so a backdated timestamp only affects reporting.
              timestamp: params.timestamp?.toISOString(),
              // Deduplication is a permanent unique index on (organization, external_id).
              external_id: params.idempotencyKey,
              // Polar caps metadata at 50 pairs, keys at 40 characters and string values at 500.
              metadata: toUsagePayload(params),
            },
          ],
        },
        signal: params.signal,
      });
    },

    async listOrders(params) {
      const { page, query } = pages.read(params.cursor, params.limit);
      const { data } = await http.json<PolarListResponse<PolarOrder>>('/v1/orders/', {
        // Polar already sorts by `-created_at`.
        query: { ...query, customer_id: params.customerId, status: LISTED_ORDER_STATUSES },
        signal: params.signal,
      });
      return {
        items: data.items.map(toOrder),
        cursor: pages.next(page, page < data.pagination.max_page),
      };
    },

    async getOrder(params) {
      const { data } = await http.json<PolarOrder>(`/v1/orders/${params.id}`, {
        signal: params.signal,
      });
      return toOrder(data);
    },

    async getOrderInvoiceUrl(params) {
      // Polar presigns the URL for 600 seconds, so it can only be read on demand. It 404s until
      // the invoice exists; generating one (`POST /v1/orders/{id}/invoice`) is an asynchronous
      // 202 job that this method cannot wait on, so the `not_found` is surfaced as-is.
      const { data } = await http.json<PolarOrderInvoice>(`/v1/orders/${params.id}/invoice`, {
        signal: params.signal,
      });
      return data.url;
    },

    async listLicenseKeys(params) {
      const { page, query } = pages.read(params.cursor, params.limit);
      const { data } = await http.json<PolarListResponse<PolarLicenseKey>>('/v1/license-keys/', {
        query,
        signal: params.signal,
      });
      return {
        items: data.items.map(toLicenseKey),
        cursor: pages.next(page, page < data.pagination.max_page),
      };
    },

    async getLicenseKey(params) {
      const { data } = await http.json<PolarLicenseKey>(`/v1/license-keys/${params.id}`, {
        signal: params.signal,
      });
      return toLicenseKey(data);
    },

    async updateLicenseKey(params) {
      const { data } = await http.json<PolarLicenseKey>(`/v1/license-keys/${params.id}`, {
        method: 'PATCH',
        body: {
          status: toLicenseKeyUpdateStatus(params.disabled),
          limit_activations: params.activationLimit,
          expires_at: toLicenseKeyExpiresAt(params.expiresAt),
        },
        signal: params.signal,
      });
      return toLicenseKey(data);
    },
  };
}
