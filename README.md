# revenue-sdk

Unified TypeScript SDK for billing providers — [Polar](https://polar.sh), [Lemon Squeezy](https://lemonsqueezy.com), [Stripe](https://stripe.com), [Paddle](https://paddle.com), [Dodo Payments](https://dodopayments.com).

## Features

- **One API, five providers** — products, checkouts, customers, subscriptions, customer portal, and webhooks behind a single interface.
- **Zero dependencies** — built entirely on Web-standard APIs (`fetch`, Web Crypto). Runs on Cloudflare Workers, Deno, Bun, and Node.js 22+ without polyfills.
- **Webhook verification included** — per-provider signature verification and normalized event parsing, implementable-anywhere via Web Crypto.
- **Tree-shakable by design** — each provider ships on its own subpath (`revenue-sdk/polar`), so unused providers never reach your bundle.
- **Typed, normalized models** — a unified subscription status model across all providers, with the raw provider payload always available via `raw`.

## Installation

```bash
npm install revenue-sdk
```

## Quickstart

```ts
import { createClient } from 'revenue-sdk';
import { polar } from 'revenue-sdk/polar';

const client = createClient({
  provider: polar({ accessToken: process.env.POLAR_ACCESS_TOKEN! }),
});

const checkout = await client.checkouts.create({
  items: [{ product: 'your-product-id' }],
  successUrl: 'https://example.com/thanks',
});
```

## Documentation

Full documentation will be available at [revenue-sdk.dev](https://revenue-sdk.dev).

## License

[MIT](./LICENSE)
