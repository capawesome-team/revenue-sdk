---
paths:
  - 'src/client.ts'
  - 'src/types.ts'
  - 'src/webhooks/**'
  - 'src/providers/**'
  - 'test/**'
---

# Webhook signature schemes (verified against official SDK sources — exact, do not guess)

| Provider      | Header(s)                            | Signed payload           | HMAC key derivation                                | Output                                 |
| ------------- | ------------------------------------ | ------------------------ | -------------------------------------------------- | -------------------------------------- |
| Polar         | `webhook-id/-timestamp/-signature`   | `{id}.{ts}.{body}`       | secret **VERBATIM incl. `whsec_`** (UTF-8)         | base64, any `v1,` part                 |
| Dodo          | same (Standard Webhooks)             | `{id}.{ts}.{body}`       | **strip `whsec_`, then base64-DECODE** → key bytes | base64, any `v1,` part                 |
| Stripe        | `stripe-signature`                   | `{t}.{body}`             | secret verbatim incl. `whsec_`                     | lowercase hex, any `v1=`, ignore `v0=` |
| Paddle        | `paddle-signature` (`ts=...;h1=...`) | `{ts}:{body}`            | secret verbatim                                    | lowercase hex, any `h1=`               |
| Lemon Squeezy | `x-signature`                        | body only (no timestamp) | secret verbatim                                    | hex (compare case-insensitively)       |

Polar vs Dodo key handling differs even though both are "Standard Webhooks" — Polar's SDK base64-encodes the raw secret before handing it to the lib (cancels out to verbatim); Dodo uses the lib's strict behavior. Always verify against the RAW request body (`await request.text()` once); timestamp tolerance 300s default; constant-time compare; never throw on unknown event types when parsing (open unions).

`WebhookEventType` also carries `license.issued` (alphabetical, after `checkout.completed`) — see `.claude/rules/license-keys.md` for the mapping and the two-field (`licenseKeyId`/`licenseKey`) rationale. Polar's derives from the PAYLOAD rather than the event string (`benefit_grant.created` + `data.benefit.type === 'license_keys'`); every other benefit type falls through to `unknown`.

Exactly four mappings read the PAYLOAD rather than the event string, and that is the complete list — do not add a fifth: the Polar license grant above, plus Polar `checkout.updated` and Stripe `checkout.session.completed`/`.async_payment_succeeded` (→ `checkout.completed` only when the mapped `Checkout.status` is `complete`), plus LS `subscription_payment_success` (→ `unknown` when `billing_reason === 'initial'`, see the LS union rule in `.claude/rules/orders.md`). Payload-reading answers "did this reach a terminal state" or "is this the duplicate half of a payment the other event already reported" — nothing else, and never a `subscriptionChange`.

`WebhookEvent` is a DISCRIMINATED UNION on `type`: `WebhookEventBase` (`type`, `providerType`, `idempotencyKey`, `createdAt?`, `raw`) plus one exported interface per member (`SubscriptionUpdatedEvent`, `OrderPaidEvent`, ...), each carrying its payload as a REQUIRED field. `subscriptionChange` lives on `subscription.updated` alone, `licenseKeyId` is always set on `license.issued`, and `UnknownEvent` adds nothing but the optional `checkout` of a not-yet-paid Polar/Stripe checkout event. `ProviderWebhooks` (root export, next to `detectWebhookProvider`) types a routing table of per-subpath `verifyWebhook`/`parseWebhookEvent`.

`WebhookEvent.idempotencyKey` is `<provider>:<id>` — the provider's event id, else a SHA-256 of the raw body. `createdAt` comes from BODY fields only: the `webhook-timestamp` header is the delivery ATTEMPT time and changes on every retry.
