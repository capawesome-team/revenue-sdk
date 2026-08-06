import { RevenueError } from '../../errors.ts';
import { HttpClient, type ProviderErrorInfo } from '../../http.ts';
import { clampLimit, decodeCursor, encodeCursor } from '../../pagination.ts';
import type { ProrationBehavior, RevenueCapabilities, RevenueProvider } from '../../types.ts';
import { toUsagePayload } from '../shared.ts';
import {
  toCheckoutFromSession,
  toCheckoutFromStatus,
  toCustomer,
  toProduct,
  toSubscription,
  type DodoCheckoutSession,
  type DodoCheckoutSessionStatus,
  type DodoCustomer,
  type DodoListResponse,
  type DodoProduct,
  type DodoSubscription,
} from './common.ts';

const LIVE_BASE_URL = 'https://live.dodopayments.com';
const TEST_BASE_URL = 'https://test.dodopayments.com';
const DEFAULT_PAGE_SIZE = 10;
const MAX_PAGE_SIZE = 100;

const CAPABILITIES: RevenueCapabilities = {
  cancellationReason: true,
  checkoutStatus: true,
  checkoutSuccessUrl: true,
  // Dodo has no end-trial operation.
  endTrial: false,
  hostedCheckout: true,
  listSubscriptionsByCustomer: true,
  // Dodo has no pause/resume endpoint and no paused subscription status.
  pause: false,
  pauseBehaviors: [],
  portalReturnUrl: true,
  // `prorated_immediately` and `do_not_bill`; there is no defer-to-next-invoice mode.
  prorationBehaviors: ['invoice_now', 'none'],
  revoke: true,
  uncancel: true,
  usageReporting: true,
};

export interface DodoPaymentsProviderOptions {
  apiKey: string;
  server?: 'live' | 'test';
  /** Overrides `server`; used verbatim. */
  baseUrl?: string;
  fetch?: typeof fetch;
}

interface PageCursorState {
  /** Zero-based page number. */
  page: number;
}

function mapError(status: number, body: unknown): ProviderErrorInfo {
  if (body === null || typeof body !== 'object') {
    return {};
  }
  const { code, message } = body as { code?: unknown; message?: unknown };
  if (typeof message === 'string') {
    return { message: typeof code === 'string' ? `${code}: ${message}` : message };
  }
  return {};
}

function toProrationBillingMode(behavior: ProrationBehavior | undefined): string {
  switch (behavior) {
    case undefined:
    case 'invoice_now':
      return 'prorated_immediately';
    case 'none':
      return 'do_not_bill';
    default:
      throw new RevenueError(`Dodo Payments does not support the ${behavior} proration behavior`, {
        code: 'unsupported',
        provider: 'dodo-payments',
      });
  }
}

