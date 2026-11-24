---
paths:
  - 'src/client.ts'
  - 'src/types.ts'
  - 'src/webhooks/**'
  - 'src/providers/**'
  - 'test/**'
---

# Webhook signature schemes (verified against official SDK sources — exact, do not guess)

| Provider      | Header(s)                            | Signed payload           | HMAC key derivation                                                                                                         | Output                                 |
| ------------- | ------------------------------------ | ------------------------ | --------------------------------------------------------------------------------------------------------------------------- | -------------------------------------- |
| Polar         | `webhook-id/-timestamp/-signature`   | `{id}.{ts}.{body}`       | **EITHER** secret **VERBATIM incl. `whsec_`** (UTF-8, legacy) **OR** strip `whsec_`, then base64-DECODE (Standard Webhooks) | base64, any `v1,` part                 |
| Dodo          | same (Standard Webhooks)             | `{id}.{ts}.{body}`       | **strip `whsec_`, then base64-DECODE** → key bytes                                                                          | base64, any `v1,` part                 |
| Stripe        | `stripe-signature`                   | `{t}.{body}`             | secret verbatim incl. `whsec_`                                                                                              | lowercase hex, any `v1=`, ignore `v0=` |
| Paddle        | `paddle-signature` (`ts=...;h1=...`) | `{ts}:{body}`            | secret verbatim                                                                                                             | lowercase hex, any `h1=`               |
| Lemon Squeezy | `x-signature`                        | body only (no timestamp) | secret verbatim                                                                                                             | hex (compare case-insensitively)       |

Polar signs with ONE of two keys and picks it per endpoint by the age of the secret. Secrets generated on or after 2026-09-08, and every secret reset since, get the Standard Webhooks key (the same derivation as Dodo). Older secrets get the legacy key, the secret verbatim. The receiver cannot see which one was used, so the SDK's Polar `verifyWebhook` accepts a `v1` signature that matches EITHER key, as Polar's own SDK does. The decoded key is tried only when the secret starts with `whsec_` and the rest is valid, non-empty base64. Otherwise only the legacy key applies, so a `whsec_` secret with an empty or invalid rest never makes it throw. Dodo uses the lib's strict behavior and only the decoded key. Both verifiers and the testing `signWebhook` share `toStandardWebhooksKey` in `webhooks/verify.ts`. `signWebhook` signs Polar the legacy way. Always verify against the RAW request body (`await request.text()` once); timestamp tolerance 300s default; constant-time compare; never throw on unknown event types when parsing (open unions).

`WebhookEventType` also carries `license.issued` (alphabetical, after `checkout.completed`) — see `.claude/rules/license-keys.md` for the mapping and the two-field (`licenseKeyId`/`licenseKey`) rationale. Polar's derives from the PAYLOAD rather than the event string (`benefit_grant.created` + `data.benefit.type === 'license_keys'`); every other benefit type falls through to `unknown`.

Exactly four mappings read the PAYLOAD rather than the event string, and that is the complete list — do not add a fifth: the Polar license grant above, plus Polar `checkout.updated` and Stripe `checkout.session.completed`/`.async_payment_succeeded` (→ `checkout.completed` only when the mapped `Checkout.status` is `complete`), plus LS `subscription_payment_success` (→ `unknown` when `billing_reason === 'initial'`, see the LS union rule in `.claude/rules/orders.md`). Payload-reading answers "did this reach a terminal state" or "is this the duplicate half of a payment the other event already reported" — nothing else, and never a `subscriptionChange`.

`WebhookEvent` is a DISCRIMINATED UNION on `type`: `WebhookEventBase` (`type`, `providerType`, `idempotencyKey`, `createdAt?`, `raw`) plus one exported interface per member (`SubscriptionUpdatedEvent`, `OrderPaidEvent`, ...), each carrying its payload as a REQUIRED field. `subscriptionChange` lives on `subscription.updated` alone, `licenseKeyId` is always set on `license.issued`, and `UnknownEvent` adds nothing but the optional `checkout` of a not-yet-paid Polar/Stripe checkout event. `ProviderWebhooks` (root export, next to `detectWebhookProvider`) types a routing table of per-subpath `verifyWebhook`/`parseWebhookEvent`.

`WebhookEvent.idempotencyKey` is `<provider>:<id>` — the provider's event id, else a SHA-256 of the raw body. `createdAt` comes from BODY fields only: the `webhook-timestamp` header is the delivery ATTEMPT time and changes on every retry.
