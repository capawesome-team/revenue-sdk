---
paths:
  - 'src/paddle.ts'
  - 'src/providers/paddle/**'
  - 'test/**/paddle*'
---

# Paddle quirks

No per-checkout custom amount (`checkoutCustomAmount: false`) — a transaction item is EITHER a catalog `price_id` (no amount field) OR a fully specified ad-hoc `price` object, mutually exclusive, and neither re-prices a catalog price. NO API-hosted checkout — `POST /transactions` → `checkout.url` points at the merchant's own default-payment-link page (requires Paddle.js + approved domain); capability `hostedCheckout: false`. Amounts are string integers. Auth failures are **403**. `PATCH` list fields (`items`) are full replacement → GET-merge-PATCH. Cancel = `POST /subscriptions/{id}/cancel`; undo = `PATCH { scheduled_change: null }`. Pause/resume = `POST /subscriptions/{id}/pause|resume` with `effective_from` (`period_end` → `next_billing_period`; resume always `immediately`). Portal path is `POST /customers/{id}/portal-sessions`. `management_urls` absent from webhook payloads. `POST /customers` answers **409 `customer_already_exists`** on a taken email (→ `conflict`; the existing customer's ID is in `detail`) — only the Paddle-managed checkout flow reuses the customer silently. Customer `custom_data` on PATCH is full replacement like `items`, but is deliberately NOT GET-merged: a merge would make clearing a key impossible. Webhook dedupe uses `event_id`, NEVER `notification_id` (the latter is per-destination and a replay mints a new one). No usage API at all (`usageReporting: false`) — meter externally and bill via `POST /subscriptions/{id}/charge`. Billing v1 REMOVED license keys (Classic had `POST /api/2.0/product/generate_license`; Paddle's own migration matrix lists them as Classic-only with no Billing equivalent, and Classic takes no new signups) → `licenseKeys: false`.
