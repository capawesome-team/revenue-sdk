---
paths:
  - 'src/client.ts'
  - 'src/types.ts'
  - 'src/providers/**'
  - 'test/**'
---

# Orders (decided — do not relitigate)

`client.orders.list/listAll({ cursor?, limit?, customerId? })`, `get({ id })`, `getInvoiceUrl({ id })` — read-only, no create/refund. `Order { id, status, amount?, currency?, customerId?, customerEmail?, subscriptionId?, createdAt?, refundStatus?, metadata?, raw }`; `status: OrderStatus` is REQUIRED, `refundStatus?: 'full' | 'partial'`. `amount` = what the customer WAS CHARGED (minor units, after discounts and credits, incl. tax) → Stripe `amount_paid` on a settled invoice (`total` when unpaid, since `amount_paid` is 0 there), Paddle `grand_total` (not `total`), Polar `total_amount` (not `net_amount`/`due_amount`), Dodo `total_amount` (not `settlement_amount`). Client checks: non-empty `id` (`validation`), `customerId` gated on capability `listOrdersByCustomer` (`unsupported`, sorted between `licenseKeys` and `listSubscriptionsByCustomer`): Polar/Stripe/Paddle/Dodo `true`, LS `false`, testing `true`.

**One resource per provider, and the ID space must match the webhook:**

| Provider | Resource                         | List call                                             | List filter                                                                  |
| -------- | -------------------------------- | ----------------------------------------------------- | ---------------------------------------------------------------------------- |
| Polar    | Order                            | `GET /v1/orders/`                                     | repeated `status` params, drafts excluded SERVER-side                        |
| LS       | Order **∪** Subscription Invoice | `GET /v1/orders` then `GET /v1/subscription-invoices` | store-scoped; invoices with `billing_reason: 'initial'` dropped              |
| Stripe   | **Invoice** (NOT Charge)         | `GET /v1/invoices`                                    | drafts dropped CLIENT-side (`status` takes one value)                        |
| Paddle   | Transaction                      | `GET /transactions`                                   | `status=completed`, `order_by=billed_at[DESC]`, `include=adjustments_totals` |
| Dodo     | Payment                          | `GET /payments`                                       | `status=succeeded`                                                           |

**Stripe = Invoice, not Charge** — `order.paid` maps from `invoice.paid`, so `orders.get(event.order.id)` MUST hit the invoice ID space; and `charge.invoice` was removed in `2025-03-31.basil` (the pinned version is later), so a Charge cannot carry `subscriptionId`. Consequence: a Stripe one-off payment is only invoiced when the session sets `invoice_creation[enabled]` — `createCheckout` now sends it for `payment` mode ONLY (subscription mode always invoices and REJECTS the param). Purchases from sessions created outside this SDK, or before this version, never appear in `orders.list` and never emit `order.paid`. Not retrofittable.

**LS union rule** — a one-off purchase raises an Order; a renewal raises a Subscription Invoice and NO order; the FIRST subscription payment raises BOTH (same money, two IDs, two numeric ID spaces, no FK). So: ALL orders + invoices where `billing_reason !== 'initial'` = every payment exactly once. The cursor carries a phase (`{ source: 'orders' | 'invoices', page }`), orders drained first, and the last order page hands over to invoice page 1. Therefore LS pages are NOT globally chronological (every other provider is newest-first) — merge-sorting two independently paginated sources cannot live in an opaque cursor; accepted tradeoff. Filtered pages can be SHORT or EMPTY and are never backfilled (also true for Stripe drafts) → follow the cursor, never stop on a short page. `getOrder` tries `/v1/orders/{id}` then falls back to `/v1/subscription-invoices/{id}` on `not_found` (the original error wins if both miss). LS orders carry no `subscriptionId`. The WEBHOOK path applies the same `initial` filter (`subscription_payment_success` → `unknown`) so `order.paid` fires once per payment and both paths report the first subscription payment under its ORDER id.

**`getInvoiceUrl` is a METHOD, not a field on `Order`** — cost and lifetime differ wildly: LS `urls.receipt` / `urls.invoice_url` (no expiry), Dodo `invoice_url` on the payment (stable; `GET /invoices/payments/{id}` returns PDF BYTES, not a URL), Stripe `hosted_invoice_url` → `invoice_pdf` (minted at finalization, ~30 days after due date capped at 120; expired PDF answers 400), Paddle `GET /transactions/{id}/invoice` (**1 hour**), Polar `GET /v1/orders/{id}/invoice` (**10 minutes**, S3 presign). A field would mean an N+1 per list page on Polar and Paddle plus persisting URLs that die in ten minutes. Throws `not_found` when no invoice exists: Stripe before finalization, Polar when it was never generated (`POST /v1/orders/{id}/invoice` is a 202 async job — the SDK does NOT trigger or poll it), Paddle for unbilled or zero-value transactions, LS while an invoice is pending, Dodo when `invoice_url` is absent.

`OrderStatus: 'failed' | 'paid' | 'partially_refunded' | 'pending' | 'refunded' | 'void'`:

| Unified            | Polar              | Lemon Squeezy        | Stripe        | Paddle                 | Dodo                    |
| ------------------ | ------------------ | -------------------- | ------------- | ---------------------- | ----------------------- |
| paid               | paid               | paid                 | paid          | completed              | succeeded               |
| pending            | pending, draft\*   | pending              | open, draft\* | billed, ready, draft\* | processing, requires_\* |
| failed             | —                  | failed, fraudulent   | uncollectible | past_due               | failed, cancelled       |
| refunded           | refunded           | refunded             | —             | —                      | —                       |
| partially_refunded | partially_refunded | partial_refund       | —             | —                      | —                       |
| void               | void               | void (invoices only) | void          | canceled               | —                       |

\* Drafts never reach `orders.list`; the mapping only matters for a direct `get` or a webhook. EVERY provider enum is open: an unknown value → `pending`, never an error. Paddle/Dodo list only settled rows, so everything they list is `paid`.

`refundStatus` — Polar: status `refunded` → full, status `partially_refunded` OR any `refunded_amount > 0` → partial (a refund below the total does not always move the status). LS: status `refunded` → full, else `refunded_amount` vs `total`; the `refunded` BOOLEAN means fully refunded only and is deliberately never read. Paddle: `adjustments_totals.breakdown.refund` vs `amount` (hence the always-on `include`). Dodo: `refund_status` on the payment. **Stripe: NEVER set** — a refund is a Charge-level object and leaves no trace on the invoice (no flag, no amount), so a refunded Stripe invoice still reports `paid`.

Paddle `/transactions` rejects `per_page > 30` (every other Paddle collection allows 200) → `MAX_TRANSACTION_PAGE_LIMIT`. Dodo `/payments` documents no sort order — unverified, do not claim one. Testing provider: `InMemorySeed.orders?: InMemoryOrderSeed[]` → `state.orders` (status defaults to `paid`), `getOrderInvoiceUrl` returns `https://invoices.example.com/<id>`.

Out of scope (deliberate): creating/refunding payments (separate resource on every provider — Paddle/Polar adjustments, Stripe Charge-level), line items, tax/discount/net breakdowns (`amount` is the charged total; read `raw`).
