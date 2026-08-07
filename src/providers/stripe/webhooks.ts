import { RevenueError } from '../../errors.ts';
import type { SubscriptionChange, WebhookEvent } from '../../types.ts';
import {
  hmacSha256,
  isTimestampWithinTolerance,
  sha256Hex,
  timingSafeEqual,
  toHex,
  toIncomingWebhook,
  type VerifyWebhookParams,
  type WebhookInput,
} from '../../webhooks/verify.ts';
import {
  fromUnixSeconds,
  toCheckout,
  toOrderFromInvoice,
  toSubscription,
  type StripeCheckoutSession,
  type StripeInvoice,
  type StripeSubscription,
} from './common.ts';

const TOLERANCE_SECONDS = 300;

/**
 * Verifies a Stripe webhook. The `whsec_` signing secret is used VERBATIM as the HMAC key —
 * never stripped or base64-decoded (unlike Standard Webhooks implementations).
 */
export async function verifyWebhook(params: VerifyWebhookParams): Promise<boolean> {
  const { headers, body } = await toIncomingWebhook(params);
  const header = headers['stripe-signature'];
  if (!header) {
    return false;
  }
  let timestamp: number | undefined;
  const signatures: string[] = [];
  for (const part of header.split(',')) {
    const separator = part.indexOf('=');
    if (separator === -1) {
      continue;
    }
    const key = part.slice(0, separator).trim();
    const value = part.slice(separator + 1).trim();
    if (key === 't') {
      timestamp = Number.parseInt(value, 10);
    } else if (key === 'v1') {
      // Only `v1` may be trusted; `v0` is a deliberately fake test scheme.
      signatures.push(value);
    }
  }
  if (timestamp === undefined || signatures.length === 0) {
    return false;
  }
  if (!isTimestampWithinTolerance(timestamp, TOLERANCE_SECONDS)) {
    return false;
  }
  const expected = toHex(await hmacSha256(params.secret, `${timestamp}.${body}`));
  let matched = false;
  for (const signature of signatures) {
    if (timingSafeEqual(signature, expected)) {
      matched = true;
    }
  }
  return matched;
}

interface StripeEventEnvelope {
  id?: string;
  type?: string;
  created?: number;
  data?: { object?: unknown };
}

const SUBSCRIPTION_CHANGES: Record<string, SubscriptionChange> = {
  // These fire only when the subscription enters `status=paused` — a trial that ended without a
  // payment method. They are NOT emitted for paused payment collection, so a pause issued via
  // `subscriptions.pause` (which sets `pause_collection`) produces no paused event at all.
  'customer.subscription.paused': 'paused',
  'customer.subscription.resumed': 'resumed',
};

/**
 * Parses a Stripe webhook into a normalized event. Does NOT verify the signature — call
 * `verifyWebhook` first.
 */
export async function parseWebhookEvent(input: WebhookInput): Promise<WebhookEvent> {
  const { body } = await toIncomingWebhook(input);
  let envelope: StripeEventEnvelope;
  try {
    envelope = JSON.parse(body) as StripeEventEnvelope;
  } catch (error) {
    throw new RevenueError('Received an unparseable Stripe webhook payload', {
      code: 'validation',
      provider: 'stripe',
      cause: error,
    });
  }
  const providerType = envelope.type ?? 'unknown';
  const object = envelope.data?.object;
  const base = {
    providerType,
    idempotencyKey: envelope.id
      ? `stripe:${envelope.id}`
      : `stripe:sha256:${await sha256Hex(body)}`,
    // `created` is UNIX seconds; a missing, out-of-range or non-finite value reads as absent.
    createdAt: fromUnixSeconds(envelope.created),
    raw: envelope,
  };
  switch (providerType) {
    case 'customer.subscription.created':
      return {
        ...base,
        type: 'subscription.created',
        subscription: toSubscription(object as StripeSubscription),
      };
    case 'customer.subscription.paused':
    case 'customer.subscription.pending_update_applied':
    case 'customer.subscription.pending_update_expired':
    case 'customer.subscription.resumed':
    case 'customer.subscription.updated':
      return {
        ...base,
        type: 'subscription.updated',
        subscription: toSubscription(object as StripeSubscription),
        subscriptionChange: SUBSCRIPTION_CHANGES[providerType],
      };
    case 'customer.subscription.deleted':
      return {
        ...base,
        type: 'subscription.canceled',
        subscription: toSubscription(object as StripeSubscription),
      };
    case 'checkout.session.completed':
    case 'checkout.session.async_payment_succeeded': {
      const checkout = toCheckout(object as StripeCheckoutSession);
      // `completed` fires with payment_status "unpaid" for delayed payment methods —
      // fulfillment must wait for async_payment_succeeded in that case.
      if (checkout.status === 'complete') {
        return { ...base, type: 'checkout.completed', checkout };
      }
      return { ...base, type: 'unknown', checkout };
    }
    case 'invoice.paid':
      return { ...base, type: 'order.paid', order: toOrderFromInvoice(object as StripeInvoice) };
    default:
      return { ...base, type: 'unknown' };
  }
}
