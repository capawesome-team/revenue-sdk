# revenue-sdk

[![npm version](https://img.shields.io/npm/v/revenue-sdk)](https://www.npmjs.com/package/revenue-sdk)
[![npm downloads](https://img.shields.io/npm/dm/revenue-sdk)](https://www.npmjs.com/package/revenue-sdk)
[![license](https://img.shields.io/npm/l/revenue-sdk)](https://github.com/capawesome-team/revenue-sdk/blob/main/LICENSE)

A unified, normalized, zero-dependency, edge-compatible TypeScript SDK over [Polar](https://polar.sh), [Lemon Squeezy](https://lemonsqueezy.com), [Stripe](https://stripe.com), [Paddle](https://paddle.com), and [Dodo Payments](https://dodopayments.com). Write your products, checkout, subscription, customer-portal, billing-history, usage and webhook logic once against one normalized API — built on raw `fetch` and Web Crypto, so it runs on Node, Cloudflare Workers, and other Web-standard runtimes.

## Features

- **One API, eight namespaces** — products, checkouts, customers, subscriptions, customer portal, orders, usage, and license keys behind a single interface.
- **Capability gating** — providers differ. The client reports what the active provider supports and throws `unsupported` instead of silently dropping an option.
- **One subscription status model** — seven statuses across all five providers, with `cancelAtPeriodEnd` split out so `canceled` always means terminal.
- **Webhook verify & parse** — standalone per-provider helpers that take a Web-standard `Request`. No client, no credentials.
- **Zero dependencies** — `fetch` and Web Crypto only. No `node:*` imports, so it runs on Cloudflare Workers without `nodejs_compat`.
- **Tree-shakable and typed** — each provider ships on its own subpath, so unused providers never reach your bundle. Every model is normalized (IDs as strings, dates as `Date`, amounts in integer minor units) and keeps the untouched provider payload on `raw`.

## Installation

```bash
npm install revenue-sdk
```

## Quickstart

Create a client from the package root and a provider factory from its subpath.

```ts
import { createClient } from 'revenue-sdk';
import { polar } from 'revenue-sdk/polar';

const client = createClient({
  provider: polar({ accessToken: process.env.POLAR_ACCESS_TOKEN! }),
});
```

Create a checkout and redirect the customer to it.

```ts
const { items: products } = await client.products.list({ limit: 10 });
const price = products[0]!.prices[0]!;

const checkout = await client.checkouts.create({
  items: [{ product: price.checkoutRef }],
  customerEmail: 'ada@example.com',
  successUrl: 'https://example.com/thanks',
  metadata: { userId: 'user_123' },
});

console.log(checkout.url);
```

Verify and handle the webhook. Read the raw body once, verify it, then parse it.

```ts
import { parseWebhookEvent, verifyWebhook } from 'revenue-sdk/polar';

export async function handleWebhook(request: Request, secret: string): Promise<Response> {
  const headers = request.headers;
  const body = await request.text();

  if (!(await verifyWebhook({ headers, body, secret }))) {
    return new Response('invalid signature', { status: 401 });
  }

  const event = await parseWebhookEvent({ headers, body });

  // Providers retry for days: deduplicate on event.idempotencyKey, which is always set.
  switch (event.type) {
    case 'subscription.created':
    case 'subscription.updated':
    case 'subscription.canceled':
      // Upsert by event.subscription.id.
      break;
    case 'order.paid':
      // Money received — including renewals.
      break;
  }

  return new Response(null, { status: 204 });
}
```

Check entitlement. A subscription grants access while its status is `active` or `trialing`; a _scheduled_ cancellation keeps the status unchanged and sets `cancelAtPeriodEnd`.

```ts
const subscription = await client.subscriptions.get({ id: 'SUBSCRIPTION_ID' });
const entitled = subscription.status === 'active' || subscription.status === 'trialing';
```

Switching providers means swapping the `provider` argument — the rest of your code stays the same:

```diff
-import { polar } from 'revenue-sdk/polar';
+import { stripe } from 'revenue-sdk/stripe';

 const client = createClient({
-  provider: polar({ accessToken: process.env.POLAR_ACCESS_TOKEN! }),
+  provider: stripe({ secretKey: process.env.STRIPE_SECRET_KEY! }),
 });
```

## API at a glance

| Namespace        | Methods                                                                                                        |
| ---------------- | -------------------------------------------------------------------------------------------------------------- |
| `products`       | `list` · `listAll` · `get`                                                                                     |
| `checkouts`      | `create` · `get`                                                                                               |
| `customers`      | `list` · `listAll` · `get` · `create` · `update`                                                               |
| `subscriptions`  | `list` · `listAll` · `get` · `cancel` · `uncancel` · `changePlan` · `endTrial` · `pause` · `resume` · `revoke` |
| `customerPortal` | `createSession`                                                                                                |
| `orders`         | `list` · `listAll` · `get` · `getInvoiceUrl`                                                                   |
| `usage`          | `report`                                                                                                       |
| `licenseKeys`    | `list` · `listAll` · `get` · `update`                                                                          |

Every list returns an opaque cursor and has a `listAll` async generator that walks the pages for you. Every method accepts a `signal` for cancellation. Reads are retried once on a rate limit or a transient network error; writes are never replayed.

License keys have a second surface: `validateLicenseKey`, `activateLicenseKey`, and `deactivateLicenseKey` are exported from the provider subpaths and take no credential, so they are safe to call from a customer's machine.

## Providers

| Provider      | Import                      | Notes                                                                |
| ------------- | --------------------------- | -------------------------------------------------------------------- |
| Polar         | `revenue-sdk/polar`         | Merchant of record. Organization access token, separate sandbox.     |
| Lemon Squeezy | `revenue-sdk/lemon-squeezy` | Merchant of record. Store-scoped; variants are the purchasable unit. |
| Stripe        | `revenue-sdk/stripe`        | Payment processor. Pinned API version, optional Managed Payments.    |
| Paddle        | `revenue-sdk/paddle`        | Merchant of record. Checkout runs on your own domain via Paddle.js.  |
| Dodo Payments | `revenue-sdk/dodo-payments` | Merchant of record. Live and test mode.                              |
| Testing       | `revenue-sdk/testing`       | Seedable in-memory provider for your test suite. No API keys.        |

Every factory accepts an optional `baseUrl` (self-hosted gateways and proxies) and an injectable `fetch`. Providers do not support the same feature set — `client.capabilities` tells you what the active one can do, and the full breakdown lives in the [capability matrix](https://revenue-sdk.dev/docs/reference/capability-matrix).

## Testing

`revenue-sdk/testing` ships a seedable in-memory provider you hand to `createClient` like any other — no account, no API keys, no `fetch` stubs, no test cards.

```ts
import { createClient } from 'revenue-sdk';
import { createInMemoryProvider } from 'revenue-sdk/testing';

const client = createClient({
  provider: createInMemoryProvider({
    products: [{ id: 'pro', name: 'Pro', prices: [{ amount: 2900, interval: 'month' }] }],
    customers: [{ id: 'cus-1', email: 'ada@example.com' }],
    subscriptions: [{ id: 'sub-1', customerId: 'cus-1', productId: 'pro', status: 'active' }],
  }),
});
```

It reports every capability enabled by default, and a second options argument simulates a specific provider's identity and capability gaps — so code that branches on `client.capabilities` is testable. `signWebhook` produces headers that a provider's own `verifyWebhook` accepts, so webhook handlers are testable too.

## Errors

Every failure is a `RevenueError` with a closed `code` union: `unauthorized`, `forbidden`, `not_found`, `conflict`, `rate_limited`, `payment_required`, `validation`, `unsupported`, `provider_error`, `network_error`.

```ts
import { RevenueError } from 'revenue-sdk';

try {
  await client.subscriptions.revoke({ id: 'SUBSCRIPTION_ID' });
} catch (error) {
  if (error instanceof RevenueError && error.code === 'unsupported') {
    // This provider cannot cancel immediately — cancel at period end instead.
  }
}
```

Errors also carry `provider`, `status`, `retryAfter` and `retryable`. `cause` is the underlying JS `Error`; the provider's parsed body is on `responseBody`, installed non-enumerable so `console.error`, `JSON.stringify` and error reporters cannot pick up customer data by accident. Secrets are never logged or embedded in messages.

## Runtime support

Node.js ≥ 22, Cloudflare Workers (without `nodejs_compat`), Deno, Bun, Vercel Edge, and any other runtime with `fetch`, Web Crypto and `TextEncoder`. ESM only.

## Documentation

Full documentation lives at **[revenue-sdk.dev](https://revenue-sdk.dev)** ([docs](https://revenue-sdk.dev/docs)):

- [Quickstart](https://revenue-sdk.dev/docs/quickstart)
- [Concepts](https://revenue-sdk.dev/docs/concepts/client-and-providers) — clients, checkouts, subscriptions, orders, webhooks, pagination, errors
- [Guides](https://revenue-sdk.dev/docs/guides/checkout-flow) — pricing page, checkout flow, webhook handler, subscription management, Cloudflare Workers, custom providers
- [Capability matrix](https://revenue-sdk.dev/docs/reference/capability-matrix)
- [Webhook events](https://revenue-sdk.dev/docs/reference/webhook-events)
- [Error codes](https://revenue-sdk.dev/docs/reference/error-codes)

## Development

**Prerequisites:** Node >= 22.

```bash
npm install
```

| Script               | Description                                 |
| -------------------- | ------------------------------------------- |
| `npm run build`      | Build with tsdown                           |
| `npm test`           | Run the unit + provider contract test suite |
| `npm run test:watch` | Run tests in watch mode                     |
| `npm run test:live`  | Gated live provider tests (read-only)       |
| `npm run typecheck`  | Type-check without emitting                 |
| `npm run lint`       | Lint the codebase                           |
| `npm run fmt`        | Format with prettier                        |

Docs site:

- `npm run docs:dev` — run the docs dev server
- `npm run docs:build` — build the static site to `.blume-dist/`

Releases are automated with [release-please](https://github.com/googleapis/release-please), driven by [Conventional Commits](https://www.conventionalcommits.org/). While pre-`1.0.0`, breaking changes bump the minor version and features bump the patch version. Merging the release pull request publishes to npm.

## About

revenue-sdk is developed and maintained by [Genz IT Solutions GmbH](http://genz-its.de/). It powers [Capawesome](https://capawesome.io/), a cloud platform for mobile apps.

## License

[MIT](./LICENSE)
