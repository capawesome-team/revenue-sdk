import { RevenueError } from '../../errors.ts';
import { HttpClient, type ProviderErrorInfo } from '../../http.ts';
import { clampLimit, decodeCursor, encodeCursor, pageNumberCursor } from '../../pagination.ts';
import type { Product, RevenueCapabilities, RevenueProvider } from '../../types.ts';
import { requireOptions, unsupported } from '../shared.ts';
import {
  BASE_URL,
  toCheckout,
  toCustomer,
  toLicenseKey,
  toOrderFromInvoice,
  toOrderFromOrder,
  toProduct,
  toSubscription,
  type LsCheckoutAttributes,
  type LsCustomerAttributes,
  type LsLicenseKeyAttributes,
  type LsListResponse,
  type LsOrderAttributes,
  type LsPriceAttributes,
  type LsResource,
  type LsSingleResponse,
  type LsSubscriptionAttributes,
  type LsSubscriptionInvoiceAttributes,
  type LsVariantAttributes,
} from './common.ts';

const DEFAULT_PAGE_SIZE = 10;
const MAX_PAGE_SIZE = 100;

const CAPABILITIES: RevenueCapabilities = {
  cancellationReason: false,
  checkoutCustomAmount: true,
  checkoutExpiresAt: true,
  checkoutStatus: false,
  checkoutSuccessUrl: true,
  // The customer object has no metadata field at all — not even a custom-data one.
  customerMetadata: false,
  endTrial: true,
  hostedCheckout: true,
  licenseKeys: true,
  // `/v1/orders` only filters by store, user email and order number.
  listOrdersByCustomer: false,
  // Subscriptions are filterable by store/product/variant/email only, not by customer ID.
  listSubscriptionsByCustomer: false,
  pause: true,
  pauseBehaviors: ['immediately'],
  portalReturnUrl: false,
  prorationBehaviors: ['invoice_now', 'prorate', 'none'],
  revoke: false,
  uncancel: true,
  // `POST /v1/usage-records` keys on a subscription-item ID rather than a customer (ambiguous once a
  // customer has several subscriptions) and has no idempotency at all, so a replay double-bills.
  usageReporting: false,
};

export interface LemonSqueezyProviderOptions {
  apiKey: string;
  /** The store checkouts are created in. */
  storeId: string | number;
  /** Used verbatim. */
  baseUrl?: string;
  fetch?: typeof fetch;
}

/**
 * Orders live in two independently paginated resources, so the cursor names the phase it is in:
 * `/v1/orders` is drained first, then `/v1/subscription-invoices`.
 */
interface OrderCursorState {
  source: 'orders' | 'invoices';
  page: number;
}

type LsOrderLookup =
  | { source: 'orders'; resource: LsResource<LsOrderAttributes> }
  | { source: 'invoices'; resource: LsResource<LsSubscriptionInvoiceAttributes> };

const pages = pageNumberCursor('lemon-squeezy', {
  startPage: 1,
  defaultLimit: DEFAULT_PAGE_SIZE,
  maxLimit: MAX_PAGE_SIZE,
  pageKey: 'page[number]',
  limitKey: 'page[size]',
});

function hasMorePages(page: number, response: LsListResponse<unknown>): boolean {
  return page < (response.meta?.page?.lastPage ?? page);
}

function mapError(status: number, body: unknown): ProviderErrorInfo {
  if (body === null || typeof body !== 'object') {
    return {};
  }
  const { errors } = body as { errors?: Array<{ detail?: unknown; title?: unknown }> };
  const detail = errors?.[0]?.detail;
  return typeof detail === 'string' ? { message: detail } : {};
}

