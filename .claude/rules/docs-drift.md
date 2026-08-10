---
paths:
  - 'src/**'
  - 'docs/**'
  - 'blog/**'
  - 'pages/**'
  - 'README.md'
---

# Docs drift checklist

Single-home rule (docs restructure, 2026-08): every cross-provider table lives in exactly ONE page —
`docs/reference/` for lookup tables; a collapsed `<Accordion>` on the owning concept page for tables
reference does not carry (order/refund status, invoice-URL lifetimes, checkout expiry, metadata
propagation, idempotency-key derivation, proration wire values). Concept pages teach the unified model
code-first and LINK to reference — they never carry a twin of a reference table. Provider pages have a
fixed skeleton: Factory options → Authentication → Sandbox & test mode → `## Limitations` (what's
unsupported/restricted, links to the capability matrix) → Webhooks → License keys → Orders →
`## Provider notes` (≤8 actionable traps). Quirks the SDK fully absorbs (wire formats, header names,
endpoint spellings, encodings) are documented in `.claude/rules/` and code comments ONLY, never in docs/.
`docs/guides/webhook-handler.mdx` holds the docs' only full webhook handler and the only
`upsertSubscription` reference implementation; other pages excerpt and link.

When changing any of the following, update the single home in the same PR:

- A provider's `CAPABILITIES` const → `docs/reference/capability-matrix.mdx` + that provider page's `## Limitations` bullets + the matching `.claude/rules/` tables. A NEW capability key needs only the matrix row and the affected providers' Limitations.
- Status, `cancelAtPeriodEnd` or `pauseAtPeriodEnd` mapping → `docs/reference/status-mapping.mdx` + the table in `.claude/rules/subscriptions.md` (concepts/subscription-lifecycle only links)
- Webhook event mapping in `providers/*/webhooks.ts` → `docs/reference/webhook-events.mdx` + that provider page's "events worth subscribing to" list (license events also `docs/concepts/license-keys.mdx`)
- `WebhookEvent` fields → the `TypeTable` in `docs/concepts/webhooks.mdx` + the "which model each event carries" table in `docs/reference/webhook-events.mdx`
- `RevenueErrorCode` union, `codeFromStatus`, `RevenueError` fields or a provider's `mapError` → `docs/reference/error-codes.mdx` (touch `docs/concepts/errors.mdx` only if the short overview story itself changes)
- `SubscriptionChange` mapping, `WebhookEvent.idempotencyKey`/`createdAt` derivation → `docs/reference/webhook-events.mdx` + the idempotency Accordion in `docs/concepts/webhooks.mdx`. Handler `switch`es in `docs/quickstart.mdx`, `docs/guides/webhook-handler.mdx`, `pages/index.astro` and `blog/` drift too — grep for `subscription.updated`.
- `CreateCheckoutParams` fields → `docs/concepts/checkouts.mdx` (incl. its Accordions) + `docs/guides/checkout-flow.mdx`
- `CreateCustomerParams`/`UpdateCustomerParams` fields, or a provider's customer metadata handling → `docs/concepts/customers-and-portal.mdx` (incl. its Accordions) + that provider page's notes
- `reportUsage` wire mapping, `toUsagePayload`, or `Subscription.meters` → `docs/concepts/usage-based-billing.mdx` + that provider's page + the table in `.claude/rules/usage-billing.md`
- License-key status mapping, the standalone `providers/*/licenses.ts` signatures, or `licenseKeys` client gating → `docs/concepts/license-keys.mdx` + that provider page's `## License keys` section + the tables in `.claude/rules/license-keys.md`
- `Order` fields, a `toOrderStatus`/`toRefundStatus` helper, a `listOrders` filter or sort, or `getOrderInvoiceUrl` → `docs/concepts/orders.mdx` (its Accordions are the single home for order-status/refund/invoice-URL tables) + that provider page's `## Orders` deltas + the tables in `.claude/rules/orders.md` (short filtered pages also `docs/concepts/pagination.mdx`)
- Provider factory options → that provider's page + `docs/quickstart.mdx` code tabs + `pages/index.astro` code tabs
- A `RevenueClient` namespace or method, a new provider subpath, or the `RevenueErrorCode` union → the matching `README.md` table ("API at a glance", "Providers", "Errors"). These are the only cross-provider tables outside `docs/`, kept deliberately coarse: the README links to `docs/reference/capability-matrix.mdx` and must never grow a twin of it, of the status mapping, or of the webhook-event table.
