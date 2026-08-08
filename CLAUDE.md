# CLAUDE.md

revenue-sdk — unified TypeScript SDK for billing providers (Polar, Lemon Squeezy, Stripe, Paddle, Dodo Payments). Architecture mirrors [repo-sdk](https://github.com/capawesome-team/repo-sdk): **thin adapter, fat client**.

## Commands

- `npm run build` — tsdown (ESM only, platform neutral, bundled d.ts)
- `npm test` — vitest (unit + provider contract tests; excludes `test/live/**`)
- `npm run test:live` — env-gated live tests (`REVENUE_SDK_LIVE_<PROVIDER>_*`; tests read env via `test/helpers/env.ts` because the tsconfig deliberately has no Node types)
- `npm run typecheck` / `lint` / `fmt` / `fmt:check`
- `npm run docs:dev` / `docs:build` / `docs:check` — Blume docs site. GOTCHA: `docs:build` writes Astro output into `dist/` (clobbering the SDK bundle) and copies it to `.blume-dist` for Cloudflare Pages deploys; `prepack` rebuilds the bundle, but re-run `npm run build` manually after building docs.

## Breaking changes

Still 0.x and pre-release: a clean model wins over backwards compatibility every time. Never contort the
design to spare existing callers — rename, re-shape or delete the wrong abstraction and note it in the
commit footer. Do avoid changes that break callers _silently_; make them fail loudly instead.

## Hard constraints

- **Zero runtime dependencies. No `node:*` imports in `src/`.** Only Web-standard APIs: `fetch`, `crypto.subtle`, `btoa`/`atob`, `TextEncoder`, `URL`, `AbortSignal`, `Request`/`Response`/`Headers`. Must run on Cloudflare Workers WITHOUT `nodejs_compat`.
- ESM only. No CJS build. Intra-package imports use explicit `.ts` extensions (`verbatimModuleSyntax` + `allowImportingTsExtensions`).
- Every provider factory accepts `fetch?: typeof fetch` (test seam + edge runtimes). Call injected fetch **detached from any holder object** (workerd throws `Illegal invocation` otherwise).
- Never log or embed secrets in error messages — `RevenueError` redacts via the `secrets` hook.
- No module-scope mutable state (Workers isolate reuse).

## Architecture

- `src/types.ts` — normalized models + flat `RevenueProvider` interface + `RevenueCapabilities`. Every model carries `raw: unknown`. IDs coerced to `string`, dates are `Date`, amounts integer minor units.
- `src/providers/<name>/index.ts` — factory function (`polar()`, `lemonSqueezy()`, `stripe()`, `paddle()`, `dodoPayments()`) returning an object literal. No classes, no registry; consumers import from subpaths (`revenue-sdk/polar`) so unused providers never bundle.
- `src/client.ts` — `createClient({ provider })` → grouped namespaces (`products`, `checkouts`, `customers`, `subscriptions`, `customerPortal`, `usage`, `licenseKeys`, `orders`). All cross-provider behavior lives here: validation, capability gating (throw `unsupported`, never silently drop), at most ONE bounded retry per call, `listAll` async generators, `AbortSignal` threading. Retry fires on `rate_limited` unless `error.retryable === false` (Stripe's `Stripe-Should-Retry`) on every call EXCEPT `usage.report` (see `.claude/rules/usage-billing.md`), and additionally on any `retryable` error (`network_error`, 5xx) for READS only — writes carry no idempotency key, so a lost response is never replayed; delay = `retryAfter` else 1s (Stripe sends no `Retry-After`), skipped when it exceeds `maxRetryAfterSeconds` (0 disables), and the wait rejects with `signal.reason` on abort. Each list resource has ONE checked `list<Resource>` function (validation + capability gate + `runRead`); `list` IS that function and `listAll` feeds it to `listAllOf`, so a check exists once per namespace, both surfaces REJECT rather than throw synchronously, and the retry wraps each page exactly once. `limit` must be undefined or a positive integer (`validation`) — no upper bound, adapters clamp. `customers.create`/`update` are NOT capability-gated (all five providers create and update customers); `name` is REQUIRED on create because LS and Dodo reject a nameless customer, and a blank `email`/`name` on either call is `validation` — `''` is never a "clear this field" signal, an omitted field is. `checkouts.create({ customAmount })` is the buyer-chosen amount of a pay-what-you-want price (`Price.model === 'custom'`), integer MINOR UNITS in the product's own currency: validated as a positive integer (`validation`, no upper bound — the price's own min/max live upstream) and gated on capability `checkoutCustomAmount` (`unsupported`): Polar/LS `true`, Stripe/Paddle/Dodo `false`, testing `true`. Neither Polar nor LS errors when the price is NOT custom (Polar documents that it "will be ignored for fixed and free prices"), so this is one gap the SDK cannot close client-side without an extra product read. No `customers.delete` (Polar-only upstream). Customer `metadata` IS gated, on capability `customerMetadata` (both create and update, `unsupported`): LS `false` (its customer object has no metadata field at all), everyone else `true` — a capability, not an adapter throw, so provider-agnostic callers can branch before calling, exactly like `portalReturnUrl`/`checkoutSuccessUrl`.
- `src/providers/<name>/webhooks.ts` — standalone `verifyWebhook` / `parseWebhookEvent` per subpath (no client needed). Root exports `detectWebhookProvider` (routing only, NOT authentication).
- `src/providers/<name>/licenses.ts` — standalone `validateLicenseKey` / `activateLicenseKey` / `deactivateLicenseKey` per subpath (Polar, LS, Dodo only). NO credential, NOT part of `RevenueProvider` — see `.claude/rules/license-keys.md`.
- `src/providers/shared.ts` — the only cross-provider helpers: `unsupported(provider, feature)` (`${DisplayName} does not support ${feature}`, code `unsupported`) and `requireOptions(provider, record)` (each factory's first statement; throws `validation` naming ONLY the missing keys, never echoing a provided value), plus `toDate` / `fromUnixSeconds` / `toUsagePayload` / `toMetadata`. `idOf` stays local to Stripe.
- `src/http.ts` — `buildUrl` CONCATENATES `baseUrl` + path (one trailing slash trimmed, path must start with `/`): `new URL(path, baseUrl)` would drop a gateway path prefix, and `baseUrl` is documented as verbatim. An absolute `https?://` path (Paddle's cursor URLs) still bypasses `baseUrl` entirely.
- Wire payload interfaces are private per provider file, never exported, never `any`. Mapping via small pure `to<Model>()` functions.
- Pagination: opaque base64url provider-tagged cursors (`pagination.ts`); URL-carrying cursors MUST pass `assertSameOriginUrl` (token-exfiltration guard). `pageNumberCursor(provider, { startPage, defaultLimit, maxLimit, pageKey, limitKey })` → `{ read, next }` covers the three plain page-number adapters (Polar/LS start 1, Dodo 0) and encodes the same `{ page }` state they always did. Bespoke on purpose: Stripe's id cursor, Paddle's URL cursor, and the LS orders union (its cursor carries a `source` phase). `clampLimit` falls back on a non-finite limit.

## Deep-dive rules (`.claude/rules/`)

Domain decision records and provider quirks live in `.claude/rules/*.md`; each auto-loads (via `paths:` frontmatter) when a matching file is touched. Consult them BEFORE changing anything in their area — most are marked "decided — do not relitigate":

- `subscriptions.md` — unified status model + mapping table, cancel/pause-at-period-end detection, pause support, `subscriptionChange` edges
- `usage-billing.md` — `usage.report` contract (never retried), per-provider wire table, why LS/Paddle are off
- `license-keys.md` — two-surface split, per-provider scoping (the security core), status mapping
- `orders.md` — one-resource-per-provider table, LS union cursor, `getInvoiceUrl` lifetimes, refund status
- `webhooks.md` — signature schemes (exact, verified), event model, the only four payload-derived mappings, idempotency
- `polar.md` / `lemon-squeezy.md` / `stripe.md` / `paddle.md` / `dodo-payments.md` — provider quirks cheat sheets
- `docs-drift.md` — single-home rule + checklist of docs to update in the same PR
- `blog.md` — blog rendering + SEO/GEO conventions

## Conventions

- One options/params object per public function; params extend `BaseParams { signal?: AbortSignal }`.
- A new normalized param earns its place only if at least two providers implement the SAME concept (not a similar-sounding field) and the SDK's model does not structurally prevent it; below that bar, say "call the provider directly". `customAmount` CLEARED it (Polar `amount` and LS `custom_price` are the same buyer-chosen amount in minor units on the same call); `embedOrigin`, a per-checkout product description and a `providerOptions` passthrough all failed it — the passthrough also voids "throw `unsupported`, never silently drop", since the client cannot gate keys it does not know.
- Mappers `to<Model>()`, constants `SCREAMING_SNAKE`, files kebab-case, barrels list exports explicitly and alphabetically (`export {}` / `export type {}` separated, never `export *`).
- All errors are `RevenueError` with closed `code` union: `unauthorized | forbidden | not_found | conflict | rate_limited | payment_required | validation | unsupported | provider_error | network_error`.
- **`cause` vs `responseBody`**: `cause` is the underlying JS `Error` and nothing else; the provider's parsed body goes on `responseBody`, installed NON-ENUMERABLE via `Object.defineProperty` so `console.error`/`util.inspect`/`JSON.stringify`/Sentry cannot pick it up while a deliberate `error.responseBody` still can. Do NOT redact it — the content is customer PII, which no secrets list can enumerate, and redacting would corrupt `LicenseKeyValidation.raw` while implying the field is safe to log. For the same reason error MESSAGES must never embed echoed request values (Polar's array-shaped `detail` summarizes `loc`+`msg`, never `input`).
- JSDoc only for non-obvious semantics; inline comments only for provider quirks (cite the upstream behavior).
- Conventional Commits with provider scopes: `feat(paddle): ...`, `fix(stripe): ...`.

## Testing

- `test/unit/` — client (fake provider), errors, pagination, Stripe form encoder, webhook verify with precomputed HMAC vectors.
- `test/providers/<name>.test.ts` — contract tests over `test/helpers/fetch-stub.ts` (hand-rolled, no msw): assert outgoing request (method/path/headers/body) AND normalized result.
- `test/live/` — read-only, `describe.skipIf(!env)`, prefix `REVENUE_SDK_LIVE_<PROVIDER>_*`. Only providers with accounts.
- `revenue-sdk/testing` — in-memory provider, `PAGE_SIZE = 2` on purpose, plus `signWebhook({ provider, secret, body, timestamp?, id? })` → the header record that provider's `verifyWebhook` accepts (reuses `webhooks/verify.ts`; Polar keys verbatim, Dodo strips `whsec_` + base64-decodes, pinned by precomputed vectors in `test/providers/testing-sign-webhook.test.ts`).

## Status

v0.1.0 feature-complete: all five providers, client, testing provider, docs site, CI/release/live workflows. Published as in-development (0.x) — APIs may change. Deferred post-v1: discounts, webhook-endpoint management, `tokenProvider`-style auth.

`RevenueProvider` is a PUBLIC extension point — user-defined adapters are documented in `docs/guides/custom-provider.mdx`. Adding a method to the interface or a field to `RevenueCapabilities` breaks them; keep that guide's skeleton method-agnostic ("implement what you support, throw `unsupported` for the rest") so it does not drift with every addition.