export function lemonSqueezy(options: LemonSqueezyProviderOptions): RevenueProvider {
  requireOptions('lemon-squeezy', { apiKey: options.apiKey, storeId: options.storeId });
  const storeId = String(options.storeId);
  const http = new HttpClient({
    provider: 'lemon-squeezy',
    baseUrl: options.baseUrl ?? BASE_URL,
    fetchImpl: options.fetch,
    authHeaders: () => ({ Authorization: `Bearer ${options.apiKey}` }),
    defaultHeaders: {
      // JSON:API — required on every request, including GETs.
      Accept: 'application/vnd.api+json',
      'Content-Type': 'application/vnd.api+json',
    },
    mapError,
    secrets: () => [options.apiKey],
  });

  let storeCurrency: string | undefined;
  async function getStoreCurrency(signal: AbortSignal | undefined): Promise<string> {
    if (storeCurrency === undefined) {
      const { data } = await http.json<LsSingleResponse<{ currency?: string | null }>>(
        `/v1/stores/${storeId}`,
        { signal },
      );
      storeCurrency = (data.data.attributes.currency ?? 'USD').toLowerCase();
    }
    return storeCurrency;
  }

  async function toProductWithPrice(
    variant: { type: string; id: string; attributes: LsVariantAttributes },
    signal: AbortSignal | undefined,
  ): Promise<Product> {
    // The variant's CURRENT price lives on its price-model relationship; `/v1/prices` is an
    // append-only history and must not be used here.
    const { data } = await http.json<LsSingleResponse<LsPriceAttributes>>(
      `/v1/variants/${variant.id}/price-model`,
      { signal },
    );
    return toProduct(variant, data.data, await getStoreCurrency(signal));
  }

  /**
   * Lemon Squeezy documents that `PATCH /v1/subscriptions/{id}` "will not modify the subscription"
   * when its payment processor is PayPal — the request answers 200 with the record unchanged, so
   * returning it would report a success that never happened. The processor is on the response
   * itself, so the no-op is detected without a preflight request.
   *
   * This covers every PATCH-backed operation: plan changes, uncancel, pause, resume and endTrial
   * (the last one is not documented upstream, but goes through the same endpoint). Narrowing the
   * guard to plan changes alone is a one-line change here if live testing shows LS honors some
   * fields after all.
   */
  function assertPatchApplied(subscription: LsResource<LsSubscriptionAttributes>): void {
    if (subscription.attributes.payment_processor === 'paypal') {
      throw unsupported(
        'lemon-squeezy',
        'updating a subscription paid through PayPal; the request succeeded but nothing changed — ' +
          'send the customer to the customer portal to manage the subscription instead',
      );
    }
  }

  async function fetchSubscription(id: string, signal: AbortSignal | undefined) {
    const { data } = await http.json<LsSingleResponse<LsSubscriptionAttributes>>(
      `/v1/subscriptions/${id}`,
      { signal },
    );
    return data.data;
  }

  async function patchSubscription(
    id: string,
    attributes: Record<string, unknown>,
    signal: AbortSignal | undefined,
  ) {
    const { data } = await http.json<LsSingleResponse<LsSubscriptionAttributes>>(
      `/v1/subscriptions/${id}`,
      {
        method: 'PATCH',
        body: { data: { type: 'subscriptions', id, attributes } },
        signal,
      },
    );
    assertPatchApplied(data.data);
    return toSubscription(data.data);
  }

  /**
   * Orders and subscription invoices are separate numeric ID spaces with nothing to tell them
   * apart, so an opaque order ID is resolved by trying the order first and falling back to the
   * invoice. When both miss, the original order lookup is what the caller asked for.
   */
  async function findOrder(id: string, signal: AbortSignal | undefined): Promise<LsOrderLookup> {
    try {
      const { data } = await http.json<LsSingleResponse<LsOrderAttributes>>(`/v1/orders/${id}`, {
        signal,
      });
      return { source: 'orders', resource: data.data };
    } catch (error) {
      if (!(error instanceof RevenueError) || error.code !== 'not_found') {
        throw error;
      }
      try {
        const { data } = await http.json<LsSingleResponse<LsSubscriptionInvoiceAttributes>>(
          `/v1/subscription-invoices/${id}`,
          { signal },
        );
        return { source: 'invoices', resource: data.data };
      } catch (fallbackError) {
        if (fallbackError instanceof RevenueError && fallbackError.code === 'not_found') {
          throw error;
        }
        throw fallbackError;
      }
    }
  }

  return {
    name: 'lemon-squeezy',
    capabilities: CAPABILITIES,

    async listProducts(params) {
      const { page, query } = pages.read(params.cursor, params.limit);
      const { data } = await http.json<LsListResponse<LsVariantAttributes>>('/v1/variants', {
        // Draft and pending variants cannot be bought, so only published ones are listed.
        // `/v1/variants` takes no store filter, so a multi-store API key lists every store's
        // variants — there is no upstream way to narrow this.
        query: { ...query, 'filter[status]': 'published' },
        signal: params.signal,
      });
      const items: Product[] = [];
      for (const variant of data.data) {
        items.push(await toProductWithPrice(variant, params.signal));
      }
      return { items, cursor: pages.next(page, hasMorePages(page, data)) };
    },

    async getProduct(params) {
      const { data } = await http.json<LsSingleResponse<LsVariantAttributes>>(
        `/v1/variants/${params.id}`,
        { signal: params.signal },
      );
      return toProductWithPrice(data.data, params.signal);
    },

    async createCheckout(params) {
      const item = params.items[0];
      if (params.items.length !== 1 || item === undefined) {
        throw unsupported('lemon-squeezy', 'checkouts with more than one item');
      }
      if (params.customerId !== undefined) {
        throw unsupported(
          'lemon-squeezy',
          'attaching an existing customer to a checkout; pass customerEmail',
        );
      }
      const checkoutData: Record<string, unknown> = {};
      if (params.customerEmail !== undefined) {
        checkoutData.email = params.customerEmail;
      }
      if (params.metadata !== undefined) {
        checkoutData.custom = params.metadata;
      }
      if (item.quantity !== undefined && item.quantity !== 1) {
        checkoutData.variant_quantities = [
          { variant_id: Number(item.product), quantity: item.quantity },
        ];
      }
      const { data } = await http.json<LsSingleResponse<LsCheckoutAttributes>>('/v1/checkouts', {
        method: 'POST',
        body: {
          data: {
            type: 'checkouts',
            attributes: {
              ...(Object.keys(checkoutData).length > 0 ? { checkout_data: checkoutData } : {}),
              ...(params.customAmount !== undefined ? { custom_price: params.customAmount } : {}),
              ...(params.expiresAt !== undefined
                ? { expires_at: params.expiresAt.toISOString() }
                : {}),
              product_options: {
                enabled_variants: [Number(item.product)],
                ...(params.successUrl !== undefined ? { redirect_url: params.successUrl } : {}),
              },
            },
            relationships: {
              store: { data: { type: 'stores', id: storeId } },
              variant: { data: { type: 'variants', id: String(item.product) } },
            },
          },
        },
        signal: params.signal,
      });
      return toCheckout(data.data);
    },

    async getCheckout(params) {
      const { data } = await http.json<LsSingleResponse<LsCheckoutAttributes>>(
        `/v1/checkouts/${params.id}`,
        { signal: params.signal },
      );
      return toCheckout(data.data);
    },

    async getCustomer(params) {
      const { data } = await http.json<LsSingleResponse<LsCustomerAttributes>>(
        `/v1/customers/${params.id}`,
        { signal: params.signal },
      );
      return toCustomer(data.data);
    },

    async listCustomers(params) {
      const { page, query } = pages.read(params.cursor, params.limit);
      const { data } = await http.json<LsListResponse<LsCustomerAttributes>>('/v1/customers', {
        query: { ...query, 'filter[store_id]': storeId, 'filter[email]': params.email },
        signal: params.signal,
      });
      return {
        items: data.data.map(toCustomer),
        cursor: pages.next(page, hasMorePages(page, data)),
      };
    },

    async createCustomer(params) {
      const { data } = await http.json<LsSingleResponse<LsCustomerAttributes>>('/v1/customers', {
        method: 'POST',
        body: {
          data: {
            type: 'customers',
            // Lemon Squeezy requires both a name and an email; the store is a relationship
            // rather than an attribute.
            attributes: { name: params.name, email: params.email },
            relationships: { store: { data: { type: 'stores', id: storeId } } },
          },
        },
        signal: params.signal,
      });
      return toCustomer(data.data);
    },

    async updateCustomer(params) {
      const { data } = await http.json<LsSingleResponse<LsCustomerAttributes>>(
        `/v1/customers/${params.id}`,
        {
          method: 'PATCH',
          body: {
            data: {
              type: 'customers',
              id: params.id,
              attributes: { name: params.name, email: params.email },
            },
          },
          signal: params.signal,
        },
      );
      return toCustomer(data.data);
    },

    async getSubscription(params) {
      return toSubscription(await fetchSubscription(params.id, params.signal));
    },

    async listSubscriptions(params) {
      if (params.customerId !== undefined) {
        throw unsupported('lemon-squeezy', 'filtering subscriptions by customer');
      }
      const { page, query } = pages.read(params.cursor, params.limit);
      const { data } = await http.json<LsListResponse<LsSubscriptionAttributes>>(
        '/v1/subscriptions',
        {
          query: { ...query, 'filter[store_id]': storeId },
          signal: params.signal,
        },
      );
      return {
        items: data.data.map((item) => toSubscription(item)),
        cursor: pages.next(page, hasMorePages(page, data)),
      };
    },

    async cancelSubscription(params) {
      if (params.reason !== undefined || params.comment !== undefined) {
        throw unsupported('lemon-squeezy', 'cancellation reasons');
      }
      const { data } = await http.json<LsSingleResponse<LsSubscriptionAttributes>>(
        `/v1/subscriptions/${params.id}`,
        { method: 'DELETE', signal: params.signal },
      );
      return toSubscription(data.data);
    },

    async uncancelSubscription(params) {
      return patchSubscription(params.id, { cancelled: false }, params.signal);
    },

    async changeSubscriptionPlan(params) {
      if (params.quantity !== undefined && params.quantity !== 1) {
        throw unsupported('lemon-squeezy', 'quantities on plan changes');
      }
      // The PATCH requires both the variant and its parent product ID.
      const { data: variant } = await http.json<LsSingleResponse<LsVariantAttributes>>(
        `/v1/variants/${params.product}`,
        { signal: params.signal },
      );
      const attributes: Record<string, unknown> = {
        product_id: variant.data.attributes.product_id,
        // A plan-change PATCH re-validates the subscription's STORED `trial_ends_at` and rejects
        // it with a 422 once that date is in the past — which it is for every subscription whose
        // trial has ended (verified against the live API). Clearing it keeps plan changes working
        // after a trial; on a still-trialing subscription it also ends the trial, consistent with
        // the plan change billing immediately.
        trial_ends_at: null,
        variant_id: Number(params.product),
      };
      if (params.prorationBehavior === 'invoice_now') {
        attributes.invoice_immediately = true;
      } else if (params.prorationBehavior === 'none') {
        attributes.disable_prorations = true;
      }
      return patchSubscription(params.id, attributes, params.signal);
    },

    async endSubscriptionTrial(params) {
      // Lemon Squeezy documents `billing_anchor: null` as "reset the billing anchor to the current
      // date. Doing this will also remove an active trial." — the only upstream lever that ends a
      // trial. The reset is unconditional, so on a subscription that is NOT on trial the same call
      // succeeds and silently moves the customer's billing day to today (with a proration). Hence
      // the preflight read: the operation is refused unless the subscription is really trialing.
      // (`trial_ends_at` is writable too, but upstream only describes it as adjusting a trial's
      // DURATION and documents nothing about past or present values, so it is not used here.)
      const subscription = await fetchSubscription(params.id, params.signal);
      if (subscription.attributes.status !== 'on_trial') {
        throw new RevenueError(
          'This subscription is not on trial; ending a trial resets the Lemon Squeezy billing ' +
            "anchor, which would move the customer's billing day to today",
          { code: 'validation', provider: 'lemon-squeezy' },
        );
      }
      return patchSubscription(params.id, { billing_anchor: null }, params.signal);
    },

    async pauseSubscription(params) {
      return patchSubscription(
        params.id,
        // `void` voids the invoices raised while paused; the alternative `free` keeps serving the
        // subscription for free. The mode is not part of the unified API, so it is fixed here.
        { pause: { mode: 'void', resumes_at: params.resumesAt?.toISOString() } },
        params.signal,
      );
    },

    async resumeSubscription(params) {
      return patchSubscription(params.id, { pause: null }, params.signal);
    },

    async revokeSubscription() {
      throw unsupported('lemon-squeezy', 'revoking a subscription immediately');
    },

    async createCustomerPortalSession(params) {
      if (params.returnUrl !== undefined) {
        throw unsupported('lemon-squeezy', 'a return URL on customer portal sessions');
      }
      // The portal URL is pre-signed and valid for 24 hours — always fetched on demand.
      const { data } = await http.json<
        LsSingleResponse<LsCustomerAttributes & { urls?: { customer_portal?: string | null } }>
      >(`/v1/customers/${params.customerId}`, { signal: params.signal });
      const url = data.data.attributes.urls?.customer_portal;
      if (!url) {
        throw new RevenueError('This customer has no customer portal (no subscription yet)', {
          code: 'not_found',
          provider: 'lemon-squeezy',
        });
      }
      return { url, raw: data.data };
    },

    async reportUsage() {
      throw unsupported('lemon-squeezy', 'usage reporting');
    },

    /**
     * Lists every payment exactly once as the union of ALL orders and the subscription invoices
     * whose `billing_reason` is not `initial`: a one-off purchase raises an order only, a renewal
     * raises an invoice only, and the FIRST subscription payment raises BOTH — the same money
     * under two IDs in two ID spaces with no foreign key to join on. Dropping the `initial`
     * invoices is what keeps that first payment from being counted twice.
     *
     * Unlike the other providers, a page is therefore NOT globally chronological: all orders come
     * before all invoices. Merge-sorting two independently paginated sources cannot be expressed
     * in an opaque cursor, so the ordering is the accepted tradeoff.
     */
    async listOrders(params) {
      if (params.customerId !== undefined) {
        throw unsupported('lemon-squeezy', 'filtering orders by customer');
      }
      const state: OrderCursorState = params.cursor
        ? decodeCursor<OrderCursorState>('lemon-squeezy', params.cursor)
        : { source: 'orders', page: 1 };
      const query = {
        'page[number]': state.page,
        'page[size]': clampLimit(params.limit, DEFAULT_PAGE_SIZE, MAX_PAGE_SIZE),
        'filter[store_id]': storeId,
      };
      if (state.source === 'orders') {
        const { data } = await http.json<LsListResponse<LsOrderAttributes>>('/v1/orders', {
          query,
          signal: params.signal,
        });
        return {
          items: data.data.map((order) => toOrderFromOrder(order)),
          // The invoice phase always follows, even on the last page of orders.
          cursor: encodeCursor<OrderCursorState>(
            'lemon-squeezy',
            hasMorePages(state.page, data)
              ? { source: 'orders', page: state.page + 1 }
              : { source: 'invoices', page: 1 },
          ),
        };
      }
      const { data } = await http.json<LsListResponse<LsSubscriptionInvoiceAttributes>>(
        '/v1/subscription-invoices',
        { query, signal: params.signal },
      );
      return {
        // Filtering can leave a page short or even empty; it is never backfilled.
        items: data.data
          .filter((invoice) => invoice.attributes.billing_reason !== 'initial')
          .map((invoice) => toOrderFromInvoice(invoice)),
        cursor: hasMorePages(state.page, data)
          ? encodeCursor<OrderCursorState>('lemon-squeezy', {
              source: 'invoices',
              page: state.page + 1,
            })
          : undefined,
      };
    },

    async getOrder(params) {
      const found = await findOrder(params.id, params.signal);
      return found.source === 'orders'
        ? toOrderFromOrder(found.resource)
        : toOrderFromInvoice(found.resource);
    },

    async getOrderInvoiceUrl(params) {
      const found = await findOrder(params.id, params.signal);
      // Both URLs are hosted by Lemon Squeezy and documented as not expiring, so they come
      // straight off the resource: orders link to the "My Orders" receipt page, subscription
      // invoices to a signed PDF that only exists once the invoice is no longer pending.
      const url =
        found.source === 'orders'
          ? found.resource.attributes.urls?.receipt
          : found.resource.attributes.urls?.invoice_url;
      if (!url) {
        throw new RevenueError('This order has no invoice URL yet', {
          code: 'not_found',
          provider: 'lemon-squeezy',
        });
      }
      return url;
    },

    async listLicenseKeys(params) {
      const { page, query } = pages.read(params.cursor, params.limit);
      const { data } = await http.json<LsListResponse<LsLicenseKeyAttributes>>('/v1/license-keys', {
        query: { ...query, 'filter[store_id]': storeId },
        signal: params.signal,
      });
      return {
        items: data.data.map(toLicenseKey),
        cursor: pages.next(page, hasMorePages(page, data)),
      };
    },

    async getLicenseKey(params) {
      const { data } = await http.json<LsSingleResponse<LsLicenseKeyAttributes>>(
        `/v1/license-keys/${params.id}`,
        { signal: params.signal },
      );
      return toLicenseKey(data.data);
    },

    async updateLicenseKey(params) {
      const attributes: Record<string, unknown> = {};
      if (params.disabled !== undefined) {
        attributes.disabled = params.disabled;
      }
      if (params.activationLimit !== undefined) {
        attributes.activation_limit = params.activationLimit;
      }
      if (params.expiresAt !== undefined) {
        attributes.expires_at = params.expiresAt === null ? null : params.expiresAt.toISOString();
      }
      const { data } = await http.json<LsSingleResponse<LsLicenseKeyAttributes>>(
        `/v1/license-keys/${params.id}`,
        {
          method: 'PATCH',
          body: { data: { type: 'license-keys', id: params.id, attributes } },
          signal: params.signal,
        },
      );
      return toLicenseKey(data.data);
    },
  };
}
