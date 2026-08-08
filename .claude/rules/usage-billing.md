---
paths:
  - 'src/client.ts'
  - 'src/types.ts'
  - 'src/providers/**'
  - 'test/**'
---

# Usage-based billing (decided — do not relitigate)

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
