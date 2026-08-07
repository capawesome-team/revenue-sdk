import { RevenueError } from '../../errors.ts';
import { HttpClient, type ProviderErrorInfo } from '../../http.ts';
import { clampLimit, decodeCursor, encodeCursor } from '../../pagination.ts';
import type {
  Product,
  ProrationBehavior,
  RevenueCapabilities,
  RevenueProvider,
} from '../../types.ts';
import { toUsagePayload } from '../shared.ts';
import {
  toCheckout,
  toCustomer,
  toOrderFromInvoice,
  toProduct,
  toSubscription,
  type StripeCheckoutSession,
  type StripeCustomer,
  type StripeInvoice,
  type StripeList,
  type StripePrice,
  type StripeProduct,
  type StripeSubscription,
} from './common.ts';
import { encodeForm } from './form-encoder.ts';

const BASE_URL = 'https://api.stripe.com';
// Pinned so response shapes match this SDK's types regardless of the account default.
const API_VERSION = '2026-07-29.dahlia';
const DEFAULT_PAGE_LIMIT = 10;
const MAX_PAGE_LIMIT = 100;
const PRICES_PER_PRODUCT_LIMIT = 100;

const CAPABILITIES: RevenueCapabilities = {
  cancellationReason: true,
  checkoutStatus: true,
  checkoutSuccessUrl: true,
  endTrial: true,
  hostedCheckout: true,
  // Stripe has no license-key API. Billing Entitlements is not a substitute: it is a derived
  // per-customer feature boolean with no key string, activation count, or device identity, and
  // `/v1/entitlements/active_entitlements` is secret-key-only — an app cannot check its own license.
  licenseKeys: false,
  listOrdersByCustomer: true,
  listSubscriptionsByCustomer: true,
  pause: true,
  // `pause_collection` takes effect immediately; a period-end pause would require Subscription
  // Schedules.
  pauseBehaviors: ['immediately'],
  portalReturnUrl: true,
  prorationBehaviors: ['invoice_now', 'none', 'prorate'],
  revoke: true,
  uncancel: true,
  usageReporting: true,
};

export interface StripeProviderOptions {
  /** Secret or restricted API key (`sk_...` / `rk_...`). */
  secretKey: string;
  /** Overrides the pinned Stripe API version — response shapes may no longer match. */
  apiVersion?: string;
  /** Used verbatim. */
  baseUrl?: string;
  fetch?: typeof fetch;
}

interface CursorState {
  after: string;
}

function unsupported(feature: string): RevenueError {
  return new RevenueError(`Stripe does not support ${feature}`, {
    code: 'unsupported',
    provider: 'stripe',
  });
}

function mapError(status: number, body: unknown): ProviderErrorInfo {
  if (body === null || typeof body !== 'object') {
    return {};
  }
  const { error } = body as { error?: { message?: unknown } };
  return typeof error?.message === 'string' ? { message: error.message } : {};
}

function toProrationBehavior(behavior: ProrationBehavior | undefined): string | undefined {
  switch (behavior) {
    case 'invoice_now':
      return 'always_invoice';
    case 'prorate':
      return 'create_prorations';
    case 'none':
      return 'none';
    default:
      return undefined;
  }
}

