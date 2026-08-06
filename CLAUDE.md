# CLAUDE.md

revenue-sdk — unified TypeScript SDK for billing providers (Polar, Lemon Squeezy, Stripe, Paddle, Dodo Payments). Architecture mirrors [repo-sdk](https://github.com/capawesome-team/repo-sdk): **thin adapter, fat client**.

## Commands

- `npm run build` — tsdown (ESM only, platform neutral, bundled d.ts)
- `npm test` — vitest (unit + provider contract tests; excludes `test/live/**`)
- `npm run test:live` — env-gated live tests (`REVENUE_SDK_LIVE_<PROVIDER>_*`; tests read env via `test/helpers/env.ts` because the tsconfig deliberately has no Node types)
- `npm run typecheck` / `lint` / `fmt` / `fmt:check`
- `npm run docs:dev` / `docs:build` / `docs:check` — Blume docs site. GOTCHA: `docs:build` writes Astro output into `dist/` (clobbering the SDK bundle) and copies it to `.blume-dist` for Cloudflare Pages deploys; `prepack` rebuilds the bundle, but re-run `npm run build` manually after building docs.

## Hard constraints

- **Zero runtime dependencies. No `node:*` imports in `src/`.** Only Web-standard APIs: `fetch`, `crypto.subtle`, `btoa`/`atob`, `TextEncoder`, `URL`, `AbortSignal`, `Request`/`Response`/`Headers`. Must run on Cloudflare Workers WITHOUT `nodejs_compat`.
- ESM only. No CJS build. Intra-package imports use explicit `.ts` extensions (`verbatimModuleSyntax` + `allowImportingTsExtensions`).
- Every provider factory accepts `fetch?: typeof fetch` (test seam + edge runtimes). Call injected fetch **detached from any holder object** (workerd throws `Illegal invocation` otherwise).
- Never log or embed secrets in error messages — `RevenueError` redacts via the `secrets` hook.
- No module-scope mutable state (Workers isolate reuse).

## Architecture

- `src/types.ts` — normalized models + flat `RevenueProvider` interface + `RevenueCapabilities`. Every model carries `raw: unknown`. IDs coerced to `string`, dates are `Date`, amounts integer minor units.
- `src/providers/<name>/index.ts` — factory function (`polar()`, `lemonSqueezy()`, `stripe()`, `paddle()`, `dodoPayments()`) returning an object literal. No classes, no registry; consumers import from subpaths (`revenue-sdk/polar`) so unused providers never bundle.
- `src/client.ts` — `createClient({ provider })` → grouped namespaces (`products`, `checkouts`, `customers`, `subscriptions`, `customerPortal`). All cross-provider behavior lives here: validation, capability gating (throw `unsupported`, never silently drop), one bounded `rate_limited` retry, `listAll` async generators, `AbortSignal` threading.
- `src/providers/<name>/webhooks.ts` — standalone `verifyWebhook` / `parseWebhookEvent` per subpath (no client needed). Root exports `detectWebhookProvider` (routing only, NOT authentication).
- Wire payload interfaces are private per provider file, never exported, never `any`. Mapping via small pure `to<Model>()` functions.
- Pagination: opaque base64url provider-tagged cursors (`pagination.ts`); URL-carrying cursors MUST pass `assertSameOriginUrl` (token-exfiltration guard).

## Unified subscription status model (decided — do not relitigate)

`status: 'incomplete' | 'trialing' | 'active' | 'past_due' | 'unpaid' | 'paused' | 'canceled'` — `canceled` is TERMINAL only. A scheduled "cancel at period end" is `cancelAtPeriodEnd: true` with `status` unchanged (+ `endsAt`).

| Unified    | Polar      | Lemon Squeezy      | Stripe                       | Paddle   | Dodo                       |
| ---------- | ---------- | ------------------ | ---------------------------- | -------- | -------------------------- |
| incomplete | incomplete | —                  | incomplete                   | —        | pending                    |
| trialing   | trialing   | on_trial           | trialing                     | trialing | —                          |
| active     | active     | active, cancelled¹ | active                       | active   | active                     |
| past_due   | past_due   | past_due           | past_due                     | past_due | on_hold                    |
| unpaid     | unpaid     | unpaid             | unpaid                       | —        | —                          |
| paused     | paused     | paused             | paused                       | paused   | —                          |
| canceled   | canceled   | expired            | canceled, incomplete_expired | canceled | cancelled, failed, expired |

¹ LS `cancelled` → `active` + `cancelAtPeriodEnd: true`.

`cancelAtPeriodEnd` detection: Polar `cancel_at_period_end`; LS status `cancelled`; **Stripe `cancel_at_period_end || cancel_at !== null`** (flexible billing mode portal cancellations set only `cancel_at`); Paddle `scheduled_change?.action === 'cancel'`; Dodo `cancel_at_next_billing_date`.

## Webhook signature schemes (verified against official SDK sources — exact, do not guess)

| Provider      | Header(s)                            | Signed payload           | HMAC key derivation                                | Output                                 |
| ------------- | ------------------------------------ | ------------------------ | -------------------------------------------------- | -------------------------------------- |
| Polar         | `webhook-id/-timestamp/-signature`   | `{id}.{ts}.{body}`       | secret **VERBATIM incl. `whsec_`** (UTF-8)         | base64, any `v1,` part                 |
| Dodo          | same (Standard Webhooks)             | `{id}.{ts}.{body}`       | **strip `whsec_`, then base64-DECODE** → key bytes | base64, any `v1,` part                 |
| Stripe        | `stripe-signature`                   | `{t}.{body}`             | secret verbatim incl. `whsec_`                     | lowercase hex, any `v1=`, ignore `v0=` |
| Paddle        | `paddle-signature` (`ts=...;h1=...`) | `{ts}:{body}`            | secret verbatim                                    | lowercase hex, any `h1=`               |
| Lemon Squeezy | `x-signature`                        | body only (no timestamp) | secret verbatim                                    | hex (compare case-insensitively)       |

Polar vs Dodo key handling differs even though both are "Standard Webhooks" — Polar's SDK base64-encodes the raw secret before handing it to the lib (cancels out to verbatim); Dodo uses the lib's strict behavior. Always verify against the RAW request body (`await request.text()` once); timestamp tolerance 300s default; constant-time compare; never throw on unknown event types when parsing (open unions).

## Provider quirks cheat sheet

- **Polar**: trailing slashes in collection paths are load-bearing (`/v1/checkouts/`). Sandbox = separate host (`sandbox-api.polar.sh`). `Retry-After` on 429. Checkout takes `products: string[]`; `external_customer_id` links your user IDs. No idempotency keys.
- **Lemon Squeezy**: JSON:API (`application/vnd.api+json` on ALL requests incl. GET). `data.id` is string but FKs in `attributes` are numbers → coerce with `String()`. Empty objects serialize as `[]` (`custom`, `billing_address`). Unified `Product` = LS **variant**; current price via variant `price-model` relationship (NOT `/v1/prices?filter[variant_id]` — that's append-only history). Portal/update URLs expire in 24h — fetch on demand. PayPal subscriptions: `PATCH /subscriptions` silently no-ops. Test mode is a property of the API key. `storeId` required in factory (checkout `store` relationship).
- **Stripe**: bodies are `application/x-www-form-urlencoded` with bracket notation — the form encoder (`providers/stripe/form-encoder.ts`) is load-bearing: sequential explicit array indices, `undefined` → omit key, `null` → `''`, booleans `'true'/'false'`, `Date` → unix seconds. Pin `Stripe-Version` (const). Unix-second timestamps everywhere. `GET /v1/subscriptions` hides canceled subs by default → pass `status=all`. Plan change MUST send `items[0][id]` (else double-billing). No `Retry-After`; use `Stripe-Should-Retry`. `current_period_*` lives on subscription items, not the subscription.
- **Paddle**: NO API-hosted checkout — `POST /transactions` → `checkout.url` points at the merchant's own default-payment-link page (requires Paddle.js + approved domain); capability `hostedCheckout: false`. Amounts are string integers. Auth failures are **403**. `PATCH` list fields (`items`) are full replacement → GET-merge-PATCH. Cancel = `POST /subscriptions/{id}/cancel`; undo = `PATCH { scheduled_change: null }`. Portal path is `POST /customers/{id}/portal-sessions`. `management_urls` absent from webhook payloads.
- **Dodo**: unversioned, additive API → tolerant types, open enums, never validate ID prefixes. `POST /checkouts` (legacy `POST /payments`/`POST /subscriptions` are deprecated). Pagination: zero-based `page_number`, envelope `{ items }`, NO has_more → terminate when `items.length < page_size`. `TimeInterval` is capitalized (`'Month'`). `POST /change-plan` returns 200 with EMPTY body. Portal session params go in the QUERY string. No end-trial operation (capability `endTrial: false`).

## Conventions

- One options/params object per public function; params extend `BaseParams { signal?: AbortSignal }`.
- Mappers `to<Model>()`, constants `SCREAMING_SNAKE`, files kebab-case, barrels list exports explicitly and alphabetically (`export {}` / `export type {}` separated, never `export *`).
- All errors are `RevenueError` with closed `code` union: `unauthorized | forbidden | not_found | conflict | rate_limited | payment_required | validation | unsupported | provider_error | network_error`.
- JSDoc only for non-obvious semantics; inline comments only for provider quirks (cite the upstream behavior).
- Conventional Commits with provider scopes: `feat(paddle): ...`, `fix(stripe): ...`.

## Testing

- `test/unit/` — client (fake provider), errors, pagination, Stripe form encoder, webhook verify with precomputed HMAC vectors.
- `test/providers/<name>.test.ts` — contract tests over `test/helpers/fetch-stub.ts` (hand-rolled, no msw): assert outgoing request (method/path/headers/body) AND normalized result.
- `test/live/` — read-only, `describe.skipIf(!env)`, prefix `REVENUE_SDK_LIVE_<PROVIDER>_*`. Only providers with accounts.
- `revenue-sdk/testing` — in-memory provider, `PAGE_SIZE = 2` on purpose.

## Docs drift checklist

When changing any of the following, update the matching docs in the same PR:

- A provider's `CAPABILITIES` const → `docs/reference/capability-matrix.mdx` + that provider's page + this file's tables
- Status or `cancelAtPeriodEnd` mapping → `docs/reference/status-mapping.mdx` + `docs/concepts/subscription-lifecycle.mdx` + the table above
- Webhook event mapping in `providers/*/webhooks.ts` → `docs/reference/webhook-events.mdx` + `docs/concepts/webhooks.mdx`
- `RevenueErrorCode` union or `codeFromStatus` → `docs/reference/error-codes.mdx`
- Provider factory options → that provider's page + `docs/quickstart.mdx` code tabs + `pages/index.astro` code tabs

## Blog

`blog/*.mdx` → `/blog`, rendered by the custom `pages/blog/index.astro` and `pages/blog/[slug].astro`
(custom pages win over the content route at the same path). Posts need `type: blog` + `date` in
frontmatter; `blog/index.mdx` deliberately has neither so it stays out of the post list.

SEO/GEO conventions, all enforced by `npx blume audit` (run it against `dist/` after `docs:build`):
question-form `##` headings answered in their first sentence, a "short version" bullet list up top, a
"Frequently asked questions" section, `<title>` ≤ 60 chars (use `seo.title` when the H1 is longer),
description 110–160 chars, and enough in-body links that no post is an orphan. `PageLayout` emits no
JSON-LD, so both blog pages build their own schema.org graph. Verify with `npx blume validate`
(internal links) and `npx blume audit`.

## Status

v0.1.0 feature-complete: all five providers, client, testing provider, docs site, CI/release/live workflows. Published as in-development (0.x) — APIs may change. Deferred post-v1: orders resource, usage-based billing, pause/resume, discounts, license keys, webhook-endpoint management, `tokenProvider`-style auth.
