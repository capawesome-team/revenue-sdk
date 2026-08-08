---
paths:
  - 'src/client.ts'
  - 'src/types.ts'
  - 'src/providers/**'
  - 'test/**'
---

# License keys (decided — do not relitigate)

**TWO SURFACES, and the split is the feature.**

1. **Public, credential-free** — `validateLicenseKey` / `activateLicenseKey` / `deactivateLicenseKey` are STANDALONE per-subpath exports (`revenue-sdk/polar|lemon-squeezy|dodo-payments`), NOT client methods and NOT on `RevenueProvider`. Why, all three reasons: (a) they are the only endpoints in the SDK needing no secret — hanging them off the authenticated client teaches devs that validating a license needs the merchant key, which ends with that key inside a shipped desktop binary; (b) **Polar answers `401 invalid_token` if ANY `Authorization` header is present** on those routes, so a client-mounted method would have to strip the header its own transport just added; (c) bundle size — a shipped app pulls in three small functions, not the whole client. Shared params `key`, `baseUrl?`, `fetch?`, `signal?` (every params type extends `BaseParams`, LS included). Validate takes `activationId?`, activate takes `label`, deactivate takes `activationId` (LS's wire name is "instance"; the SDK name is uniform everywhere).
2. **Merchant CRUD, credentialed** — `client.licenseKeys.list/listAll/get/update`, gated on capability `licenseKeys` (sorted between `hostedCheckout` and `listSubscriptionsByCustomer`): Polar/LS/Dodo `true`, Stripe/Paddle `false`, testing `true`. Client checks: non-empty `id` and `activationLimit` must be `null` or a positive integer (both `validation`), capability (`unsupported`). No `create` — only Dodo can mint a key upstream.
3. **Issuance webhook** — normalized `WebhookEventType` `license.issued`, from Polar `benefit_grant.created` (ONLY when `data.benefit.type === 'license_keys'` — the SDK's only payload-derived event type; other benefit types → `unknown`), LS `license_key_created`, Dodo `license_key.created`. Stripe/Paddle emit nothing. TWO fields, deliberately: `licenseKeyId` is ALWAYS set on the event (one uniform access path on every provider), `licenseKey` only where the provider sends the real key — never on Polar, whose grant carries only the masked `display_key`, so the follow-up is `client.licenseKeys.get({ id: event.licenseKeyId })`. LS's mapped `licenseKey` has NO `productId` (same LS-product-vs-variant reason as the merchant path); Dodo's does. NOT mapped: `license.revoked` / `license.updated` — Polar signals revocation directly (`benefit_grant.revoked`), LS only has a generic `license_key_updated` that would have to be diffed on `status`, Dodo has no revocation or update event at all; one direct signal, one inferred, one absent is not a normalization. Enforcement belongs in the shipped app via `validateLicenseKey` (all three reject revoked/disabled/expired server-side), server-side bookkeeping on the subscription events (normalized on all five providers).

Return types are IDENTICAL on all three subpaths — `validate → LicenseKeyValidation`, `activate → LicenseKeyActivation`, `deactivate → void` — even though LS answers all three of its routes with one envelope. Only `validate` reports a rejection as data (`valid: false`, never throws); activate/deactivate carry no verdict field, so a refusal throws: reached activation limit → `validation`, key belonging to another store → `not_found` (deliberately indistinguishable from unknown, and the foreign key's details are never attached). All params extend `BaseParams`, so `signal` works everywhere.

Scoping — the security core:

- **Polar**: `organizationId` REQUIRED. It is a PUBLIC identifier, safe to ship in an app, and it is what gives Polar server-side merchant scoping.
- **LS**: `expect: { storeId, productId?, variantId? }` REQUIRED. The public license API takes ONLY the key, so ANY LS merchant's key validates ("someone using a license key from another Lemon Squeezy product could use it to get access to your product" — LS docs). Asserted against the response `meta` on all three ops; a mismatch — or a missing `meta` (fail closed) — yields `valid: false` with `licenseKey`/`activation` left undefined, so a foreign key is never handed to the caller. IDs compared as strings.
- **Dodo**: CANNOT be scoped at all — the validate response is literally `{ valid: boolean }` (no product, business, customer or expiry). Therefore `LicenseKeyValidation.licenseKey` is ALWAYS undefined on Dodo, and `activate` is the only op that reveals `business_id`/`product`. Real limitation, documented as such.

All three license `HttpClient`s pass `secrets: () => [params.key]` — the key IS the credential here and rides in the request body, so an echoed key must never survive into `RevenueError.message` (`responseBody` still keeps it verbatim, non-enumerable).

`LicenseKeyStatus: 'active' | 'disabled' | 'expired'` — `valid` from a validation call is ALWAYS authoritative over the locally derived `status`.

| Unified  | Polar                      | Lemon Squeezy     | Dodo     |
| -------- | -------------------------- | ----------------- | -------- |
| active   | granted                    | active, inactive¹ | active   |
| disabled | revoked, disabled          | disabled          | disabled |
| expired  | derived from `expires_at`² | expired           | expired  |

¹ LS `inactive` means "issued but never activated" — still usable.

² Polar has no `expired` status. But Polar rejects expired, revoked AND disabled keys server-side on validate (`service.py` raises `ResourceNotFound` → 404 → `valid: false`), so the derived status only ever shows up on MERCHANT reads and can never contradict a validation verdict.

Out of scope (deliberate): key creation (Dodo-only upstream), issuance configuration (Polar benefit / LS variant setting / Dodo entitlement — all dashboard-configured), Polar's usage metering on keys (`increment_usage`, `conditions`, `limit_usage`), every license webhook event except issuance (see point 3). Testing provider: `InMemorySeed.licenseKeys?: InMemoryLicenseKeySeed[]` → `state.licenseKeys`; it deliberately does NOT implement the standalone public functions (they are subpath exports, not `RevenueProvider` members).