export function stripe(options: StripeProviderOptions): RevenueProvider {
  const http = new HttpClient({
    provider: 'stripe',
    baseUrl: options.baseUrl ?? BASE_URL,
    fetchImpl: options.fetch,
    authHeaders: () => ({ Authorization: `Bearer ${options.secretKey}` }),
    defaultHeaders: { 'Stripe-Version': options.apiVersion ?? API_VERSION },
    mapError,
    secrets: () => [options.secretKey],
  });

  function pageParams(cursor: string | undefined, limit: number | undefined) {
    return {
      limit: clampLimit(limit, DEFAULT_PAGE_LIMIT, MAX_PAGE_LIMIT),
      starting_after: cursor ? decodeCursor<CursorState>('stripe', cursor).after : undefined,
    };
  }

  function nextCursor(list: StripeList<{ id: string }>): string | undefined {
    const last = list.data[list.data.length - 1];
    return list.has_more && last
      ? encodeCursor<CursorState>('stripe', { after: last.id })
      : undefined;
  }

  async function listPricesOf(productId: string, signal: AbortSignal | undefined) {
    const { data } = await http.json<StripeList<StripePrice>>('/v1/prices', {
      query: { product: productId, active: true, limit: PRICES_PER_PRODUCT_LIMIT },
      signal,
    });
    return data.data;
  }

  async function getPrice(priceId: string, signal: AbortSignal | undefined) {
    const { data } = await http.json<StripePrice>(`/v1/prices/${priceId}`, { signal });
    return data;
  }

  async function fetchInvoice(id: string, signal: AbortSignal | undefined) {
    const { data } = await http.json<StripeInvoice>(`/v1/invoices/${id}`, { signal });
    return data;
  }

  async function fetchSubscription(id: string, signal: AbortSignal | undefined) {
    const { data } = await http.json<StripeSubscription>(`/v1/subscriptions/${id}`, { signal });
    return data;
  }

  async function postSubscription(
    id: string,
    body: Record<string, unknown>,
    signal: AbortSignal | undefined,
  ) {
    const { data } = await http.json<StripeSubscription>(`/v1/subscriptions/${id}`, {
      method: 'POST',
      form: encodeForm(body),
      signal,
    });
    return toSubscription(data);
  }

  return {
    name: 'stripe',
    capabilities: CAPABILITIES,

    async listProducts(params) {
      const { data } = await http.json<StripeList<StripeProduct>>('/v1/products', {
        query: { active: true, ...pageParams(params.cursor, params.limit) },
        signal: params.signal,
      });
      const items: Product[] = [];
      for (const product of data.data) {
        items.push(toProduct(product, await listPricesOf(product.id, params.signal)));
      }
      return { items, cursor: nextCursor(data) };
    },

    async getProduct(params) {
      const { data } = await http.json<StripeProduct>(`/v1/products/${params.id}`, {
        signal: params.signal,
      });
      return toProduct(data, await listPricesOf(params.id, params.signal));
    },

    async createCheckout(params) {
      const firstItem = params.items[0];
      if (firstItem === undefined) {
        throw new RevenueError('At least one checkout item is required', {
          code: 'validation',
          provider: 'stripe',
        });
      }
      // `mode` is derived from the first price; Stripe rejects mixed recurring/one-time
      // carts in payment mode anyway.
      const firstPrice = await getPrice(firstItem.product, params.signal);
      const mode = firstPrice.recurring ? 'subscription' : 'payment';
      const { data } = await http.json<StripeCheckoutSession>('/v1/checkout/sessions', {
        method: 'POST',
        form: encodeForm({
          mode,
          line_items: params.items.map((item) => ({
            price: item.product,
            quantity: item.quantity ?? 1,
          })),
          success_url: params.successUrl,
          customer: params.customerId,
          customer_email: params.customerId === undefined ? params.customerEmail : undefined,
          // Stripe only draws up an Invoice for a one-off payment when the session asks for one,
          // and without it the purchase appears in neither `orders.list` nor `order.paid`.
          // Subscription mode always invoices and rejects the parameter.
          invoice_creation: mode === 'payment' ? { enabled: true } : undefined,
          // Session metadata does NOT propagate to the subscription — write both.
          metadata: params.metadata,
          subscription_data:
            mode === 'subscription' && params.metadata !== undefined
              ? { metadata: params.metadata }
              : undefined,
        }),
        signal: params.signal,
      });
      return toCheckout(data);
    },

    async getCheckout(params) {
      const { data } = await http.json<StripeCheckoutSession>(
        `/v1/checkout/sessions/${params.id}`,
        { signal: params.signal },
      );
      return toCheckout(data);
    },

    async getCustomer(params) {
      const { data } = await http.json<StripeCustomer>(`/v1/customers/${params.id}`, {
        signal: params.signal,
      });
      return toCustomer(data);
    },

    async listCustomers(params) {
      // Note: Stripe's email filter is case-sensitive and emails are not unique.
      const { data } = await http.json<StripeList<StripeCustomer>>('/v1/customers', {
        query: { email: params.email, ...pageParams(params.cursor, params.limit) },
        signal: params.signal,
      });
      return { items: data.data.map(toCustomer), cursor: nextCursor(data) };
    },

    async getSubscription(params) {
      return toSubscription(await fetchSubscription(params.id, params.signal));
    },

    async listSubscriptions(params) {
      // Without `status=all`, Stripe silently hides canceled subscriptions.
      const { data } = await http.json<StripeList<StripeSubscription>>('/v1/subscriptions', {
        query: {
          customer: params.customerId,
          status: 'all',
          ...pageParams(params.cursor, params.limit),
        },
        signal: params.signal,
      });
      return { items: data.data.map(toSubscription), cursor: nextCursor(data) };
    },

    async cancelSubscription(params) {
      return postSubscription(
        params.id,
        {
          cancel_at_period_end: true,
          cancellation_details:
            params.reason !== undefined || params.comment !== undefined
              ? { feedback: params.reason, comment: params.comment }
              : undefined,
        },
        params.signal,
      );
    },

    async uncancelSubscription(params) {
      // `cancel_at: null` also clears portal-scheduled cancellations (flexible billing mode).
      return postSubscription(
        params.id,
        { cancel_at_period_end: false, cancel_at: null },
        params.signal,
      );
    },

    async changeSubscriptionPlan(params) {
      // The current item ID must be sent — omitting it ADDS the new price instead of
      // replacing the old one (silent double-billing).
      const current = await fetchSubscription(params.id, params.signal);
      const itemId = current.items?.data[0]?.id;
      return postSubscription(
        params.id,
        {
          items: [
            {
              id: itemId,
              price: params.product,
              quantity: params.quantity,
            },
          ],
          proration_behavior: toProrationBehavior(params.prorationBehavior),
        },
        params.signal,
      );
    },

    async endSubscriptionTrial(params) {
      return postSubscription(params.id, { trial_end: 'now' }, params.signal);
    },

    async pauseSubscription(params) {
      // `void` voids the invoices generated while paused — the only behavior this SDK exposes.
      return postSubscription(
        params.id,
        { pause_collection: { behavior: 'void', resumes_at: params.resumesAt } },
        params.signal,
      );
    },

    async resumeSubscription(params) {
      // Stripe's two pause mechanisms resume through different endpoints and the ID alone does
      // not tell them apart, so the current status has to be read first.
      const current = await fetchSubscription(params.id, params.signal);
      if (current.status === 'paused') {
        // A trial that ended without a payment method — only the dedicated endpoint resumes it.
        const { data } = await http.json<StripeSubscription>(
          `/v1/subscriptions/${params.id}/resume`,
          {
            method: 'POST',
            form: encodeForm({ billing_cycle_anchor: 'now' }),
            signal: params.signal,
          },
        );
        return toSubscription(data);
      }
      return postSubscription(params.id, { pause_collection: null }, params.signal);
    },

    async revokeSubscription(params) {
      const { data } = await http.json<StripeSubscription>(`/v1/subscriptions/${params.id}`, {
        method: 'DELETE',
        signal: params.signal,
      });
      return toSubscription(data);
    },

    async createCustomerPortalSession(params) {
      const { data } = await http.json<{ url: string }>('/v1/billing_portal/sessions', {
        method: 'POST',
        form: encodeForm({ customer: params.customerId, return_url: params.returnUrl }),
        signal: params.signal,
      });
      return { url: data.url, raw: data };
    },

    async reportUsage(params) {
      // A 2xx does NOT mean the usage was recorded: meter events are validated synchronously but
      // processed asynchronously. An unknown customer or an `event_name` with no matching meter is
      // dropped silently and only reported through the `v1.billing.meter.error_report_triggered`
      // and `v1.billing.meter.no_meter_found` webhooks, which this SDK does not parse.
      //
      // Stripe keys usage on the CUSTOMER, never on a subscription or subscription item: it
      // resolves the price through the customer's subscription that contains a price whose
      // `recurring.meter` matches the meter for this `event_name`. A customer with two
      // subscriptions sharing one meter is ambiguous and cannot be disambiguated here.
      //
      // `stripe_customer_id` and `value` are the meter's DEFAULT payload keys
      // (`customer_mapping.event_payload_key` / `value_settings.event_payload_key`); a meter
      // configured with custom keys needs those passed through `metadata` instead.
      //
      // Livemode allows 1,000 events/s on a bucket separate from the regular API, but only ONE
      // concurrent call per customer per meter — parallelize across customers, not within one.
      await http.json('/v1/billing/meter_events', {
        method: 'POST',
        form: encodeForm({
          event_name: params.eventName,
          // `stripe_customer_id` is written last so metadata can never clobber it.
          payload: { ...toUsagePayload(params), stripe_customer_id: params.customerId },
          identifier: params.idempotencyKey,
          timestamp: params.timestamp,
        }),
        signal: params.signal,
      });
    },

    async listOrders(params) {
      const { data } = await http.json<StripeList<StripeInvoice>>('/v1/invoices', {
        query: { customer: params.customerId, ...pageParams(params.cursor, params.limit) },
        signal: params.signal,
      });
      // Stripe's `status` filter takes a single value, so "everything except draft" cannot be
      // expressed server-side and drafts are dropped here instead. They matter: a subscription
      // renewal sits as an unpaid `draft` for about an hour before Stripe charges it. The cursor
      // is taken from the unfiltered page so paging stays on Stripe's own ordering.
      return {
        items: data.data.filter((invoice) => invoice.status !== 'draft').map(toOrderFromInvoice),
        cursor: nextCursor(data),
      };
    },

    async getOrder(params) {
      return toOrderFromInvoice(await fetchInvoice(params.id, params.signal));
    },

    async getOrderInvoiceUrl(params) {
      const invoice = await fetchInvoice(params.id, params.signal);
      // Both links are minted at finalization and expire 30 days after the due date (capped at
      // 120 days) — an expired `invoice_pdf` answers with HTTP 400 — so they are read on demand.
      const url = invoice.hosted_invoice_url ?? invoice.invoice_pdf;
      if (!url) {
        throw new RevenueError(`Stripe invoice ${params.id} has no URL until it is finalized`, {
          code: 'not_found',
          provider: 'stripe',
        });
      }
      return url;
    },

    async listLicenseKeys() {
      throw unsupported('license keys');
    },

    async getLicenseKey() {
      throw unsupported('license keys');
    },

    async updateLicenseKey() {
      throw unsupported('license keys');
    },
  };
}
