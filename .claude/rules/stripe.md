---
paths:
  - 'src/stripe.ts'
  - 'src/providers/stripe/**'
  - 'test/**/stripe*'
---

# Stripe quirks

No per-checkout custom amount (`checkoutCustomAmount: false`) — `custom_unit_amount` is PWYW config on the PRICE and the buyer types the amount on the hosted page, while `line_items[].price_data` mints a new inline price instead of re-pricing an existing one. Bodies are `application/x-www-form-urlencoded` with bracket notation — the form encoder (`providers/stripe/form-encoder.ts`) is load-bearing: sequential explicit array indices, `undefined` → omit key, `null` → `''`, booleans `'true'/'false'`, `Date` → unix seconds. Pin `Stripe-Version` (const). Unix-second timestamps everywhere. `GET /v1/subscriptions` hides canceled subs by default → pass `status=all`. Plan change MUST send `items[0][id]` (else double-billing). No `Retry-After`; use `Stripe-Should-Retry`. `current_period_*` lives on subscription items, not the subscription. Two unrelated pause mechanisms — see footnote ² in `.claude/rules/subscriptions.md`; the `customer.subscription.paused`/`.resumed` webhooks fire ONLY for a trial that ended without a payment method, never for `pause_collection`, so an SDK-initiated pause emits no paused event. Meter events (`/v1/billing/meter_events`) are async: a 2xx does NOT mean the usage was recorded. Customer update is `POST /v1/customers/{id}` (Stripe has no PATCH) and `metadata` MERGES key by key — the only provider that does not replace it; nothing at all is required to create a customer. NO license-key API at all (`licenseKeys: false`) — Billing Entitlements is not a substitute: derived per-customer feature boolean, no key string, no activation count, no device identity, and `GET /v1/entitlements/active_entitlements` is secret-key-only with no `entitlements` component on `CustomerSessions`, so a shipped app cannot check its own license.
