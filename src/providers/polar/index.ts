import { RevenueError } from '../../errors.ts';
import { HttpClient, type ProviderErrorInfo } from '../../http.ts';
import { clampLimit, decodeCursor, encodeCursor } from '../../pagination.ts';
import type { ProrationBehavior, RevenueCapabilities, RevenueProvider } from '../../types.ts';
import {
  toCheckout,
  toCustomer,
  toProduct,
  toSubscription,
  type PolarCheckout,
  type PolarCustomer,
  type PolarListResponse,
  type PolarProduct,
  type PolarSubscription,
} from './common.ts';

const PRODUCTION_BASE_URL = 'https://api.polar.sh';
const SANDBOX_BASE_URL = 'https://sandbox-api.polar.sh';
const DEFAULT_PAGE_LIMIT = 10;
const MAX_PAGE_LIMIT = 100;

const CAPABILITIES: RevenueCapabilities = {
  cancellationReason: true,
  checkoutStatus: true,
  endTrial: true,
  hostedCheckout: true,
  listSubscriptionsByCustomer: true,
  portalReturnUrl: true,
  // Polar's `next_period` defers the plan change itself and `reset` restarts the billing
  // anchor — neither matches the unified `none` ("switch now, bill nothing extra").
  prorationBehaviors: ['invoice_now', 'prorate'],
  revoke: true,
  uncancel: true,
};

export interface PolarProviderOptions {
  /** Organization access token (`polar_oat_...`). */
  accessToken: string;
  server?: 'production' | 'sandbox';
  /** Overrides `server`; used verbatim. */
  baseUrl?: string;
  fetch?: typeof fetch;
}

interface PageCursorState {
  page: number;
}

interface PolarCustomerSession {
  customer_portal_url: string;
}

function mapError(status: number, body: unknown): ProviderErrorInfo {
  if (body === null || typeof body !== 'object') {
    return {};
  }
  const { error, detail } = body as { error?: unknown; detail?: unknown };
  if (typeof detail === 'string') {
    return { message: typeof error === 'string' ? `${error}: ${detail}` : detail };
  }
  return {};
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
      throw new RevenueError(`Polar does not support the ${behavior} proration behavior`, {
        code: 'unsupported',
        provider: 'polar',
      });
  }
}

export function polar(options: PolarProviderOptions): RevenueProvider {
  const baseUrl =
    options.baseUrl ?? (options.server === 'sandbox' ? SANDBOX_BASE_URL : PRODUCTION_BASE_URL);
  const http = new HttpClient({
    provider: 'polar',
    baseUrl,
    fetchImpl: options.fetch,
    authHeaders: () => ({ Authorization: `Bearer ${options.accessToken}` }),
    mapError,
    secrets: () => [options.accessToken],
  });

  function pageQuery(cursor: string | undefined, limit: number | undefined) {
    const page = cursor ? decodeCursor<PageCursorState>('polar', cursor).page : 1;
    return { page, limit: clampLimit(limit, DEFAULT_PAGE_LIMIT, MAX_PAGE_LIMIT) };
  }

  function nextCursor(page: number, maxPage: number): string | undefined {
    return page < maxPage ? encodeCursor<PageCursorState>('polar', { page: page + 1 }) : undefined;
  }

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
      const { page, limit } = pageQuery(params.cursor, params.limit);
      const { data } = await http.json<PolarListResponse<PolarProduct>>('/v1/products/', {
        query: { page, limit, is_archived: false },
        signal: params.signal,
      });
      return {
        items: data.items.map(toProduct),
        cursor: nextCursor(page, data.pagination.max_page),
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
          throw new RevenueError('Polar checkouts do not support item quantities', {
            code: 'unsupported',
            provider: 'polar',
          });
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
      const { page, limit } = pageQuery(params.cursor, params.limit);
      const { data } = await http.json<PolarListResponse<PolarCustomer>>('/v1/customers/', {
        query: { page, limit, email: params.email },
        signal: params.signal,
      });
      return {
        items: data.items.map(toCustomer),
        cursor: nextCursor(page, data.pagination.max_page),
      };
    },

    async getSubscription(params) {
      const { data } = await http.json<PolarSubscription>(`/v1/subscriptions/${params.id}`, {
        signal: params.signal,
      });
      return toSubscription(data);
    },

    async listSubscriptions(params) {
      const { page, limit } = pageQuery(params.cursor, params.limit);
      const { data } = await http.json<PolarListResponse<PolarSubscription>>('/v1/subscriptions/', {
        query: { page, limit, customer_id: params.customerId },
        signal: params.signal,
      });
      return {
        items: data.items.map(toSubscription),
        cursor: nextCursor(page, data.pagination.max_page),
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
        throw new RevenueError('Polar plan changes do not support quantities', {
          code: 'unsupported',
          provider: 'polar',
        });
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
  };
}
