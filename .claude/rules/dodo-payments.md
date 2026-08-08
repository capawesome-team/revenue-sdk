---
paths:
  - 'src/dodo-payments.ts'
  - 'src/providers/dodo-payments/**'
  - 'test/**/dodo-payments*'
---

# Dodo Payments quirks

Unversioned, additive API → tolerant types, open enums, never validate ID prefixes. `POST /checkouts` (legacy `POST /payments`/`POST /subscriptions` are deprecated). PWYW deliberately NOT wired up (`checkoutCustomAmount: false`): Dodo's `product_cart[].amount` is per-ITEM and one-time-only, so it cannot express one checkout-level `customAmount` — ambiguous as soon as the cart has several items. Pagination: zero-based `page_number`, envelope `{ items }`, NO has_more → terminate when `items.length < page_size`. `TimeInterval` is capitalized (`'Month'`). `POST /change-plan` returns 200 with EMPTY body. Portal session params go in the QUERY string. `POST /customers` requires BOTH `name` and `email` (the second reason the unified create takes a required `name`); customer `metadata` exists and is replaced wholesale on `PATCH /customers/{id}`. No end-trial operation (capability `endTrial: false`). No pause/resume endpoint and no paused status (capability `pause: false`) — the `subscription.paused` webhook listed in Dodo's catalogue is therefore NOT mapped: nothing upstream can produce it, and handling it would imply a capability that does not exist. `/events/ingest` requires `event_id` (SDK generates a UUID when `idempotencyKey` is omitted), rejects timestamps older than 1h, and drops unknown `customer_id`s silently. License routes: public `/licenses/{validate,activate,deactivate}` vs merchant `/license_keys/*` (UNDERSCORE); the merchant list/get/update endpoints are marked `@deprecated` upstream in favour of an entitlements-based replacement but still function; the public routes carry the tightest rate limits of the three (~20/sec, 100/min); validate answers `{ valid }` only and a 404 means the same as `valid: false`; deactivate answers 200 with an EMPTY body.
