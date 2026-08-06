import { RevenueError } from '../../errors.ts';
import { HttpClient, type ProviderErrorInfo } from '../../http.ts';
import { clampLimit, decodeCursor, encodeCursor } from '../../pagination.ts';
import type { Product, RevenueCapabilities, RevenueProvider } from '../../types.ts';
import {
  toCheckout,
  toCustomer,
  toProduct,
  toSubscription,
  type LsCheckoutAttributes,
  type LsCustomerAttributes,
  type LsListResponse,
  type LsPriceAttributes,
  type LsSingleResponse,
  type LsSubscriptionAttributes,
  type LsVariantAttributes,
} from './common.ts';

const BASE_URL = 'https://api.lemonsqueezy.com';
const DEFAULT_PAGE_SIZE = 10;
const MAX_PAGE_SIZE = 100;

const CAPABILITIES: RevenueCapabilities = {
  cancellationReason: false,
  checkoutStatus: false,
  endTrial: true,
  hostedCheckout: true,
  // Subscriptions are filterable by store/product/variant/email only, not by customer ID.
  listSubscriptionsByCustomer: false,
  portalReturnUrl: false,
  prorationBehaviors: ['invoice_now', 'prorate', 'none'],
  revoke: false,
  uncancel: true,
};

export interface LemonSqueezyProviderOptions {
  apiKey: string;
  /** The store checkouts are created in. */
  storeId: string | number;
  /** Used verbatim. */
  baseUrl?: string;
  fetch?: typeof fetch;
}

interface PageCursorState {
  page: number;
}

function unsupported(feature: string): RevenueError {
  return new RevenueError(`Lemon Squeezy does not support ${feature}`, {
    code: 'unsupported',
    provider: 'lemon-squeezy',
  });
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

  function pageQuery(cursor: string | undefined, limit: number | undefined) {
    const page = cursor ? decodeCursor<PageCursorState>('lemon-squeezy', cursor).page : 1;
    return {
      page,
      query: {
        'page[number]': page,
        'page[size]': clampLimit(limit, DEFAULT_PAGE_SIZE, MAX_PAGE_SIZE),
      },
    };
  }

  function nextCursor(page: number, response: LsListResponse<unknown>): string | undefined {
    const lastPage = response.meta?.page?.lastPage ?? page;
    return page < lastPage
      ? encodeCursor<PageCursorState>('lemon-squeezy', { page: page + 1 })
      : undefined;
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
    return toSubscription(data.data);
  }

  return {
    name: 'lemon-squeezy',
    capabilities: CAPABILITIES,

    async listProducts(params) {
      const { page, query } = pageQuery(params.cursor, params.limit);
      const { data } = await http.json<LsListResponse<LsVariantAttributes>>('/v1/variants', {
        query,
        signal: params.signal,
      });
      const items: Product[] = [];
      for (const variant of data.data) {
        items.push(await toProductWithPrice(variant, params.signal));
      }
      return { items, cursor: nextCursor(page, data) };
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
        throw unsupported('checkouts with more than one item');
      }
      if (params.customerId !== undefined) {
        throw unsupported('attaching an existing customer to a checkout; pass customerEmail');
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
      const { page, query } = pageQuery(params.cursor, params.limit);
      const { data } = await http.json<LsListResponse<LsCustomerAttributes>>('/v1/customers', {
        query: { ...query, 'filter[store_id]': storeId, 'filter[email]': params.email },
        signal: params.signal,
      });
      return { items: data.data.map(toCustomer), cursor: nextCursor(page, data) };
    },

    async getSubscription(params) {
      const { data } = await http.json<LsSingleResponse<LsSubscriptionAttributes>>(
        `/v1/subscriptions/${params.id}`,
        { signal: params.signal },
      );
      return toSubscription(data.data);
    },

    async listSubscriptions(params) {
      if (params.customerId !== undefined) {
        throw unsupported('filtering subscriptions by customer');
      }
      const { page, query } = pageQuery(params.cursor, params.limit);
      const { data } = await http.json<LsListResponse<LsSubscriptionAttributes>>(
        '/v1/subscriptions',
        {
          query: { ...query, 'filter[store_id]': storeId },
          signal: params.signal,
        },
      );
      return {
        items: data.data.map((item) => toSubscription(item)),
        cursor: nextCursor(page, data),
      };
    },

    async cancelSubscription(params) {
      if (params.reason !== undefined || params.comment !== undefined) {
        throw unsupported('cancellation reasons');
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
        throw unsupported('quantities on plan changes');
      }
      // The PATCH requires both the variant and its parent product ID.
      const { data: variant } = await http.json<LsSingleResponse<LsVariantAttributes>>(
        `/v1/variants/${params.product}`,
        { signal: params.signal },
      );
      const attributes: Record<string, unknown> = {
        product_id: variant.data.attributes.product_id,
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
      // `billing_anchor: null` resets the anchor to today and removes an active trial.
      return patchSubscription(params.id, { billing_anchor: null }, params.signal);
    },

    async revokeSubscription() {
      throw unsupported('revoking a subscription immediately');
    },

    async createCustomerPortalSession(params) {
      if (params.returnUrl !== undefined) {
        throw unsupported('a return URL on customer portal sessions');
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
  };
}