export function dodoPayments(options: DodoPaymentsProviderOptions): RevenueProvider {
  const baseUrl = options.baseUrl ?? (options.server === 'test' ? TEST_BASE_URL : LIVE_BASE_URL);
  const http = new HttpClient({
    provider: 'dodo-payments',
    baseUrl,
    fetchImpl: options.fetch,
    authHeaders: () => ({ Authorization: `Bearer ${options.apiKey}` }),
    mapError,
    secrets: () => [options.apiKey],
  });

  function pageQuery(cursor: string | undefined, limit: number | undefined) {
    const page = cursor ? decodeCursor<PageCursorState>('dodo-payments', cursor).page : 0;
    const pageSize = clampLimit(limit, DEFAULT_PAGE_SIZE, MAX_PAGE_SIZE);
    return { page, pageSize, query: { page_number: page, page_size: pageSize } };
  }

  // Dodo lists carry no has_more/total marker — a full page implies there may be more.
  function nextCursor(page: number, pageSize: number, received: number): string | undefined {
    return received === pageSize
      ? encodeCursor<PageCursorState>('dodo-payments', { page: page + 1 })
      : undefined;
  }

  async function patchSubscription(
    id: string,
    body: Record<string, unknown>,
    signal: AbortSignal | undefined,
  ) {
    const { data } = await http.json<DodoSubscription>(`/subscriptions/${id}`, {
      method: 'PATCH',
      body,
      signal,
    });
    return toSubscription(data);
  }

  return {
    name: 'dodo-payments',
    capabilities: CAPABILITIES,

    async listProducts(params) {
      const { page, pageSize, query } = pageQuery(params.cursor, params.limit);
      const { data } = await http.json<DodoListResponse<DodoProduct>>('/products', {
        query: { ...query, archived: false },
        signal: params.signal,
      });
      return {
        items: data.items.map(toProduct),
        cursor: nextCursor(page, pageSize, data.items.length),
      };
    },

    async getProduct(params) {
      const { data } = await http.json<DodoProduct>(`/products/${params.id}`, {
        signal: params.signal,
      });
      return toProduct(data);
    },

    async createCheckout(params) {
      const { data } = await http.json<DodoCheckoutSession>('/checkouts', {
        method: 'POST',
        body: {
          product_cart: params.items.map((item) => ({
            product_id: item.product,
            quantity: item.quantity ?? 1,
          })),
          customer:
            params.customerId !== undefined
              ? { customer_id: params.customerId }
              : params.customerEmail !== undefined
                ? { email: params.customerEmail }
                : undefined,
          return_url: params.successUrl,
          metadata: params.metadata,
        },
        signal: params.signal,
      });
      return toCheckoutFromSession(data);
    },

    async getCheckout(params) {
      const { data } = await http.json<DodoCheckoutSessionStatus>(`/checkouts/${params.id}`, {
        signal: params.signal,
      });
      return toCheckoutFromStatus(data);
    },

    async getCustomer(params) {
      const { data } = await http.json<DodoCustomer>(`/customers/${params.id}`, {
        signal: params.signal,
      });
      return toCustomer(data);
    },

    async listCustomers(params) {
      const { page, pageSize, query } = pageQuery(params.cursor, params.limit);
      const { data } = await http.json<DodoListResponse<DodoCustomer>>('/customers', {
        query: { ...query, email: params.email },
        signal: params.signal,
      });
      return {
        items: data.items.map(toCustomer),
        cursor: nextCursor(page, pageSize, data.items.length),
      };
    },

    async getSubscription(params) {
      const { data } = await http.json<DodoSubscription>(`/subscriptions/${params.id}`, {
        signal: params.signal,
      });
      return toSubscription(data);
    },

    async listSubscriptions(params) {
      const { page, pageSize, query } = pageQuery(params.cursor, params.limit);
      const { data } = await http.json<DodoListResponse<DodoSubscription>>('/subscriptions', {
        query: { ...query, customer_id: params.customerId },
        signal: params.signal,
      });
      return {
        items: data.items.map(toSubscription),
        cursor: nextCursor(page, pageSize, data.items.length),
      };
    },

    async cancelSubscription(params) {
      return patchSubscription(
        params.id,
        {
          cancel_at_next_billing_date: true,
          cancellation_feedback: params.reason,
          cancellation_comment: params.comment,
        },
        params.signal,
      );
    },

    async uncancelSubscription(params) {
      return patchSubscription(params.id, { cancel_at_next_billing_date: false }, params.signal);
    },

    async changeSubscriptionPlan(params) {
      // `POST /change-plan` returns 200 with an empty body — the subscription is re-fetched
      // to return the updated state.
      await http.json<undefined>(`/subscriptions/${params.id}/change-plan`, {
        method: 'POST',
        body: {
          product_id: params.product,
          quantity: params.quantity ?? 1,
          proration_billing_mode: toProrationBillingMode(params.prorationBehavior),
        },
        signal: params.signal,
      });
      const { data } = await http.json<DodoSubscription>(`/subscriptions/${params.id}`, {
        signal: params.signal,
      });
      return toSubscription(data);
    },

    async endSubscriptionTrial() {
      throw new RevenueError('Dodo Payments does not support ending a trial early', {
        code: 'unsupported',
        provider: 'dodo-payments',
      });
    },

    async pauseSubscription() {
      throw new RevenueError('Dodo Payments does not support pausing a subscription', {
        code: 'unsupported',
        provider: 'dodo-payments',
      });
    },

    async resumeSubscription() {
      throw new RevenueError('Dodo Payments does not support resuming a subscription', {
        code: 'unsupported',
        provider: 'dodo-payments',
      });
    },

    async revokeSubscription(params) {
      return patchSubscription(params.id, { status: 'cancelled' }, params.signal);
    },

    async createCustomerPortalSession(params) {
      // Parameters go in the query string on this POST.
      const { data } = await http.json<{ link: string }>(
        `/customers/${params.customerId}/customer-portal/session`,
        {
          method: 'POST',
          query: { return_url: params.returnUrl },
          signal: params.signal,
        },
      );
      return { url: data.link, raw: data };
    },

    async reportUsage(params) {
      // `event_id` is required and is what Dodo dedupes on across requests. A generated one is
      // unique per attempt, so a retry without a caller-supplied `idempotencyKey` double-counts.
      const eventId = params.idempotencyKey ?? crypto.randomUUID();
      // The endpoint takes a batch of up to 1000 events; one event per call is enough here.
      // Timestamps older than 1 hour or more than 5 minutes ahead are rejected with 400 — a much
      // tighter backdating window than Polar (unbounded) or Stripe (35 days).
      await http.json<unknown>('/events/ingest', {
        method: 'POST',
        body: {
          events: [
            {
              event_id: eventId,
              customer_id: params.customerId,
              event_name: params.eventName,
              timestamp: params.timestamp?.toISOString(),
              // Metadata values must stay primitive — `Metadata` already enforces that. An
              // unknown `customer_id` is dropped silently instead of erroring.
              metadata: toUsagePayload(params),
            },
          ],
        },
        signal: params.signal,
      });
    },
  };
}
