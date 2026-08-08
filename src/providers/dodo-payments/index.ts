import { RevenueError } from '../../errors.ts';
import { HttpClient } from '../../http.ts';
import { pageNumberCursor } from '../../pagination.ts';
import type { ProrationBehavior, RevenueCapabilities, RevenueProvider } from '../../types.ts';
import { requireOptions, toUsagePayload, unsupported } from '../shared.ts';
import {
  mapError,
  toBaseUrl,
  toCheckoutFromSession,
  toCheckoutFromStatus,
  toCustomer,
  toLicenseKey,
  toOrderFromPayment,
  toProduct,
  toSubscription,
  type DodoCheckoutSession,
  type DodoCheckoutSessionStatus,
  type DodoCustomer,
  type DodoLicenseKey,
  type DodoListResponse,
  type DodoPayment,
  type DodoProduct,
  type DodoSubscription,
} from './common.ts';

const DEFAULT_PAGE_SIZE = 10;
const MAX_PAGE_SIZE = 100;

const CAPABILITIES: RevenueCapabilities = {
  cancellationReason: true,
  // Dodo expires a checkout session 24 hours after creation (15 minutes with `confirm=true`) and
  // accepts no override.
  checkoutExpiresAt: false,
  checkoutStatus: true,
  checkoutSuccessUrl: true,
  // Dodo has no end-trial operation.
  endTrial: false,
  hostedCheckout: true,
  licenseKeys: true,
  listOrdersByCustomer: true,
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

function toProrationBillingMode(behavior: ProrationBehavior | undefined): string {
  switch (behavior) {
    case undefined:
    case 'invoice_now':
      return 'prorated_immediately';
    case 'none':
      return 'do_not_bill';
    default:
      throw unsupported('dodo-payments', `the ${behavior} proration behavior`);
  }
}

// Dodo numbers its pages from zero.
const pages = pageNumberCursor('dodo-payments', {
  startPage: 0,
  defaultLimit: DEFAULT_PAGE_SIZE,
  maxLimit: MAX_PAGE_SIZE,
  pageKey: 'page_number',
  limitKey: 'page_size',
});

// Dodo lists carry no has_more/total marker — a full page implies there may be more.
function nextCursor(page: number, limit: number, received: number): string | undefined {
  return pages.next(page, received === limit);
}

export function dodoPayments(options: DodoPaymentsProviderOptions): RevenueProvider {
  requireOptions('dodo-payments', { apiKey: options.apiKey });
  const http = new HttpClient({
    provider: 'dodo-payments',
    baseUrl: toBaseUrl(options),
    fetchImpl: options.fetch,
    authHeaders: () => ({ Authorization: `Bearer ${options.apiKey}` }),
    mapError,
    secrets: () => [options.apiKey],
  });

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
      const { page, limit, query } = pages.read(params.cursor, params.limit);
      const { data } = await http.json<DodoListResponse<DodoProduct>>('/products', {
        query: { ...query, archived: false },
        signal: params.signal,
      });
      return {
        items: data.items.map(toProduct),
        cursor: nextCursor(page, limit, data.items.length),
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
      const { page, limit, query } = pages.read(params.cursor, params.limit);
      const { data } = await http.json<DodoListResponse<DodoCustomer>>('/customers', {
        query: { ...query, email: params.email },
        signal: params.signal,
      });
      return {
        items: data.items.map(toCustomer),
        cursor: nextCursor(page, limit, data.items.length),
      };
    },

    async getSubscription(params) {
      const { data } = await http.json<DodoSubscription>(`/subscriptions/${params.id}`, {
        signal: params.signal,
      });
      return toSubscription(data);
    },

    async listSubscriptions(params) {
      const { page, limit, query } = pages.read(params.cursor, params.limit);
      const { data } = await http.json<DodoListResponse<DodoSubscription>>('/subscriptions', {
        query: { ...query, customer_id: params.customerId },
        signal: params.signal,
      });
      return {
        items: data.items.map(toSubscription),
        cursor: nextCursor(page, limit, data.items.length),
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
      throw unsupported('dodo-payments', 'ending a trial early');
    },

    async pauseSubscription() {
      throw unsupported('dodo-payments', 'pausing a subscription');
    },

    async resumeSubscription() {
      throw unsupported('dodo-payments', 'resuming a subscription');
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

    async listOrders(params) {
      const { page, limit, query } = pages.read(params.cursor, params.limit);
      // `/payments` takes no sort parameter and documents no ordering guarantee — the order is
      // provider-defined and unverified.
      const { data } = await http.json<DodoListResponse<DodoPayment>>('/payments', {
        query: { ...query, status: 'succeeded', customer_id: params.customerId },
        signal: params.signal,
      });
      return {
        items: data.items.map(toOrderFromPayment),
        cursor: nextCursor(page, limit, data.items.length),
      };
    },

    async getOrder(params) {
      const { data } = await http.json<DodoPayment>(`/payments/${params.id}`, {
        signal: params.signal,
      });
      return toOrderFromPayment(data);
    },

    async getOrderInvoiceUrl(params) {
      // `invoice_url` is a field on the payment itself; `GET /invoices/payments/{id}` returns
      // the PDF bytes rather than a URL.
      const { data } = await http.json<DodoPayment>(`/payments/${params.id}`, {
        signal: params.signal,
      });
      if (!data.invoice_url) {
        throw new RevenueError(`Dodo Payments has no invoice for payment ${params.id}`, {
          code: 'not_found',
          provider: 'dodo-payments',
        });
      }
      return data.invoice_url;
    },

    // The merchant routes are `/license_keys` (underscore); the credential-free activate,
    // validate, and deactivate routes are `/licenses`. All three below are marked deprecated in
    // Dodo's SDK in favour of an entitlements-based replacement, but remain functional.
    async listLicenseKeys(params) {
      const { page, limit, query } = pages.read(params.cursor, params.limit);
      const { data } = await http.json<DodoListResponse<DodoLicenseKey>>('/license_keys', {
        query,
        signal: params.signal,
      });
      return {
        items: data.items.map(toLicenseKey),
        cursor: nextCursor(page, limit, data.items.length),
      };
    },

    async getLicenseKey(params) {
      const { data } = await http.json<DodoLicenseKey>(`/license_keys/${params.id}`, {
        signal: params.signal,
      });
      return toLicenseKey(data);
    },

    async updateLicenseKey(params) {
      const { data } = await http.json<DodoLicenseKey>(`/license_keys/${params.id}`, {
        method: 'PATCH',
        body: {
          activations_limit: params.activationLimit,
          disabled: params.disabled,
          expires_at: params.expiresAt === null ? null : params.expiresAt?.toISOString(),
        },
        signal: params.signal,
      });
      return toLicenseKey(data);
    },
  };
}
