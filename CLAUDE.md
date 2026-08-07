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
- `src/client.ts` — `createClient({ provider })` → grouped namespaces (`products`, `checkouts`, `customers`, `subscriptions`, `customerPortal`, `usage`, `licenseKeys`). All cross-provider behavior lives here: validation, capability gating (throw `unsupported`, never silently drop), one bounded `rate_limited` retry on every call EXCEPT `usage.report` (see below), `listAll` async generators, `AbortSignal` threading.
- `src/providers/<name>/webhooks.ts` — standalone `verifyWebhook` / `parseWebhookEvent` per subpath (no client needed). Root exports `detectWebhookProvider` (routing only, NOT authentication).
- `src/providers/<name>/licenses.ts` — standalone `validateLicenseKey` / `activateLicenseKey` / `deactivateLicenseKey` per subpath (Polar, LS, Dodo only). NO credential, NOT part of `RevenueProvider` — see below.
- Wire payload interfaces are private per provider file, never exported, never `any`. Mapping via small pure `to<Model>()` functions.
- Pagination: opaque base64url provider-tagged cursors (`pagination.ts`); URL-carrying cursors MUST pass `assertSameOriginUrl` (token-exfiltration guard).

## Unified subscription status model (decided — do not relitigate)

`status: 'incomplete' | 'trialing' | 'active' | 'past_due' | 'unpaid' | 'paused' | 'canceled'` — `canceled` is TERMINAL only. A scheduled "cancel at period end" is `cancelAtPeriodEnd: true` with `status` unchanged (+ `endsAt`). A scheduled "pause at period end" works the same way: `pauseAtPeriodEnd: true` with `status` unchanged (+ `resumesAt`); `status` only becomes `paused` once the pause takes effect.

| Unified    | Polar      | Lemon Squeezy      | Stripe                       | Paddle   | Dodo                       |
| ---------- | ---------- | ------------------ | ---------------------------- | -------- | -------------------------- |
| incomplete | incomplete | —                  | incomplete                   | —        | pending                    |
| trialing   | trialing   | on_trial           | trialing                     | trialing | —                          |
| active     | active     | active, cancelled¹ | active                       | active   | active                     |
| past_due   | past_due   | past_due           | past_due                     | past_due | on_hold                    |
| unpaid     | unpaid     | unpaid             | unpaid                       | —        | —                          |
| paused     | paused     | paused             | paused, pause_collection²    | paused   | —                          |
| canceled   | canceled   | expired            | canceled, incomplete_expired | canceled | cancelled, failed, expired |

¹ LS `cancelled` → `active` + `cancelAtPeriodEnd: true`.

² Stripe's `pause_collection` leaves the raw status untouched ("the subscription status will be unchanged and will not be updated to `paused`") → mapped to `paused` anyway, EXCEPT when the raw status is `canceled` (terminal outranks a leftover `pause_collection`). Stripe's raw `paused` status is a different mechanism: a trial that ended without a payment method. `resumeSubscription` reads the subscription first to pick the right endpoint (`pause_collection: null` vs `POST /v1/subscriptions/{id}/resume`).

`cancelAtPeriodEnd` detection: Polar `cancel_at_period_end`; LS status `cancelled`; **Stripe `cancel_at_period_end || cancel_at !== null`** (flexible billing mode portal cancellations set only `cancel_at`); Paddle `scheduled_change?.action === 'cancel'`; Dodo `cancel_at_next_billing_date`.

`pauseAtPeriodEnd` detection: Polar `pause_at_period_end`; Paddle `scheduled_change?.action === 'pause'`; always `false` for LS, Stripe and Dodo (none can schedule a pause).

Pause support (`pause` / `pauseBehaviors`): Polar `true` / `['period_end']` (`resumes_at` must fall after the current period end; resume is immediate — new billing period + charge); LS `true` / `['immediately']` (`mode` fixed to `void`); Stripe `true` / `['immediately']` (`pause_collection`, period-end would need Subscription Schedules); Paddle `true` / `['immediately', 'period_end']` (`on_resume` not exposed); Dodo `false` / `[]`. The client throws `unsupported` when `pause` is false or an explicitly passed `behavior` is not in `pauseBehaviors`; omitting `behavior` uses the provider default.

## Usage-based billing (decided — do not relitigate)

