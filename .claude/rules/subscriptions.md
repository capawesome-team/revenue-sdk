---
paths:
  - 'src/client.ts'
  - 'src/types.ts'
  - 'src/providers/**'
  - 'test/**'
---

# Unified subscription status model (decided — do not relitigate)

`status: 'incomplete' | 'trialing' | 'active' | 'past_due' | 'unpaid' | 'paused' | 'canceled'` — `canceled` is TERMINAL only. A scheduled "cancel at period end" is `cancelAtPeriodEnd: true` with `status` unchanged (+ `endsAt`). A scheduled "pause at period end" works the same way: `pauseAtPeriodEnd: true` with `status` unchanged (+ `resumesAt`); `status` only becomes `paused` once the pause takes effect.

| Unified    | Polar                        | Lemon Squeezy      | Stripe                       | Paddle   | Dodo                       |
| ---------- | ---------------------------- | ------------------ | ---------------------------- | -------- | -------------------------- |
| incomplete | incomplete                   | —                  | incomplete                   | —        | pending                    |
| trialing   | trialing                     | on_trial           | trialing                     | trialing | —                          |
| active     | active                       | active, cancelled¹ | active                       | active   | active                     |
| past_due   | past_due                     | past_due           | past_due                     | past_due | on_hold                    |
| unpaid     | unpaid                       | unpaid             | unpaid                       | —        | —                          |
| paused     | paused                       | paused             | paused, pause_collection²    | paused   | —                          |
| canceled   | canceled, incomplete_expired | expired            | canceled, incomplete_expired | canceled | cancelled, failed, expired |

¹ LS `cancelled` → `active` + `cancelAtPeriodEnd: true`.

² Stripe's `pause_collection` leaves the raw status untouched ("the subscription status will be unchanged and will not be updated to `paused`") → mapped to `paused` anyway, EXCEPT when the raw status is `canceled` (terminal outranks a leftover `pause_collection`). Stripe's raw `paused` status is a different mechanism: a trial that ended without a payment method. `resumeSubscription` reads the subscription first to pick the right endpoint (`pause_collection: null` vs `POST /v1/subscriptions/{id}/resume`).

`cancelAtPeriodEnd` detection: Polar `cancel_at_period_end`; LS status `cancelled`; **Stripe `cancel_at_period_end || cancel_at !== null`** (flexible billing mode portal cancellations set only `cancel_at`); Paddle `scheduled_change?.action === 'cancel'`; Dodo `cancel_at_next_billing_date`.

`pauseAtPeriodEnd` detection: Polar `pause_at_period_end`; Paddle `scheduled_change?.action === 'pause'`; always `false` for LS, Stripe and Dodo (none can schedule a pause).

Pause support (`pause` / `pauseBehaviors`): Polar `true` / `['period_end']` (`resumes_at` must fall after the current period end; resume is immediate — new billing period + charge); LS `true` / `['immediately']` (`mode` fixed to `void`); Stripe `true` / `['immediately']` (`pause_collection`, period-end would need Subscription Schedules); Paddle `true` / `['immediately', 'period_end']` (`on_resume` not exposed); Dodo `false` / `[]`. The client throws `unsupported` when `pause` is false or an explicitly passed `behavior` is not in `pauseBehaviors`; omitting `behavior` uses the provider default.

`WebhookEvent.subscriptionChange` is the EDGE for these levels (`cancel_scheduled | past_due | paused | resumed | uncanceled`), derived ONLY from the provider's event string — **never from payload state**, which stays set for the rest of the period and would re-fire on every later event. Sibling field, not extra `WebhookEventType` members: coverage is uneven (`paused` 3/5, `uncanceled` 2/5), so a fine-grained union would imply a uniformity that does not exist. No `subscription.revoked` — that is what `subscription.canceled` already means here; Polar's naming is inverted (its `canceled` is the schedule, its `revoked` the end).