`client.usage.report({ customerId, eventName, value?, metadata?, idempotencyKey?, timestamp? }) → Promise<void>`. `customerId` is the PROVIDER's customer ID; `eventName` must match the meter config EXACTLY (case-sensitive). `value` is shorthand for a `value` entry in the event properties (the default aggregation key) and an explicit `value` beats `metadata.value` — folded once in `providers/shared.ts` (`toUsagePayload`). The client validates non-empty `customerId`/`eventName` + finite `value` AND every numeric `metadata` entry (`validation` — meters aggregate on a caller-configured key, so any number can be the billed quantity), gates on `usageReporting` (`unsupported`), and **NEVER retries**: a replayed event only dedupes when the caller passed `idempotencyKey`, so an automatic retry would over-bill. Capability `usageReporting` sorts LAST in `RevenueCapabilities` (after `uncancel`): Polar/Stripe/Dodo `true`, LS/Paddle `false`, testing `true`.

| Provider | Endpoint                        | Customer key                  | Idempotency                                                                                                        | Backdating                                                                                    |
| -------- | ------------------------------- | ----------------------------- | ------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------- |
| Polar    | `POST /v1/events/ingest`        | `customer_id`                 | `external_id`, permanent unique index → replay-safe                                                                | any past ts, but periods attributed by RECEIPT time, no retroactive invoices → reporting only |
| Stripe   | `POST /v1/billing/meter_events` | `payload[stripe_customer_id]` | `identifier`, rolling ≥24h                                                                                         | 35 days past / 5 min future, else error                                                       |
| Dodo     | `POST /events/ingest`           | `customer_id`                 | `event_id` REQUIRED → SDK generates a UUID when the caller omits `idempotencyKey`, so THAT call is not replay-safe | 1 hour past / 5 min future, else 400 — cannot backfill                                        |

Stripe: **2xx ≠ recorded** — meter events validate synchronously, process asynchronously; an unknown customer or an `event_name` with no matching meter is dropped silently and only surfaces via the `v1.billing.meter.error_report_triggered` / `v1.billing.meter.no_meter_found` thin webhooks (not parsed here). `stripe_customer_id`/`value` are the meter's DEFAULT payload keys (`customer_mapping.event_payload_key` / `value_settings.event_payload_key`) → a meter with custom keys needs them in `metadata`. 1,000 events/s but only ONE concurrent call per customer per meter.

LS is off because `POST /v1/usage-records` keys on a subscription-ITEM id (extra lookup, ambiguous with several subscriptions) and has no idempotency at all with `increment` semantics → any replay double-bills. Paddle is off because it has no usage API (Paddle's guidance: meter externally, bill via `POST /subscriptions/{id}/charge`).

`SubscriptionMeter { id, name, consumedUnits, creditedUnits, amount, raw }` on `Subscription.meters?` — **Polar only** (returned inline on the subscription), absent everywhere else; `amount` is minor units accrued so far this period. Testing provider records `state.usageEvents: InMemoryUsageEvent[]` (`payload` = metadata with `value` merged in).

Out of scope (deliberate): meter CRUD/management, reading usage back (`getCurrent` — Polar answers inline, Stripe needs meter id + minute-aligned window keyed on customer+meter, Dodo only returns CLOSED cycles), normalized `Price.amount` for metered/tiered (stays `null`), batch reporting, tier tables, seat management.

## License keys (decided — do not relitigate)

**TWO SURFACES, and the split is the feature.**

1. **Public, credential-free** — `validateLicenseKey` / `activateLicenseKey` / `deactivateLicenseKey` are STANDALONE per-subpath exports (`revenue-sdk/polar|lemon-squeezy|dodo-payments`), NOT client methods and NOT on `RevenueProvider`. Why, all three reasons: (a) they are the only endpoints in the SDK needing no secret — hanging them off the authenticated client teaches devs that validating a license needs the merchant key, which ends with that key inside a shipped desktop binary; (b) **Polar answers `401 invalid_token` if ANY `Authorization` header is present** on those routes, so a client-mounted method would have to strip the header its own transport just added; (c) bundle size — a shipped app pulls in three small functions, not the whole client. Shared params `key`, `baseUrl?`, `fetch?`, `signal?` (every params type extends `BaseParams`, LS included). Validate takes `activationId?`, activate takes `label`, deactivate takes `activationId` (LS's wire name is "instance"; the SDK name is uniform everywhere).
2. **Merchant CRUD, credentialed** — `client.licenseKeys.list/listAll/get/update`, gated on capability `licenseKeys` (sorted between `hostedCheckout` and `listSubscriptionsByCustomer`): Polar/LS/Dodo `true`, Stripe/Paddle `false`, testing `true`. Client checks: non-empty `id` and `activationLimit` must be `null` or a positive integer (both `validation`), capability (`unsupported`). No `create` — only Dodo can mint a key upstream.
3. **Issuance webhook** — normalized `WebhookEventType` `license.issued`, from Polar `benefit_grant.created` (ONLY when `data.benefit.type === 'license_keys'` — the SDK's only payload-derived event type; other benefit types → `unknown`), LS `license_key_created`, Dodo `license_key.created`. Stripe/Paddle emit nothing. TWO fields, deliberately: `licenseKeyId` is ALWAYS set on the event (one uniform access path on every provider), `licenseKey` only where the provider sends the real key — never on Polar, whose grant carries only the masked `display_key`, so the follow-up is `client.licenseKeys.get({ id: event.licenseKeyId })`. LS's mapped `licenseKey` has NO `productId` (same LS-product-vs-variant reason as the merchant path); Dodo's does. NOT mapped: `license.revoked` / `license.updated` — Polar signals revocation directly (`benefit_grant.revoked`), LS only has a generic `license_key_updated` that would have to be diffed on `status`, Dodo has no revocation or update event at all; one direct signal, one inferred, one absent is not a normalization. Enforcement belongs in the shipped app via `validateLicenseKey` (all three reject revoked/disabled/expired server-side), server-side bookkeeping on the subscription events (normalized on all five providers).

Return types are IDENTICAL on all three subpaths — `validate → LicenseKeyValidation`, `activate → LicenseKeyActivation`, `deactivate → void` — even though LS answers all three of its routes with one envelope. Only `validate` reports a rejection as data (`valid: false`, never throws); activate/deactivate carry no verdict field, so a refusal throws: reached activation limit → `validation`, key belonging to another store → `not_found` (deliberately indistinguishable from unknown, and the foreign key's details are never attached). All params extend `BaseParams`, so `signal` works everywhere.

Scoping — the security core:

- **Polar**: `organizationId` REQUIRED. It is a PUBLIC identifier, safe to ship in an app, and it is what gives Polar server-side merchant scoping.
- **LS**: `expect: { storeId, productId?, variantId? }` REQUIRED. The public license API takes ONLY the key, so ANY LS merchant's key validates ("someone using a license key from another Lemon Squeezy product could use it to get access to your product" — LS docs). Asserted against the response `meta` on all three ops; a mismatch — or a missing `meta` (fail closed) — yields `valid: false` with `licenseKey`/`activation` left undefined, so a foreign key is never handed to the caller. IDs compared as strings.
- **Dodo**: CANNOT be scoped at all — the validate response is literally `{ valid: boolean }` (no product, business, customer or expiry). Therefore `LicenseKeyValidation.licenseKey` is ALWAYS undefined on Dodo, and `activate` is the only op that reveals `business_id`/`product`. Real limitation, documented as such.

`LicenseKeyStatus: 'active' | 'disabled' | 'expired'` — `valid` from a validation call is ALWAYS authoritative over the locally derived `status`.

| Unified  | Polar                      | Lemon Squeezy     | Dodo     |
| -------- | -------------------------- | ----------------- | -------- |
| active   | granted                    | active, inactive¹ | active   |
| disabled | revoked, disabled          | disabled          | disabled |
| expired  | derived from `expires_at`² | expired           | expired  |

¹ LS `inactive` means "issued but never activated" — still usable.

² Polar has no `expired` status. But Polar rejects expired, revoked AND disabled keys server-side on validate (`service.py` raises `ResourceNotFound` → 404 → `valid: false`), so the derived status only ever shows up on MERCHANT reads and can never contradict a validation verdict.

Out of scope (deliberate): key creation (Dodo-only upstream), issuance configuration (Polar benefit / LS variant setting / Dodo entitlement — all dashboard-configured), Polar's usage metering on keys (`increment_usage`, `conditions`, `limit_usage`), every license webhook event except issuance (see point 3). Testing provider: `InMemorySeed.licenseKeys?: InMemoryLicenseKeySeed[]` → `state.licenseKeys`; it deliberately does NOT implement the standalone public functions (they are subpath exports, not `RevenueProvider` members).

## Webhook signature schemes (verified against official SDK sources — exact, do not guess)

| Provider      | Header(s)                            | Signed payload           | HMAC key derivation                                | Output                                 |
| ------------- | ------------------------------------ | ------------------------ | -------------------------------------------------- | -------------------------------------- |
| Polar         | `webhook-id/-timestamp/-signature`   | `{id}.{ts}.{body}`       | secret **VERBATIM incl. `whsec_`** (UTF-8)         | base64, any `v1,` part                 |
| Dodo          | same (Standard Webhooks)             | `{id}.{ts}.{body}`       | **strip `whsec_`, then base64-DECODE** → key bytes | base64, any `v1,` part                 |
| Stripe        | `stripe-signature`                   | `{t}.{body}`             | secret verbatim incl. `whsec_`                     | lowercase hex, any `v1=`, ignore `v0=` |
| Paddle        | `paddle-signature` (`ts=...;h1=...`) | `{ts}:{body}`            | secret verbatim                                    | lowercase hex, any `h1=`               |
| Lemon Squeezy | `x-signature`                        | body only (no timestamp) | secret verbatim                                    | hex (compare case-insensitively)       |

Polar vs Dodo key handling differs even though both are "Standard Webhooks" — Polar's SDK base64-encodes the raw secret before handing it to the lib (cancels out to verbatim); Dodo uses the lib's strict behavior. Always verify against the RAW request body (`await request.text()` once); timestamp tolerance 300s default; constant-time compare; never throw on unknown event types when parsing (open unions).

`WebhookEventType` also carries `license.issued` (alphabetical, after `checkout.completed`) — see the License keys section for the mapping and the two-field (`licenseKeyId`/`licenseKey`) rationale. **Polar's is the ONLY normalized type derived from the PAYLOAD rather than the provider's event string** (`benefit_grant.created` + `data.benefit.type === 'license_keys'`); every other benefit type falls through to `unknown`. Do not generalize this — no other mapping may branch on payload contents.

## Provider quirks cheat sheet

- **Polar**: trailing slashes in collection paths are load-bearing (`/v1/checkouts/`). Sandbox = separate host (`sandbox-api.polar.sh`). `Retry-After` on 429. Checkout takes `products: string[]`; `external_customer_id` links your user IDs. No idempotency keys. Pause is period-end only and the pause fields must be PATCHed alone (`SubscriptionUpdate` is an exclusive union); resume = `{ resume: true }`. Usage ingest is `/v1/events/ingest` — an action, so NO trailing slash; metadata caps 50 pairs / 40-char keys / 500-char string values; ingest also accepts `external_customer_id` (not exposed by the unified API). Subscriptions carry inline `meters`. License routes are `/v1/customer-portal/license-keys/{validate,activate,deactivate}` and must send NO `Authorization` (401 otherwise); validate 404 = EVERY kind of rejection (unknown/revoked/disabled/expired/unmatched activation) → `valid: false`, other statuses still throw; activate 403 = limit reached OR no activation limit configured at all; `LicenseKey.productId` never set (a key hangs off `benefit_id`, and a benefit is not a product); `activationCount` only populated by `getLicenseKey` (list and PATCH return no activations array); `update({ disabled: true })` writes `disabled`, NOT `revoked` — `revoked` is owned by the benefit lifecycle and flips back to `granted` on the next grant cycle.
- **Lemon Squeezy**: JSON:API (`application/vnd.api+json` on ALL requests incl. GET). `data.id` is string but FKs in `attributes` are numbers → coerce with `String()`. Empty objects serialize as `[]` (`custom`, `billing_address`). Unified `Product` = LS **variant**; current price via variant `price-model` relationship (NOT `/v1/prices?filter[variant_id]` — that's append-only history). Portal/update URLs expire in 24h — fetch on demand. PayPal subscriptions: `PATCH /subscriptions` silently no-ops (hits plan change, uncancel, pause and resume alike). Pause is `{ pause: { mode: 'void', resumes_at } }`, resume is `{ pause: null }`. No usage reporting (`usageReporting: false`) — `usage-records` keys on a subscription item and has no idempotency. Test mode is a property of the API key. `storeId` required in factory (checkout `store` relationship). The public license API (`/v1/licenses/*`) is NOT JSON:API — form-encoded body, `Accept: application/json`, own `HttpClient` — and is unscoped, hence the required `expect`; test and live share ONE host, so `license_key.test_mode` on `raw` is the only discriminator (a test key validates against production); non-OK responses that carry the verdict field are verdicts, not errors (activate limit reached = **400** `{"activated":false,"error":"License key activation limit reached."}`), anything else re-throws; merchant `LicenseKey.productId` is undefined (LS `product_id` = LS PRODUCT, unified `Product` = variant → the ID would not work with `products.get`), the public path uses `meta.variant_id` instead; `disabled` arrives as boolean OR number depending on the endpoint.
- **Stripe**: bodies are `application/x-www-form-urlencoded` with bracket notation — the form encoder (`providers/stripe/form-encoder.ts`) is load-bearing: sequential explicit array indices, `undefined` → omit key, `null` → `''`, booleans `'true'/'false'`, `Date` → unix seconds. Pin `Stripe-Version` (const). Unix-second timestamps everywhere. `GET /v1/subscriptions` hides canceled subs by default → pass `status=all`. Plan change MUST send `items[0][id]` (else double-billing). No `Retry-After`; use `Stripe-Should-Retry`. `current_period_*` lives on subscription items, not the subscription. Two unrelated pause mechanisms — see footnote ² above. Meter events (`/v1/billing/meter_events`) are async: a 2xx does NOT mean the usage was recorded. NO license-key API at all (`licenseKeys: false`) — Billing Entitlements is not a substitute: derived per-customer feature boolean, no key string, no activation count, no device identity, and `GET /v1/entitlements/active_entitlements` is secret-key-only with no `entitlements` component on `CustomerSessions`, so a shipped app cannot check its own license.
- **Paddle**: NO API-hosted checkout — `POST /transactions` → `checkout.url` points at the merchant's own default-payment-link page (requires Paddle.js + approved domain); capability `hostedCheckout: false`. Amounts are string integers. Auth failures are **403**. `PATCH` list fields (`items`) are full replacement → GET-merge-PATCH. Cancel = `POST /subscriptions/{id}/cancel`; undo = `PATCH { scheduled_change: null }`. Pause/resume = `POST /subscriptions/{id}/pause|resume` with `effective_from` (`period_end` → `next_billing_period`; resume always `immediately`). Portal path is `POST /customers/{id}/portal-sessions`. `management_urls` absent from webhook payloads. No usage API at all (`usageReporting: false`) — meter externally and bill via `POST /subscriptions/{id}/charge`. Billing v1 REMOVED license keys (Classic had `POST /api/2.0/product/generate_license`; Paddle's own migration matrix lists them as Classic-only with no Billing equivalent, and Classic takes no new signups) → `licenseKeys: false`.
- **Dodo**: unversioned, additive API → tolerant types, open enums, never validate ID prefixes. `POST /checkouts` (legacy `POST /payments`/`POST /subscriptions` are deprecated). Pagination: zero-based `page_number`, envelope `{ items }`, NO has_more → terminate when `items.length < page_size`. `TimeInterval` is capitalized (`'Month'`). `POST /change-plan` returns 200 with EMPTY body. Portal session params go in the QUERY string. No end-trial operation (capability `endTrial: false`). No pause/resume endpoint and no paused status (capability `pause: false`). `/events/ingest` requires `event_id` (SDK generates a UUID when `idempotencyKey` is omitted), rejects timestamps older than 1h, and drops unknown `customer_id`s silently. License routes: public `/licenses/{validate,activate,deactivate}` vs merchant `/license_keys/*` (UNDERSCORE); the merchant list/get/update endpoints are marked `@deprecated` upstream in favour of an entitlements-based replacement but still function; the public routes carry the tightest rate limits of the three (~20/sec, 100/min); validate answers `{ valid }` only and a 404 means the same as `valid: false`; deactivate answers 200 with an EMPTY body.

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
- Status, `cancelAtPeriodEnd` or `pauseAtPeriodEnd` mapping → `docs/reference/status-mapping.mdx` + `docs/concepts/subscription-lifecycle.mdx` + the table above
- Webhook event mapping in `providers/*/webhooks.ts` → `docs/reference/webhook-events.mdx` + `docs/concepts/webhooks.mdx` (license events also `docs/concepts/license-keys.mdx` + that provider's "events worth subscribing to" list)
- `WebhookEvent` fields → the `TypeTable` in `docs/concepts/webhooks.mdx` + the "which model each event carries" table in `docs/reference/webhook-events.mdx`
- `RevenueErrorCode` union or `codeFromStatus` → `docs/reference/error-codes.mdx`
- `reportUsage` wire mapping, `toUsagePayload`, or `Subscription.meters` → `docs/concepts/usage-based-billing.mdx` + that provider's page + the table above
- License-key status mapping, the standalone `providers/*/licenses.ts` signatures, or `licenseKeys` client gating → `docs/concepts/license-keys.mdx` + that provider's page + the tables above
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

v0.1.0 feature-complete: all five providers, client, testing provider, docs site, CI/release/live workflows. Published as in-development (0.x) — APIs may change. Deferred post-v1: orders resource, discounts, webhook-endpoint management, `tokenProvider`-style auth.
